/**
 * The task as the operator reads it (ruling 656): `operatorSnapshot`, the one
 * structured view of a task (its stage and owner, timeline, decisions, runs,
 * gates, dependencies and base drift) that every operator turn is built on.
 */

import { describeRevisionDrift, type RevisionDrift } from "~/shared/revision-drift";
import { resolveDependencies } from "~/server/projections/dependencies.server";
import { OPERATOR_SCHEDULER_ID } from "./schedule.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import { prPathOverlaps } from "~/shared/pr-overlaps";
import type { DependencyRender } from "~/shared/dependencies";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CapabilityGrant, ProjectGate } from "~/schemas/project-file.schema";
import { withheldAgentGrants } from "~/features/agents/capability-catalog";
import { effectiveCollabMode } from "./agent-outcome.server";
import { PLAN_NOT_CARRIED_OUT_RE, RUN_DID_NOT_COMPLETE_RE } from "~/shared/run-failure";
import { DECISION_LEAD } from "~/shared/timeline-leads";
import { type EpicStatus, isEpicOpen } from "~/schemas/epic-file.schema";
import { epicTaskRows, listEpics } from "~/server/projections/epic-query.server";
import { acceptanceBoundaryRefusal } from "~/server/github/acceptance-boundary.server";
import {
  activeWorkRevision,
  consecutiveRequestChanges,
  currentVerdicts,
  deliveringEngagement,
  deriveValidation,
  type ForeignBranchHead,
  PACKET_NOTE_MAX,
  type PrMergeable,
  type PrState,
  supportingEngagements,
  type TaskFileEvent,
  type TaskFrontmatter,
  type TaskSchedule,
  type UnpushedRevision,
  unpushedRevisionBlockedReason,
  unpushedRevisionOf,
} from "~/schemas/task-file.schema";
import { resolveStageRoles, stageName } from "~/shared/workflow/stage-roles";
import { engageStagesFor } from "~/shared/workflow/engage-stages";
import { verdictStageFor } from "~/shared/workflow/verdict-stage";
import { AppError } from "~/server/errors/app-error.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { activeFileLeases } from "~/server/tasks/file-leases.server";
import { readTaskFile, resolveTaskFilePath } from "~/server/files/task-writer.server";
import {
  type BaseCompareReading,
  createBaseCompareLookup,
} from "~/server/provenance/provenance-query.server";
import { storeRelativePath } from "~/server/files/file-store-root.server";
import { RECOMMENDATION_DISMISSED_AUDIT_ACTION } from "./task-recommendations.server";
import { acceptanceRefusalFor } from "./task-acceptance.server";
import { type TaskMutationContext, taskRef } from "./task-mutation.server";
import { noChangeApplies } from "./no-change-completion.server";
import {
  type DeployedSpecialistView,
  listDeployedSpecialists,
  runEligibilityFor,
} from "./specialist-roster.server";
import { type RequiredReviewerView, resolveRequiredReviewers } from "./required-reviewers.server";
import { type CompletionPacketFact, completionPacketFact } from "./completion-packet.server";
import { type TaskTook, taskTook } from "./what-it-took.server";
import { listRunsForTaskRows } from "~/server/runtimes/run-store.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import { liveMergeable } from "~/features/github/github-pills";
import {
  listKnowledgeBaseNames,
  listMcpServerNames,
  listSkillNames,
} from "~/server/org/resources.server";
import {
  failedGateResults,
  gateOutcomeText,
  type GatesState,
  projectGatesView,
} from "~/shared/project-gates";
import type { OperatorAuthority, OperatorAutonomy } from "./operator-authority.server";
import { packetIsOperators } from "./operator-packets.server";

export interface OperatorTaskSnapshot {
  key: string;
  title: string;
  goal: string;
  /** R26-1 (owner ruling): the human triage metadata, surfaced to the OPERATOR
   *  (not the delivering agent) so it can factor urgency and deadlines into how it
   *  sequences work and what it recommends. Purely informational — it changes no
   *  gate and grants no authority. `priority: "normal"`, an empty label set and a
   *  null due date are the unremarkable defaults. */
  priority: string;
  labels: string[];
  dueDate: string | null;
  /** Ruling 131(d): what the task waits on, each entry with its live state.
   *  Non-empty means the task is HELD: the doctrine replaces the stage rule. */
  blockedBy: DependencyRender[];
  stage: string;
  stageName: string;
  /** Dynamic-dispatch rework (2026-08-29): where the task CAME from — the
   *  durable `previousStageId` frontmatter fact, named so the agent choice can
   *  weigh it (a task back in the work stage from Review is rework for the
   *  same builder; a fresh arrival wants a first hand-off). Null until the
   *  task's first transition. */
  previousStage: { id: string; name: string } | null;
  readiness: string;
  waiting: string;
  /** F27-O5: the DERIVED review outcome on the current revision — `healthy`
   *  (every required reviewer approved), `failing` (a required reviewer requested
   *  changes), `changed` (a revision under review, verdicts pending), or `none`
   *  (nothing delivered). The operator used to infer this from the timeline
   *  window alone; naming it here makes review state explicit and robust to a
   *  long/noisy timeline. Advisory context, not authority — acceptance is still
   *  gated server-side. */
  validation: string;
  owner: string | null;
  specialist: { profileId: string; role: string; backend: string } | null;
  /** `verdict` is each reviewer's OWN verdict on the current revision (F27-O5):
   *  `approve` | `request_changes`, or `null` when it has not weighed in yet. */
  reviewers: {
    profileId: string;
    role: string;
    backend: string;
    verdict: "approve" | "request_changes" | null;
    /** Ruling 193: successive delivered revisions this reviewer has requested
     *  changes on, counted back from its newest verdict and stopping at its
     *  first `approve`. `0` when its newest verdict is an approval or it has
     *  not weighed in. Two or more means the same objection survived a rework,
     *  which is when re-prompting the deliverer stops being the move. Optional
     *  so hand-built fixtures need not restate it; `operatorSnapshot` always
     *  sets it. */
    consecutiveRequestChanges?: number;
  }[];
  /** Ruling 178: the reviewers the PROJECT requires, per review stage,
   *  resolved to the names the acceptance gate prints. Each must hold an
   *  `approve` verdict on the delivered revision before acceptance, engaged
   *  or not — `reviewers` above lists only who the operator has engaged.
   *  Optional so hand-built fixtures need not restate it; `operatorSnapshot`
   *  always sets it. */
  requiredReviewers?: RequiredReviewerView[];
  /**
   * Ruling 482 (F40-52): the project's gates on the revision under review, as
   * VIBERR ran them (never an agent's report of them): the line the PR card
   * prints, the state, and each gate that did not exit 0 with its log's
   * attachment name. A `failed` state blocks acceptance; dispatch the rework
   * with the failing gate and its log in the directive. Null when the project
   * declares no gates or nothing is delivered. Optional so hand-built
   * fixtures need not restate it; `operatorSnapshot` always sets it.
   */
  gates?: {
    line: string;
    state: GatesState;
    failed: { name: string; command: string; outcome: string; log: string | null }[];
    error: string | null;
  } | null;
  /** Stages the task may move to next (declared workflow boundaries). */
  nextStages: { id: string; name: string; boundary: string }[];
  /** R7-4 rework routing, made VISIBLE. The governed workflow graph is
   *  forward-only, so `nextStages` never contains an earlier stage — and an
   *  operator reading only that field concludes it cannot send failed work
   *  back, which is exactly what happened live: a reviewer requested changes,
   *  the operator reported "there is no Review → In Progress transition
   *  available to me" and parked the task on a human, while the move was
   *  legal all along. These are the earlier stages the operator MAY move the
   *  task to directly, no human and no recommendation. Non-empty only while
   *  the latest review is `failing` — the same gate `transitionStage` vets.
   *  Ruling 702: and while the task has no delivering agent, the earlier
   *  stages where one can be engaged, each with `engage` naming the agents. */
  reworkStages: { id: string; name: string; engage?: string[] }[];
  /** All stage ids in workflow order (first → done). Lets a coordinator tell a
   *  pre-work stage from the implementation stage from the review stage. */
  stageIds: string[];
  /** The last stage id — reached only via accept_completion. */
  doneStageId: string | null;
  /** The review stage id (edge into Done) — resolved from the workflow graph,
   *  NOT positionally, so custom/lightweight boards classify correctly. */
  reviewStageId: string | null;
  /** The implementation ("work") stage id (edge into review). */
  workStageId: string | null;
  deployedSpecialists: (DeployedSpecialistView & {
    /** Whether this profile may RUN the task at its CURRENT stage: its
     *  declared eligibility, or (ruling 133) it is the task's engaged
     *  deliverer, which runs at every stage. Declared eligibility alone is
     *  where a profile may be NEWLY engaged. */
    eligibleForCurrentStage: boolean;
    /** Ruling 133: this profile is the task's delivering engagement. */
    engagedAsDeliverer: boolean;
    /** F21-16: the specialist's OWN capabilities, resolved live from its
     *  deployment grants — the right place to look when a human asks whether an
     *  agent's grant took effect. `DeployedSpecialistView.capabilities` already
     *  carries `browser`; `web` (`use-web-search-fetch`) is added here because
     *  it is the row the operator misattributed to itself. */
    capabilities: DeployedSpecialistView["capabilities"] & { web: boolean };
  })[];
  openPacket: boolean;
  /** The open decision packet's CONTENT (null when none) — the operator needs
   *  it to judge whether the packet is now moot (resolve_decision_packet)
   *  rather than only knowing "a packet exists". */
  packet: {
    type: "input" | "blocked";
    title: string;
    body: string;
    options: string[];
    /** Ruling 138: `goal_edit` once an edit_goal option was confirmed — the
     *  packet is decided and waits for the edited goal, so do not re-ask. */
    awaiting: "goal_edit" | null;
    /** Ruling 437: who raised it, as the packet records it ("operator", an
     *  agent's ref, "policy-engine"). */
    raisedBy: string;
    /** Ruling 437: whether `resolve_packet` may withdraw it, read with the
     *  refusal's own condition: only a packet the operator raised, never an
     *  agent's question. */
    yours: boolean;
  } | null;
  /**
   * Ruling 503: the EPIC this task is in, with the rest of its work.
   *
   * Ruling 402 (F39-29) gave the operator the goal chain its task was a link
   * of, because a link that had not started had no task and `read_board`
   * could not see it: live on ax-clone AX-4 the operator planned a packet
   * offering to create a follow-on for the missing `/logs` baseline, which
   * goal-4 link 5 already held, waiting on AX-4 itself. Every task an epic
   * holds exists from the moment it joins, so the same question has a plain
   * answer here: the epic's other tasks, each with its stage and what it
   * waits on. Absent for a task in no epic.
   */
  epic?: {
    id: string;
    title: string;
    status: EpicStatus;
    description: string;
    /** Present only when `description` was cut. */
    clipped?: string;
    /** The epic's OTHER tasks, archived ones left out. */
    tasks: { key: string; title: string; stage: string; blockedBy: string[] }[];
  };
  /** Ruling 503: the project's open epics, for `set_epic`. Absent when it has
   *  none. */
  openEpics?: { id: string; title: string }[];
  recentTimeline: OperatorTimelineRow[];
  /**
   * Ruling 397 (F39-24): a run Viberr recorded as FAILED that had already
   * posted its report moments earlier, with nothing dispatched since.
   *
   * Ruling 394 stops the common cause of this, but a genuinely cut run can
   * still leave a partial report, and the failure event's own sentence
   * ("Nothing was delivered to a pull request") is about the PR while a reader
   * takes it to be about the work. Live on ax-clone AX-2 the report said "Done
   * on branch ax-2, commit 3e0396ab, make gate and go test -race both pass",
   * and the sentence two lines below it said the run did not complete; a human
   * had to read the workspace to find out which was true.
   *
   * Absent once anything has been dispatched since: the decision this carries
   * has been made by then, and repeating it every turn is noise.
   */
  unfinishedReport?: {
    /** The agent whose run failed, by its role (its profile id when the
     *  event carries none). */
    actor: string;
    /** The failure event's stamp. */
    failedAt: string;
    /** The report's stamp, which `read_timeline_entry` takes. */
    reportedAt: string;
    /** Ruling 415: the report itself, for an operator that cannot call
     *  `read_timeline_entry` (a Codex plan). Absent for one that can. */
    text?: string;
    /** Ruling 440: present only when `text` was cut. */
    clipped?: string;
  };
  /**
   * Ruling 408 (F39-35): a refusal this task has not answered yet.
   *
   * Ruling 400 made the plan-refused retry CARRY its refusals instead of
   * saying "read them on the timeline" -- but it records them only when the
   * plan was WHOLLY refused (`refused.length === plan.actions.length`), which
   * is the rarer half. Live on ax-clone AX-18 the operator planned
   * `[deliver_for_review, transition_stage]`; the delivery RAN, the transition
   * was refused, so nothing was recorded -- and fourteen seconds later the
   * next drive planned `transition_stage` again and was refused with a
   * byte-identical message. That second wasted drive is what tripped the
   * two-in-a-row hold (ruling 406).
   *
   * Partial or whole, a refusal the operator has not acted on is the most
   * important thing about the task. Absent once it has moved the task or
   * dispatched an agent since.
   */
  unansweredRefusal?: { at: string; text: string };
  /**
   * Ruling 413: the OTHER open review PRs whose diff shares a file with this
   * task's, by shared path.
   *
   * Viberr has computed this since ruling 236 and rendered it on exactly one
   * surface, the human's review queue, described there as "read-only and quiet
   * by design". The operator is the actor that decides what to dispatch, when
   * to deliver and whether to refresh a branch, and it had no cross-task view
   * at all: asked where it was weakest, the ax-clone controller answered that
   * `get_task` is single-task, "so every cross-task correlation on this board
   * is currently done by you". Ruling 402 gave it the goal chain for the same
   * reason (ruling 503: its epic now); this is the other fact viberr already
   * holds.
   *
   * Read live on ax-clone: all five open PRs carried one, and AX-20 and AX-21
   * had already spent a run, a decision packet and a human answer on a
   * collision in `internal/sandbox/local.go`. Absent when this task has no
   * open review PR, or when nothing overlaps.
   */
  collisions?: { taskKey: string; prNumber: number; paths: string[]; partial: boolean }[];
  /**
   * Ruling 431 (pass 39, F39-53): the project's file leases as they bind NOW
   * (ruling 245(b): a finished holder's lease is gone), every holder included.
   *
   * The operator only had the timeline's "Files leased by another task" note,
   * which is history. Live on ax-clone AX-21 (01:18) the owner had removed
   * AX-22's lease on `internal/server/server.go` twenty minutes before, and the
   * operator still told the Surface Developer "AX-22 currently holds
   * `internal/server/server.go` … do not change those paths", about one of the
   * three files its conflict needed resolved, while the developer's own prompt
   * listed no such lease. Absent when nothing is leased.
   */
  fileLeases?: { taskKey: string; paths: string[]; reason: string }[];
  /**
   * Ruling 415 (F39-41): every decision a PERSON made on this task, newest
   * first, read from the WHOLE timeline, with their own words when they gave
   * any.
   *
   * Ruling 284 keeps typed words out of the goal and said nothing was lost by
   * it, because the words "reach the operator in their own `note` field on the
   * re-queue". They reach exactly ONE turn. Live on ax-clone AX-19 the owner
   * answered round five in their own words ("I am changing what may block
   * rather than asking again"); the turn that note summoned dispatched the
   * rework, the provider refused that run for quota three minutes later, and
   * the next turn, forty minutes on, was a scheduled resume whose six-entry
   * window started after the decision. It did the one thing the decision
   * ruled out: it asked the reviewer again.
   *
   * The newest entry's words are whole; older ones are cut, and say so.
   * Absent when no person has decided anything here.
   */
  humanDecisions?: {
    /** The decision event's stamp. */
    at: string;
    /** Who decided, as the timeline names them. */
    by: string;
    /** What was chosen: the decision sentence, without its label. */
    decision: string;
    /** The person's own words (a directive, or the note under an option). */
    words?: string;
    /** Present when `words` was cut, saying where the rest is. */
    clipped?: string;
  }[];
  /** Ruling 302: how many entries this task's timeline HAS, against the
   *  `recentTimeline.length` shown. Present always, so a coordinator never has
   *  to infer from a full-looking window that it saw everything. */
  timelineTotal: number;
  /** Ruling 302: present ONLY when entries were left out, naming the count and
   *  the way to reach them. */
  timelineOlder?: string;
  /** [1] The coordinator's OWN proposals — what it already asked for, and what a
   *  human already refused. Without this the supervised loop spins: a supervisor
   *  declines "move to Review", the next drive cannot see the refusal (the
   *  dismissal clears the card, and `addRecommendation`'s duplicate guard
   *  compares only against still-PENDING cards), so it proposes the identical
   *  thing and re-pings the same supervisors.
   *
   *  BOUNDED on purpose — the whole snapshot is JSON-embedded in the operator
   *  prompt (buildCodexOperatorPrompt) and returned verbatim by `get_task`: at
   *  most MAX_SNAPSHOT_RECOMMENDATIONS entries per list, each label capped at
   *  RECOMMENDATION_LABEL_CAP characters.
   *
   *  `declined` reads the `task.recommendation.dismissed` audit rows — which had
   *  no reader anywhere in the product before this — so this list is bounded by
   *  the 90-day audit retention. The DURABLE trace of a refusal is the typed
   *  timeline event `dismissRecommendation` writes
   *  (RECOMMENDATION_DECLINED_TITLE); that one lives in task.md for good and is
   *  what the operator re-reads through `recentTimeline`.
   *
   *  Optional only so hand-built test fixtures need not restate it (same reason
   *  as `repo`/`noChanges`); `operatorSnapshot` always sets it. */
  recommendations?: {
    /** Still awaiting a human — do NOT re-propose these. */
    pending: {
      id: string;
      kind: string;
      label: string;
      /** Target profile id (assign/run recommendations), when the kind has one. */
      profileId: string | null;
      /** transition target stage id, when the kind carries one. */
      toStageId: string | null;
    }[];
    /** Already REFUSED by a human, newest first. Re-proposing one of these is
     *  the loop this field exists to stop. */
    declined: { kind: string; label: string; at: string }[];
  };
  /** P13-D-4: the review PR, or null. The operator used to be structurally
   *  blind to it — no `pr` field anywhere in the snapshot — so it could neither
   *  see that a human had CLOSED the PR on GitHub (an out-of-band rejection)
   *  nor reason about it before recommending/accepting completion. `state` is
   *  the task-file cache vocabulary: review | merged | closed | accepted.
   *
   *  F21-17: `revisionDrift` is the same fact the acceptance ceremony discloses
   *  (R17-1) — commits pushed to the PR head AFTER the last reviewed revision.
   *  The operator was structurally blind to it, so its PR-closed recovery packet
   *  could say "the review before closure was clean (Approve)" while an
   *  unreviewed out-of-band commit the reconciler had already seen went
   *  unmentioned. Null when the head equals the reviewed revision.
   *
   *  Ruling 132 (pass 34, F34-14): the WHOLE record, plus the canonical
   *  sentence (`describeRevisionDrift`) the accept dialog prints, so the
   *  operator's read and the ceremony can never say two different things. */
  pr:
    | {
        number: number;
        state: PrState;
        title: string;
        revisionDrift: RevisionDrift | null;
        /** `describeRevisionDrift(revisionDrift).sentence`, empty for none. */
        revisionDriftSentence: string;
        /** Ruling 135 (pass 34, F34-11): the PR head as last read, the CURRENT
         *  unpushed record (null when the delivered revision is on the PR or
         *  the fact was never measured), and the sentence the acceptance gate
         *  refuses with ("" when none). An unpushed revision reaches its PR
         *  through `deliver_for_review`; it is never a person's push. */
        headSha: string | null;
        unpushedRevision: UnpushedRevision | null;
        unpushedRevisionSentence: string;
        /** Ruling 162 (pass 35, F35-12): GitHub's mergeability as the
         *  reconciler last read it (`conflicting` is the fact the acceptance
         *  gate refuses on); null when never read or settled. Optional only so
         *  hand-built fixtures need not restate it; the producer always sets it. */
        mergeable?: PrMergeable | null;
      }
    | null;
  /** Ruling 162 (pass 35, F35-12): the acceptance gate's own refusal, computed
   *  by the SAME function every acceptance surface reads
   *  (`acceptanceRefusalFor`), or null when the task could be accepted now.
   *  A PR the gate would refuse cannot be recommended for acceptance and the
   *  task cannot be moved into the acceptance stage; route the conflict with
   *  `update_branch_from_base` (ruling 475) or deliver the unpushed revision
   *  instead. Optional only so hand-built
   *  fixtures need not restate it; `operatorSnapshot` always sets it. */
  notAcceptableReason?: string | null;
  /** Ruling 521: the completion packet a person reads before accepting, and
   *  what writing it takes (the change's size, the images you may pick).
   *  Optional only so hand-built fixtures need not restate it;
   *  `operatorSnapshot` always sets it. */
  completionPacket?: CompletionPacketFact;
  /** Ruling 693: what the task has taken so far, derived from its run rows and
   *  its own timeline at this read: the runs that started and their agent
   *  minutes, the dollars they reported (`cost.usd: null` is unknown, never
   *  zero), the rounds a person was asked, the times the work was sent back,
   *  the wall time to the first delivery and to acceptance, and who spent it
   *  (`byAgent`). `notes` says what the figure misses. Information only: it
   *  changes no gate. Optional so hand-built fixtures need not restate it;
   *  `operatorSnapshot` sets it unless the read itself failed. */
  whatItTook?: TaskTook;
  /** The task's delivery branch (null before any delivery). Lets recovery
   *  packets name the branch a `deleteBranch` archive option would remove. */
  branch: string | null;
  /** V19: an unrelated PR squatting this task's branch name (R15-15 collision,
   *  recorded by the reconciler as `github.unownedPr`). The operator was
   *  structurally blind to the collision at the exact moment it must author a
   *  `resolve_remote_collision` packet — the Collision card row and the
   *  refusal notes rendered it for humans only, so the model had to guess from
   *  timeline prose. Null when no collision is recorded.
   *
   *  Optional only so hand-built test fixtures need not restate it; the real
   *  producer (`operatorSnapshot`) always sets it. */
  unownedPr?: number | null;
  /** Ruling 161 (pass 35, U35-8): origin's copy of the task branch carries
   *  commits this task did not author, as the reconciler last recorded it
   *  (`github.foreignHead`): the head sha when GitHub named one and the
   *  unowned PR when one stands. Name it in an `archive_task` option's text
   *  when offering `deleteBranch`: deleting the branch removes those commits
   *  too. Null when the head is this task's or was never read. Optional only
   *  so hand-built fixtures need not restate it; `operatorSnapshot` sets it. */
  foreignHead?: ForeignBranchHead | null;
  /** F37-11 (pass 37): how many commits the BASE is ahead of this task's
   *  branch, from the reconciler's last compare — the same reading the GitHub
   *  page's sync pill renders. `0` = level with the base, `null` = no pass has
   *  compared this task yet. Informational: a stale or absent reading must
   *  never stop an update, it only stops the step being planned blind. */
  baseBehindBy?: number | null;
  /** Ruling 494 (pass 40, F40-70): the compare `baseBehindBy` was counted in.
   *  `sha` is the branch head it read and `observedAt` when it ran. `current`
   *  is false when the count was not read on the head Viberr's newest push
   *  published (`pushedSince` names that head, null when git could not name
   *  it): the push came after the compare, or the compare right after the
   *  push read another head because GitHub had not shown the push yet. The
   *  count then describes another head than the pushed one. It is null when
   *  the compare named no head (a compare recorded before ruling 494), which
   *  never reads as current either, and true otherwise. Null while
   *  `baseBehindBy` is null. Optional only so hand-built fixtures need not
   *  restate it; `operatorSnapshot` always sets it. */
  baseComparedHead?: {
    sha: string | null;
    observedAt: string;
    current: boolean | null;
    pushedSince: { sha: string | null; at: string } | null;
  } | null;
  /** Ruling 494: when `baseBehindBy` does not describe the branch's current
   *  head, the sentence that says so and what not to write; "" when it does.
   *  Optional for the same reason as above. */
  baseBehindBySentence?: string;
  /** Ruling 424 (pass 39): the sentence `update_branch_from_base` refuses
   *  with from where the task stands, or null when a refresh would run. At
   *  the acceptance stage the ceremony refreshes the branch once and merges,
   *  so a positive `baseBehindBy` there is the ceremony's to settle; the
   *  operator read the doctrine and the count and planned the refresh anyway,
   *  fifteen times across seven ax-clone tasks, each one a "plan was not
   *  carried out in full" note on the task's timeline. Read from the same
   *  function the tool refuses with, so the two cannot disagree. Optional only
   *  so hand-built fixtures need not restate it; `operatorSnapshot` sets it. */
  notRefreshableReason?: string | null;
  /** R19-1: the project's repository ("owner/name"), or null when none is
   *  attached. The coordinator used to be blind to it — it could not even NAME
   *  the repository it operates on, which is part of how it came to call its own
   *  task folder "the repo" (F19-4). It now works inside a read-only checkout of
   *  that repository (owner ruling 2026-08-06), so naming it is table stakes.
   *
   *  Optional only so hand-built test fixtures need not restate it (same
   *  reason as `noChanges`); `operatorSnapshot` always sets it. */
  repo?: string | null;
  /** R19-8: this task is a no-change completion — nothing was delivered and
   *  there is nothing to merge. Accept it with `accept_completion`; do NOT call
   *  `deliver_for_review` and do NOT open a decision packet asking a human how
   *  to close it out. The operator used to be structurally blind to the shape,
   *  which is how VC-5 became a "how do we close this out?" packet whose
   *  recommended option was "Manually mark Done" (F19-21).
   *
   *  Optional only so hand-built test fixtures need not restate it; the real
   *  producer (`operatorSnapshot`) always sets it. */
  noChanges?: boolean;
  /** Queued/running agent runs on THIS task — the ONLY truth for "a run is
   *  in flight". Live-caught: the operator inferred an in-flight deliverer
   *  from `waiting: "agent"` (a board display flag) plus its own directive
   *  comment, when the prompt's run had actually REFUSED to start — so the
   *  rework never resumed. An empty list here means nothing is running,
   *  whatever the timeline or `waiting` suggest. */
  liveRuns: {
    kind: "operator" | "primary" | "reviewer";
    profileId: string | null;
    state: "queued" | "running";
  }[];
  /**
   * Ruling 487: the runs scheduled on THIS task that have not fired yet, read
   * from the task file: its own re-run (`run-operator`) or an agent's
   * (`run-agent`, with the profile and directive). `by` is who scheduled it,
   * and `yours` marks one the operator scheduled itself, the only kind
   * `cancel_task_schedule` takes from it. A hold one of these explains needs
   * no decision packet. Optional so hand-built fixtures need not restate it;
   * `operatorSnapshot` always sets it.
   */
  schedules?: {
    id: string;
    action: TaskSchedule["action"];
    dueAt: string;
    profileId: string | null;
    prompt: string;
    by: string;
    yours: boolean;
  }[];
  autonomy: OperatorAutonomy;
  /**
   * F21-16 — the operator's OWN capability policy, LABELLED as its own.
   *
   * This used to be a bare `policy: Record<string, string>` sitting next to
   * `deployedSpecialists`, with nothing in the payload saying whose policy it
   * was. Live (VIB-5): a human granted the Web Verifier profile web + browser,
   * the operator read `use-web-search-fetch: off` out of THIS map — its own
   * egress row, withheld from the coordinator on purpose — and generated a
   * "Web egress grant did not take effect" packet about the specialist. The
   * specialist's next run mounted the browser fine. A model cannot be blamed
   * for reading an unlabelled map as the only policy in the payload, so the
   * payload now names the scope and points at the right place for the other
   * one (`deployedSpecialists[].capabilities`).
   */
  operatorPolicy: {
    /** Always `"operator"` — whose capabilities these are. */
    scope: "operator";
    /** One line the model reads before it quotes a row at anybody. */
    note: string;
    /** capabilityId → mode the OPERATOR holds (the RBAC its own tools honor). */
    capabilities: Record<string, string>;
  };
  /**
   * F31-3 — the INSTANCE resource catalog, names only. Every other field here
   * is project-scoped, so a goal citing a knowledge base that existed at the
   * org level but was granted to no deployed profile read as "does not exist"
   * in a live packet headline. These lists answer the EXISTENCE half: a name
   * here but under no `deployedSpecialists[].resources` means "exists, not
   * granted on this project" — the remedy is granting it from the project's
   * Agents surface, never re-creating it. Names only, bounded by the org
   * catalog's own size; optional so hand-built fixtures need not restate it
   * (`operatorSnapshot` always sets it).
   */
  orgResources?: { kbs: string[]; skills: string[]; mcps: string[] };
}

/** [1] Hard bound on `snapshot.recommendations`: the whole snapshot is
 *  JSON-embedded in the operator prompt, so neither list may grow with the
 *  task's age. Five is enough to stop a re-proposal loop — the operator only
 *  needs to recognise the card it is about to raise. */
const MAX_SNAPSHOT_RECOMMENDATIONS = 5;
/** Labels are model-authored prose; cap them so five entries stay small. */
const RECOMMENDATION_LABEL_CAP = 160;

function capRecommendationLabel(label: string): string {
  return label.length > RECOMMENDATION_LABEL_CAP
    ? label.slice(0, RECOMMENDATION_LABEL_CAP - 1) + "…"
    : label;
}

/** One refused recommendation, as the snapshot states it. */
interface DeclinedRecommendation {
  kind: string;
  label: string;
  /** When the human refused it (the audit row's `occurred_at`). */
  at: string;
}

/** `audit_events.occurred_at` is TEXT NOT NULL; `details_json` is nullable. */
const dismissalRowsSchema = z.array(
  z.object({ occurred_at: z.string(), details_json: z.string().nullable() }),
);

/** A dismissal's details. A row that cannot name WHAT was declined is worse
 *  than silent — it would tell the model "something was refused" with nothing
 *  to match on — so `label` is required and a junk `kind` degrades instead. */
const dismissalDetailsSchema = z.object({
  kind: z.string().catch("unknown"),
  label: z.string().min(1),
});

/**
 * [1] The recommendations a human already REFUSED on this task, newest first.
 *
 * Reads the audit rows `dismissRecommendation` writes — the structured
 * kind+label pair, rather than re-parsing the prose of the timeline event. This
 * also gives `task.recommendation.dismissed` its first reader anywhere in the
 * product. Bounded by the 90-day audit retention; the durable refusal record is
 * the timeline event (RECOMMENDATION_DECLINED_TITLE), not this list.
 */
function declinedRecommendations(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): DeclinedRecommendation[] {
  const rows = dismissalRowsSchema.parse(
    db
      .prepare(
        `SELECT occurred_at, details_json FROM audit_events
        WHERE project_slug = ? AND task_key = ? AND action = ?
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT ?`,
      )
      .all(
        projectSlug,
        taskKey,
        RECOMMENDATION_DISMISSED_AUDIT_ACTION,
        MAX_SNAPSHOT_RECOMMENDATIONS,
      ),
  );
  return rows.flatMap((row) => {
    if (!row.details_json) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(row.details_json);
    } catch {
      return [];
    }
    const details = dismissalDetailsSchema.safeParse(raw);
    if (!details.success) return [];
    return [
      {
        kind: details.data.kind,
        label: capRecommendationLabel(details.data.label),
        at: row.occurred_at,
      },
    ];
  });
}

/**
 * F21-16 — the sentence that stops the operator quoting its own policy at a
 * specialist. It ships INSIDE the payload (not only in the manual) because the
 * misread happened while the model was reading this exact object.
 *
 * Also carries the F21-14 acceptance exception: the same live operator that
 * misread the scope of this map also read `transition-to-done: human` off it and
 * posted "I can't accept completion myself", then accepted 60 seconds later.
 * `transition-to-done` is the RAW stage transition; acceptance is
 * `completion-for-acceptance`, and the two rows answer different questions.
 */
export const OPERATOR_POLICY_SCOPE_NOTE =
  "These capabilities are YOURS, the operator's, and nobody else's. They say NOTHING about what a " +
  "specialist agent may do: an agent's own grants are in `deployedSpecialists[].capabilities` " +
  "(delivery / verdict / askHuman / browser / web), resolved live from its profile. Never quote a " +
  "row from here as evidence about an agent; e.g. `use-web-search-fetch: off` here means YOUR web " +
  "egress is withheld, not that a specialist's web grant failed to take effect. " +
  "Acceptance: `completion-for-acceptance: direct` plus task autonomy `full` IS the sanctioned " +
  "route to Done. Call `accept_completion` and say so plainly. `transition-to-done: human` is the " +
  "RAW stage transition (`transition_stage` into the terminal stage), which stays human-only; it is " +
  "not a bar on the acceptance action, so never narrate that you cannot accept while you hold that grant.";

/**
 * F21-16 — does this deployed specialist actually hold web egress?
 *
 * Resolved from the deployment's own grants, with the same polarity the run path
 * uses (`deploymentGrants` + `effectiveCollabMode`): an EMPTY grant list is not
 * "no opinion" but a fully WITHHELD profile (P13-AP-06), so it must not fall
 * through to the catalog's granted-by-default egress.
 */
function specialistWebGranted(
  deployments: readonly { profileId: string; capabilities: CapabilityGrant[] }[],
  profileId: string,
): boolean {
  const deployment = deployments.find((d) => d.profileId === profileId);
  if (!deployment) return false;
  const grants =
    deployment.capabilities.length > 0
      ? deployment.capabilities
      : withheldAgentGrants();
  return effectiveCollabMode(grants, "use-web-search-fetch") === "direct";
}

/** `users.name` is TEXT NOT NULL; a missing row simply has no owner name. */
const userNameSchema = z.object({ name: z.string() });

/** `agent_runs.kind` and `state` are NOT NULL under CHECK constraints, and the
 *  query narrows `state` further to the two live values. */
const liveRunRowsSchema = z.array(
  z.object({
    kind: z.enum(["operator", "primary", "reviewer"]),
    agent_profile_id: z.string().nullable(),
    state: z.enum(["queued", "running"]),
  }),
);

/**
 * Ruling 302: how many timeline entries `get_task` returns by default, and the
 * most it will return when asked. The controller's own `get_task` has taken an
 * `events` count (1..50, default 12) for as long as it has existed; the
 * operator's took no arguments at all and returned six.
 */
export const OPERATOR_TIMELINE_DEFAULT = 6;
export const OPERATOR_TIMELINE_MAX = 50;

/** One row of {@link OperatorTaskSnapshot.recentTimeline} — the shape the
 *  snapshot builder writes and the operator reads. Named rather than inline so
 *  the builder and the contract cannot drift over what `clipped` means. */
export interface OperatorTimelineRow {
  /** Ruling 285: the ADDRESS `read_timeline_entry` takes. */
  occurredAt: string;
  type: string;
  actor: string;
  text: string;
  /** Ruling 285: present ONLY when the text was cut, naming the tool that
   *  returns it whole. */
  clipped?: string;
}

/**
 * Ruling 397: find a report a failed run left standing, if one is still the
 * open question on this task.
 *
 * The scan walks the timeline newest-first and stops at the first `agent`
 * event, which is Viberr recording that a run STARTED: once something has been
 * dispatched, the decision this fact exists to inform has already been made.
 * The pair is written milliseconds apart by one code path — the reply first,
 * the failure second — so they are adjacent among that agent's own events.
 */
function findUnfinishedReport(
  timeline: readonly TaskFileEvent[],
): OperatorTaskSnapshot["unfinishedReport"] {
  // WHO wrote an event, as one key. Every agent is `kind: "agent"`, so the
  // kind alone paired a failed run with any agent's comment: the reviewer's
  // verdict from the round before was handed over as the developer's report.
  const whoOf = (e: TaskFileEvent): string =>
    e.actor.kind === "agent"
      ? `agent:${e.actor.profileId}`
      : e.actor.kind === "human"
        ? `human:${e.actor.userId}`
        : e.actor.kind;
  for (let i = 0; i < timeline.length; i++) {
    const event = timeline[i]!;
    // Something was dispatched after the failure: the question is settled.
    if (event.type === "agent") return undefined;
    if (event.type !== "blocked") continue;
    if (!RUN_DID_NOT_COMPLETE_RE.test(event.text)) continue;
    if (event.actor.kind !== "agent") return undefined;
    const who = whoOf(event);
    const actor = event.actor.roleHint ?? event.actor.profileId;
    for (let j = i + 1; j < timeline.length; j++) {
      const older = timeline[j]!;
      // The run's own start: everything older belongs to an earlier run, so
      // this one posted no report.
      if (older.type === "agent") return undefined;
      if (whoOf(older) !== who) continue;
      // The same agent's own previous event. A comment is its report; anything
      // else means this run posted none and there is nothing to weigh.
      if (older.type !== "comment") return undefined;
      return { actor, failedAt: event.occurredAt, reportedAt: older.occurredAt };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Ruling 408: the newest refusal note with nothing done since.
 *
 * Same walk as {@link findUnfinishedReport} and the same stop rule: a
 * `transition` or an `agent` event means the operator got somewhere after the
 * refusal, so it has been answered and carrying it would be noise.
 */
function findUnansweredRefusal(
  timeline: readonly TaskFileEvent[],
): OperatorTaskSnapshot["unansweredRefusal"] {
  for (const event of timeline) {
    if (event.type === "transition" || event.type === "agent") return undefined;
    if (event.actor.kind !== "operator") continue;
    if (!PLAN_NOT_CARRIED_OUT_RE.test(event.text)) continue;
    return { at: event.occurredAt, text: event.text };
  }
  return undefined;
}

/** Ruling 415: how many of a task's human decisions the snapshot carries. */
const HUMAN_DECISIONS_MAX = 5;
/** Ruling 285: the window cuts an entry here for an operator that can read
 *  the rest with `read_timeline_entry`. */
const TIMELINE_ENTRY_CAP = 1500;
/** Ruling 415: an OLDER decision's words are cut here, at the timeline
 *  window's own per-entry cap; the newest is whole. */
const OLDER_DECISION_WORDS_CAP = TIMELINE_ENTRY_CAP;
/**
 * Ruling 440 (F39-67): the one cut for everything an operator that cannot
 * call tools (a Codex plan) is handed in place of an address. That covers a
 * window entry, a decision's words, an unfinished report, and the report that
 * woke it (`agentReportBlock`). Ruling 415 raised only the last of those to
 * this. So the same reviewer report read whole on the turn it woke, and cut
 * at 1,500 characters on any other turn, which "cannot fetch the rest".
 */
export const AGENT_REPORT_CAP_TOOLLESS = 16000;
/** Ruling 503: the snapshot carries the task's epic's description up to this;
 *  the epic's page has the rest. */
const EPIC_DESCRIPTION_CAP = 2000;
/**
 * Ruling 415 (F39-41): the decisions a person made on this task, newest
 * first, over the WHOLE timeline rather than the snapshot's window.
 *
 * A decision is the `transition` event `resolvePacket` writes under a human
 * actor, led by "**Decision:**"; the person's own words ride it as a
 * blockquote, the one shape both the custom directive and the note under a
 * listed option are written in.
 */
function findHumanDecisions(
  timeline: readonly TaskFileEvent[],
  toolless: boolean,
): OperatorTaskSnapshot["humanDecisions"] {
  const found: NonNullable<OperatorTaskSnapshot["humanDecisions"]> = [];
  for (const event of timeline) {
    if (found.length >= HUMAN_DECISIONS_MAX) break;
    if (event.type !== "transition" || event.actor.kind !== "human") continue;
    if (!event.text.startsWith(DECISION_LEAD)) continue;
    const [lead = "", ...rest] = event.text.split(/\n\n/);
    const quoted = rest
      .join("\n\n")
      .split("\n")
      .filter((line) => line.startsWith(">"))
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n")
      .trim();
    const entry: NonNullable<OperatorTaskSnapshot["humanDecisions"]>[number] = {
      at: event.occurredAt,
      by: event.actor.nameHint ?? "a person",
      decision: lead.slice(DECISION_LEAD.length).trim(),
    };
    if (quoted) {
      // The newest decision governs, so it is carried whole (it is bounded by
      // the directive field's own limit); older ones are context. Ruling 440:
      // context an operator cannot fetch is carried whole too.
      const cap = toolless
        ? AGENT_REPORT_CAP_TOOLLESS
        : found.length === 0
          ? PACKET_NOTE_MAX
          : OLDER_DECISION_WORDS_CAP;
      if (quoted.length > cap) {
        entry.words = `${quoted.slice(0, cap - 1)}…`;
        entry.clipped = toolless
          ? `cut at ${cap.toLocaleString("en-US")} chars; this turn cannot fetch the rest`
          : `cut at ${cap.toLocaleString("en-US")} chars; read_timeline_entry with this \`at\` returns it whole`;
      } else {
        entry.words = quoted;
      }
    }
    found.push(entry);
  }
  return found.length > 0 ? found : undefined;
}

/** Ruling 482: the snapshot's `gates` — the PR card's line plus what failed. */
function operatorGatesOf(
  declared: readonly ProjectGate[] | undefined,
  fm: TaskFrontmatter,
): OperatorTaskSnapshot["gates"] {
  const view = projectGatesView(declared, fm);
  if (!view) return null;
  return {
    line: view.line,
    state: view.state,
    failed: failedGateResults(view).map((r) => ({
      name: r.name,
      command: r.command,
      outcome: gateOutcomeText(r),
      log: r.log,
    })),
    error: view.error,
  };
}

/**
 * Ruling 494 (pass 40, F40-70): does the newest compare's count describe the
 * branch as it stands? Not when it was not read on the head Viberr's newest
 * push published (`pushedSince`, set by `createBaseCompareLookup`): a push
 * recorded after that compare, or one the compare right after it read another
 * head for, GitHub answering before it showed the push. Not when the compare
 * named no head either (`null`, unknown). The known head is the one Viberr's
 * own push published: `pr.headSha` lags a push until GitHub shows it on the
 * pull request (F39-64), a task with no live pull request has none, and a base
 * refresh moves the branch past `workRevision` (ruling 439).
 */
function comparedHeadCurrent(reading: BaseCompareReading): boolean | null {
  if (reading.pushedSince) return false;
  return reading.headSha === null ? null : true;
}

/** Ruling 494: the snapshot's `baseComparedHead` for a compare reading. */
function baseComparedHeadOf(
  reading: BaseCompareReading | null,
): OperatorTaskSnapshot["baseComparedHead"] {
  if (!reading) return null;
  return {
    sha: reading.headSha,
    observedAt: reading.observedAt,
    current: comparedHeadCurrent(reading),
    pushedSince: reading.pushedSince
      ? { sha: reading.pushedSince.headSha, at: reading.pushedSince.at }
      : null,
  };
}

/**
 * Ruling 494: the sentence the operator reads instead of a count it must not
 * repeat, or "" when the count describes the current head. It names both
 * heads, so "the head you just pushed" is checkable against what was counted.
 */
function baseBehindBySentence(
  reading: BaseCompareReading | null,
  where: { branch: string | null; base: string },
): string {
  if (!reading) return "";
  const current = comparedHeadCurrent(reading);
  if (current === true) return "";
  const branch = where.branch ? `\`${where.branch}\`` : "the branch";
  const count = `\`baseBehindBy\` (${reading.behindBy})`;
  const never =
    `Do not quote it, in a comment or a decision packet, as how far ${branch} is behind ` +
    `\`${where.base}\` now: a count describes only the head it was counted on.`;
  if (current === false) {
    const counted = reading.headSha
      ? `on \`${reading.headSha.slice(0, 7)}\``
      : "on a head the compare did not name";
    const pushed = reading.pushedSince?.headSha;
    if (reading.pushedSince?.afterCompare === false && pushed) {
      // The first compare after the push read another head than it published
      // (`pushNotCounted` sets this only with both heads named).
      return (
        `${count} was counted ${counted}, not on \`${pushed.slice(0, 7)}\`, which Viberr pushed to ` +
        `${branch} before that compare, so the count does not describe the pushed head. ${never} ` +
        `The next GitHub pass compares the branch again.`
      );
    }
    return (
      `${count} was counted ${counted}, and Viberr pushed ` +
      `${pushed ? `\`${pushed.slice(0, 7)}\` to ${branch}` : `to ${branch}`} after that compare, ` +
      `so the count describes the older head. ${never} The next GitHub pass compares the pushed head.`
    );
  }
  return (
    `The last compare did not record which head it read, so ${count} may describe an older head ` +
    `than ${branch} carries now. ${never} The next GitHub pass records the head it compares.`
  );
}

/** Read-only task snapshot for the operator's `get_task` tool. */
export function operatorSnapshot(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  authority: OperatorAuthority,
  events: number = OPERATOR_TIMELINE_DEFAULT,
  /**
   * Ruling 415: `toolless` is a Codex operator, which returns a plan and "cannot
   * call tools". Every note that names a tool (`get_task`, `read_timeline_entry`)
   * sent it somewhere it cannot go, so for it the snapshot carries the content
   * instead of the address, and says plainly when content is out of reach.
   */
  opts: { toolless?: boolean } = {},
): OperatorTaskSnapshot {
  const toolless = opts.toolless === true;
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) throw AppError.notFound(`Task ${taskKey} not found.`);
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!project) throw AppError.notFound(`Project ${projectSlug} not found.`);

  const fm = file.parsed.frontmatter;
  // F37-11: the reconciler's own last compare, read the same way the GitHub
  // page's sync pill reads it. Ruling 494: with the head it was counted on and
  // any push Viberr made after it.
  const baseCompare = createBaseCompareLookup(db)(
    storeRelativePath(resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), ctx.dataRoot),
  );
  // Ruling 302: the window, clamped the way the controller's own `events` is.
  const timelineWindow = Math.min(
    Math.max(Math.trunc(events), 1),
    OPERATOR_TIMELINE_MAX,
  );
  const orgCtx: { dataRoot?: string } = ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {};
  const stages = project.parsed.frontmatter.stages;
  const workflow = project.parsed.frontmatter.workflow;
  const roles = resolveStageRoles(stages, workflow);
  const doneStageId = roles.terminalId;

  const nextStages = workflow.flatMap((w) =>
    w.from === fm.stage
      ? [{ id: w.to, name: stageName(stages, w.to), boundary: w.boundary }]
      : [],
  );
  // R7-4: the rework license, listed rather than left to be inferred. Same
  // predicate `isReworkMove` vets on the way in (backward + validation
  // failing), so what this offers is exactly what transition_stage accepts.
  // Ruling 163 (pass 35, F35-13): a revision that CHANGED after a verdict is
  // rework by definition, so a task past the review stage with `validation:
  // changed` may go back to the review stage (and only there) for its
  // re-verdict; `failing` keeps the whole backward license.
  const currentStageIndex = stages.findIndex((s) => s.id === fm.stage);
  const changedTarget =
    fm.validation === "changed"
      ? verdictStageFor({ stages, workflow }, fm, listDeployedSpecialists(projectSlug, ctx))
      : null;
  // Ruling 702: a task with no delivering agent may also go back to a stage
  // where one can be engaged, and the entry says who, so the move and the
  // hand-off that follows it are one decision. `failing` already licenses
  // every earlier stage, so the names ride on those entries too.
  const engageAt = new Map(
    engageStagesFor({ stages, workflow }, fm, listDeployedSpecialists(projectSlug, ctx)).map(
      (e) => [e.stageId, e.agents],
    ),
  );
  const reworkStages = stages
    .slice(0, Math.max(currentStageIndex, 0))
    .filter((s) => fm.validation === "failing" || s.id === changedTarget || engageAt.has(s.id))
    .map((s) => {
      const engage = engageAt.get(s.id);
      return engage ? { id: s.id, name: s.name, engage } : { id: s.id, name: s.name };
    });

  const ownerName = fm.ownerUserId
    ? (userNameSchema.safeParse(
        db.prepare(`SELECT name FROM users WHERE id = ?`).get(fm.ownerUserId),
      ).data?.name ?? null)
    : null;

  const snapshot: OperatorTaskSnapshot = {
    key: fm.key,
    title: fm.title,
    goal: file.parsed.goal,
    // R26-1: surface the human triage metadata to the operator.
    priority: fm.priority,
    labels: fm.labels,
    dueDate: fm.dueDate,
    blockedBy: resolveDependencies(db, projectSlug, fm.blockedBy),
    stage: fm.stage,
    stageName: stageName(stages, fm.stage),
    previousStage: fm.previousStageId
      ? { id: fm.previousStageId, name: stageName(stages, fm.previousStageId) }
      : null,
    readiness: fm.readiness,
    waiting: fm.waiting,
    // F27-O5: the explicit derived review outcome, so review state does not have
    // to be reconstructed from the timeline window alone.
    validation: deriveValidation(fm),
    owner: ownerName,
    specialist: (() => {
      const delivering = deliveringEngagement(fm);
      return delivering
        ? {
            profileId: delivering.profileId,
            role: delivering.role,
            backend: delivering.backend,
          }
        : null;
    })(),
    reviewers: (() => {
      const cur = currentVerdicts(fm);
      const verdictOf = (
        profileId: string,
      ): "approve" | "request_changes" | null => {
        const r = cur.find((v) => v.profileId === profileId)?.result;
        return r === "approve" || r === "request_changes" ? r : null;
      };
      return supportingEngagements(fm).map((r) => ({
        profileId: r.profileId,
        role: r.role,
        backend: r.backend,
        verdict: verdictOf(r.profileId),
        // Ruling 193: how many successive DELIVERED REVISIONS this reviewer
        // has requested changes on. One is ordinary review. A run of them on
        // revisions that keep changing is the shape of an objection the work
        // cannot satisfy, and the operator could not see it: the snapshot
        // showed only the current revision's verdict, so every round looked
        // like the first.
        consecutiveRequestChanges: consecutiveRequestChanges(fm, r.profileId),
      }));
    })(),
    // Ruling 178: from the project file, resolved the way the gate prints it.
    requiredReviewers: resolveRequiredReviewers(project.parsed.frontmatter, ctx.dataRoot),
    // Ruling 482: the server's own gate record, in the PR card's words.
    gates: operatorGatesOf(project.parsed.frontmatter.gates, fm),
    nextStages,
    reworkStages,
    stageIds: stages.map((s) => s.id),
    doneStageId,
    reviewStageId: roles.reviewId,
    workStageId: roles.workId,
    deployedSpecialists: listDeployedSpecialists(projectSlug, ctx).map((s) => ({
      ...s,
      // Ruling 133: may this profile RUN here (declared, or the engaged
      // deliverer), not only "may it be newly engaged here".
      eligibleForCurrentStage: runEligibilityFor(
        s,
        file.parsed.frontmatter.engagements,
        s.id,
        file.parsed.frontmatter.stage,
        { stages, workflow },
      ).ok,
      engagedAsDeliverer: file.parsed.frontmatter.engagements.some(
        (e) => e.profileId === s.id && e.delivers,
      ),
      // F21-16: the specialist's own egress row, so the operator has somewhere
      // TRUE to look when it is asked whether an agent's web grant took effect.
      capabilities: {
        ...s.capabilities,
        web: specialistWebGranted(project.parsed.frontmatter.agents, s.id),
      },
    })),
    openPacket: !!file.parsed.packet,
    packet: file.parsed.packet
      ? {
          type: file.parsed.packet.type,
          title: file.parsed.packet.title,
          body: file.parsed.packet.body,
          options: file.parsed.packet.options.map((o) => o.t),
          awaiting: file.parsed.packet.awaiting ?? null,
          raisedBy: file.parsed.packet.from,
          yours: packetIsOperators(file.parsed.packet),
        }
      : null,
    timelineTotal: file.parsed.timeline.length,
    recentTimeline: file.parsed.timeline.slice(0, timelineWindow).map((e) => {
      // Timeline comments store the agent's FULL report (no 1,200-char cap
      // since 2026-07-17) — cap here so six entries can't balloon the prompt.
      //
      // Ruling 285 (F37-120): the cap stays and the ADDRESS ships with it. The
      // stamp is what `read_timeline_entry` takes, and a clipped entry says it
      // is clipped — an entry that ends mid-sentence with a "…" and no way to
      // ask for the rest is how a coordinator states half a report as the whole
      // of it, which it did, live, on SHOP-42.
      //
      // Ruling 440 (F39-67): an operator that cannot go to the address is
      // handed the content. Live on ax-clone AX-5 a restart re-invoked a Codex
      // operator without the reviewer report that had woken the interrupted
      // turn. It read that report here, cut partway into finding 3 of 4. It
      // opened a packet asking the owner to "confirm the full report", and
      // proposed a follow-up task that left out finding 4.
      const cap = toolless ? AGENT_REPORT_CAP_TOOLLESS : TIMELINE_ENTRY_CAP;
      const clipped = e.text.length > cap;
      const row: OperatorTimelineRow = {
        occurredAt: e.occurredAt,
        type: e.type,
        actor:
          e.actor.kind === "human"
            ? (e.actor.nameHint ?? "human")
            : e.actor.kind,
        text: clipped ? e.text.slice(0, cap - 3) + "…" : e.text,
      };
      if (clipped) {
        const at = `cut at ${cap.toLocaleString("en-US")} chars`;
        row.clipped = toolless
          ? `${at}; this turn cannot fetch the rest`
          : `${at}; read_timeline_entry with this occurredAt returns it whole`;
      }
      return row;
    }),
    // Ruling 503: the epic, when this task is in one, and the open epics it
    // could be put in.
    ...((): Pick<OperatorTaskSnapshot, "epic" | "openEpics"> => {
      const epics = listEpics(db, projectSlug);
      const out: Pick<OperatorTaskSnapshot, "epic" | "openEpics"> = {};
      const open = epics.filter((e) => isEpicOpen(e.status)).map((e) => ({ id: e.id, title: e.title }));
      if (open.length > 0) out.openEpics = open;
      const own = fm.epic ? epics.find((e) => e.id === fm.epic) : undefined;
      if (!own) return out;
      const cut = own.description.length > EPIC_DESCRIPTION_CAP;
      out.epic = {
        id: own.id,
        title: own.title,
        status: own.status,
        description: cut ? `${own.description.slice(0, EPIC_DESCRIPTION_CAP - 1)}…` : own.description,
        tasks: epicTaskRows(db, projectSlug, own.id)
          .filter((t) => !t.archived && t.key !== fm.key)
          .map((t) => ({
            key: t.key,
            title: t.title,
            stage: stageName(stages, t.stage),
            blockedBy: t.blockedBy,
          })),
      };
      if (cut) {
        out.epic.clipped = `cut at ${EPIC_DESCRIPTION_CAP.toLocaleString("en-US")} chars; the epic's page has it whole`;
      }
      return out;
    })(),
    // Ruling 397: scanned over the WHOLE timeline, not the window above — the
    // pair is adjacent, but the window can end between them.
    ...((): Pick<OperatorTaskSnapshot, "unfinishedReport"> => {
      const found = findUnfinishedReport(file.parsed.timeline);
      if (!found) return {};
      // Ruling 415: an operator that cannot call read_timeline_entry gets the
      // report itself. Ruling 440: bounded by the one cut such an operator
      // gets everywhere, and saying so when that cut lands.
      if (toolless) {
        // Ruling 644: the report is the comment at that stamp; the failure is
        // often written in the same millisecond.
        const report = file.parsed.timeline.find(
          (e) => e.occurredAt === found.reportedAt && e.type === "comment",
        );
        if (report) {
          const cut = report.text.length > AGENT_REPORT_CAP_TOOLLESS;
          found.text = cut
            ? `${report.text.slice(0, AGENT_REPORT_CAP_TOOLLESS - 1)}…`
            : report.text;
          if (cut) {
            found.clipped = `cut at ${AGENT_REPORT_CAP_TOOLLESS.toLocaleString("en-US")} chars; this turn cannot fetch the rest`;
          }
        }
      }
      return { unfinishedReport: found };
    })(),
    // Ruling 415: whole timeline, for ruling 408's reason — a person's decision
    // falls out of the window while it is still the one that governs.
    ...((): Pick<OperatorTaskSnapshot, "humanDecisions"> => {
      const found = findHumanDecisions(file.parsed.timeline, toolless);
      return found ? { humanDecisions: found } : {};
    })(),
    // Ruling 408: whole timeline for the same reason — the refusal can fall
    // out of the window while still being the open question.
    ...((): Pick<OperatorTaskSnapshot, "unansweredRefusal"> => {
      const found = findUnansweredRefusal(file.parsed.timeline);
      return found ? { unansweredRefusal: found } : {};
    })(),
    // Ruling 413: ruling 236's intersection, reused rather than re-derived.
    ...((): Pick<OperatorTaskSnapshot, "collisions"> => {
      const mine = fm.pr;
      if (!mine || mine.state !== "review" || !mine.paths?.changed.length) return {};
      const sides = listProjectTasks(db, projectSlug, { dataRoot: ctx.dataRoot }).flatMap((t) =>
        t.pr && t.pr.state === "review" && t.pr.paths?.changed.length
          ? [
              {
                taskKey: t.key,
                prNumber: t.pr.number,
                changed: t.pr.paths.changed,
                truncated: t.pr.paths.truncated,
              },
            ]
          : [],
      );
      const found = prPathOverlaps(
        {
          taskKey,
          prNumber: mine.number,
          changed: mine.paths.changed,
          truncated: mine.paths.truncated,
        },
        sides,
      );
      return found.length > 0 ? { collisions: found } : {};
    })(),
    ...((): Pick<OperatorTaskSnapshot, "fileLeases"> => {
      const leases = activeFileLeases(projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {});
      return leases.length > 0
        ? { fileLeases: leases.map((l) => ({ taskKey: l.taskKey, paths: [...l.paths], reason: l.reason })) }
        : {};
    })(),
    // [1] What this coordinator already proposed, and what a human already
    // refused — the two facts it needed to stop re-proposing a declined move.
    recommendations: {
      pending: fm.recommendations
        .slice(0, MAX_SNAPSHOT_RECOMMENDATIONS)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          label: capRecommendationLabel(r.label),
          profileId: r.profileId ?? null,
          toStageId: r.toStageId ?? null,
        })),
      declined: declinedRecommendations(db, projectSlug, taskKey),
    },
    // P13-D-4: expose the review PR. `state: "closed"` means a human closed it
    // on GitHub WITHOUT merging — an out-of-band rejection the operator must
    // not paper over by recommending or accepting completion.
    pr: fm.pr
      ? {
          number: fm.pr.number,
          state: fm.pr.state,
          title: fm.pr.title,
          // F21-17 / ruling 132: the drift record verbatim from the same field
          // the acceptance ceremony reads, and the same sentence it prints.
          revisionDrift:
            describeRevisionDrift(fm.pr.revisionDrift).kind !== "none"
              ? (fm.pr.revisionDrift ?? null)
              : null,
          revisionDriftSentence: describeRevisionDrift(fm.pr.revisionDrift).sentence,
          headSha: fm.pr.headSha ?? null,
          unpushedRevision: unpushedRevisionOf(
            fm.pr,
            activeWorkRevision(fm.workRevision)?.headSha ?? null,
          ),
          unpushedRevisionSentence:
            unpushedRevisionBlockedReason(
              fm.pr,
              activeWorkRevision(fm.workRevision)?.headSha ?? null,
              taskKey,
            ) ?? "",
          // Ruling 162: the fact the acceptance gate refuses on (settled PRs
          // carry none). Ruling 435: read as the gate reads it, pinned to the
          // head it was measured on (ruling 405). Raw, it said `conflicting`
          // for three minutes after the push that resolved AX-21's conflict,
          // and the operator told the reviewer to weigh it.
          mergeable:
            fm.pr.state === "review" || fm.pr.state === "accepted"
              ? liveMergeable(fm.pr)
              : null,
        }
      : null,
    // Ruling 162 (pass 35, F35-12): the acceptance gate's verdict, from the ONE
    // function every acceptance surface reads. KNC-6 and KNC-20 were
    // recommended for acceptance with `pr.mergeable: conflicting` already on
    // the file; the operator's snapshot simply did not carry the fact.
    notAcceptableReason: acceptanceRefusalFor({ projectSlug, taskKey }, ctx),
    // Ruling 521: whether an acceptance offer may go out yet, and what the
    // packet it needs must carry.
    completionPacket: completionPacketFact(fm, { projectSlug, taskKey, dataRoot: ctx.dataRoot }),
    // Ruling 693: what the task took, from its run rows and the file read
    // above. A read of what a task cost never fails the read of the task, so
    // a throw here leaves the key out.
    ...((): Pick<OperatorTaskSnapshot, "whatItTook"> => {
      try {
        return {
          whatItTook: taskTook({
            taskKey,
            rows: listRunsForTaskRows(db, projectSlug, taskKey),
            file: file.parsed,
            stages,
            terminalStageId: doneStageId,
          }),
        };
      } catch (error) {
        logger.warn("ruling 693 what-it-took read failed", {
          projectSlug,
          taskKey,
          err: toError(error),
        });
        return {};
      }
    })(),
    // The task branch, so recovery copy can NAME what an `archive_task`
    // option with `deleteBranch: true` would delete instead of gesturing at
    // "the branch".
    branch: fm.branch ?? null,
    // V19: the recorded branch-name collision, so the operator can author
    // `resolve_remote_collision` from a fact instead of timeline prose.
    unownedPr: fm.github?.unownedPr ?? null,
    // Ruling 161: what origin's branch holds when it is not this task's work.
    foreignHead: fm.github?.foreignHead ?? null,
    // F37-11 (pass 37): how the branch stands against the base, read from the
    // reconciler's own last compare — the same row the GitHub page's sync pill
    // renders. Without it the operator planned `update_branch_from_base` on
    // EVERY delivery and the server answered "already up to date" every time:
    // eight of the pass's nine "plan was not carried out in full" notes were
    // this one step. `null` means no pass has compared this task yet, which is
    // "unknown" and never an excuse to skip the call.
    baseBehindBy: baseCompare?.behindBy ?? null,
    // Ruling 494 (F40-70): which head that count describes. Live on WEB-16 the
    // count was read 7 s before the delivery pushed a head that carried `main`,
    // and two packets told the owner the branch was 6 behind for five minutes.
    baseComparedHead: baseComparedHeadOf(baseCompare),
    baseBehindBySentence: baseBehindBySentence(baseCompare, {
      branch: fm.branch ?? null,
      base: project.parsed.frontmatter.defaultBranch || "main",
    }),
    notRefreshableReason: acceptanceBoundaryRefusal(fm, taskKey, project.parsed.frontmatter),
    // R19-1: name the repository the read-only view reads.
    repo: project.parsed.frontmatter.repo ?? null,
    // R19-8: the "nothing to deliver" shape, stated outright.
    noChanges: noChangeApplies(fm),
    liveRuns: liveRunRowsSchema
      .parse(
        db
          .prepare(
            `SELECT kind, agent_profile_id, state FROM agent_runs
           WHERE project_slug = ? AND task_key = ?
             AND state IN ('queued', 'running')
           ORDER BY rowid`,
          )
          .all(projectSlug, taskKey),
      )
      .map((r) => ({
        kind: r.kind,
        profileId: r.agent_profile_id,
        state: r.state,
      })),
    // Ruling 487: what is already set to happen later, so a wait on a clock
    // is read before it is asked about or scheduled twice.
    schedules: fm.schedules
      .filter((s) => s.status === "pending")
      .map((s) => ({
        id: s.id,
        action: s.action,
        dueAt: s.dueAt,
        profileId: s.profileId ?? null,
        prompt: s.prompt,
        by: s.createdByLabel || s.createdBy,
        yours: s.createdBy === OPERATOR_SCHEDULER_ID,
      })),
    autonomy: authority.autonomy,
    operatorPolicy: {
      scope: "operator",
      note: OPERATOR_POLICY_SCOPE_NOTE,
      capabilities: Object.fromEntries(authority.policy),
    },
    // F31-3: instance catalog names, so "does not exist" claims are checkable.
    // Names-only readers (V12): the snapshot backs `get_task`, the operator's
    // most-called tool — the full view builders walk every KB/skill store
    // directory and read every SKILL.md body, all discarded for `.name`.
    orgResources: {
      kbs: listKnowledgeBaseNames(db, orgCtx),
      skills: listSkillNames(db, orgCtx),
      mcps: listMcpServerNames(db),
    },
  };
  if (snapshot.timelineTotal > snapshot.recentTimeline.length) {
    // Ruling 302: the same rule the per-ENTRY clip beside it already follows.
    // A window that does not say it is a window is how a coordinator states
    // part of a history as the whole of it.
    const older = snapshot.timelineTotal - snapshot.recentTimeline.length;
    const notShown = `${older} older ${older === 1 ? "entry is" : "entries are"} not shown, newest first. `;
    // Ruling 415: the address is only worth giving to an operator that can go
    // there. For one that cannot, say where the parts of that history that
    // still bind were carried instead.
    snapshot.timelineOlder = toolless
      ? notShown +
        "This turn cannot fetch them. What in them still binds you is carried in this snapshot: " +
        "`humanDecisions` (every decision a person made here, in their own words), `unansweredRefusal`, " +
        "`unfinishedReport` and `epic`."
      : notShown +
        `Call get_task with events up to ${OPERATOR_TIMELINE_MAX} to widen this window, ` +
        "and read_timeline_entry with an occurredAt for one in full.";
  }
  return snapshot;
}
