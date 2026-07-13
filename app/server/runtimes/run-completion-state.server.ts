import type Database from "better-sqlite3";
import type { RealBackend } from "./runtime-registry.server";
import type { DeliveryPermissions } from "~/server/tasks/specialist-tool-policy";
import type { OperatorAutonomy } from "~/server/tasks/operator-actions.server";
import type { TaskLaunchAuthorization } from "~/server/tasks/specialist-run.server";

/** Monotonic specialist-completion checkpoints persisted on agent_runs. */
export const RUN_COMPLETION_PHASE = {
  pending: 0,
  reply: 1,
  delivery: 2,
  evidence: 3,
  verdict: 4,
  reaction: 5,
  complete: 6,
} as const;

export type RunCompletionPhase =
  (typeof RUN_COMPLETION_PHASE)[keyof typeof RUN_COMPLETION_PHASE];

/** Exact context the live callback had and boot recovery must restore. */
export interface RunCompletionContext {
  workdir: string | null;
  delivery: DeliveryPermissions | null;
  agentHandle: string;
  operatorRun: {
    backend: RealBackend;
    autonomy: OperatorAutonomy;
    reactDepth: number;
  } | null;
  /** Immutable task/deployment/repository authority captured before checkout. */
  launchAuthorization: TaskLaunchAuthorization | null;
}

function isDeliveryPermissions(value: unknown): value is DeliveryPermissions {
  if (!value || typeof value !== "object") return false;
  const delivery = value as Record<string, unknown>;
  return (
    typeof delivery.canBranch === "boolean" &&
    typeof delivery.canCommitPush === "boolean" &&
    typeof delivery.canOpenPr === "boolean"
  );
}

function isTaskLaunchAuthorization(
  value: unknown,
): value is TaskLaunchAuthorization {
  if (!value || typeof value !== "object") return false;
  const launch = value as Record<string, unknown>;
  return (
    typeof launch.createdAt === "string" &&
    (launch.kind === "primary" || launch.kind === "reviewer") &&
    typeof launch.profileId === "string" &&
    typeof launch.taskSnapshot === "string" &&
    typeof launch.deploymentSnapshot === "string" &&
    (launch.reviewEvidenceSnapshot === null ||
      typeof launch.reviewEvidenceSnapshot === "string")
  );
}

function parseContext(raw: string | null): RunCompletionContext | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const operator = value.operatorRun;
    const operatorRun =
      operator &&
      typeof operator === "object" &&
      ((operator as Record<string, unknown>).backend === "claude" ||
        (operator as Record<string, unknown>).backend === "codex") &&
      ((operator as Record<string, unknown>).autonomy === "supervised" ||
        (operator as Record<string, unknown>).autonomy === "full") &&
      Number.isInteger((operator as Record<string, unknown>).reactDepth)
        ? {
            backend: (operator as { backend: RealBackend }).backend,
            autonomy: (operator as { autonomy: OperatorAutonomy }).autonomy,
            reactDepth: (operator as { reactDepth: number }).reactDepth,
          }
        : null;
    return {
      workdir: typeof value.workdir === "string" ? value.workdir : null,
      delivery: isDeliveryPermissions(value.delivery) ? value.delivery : null,
      agentHandle:
        typeof value.agentHandle === "string" && value.agentHandle.trim()
          ? value.agentHandle.trim()
          : "agent",
      operatorRun,
      launchAuthorization: isTaskLaunchAuthorization(value.launchAuthorization)
        ? value.launchAuthorization
        : null,
    };
  } catch {
    return null;
  }
}

/** First registration wins so later callback wiring cannot mutate authority. */
export function persistRunCompletionContext(
  db: Database.Database,
  runId: string,
  context: RunCompletionContext,
): void {
  db.prepare(
    `UPDATE agent_runs
        SET completion_context_json = COALESCE(completion_context_json, ?),
            updated_at = ?
      WHERE id = ?`,
  ).run(JSON.stringify(context), new Date().toISOString(), runId);
}

export function readRunCompletionContext(
  db: Database.Database,
  runId: string,
): RunCompletionContext | null {
  const row = db
    .prepare(`SELECT completion_context_json FROM agent_runs WHERE id = ?`)
    .get(runId) as { completion_context_json: string | null } | undefined;
  return parseContext(row?.completion_context_json ?? null);
}

export function readRunCompletionPhase(
  db: Database.Database,
  runId: string,
): RunCompletionPhase {
  const row = db
    .prepare(`SELECT completion_phase FROM agent_runs WHERE id = ?`)
    .get(runId) as { completion_phase: number } | undefined;
  const phase = row?.completion_phase ?? RUN_COMPLETION_PHASE.pending;
  return Math.max(
    RUN_COMPLETION_PHASE.pending,
    Math.min(RUN_COMPLETION_PHASE.complete, phase),
  ) as RunCompletionPhase;
}

/** Missing tokens fail closed: only a launch which observed this exact
 * canonical task lifecycle may apply delayed effects to it. */
export function runMatchesTaskIncarnation(
  db: Database.Database,
  runId: string,
  currentTaskCreatedAt: string | null,
): boolean {
  const row = db
    .prepare(`SELECT task_incarnation FROM agent_runs WHERE id = ?`)
    .get(runId) as { task_incarnation: string | null } | undefined;
  return (
    !!row?.task_incarnation &&
    !!currentTaskCreatedAt &&
    row.task_incarnation === currentTaskCreatedAt
  );
}

/** Advance only; concurrent/replayed workers can never move a run backward. */
export function advanceRunCompletionPhase(
  db: Database.Database,
  runId: string,
  phase: RunCompletionPhase,
): void {
  db.prepare(
    `UPDATE agent_runs
        SET completion_phase = CASE
              WHEN completion_phase < ? THEN ? ELSE completion_phase END,
            updated_at = ?
      WHERE id = ?`,
  ).run(phase, phase, new Date().toISOString(), runId);
}

export function hasSourceLinkedOperatorRun(
  db: Database.Database,
  sourceRunId: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM agent_runs
        WHERE kind = 'operator' AND completion_source_run_id = ? LIMIT 1`,
    )
    .get(sourceRunId);
}

/** A source reservation alone is not a completed reaction. A genuinely
 * running operator proves provider launch; terminal rows require an explicit
 * durable effect/recovery boundary so an ambiguous plan is never acknowledged
 * as applied merely because its process exited. */
export function sourceLinkedOperatorReactionReady(
  db: Database.Database,
  sourceRunId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT state, started_at, operator_effect_state
         FROM agent_runs
        WHERE kind = 'operator' AND completion_source_run_id = ?
        LIMIT 1`,
    )
    .get(sourceRunId) as
    | {
        state: string;
        started_at: string | null;
        operator_effect_state: "pending" | "applied" | "recovery" | null;
      }
    | undefined;
  if (!row) return false;
  if (row.state === "running") return row.started_at !== null;
  if (row.state === "queued") return false;
  return (
    row.operator_effect_state === "applied" ||
    row.operator_effect_state === "recovery"
  );
}

const COMPLETION_LOCKS = Symbol.for("viberr.runCompletionLocks");
const PROJECT_COMPLETION_EFFECTS = Symbol.for(
  "viberr.projectCompletionEffects",
);
const REVOKED_PROJECT_COMPLETIONS = Symbol.for(
  "viberr.revokedProjectCompletions",
);
const PROJECT_COMPLETION_REVOCATIONS = Symbol.for(
  "viberr.projectCompletionRevocations",
);
const PROJECT_COMPLETION_ABORTS = Symbol.for(
  "viberr.projectCompletionAborts",
);

function lockMap(): WeakMap<Database.Database, Map<string, Promise<void>>> {
  const cache = globalThis as unknown as Record<
    symbol,
    WeakMap<Database.Database, Map<string, Promise<void>>> | undefined
  >;
  return (cache[COMPLETION_LOCKS] ??= new WeakMap());
}

function projectEffectMap(): WeakMap<
  Database.Database,
  Map<string, Set<Promise<unknown>>>
> {
  const cache = globalThis as unknown as Record<
    symbol,
    | WeakMap<Database.Database, Map<string, Set<Promise<unknown>>>>
    | undefined
  >;
  return (cache[PROJECT_COMPLETION_EFFECTS] ??= new WeakMap());
}

function revokedProjectMap(): WeakMap<Database.Database, Set<string>> {
  const cache = globalThis as unknown as Record<
    symbol,
    WeakMap<Database.Database, Set<string>> | undefined
  >;
  return (cache[REVOKED_PROJECT_COMPLETIONS] ??= new WeakMap());
}

function revokedProjects(db: Database.Database): Set<string> {
  const projects = revokedProjectMap().get(db) ?? new Set<string>();
  revokedProjectMap().set(db, projects);
  return projects;
}

function projectRevocationMap(): WeakMap<
  Database.Database,
  Map<string, number>
> {
  const cache = globalThis as unknown as Record<
    symbol,
    WeakMap<Database.Database, Map<string, number>> | undefined
  >;
  return (cache[PROJECT_COMPLETION_REVOCATIONS] ??= new WeakMap());
}

function nextProjectRevocation(
  db: Database.Database,
  projectSlug: string,
): number {
  const byProject = projectRevocationMap().get(db) ?? new Map<string, number>();
  projectRevocationMap().set(db, byProject);
  const generation = (byProject.get(projectSlug) ?? 0) + 1;
  byProject.set(projectSlug, generation);
  return generation;
}

function projectAbortMap(): WeakMap<
  Database.Database,
  Map<string, AbortController>
> {
  const cache = globalThis as unknown as Record<
    symbol,
    WeakMap<Database.Database, Map<string, AbortController>> | undefined
  >;
  return (cache[PROJECT_COMPLETION_ABORTS] ??= new WeakMap());
}

function projectAbortController(
  db: Database.Database,
  projectSlug: string,
): AbortController {
  const byProject = projectAbortMap().get(db) ?? new Map();
  projectAbortMap().set(db, byProject);
  let controller = byProject.get(projectSlug);
  if (!controller) {
    controller = new AbortController();
    byProject.set(projectSlug, controller);
  }
  return controller;
}

/** Close admission synchronously before runtime handles are aborted. */
export function revokeProjectCompletionEffects(
  db: Database.Database,
  projectSlug: string,
): number {
  const generation = nextProjectRevocation(db, projectSlug);
  revokedProjects(db).add(projectSlug);
  projectAbortController(db, projectSlug).abort(
    new DOMException(
      `Project ${projectSlug} lifecycle ownership was revoked.`,
      "AbortError",
    ),
  );
  return generation;
}

/** Reopen only after a restored/new canonical project owns the slug. */
export function allowProjectCompletionEffects(
  db: Database.Database,
  projectSlug: string,
  expectedRevocation?: number,
): boolean {
  if (
    expectedRevocation !== undefined &&
    projectRevocationMap().get(db)?.get(projectSlug) !== expectedRevocation
  ) {
    return false;
  }
  revokedProjects(db).delete(projectSlug);
  const byProject = projectAbortMap().get(db);
  byProject?.delete(projectSlug);
  projectAbortController(db, projectSlug);
  return true;
}

export function projectCompletionAdmissionOpen(
  db: Database.Database,
  projectSlug: string,
): boolean {
  return !revokedProjects(db).has(projectSlug);
}

/** Signal shared by all currently admitted effects for this project
 * incarnation. Archive/delete abort it synchronously before draining effects;
 * restore/recreation receives a fresh signal. */
export function projectCompletionSignal(
  db: Database.Database,
  projectSlug: string,
): AbortSignal {
  const controller = projectAbortController(db, projectSlug);
  if (!projectCompletionAdmissionOpen(db, projectSlug) && !controller.signal.aborted) {
    controller.abort(
      new DOMException(
        `Project ${projectSlug} lifecycle ownership was revoked.`,
        "AbortError",
      ),
    );
  }
  return controller.signal;
}

/**
 * Register one whole governed completion pipeline as owned by a project.
 * Archive/delete revoke the run-service callback first, then await this set
 * before changing canonical files. That closes the remaining race where an
 * abort arrives after an effect already entered one atomic file mutation.
 */
export function withProjectCompletionEffect<T>(
  db: Database.Database,
  projectSlug: string,
  effect: () => Promise<T>,
): Promise<T> {
  if (!projectCompletionAdmissionOpen(db, projectSlug)) {
    return Promise.reject(
      new Error(`Completion ownership for project ${projectSlug} was revoked.`),
    );
  }
  const byProject = projectEffectMap().get(db) ?? new Map();
  projectEffectMap().set(db, byProject);
  const active = byProject.get(projectSlug) ?? new Set<Promise<unknown>>();
  byProject.set(projectSlug, active);

  // Defer invocation by one microtask so the promise is registered before any
  // async effect can reach its first mutation or throw synchronously.
  const running = Promise.resolve().then(effect);
  active.add(running);
  const release = () => {
    active.delete(running);
    if (active.size === 0) byProject.delete(projectSlug);
  };
  void running.then(release, release);
  return running;
}

/** Wait until every completion which already owns this project has settled. */
export async function waitForProjectCompletionEffects(
  db: Database.Database,
  projectSlug: string,
): Promise<void> {
  const byProject = projectEffectMap().get(db);
  // A completion can release a per-run lock and expose a queued same-run
  // follower while we are draining. Loop until the ownership set is empty.
  while (true) {
    const active = byProject?.get(projectSlug);
    if (!active || active.size === 0) return;
    await Promise.allSettled([...active]);
  }
}

/**
 * Permanently abandon replayable specialist effects when project ownership is
 * archived. Call only after runtime callbacks were revoked and the active
 * effect registry drained. This is what prevents a later restore (or a
 * same-slug recreation after operational-row lag) from inheriting old work.
 */
export function completeProjectRunEffects(
  db: Database.Database,
  projectSlug: string,
): number {
  if (!db.open) return 0;
  const now = new Date().toISOString();
  const specialistChanges = db
    .prepare(
      `UPDATE agent_runs
          SET completion_phase = ?, updated_at = ?
        WHERE project_slug = ?
          AND kind IN ('primary', 'reviewer')
          AND completion_phase < ?`,
    )
    .run(
      RUN_COMPLETION_PHASE.complete,
      now,
      projectSlug,
      RUN_COMPLETION_PHASE.complete,
    ).changes;
  // An operator callback canceled by archive is deliberately inert, not an
  // ambiguous crash. Mark its pending effects as a recovery boundary so a
  // same-process restore or later boot cannot raise a false packet.
  const operatorChanges = db
    .prepare(
      `UPDATE agent_runs
          SET operator_effect_state = 'recovery', updated_at = ?
        WHERE project_slug = ? AND kind = 'operator'
          AND operator_effect_state = 'pending'`,
    )
    .run(now, projectSlug).changes;
  return specialistChanges + operatorChanges;
}

/** Serialize a live callback and boot replay for one run within this process. */
export async function withRunCompletionLock<T>(
  db: Database.Database,
  runId: string,
  effect: () => Promise<T>,
): Promise<T> {
  const byRun = lockMap().get(db) ?? new Map<string, Promise<void>>();
  lockMap().set(db, byRun);
  const previous = byRun.get(runId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  byRun.set(runId, current);
  await previous.catch(() => {});
  try {
    return await effect();
  } finally {
    release();
    if (byRun.get(runId) === current) byRun.delete(runId);
  }
}
