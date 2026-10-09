import type { PrCacheState } from "./pr-linker.server";

/**
 * R16-1 (owner ruling 2026-08-04) — when a pull request Viberr did not just
 * open may become a task's PR.
 *
 * Adoption exists for ONE case: Viberr lost track of a PR it had opened (a
 * crashed delivery, a `pr:` field wiped by hand). Every implementation of it
 * matched on the head BRANCH NAME — and a task-key branch is not an identifier.
 * Keys restart at 1 on a new data root, so `vib-4` on GitHub may still carry the
 * work of a VIB-4 from a wiped instance.
 *
 * Live (H8, 2026-08-04): a brand-new VIB-4 adopted PR #113 — merged a week
 * earlier, head `93435df`, nothing to do with this task's revision `80e9b2c`,
 * which had never been pushed. The task rail then wore a green "merged" badge
 * and "checks 2/2" for work that was never delivered. VIB-1 hit the same class
 * with merged #109.
 *
 * The rule: adopt ONLY a PR that is OPEN **and** whose head sha IS the task's
 * delivered revision. Identity, not containment — the acceptance gate
 * (`acceptancePrHeadCheck`) accepts a head that CONTAINS the delivered
 * commit because an auto-commit on top of the delivery is legitimate there;
 * adoption is the stronger claim "this PR is the one we opened for this
 * revision", and a task that has delivered nothing may adopt nothing at all.
 *
 * A name-matched PR that fails the rule is not a divergence and must not be
 * silently dropped either: it is a branch COLLISION, reported as one
 * (`prAdoptionRefusalNote`) and blocking delivery rather than being bound to
 * the task.
 */

type PrAdoptionRefusal =
  /** MERGED — its work is already on the base branch, so a fresh delivery
   *  fast-forwards cleanly; the collision is only about the stale branch name,
   *  not a history conflict (F17-L4). */
  | "merged"
  /** CLOSED without merging — the remote branch carries commits that are NOT on
   *  the base, so a fresh push risks a non-fast-forward; the collision is a real
   *  history hazard, not just a name clash (F17-L4). */
  | "closed"
  /** The task has delivered no revision, so nothing can stand for its work. */
  | "no_revision"
  /** The PR's head sha could not be read — unprovable, so refused (fail closed). */
  | "head_unknown"
  /** Open, readable, and simply not this task's work. */
  | "head_mismatch";

export type PrAdoptionDecision =
  | { adopt: true }
  | { adopt: false; refusal: PrAdoptionRefusal };

export function decidePrAdoption(input: {
  /** The PR's state in the task-file cache vocabulary (`mapPrToCacheState`). */
  state: PrCacheState;
  prHeadSha: string | null | undefined;
  /** `workRevision.headSha` — the task's delivered revision. */
  revisionHeadSha: string | null | undefined;
}): PrAdoptionDecision {
  if (input.state !== "review") {
    // F17-L4: merged and closed are BOTH un-adoptable, but they carry different
    // delivery hazards — name them apart so the refusal copy is honest.
    return {
      adopt: false,
      refusal: input.state === "merged" ? "merged" : "closed",
    };
  }
  const revision = input.revisionHeadSha?.trim();
  if (!revision) return { adopt: false, refusal: "no_revision" };
  const head = input.prHeadSha?.trim();
  if (!head) return { adopt: false, refusal: "head_unknown" };
  return head === revision
    ? { adopt: true }
    : { adopt: false, refusal: "head_mismatch" };
}

/** Why the PR on this branch is not the task's, in one sentence. */
function refusalCause(input: {
  refusal: PrAdoptionRefusal;
  taskKey: string;
  revisionHeadSha?: string | null;
}): string {
  switch (input.refusal) {
    case "merged":
      return `that PR is already merged and its work is on the base branch, so a fresh delivery fast-forwards cleanly once the stale branch name is cleared`;
    case "closed":
      return `that PR was closed without merging and the remote branch still holds its commits, so a fresh push would conflict until the branch is cleared`;
    case "no_revision":
      return `${input.taskKey} has delivered no revision, so no pull request can stand for its work yet`;
    case "head_unknown":
      return `its head commit could not be read, so it cannot be matched to ${input.taskKey}'s delivered revision`;
    case "head_mismatch":
      return input.revisionHeadSha
        ? `its head is not ${input.taskKey}'s delivered revision (${input.revisionHeadSha.slice(0, 7)})`
        : `its head is not ${input.taskKey}'s delivered revision`;
  }
}

/**
 * The ONE branch-collision note, shared by every refusing site (the poller's
 * reconcile, the workspace reconcile after a run, PR open) so a refused match
 * reads as the same problem wherever it surfaces instead of three unrelated
 * GitHub mysteries.
 *
 * It names the two shapes ruling 233 keeps the collision packet for and
 * asserts NEITHER, because a refused match cannot tell them apart: an unowned
 * OPEN pull request that appeared on the branch AFTER Viberr allocated the
 * name (pass 34, U34-6: JC-8 hit this one at 10:17:52Z while the note blamed
 * the other), and a branch recorded before ruling 228 under a task key an
 * older data root had already used (keys restart at 1; names allocated since
 * take a suffix when the canonical one is spoken for). The remedy is the same
 * either way, so the note commits to the remedy and not to a cause.
 *
 * The `**Branch name collision:**` opener is the marker the reconciler, the
 * divergence wake, PR open and their tests key on; keep it byte-identical.
 */
export function prAdoptionRefusalNote(input: {
  refusal: PrAdoptionRefusal;
  taskKey: string;
  branch: string;
  prNumber: number;
  revisionHeadSha?: string | null;
}): string {
  return (
    `**Branch name collision:** GitHub already has PR #${input.prNumber} on branch ` +
    `\`${input.branch}\`, but it is NOT ${input.taskKey}'s review PR: ${refusalCause(input)}. ` +
    `Viberr will not track it as one. Either that pull request was opened on ` +
    `\`${input.branch}\` after Viberr allocated the name to ${input.taskKey}, or ` +
    `${input.taskKey}'s branch was recorded under a task key an older data root had ` +
    `already used, before names took a suffix when the canonical one is spoken for ` +
    `(keys restart at 1), and Viberr cannot tell which from here. ` +
    `Resolve it with a ` +
    `\`resolve_remote_collision\` decision (closes the unrelated PR, deletes the stale ` +
    `remote branch \`${input.branch}\`, and re-delivers this task's work) before delivering.`
  );
}
