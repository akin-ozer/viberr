import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { AppError } from "~/server/errors/app-error.server";
import { resolveStoreTarget } from "~/server/org/resources.server";
import { readStoreDoc } from "~/server/org/store-files.server";
import { healthSnapshot } from "~/server/ops/health-snapshot.server";
import { getRunLog, runConcurrencySnapshot } from "~/server/runtimes/run-service.server";
import type { RunLogQuery } from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";
import type { AgentRunRow } from "~/server/runtimes/run-store.server";
import { backendCredentialHealth } from "~/server/runtimes/runtime-registry.server";
import { canReadControllerRunLog } from "./controller-conversations.server";
import {
  controllerToolGuards,
  NotVisibleError,
  type ControllerToolUser,
} from "./controller-tool-guards.server";

/**
 * `viberr_ops` — the controller's built-in diagnostics server (ruling 107).
 *
 * The `viberr_controller` toolkit reads and changes the PRODUCT: projects,
 * tasks, agents, goals, org resources. It has no reach at all into the ops
 * layer that already sits behind routes — per-run logs, subsystem health,
 * backend credential state, the run concurrency queue, store documents — so
 * asked "why did that run fail" or "is the instance healthy" the controller
 * could only guess or send the person to a page.
 *
 * NOT REMOVABLE BY CONSTRUCTION. This server is mounted by
 * `controller-run.server` on EVERY controller run: no config is read, no grant
 * row exists, and nothing in the UI can drop it. That is deliberate rather than
 * a missing feature — a stored grant for machinery the run mounts anyway would
 * be a toggle with no effect (P14-KM-14), and the name is reserved in
 * `saveMcpServer` so an org row can never shadow the mount key.
 *
 * READ-ONLY: nothing here writes, deletes, or starts anything. Diagnostics that
 * could change the instance would be a second authority surface beside the
 * toolkit, and the toolkit is where changes are audited.
 *
 * AUTHORITY is the asking person's own, resolved LIVE per call through the
 * shared controller guards: instance health is aggregate (what
 * `/resources/health` already answers unauthenticated), a run log follows the
 * exact gate `/resources/run-log` applies, and store documents are org-admin
 * only, like the store browser they come from.
 */

export interface ControllerOpsDeps {
  db: DatabaseSync;
  ctx: { dataRoot?: string };
  /** The asking user — the only authority anything here runs under. */
  user: ControllerToolUser;
}

export interface ControllerOpsMcp {
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: SdkMcpToolDefinition<any>[];
}

/** The mount key, exported so the run assembly and the reserved-name guard
 *  can never disagree about what this server is called. */
export const CONTROLLER_OPS_MCP_NAME = "viberr_ops";

export const CONTROLLER_OPS_INSTRUCTIONS =
  "Viberr built-in diagnostics. READ-ONLY: nothing here changes the instance. Every call is " +
  "checked against the ASKING PERSON's own permissions, so a [denied] answer is final — relay " +
  "it with its reason. Use these to answer questions about how the instance and its runs are " +
  "actually doing, and quote what you read rather than inferring it.";

/** The route's own clamp (P13-D-11): a client-named page size is bounded, so a
 *  tool call cannot ask for the payload paging exists to avoid. */
const MAX_LOG_LINES = 500;

/** Uniform not-visible copy for a run: a run that does not exist and one the
 *  asker may not read answer identically, so a probe cannot walk run ids
 *  (the R15-4 posture the toolkit applies to projects). */
function notVisibleRun(runId: string): string {
  return `[denied] No run "${runId}" is visible to you.`;
}

/** Build the diagnostics server for one controller turn. */
export function buildControllerOpsMcp(deps: ControllerOpsDeps): ControllerOpsMcp {
  const { db, ctx, user } = deps;
  const dataRoot = ctx.dataRoot;
  const { requireOrgAdmin, requireVisible, run, runWith, json } =
    controllerToolGuards(db, user, dataRoot);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [];
  const allowed: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (t: SdkMcpToolDefinition<any>, name: string) => {
    tools.push(t);
    allowed.push(`mcp__${CONTROLLER_OPS_MCP_NAME}__${name}`);
  };

  /**
   * The run-log gate, exactly as `/resources/run-log` applies it: a controller
   * turn is scoped to its conversation's owner (org admins supervise), and
   * every other run to membership of its project. Both refusals — and a run id
   * that matches nothing — answer the same sentence, so the reply never
   * discloses that a run exists or which project it belongs to.
   */
  function requireRunVisible(row: AgentRunRow): void {
    if (row.kind === "controller") {
      if (canReadControllerRunLog(db, row, { id: user.id })) return;
      throw new NotVisibleError(notVisibleRun(row.id));
    }
    try {
      requireVisible(row.project_slug, "read this run's log");
    } catch {
      throw new NotVisibleError(notVisibleRun(row.id));
    }
  }

  add(
    tool(
      "instance_health",
      "How this Viberr instance is doing right now: overall status and which subsystems are degraded, the store watchers and the single-writer lock, disk space, the maintenance pass, build identity, per-backend credential health, and the run concurrency queue. Open to anyone; it reports aggregates, never anyone's data.",
      {},
      run(() => {
        // No gate, deliberately. The snapshot is what `/resources/health`
        // already serves UNAUTHENTICATED (aggregate counts, the lock holder,
        // free bytes, build identity), and per-backend credential health is
        // what the project agents page already shows any member. The
        // concurrency numbers are the one reading a page keeps to admins, and
        // they are three integers about instance load with no name or project
        // in them — strictly less than the probe hands an anonymous caller, so
        // gating this tool would perform secrecy rather than keep any.
        const snapshot = healthSnapshot(db);
        return json({
          ...snapshot,
          // WHY a backend reads available or not — the health probe's
          // `backends` is env presence only, and "unavailable" with no reason
          // is the answer that sends someone hunting through the deployment.
          backendCredentials: [
            backendCredentialHealth("claude"),
            backendCredentialHealth("codex"),
          ],
          // What the concurrency cap is doing this second: a queued run is the
          // usual answer to "why has nothing started".
          runs: runConcurrencySnapshot(db),
        });
      }),
    ),
    "instance_health",
  );

  add(
    tool(
      "read_run_log",
      "A page of one agent run's raw log lines. Readable by a member of the run's project; a controller conversation's own turns are readable by the person whose conversation it is (and by org admins). Use `since` to read forward from a sequence number, or `before` with `limit` to page backwards through history.",
      {
        runId: z.string().describe("The run id, e.g. from a task's console."),
        since: z
          .number()
          .int()
          .optional()
          .describe("Forward tail: lines after this sequence number (default -1 = all)."),
        before: z
          .number()
          .int()
          .optional()
          .describe("Backward page: the newest lines OLDER than this sequence number."),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Page size, clamped to 1..${MAX_LOG_LINES}.`),
      },
      runWith(
        (args: {
          runId: string;
          since?: number;
          before?: number;
          limit?: number;
        }) => {
          const row = getRun(db, args.runId);
          // A missing run answers the not-visible sentence rather than "no such
          // run": the gate below must not be inferable from which reply came
          // back.
          if (!row) throw new NotVisibleError(notVisibleRun(args.runId));
          requireRunVisible(row);

          // Backward mode is selected by the PRESENCE of before/limit, so an
          // absent argument must leave its key off rather than carry undefined.
          let query: RunLogQuery;
          if (args.before !== undefined || args.limit !== undefined) {
            query = {};
            if (args.before !== undefined) query.before = args.before;
            if (args.limit !== undefined) {
              query.limit = Math.min(Math.max(args.limit, 1), MAX_LOG_LINES);
            }
          } else {
            query = { since: args.since ?? -1 };
          }
          const log = getRunLog(db, args.runId, query);
          if (!log) throw new NotVisibleError(notVisibleRun(args.runId));
          return json({
            run: {
              id: row.id,
              kind: row.kind,
              state: row.state,
              backend: row.backend,
              model: row.model,
              agent: row.agent_name,
              project: row.project_slug,
              task: row.task_key,
              startedAt: row.started_at,
              finishedAt: row.finished_at,
              turns: row.turns,
            },
            headSeq: log.headSeq,
            oldestSeq: log.oldestSeq,
            hasMore: log.hasMore,
            lines: log.lines.map((line) => ({
              seq: line.seq,
              at: line.occurredAt,
              display: line.display,
            })),
          });
        },
      ),
    ),
    "read_run_log",
  );

  add(
    tool(
      "read_store_doc",
      "Read one text document out of a knowledge base or skill folder in the org store. Org admins only, like the store browser itself. Give the resource kind and id, then the file path as its segments, e.g. [\"notes\", \"api.md\"].",
      {
        kind: z.enum(["kb", "skill"]).describe("Which store the document lives in."),
        id: z.string().describe("The knowledge base or skill id."),
        path: z
          .array(z.string())
          .describe("Path segments inside the folder, file name last."),
      },
      runWith((args: { kind: "kb" | "skill"; id: string; path: string[] }) => {
        requireOrgAdmin("read store documents");
        const target = resolveStoreTarget(db, args.kind, args.id, { dataRoot });
        if (!target) throw AppError.notFound("That resource no longer exists.");
        const doc = readStoreDoc(target, args.path);
        if (!doc) throw AppError.notFound("That file no longer exists.");
        return json({
          resource: { kind: target.kind, id: target.id, name: target.name },
          path: args.path,
          // Reported, never hidden: a clipped document that reads as complete
          // is how a model states a half-read file as fact.
          truncated: doc.truncated,
          text: doc.text,
        });
      }),
    ),
    "read_store_doc",
  );

  const server = createSdkMcpServer({
    name: CONTROLLER_OPS_MCP_NAME,
    version: "1.0.0",
    instructions: CONTROLLER_OPS_INSTRUCTIONS,
    tools,
  });

  return {
    mcpServers: { [CONTROLLER_OPS_MCP_NAME]: server },
    allowedTools: allowed,
    tools,
  };
}
