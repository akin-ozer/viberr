import { execFile, spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  AGENT_UID_FLOOR,
  AGENT_UID_MAX,
  launchEnv,
  launchesAgents,
  resolveExecutable,
  type AgentLaunch,
} from "./agent-isolation.server";
import { filteredSpawnEnv } from "./spawn-env.server";

/**
 * Ruling 485: a tree an agent can write is removed AS ITS PERSON, through the
 * launcher, never by the server's own recursive remove.
 *
 * Ruling 460 runs every agent as its person's own uid in a shared group, and
 * the directories a run writes are group-writable so the server can read and
 * replace them. A tool can still make a directory the group cannot enter:
 * wrangler's `mkdtemp` dirs are 0700 as the agent's uid. The server's
 * `rmSync(dir, {recursive: true})` then deleted what group permission allowed
 * (`.git` first) and threw EACCES on the rest (F40-62, live on WEB-5): every
 * later supporting run found a checkout with no `.git`, could not clone into
 * it, and ran with no checkout and no verdict. A recursive remove by the server
 * in a tree an agent writes also walks paths an agent can swap for a symlink
 * mid-walk, with the server's authority.
 *
 * So the removal runs as the tree's person: `chmod -R u+rwX` (what a tool left
 * read-only or unenterable becomes its owner's to remove) and then
 * `rm -rf --`, both absolute binaries, through the launcher like their git
 * (`agentGitLaunchFor`). What the person's removal leaves is another uid's
 * (a task whose owner changed, so two people's agents wrote it): the server
 * reads the owners it can see in what is left and removes as each of them,
 * this time also opening their entries to the group (`g+rwX`) so a deeper
 * layer another uid wrote becomes visible and removable on the next round.
 * The rounds are bounded; a tree still there after them is a fault that names
 * the path it stopped at and the OS error.
 *
 * With isolation off (the host dev server, the test harness) there is nobody
 * else: the same two commands run as the server's own user. With isolation on
 * and no person named, it refuses and removes nothing — it never falls back to
 * the server's user (460(h), the rule R-seams-1 set for git).
 */

/** How many fallback rounds run as the owners found in what is left. */
const OWNER_ROUNDS = 3;
/** How many entries the owner scan reads before it stops looking. */
const OWNER_SCAN_LIMIT = 200_000;
/** A removal of a large tree (a `node_modules`) is not a hung process. */
const STEP_TIMEOUT_MS = 10 * 60_000;

/** Why a tree is still there: the path the removal stopped at and the OS
 *  error, "EACCES on /…/.wrangler/tmp/dev-1wnDsF", plus rm's own words. */
export class AgentTreeRemovalError extends Error {
  readonly target: string;
  /** "<errno> on <path>" (or rm's own sentence when it named no errno). */
  readonly failure: string;
  /** rm's stderr from the last pass, for the log. */
  readonly detail: string;

  constructor(target: string, failure: string, detail: string) {
    super(`${target} could not be removed: ${failure}`);
    this.name = "AgentTreeRemovalError";
    this.target = target;
    this.failure = failure;
    this.detail = detail;
  }
}

/** One command of a removal: as `launch`'s uid, or the server's own user. */
interface RemovalStep {
  launch: AgentLaunch | null;
  command: "chmod" | "rm";
  args: string[];
}

interface StepOutcome {
  ok: boolean;
  stderr: string;
}

function present(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The agent uids that own what the server can see of `target`: every entry
 * in a directory the server may read (it is in the agents' group), and the
 * owner of every directory it may not, which is the one who can open it.
 * Read-only and never followed through a symlink, so a swapped path can only
 * change who is ASKED to remove, and each is confined by the kernel to what
 * its own uid may do.
 */
function agentOwnersIn(target: string): number[] {
  const owners = new Set<number>();
  let seen = 0;
  const visit = (entry: string, depth: number) => {
    if (seen >= OWNER_SCAN_LIMIT) return;
    seen += 1;
    let uid: number;
    let isDir: boolean;
    try {
      const st = lstatSync(entry);
      uid = st.uid;
      isDir = st.isDirectory();
    } catch {
      return;
    }
    if (uid >= AGENT_UID_FLOOR && uid <= AGENT_UID_MAX) owners.add(uid);
    if (!isDir || depth > 64) return;
    let names: string[];
    try {
      names = readdirSync(entry);
    } catch {
      return;
    }
    for (const name of names) visit(path.join(entry, name), depth + 1);
  };
  visit(target, 0);
  return [...owners].sort((a, b) => a - b);
}

/**
 * The removal as a plan of commands, so the synchronous and the asynchronous
 * drivers run one sequence. Returns null when the tree is gone, else rm's
 * stderr from the last pass that failed.
 */
function* removalPlan(
  target: string,
  person: AgentLaunch | null,
): Generator<RemovalStep, string | null, StepOutcome> {
  let stderr = "";
  function* pass(launch: AgentLaunch | null, mode: string): Generator<RemovalStep, void, StepOutcome> {
    // chmod's own refusals (an entry another uid owns) are expected: rm's
    // result and what is left decide.
    yield { launch, command: "chmod", args: ["-R", mode, "--", target] };
    const removed: StepOutcome = yield { launch, command: "rm", args: ["-rf", "--", target] };
    if (!removed.ok && removed.stderr.trim()) stderr = removed.stderr;
  }
  yield* pass(person, "u+rwX");
  if (!present(target)) return null;
  // Isolation off: one user, nobody else to ask.
  if (!person) return stderr;
  for (let round = 0; round < OWNER_ROUNDS; round += 1) {
    const owners = agentOwnersIn(target);
    if (owners.length === 0) break;
    for (const uid of owners) {
      yield* pass({ uid, launcher: person.launcher }, "u+rwX,g+rwX");
      if (!present(target)) return null;
    }
  }
  return stderr;
}

/** A program to spawn, its arguments and its environment. */
interface StepSpawn {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** What is spawned for one step: the binary itself (the server's own user) or
 *  the launcher with the binary and the uid in its environment. Only the uid
 *  and the launcher of a launch are used: a removal hands no home back. */
function spawnOf(step: RemovalStep): StepSpawn {
  // `C`: rm's refusal is read below, in its own words.
  const env: NodeJS.ProcessEnv = { ...filteredSpawnEnv(), LC_ALL: "C" };
  const binary = resolveExecutable(step.command, env.PATH ?? process.env.PATH ?? "");
  if (!step.launch) return { file: binary, args: step.args, env };
  const launch: AgentLaunch = { uid: step.launch.uid, launcher: step.launch.launcher };
  return { file: launch.launcher, args: step.args, env: launchEnv(launch, binary, env) };
}

function runStepSync(step: RemovalStep): StepOutcome {
  const { file, args, env } = spawnOf(step);
  const result = spawnSync(file, args, { env, encoding: "utf8", timeout: STEP_TIMEOUT_MS });
  return { ok: result.status === 0, stderr: result.stderr ?? result.error?.message ?? "" };
}

function runStep(step: RemovalStep): Promise<StepOutcome> {
  const { file, args, env } = spawnOf(step);
  return new Promise((resolve) => {
    execFile(file, args, { env, encoding: "utf8", timeout: STEP_TIMEOUT_MS }, (error, _stdout, stderr) => {
      resolve({ ok: !error, stderr: stderr || (error ? error.message : "") });
    });
  });
}

/** rm's strerror texts under `LC_ALL=C`, as the errno a reader searches for. */
const ERRNO_BY_MESSAGE = new Map([
  ["Permission denied", "EACCES"],
  ["Operation not permitted", "EPERM"],
  ["Directory not empty", "ENOTEMPTY"],
  ["Read-only file system", "EROFS"],
  ["Device or resource busy", "EBUSY"],
]);

/** "<errno> on <path>" from rm's first refusal (GNU: `rm: cannot remove
 *  '<path>': <text>`; BSD: `rm: <path>: <text>`). */
export function removalFailure(stderr: string): string | null {
  for (const line of stderr.split("\n")) {
    const match =
      /^rm: cannot remove '(.+)': (.+)$/.exec(line.trim()) ?? /^rm: (\/.+): ([^:]+)$/.exec(line.trim());
    if (!match) continue;
    const [, where, text] = match;
    return `${ERRNO_BY_MESSAGE.get(text ?? "") ?? text} on ${where}`;
  }
  return null;
}

function refuseNobody(target: string): AppError {
  return new AppError({
    code: ERROR_CODES.RUN_UNAVAILABLE,
    status: 409,
    userMessage:
      `${target} could not be removed as its person's own user (ruling 485): no person is named to remove it as. ` +
      "Nothing was removed; a tree an agent writes is never removed as the server's own user.",
  });
}

function checkTarget(target: string): void {
  if (!path.isAbsolute(target) || path.dirname(target) === target) {
    throw new Error(`refusing to remove ${JSON.stringify(target)}: not an absolute path below a root`);
  }
}

function settle(target: string, left: string | null): void {
  if (left === null) return;
  const failure =
    removalFailure(left) ?? (left.trim() || "it was still there after the removal as its person");
  throw new AgentTreeRemovalError(target, failure, left.trim());
}

/**
 * Remove `target`, a tree an agent can write, as `person` (their launch, from
 * `agentGitLaunchFor` or a run's `RunSpec.agent`). `null` is the server's own
 * user and is allowed only when this server launches no agents; with isolation
 * on it refuses (a `run_unavailable` AppError) and removes nothing. Resolves
 * when the tree is gone (or was never there); throws an
 * {@link AgentTreeRemovalError} naming the path and the OS error otherwise.
 */
export async function removeAgentTree(target: string, person: AgentLaunch | null): Promise<void> {
  checkTarget(target);
  if (!present(target)) return;
  if (!person && launchesAgents()) throw refuseNobody(target);
  const plan = removalPlan(target, person);
  let next = plan.next();
  while (!next.done) next = plan.next(await runStep(next.value));
  settle(target, next.value);
}

/** {@link removeAgentTree} for a caller that must finish before it returns (a
 *  run's settle, boot's workspace reclaim, the seed). */
export function removeAgentTreeSync(target: string, person: AgentLaunch | null): void {
  checkTarget(target);
  if (!present(target)) return;
  if (!person && launchesAgents()) throw refuseNobody(target);
  const plan = removalPlan(target, person);
  let next = plan.next();
  while (!next.done) next = plan.next(runStepSync(next.value));
  settle(target, next.value);
}
