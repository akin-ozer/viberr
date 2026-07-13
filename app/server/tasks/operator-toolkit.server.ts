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
  operatorAssessReadiness,
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
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  projectCompletionAdmissionOpen,
  withProjectCompletionEffect,
} from "~/server/runtimes/run-completion-state.server";

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
  expectedTaskIncarnation?: string;
  /** Exact operator lease cancellation state. Project admission can remain
   * open for unrelated work while this particular run has lost ownership. */
  isCancelled?: () => boolean;
  /** Deterministic test seam after effect ownership is registered but before
   * the final admission/incarnation check immediately preceding mutation. */
  beforeMutationForTests?: () => void | Promise<void>;
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
  const { db, ctx, projectSlug, taskKey, authority, expectedTaskIncarnation } = deps;
  const base = { projectSlug, taskKey };
  const assertMutationOwned = () => {
    if (deps.isCancelled?.()) {
      throw new Error(
        `Operator tool ownership for ${projectSlug}/${taskKey} was cancelled.`,
      );
    }
    if (!projectCompletionAdmissionOpen(db, projectSlug)) {
      throw new Error(`Operator tool ownership for project ${projectSlug} was revoked.`);
    }
    if (expectedTaskIncarnation !== undefined) {
      const current = readTaskFile({
        projectSlug,
        taskKey,
        ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
      })?.parsed.frontmatter.createdAt;
      if (current !== expectedTaskIncarnation) {
        throw new Error(`Operator tool target ${projectSlug}/${taskKey} changed incarnation.`);
      }
    }
  };
  const ownedAction = (effect: () => Promise<OperatorActionResult>) =>
    withProjectCompletionEffect(db, projectSlug, async () => {
      assertMutationOwned();
      await deps.beforeMutationForTests?.();
      // Lifecycle revocation or a same-key replacement can win while an SDK
      // tool is awaiting provider/application work. Revalidate at the final
      // boundary before allowing the governed mutation to begin.
      assertMutationOwned();
      return resultText(await effect());
    });
  // Tool availability is frozen for this turn. If readiness was unresolved at
  // turn start, this toolkit can assess/ask/comment only; even a ready verdict
  // cannot be followed by assignment/transition in the same model turn.
  const workAllowed =
    operatorSnapshot(db, ctx, projectSlug, taskKey, authority).readiness === "ready";

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

  add(
    tool(
      "assess_readiness",
      "Resolve readiness BEFORE any assignment, run, prompt, or stage transition. Choose ready only when the canonical goal names a concrete outcome and verification boundary. Choose input_required when intent is missing or only asks to exercise a lifecycle; Viberr then keeps the task in Triage and opens a clarification packet. Never invent product or repository work.",
      {
        verdict: z.enum(["ready", "input_required"]),
        rationale: z.string().describe("Evidence from the canonical goal supporting this verdict."),
        missingInformation: z
          .string()
          .optional()
          .describe("For input_required: exactly what outcome or verification boundary the human must add."),
      },
      async (args) =>
        ownedAction(() =>
          operatorAssessReadiness(
            db,
            ctx,
            {
              ...base,
              verdict: args.verdict,
              rationale: prose(args.rationale),
              ...(args.missingInformation
                ? { missingInformation: prose(args.missingInformation) }
                : {}),
            },
            authority,
          ),
        ),
    ),
    "assess_readiness",
  );

  if (gate(authority, "append-typed-events") !== "deny") {
    add(
      tool(
        "post_comment",
        "Post a concise operator comment to the task timeline. Use it to narrate your plan and decisions (observed → changed → recommended → decision required). Keep it short.",
        { text: z.string().describe("The comment text (markdown allowed).") },
        async (args) =>
          ownedAction(() => operatorPostComment(db, ctx, { ...base, text: prose(args.text) }, authority)),
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
          ownedAction(() =>
            operatorOpenPacket(
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

  if (workAllowed && gate(authority, "assign-primary-specialist") !== "deny") {
    add(
      tool(
        "assign_specialist",
        "Assign an exact hard-eligible routingCandidates.primary profileId/backend pair. Compare declared scope/skills/KB/MCP fit, backend health, workload, and observed cost. YOU make the final choice; Viberr does not score or preselect a winner. The task must already be ready.",
        {
          profileId: z.string().describe("The specialist profile id to assign."),
          backend: z
            .enum(["claude", "codex"])
            .describe("The backend from the selected routing candidate row."),
          reason: z
            .string()
            .trim()
            .min(1)
            .describe("Why this profile/backend choice is the best fit from the supplied context; persisted and audited."),
        },
        async (args) =>
          ownedAction(() =>
            operatorAssignSpecialist(
              db,
              ctx,
              {
                ...base,
                profileId: args.profileId,
                backend: args.backend,
                reason: prose(args.reason),
              },
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
        async () => ownedAction(() => operatorRunSpecialist(db, ctx, base, authority)),
      ),
      "run_specialist",
    );
    add(
      tool(
        "prompt_specialist",
        "Hand the ready task to an exact routingCandidates.primary profileId/backend pair for this stage. YOU choose after comparing fit/resources, backend health, workload, and observed cost, and persist why. Keep the directive inside the canonical goal; never ask the specialist to invent a change.",
        {
          profileId: z.string().describe("The primary specialist profile id to prompt."),
          backend: z
            .enum(["claude", "codex"])
            .describe("The backend from the selected routing candidate row."),
          prompt: z
            .string()
            .describe("The task-related directive to give the specialist (what to do now at this stage)."),
          reason: z
            .string()
            .trim()
            .min(1)
            .describe("Why this profile/backend choice is the best fit from the supplied context; persisted and audited."),
        },
        async (args) =>
          ownedAction(() =>
            operatorPromptSpecialist(
              db,
              ctx,
              {
                ...base,
                profileId: args.profileId,
                backend: args.backend,
                directive: prose(args.prompt),
                reason: prose(args.reason),
              },
              authority,
            ),
          ),
      ),
      "prompt_specialist",
    );
  }

  if (workAllowed && gate(authority, "summon-reviewers") !== "deny") {
    add(
      tool(
        "assign_reviewer",
        "Engage an exact hard-eligible routingCandidates.reviewer profileId/backend pair. Compare review fit/resources, backend health, workload, and observed cost; YOU choose and persist why. Supervised → recommendation card; full autonomy → engages directly.",
        {
          profileId: z.string().describe("The specialist profile id to engage as reviewer."),
          backend: z
            .enum(["claude", "codex"])
            .describe("The backend from the selected routing candidate row."),
          reason: z
            .string()
            .trim()
            .min(1)
            .describe("Why this reviewer/backend choice is the best fit from the supplied context; persisted and audited."),
        },
        async (args) =>
          ownedAction(() =>
            operatorAssignReviewer(
              db,
              ctx,
              {
                ...base,
                profileId: args.profileId,
                backend: args.backend,
                reason: prose(args.reason),
              },
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
          ownedAction(() => operatorRunReviewer(db, ctx, { ...base, profileId: args.profileId }, authority)),
      ),
      "run_reviewer",
    );
    add(
      tool(
        "prompt_reviewer",
        "Hand the ready task to an exact routingCandidates.reviewer profileId/backend pair for the review stage. Compare review fit/resources, backend health, workload, and observed cost, persist why, and keep the directive grounded in this task's goal and evidence.",
        {
          profileId: z.string().describe("The reviewer profile id to prompt."),
          backend: z
            .enum(["claude", "codex"])
            .describe("The backend from the selected routing candidate row."),
          prompt: z
            .string()
            .describe("The task-related directive to give the reviewer (what to review now)."),
          reason: z
            .string()
            .trim()
            .min(1)
            .describe("Why this reviewer/backend choice is the best fit from the supplied context; persisted and audited."),
        },
        async (args) =>
          ownedAction(() =>
            operatorPromptReviewer(
              db,
              ctx,
              {
                ...base,
                profileId: args.profileId,
                backend: args.backend,
                directive: prose(args.prompt),
                reason: prose(args.reason),
              },
              authority,
            ),
          ),
      ),
      "prompt_reviewer",
    );
  }

  if (workAllowed && gate(authority, "stage-transitions") !== "deny") {
    add(
      tool(
        "transition_stage",
        "Move the task to an allowed next stage (see get_task's nextStages) with a short reason. Do NOT move to the final Done stage here — use accept_completion. Supervised → recommendation card; full autonomy → moves directly.",
        {
          toStageId: z.string().describe("The target stage id (must be a declared next stage)."),
          reason: z.string().optional().describe("Why advance now — shown on the recommendation card."),
        },
        async (args) =>
          ownedAction(() =>
            operatorTransitionStage(
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
  if (workAllowed && gate(authority, "completion-for-acceptance") !== "deny") {
    add(
      tool(
        "accept_completion",
        "Accept the task's completion. Under FULL autonomy this moves the task to Done and records the review PR as accepted; the real merge is completed when GitHub is reachable, otherwise it is left 'merge pending' for a human to finish — never claim a merge that has not happened. Under supervised autonomy it posts an actionable 'accept completion → move to Done' recommendation card for a maintainer to apply. Only call this once the work has reached the review boundary and the review is clean.",
        {},
        async () => ownedAction(() => operatorAcceptCompletion(db, ctx, base, authority)),
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
