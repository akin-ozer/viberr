# Spec — F18-5: the data-root writer lock must fail CLOSED when its file is stolen

**Status:** implementation spec (no source touched by this document).
**Scope files:**
- `app/server/db/data-root-lock.server.ts` (the fix lives here)
- `app/server/boot.server.ts` (start the guard)
- `app/server/events/sse-broker.server.ts` (stop the guard on shutdown)
- `app/routes/resources.health.ts` (surface the holder — required)
- `app/routes/_index.tsx` + `app/features/home/home-sections.tsx` (surface the holder on the Home strip — OPTIONAL)
- `app/server/db/data-root-lock.server.test.ts` (tests)

---

## 1. The bug, exactly

`acquireDataRootLock` (`data-root-lock.server.ts:247`) does an `O_EXCL` create of `<dataRoot>/state/writer.lock`, keeps the returned **fd** open for the process lifetime, and removes the file on `release()`. It is the single-writer defence (B-FD1) against the documented WAL-clobber catastrophe.

It has **no defence against its own file being deleted or replaced while it is held.** The fd stays open on the (now unlinked) inode forever; nothing re-checks that the *path* still resolves to *that* inode. Live F18-5 sequence:

1. Process A `acquireDataRootLock()` → holds fd on inode `X`, file `state/writer.lock` present.
2. A **store reset deleted `state/`** out from under A. `writer.lock` is now an unlinked ghost that only A's fd references. A keeps writing, believing it holds the lock.
3. Process B booted, `openSync(lockPath, "wx")` **succeeds** (no file present) → B holds a fresh inode `Y` and writes. **Two live writers on one `docker-data` root over VirtioFS.**
4. Next boot: org-level SQLite tables (users, encrypted PAT, org KB/MCP rows, notifications) were silently gone. `PRAGMA integrity_check` passed before *and* after — it does not detect **lost transactions**.

The fix makes A **notice** it no longer owns the file and **shut down loudly** (fail closed) instead of continuing lock-less.

---

## 2. Design

Three parts, all in `data-root-lock.server.ts` except the wiring:

1. **`verifyLockOwnership(lock, probes?)`** — a pure, injectable ownership check: `fstat` the held fd, `stat` the path, compare `ino`+`dev`; if the inode matches, corroborate by reading the file and comparing `bootId`. Returns `"held" | "stolen" | "unverifiable"`.
2. **`startDataRootLockGuard()` / `stopDataRootLockGuard()`** — an unref'd, once-registered, HMR-safe 20 s timer (mirrors `startGithubReconcilePoller`) that runs the check against the process-held lock and, on `"stolen"`, calls a loud-shutdown callback (default: `logger.error` + `process.exit(1)`).
3. **Surface the holder** on `/resources/health` (required) and optionally the Home store-maintenance strip.

Invariants preserved (verified against current code): the `O_EXCL` create, `classifyLock` bootId self-reclaim + foreign-host refusal + liveness probe, `VIBERR_FORCE_DATA_ROOT_LOCK`, `releaseOnExit` tracking, and the `exit`-hook + signal-shutdown release. The one structural change to `release` is additive (an `unlink` flag consulted only by the new `abandon()` path).

### Why this cannot false-positive on a normal run

- The app **writes its lock file exactly once**, at create (`writeLockFile`, line 233–240), and **never rewrites or replaces it**. So during a healthy run `fstat(fd).ino === stat(path).ino` always holds and the file content always names our own `bootId`. Neither trigger fires.
- A `"stolen"` verdict requires the *path* to resolve to a **different inode** than the fd we hold (delete+recreate) or to be **absent** (delete) or to **name a different boot** — all of which are exactly the F18-5 steal and never a normal run.
- The inode check is corroborated by the `bootId` content check specifically because VirtioFS synthesizes inode numbers; if a bind mount ever made `fstat`/`stat` inode comparison unreliable, the identity mismatch still catches a real replacement. A transient torn read returns `"unverifiable"` (guard no-ops that tick) rather than a spurious shutdown.

---

## 3. `data-root-lock.server.ts` — exact changes

### 3.1 Imports — add `fstatSync`, `statSync`

**Anchor:** line 1 (current).

Before:
```ts
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
```
After:
```ts
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
```

### 3.2 `DataRootLock` interface — expose `fd`, add `abandon()` + `verifyOwnership()`

**Anchor:** lines 66–74 (current `LockVerdict` + `DataRootLock`).

Before:
```ts
/** Why an existing lock could not simply be taken. */
export type LockVerdict = "stale" | "held" | "unknown-holder";

export interface DataRootLock {
  /** Absolute path of the lock file. */
  path: string;
  holder: LockHolder;
  /** Idempotent: closes the descriptor and removes the file. */
  release(): void;
}
```
After:
```ts
/** Why an existing lock could not simply be taken. */
export type LockVerdict = "stale" | "held" | "unknown-holder";

/**
 * Result of re-verifying that THIS process still owns the file at the lock path
 * (F18-5). `stolen` = the file was deleted or replaced while we held it (a second
 * writer is now possible → fail closed). `unverifiable` = a transient/torn read
 * this tick, not proof of a steal (the guard retries).
 */
export type LockOwnership = "held" | "stolen" | "unverifiable";

/** Injected fs probes for {@link verifyLockOwnership}; tests substitute these to
 *  simulate a steal without touching a real descriptor (mirrors the `isAlive`
 *  injection used by `acquireDataRootLock`). */
export interface LockOwnershipProbes {
  fstat: (fd: number) => { ino: bigint; dev: bigint };
  stat: (path: string) => { ino: bigint; dev: bigint };
  readHolder: (path: string) => LockHolder | null;
}

export interface DataRootLock {
  /** Absolute path of the lock file. */
  path: string;
  holder: LockHolder;
  /** The OS descriptor of the open lock file. The ownership re-check fstats THIS
   *  to compare against the inode currently living at `path`. */
  fd: number;
  /** Idempotent: closes the descriptor and removes the file. */
  release(): void;
  /**
   * Fail-closed teardown for a STOLEN lock (F18-5): drop tracking + close our
   * (stale) descriptor, but DO NOT unlink `path` — the file there now belongs to
   * whatever replaced it, and removing it would re-open the two-writer window.
   */
  abandon(): void;
  /** Re-verify this process still owns the file at `path`. See {@link verifyLockOwnership}. */
  verifyOwnership(probes?: LockOwnershipProbes): LockOwnership;
}
```

### 3.3 New `verifyLockOwnership` + default probes

**Anchor:** insert directly after `classifyLock` (ends line 206) — it belongs with the other verdict logic and above `acquireDataRootLock`.

```ts
const DEFAULT_OWNERSHIP_PROBES: LockOwnershipProbes = {
  fstat: (fd) => {
    const s = fstatSync(fd, { bigint: true });
    return { ino: s.ino, dev: s.dev };
  },
  stat: (p) => {
    const s = statSync(p, { bigint: true });
    return { ino: s.ino, dev: s.dev };
  },
  readHolder,
};

/**
 * Re-verify that the file at `lock.path` is STILL the one this process opened
 * (F18-5). The B-FD1 lock keeps an fd open for the process lifetime; if a store
 * reset deletes `state/` (or a second boot replaces the file), that fd becomes an
 * unlinked ghost while a NEW inode sits at the path — two live writers, silent
 * SQLite loss. This is how the holder catches it.
 *
 *  1. `fstat` our held fd — if the descriptor itself is unusable, we cannot prove
 *     we own anything → `stolen`.
 *  2. `stat` the path — ENOENT (deleted out from under us) → `stolen`.
 *  3. inode/device differ → the path was deleted+recreated → `stolen`.
 *  4. inode matches: corroborate identity for filesystems with synthesized inode
 *     numbers (VirtioFS bind mounts) — the file must still NAME our `bootId`.
 *     Only enforced when our own identity carries a bootId (production always
 *     does; a bootId-less injected/legacy self trusts the inode match). A null
 *     read is a torn/racing read, not proof → `unverifiable`.
 *
 * Pure + injectable so a test can simulate every branch (mirrors `classifyLock`).
 */
export function verifyLockOwnership(
  lock: Pick<DataRootLock, "fd" | "path" | "holder">,
  probes: LockOwnershipProbes = DEFAULT_OWNERSHIP_PROBES,
): LockOwnership {
  let held: { ino: bigint; dev: bigint };
  try {
    held = probes.fstat(lock.fd);
  } catch {
    return "stolen";
  }
  let onDisk: { ino: bigint; dev: bigint };
  try {
    onDisk = probes.stat(lock.path);
  } catch {
    return "stolen"; // ENOENT — the lock file was deleted while we held it.
  }
  if (held.ino !== onDisk.ino || held.dev !== onDisk.dev) return "stolen";
  if (lock.holder.bootId) {
    const onDiskHolder = probes.readHolder(lock.path);
    if (!onDiskHolder) return "unverifiable";
    if (onDiskHolder.bootId !== lock.holder.bootId) return "stolen";
  }
  return "held";
}
```

### 3.4 `acquireDataRootLock` — store `fd`, add `abandon`/`verifyOwnership`, keep unlink behaviour

**Anchor:** lines 292–314 (current `release`/`lock` construction inside the retry loop).

Before:
```ts
    const tracked = options.releaseOnExit !== false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (tracked) {
        process.off("exit", release);
        if (heldDataRootLock() === lock) heldLockSlot()[HELD_LOCK_KEY] = null;
      }
      try {
        closeSync(fd);
      } catch {
        // A descriptor already closed by shutdown is not a failure.
      }
      rmSync(lockPath, { force: true });
    };
    const lock: DataRootLock = { path: lockPath, holder: self, release };
    if (tracked) {
      // Both ends of the process's life: `exit` covers a normal return, and the
      // signal handler calls releaseDataRootLock() before it re-raises.
      process.once("exit", release);
      heldLockSlot()[HELD_LOCK_KEY] = lock;
    }
```
After:
```ts
    const tracked = options.releaseOnExit !== false;
    let released = false;
    // Normal release unlinks; the fail-closed `abandon()` (F18-5) sets this false
    // so a STOLEN lock's teardown closes our stale fd WITHOUT deleting the file
    // that now belongs to the process which replaced us.
    let unlinkOnRelease = true;
    const release = () => {
      if (released) return;
      released = true;
      if (tracked) {
        process.off("exit", release);
        if (heldDataRootLock() === lock) heldLockSlot()[HELD_LOCK_KEY] = null;
      }
      try {
        closeSync(fd);
      } catch {
        // A descriptor already closed by shutdown is not a failure.
      }
      if (unlinkOnRelease) rmSync(lockPath, { force: true });
    };
    const abandon = () => {
      unlinkOnRelease = false;
      release();
    };
    const verifyOwnership = (probes?: LockOwnershipProbes): LockOwnership =>
      verifyLockOwnership({ fd, path: lockPath, holder: self }, probes);
    const lock: DataRootLock = {
      path: lockPath,
      holder: self,
      fd,
      release,
      abandon,
      verifyOwnership,
    };
    if (tracked) {
      // Both ends of the process's life: `exit` covers a normal return, and the
      // signal handler calls releaseDataRootLock() before it re-raises.
      process.once("exit", release);
      heldLockSlot()[HELD_LOCK_KEY] = lock;
    }
```

Notes:
- `process.once/off("exit", release)` are kept **verbatim** — the exit hook still unlinks on a clean exit (`unlinkOnRelease` defaults true). Only `abandon()` flips the flag.
- `fd` is already in scope (assigned at line 269). No global needed — it now simply rides on the `lock` object, which is exactly what the guard/health reads via `heldDataRootLock()`.

### 3.5 New guard timer + default loud shutdown

**Anchor:** append after `acquireDataRootLock` (end of file, line 325).

```ts
/** Ownership re-check cadence. Cheap (one fstat + one stat + one small read),
 *  unref'd, so 20 s is comfortable while still catching a steal within a tick. */
export const DATA_ROOT_LOCK_GUARD_INTERVAL_MS = 20_000;

/** HMR-safe singleton handle — same global-symbol pattern as the reconcile
 *  poller / file watcher, so a dev reload never stacks a second interval. */
const GUARD_KEY = Symbol.for("viberr.dataRootLockGuard");

function guardSlot(): Record<symbol, ReturnType<typeof setInterval> | undefined> {
  return globalThis as unknown as Record<
    symbol,
    ReturnType<typeof setInterval> | undefined
  >;
}

export interface DataRootLockGuardOptions {
  intervalMs?: number;
  /** Lock to watch. Defaults to the process-held lock (read every tick, so an
   *  HMR re-acquire is picked up). Injected by tests. */
  lock?: DataRootLock;
  /** Ownership probe. Defaults to `lock.verifyOwnership()`. Injected by tests. */
  verify?: (lock: DataRootLock) => LockOwnership;
  /** Reaction to a lost lock. Default: loud log + `process.exit(1)`. Injected by
   *  tests so the worker is not taken down. */
  onStolen?: (lock: DataRootLock, verdict: LockOwnership) => void;
}

function loudlyShutDownOnStolenLock(
  lock: DataRootLock,
  verdict: LockOwnership,
): void {
  // No `logger.fatal` exists (levels: debug/info/warn/error); this is the app's
  // fatal channel — a loud `error` line + a non-zero exit, mirroring the boot
  // refusal's who/what/why so an operator reading stdout has the whole diagnosis.
  logger.error(
    `FATAL: this Viberr process no longer owns the data-root writer lock at ${lock.path} (${verdict}). ` +
      `The lock file was deleted or replaced while this process held it — another process may now be ` +
      `writing the same data root concurrently, which clobbers the SQLite WAL and silently loses ` +
      `transactions (B-FD1/F18-5). Shutting down NOW rather than continuing to write lock-less. ` +
      `Do not wipe <dataRoot>/state while a Viberr process is running.`,
    { lockPath: lock.path, holder: lock.holder, verdict },
  );
  // Detach WITHOUT unlinking: the file at lock.path is no longer ours to remove.
  lock.abandon();
  process.exit(1);
}

/**
 * Start the fail-closed ownership guard (F18-5): every {@link DATA_ROOT_LOCK_GUARD_INTERVAL_MS}
 * re-verify the process still owns its writer-lock file; on a `stolen` verdict,
 * loudly shut the process down instead of writing lock-less. Idempotent + HMR-safe
 * + unref'd (never blocks exit). No-op when nothing is held.
 */
export function startDataRootLockGuard(options: DataRootLockGuardOptions = {}): void {
  const slot = guardSlot();
  if (slot[GUARD_KEY]) return;
  const intervalMs = options.intervalMs ?? DATA_ROOT_LOCK_GUARD_INTERVAL_MS;
  const verify = options.verify ?? ((l: DataRootLock) => l.verifyOwnership());
  const onStolen = options.onStolen ?? loudlyShutDownOnStolenLock;
  const handle = setInterval(() => {
    const lock = options.lock ?? heldDataRootLock();
    if (!lock) return; // released (or never taken) — nothing to guard this tick.
    let verdict: LockOwnership;
    try {
      verdict = verify(lock);
    } catch (error) {
      // A single probe hiccup is not proof of a steal — log and retry next tick.
      logger.warn("data-root lock guard check failed (transient)", {
        err: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    if (verdict === "stolen") {
      stopDataRootLockGuard();
      onStolen(lock, verdict);
    }
    // "held" → fine; "unverifiable" → torn read, retry next tick.
  }, intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  slot[GUARD_KEY] = handle;
}

/** Stop the guard (graceful shutdown + tests). */
export function stopDataRootLockGuard(): void {
  const slot = guardSlot();
  const handle = slot[GUARD_KEY];
  if (handle) {
    clearInterval(handle);
    slot[GUARD_KEY] = undefined;
  }
}
```

---

## 4. `boot.server.ts` — start the guard after the lock is taken

**Anchor:** lines 204–209 (current `takeDataRootWriterLock(env);` … `armProcessShutdown();`).

Before:
```ts
  takeDataRootWriterLock(env);
  // …and arm the signal handler that RELEASES it. Registration used to ride on
  // the first SSE publish/connect, so a warm store that emitted nothing on boot
  // shut down without ever running it — leaving the lock behind for the next
  // container to refuse.
  armProcessShutdown();
```
After:
```ts
  takeDataRootWriterLock(env);
  // …and arm the signal handler that RELEASES it. Registration used to ride on
  // the first SSE publish/connect, so a warm store that emitted nothing on boot
  // shut down without ever running it — leaving the lock behind for the next
  // container to refuse.
  armProcessShutdown();
  // F18-5: the lock keeps an fd open for the process lifetime but nothing
  // re-checked the FILE still exists. A store reset that deleted state/ left this
  // process writing lock-less while a second one booted into the freed path — two
  // writers, silent SQLite loss. The guard re-verifies ownership on a timer and
  // fails CLOSED (loud shutdown) the moment the file is gone or replaced.
  startDataRootLockGuard();
```

Import addition — **Anchor:** lines 6–10 (current `data-root-lock.server` import block):

Before:
```ts
import {
  acquireDataRootLock,
  DataRootLockedError,
  forceDataRootTakeover,
} from "./db/data-root-lock.server";
```
After:
```ts
import {
  acquireDataRootLock,
  DataRootLockedError,
  forceDataRootTakeover,
  startDataRootLockGuard,
} from "./db/data-root-lock.server";
```

> Note on `bootServer` idempotency: it early-returns on the `BOOT_KEY` global (line 181), and `startDataRootLockGuard` is itself idempotent via `GUARD_KEY`, so a re-entrant boot never stacks a second guard.

---

## 5. `sse-broker.server.ts` — stop the guard on shutdown

**Anchor:** `runProcessShutdown` (lines 358–366) + the import at line 2.

Import — Before:
```ts
import { releaseDataRootLock } from "~/server/db/data-root-lock.server";
```
After:
```ts
import {
  releaseDataRootLock,
  stopDataRootLockGuard,
} from "~/server/db/data-root-lock.server";
```

Teardown — Before:
```ts
export function runProcessShutdown(): void {
  closeAllSseConnections();
  // Detach both watchers (timers + handlers cleared synchronously) BEFORE the
  // database closes, so no debounced rebuild can fire into a shut-down DB.
  stopFileWatcher();
  stopKbWatcher();
  shutdownDatabase();
  releaseDataRootLock();
}
```
After:
```ts
export function runProcessShutdown(): void {
  closeAllSseConnections();
  // Detach both watchers (timers + handlers cleared synchronously) BEFORE the
  // database closes, so no debounced rebuild can fire into a shut-down DB.
  stopFileWatcher();
  stopKbWatcher();
  // Stop the F18-5 ownership guard before we deliberately release the lock — a
  // clean shutdown must not be mistaken for a steal.
  stopDataRootLockGuard();
  shutdownDatabase();
  releaseDataRootLock();
}
```

> The guard is unref'd, so this stop is belt-and-suspenders (the timer never blocks exit); it exists so an interval that happens to be mid-flight during a graceful `docker compose stop` cannot race the deliberate `releaseDataRootLock()` and read its own release as a theft.

---

## 6. Surface the holder (option 2) — REQUIRED: `/resources/health`

**Anchor:** `app/routes/resources.health.ts` lines 1–6 (imports) and 36–46 (returned data).

Import — add:
```ts
import { heldDataRootLock } from "~/server/db/data-root-lock.server";
```

Returned data — Before:
```ts
    return data({
      ok: true as const,
      projections: { projects, tasks },
      watcher: isFileWatcherAlive(),
      kbWatcher: isKbWatcherAlive(),
      backends: {
        // Env-presence only — never probes token validity (see docblock).
        claude: isBackendAvailable("claude") ? "real" : "unavailable",
        codex: isBackendAvailable("codex") ? "real" : "unavailable",
      },
    });
```
After:
```ts
    const lock = heldDataRootLock();
    return data({
      ok: true as const,
      projections: { projects, tasks },
      watcher: isFileWatcherAlive(),
      kbWatcher: isKbWatcherAlive(),
      // B-FD1/F18-5: which process owns the single-writer lock on this data root.
      // pid/hostname/startedAt only (bootId is internal) — enough for a human to
      // confirm exactly one writer and to see WHO it is over a shared mount.
      lock: lock
        ? {
            pid: lock.holder.pid,
            hostname: lock.holder.hostname,
            startedAt: lock.holder.startedAt,
          }
        : null,
      backends: {
        // Env-presence only — never probes token validity (see docblock).
        claude: isBackendAvailable("claude") ? "real" : "unavailable",
        codex: isBackendAvailable("codex") ? "real" : "unavailable",
      },
    });
```

Update the route docblock's 200-shape line (line ~18) to include `lock`.

### Optional secondary — Home store-maintenance strip

Low priority; the health endpoint already satisfies option 2. If wanted:

- `app/routes/_index.tsx` loader (after line 61) — admin-gated, mirrors `storeRoot`:
  ```ts
  lockHolder:
    user.role === "admin"
      ? (() => {
          const h = heldDataRootLock()?.holder;
          return h ? { pid: h.pid, hostname: h.hostname, startedAt: h.startedAt } : null;
        })()
      : null,
  ```
  (import `heldDataRootLock` from `~/server/db/data-root-lock.server`.)
- `app/features/home/home-sections.tsx` `StoreStrip` (lines 533–588) — accept an optional `lockHolder` prop and render one muted line inside the existing `<span>` (after the "admins only …" sentence), e.g. `Writer: pid {pid} on {hostname} since {startedAt}`. No new controls, no new styles required beyond the existing `.sub`/muted text.

---

## 7. Test plan — `data-root-lock.server.test.ts`

Follows the file's existing DI style (`self`, `isAlive`, `releaseOnExit`, real temp dirs via `ctx.makeTempDir()`).

### 7.1 Imports to add

- from `node:fs`: add `rmSync` (already have `existsSync, readFileSync, writeFileSync`).
- from `vitest`: add `vi` (already have `afterEach, describe, expect, it`).
- from `./data-root-lock.server`: add `verifyLockOwnership`, `startDataRootLockGuard`, `stopDataRootLockGuard`, and the type `LockOwnership` / `DataRootLock` as needed.

### 7.2 `verifyLockOwnership` — real-fs cases (primary, matches file style)

```ts
describe("verifyLockOwnership (F18-5 fail-closed)", () => {
  it("reports 'held' for a lock this process genuinely owns", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquire(dataRoot, { ...HOST_A, bootId: "boot-1" });
    expect(lock.verifyOwnership()).toBe("held");
    expect(verifyLockOwnership(lock)).toBe("held");
    lock.release();
  });

  it("reports 'stolen' when the lock file is deleted out from under the holder", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquire(dataRoot, { ...HOST_A, bootId: "boot-1" });
    rmSync(lock.path, { force: true }); // the store reset that started F18-5
    expect(lock.verifyOwnership()).toBe("stolen");
    lock.release();
  });

  it("reports 'stolen' when another process replaces the lock file", () => {
    const dataRoot = ctx.makeTempDir();
    const lock = acquire(dataRoot, { ...HOST_A, bootId: "boot-1" });
    // Process B boots into the freed path and writes a fresh lock (new inode):
    rmSync(lock.path, { force: true });
    writeFileSync(lock.path, JSON.stringify({ ...HOST_A_OTHER, bootId: "boot-2" }));
    expect(lock.verifyOwnership()).toBe("stolen");
    // abandon() must NOT delete B's file:
    lock.abandon();
    expect(existsSync(lock.path)).toBe(true);
    rmSync(lock.path, { force: true });
  });
});
```

> `acquire` here is the test's existing helper (line 36, `releaseOnExit: false`). It returns the `DataRootLock`, which now carries `fd`, `verifyOwnership`, `abandon`.

### 7.3 `verifyLockOwnership` — injected-probe cases (the branches real fs can't cheaply force)

```ts
describe("verifyLockOwnership (injected probes)", () => {
  const owned = { fd: 7, path: "/x/writer.lock", holder: { ...HOST_A, bootId: "boot-1" } };

  it("'stolen' on an inode mismatch, before reading content", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 999n, dev: 1n }),
        readHolder: () => owned.holder,
      }),
    ).toBe("stolen");
  });

  it("'stolen' when our held descriptor is unusable (fstat throws)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => { throw new Error("EBADF"); },
        stat: () => ({ ino: 1n, dev: 1n }),
        readHolder: () => owned.holder,
      }),
    ).toBe("stolen");
  });

  it("'stolen' when inode matches but the content names another boot (VirtioFS ino-reuse guard)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 100n, dev: 1n }),
        readHolder: () => ({ ...HOST_A, bootId: "boot-2" }),
      }),
    ).toBe("stolen");
  });

  it("'unverifiable' on a torn read (inode matches, content unreadable)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 100n, dev: 1n }),
        readHolder: () => null,
      }),
    ).toBe("unverifiable");
  });

  it("'held' when inode + boot identity both agree (normal run does not false-positive)", () => {
    expect(
      verifyLockOwnership(owned, {
        fstat: () => ({ ino: 100n, dev: 1n }),
        stat: () => ({ ino: 100n, dev: 1n }),
        readHolder: () => owned.holder,
      }),
    ).toBe("held");
  });
});
```

### 7.4 `startDataRootLockGuard` — the timer wiring (fake timers, injected `verify`/`onStolen`)

```ts
describe("startDataRootLockGuard (F18-5)", () => {
  afterEach(() => stopDataRootLockGuard());

  const fakeLock = (path = "/x/writer.lock") =>
    ({ path, holder: HOST_A } as unknown as DataRootLock);

  it("loudly shuts down and stops itself when a tick sees a stolen lock", () => {
    vi.useFakeTimers();
    const stolen: Array<[string, LockOwnership]> = [];
    startDataRootLockGuard({
      intervalMs: 1000,
      lock: fakeLock(),
      verify: () => "stolen",
      onStolen: (l, v) => stolen.push([l.path, v]),
    });
    vi.advanceTimersByTime(1000);
    expect(stolen).toEqual([["/x/writer.lock", "stolen"]]);
    // guard stopped itself → later ticks do not re-fire onStolen:
    vi.advanceTimersByTime(5000);
    expect(stolen).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not shut down on healthy or unverifiable ticks", () => {
    vi.useFakeTimers();
    const stolen: string[] = [];
    let verdict: LockOwnership = "held";
    startDataRootLockGuard({
      intervalMs: 1000,
      lock: fakeLock(),
      verify: () => verdict,
      onStolen: () => stolen.push("x"),
    });
    vi.advanceTimersByTime(1000);
    verdict = "unverifiable";
    vi.advanceTimersByTime(1000);
    expect(stolen).toEqual([]);
    vi.useRealTimers();
  });

  it("is idempotent — a second start does not stack a second interval", () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    startDataRootLockGuard({ intervalMs: 1000, lock: fakeLock(), verify: () => { ticks.push(1); return "held"; }, onStolen: () => {} });
    startDataRootLockGuard({ intervalMs: 1000, lock: fakeLock(), verify: () => { ticks.push(2); return "held"; }, onStolen: () => {} });
    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1]); // only the first guard's verify ran
    vi.useRealTimers();
  });
});
```

### 7.5 Regression guard (canary)

Reverting §3.4/§3.5 (the guard) or §4 (boot wiring) must break §7.2/§7.4. Also confirm the **existing** suite still passes unchanged — the additive `fd`/`abandon`/`verifyOwnership` on `DataRootLock` and the `unlinkOnRelease` default keep every current test (§ "release removes the file", "releaseDataRootLock (G1)", `classifyLock`, `forceDataRootTakeover`) green. Per the project's canary rule, verify each new test fails when its fix is reverted.

### 7.6 Optional — health route

If a `resources.health.test.ts` is added later, assert `lock` is `{ pid, hostname, startedAt }` while a lock is held and `null` otherwise. Not required for this fix.

---

## 8. Invariant checklist (must remain true)

- [x] `O_EXCL` create (`writeLockFile`, "wx") unchanged.
- [x] `classifyLock` bootId self-reclaim, foreign-host refusal, liveness probe unchanged.
- [x] `VIBERR_FORCE_DATA_ROOT_LOCK` override unchanged.
- [x] `releaseOnExit` tracking + `process.once/off("exit", release)` unchanged; exit hook still unlinks on clean exit.
- [x] Signal-shutdown release (`runProcessShutdown` → `releaseDataRootLock`) unchanged; guard stopped just before it.
- [x] New guard is unref'd, once-registered (HMR-safe `GUARD_KEY`), cheap (fstat+stat+small read / 20 s).
- [x] Re-verify cannot false-positive on a normal run (the lock file is written once and never rewritten; inode + bootId both stable).
- [x] Fail-closed shutdown does NOT unlink the (foreign) file — `abandon()` skips `rmSync`, preventing a fresh two-writer window.
