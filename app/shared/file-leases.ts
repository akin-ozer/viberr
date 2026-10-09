/**
 * Ruling 60 (pass 37, F37-74): per-file LEASES — which task owns a path until
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
  /** The ONE task that holds them. A lease whose holder has reached a terminal
   *  stage or been archived binds nobody — resolved at READ time by
   *  `activeFileLeases` (ruling 60), never by a sweep that a completion
   *  path could miss. */
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

/** A glob's segment pattern: `*` within it, never `/`. */
function segmentsIntersect(a: string, b: string): boolean {
  const aStar = a.includes("*");
  const bStar = b.includes("*");
  // A literal meets a pattern exactly when the pattern matches it.
  if (!aStar && !bStar) return a === b;
  if (!aStar) return matchesGlob(a, b);
  if (!bStar) return matchesGlob(b, a);
  // Both carry a star: some string matches both exactly when their literal
  // heads are compatible (one a prefix of the other) and their literal tails
  // are too. Each star can absorb the other pattern's middle, so nothing
  // between the first and last star can rule a string out.
  const head = (s: string) => s.slice(0, s.indexOf("*"));
  const tail = (s: string) => s.slice(s.lastIndexOf("*") + 1);
  const [ha, hb, ta, tb] = [head(a), head(b), tail(a), tail(b)];
  return (ha.startsWith(hb) || hb.startsWith(ha)) && (ta.endsWith(tb) || tb.endsWith(ta));
}

/**
 * Ruling 61: can one path fall under BOTH globs?
 *
 * Two leases whose globs overlap refuse each other's deliveries: a task that
 * changes a path both cover is refused by the lease it does not hold, so
 * neither can ever land. An exact-duplicate check (`internal/**` twice) misses
 * every real case (`internal/**` against `internal/sandbox/local.go`), which is
 * why a lease is now refused on overlap, the first to declare winning.
 *
 * Same two wildcards as {@link matchesGlob}, walked segment by segment: `**`
 * matches any number of whole segments, including none.
 */
export function globsOverlap(a: string, b: string): boolean {
  const split = (g: string) =>
    g
      .replace(/^\.\//, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean);
  const as = split(a);
  const bs = split(b);
  if (as.length === 0 || bs.length === 0) return false;
  // `matchesGlob` lets a `**` INSIDE a segment (`src/**.ts`) span directories,
  // which this segment walk cannot model. Such a glob is answered "overlaps":
  // a lease wrongly refused is a sentence a person can act on, and two leases
  // wrongly allowed refuse each other's deliveries for good.
  const partialGlobstar = (segs: string[]) => segs.some((s) => s !== "**" && s.includes("**"));
  if (partialGlobstar(as) || partialGlobstar(bs)) return true;
  const memo = new Map<string, boolean>();
  const meet = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === as.length && j === bs.length) result = true;
    else if (i < as.length && as[i] === "**")
      // Zero segments, or one segment (then possibly more) under the globstar.
      result = meet(i + 1, j) || (j < bs.length && meet(i, j + 1));
    else if (j < bs.length && bs[j] === "**") result = meet(i, j + 1) || (i < as.length && meet(i + 1, j));
    else if (i === as.length || j === bs.length) result = false;
    else result = segmentsIntersect(as[i]!, bs[j]!) && meet(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return meet(0, 0);
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
