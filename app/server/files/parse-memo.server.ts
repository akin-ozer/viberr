/**
 * Ruling 454: a CONTENT-keyed parse memo for the store readers (project.md,
 * task.md, agent profile templates).
 *
 * The problem it removes: one task-page revalidation called readers that each
 * parsed the same few files again — project.md 13 times, the profiles 20 times,
 * task.md twice — and the YAML + Zod parse is ~97% of a read's cost (a 4 KB
 * project.md reads in 0.02 ms and parses in ~0.9 ms). Every helper asking its
 * own question of the file is the right shape; parsing identical bytes again
 * is the waste.
 *
 * Why content, not stat and not per request. Callers still read the file on
 * every call ("files are truth"); only the parse is skipped, and only when the
 * bytes are IDENTICAL to the bytes the cached value was parsed from. So the
 * answer is always parse(what is on disk now), by construction:
 *  - a write through the writers (atomic rename) and an external edit (an
 *    editor, `git pull`, a human in the file) are both seen by the very next
 *    read, whatever their inode, size or mtime — including an in-place rewrite
 *    of the same length inside one mtime tick, which a stat key would miss;
 *  - a stale read on a cached bind mount (the VirtioFS hazard write-cache
 *    repairs) is served exactly as stale as it is today and heals on the next
 *    read. A stat-keyed cache could pin it: fresh attributes over stale bytes
 *    would store the old parse under the new key until the file changed again;
 *  - no invalidation to forget: nothing has to tell the memo about a write, so
 *    the watcher, the writers and the write-cache are untouched;
 *  - no request scope: an AsyncLocalStorage memo would leak into every async
 *    continuation a request starts (a run kicked off by an action would read
 *    its first parse for its whole life) and would still parse once per
 *    request.
 *
 * Callers get a private copy (`structuredClone`, ~0.02 ms for project.md):
 * the writers mutate what they read (`updateProjectFile`'s `mutate(base)`,
 * `allocateTaskKey`), so the cached value must never be handed out. A value
 * that cannot be cloned is returned uncached.
 *
 * Bounded by entry count and by the characters of content held.
 */

export type StoreFileKind = "project-file" | "task-file" | "agent-profile";

/** YAML parses per kind of store file. */
export interface StoreFileParseCounts {
  "project-file": number;
  "task-file": number;
  "agent-profile": number;
}

interface MemoEntry {
  /** The parse's context (fallback slug/key/id) — part of the key. */
  variant: string;
  /** The exact bytes `value` was parsed from. */
  content: string;
  /** Never handed out: callers get a clone. */
  value: unknown;
}

const MAX_ENTRIES = 256;
// The hot set (project files, profile templates, the tasks people have open)
// is far smaller; the bound caps the parsed copies a long session can hold.
const MAX_CONTENT_CHARS = 4_000_000;

const memo = new Map<string, MemoEntry>();
let heldChars = 0;

const parses: StoreFileParseCounts = {
  "project-file": 0,
  "task-file": 0,
  "agent-profile": 0,
};

function forget(key: string): void {
  const entry = memo.get(key);
  if (!entry) return;
  heldChars -= entry.content.length;
  memo.delete(key);
}

function remember(key: string, entry: MemoEntry): void {
  forget(key);
  memo.set(key, entry);
  heldChars += entry.content.length;
  // Oldest first (Map keeps insertion order; a hit re-inserts its entry).
  for (const oldest of memo.keys()) {
    if (memo.size <= MAX_ENTRIES && heldChars <= MAX_CONTENT_CHARS) break;
    forget(oldest);
  }
}

/**
 * `parse(content)` for the file at `absPath`, skipping the parse when these
 * exact bytes (and `variant`) were parsed last time. Always returns a value
 * the caller owns.
 */
export function parseStoreFile<T>(
  kind: StoreFileKind,
  absPath: string,
  variant: string,
  content: string,
  parse: (content: string) => T,
): T {
  const key = `${kind}\u0000${absPath}`;
  const hit = memo.get(key);
  if (hit && hit.content === content && hit.variant === variant) {
    remember(key, hit);
    // SAFETY: `hit.value` was stored below from `parse(content)` for this same
    // key, kind and variant, and `parse` for a kind is always the same reader's
    // parser, so it is a T.
    return structuredClone(hit.value) as T;
  }
  parses[kind] += 1;
  const value = parse(content);
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    forget(key);
    return value;
  }
  remember(key, { variant, content, value: copy });
  return value;
}

/** test-only: YAML parses (memo misses) per kind since the last reset. */
export function storeFileParseCounts(): StoreFileParseCounts {
  return { ...parses };
}

/** test-only: zero the counters and empty the memo. */
export function resetParseMemoForTests(): void {
  parses["project-file"] = 0;
  parses["task-file"] = 0;
  parses["agent-profile"] = 0;
  memo.clear();
  heldChars = 0;
}
