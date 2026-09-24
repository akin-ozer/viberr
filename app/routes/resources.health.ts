import { data } from "react-router";
import { getDb } from "~/server/db/sqlite.server";
import { logger } from "~/server/logging/logger.server";
import { healthSnapshot } from "~/server/ops/health-snapshot.server";
import { toError } from "~/shared/errors";

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
 *  - `projectionStore` non-null → degraded as `projections` (ruling 217). The
 *    mirror could not be rebuilt from the canonical files, which is the other
 *    half of the same scenario: "files are truth" only helps while SQLite
 *    follows them. It is a LATCH, set by `rebuildPath`'s own catch and cleared
 *    by the next rebuild that writes — never a probe, so this endpoint stays
 *    cheap. Note that `projections` above (the row counts) keeps answering
 *    happily through a corrupt store, which is why a count is not a verdict.
 *  - `backends.<b>.connectedUsers` is a COUNT, never a verdict, and zero is
 *    **NOT** degraded. Ruling 127 made agent backends per-person: there is no
 *    instance credential to probe, so the only true instance-level fact is how
 *    many people have connected each backend (a sealed key, or a vendor
 *    sign-in whose credential file is on this server — still never a
 *    token-validity check). A deployment where nobody uses Codex is a correct
 *    deployment, and reporting zero as a fault would make a normal instance
 *    alarm forever (R17-5: a never-checked thing renders neutral, not
 *    alarming).
 *  - A per-person BACKEND fact — one member's refused credential, one member's
 *    spent quota — is **NOT** degraded either (ruling 146, owner 2026-09-06,
 *    superseding the F32-4/F32-9 entries). Those entries predate ruling 127,
 *    when a credential was deployment-wide and a refusal really was an instance
 *    outage; now it is one person's key, and letting it 503 this probe drained
 *    traffic from an instance serving everyone else. The readings stay in the
 *    response body (`quota`) and are rendered per person on Insights and
 *    Profile — this endpoint reports instance facts, not somebody's account.
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
    // Ruling 107: the reading is assembled in `healthSnapshot` so the
    // controller's `viberr_ops` diagnostics tool answers from the SAME
    // derivation instead of a second one that drifts. Spread after `ok` keeps
    // the wire body byte-for-byte what it was.
    const snapshot = healthSnapshot(getDb());

    const probe = requestedProbe(args?.request);
    const readiness = probe === "readiness" || probe === "ready";

    return data(
      {
        // Liveness, unchanged meaning: false only when SQLite is unreachable.
        // Read `status`/`degraded` for the honest verdict.
        ok: true as const,
        ...snapshot,
      },
      readiness && snapshot.degraded.length > 0 ? { status: 503 } : undefined,
    );
  } catch (error) {
    logger.error("health check failed", {
      err: toError(error),
    });
    return data({ ok: false as const, status: "down" as const }, { status: 503 });
  }
}
