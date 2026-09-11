import type { DatabaseSync } from "node:sqlite";
import { heldDataRootLock } from "~/server/db/data-root-lock.server";
import { isFileWatcherAlive } from "~/server/files/file-watch.service.server";
import { isKbWatcherAlive } from "~/server/files/kb-watch.service.server";
import {
  latestBackendRateLimits,
  stripQuotaPrincipals,
  type BackendQuotaRow,
} from "~/server/runtimes/backend-quota.server";
import { countConnectedUsers } from "~/server/runtimes/backend-credentials.server";
import { browserRuntimeStatus } from "~/server/tasks/specialist-browser-mcp.server";
import { getBuildInfo, type BuildInfo } from "./build-info.server";
import { cachedDataRootSpace, type DiskSpace } from "./disk-space.server";
import { maintenanceState, type MaintenanceState } from "./maintenance.server";
import { cachedToolchain, type Toolchain } from "./toolchain.server";

/**
 * The instance's ops reading, assembled once (ruling 107).
 *
 * `/resources/health` built this body inline, so it was reachable only over
 * HTTP. The controller's `viberr_ops` diagnostics MCP answers the same question
 * in-process, and a second derivation of "is this instance healthy" would drift
 * the moment one side learned about a subsystem the other did not. One
 * assembly, two readers.
 *
 * What counts as `degraded` — and what deliberately does not — is documented on
 * the route, which owns the probe contract (liveness vs readiness, the 503).
 * This module owns only the reading.
 */

/**
 * Ruling 127: how many PEOPLE have connected this backend.
 *
 * There is no instance-level "the backend is configured" verdict any more — a
 * run bills the person it is for, so the only true instance-level number is a
 * count of the people who can run it. Zero is a real, actionable reading ("no
 * one on this instance has connected Codex"); it is not a fault, so it never
 * degrades health — a deployment where nobody uses Codex is a correct
 * deployment, exactly as the browser-runtime reading already is (R17-5).
 *
 * Still never a token-validity probe: a sealed key counts, and a vendor
 * sign-in counts when its credential file is on this server.
 */
export interface BackendConnections {
  connectedUsers: number;
}

/** Whether the `use-browser` runtime (chromium + the Playwright MCP CLI) is
 *  installed. Informational, like `backends`: a deployment that never grants
 *  the browser is a correct deployment (R17-5). */
export type BrowserHealth =
  | { status: "ready" }
  | { status: "unavailable"; reason?: string };

export interface HealthSnapshot {
  status: "ok" | "degraded";
  /** The failing subsystems, named. Empty when `status` is `ok`. */
  degraded: string[];
  projections: { projects: number; tasks: number };
  watcher: boolean;
  kbWatcher: boolean;
  /** Who holds the single-writer lock on this data root (B-FD1/F18-5).
   *  `bootId` stays internal; this is what a human needs to see one writer. */
  lock: { pid: number; hostname: string; startedAt: string } | null;
  backends: { claude: BackendConnections; codex: BackendConnections };
  browser: BrowserHealth;
  /** Free space on the data root. null when the filesystem could not be
   *  measured, which is not the same as "there is no space". */
  disk: DiskSpace | null;
  maintenance: MaintenanceState;
  build: BuildInfo;
  /**
   * F32-9 (pass 32): what each backend last TOLD us — the latest rate-limit
   * reading, a quota exhaustion read off a refused run, a credential refusal.
   * `backends` above is a connection COUNT only; without this the controller's
   * `instance_health` answered "codex usable, no quota exhaustion flagged"
   * ten minutes after a codex run had been refused for quota, while the
   * Insights page (which reads the same store) showed "usage limit reached".
   * One store, every reader.
   */
  quota: BackendQuotaRow[];
  /**
   * Ruling 182 (pass 36, G36-4): what this host can run — the versions of the
   * tools an agent's shell finds (null when absent), the pinned CLI packages,
   * and whether a sandboxed Codex run can exec at all. Probed once per
   * process; the same verdict `startRun` reads to refuse a sandboxed Codex
   * dispatch with a named remedy. Informational here, like `browser`: a host
   * that runs no Codex is a correct host, so it never degrades health.
   */
  toolchain: Toolchain;
}

/**
 * Read every subsystem the health probe reports on.
 *
 * KEY ORDER IS PART OF THE CONTRACT: the route spreads this object straight
 * into its response body after `ok`, so the wire bytes are what they were
 * before the extraction. Insert new fields at the END.
 *
 * Throws only when SQLite is unreachable — the one condition that means this
 * process cannot serve at all. The route turns that into its 503.
 */
export function healthSnapshot(
  db: DatabaseSync,
  /** Ruling 130(d): the unauthenticated route never names a person; the
   *  signed-in `instance_health` read and Insights do. */
  opts: { principal?: boolean } = {},
): HealthSnapshot {
  // SAFETY: `SELECT count(*) AS c` is an aggregate with no GROUP BY — sqlite
  // answers it with exactly one row carrying the single integer column `c`.
  const projects = (
    db.prepare(`SELECT count(*) AS c FROM projects`).get() as { c: number }
  ).c;
  // SAFETY: same aggregate guarantee as the `projects` count above.
  const tasks = (
    db.prepare(`SELECT count(*) AS c FROM task_projections`).get() as {
      c: number;
    }
  ).c;
  const lock = heldDataRootLock();
  const watcher = isFileWatcherAlive();
  const kbWatcher = isKbWatcherAlive();
  // Cached (5 s TTL) — the route is unauthenticated and polled every few
  // seconds by container platforms; a disk fills over hours.
  const disk = cachedDataRootSpace();

  const degraded: string[] = [];
  if (!watcher) degraded.push("watcher");
  if (!kbWatcher) degraded.push("kbWatcher");
  if (!lock) degraded.push("lock");
  if (disk && disk.status !== "ok") degraded.push("disk");
  // Ruling 146 (owner, 2026-09-06) — SUPERSEDES the F32-4/F32-9 entries that
  // used to be pushed here (`credential:<backend>` / `quota:<backend>`).
  //
  // Those predate ruling 127, when a backend credential was a deployment-wide
  // fact and "Claude is refused" really was an instance outage. Since 127 the
  // credential is PER PERSON, so the refusal this reads is one person's — and
  // pushing it into `degraded` made `?probe=readiness` answer 503 for the whole
  // instance because somebody's key expired, which drains traffic from an
  // instance that is serving everyone else perfectly well.
  //
  // It loses no visibility: the refusal is already rendered per person on
  // Insights (the account label, the refusing run and the provider's own text)
  // and on Profile. This endpoint reports INSTANCE facts, and the only
  // instance-level backend fact is `backends.<b>.connectedUsers` below — which
  // is a count, never a verdict, exactly as the route's contract says.
  //
  // The readings themselves still ride the RESPONSE BODY (`quota` below), so an
  // operator polling this endpoint sees them; they simply no longer decide
  // whether the instance is ready to serve.
  const quota = latestBackendRateLimits(db);

  const browser = browserRuntimeStatus();

  return {
    status: degraded.length > 0 ? "degraded" : "ok",
    degraded,
    projections: { projects, tasks },
    watcher,
    kbWatcher,
    lock: lock
      ? {
          pid: lock.holder.pid,
          hostname: lock.holder.hostname,
          startedAt: lock.holder.startedAt,
        }
      : null,
    backends: {
      claude: { connectedUsers: countConnectedUsers(db, "claude") },
      codex: { connectedUsers: countConnectedUsers(db, "codex") },
    },
    browser: browser.available
      ? { status: "ready" }
      : { status: "unavailable", reason: browser.reason },
    disk,
    maintenance: maintenanceState(),
    build: getBuildInfo(),
    quota: opts.principal ? quota : stripQuotaPrincipals(quota),
    // LAST, by the key-order contract above. Memoized: the first call (boot's
    // integrity line, normally) pays the probe once.
    toolchain: cachedToolchain(),
  };
}
