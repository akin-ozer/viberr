import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useFetcher } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import {
  decisionPacketId,
  TASK_DECISION_ANCHOR,
  TASK_RECOMMENDATIONS_ANCHOR,
  TASK_TIMELINE_ANCHOR,
} from "~/shared/page-anchors";
import { setDisclosure, type AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import { stageName } from "~/shared/workflow/stage-roles";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { inFlightIntent } from "~/ui/in-flight";
import { useActionToast } from "~/ui/use-action-toast";
import { revealTarget, useHashTarget } from "~/ui/use-hash-target";
import type { RunView } from "~/features/runtime/runtime-types";
import { AgentLogsPanel } from "~/features/runtime/runs-panels";
import { useRunLogStream } from "~/features/runtime/use-run-log-stream";
import type { AcceptCeremonyMode } from "./accept-confirm";
import { ArchiveConfirm } from "./archive-confirm";
import type { OwnerAction, TaskMemberView } from "./execution-profile";
import { MoveBackConfirm } from "./move-back-confirm";
import type { RecommendationInFlight, RecommendationView } from "./operator-recommendations";
import { reachesAcceptance } from "./reaches-acceptance";
import { ReleaseConfirm } from "./release-confirm";
import type { TaskRunPrincipalView } from "./run-principal-view";
import { useLogSelection, useRunControls, type ActionResult } from "./task-detail-hooks";

/**
 * The task page's posts (ruling 684(d), the pilot split of
 * `task-detail-page.tsx`), each with its fetcher, toast, local state and
 * confirm: who owns the task, the open decision, the archive, the acceptance,
 * the run console, the recommendations and the stage. The page calls them in
 * the order its fetchers always registered, so each fetcher keeps its key, and
 * places each confirm where it always stood. No component lives here (the
 * dialogs are elements the page places), so the module is not a Fast Refresh
 * boundary, like `task-detail-hooks.ts` beside it.
 */

/**
 * The acceptance ceremony's pending state (ruling 20 / R15-1). Every variant
 * ends in "task Done + a real GitHub merge", so every variant asks first; the
 * payload is whatever the confirmed click has to replay.
 *
 * F15-10/R15-1: accepting merges the PR — it fires only through the confirm
 * dialog (which states PR, revision, merge head, verdict state and target
 * branch). Pass 19 (ruling 20 / the acceptance-writer matrix): the dialog now
 * covers EVERY writer that ends in "Done + real merge", not just the two
 * buttons that already had it. The pending state carries what the confirmed
 * action has to replay — a recommendation id, a packet option + its note, or
 * the stage the human picked out of the Current-state menu (F19-37).
 */
export type PendingAccept =
  | { mode: Extract<AcceptCeremonyMode, "accept" | "force" | "complete-merge"> }
  | { mode: "apply-recommendation"; recId: string; label: string }
  /** Ruling 164 (pass 35, F35-14): `force` marks the `force_accept` option,
   *  whose resolution runs the admin override — so the ceremony opens in its
   *  FORCE form (the skipped stages, the bypassed refusal, the danger confirm)
   *  while the click still travels as a packet resolution. */
  | { mode: "packet"; option: number; note: string; label: string; force?: true }
  | { mode: "stage-move"; toStageId: string; label: string };

/** Opens the one acceptance ceremony on what its confirm replays: the page's
 *  pending-accept setter, which every door that ends in a merge calls. */
export type OpenCeremony = (pending: PendingAccept) => void;

/** A page POST's first two fields, in the order every submitter wrote them:
 *  the CSRF token, then the intent. */
function intentForm(csrf: string, intent: string): FormData {
  const fd = new FormData();
  fd.set("_csrf", csrf);
  fd.set("intent", intent);
  return fd;
}

/** A bare intent posted on a fetcher of its own: whether it is in flight, and
 *  the press, which does nothing while the last one runs. Its answer toasts. */
export function useIntentPost(intent: string, csrf: string): [busy: boolean, post: () => void] {
  const fetcher = useFetcher<ActionResult>();
  useActionToast(fetcher);
  const busy = fetcher.state !== "idle";
  const post = () => {
    if (busy) return;
    fetcher.submit(intentForm(csrf, intent), { method: "post" });
  };
  return [busy, post];
}

/**
 * G7: the page body is overflow:hidden and `.detail` is the actual scroll
 * container, so keyboard scrolling (Space / PageDown / arrows) is dead until
 * `.detail` holds focus. It's kept out of the tab order (tabIndex=-1) and
 * focused on mount so the workspace is keyboard-scrollable immediately.
 */
export function useWorkspaceFocus(): RefObject<HTMLDivElement | null> {
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const detail = detailRef.current;
    // Ruling 497: a link that opened a place on this page (a timeline event)
    // has focused it already, and inside `.detail` the keys scroll just the same.
    if (detail?.contains(document.activeElement)) return;
    detail?.focus({ preventScroll: true });
  }, []);
  return detailRef;
}

/** Ruling 497: the page's own places a notification opens (the timeline's
 *  events are the timeline's); ruling 547 names a decision by its packet. */
function isTaskRegionAnchor(id: string): boolean {
  return (
    id === TASK_DECISION_ANCHOR ||
    decisionPacketId(id) !== null ||
    id === TASK_RECOMMENDATIONS_ANCHOR
  );
}

/**
 * Ruling 547: the element a region link lands on: the place it names while
 * the page shows it, else the timeline, which records what became of it (the
 * decision answered or withdrawn, the recommendations applied or dismissed).
 * A link naming a packet opens the card only for that packet; the bare
 * `#decision` of a row written before ruling 547 opens whichever is open.
 */
function regionPlace(
  id: string,
  packet: TaskDetail["packet"],
  hasRecommendations: boolean,
): string {
  if (id === TASK_RECOMMENDATIONS_ANCHOR) {
    return hasRecommendations ? TASK_RECOMMENDATIONS_ANCHOR : TASK_TIMELINE_ANCHOR;
  }
  const named = decisionPacketId(id);
  return packet && (named === null || named === packet.id)
    ? TASK_DECISION_ANCHOR
    : TASK_TIMELINE_ANCHOR;
}

/**
 * Ruling 497: a decision's notification opens the packet or the
 * recommendation cards, and a second click on it, from this page, brings
 * them back into view. Ruling 547: once they are gone, the timeline. Returns
 * the anchor of the place the link landed on, which the page marks, or null.
 */
export function useRegionLanding(
  packet: TaskDetail["packet"],
  hasRecommendations: boolean,
): string | null {
  const regionTarget = useHashTarget(isTaskRegionAnchor, true, (id) => {
    const place = document.getElementById(regionPlace(id, packet, hasRecommendations));
    if (place) revealTarget(place);
    return place;
  });
  return regionTarget === null ? null : regionPlace(regionTarget, packet, hasRecommendations);
}

/** Who owns the task: take, assign and release, and the release confirm. */
export function useOwnerControl(
  csrf: string,
  task: TaskDetail,
  me: { id: string; name: string },
  members: TaskMemberView[],
) {
  const [releasing, setReleasing] = useState(false);
  const ownerFetcher = useFetcher<ActionResult>();
  useActionToast(ownerFetcher);
  const ownerBusy = ownerFetcher.state !== "idle";
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
  const releaseDialog = releasing && (
    <ReleaseConfirm
      task={task}
      me={me}
      members={members}
      busy={ownerBusy}
      onCancel={() => setReleasing(false)}
      onConfirm={() => onOwner("release")}
      onOwner={onOwner}
    />
  );
  return { busy: ownerBusy, onOwner, openRelease: () => setReleasing(true), releaseDialog };
}

/** The open decision packet: its resolution, the questionnaire's own answer,
 *  and the goal editor a decided edit_goal option opens. */
export function usePacketResolution(
  csrf: string,
  packet: TaskDetail["packet"],
  openCeremony: OpenCeremony,
) {
  const resolveFetcher = useFetcher<ActionResult>();
  useActionToast(resolveFetcher);
  const resolveBusy = resolveFetcher.state !== "idle";
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

  const submitResolve = (
    optionIndex: number,
    note: string,
    // Ruling 88: set ONLY for the `accept_completion` option, the one kind that
    // writes Done and merges — the server gates that arm on the echo and leaves
    // every other decision ack-free.
    disclosure?: AcceptanceDisclosure,
  ) => {
    if (resolveBusy) return;
    const fd = intentForm(csrf, "resolve-packet");
    fd.set("option", String(optionIndex));
    if (note.trim()) fd.set("note", note);
    setDisclosure(fd, disclosure);
    resolveFetcher.submit(fd, { method: "post" });
  };
  // Questionnaire packets (owner request 2026-08-20): resolve with the human's
  // OWN directive. No option index — the server runs the synthetic `custom`
  // arm, which never accepts/archives/merges, so no ceremony interposes.
  const submitResolveCustom = (custom: string) => {
    if (resolveBusy || !custom.trim()) return;
    const fd = intentForm(csrf, "resolve-packet");
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
    const option = packet?.options[optionIndex];
    if (option?.kind === "accept_completion") {
      openCeremony({
        mode: "packet",
        option: optionIndex,
        note,
        label: option.t,
      });
      return;
    }
    // Ruling 164 (pass 35, F35-14): a `force_accept` option runs the admin
    // override, and the server refuses a resolution that carries no echo of it
    // (`forceAcceptCompletion` holds the same ceremony the button does). Open
    // the FORCE form of the one dialog: it names the stages the close skips and
    // the refusal it bypasses, which a title alone never did.
    if (option?.kind === "force_accept") {
      openCeremony({
        mode: "packet",
        option: optionIndex,
        note,
        label: option.t,
        force: true,
      });
      return;
    }
    submitResolve(optionIndex, note);
  };
  return {
    busy: resolveBusy,
    submitResolve,
    submitResolveCustom,
    onResolve,
    onEditGoal: (draft: string) => {
      // Ruling 138: the reload path opens the editor with the SAME
      // draft the confirm response carried.
      setEditGoalDraft(draft);
      setEditGoalSignal((n) => n + 1);
    },
    editGoalSignal,
    editGoalDraft,
    // F35-6: while a decided edit_goal packet waits, the hero's own Edit
    // opens with the SAME draft the decided card shows (one mapping
    // field), not the goal the decision asked to replace.
    pendingGoalDraft: packet?.goalDraft ?? null,
  };
}

/** R14-3: the archive and its restore, and the archive's confirm. */
export function useArchiveControl(
  csrf: string,
  task: TaskDetail,
  archived: boolean,
  pendingRecommendations: number,
) {
  const [archiving, setArchiving] = useState(false);
  // R14-3: its own fetcher — an archive/restore must not be able to strand or be
  // stranded by an ownership submission sharing one fetcher (UI-56's lesson).
  const archiveFetcher = useFetcher<ActionResult>();
  useActionToast(archiveFetcher);
  const archiveBusy = archiveFetcher.state !== "idle";
  // R14-3: archiving asks first (it withdraws the open decision); restoring is
  // additive and reversible, so it submits straight away.
  const submitArchive = (nextArchived: boolean) => {
    if (archiveBusy) return;
    archiveFetcher.submit(intentForm(csrf, nextArchived ? "archive-task" : "restore-task"), {
      method: "post",
    });
  };
  const dialog = archiving && (
    <ArchiveConfirm
      task={task}
      pendingRecommendations={pendingRecommendations}
      busy={archiveBusy}
      onCancel={() => setArchiving(false)}
      onConfirm={() => submitArchive(true)}
    />
  );
  return {
    busy: archiveBusy,
    onArchive: () => (archived ? submitArchive(false) : setArchiving(true)),
    dialog,
  };
}

/** The direct acceptance, and the ceremony's offer to bring the work up to
 *  date first, on one fetcher. */
export function useAcceptCompletion(csrf: string) {
  const acceptFetcher = useFetcher<ActionResult>();
  useActionToast(acceptFetcher);
  const acceptBusy = acceptFetcher.state !== "idle";
  // Ruling 88 (F21-2): the acceptance intents carry the ceremony's own echo of
  // what it displayed. The server refuses this POST without it — that refusal
  // is the invariant; this is just the honest client half of it.
  const submitAccept = (disclosure: AcceptanceDisclosure) => {
    if (acceptBusy) return;
    const fd = intentForm(csrf, "accept-completion");
    setDisclosure(fd, disclosure);
    acceptFetcher.submit(fd, { method: "post" });
  };

  // Ruling 449 (O39-c): the dialog's "bring it up to date and re-review
  // first". Rides the accept fetcher, so the dialog's busy state and the
  // toast are the acceptance's own.
  const submitRefreshFirst = () => {
    if (acceptBusy) return;
    acceptFetcher.submit(intentForm(csrf, "refresh-and-review"), { method: "post" });
  };
  return {
    busy: acceptBusy,
    inFlight: inFlightIntent(acceptFetcher),
    submitAccept,
    submitRefreshFirst,
  };
}

/** The task's runs: the console's store, the run controls, the log selection,
 *  the one console element, and the interrupt's confirm. */
export function useRunConsole({
  csrf,
  task,
  runtime,
  runsVisible,
  myRole,
  canRunAgents,
  runPrincipal,
  acceptance,
}: {
  csrf: string;
  task: TaskDetail;
  runtime: RunView[];
  runsVisible: boolean;
  myRole: string | null;
  canRunAgents: boolean;
  runPrincipal: TaskRunPrincipalView | null;
  acceptance: AcceptanceAffordance;
}) {
  // D6: two consequential single-click actions gained a confirm — interrupting a
  // live run (discards its in-flight, uncommitted work) and dismissing an
  // operator recommendation (withdraws a governed, audited decision). Both were
  // one silent click while a reversible archive took a three-row ceremony.
  const [confirmInterrupt, setConfirmInterrupt] = useState<string | null>(null);

  // The run-log console's store (ruling 457): it follows the task's runs
  // line by line on the layout's live stream, fills a thread the payload did
  // not carry, and keeps its lines OUTSIDE this page's state, so a console
  // line re-renders the console and not the page.
  const runLog = useRunLogStream({
    source: { kind: "task", projectSlug: task.projectSlug, taskKey: task.key },
    // P13-D-11: each thread carries its BOUNDED window's facts (NFR5): the
    // live-tail seed (`headSeq`) and the backward cursor.
    threads: runtime,
    // F22: bounds a stale "running" strip if a finalize event is missed.
    hasActiveRun: runtime.some((r) => r.state === "running"),
    // UI-30: a non-member's tail requests 403 — don't ask for what can only
    // be refused (it used to 403 silently on every appended line).
    enabled: runsVisible,
  });

  const {
    runBusy,
    runIntent,
    interruptingRunId,
    retryingProfileId,
    canInterrupt,
    onInterrupt,
    onRetryBackend,
    retryBackends,
    onCompleteMerge,
    onForceAccept,
  } = useRunControls({
    csrf,
    runtime,
    myRole,
    canRunAgents,
    // Ruling 127: the retry-on-the-other-backend offer bills the task owner,
    // so it follows their connected accounts, not the viewer's grant alone.
    runPrincipal,
    // F19-10: the merge control follows the SERVER's acceptance authority
    // (role OR this task's own owner), not a role-only copy of it.
    acceptanceHasAuthority: acceptance.hasAuthority,
    acceptanceTerminallyBlocked: acceptance.terminallyBlocked,
  });
  const { shownLogSel, selectLog, onViewLogs, onAgentLog, consoleOpen } =
    useLogSelection(runtime);
  /** F39: is any run of this task streaming? While one is, its console is
   *  disclosed on the run card; otherwise the settled-runs panel holds it. */
  const liveRun = runtime.some((r) => r.state === "running");
  /** ONE console element for both positions, so the props cannot drift. */
  const agentLogs = useMemo(
    () => (
      <AgentLogsPanel
        runtime={runtime}
        sel={shownLogSel}
        onSel={selectLog}
        store={runLog}
        {...(onRetryBackend ? { onRetryBackend } : {})}
        retryBackends={retryBackends}
        retrying={runBusy}
        retryingProfileId={retryingProfileId}
      />
    ),
    [
      runtime,
      shownLogSel,
      selectLog,
      runLog,
      onRetryBackend,
      retryBackends,
      runBusy,
      retryingProfileId,
    ],
  );

  // D6: interrupt a live run — discards uncommitted in-flight work. That
  // discard is ruling 149's destructive class, so the commit keeps the
  // shared `danger` default and, under ruling 150, the `LiveRunPanel`
  // trigger that opens this dialog carries the same red label.
  const interruptDialog = confirmInterrupt && (
    <ConfirmDialog
      screenLabel="Interrupt run dialog"
      title="Interrupt this run?"
      /* Ruling 272 (pass 37, F37-104): this said "Anything it has not
         already committed or delivered is lost", and nothing is. An
         interrupt kills the PROCESS; it never touches the task's
         workspace, and the next run reuses that checkout as it stands
         (`cloneRepo`'s reuse path fast-forwards only a tree that is clean
         on the default branch, so a dirty one is left exactly alone). The
         sentence was wrong in the direction that costs most: it tells a
         person that stopping a stuck run destroys work — discouraging the
         one action the product wants them to be able to take — and it
         tells whoever runs next that the tree is clean when a half-written
         edit is sitting in it. */
      body="The agent stops mid-turn. It never reports, so nothing it was about to deliver, record or answer lands. Its edits stay in the task's workspace exactly as it left them, which may be half-finished, and the next run continues from that tree rather than a fresh one."
      confirmLabel="Interrupt run"
      busy={runBusy}
      onCancel={() => setConfirmInterrupt(null)}
      onConfirm={() => onInterrupt(confirmInterrupt)}
    />
  );
  return {
    runLog,
    runBusy,
    runIntent,
    interruptingRunId,
    canInterrupt,
    onCompleteMerge,
    onForceAccept,
    onViewLogs,
    onAgentLog,
    consoleOpen,
    agentLogs,
    liveRun,
    // The state setter itself, never a wrapper: the memoised run card keeps
    // one reference across renders (ruling 457).
    askInterrupt: setConfirmInterrupt,
    interruptDialog,
  };
}

/**
 * Apply / dismiss an operator recommendation (apply is admin|maintainer; the
 * server re-checks). Lifted onto the page — with F19-3 an Apply can BE an
 * acceptance, so the click has to reach the page's confirm state rather than
 * submit from inside the card.
 */
export function useRecommendationActions(
  csrf: string,
  recommendations: RecommendationView[],
  terminalStageId: string | null,
  openCeremony: OpenCeremony,
) {
  const [confirmDismiss, setConfirmDismiss] = useState<
    { recId: string; label: string } | null
  >(null);
  const recFetcher = useFetcher<ActionResult>();
  useActionToast(recFetcher);
  const recBusy = recFetcher.state !== "idle";
  // Ruling 368: the card whose request this fetcher carries shows it in
  // flight. The fetcher keeps its form data through `submitting` and the
  // revalidating `loading` that follows, which is exactly the stretch the
  // human is waiting through.
  const recInFlight: RecommendationInFlight | null =
    recBusy && recFetcher.formData
      ? {
          recId: String(recFetcher.formData.get("recId") ?? ""),
          action:
            recFetcher.formData.get("intent") === "dismiss-recommendation" ? "dismiss" : "apply",
        }
      : null;
  const submitApplyRec = (
    recId: string,
    // Ruling 88: set ONLY when the card REACHES acceptance
    // (`reachesAcceptance` — kind or terminal target), which is the same
    // predicate the server consults its own copy of before demanding the echo.
    disclosure?: AcceptanceDisclosure,
  ) => {
    if (recBusy) return;
    const fd = intentForm(csrf, "apply-recommendation");
    fd.set("recId", recId);
    setDisclosure(fd, disclosure);
    recFetcher.submit(fd, { method: "post" });
  };
  // F19-3 (live-proven: one Apply click merged an unreviewed head into main).
  // The confirmed action still posts `apply-recommendation`, NOT
  // `accept-completion` — that keeps the recommendation-applied audit row, the
  // R15-3/R14-2 owner-authority seam and the card-clearing on the server.
  const onApplyRec = (recId: string) => {
    if (recBusy) return;
    const rec = recommendations.find((r) => r.id === recId);
    if (rec && reachesAcceptance(rec, terminalStageId)) {
      openCeremony({ mode: "apply-recommendation", recId, label: rec.label });
      return;
    }
    submitApplyRec(recId);
  };
  const submitDismissRec = (recId: string) => {
    if (recBusy) return;
    const fd = intentForm(csrf, "dismiss-recommendation");
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

  // D6: dismiss an operator recommendation — an audited decision, and one
  // that takes nothing away: the dismissal is recorded on the timeline and
  // the operator may raise the recommendation again on its next run. Under
  // rulings 149 and 150 the danger treatment belongs to the controls that
  // take something away, so this one commits `primary`, like the neutral
  // `btn ghost sm` trigger that opens it.
  const dismissDialog = confirmDismiss && (
    <ConfirmDialog
      screenLabel="Dismiss recommendation dialog"
      title="Dismiss this recommendation?"
      body={
        <>
          <strong>{confirmDismiss.label}</strong> is withdrawn without acting
          on it. The dismissal is recorded on the timeline; the operator may
          raise it again on its next run.
        </>
      }
      confirmLabel="Dismiss recommendation"
      tone="primary"
      // colo-7: the warning triangle reads as a warning on any wash.
      icon="shield"
      busy={recBusy}
      onCancel={() => setConfirmDismiss(null)}
      onConfirm={() => submitDismissRec(confirmDismiss.recId)}
    />
  );
  return {
    busy: recBusy,
    inFlight: recInFlight,
    onApply: onApplyRec,
    onDismiss: onDismissRec,
    submitApply: submitApplyRec,
    dismissDialog,
  };
}

/**
 * Manual stage change from the Current-state menu. Page-owned since F19-37 —
 * see below. With it, the move-back confirm (ruling 381).
 */
export function useStageTransition(
  csrf: string,
  task: TaskDetail,
  stage: TaskDetail["stages"][number] | undefined,
  terminalStageId: string | null,
  openCeremony: OpenCeremony,
) {
  const transitionFetcher = useFetcher<ActionResult>();
  useActionToast(transitionFetcher);
  const transitionBusy = transitionFetcher.state !== "idle";
  const submitTransition = (
    toStageId: string,
    // Ruling 88: set ONLY for the stage-move-into-Done case, which the server
    // reads as an acceptance and gates on the disclosure like any other accept.
    disclosure?: AcceptanceDisclosure,
    // Ruling 381: WHY, for a move backward. The server requires it there and
    // refuses without it, so the dialog below collects it first.
    reason?: string,
  ) => {
    if (transitionBusy) return;
    const fd = intentForm(csrf, "transition");
    fd.set("to", toStageId);
    if (reason) fd.set("reason", reason);
    setDisclosure(fd, disclosure);
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
  /** Ruling 381: the move the operator has to act on, so it carries its reason. */
  const [confirmMoveBack, setConfirmMoveBack] = useState<string | null>(null);
  const stageIndexOf = (id: string) => task.stages.findIndex((s) => s.id === id);
  const onTransition = (toStageId: string) => {
    if (transitionBusy) return;
    const fromIdx = stageIndexOf(task.stage);
    const toIdx = stageIndexOf(toStageId);
    if (toIdx >= 0 && fromIdx >= 0 && toIdx < fromIdx) {
      setConfirmMoveBack(toStageId);
      return;
    }
    if (toStageId === terminalStageId && task.stage !== terminalStageId) {
      openCeremony({
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
  const moveBackDialog = confirmMoveBack && (
    <MoveBackConfirm
      taskKey={task.key}
      taskTitle={task.title}
      fromStageName={stage?.name ?? task.stage}
      toStageName={stageName(task.stages, confirmMoveBack)}
      busy={transitionBusy}
      onCancel={() => setConfirmMoveBack(null)}
      onConfirm={(reason) => submitTransition(confirmMoveBack, undefined, reason)}
    />
  );
  return { busy: transitionBusy, onTransition, submitTransition, moveBackDialog };
}

/** The objects these hooks return, as the page hands them to its regions. */
export type OwnerControl = ReturnType<typeof useOwnerControl>;
export type PacketResolution = ReturnType<typeof usePacketResolution>;
export type AcceptCompletion = ReturnType<typeof useAcceptCompletion>;
export type RunConsole = ReturnType<typeof useRunConsole>;
export type RecommendationActions = ReturnType<typeof useRecommendationActions>;
export type StageTransition = ReturnType<typeof useStageTransition>;
