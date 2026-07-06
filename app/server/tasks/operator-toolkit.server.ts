import type Database from "better-sqlite3";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { TaskMutationContext } from "./task-actions.server";
import {
  gate,
  operatorAcceptCompletion,
  operatorAssignReviewer,
  operatorAssignSpecialist,
  operatorPostComment,
  operatorRunReviewer,
  operatorRunSpecialist,
  operatorSnapshot,
  operatorTransitionStage,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-actions.server";

/**
 * The operator's in-process governance TOOLS — a Claude Agent SDK MCP server
 * ("viberr") whose handlers call the capability-gated operator-actions with the
 * DB + task context closed over. Because operator runs execute in this same
 * Node process, the tools reach the real store directly (no network), so the
 * board updates live as the operator acts.
 *
 * Which tools are offered depends on the operator's capability policy: a
 * capability in `off` mode ("don't recommend") is withheld — its tool is not
 * even built (mirrors the operator RBAC). `allowedTools` then confines the run
 * to exactly these tools, so a server-spawned operator can never write code.
 */

export interface OperatorToolkit {
  /** `{ viberr: <sdk mcp server> }` for the Claude query `mcpServers` option. */
  mcpServers: Record<string, unknown>;
  /** The `mcp__viberr__*` tool names the run is confined to. */
  allowedTools: string[];
}

interface ToolkitDeps {
  db: Database.Database;
  ctx: TaskMutationContext;
  projectSlug: string;
  taskKey: string;
  authority: OperatorAuthority;
}

function textResult(payload: unknown) {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function resultText(r: OperatorActionResult) {
  return textResult(`[${r.outcome}] ${r.message}`);
}

/** Build the operator's toolkit for one task run. */
export function buildOperatorToolkit(deps: ToolkitDeps): OperatorToolkit {
  const { db, ctx, projectSlug, taskKey, authority } = deps;
  const base = { projectSlug, taskKey };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [];
  const allowed: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (t: SdkMcpToolDefinition<any>, name: string) => {
    tools.push(t);
    allowed.push(`mcp__viberr__${name}`);
  };

  // get_task — always available (read-only). Also reports the operator's own
  // policy + autonomy so the model knows which actions it may take.
  add(
    tool(
      "get_task",
      "Read the current task snapshot: stage, readiness, waiting, owner, primary specialist, reviewers, goal, the deployed specialists you can assign, the allowed next stage transitions, any open decision packet, and your own capability policy + autonomy. Call this FIRST and after each change.",
      {},
      async () =>
        textResult(operatorSnapshot(db, ctx, projectSlug, taskKey, authority)),
    ),
    "get_task",
  );

  if (gate(authority, "append-typed-events") !== "deny") {
    add(
      tool(
        "post_comment",
        "Post a concise operator comment to the task timeline. Use it to narrate your plan and decisions (observed → changed → recommended → decision required). Keep it short.",
        { text: z.string().describe("The comment text (markdown allowed).") },
        async (args) =>
          resultText(
            await operatorPostComment(db, ctx, { ...base, text: args.text }, authority),
          ),
      ),
      "post_comment",
    );
  }

  if (gate(authority, "assign-primary-specialist") !== "deny") {
    add(
      tool(
        "assign_specialist",
        "Assign a deployed specialist as the task's PRIMARY specialist. Pass the specialist's profileId (from get_task's deployedSpecialists).",
        { profileId: z.string().describe("The specialist profile id to assign.") },
        async (args) =>
          resultText(
            await operatorAssignSpecialist(db, ctx, { ...base, profileId: args.profileId }, authority),
          ),
      ),
      "assign_specialist",
    );
    add(
      tool(
        "run_specialist",
        "Start an agent run for the assigned primary specialist so it does the stage work.",
        {},
        async () =>
          resultText(await operatorRunSpecialist(db, ctx, base, authority)),
      ),
      "run_specialist",
    );
  }

  if (gate(authority, "summon-reviewers") !== "deny") {
    add(
      tool(
        "assign_reviewer",
        "Engage a deployed specialist as a REVIEWER (advisory, non-primary). Pass its profileId.",
        { profileId: z.string().describe("The specialist profile id to engage as reviewer.") },
        async (args) =>
          resultText(
            await operatorAssignReviewer(db, ctx, { ...base, profileId: args.profileId }, authority),
          ),
      ),
      "assign_reviewer",
    );
    add(
      tool(
        "run_reviewer",
        "Start an agent run for an engaged reviewer. Pass its profileId.",
        { profileId: z.string().describe("The engaged reviewer's profile id.") },
        async (args) =>
          resultText(
            await operatorRunReviewer(db, ctx, { ...base, profileId: args.profileId }, authority),
          ),
      ),
      "run_reviewer",
    );
  }

  if (gate(authority, "stage-transitions") !== "deny") {
    add(
      tool(
        "transition_stage",
        "Move the task to an allowed next stage (see get_task's nextStages). Do NOT try to move to the final Done stage here — use accept_completion for that.",
        { toStageId: z.string().describe("The target stage id (must be a declared next stage).") },
        async (args) =>
          resultText(
            await operatorTransitionStage(db, ctx, { ...base, toStageId: args.toStageId }, authority),
          ),
      ),
      "transition_stage",
    );
  }

  // accept_completion: offered when the operator holds the completion
  // capability OR runs under full autonomy (full autonomy is what actually
  // moves the task to Done; supervised opens a packet for a human).
  if (
    gate(authority, "completion-for-acceptance") !== "deny" ||
    authority.autonomy === "full"
  ) {
    add(
      tool(
        "accept_completion",
        "Accept the task's completion. Under FULL autonomy this moves the task to Done and marks the review PR merged. Under supervised autonomy it opens a completion packet for a human to accept. Only call this once the work has reached the review boundary.",
        {},
        async () =>
          resultText(await operatorAcceptCompletion(db, ctx, base, authority)),
      ),
      "accept_completion",
    );
  }

  const server = createSdkMcpServer({
    name: "viberr",
    version: "1.0.0",
    instructions:
      "Viberr governance tools. You are the task operator. Use these tools to coordinate the task; never write code or touch the repository.",
    tools,
  });

  return { mcpServers: { viberr: server }, allowedTools: allowed };
}
