import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
// Ruling 296: every tool on this server refuses arguments it does not
// declare, instead of silently dropping them and answering anyway.
import { strictTool as tool } from "~/server/runtimes/strict-tool.server";
import { mountedToolName } from "~/server/runtimes/tool-manifest.server";
import {
  recordAudit,
  type AuditDetails,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { resolveStoreTarget } from "~/server/org/resources.server";
import { readStoreDoc } from "~/server/org/store-files.server";
import { KB_DOC_OFFSET_DESCRIPTION } from "~/server/files/kb-injection.server";
import { pageEnd } from "~/server/runtimes/read-page-budget.server";
import {
  healthSnapshot,
  type HealthSnapshot,
} from "~/server/ops/health-snapshot.server";
import {
  PROBE_LIMIT,
  probeTools,
  type ProbedTool,
} from "~/server/ops/toolchain.server";
import { runConcurrencySnapshot, runLogPage } from "~/server/runtimes/run-service.server";
import type { RunLog, RunLogQuery } from "~/server/runtimes/run-service.server";
import {
  getRun,
  listLiveRunRows,
  listRunsForTaskRows,
  runLineStats,
} from "~/server/runtimes/run-store.server";
import type { AgentRunRow } from "~/server/runtimes/run-store.server";
import type {
  RunBackend,
  RunKind,
  RunState,
} from "~/features/runtime/runtime-types";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  countConnectedUsers,
  isBackendAvailableFor,
} from "~/server/runtimes/backend-credentials.server";
import { browserRuntimeStatus } from "~/server/tasks/specialist-browser-mcp.server";
import { canReadControllerRunLog } from "./controller-conversations.server";
import {
  controllerToolGuards,
  NotVisibleError,
  type ControllerToolUser,
} from "./controller-tool-guards.server";
import { countLabel } from "~/shared/text/plural";

/**
 * `viberr_ops` — the controller's built-in diagnostics server (ruling 107).
 *
 * The `viberr_controller` toolkit reads and changes the PRODUCT: projects,
 * tasks, agents, epics, org resources. It has no reach at all into the ops
 * layer that already sits behind routes — per-run logs, subsystem health,
 * backend credential state, the run concurrency queue, store documents — so
 * asked "why did that run fail" or "is the instance healthy" the controller
 * could only guess or send the person to a page.
 *
 * NOT REMOVABLE BY CONSTRUCTION. This server is mounted by
 * `controller-run.server` on EVERY controller run: no config is read, no grant
 * row exists, and nothing in the UI can drop it. That is deliberate rather than
 * a missing feature — a stored grant for machinery the run mounts anyway would
 * be a toggle with no effect (P14-KM-14). The mount key is reserved at all
 * three layers (`~/shared/mcp-reserved`): no org row can be created under it,
 * the picker never offers one, and the resolver refuses to resolve one that
 * reached the registry some other way.
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

/** The mount key, exported so the run assembly can never disagree about
 *  what this server is called. */
export const CONTROLLER_OPS_MCP_NAME = "viberr_ops";

const CONTROLLER_OPS_INSTRUCTIONS =
  "Viberr built-in diagnostics. READ-ONLY: nothing here changes the instance. Every call is " +
  "checked against the ASKING PERSON's own permissions, so a [denied] answer is final; relay " +
  "it with its reason. Use these to answer questions about how the instance and its runs are " +
  "actually doing, and quote what you read rather than inferring it.";

/**
 * Page size for `read_run_log`, bounded on EVERY path.
 *
 * The route this tool descends from can afford an unbounded default (`since=-1`
 * = the whole log) because its caller is the console, which holds a live cursor
 * and never asks for everything. A model holds no cursor: `read_run_log({runId})`
 * is the natural shape for "why did that run fail", and a run's `display` bodies
 * run to kilobytes each (run-projection measured ~2.2 KB/line), so an unbounded
 * default is megabytes of tool result in a context window. Bounded by DEFAULT,
 * like `inspect_audit_log` (`?? 50`) and `read_store_doc` (a page + `truncated`)
 * — a max the caller has to opt into protects the call nobody makes.
 *
 * 200 is `RUN_LOG_PAGE_LINES`, the same page the console takes when it names no
 * size, for the same reason: it is a readable page rather than a history.
 */
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 250;

/**
 * Ruling 677: the most a page's lines come to, in UTF-8 bytes as the reply
 * prints them. A count alone bounds nothing: a line's `display` runs from a
 * few bytes to kilobytes, and 500 of the smallest already printed as 82 KB,
 * more than a turn carries. Under the reply's own cap of 50,000 characters,
 * with room for the run and page blocks above the lines.
 */
const RUN_LOG_PAGE_BYTES = 44_000;

/**
 * The lines of `page` that fit {@link RUN_LOG_PAGE_BYTES}, kept from the end
 * the cursor reads from: the newest of a backward page, the oldest of a
 * forward one. The page's position is computed from what is kept, so its
 * cursors lead to the lines left out. One line is always kept.
 */
function linesThatFit<T>(page: readonly T[], keep: "newest" | "oldest"): T[] {
  const ordered = keep === "newest" ? [...page].reverse() : [...page];
  const kept: T[] = [];
  let bytes = 0;
  for (const line of ordered) {
    const printed = JSON.stringify(line, null, 1);
    // As `json` prints it inside the `lines` array: two more spaces a row,
    // and the comma and newline that separate it from the next.
    const size = Buffer.byteLength(printed, "utf8") + 2 * printed.split("\n").length + 2;
    if (kept.length > 0 && bytes + size > RUN_LOG_PAGE_BYTES) break;
    bytes += size;
    kept.push(line);
  }
  return keep === "newest" ? kept.reverse() : kept;
}

/** Ruling 265: page bounds for `list_runs`. A live listing on a busy instance
 *  is tens of rows, not thousands, and a task's whole run history is the other
 *  arm — both are summaries, so the default is generous and the max is a stop. */
const DEFAULT_RUN_ROWS = 50;
const MAX_RUN_ROWS = 200;

/** One page of a store document, as `read_store_doc` answers it. */
interface StoreDocPage {
  resource: { kind: "kb" | "skill"; id: string; name: string };
  path: string[];
  truncated: boolean;
  /** The document's length, in the characters `offset` counts. */
  characters: number;
  text: string;
  /** Where this page starts, when it is not the first. */
  offset?: number;
  /** The offset the next page starts at, when one follows. */
  nextOffset?: number;
}

/** Ruling 302: present on a `list_runs` reply ONLY when rows were left out,
 *  naming how many and the argument that returns them. */
interface RunWindowNote {
  truncated?: string;
}

/** Uniform not-visible copy for a run: a run that does not exist and one the
 *  asker may not read answer identically, so a probe cannot walk run ids
 *  (the R15-4 posture the toolkit applies to projects). */
function notVisibleRun(runId: string): string {
  return `[denied] No run "${runId}" is visible to you.`;
}

/**
 * What `instance_health` says about one backend (ruling 127).
 *
 * The org-admin-only DETAIL arm is gone, and with it the whole reason it
 * existed: `backendCredentialHealth` used to explain an unusable credential by
 * naming the deployment's config directory (`/Users/<owner>/.claude` under the
 * CLI-auth opt-in) and which environment variable to set — deployment
 * configuration, which is why only an org admin got it. Nothing here names a
 * config path any more, because there is no instance credential to configure:
 * each person connects their own on Profile → Agent accounts (ruling 107's
 * "everyone learns whether, only admins learn why" split therefore no longer
 * applies to this tool — see the dated correction on that ruling).
 *
 * What is left is two facts, both safe for any asker: how many people on this
 * instance have connected the backend, and whether the ASKER has — which is
 * the only one that changes what they can do next.
 */
interface BackendCredentialReport {
  backend: RealBackend;
  connectedUsers: number;
  /** Whether the person asking can run this backend on their own tasks. */
  askerConnected: boolean;
}

function backendCredential(
  db: DatabaseSync,
  backend: RealBackend,
  userId: string,
): BackendCredentialReport {
  return {
    backend,
    connectedUsers: countConnectedUsers(db, backend),
    askerConnected: isBackendAvailableFor(db, userId, backend),
  };
}

/** Build the diagnostics server for one controller turn. */
export function buildControllerOpsMcp(deps: ControllerOpsDeps): ControllerOpsMcp {
  const { db, ctx, user } = deps;
  const dataRoot = ctx.dataRoot;
  const { actor, orgAdmin, requireOrgAdmin, requireVisible, runWith, json } =
    controllerToolGuards(db, user, dataRoot);

  /**
   * Owner ruling (pass 32, E32-5): every SUCCESSFUL diagnostics read leaves one
   * audit row naming the tool, its target and the asking person. These are the
   * first tools that let a MODEL read run logs and store documents on someone's
   * behalf; "who read what through the controller" has to be answerable from
   * the audit trail, not reconstructed from run transcripts. Denials keep
   * writing `controller.authority.denied` through the guards.
   */
  function auditRead(
    toolName: string,
    target: string,
    extra: AuditDetails = {},
  ): void {
    recordAudit(db, {
      action: "controller.ops.read",
      actor,
      subjectKind: "controller",
      subjectId: target,
      details: { tool: toolName, ...extra },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [];
  const allowed: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (t: SdkMcpToolDefinition<any>, name: string) => {
    tools.push(t);
    // Ruling 347: the manifest's spelling of the mounted name.
    allowed.push(mountedToolName(CONTROLLER_OPS_MCP_NAME, name));
  };

  /**
   * The run-log gate, exactly as `/resources/run-log` applies it: a controller
   * turn is scoped to its conversation's owner (org admins supervise), and
   * every other run to membership of its project. Both refusals — and a run id
   * that matches nothing — answer the same sentence, so the reply never
   * discloses that a run exists or which project it belongs to.
   */
  function runVisible(row: AgentRunRow): boolean {
    if (row.kind === "controller") {
      return canReadControllerRunLog(db, row, { id: user.id });
    }
    try {
      requireVisible(row.project_slug, "read this run's log");
      return true;
    } catch {
      return false;
    }
  }

  function requireRunVisible(row: AgentRunRow): void {
    if (!runVisible(row)) throw new NotVisibleError(notVisibleRun(row.id));
  }

  /** One `list_runs` row. Named, because ruling 268 adds a key that is present
   *  on exactly one kind of run and the shape has to say so. */
  interface RunRowView {
    runId: string;
    /** Null on a CONTROLLER turn: it belongs to a conversation, not a board. */
    projectSlug: string | null;
    taskKey: string | null;
    /** Present only on a controller turn (ruling 268). */
    conversationId?: string;
    kind: RunKind;
    agent: string;
    agentProfileId: string;
    role: string;
    backend: RunBackend;
    model: string;
    state: RunState;
    phase: string | null;
    step: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    turns: number;
    logLines: number;
  }

  /** Ruling 265: one run, as `list_runs` reports it. Enough to decide which log
   *  to read and what a run is doing, and nothing a `get_task` read would not
   *  already tell the same asker. */
  function runRow(row: AgentRunRow): RunRowView {
    // Ruling 268 (F37-100): a CONTROLLER turn has no project and no task —
    // ruling 99 stores the conversation id in `task_key` because the runs
    // table has one identity column. Reporting that raw put a `cnv_…` in a
    // field named `taskKey` with `projectSlug: ""`, so "anything filtering by
    // task has to know to discard that row". A storage shape is not a reply
    // shape: a controller row names its conversation and carries no task.
    const controllerTurn = row.kind === "controller";
    const view: RunRowView = {
      runId: row.id,
      projectSlug: controllerTurn ? null : row.project_slug,
      taskKey: controllerTurn ? null : row.task_key,
      kind: row.kind,
      agent: row.agent_name ?? row.agent_profile_id,
      agentProfileId: row.agent_profile_id,
      role: row.role,
      backend: row.backend,
      model: row.model,
      state: row.state,
      // Ruling 250's pair: the phase is the strip's header and the step is what
      // the run is doing this second.
      phase: row.phase,
      step: row.step,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      turns: row.turns,
      logLines: runLineStats(db, row.id).count,
    };
    if (controllerTurn) view.conversationId = row.task_key;
    return view;
  }

  add(
    tool(
      "instance_health",
      "How this Viberr instance is doing right now: overall status and which subsystems are degraded, the store watchers and the single-writer lock, disk space, the maintenance pass, build identity, how many people have connected each model backend (and whether you have), each backend's last usage reading (how much of which window is spent, and when it resets, with every window it knows in `windows`: the five-hour and the weekly ones) and any spent window, the run concurrency queue, and the host toolchain (node, npm, git, python3, go versions or null when absent; and the pinned Codex CLI and Claude Agent SDK). That fixed list is npm-shaped, so pass `probe` to ask about ANY other command this host might have (up to 8 bare names, e.g. [\"golangci-lint\", \"gofmt\"]) and each answers `present` with a version, or `present: false` with the reason. PROBE BEFORE YOU PROMISE A GATE: a gate command whose binary you never checked is a promise every task on the board inherits and quietly fails. Open to anyone: agent backends are connected per person, and this reports presence and versions only, never a path, so nothing here names another person or any deployment configuration.",
      {
        probe: z
          .array(z.string())
          .max(PROBE_LIMIT)
          .optional()
          .describe(
            `Up to ${PROBE_LIMIT} command names to check on this host, e.g. ["golangci-lint", "gofmt"]. Bare names only: a path, a flag or a shell fragment is refused by name rather than run.`,
          ),
      },
      runWith((args: { probe?: string[] }) => {
        // The READING is ungated: it is what `/resources/health` already serves
        // UNAUTHENTICATED (aggregate counts, the lock holder's pid and host,
        // free bytes, build identity), plus availability booleans and three
        // integers about run load that carry no name, project or run in them
        // (`backendCredential` says why the per-backend reading is open too).
        const admin = orgAdmin();
        // Ruling 130(d): a signed-in read carries whose account a refusal was.
        const snapshot = healthSnapshot(db, { principal: true });
        auditRead("instance_health", "instance");
        const body: HealthSnapshot & {
          backendCredentials: BackendCredentialReport[];
          runs: ReturnType<typeof runConcurrencySnapshot>;
          browserDetail?: string;
          probe?: ProbedTool[];
        } = {
          ...snapshot,
          // The asker-facing half of the health probe's connection counts: an
          // instance where nobody has connected Codex is not broken, but an
          // asker who has not connected it cannot run one — and only the
          // second fact tells them what to do.
          backendCredentials: [
            backendCredential(db, "claude", user.id),
            backendCredential(db, "codex", user.id),
          ],
          // What the concurrency cap is doing this second: a queued run is the
          // usual answer to "why has nothing started".
          runs: runConcurrencySnapshot(db),
        };
        // F39-1: the answer to a question the fixed `toolchain` struct cannot
        // hold. Present only when asked, so the common reading stays the size
        // it was.
        const probed = probeTools(args.probe ?? []);
        if (probed.length > 0) body.probe = probed;
        // C05-A: the browser's configured executable PATH is deployment
        // configuration and stays org-admin-only (`admin`, above). The key is
        // present only for an org admin, never carried empty.
        const browserDetail = admin ? browserRuntimeStatus().detail : undefined;
        if (browserDetail) body.browserDetail = browserDetail;
        return json(body);
      }),
    ),
    "instance_health",
  );

  /**
   * Ruling 302, third sibling. `list_runs` clipped at `limit` and said nothing:
   * a caller asking "which runs are live right now" got a list that looked
   * complete, and could not reconcile it with the count `instance_health`
   * reports for the same instant. `read_run_log` beside it has carried
   * `olderExist`/`newerExist` and recovery cursors since pass 32, and
   * `inspect_audit_log` has carried `total`/`shown` since ruling 279. This is
   * the one that did not.
   */
  const windowNote = (total: number, shown: number): RunWindowNote => {
    if (total <= shown) return {};
    return {
      truncated:
        `${countLabel(total - shown, "more run")} matched and ` +
        `${shown} are shown, newest first. Pass limit up to ${MAX_RUN_ROWS} for the rest.`,
    };
  };

  add(
    tool(
      "list_runs",
      "Agent runs you can see, as run ids `read_run_log` takes. With no arguments: every run that is LIVE right now across every project visible to you (running, or queued: behind the concurrency cap, or for the summary of its session's last run), newest first, the answer to \"which runs are those\" when instance_health reports a live count. With `projectSlug` and `taskKey` together: that task's runs instead, finished ones included, newest first, which is how you reach the log of a run that already failed. Read-only, membership gated; a run in a project you cannot see is simply absent.",
      {
        projectSlug: z.string().optional(),
        taskKey: z
          .string()
          .optional()
          .describe(
            "List this task's runs (finished included) instead of the live ones. Needs projectSlug: this server holds no project binding.",
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe(`Most rows to return, clamped to 1..${MAX_RUN_ROWS} (default ${DEFAULT_RUN_ROWS}).`),
      },
      runWith((args: { projectSlug?: string; taskKey?: string; limit?: number }) => {
        const limit = Math.min(
          Math.max(args.limit ?? DEFAULT_RUN_ROWS, 1),
          MAX_RUN_ROWS,
        );
        let scope = "live";
        let visible: AgentRunRow[];
        if (args.taskKey) {
          const slug = (args.projectSlug ?? "").trim();
          if (!slug) {
            // This server is not bound to a project (its other tools are
            // instance-wide), so there is no slug to default to. Say which
            // argument is missing rather than answering an empty list.
            throw AppError.validation(
              "Name projectSlug alongside taskKey: list_runs holds no project binding.",
            );
          }
          // The project gate answers first and out loud: a task listing is
          // asked FOR a project, so "you cannot see this project" is the true
          // and useful refusal, not an empty list.
          requireVisible(slug, "read this task's runs");
          scope = `${slug}/${args.taskKey}`;
          visible = listRunsForTaskRows(db, slug, args.taskKey).filter(runVisible).reverse();
        } else {
          // The LIVE listing spans every project, so an invisible row is
          // dropped rather than refused.
          visible = listLiveRunRows(db).filter(runVisible);
        }
        const rows = visible.slice(0, limit);
        auditRead("list_runs", scope);
        return json({
          scope,
          total: visible.length,
          ...windowNote(visible.length, rows.length),
          runs: rows.map(runRow),
        });
      }),
    ),
    "list_runs",
  );

  add(
    tool(
      "read_run_log",
      `One PAGE of an agent run's log lines, newest page by default (which is where a failure is). Readable by a member of the run's project; a controller conversation's own turns are readable by the person whose conversation it is (and by org admins). Two ways to move: \`before\` pages BACKWARD (the lines older than that sequence number) and \`since\` pages FORWARD (the lines after it). Name only one of them. Every call returns at most \`limit\` lines (${DEFAULT_LOG_LINES} by default, ${MAX_LOG_LINES} at most), and fewer when they are long (ruling 677: a page's lines come to at most 44,000 bytes, kept from the end the cursor reads from), so read \`page\` to see where you are: it reports whether older or newer lines exist and hands you the exact argument for the next call. \`run.logLines\` is the run's total.`,
      {
        runId: z
          .string()
          .describe("The run id, from list_runs (or a task's console)."),
        since: z
          .number()
          .int()
          .optional()
          .describe(
            "Read FORWARD: the page of lines after this sequence number. Omit to read the newest page.",
          ),
        before: z
          .number()
          .int()
          .optional()
          .describe(
            "Read BACKWARD: the page of lines older than this sequence number. Cannot be combined with `since`.",
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `Lines per page, clamped to 1..${MAX_LOG_LINES} (default ${DEFAULT_LOG_LINES}).`,
          ),
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
          if (args.since !== undefined && args.before !== undefined) {
            // The two cursors move opposite ways, and the underlying query
            // silently lets one win. Refusing is the only answer that cannot
            // hand back a window the caller did not ask for.
            throw AppError.validation(
              "Name either since (a forward page) or before (a backward page), not both.",
            );
          }
          const limit = Math.min(
            Math.max(args.limit ?? DEFAULT_LOG_LINES, 1),
            MAX_LOG_LINES,
          );

          let page: RunLog["lines"];
          if (args.since === undefined) {
            // Backward: the newest page, or the page older than `before`. An
            // absent cursor must leave its key OFF rather than carry undefined,
            // which is how `runLogPage` selects its mode.
            const query: RunLogQuery = { limit };
            if (args.before !== undefined) query.before = args.before;
            page = runLogPage(db, row, query).lines;
          } else {
            // Forward. `runLogPage` ignores `limit` in this mode BY DESIGN (the
            // console's live tail is bounded by its own cursor), so the bound
            // travels as `forwardLimit` — pushed into the SELECT (C02-R12,
            // pass 32) rather than applied on lines already materialized. What
            // this tool must keep bounded is the REPLY it puts in a model's
            // context; the SQL bound keeps the read proportional to it too.
            page = runLogPage(db, row, { since: args.since, forwardLimit: limit }).lines;
          }

          // Ruling 677: and to what a reply carries. The lines are shaped as
          // the reply prints them first, so the measure is of the reply.
          const lines = linesThatFit(
            page.map((line) => ({ seq: line.seq, at: line.occurredAt, display: line.display })),
            args.since === undefined ? "newest" : "oldest",
          );

          // Page position, computed against the RUN's real bounds. `runLogPage`'s
          // own headSeq/oldestSeq/hasMore are page-local cursors for a stateful
          // console (headSeq is this page's last line, hasMore means "older
          // lines exist"), and a model with no second source reads them as facts
          // about the run — so they are not relayed at all.
          const stats = runLineStats(db, args.runId);
          const firstSeq = lines.length ? lines[0]!.seq : null;
          const lastSeq = lines.length ? lines[lines.length - 1]!.seq : null;
          // C03-OC2 (pass 32): an EMPTY page is a cursor that overshot, and
          // the flags still have to tell the truth about the RUN. A `since`
          // past the end means every logged line is older than the cursor; a
          // `before` at or below the first line means every line is newer.
          // Answering `olderExist: false` there told a model "nothing older
          // exists" about a run with thousands of lines, and handed it no
          // cursor to recover with.
          const overshotForward = lines.length === 0 && stats.count > 0 && args.since !== undefined;
          const overshotBackward = lines.length === 0 && stats.count > 0 && args.before !== undefined;
          const olderExist =
            firstSeq !== null ? firstSeq > stats.minSeq : overshotForward;
          const newerExist =
            lastSeq !== null ? lastSeq < stats.maxSeq : overshotBackward;
          const olderCursor = firstSeq !== null ? firstSeq : stats.maxSeq + 1;
          const newerCursor = lastSeq !== null ? lastSeq : stats.minSeq - 1;

          auditRead("read_run_log", row.id, {
            project: row.project_slug,
            task: row.task_key,
            lines: lines.length,
          });
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
              // The run's TRUE total, so an empty page reads as "your cursor is
              // past the end", never as "this run logged nothing".
              logLines: stats.count,
            },
            page: {
              firstSeq,
              lastSeq,
              olderExist,
              newerExist,
              // The exact argument for the follow-up call, so continuing is not
              // arithmetic the model has to get right.
              next: {
                older: olderExist ? { before: olderCursor } : null,
                newer: newerExist ? { since: newerCursor } : null,
              },
            },
            lines,
          });
        },
      ),
    ),
    "read_run_log",
  );

  add(
    tool(
      "read_store_doc",
      "Read one text document out of a knowledge base or skill folder in the org store. Org admins only, like the store browser itself. Give the resource kind and id, then the file path as its segments, e.g. [\"notes\", \"api.md\"]. Ruling 677: a read returns one page of at most 32,000 bytes; `truncated` is true while more follows, `nextOffset` is the `offset` that reads on, and `characters` is the document's length.",
      {
        kind: z.enum(["kb", "skill"]).describe("Which store the document lives in."),
        id: z.string().describe("The knowledge base or skill id."),
        path: z
          .array(z.string())
          .describe("Path segments inside the folder, file name last."),
        offset: z.number().int().min(0).optional().describe(KB_DOC_OFFSET_DESCRIPTION),
      },
      runWith((args: { kind: "kb" | "skill"; id: string; path: string[]; offset?: number }) => {
        requireOrgAdmin("read store documents");
        const target = resolveStoreTarget(db, args.kind, args.id, { dataRoot });
        if (!target) {
          // Ruling 246's rule for the resource as for the file below: "no
          // longer exists" claims the id once named something, and a mistyped
          // or invented id never did. Name the id and the read that lists the
          // real ones, as every other toolkit miss does.
          throw AppError.notFound(
            args.kind === "kb"
              ? `No knowledge base has the id ${args.id}; list_knowledge_bases names them.`
              : `No skill has the id ${args.id}; list_skills names them.`,
          );
        }
        const doc = readStoreDoc(target, args.path);
        if (!doc) {
          // Ruling 246 (F37-75): say what this reader IS, not that the file
          // "no longer exists" — which claims it once did, and sent the
          // controller looking for a deletion that never happened. The store
          // and the git repository are different places, and the caller most
          // likely to hit this is one that confused them, so it names the
          // reads that do open the repository (ruling 299 gave the controller
          // the default branch).
          throw AppError.notFound(
            `${target.kind === "kb" ? "Knowledge base" : "Skill"} "${target.name}" has no ` +
              `\`${args.path.join("/")}\`. This reads the org KNOWLEDGE-BASE and SKILL store, ` +
              "not a git repository, so a path from the project's repo will never be found here: " +
              "read_default_branch_file reads a file as the project's default branch has it, and " +
              "read_pull_request a pull request's changed files.",
          );
        }
        // Ruling 677: one page at a time, like every other document read. It
        // returned up to 256 KB in one reply, which no turn receives: a skill
        // or a document past about 60 KB could not be read at all.
        const start = args.offset ?? 0;
        if (start > 0 && start >= doc.text.length) {
          throw AppError.validation(
            `\`${args.path.join("/")}\` reads as ${doc.text.length.toLocaleString("en-US")} characters; ` +
              `offset ${start.toLocaleString("en-US")} is past its end.`,
          );
        }
        const end = pageEnd(doc.text, start);
        const more = end < doc.text.length;
        auditRead("read_store_doc", `${target.kind}/${target.id}`, {
          path: args.path.join("/"),
          truncated: doc.truncated || more,
        });
        const page: StoreDocPage = {
          resource: { kind: target.kind, id: target.id, name: target.name },
          path: args.path,
          // Reported, never hidden: a clipped document that reads as complete
          // is how a model states a half-read file as fact. True while a page
          // follows this one, and on the last page of a document longer than
          // this reader takes.
          truncated: doc.truncated || more,
          characters: doc.text.length,
          text: doc.text.slice(start, end),
        };
        if (start > 0) page.offset = start;
        if (more) page.nextOffset = end;
        return json(page);
      }),
    ),
    "read_store_doc",
  );

  const server = createSdkMcpServer({
    name: CONTROLLER_OPS_MCP_NAME,
    version: "1.0.0",
    // Ruling 297, corrected: the manifest rides in the system prompt, which
    // is rebuilt per turn, not here, which is captured once per session.
    instructions: CONTROLLER_OPS_INSTRUCTIONS,
    tools,
  });

  return {
    mcpServers: { [CONTROLLER_OPS_MCP_NAME]: server },
    allowedTools: allowed,
    tools,
  };
}
