import { Link, useFetcher } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import { Avatar } from "~/ui/avatar";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { StageMenu } from "~/ui/stage-menu";
import { LocalRelative } from "~/ui/local-time";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import type { AcceptanceAffordance } from "~/server/tasks/task-actions.server";
import { checksPill, prStatePill, reviewPill } from "~/features/github/github-pills";
import type { OwnerAction, TaskMemberView } from "./execution-profile";
import { useActionFeedback, type ActionResult } from "./task-detail-hooks";

/**
 * The task-detail SIDE column, in its contracted order (spec §2): GitHub trace
 * → current state → permissions. Split out of `task-detail-page.tsx` (pass 16,
 * pure structural refactor — no behaviour or copy change).
 */

export function GithubTrace({
  task,
  githubHost,
  reconciledAt = null,
  onCompleteMerge,
  onForceAccept,
  onDeliver,
  delivering = false,
  merging,
}: {
  task: TaskDetail;
  /** GitHub web host for browse links — always the loader's `githubWebHost()`
   *  (P14-UI-11: no client-side default, so the literal lives in one place). */
  githubHost: string;
  /** UI-57: ISO of the newest `github.reconcile` for THIS task, or null when it
   *  has never been synced. Diff/commits/PR below are a CACHE — the GitHub page
   *  discloses its freshness and this card did not. */
  reconciledAt?: string | null;
  /** Run the real merge for an accepted (merge-pending) PR (S2). */
  onCompleteMerge?: () => void;
  /** Admin override of a stuck acceptance gate (DG-2); admin-only, undefined otherwise. */
  onForceAccept?: () => void;
  /** R15-2 safety net (b): perform delivery (push + review PR) by hand —
   *  maintainer+ or the task owner; undefined hides the control. */
  onDeliver?: () => void;
  delivering?: boolean;
  merging?: boolean;
}) {
  // Admin escape hatch (DG-2): acceptance is wedged either by the required-reviewer
  // gate (task.blockReason) OR by an open blocked decision packet a crashed run left
  // behind. Surfaced for admins (onForceAccept present) regardless of branch/PR, so a
  // no-branch pre-work wedge is still escapable.
  const forceAcceptReason =
    task.blockReason ??
    (task.packet?.type === "blocked"
      ? "An open blocked decision is holding this task."
      : null);
  const forceAcceptRow =
    forceAcceptReason && onForceAccept ? (
      <div className="force-accept">
        {/* P13-D-19: `.hint` used to exist only as `.pj-new .hint`, so this line
            rendered as an unstyled <p>; it is a global utility now. */}
        <p className="hint">
          Acceptance is blocked: {forceAcceptReason}
        </p>
        <button
          type="button"
          className="btn ghost sm full"
          disabled={merging}
          onClick={onForceAccept}
          title="Admin override: accept this task into Done past the review gate. Audited."
        >
          <Icon name="shield" />
          Force accept (override review gate)
        </button>
      </div>
    ) : null;
  if (!task.branch && !task.pr) {
    return (
      <div className="panel">
        <div className="panel-head">
          <Icon name="github" />
          <h2>GitHub</h2>
        </div>
        <div className="empty sm">
          No branch yet. A task-key branch is created when execution starts.
        </div>
        {forceAcceptRow}
      </div>
    );
  }
  // Real external link (spec §4.9: the prototype toast goes away): the PR when
  // one exists, else the branch tree.
  //
  // P14-UI-11 residual: this used to carry its own `?? "https://github.com"`
  // fallback, so the app held the host literal in TWO places while the fix note
  // in `github-query.server.ts` designated ONE thread-through point for a real
  // GHE base URL. The loader always sends `githubWebHost()`, so the prop is
  // required and the second literal is gone.
  const host = githubHost;
  const ghHref = task.repo
    ? task.pr
      ? `${host}/${task.repo}/pull/${task.pr.number}`
      : task.branch
        ? `${host}/${task.repo}/tree/${task.branch}`
        : `${host}/${task.repo}`
    : null;
  return (
    <div className="panel flush">
      <div className="gh-bar">
        <Icon name="github" />
        <span className="repo">{task.repo}</span>
        {task.pr ? (
          // UI-36: reuse the shared PR-state mapping. This branched only on
          // `merged`/`accepted`, so a PR CLOSED WITHOUT MERGING (a rejected
          // one — a first-class state since NEW-1) rendered as a blue "PR #14",
          // visually identical to a PR still in review. The GitHub page and the
          // review queue have always rendered it correctly.
          <Pill kind={prStatePill(task.pr.state).kind} sm>
            {task.pr.state === "merged"
              ? "merged"
              : `PR #${task.pr.number} · ${prStatePill(task.pr.state).label}`}
          </Pill>
        ) : (
          <Pill kind="neutral" sm>
            no PR
          </Pill>
        )}
        {/* P13-D-28: the two GitHub facts the app fetched (or could have) and
            never showed. Check-runs were summarized on every reconcile pass and
            read by nothing; review state was never read at all, so a teammate
            approving or requesting changes on GitHub was invisible here and a
            merge blocked by required reviews surfaced only as a late 405. */}
        {task.prChecks && (
          <Pill kind={checksPill(task.prChecks).kind} sm>
            {checksPill(task.prChecks).label}
          </Pill>
        )}
        {task.prReview && (
          <Pill kind={reviewPill(task.prReview).kind} sm>
            {reviewPill(task.prReview).label}
          </Pill>
        )}
      </div>
      <div className="gh-body">
        <div className="kv-row">
          <span className="k">Synced</span>
          <span className="v sub" title="Branch, diff, commits and PR state below are served from the cached projection; a background poller refreshes it every 5 minutes.">
            {reconciledAt ? (
              <time dateTime={reconciledAt}>
                <LocalRelative iso={reconciledAt} />
              </time>
            ) : task.pr || task.commits.length > 0 ? (
              // F15-02: PR/commit facts on screen came from delivery-time
              // writes, not a reconcile pass — "not yet synced" next to a live
              // PR read as a contradiction. Say what is actually true.
              "recorded at delivery — no background sync pass yet"
            ) : (
              "not yet synced with GitHub"
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Branch</span>
          <span className="v">
            <Icon name="branch" />
            <span className="mono">{task.branch}</span>
          </span>
        </div>
        {task.changed && (
          <div className="kv-row">
            <span className="k">Diff</span>
            <span className="v mono">
              {/* LV-09: "Diff 1 files" */}
              {task.changed.files} {task.changed.files === 1 ? "file" : "files"} ·{" "}
              <span className="diff-add">+{task.changed.add}</span>{" "}
              <span className="diff-del">−{task.changed.del}</span>
            </span>
          </div>
        )}
        {task.commits.length > 0 && (
          <div className="commit-list">
            {/* P16-F3: `.flabel` IS these six declarations — the inline copy
                was a second source for the same section-label treatment. */}
            <div className="flabel">Commits</div>
            {task.commits.map((c) => (
              <div className="commit" key={c.sha}>
                <span className="sha">{c.sha}</span>
                <span className="msg">{c.msg}</span>
              </div>
            ))}
          </div>
        )}
        {/* R15-2 safety net (b): with delivery now an operator decision, a
            human with authority can always ship the branch by hand — shown when
            no live PR stands (none yet, or the last one closed/merged). */}
        {onDeliver &&
          (!task.pr ||
            task.pr.state === "closed" ||
            task.pr.state === "merged") && (
            <button
              type="button"
              className="btn primary sm panel-act"
              disabled={delivering}
              onClick={onDeliver}
              title="Push the delivering agent's branch and open the review PR (audited)"
            >
              <Icon name="branch" />
              {delivering ? "Delivering…" : "Deliver branch & open PR"}
            </button>
          )}
        {task.pr?.state === "accepted" && onCompleteMerge && (
          <button
            type="button"
            className="btn primary sm panel-act"
            disabled={merging}
            onClick={onCompleteMerge}
            title="Run the real GitHub merge for this accepted PR (needs a valid project credential)"
          >
            <Icon name="check" />
            Complete merge
          </button>
        )}
        {forceAcceptRow}
        {ghHref && (
          <a
            className="btn ghost sm panel-act"
            href={ghHref}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="ext" />
            Open on GitHub
          </a>
        )}
      </div>
    </div>
  );
}

export function PolicyPanel({
  projectSlug,
  myRole,
  stages,
  ownsTask,
}: {
  projectSlug: string;
  myRole: string | null;
  /** UI-15/UI-49 family: the boundary row names the project's OWN review and
   *  terminal stages instead of the literals "Review → Done". */
  stages: TaskDetail["stages"];
  /** P14-GV-04: this viewer holds the task's owner seat. The acceptance row is
   *  the one platform rule that is NOT identical for every task — R6-2 gives the
   *  owner acceptance authority whatever their project role — and this panel
   *  told a contributor-owner "Maintainer or admin only" while the server let
   *  them accept and the review queue counted them as the one who must. */
  ownsTask: boolean;
}) {
  const reviewName =
    stages.length >= 2 ? stages[stages.length - 2]!.name : "the review stage";
  const terminalName =
    stages.length >= 1 ? stages[stages.length - 1]!.name : "the final stage";
  const r = (myRole as ProjectRole | null) ?? null;
  const role = myRole || "viewer";
  // Render exactly what the canonical matrix (app/shared/rbac.ts) enforces for
  // THIS viewer's role — no aspirational copy that the server would 403.
  const rows: { k: string; v: string; icon: "user" | "flag" | "plus" | "message" | "cpu" | "lock" }[] = [
    { k: "Your role", v: role.charAt(0).toUpperCase() + role.slice(1), icon: "user" },
    {
      // E1: this was hardcoded "Every registered user" — false, and false on a
      // surface whose whole job is stating what the server enforces. A
      // signed-in non-member 404s on this page and on the comment POST;
      // membership is the gate, and every project role holds `comment` inside
      // it. Read from the matrix like every other row so it cannot drift again.
      k: "Comments",
      v: roleCan(r, "comment")
        ? "You can comment — every project member can"
        : "Project members only",
      icon: "message",
    },
    {
      k: "Task ownership",
      v: roleCan(r, "own-task")
        ? roleCan(r, "release-any-ownership")
          ? "Take / release · you can release anyone"
          : "Take / release your own seat"
        : "View only — contributor+ to own",
      icon: "plus",
    },
    {
      k: "Accept completion",
      v: roleCan(r, "accept-completion")
        ? "You can accept → Done"
        : ownsTask
          ? "You own this task — you can accept it → Done"
          : "Maintainer, admin, or the task's own owner",
      icon: "flag",
    },
    {
      k: "Run agents",
      v: roleCan(r, "run-agents") ? "You can run agents" : "Maintainer or admin only",
      icon: "cpu",
    },
    {
      k: `${reviewName} → ${terminalName}`,
      v: "Human decision, locked at the review boundary",
      icon: "lock",
    },
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="shield" />
        <h2>Permissions</h2>
        <span className="right sub fine xs">V1 rules</span>
      </div>
      <p className="fine xs perm-intro">
        Platform rules as they apply to <b>you on this task</b> — role grants,
        plus the owner authority R6-2 adds. This task's live stage, owner and
        waiting-on are in <b>Current state</b> above.
      </p>
      {rows.map((r) => (
        <div className="policy-line" key={r.k}>
          <span className="k">
            <Icon name={r.icon} />
            {r.k}
          </span>
          <span className="v">{r.v}</span>
        </div>
      ))}
      <Link
        className="btn ghost sm panel-act"
        to={`/projects/${projectSlug}/policy`}
      >
        <Icon name="shield" />
        View project policy
      </Link>
    </div>
  );
}

/** Sidebar "Current state" panel — stage (with governed transition menu),
 * waiting-on, owner controls, repo, and the two dispositions a human decides
 * here: accepting the completion (P14-LV-06) and archiving (R14-3). */
export function CurrentStatePanel({
  task,
  stage,
  meId,
  myRole,
  archived,
  acceptance,
  ownerBusy,
  onOwner,
  onRelease,
  onArchive,
  onAccept,
  acceptBusy: acceptSubmitting,
  dispositionBusy,
}: {
  task: TaskDetail;
  stage: TaskDetail["stages"][number] | undefined;
  meId: string;
  myRole: string | null;
  /** R14-3: this task is archived — the panel offers Restore instead. */
  archived: boolean;
  /** P14-LV-06: what this viewer may do about accepting, resolved server-side
   *  by the same predicate the review queue counts with. */
  acceptance: AcceptanceAffordance;
  ownerBusy: boolean;
  onOwner: (action: OwnerAction, member?: TaskMemberView) => void;
  onRelease: () => void;
  /** Open the archive confirm (archived === false) or restore immediately. */
  onArchive: () => void;
  /** F15-10: opens the accept CONFIRM dialog (the page owns the submission —
   *  accepting merges the PR, so it never fires on a bare click any more). */
  onAccept: () => void;
  /** The accept submission is in flight (page-owned fetcher). */
  acceptBusy: boolean;
  /** An accept / archive / restore submission is in flight. */
  dispositionBusy: boolean;
}) {
  const csrf = useCsrfToken();
  const transitionFetcher = useFetcher<ActionResult>();
  useActionFeedback(transitionFetcher);

  // Manual stage change from the Current-state dropdown (admin|maintainer; the
  // server re-checks). Goes through the same governed transition that an applied
  // operator recommendation does, so it posts the **Transition:** timeline
  // comment and hands the task to the operator at its new stage.
  const canTransition = roleCan(myRole as ProjectRole | null, "approve-transition");
  const canOwn = roleCan(myRole as ProjectRole | null, "own-task");
  // E3: releasing SOMEONE ELSE's seat is `release-any-ownership`, which is what
  // `releaseOwner` enforces — this asked `myRole === "admin"`, a hardcoded copy
  // of one row of the matrix.
  const canReleaseAnyOwner = roleCan(
    myRole as ProjectRole | null,
    "release-any-ownership",
  );
  const transitionBusy = transitionFetcher.state !== "idle";
  const onTransition = (toStageId: string) => {
    if (transitionBusy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "transition");
    fd.set("to", toStageId);
    transitionFetcher.submit(fd, { method: "post" });
  };

  const owner = task.owner && task.owner.kind === "human" ? task.owner : null;
  const ownerMine = !!(owner && owner.userId === meId);
  const acceptBusy = acceptSubmitting || dispositionBusy;
  const terminalName =
    task.stages.length > 0 ? task.stages[task.stages.length - 1]!.name : "Done";

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="bolt" />
        <h2>Current state</h2>
        {archived && (
          <span className="right">
            <Pill kind="neutral" sm>
              archived
            </Pill>
          </span>
        )}
      </div>
      <div className="kv">
        <div className="kv-row">
          <span className="k">Stage</span>
          <span className="v">
            {canTransition ? (
              <StageMenu
                stages={task.stages}
                currentStageId={task.stage}
                onSelect={onTransition}
                busy={transitionBusy}
              />
            ) : (
              <span className="stage-static">
                {/* The colour is the STAGE's, so it stays in the markup; the
                    size is a design decision and lives in the sheet. */}
                <span
                  className="col-stage-dot sm"
                  style={{ background: stage?.color }}
                />
                {stage?.name ?? ""}
              </span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Waiting on</span>
          <span className="v">
            {task.waiting === "human" ? (
              // F17-2: name WHERE the decision lives without asserting WHICH one
              // (that is state-dependent — a packet, a stage move, or acceptance).
              // A wrong specific hint would mislead; this tooltip is always true.
              <span
                className="by-human"
                title="A human decision is needed — see the decision packet, the stage control, or the acceptance action on this page."
              >
                Human decision
              </span>
            ) : task.waiting === "agent" ? (
              <span className="by-agent">Agent work</span>
            ) : (
              "Nothing"
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Owner</span>
          <span className="v">
            {owner ? (
              <span
                className="rev-stack"
                title="Human owner — reviews & accepts, this task only"
              >
                <Avatar person={owner} />
                <span className="rs-names">
                  {owner.name.split(" ")[0]}
                  {ownerMine ? " (you)" : ""}
                </span>
                {((ownerMine && canOwn) || canReleaseAnyOwner) && (
                  <button
                    type="button"
                    className="own-x"
                    title={
                      ownerMine
                        ? "Release ownership"
                        : "Release " + owner.name.split(" ")[0] + " (admin)"
                    }
                    aria-label="Release owner"
                    onClick={onRelease}
                  >
                    <Icon name="x" />
                  </button>
                )}
              </span>
            ) : canOwn ? (
              // Q5 clean tiering: only contributor+ may hold the owner seat
              // (setOwner enforces `own-task`). Viewers are read + comment, so
              // hide "Assign me" rather than render a button that 403s.
              <button
                type="button"
                className="rev-add sm"
                disabled={ownerBusy}
                onClick={() => onOwner("take")}
              >
                <Icon name="plus" />
                Assign me
              </button>
            ) : (
              <span className="v sub">Unowned</span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Repo</span>
          <span className="v mono">{task.repo}</span>
        </div>
      </div>
      {/* P14-LV-06: the acceptance the review queue promises. It renders for a
          viewer who HOLDS acceptance authority here (maintainer+, or this task's
          own owner per R6-2/R14-2) once the task stands at the boundary a
          completion can be accepted from — never as an inert button, and never
          silently absent while the queue says "waiting on your acceptance".
          F15-19: the refusal TEXT renders whenever one exists, boundary or not —
          a silent refusal is how an unreviewed merge looked like a hang. */}
      {acceptance.hasAuthority &&
        !archived &&
        (acceptance.atBoundary || acceptance.blockedReason) && (
          <div className="state-acts">
            {acceptance.atBoundary && (
              <button
                type="button"
                className="btn primary sm full"
                disabled={!acceptance.canAccept || acceptBusy}
                onClick={onAccept}
              >
                <Icon name="check" />
                {acceptBusy
                  ? "Accepting — merging the review PR…"
                  : `Accept completion → ${terminalName}`}
              </button>
            )}
            {acceptance.blockedReason && (
              // The reason has to be TEXT, not a `title`: a disabled control gets
              // no pointer events, so a tooltip on it never opens (P14-LV-08).
              <p className="deny-note">
                <Icon name="alert" />
                <span>
                  {/* R16-3: "Not acceptable yet" is the right frame for a
                      process gate and the wrong one for a closed PR — nothing
                      about waiting makes that acceptable. The reason itself is
                      the server's (one source); only the framing and the
                      pointer at the recovery decision are this surface's. */}
                  <strong>
                    {acceptance.terminallyBlocked
                      ? "Acceptance is closed."
                      : "Not acceptable yet."}
                  </strong>{" "}
                  {acceptance.blockedReason}
                  {acceptance.terminallyBlocked && task.packet && (
                    <> The decision on this task carries the recovery paths.</>
                  )}
                </span>
              </p>
            )}
          </div>
        )}
      {/* R14-3: the honest ending for abandoned work — the one the closed-PR
          guidance has been naming since pass 13. Board-management authority
          (`approve-transition`), the same tier that moves a task between
          stages; hidden for everyone else rather than rendered inert. */}
      {canTransition && (
        <div className="state-acts">
          <button
            type="button"
            className="btn ghost sm full"
            disabled={dispositionBusy}
            onClick={onArchive}
          >
            <Icon name={archived ? "refresh" : "lock"} />
            {archived ? "Restore from archive" : "Archive task"}
          </button>
          <p className="hint archive-hint">
            {archived
              ? "Archived — off the board and out of the review queue. Restoring puts it back where it stood, waiting on a human."
              : "Keeps the record, takes the task off the board and out of the review queue. Reversible."}
          </p>
        </div>
      )}
    </div>
  );
}
