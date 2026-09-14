/**
 * Ruling 245 (pass 37, F37-74): per-file LEASES — which task owns a path until
 * it merges.
 *
 * The project's conventions encode several rules that all need to name a file's
 * current owner: only the branch at the head of the merge queue regenerates the
 * lockfile freely; an authorized shared-file edit names its order; the approved
 * branch merges first. Viberr had nowhere to put that fact. `blockedBy` is the
 * only ordering primitive and it says "do not START until done", which is far
 * too strong — the statement actually wanted is "both may proceed, this one owns
 * `pnpm-lock.yaml` until it lands".
 *
 * Live on this pass the absence cost two decision packets in one evening:
 * SHOP-19 merged the Makefile fragment layout while SHOP-5 still carried the
 * pre-refactor monolith, and SHOP-11 was made to WAIT on two tasks when sequence
 * was meant, drifting twelve commits behind and losing a human decision to a
 * refused push.
 *
 * A lease is deliberately small: some path globs, the one task that holds them,
 * and why. It is read where a person or an agent asks "may I touch this", and
 * enforced where the answer stops being advice — the push that publishes the
 * change.
 */

/** One project's declaration that a task owns some paths until it merges. */
export interface FileLease {
  /** Globs this lease covers. `*` matches within one segment, `**` spans them. */
  paths: string[];
  /** The ONE task that holds them. Released when it reaches a terminal stage. */
  taskKey: string;
  /** Why it is held, in the holder's own words. Rendered wherever it refuses. */
  reason: string;
}

/**
 * Does `path` match `glob`?
 *
 * Deliberately two wildcards and no more, because a lease is read by people and
 * by models under time pressure and a surprising match is worse than a missing
 * feature:
 *  - `*` matches any run of characters WITHIN one segment (never `/`).
 *  - `**` matches any number of whole segments, including none.
 *
 * So `services/cart/**` covers `services/cart/src/index.ts` and `services/cart`
 * itself; `make/*.mk` covers `make/test.mk` but not `make/sub/test.mk`; and a
 * glob with no wildcard is an exact path.
 */
export function matchesGlob(path: string, glob: string): boolean {
  const normalise = (s: string): string => s.replace(/^\.\//, "").replace(/\/+$/, "");
  const p = normalise(path);
  const g = normalise(glob);
  if (!g) return false;
  // `a/**` should cover `a` itself, not only its descendants: a lease on a
  // directory means the directory, and a task that deletes it has touched it.
  const bare = g.endsWith("/**") ? g.slice(0, -3) : null;
  if (bare !== null && p === bare) return true;
  // Sentinels, not inline regex fragments: the replacements would otherwise
  // rewrite each other's output (`[^/]*` contains a `*`). Both are strings no
  // path or glob can contain.
  const GLOBSTAR_SLASH = "\u0000GS_SLASH\u0000";
  const GLOBSTAR = "\u0000GS\u0000";
  const STAR = "\u0000S\u0000";
  const pattern = g
    // `**/` spans whole segments INCLUDING none, so `a/**/b` matches `a/b`.
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, STAR)
    // Escape every regex metacharacter now that no `*` survives the string.
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .split(GLOBSTAR_SLASH)
    .join("(?:.*/)?")
    .split(GLOBSTAR)
    .join(".*")
    .split(STAR)
    .join("[^/]*");
  return new RegExp(`^${pattern}$`).test(p);
}

/** A changed path that another task's lease covers. */
export interface LeaseConflict {
  path: string;
  lease: FileLease;
}

/**
 * The first changed path held by a lease belonging to a DIFFERENT task.
 *
 * Returns the first rather than all of them on purpose: the refusal names one
 * concrete file and one holder, which is the sentence a person can act on. The
 * caller that wants the whole set can map over `paths` itself.
 */
export function leaseConflictFor(
  changedPaths: readonly string[],
  leases: readonly FileLease[],
  taskKey: string,
): LeaseConflict | null {
  for (const path of changedPaths) {
    for (const lease of leases) {
      if (lease.taskKey === taskKey) continue;
      if (lease.paths.some((glob) => matchesGlob(path, glob))) {
        return { path, lease };
      }
    }
  }
  return null;
}

/**
 * The refusal sentence, shared so a person meets one wording wherever a lease
 * stops them — the same rule `holdRefusal` and `closureRefusal` follow.
 *
 * `verb` completes "…before <verb>", e.g. "delivering it for review".
 */
export function leaseRefusal(
  taskKey: string,
  conflict: LeaseConflict,
  verb: string,
): string {
  return (
    `${taskKey} changes \`${conflict.path}\`, which ${conflict.lease.taskKey} holds ` +
    `(${conflict.lease.reason}). One task owns a shared file until it merges, so ` +
    `${taskKey} waits for ${conflict.lease.taskKey} before ${verb}. ` +
    `Drop the change, or clear the lease once ${conflict.lease.taskKey} has landed.`
  );
}
