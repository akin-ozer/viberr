import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { AttachmentLightboxProvider } from "./attachment-lightbox";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { TaskSchedule } from "~/schemas/task-file.schema";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import type { AcceptanceAuthority } from "~/features/review/review-acceptance-authority.server";
import { AcceptConfirm, type AcceptCeremonyMode } from "./accept-confirm";
import { ArchiveConfirm } from "./archive-confirm";
import { ContinuityRecoveryPanel } from "./continuity-recovery";
import { DecisionPacket } from "./decision-packet";
import type {
  DeployedSpecialistView,
  OwnerAction,
  TaskMemberView,
} from "./execution-profile";
import { ReleaseConfirm } from "./release-confirm";
import {
  OperatorRecommendations,
  type RecommendationView,
} from "./operator-recommendations";
import { AttachmentsPanel } from "./attachments-panel";
import type { TaskAttachmentEntry } from "~/server/files/task-attachments.server";
import { Timeline, type TimelineFilterId } from "./timeline";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { AgentLogsPanel, LiveRunPanel } from "~/features/runtime/runs-panels";
import { useRunLogStream } from "~/features/runtime/use-run-log-stream";
import { PROJECT_ROLES, roleCan, type ProjectRole } from "~/shared/rbac";
import {
  acceptanceDisclosureFields,
  type AcceptanceDisclosure,
} from "~/shared/acceptance-disclosure";
import {
  useActionFeedback,
  useLogSelection,
  useRunControls,
  type ActionResult,
} from "./task-detail-hooks";
import {
  CurrentStatePanel,
  GithubTrace,
  PolicyPanel,
  TaskDetailsPanel,
} from "./task-side-panels";
import {
  DiagnosticsPanel,
  ExecutionSection,
  ScheduledActions,
  TaskHero,
} from "./task-main-sections";

/**
 * Task detail workspace — port of TaskDetail (task.jsx). Operator-first
 * layout order is a contract (spec §2): hero → live run strip → decision
 * packet → execution profile → agent logs → timeline; sidebar: GitHub
 * trace → current state → permissions. All mutations are route actions
 * (revalidation, no optimistic governed state); toast copy comes back from
 * the action (verbatim spec §5 strings).
 *
 * Pass 16 split this file (1811 lines) along that same contract — a pure
 * structural refactor, no behaviour or copy change. What stayed here is the
 * composition and the 13 fetchers; the pieces live in `task-detail-hooks.ts`,
 * `task-main-sections.tsx` and `task-side-panels.tsx`.
 */

/**
 * The acceptance ceremony's pending state (ruling 20 / R15-1). Every variant
 * ends in "task Done + a real GitHub merge", so every variant asks first; the
 * payload is whatever the confirmed click has to replay.
 */
type PendingAccept =
  | { mode: Extract<AcceptCeremonyMode, "accept" | "force" | "complete-merge"> }
  | { mode: "apply-recommendation"; recId: string; label: string }
  | { mode: "packet"; option: number; note: string; label: string }
  | { mode: "stage-move"; toStageId: string; label: string };

/**
 * F19-3 + F19-26 — does APPLYING this recommendation reach acceptance?
 *
 * Gate on the recommendation's TARGET, never on its `kind`. A supervised
 * operator can recommend a plain `transition` to the terminal stage; applying it
 * runs the identical full acceptance contract (transitionStage → acceptCompletion
 * → the real PR merge) under a label that says only "Move the task to Done".
 * A kind-only test would let that one through the ceremony it needs most.
 */
function recReachesAcceptance(
  rec: RecommendationView,
  terminalStageId: string | null,
): boolean {
  if (rec.kind === "accept_completion") return true;
  return (
    rec.kind === "transition" &&
    terminalStageId !== null &&
    rec.toStageId === terminalStageId
  );
}

export function TaskDetailPage({
  task,
  attachments = [],
  attachmentsTotal,
  attachmentProducers = {},
  attachmentsBase = null,
  runtime,
  deployedSpecialists,
  operatorBackend,
  operatorAutonomy,
  backendAvailable,
  deliveringActive,
  activeReviewerIds,
  runsVisible = true,
  timelineHasMore,
  timelineRemaining,
  timelineNextLimit,
  tlDefault,
  members,
  me,
  myRole,
  mentionables,
  recommendations,
  schedules,
  archived = false,
  acceptance,
  acceptanceAuthority = { operatorCanAccept: false, operatorName: "the operator" },
  githubHost,
  githubReconciledAt = null,
  githubCheckedAt = null,
  workRevisionSha = null,
  noChanges = false,
  defaultBranch = "main",
  canDeliver = false,
}: {
  /** Loader detail — `task.timeline` is the bounded newest-first slice. */
  task: TaskDetail;
  /** R19-19: browser-produced files (loader; `[]` for non-members — the same
   *  visibility bar as the run console). */
  attachments?: TaskAttachmentEntry[];
  /** Attachment name → who saved it and when (from the events that claim
   *  names). Names no event claims are absent — the panel omits the line. */
  attachmentProducers?: Record<string, { actor: string; occurredAt: string }>;
  /** C8 (pass 25): true total attachment count, so the panel can disclose the
   *  100-item list cap ("showing 100 of N") instead of hiding older evidence. */
  attachmentsTotal?: number;
  /** `/projects/<slug>/tasks/<KEY>/attachments` — the serving route's base,
   *  built by the route component (the one place that knows the params).
   *  Null hides the panel and the evidence links (e.g. bare test renders). */
  attachmentsBase?: string | null;
  /** Per-task run projection (Phase 8). */
  runtime: RunView[];
  /** Deployed specialists the assign menu offers (loader). */
  deployedSpecialists: DeployedSpecialistView[];
  /** The operator's configured backend — the run picker's default (P11-76). */
  operatorBackend: "claude" | "codex";
  /** R19-A: the project's configured operator autonomy (the run ceiling). */
  operatorAutonomy: "supervised" | "full";
  /** P11-41: which backends are configured, for the run picker. */
  backendAvailable: { claude: boolean; codex: boolean };
  /** A DELIVERING run is active — disables the delivering Run button (F10-04). */
  deliveringActive: boolean;
  /** Reviewer profile ids with an active run — disables only that reviewer. */
  activeReviewerIds: string[];
  /** UI-30: false → the viewer is not a project member, so `lines`/`raw`/`sid`
   *  were withheld by the loader and the console renders an honest gate notice
   *  instead of an empty panel. */
  runsVisible?: boolean;
  timelineHasMore: boolean;
  timelineRemaining: number;
  timelineNextLimit: number;
  tlDefault: TimelineFilterId;
  members: TaskMemberView[];
  me: { id: string; name: string };
  myRole: string | null;
  /** @-mention autocomplete directory for the comment composer (loader). */
  mentionables: Mentionables;
  /** Pending operator recommendation cards (loader — from the task file). */
  recommendations: RecommendationView[];
  /** Pending scheduled operator re-runs (O-3, loader — from the task file). */
  schedules: TaskSchedule[];
  /** R14-3: the task's archive disposition (loader — from the task file, which
   *  is where it lives; the projection has no column for it). */
  archived?: boolean;
  /** P14-LV-06: the viewer's acceptance authority + the exact refusal, resolved
   *  server-side by the predicate the review queue also counts with. */
  acceptance: AcceptanceAffordance;
  /** A6 (pass 23): whether THIS project's operator holds the one exception to
   *  the human-only Done boundary. The Permissions panel's boundary row reads it
   *  so it can never state the rule flatly on a full-autonomy project. Defaults
   *  to the strict boundary for bare test renders (the loader always supplies
   *  the real value). */
  acceptanceAuthority?: AcceptanceAuthority;
  /** GitHub web host for browse links — the loader's `githubWebHost()`. */
  githubHost: string;
  /** UI-57: newest `github.reconcile` for this task (freshness cue) — the last
   *  pass that CHANGED something, see the prop docs on `GithubTrace`. */
  githubReconciledAt?: string | null;
  /** F19-22: newest COMPLETED reconcile pass for this task (`github.reconcile.task`
   *  audit row). The panel needs both — one number could never say both "the
   *  poller is alive" and "nothing has moved since Tuesday". */
  githubCheckedAt?: string | null;
  /** R15-1: the delivered revision's head sha (task file) for the confirm. */
  workRevisionSha?: string | null;
  /** R17-2: a verified no-change completion (empty branch, no PR). */
  noChanges?: boolean;
  /** The merge target named in the accept confirm — the project's default branch. */
  defaultBranch?: string;
  /** R15-2 safety net (b): the viewer may deliver by hand (maintainer+ or owner). */
  canDeliver?: boolean;
}) {
  const stage = task.stages.find((s) => s.id === task.stage);
  const [releasing, setReleasing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [ask, setAsk] = useState(0);
  // C8: "Scheduled re-runs" now sits BELOW the Execution profile and its empty
  // form is collapsed behind a one-line disclosure on the common (no-schedule)
  // case — this opens it. A task that already has a schedule renders expanded.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const csrf = useCsrfToken();

  // G7: the page body is overflow:hidden and `.detail` is the actual scroll
  // container, so keyboard scrolling (Space / PageDown / arrows) is dead until
  // `.detail` holds focus. It's kept out of the tab order (tabIndex=-1) and
  // focused on mount so the workspace is keyboard-scrollable immediately.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    detailRef.current?.focus({ preventScroll: true });
  }, []);

  const ownerFetcher = useFetcher<ActionResult>();
  const resolveFetcher = useFetcher<ActionResult>();
  // R14-3: its own fetcher — an archive/restore must not be able to strand or be
  // stranded by an ownership submission sharing one fetcher (UI-56's lesson).
  const archiveFetcher = useFetcher<ActionResult>();
  useActionFeedback(ownerFetcher);
  useActionFeedback(resolveFetcher);
  useActionFeedback(archiveFetcher);
  const ownerBusy = ownerFetcher.state !== "idle";
  const resolveBusy = resolveFetcher.state !== "idle";
  const archiveBusy = archiveFetcher.state !== "idle";
  // A confirmed edit_goal packet decision drops the human straight into the
  // goal editor (TaskHero opens + focuses it on this signal).
  const [editGoalSignal, setEditGoalSignal] = useState(0);
  // F17-L3: the deliverable of the chosen scoping option, so the editor opens
  // prefilled with the scope the human just picked (not the old vague goal).
  const [editGoalDraft, setEditGoalDraft] = useState<string | null>(null);
  useEffect(() => {
    if (
      resolveFetcher.state === "idle" &&
      resolveFetcher.data?.ok &&
      resolveFetcher.data.kind === "edit_goal"
    ) {
      setEditGoalDraft(resolveFetcher.data.goalDraft ?? null);
      setEditGoalSignal((n) => n + 1);
    }
  }, [resolveFetcher.state, resolveFetcher.data]);

  // Agent affordances (assign/run specialist, reviewers, operator, apply
  // recommendation) are admin|maintainer (contracts §3.2); server re-checks
  // RBAC. The execution mutations live in ExecutionSection; applying a
  // recommendation is page-owned (F19-3 — an Apply can be an acceptance).
  // `myRole` arrives from the loader as a plain string; narrow it ONCE to the
  // project-role domain. A value outside the four roles holds no action — the
  // same answer `roleCan` already gives a non-member.
  const role: ProjectRole | null = PROJECT_ROLES.find((r) => r === myRole) ?? null;
  const canRunAgents = roleCan(role, "run-agents");
  const canOwn = roleCan(role, "own-task");
  // E3: ask for the action the SERVER enforces, not a neighbouring one.
  // `updateTaskGoal` requires `update-goal`; this read `run-agents`, which
  // agrees today only because the matrix happens to line up — a role change to
  // either row silently desyncs the button from the endpoint behind it.
  const canEditGoal = roleCan(role, "update-goal");
  const canEditMeta = roleCan(role, "edit-task-meta");
  // The viewer may resolve THIS packet when they're admin|maintainer OR the
  // task owner (M2 / owner ruling Q2, WIDENED by R14-2). The owner bypass
  // requires `own-task` (contributor+): the server's owner check does too, so a
  // demoted viewer-owner must NOT be shown resolve options that would 403
  // (matches releaseOwner's own-task gate).
  const isOwner =
    task.owner?.kind === "human" && task.owner.userId === me.id && canOwn;
  const canResolvePacket = canRunAgents || isOwner;
  // P14-GV-01/R14-2: acceptance carries the owner exception (R6-2) on the
  // server, and since R14-2 so do apply/dismiss — the owner governs EVERY
  // decision on their own task. This flag used to be `canRunAgents` alone, so a
  // contributor-owner was counted "waiting on you" by the decisions inbox and
  // then shown a blocked Accept option and disabled recommendation buttons.
  const canDecideOwned = canRunAgents || isOwner;
  // An `archive_task` packet option runs the R14-3 archive, whose authority is
  // the board-management tier (`approve-transition`) — NOT the packet-resolver
  // set. A contributor-owner may resolve the packet but not this option, so the
  // card blocks it with the reason instead of 403ing on click (same treatment
  // as edit_goal / accept_completion).
  const canArchiveViaPacket = roleCan(role, "approve-transition");

  // F7-UI1: "operator active" reflects a LIVE operator run (queued/running),
  // never mere attachment. The runtime projection already carries kind+state.
  const operatorRunActive = runtime.some(
    (r) =>
      r.kind === "operator" &&
      (r.lifecycle === "running" || r.lifecycle === "queued"),
  );
  // Any live run (operator, specialist, or reviewer) drives the working pill.
  // `waiting` also covers the short window before a runtime row exists.
  const anyRunLive =
    task.waiting === "agent" ||
    runtime.some(
      (r) => r.lifecycle === "running" || r.lifecycle === "queued",
    );
  // Terminal-stage OR archived task — closed for new work (comments stay open,
  // R7-6). F15-11: archived tasks used to keep every live control.
  const taskClosed =
    task.displayReadiness === "accepted" ||
    task.displayReadiness === "merged" ||
    archived;

  // F15-10/R15-1: accepting merges the PR — it fires only through the confirm
  // dialog (which states PR, revision, merge head, verdict state and target
  // branch). Pass 19 (ruling 20 / the acceptance-writer matrix): the dialog now
  // covers EVERY writer that ends in "Done + real merge", not just the two
  // buttons that already had it. The pending state carries what the confirmed
  // action has to replay — a recommendation id, a packet option + its note, or
  // the stage the human picked out of the Current-state menu (F19-37).
  const [confirmAccept, setConfirmAccept] = useState<PendingAccept | null>(null);
  // D6: two consequential single-click actions gained a confirm — interrupting a
  // live run (discards its in-flight, uncommitted work) and dismissing an
  // operator recommendation (withdraws a governed, audited decision). Both were
  // one silent click while a reversible archive took a three-row ceremony.
  const [confirmInterrupt, setConfirmInterrupt] = useState<string | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState<
    { recId: string; label: string } | null
  >(null);
  const acceptFetcher = useFetcher<ActionResult>();
  useActionFeedback(acceptFetcher);
  const acceptBusy = acceptFetcher.state !== "idle";
  // Ruling 88 (F21-2): the acceptance intents carry the ceremony's own echo of
  // what it displayed. The server refuses this POST without it — that refusal
  // is the invariant; this is just the honest client half of it.
  const submitAccept = (disclosure: AcceptanceDisclosure) => {
    if (acceptBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "accept-completion");
    for (const [field, value] of Object.entries(
      acceptanceDisclosureFields(disclosure),
    )) {
      fd.set(field, value);
    }
    acceptFetcher.submit(fd, { method: "post" });
  };

  // R15-2 safety net (b): manual delivery from the GitHub panel.
  const deliverFetcher = useFetcher<ActionResult>();
  useActionFeedback(deliverFetcher);
  const deliverBusy = deliverFetcher.state !== "idle";
  const onDeliver = () => {
    if (deliverBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "deliver-review");
    deliverFetcher.submit(fd, { method: "post" });
  };

  // Dedicated run-log SSE consumer (own EventSource; NOT useLiveUpdates —
  // phase-6 report). Seeds from the loader's runtime[].lines + raw; tails
  // live lines via run.log-appended; revalidates on run.state-changed.
  const { linesByThread, streamError, olderByThread, loadOlder } = useRunLogStream({
    projectSlug: task.projectSlug,
    taskKey: task.key,
    threads: runtime.map((r) => ({
      threadId: r.id,
      runId: r.serverRunId,
      lines: r.lines.map((display, i) => ({ display, raw: r.raw[i] ?? "" })),
      // P13-D-11: the loader ships a BOUNDED window of each agent group's
      // console (NFR5). The window carries the live-tail seed (`headSeq`) and
      // the backward cursor the console pages the rest of the history with.
      window: r.logWindow,
    })),
    // F22: bounds a stale "running" strip if a finalize event is missed.
    hasActiveRun: runtime.some((r) => r.state === "running"),
    // UI-30: a non-member's tail requests 403 — don't open a stream that can
    // only fail (it used to 403 silently on every appended line).
    enabled: runsVisible,
  });

  const {
    runBusy,
    canInterrupt,
    onInterrupt,
    onRetryBackend,
    onCompleteMerge,
    onForceAccept,
  } = useRunControls({
    csrf,
    runtime,
    myRole,
    canRunAgents,
    // F19-10: the merge control follows the SERVER's acceptance authority
    // (role OR this task's own owner), not a role-only copy of it.
    acceptanceHasAuthority: acceptance.hasAuthority,
    acceptanceTerminallyBlocked: acceptance.terminallyBlocked,
  });
  const { shownLogSel, selectLog, onViewLogs, onAgentLog } =
    useLogSelection(runtime);

  const onOwner = (action: OwnerAction, member?: TaskMemberView) => {
    if (ownerBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    if (action === "assign" && member) {
      fd.set("intent", "owner-assign");
      fd.set("userId", member.userId);
    } else if (action === "release") {
      fd.set("intent", "owner-release");
    } else {
      fd.set("intent", "owner-take");
    }
    ownerFetcher.submit(fd, { method: "post" });
  };

  // R14-3: archiving asks first (it withdraws the open decision); restoring is
  // additive and reversible, so it submits straight away.
  const submitArchive = (nextArchived: boolean) => {
    if (archiveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", nextArchived ? "archive-task" : "restore-task");
    archiveFetcher.submit(fd, { method: "post" });
  };

  const submitResolve = (
    optionIndex: number,
    note: string,
    // Ruling 88: set ONLY for the `accept_completion` option, the one kind that
    // writes Done and merges — the server gates that arm on the echo and leaves
    // every other decision ack-free.
    disclosure?: AcceptanceDisclosure,
  ) => {
    if (resolveBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "resolve-packet");
    fd.set("option", String(optionIndex));
    if (note.trim()) fd.set("note", note);
    if (disclosure) {
      for (const [field, value] of Object.entries(
        acceptanceDisclosureFields(disclosure),
      )) {
        fd.set(field, value);
      }
    }
    resolveFetcher.submit(fd, { method: "post" });
  };
  // Questionnaire packets (owner request 2026-08-20): resolve with the human's
  // OWN directive. No option index — the server runs the synthetic `custom`
  // arm, which never accepts/archives/merges, so no ceremony interposes.
  const submitResolveCustom = (custom: string) => {
    if (resolveBusy || !custom.trim()) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "resolve-packet");
    fd.set("option", "-1");
    fd.set("custom", custom.trim());
    resolveFetcher.submit(fd, { method: "post" });
  };
  // F19-7: an `accept_completion` packet option runs the full acceptance
  // contract — including the real, irreversible PR merge — from a button
  // labelled "Confirm decision", whose only disclosure is whatever freeform
  // title the operator happened to type. The radiogroup is a selection, not a
  // confirmation of a merge: route it through the one ceremony, which names the
  // PR, the merge head, the verdict and the target branch. Every other option
  // kind keeps its one-click resolve — none of them writes to GitHub.
  const onResolve = (optionIndex: number, note = "") => {
    if (resolveBusy) return;
    const option = task.packet?.options[optionIndex];
    if (option?.kind === "accept_completion") {
      setConfirmAccept({
        mode: "packet",
        option: optionIndex,
        note,
        label: option.t,
      });
      return;
    }
    submitResolve(optionIndex, note);
  };

  // F20-18: a contributor-OWNER may open the packet (owner exception) but every
  // option re-checks a higher tier — hand the decision UP to a maintainer/admin
  // instead of stranding them. The server (requestPacketMaintainerDecision)
  // refuses when the caller already holds `resolve-packet`, so this is wired
  // only for the owner-who-cannot-resolve-directly case.
  const escalateFetcher = useFetcher<ActionResult>();
  useActionFeedback(escalateFetcher);
  const escalateBusy = escalateFetcher.state !== "idle";
  const canEscalatePacket = isOwner && !canRunAgents;
  const onRequestMaintainer = () => {
    if (escalateBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "request-maintainer-decision");
    escalateFetcher.submit(fd, { method: "post" });
  };

  // Apply / dismiss an operator recommendation (apply is admin|maintainer; the
  // server re-checks). Lifted onto the page — with F19-3 an Apply can BE an
  // acceptance, so the click has to reach the page's confirm state rather than
  // submit from inside the card.
  const recFetcher = useFetcher<ActionResult>();
  useActionFeedback(recFetcher);
  const recBusy = recFetcher.state !== "idle";
  const terminalStageId =
    task.stages.length > 0 ? task.stages[task.stages.length - 1]!.id : null;
  const submitApplyRec = (
    recId: string,
    // Ruling 88: set ONLY when the card REACHES acceptance
    // (`recReachesAcceptance` — kind or terminal target), which is the same
    // predicate the server consults its own copy of before demanding the echo.
    disclosure?: AcceptanceDisclosure,
  ) => {
    if (recBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "apply-recommendation");
    fd.set("recId", recId);
    if (disclosure) {
      for (const [field, value] of Object.entries(
        acceptanceDisclosureFields(disclosure),
      )) {
        fd.set(field, value);
      }
    }
    recFetcher.submit(fd, { method: "post" });
  };
  // F19-3 (live-proven: one Apply click merged an unreviewed head into main).
  // The confirmed action still posts `apply-recommendation`, NOT
  // `accept-completion` — that keeps the recommendation-applied audit row, the
  // R15-3/R14-2 owner-authority seam and the card-clearing on the server.
  const onApplyRec = (recId: string) => {
    if (recBusy) return;
    const rec = recommendations.find((r) => r.id === recId);
    if (rec && recReachesAcceptance(rec, terminalStageId)) {
      setConfirmAccept({ mode: "apply-recommendation", recId, label: rec.label });
      return;
    }
    submitApplyRec(recId);
  };
  const submitDismissRec = (recId: string) => {
    if (recBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "dismiss-recommendation");
    fd.set("recId", recId);
    recFetcher.submit(fd, { method: "post" });
  };
  // D6: dismissing withdraws a pending operator recommendation — confirm it,
  // naming the recommendation. (Apply already routes through the accept confirm
  // when it reaches acceptance; the harmless dismiss had no gate at all.)
  const onDismissRec = (recId: string) => {
    if (recBusy) return;
    const rec = recommendations.find((r) => r.id === recId);
    setConfirmDismiss({ recId, label: rec?.label ?? "this recommendation" });
  };

  // Manual stage change from the Current-state menu. Page-owned since F19-37 —
  // see below.
  const transitionFetcher = useFetcher<ActionResult>();
  useActionFeedback(transitionFetcher);
  const transitionBusy = transitionFetcher.state !== "idle";
  const submitTransition = (
    toStageId: string,
    // Ruling 88: set ONLY for the stage-move-into-Done case, which the server
    // reads as an acceptance and gates on the disclosure like any other accept.
    disclosure?: AcceptanceDisclosure,
  ) => {
    if (transitionBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "transition");
    fd.set("to", toStageId);
    if (disclosure) {
      for (const [field, value] of Object.entries(
        acceptanceDisclosureFields(disclosure),
      )) {
        fd.set(field, value);
      }
    }
    transitionFetcher.submit(fd, { method: "post" });
  };
  // F19-37 — the SIXTH acceptance writer. The server treats a human move into
  // the LAST stage as an acceptance: transitionStage's own comment reads "A
  // HUMAN manually moving a task INTO the final stage IS accepting completion",
  // and it calls acceptCompletion — the real, irreversible PR merge. The board's
  // identical stage menu has confirmed since ruling 53/R18-7; this one was the
  // last surface where dropping a card on Done merged silently. Same ceremony,
  // and the confirmed click still posts `transition` (the server's own
  // stage-move contract writes the acceptance from there).
  const onTransition = (toStageId: string) => {
    if (transitionBusy) return;
    if (toStageId === terminalStageId && task.stage !== terminalStageId) {
      setConfirmAccept({
        mode: "stage-move",
        toStageId,
        label: `${stage?.name ?? task.stage} → ${
          task.stages[task.stages.length - 1]?.name ?? toStageId
        }`,
      });
      return;
    }
    submitTransition(toStageId);
  };

  return (
    // Image evidence anywhere on this page — timeline thumbnails, inline
    // markdown embeds, the Attachments panel, cited evidence filenames —
    // opens in the in-app lightbox this provider renders (owner request
    // 2026-08-21) instead of a raw-file tab.
    <AttachmentLightboxProvider>
    <div
      className="detail"
      ref={detailRef}
      tabIndex={-1}
      data-screen-label={"Task " + task.key}
    >
      {/* U7 (D2's other half): the side column is FIRST in the DOM.
          UX spec §Breakpoint Strategy asks for a reading order — "the task
          detail's side-by-side regions stack, preserving reading order: current
          state, latest packet, next action, then the timeline" — and reading
          order is source order, which is what a screen reader announces and
          what Tab walks. Pass 20 fixed only the paint (`order: -1` at 1100px)
          and recorded the departure in a CSS comment that cited this very
          sentence; below that width a sighted keyboard user then SAW "Accept
          completion → Done" at the top and reached it LAST, after every
          timeline entry (WCAG 2.2 SC 1.3.2 / 2.4.3). The desktop layout is
          unchanged: `.detail` is a grid and both columns name their cell in
          app.css, so main still paints left of side at any source order. */}
      <div className="detail-side">
        <GithubTrace
          task={task}
          githubHost={githubHost}
          acceptance={acceptance}
          reconciledAt={githubReconciledAt}
          checkedAt={githubCheckedAt}
          {...(onCompleteMerge
            ? { onCompleteMerge: () => setConfirmAccept({ mode: "complete-merge" }) }
            : {})}
          {...(onForceAccept
            ? { onForceAccept: () => setConfirmAccept({ mode: "force" }) }
            : {})}
          {...(canDeliver && !taskClosed ? { onDeliver } : {})}
          delivering={deliverBusy}
          merging={runBusy}
        />
        <CurrentStatePanel
          task={task}
          stage={stage}
          meId={me.id}
          myRole={myRole}
          archived={archived}
          acceptance={acceptance}
          ownerBusy={ownerBusy}
          onOwner={onOwner}
          onRelease={() => setReleasing(true)}
          onArchive={() => (archived ? submitArchive(false) : setArchiving(true))}
          onAccept={() => setConfirmAccept({ mode: "accept" })}
          onTransition={onTransition}
          transitionBusy={transitionBusy}
          acceptBusy={acceptBusy}
          dispositionBusy={archiveBusy}
        />
        <TaskDetailsPanel task={task} canEdit={canEditMeta} />
        <PolicyPanel
          projectSlug={task.projectSlug}
          myRole={myRole}
          stages={task.stages}
          ownsTask={isOwner}
          acceptanceAuthority={acceptanceAuthority}
        />
      </div>

      <div className="detail-main">
        <TaskHero
          task={task}
          stage={stage}
          canEditGoal={canEditGoal}
          archived={archived}
          agentWorking={anyRunLive}
          editGoalSignal={editGoalSignal}
          editGoalDraft={editGoalDraft}
        />

        {runtime.length > 0 ? (
          <LiveRunPanel
            runtime={runtime}
            onViewLogs={onViewLogs}
            // D6: the button opens a confirm instead of interrupting on the click.
            onInterrupt={(id) => setConfirmInterrupt(id)}
            canInterrupt={canInterrupt}
            interrupting={runBusy}
          />
        ) : null}

        <DiagnosticsPanel diagnostics={task.diagnostics} />

        {/* D18 — above the packet, not below it. The Operator Desk order canon
            names is "current state, execution truth, latest packet, steering
            actions above timeline depth": degraded continuity is execution
            TRUTH, so it sits with Diagnostics, ahead of the decision it may
            well explain. It renders itself away when there is nothing to
            report. */}
        <ContinuityRecoveryPanel
          timeline={task.timeline}
          runtime={runtime}
          runsVisible={runsVisible}
          canRunAgents={canRunAgents}
          {...(runsVisible ? { onOpenConsole: onViewLogs } : {})}
          onAsk={() => setAsk((a) => a + 1)}
        />

        {task.packet && (
          <DecisionPacket
            packet={task.packet}
            busy={resolveBusy}
            canResolve={canResolvePacket}
            canResolveCompletion={canDecideOwned}
            // UI-42: an owner-only resolver must not be offered a decision they
            // cannot then carry out — so this asks for `update-goal`, the grant
            // `updateTaskGoal` itself enforces (E3).
            canEditGoal={canEditGoal}
            canArchive={canArchiveViaPacket}
            // F20-6: discard_branch re-checks the same `approve-transition` tier
            // the archive-with-branch-deletion needs (it destroys commits).
            canDiscardBranch={canArchiveViaPacket}
          // UX19-9: what an `archive_task` resolution destroys — the branch its
          // `deleteBranch` variant deletes permanently, and the recommendations
          // the archive withdraws. The same two facts ArchiveConfirm is handed.
          archiveDisclosure={{
            taskKey: task.key,
            branch: task.branch,
            pendingRecommendations: recommendations.length,
          }}
            onResolve={onResolve}
            onResolveCustom={submitResolveCustom}
            // F20-18: only the contributor-owner-who-cannot-resolve-directly
            // gets the escalation affordance (the card shows it only when EVERY
            // option is above their tier).
            {...(canEscalatePacket ? { onRequestMaintainer } : {})}
            onAsk={() => setAsk((a) => a + 1)}
          />
        )}

        <OperatorRecommendations
          recommendations={recommendations}
          canApply={canDecideOwned}
          busy={recBusy}
          onApply={onApplyRec}
          onDismiss={onDismissRec}
        />

        <ExecutionSection
          task={task}
          meId={me.id}
          myRole={myRole}
          ownerBusy={ownerBusy}
          onOwner={onOwner}
          deployedSpecialists={deployedSpecialists}
          operatorBackend={operatorBackend}
          operatorAutonomy={operatorAutonomy}
          backendAvailable={backendAvailable}
          canRunAgents={canRunAgents}
          deliveringActive={deliveringActive}
          activeReviewerIds={activeReviewerIds}
          operatorRunActive={operatorRunActive}
        />

        {/* C8: Scheduled re-runs used to sit directly under the goal, showing a
            four-control form for nothing on the common case and pushing the
            Execution profile (Run operator, delivering agent, reviewers, owner)
            below the fold. It sits below Execution profile now, and its empty
            form is collapsed behind a one-line disclosure — expanded only when a
            schedule already exists (there is something to show) or the viewer
            asks to add one. */}
        {schedules.length > 0 || scheduleOpen ? (
          <ScheduledActions
            schedules={schedules}
            canRunAgents={canRunAgents}
            taskClosed={taskClosed}
          />
        ) : canRunAgents && !taskClosed ? (
          <button
            type="button"
            className="btn ghost sm panel-act"
            onClick={() => setScheduleOpen(true)}
          >
            <Icon name="clock" />
            Schedule a re-run
          </button>
        ) : null}

        {runtime.length > 0 && runsVisible ? (
          <AgentLogsPanel
            runtime={runtime}
            sel={shownLogSel}
            onSel={selectLog}
            linesByThread={linesByThread}
            {...(onRetryBackend ? { onRetryBackend } : {})}
            retrying={runBusy}
            streamError={streamError}
            olderByThread={olderByThread}
            onLoadOlder={loadOlder}
          />
        ) : null}
        {/* UI-30: raw console output, the `{ } raw` wire envelopes and the
            provider session id are project-member material (the two routes that
            serve the same data require membership). Say so rather than render an
            empty console or, as before, hand them to any signed-in user. */}
        {runtime.length > 0 && !runsVisible ? (
          <section className="panel" data-comment-anchor="agent-logs">
            <div className="panel-head">
              <Icon name="cpu" />
              <h2>Agent logs</h2>
            </div>
            <p className="empty sm">
              Raw agent output, wire envelopes and provider session ids are
              limited to project members. The run summary above is public to
              signed-in users.
            </p>
          </section>
        ) : null}

        {attachmentsBase ? (
          <AttachmentsPanel
            base={attachmentsBase}
            attachments={attachments}
            {...(attachmentsTotal !== undefined ? { total: attachmentsTotal } : {})}
            producers={attachmentProducers}
            // D8: show an empty state (not nothing) when a browser-capable agent
            // is deployed — its runs are what fill this panel.
            browserExpected={deployedSpecialists.some(
              (s) => s.capabilities?.browser,
            )}
          />
        ) : null}

        <Timeline
          events={task.timeline}
          hasMore={timelineHasMore}
          remaining={timelineRemaining}
          nextLimit={timelineNextLimit}
          tlDefault={tlDefault}
          ask={ask}
          mentionables={mentionables}
          onAgentLog={onAgentLog}
          taskClosed={taskClosed}
          {...(attachmentsBase
            ? {
                attachmentNames: attachments.map((a) => a.name),
                attachmentsBase,
              }
            : {})}
        />
      </div>

      {confirmAccept && (
        <AcceptConfirm
          task={task}
          workRevisionSha={workRevisionSha}
          noChanges={noChanges}
          // F20-6 (R20-2): no PR + the completion never claimed no-change → the
          // accept path auto-detects it by re-probing the branch. The dialog
          // states that instead of promising a merge. `noChanges` (the flagged
          // shape) still takes precedence when the completion DID claim it.
          noPullRequest={!task.pr && !noChanges}
          defaultBranch={defaultBranch}
          // R19-5: a force-accept from before the boundary MAY skip the
          // remaining stages and the review gate — the dialog has to name which.
          atBoundary={acceptance.atBoundary}
          // R19-B: the human GitHub approval carrying the verdict gate, rendered
          // on the verdict row (null when an agent verdict cleared it).
          verdictSatisfiedBy={acceptance.verdictSatisfiedBy ?? null}
          ceremony={
            "label" in confirmAccept
              ? { mode: confirmAccept.mode, label: confirmAccept.label }
              : { mode: confirmAccept.mode }
          }
          blockedReason={
            confirmAccept.mode === "force"
              ? (task.blockReason ??
                acceptance.blockedReason ??
                (task.packet?.type === "blocked"
                  ? "An open blocked decision is holding this task."
                  : null))
              : // The merge is the SECOND half of an acceptance that already
                // happened (R16-6), so the acceptance gate has nothing left to
                // say about it — quoting a stale refusal here would read as a
                // block on a merge nothing is blocking.
                confirmAccept.mode === "complete-merge"
                ? null
                : // F19-7 (B's correctness win): a packet resolution evaluates
                  // the acceptance contract with `blockedPacket: false` — the
                  // open packet is what this resolution CLEARS, so it cannot
                  // also be the reason to refuse it. Name the refusal the PACKET
                  // path would hit, never the open-packet one.
                  confirmAccept.mode === "packet"
                  ? acceptance.blockedReasonViaPacket
                  : acceptance.blockedReason
          }
          busy={acceptBusy || runBusy || recBusy || resolveBusy || transitionBusy}
          onCancel={() => setConfirmAccept(null)}
          onConfirm={(disclosure) => {
            const pending = confirmAccept;
            setConfirmAccept(null);
            // Ruling 88: EVERY acceptance intent carries this dialog's own echo
            // of what it displayed. `apply-recommendation` and `resolve-packet`
            // included: their server-side pins (the recommendation id, the
            // packet identity) prove WHICH decision is being settled, never that
            // the human saw what merges — so they are held to the ceremony on
            // the same terms as the direct Accept. `complete-merge` is the one
            // exception: the acceptance already happened (R16-6) and its own
            // path re-verifies the PR head, so there is no acceptance state left
            // to echo.
            if (pending.mode === "force") onForceAccept?.(disclosure);
            else if (pending.mode === "complete-merge") onCompleteMerge?.();
            else if (pending.mode === "apply-recommendation")
              submitApplyRec(pending.recId, disclosure);
            else if (pending.mode === "packet")
              submitResolve(pending.option, pending.note, disclosure);
            else if (pending.mode === "stage-move")
              submitTransition(pending.toStageId, disclosure);
            else submitAccept(disclosure);
          }}
        />
      )}

      {archiving && (
        <ArchiveConfirm
          task={task}
          pendingRecommendations={recommendations.length}
          busy={archiveBusy}
          onCancel={() => setArchiving(false)}
          onConfirm={() => {
            setArchiving(false);
            submitArchive(true);
          }}
        />
      )}

      {releasing && (
        <ReleaseConfirm
          task={task}
          me={me}
          members={members}
          busy={ownerBusy}
          onCancel={() => setReleasing(false)}
          onConfirm={() => {
            setReleasing(false);
            onOwner("release");
          }}
          onOwner={onOwner}
        />
      )}

      {/* D6: interrupt a live run — discards uncommitted in-flight work. */}
      {confirmInterrupt && (
        <ConfirmDialog
          title="Interrupt this run?"
          body="The agent stops where it is. Anything it has not already committed or delivered is lost. You can start a new run afterward."
          confirmLabel="Interrupt run"
          busy={runBusy}
          onCancel={() => setConfirmInterrupt(null)}
          onConfirm={() => {
            onInterrupt(confirmInterrupt);
            setConfirmInterrupt(null);
          }}
        />
      )}

      {/* D6: dismiss an operator recommendation — a governed, audited decision. */}
      {confirmDismiss && (
        <ConfirmDialog
          title="Dismiss this recommendation?"
          body={
            <>
              <strong>{confirmDismiss.label}</strong> is withdrawn without acting
              on it. The dismissal is recorded on the timeline; the operator may
              raise it again on its next run.
            </>
          }
          confirmLabel="Dismiss recommendation"
          busy={recBusy}
          onCancel={() => setConfirmDismiss(null)}
          onConfirm={() => {
            submitDismissRec(confirmDismiss.recId);
            setConfirmDismiss(null);
          }}
        />
      )}
    </div>
    </AttachmentLightboxProvider>
  );
}
