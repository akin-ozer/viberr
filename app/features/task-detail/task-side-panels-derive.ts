import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import { unpushedRevisionOf, type UnpushedRevision } from "~/schemas/task-file.schema";
import {
  checksPill,
  liveMergeable,
  mergeablePill,
  reviewPill,
  type PillView,
} from "~/features/github/github-pills";

/**
 * What the GitHub trace reads off the task before it draws (ruling 13(b), the
 * task-page recipe applied to `task-side-panels.tsx`): whether a live pull
 * request stands, the revision a push would carry and what the server would
 * refuse a delivery with, the admin override's reason, the card's links and
 * its status signals. Pure functions of the task and its acceptance
 * affordance, no React; `GithubTrace` or one of its parts calls each at most
 * once per render.
 */

/** No live pull request stands: none yet, or the last one closed or merged. */
export function prIsTerminal(task: TaskDetail): boolean {
  return !task.pr || task.pr.state === "closed" || task.pr.state === "merged";
}

/** Ruling 232 (pass 35, F35-11): the refusal the server gives a delivery over a
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

/**
 * Ruling 232: `closed` is terminal, so the delivery control is offered — and
 * the server refuses it while nobody has answered the closure. The whole
 * `PrRef` reaches this page (`pr_json`), so the refusal is derivable here and
 * is said on the control, the way the diverged push is.
 */
export function closedPrRefusal(task: TaskDetail): string | null {
  return task.pr && task.pr.state === "closed" && !task.pr.closure?.answered
    ? CLOSED_PR_DELIVERY_REFUSAL(task.pr.number, task.pr.closure?.by ?? null)
    : null;
}

/** Ruling 243: the delivered revision the open pull request does not carry,
 *  short, as the push control and its status row name it. */
export interface PushOffer {
  prNumber: number;
  rev: string;
  head: string | null;
  relation: UnpushedRevision["relation"];
}

export function prPushOffer(task: TaskDetail, prTerminal: boolean): PushOffer | null {
  // Ruling 229 / 243: the recorded unpushed revision, current only.
  const unpushed = unpushedRevisionOf(task.pr, task.workRevisionSha ?? null);
  return task.pr && !prTerminal && unpushed
    ? {
        prNumber: task.pr.number,
        rev: unpushed.revisionSha.slice(0, 7),
        head: unpushed.prHeadSha ? unpushed.prHeadSha.slice(0, 7) : null,
        relation: unpushed.relation,
      }
    : null;
}

/** The admin override's reason, or null when the card offers none. */
export function forceAcceptReason(
  task: TaskDetail,
  acceptance: Pick<AcceptanceAffordance, "blockedReason" | "terminallyBlocked">,
  filesDelivery: "expected" | "delivered" | null,
): string | null {
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
  // Ruling 98: force-accept is an escape hatch, not a standing offer. It stays
  // visible OFF-BOUNDARY (ruling 98 — a pre-work wedge must be escapable), but a
  // task with nothing to accept cannot be wedged yet: before this rule every
  // non-terminal task showed an admin "skips the remaining stages and the review
  // gate" in its GitHub card, ten seconds after creation, directly above "No
  // branch yet" and directly under "Not acceptable yet … move it through the
  // workflow first". "Escapable" is the test, so a task that IS wedged still
  // offers it with no branch at all: an open BLOCKED packet is a wedge (a
  // crashed run's recovery packet), and so is any work to accept — a branch, a
  // pull request, a delivered revision, or (ruling 228) delivered files. What
  // goes away is the standing offer on a task where nothing has happened yet.
  const wedgedOrDelivering = Boolean(
    task.branch ?? task.pr ?? task.workRevisionSha ?? null,
  ) || filesDelivery === "delivered" || task.packet?.type === "blocked";
  return isTerminal || acceptance.terminallyBlocked || !wedgedOrDelivering
    ? null
    : (acceptance.blockedReason ??
        (task.packet?.type === "blocked"
          ? "An open blocked decision is holding this task."
          : null));
}

/** The PR card's two ways to GitHub: the pull request and the branch's tree. */
export interface PrCardLinks {
  prHref: string | null;
  treeHref: string | null;
}

/**
 * Real external links (spec §4.9: the prototype toast goes away). Ruling
 * 315: the pull request's title opens it, and the branch opens its tree;
 * they are the card's "Open on GitHub", which stood as a third full-width
 * button under the other two.
 *
 * P14-UI-11 residual: this used to carry its own `?? "https://github.com"`
 * fallback, so the app held the host literal in TWO places while the fix note
 * in `github-query.server.ts` designated ONE thread-through point for a real
 * GHE base URL. The loader always sends `githubWebHost()`, so the prop is
 * required and the second literal is gone.
 */
export function prCardLinks(task: TaskDetail, host: string): PrCardLinks {
  return {
    prHref: task.repo && task.pr ? `${host}/${task.repo}/pull/${task.pr.number}` : null,
    treeHref: task.repo && task.branch ? `${host}/${task.repo}/tree/${task.branch}` : null,
  };
}

/** The PR card's status signals from GitHub, and whether the card has any
 *  status row to show at all. */
export interface PrCardSignals {
  checks: PillView | null;
  review: PillView | null;
  conflict: PillView | null;
  shown: boolean;
}

export function prCardSignals(
  task: TaskDetail,
  acceptance: Pick<AcceptanceAffordance, "gates">,
  pushOffer: PushOffer | null,
): PrCardSignals {
  // P13-D-28: the two GitHub facts the app fetched (or could have) and never
  // showed. Check-runs were summarized on every reconcile pass and read by
  // nothing; review state was never read at all, so a teammate approving or
  // requesting changes on GitHub was invisible here and a merge blocked by
  // required reviews surfaced only as a late 405.
  const checks = task.prChecks ? checksPill(task.prChecks) : null;
  const review = task.prReview ? reviewPill(task.prReview) : null;
  // Ruling 95 (pass 35, F35-12 (c)): the conflict the acceptance gate refuses
  // on, on the task page too. It was rendered on the GitHub page alone, so this
  // card read "PR #16 · in review" while the accept click answered 409. The
  // reconciler drops the fact for a settled PR, so a merged or closed one never
  // carries it. Ruling 315(d): through `liveMergeable`, not off the raw field.
  // The GitHub page and the review queue both read the verdict's head pin, and
  // a task page reporting "conflicts" over the commit that resolved it would
  // disagree with them and with the acceptance gate.
  const conflict = task.pr ? mergeablePill(liveMergeable(task.pr)) : null;
  const shown = Boolean(
    task.unownedPr !== null || acceptance.gates || checks || review || conflict || pushOffer,
  );
  return { checks, review, conflict, shown };
}

/**
 * R15-2 safety net (b): with delivery now an operator decision, a human with
 * authority can always ship the branch by hand — offered when no live PR
 * stands (none yet, or the last one closed/merged) and, since ruling 229,
 * whenever the open PR does not carry the delivered revision: the same door
 * pushes the revision to that PR. A DIVERGED remote gets the fact and a
 * disabled control naming the refusal the server would give, never a button
 * that then fails.
 */
export function deliveryOffered(
  canDeliver: boolean,
  prTerminal: boolean,
  pushOffer: PushOffer | null,
): boolean {
  return canDeliver && (prTerminal || pushOffer !== null);
}
