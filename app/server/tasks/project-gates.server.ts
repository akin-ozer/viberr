import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import {
  EVIDENCE_EMPTY_COLUMN,
  normalizeEvidenceRows,
  type GateResult,
  type GateRun,
  type ParsedTaskFile,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";
import { GATE_DEFAULT_TIMEOUT_SECONDS, type ProjectGate } from "~/schemas/project-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import {
  resolveStoreSegment,
  taskAttachmentsDir,
  taskDir,
} from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
  type TaskFileRef,
} from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  agentGitLaunchFor,
  launchEnv,
  launchedSignal,
  launchesAgents,
  resolveExecutable,
  shareDirWithAgentsOrWarn,
  type AgentLaunch,
} from "~/server/runtimes/agent-isolation.server";
import { removeAgentTree } from "~/server/runtimes/agent-trees.server";
import { reapRunProcesses, RUN_MARKER_ENV } from "~/server/runtimes/run-processes.server";
import { filteredSpawnEnv } from "~/server/runtimes/spawn-env.server";
import { newId } from "~/shared/ids/new-id.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  gateLogName,
  gateOutcomeText,
  gateRunMatchesDeclared,
  gateSubject,
  gateWallTime,
  projectGatesView,
} from "~/shared/project-gates";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { githubRemoteSanitizationArgs } from "./git-clone-auth.server";
import { workspaceGitAs, type WorkspaceGit } from "./workspace-git.server";
import { refreshWorkspaceFromMirror } from "./workspace-refresh.server";
import type { TaskActionDeps } from "./task-actions.server";

/**
 * Ruling 482 (pass 40, F40-52): **Viberr runs the project's gates itself.**
 *
 * The gate list used to be prose: a rulings knowledge base said "the only gate
 * is `pnpm build`", WEB-1's measured set sat under "Proposed (not binding)",
 * every directive re-typed the commands, and the result came back as an
 * agent's sentence ("4 exit 0 · 0 failed"), repeated by a second agent. The
 * person who accepted a production deploy had no fact about the sha, only a
 * claim — and a skipped or misreported gate could not be told from a real one.
 *
 * Now `project.md` declares `gates: [{name, command, timeoutSeconds?}]`, and
 * this module runs them:
 *
 *  - **When.** A delivery (`performDelivery`) and every new head that stales
 *    the verdicts — a workspace reconcile that mints a revision while a pull
 *    request stands, the reconciler's external revision — ask for a run
 *    ({@link requestProjectGates}). A person can ask from the PR card, and a
 *    changed gate list re-asks for every open delivered task.
 *  - **Off the request path.** The request only writes `gateRun: queued` onto
 *    the task and enqueues; one worker runs one task's gates at a time,
 *    instance-wide, so a burst of deliveries never runs builds in parallel on
 *    a shared host.
 *  - **Where, and as whom.** A fresh clone of the delivering checkout, taken
 *    through git's transport as the task's owner (the delivering workspace is
 *    agent-written, pass 40 review R-seams-1), detached at the revision's sha
 *    — fetched from the project's mirror when the checkout does not have it
 *    (an external revision). Each command runs as `sh -c` through the ruling
 *    460 launcher as the owner's agent uid, with `filteredSpawnEnv()` (no
 *    secret, no app configuration) and the agent's own `$HOME`; with no
 *    launcher (the host dev server, tests) as the server's own user, the way
 *    workspace git does. Never as the server where isolation is on.
 *  - **What is recorded.** Per gate: exit code, whether it was killed at its
 *    timeout, wall time, and the combined output saved as a task attachment.
 *    The record is bound to the revision id and sha, like a verdict, and the
 *    finished run adds one timeline note that claims its logs.
 *  - **What it does.** `projectGatesRefusal` blocks a plain acceptance until
 *    every gate exited 0 on the revision under review; force accept still
 *    works and names the bypass. A failing gate re-invokes the operator
 *    (`gates-failed`) to dispatch the rework.
 */

/** Why a run was asked for; recorded on the run, display only. */
export type GateRunReason = "delivery" | "revision" | "person" | "gates-changed" | "restart";

export interface GateRequestResult {
  /** `queued`: a run was written and enqueued. `current`: this revision's run
   *  is already queued, running, or finished under the declared list.
   *  `not_owed`: nothing to run (no gates, no delivered revision, a closed
   *  task). */
  status: "queued" | "current" | "not_owed";
  message: string;
  runId?: string;
}

interface GateJob {
  db: DatabaseSync;
  runId: string;
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
  /** Tests: the operator a failing run hands the rework to. */
  runOperator?: TaskActionDeps["runOperator"];
}

/** Where a gate run is asked for: the task, and (tests) the operator seam. */
export interface GateRequestInput {
  projectSlug: string;
  taskKey: string;
  dataRoot?: string | undefined;
  deps?: Pick<TaskActionDeps, "runOperator"> | undefined;
}

/** Output kept per gate log: the first part and the last part, the middle cut. */
const LOG_HEAD_BYTES = 256 * 1024;
const LOG_TAIL_BYTES = 1792 * 1024;
/** After a timeout's SIGTERM, how long a gate has before its group is killed. */
const KILL_GRACE_MS = 5_000;
/** The leftover sweep after a gate exits (daemons it forked). */
const REAP_GRACE_MS = 2_000;
const GIT_TIMEOUT_MS = 10 * 60_000;
/** How much of a could-not-run reason the record keeps. */
const FAILURE_MAX_CHARS = 600;

// ------------------------------------------------------------ the queue

const pending: GateJob[] = [];
/** Run ids queued or running in THIS process. A record that says queued or
 *  running without being here was orphaned by a restart. */
const live = new Set<string>();
let draining: Promise<void> | null = null;
/** Operator hand-offs a failing run made; never awaited by the queue. */
const handoffs = new Set<Promise<void>>();

function kick(): void {
  if (draining) return;
  draining = (async () => {
    try {
      while (pending.length > 0) {
        const job = pending.shift()!;
        try {
          await runGateJob(job);
        } catch (error) {
          logger.error("a project gate run failed outside its own handling", {
            taskKey: job.taskKey,
            runId: job.runId,
            err: toError(error),
          });
        } finally {
          live.delete(job.runId);
        }
      }
    } finally {
      draining = null;
      // A job enqueued between the loop's last check and here starts now.
      if (pending.length > 0) kick();
    }
  })();
}

function enqueue(job: GateJob): void {
  // A newer request for the same task replaces one still waiting: the record
  // now names the newer run, so the older one would only be skipped.
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const queued = pending[i]!;
    if (queued.projectSlug === job.projectSlug && queued.taskKey === job.taskKey) {
      live.delete(queued.runId);
      pending.splice(i, 1);
    }
  }
  pending.push(job);
  live.add(job.runId);
  kick();
}

/** Tests: resolves once every queued gate run, and the operator hand-off a
 *  failing one made, has finished. */
export async function whenProjectGatesIdle(): Promise<void> {
  while (draining || handoffs.size > 0) {
    if (draining) await draining;
    await Promise.all(handoffs);
  }
}

/** Tests: forget every queued run (a run in flight finishes on its own). */
export function resetProjectGatesForTests(): void {
  pending.length = 0;
  live.clear();
}

// ------------------------------------------------------------ requesting

function refOf(input: { projectSlug: string; taskKey: string; dataRoot?: string | undefined }): TaskFileRef {
  const ref: TaskFileRef = { projectSlug: input.projectSlug, taskKey: input.taskKey };
  if (input.dataRoot) ref.dataRoot = input.dataRoot;
  return ref;
}

function reproject(db: DatabaseSync, ref: TaskFileRef): void {
  rebuildPath(db, resolveTaskFilePath(ref), ref.dataRoot ? { dataRoot: ref.dataRoot } : {});
}

/**
 * Ask for the project's gates on the task's revision under review. Writes the
 * `queued` record (so the acceptance gate refuses at once) and enqueues the
 * run; never runs anything on the caller's path. Idempotent: a revision whose
 * run is already queued, running, or finished under the declared list answers
 * `current` — unless `force` (a person's "Run gates"), which re-runs a
 * finished one.
 */
export async function requestProjectGates(
  db: DatabaseSync,
  input: GateRequestInput,
  opts: { reason: GateRunReason; force?: boolean },
): Promise<GateRequestResult> {
  const ref = refOf(input);
  const project = readProjectFile(
    input.dataRoot ? { projectSlug: input.projectSlug, dataRoot: input.dataRoot } : { projectSlug: input.projectSlug },
  );
  const gates = project?.parsed.frontmatter.gates ?? [];
  if (!project || gates.length === 0) {
    return { status: "not_owed", message: "The project declares no gates." };
  }
  const file = readTaskFile(ref);
  if (!file) return { status: "not_owed", message: `${input.taskKey} has no task file.` };
  const fm = file.parsed.frontmatter;
  if (fm.archived || isTerminalStage(fm.stage, project.parsed.frontmatter.stages)) {
    return { status: "not_owed", message: `${input.taskKey} is closed; its gates are not run again.` };
  }
  const subject = gateSubject(fm);
  if (!subject) {
    return {
      status: "not_owed",
      message: `${input.taskKey} has no delivered revision for the gates to run on.`,
    };
  }
  const current = fm.gateRun;
  if (current && current.revisionId === subject.id && current.headSha === subject.headSha) {
    if ((current.status === "queued" || current.status === "running") && live.has(current.id)) {
      return {
        status: "current",
        message: `The project's gates are already ${current.status} on \`${subject.headSha.slice(0, 7)}\`.`,
        runId: current.id,
      };
    }
    if (!opts.force && current.status === "finished" && gateRunMatchesDeclared(current, gates)) {
      return {
        status: "current",
        message: `The project's gates already ran on \`${subject.headSha.slice(0, 7)}\`.`,
        runId: current.id,
      };
    }
  }
  const run: GateRun = {
    id: newId("gate"),
    revisionId: subject.id,
    headSha: subject.headSha,
    status: "queued",
    reason: opts.reason,
    requestedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    results: [],
  };
  const write = { done: false };
  await updateTaskFile(ref, (parsed) => {
    // Re-checked under the lock: a delivery landing in between replaced the
    // revision, and its own request names the new one.
    const now = gateSubject(parsed.frontmatter);
    if (!now || now.id !== run.revisionId || now.headSha !== run.headSha) return;
    parsed.frontmatter.gateRun = run;
    write.done = true;
  });
  if (!write.done) {
    return { status: "not_owed", message: `${input.taskKey}'s revision moved while the gates were being queued.` };
  }
  reproject(db, ref);
  const job: GateJob = { db, runId: run.id, projectSlug: input.projectSlug, taskKey: input.taskKey };
  if (input.dataRoot) job.dataRoot = input.dataRoot;
  if (input.deps?.runOperator) job.runOperator = input.deps.runOperator;
  enqueue(job);
  return {
    status: "queued",
    message: `The project's gates are queued on \`${subject.headSha.slice(0, 7)}\`; Viberr runs them and records each exit code.`,
    runId: run.id,
  };
}

/**
 * {@link requestProjectGates} for a caller whose own work must never fail on
 * it (a delivery, a reconcile): every error is logged and swallowed.
 */
export async function requestProjectGatesQuietly(
  db: DatabaseSync,
  input: GateRequestInput,
  reason: GateRunReason,
): Promise<void> {
  try {
    await requestProjectGates(db, input, { reason });
  } catch (error) {
    logger.warn("project gates could not be queued", {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      reason,
      err: toError(error),
    });
  }
}

/**
 * Ruling 482: a changed gate list re-asks for every open task that has a
 * delivered revision, so a promoted gate set is evidence on the tasks already
 * in review rather than a refusal nobody can clear without a click.
 */
export async function requestGatesForOpenTasks(
  db: DatabaseSync,
  projectSlug: string,
  dataRoot?: string,
): Promise<number> {
  // SAFETY: both columns are NOT NULL TEXT in 0001_baseline.
  const rows = db
    .prepare(
      `SELECT task_key FROM task_projections
        WHERE project_slug = ? AND archived = 0 AND work_revision_sha IS NOT NULL`,
    )
    .all(projectSlug) as { task_key: string }[];
  let queued = 0;
  for (const row of rows) {
    try {
      const result = await requestProjectGates(
        db,
        { projectSlug, taskKey: row.task_key, dataRoot },
        { reason: "gates-changed" },
      );
      if (result.status === "queued") queued += 1;
    } catch (error) {
      logger.warn("project gates could not be queued after a gate-list change", {
        projectSlug,
        taskKey: row.task_key,
        err: toError(error),
      });
    }
  }
  return queued;
}

/**
 * Boot: a record left `queued` or `running` by the previous process has no
 * worker behind it. Each is asked for again, so the evidence the acceptance
 * gate waits on is produced rather than waited for forever.
 */
export async function recoverProjectGates(db: DatabaseSync, dataRoot?: string): Promise<number> {
  // SAFETY: both columns are NOT NULL TEXT in 0001_baseline.
  const rows = db
    .prepare(
      `SELECT project_slug, task_key FROM task_projections
        WHERE archived = 0 AND work_revision_sha IS NOT NULL`,
    )
    .all() as { project_slug: string; task_key: string }[];
  let requeued = 0;
  for (const row of rows) {
    const ref = refOf({ projectSlug: row.project_slug, taskKey: row.task_key, dataRoot });
    const run = readTaskFile(ref)?.parsed.frontmatter.gateRun;
    if (!run || (run.status !== "queued" && run.status !== "running") || live.has(run.id)) continue;
    try {
      const result = await requestProjectGates(
        db,
        { projectSlug: row.project_slug, taskKey: row.task_key, dataRoot },
        { reason: "restart", force: true },
      );
      if (result.status === "queued") requeued += 1;
    } catch (error) {
      logger.warn("an interrupted gate run could not be queued again", {
        taskKey: row.task_key,
        err: toError(error),
      });
    }
  }
  return requeued;
}

// ------------------------------------------------------------ running

class GateRunSuperseded extends Error {}

/** Where the finishing write leaves the record it wrote. */
interface FinishedRunHolder {
  run: GateRun | null;
}

/** Apply `mutate` to the run record while it is still this run's. */
async function patchRun(
  job: GateJob,
  mutate: (run: GateRun, parsed: ParsedTaskFile) => void,
): Promise<void> {
  const ref = refOf(job);
  const write = { applied: false };
  await updateTaskFile(ref, (parsed) => {
    const run = parsed.frontmatter.gateRun;
    if (!run || run.id !== job.runId) return;
    mutate(run, parsed);
    write.applied = true;
  });
  if (!write.applied) throw new GateRunSuperseded();
  reproject(job.db, ref);
}

/** Who a gate runs as: the task owner's agent uid through the launcher, or
 *  (isolation off) the server's own user. Throws when isolation is on and
 *  nobody can be named — ruling 460(h): never the server instead. */
function gateLaunch(db: DatabaseSync, ownerUserId: string | null, dataRoot?: string): AgentLaunch | null {
  if (!launchesAgents()) return null;
  if (!ownerUserId) {
    throw new AppError({
      code: ERROR_CODES.RUN_UNAVAILABLE,
      status: 409,
      userMessage:
        "the task has no owner to run them as (ruling 460: a gate runs as its person's agent user, never as the server)",
    });
  }
  return agentGitLaunchFor(db, ownerUserId, dataRoot);
}

/** The combined output of one gate, bounded: the head and the tail are kept,
 *  the middle is cut with a marker saying how much. */
class BoundedLog {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private cut = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < LOG_HEAD_BYTES) {
      const room = LOG_HEAD_BYTES - this.headBytes;
      const take = rest.subarray(0, room);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > LOG_TAIL_BYTES && this.tail.length > 0) {
      const first = this.tail[0]!;
      const over = this.tailBytes - LOG_TAIL_BYTES;
      if (first.length <= over) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.cut += first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailBytes -= over;
        this.cut += over;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (this.cut === 0) return head + tail;
    return `${head}\n[… ${this.cut} bytes of output cut …]\n${tail}`;
  }
}

export interface GateCommandInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  launch: AgentLaunch | null;
  env: Record<string, string>;
  /** `VIBERR_RUN_ID` for the leftover sweep. */
  marker: string;
}

export interface GateCommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  output: string;
  /** The process could not be spawned at all. */
  spawnError: string | null;
}

/** `sh -c <command>` as `launch` (or as the server), its own process group,
 *  killed with its group at the timeout. Never rejects. */
export function runGateCommand(input: GateCommandInput): Promise<GateCommandOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = new BoundedLog();
    let settled = false;
    const settle = (outcome: Omit<GateCommandOutcome, "wallMs" | "output">): void => {
      if (settled) return;
      settled = true;
      resolve({ ...outcome, wallMs: Date.now() - started, output: log.text() });
    };
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      const sh = resolveExecutable("sh", input.env.PATH ?? process.env.PATH ?? "");
      const file = input.launch ? input.launch.launcher : sh;
      const env = input.launch ? launchEnv(input.launch, sh, input.env) : input.env;
      child = spawn(file, ["-c", input.command], {
        cwd: input.cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      settle({ exitCode: null, timedOut: false, spawnError: errorMessage(error) });
      return;
    }
    const pid = child.pid ?? null;
    const signalGroup = (requested: NodeJS.Signals): void => {
      const signal = input.launch ? launchedSignal(requested) : requested;
      if (pid !== null && pid > 1) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // The group is gone; the process alone, below.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      log.push(Buffer.from(`\n[viberr] the gate ran past its ${Math.round(input.timeoutMs / 1000)} s timeout and was stopped\n`));
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }, input.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => log.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => log.push(chunk));
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    let spawnError: string | null = null;
    child.on("error", (error) => {
      spawnError = errorMessage(error);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      settle({ exitCode: null, timedOut: false, spawnError });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // A process a signal ended reports the shell's convention, 128 + n, so
      // "killed" never reads as "did not start".
      const signalled =
        signal !== null ? 128 + (osConstants.signals[signal] ?? 0) : null;
      const exitCode = timedOut ? null : (code ?? signalled);
      void reapRunProcesses(
        { runIds: [input.marker], groupLeader: pid, launched: input.launch !== null },
        { graceMs: REAP_GRACE_MS },
      )
        .catch(() => undefined)
        .finally(() => settle({ exitCode, timedOut, spawnError }));
    });
  });
}

/** The environment a gate runs with: the server's minus every credential and
 *  every Viberr setting (`filteredSpawnEnv`), the person's own `$HOME`, and
 *  the sweep marker. Nothing else. */
function gateEnv(launch: AgentLaunch | null, marker: string): Record<string, string> {
  const env = filteredSpawnEnv();
  if (launch?.home) env.HOME = launch.home;
  env[RUN_MARKER_ENV] = marker;
  return env;
}

interface GateCheckout {
  /** The checkout the gates run in. */
  dir: string;
  /** What to remove afterwards. */
  root: string;
}

/**
 * A fresh clone of the delivering checkout at the revision's sha, made as the
 * task's person. Throws with the sentence the record keeps.
 */
async function prepareGateCheckout(
  db: DatabaseSync,
  job: GateJob,
  git: WorkspaceGit,
  input: { repo: string | null; defaultBranch: string; headSha: string },
): Promise<GateCheckout> {
  if (!input.repo) throw new Error("the project has no repository to check the revision out of");
  const name = input.repo.split("/").pop() ?? input.repo;
  const workspaceRoot = path.join(taskDir(job.projectSlug, job.taskKey, job.dataRoot), "workspace");
  const delivering = path.join(workspaceRoot, name);
  if (!existsSync(path.join(delivering, ".git"))) {
    throw new Error(
      `the delivering checkout (\`workspace/${name}\`) is not there to take the revision from`,
    );
  }
  const gatesRoot = path.join(workspaceRoot, ".gates");
  const root = path.join(gatesRoot, job.runId);
  // Ruling 460: the clone below is made by the person's uid, so the
  // directories it lands in are the agents' to write.
  shareDirWithAgentsOrWarn(workspaceRoot);
  shareDirWithAgentsOrWarn(gatesRoot);
  // One worker runs one gate run at a time, so anything else here is a run a
  // restart cut short: removed before this one starts.
  for (const stale of readdirSync(gatesRoot)) {
    if (stale !== job.runId) await removeGateCheckout(path.join(gatesRoot, stale), git.launch);
  }
  shareDirWithAgentsOrWarn(root);
  const dir = path.join(root, name);
  // Through git's transport, never `--local` (pass 40 review R-seams-2), and
  // as the person (R-seams-1): the delivering checkout is agent-written.
  await git.run(["clone", "--no-local", "--quiet", delivering, dir], { timeoutMs: GIT_TIMEOUT_MS });
  await git.run(githubRemoteSanitizationArgs(input.repo, dir), { timeoutMs: 10_000 });
  const has = async (): Promise<boolean> => {
    try {
      await git.run(["-C", dir, "cat-file", "-e", `${input.headSha}^{commit}`], { timeoutMs: 10_000 });
      return true;
    } catch {
      return false;
    }
  };
  if (!(await has())) {
    // An external revision (ruling 179) is a head GitHub has and the
    // delivering checkout never saw: read origin's heads from the mirror.
    const refresh: Parameters<typeof refreshWorkspaceFromMirror>[1] = {
      projectSlug: job.projectSlug,
      repo: input.repo,
      dir,
      defaultBranch: input.defaultBranch,
      fastForward: false,
      taskKey: job.taskKey,
    };
    if (job.dataRoot) refresh.dataRoot = job.dataRoot;
    await refreshWorkspaceFromMirror(db, refresh);
    if (!(await has())) {
      throw new Error(
        `the revision \`${input.headSha.slice(0, 7)}\` is in neither the delivering checkout nor the project's mirror`,
      );
    }
  }
  await git.run(["-C", dir, "checkout", "--quiet", "--detach", input.headSha], { timeoutMs: 120_000 });
  return { dir, root };
}

/** Remove a gate checkout as the person its gates ran as (ruling 485: their
 *  files, whatever mode a tool left them in, and never the server's own
 *  recursive remove after it). A checkout left behind costs disk and is
 *  removed before the next gate run. */
async function removeGateCheckout(root: string, launch: AgentLaunch | null): Promise<void> {
  try {
    await removeAgentTree(root, launch);
  } catch (error) {
    logger.warn("a gate checkout could not be removed", { root, err: toError(error) });
  }
}

/** Save one gate's log as a task attachment; null when it cannot be saved. */
function saveGateLog(
  job: GateJob,
  input: {
    sha: string;
    index: number;
    gate: ProjectGate;
    startedAt: string;
    outcome: GateCommandOutcome;
    runsAs: string;
  },
): string | null {
  const name = gateLogName(input.sha, input.index, input.gate.name, input.startedAt);
  const dir = taskAttachmentsDir(job.projectSlug, job.taskKey, job.dataRoot);
  const header = [
    `# Viberr project gate \`${input.gate.name}\` on ${input.sha} (${job.taskKey}, ruling 482)`,
    `# command: ${input.gate.command.replace(/\s*\n\s*/g, " ")}`,
    `# run as: ${input.runsAs}`,
    `# started: ${input.startedAt}`,
    "",
  ].join("\n");
  const footer = [
    "",
    `# result: ${gateOutcomeText(input.outcome)} after ${gateWallTime(input.outcome.wallMs)}` +
      (input.outcome.spawnError ? ` (${input.outcome.spawnError})` : ""),
    "",
  ].join("\n");
  try {
    shareDirWithAgentsOrWarn(dir);
    writeFileSync(resolveStoreSegment(dir, name), header + input.outcome.output + footer);
    return name;
  } catch (error) {
    logger.warn("a gate log could not be saved", { taskKey: job.taskKey, name, err: toError(error) });
    return null;
  }
}

const GATES_ACTOR = { kind: "system", systemId: "project-gates" } as const;

/** The timeline note a finished (or failed-to-run) gate run writes. */
function gateRunEvent(run: GateRun, gates: readonly ProjectGate[], taskKey: string): TaskFileEvent {
  const view = projectGatesView(gates, {
    workRevision: {
      id: run.revisionId,
      headSha: run.headSha,
      treeSha: null,
      branch: null,
      createdAt: run.requestedAt,
      sourceProfileId: null,
    },
    gateRun: run,
  });
  const line = view?.line ?? `Gates on ${run.headSha.slice(0, 7)}`;
  const failed = run.results.filter((r) => r.exitCode !== 0);
  let title: string;
  let text: string;
  if (run.status === "error") {
    title = "Project gates could not run";
    text =
      `**${line}.** Viberr could not run the project's gates on \`${run.headSha.slice(0, 7)}\`: ${run.error}. ` +
      `${taskKey} cannot be accepted on this revision until they run; a maintainer or the task owner can run them again from the GitHub card.`;
  } else if (failed.length > 0) {
    title = "Project gates failed";
    text =
      `**${line}.** ${failed.map((r) => `\`${r.name}\` ${gateOutcomeText(r)}`).join(", ")}. ` +
      `${taskKey} cannot be accepted on this revision; the next delivered revision is gated again, and an admin can force-accept on the record. Each gate's log is attached.`;
  } else {
    title = "Project gates passed";
    text = `**${line}.** Each gate's log is attached.`;
  }
  const evidence = normalizeEvidenceRows(
    run.results.map((r) => ({
      label: `${r.name}: ${gateOutcomeText(r)} in ${gateWallTime(r.wallMs)}${r.log ? ` · ${r.log}` : ""}`,
      add: EVIDENCE_EMPTY_COLUMN,
      del: EVIDENCE_EMPTY_COLUMN,
    })),
  );
  const logs = run.results.flatMap((r) => (r.log ? [r.log] : []));
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "note",
    actor: GATES_ACTOR,
    title,
    text,
    toAgent: false,
    evidence,
  };
  if (logs.length > 0) event.attachments = logs;
  return event;
}

async function runGateJob(job: GateJob): Promise<void> {
  const ref = refOf(job);
  const file = readTaskFile(ref);
  const record = file?.parsed.frontmatter.gateRun;
  if (!file || !record || record.id !== job.runId) return; // superseded
  const project = readProjectFile(
    job.dataRoot ? { projectSlug: job.projectSlug, dataRoot: job.dataRoot } : { projectSlug: job.projectSlug },
  );
  const gates = project?.parsed.frontmatter.gates ?? [];
  if (gates.length === 0) {
    // The list was cleared while this run waited: there is nothing to run and
    // nothing to say, so the record goes and no note is written.
    await updateTaskFile(ref, (parsed) => {
      if (parsed.frontmatter.gateRun?.id === job.runId) delete parsed.frontmatter.gateRun;
    });
    reproject(job.db, ref);
    return;
  }
  const results: GateResult[] = [];
  let failure: string | null = null;
  let launch: AgentLaunch | null = null;
  let checkout: GateCheckout | null = null;
  try {
    await patchRun(job, (run) => {
      run.status = "running";
      run.startedAt = new Date().toISOString();
    });
    launch = gateLaunch(job.db, file.parsed.frontmatter.ownerUserId, job.dataRoot);
    const git = workspaceGitAs(launch);
    checkout = await prepareGateCheckout(job.db, job, git, {
      repo: project?.parsed.frontmatter.repo ?? null,
      defaultBranch: project?.parsed.frontmatter.defaultBranch || "main",
      headSha: record.headSha,
    });
    const runsAs = launch ? `agent uid ${launch.uid} (the task owner)` : "the server's own user (no agent launcher)";
    for (const [index, gate] of gates.entries()) {
      const startedAt = new Date().toISOString();
      const marker = `${job.runId}-${index + 1}`;
      const outcome = await runGateCommand({
        command: gate.command,
        cwd: checkout.dir,
        timeoutMs: (gate.timeoutSeconds ?? GATE_DEFAULT_TIMEOUT_SECONDS) * 1000,
        launch,
        env: gateEnv(launch, marker),
        marker,
      });
      const log = saveGateLog(job, {
        sha: record.headSha,
        index: index + 1,
        gate,
        startedAt,
        outcome,
        runsAs,
      });
      results.push({
        name: gate.name,
        command: gate.command,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        wallMs: outcome.wallMs,
        log,
      });
      await patchRun(job, (run) => {
        run.results = results.map((r) => ({ ...r }));
      });
    }
  } catch (error) {
    if (error instanceof GateRunSuperseded) {
      if (checkout) await removeGateCheckout(checkout.root, launch);
      return;
    }
    // One line, bounded: it is printed on the PR card and in the refusal.
    const said = (error instanceof AppError ? error.userMessage : errorMessage(error))
      .replace(/\s+/g, " ")
      .trim();
    failure = said.length > FAILURE_MAX_CHARS ? `${said.slice(0, FAILURE_MAX_CHARS - 1)}…` : said;
    logger.warn("project gates could not run", {
      projectSlug: job.projectSlug,
      taskKey: job.taskKey,
      runId: job.runId,
      err: toError(error),
    });
  }
  if (checkout) await removeGateCheckout(checkout.root, launch);
  // A holder, not a `let`: the write below assigns it inside a callback.
  const finished: FinishedRunHolder = { run: null };
  try {
    await patchRun(job, (run, parsed) => {
      run.status = failure ? "error" : "finished";
      run.finishedAt = new Date().toISOString();
      run.error = failure;
      run.results = results.map((r) => ({ ...r }));
      parsed.timeline.unshift(gateRunEvent(run, gates, job.taskKey));
      finished.run = { ...run, results: run.results.map((r) => ({ ...r })) };
    });
  } catch (error) {
    if (error instanceof GateRunSuperseded) return;
    throw error;
  }
  const done = finished.run;
  if (!done) return;
  const passed = done.results.filter((r) => r.exitCode === 0).length;
  const failedGates = done.results.filter((r) => r.exitCode !== 0).map((r) => r.name);
  recordAudit(job.db, {
    action: "task.gates.run",
    actor: SYSTEM_ACTOR,
    subjectKind: "task",
    subjectId: job.taskKey,
    projectSlug: job.projectSlug,
    taskKey: job.taskKey,
    details: {
      runId: done.id,
      revisionId: done.revisionId,
      headSha: done.headSha,
      status: done.status,
      reason: done.reason,
      passed,
      total: gates.length,
      failed: failedGates,
      error: done.error,
      runsAs: launch ? launch.uid : "server",
    },
  });
  if (done.status === "finished" && failedGates.length > 0) {
    // Ruling 482: a failing gate is the operator's to act on — it dispatches
    // the rework — so the result is handed to it rather than left on a card.
    const { autoInvokeOperator } = await import("./task-actions.server");
    const operatorCtx: Parameters<typeof autoInvokeOperator>[1] = {};
    if (job.dataRoot) operatorCtx.dataRoot = job.dataRoot;
    if (job.runOperator) operatorCtx.deps = { runOperator: job.runOperator };
    const handoff = autoInvokeOperator(
      job.db,
      operatorCtx,
      job.projectSlug,
      job.taskKey,
      "gates-failed",
    ).catch(() => {});
    handoffs.add(handoff);
    void handoff.finally(() => handoffs.delete(handoff));
  }
}
