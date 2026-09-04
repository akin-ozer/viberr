import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { TaskMutationContext } from "./task-actions.server";
import {
  deliverGate,
  dispatchGate,
  gate,
  operatorAcceptCompletion,
  operatorDeliverForReview,
  operatorDispatchAgent,
  operatorFlagContextConflict,
  operatorOpenPacket,
  operatorResolvePacket,
  operatorPostComment,
  operatorSetGoal,
  operatorSnapshot,
  operatorTransitionStage,
  type OperatorActionResult,
  type OperatorAuthority,
  type OperatorOpenPacketInput,
  type OperatorPacketOptionInput,
} from "./operator-actions.server";
import {
  operatorUpdateBranchFromBase,
  updateBranchGate,
} from "~/server/github/update-branch-operator.server";
import { PACKET_OPTION_KINDS } from "~/schemas/task-file.schema";
import { normalizeEscapedNewlines } from "./model-prose.server";
import {
  resolveSpecialistMcpServers,
  type SpecialistMcpServerConfig,
} from "./specialist-mcp.server";
import { listDeployedSpecialists } from "./specialist-run.server";
import {
  readDefaultBranchFile,
  DEFAULT_BRANCH_READ_MAX_BYTES,
} from "./operator-repo-read.server";

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

/** What the run mounts, keyed by server name: the in-process `viberr`
 *  governance server, plus whichever org MCP grants resolved. */
export type OperatorMcpServers = Record<
  string,
  McpSdkServerConfigWithInstance | SpecialistMcpServerConfig
>;

export interface OperatorToolkit {
  /** `{ viberr: <sdk mcp server> }` for the Claude query `mcpServers` option. */
  mcpServers: OperatorMcpServers;
  /** The `mcp__*` tool names this run AUTO-APPROVES (P14-KM-12: confinement is
   *  the deny list, not this). */
  allowedTools: string[];
  /**
   * The in-process governance tools, as definitions. The run itself reads them
   * through `mcpServers.viberr`; this is the seam that lets a test CALL one —
   * the alternative is reaching into the MCP SDK's private `_registeredTools`,
   * which would pass silently the day the SDK renames it. Behaviour that only
   * appears when a handler actually runs (R20-9's delegated-ask disclosure) is
   * otherwise untestable without a live model.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: SdkMcpToolDefinition<any>[];
}

interface ToolkitDeps {
  db: DatabaseSync;
  ctx: TaskMutationContext;
  projectSlug: string;
  taskKey: string;
  authority: OperatorAuthority;
  /**
   * F21-21: the task checkout this run really got, when it got one. Its presence
   * is what offers `read_default_branch_file` — the operator's only anchored way
   * to ask what the DEFAULT branch contains (the checkout itself sits on the
   * task branch once the deliverer commits, and the operator holds no `Bash`).
   */
  workspace?: {
    /** Absolute checkout path. */
    dir: string;
    /** The project's default branch, e.g. `main`. */
    defaultBranch: string;
  };
  /**
   * F21-3: the org MCP servers this run already resolved AND pre-flighted
   * (`operatorMcpResolution`). Passed in so the toolkit mounts exactly what the
   * system prompt announced: resolving a second time here would re-mount a
   * stdio server the pre-flight just dropped, and the prompt and the mount would
   * disagree about what the run has. Omitted only by callers with no resolution
   * of their own (tests), which fall back to the un-pre-flighted resolve.
   */
  orgMcpServers?: Record<string, SpecialistMcpServerConfig>;
}

/** Every tool answers with one text block — the SDK's tool-result shape. */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Every model-emitted prose string crosses into the store through here —
// repair double-escaped `\n` sequences before they persist (finding #23:
// literal "\n" rendered verbatim on the timeline).
const prose = normalizeEscapedNewlines;

function resultText(r: OperatorActionResult) {
  return textResult(`[${r.outcome}] ${r.message}`);
}

// The action inputs, taken FROM the actions themselves: each handler below
// fills one field at a time (an absent key and a key set to undefined are not
// the same thing to these actions), so it needs the contract by name.
type SetGoalInput = Parameters<typeof operatorSetGoal>[2];
type OpenPacketObservation = NonNullable<
  OperatorOpenPacketInput["observations"]
>[number];
type DispatchAgentInput = Parameters<typeof operatorDispatchAgent>[2];
type DeliverInput = Parameters<typeof operatorDeliverForReview>[2];
type TransitionInput = Parameters<typeof operatorTransitionStage>[2];

/**
 * The MCP instructions block the model reads alongside these tools.
 *
 * R19-1 changed what is true here. The old sentence — "never write code or
 * touch the repository" — was written when the operator had no working tree at
 * all, and it now contradicts the run's own system prompt, which hands it a
 * READ-ONLY checkout and requires every packet that reasons about repository
 * contents to be grounded in it. A model told by one channel to read the repo
 * and by another never to touch it can resolve that either way, and the way
 * that loses is the F19-4 failure: describing the empty task folder as "the
 * repo". So the prohibition is stated precisely — the model's own hands never
 * edit or commit — and reading is stated as the expectation it now is.
 *
 * "You cannot push" would be wrong in the other direction: `deliver_for_review`
 * (below) pushes the deliverer's committed branch, and both the operator
 * definition and that tool's description tell the model delivery is its
 * decision to make. Contradicting them here would risk an operator that stops
 * delivering — so the push is named as the SERVER's action, which is what it is.
 */
export const OPERATOR_TOOLKIT_INSTRUCTIONS =
  "Viberr coordination tools. You are the task operator. Use these tools to coordinate the task. " +
  "You never write code: you cannot edit, create or commit files in the repository checkout, and " +
  "the file-writing and shell tools are withheld from this run — delivery is a decision you make " +
  "and the server executes. READING the task's repository checkout is expected of you — any claim " +
  "you make about the repository must come from reading it, never from the task folder you are " +
  "standing in.";

/**
 * R20-9 / ruling 84 — the DELEGATED-ASK disclosure, made mechanical.
 *
 * The ruling was prompt-only: an operator that consults a specialist and then
 * raises the human-facing packet itself must say whose ask it is carrying,
 * because the timeline otherwise reads as if that agent never held the
 * question. A rule the model must remember is a rule it will eventually forget,
 * so the server remembers instead: every profile a run actually PROMPTED is
 * recorded, and the packet writer appends the disclosure when that same run
 * then opens a packet.
 *
 * Band-3 follow-up: the ledger and the writer live HERE, not inside
 * `buildOperatorToolkit`, because the Claude toolkit is only one of the two
 * paths that open packets. The Codex plan executor
 * (`executeCodexPlan`, operator-run.server.ts) opens them itself, so a
 * closure-scoped disclosure covered exactly one backend and a Codex plan that
 * prompted an agent and then opened a packet reached the human with nothing
 * said. One ledger + one writer, both backends.
 *
 * Deliberately in-run and in-memory: the point is "you consulted an agent
 * DURING this turn and are now asking a human", which is exactly one run's
 * scope. Prompt guidance stays (the model should still say WHY in its own
 * words); this only guarantees the fact is never absent.
 */
export function noteConsultedProfile(
  into: string[],
  profileId: string,
  outcome: OperatorActionResult["outcome"],
): void {
  // A denied / recommended / no-op prompt consulted nobody — disclosing it
  // would be a different lie from the one this fixes.
  if (outcome !== "done") return;
  if (!into.includes(profileId)) into.push(profileId);
}

/** The disclosure line for the profiles this run really prompted, or "". */
function consultationDisclosure(
  ctx: TaskMutationContext,
  projectSlug: string,
  consultedProfileIds: readonly string[],
): string {
  if (consultedProfileIds.length === 0) return "";
  const deployed = listDeployedSpecialists(projectSlug, ctx);
  const names = consultedProfileIds.map(
    (id) => deployed.find((s) => s.id === id)?.name ?? id,
  );
  return (
    `\n\n_Disclosure: before opening this, the operator prompted ${names.join(", ")} on this task — ` +
    "this decision is being raised with you by the operator, not by that agent._"
  );
}

/**
 * THE packet writer for both operator backends: `operatorOpenPacket` with the
 * R20-9 disclosure appended for whichever profiles this run consulted
 * (`noteConsultedProfile`). Pass an empty array when nothing was consulted —
 * the disclosure is a FACT, so it is absent unless a prompt actually landed.
 */
export async function operatorOpenPacketDisclosed(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: OperatorOpenPacketInput,
  authority: OperatorAuthority,
  consultedProfileIds: readonly string[],
): Promise<OperatorActionResult> {
  const body = `${input.body ?? ""}${consultationDisclosure(ctx, input.projectSlug, consultedProfileIds)}`;
  const disclosed: OperatorOpenPacketInput = { ...input };
  if (body) disclosed.body = body;
  return operatorOpenPacket(db, ctx, disclosed, authority);
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

  /** R20-9: the profiles THIS run prompted, for the disclosure the shared
   *  packet writer appends (`operatorOpenPacketDisclosed`). */
  const consultedProfileIds: string[] = [];

  // get_task — always available (read-only). Also reports the operator's own
  // policy + autonomy so the model knows which actions it may take.
  add(
    tool(
      "get_task",
      "Read the current task snapshot: stage (plus `previousStage`, where the task CAME from — arriving back from a later stage means rework for the profile that built it), readiness, waiting, owner, the engaged agents (delivering + supporting), goal, the deployed agent profiles you can run, the allowed next stage transitions, any open decision packet, the review `pr` (P13-D-4 — `state: \"closed\"` means a human CLOSED it on GitHub without merging, i.e. the work was rejected out-of-band: do NOT recommend or accept completion, report it and ask what to do; `pr.revisionDrift` names commits pushed to the PR head AFTER the last reviewed revision, which ship UNREVIEWED and must be stated wherever you reason about that PR), and `operatorPolicy` + autonomy. TWO SCOPES, do not mix them: `operatorPolicy` is YOUR OWN capability policy (`operatorPolicy.scope: \"operator\"`, and read its `note`), while each agent's own grants are `deployedSpecialists[].capabilities` — never quote a row of yours as evidence about an agent. Call this FIRST and after each change. If the `goal` is still the unspecified triage placeholder, DRAFT it with set_goal (or open an edit_goal packet for the human) BEFORE prompting any agent. SELECT agents by each profile's `desc` (its purpose) and `capabilities` (delivery = builds and owns the branch/PR; verdict = its review verdicts gate acceptance; askHuman = can raise questions; browser = can drive a live browser; web = holds web search/fetch egress) — never by guessing from names.",
      {},
      async () =>
        textResult(
          JSON.stringify(
            operatorSnapshot(db, ctx, projectSlug, taskKey, authority),
            null,
            2,
          ),
        ),
    ),
    "get_task",
  );

  // F21-21: the ONE anchored answer to "what is on the default branch?".
  //
  // The checkout under the operator's cwd is the delivering agent's workspace,
  // so after that agent commits it stands on the TASK branch — reading it and
  // calling the result "the default branch" is what produced a live blocking
  // packet accusing a healthy flow of an out-of-band merge (VIB-7). The
  // operator cannot run `git show` itself (`Bash` is denied for every operator
  // run), so the anchored read has to be a tool. Offered only when the run
  // actually has a checkout — a tool that can never answer is worse than none.
  if (deps.workspace) {
    const workspace = deps.workspace;
    add(
      tool(
        "read_default_branch_file",
        `Read one file AS THE DEFAULT BRANCH (\`${workspace.defaultBranch}\`) HAS IT — the only valid way to answer "is this already on ${workspace.defaultBranch}?". The repository checkout under your working directory is the DELIVERING AGENT'S workspace and stands on THIS TASK's branch once it starts work, so Read/Grep/Glob there show the task's own in-progress changes — never treat that as the default branch, and never conclude from it that work landed out-of-band. This tool reads \`origin/${workspace.defaultBranch}\` directly (refreshing it from GitHub when a credential is available) and says plainly when the path is NOT on that branch.`,
        {
          path: z
            .string()
            .describe(
              "Repository-relative file path, e.g. 'docs/guide.md' (no leading slash).",
            ),
        },
        async (args) => {
          const read = await readDefaultBranchFile(db, {
            projectSlug,
            dir: workspace.dir,
            defaultBranch: workspace.defaultBranch,
            path: args.path,
          });
          if (read.kind === "absent") {
            return textResult(
              `[absent] \`${args.path}\` does NOT exist on \`${workspace.defaultBranch}\`.`,
            );
          }
          if (read.kind === "unavailable") {
            return textResult(
              `[unavailable] \`${args.path}\` could not be read from \`${workspace.defaultBranch}\`: ${read.reason}. ` +
                "Say so rather than substituting a read of the checkout — that tree is on the task branch.",
            );
          }
          const freshness = read.refreshed
            ? `\`origin/${workspace.defaultBranch}\`, just refreshed from GitHub`
            : `\`origin/${workspace.defaultBranch}\` as of this task's checkout (the refresh from GitHub did not run — treat it as slightly stale)`;
          const cut = read.truncated
            ? `\n\n[truncated at ${DEFAULT_BRANCH_READ_MAX_BYTES} characters]`
            : "";
          return textResult(
            `[found] \`${args.path}\` on ${freshness}:\n\n${read.text}${cut}`,
          );
        },
      ),
      "read_default_branch_file",
    );
  }

  // R19-1 (owner ruling): the operator reads the repository from the FULL
  // read-only checkout provisioned under its cwd (`ensureOperatorRepoCheckout`
  // in operator-run.server.ts) with Read/Grep/Glob — see `workspaceSection`.
  // Session B's API-based `list_repo_files`/`read_repo_file` MCP tools were
  // dropped in the pass-19 merge: the clone is a strictly richer view, and their
  // "your cwd is NOT the repository" persona is false once the checkout lives in
  // that cwd. A second repo surface would double-answer the question the ruling
  // settled.

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
        async (args) => {
          const input: SetGoalInput = { ...base, goal: prose(args.goal) };
          if (args.reason) input.reason = prose(args.reason);
          return resultText(await operatorSetGoal(db, ctx, input, authority));
        },
      ),
      "set_goal",
    );
    // R19-2: the repository wins over a knowledge base for how the repository's
    // own files should look — but the disagreement is never settled quietly.
    add(
      tool(
        "flag_context_conflict",
        "Flag that a knowledge base attached to this task's agents contradicts the repository's OWN documented conventions for how its files should look. The REPOSITORY wins — follow it, and say so — but never settle the disagreement silently: this records a flag the humans see. Name both sides.",
        {
          kbSource: z
            .string()
            .describe("The knowledge-base document that disagrees."),
          repoSource: z
            .string()
            .describe(
              "The repository file that is authoritative, e.g. 'qa/smoke/README.md'.",
            ),
          detail: z
            .string()
            .describe(
              "One or two sentences: what each says, and what was followed.",
            ),
        },
        async (args) =>
          resultText(
            await operatorFlagContextConflict(
              db,
              ctx,
              {
                ...base,
                kbSource: prose(args.kbSource),
                repoSource: prose(args.repoSource),
                detail: prose(args.detail),
              },
              authority,
            ),
          ),
      ),
      "flag_context_conflict",
    );
  }

  if (gate(authority, "generate-packets") !== "deny") {
    add(
      tool(
        "open_decision_packet",
        "Open a STRUCTURED decision or blocking packet for a human to resolve — the canonical governed hand-off (not a comment). Use it when you reach a genuine decision point or the limit of your authority (a task stuck after repeated no-progress, a policy/credential block, or a completion the human must accept). Prefer this over a plain comment for anything requiring a human choice. Set `packetType` to 'blocked' when work is stuck (also marks the task blocked) or 'input' for a decision. Give 2-4 `options`, each with a stable `kind` and a short title; mark exactly one `recommended`. Use kind 'edit_goal' for an option that asks the human to refine/specify the task GOAL — confirming it opens the goal editor and the packet clears automatically when the edited goal is saved. ONE packet stands at a time: this REFUSES while a packet is already open (whoever is answering it must not be stranded) — answer from that packet, or withdraw it with resolve_decision_packet when it is genuinely moot, then open yours. Ruling 85: when the blocker is a CAPABILITY no deployed agent declares (see `deployedSpecialists[].capabilities` — browser, web, verdict, delivery), state the gap as an observation AND name the product's remedy — that capability is grantable on an agent profile from the project's Agents surface — and offer it as an option beside any workaround; a packet that offers only workarounds hides the fix. You never change that configuration yourself. The human resolves it from the task page.",
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
                  .enum(PACKET_OPTION_KINDS)
                  .describe(
                    "Stable option kind the resolver dispatches on. For a delivery push_conflict caused by an UNRELATED remote branch squatting on this task's branch name (usually with an unowned PR), use 'resolve_remote_collision' — the human's confirm closes that PR, deletes the stale remote branch and re-delivers this task's local work. Never author 'discard_branch' for that shape: it deletes the LOCAL branch and is refused on a task with a delivered revision or an occupied branch name.",
                  ),
                title: z.string().describe("Button label, e.g. 'Reassign to a different developer'."),
                detail: z.string().optional().describe("Short explanation under the option."),
                recommended: z.boolean().optional().describe("Mark exactly ONE option recommended."),
                backend: z
                  .enum(["claude", "codex"])
                  .optional()
                  .describe(
                    "retry_other_backend only: which backend to re-run the failed agent on. It must be the OTHER one — omit it and the server fills in the opposite of the backend that just failed.",
                  ),
                profileId: z
                  .string()
                  .optional()
                  .describe(
                    "retry_other_backend only: the agent profile to re-run; omit to re-run the agent whose run failed.",
                  ),
                deleteBranch: z
                  .boolean()
                  .optional()
                  .describe(
                    "archive_task only: ALSO delete the task's remote branch (discard the rejected work entirely).",
                  ),
              }),
            )
            .describe("The 2-4 resolvable options; exactly one recommended."),
        },
        async (args) => {
          const input: OperatorOpenPacketInput = {
            ...base,
            packetType: args.packetType,
            title: prose(args.title),
            options: args.options.map((o) => {
              const option: OperatorPacketOptionInput = {
                kind: o.kind,
                title: prose(o.title),
              };
              if (o.detail) option.detail = prose(o.detail);
              if (o.recommended !== undefined) option.recommended = o.recommended;
              if (o.backend) option.backend = o.backend;
              if (o.profileId) option.profileId = o.profileId;
              if (o.deleteBranch) option.deleteBranch = true;
              return option;
            }),
          };
          if (args.body) input.body = prose(args.body);
          if (args.observations) {
            // Code-flagged observation values render as code — their
            // backslashes are content, so only prose values are repaired.
            input.observations = args.observations.map((o) => {
              const observed: OpenPacketObservation = {
                k: prose(o.k),
                v: o.code ? o.v : prose(o.v),
              };
              if (o.code !== undefined) observed.code = o.code;
              return observed;
            });
          }
          // R20-9 / ruling 84: the delegated-ask disclosure is appended by the
          // SHARED writer, so a packet raised after the operator consulted an
          // agent this run can never reach a human without saying so — even for
          // a body the model left empty, and on either backend.
          return resultText(
            await operatorOpenPacketDisclosed(
              db,
              ctx,
              input,
              authority,
              consultedProfileIds,
            ),
          );
        },
      ),
      "open_decision_packet",
    );
    add(
      tool(
        "resolve_decision_packet",
        "WITHDRAW YOUR OWN open decision packet when it has become MOOT — the input it asked for was provided out-of-band (e.g. a human edited the goal/scope directly instead of clicking an option), or circumstances changed so the decision no longer applies. Give a short `reason`; it is written to the timeline so the decision log shows why the packet was withdrawn. Do NOT withdraw a packet that still genuinely awaits a human decision. A packet an AGENT raised (an ask-human question) is refused: only the human's answer resolves it, and withdrawing it would leave that agent blocked forever.",
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

  // Dynamic-dispatch rework (2026-08-29): ONE tool selects AND runs an agent —
  // the collapsed replacement for engage_agent / run_agent / prompt_agent.
  // Gated by `dispatch-agents` (the collapsed assign/summon pair).
  if (dispatchGate(authority) !== "deny") {
    add(
      tool(
        "run_agent",
        "Select a deployed agent and put it to work on the task — YOU choose which agent fits what the CURRENT stage needs, weighing where the task just came from (a task back from Review is rework for the same builder; a task newly in Review wants a verdict-capable profile). Pick by each profile's `desc` and `capabilities` from get_task, never by name. Engages the profile if needed: it becomes the delivering agent when the task has none and it holds repo-write, otherwise a supporting agent (its own read-only checkout; a verdict-capable one gates acceptance). Pass a concrete `prompt` when handing off work — it is posted as your comment and becomes the run's directive; omit it only to re-run an agent against the task as it stands. `delivers: true` explicitly hands delivery to this profile (reassigning the current deliverer). Supervised → ONE run-agent recommendation card; full autonomy → runs directly.",
        {
          profileId: z
            .string()
            .describe("The agent profile id to run (from get_task's deployedSpecialists)."),
          prompt: z
            .string()
            .optional()
            .describe("The task-related directive (what to do for this task at this stage). Omit for a bare re-run."),
          delivers: z
            .boolean()
            .optional()
            .describe("true = hand delivery to this profile · false = run as supporting. Omit to derive from its grants and the task's current deliverer."),
          reason: z
            .string()
            .optional()
            .describe("Why this profile fits — recorded on the selection trace and the recommendation card."),
        },
        async (args) => {
          const input: DispatchAgentInput = {
            ...base,
            profileId: args.profileId,
          };
          if (args.prompt) input.prompt = prose(args.prompt);
          if (args.delivers !== undefined) input.delivers = args.delivers;
          if (args.reason) input.reason = prose(args.reason);
          const result = await operatorDispatchAgent(db, ctx, input, authority);
          // R20-9: remember the consultation so a packet opened later in THIS
          // run discloses it without the model having to remember.
          noteConsultedProfile(consultedProfileIds, args.profileId, result.outcome);
          return resultText(result);
        },
      ),
      "run_agent",
    );
  }

  // R15-2: delivery (push the branch + open the review PR) is the operator's
  // decision, gated by `deliver-review-pr` (absent = granted — the capability
  // postdates live deployments; see deliverGate).
  if (deliverGate(authority) !== "deny") {
    add(
      tool(
        "deliver_for_review",
        "DELIVER the task: push the delivering agent's committed branch and open (or reuse) the review pull request. Delivery is YOUR decision, not a stage side-effect — deliver when the work is committed and plausible for review, weighing the task's REMAINING stages (a later stage like QA need not gate delivery for this task; offer early delivery when so). When unsure whether the branch should be pushed, open a decision packet instead. The result reports the push status and PR number honestly: a `push_conflict` means the remote branch diverged (a history conflict, NOT a credential problem) and no PR was opened — open a decision packet naming the branch with a `resolve_remote_collision` option (clears the stale remote branch and its recorded squatting PR, then re-delivers; never `discard_branch`, which destroys the task's LOCAL commits) so a human resolves it. Never instruct a specialist to push or open a PR; this tool is how delivery happens. " + "When the task's PR is already open and `get_task` shows `pr.unpushedRevision`, call `deliver_for_review`: it pushes the delivered revision to that PR. Pushing is never a person's job and never an agent's. A result of `up_to_date` means the PR already carries the workspace head; the tool never says nothing to deliver from a cached PR state.",
        {
          reason: z
            .string()
            .optional()
            .describe("One line on why delivery is right now — shown on the recommendation card when your policy recommends instead of performs."),
        },
        async (args) => {
          const input: DeliverInput = { ...base };
          if (args.reason) input.reason = prose(args.reason);
          return resultText(
            await operatorDeliverForReview(db, ctx, input, authority),
          );
        },
      ),
      "deliver_for_review",
    );
  }

  // N19-9: the branch can finally be moved FORWARD onto an advanced base. Same
  // shape as delivery (R15-2): the operator decides, the server does the git,
  // and a conflict stops and asks a human (R18-4) instead of being retried.
  if (updateBranchGate(authority) !== "deny") {
    add(
      tool(
        "update_branch_from_base",
        "Bring the task's branch UP TO DATE with the project's base branch — merge the base into the branch and push it. Other tasks share this repository, so a branch goes stale the moment one of them merges; a reviewer then reads a diff against a base that no longer exists, and delivery can hit a conflict nobody chose. Call it BEFORE you deliver and before you hand work to a reviewer. It is idempotent and cheap: an already-current branch changes nothing and says so, so call it when you are unsure rather than guessing. The server does the git inside the delivering agent's workspace — never ask an agent to rebase, merge or force-push. If the branch CONFLICTS with the base, the merge is aborted, the branch is left exactly as it was, and a blocking decision packet is opened for a human: report that and stop. Do not retry it, and never propose a force-push.",
        {},
        async () =>
          resultText(
            await operatorUpdateBranchFromBase(db, ctx, base, authority),
          ),
      ),
      "update_branch_from_base",
    );
  }

  if (gate(authority, "stage-transitions") !== "deny") {
    add(
      tool(
        "transition_stage",
        "Move the task to a stage in get_task: FORWARD to any stage in `nextStages`, or BACKWARD to any stage in `reworkStages` to send failed work back. Give a short reason. `reworkStages` is populated only while validation is failing, and a move to one of them is REWORK ROUTING: you perform it directly, no human and no recommendation card, even under supervised autonomy, because the workflow graph is forward-only and a rejected task has to reach the developer somehow. That is the move to make when a reviewer requests changes and the delivering profile does not work the review stage: send the task back to its work stage, then summon the specialist. Do NOT ask a human to move it for you while `reworkStages` offers it. Do NOT move to the final Done stage here — use accept_completion. Forward moves: supervised → recommendation card; full autonomy → moves directly.",
        {
          toStageId: z.string().describe("The target stage id (must be a declared next stage)."),
          reason: z.string().optional().describe("Why advance now — shown on the recommendation card."),
        },
        async (args) => {
          const input: TransitionInput = { ...base, toStageId: args.toStageId };
          if (args.reason) input.reason = prose(args.reason);
          return resultText(
            await operatorTransitionStage(db, ctx, input, authority),
          );
        },
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
        "Accept the task's completion. Under FULL autonomy this moves the task to Done and records the review PR as accepted, merge pending — you do NOT merge it yourself and a merge does not happen when you accept, whether or not GitHub is reachable (a real merge is a human-only action). A human merges the accepted PR afterward; never tell anyone the PR was merged. Under supervised autonomy it posts an actionable 'accept completion → move to Done' recommendation card for a maintainer to apply — the maintainer's acceptance is what merges the review PR when GitHub is reachable, otherwise it is left 'merge pending'. Only call this once the work has reached the review boundary and the review is clean. A task with NOTHING to deliver (get_task `noChanges: true` — no branch, no PR) is accepted the same way and completes with no changes: nothing is merged, and the server re-checks the remote branch state before closing. Never call deliver_for_review for such a task, and never open a decision packet asking a human how to close it out.",
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
    instructions: OPERATOR_TOOLKIT_INSTRUCTIONS,
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
  //
  // F21-3: prefer the caller's ALREADY PRE-FLIGHTED resolution. Resolving again
  // here would undo the pre-flight — a stdio server that failed to start was
  // dropped from the prompt but would be mounted anyway by this second resolve.
  const orgServers = deps.orgMcpServers ?? resolveSpecialistMcpServers(db, authority.mcps);
  for (const name of Object.keys(orgServers)) {
    allowed.push(`mcp__${name}`);
  }

  return {
    mcpServers: { viberr: server, ...orgServers },
    allowedTools: allowed,
    tools,
  };
}
