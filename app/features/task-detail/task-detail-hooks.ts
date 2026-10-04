import { useCallback, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { inFlightIntent } from "~/ui/in-flight";
import { useActionToast } from "~/ui/use-action-toast";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import {
  acceptanceDisclosureFields,
  type AcceptanceDisclosure,
} from "~/shared/acceptance-disclosure";
import type { RunView } from "~/features/runtime/runtime-types";
import type { TaskRunPrincipalView } from "./run-principal-view";

/**
 * Task-detail behaviour that is not markup: the result every one of the page's
 * fetchers reads (each toasts it through the shared `useActionToast`), the run
 * controls, and the log-panel selection. Split out of `task-detail-page.tsx`
 * (pass 16 — the file was 1811 lines and the most conflict-prone in the tree);
 * a pure structural refactor, no behaviour or copy change.
 */

export type ActionResult =
  | {
      ok: true;
      toast?: string;
      kind?: string;
      /** R17-2/F17-L3: a suggested new goal from a resolved scoping (edit_goal)
       *  packet option — the editor prefills with THIS instead of the old goal. */
      goalDraft?: string;
    }
  | { ok: false; error: string };

/** Ruling 88 (F21-2): the acceptance ceremony's echo of what it displayed, on
 *  the form an acceptance intent posts; nothing for an intent that has none. */
export function setDisclosure(fd: FormData, disclosure: AcceptanceDisclosure | undefined): void {
  if (!disclosure) return;
  for (const [field, value] of Object.entries(acceptanceDisclosureFields(disclosure))) {
    fd.set(field, value);
  }
}

/**
 * Run-control mutations (interrupt / retry-on-other-backend / complete the
 * real merge). One fetcher backs all three, so a single in-flight run action
 * disables the others.
 */
export function useRunControls({
  csrf,
  runtime,
  myRole,
  canRunAgents,
  runPrincipal,
  acceptanceHasAuthority,
  acceptanceTerminallyBlocked,
}: {
  csrf: string;
  runtime: RunView[];
  myRole: string | null;
  canRunAgents: boolean;
  /** Ruling 127: whose accounts a run on this task would bill, and what those
   *  accounts can run. `null` = nobody to bill (no owner, or a seat pointing at
   *  a gone/disabled account), which no backend switch fixes. */
  runPrincipal: TaskRunPrincipalView | null;
  /** F19-10: `acceptance.hasAuthority` — the server's OWN answer to "may this
   *  viewer accept/merge THIS task", resolved by `acceptanceStanding`
   *  with the same predicate `requireAcceptCompletion` enforces: the
   *  `accept-completion` role grant OR the live task-owner exception. */
  acceptanceHasAuthority: boolean;
  /** R16-3: a closed, unmerged PR blocks acceptance terminally — no override. */
  acceptanceTerminallyBlocked: boolean;
}) {
  const runFetcher = useFetcher<ActionResult>();
  useActionToast(runFetcher);
  const runBusy = runFetcher.state !== "idle";
  // Ruling 368: this one fetcher carries four requests (interrupt, the backend
  // retry, complete-merge, force-accept), so the page reads which one — and
  // for which run or agent — off its form data. The button that started it
  // shows the work; every other one only waits on `runBusy`.
  const runIntent = inFlightIntent(runFetcher);
  const interruptingRunId =
    runIntent === "run-interrupt" ? String(runFetcher.formData?.get("runId") ?? "") : null;
  const retryingProfileId =
    runIntent === "run-agent" ? String(runFetcher.formData?.get("profileId") ?? "") : null;
  // Any live (queued/running) run — the D4 backend-retry affordance stays gated
  // on "nothing currently in flight" (F10-04 keeps this coarse gate; per-
  // engagement gating applies to the primary/reviewer Run buttons only).
  const anyRunActive = runtime.some(
    (r) => r.lifecycle === "running" || r.lifecycle === "queued",
  );
  // Interrupt is admin|maintainer (contracts §3.2); the button hides for
  // everyone else. Server re-checks RBAC regardless.
  //
  // SAFETY: `myRole` is the project layout loader's own value (routes/project.tsx
  // — `project_members.role`, which 0001_baseline CHECK-constrains to exactly the
  // four project roles, or "admin" for the org-admin override, or null); the prop
  // chain down to this hook is what widens it to `string`. `roleCan` denies any
  // value outside the four regardless, so the widening can only ever under-grant.
  const canInterrupt = roleCan(myRole as ProjectRole | null, "run-agents");
  const onInterrupt = (runThreadId: string) => {
    if (runBusy) return;
    const run = runtime.find((r) => r.id === runThreadId);
    if (!run) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "run-interrupt");
    fd.set("runId", run.serverRunId);
    runFetcher.submit(fd, { method: "post" });
  };
  // Ruling 127: which backends a retry could actually RUN on. A retry dispatch
  // bills the task owner exactly as the failed run did, so offering one on a
  // backend they have not connected promises a one-click fix that fails
  // identically the moment it is clicked — which is why the blocked packet
  // already asks this same question before it offers `retry_other_backend`
  // (`isBackendAvailableFor(db, ownerUserId, altBackend)` in
  // run-failure-remedy.server.ts). The button was gated on the viewer's grant alone,
  // so the two surfaces on one task disagreed. An unowned task (null principal)
  // has nobody to bill on either backend.
  //
  // Ruling 457 (TASK-4): kept as one array while the answer is the same, so the
  // memoised console does not re-render on a revalidation that changed nothing.
  const claudeAvailable = runPrincipal?.claude.available ?? false;
  const codexAvailable = runPrincipal?.codex.available ?? false;
  const retryBackends = useMemo(
    () =>
      (["claude", "codex"] as const).filter((b) =>
        b === "claude" ? claudeAvailable : codexAvailable,
      ),
    [claudeAvailable, codexAvailable],
  );
  // Retry the failed run's agent on the OTHER backend after a backend
  // availability / quota failure (D4). Routes by the failed run's kind —
  // a reviewer retries as THAT reviewer, not as the primary. The override
  // also persists to the assignment snapshot server-side, so the operator's
  // next prompt follows the switched backend. admin|maintainer; server
  // re-checks.
  const submitRun = runFetcher.submit;
  const retryOnBackend = useCallback(
    (backend: "claude" | "codex", run: RunView) => {
      if (runBusy || !retryBackends.includes(backend)) return;
      const fd = new FormData();
      fd.set("_csrf", csrf);
      // Dynamic-dispatch rework: one run-agent intent for every agent kind
      // — the failed run's own profileId identifies who retries.
      fd.set("intent", "run-agent");
      fd.set("profileId", run.profileId);
      fd.set("backend", backend);
      void submitRun(fd, { method: "post" });
    },
    [runBusy, retryBackends, csrf, submitRun],
  );
  const onRetryBackend = canRunAgents && !anyRunActive ? retryOnBackend : undefined;
  // Complete the real merge of an accepted (merge-pending) PR (S2).
  //
  // F19-24: this SUBMITS — it performs the irreversible GitHub merge, and it is
  // the mandatory human half of every full-autonomy operator acceptance (R16-6).
  // Like `onForceAccept` below it must only ever be called from the confirmed
  // branch of `AcceptConfirm`; the GitHub panel's button opens that dialog, it
  // does not receive this callback directly.
  //
  // F19-10: this asked `roleCan(myRole, "accept-completion")` — a hardcoded copy
  // of ONE row of the matrix, and the wrong row. `completeTaskMerge`
  // (task-acceptance.server.ts) gates on `requireAcceptCompletion(…, "complete a PR
  // merge")`, which passes the task's own human owner whatever their project
  // role (R6-2/R14-2 — "completing a merge-pending acceptance is part of the
  // same acceptance authority"). So a contributor-owner who accepted their own
  // task and got "accepted (merge pending)" was shown NO way to finish it: the
  // task stranded until a maintainer happened to visit, while the server would
  // have merged it on their click. `hasAuthority` is that same predicate,
  // resolved server-side — one source, and it survives the merge-pending case
  // (a merge-pending task sits at the terminal stage, where the affordance
  // returns early but still carries the authority answer).
  const canMerge = acceptanceHasAuthority;
  const onCompleteMerge = canMerge
    ? () => {
        if (runBusy) return;
        const fd = new FormData();
        fd.set("_csrf", csrf);
        fd.set("intent", "complete-merge");
        runFetcher.submit(fd, { method: "post" });
      }
    : undefined;
  // Admin-only override of a stuck acceptance gate (DG-2). Server re-checks the
  // admin role AND re-derives the block; this only wires the affordance.
  //
  // R16-3: force-accept exists for a WEDGED gate — a verdict that can no longer
  // be recorded, a stale packet. A PR closed unmerged is not wedged, it is
  // decided: forcing past it moves the task to Done over a rejection and stamps
  // `pr.state: accepted` on a PR GitHub has already closed. Live (H10) the rail
  // offered exactly that while the recovery packet beside it said otherwise, so
  // the affordance is withheld entirely and the packet is the path.
  //
  // SAFETY: same loader-sourced `myRole` as `canInterrupt` above.
  const canForceAccept =
    roleCan(myRole as ProjectRole | null, "force-accept-completion") &&
    !acceptanceTerminallyBlocked;
  // Ruling 88 (F21-2): the force ceremony discloses MORE than the ordinary one
  // (the skipped stages, the bypassed refusal), so it echoes on the same terms
  // — the server refuses a force-accept POST that carries no acknowledgment,
  // and records no `task.acceptance.forced` row for the attempt.
  const onForceAccept = canForceAccept
    ? (disclosure: AcceptanceDisclosure) => {
        if (runBusy) return;
        const fd = new FormData();
        fd.set("_csrf", csrf);
        fd.set("intent", "force-accept");
        setDisclosure(fd, disclosure);
        runFetcher.submit(fd, { method: "post" });
      }
    : undefined;
  return {
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
  };
}

/**
 * BUG 3: commenting an @agent auto-selects that agent's grouped log entry and
 * scrolls the Agent-logs panel into view. The reply run is the group
 * representative → selecting its id shows its live output (streamed by the
 * page's run-log store, `useRunLogStream`). Revalidation (fired by the comment fetcher)
 * brings the run into `runtime`; the pending id is kept until it appears so
 * the selection lands after revalidation, not before it.
 */
export function useLogSelection(runtime: RunView[]) {
  const [logSel, setLogSel] = useState<string | null>(null);
  const [pendingLogSel, setPendingLogSel] = useState<string | null>(null);
  // Derived selection (no confirm-effect): once revalidation lands the pending
  // reply run in `runtime` it wins over `logSel`; until then the user's own
  // selection shows. A manual pick made after the pending run landed evicts
  // the pending marker so it can't snap the selection back later.
  const pendingLogReady =
    pendingLogSel !== null && runtime.some((r) => r.id === pendingLogSel);
  const shownLogSel = pendingLogReady ? pendingLogSel : logSel;
  // Ruling 457 (TASK-4): stable while `pendingLogReady` holds, so the memoised
  // console and run card do not re-render on a revalidation that changed
  // nothing they draw.
  const selectLog = useCallback(
    (id: string | null) => {
      if (pendingLogReady) setPendingLogSel(null);
      setLogSel(id);
    },
    [pendingLogReady],
  );
  // F39 (owner decision): while a run is LIVE its console is disclosed inside
  // the run card, so the strip's own control is a toggle rather than a jump to
  // a panel a viewport below with the timeline in between.
  // Open by default — the console was always on the page before, just far
  // from the strip that describes it.
  const [consoleOpen, setConsoleOpen] = useState(true);
  const onViewLogs = useCallback(
    (id: string) => {
      selectLog(id);
      setConsoleOpen((open) => !open);
    },
    [selectLog],
  );
  const onAgentLog = (threadId: string) => {
    setPendingLogSel(threadId);
    setLogSel(threadId);
    // From the TIMELINE, and from the continuity panel's console door, the
    // console is genuinely elsewhere, so this one still travels — it just has
    // to open the disclosure first, or there would be nothing at the anchor to
    // travel to. Never a toggle: the console may already be open.
    setConsoleOpen(true);
    requestAnimationFrame(() => {
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  return { shownLogSel, selectLog, onViewLogs, onAgentLog, consoleOpen };
}
