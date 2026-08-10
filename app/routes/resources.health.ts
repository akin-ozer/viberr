import { data } from "react-router";
import { heldDataRootLock } from "~/server/db/data-root-lock.server";
import { getDb } from "~/server/db/sqlite.server";
import { isFileWatcherAlive } from "~/server/files/file-watch.service.server";
import { isKbWatcherAlive } from "~/server/files/kb-watch.service.server";
import { logger } from "~/server/logging/logger.server";
import { getBuildInfo } from "~/server/ops/build-info.server";
import { cachedDataRootSpace } from "~/server/ops/disk-space.server";
import { maintenanceState } from "~/server/ops/maintenance.server";
import { isBackendAvailable } from "~/server/runtimes/runtime-registry.server";

/**
 * GET /resources/health — ops probe (Phase 10, docs/architecture/decisions.md route map).
 * Unauthenticated by design (readiness checks run without a session);
 * exposes only aggregate counts, never data.
 *
 * ## Two probes, one route
 *
 * The endpoint used to answer exactly one question — "is SQLite readable" — and
 * answered 200/`ok:true` to everything else, so a container with a DEAD STORE
 * WATCHER (the silent failure this deployment is most exposed to: the board
 * keeps serving cached projections while task files on disk drift) reported
 * healthy forever. compose's healthcheck is status-only, so it could never act
 * on the degraded fields even though they were in the body.
 *
 *  - **liveness** (default): 200 while the process can serve. A degraded
 *    subsystem does NOT kill the container — restarting it does not revive a
 *    full disk, and killing a serving instance is worse than a stale board.
 *  - **readiness** (`?probe=readiness`, also `?probe=ready`): 503 when anything
 *    in `degraded` is set, so an orchestrator drains traffic and an alert fires.
 *
 * `status` is `ok | degraded | down` on BOTH, and `degraded` names the failing
 * subsystems, so a body-reading monitor needs no query parameter.
 *
 * ## What counts as degraded — and what deliberately does not
 *
 *  - `watcher` / `kbWatcher` false → degraded. A watcher error CLEARS the
 *    handle, so false is a REAL dead watcher, never "not started yet".
 *  - `lock` null → degraded. Boot refuses to start without the single-writer
 *    lock, so a serving process without one is not a normal state.
 *  - `disk.status` low/critical → degraded. Canonical state is files; a full
 *    volume is the corruption scenario this product cannot afford.
 *  - `backends` unavailable is **NOT** degraded. A deployment that only ever
 *    uses Claude is a correct deployment, and the probe is env-presence only —
 *    it has never checked a token's validity. Reporting a never-configured
 *    backend as a fault would make a normal instance alarm forever (R17-5: a
 *    never-checked thing renders neutral, not alarming).
 *  - `disk: null` (unmeasurable) is NOT degraded — "we could not measure" is
 *    not "there is no space", and `build` identity is informational only.
 *
 * 503 `{ ok: false, status: "down" }` when the database cannot be read — the
 * one condition that means this process cannot serve at all.
 */
/** The `?probe=` selector, read defensively: the argument is optional so a
 *  direct `loader()` call (and any caller without a Request) gets LIVENESS,
 *  which is the safe default — never an error, never a silent 503. */
function requestedProbe(request?: Request): string | null {
  try {
    return request ? new URL(request.url).searchParams.get("probe") : null;
  } catch {
    return null;
  }
}

export async function loader(args?: { request?: Request }) {
  try {
    const db = getDb();
    const projects = (
      db.prepare(`SELECT count(*) AS c FROM projects`).get() as { c: number }
    ).c;
    const tasks = (
      db.prepare(`SELECT count(*) AS c FROM task_projections`).get() as {
        c: number;
      }
    ).c;
    const lock = heldDataRootLock();
    const watcher = isFileWatcherAlive();
    const kbWatcher = isKbWatcherAlive();
    // Cached (5 s TTL) — this route is unauthenticated and polled every few
    // seconds by container platforms; a disk fills over hours.
    const disk = cachedDataRootSpace();

    const degraded: string[] = [];
    if (!watcher) degraded.push("watcher");
    if (!kbWatcher) degraded.push("kbWatcher");
    if (!lock) degraded.push("lock");
    if (disk && disk.status !== "ok") degraded.push("disk");

    const probe = requestedProbe(args?.request);
    const readiness = probe === "readiness" || probe === "ready";
    const status = degraded.length > 0 ? ("degraded" as const) : ("ok" as const);

    return data(
      {
        // Liveness, unchanged meaning: false only when SQLite is unreachable.
        // Read `status`/`degraded` for the honest verdict.
        ok: true as const,
        status,
        degraded,
        projections: { projects, tasks },
        watcher,
        kbWatcher,
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
        // Free space on the data root, with the thresholds in force. null when
        // the filesystem could not be measured — never a fabricated 0.
        disk,
        // Proof the periodic pruner is alive (lastPassAt null until its first
        // pass — neutral, not a fault).
        maintenance: maintenanceState(),
        // Which build is serving. Nulls are honest: this image was built
        // without a version stamp and has no checkout to read.
        build: getBuildInfo(),
      },
      readiness && degraded.length > 0 ? { status: 503 } : undefined,
    );
  } catch (error) {
    logger.error("health check failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return data({ ok: false as const, status: "down" as const }, { status: 503 });
  }
}
