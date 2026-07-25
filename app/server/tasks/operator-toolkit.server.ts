import type { DatabaseSync } from "node:sqlite";
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
  operatorEngageAgent,
  operatorOpenPacket,
  operatorResolvePacket,
  operatorPostComment,
  operatorPromptAgentGeneric,
  operatorRunAgent,
  operatorSetGoal,
  operatorSnapshot,
  operatorTransitionStage,
  type OperatorActionResult,
  type OperatorAuthority,
} from "./operator-actions.server";
import { PACKET_OPTION_KINDS } from "~/schemas/task-file.schema";
import { normalizeEscapedNewlines } from "./model-prose.server";
import { resolveSpecialistMcpServers } from "./specialist-mcp.server";

/**
 * The operator's in-process governance TOOLS — a Claude Agent SDK MCP server
 * ("viberr") whose handlers call the capability-gated operator-actions with the
 * DB + task context closed over. Because operator runs execute in this same
 * Node process, the tools reach the real store directly (no network), so the
 * board updates live as the operator acts.
 *
 * Which tools are offered depends on the operator's capability policy: a
 * capability in `off` mode ("don't recommend") is withheld — its tool is not
 * even built (mirrors the operator RBAC). `allowedTools` then AUTO-APPROVES
 * those tools; under `bypassPermissions` it removes nothing from the model's
 * context, so it is NOT the fence (P14-KM-12 — this used to claim it "confines
 * the run"). What actually stops a server-spawned operator writing code is the
 * DENY list (`claude-runtime.server.ts`) plus the fact that no repo-write tool
 * is built here at all.
 */

export interface OperatorToolkit {
  /** `{ viberr: <sdk mcp server> }` for the Claude query `mcpServers` option. */
  mcpServers: Record<string, unknown>;
  /** The `mcp__*` tool names this run AUTO-APPROVES (P14-KM-12: confinement is
   *  the deny list, not this). */
  allowedTools: string[];
}

interface ToolkitDeps {
  db: DatabaseSync;
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
      "Read the current task snapshot: stage, readiness, waiting, owner, the engaged agents (delivering + supporting), goal, the deployed agent profiles you can engage, the allowed next stage transitions, any open decision packet, the review `pr` (P13-D-4 — `state: \"closed\"` means a human CLOSED it on GitHub without merging, i.e. the work was rejected out-of-band: do NOT recommend or accept completion, report it and ask what to do), and your own capability policy + autonomy. Call this FIRST and after each change. If the `goal` is still the unspecified triage placeholder, DRAFT it with set_goal (or open an edit_goal packet for the human) BEFORE prompting any agent. SELECT agents by each profile's `desc` (its purpose) and `capabilities` (delivery = builds and owns the branch/PR; verdict = its review verdicts gate acceptance; askHuman = can raise questions) — never by guessing from names.",
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
    add(
      tool(
        "set_goal",
        "Draft or refine the task GOAL when it is still unspecified (the triage-gate placeholder). Use it to write the scope/acceptance criteria you have determined — e.g. after a human accepts your offer to draft the scope, or when the task title gives enough signal to specify it yourself at triage. It fills only an UNSPECIFIED goal; it will refuse to overwrite an already-specified goal (open an edit_goal packet to propose a change to a real goal). Downstream agents re-anchor on the new goal.",
        {
          goal: z.string().describe("The full drafted goal / scope + acceptance criteria."),
          reason: z.string().optional().describe("One line on why this scope — shown on the timeline."),
        },
        async (args) =>
          resultText(
            await operatorSetGoal(
              db,
              ctx,
              { ...base, goal: prose(args.goal), ...(args.reason ? { reason: prose(args.reason) } : {}) },
              authority,
            ),
          ),
      ),
      "set_goal",
    );
  }

  if (gate(authority, "generate-packets") !== "deny") {
    add(
      tool(
        "open_decision_packet",
        "Open a STRUCTURED decision or blocking packet for a human to resolve — the canonical governed hand-off (not a comment). Use it when you reach a genuine decision point or the limit of your authority (a task stuck after repeated no-progress, a policy/credential block, or a completion the human must accept). Prefer this over a plain comment for anything requiring a human choice. Set `packetType` to 'blocked' when work is stuck (also marks the task blocked) or 'input' for a decision. Give 2-4 `options`, each with a stable `kind` and a short title; mark exactly one `recommended`. Use kind 'edit_goal' for an option that asks the human to refine/specify the task GOAL — confirming it opens the goal editor and the packet clears automatically when the edited goal is saved. The human resolves it from the task page.",
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
    add(
      tool(
        "resolve_decision_packet",
        "WITHDRAW the task's open decision packet when it has become MOOT — the input it asked for was provided out-of-band (e.g. a human edited the goal/scope directly instead of clicking an option), or circumstances changed so the decision no longer applies. Give a short `reason`; it is written to the timeline so the decision log shows why the packet was withdrawn. Do NOT withdraw a packet that still genuinely awaits a human decision.",
        {
          reason: z
            .string()
            .describe("Why the packet is moot, e.g. 'the goal now specifies scope + acceptance criteria'."),
        },
        async (args) =>
          resultText(
            await operatorResolvePacket(
              db,
              ctx,
              { ...base, reason: prose(args.reason) },
              authority,
            ),
          ),
      ),
      "resolve_decision_packet",
    );
  }

  // `delivers` selects the engagement shape. Existing capability gates still
  // govern each shape, so a partially-granted operator is refused per call.
  const canDeliverers = gate(authority, "assign-primary-specialist") !== "deny";
  const canSupporting = gate(authority, "summon-reviewers") !== "deny";
  if (canDeliverers || canSupporting) {
    add(
      tool(
        "engage_agent",
        "Engage a deployed agent profile on the task. `delivers: true` makes it THE delivering agent (owns the workspace/branch/PR — exactly one per task); `delivers: false` engages it as a supporting agent (e.g. a verdict-capable profile for review). Pick the profile by its `desc` and `capabilities` from get_task. Supervised → recommendation card; full autonomy → engages directly.",
        {
          profileId: z.string().describe("The agent profile id to engage (from get_task's deployedSpecialists)."),
          delivers: z
            .boolean()
            .describe("true = the delivering agent (builds + owns the branch/PR); false = supporting (review/advice)."),
          reason: z.string().optional().describe("Why this profile fits — shown on the recommendation card."),
        },
        async (args) =>
          resultText(
            await operatorEngageAgent(
              db,
              ctx,
              {
                ...base,
                profileId: args.profileId,
                delivers: args.delivers,
                ...(args.reason ? { reason: prose(args.reason) } : {}),
              },
              authority,
            ),
          ),
      ),
      "engage_agent",
    );
    add(
      tool(
        "run_agent",
        "Start a run for an ENGAGED agent. Omit profileId to run the delivering agent; pass a supporting agent's profileId to run it.",
        {
          profileId: z
            .string()
            .optional()
            .describe("The engaged agent to run; omit for the delivering agent."),
        },
        async (args) =>
          resultText(
            await operatorRunAgent(
              db,
              ctx,
              { ...base, ...(args.profileId ? { profileId: args.profileId } : {}) },
              authority,
            ),
          ),
      ),
      "run_agent",
    );
    add(
      tool(
        "prompt_agent",
        "Hand the task to an agent for the CURRENT stage: engage it (if needed), post a task-related prompt comment addressed to it, and start its run with that prompt as its directive. Use this when a task enters a working stage — it triggers the agent WITH a prompt, not silently. Pass the profileId, a concrete `prompt`, and `delivers` (true = as the delivering builder; false = as a supporting agent, e.g. for review).",
        {
          profileId: z.string().describe("The agent profile id to prompt."),
          prompt: z
            .string()
            .describe("The task-related directive (what to do for this task at this stage)."),
          delivers: z
            .boolean()
            .optional()
            .describe("true = delivering builder · false = supporting (review). Omit to follow how it is already engaged."),
        },
        async (args) =>
          resultText(
            await operatorPromptAgentGeneric(
              db,
              ctx,
              {
                ...base,
                profileId: args.profileId,
                directive: prose(args.prompt),
                ...(args.delivers !== undefined ? { delivers: args.delivers } : {}),
              },
              authority,
            ),
          ),
      ),
      "prompt_agent",
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

  // P13-KM-03: the operator's DECLARED org MCP servers now actually mount. They
  // were offered by the resource catalog and rendered as granted, but nothing
  // ever resolved them for an operator run — `OperatorAuthority` carried skills
  // and kb only, so a live operator granted `everything-mcp` correctly reported
  // "MCP servers/tools I can call: none". `resolveSpecialistMcpServers` skips
  // the reserved `viberr` name, so the in-process toolkit can never be shadowed.
  // Their tools must also be auto-approved: `allowedTools` is the APPROVAL list,
  // not a restriction (P14-KM-12) — without the entry every org MCP call would
  // stall on a permission prompt no human is there to answer.
  const orgServers = resolveSpecialistMcpServers(db, authority.mcps);
  for (const name of Object.keys(orgServers)) {
    allowed.push(`mcp__${name}`);
  }

  return {
    mcpServers: { viberr: server, ...orgServers },
    allowedTools: allowed,
  };
}
