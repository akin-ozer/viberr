import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate, type FetcherWithComponents } from "react-router";
import { useToast } from "~/ui/toast";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import type { RunView } from "~/features/runtime/runtime-types";

/**
 * Task-detail behaviour that is not markup: the once-per-settled-result toast
 * wiring every one of the page's 13 fetchers routes through, the run controls,
 * and the log-panel selection. Split out of `task-detail-page.tsx` (pass 16 —
 * the file was 1811 lines and the most conflict-prone in the tree); a pure
 * structural refactor, no behaviour or copy change.
 */

export type ActionResult =
  | {
      ok: true;
      toast?: string;
      navigateTo?: string;
      kind?: string;
      /** R17-2/F17-L3: a suggested new goal from a resolved scoping (edit_goal)
       *  packet option — the editor prefills with THIS instead of the old goal. */
      goalDraft?: string;
    }
  | { ok: false; error: string };

/** Toast + optional redirect once per completed fetcher submission. */
export function useActionFeedback(fetcher: FetcherWithComponents<ActionResult>) {
  const push = useToast();
  const navigate = useNavigate();
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    const d = fetcher.data;
    if (d.ok) {
      if (d.toast) push(d.toast);
      if (d.navigateTo) navigate(d.navigateTo);
    } else if (d.error) {
      // E.g. "This packet was already resolved." — revalidation has already
      // refreshed the panel; surface the reason, never crash (spec §7).
      // P13-D-10: `push` defaults to the "success" kind, so every failure on
      // this page rendered under a green tick.
      push(d.error, "error");
    }
  }, [fetcher.state, fetcher.data, push, navigate]);
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
  acceptanceTerminallyBlocked,
}: {
  csrf: string;
  runtime: RunView[];
  myRole: string | null;
  canRunAgents: boolean;
  /** R16-3: a closed, unmerged PR blocks acceptance terminally — no override. */
  acceptanceTerminallyBlocked: boolean;
}) {
  const runFetcher = useFetcher<ActionResult>();
  useActionFeedback(runFetcher);
  const runBusy = runFetcher.state !== "idle";
  // Any live (queued/running) run — the D4 backend-retry affordance stays gated
  // on "nothing currently in flight" (F10-04 keeps this coarse gate; per-
  // engagement gating applies to the primary/reviewer Run buttons only).
  const anyRunActive = runtime.some(
    (r) => r.lifecycle === "running" || r.lifecycle === "queued",
  );
  // Interrupt is admin|maintainer (contracts §3.2); the button hides for
  // everyone else. Server re-checks RBAC regardless.
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
  // Retry the failed run's agent on the OTHER backend after a backend
  // availability / quota failure (D4). Routes by the failed run's kind —
  // a reviewer retries as THAT reviewer, not as the primary. The override
  // also persists to the assignment snapshot server-side, so the operator's
  // next prompt follows the switched backend. admin|maintainer; server
  // re-checks.
  const onRetryBackend =
    canRunAgents && !anyRunActive
      ? (backend: "claude" | "codex", run: RunView) => {
          if (runBusy) return;
          const fd = new FormData();
          fd.set("_csrf", csrf);
          fd.set(
            "intent",
            run.kind === "reviewer" ? "run-reviewer" : "run-specialist",
          );
          if (run.kind === "reviewer") {
            fd.set("profileId", run.profileId);
          }
          fd.set("backend", backend);
          runFetcher.submit(fd, { method: "post" });
        }
      : undefined;
  // Complete the real merge of an accepted (merge-pending) PR (S2).
  // admin|maintainer only; server re-checks.
  const canMerge = roleCan(myRole as ProjectRole | null, "accept-completion");
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
  const canForceAccept =
    roleCan(myRole as ProjectRole | null, "force-accept-completion") &&
    !acceptanceTerminallyBlocked;
  const onForceAccept = canForceAccept
    ? () => {
        if (runBusy) return;
        const fd = new FormData();
        fd.set("_csrf", csrf);
        fd.set("intent", "force-accept");
        runFetcher.submit(fd, { method: "post" });
      }
    : undefined;
  return {
    runBusy,
    canInterrupt,
    onInterrupt,
    onRetryBackend,
    onCompleteMerge,
    onForceAccept,
  };
}

/**
 * BUG 3: commenting an @agent auto-selects that agent's grouped log entry and
 * scrolls the Agent-logs panel into view. The reply run is the group
 * representative → selecting its id shows its live output (streamed by the
 * existing useRunLogStream). Revalidation (fired by the comment fetcher)
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
  const selectLog = (id: string | null) => {
    if (pendingLogReady) setPendingLogSel(null);
    setLogSel(id);
  };
  const onViewLogs = (id: string) => {
    selectLog(id);
    // Scroll the logs panel into view (spec §5.2 addition).
    requestAnimationFrame(() => {
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const onAgentLog = (threadId: string) => {
    setPendingLogSel(threadId);
    setLogSel(threadId);
    requestAnimationFrame(() => {
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  return { shownLogSel, selectLog, onViewLogs, onAgentLog };
}
