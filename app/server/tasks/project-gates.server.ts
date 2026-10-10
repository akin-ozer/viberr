import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizeEvidenceRows,
  type GateResult,
  type GateRun,
  type ParsedTaskFile,
  type TaskFileEvent,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import { GATE_DEFAULT_TIMEOUT_SECONDS, type ProjectGate } from "~/schemas/project-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { capturesGateRun } from "./page-measured.server";
import {
  resolveStoreSegment,
  taskAttachmentsDir,
  taskDir,
} from "~/server/files/file-store-root.server";
import { keepBuild, projectPagesDir, type KeptBuild } from "~/server/files/kept-builds.server";
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
  resolveExecutable,
  shareDirWithAgentsOrWarn,
  type AgentLaunch,
} from "~/server/runtimes/agent-isolation.server";
import { removeAgentTree } from "~/server/runtimes/agent-trees.server";
import {
  runPersonCommand,
  taskOwnerLaunch,
  type PersonCommandOutcome,
} from "~/server/runtimes/person-command.server";
import { RUN_MARKER_ENV } from "~/server/runtimes/run-processes.server";
import { filteredSpawnEnv } from "~/server/runtimes/spawn-env.server";
import { newId } from "~/shared/ids/new-id.server";
import { errorMessage, toError } from "~/shared/errors";
import {
  GATE_NOTE_TITLE,
  GATES_SYSTEM_ID,
  gateEvidenceLabel,
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
import type { TaskActionDeps } from "./task-action-core.server";

/**
 * Ruling 104 (pass 40, F40-52): **Viberr runs the project's gates itself.**
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
 *    139 launcher as the owner's agent uid, with `filteredSpawnEnv()` (no
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

/** Ruling 86: the folder a gate named for the pages when this finished
 *  run's gates all exited 0 (`pages` on the run, which the task file's
 *  schema keeps and does not declare), or null: no gate named one, or a
 *  gate did not pass. Whether the folder was then kept is `pagesKept`. */
function builtFolderOf(run: GateRun): string | null {
  const read = z.looseObject({ pages: z.string() }).safeParse(run);
  return read.success ? read.data.pages : null;
}

/** Ruling 86: what that keep held (`pagesKept` on the run: how many files,
 *  and how many were past what a build holds), or null when the folder
 *  could not be kept at all. */
function keptOf(run: GateRun): { files: number; leftOut: number } | null {
  const read = z.looseObject({ pagesKept: z.object({ files: z.number(), leftOut: z.number() }) }).safeParse(run);
  return read.success ? read.data.pagesKept : null;
}

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

/**
 * Ruling 86: the tasks with a gate run queued or running here, or with the
 * pictures of the pages that run built still being made, each with a promise
 * that resolves when both are over. What the delivering run's completion
 * waits on ({@link builtPagesSettled}), so the operator and the reviewers it
 * dispatches start with the pages there.
 */
const building = new Map<string, { settled: Promise<void>; settle: () => void; jobs: number }>();

const buildKey = (job: Pick<GateJob, "projectSlug" | "taskKey">): string => `${job.projectSlug}/${job.taskKey}`;

function buildStarts(job: GateJob): void {
  const entry = building.get(buildKey(job));
  if (entry) {
    entry.jobs += 1;
    return;
  }
  let settle = (): void => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  building.set(buildKey(job), { settled, settle, jobs: 1 });
}

function buildEnds(job: GateJob): void {
  const entry = building.get(buildKey(job));
  if (!entry) return;
  entry.jobs -= 1;
  if (entry.jobs > 0) return;
  building.delete(buildKey(job));
  entry.settle();
}

/** How long a delivering run's completion waits for the gates to build its
 *  revision's pages and for their pictures: a slow build never holds the
 *  operator longer, and the pages are then shown when they are there. */
const BUILT_PAGES_WAIT_MS = 300_000;

/**
 * Ruling 86: resolves when no gate run of this task is queued or running here
 * and the pictures of what the last one built are made, or after
 * {@link BUILT_PAGES_WAIT_MS}, whichever is first. At once when nothing of
 * the task's is under way.
 */
export function builtPagesSettled(
  input: { projectSlug: string; taskKey: string },
  waitMs: number = BUILT_PAGES_WAIT_MS,
): Promise<void> {
  const entry = building.get(buildKey(input));
  if (!entry) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    timer.unref?.();
    void entry.settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function kick(): void {
  if (draining) return;
  draining = (async () => {
    try {
      while (pending.length > 0) {
        const job = pending.shift()!;
        let pictured: Promise<void> | null = null;
        try {
          pictured = (await runGateJob(job)).pictured;
        } catch (error) {
          logger.error("a project gate run failed outside its own handling", {
            taskKey: job.taskKey,
            runId: job.runId,
            err: toError(error),
          });
        } finally {
          live.delete(job.runId);
          // The pictures are made off this queue: the next task's gates do
          // not wait for a render.
          if (pictured) void pictured.finally(() => buildEnds(job));
          else buildEnds(job);
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
  // Counted before a waiting job of the same task is taken out, so the task
  // is never settled between the two.
  buildStarts(job);
  // A newer request for the same task replaces one still waiting: the record
  // now names the newer run, so the older one would only be skipped.
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    const queued = pending[i]!;
    if (queued.projectSlug === job.projectSlug && queued.taskKey === job.taskKey) {
      live.delete(queued.runId);
      pending.splice(i, 1);
      buildEnds(queued);
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
    // Ruling 86: a run that passed before a gate named the folder the pages
    // are built into (or while it named another) kept no build of that
    // folder, and running again is how one is kept. By the folder the run
    // itself recorded, never by what is on disk: a folder the build leaves
    // empty is kept as nothing once, and not asked for again.
    const folder = projectPagesDir(gates);
    const owesBuild =
      folder !== null &&
      current.results.every((result) => result.exitCode === 0) &&
      builtFolderOf(current) !== folder;
    if (!opts.force && current.status === "finished" && gateRunMatchesDeclared(current, gates) && !owesBuild) {
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
 * Ruling 104: a changed gate list re-asks for every open task that has a
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
    const fm = readTaskFile(ref)?.parsed.frontmatter;
    const run = fm?.gateRun;
    if (fm && run) picturesOwedAfterRestart(db, ref, fm, run);
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

/**
 * Ruling 86: a run whose gates passed where a gate names a pages folder, on
 * a task with no record of that run's build, was cut off before the ask (it
 * is made after the finishing write, and a restart drops the queue). What
 * the run kept is on disk and on its record, so the same ask is made again,
 * and the task gets that build's pictures, or the note that says there is no
 * page to picture. Held to what every other asker is held to: an open task,
 * on the revision under review, while a gate still names that folder.
 */
function picturesOwedAfterRestart(db: DatabaseSync, ref: TaskFileRef, fm: TaskFrontmatter, run: GateRun): void {
  const folder = builtFolderOf(run);
  if (run.status !== "finished" || folder === null || gateSubject(fm)?.id !== run.revisionId) return;
  // The record is written for every build the ask reached, a page or none,
  // and names the run whose build it is of. One of another run on the same
  // revision (a folder since corrected on the gate, a keep that failed and
  // was run again, a render that outlasted the next run) leaves this run's
  // build still to picture. By the run's id, never by the clock.
  if (capturesGateRun(fm.pageCaptures) === run.id) return;
  const project = readProjectFile(
    ref.dataRoot ? { projectSlug: ref.projectSlug, dataRoot: ref.dataRoot } : { projectSlug: ref.projectSlug },
  )?.parsed.frontmatter;
  if (!project || fm.archived || isTerminalStage(fm.stage, project.stages)) return;
  if (projectPagesDir(project.gates) !== folder) return;
  const kept = keptOf(run);
  const asked = import("./page-capture.server").then(({ requestRevisionCaptures }) =>
    requestRevisionCaptures(db, ref.dataRoot ? { dataRoot: ref.dataRoot } : {}, {
      projectSlug: ref.projectSlug,
      taskKey: ref.taskKey,
      revisionId: run.revisionId,
      gateRunId: run.id,
      folder,
      kept: kept !== null,
      leftOut: kept?.leftOut ?? 0,
    }),
  );
  handoffs.add(asked);
  void asked.finally(() => handoffs.delete(asked));
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
 *  nobody can be named — ruling 139: never the server instead. */
function gateLaunch(db: DatabaseSync, ownerUserId: string | null, dataRoot?: string): AgentLaunch | null {
  return taskOwnerLaunch(
    db,
    ownerUserId,
    dataRoot,
    "the task has no owner to run them as (ruling 139: a gate runs as its person's agent user, never as the server)",
  );
}

interface GateCommandInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  launch: AgentLaunch | null;
  env: Record<string, string>;
  /** `VIBERR_RUN_ID` for the leftover sweep. */
  marker: string;
}

type GateCommandOutcome = PersonCommandOutcome;

/** `sh -c <command>` as `launch` (or as the server), its own process group,
 *  killed with its group at the timeout (`runPersonCommand`, the home ruling
 *  194 gave it). Never rejects. */
function runGateCommand(input: GateCommandInput): Promise<GateCommandOutcome> {
  let sh: string;
  try {
    sh = resolveExecutable("sh", input.env.PATH ?? process.env.PATH ?? "");
  } catch (error) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      wallMs: 0,
      output: "",
      spawnError: errorMessage(error),
    });
  }
  return runPersonCommand({
    file: sh,
    args: ["-c", input.command],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    launch: input.launch,
    env: input.env,
    marker: input.marker,
    timeoutNote: `\n[viberr] the gate ran past its ${Math.round(input.timeoutMs / 1000)} s timeout and was stopped\n`,
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
  // Ruling 15: the clone below is made by the person's uid, so the
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
    // An external revision (ruling 240) is a head GitHub has and the
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

/** Remove a gate checkout as the person its gates ran as (ruling 140: their
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
    `# Viberr project gate \`${input.gate.name}\` on ${input.sha} (${job.taskKey}, ruling 104)`,
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

const GATES_ACTOR = { kind: "system", systemId: GATES_SYSTEM_ID } as const;

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
    title = GATE_NOTE_TITLE.error;
    text =
      `**${line}.** Viberr could not run the project's gates on \`${run.headSha.slice(0, 7)}\`: ${run.error}. ` +
      `${taskKey} cannot be accepted on this revision until they run; a maintainer or the task owner can run them again from the GitHub card.`;
  } else if (failed.length > 0) {
    title = GATE_NOTE_TITLE.failed;
    text =
      `**${line}.** ${failed.map((r) => `\`${r.name}\` ${gateOutcomeText(r)}`).join(", ")}. ` +
      `${taskKey} cannot be accepted on this revision; the next delivered revision is gated again, and an admin can force-accept on the record. Each gate's log is attached.`;
  } else {
    title = GATE_NOTE_TITLE.passed;
    text = `**${line}.** Each gate's log is attached.`;
  }
  const evidence = normalizeEvidenceRows(
    // Ruling 313: the timeline reads these rows back (`gateNoteView`).
    // Ruling 16: each row says whether its gate passed.
    run.results.map((r) => ({
      label: gateEvidenceLabel(r),
      status: r.exitCode === 0 ? "pass" : "fail",
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

/** Runs one task's gates. Answers the pictures being made of the pages they
 *  built (ruling 86) in a holder, since awaiting a promise of a promise
 *  waits for both and the queue must not wait on a render. */
async function runGateJob(job: GateJob): Promise<{ pictured: Promise<void> | null }> {
  const none = { pictured: null };
  const ref = refOf(job);
  const file = readTaskFile(ref);
  const record = file?.parsed.frontmatter.gateRun;
  if (!file || !record || record.id !== job.runId) return none; // superseded
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
    return none;
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
      return none;
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
  // Ruling 86: the pages this revision builds are kept as the gates built
  // them, before the checkout goes, so that what Viberr pictures and measures
  // and what a reviewer is shown is the revision and not somebody's own build.
  // Only over gates that all passed: a build that failed is no page.
  let built: KeptBuild | null = null;
  const pagesDir = projectPagesDir(gates);
  const builds = checkout !== null && pagesDir !== null && failure === null && results.length === gates.length && results.every((r) => r.exitCode === 0);
  if (checkout && pagesDir && builds) {
    try {
      built = await keepBuild(job.projectSlug, job.taskKey, record.revisionId, checkout.dir, pagesDir, job.dataRoot);
    } catch (error) {
      logger.warn("a revision's built pages could not be kept", {
        projectSlug: job.projectSlug,
        taskKey: job.taskKey,
        revisionId: record.revisionId,
        err: toError(error),
      });
    }
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
      // Ruling 86: the folder a gate named for the pages of this run, whose
      // gates all passed, so a later ask knows the revision was built under
      // the folder now named; and what the keep of it held, when it held.
      if (builds && pagesDir) {
        run.pages = pagesDir;
        if (built) run.pagesKept = { files: built.files, leftOut: built.leftOut };
      }
      parsed.timeline.unshift(gateRunEvent(run, gates, job.taskKey));
      finished.run = { ...run, results: run.results.map((r) => ({ ...r })) };
    });
  } catch (error) {
    if (error instanceof GateRunSuperseded) return none;
    throw error;
  }
  const done = finished.run;
  if (!done) return none;
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
  let pictured: Promise<void> | null = null;
  if (builds && pagesDir && done.status === "finished") {
    // Pictured and measured once the renderer is free, like a files delivery
    // (ruling 86); a build that left no page there, or could not be kept, is
    // said on the task by the same job. Imported here: the page capture
    // reaches back into the task-action modules.
    const { requestRevisionCaptures } = await import("./page-capture.server");
    pictured = requestRevisionCaptures(
      job.db,
      job.dataRoot ? { dataRoot: job.dataRoot } : {},
      {
        projectSlug: job.projectSlug,
        taskKey: job.taskKey,
        revisionId: done.revisionId,
        gateRunId: done.id,
        folder: pagesDir,
        kept: built !== null,
        leftOut: built?.leftOut ?? 0,
      },
    );
    const making = pictured;
    handoffs.add(making);
    void making.finally(() => handoffs.delete(making));
  }
  if (done.status === "finished" && failedGates.length > 0) {
    // Ruling 130: a failing gate is the operator's to act on — it dispatches
    // the rework — so the result is handed to it rather than left on a card.
    const { autoInvokeOperator } = await import("./task-action-core.server");
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
  return { pictured };
}
