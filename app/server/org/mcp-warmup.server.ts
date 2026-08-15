import type { DatabaseSync } from "node:sqlite";
import { logger } from "~/server/logging/logger.server";
import type { McpProbeOptions } from "./resources.server";

/**
 * R19-18 (owner ruling) — FIRST-RUN INSTALLS FINISH IN THE BACKGROUND.
 *
 * A stdio MCP command that installs on first use cannot be validated inside the
 * request that registers it. Measured on the reported server
 * (`uvx --from git+…/writing-tools-mcp`): it pulls fastmcp → authlib →
 * cryptography plus spacy, networkx and nvidia CUDA wheels, and had not
 * finished after 556 seconds. Worse, the probe KILLED it each time, and uv only
 * commits to its cache on completion — so every retest started the download
 * over and the row could never go green. Registering such a server was an
 * unwinnable loop.
 *
 * So the probe stops being the only chance. When it gives up on a command that
 * is visibly installing, the same command is started again here with a long
 * budget, detached from the request, and whatever it finally answers is written
 * to the row. The admin sees "installing", and the page re-checks until it
 * turns into a real verdict.
 *
 * Two things this deliberately is NOT:
 *  - it is not a second code path. The warm-up runs the SAME
 *    `discoverStdioMcpTools` handshake the probe runs, with a bigger deadline,
 *    so a server that goes green here would have gone green there given time.
 *  - it is not a queue or a job table. One in-process registry keyed by server
 *    id, cleared when the run settles; a container restart simply loses the
 *    warm-up, and `reapStaleWarmups` at boot clears the row's flag rather than
 *    leaving it "installing" forever with nothing running.
 */

/** Owner ruling: 15 minutes covers the heavy real-world case without letting a
 *  wedged install sit forever. */
export const WARMUP_CAP_MS = 15 * 60 * 1000;

/** Server ids with a warm-up in flight IN THIS PROCESS. */
const inFlight = new Set<string>();

/** True while this server has a background install running here. */
export function isWarming(id: string): boolean {
  return inFlight.has(id);
}

/** Test seam — the suite must never leave a real warm-up armed. */
export function resetWarmupsForTest(): void {
  inFlight.clear();
}

function markWarming(db: DatabaseSync, id: string, at: string | null): void {
  db.prepare(
    `UPDATE org_mcp_servers SET warming_since = ?, updated_at = ? WHERE id = ?`,
  ).run(at, new Date().toISOString(), id);
}

/**
 * Start (or re-use) a background install for one stdio server.
 *
 * Returns immediately. Idempotent: a second registration while one is running
 * is a no-op rather than a second gigabyte of downloads.
 */
export function startMcpWarmup(
  db: DatabaseSync,
  input: { id: string; name: string; target: string; token: string | null },
  options: McpProbeOptions & { capMs?: number; heuristic?: boolean } = {},
): void {
  if (inFlight.has(input.id)) return;
  inFlight.add(input.id);
  markWarming(db, input.id, new Date().toISOString());
  // R20-4 (N20-2): a HEURISTIC warm-up (the command LOOKS like an installer but
  // said nothing on stderr) is capped at one per row — count it here, at arm
  // time, so a server that never answers cannot re-arm forever. The
  // evidence-based path (`installing === true`) is NOT counted: it is not a
  // guess. `reapStaleWarmups` rolls this back for a warm-up a restart killed.
  if (options.heuristic) {
    db.prepare(
      `UPDATE org_mcp_servers SET heuristic_warmups = heuristic_warmups + 1 WHERE id = ?`,
    ).run(input.id);
  }

  const capMs = options.capMs ?? WARMUP_CAP_MS;
  // `resources.server` imports THIS module to start a warm-up, so the probe is
  // reached by dynamic import — the same cycle-breaking dance the github/
  // surface uses. A type-only import above keeps the signature checked.
  void import("./resources.server")
    .then(({ discoverStdioMcpTools }) =>
      discoverStdioMcpTools(input.target, {
        ...options,
        token: input.token,
        timeoutMs: capMs,
      }),
    )
    .then((disc) => {
      const now = new Date().toISOString();
      if (disc.kind === "up") {
        db.prepare(
          `UPDATE org_mcp_servers
             SET up = 1, tools_count = ?, last_checked_at = ?, last_error = NULL,
                 warming_since = NULL, first_success_at = COALESCE(first_success_at, ?),
                 updated_at = ?
           WHERE id = ?`,
          // R20-4: the warm-up finishing is this server's first-ever success —
          // stamp it (idempotently) so a later cold probe is never mistaken for
          // a fresh first run.
        ).run(disc.tools, now, now, now, input.id);
        logger.info("mcp background install finished — server answered", {
          mcp: input.name,
          tools: disc.tools,
        });
        return;
      }
      db.prepare(
        `UPDATE org_mcp_servers
           SET up = 0, tools_count = NULL, last_checked_at = ?, last_error = ?,
               warming_since = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now, disc.reason, now, input.id);
      logger.warn("mcp background install did not produce a working server", {
        mcp: input.name,
        reason: disc.reason,
      });
    })
    .catch((err: unknown) => {
      // The row must never be left mid-install because the runner threw.
      markWarming(db, input.id, null);
      logger.error("mcp background install crashed", {
        mcp: input.name,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    })
    .finally(() => {
      inFlight.delete(input.id);
    });
}

/**
 * Boot: clear any `warming_since` left by a process that is gone.
 *
 * The flag means "a warm-up is running HERE". After a restart nothing is, so a
 * surviving flag would be a row claiming to be installing with no installer —
 * the kind of stale state a reader cannot tell from a live one.
 */
export function reapStaleWarmups(db: DatabaseSync): number {
  const stale = db
    .prepare(`SELECT id, name FROM org_mcp_servers WHERE warming_since IS NOT NULL`)
    .all() as unknown as { id: string; name: string }[];
  const orphans = stale.filter((row) => !inFlight.has(row.id));
  for (const row of orphans) {
    db.prepare(
      `UPDATE org_mcp_servers
         SET warming_since = NULL,
             -- R20-4 (N20-2): a warm-up a restart killed never got its 15
             -- minutes, so it is NOT a spent heuristic attempt — roll the
             -- counter back so a retest can try once more (and so the reaper's
             -- "retest to start it again" message is not a lie). MAX(0, …) keeps
             -- an evidence-armed row (counter 0) at 0.
             heuristic_warmups = MAX(0, heuristic_warmups - 1),
             last_error = COALESCE(last_error,
               'the background install was interrupted by a restart — retest to start it again'),
             updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), row.id);
  }
  return orphans.length;
}
