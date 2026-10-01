import { execFile, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { logger } from "~/server/logging/logger.server";
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
 *
 * Ruling 495 (F40-71) completes this for what the SERVER wrote in such a tree,
 * which no agent pass could remove: a run's skill plugin as `cpSync` copied it
 * (its files in folders the store's 0755 left the person unable to write),
 * and the workspace root (`node`'s 2770, in a task directory only `node`
 * writes, so no agent uid may unlink it even empty). When the agent passes
 * leave entries, the server takes one step as itself,
 * `chmod -R -P g+rwX -- <tree>`, which opens its own entries to their group,
 * and the person's pass and the owner rounds run again. When they leave the
 * target an EMPTY directory the server's uid owns, the server removes it with
 * `rmdir -- <tree>`. A target still holding entries stays a fault naming the
 * path and the OS error, and an empty one an agent uid owns is left to the
 * agent passes. What the mount writes from now on needs neither step
 * (`copySkillFolder`, `skill-mount.server.ts`).
 *
 * 485's safety argument holds:
 *  - no recursive remove runs with the server's authority: its steps are a
 *    `chmod`, which removes nothing, and an `rmdir`, which walks nothing and
 *    refuses a directory with anything in it and a link (ENOTDIR);
 *  - `chmod -R -P` follows no symbolic link, during the traversal or at the
 *    tree itself. (`-P` because GNU chmod's `-R` defaults to `-H`, which
 *    traverses a link named on the command line: measured in the image,
 *    coreutils 9.7, `chmod -R g+rwX -- <link>` changed the linked tree and
 *    `chmod -R -P g+rwX -- <link>` changed nothing.) chmod refuses every entry
 *    the server does not own, and `g+rwX` opens an entry only to the group it
 *    already has: `state/` and the raw run logs are in the server's own group,
 *    which no agent uid is in;
 *  - `chmod -R` has no way to leave out a file with a second link, so what
 *    matters is which of the server's files a tree can hold a link to. The
 *    server makes some itself: its clone of a checkout from the project
 *    mirror (`git clone --local`) hardlinks the checkout's objects to the
 *    mirror's, and an agent can put one where its person's pass cannot
 *    remove it, so the step reaches it. Boot keeps every mirror file in the
 *    server's own group (`revokeMirrorWrites`, `agent-isolation.server.ts`;
 *    the hand-over before R-seams-1 had put some in the agents' group), so
 *    the step opens such a file to no agent, and the next boot takes the
 *    group write back off. An agent cannot link any other file of the
 *    server's that it cannot already read and write, because
 *    `fs.protected_hardlinks` is 1. That is the host kernel's setting, not
 *    the image's (a container reads the kernel's `/proc/sys/fs`): measured 1
 *    in the e2e stack's container, on this host's kernel, on 2026-09-26
 *    (`protected_symlinks` 1 too), and `scripts/check-agent-isolation.sh`
 *    fails on a host that has it off;
 *  - neither server step runs while a directory above the tree is a link an
 *    agent could have put there (`agentLinkAbove`): one an agent uid owns, or
 *    any link in a folder an agent can write, since an agent can move a link
 *    the server made (a symlink a repository commits, checked out by the
 *    server's clone) into any folder it writes. The server puts no link on
 *    these paths itself. Through such a link the steps would reach another
 *    directory of the tree's name. The check reads before each step; a link
 *    swapped in between the read and the step is not covered, and what it
 *    could reach is a directory of that name the server owns, where the steps
 *    add group permissions, or remove it if it is empty.
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
  /** The last refusal's stderr (rm's, or rmdir's for an emptied root), for
   *  the log. */
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
export interface RemovalStep {
  launch: AgentLaunch | null;
  command: "chmod" | "rm" | "rmdir";
  args: string[];
}

export interface StepOutcome {
  ok: boolean;
  stderr: string;
}

/** What the rest of a removal depends on, read between its steps; never
 *  through a link. Tests hand the plan their own. */
export interface TreeView {
  /** The target is still there. */
  present(target: string): boolean;
  /** The agent uids that own what the server can see of the target. */
  agentOwners(target: string): number[];
  /** What is left of a target that is still there: `entries` (a directory
   *  with something in it, or one the server cannot list), `empty-server` (an
   *  empty directory the server's own uid owns), or `other` (an empty
   *  directory an agent uid owns, a file, a link). */
  left(target: string): "entries" | "empty-server" | "other";
  /** A directory above the target that is a link an agent could have put
   *  there (one an agent uid owns, or any link in a folder an agent can
   *  write), or null. */
  agentLinkAbove(target: string): string | null;
  /** An agent could put something else at the target's path: the folder
   *  holding it is one an agent writes (or one the server cannot look at). */
  agentMayReplace(target: string): boolean;
}

function present(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isAgentUid(uid: number): boolean {
  return uid >= AGENT_UID_FLOOR && uid <= AGENT_UID_MAX;
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
    if (isAgentUid(uid)) owners.add(uid);
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

/** Ruling 495: what is left once the agent passes are done. */
function leftOf(target: string): "entries" | "empty-server" | "other" {
  let st: Stats;
  try {
    st = lstatSync(target);
  } catch {
    return "other";
  }
  if (!st.isDirectory()) return "other";
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    // A directory the server may not list may still hold its entries.
    return "entries";
  }
  if (names.length > 0) return "entries";
  return st.uid === process.getuid?.() ? "empty-server" : "other";
}

/** Ruling 495: a folder an agent could have put a link in: an agent uid owns
 *  it, or it grants group or other write. Which group is not asked: the
 *  folders agents write are 2770 or 2775 in theirs, and a folder of the
 *  server's that its umask left writable to its own group holds no link of
 *  the server's either. A folder the server cannot look at counts as one. */
function agentWritableFolder(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return isAgentUid(st.uid) || (st.mode & 0o022) !== 0;
  } catch {
    return true;
  }
}

/** Ruling 495: the first directory above `target` that is a link an agent
 *  could have put there, or null: a link an agent uid owns, or any link in a
 *  folder an agent can write, whoever owns it. A link the server made (a
 *  symlink a repository commits, checked out by the server's clone) is the
 *  server's, and an agent can move it to any folder it writes. */
function agentLinkAboveOf(target: string): string | null {
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() && (isAgentUid(st.uid) || agentWritableFolder(path.dirname(dir)))) return dir;
    } catch {
      // Not there: nothing below it resolves through it either.
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** The target's folder, followed: a link above it is either one no agent
 *  could have put there or one `agentLinkAbove` already refused. */
function agentMayReplaceOf(target: string): boolean {
  try {
    const st = statSync(path.dirname(target));
    return isAgentUid(st.uid) || (st.mode & 0o022) !== 0;
  } catch {
    return true;
  }
}

const FS_VIEW: TreeView = {
  present,
  agentOwners: agentOwnersIn,
  left: leftOf,
  agentLinkAbove: agentLinkAboveOf,
  agentMayReplace: agentMayReplaceOf,
};

/**
 * The removal as a plan of commands, so the synchronous and the asynchronous
 * drivers run one sequence. Returns null when the tree is gone, else the
 * stderr of the last refusal (rm's from the last pass that failed, or the
 * server's rmdir's).
 *
 * The order: the person's pass, then each agent uid found in what is left
 * (at most {@link OWNER_ROUNDS} rounds). With isolation on, when that leaves
 * entries, the server opens its own to the group (`chmod -R -P g+rwX`, or
 * without `-P` on a chmod that lacks it, where no agent may replace the
 * target) and the person's pass and the rounds run again; when it leaves an empty
 * directory the server owns, the server's `rmdir` removes it (ruling 495).
 * Exported for the plan's own tests, which pass a {@link TreeView}.
 */
export function* removalPlan(
  target: string,
  person: AgentLaunch | null,
  view: TreeView = FS_VIEW,
): Generator<RemovalStep, string | null, StepOutcome> {
  let stderr = "";
  function* pass(launch: AgentLaunch | null, mode: string): Generator<RemovalStep, void, StepOutcome> {
    // chmod's own refusals (an entry another uid owns) are expected: rm's
    // result and what is left decide.
    yield { launch, command: "chmod", args: ["-R", mode, "--", target] };
    const removed: StepOutcome = yield { launch, command: "rm", args: ["-rf", "--", target] };
    if (!removed.ok && removed.stderr.trim()) stderr = removed.stderr;
  }
  /** The person's pass, then each owner found in what is left; true once
   *  the tree is gone. */
  function* agentPasses(launch: AgentLaunch): Generator<RemovalStep, boolean, StepOutcome> {
    yield* pass(launch, "u+rwX");
    if (!view.present(target)) return true;
    for (let round = 0; round < OWNER_ROUNDS; round += 1) {
      const owners = view.agentOwners(target);
      if (owners.length === 0) break;
      for (const uid of owners) {
        yield* pass({ uid, launcher: launch.launcher }, "u+rwX,g+rwX");
        if (!view.present(target)) return true;
      }
    }
    return false;
  }
  /** The server's own steps run only where no agent's link leads. */
  function serverMayAct(): boolean {
    const link = view.agentLinkAbove(target);
    if (link === null) return true;
    logger.warn("the server's own removal steps were skipped: a directory above the tree is a link an agent could have put there", {
      target,
      link,
    });
    return false;
  }
  if (!person) {
    // Isolation off: one user, nobody else to ask, and none of ruling 495's
    // steps either (495(d)).
    yield* pass(null, "u+rwX");
    return view.present(target) ? stderr : null;
  }
  if (yield* agentPasses(person)) return null;
  // Ruling 495(b): what is left is the server's own; opened to the group,
  // never removed, by the server.
  if (view.left(target) === "entries" && serverMayAct()) {
    const opened: StepOutcome = yield { launch: null, command: "chmod", args: ["-R", "-P", "g+rwX", "--", target] };
    // GNU chmod before coreutils 9.5 has no `-P` and follows a link named on
    // the command line (an Ubuntu 24.04 host). Without it the step runs only
    // where no agent can put a link at the target's path; links met while
    // recursing are ignored by every GNU chmod.
    if (!opened.ok && /invalid option -- '?P'?/.test(opened.stderr) && !view.agentMayReplace(target)) {
      yield { launch: null, command: "chmod", args: ["-R", "g+rwX", "--", target] };
    }
    if (yield* agentPasses(person)) return null;
  }
  // Ruling 495(c): the emptied root the server owns goes with its rmdir.
  if (view.left(target) === "empty-server" && serverMayAct()) {
    const removed: StepOutcome = yield { launch: null, command: "rmdir", args: ["--", target] };
    if (!view.present(target)) return null;
    if (!removed.ok && removed.stderr.trim()) stderr = removed.stderr;
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

/** rm's and rmdir's strerror texts under `LC_ALL=C`, as the errno a reader
 *  searches for. */
const ERRNO_BY_MESSAGE = new Map([
  ["Permission denied", "EACCES"],
  ["Operation not permitted", "EPERM"],
  ["Directory not empty", "ENOTEMPTY"],
  ["Not a directory", "ENOTDIR"],
  ["Read-only file system", "EROFS"],
  ["Device or resource busy", "EBUSY"],
]);

/** "<errno> on <path>" from the first refusal of rm (GNU: `rm: cannot remove
 *  '<path>': <text>`; BSD: `rm: <path>: <text>`) or of the server's rmdir of
 *  an emptied root (GNU: `rmdir: failed to remove '<path>': <text>`; BSD:
 *  `rmdir: <path>: <text>`). GNU names itself by its argv[0], and `spawnOf`
 *  runs the resolved binary, so the name may carry its directory
 *  (`/usr/bin/rm: cannot remove …`). */
export function removalFailure(stderr: string): string | null {
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim().replace(/^\/\S*\/(rm|rmdir):/, "$1:");
    const match =
      /^rm: cannot remove '(.+)': (.+)$/.exec(trimmed) ??
      /^rmdir: failed to remove '(.+)': (.+)$/.exec(trimmed) ??
      /^rmdir: (\/.+): ([^:]+)$/.exec(trimmed) ??
      /^rm: (\/.+): ([^:]+)$/.exec(trimmed);
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
 * on it refuses (a `run_unavailable` AppError) and removes nothing. What the
 * agent passes leave of the server's own is opened by the server and removed
 * by the person, and an emptied root the server owns goes with the server's
 * `rmdir` (ruling 495). Resolves when the tree is gone (or was never there);
 * throws an {@link AgentTreeRemovalError} naming the path and the OS error
 * otherwise.
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
