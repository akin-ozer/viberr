import type { PrState, Validation } from "~/schemas/task-file.schema";

/**
 * Ruling 88 (F21-2) — the acceptance disclosure ACKNOWLEDGMENT.
 *
 * R15-1 consolidated every writer to Done behind one ceremony
 * (`accept-confirm.tsx`), and pass 21 found that the ceremony was **client
 * architecture only**: the server took a bare POST and accepted, so the whole
 * "the human saw what merges" contract held for exactly as long as nobody
 * skipped the dialog (a stale tab, a replayed form, a script, a fetch from the
 * console). The pass-19 `AcceptDisclosure` that once enforced it server-side
 * was lost in the two-session merge.
 *
 * The invariant this module carries: **the human acceptance doors require the
 * client to echo back the three facts the dialog put on screen** — what merges
 * (the PR state), what was delivered (the revision head sha) and what the review
 * said (the validation pill) — and the server compares that echo against the
 * LIVE task before it merges anything, and again inside the write lock.
 *
 * That makes the echo do two jobs at once:
 *  1. a bare POST carries no echo at all and is refused (the disclosure is not
 *     optional, and it cannot be forged from the server's own state — the whole
 *     point is that it comes from what was RENDERED);
 *  2. an echo that no longer matches means the task moved under the dialog
 *     (R17-1 drift: the head advanced, the PR merged out of band, a verdict
 *     landed) — the human is looking at a screen that is no longer true, so the
 *     acceptance is refused and the ceremony has to be re-opened.
 *
 * One definition, imported by BOTH sides (rulings 12/14: never fork a mapping
 * per surface) — the dialog builds the echo from the exact values it rendered,
 * and the server derives the comparison from the task file.
 */

/** The three facts the acceptance ceremony states, as the ceremony stated them. */
export interface AcceptanceDisclosure {
  /** The "Merges" row: the linked PR's state (the value behind its pill), or
   *  `"none"` when the task has no pull request and nothing merges. */
  pr: PrState | "none";
  /** The "Revision" row: the delivered revision's head sha, or `"none"` when no
   *  revision has been delivered. */
  revision: string;
  /** The "Verdict" row: the validation value its pill rendered. */
  verdict: Validation;
}

/** The form fields the ceremony posts the echo in. Named once so the writer and
 *  the reader cannot drift apart. */
export const ACCEPT_DISCLOSURE_FIELDS = {
  pr: "ackPr",
  revision: "ackRevision",
  verdict: "ackVerdict",
} as const;

/** The echo as form fields — what the confirmed click submits. */
export function acceptanceDisclosureFields(disclosure: AcceptanceDisclosure) {
  return {
    [ACCEPT_DISCLOSURE_FIELDS.pr]: disclosure.pr,
    [ACCEPT_DISCLOSURE_FIELDS.revision]: disclosure.revision,
    [ACCEPT_DISCLOSURE_FIELDS.verdict]: disclosure.verdict,
  };
}

const PR_VALUES: readonly (PrState | "none")[] = [
  "review",
  "accepted",
  "merged",
  "closed",
  "none",
];

const VERDICT_VALUES: readonly Validation[] = [
  "healthy",
  "changed",
  "failing",
  "none",
  "bypassed",
];

/**
 * Read the echo out of a request, or `null` when it is absent or malformed —
 * which is exactly the "bare POST" case the server refuses. Deliberately
 * strict: a half-filled or unrecognised echo is NOT a disclosure, and coercing
 * one into a default would re-open the hole this exists to close.
 */
export function parseAcceptanceDisclosure(
  read: (field: string) => string | null,
): AcceptanceDisclosure | null {
  const revision = read(ACCEPT_DISCLOSURE_FIELDS.revision);
  // Matched against the declared vocabularies rather than cast into them: an
  // unrecognised word is not a disclosure, it is noise, and it must not become
  // one by assertion.
  const prRaw = read(ACCEPT_DISCLOSURE_FIELDS.pr);
  const verdictRaw = read(ACCEPT_DISCLOSURE_FIELDS.verdict);
  const pr = PR_VALUES.find((value) => value === prRaw);
  const verdict = VERDICT_VALUES.find((value) => value === verdictRaw);
  if (!pr || !revision || !verdict) return null;
  return { pr, revision, verdict };
}

/** How a PR state reads in a refusal sentence — the same words the dialog's
 *  pill uses, so the two sides of the comparison are recognisably the same
 *  fact. */
function prPhrase(state: PrState | "none"): string {
  switch (state) {
    case "none":
      return "no pull request";
    case "review":
      return "a pull request in review";
    case "accepted":
      return "a pull request accepted (merge pending)";
    case "merged":
      return "a merged pull request";
    case "closed":
      return "a closed pull request";
  }
}

function revisionPhrase(sha: string): string {
  return sha === "none" ? "no delivered revision" : `revision \`${sha.slice(0, 12)}\``;
}

/**
 * What has changed between the state the ceremony DISPLAYED and the state the
 * server is looking at now — one phrase per drifted fact, empty when the echo
 * still describes the task.
 *
 * `scope`:
 *  - `"full"` — the pre-merge comparison: every fact, against a task nothing has
 *    written to yet.
 *  - `"in-lock"` — the comparison inside the write lock, where the acceptance's
 *    OWN merge may already have moved `pr.state` (review → merged/accepted).
 *    The PR fact is therefore left to the `full` pass and the gate stack
 *    (`closedPrBlockedReason` and friends re-run in-lock anyway); the revision
 *    and the verdict are re-compared because nothing this path does can change
 *    them, so a difference there is a genuine concurrent write.
 */
export function acceptanceDisclosureDrift(
  live: AcceptanceDisclosure,
  echoed: AcceptanceDisclosure,
  scope: "full" | "in-lock" = "full",
): string[] {
  const drift: string[] = [];
  if (scope === "full" && live.pr !== echoed.pr) {
    drift.push(
      `the task now has ${prPhrase(live.pr)}, not ${prPhrase(echoed.pr)}`,
    );
  }
  if (live.revision !== echoed.revision) {
    drift.push(
      `the delivered revision is now ${revisionPhrase(live.revision)}, not ${revisionPhrase(echoed.revision)}`,
    );
  }
  if (live.verdict !== echoed.verdict) {
    drift.push(`the review state is now "${live.verdict}", not "${echoed.verdict}"`);
  }
  return drift;
}
