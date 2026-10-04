import { useId, useState, type ReactNode } from "react";
import { holdEntriesSentence, type DependencyRender } from "~/shared/dependencies";
import { escapeRegExp } from "~/shared/text/regexp";
import { unpushedRevisionOf } from "~/schemas/task-file.schema";
import type { TaskDetail } from "~/server/projections/task-query.server";
import { Avatar } from "~/ui/avatar";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon, type IconName } from "~/ui/icon";
import { Pill, type PillKind } from "~/ui/pill";
import { StageMenu } from "~/ui/stage-menu";
import { LocalDayDotTime, LocalRelative } from "~/ui/local-time";
import { PROJECT_ROLES, roleCan, type ProjectRole } from "~/shared/rbac";
import { stageLabel } from "~/shared/workflow/stage-label";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import {
  checksPill,
  gatesPill,
  liveMergeable,
  mergeablePill,
  prStatePill,
  reviewPill,
  type PillView,
} from "~/features/github/github-pills";
import type { GatesView } from "~/shared/project-gates";
import { useAttachmentLightbox } from "./attachment-lightbox";
import { GateResults } from "./gate-results";
import type { OwnerAction, TaskMemberView } from "./execution-profile";

/**
 * The task-detail SIDE column: Current state (the next action) and the GitHub
 * trace; Details, the column's last panel, is `task-details-panel.tsx`
 * (ruling 501). Split out of `task-detail-page.tsx` (pass 16, pure
 * structural refactor). The Permissions panel that used to close the column
 * — the viewer's role grants restated row by row — is gone (owner, 2026-09-08,
 * ruling 167): what a person may do here is said where they would do it.
 */

/** Ruling 511: a signal's mark, from its pill tone, in the circle family
 *  (ruling 365): a check for a pass, a cross for a failure, the dotted ring
 *  for a wait (ruling 499), a plain ring for the rest; a risk is the alert. */
function signalGlyph(kind: PillKind): IconName {
  switch (kind) {
    case "done":
    case "ready":
      return "checkcircle";
    case "blocked":
      return "xcircle";
    case "risk":
      return "alert";
    case "input":
      return "todo";
    default:
      return "ring";
  }
}

/**
 * Ruling 511: one row of the PR card's status list, drawn the way GitHub's
 * merge box draws a check: the mark in the pill vocabulary's tone
 * (`github-pills.ts`, so the words and the tones are the ones every other
 * surface prints), the state as the row's title, and what it rests on under
 * it. A plain function rather than a component: the rows are static markup,
 * and a component each would add a render per row to every revalidation
 * (ruling 457).
 */
function prSignal({
  signal,
  view,
  glyph,
  detail,
  aside,
  children,
}: {
  /** What the row reports, for the sheet and the tests. */
  signal: string;
  view: PillView;
  /** The mark, when the tone's own would say less than this one. */
  glyph?: IconName;
  detail?: ReactNode;
  /** A control at the end of the title line. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="pr-sig" data-signal={signal} data-kind={view.kind}>
      <Icon name={glyph ?? signalGlyph(view.kind)} />
      <div className="pr-sig-main">
        <div className="pr-sig-head">
          <p className="pr-sig-title">{view.label}</p>
          {aside}
        </div>
        {detail && <p className="pr-sig-desc">{detail}</p>}
        {children}
      </div>
    </li>
  );
}

/** The layout hands these panels `myRole` as a raw string. Decode it to the
 *  domain role once, so every matrix read asks about a role the matrix knows —
 *  anything else is no role at all, exactly as `roleCan` already treats it. */
function viewerRole(myRole: string | null): ProjectRole | null {
  return PROJECT_ROLES.find((role) => role === myRole) ?? null;
}

/** Ruling 134(c): the push control's label, with its own busy text and tooltip. */
const PUSH_LABEL = (rev: string, prNumber: number): string =>
  `Push ${rev} to PR #${prNumber}`;
/** Ruling 160 (pass 35, F35-11): the refusal the server gives a delivery over a
 *  pull request a person closed without merging, said on the control rather than
 *  after the click. The server's own sentence is `closedByHumanDeliveryText`;
 *  this is its client half, so the card never offers a door that then 409s. */
const CLOSED_PR_DELIVERY_REFUSAL = (
  prNumber: number,
  closedBy: string | null,
): string =>
  `PR #${prNumber} was closed without merging${closedBy ? ` by ${closedBy}` : ""}. ` +
  `A closed pull request is a person's decision about the task, so Viberr opens no new ` +
  `pull request for this branch until the closed-PR decision is answered. Reopening PR ` +
  `#${prNumber} on GitHub lifts the block too.`;
/** The refusal the server would give a plain push of a diverged branch.
 *  Exported with no importer on purpose: exported, the build inlines it at its
 *  one use; module-local, it ships as a variable, 6 B more on the budgeted
 *  project.task closure (ruling 457's ratchet; measured for ruling 458(g)). */
export const DIVERGED_PUSH_REFUSAL =
  "Origin's copy of this branch holds commits the workspace does not, so a plain push would be refused as non-fast-forward. Resolve the branch history first; the operator can open a decision packet for it.";

export function GithubTrace({
  task,
  githubHost,
  acceptance,
  reconciledAt = null,
  checkedAt = null,
  onCompleteMerge,
  onForceAccept,
  onDeliver,
  delivering = false,
  runIntent = null,
  onRunGates,
  runningGates = false,
  attachmentsBase = null,
}: {
  task: TaskDetail;
  /** GitHub web host for browse links — always the loader's `githubWebHost()`
   *  (P14-UI-11: no client-side default, so the literal lives in one place). */
  githubHost: string;
  /** UX19-2: the SAME live acceptance affordance the Current-state panel below
   *  renders. This panel used to read the gate from `task.blockReason` — the
   *  projection column that deliberately carries only the REVISION dimension
   *  (rebuilder.server.ts: "the stage boundary … stays out of this column") —
   *  so on any delivered-but-unreviewed pre-boundary task the two adjacent
   *  panels named different gates: "Acceptance is blocked: no approving verdict
   *  yet" here, "Not acceptable yet — at In Progress, not Review" one panel
   *  down. One source, one sentence, no contradiction. */
  acceptance: Pick<
    AcceptanceAffordance,
    "atBoundary" | "blockedReason" | "terminallyBlocked" | "gates"
  >;
  /** UI-57: ISO of the newest `github.reconcile` PROVENANCE row for THIS task —
   *  i.e. the last pass that actually CHANGED something, not the last pass that
   *  ran. DG-3 (github-reconciler.server.ts: `if (changed ||
   *  !ctx.skipUnchangedProvenance)`) deliberately skips the row on an unchanged
   *  poller tick to bound table growth, so a healthy task whose GitHub state is
   *  stable has no fresh row at all. Null = no change has ever been recorded.
   *
   *  F19-22: this used to be labelled "Synced" under a tooltip promising a
   *  5-minute poller — live-proven contradiction (panel "Synced 1h ago" at
   *  12:42Z while `audit_events` held successful `github.reconcile.task` passes
   *  at 12:07 … 12:42). The row now names the quantity it actually holds, and
   *  `checkedAt` below supplies the half it never had. */
  reconciledAt?: string | null;
  /** F19-22 (second half): ISO of the newest COMPLETED reconcile pass for this
   *  task — `MAX(occurred_at)` over the `github.reconcile.task` AUDIT rows
   *  (`server/audit/audit-query.server.ts`). That write is unconditional and
   *  sits after every early return in `reconcileTaskExclusive`, so a row exists
   *  iff a pass ran to completion, changed or not: it is the only fact in the
   *  app that can tell a human the poller is alive. Rendered as its own row
   *  because it answers a different question from `reconciledAt` — "we looked"
   *  vs "something moved" — and collapsing them is exactly the conflation this
   *  finding is about.
   *
   *  Null = no completed pass on record (audit retention is 90 days). That is
   *  NOT "never synced", and the copy must not say so. */
  checkedAt?: string | null;
  /** F19-24: OPEN the merge confirm for an accepted (merge-pending) PR (S2).
   *  Never the submitter — completing the merge is the real, irreversible
   *  GitHub merge and the mandatory human half of every full-autonomy operator
   *  acceptance (R16-6), so ruling 20's dialog binds here exactly as it does on
   *  the Accept button. */
  onCompleteMerge?: () => void;
  /** Admin override of a stuck acceptance gate (DG-2); admin-only, undefined
   *  otherwise. Also opens the confirm, never submits. */
  onForceAccept?: () => void;
  /** R15-2 safety net (b): perform delivery (push + review PR) by hand —
   *  maintainer+ or the task owner; undefined hides the control. */
  onDeliver?: () => void;
  delivering?: boolean;
  /** Ruling 368: the intent the task page's run fetcher is carrying (it also
   *  carries interrupt and retry), null while idle. Complete merge and Force
   *  accept wait on any of them and show the work when it is theirs. */
  runIntent?: string | null;
  /** Ruling 482: queue the project's gates on the revision under review again
   *  (maintainer+ or the owner, the manual delivery's tier); undefined hides
   *  the control. */
  onRunGates?: () => void;
  runningGates?: boolean;
  /** The attachments route's base, so each gate's log opens where it lives.
   *  Null renders the log names as text. */
  attachmentsBase?: string | null;
}) {
  const merging = runIntent !== null;
  const completingMerge = runIntent === "complete-merge";
  const forcing = runIntent === "force-accept";
  // Ruling 134(c) / 135: the recorded unpushed revision, current only.
  const unpushed = unpushedRevisionOf(task.pr, task.workRevisionSha ?? null);
  const prTerminal =
    !task.pr || task.pr.state === "closed" || task.pr.state === "merged";
  // Ruling 160: `closed` is terminal, so the delivery control is offered — and
  // the server refuses it while nobody has answered the closure. The whole
  // `PrRef` reaches this page (`pr_json`), so the refusal is derivable here and
  // is said on the control, the way the diverged push below is.
  const closedRefusal =
    task.pr && task.pr.state === "closed" && !task.pr.closure?.answered
      ? CLOSED_PR_DELIVERY_REFUSAL(task.pr.number, task.pr.closure?.by ?? null)
      : null;
  const pushOffer =
    task.pr && !prTerminal && unpushed
      ? {
          prNumber: task.pr.number,
          rev: unpushed.revisionSha.slice(0, 7),
          head: unpushed.prHeadSha ? unpushed.prHeadSha.slice(0, 7) : null,
          relation: unpushed.relation,
        }
      : null;
  // Admin escape hatch (DG-2): acceptance is wedged either by the acceptance gate
  // itself (`acceptance.blockedReason` — the live, full-order refusal) OR by an open
  // blocked decision packet a crashed run left behind. Surfaced for admins
  // (onForceAccept present) regardless of branch/PR, so a no-branch pre-work wedge is
  // still escapable.
  //
  // F18-13: but never on a task that is ALREADY terminal. Force-accept BYPASSES the
  // verdict gate (it never satisfies it), so the refusal persists after the task is
  // accepted into Done — the card kept offering "Force accept (override review gate)"
  // and "Acceptance is blocked …" on a task with nothing left to accept. A terminal
  // task withdraws the affordance, and so does R16-3's terminal GitHub fact (a closed,
  // unmerged PR is decided, not wedged — there is nothing to override).
  const isTerminal =
    task.displayReadiness === "accepted" || task.displayReadiness === "merged";
  // Ruling 124: force-accept is an escape hatch, not a standing offer. It stays
  // visible OFF-BOUNDARY (ruling 59 — a pre-work wedge must be escapable), but a
  // task with nothing to accept cannot be wedged yet: before ruling 124 every
  // non-terminal task showed an admin "skips the remaining stages and the review
  // gate" in its GitHub card, ten seconds after creation, directly above "No
  // branch yet" and directly under "Not acceptable yet … move it through the
  // workflow first". "Escapable" is the test, so a task that IS wedged still
  // offers it with no branch at all: an open BLOCKED packet is a wedge (a
  // crashed run's recovery packet), and so is any work to accept — a branch, a
  // pull request, or a delivered revision. What goes away is the standing offer
  // on a task where nothing has happened yet.
  const wedgedOrDelivering = Boolean(
    task.branch ?? task.pr ?? task.workRevisionSha ?? null,
  ) || task.packet?.type === "blocked";
  const forceAcceptReason =
    isTerminal || acceptance.terminallyBlocked || !wedgedOrDelivering
      ? null
      : (acceptance.blockedReason ??
        (task.packet?.type === "blocked"
          ? "An open blocked decision is holding this task."
          : null));
  // UX19-2 / R19-5: force-accept from BEFORE the review boundary really does jump
  // the task straight to Done and merge (the stage gate is inside the block
  // `force` skips). The owner ruled the skip LEGAL, and the silence about it the
  // defect — so the offer STAYS off-boundary (a pre-work wedge must be escapable;
  // there is no off-boundary hiding), and the label names the skip instead of
  // promising only a "review gate" override. The confirm dialog enumerates the
  // skipped stages by name; the `!acceptance.terminallyBlocked` guard (folded
  // into `forceAcceptReason`) is the only withdrawal — a closed PR is decided
  // (R16-3), not wedged.
  const skipsStages = !acceptance.atBoundary;
  // C1: the refusal sentence has ONE owner — the Current-state panel, where
  // the Accept button lives. It used to render here too ("Acceptance is
  // blocked: …"), byte-identical to the Current-state deny-note ~350px away; a
  // prior pass fixed the two DISAGREEING and left them duplicates. This panel
  // keeps only the GitHub-side fact: the admin override itself, whose button
  // already names what it does.
  const forceAcceptRow =
    forceAcceptReason && onForceAccept ? (
      <button
        type="button"
        // Ruling 149: force-accept is destructive, and the confirmation it
        // opens already commits in red.
        className="btn ghost sm full danger"
        disabled={merging}
        aria-busy={forcing || undefined}
        onClick={onForceAccept}
        title={
          skipsStages
            ? `Admin override: accept ${task.key} into Done from here, skipping the remaining stages AND the review gate, and merge. Audited.`
            : "Admin override: accept this task into Done past the review gate. Audited."
        }
      >
        <GlyphSwap rest="shield" alt="loader" on={forcing} spinAlt />
        {forcing
          ? "Force-accepting…"
          : skipsStages
            ? "Force accept (skips the remaining stages and the review gate)"
            : "Force accept (override review gate)"}
      </button>
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
        {forceAcceptRow && <div className="pr-acts">{forceAcceptRow}</div>}
      </div>
    );
  }
  // Real external links (spec §4.9: the prototype toast goes away). Ruling
  // 511: the pull request's title opens it, and the branch opens its tree;
  // they are the card's "Open on GitHub", which stood as a third full-width
  // button under the other two.
  //
  // P14-UI-11 residual: this used to carry its own `?? "https://github.com"`
  // fallback, so the app held the host literal in TWO places while the fix note
  // in `github-query.server.ts` designated ONE thread-through point for a real
  // GHE base URL. The loader always sends `githubWebHost()`, so the prop is
  // required and the second literal is gone.
  const host = githubHost;
  const prHref = task.repo && task.pr ? `${host}/${task.repo}/pull/${task.pr.number}` : null;
  const treeHref = task.repo && task.branch ? `${host}/${task.repo}/tree/${task.branch}` : null;
  // UI-36: reuse the shared PR-state mapping. This branched only on
  // `merged`/`accepted`, so a PR CLOSED WITHOUT MERGING (a rejected one — a
  // first-class state since NEW-1) rendered as a blue "PR #14", visually
  // identical to a PR still in review. The GitHub page and the review queue
  // have always rendered it correctly.
  const prState = task.pr ? prStatePill(task.pr.state) : null;
  const prName = task.pr && (
    <>
      {task.pr.title.trim() || "Pull request"}{" "}
      <span className="pr-num">#{task.pr.number}</span>{" "}
    </>
  );
  const branchChip = task.branch && (
    <>
      <Icon name="branch" />
      {task.branch}
    </>
  );
  // P13-D-28: the two GitHub facts the app fetched (or could have) and never
  // showed. Check-runs were summarized on every reconcile pass and read by
  // nothing; review state was never read at all, so a teammate approving or
  // requesting changes on GitHub was invisible here and a merge blocked by
  // required reviews surfaced only as a late 405.
  const checks = task.prChecks ? checksPill(task.prChecks) : null;
  const review = task.prReview ? reviewPill(task.prReview) : null;
  // Ruling 162 (pass 35, F35-12 (c)): the conflict the acceptance gate refuses
  // on, on the task page too. It was rendered on the GitHub page alone, so this
  // card read "PR #16 · in review" while the accept click answered 409. The
  // reconciler drops the fact for a settled PR, so a merged or closed one never
  // carries it. Ruling 405(b): through `liveMergeable`, not off the raw field.
  // The GitHub page and the review queue both read the verdict's head pin, and
  // a task page reporting "conflicts" over the commit that resolved it would
  // disagree with them and with the acceptance gate.
  const conflict = task.pr ? mergeablePill(liveMergeable(task.pr)) : null;
  const signals = Boolean(
    task.unownedPr !== null || acceptance.gates || checks || review || conflict || pushOffer,
  );
  // R15-2 safety net (b): with delivery now an operator decision, a human with
  // authority can always ship the branch by hand — offered when no live PR
  // stands (none yet, or the last one closed/merged) and, since ruling 134(c),
  // whenever the open PR does not carry the delivered revision: the same door
  // pushes the revision to that PR. A DIVERGED remote gets the fact and a
  // disabled control naming the refusal the server would give, never a button
  // that then fails.
  const offersDelivery = Boolean(onDeliver && (prTerminal || pushOffer));
  // F19-24: this is a Done writer — it finishes the acceptance by performing
  // the irreversible merge, and it is the mandatory human half of EVERY
  // full-autonomy operator acceptance (R16-6). It used to merge on a bare click
  // while the sibling force-accept one line down was already wrapped in the
  // confirm. `onCompleteMerge` opens the same ceremony now; the label names the
  // outcome, the dialog names the PR, the target branch and any commits pushed
  // since the review.
  const mergePr = task.pr?.state === "accepted" && onCompleteMerge ? task.pr : null;
  return (
    <div className="panel flush pr-card">
      {/* Ruling 511: the inverted bar stays the card's head (the owner, on
          the first draft without it: "the old white/black headers were
          looking good"), holding the mark, the repository and the state. The
          other pills it carried are the status rows below. */}
      <div className="gh-bar">
        {/* Ruling 478(f) (F40-35): the panel's name, for heading navigation.
            The mark and the repository already say it to the eye; without
            this the panel was the one region of the page a screen reader's
            heading list could not reach once the task had a branch. */}
        <h2 className="vh">GitHub</h2>
        <Icon name="github" />
        {task.repo && <span className="repo">{task.repo}</span>}
        {/* Filled whatever its tier, as the bar always drew it: the quiet
            outline's ink is made for --surface and fades on the bar. */}
        {prState ? (
          <Pill kind={prState.kind} sm>
            {prState.label}
          </Pill>
        ) : (
          <Pill kind="neutral" sm>
            no PR
          </Pill>
        )}
      </div>
      <div className="pr-id">
        {task.pr && (
          <p className="pr-title">
            {prHref ? (
              <a href={prHref} target="_blank" rel="noreferrer">
                {prName}
                <span className="vh">on GitHub</span>
                <Icon name="ext" />
              </a>
            ) : (
              prName
            )}
          </p>
        )}
        {(task.branch || task.changed) && (
          <p className="pr-src">
            {branchChip &&
              (treeHref ? (
                <a className="pr-branch" href={treeHref} target="_blank" rel="noreferrer">
                  {branchChip}
                </a>
              ) : (
                <span className="pr-branch">{branchChip}</span>
              ))}
            {task.changed && (
              <span className="pr-diff">
                {/* LV-09: "Diff 1 files" */}
                {task.changed.files} {task.changed.files === 1 ? "file" : "files"}{" "}
                <span className="diff-add">+{task.changed.add}</span>{" "}
                <span className="diff-del">−{task.changed.del}</span>
              </span>
            )}
          </p>
        )}
      </div>
      {signals && (
        <ul className="pr-sigs">
          {/* F31-1: while an unrelated PR squats on this task's branch name
              (R15-15), the branch on GitHub is a STRANGER — say so instead of
              leaving the panel to read as this task's footprint. The
              reconciler no longer records the stranger's stats, so `changed`
              and `commits` are this task's own honest cache (usually empty
              pre-work). */}
          {task.unownedPr !== null &&
            prSignal({
              signal: "collision",
              view: { kind: "risk", label: "Branch collision" },
              detail: (
                <>
                  PR <span className="mono">#{task.unownedPr}</span> holds this branch name but
                  is not this task&rsquo;s review PR
                </>
              ),
            })}
          {/* Ruling 482: what Viberr's own run of the project's gates says
              about the revision under review, beside what GitHub's checks
              say. */}
          {acceptance.gates && (
            <GatesRow
              gates={acceptance.gates}
              attachmentsBase={attachmentsBase}
              {...(onRunGates ? { onRunGates } : {})}
              running={runningGates}
            />
          )}
          {checks &&
            prSignal({ signal: "checks", view: checks, detail: "GitHub's check runs on this pull request" })}
          {review && prSignal({ signal: "review", view: review, detail: "GitHub's review decision" })}
          {conflict &&
            prSignal({ signal: "conflicts", view: conflict, detail: "GitHub can't merge it into the base branch" })}
          {/* Ruling 135: the delivered revision is not on the open PR. Named
              among the PR's signals so the push control below reads from a
              fact. */}
          {pushOffer &&
            prSignal({
              signal: "unpushed",
              view: { kind: "input", label: "Unpushed revision" },
              glyph: "upload",
              detail: (
                <>
                  <span className="mono">{pushOffer.rev}</span> is not on PR{" "}
                  <span className="mono">#{pushOffer.prNumber}</span>
                  {pushOffer.head ? (
                    <>
                      {" "}(its head is <span className="mono">{pushOffer.head}</span>)
                    </>
                  ) : null}
                </>
              ),
            })}
        </ul>
      )}
      {task.commits.length > 0 && (
        <div className="pr-commits">
          {/* P16-F3: `.flabel` IS these six declarations — the inline copy
              was a second source for the same section-label treatment. */}
          <div className="flabel">Commits</div>
          <ul className="commit-rows">
            {task.commits.map((c) => (
              <li className="commit" key={c.sha}>
                <span className="msg">{c.msg}</span>
                <span className="sha">{c.sha}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Ruling 179 (pass 36, F36-7): the `[KEY]` filter above hid the very
          commits that move a reviewed head — a stranger's push sat on the
          branch and this card showed only the task's own. Named apart, not
          mixed in. */}
      {task.otherCommits.length > 0 && (
        <div className="pr-commits" data-other-commits>
          <div className="flabel">Also on the branch · not this task's</div>
          <ul className="commit-rows">
            {task.otherCommits.map((c) => (
              <li className="commit" key={c.sha}>
                <span className="msg">{c.msg}</span>
                <span className="sha">{c.sha}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(offersDelivery || mergePr || forceAcceptRow) && (
        <div className="pr-acts">
          {offersDelivery && closedRefusal && (
            <p className="deny-note" id="deliver-closed-refusal">
              <Icon name="alert" />
              {closedRefusal}
            </p>
          )}
          {offersDelivery && (
            <button
              type="button"
              className="btn primary sm full"
              disabled={delivering || pushOffer?.relation === "diverged" || !!closedRefusal}
              aria-busy={delivering || undefined}
              aria-describedby={closedRefusal ? "deliver-closed-refusal" : undefined}
              onClick={onDeliver}
              title={
                closedRefusal
                  ? closedRefusal
                  : pushOffer?.relation === "diverged"
                    ? DIVERGED_PUSH_REFUSAL
                    : pushOffer
                      ? "Push the delivered revision to the open review PR (audited)"
                      : "Push the delivering agent's branch and open the review PR (audited)"
              }
            >
              <GlyphSwap rest="branch" alt="loader" on={delivering} spinAlt />
              {pushOffer
                ? delivering
                  ? "Pushing…"
                  : PUSH_LABEL(pushOffer.rev, pushOffer.prNumber)
                : delivering
                  ? "Delivering…"
                  : "Deliver branch & open PR"}
            </button>
          )}
          {mergePr && (
            <button
              type="button"
              className="btn primary sm full"
              disabled={merging}
              aria-busy={completingMerge || undefined}
              onClick={onCompleteMerge}
              title={`Review and run the real GitHub merge for PR #${mergePr.number} (needs a valid project credential)`}
            >
              <GlyphSwap rest="check" alt="loader" on={completingMerge} spinAlt />
              {completingMerge ? "Merging…" : "Complete merge"}
            </button>
          )}
          {forceAcceptRow}
        </div>
      )}
      {/* F19-22 (second half): the honest freshness cue is TWO facts, and the
          panel could previously only hold one. "Checked" comes off the
          per-tick `github.reconcile.task` audit row — the last pass that
          completed, whether or not it found anything — so a human can tell a
          quiet branch from a dead poller. "Last change" below stays the
          provenance row DG-3 skips on unchanged ticks. Two rows, not one
          merged sentence: they go stale independently, and the whole defect
          was one number being read as the other. Ruling 511: they close the
          card in small print, because they say how fresh the card is, not
          what the pull request needs. */}
      <div className="pr-facts">
        <div className="kv-row">
          <span className="k">Checked</span>
          <span
            className="v"
            title="When a reconcile pass for this task last completed. A background poller re-checks branched tasks roughly every 5 minutes, and a pass that finds nothing new is still a check: it just records no change."
          >
            {checkedAt ? (
              <time dateTime={checkedAt}>
                <LocalRelative iso={checkedAt} />
              </time>
            ) : (
              // Deliberately not "never synced": the app knows only that no
              // completed pass is on record (audit rows are kept 90 days).
              "no completed pass on record"
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Last change</span>
          <span
            className="v"
            title="Branch, diff, commits and PR state above are served from the cached projection. This is when that cache last CHANGED: a background poller re-checks GitHub every 5 minutes and records nothing on a pass that finds nothing new, so an older time here means a quiet branch. The Checked row above says when GitHub was last read."
          >
            {reconciledAt ? (
              <time dateTime={reconciledAt}>
                <LocalRelative iso={reconciledAt} />
              </time>
            ) : task.pr || task.commits.length > 0 ? (
              // F15-02: PR/commit facts on screen came from delivery-time
              // writes, not a reconcile pass — "not yet synced" next to a live
              // PR read as a contradiction. Say what is actually true.
              "recorded at delivery (nothing has changed since)"
            ) : (
              // F19-22: NOT "not yet synced with GitHub". Under DG-3 an absent
              // provenance row is silent about whether a pass ever ran — it only
              // says none of them found anything to write. Claiming "never
              // synced" from it is the same lie the "Synced Nh ago" label told,
              // just in the other direction.
              "nothing recorded yet"
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Ruling 482 (F40-52): the PR card's gate record — "Gates on a95c337: 4/4 exit
 * 0 (run by Viberr)" — with each gate's outcome, time and log, and the control
 * that runs them again. The line is the server's (`projectGatesView`), so the
 * card, the accept dialog, the refusal and every agent's anchor say the same.
 * Ruling 511: it is the first of the card's status rows, and a pass folds its
 * table behind "Show all"; anything short of a pass keeps the table open,
 * because then it is the table that says what to do.
 */
function GatesRow({
  gates,
  attachmentsBase,
  onRunGates,
  running,
}: {
  gates: GatesView;
  attachmentsBase: string | null;
  onRunGates?: () => void;
  running: boolean;
}) {
  const lightbox = useAttachmentLightbox();
  const tableId = useId();
  const [open, setOpen] = useState(false);
  const inFlight = gates.state === "queued" || gates.state === "running";
  const folds = gates.state === "passed" && gates.rows.length > 0;
  return prSignal({
    signal: "gates",
    view: gatesPill(gates.state),
    detail: <span role="status">{gates.line}</span>,
    aside: folds ? (
      <button
        type="button"
        className="pr-fold"
        aria-expanded={open}
        aria-controls={tableId}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? "Hide" : "Show all"}{" "}
        <span className="vh">gates</span>
        <Icon name="chevron" />
      </button>
    ) : null,
    children: (
      <>
        {gates.rows.length > 0 && (
          <div id={tableId} hidden={folds && !open}>
            <GateResults rows={gates.rows} attachmentsBase={attachmentsBase} openLog={lightbox} compact />
          </div>
        )}
        {gates.error && (
          <p className="deny-note">
            <Icon name="alert" />
            {gates.error}
          </p>
        )}
        {onRunGates && (
          <button
            type="button"
            className="btn ghost sm pr-run"
            disabled={running || inFlight}
            aria-busy={running || undefined}
            onClick={onRunGates}
            title="Run the project's gates on this revision again (audited)"
          >
            <GlyphSwap rest="refresh" alt="loader" on={running} spinAlt />
            {running ? "Queuing gates…" : gates.state === "not_run" ? "Run gates" : "Run gates again"}
          </button>
        )}
      </>
    ),
  });
}

/**
 * Ruling 520: the marks Current state leads its values with. Hoisted, so a
 * revalidation that re-renders the panel hands React the same elements and no
 * `Icon` renders again (ruling 457's no-op revalidation budget).
 */
const MARK = {
  hand: <Icon name="hand" />,
  clock: <Icon name="clock" />,
  ring: <Icon name="ring" />,
  ban: <Icon name="ban" />,
  activity: <Icon name="activity" />,
  github: <Icon name="github" />,
};

/**
 * Ruling 520: the hold's sentence with each entry's label on one line. In the
 * property grid's value column Chromium breaks a key after its hyphen ("VIB-"
 * over "151"), and no CSS property stops that; the words between the labels
 * still wrap.
 */
function holdSentenceKeepingLabels(entries: readonly DependencyRender[]): ReactNode {
  const sentence = holdEntriesSentence(entries);
  const labels = [...new Set(entries.map((e) => e.label).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (labels.length === 0) return sentence;
  // A capturing split: the labels land at the odd indices.
  return sentence
    .split(new RegExp(`(${labels.map(escapeRegExp).join("|")})`))
    .map((run, i) => (i % 2 === 1 ? <span key={i} className="hold-ref">{run}</span> : run));
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
  onTransition,
  transitionBusy,
  acceptInFlight,
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
  /** F19-37: pick a stage from the menu. Page-owned for the same reason
   *  `onAccept` is — a HUMAN move into the LAST stage IS an acceptance
   *  (task-transitions.server.ts: "A HUMAN manually moving a task INTO the
   *  final stage IS accepting completion" → acceptCompletion in
   *  task-acceptance.server.ts → the real PR merge), so the terminal pick has
   *  to reach the page's confirm state instead of submitting from inside this
   *  panel. Every other stage still submits straight through. */
  onTransition: (toStageId: string) => void;
  /** A stage transition is in flight (page-owned fetcher) — locks the menu. */
  transitionBusy: boolean;
  /** Ruling 368: the intent the page's accept fetcher is carrying (the
   *  acceptance itself, or ruling 449's refresh-and-review), null while idle.
   *  Accept shows the work only when it is the acceptance. */
  acceptInFlight: string | null;
  /** An archive / restore submission is in flight: the Archive button's own. */
  dispositionBusy: boolean;
}) {
  // E32-9: the owner seat follows the task's closed state (accepted or merged),
  // the same predicate the runtime controls read (execution-profile.tsx).
  const closed =
    task.displayReadiness === "accepted" || task.displayReadiness === "merged";
  // Manual stage change from the Current-state dropdown (admin|maintainer; the
  // server re-checks). Goes through the same governed transition that an applied
  // operator recommendation does, so it posts the **Transition:** timeline
  // comment and hands the task to the operator at its new stage. The submission
  // itself is the page's (`onTransition`) — see F19-37 on the prop.
  const role = viewerRole(myRole);
  const canTransition = roleCan(role, "approve-transition");
  const canOwn = roleCan(role, "own-task");
  // E3: releasing SOMEONE ELSE's seat is `release-any-ownership`, which is what
  // `releaseOwner` enforces — this asked `myRole === "admin"`, a hardcoded copy
  // of one row of the matrix.
  const canReleaseAnyOwner = roleCan(role, "release-any-ownership");
  const owner = task.owner && task.owner.kind === "human" ? task.owner : null;
  const ownerMine = !!(owner && owner.userId === meId);
  const accepting = acceptInFlight === "accept-completion";
  const acceptBusy = acceptInFlight !== null || dispositionBusy;
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
      {/* Ruling 520: the facts are the property grid Details draws (ruling
          501), one label column and every value on one left edge, each led
          by its mark: the stage's dot, who owes the next move in the board
          card's marks (ruling 365), the activity pulse, the owner's avatar,
          the GitHub mark. */}
      <div className="kv props">
        <div className="kv-row">
          <span className="k">Stage</span>
          <span className="v">
            {canTransition ? (
              <StageMenu
                stages={task.stages}
                currentStageId={task.stage}
                onSelect={onTransition}
                busy={transitionBusy}
                align="start"
              />
            ) : (
              <span className="stage-static">
                {/* The colour is the STAGE's, named in the markup (ruling 364);
                    the sheet turns the name into paint and owns the size. */}
                <span
                  className="col-stage-dot sm"
                  data-stage-color={stage?.color}
                />
                {/* Ruling 148: the empty string left a bare coloured dot with
                    no words at all. Same phrase as the stage menu. */}
                {stageLabel(stage)}
              </span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Waiting on</span>
          <span className="v">
            {task.packet?.awaiting === "goal_edit" ? (
              // Ruling 138: a decided edit_goal packet owes exactly one thing.
              <span
                className="prop-fact by-human"
                title="An edit-goal decision was confirmed; saving the edited goal clears the packet."
              >
                {MARK.hand}
                a goal edit
              </span>
            ) : task.waiting === "human" ? (
              // F17-2: name WHERE the decision lives without asserting WHICH one
              // (that is state-dependent — a packet, a stage move, or acceptance).
              // A wrong specific hint would mislead; this tooltip is always true.
              // C4: the copy is the ONE project-scope phrase the board's card and
              // subtitle also use — "waiting on a human" ("Waiting on" + "a
              // human") — collapsing the five spellings the app had for "a human
              // owes something". This rail deliberately does NOT personalise to
              // "you" (ruling 10 / R8-3 reserves the viewer-scoped "waiting on
              // you" for surfaces that resolve the viewer, which this one never
              // did); the project phrase is the correct one here.
              <span
                className="prop-fact by-human"
                title="A human decision is needed: see the decision packet, the stage control, or the acceptance action on this page."
              >
                {MARK.hand}
                a human
              </span>
            ) : task.waiting === "schedule" ? (
              // Ruling 225 (F37-45): the rail's job is to name who owes
              // something. Nobody does — a schedule will pick this task back
              // up. Saying "a human" here was the same false demand the board
              // card made, one surface over.
              <span
                className="prop-fact by-schedule"
                title="No decision is needed: a scheduled run picks this task back up on its own. The Schedules panel below can change or cancel it."
              >
                {MARK.clock}
                {/* One run of text, so the time stays beside its words
                    rather than a flex gap away from them. */}
                <span>
                  {task.resumesAt ? (
                    <>
                      a schedule · <LocalDayDotTime iso={task.resumesAt} />
                    </>
                  ) : (
                    "a schedule"
                  )}
                </span>
              </span>
            ) : task.waiting === "agent" && task.liveRun === "queued" ? (
              // Ruling 349: the run is parked behind the cap; nothing streams,
              // so the board's ring rather than its pulse.
              <span
                className="prop-fact by-agent"
                title="Behind the instance's concurrent-run cap; it starts when a slot frees."
              >
                {MARK.ring}
                Agent queued
              </span>
            ) : task.waiting === "agent" ? (
              <span className="prop-fact by-agent">
                <span className="working" />
                Agent work
              </span>
            ) : task.blockedBy.length > 0 ? (
              // Ruling 131(a): a held task owes nobody anything; what it waits
              // on is other work, named with each entry's live state.
              <span
                className="prop-fact"
                title={task.blockedBy.map((e) => `${e.label} · ${e.state}`).join(" · ")}
              >
                {MARK.ban}
                <span>Other work: {holdSentenceKeepingLabels(task.blockedBy)}</span>
              </span>
            ) : (
              <span className="prop-empty">Nothing</span>
            )}
          </span>
        </div>
        {/* Gap-10 — last activity, ALWAYS on, unlike the board's threshold-gated
            cue. This is the detail surface; a supervisor who has opened the task
            is asking history questions, and "when did anything last happen here"
            had no answer anywhere in the app.
            The stamp is `task.lastActivityAt` — the newest TIMELINE event
            (`occurred_at`), not `task.updatedAt`. `updatedAt` is a file-write
            stamp bumped by bookkeeping nobody performed (the 5-minute GitHub
            reconcile poller re-stamps every branched task), so a dead task with
            an open PR would read "4m ago" forever. The full argument is on
            app/server/projections/task-activity.server.ts. */}
        <div className="kv-row">
          <span className="k">Last activity</span>
          <span
            className="v"
            title="The newest event on this task's timeline. Not the last time the task file changed: a background GitHub sync rewrites that without anything happening."
          >
            {task.lastActivityAt ? (
              <span className="prop-fact">
                {MARK.activity}
                <time dateTime={task.lastActivityAt}>
                  <LocalRelative iso={task.lastActivityAt} />
                </time>
              </span>
            ) : (
              <span className="prop-empty">Nothing on the timeline yet</span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Owner</span>
          <span className="v">
            {owner ? (
              <span
                className="rev-stack"
                // Ruling 127 widened what this seat means: the owner is still
                // the human reviewer and acceptance authority for this task,
                // and is now also WHOSE Claude and Codex accounts its agent
                // runs bill. The row that shows (and releases) the seat is
                // where that belongs.
                title="Human owner: reviews and accepts this task, and its agent runs use their own Claude and Codex accounts"
              >
                <Avatar person={owner} size="xs" />
                <span className="rs-names">
                  {owner.name.split(" ")[0]}
                  {ownerMine && <span className="rs-you"> (you)</span>}
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
            ) : canOwn && !archived && (!closed || canReleaseAnyOwner) ? (
              // Q5 clean tiering: only contributor+ may hold the owner seat
              // (setOwner enforces `own-task`). Viewers are read + comment, so
              // hide "Assign me" rather than render a button that 403s.
              // D32-16: an archived task's owner seat is frozen server-side
              // (restore first), so the affordance goes with it. E32-9 /
              // ruling 118: so is a CLOSED (accepted/merged) task's — live, a
              // Done task whose every other control read "task closed" still
              // offered it — except to an ADMIN, who may reassign for the
              // record (the release-any-ownership tier).
              // Ruling 520: the invitation Details makes for an empty value
              // it can fill ("Add dependency"), a ghost trigger at rest.
              <button
                type="button"
                className="prop-btn"
                disabled={ownerBusy}
                onClick={() => onOwner("take")}
              >
                <span className="prop-empty">
                  <Icon name="plus" />
                  Assign me
                </span>
              </button>
            ) : (
              <span className="prop-empty">Unowned</span>
            )}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Repo</span>
          <span className="v">
            <span className="prop-fact">
              {MARK.github}
              <span className="mono">{task.repo}</span>
            </span>
          </span>
        </div>
      </div>
      {/* Gap-10: the cue, once the stamp above has crossed its threshold. Stated
          as the two facts the detector actually has — an empty timeline and an
          empty run registry — and then the two real ways forward, because a
          quiet task is not broken, it is unattended. Archived and terminal tasks
          never reach here: `isQuiet` refuses them outright (R14-3 / UXO-1). */}
      {task.quiet && (
        <p className="hint">
          No activity. Nothing has been recorded on this task since then, and no
          run is in flight. It stays here until someone runs an agent or the
          operator, now or scheduled, from the Execution profile.
        </p>
      )}
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
                aria-busy={accepting || undefined}
                onClick={onAccept}
              >
                <GlyphSwap rest="check" alt="loader" on={accepting} spinAlt />
                {/* Ruling 368: only the acceptance's own request reads as it;
                    an archive or a refresh in flight leaves this waiting. */}
                {accepting
                  ? task.pr
                    ? "Accepting · merging the review PR…"
                    : "Accepting…"
                  : `Accept completion → ${terminalName}`}
              </button>
            )}
            {/* R19-B: the R15-1 verdict gate can be satisfied by a HUMAN's
                GitHub approval instead of an agent verdict. Name the person and
                the commit they approved — a gate a human cleared cannot just go
                green, or whoever accepts has no idea whose judgement they stand
                on (ruling 19). */}
            {acceptance.verdictSatisfiedBy && (
              <p className="hint">
                <Icon name="check" />
                {acceptance.verdictSatisfiedBy}
              </p>
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
            // Ruling 149: archiving is destructive and its own confirmation
            // commits in red, so the trigger carries the danger label too.
            // Restoring is a recovery action and stays neutral.
            className={"btn ghost sm full" + (archived ? "" : " danger")}
            disabled={dispositionBusy}
            aria-busy={dispositionBusy || undefined}
            onClick={onArchive}
          >
            {/* Ruling 459 over ruling 368: the archive mark (ruling 651) trades
                for the restore mark with the task's state, and that resting
                cell trades for the spinning loader while the disposition is in
                flight (GlyphSwap's `busy`), so neither change is a hard swap
                and there is only ever one loader. */}
            <GlyphSwap rest="archive" alt="refresh" on={archived} busy={dispositionBusy} />
            {archived
              ? dispositionBusy
                ? "Restoring…"
                : "Restore from archive"
              : dispositionBusy
                ? "Archiving…"
                : "Archive task"}
          </button>
          <p className="hint archive-hint">
            {archived
              ? "Archived: off the board and out of the review queue. Restoring puts it back where it stood, waiting on a human."
              : "Keeps the record, takes the task off the board and out of the review queue. Reversible."}
          </p>
        </div>
      )}
    </div>
  );
}
