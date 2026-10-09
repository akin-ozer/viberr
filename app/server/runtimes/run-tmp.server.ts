import { mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import {
  agentGitLaunchFor,
  launchesAgents,
  passThroughDirForAgents,
  shareDirWithAgents,
  type AgentLaunch,
} from "./agent-isolation.server";
import { removeAgentTree, removeAgentTreeSync } from "./agent-trees.server";
import { RUN_REAP_GRACE_MS } from "./run-processes.server";
import { assertPathSafeRunId } from "./user-homes.server";

/**
 * Ruling 141(c): every run has a temporary directory of its own, and it goes when
 * the run settles.
 *
 * Ruling 141 runs each agent as its person's own uid, and every run of one
 * person is that one uid, so all of them shared `/tmp`: what a run wrote there
 * stayed until the container went, and every later run of the person could
 * list it and read it. Live on AWSC-86 (2026-10-02) the Cloud Solutions
 * Architect read `/tmp/awsc-86-manifest.json`, 399 KB a run had left there,
 * "before noticing the workspace boundary"; the Estimate Judge, which reads the
 * private golden set while it designs and scores, keeps its scratch in the same
 * `/tmp` as the same uid.
 *
 * So a run's processes get `TMPDIR`, `TMP` and `TEMP` = `<root>/<runId>`, the
 * root being `VIBERR_RUN_TMP_ROOT` or else `viberr-runs` under the server's own
 * temp directory (in the image the container's `/tmp`). The root is the
 * server's, 0710 in the agent group: an agent enters its own run's directory by
 * the path it is given and cannot list the others. The run's directory is the
 * server's, 2770 in the agent group like a workspace, so whatever the agent
 * writes in it stays removable. It is made when the run launches (a queued run
 * has none), removed as the run's person (ruling 140) once the settle is done
 * and the sweep has had its grace (ruling 142), and boot removes whatever a
 * stopped server or a failed removal left. The shell inventory every prompt
 * carries says to keep temporary files there.
 *
 * Separation by convention and cleanup, not containment: the runs of one
 * person are one uid, so a run that knows another's id can still open its
 * directory, and `/tmp` itself stays writable.
 */

/** The directory each run's own temporary directory is made in. */
function runTmpRoot(): string {
  return getEnv().VIBERR_RUN_TMP_ROOT ?? path.join(tmpdir(), "viberr-runs");
}

/** The names a run's processes look their temporary directory up under:
 *  `TMPDIR` for POSIX tools, `TMP` and `TEMP` for the rest. */
export const RUN_TMP_ENV_KEYS = ["TMPDIR", "TMP", "TEMP"] as const;

export function runTmpEnv(dir: string) {
  return { TMPDIR: dir, TMP: dir, TEMP: dir } satisfies Record<(typeof RUN_TMP_ENV_KEYS)[number], string>;
}

/**
 * `<root>/<runId>`: the temporary directory a run is given when it launches.
 * The one derivation `prepareRunTmp` makes and the run's disclosure names
 * before launch (ruling 217(d)'s file-tool roots).
 */
export function runTmpDirFor(runId: string): string {
  return path.join(runTmpRoot(), assertPathSafeRunId(runId));
}

/**
 * Make the run's temporary directory and return its path. What a crashed
 * predecessor of the same id left is removed first, as the person: a run starts
 * clean and never inherits. Throws when the root is not the server's own
 * directory or the directory cannot be made; the caller starts the run without
 * one and says so.
 */
export function prepareRunTmp(runId: string, person: AgentLaunch | null): string {
  passThroughDirForAgents(runTmpRoot());
  const dir = runTmpDirFor(runId);
  removeAgentTreeSync(dir, person);
  mkdirSync(dir);
  shareDirWithAgents(dir);
  return dir;
}

/**
 * How long after its settle a run's temporary directory waits to be removed.
 * The settle sweep gives the CLI its grace to exit and then every process still
 * carrying the run's marker its grace between SIGTERM and SIGKILL; a process
 * still writing the directory while it is removed would leave it half there.
 */
const RUN_TMP_REMOVE_DELAY_MS = 2 * RUN_REAP_GRACE_MS + 2_000;

/** Remove a run's temporary directory as its person. Never throws: a directory
 *  left behind is logged, and boot's sweep removes it. */
export async function removeRunTmp(
  dir: string,
  person: AgentLaunch | null,
  runId: string,
): Promise<void> {
  try {
    await removeAgentTree(dir, person);
  } catch (error) {
    logger.warn("a run's temporary directory could not be removed", {
      runId,
      dir,
      err: toError(error),
    });
  }
}

/** {@link removeRunTmp} once the sweep has had its grace. The timer does not
 *  hold the process open; a server that stops first leaves it to boot. */
export function scheduleRunTmpRemoval(
  dir: string,
  person: AgentLaunch | null,
  runId: string,
  delayMs: number = RUN_TMP_REMOVE_DELAY_MS,
): void {
  setTimeout(() => void removeRunTmp(dir, person, runId), delayMs).unref();
}

/**
 * Boot, before anything can start a run: every directory under the root is one
 * a run left (the server stopped before its removal, or the removal failed).
 * Each is removed as the person its run billed. One whose run the projection
 * does not know, or that names no person while this server launches agents, is
 * left and logged, never removed as the server's own user. Returns how many
 * went. Never throws.
 */
export function sweepRunTmp(db: DatabaseSync): number {
  const root = runTmpRoot();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  const billed = db.prepare("SELECT credential_user_id FROM agent_runs WHERE id = ?");
  let removed = 0;
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      // SAFETY: `credential_user_id` is a declared column of `agent_runs`; the
      // SELECT names it and nothing else, and `.get` returns undefined when no
      // run has this id.
      const row = billed.get(name) as { credential_user_id: string | null } | undefined;
      const userId = row?.credential_user_id ?? null;
      const person = launchesAgents() && userId ? agentGitLaunchFor(db, userId) : null;
      removeAgentTreeSync(dir, person);
      removed++;
    } catch (error) {
      logger.warn("a temporary directory a run left could not be removed at boot", {
        dir,
        err: toError(error),
      });
    }
  }
  return removed;
}
