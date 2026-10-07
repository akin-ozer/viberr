/**
 * The Codex operator's plan (ruling 656): the tools a plan may name and the
 * structured-output schema built from the operator's grants, the packet
 * options a plan authors, and the execution of a plan step by step, with the
 * notes that narrate a paused, refused or empty plan on the task.
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { PAGE_PICTURES_PLAN_SENTENCE } from "~/server/tasks/completion-packet.server";
import {
  operatorUpdateBranchFromBase,
  updateBranchGate,
} from "~/server/github/update-branch-operator.server";
import {
  CREATE_TASK_BASE_NOTE,
  OPERATOR_PACKET_OPTION_KINDS,
  operatorAskForRepository,
  operatorOpenPacket,
  type OperatorOpenPacketInput,
  type OperatorPacketOptionInput,
  operatorResolvePacket,
} from "~/server/tasks/operator-packets.server";
import {
  operatorAcceptCompletion,
  operatorDeliverForReview,
  operatorTransitionStage,
  operatorWriteCompletionPacket,
} from "~/server/tasks/operator-moves.server";
import {
  operatorCorrectKnowledgeDoc,
  operatorEditComment,
  operatorFlagContextConflict,
  operatorLeaseFiles,
  operatorPostComment,
  operatorRelayToTask,
  operatorSetDependencies,
  operatorSetEpic,
  operatorSetGoal,
  operatorTakeFromTask,
} from "~/server/tasks/operator-actions.server";
import {
  operatorCancelSchedule,
  operatorDispatchAgent,
  operatorScheduleRun,
} from "~/server/tasks/operator-dispatch.server";
import {
  deliverGate,
  dispatchGate,
  gate,
  type OperatorActionResult,
  type OperatorAuthority,
} from "~/server/tasks/operator-authority.server";
import type { PacketOptionKind } from "~/schemas/task-file.schema";
import { DONE_SIGNAL_RULE } from "~/server/tasks/done-signal.server";
import {
  noteConsultedProfile,
  operatorOpenPacketDisclosed,
} from "~/server/tasks/operator-toolkit.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import { splitKbSource } from "~/server/tasks/kb-correction-actions.server";
import { fullReplyTextForRun } from "~/server/tasks/agent-reply.server";
import {
  reprojectTask,
  type TaskMutationContext,
  taskRef,
} from "~/server/tasks/task-mutation.server";
import type { RealBackend } from "./runtime-registry.server";
import { PLAN_NOT_CARRIED_OUT_LEAD } from "~/shared/run-failure";
import { errorMessage, toError } from "~/shared/errors";
import type { RunOperatorInput } from "./operator-run.server";

/**
 * JSON schema constraining the codex operator's decision plan. OpenAI strict
 * structured output requires EVERY object to set additionalProperties:false and
 * list ALL properties in `required` — optional fields are expressed as nullable
 * (the model emits null when unused). The executor treats null/"" as absent.
 */
const OPERATOR_PLAN_TOOLS = [
  "post_comment",
  "open_packet",
  // Withdraw YOUR OWN open packet when it became moot (its asked-for input was
  // provided out-of-band, e.g. a human edited the goal). `reason` explains why.
  "resolve_packet",
  // Draft the task GOAL when it is still the unspecified triage placeholder
  // (`text` = the drafted goal). Fills only an unspecified goal.
  "set_goal",
  // Dynamic-dispatch rework (2026-08-29): ONE selection+run action — the plan
  // mirror of the Claude toolkit's `run_agent` (engage-if-needed with
  // capability-derived posture, optional `prompt` as the directive comment,
  // optional `delivers: true` for an explicit delivery hand-off).
  "run_agent",
  "transition_stage",
  // R15-2: delivery (push + review PR) is the operator's decision — the plan
  // mirror of the Claude `deliver_for_review` tool. `reason` carries the
  // recommendation-card line when policy recommends instead of performs.
  "deliver_for_review",
  // N19-9 (owner ruling): bringing the task branch up to date with its base is
  // an operator decision too — the plan mirror of `update_branch_from_base`.
  // Server-owned merge+push; a conflict opens a packet, never a force.
  "update_branch_from_base",
  "accept_completion",
  // Ruling 521: the plan mirror of `write_completion_packet`, the packet every
  // acceptance offer carries. `text` is the summary, `reason` the summary of
  // the code changes, `screenshots` the images that show the result.
  "write_completion_packet",
  // F-P6 (pass 25): the plan mirror of Claude's `flag_context_conflict` — a
  // Codex operator holding `append-typed-events` can raise the R19-2 KB-vs-repo
  // conflict as the same typed `quality` event + notification, not just a plain
  // comment. `kbSource`/`repoSource` name the two sides; `text` is the detail.
  "flag_context_conflict",
  // Ruling 131(b) (pass 34): record what the task WAITS ON (the full list of
  // task keys; `blockedBy: []` clears it) instead of opening a hold packet.
  // The plan mirror of the Claude toolkit's `set_dependencies`.
  "set_dependencies",
  // Ruling 503: put this task in an epic, move it, or take it out (`epicId`,
  // "" for none). The plan mirror of the Claude toolkit's `set_epic`.
  "set_epic",
  // F39-1/F39-7 (pass 39): the plan mirror of `propose_ruling`, generalized by
  // ruling 483 into `propose_kb_correction` and made a write by ruling 498 as
  // `correct_knowledge_doc`. Every agent on the pass-39 instance ran on Codex,
  // so a tool that exists only on the Claude toolkit would have been
  // unreachable by the operator that actually found the false ruling. `text`
  // carries what the document should say, `kbSource` the knowledge base and
  // document (`<kb>/<doc>`, or a bare document of the rulings), `reason` the
  // exact passage it replaces, `repoSource` the evidence.
  "correct_knowledge_doc",
  // Ruling 417 (owner): lease shared files to THIS task until it merges. The
  // plan mirror of the Claude toolkit's `lease_files`; `paths` carries the
  // globs and `text` the reason.
  "lease_files",
  // Ruling 487 (F40-65): schedule a future run on THIS task (its own re-run,
  // or a deployed agent's with a directive) and cancel one it scheduled. The
  // plan mirrors of the Claude toolkit's two tools of the same names:
  // `profileId` (or "operator"/null) is the target, `dueAt` or `delayMinutes`
  // the time, `text` the steer or directive, `scheduleId` what to cancel.
  "schedule_task_action",
  "cancel_task_schedule",
  // Ruling 488 (F40-67): post on ANOTHER task of this project. The plan mirror
  // of the Claude toolkit's `relay_to_task`: `taskKey` names the task, `text`
  // is what lands there, `files` (ruling 538) the attachments it carries.
  "relay_to_task",
  // Ruling 557: the relay's other direction. `taskKey` names the task that
  // holds the files, `files` which of them to take onto this task, `text` an
  // optional line on what they are for.
  "take_from_task",
  // Ruling 584: edit or delete a comment the operator or an agent wrote on
  // THIS task, silently. The plan mirror of the Claude toolkit's
  // `edit_comment`: `commentAt` names the comment, `text` the words that
  // replace it (null deletes it), `reason` why.
  "edit_comment",
  // Ruling 672: ask a person to connect a repository to a board that has
  // none, because this task needs one. The plan mirror of the Claude
  // toolkit's `ask_for_repository`: `reason` is why the task needs it and
  // `text` the repository the goal or a person named (`owner/name`), if any.
  // Offered only where asking is possible (`authority.repositoryAsk`).
  "ask_for_repository",
] as const;

const OPERATOR_PACKET_TYPES = ["input", "blocked"] as const;

type OperatorPlanTool = (typeof OPERATOR_PLAN_TOOLS)[number];

/**
 * The capability each plan tool needs — the exact mapping the Claude toolkit
 * uses to decide whether to BUILD a tool (`operator-toolkit.server.ts`). On
 * Claude a denied capability's tool never exists, so the model cannot reach it;
 * the Codex plan schema used to advertise every plan tool regardless of policy.
 */
const OPERATOR_PLAN_TOOL_CAPABILITIES = {
  post_comment: ["append-typed-events"],
  set_goal: ["append-typed-events"],
  open_packet: ["generate-packets"],
  resolve_packet: ["generate-packets"],
  // Ruling 672: a packet, on the packets' grant.
  ask_for_repository: ["generate-packets"],
  run_agent: ["dispatch-agents"],
  transition_stage: ["stage-transitions"],
  // R15-2: absent-means-granted polarity — resolved via deliverGate below, not
  // the plain gate (the capability postdates live deployments).
  deliver_for_review: ["deliver-review-pr"],
  // Same absent-means-derived polarity as delivery — resolved via
  // updateBranchGate below, not the plain gate.
  update_branch_from_base: ["update-task-branch"],
  accept_completion: ["completion-for-acceptance"],
  // Ruling 521: the packet exists only to go with an acceptance offer.
  write_completion_packet: ["completion-for-acceptance"],
  // F-P6 (pass 25): same gate as Claude's `flag_context_conflict` tool.
  flag_context_conflict: ["append-typed-events"],
  // Ruling 131(b): the wait is the hold packet's replacement, so it rides the
  // packet's own grant.
  set_dependencies: ["generate-packets"],
  // Ruling 503: the same grant as `set_goal`, the operator's other planning
  // edit on its own task.
  set_epic: ["append-typed-events"],
  // F39-1/F39-7: same gate as `flag_context_conflict`, the typed event it
  // posts. Ruling 498 made the correction a write; a person undoes one from
  // the Controller page rather than gating each (owner, 2026-09-26).
  correct_knowledge_doc: ["append-typed-events"],
  // Ruling 417: a lease orders DELIVERIES, so it rides delivery authority —
  // resolved via deliverGate below, like `deliver_for_review` itself.
  lease_files: ["deliver-review-pr"],
  // Ruling 487: a schedule is a dispatch with a date on it, and it starts
  // with nobody present, so it rides a DIRECT dispatch grant (resolved below).
  schedule_task_action: ["dispatch-agents"],
  cancel_task_schedule: ["dispatch-agents"],
  // Ruling 488: a relay is a comment one task over, so it rides the comment's
  // own grant, as the Claude tool does.
  relay_to_task: ["append-typed-events"],
  // Ruling 557: a take writes the relay's claim comment on this task.
  take_from_task: ["append-typed-events"],
  // Ruling 584: a comment's words are a timeline write, like the comment.
  edit_comment: ["append-typed-events"],
} satisfies Record<OperatorPlanTool, readonly string[]>;

/**
 * The plan tools this operator is actually allowed to use (P13-RT-03). Codex
 * has no per-tool build step, so the constraint has to live in the schema the
 * run is given — otherwise the model is invited to propose actions that can
 * only be refused, burning a billed turn on a plan that does nothing.
 */
export function operatorPlanToolsFor(
  authority: OperatorAuthority,
): OperatorPlanTool[] {
  const permitted = OPERATOR_PLAN_TOOLS.filter((toolName) =>
    toolName === "ask_for_repository"
      ? // Ruling 672: only where the question can be asked: a board with no
        // repository whose rulings hold no decision to keep none.
        authority.repositoryAsk === "open" && gate(authority, "generate-packets") !== "deny"
      : toolName === "deliver_for_review" || toolName === "lease_files"
      ? deliverGate(authority) !== "deny"
      : toolName === "update_branch_from_base"
        ? updateBranchGate(authority) !== "deny"
        : toolName === "schedule_task_action" || toolName === "cancel_task_schedule"
          ? // Ruling 487: only a grant that starts runs itself schedules one,
            // the same test the Claude toolkit builds the two tools on.
            dispatchGate(authority) === "direct"
        : toolName === "run_agent"
          ? // Dispatch-rework hunt (2026-08-29): `dispatch-agents` carries the
            // absent-means-default polarity (pre-rework deployments store only
            // the retired assign/summon ids) — the plain gate read it as deny
            // and silently withheld dispatching from every existing project's
            // Codex operator. Same resolver the Claude toolkit uses.
            dispatchGate(authority) !== "deny"
          : OPERATOR_PLAN_TOOL_CAPABILITIES[toolName].some(
              (cap) => gate(authority, cap) !== "deny",
            ),
  );
  // A structured-output `enum` may not be empty. An operator with NOTHING
  // granted is a misconfiguration rather than a run shape we can express, so
  // fall back to the full list — every action it then proposes is refused
  // VISIBLY by narrateRefusedActions rather than silently.
  //
  // A4: except `deliver_for_review` and `update_branch_from_base`. Reaching the
  // fallback means their grant was either explicitly withheld or (with no
  // operator deployed) never made, and these are the plan actions with effects
  // OUTSIDE Viberr — a pushed branch, an opened PR. `operatorDeliverForReview`
  // refuses either way, so advertising them only buys a billed turn spent
  // planning a push that cannot happen.
  // Ruling 417: `lease_files` rides the delivery gate, so the fallback that
  // withholds delivery withholds it too; advertising it would buy a turn
  // spent planning a lease `operatorLeaseFiles` refuses.
  // Ruling 487: the schedule verbs ride a DIRECT dispatch grant, which no
  // operator reaching the fallback holds, so they are withheld the same way.
  const withheldInFallback: readonly OperatorPlanTool[] = [
    "deliver_for_review",
    "update_branch_from_base",
    "lease_files",
    "schedule_task_action",
    "cancel_task_schedule",
    // Ruling 672: it is offered on its own condition above and never by default.
    "ask_for_repository",
  ];
  return permitted.length
    ? [...permitted]
    : OPERATOR_PLAN_TOOLS.filter((t) => !withheldInFallback.includes(t));
}

/** The JSON schema the Codex operator run must answer with, for this
 *  authority's permitted tools — exported so a test can read the emitted
 *  shape (ruling 138: `goalDraft` is a REQUIRED option key). */
export function operatorPlanSchemaFor(authority: OperatorAuthority) {
  return buildOperatorPlanSchema(operatorPlanToolsFor(authority));
}

function buildOperatorPlanSchema(tools: readonly OperatorPlanTool[]) {
  // Ruling 672: `ask_for_repository` reads two fields other tools own, and is
  // offered on few boards. Its sentences join their descriptions only where
  // it is offered, and its two answers are not among the option kinds an
  // operator writes (`OPERATOR_PACKET_OPTION_KINDS`), so the schema every
  // other project is given is the one it had.
  const askForRepository = tools.includes("ask_for_repository")
    ? {
        text: " For ask_for_repository: the repository the goal or a person named, as owner/name, or null when none was named.",
        reason: " For ask_for_repository: why THIS task needs a repository (the code it has to change, or that it must ship as a pull request; a task that only reads one is not this question), in a sentence or two a person reads before deciding; it opens a decision packet with two answers, connect one or keep the board without, both a project admin's, and you stop there.",
      }
    : { text: "", reason: "" };
  return {
  type: "object",
  additionalProperties: false,
  properties: {
    reasoning: {
      type: "string",
      description: "A concise operator comment: observed → changed → recommended → decision required.",
    },
    actions: {
      type: "array",
      description: "The coordination actions to take, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool: {
            type: "string",
            enum: tools,
          },
          profileId: { type: ["string", "null"], description: "For run_agent: the deployed agent profile to select and run (pick by desc + capabilities from the snapshot). For schedule_task_action: the deployed profile whose run to schedule, or \"operator\" (or null) for your own re-run. Else null." },
          delivers: { type: ["boolean", "null"], description: "run_agent: true = hand delivery to this profile (owns branch/PR, one per task; on a task whose deliverable is a result, the agent that makes it, which needs only `postsFiles`, ruling 535, and whose saved files are the delivery); false = run as supporting (review). Null derives it from the profile's grants and the task's current deliverer." },
          toStageId: { type: ["string", "null"], description: "For transition_stage, else null." },
          packetType: { type: ["string", "null"], enum: ["input", "blocked", null], description: "For open_packet: 'blocked' when work is stuck, 'input' for a decision; else null." },
          // Ruling 492: `set_goal` drafts the task's goal in `text`, so this
          // field is one of the doors that write a goal.
          text: { type: ["string", "null"], description: "For post_comment: the comment text (narration the HUMANS read, which starts no agent, so an @name in it reaches nobody); put a question or directive to an agent with run_agent instead. For open_packet: the packet title; for run_agent: the agent's directive (posted as your hand-off comment; null for a bare re-run); for flag_context_conflict: the one-or-two-sentence detail of what each side says; for correct_knowledge_doc: what the document should say in place of `reason`'s passage, in the document's own form (the corrected fact, not the evidence), an empty string to delete that passage (ruling 581), or the missing convention (ruling 418); for lease_files: why this task holds the paths, which every task the lease refuses is shown; for schedule_task_action: the steer for your own re-run, or the agent's directive (under 4000 characters); for relay_to_task: what to post on the other task, whole, since it is what that task reads; for take_from_task: optional, one line on what the files are for, on the comment that claims them here (an @name in it is notified), or null for the default line; for set_goal: the drafted goal, scope plus acceptance criteria, whose done signal follows the rule below; for write_completion_packet: the summary a person reads before accepting (ruling 521), what was done against the goal and why it is complete, outcome first, in markdown, never restating a verdict or pasting a diff; else null. " + DONE_SIGNAL_RULE + askForRepository.text },
          reason: { type: ["string", "null"], description: "Short why: recommendation-card reasoning (for a transition_stage that moves the task, shown on the move in its history), or the packet body for open_packet. For write_completion_packet: your summary of the code changes by area, naming the files that matter, required when the snapshot's `completionPacket.changesSummaryRequired` is true (more than 200 changed lines), else null so the diff is shown whole. For correct_knowledge_doc: the passage the correction REPLACES, copied EXACTLY as the document has it (list marker and emphasis included; it must stand once in the document); null only to add `text` at the end of the document, such as a missing convention." + askForRepository.reason },
          kbSource: { type: ["string", "null"], description: "For flag_context_conflict: the knowledge-base document that disagrees. For correct_knowledge_doc: the knowledge base and the document to correct as `<knowledge base>/<document>`, each named as the index names it (any knowledge base a run on this task was given, yours or an engaged agent's), or the document alone for the project's rulings knowledge base. Else null." },
          repoSource: { type: ["string", "null"], description: "For flag_context_conflict: the repository file that is authoritative. For correct_knowledge_doc: the EVIDENCE that proves the passage wrong or the convention missing: the exact command and its exit code or output, or the run and verdict that showed it (for a missing convention, the reviewer's verdict). Else null." },
          blockedBy: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "For set_dependencies ONLY: the FULL list of what this task waits on, as task keys (`JC-6`) in this project; an empty array clears the wait. Null for every other tool.",
          },
          // Ruling 503: the epic set_epic puts this task in.
          epicId: {
            type: ["string", "null"],
            description: "For set_epic ONLY (ruling 503): the epic to put THIS task in (`epic-3`, from the snapshot's `openEpics`), or \"\" to take it out of its epic. A task is in at most one epic, and membership holds and orders nothing: what it waits on is set_dependencies. Null for every other tool.",
          },
          paths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "For lease_files ONLY (ruling 417): the path globs to lease to THIS task until it merges, as narrow as the shared files (`*` within one segment, `**` across segments), and put the reason in `text`. First come, first served: a path another active task already holds is refused by name. Null for every other tool.",
          },
          // Ruling 487: when a scheduled run fires, and which one to cancel.
          dueAt: {
            type: ["string", "null"],
            description: "For schedule_task_action ONLY (ruling 487): the instant the run fires, as an ISO timestamp, between 1 minute and 28 days out. Give this or `delayMinutes`. Use it for a wait a clock explains: just after the cron run, the window reopening, the deploy landing. Null for every other tool.",
          },
          delayMinutes: {
            type: ["number", "null"],
            description: "For schedule_task_action ONLY (ruling 487): minutes from now (1 to 40320) instead of `dueAt`. Null for every other tool.",
          },
          scheduleId: {
            type: ["string", "null"],
            description: "For cancel_task_schedule ONLY (ruling 487): the pending entry to cancel (`schedules[].id` in the snapshot); only one marked `yours` is yours to cancel. Null for every other tool.",
          },
          commentAt: {
            type: ["string", "null"],
            description: "For edit_comment ONLY (ruling 584): the time of a comment the operator or an agent wrote on THIS task, exactly as the timeline gives it. Use it yourself, without asking anyone and without saying so on the task, when a comment should not stand as written: it states an expected answer or a golden entry's configuration agents on a benchmark must not read, holds a secret, or misleads the next run. `text` is the words that replace it in full (null deletes it) and `reason` why, for the audit log. A person's comment is refused. Null for every other tool.",
          },
          // Ruling 488: the task a relay posts on.
          taskKey: {
            type: ["string", "null"],
            description: "For relay_to_task (ruling 488): ANOTHER task in this project to post `text` on, e.g. WEB-8. It lands there as your comment, that task's operator is woken with it, and this task's timeline records the relay, so never ask a person to copy text between tasks or to confirm it landed. Refused: another project, this task, a task that does not exist, a closed task. For take_from_task (ruling 557): the task in this project whose attachments to take onto this one, e.g. AWSC-3; it may be Done, not archived. Null for every other tool.",
          },
          // Ruling 538: the files a relay carries onto the other task.
          files: {
            type: ["array", "null"],
            description: "For relay_to_task (ruling 538): names of THIS task's attachments to put on the other task with the text, exactly as this task lists them (an input that task works from, a file it is to judge). They land on its attachments, where its agents read them. Null for a relay of text alone. For take_from_task (ruling 557): names of the OTHER task's attachments to put on THIS task, exactly as it lists them: only what this task works from, never a file that task keeps from this one (an answer key). Use it instead of asking a person to attach or carry a file. Null for every other tool.",
            items: { type: "string" },
          },
          // Ruling 521: the images write_completion_packet puts on the packet.
          screenshots: {
            type: ["array", "null"],
            description: "For write_completion_packet ONLY (ruling 521): up to 6 image attachments of this task that show the result, by exact file name from the snapshot's `completionPacket.screenshotCandidates`, each with a one-line caption of what it shows. " +
              PAGE_PICTURES_PLAN_SENTENCE +
              " Null when nothing visible changed, and for every other tool.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                caption: { type: ["string", "null"] },
              },
              required: ["name", "caption"],
            },
          },
          // Ruling 668: what write_completion_packet says beside the summary.
          result: {
            type: ["object", "null"],
            description: "For write_completion_packet ONLY (ruling 668): the rest of what a person reads before accepting, which stays on the task as its result. Null for every other tool.",
            additionalProperties: false,
            properties: {
              considerations: { type: ["string", "null"], description: "The choices the work made that the person should weigh: an option taken over another and why, a trade-off, a default. Markdown; null when there are none (never write \"none\")." },
              assumptions: { type: ["string", "null"], description: "What the work took as given without a person confirming it. Markdown; null when there are none." },
              gaps: { type: ["string", "null"], description: "What the result does not cover and what is still owed: an input nobody gave, a check nobody ran, a follow-up. Markdown; null when there are none." },
              files: {
                type: ["array", "null"],
                description: "On a task delivered as files (the snapshot's `completionPacket.resultFilesRequired`): the files that ARE the result, by exact name from `completionPacket.resultFileCandidates`, each with a line saying what the file is. The final version of each output a person takes away, never an input, a draft, a log or a working file. Null when the delivery is a revision: its pull request holds the files.",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    caption: { type: ["string", "null"] },
                  },
                  required: ["name", "caption"],
                },
              },
            },
            required: ["considerations", "assumptions", "gaps", "files"],
          },
          completeness: {
            type: ["boolean", "null"],
            description: "For run_agent ONLY (ruling 421): true when this run puts ruling 410's completeness question to a reviewer (name EVERYTHING it would still block on, including anything it would hold for a later round), whether on its own or folded into the review of a fresh rework. Viberr records the verdict that run returns as the reviewer's complete set, so a later deadlock packet recommends one rework against it instead of asking again. Null for every other run and every other tool.",
          },
          noVerdict: {
            type: ["boolean", "null"],
            description: "For run_agent ONLY (ruling 583): true whenever this run must not judge: a verdict-capable agent run for its knowledge-base corrections or its files on a task a person closes by force-accept, or a question put before any verdict. Viberr withholds its verdict and reads nothing it writes as one; a directive saying \"record no verdict\" is not enforced without it. Null for every other run and every other tool.",
          },
          // P11-27: let the Codex operator AUTHOR the packet's option set from its
          // own reasoning (2–4 options), instead of always getting the canned
          // default set. Null → use the packet type's default options.
          packetOptions: {
            type: ["array", "null"],
            description: "For open_packet ONLY: 2 to 4 options the human chooses from, mark exactly one recommended; null to use the packet type's defaults.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: [...OPERATOR_PACKET_OPTION_KINDS] },
                title: { type: "string" },
                detail: { type: ["string", "null"], description: "One concise line of extra context for this option; null if none." },
                recommended: { type: "boolean" },
                reply: {
                  type: ["boolean", "null"],
                  description: "redirect and request_edit only (ruling 650): true when choosing this option means nothing without the person's own words, what to change or what to tell the agent. The card then requires them and an empty confirm is refused. Dropped on every other kind. Null otherwise.",
                },
                // B1: the retry target used to be unexpressible here, so every
                // Codex-authored retry resolved to Claude — a re-run of the
                // backend that had just failed. Null keeps the server default
                // (the OTHER backend than the one that failed).
                backend: {
                  type: ["string", "null"],
                  enum: ["claude", "codex", null],
                  description:
                    "retry_other_backend only: the backend to re-run the failed agent on; it must be the OTHER one. Null lets the server pick the opposite of the backend that failed.",
                },
                // Ruling 409 (F39-36): this said "retry_other_backend only" while
                // ruling 237 REFUSES a `question_reviewer` option that has no
                // profileId. Live on ax-clone AX-18 the operator reached for
                // exactly that option, read this description, correctly left
                // the field null, and was refused twice -- then the task was
                // stranded and a human had to act. Two kinds need it, so both
                // are named.
                profileId: {
                  type: ["string", "null"],
                  description:
                    "TWO kinds need this, null on every other. `retry_other_backend`: the agent profile to re-run (null re-runs the agent whose run failed). `question_reviewer`: REQUIRED, the profileId of the reviewer the question is put to, which must be a reviewer this task actually has (`reviewers[].profileId`); an option without it is refused, because the resolution would promise \"ask X\" and have nobody to start.",
                },
                deleteBranch: {
                  type: ["boolean", "null"],
                  description:
                    "archive_task only: true = ALSO delete the task's remote branch (discard the rejected work). Null otherwise.",
                },
                // Ruling 164 (pass 35, F35-14): a move_stage option names the
                // stage its resolution moves the task to. Without it the
                // Codex operator could author the kind and the confirm would
                // have nowhere to move.
                toStage: {
                  type: ["string", "null"],
                  description:
                    "move_stage only: the stage id this option moves the task to. Null on every other kind. The terminal stage is refused (moving there accepts the completion).",
                },
                // Ruling 138: the goal editor opens with this text when the
                // human confirms an edit_goal option, so it is written AS a
                // goal, never as an instruction to the human.
                goalDraft: {
                  type: ["string", "null"],
                  description:
                    "edit_goal only: the proposed goal text itself, written AS a goal (the deliverable plus its acceptance criteria); it is what the goal editor opens with when the human confirms. Without it the editor prefills the option's title and detail verbatim, so never phrase those as an instruction to the human. Null on every other kind. " +
                    DONE_SIGNAL_RULE,
                },
                // Ruling 433 (F39-55): ruling 270 gave the Claude tool the
                // payloads of rulings 224, 230 and 269, and this schema never
                // got them. A Codex operator could name the three kinds, was
                // refused for the missing payload, and had no field to send
                // it in. Live on ax-clone: AX-4 twice, AX-27 once.
                blockedBy: {
                  type: ["array", "null"],
                  items: { type: "string" },
                  description:
                    "block_on_dependencies only (ruling 230): what THIS task waits on, as task keys. Required on that kind, since an option that names nothing to wait on resolves into a hold that releases on nothing. Null on every other kind. Not the action-level blockedBy, which is set_dependencies'.",
                },
                dueAt: {
                  type: ["string", "null"],
                  description:
                    "wait_for_window only (ruling 224): the instant the provider said its window reopens, as an ISO timestamp. The resolution schedules the re-dispatch just after it. Required on that kind; null on every other. Viberr raises the quota packet itself, so author one only when no packet was raised.",
                },
                newTask: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  description:
                    "create_task only (ruling 269): the task the person's confirm CREATES, under their own authority. Use it for work that belongs outside this task (another owner's package, a contract nobody produces, a gap a report named), instead of an option whose text tells the reader to create a task. " +
                    CREATE_TASK_BASE_NOTE +
                    " Required on that kind; null on every other.",
                  properties: {
                    title: { type: "string", description: "The new task's title." },
                    goal: {
                      type: "string",
                      description:
                        "The new task's goal, written AS a goal (deliverable plus acceptance criteria). It is the contract whoever works it is held to. " +
                        DONE_SIGNAL_RULE,
                    },
                    blockedBy: {
                      type: ["array", "null"],
                      items: { type: "string" },
                      description: "What the NEW task waits on (task keys), not what this task waits on. Null for nothing.",
                    },
                    blocks: {
                      type: ["array", "null"],
                      items: { type: "string" },
                      description:
                        "Ruling 287: the EXISTING tasks that must wait on the new one, usually the direction that matters, since a task is created to unblock something. Each key gets the new task added to its own blockedBy when the person confirms. This task's own key belongs here whenever it is the work that must wait (ruling 322). Null for none.",
                    },
                    labels: { type: ["array", "null"], items: { type: "string" }, description: "Labels for the new task; null for none." },
                  },
                  required: ["title", "goal", "blockedBy", "blocks", "labels"],
                },
              },
              required: ["kind", "title", "detail", "recommended", "reply", "backend", "profileId", "deleteBranch", "toStage", "goalDraft", "blockedBy", "dueAt", "newTask"],
            },
          },
        },
        required: ["tool", "profileId", "delivers", "toStageId", "packetType", "text", "reason", "packetOptions", "kbSource", "repoSource", "blockedBy", "epicId", "paths", "files", "screenshots", "result", "completeness", "noVerdict", "dueAt", "delayMinutes", "scheduleId", "commentAt", "taskKey"],
      },
    },
  },
  required: ["reasoning", "actions"],
  } as const;
}

/**
 * Runtime mirror of OPERATOR_PLAN_SCHEMA. Structured output constrains the
 * model, but persisted/provider output still crosses a trust boundary: reject
 * missing nullable fields, unknown tools, wrong types, and extra properties
 * before any governed action can run.
 */
const operatorPlanActionSchema = z.strictObject({
  tool: z.enum(OPERATOR_PLAN_TOOLS),
  profileId: z.string().nullable(),
  delivers: z.boolean().nullable(),
  toStageId: z.string().nullable(),
  packetType: z.enum(OPERATOR_PACKET_TYPES).nullable(),
  text: z.string().nullable(),
  reason: z.string().nullable(),
  // F-P6 (pass 25): the two sides of a KB-vs-repo conflict. Tolerated as ABSENT
  // (not just null) so plans persisted before these fields existed still replay.
  kbSource: z.string().nullable().optional(),
  repoSource: z.string().nullable().optional(),
  // Ruling 131: set_dependencies — the FULL list; `.optional()` so plans
  // persisted before the field existed still replay across a restart-resume.
  blockedBy: z.array(z.string()).nullable().optional(),
  // Ruling 503: set_epic's epic — `.optional()` for the same replay reason.
  epicId: z.string().nullable().optional(),
  // Ruling 417: lease_files — `.optional()` so plans persisted before the
  // field existed still replay across a restart-resume.
  paths: z.array(z.string()).nullable().optional(),
  // Ruling 521: write_completion_packet's images — `.optional()` for the same
  // replay reason.
  screenshots: z
    .array(z.strictObject({ name: z.string(), caption: z.string().nullable() }))
    .nullable()
    .optional(),
  // Ruling 668: write_completion_packet's notes and result files, `.optional()`
  // for the same replay reason.
  result: z
    .strictObject({
      considerations: z.string().nullable(),
      assumptions: z.string().nullable(),
      gaps: z.string().nullable(),
      files: z.array(z.strictObject({ name: z.string(), caption: z.string().nullable() })).nullable(),
    })
    .nullable()
    .optional(),
  // Ruling 421: run_agent's completeness question — `.optional()` for the same
  // replay reason.
  completeness: z.boolean().nullable().optional(),
  // Ruling 583: run_agent's no-verdict switch, `.optional()` for the same
  // replay reason.
  noVerdict: z.boolean().nullable().optional(),
  // Ruling 487: schedule_task_action's time and cancel_task_schedule's entry —
  // `.optional()` for the same replay reason.
  dueAt: z.string().nullable().optional(),
  delayMinutes: z.number().nullable().optional(),
  scheduleId: z.string().nullable().optional(),
  // Ruling 584: edit_comment's comment, `.optional()` for the same replay reason.
  commentAt: z.string().nullable().optional(),
  // Ruling 488: relay_to_task's target — `.optional()` for the same replay
  // reason.
  taskKey: z.string().nullable().optional(),
  // Ruling 538: the files a relay carries — `.optional()` for the same reason.
  files: z.array(z.string()).nullable().optional(),
  packetOptions: z
    .array(
      z.strictObject({
        kind: z.enum(OPERATOR_PACKET_OPTION_KINDS),
        title: z.string(),
        detail: z.string().nullable(),
        recommended: z.boolean(),
        // Tolerated as ABSENT too (not just null): plans persisted before these
        // fields existed must stay executable across a restart-resume.
        reply: z.boolean().nullable().optional(),
        backend: z.enum(["claude", "codex"]).nullable().optional(),
        profileId: z.string().nullable().optional(),
        deleteBranch: z.boolean().nullable().optional(),
        toStage: z.string().nullable().optional(),
        goalDraft: z.string().nullable().optional(),
        // Ruling 433: `.optional()` for the same replay reason.
        blockedBy: z.array(z.string()).nullable().optional(),
        dueAt: z.string().nullable().optional(),
        newTask: z
          .strictObject({
            title: z.string(),
            goal: z.string(),
            blockedBy: z.array(z.string()).nullable().optional(),
            blocks: z.array(z.string()).nullable().optional(),
            labels: z.array(z.string()).nullable().optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .nullable(),
});

const operatorPlanRuntimeSchema = z.strictObject({
  reasoning: z.string(),
  actions: z.array(operatorPlanActionSchema),
});

type OperatorPlan = z.infer<typeof operatorPlanRuntimeSchema>;

/**
 * Normalize the Codex operator's AUTHORED packet options (P11-27) into the shape
 * `operatorOpenPacket` expects, or null when it supplied nothing usable (empty,
 * or every option lacked a title) — the caller then falls back to the type's
 * default set. Caps at 4 options and ensures exactly one is marked recommended
 * (the first, if the model marked none or several).
 */
export function authoredPacketOptions(
  authored:
    | {
        kind: PacketOptionKind;
        title: string;
        detail?: string | null;
        recommended: boolean;
        reply?: boolean | null;
        backend?: RealBackend | null;
        profileId?: string | null;
        deleteBranch?: boolean | null;
        toStage?: string | null;
        goalDraft?: string | null;
        blockedBy?: string[] | null;
        dueAt?: string | null;
        newTask?: {
          title: string;
          goal: string;
          blockedBy?: string[] | null;
          blocks?: string[] | null;
          labels?: string[] | null;
        } | null;
      }[]
    | null,
): OperatorPacketOptionInput[] | null {
  if (!authored || authored.length === 0) return null;
  // Filter+cap FIRST, then locate the recommended within the KEPT set — an
  // earlier empty-title option (dropped here) would otherwise shift the raw
  // index and mark the wrong kept option recommended.
  const kept = authored.filter((o) => o.title.trim() !== "").slice(0, 4);
  if (kept.length === 0) return null;
  const recIdx = kept.findIndex((o) => o.recommended);
  return kept.map((o, i) => {
    const detail = o.detail?.trim();
    const profileId = o.profileId?.trim();
    const option: OperatorPacketOptionInput = { kind: o.kind, title: o.title.trim() };
    // Carry the per-option detail line so a Codex-authored packet renders with
    // the same context a Claude-authored one does (AO-5 #12).
    if (detail) option.detail = detail;
    // Ruling 650: `operatorOpenPacket` keeps it on redirect and request_edit.
    if (o.reply) option.reply = true;
    // Ruling 138: the proposed goal rides with the option; `operatorOpenPacket`
    // caps it and refuses it on any kind but edit_goal.
    const goalDraft = o.goalDraft?.trim();
    if (goalDraft) option.goalDraft = goalDraft;
    option.recommended = i === (recIdx >= 0 ? recIdx : 0);
    // B1: retry_other_backend only. An omitted backend is NOT defaulted here —
    // `operatorOpenPacket` fills in the opposite of the backend that failed,
    // so the Claude tool path and this one land on the same rule.
    if (o.backend) option.backend = o.backend;
    if (profileId) option.profileId = profileId;
    // archive_task only — any other kind ignores it at resolution, so gating
    // here would just second-guess the resolver.
    if (o.deleteBranch) option.deleteBranch = true;
    // Ruling 164: move_stage carries its target; `operatorOpenPacket` refuses
    // it on any other kind and validates the stage id against the board.
    const toStage = o.toStage?.trim();
    if (toStage) option.toStage = toStage;
    // Ruling 433: the payloads rulings 230, 224 and 269 require, carried the
    // way the Claude tool carries them (ruling 270). `operatorOpenPacket`
    // refuses each off its kind and its kind without it.
    if (o.blockedBy?.length) option.blockedBy = [...o.blockedBy];
    const dueAt = o.dueAt?.trim();
    if (dueAt) option.dueAt = dueAt;
    if (o.newTask) {
      const newTask: NonNullable<OperatorPacketOptionInput["newTask"]> = {
        title: o.newTask.title.trim(),
        goal: o.newTask.goal.trim(),
      };
      if (o.newTask.blockedBy?.length) newTask.blockedBy = [...o.newTask.blockedBy];
      if (o.newTask.blocks?.length) newTask.blocks = [...o.newTask.blocks];
      if (o.newTask.labels?.length) newTask.labels = [...o.newTask.labels];
      option.newTask = newTask;
    }
    return option;
  });
}

function defaultPacketOptions(
  packetType: "input" | "blocked",
): OperatorPacketOptionInput[] {
  // R20-1 (F20-5): every "blocked" label says exactly what will happen. The old
  // "…and unblock" recorded a HOLD and re-accepted the same confirm forever;
  // now each option resolves the packet, and the two active ones re-run.
  // Ruling 130(c) (pass 34, F34-12): the stock re-run option asserts only what
  // the human says. It used to read "I've updated the policy / credential",
  // was recommended for a run that died of a spent usage window, and its
  // record ("policy / credential updated") led an operator to tell a
  // specialist that a GitHub-scope block had been lifted when nothing had.
  // A FAILED run's packet never uses this set: `escalateFailedOperatorRun`
  // asks `describeRunFailure` for options that name the classified cause.
  return packetType === "blocked"
    ? [
        {
          kind: "block_on_policy",
          title: "Re-run the operator now",
          detail:
            "Closes this decision and starts a fresh operator run. If it fails again you get a new decision packet.",
          recommended: true,
          ev: "**Decision:** re-run the operator. No policy or credential was changed.",
        },
        {
          kind: "redirect",
          title: "Redirect the specialist with new guidance",
          detail:
            "Closes this decision and re-runs the operator with your note as its steer.",
        },
        {
          kind: "hold_runtime_debug",
          title: "Hold: pause coordination while I inspect the session",
          detail:
            "Closes this decision and starts NO run. The task stays blocked and waiting on you; use Run operator when you are ready.",
        },
      ]
    : [
        { kind: "request_edit", title: "Send back to the specialist for changes", recommended: true },
        { kind: "redirect", title: "Reassign or redirect the work" },
        // B-OP4: a genuine multi-way decision rarely fits "send back" or
        // "redirect". Without a free-form path the fallback card forced the
        // human to pick a wrong option or leave the packet open, so the
        // resolver's own words become the operator's next steer.
        {
          kind: "custom",
          title: "Something else: say what should happen",
          detail: "Your note becomes the operator's instruction for the next turn.",
        },
      ];
}

/** Parse the complete structured response and validate it before execution. */
function parseOperatorPlan(text: string): OperatorPlan | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const parsed = operatorPlanRuntimeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Execute a finished codex operator run's decision plan (capability-gated). */
export async function executeCodexPlan(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  runId: string,
): Promise<void> {
  // Claim the turn BEFORE anything governed happens (P14-RT-08): this row is
  // the boot reconciler's idempotency marker (`OPERATOR_PLAN_EXECUTED_ACTION`,
  // run-recovery). Leading rather than following means a restart mid-plan leaves
  // the remainder unapplied instead of re-running actions that may already have
  // transitioned the stage or engaged an agent.
  recordAudit(db, {
    action: "runtime.operator.plan_executed",
    actor: SYSTEM_ACTOR,
    subjectKind: "run",
    subjectId: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { runId },
  });
  // This is machine-readable control data, not a timeline preview: use the
  // complete reply. replyTextForRun intentionally truncates at 1,200 chars and
  // appends prose, which corrupts otherwise-valid larger JSON plans.
  const text = fullReplyTextForRun(db, runId);
  const plan = text ? parseOperatorPlan(text) : null;
  if (!plan) {
    // An empty or unparseable plan is a HUMAN-VISIBLE failure, not a silent
    // no-op: nothing else covers an operator's own run (recovery only watches
    // specialist/reviewer runs), so without this the task simply sits with no
    // signal. Raise a blocked recovery packet through the operator's own gate.
    logger.warn("codex operator produced no usable plan; escalating", {
      taskKey: input.taskKey,
      runId,
      hadText: !!text,
    });
    const escalation = await operatorOpenPacket(
      db,
      ctx,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        packetType: "blocked",
        title: "Operator turn produced no actionable plan",
        body: text
          ? "The coordinating run replied, but its output was not a valid decision plan. Coordination is paused until a human re-engages the operator or redirects the task."
          : "The coordinating run finished without producing any output. Coordination is paused until a human re-engages the operator or redirects the task.",
        options: defaultPacketOptions("blocked"),
      },
      authority,
    ).catch((error) => {
      logger.error("codex no-plan escalation failed", {
        taskKey: input.taskKey,
        err: toError(error),
      });
      return null;
    });
    // G6: `operatorOpenPacket` returns `{outcome:"denied"}` WITHOUT throwing
    // when `generate-packets` is withheld — and `.catch` only catches throws.
    // So an operator deployed with packet-generation off/human would emit an
    // unparseable turn and STRAND with no packet, no note, only a server-side
    // warn. Fall back to a direct `note` (as narrateRefusedActions does) so the
    // human sees why the operator went quiet even when it cannot open a packet.
    if (!escalation || escalation.outcome !== "done") {
      await writeOperatorNoPlanNote(db, ctx, input, !!text);
    }
    return;
  }
  // The plan's prose fields persist to the timeline / packets — repair
  // double-escaped `\n` sequences the model emitted inside its JSON strings
  // (finding #23: literal "\n" rendered verbatim in the UI).
  if (plan.reasoning) plan.reasoning = normalizeEscapedNewlines(plan.reasoning);
  for (const a of plan.actions) {
    if (a.text) a.text = normalizeEscapedNewlines(a.text);
    if (a.reason) a.reason = normalizeEscapedNewlines(a.reason);
    // Ruling 668: the completion packet's notes are prose a person reads too.
    if (a.result) {
      for (const key of ["considerations", "assumptions", "gaps"] as const) {
        const note = a.result[key];
        if (note) a.result[key] = normalizeEscapedNewlines(note);
      }
    }
  }
  const base = { projectSlug: input.projectSlug, taskKey: input.taskKey };
  // Actions narrate themselves. Only a reply-only plan needs its reasoning
  // copied to the timeline.
  if (plan.actions.length === 0 && plan.reasoning) {
    await operatorPostComment(db, ctx, { ...base, text: plan.reasoning }, authority);
  }
  // P13-RT-03: every governed action returns `{outcome, message}` and this
  // executor used to DISCARD all of them. A plan whose actions were all denied
  // therefore left no trace whatsoever — the reasoning isn't posted either
  // (`plan.actions.length !== 0`), so a billed run, a taken-and-released lease
  // and a board flip back to "waiting on you" were indistinguishable from the
  // operator deciding to do nothing. Collect the refusals and narrate them.
  //
  // The two refusal SHAPES are kept apart (see OperatorActionResult): `denied`
  // is an authority refusal, `noop` is the task's state (or a malformed step)
  // ruling the action out. Filing them under one "refused by its capability
  // policy" banner told humans the project's policy blocked work it never
  // blocked — e.g. B3's "a decision packet is already open", which the
  // operator had every capability to do and simply must not do twice.
  const refused: RefusedPlanStep[] = [];
  // R20-9 / ruling 84: the delegated-ask disclosure used to ride the CLAUDE
  // toolkit's `open_decision_packet` alone, so a CODEX plan whose actions were
  // `prompt_agent` then `open_packet` — the exact shape the ruling is about —
  // raised the human's decision with nothing said about the consultation. The
  // plan executor is the other packet writer, so it keeps the same ledger and
  // opens through the same shared writer.
  const consultedProfileIds: string[] = [];
  const record = (toolName: string, result: OperatorActionResult | undefined) => {
    if (!result) return;
    const refusal = planRefusalOf(toolName, result);
    if (refusal) {
      refused.push(refusal);
      return;
    }
    // Ruling 406: the drive acted. Stamped HERE, on the one funnel every plan
    // step already passes through, so a new action shape is covered the day it
    // is added instead of the day it is mistaken for a deliberate hold.
    // Ruling 443: a step whose outcome is the packet it opened acted too.
    if ((result.outcome === "done" || result.openedPacket) && ctx.operatorRun) {
      ctx.operatorRun.carriedOutAction = true;
    }
  };
  // B-6 (pass 24): OpenAI-strict structured output makes every plan field
  // present-but-nullable, so a step like `{tool:"transition_stage", toStageId:null}`
  // is schema-valid. The guarded arms below skip such a step — narrate the skip
  // instead of dropping it, or a turn that named an action but filled none of its
  // fields reads to the human as an operator that silently decided nothing.
  const skippedMalformed = (toolName: string, missing: string) => {
    refused.push({ tool: toolName, message: `plan step omitted ${missing}`, kind: "state" });
  };
  // Ruling 430 (F39-52): a plan is written whole, before any step runs, so it
  // cannot see a decision one of its own steps puts in front of a person. Live
  // on AX-21 (01:18): `update_branch_from_base` met a conflict and opened the
  // blocking conflict packet, and the next step still dispatched the Surface
  // Developer with "The operator has updated the branch from the changed
  // base; start from that branch", about a branch the refresh had left
  // exactly as it was. Once the task holds a packet it did not hold when the
  // plan began, the steps that ACT are not carried out; a comment still posts.
  const packetKeyOf = (): string | null => {
    const packet = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.packet;
    return packet ? (packet.id ?? packet.title) : null;
  };
  const packetAtStart = packetKeyOf();
  let pausedBy: { tool: string; title: string } | null = null;
  const pausedSteps: string[] = [];
  for (const a of plan.actions) {
    // Ruling 488: a relay is a comment on another task, whose decision this
    // task's new packet does not hold, so it still posts like one.
    if (pausedBy && a.tool !== "post_comment" && a.tool !== "relay_to_task") {
      pausedSteps.push(a.tool);
      continue;
    }
    try {
      switch (a.tool) {
        case "post_comment":
          if (a.text) {
            record(
              a.tool,
              await operatorPostComment(db, ctx, { ...base, text: a.text }, authority),
            );
          } else skippedMalformed(a.tool, "the comment text");
          break;
        case "open_packet": {
          const packetType = a.packetType === "blocked" ? "blocked" : "input";
          if (a.text) {
            const packet: OperatorOpenPacketInput = {
              ...base,
              packetType,
              title: a.text,
              // P11-27: honor the operator's authored options when it supplied
              // a usable set (2–4); else fall back to the type's defaults.
              options: authoredPacketOptions(a.packetOptions) ?? defaultPacketOptions(packetType),
            };
            if (a.reason) packet.body = a.reason;
            record(
              a.tool,
              await operatorOpenPacketDisclosed(
                db,
                ctx,
                packet,
                authority,
                consultedProfileIds,
              ),
            );
          } else skippedMalformed(a.tool, "the packet title");
          break;
        }
        case "ask_for_repository": {
          // Ruling 672: the plan mirror of the Claude tool. The question is
          // the server's packet; the plan carries the reason and, if the
          // goal named one, the repository.
          if (a.reason) {
            const ask: Parameters<typeof operatorAskForRepository>[2] = { ...base, reason: a.reason };
            if (a.text) ask.repository = a.text;
            record(
              a.tool,
              await operatorAskForRepository(db, ctx, ask, authority, (packet) =>
                operatorOpenPacketDisclosed(db, ctx, packet, authority, consultedProfileIds),
              ),
            );
          } else skippedMalformed(a.tool, "the reason this task needs a repository");
          break;
        }
        case "set_dependencies": {
          // Ruling 131(b): the plan mirror of the Claude tool. A null list is
          // a malformed step (state), never a policy refusal.
          if (a.blockedBy) {
            const wait: Parameters<typeof operatorSetDependencies>[2] = {
              ...base,
              blockedBy: a.blockedBy,
            };
            if (a.reason) wait.reason = a.reason;
            record(a.tool, await operatorSetDependencies(db, ctx, wait, authority));
          } else skippedMalformed(a.tool, "the list of what the task waits on");
          break;
        }
        case "set_epic": {
          // Ruling 503: the plan mirror of the Claude tool. "" takes the task
          // out of its epic; a null epic is a malformed step.
          if (a.epicId != null) {
            const move: Parameters<typeof operatorSetEpic>[2] = {
              ...base,
              epicId: a.epicId.trim() || null,
            };
            if (a.reason) move.reason = a.reason;
            record(a.tool, await operatorSetEpic(db, ctx, move, authority));
          } else skippedMalformed(a.tool, "the epic");
          break;
        }
        case "run_agent":
          // The plan mirror of the toolkit's one dispatch tool: select + run,
          // optional `text` as the directive, optional `delivers` hand-off.
          if (a.profileId) {
            const dispatch: Parameters<typeof operatorDispatchAgent>[2] = {
              ...base,
              profileId: a.profileId,
            };
            // Ruling 446 (F39-70): the directive travels with what this plan's earlier steps
            // were refused, which the narration below only writes after the
            // agent has started.
            if (a.text) dispatch.prompt = withEarlierRefusals(a.text, refused);
            if (a.delivers != null) dispatch.delivers = a.delivers;
            if (a.reason) dispatch.reason = a.reason;
            if (a.completeness) dispatch.completeness = true;
            if (a.noVerdict) dispatch.noVerdict = true;
            const dispatched = await operatorDispatchAgent(db, ctx, dispatch, authority);
            // R20-9: only a dispatch that actually LANDED is a consultation — a
            // denied or no-op one consulted nobody (noteConsultedProfile).
            noteConsultedProfile(consultedProfileIds, a.profileId, dispatched.outcome);
            record(a.tool, dispatched);
          } else skippedMalformed(a.tool, "the agent to run");
          break;
        case "transition_stage":
          if (a.toStageId) {
            const move: Parameters<typeof operatorTransitionStage>[2] = {
              ...base,
              toStageId: a.toStageId,
            };
            if (a.reason) move.reason = a.reason;
            record(a.tool, await operatorTransitionStage(db, ctx, move, authority));
          } else skippedMalformed(a.tool, "the target stage");
          break;
        case "deliver_for_review": {
          const deliver: Parameters<typeof operatorDeliverForReview>[2] = { ...base };
          if (a.reason) deliver.reason = a.reason;
          const delivery = await operatorDeliverForReview(db, ctx, deliver, authority);
          // A failed delivery is a GitHub-state outcome performDelivery already
          // surfaced on the timeline in full (push conflict, no commits, PR
          // number) — repeating it as a bare "did not apply" line would be a
          // worse second copy of a story already told. Only the authority
          // refusal joins the report; the generalized authority/state split
          // above now handles every OTHER tool's state refusals, which used to
          // be the F15-15 misblame class this special case was alone in
          // dodging.
          if (delivery.outcome === "denied") record(a.tool, delivery);
          break;
        }
        case "update_branch_from_base":
          record(
            a.tool,
            await operatorUpdateBranchFromBase(db, ctx, base, authority),
          );
          break;
        case "accept_completion":
          record(a.tool, await operatorAcceptCompletion(db, ctx, base, authority));
          break;
        case "write_completion_packet":
          // Ruling 521: `text` is the summary, `reason` the summary of the
          // code changes.
          if (a.text) {
            const packet: Parameters<typeof operatorWriteCompletionPacket>[2] = {
              ...base,
              summary: a.text,
            };
            if (a.reason) packet.changes = a.reason;
            if (a.screenshots?.length) {
              packet.screenshots = a.screenshots.map((s) => ({ name: s.name, caption: s.caption }));
            }
            // Ruling 668: the notes and the result's files.
            if (a.result) {
              packet.considerations = a.result.considerations;
              packet.assumptions = a.result.assumptions;
              packet.gaps = a.result.gaps;
              if (a.result.files?.length) {
                packet.files = a.result.files.map((f) => ({ name: f.name, caption: f.caption }));
              }
            }
            record(a.tool, await operatorWriteCompletionPacket(db, ctx, packet, authority));
          } else skippedMalformed(a.tool, "the summary");
          break;
        case "resolve_packet": {
          // The reason falls back to the step's prose; neither present leaves
          // the key off, which is what `operatorResolvePacket` reads as "none".
          const withdraw: Parameters<typeof operatorResolvePacket>[2] = { ...base };
          const withdrawReason = a.reason || a.text;
          if (withdrawReason) withdraw.reason = withdrawReason;
          record(a.tool, await operatorResolvePacket(db, ctx, withdraw, authority));
          break;
        }
        case "set_goal":
          // `text` carries the drafted goal.
          if (a.text) {
            const goal: Parameters<typeof operatorSetGoal>[2] = { ...base, goal: a.text };
            if (a.reason) goal.reason = a.reason;
            record(a.tool, await operatorSetGoal(db, ctx, goal, authority));
          } else skippedMalformed(a.tool, "the drafted goal text");
          break;
        case "flag_context_conflict":
          // F-P6 (pass 25): `kbSource`/`repoSource` name the two sides; `text` is
          // the detail. Same action Claude's tool calls — a typed `quality` event
          // + the R19-2 watcher notification, not a plain comment.
          if (a.kbSource && a.repoSource && a.text) {
            record(
              a.tool,
              await operatorFlagContextConflict(
                db,
                ctx,
                {
                  ...base,
                  kbSource: a.kbSource,
                  repoSource: a.repoSource,
                  detail: a.text,
                },
                authority,
              ),
            );
          } else {
            skippedMalformed(
              a.tool,
              "the KB source, the repo source, and the detail",
            );
          }
          break;
        case "correct_knowledge_doc":
          // F39-1/F39-7 (pass 39), rulings 483 and 498: `kbSource` is
          // `<kb>/<doc>` (or a bare rulings document), `text` what the document
          // should say, `reason` the exact passage it replaces, `repoSource`
          // the evidence that proves it. Reuses the plan's existing string
          // fields rather than growing the schema — the two knowledge-base-
          // shaped actions then read alike. Ruling 581: an empty `text` with a
          // `reason` deletes that passage.
          if (a.kbSource && (a.text || a.reason) && a.repoSource) {
            record(
              a.tool,
              await operatorCorrectKnowledgeDoc(
                db,
                ctx,
                {
                  ...base,
                  ...splitKbSource(a.kbSource, ctx.dataRoot),
                  replaces: a.reason ?? null,
                  text: a.text ?? "",
                  evidence: a.repoSource,
                },
                authority,
              ),
            );
          } else {
            skippedMalformed(
              a.tool,
              "the knowledge-base document, the text to write, and the evidence",
            );
          }
          break;
        case "lease_files": {
          // Ruling 417: `paths` are the globs, `text` (or `reason`) why.
          const why = a.text || a.reason;
          if (a.paths && a.paths.length > 0 && why) {
            record(
              a.tool,
              await operatorLeaseFiles(db, ctx, { ...base, paths: a.paths, reason: why }, authority),
            );
          } else {
            skippedMalformed(a.tool, "the paths to lease and the reason they are held");
          }
          break;
        }
        case "schedule_task_action": {
          // Ruling 487: `profileId` is the agent (null or "operator" is the
          // operator's own re-run), `dueAt`/`delayMinutes` the time, `text`
          // the steer. No time at all is refused by the action itself, in
          // the same sentence every schedule door uses.
          const when: Parameters<typeof operatorScheduleRun>[2] = {
            ...base,
            agent: a.profileId?.trim() || "operator",
          };
          if (a.dueAt) when.dueAt = a.dueAt;
          else if (a.delayMinutes != null) when.delayMinutes = a.delayMinutes;
          if (a.text) when.prompt = a.text;
          record(a.tool, await operatorScheduleRun(db, ctx, when, authority));
          break;
        }
        case "cancel_task_schedule":
          if (a.scheduleId) {
            record(
              a.tool,
              await operatorCancelSchedule(db, ctx, { ...base, scheduleId: a.scheduleId }, authority),
            );
          } else skippedMalformed(a.tool, "the schedule to cancel");
          break;
        case "relay_to_task":
          // Ruling 488: `taskKey` is the other task, `text` what lands there;
          // ruling 538: `files` what it carries with it.
          if (a.taskKey && a.text) {
            record(
              a.tool,
              await operatorRelayToTask(
                db,
                ctx,
                { ...base, toTaskKey: a.taskKey, text: a.text, files: a.files ?? [] },
                authority,
              ),
            );
          } else skippedMalformed(a.tool, "the task to relay to and the text");
          break;
        case "take_from_task":
          // Ruling 557: `taskKey` holds the files, `files` names them, `text`
          // is an optional line on what they are for.
          if (a.taskKey && a.files && a.files.length > 0) {
            const take: Parameters<typeof operatorTakeFromTask>[2] = {
              ...base,
              fromTaskKey: a.taskKey,
              files: a.files,
            };
            if (a.text) take.text = a.text;
            record(a.tool, await operatorTakeFromTask(db, ctx, take, authority));
          } else skippedMalformed(a.tool, "the task to take from and the files");
          break;
        case "edit_comment":
          // Ruling 584: `commentAt` names the comment, `text` replaces its
          // words (null deletes it), `reason` is why.
          if (a.commentAt && a.reason) {
            record(
              a.tool,
              await operatorEditComment(
                db,
                ctx,
                { ...base, at: a.commentAt, text: a.text ?? null, reason: a.reason },
                authority,
              ),
            );
          } else skippedMalformed(a.tool, "the comment's time and the reason");
          break;
      }
    } catch (error) {
      // ABORT the remaining plan on a governed-action failure: executing later
      // actions against a state the failed one never produced compounds the
      // damage (e.g. an accept_completion after a failed transition). The
      // failure is narrated on the timeline so the board shows what stopped.
      logger.error("codex operator action failed; aborting the remaining plan", {
        taskKey: input.taskKey,
        tool: a.tool,
        err: toError(error),
      });
      // F28-O1: narrate the abort DIRECTLY, NOT through the gated
      // `operatorPostComment` — for the same reason `narrateRefusedActions`
      // writes straight to the timeline. When the operator's `append-typed-
      // events` is withheld the gate returns `denied`/`noop` WITHOUT throwing,
      // so the `.catch()` never fired and the abort notice was silently
      // discarded, leaving an engaged-but-never-run agent (board "waiting on
      // you") with nothing but a server log to explain it. A coordination stall
      // is a `note`, not a governance signal.
      await narrateOperatorNote(db, ctx, input, "codex operator plan-abort narration failed", {
        type: "note",
        title: null,
        text: `**Coordination stopped:** the \`${a.tool}\` step failed (${errorMessage(error)}). The remaining plan was not executed.`,
      });
      break;
    }
    if (!pausedBy) {
      const now = packetKeyOf();
      if (now !== null && now !== packetAtStart) {
        const packet = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.packet;
        pausedBy = { tool: a.tool, title: packet?.title ?? "a decision" };
      }
    }
  }
  if (pausedBy && pausedSteps.length > 0) {
    await narratePausedPlan(db, ctx, input, pausedBy, pausedSteps);
  }
  await narrateRefusedActions(db, ctx, input, refused, plan.reasoning);
  // Ruling 228 (F37-47): stamp the case where the drive did NOTHING because
  // every step it planned was refused. The refusal messages are written to be
  // acted on ("Do not refresh it here; recommend or accept the completion
  // instead") and they arrive after the turn has ended, so without this nobody
  // reads them until a human notices the task has stopped. Live on SHOP-3, on
  // the very run the Codex window had just been waited three hours for: one
  // refused step, nothing else, and 25 minutes parked at Verify.
  //
  // `refused` holds one entry per non-running step (including malformed ones),
  // so equality with the plan length IS "nothing ran" — and a step that THREW
  // breaks the loop early, leaving the counts unequal, which is right: an abort
  // is narrated on its own terms and is not this.
  if (ctx.operatorRun && plan.actions.length > 0 && refused.length === plan.actions.length) {
    ctx.operatorRun.planWhollyRefused = true;
    // Ruling 400: the sentences, not just the flag. The retry quotes them.
    ctx.operatorRun.refusedPlanSteps = refused.map((r) => ({
      tool: r.tool,
      message: r.message,
    }));
  }
}

/**
 * An operator note written straight onto the timeline, then re-projected.
 * Never through the gated `operatorPostComment`: a report about what the
 * operator's plan did must not depend on the gates of the operator it reports
 * on. Never throws; a write that fails is logged as `failure`.
 */
async function narrateOperatorNote(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  failure: string,
  note: { type: "note" | "policy"; title: string | null; text: string },
): Promise<void> {
  try {
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: note.type,
        actor: { kind: "operator" },
        title: note.title,
        text: note.text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  } catch (error) {
    logger.error(failure, {
      taskKey: input.taskKey,
      err: toError(error),
    });
  }
}

/**
 * Ruling 430: say which steps a new decision packet stopped, and why.
 *
 * Written directly, like `narrateRefusedActions`. Never throws; the plan
 * already ran.
 */
async function narratePausedPlan(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  pausedBy: { tool: string; title: string },
  steps: string[],
): Promise<void> {
  const list = steps.map((s) => `\`${s}\``).join(", ");
  await narrateOperatorNote(db, ctx, input, "codex operator plan-pause narration failed", {
    type: "note",
    title: "Coordination paused",
    text:
      `**Coordination paused:** the \`${pausedBy.tool}\` step left a decision for a person ` +
      `(“${pausedBy.title}”), so the rest of this plan was not carried out: ${list}. ` +
      "It was written before that decision existed. The operator picks the task up again once it is answered.",
  });
}

/** A plan step that did not run, and WHY it did not (see OperatorActionResult):
 *  `authority` = the capability policy (or ownership) refused it;
 *  `state` = the task's current state, or the step itself, ruled it out. */
export interface RefusedPlanStep {
  tool: string;
  message: string;
  kind: "authority" | "state";
}

/**
 * Ruling 443: what one plan step's result adds to the plan's refusals, if
 * anything. `denied` is a refusal by authority and `noop` one by state (the
 * LV-03 split), except a step whose outcome is the decision packet it opened.
 * Live on ax-clone AX-21, AX-28 and AX-5 a refresh that met a conflict was
 * narrated "This step did not apply to the task's current state" beside the
 * packet it had just opened. The step ran, and its outcome was the packet.
 */
export function planRefusalOf(
  toolName: string,
  result: OperatorActionResult,
): RefusedPlanStep | null {
  if (result.outcome !== "denied" && result.outcome !== "noop") return null;
  if (result.openedPacket) return null;
  return {
    tool: toolName,
    message: result.message,
    kind: result.outcome === "denied" ? "authority" : "state",
  };
}

/**
 * Ruling 446 (F39-70): a dispatch in a Codex plan carries the refusals the same plan has
 * already collected. A plan is written before any step runs, so a directive
 * can only say "if the lease is refused, ...". The note that answers it is
 * narrated after the plan's last step, when the agent is already running.
 * Live on ax-clone AX-5 the Developer was told "Do not modify any path the
 * lease action refuses" and was never told which paths those were: the note
 * naming them landed 46 ms after its run started.
 */
export function withEarlierRefusals(
  directive: string,
  refused: readonly { tool: string; message: string }[],
): string {
  if (refused.length === 0) return directive;
  const one = refused.length === 1;
  return (
    `${directive}\n\nViberr did not carry out ${one ? "this earlier step" : "these earlier steps"} ` +
    "of the operator's plan for this turn. Read the directive above against what actually " +
    `happened (${one ? "it is" : "each is"} Viberr's answer to the operator):\n` +
    refused.map((r) => `- \`${r.tool}\`: ${r.message}`).join("\n")
  );
}

/**
 * Put refused plan actions on the timeline (P13-RT-03).
 *
 * Written DIRECTLY as a timeline event rather than through
 * `operatorPostComment`, because the commonest refusal case is an operator
 * whose `append-typed-events` is itself withheld — routing the narration
 * through the gate would make the report of the silence silent too.
 *
 * The two shapes are named separately, and the EVENT TYPE follows: LV-03
 * reserves `policy` for genuine governance refusals, so a purely state-ruled
 * plan is a `note`. A run that stated "refused by its capability policy" over
 * "a decision packet is already open" (B3) accused the project's policy of
 * blocking work no policy blocked — and a `policy` event is what the activity
 * feed and the human read as a governance signal.
 *
 * Never throws: the plan already ran.
 */
async function narrateRefusedActions(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  refused: RefusedPlanStep[],
  reasoning: string,
): Promise<void> {
  if (refused.length === 0) return;
  const byAuthority = refused.filter((r) => r.kind === "authority");
  const byState = refused.filter((r) => r.kind === "state");
  const list = (steps: RefusedPlanStep[]) =>
    steps.map((r) => `- \`${r.tool}\`: ${r.message}`).join("\n");
  const were = (steps: RefusedPlanStep[]) =>
    steps.length === 1 ? "This step was" : "These steps were";
  const did = (steps: RefusedPlanStep[]) =>
    steps.length === 1 ? "This step did" : "These steps did";
  // One bucket → one sentence (the common case reads as prose). Mixed → two
  // labelled lists, because "refused" and "did not apply" are different facts
  // and a human acts on them differently.
  const body =
    byAuthority.length > 0 && byState.length > 0
      ? `Refused by its capability policy:\n\n${list(byAuthority)}\n\n` +
        `Did not apply to the task's current state:\n\n${list(byState)}`
      : byAuthority.length > 0
        ? `${were(byAuthority)} refused by its capability policy:\n\n${list(byAuthority)}`
        : `${did(byState)} not apply to the task's current state:\n\n${list(byState)}`;
  const text =
    // Ruling 408: the lead is a shared constant, because the next turn's carry
    // finds this note by it.
    `${PLAN_NOT_CARRIED_OUT_LEAD} ${body}` +
    (reasoning.trim()
      ? `\n\nWhat it intended:\n\n> ${reasoning.trim().replace(/\n/g, "\n> ")}`
      : "");
  logger.warn("codex operator plan actions did not run", {
    taskKey: input.taskKey,
    refusedByPolicy: byAuthority.map((r) => r.tool),
    refusedByState: byState.map((r) => r.tool),
  });
  await narrateOperatorNote(db, ctx, input, "codex operator refusal narration failed", {
    // LV-03: `policy` is a governance signal. Only an authority refusal is
    // one; a state conflict is a plain note.
    type: byAuthority.length > 0 ? "policy" : "note",
    title: null,
    text,
  });
}

/**
 * G6: last-resort note when the operator produced no usable plan AND could not
 * open the blocked recovery packet (its `generate-packets` capability is
 * withheld). Without this the task strands `waiting:human` with nothing on the
 * timeline. A plain `note` (not `policy`) — this is a coordination stall, not a
 * governance refusal — that tells the human to re-engage or redirect.
 */
async function writeOperatorNoPlanNote(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  hadText: boolean,
): Promise<void> {
  const text =
    "**The operator produced no actionable plan and could not open a recovery packet** " +
    "(packet generation is not available to it here). " +
    (hadText
      ? "Its run replied, but the output was not a valid decision plan. "
      : "Its run finished without producing any output. ") +
    "Coordination is paused: re-engage the operator or redirect the task.";
  await narrateOperatorNote(db, ctx, input, "codex no-plan note fallback failed", {
    type: "note",
    title: null,
    text,
  });
}
