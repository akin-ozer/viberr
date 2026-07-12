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
  operatorOpenPacket,
  operatorPostComment,
  operatorPromptReviewer,
  operatorPromptSpecialist,
  operatorRunReviewer,
  operatorRunSpecialist,
  operatorSnapshot,
  operatorTransitionStage,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-actions.server";
import { PACKET_OPTION_KINDS } from "~/schemas/task-file.schema";
import { normalizeEscapedNewlines } from "./model-prose.server";

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

// Every model-emitted prose string crosses into the store through here —
// repair double-escaped `\n` sequences before they persist (finding #23:
// literal "\n" rendered verbatim on the timeline).
const prose = normalizeEscapedNewlines;

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
            await operatorPostComment(db, ctx, { ...base, text: prose(args.text) }, authority),
          ),
      ),
      "post_comment",
    );
  }

  if (gate(authority, "generate-packets") !== "deny") {
    add(
      tool(
        "open_decision_packet",
        "Open a STRUCTURED decision or blocking packet for a human to resolve — the canonical governed hand-off (not a comment). Use it when you reach a genuine decision point or the limit of your authority (a task stuck after repeated no-progress, a policy/credential block, or a completion the human must accept). Prefer this over a plain comment for anything requiring a human choice. Set `packetType` to 'blocked' when work is stuck (also marks the task blocked) or 'input' for a decision. Give 2-4 `options`, each with a stable `kind` and a short title; mark exactly one `recommended`. The human resolves it from the task page.",
        {
          packetType: z
            .enum(["input", "blocked"])
            .describe("'blocked' when work is stuck (marks the task blocked); 'input' for a decision the human should make."),
          title: z.string().describe("Short packet title, e.g. 'Implementation stalled — pick a recovery path'."),
          body: z.string().optional().describe("One or two sentences of context (no raw logs/secrets)."),
          observations: z
            .array(
              z.object({
                k: z.string().describe("Label, e.g. 'Branch' or 'Reviewer verdict'."),
                v: z.string().describe("Value."),
                code: z.boolean().optional().describe("Render the value as code."),
              }),
            )
            .optional()
            .describe("Typed observed facts shown above the options."),
          options: z
            .array(
              z.object({
                kind: z
                  .enum(PACKET_OPTION_KINDS as unknown as [string, ...string[]])
                  .describe("Stable option kind the resolver dispatches on."),
                title: z.string().describe("Button label, e.g. 'Reassign to a different developer'."),
                detail: z.string().optional().describe("Short explanation under the option."),
                recommended: z.boolean().optional().describe("Mark exactly ONE option recommended."),
              }),
            )
            .describe("The 2-4 resolvable options; exactly one recommended."),
        },
        async (args) =>
          resultText(
            await operatorOpenPacket(
              db,
              ctx,
              {
                ...base,
                packetType: args.packetType,
                title: prose(args.title),
                ...(args.body ? { body: prose(args.body) } : {}),
                ...(args.observations
                  ? {
                      // Code-flagged observation values render as code — their
                      // backslashes are content, so only prose values are repaired.
                      observations: args.observations.map((o) => ({
                        k: prose(o.k),
                        v: o.code ? o.v : prose(o.v),
                        ...(o.code !== undefined ? { code: o.code } : {}),
                      })),
                    }
                  : {}),
                options: args.options.map((o) => ({
                  kind: o.kind as (typeof PACKET_OPTION_KINDS)[number],
                  title: prose(o.title),
                  ...(o.detail ? { detail: prose(o.detail) } : {}),
                  ...(o.recommended !== undefined ? { recommended: o.recommended } : {}),
                })),
              },
              authority,
            ),
          ),
      ),
      "open_decision_packet",
    );
  }

  if (gate(authority, "assign-primary-specialist") !== "deny") {
    add(
      tool(
        "assign_specialist",
        "Assign a deployed specialist as the task's PRIMARY specialist. Pass the specialist's profileId (from get_task's deployedSpecialists) and a short reason. Under supervised autonomy this posts a recommendation card; under full autonomy it assigns directly.",
        {
          profileId: z.string().describe("The specialist profile id to assign."),
          reason: z.string().optional().describe("Why this specialist fits — shown on the recommendation card."),
        },
        async (args) =>
          resultText(
            await operatorAssignSpecialist(
              db,
              ctx,
              { ...base, profileId: args.profileId, ...(args.reason ? { reason: prose(args.reason) } : {}) },
              authority,
            ),
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
    add(
      tool(
        "prompt_specialist",
        "Hand the task to the primary specialist for the CURRENT stage: assign it (if needed), post a task-related prompt comment addressed to it, and start its run with that prompt as its directive. Use this when a task enters a new working stage — it triggers the agent WITH a prompt, not silently. Pass the specialist's profileId and a concrete `prompt` telling it what to do for this task at this stage.",
        {
          profileId: z.string().describe("The primary specialist profile id to prompt."),
          prompt: z
            .string()
            .describe("The task-related directive to give the specialist (what to do now at this stage)."),
        },
        async (args) =>
          resultText(
            await operatorPromptSpecialist(
              db,
              ctx,
              { ...base, profileId: args.profileId, directive: prose(args.prompt) },
              authority,
            ),
          ),
      ),
      "prompt_specialist",
    );
  }

  if (gate(authority, "summon-reviewers") !== "deny") {
    add(
      tool(
        "assign_reviewer",
        "Engage a deployed specialist as a REVIEWER (advisory, non-primary). Pass its profileId and a short reason. Supervised → recommendation card; full autonomy → engages directly.",
        {
          profileId: z.string().describe("The specialist profile id to engage as reviewer."),
          reason: z.string().optional().describe("Why engage this reviewer — shown on the recommendation card."),
        },
        async (args) =>
          resultText(
            await operatorAssignReviewer(
              db,
              ctx,
              { ...base, profileId: args.profileId, ...(args.reason ? { reason: prose(args.reason) } : {}) },
              authority,
            ),
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
    add(
      tool(
        "prompt_reviewer",
        "Hand the task to a reviewer for the REVIEW stage: engage it (if needed), post a task-related prompt comment addressed to it, and start its reviewer run with that prompt as its directive. Use this when a task enters the review stage. Pass the reviewer's profileId and a concrete `prompt` telling it what to review for this task.",
        {
          profileId: z.string().describe("The reviewer profile id to prompt."),
          prompt: z
            .string()
            .describe("The task-related directive to give the reviewer (what to review now)."),
        },
        async (args) =>
          resultText(
            await operatorPromptReviewer(
              db,
              ctx,
              { ...base, profileId: args.profileId, directive: prose(args.prompt) },
              authority,
            ),
          ),
      ),
      "prompt_reviewer",
    );
  }

  if (gate(authority, "stage-transitions") !== "deny") {
    add(
      tool(
        "transition_stage",
        "Move the task to an allowed next stage (see get_task's nextStages) with a short reason. Do NOT move to the final Done stage here — use accept_completion. Supervised → recommendation card; full autonomy → moves directly.",
        {
          toStageId: z.string().describe("The target stage id (must be a declared next stage)."),
          reason: z.string().optional().describe("Why advance now — shown on the recommendation card."),
        },
        async (args) =>
          resultText(
            await operatorTransitionStage(
              db,
              ctx,
              { ...base, toStageId: args.toStageId, ...(args.reason ? { reason: prose(args.reason) } : {}) },
              authority,
            ),
          ),
      ),
      "transition_stage",
    );
  }

  // accept_completion: offered ONLY when the completion capability is granted
  // (direct or recommend). `human`/`off` withhold the tool entirely — full
  // autonomy does NOT smuggle it back in (owner ruling Q1: the human-only-Done
  // exception requires an explicit grant, never an autonomy side-effect).
  if (gate(authority, "completion-for-acceptance") !== "deny") {
    add(
      tool(
        "accept_completion",
        "Accept the task's completion. Under FULL autonomy this moves the task to Done and records the review PR as accepted; the real merge is completed when GitHub is reachable, otherwise it is left 'merge pending' for a human to finish — never claim a merge that has not happened. Under supervised autonomy it posts an actionable 'accept completion → move to Done' recommendation card for a maintainer to apply. Only call this once the work has reached the review boundary and the review is clean.",
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
