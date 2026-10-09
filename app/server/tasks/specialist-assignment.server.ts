/**
 * Engaging specialists on a task (ruling 13(a)): assigning the delivering
 * specialist or a reviewer, and removing a reviewer.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  type AgentRef,
  deliveringEngagement,
  deriveValidation,
  supportingEngagements,
} from "~/schemas/task-file.schema";
import { resolveAgentCollab } from "./agent-outcome.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { listRunsForTaskRows } from "~/server/runtimes/run-store.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import {
  reprojectTask,
  type TaskActor,
  type TaskMutationContext,
  taskRef,
} from "./task-mutation.server";
import {
  readRequiredReviewers,
  requiredReviewerDeliversRefusal,
} from "./required-reviewers.server";
import {
  agentEvent,
  assertStageEligible,
  projectBoard,
  requireRuntimeRole,
  resolveDeployedSpecialist,
  runtimeAuditActor,
} from "./specialist-roster.server";

export interface AssignSpecialistResult {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
}

/**
 * Assigns a deployed specialist as the task's PRIMARY specialist: writes the
 * `specialist` frontmatter ({profileId, backend, role}) and appends a typed
 * `agent` timeline event announcing the deployment, then reprojects + audits
 * (SSE rides the reproject). RBAC: admin|maintainer.
 */
export async function assignSpecialist(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; profileId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AssignSpecialistResult> {
  const auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "assign a specialist",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const specialist = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
  );
  assertStageEligible(
    specialist,
    existing.parsed.frontmatter.stage,
    projectBoard(ctx, input.projectSlug),
  );
  // Ruling 89: every door to `delivers: true` passes here, so a reviewer the
  // project requires is refused on all of them.
  {
    const reviews = readRequiredReviewers(input.projectSlug, ctx).filter(
      (rule) => rule.profileId === specialist.profileId,
    );
    if (reviews.length > 0) {
      throw AppError.validation(
        requiredReviewerDeliversRefusal(specialist.name, input.taskKey, reviews),
      );
    }
  }

  // P14-GV-10: swapping the DELIVERER out from under a live run. The outgoing
  // agent's run keeps going and still reconciles delivery under its own profile,
  // while the task file already names someone else — so "who owned this
  // revision" reads wrong afterwards. Refuse while its run is in flight and name
  // the run, so the human interrupts deliberately instead of discovering the
  // overlap later in the timeline.
  const outgoing = deliveringEngagement(existing.parsed.frontmatter);
  if (outgoing && outgoing.profileId !== specialist.profileId) {
    const liveRun = listRunsForTaskRows(db, input.projectSlug, input.taskKey).find(
      (r) =>
        r.kind === "primary" &&
        (r.state === "running" || r.state === "queued"),
    );
    if (liveRun) {
      throw AppError.conflict(
        `${input.taskKey}'s current deliverer has a run in flight (${liveRun.id}). ` +
          `Interrupt it first, then assign ${specialist.name}; replacing the ` +
          `deliverer mid-run leaves that run delivering under a profile the task ` +
          `no longer names.`,
      );
    }
  }

  const backendLabel = BACKEND_LABEL[specialist.backend];
  const ref: AgentRef = {
    profileId: specialist.profileId,
    backend: specialist.backend,
    role: specialist.role,
  };
  const handoff = outgoing && outgoing.profileId !== specialist.profileId
    ? outgoing
    : null;
  const event = agentEvent(
    handoff
      ? `Delivery handed off from **${handoff.profileId}** to **${specialist.name}** (${specialist.role}, ${backendLabel}).`
      // F19-12: timeline copy uses the shipped vocabulary — "delivering agent"
      // (D9/Q17-5 retired "primary specialist"; the model is `engagements[]`
      // with one `delivers: true`, which is exactly what this event records).
      : `Deployed **${specialist.name}** (${specialist.role}, ${backendLabel}) as the delivering agent.`,
  );

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      // The new deliverer replaces the old one; if it was previously a
      // SUPPORTING engagement, drop that entry too so its profileId never
      // appears twice (a duplicate profileId corrupts run routing — the
      // engagements.find in startAgentRun returns the first match, so a later
      // review run would resolve to the delivers:true entry and run as primary).
      // Promotion REPLACES the row, so anything durable already recorded on it
      // has to be carried across. `pinnedBackend` is the one that matters:
      // F27-B1 says a retry-on-the-other-backend pin STICKS, and rebuilding the
      // row from the bare `ref` silently reverted the next run to the very
      // backend the pin existed to escape.
      const existing = parsed.frontmatter.engagements.find(
        (e) => e.profileId === ref.profileId,
      );
      parsed.frontmatter.engagements = [
        {
          ...existing,
          ...ref,
          delivers: true,
          // F10-15: snapshot verdict authority. A deliverer is excluded from the
          // required-reviewer set regardless, but keep the snapshot honest.
          verdictCapable: resolveAgentCollab(specialist.capabilities).verdict,
        },
        ...supportingEngagements(parsed.frontmatter).filter(
          (e) => e.profileId !== ref.profileId,
        ),
      ];
      // Clear any pending run_agent recommendation for THIS profile — the
      // engagement it proposed is now a fact (the run itself follows).
      parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
        (r) => !(r.kind === "run_agent" && r.profileId === ref.profileId),
      );
      // `engagements` is an input to `requiredReviewers`, so a hand-off that
      // drops the approving reviewer changes what `validation` derives to. This
      // is the roster writer that was not re-deriving the cache, leaving the
      // canonical file asserting a review state that no longer follows from it
      // (the same UX19-3 line `assignReviewer` and `removeReviewer` carry).
      parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);
      parsed.timeline.unshift(event);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  // P14-GV-10: a handoff is its own fact — "assigned" reads as a first
  // assignment and loses the identity of the agent that was replaced.
  recordAudit(db, {
    action: handoff ? "task.delivery.handoff" : "task.specialist.assigned",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: handoff
      ? {
          profileId: specialist.profileId,
          backend: specialist.backend,
          role: specialist.role,
          fromProfileId: handoff.profileId,
        }
      : {
          profileId: specialist.profileId,
          backend: specialist.backend,
          role: specialist.role,
        },
  });

  return {
    profileId: specialist.profileId,
    name: specialist.name,
    role: specialist.role,
    backend: specialist.backend,
  };
}

export interface AssignReviewerResult {
  profileId: string;
  name: string;
  role: string;
  backend: RealBackend;
  /** True when the profile was already engaged as a reviewer (idempotent no-op). */
  alreadyEngaged: boolean;
  /**
   * Whether this engagement actually holds verdict authority — i.e. whether
   * acceptance waits on its approval (F10-15's engage-time snapshot).
   *
   * F21-6: the timeline event learned to say "a supporting agent" for a
   * verdict-less engagement, but every OTHER surface kept calling it a reviewer
   * because the result carried no way to tell them apart. Callers announce from
   * this, so the toast a human reads and the event the task records make the
   * same claim about authority. On the `alreadyEngaged` arm it is the EXISTING
   * engagement's snapshot — that snapshot, not today's grants, is what the
   * acceptance gate consults.
   */
  verdictCapable: boolean;
}

/**
 * Engages a deployed specialist as a REVIEWER (advisory, non-primary): appends
 * an AgentRef to the task's `reviewers` frontmatter array and announces it with
 * a typed `agent` timeline event, then reprojects + audits. Idempotent — a
 * profile already in `reviewers` is a no-op. RBAC: admin|maintainer.
 */
export async function assignReviewer(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; profileId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<AssignReviewerResult> {
  const auditActor = runtimeAuditActor(
    db,
    ctx,
    input.projectSlug,
    actor,
    "assign a reviewer",
  );

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  const reviewer = resolveDeployedSpecialist(
    ctx,
    input.projectSlug,
    input.profileId,
  );
  assertStageEligible(
    reviewer,
    existing.parsed.frontmatter.stage,
    projectBoard(ctx, input.projectSlug),
  );

  // Already engaged in ANY capacity (delivering OR supporting): no-op. Scanning
  // only the supporting list let the CURRENT deliverer be re-added as a
  // supporting reviewer, duplicating its profileId in engagements[].
  const engaged = existing.parsed.frontmatter.engagements.find(
    (r) => r.profileId === reviewer.profileId,
  );
  if (engaged) {
    return {
      profileId: reviewer.profileId,
      name: reviewer.name,
      role: reviewer.role,
      backend: reviewer.backend,
      alreadyEngaged: true,
      // The snapshot the acceptance gate reads, not a fresh resolution of the
      // profile's current grants — those two can differ, and only one of them
      // governs.
      verdictCapable: engaged.verdictCapable,
    };
  }

  const backendLabel = BACKEND_LABEL[reviewer.backend];
  const ref: AgentRef = {
    profileId: reviewer.profileId,
    backend: reviewer.backend,
    role: reviewer.role,
  };
  // F10-15: a supporting engagement with an explicit verdict grant is a REQUIRED
  // reviewer — acceptance waits for its approval of the current revision.
  // Snapshot it at engage time from the resolved grants.
  const verdictCapable = resolveAgentCollab(reviewer.capabilities).verdict;
  // F21-6: "as a reviewer" is a claim about AUTHORITY, and it was announced for
  // every supporting engagement regardless of grants. Live (VIB-1) a profile
  // with verdict=Off was announced "as a reviewer" while the execution profile
  // listed it under SUPPORTING AGENTS and acceptance never waited on it — the
  // timeline said the task had a reviewer it did not have.
  const event = agentEvent(
    `Engaged **${reviewer.name}** (${reviewer.role}, ${backendLabel}) as ` +
      (verdictCapable ? "a reviewer." : "a supporting agent."),
  );

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.engagements.push({
        ...ref,
        delivers: false,
        verdictCapable,
      });
      // Clear a matching pending run_agent recommendation — now engaged.
      parsed.frontmatter.recommendations = parsed.frontmatter.recommendations.filter(
        (r) => !(r.kind === "run_agent" && r.profileId === reviewer.profileId),
      );
      // UX19-3 (mechanism 2): `validation` is a DERIVED cache whose contract is
      // "ONE writer — deriveValidation" (F10-15), and the required-reviewer set
      // is one of its inputs (`requiredReviewers`). Engaging a verdict-capable
      // reviewer changes that set, so a cache written before this engagement is
      // stale the instant the roster moves: an already-approved task would keep
      // showing "validation healthy" on the queue card and the task hero while
      // every acceptance gate — which derives fresh — now refuses on the new
      // reviewer's missing verdict. Recompute it here, from the post-mutation
      // frontmatter, so the file (canonical truth) never carries the lie.
      parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);
      parsed.timeline.unshift(event);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    // U36-11 (pass 36): the vocabulary predates supporting engagements — a
    // Frontend Developer engaged "as a supporting agent" was audited as a
    // reviewer. The posture is the fact.
    action: "task.engagement.added",
    actor: auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      posture: verdictCapable ? "reviewer" : "supporting",
      profileId: reviewer.profileId,
      backend: reviewer.backend,
      role: reviewer.role,
    },
  });

  return {
    profileId: reviewer.profileId,
    name: reviewer.name,
    role: reviewer.role,
    backend: reviewer.backend,
    alreadyEngaged: false,
    verdictCapable,
  };
}

export interface RemoveReviewerResult {
  profileId: string;
  /** False when the profile wasn't engaged as a reviewer (nothing to remove). */
  removed: boolean;
}

/**
 * Releases a REVIEWER from a task: drops the matching AgentRef from `reviewers`
 * and appends a typed `agent` timeline event, then reprojects + audits. A
 * profile that isn't currently a reviewer is a no-op. RBAC: admin|maintainer.
 *
 * F33-10: refuses outright on a CLOSED task (terminal stage or archived) — see
 * the gate below.
 */
export async function removeReviewer(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; profileId: string },
  actor: TaskActor,
  ctx: TaskMutationContext = {},
): Promise<RemoveReviewerResult> {
  requireRuntimeRole(db, ctx, input.projectSlug, actor, "remove a reviewer");

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);

  // F33-10 / ruling 50 (owner, 2026-09-02): a task at the terminal stage is
  // CLOSED — every runtime control on its page says so (G9) — and the roster's
  // authority (delivery, review, acceptance) has nothing left to act on. Ruling
  // 50 froze the OWNER seat there for exactly that reason; the ENGAGEMENT seat
  // earns the freeze harder, because releasing it REWRITES the record rather
  // than merely re-labelling it: `validation` is derived from the required-
  // reviewer set, so dropping the approving reviewer of a merged, accepted task
  // re-derives `healthy` → `changed` (the UX19-3 recompute below, correct for an
  // OPEN task) and the hero, the board card and the review queue all render a
  // closed task as never-validated while its own timeline and audit still say it
  // was accepted on a healthy verdict. The approving verdict survives in
  // `verdicts[]` — it is DISCONNECTED, which is worse than deleted.
  //
  // So this freeze has NO admin escape, where ruling 50's owner seat has one:
  // the owner seat carries no derived consequence, so an admin reassignment
  // there is a bookkeeping entry, while here the same click silently restates
  // history. Archived seats are frozen the same way (D32-16), and a task moved
  // back to an open stage releases agents again. Both panels withhold the ✕
  // below; this fails CLOSED if one of them does not — including on the no-op
  // path, so a closed task never answers "released nothing" to a click that
  // should not have been offered.
  if (existing.parsed.frontmatter.archived) {
    throw AppError.validation(
      `${input.taskKey} is archived. Restore it before releasing an agent from it.`,
    );
  }
  const board = projectBoard(ctx, input.projectSlug);
  if (
    board !== null &&
    isTerminalStage(existing.parsed.frontmatter.stage, board.stages)
  ) {
    throw AppError.validation(
      `${input.taskKey} is closed. Move it back to an open stage before releasing an agent from it.`,
    );
  }

  const target = supportingEngagements(existing.parsed.frontmatter).find(
    (r) => r.profileId === input.profileId,
  );
  if (!target) return { profileId: input.profileId, removed: false };

  // Best-effort display name for the event; falls back to the role snapshot.
  let label = target.role;
  try {
    label = resolveDeployedSpecialist(ctx, input.projectSlug, input.profileId).name;
  } catch {
    // Profile may have been undeployed since engagement — keep the role label.
  }
  const event = agentEvent(`Released reviewer **${label}** from the task.`);

  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.frontmatter.engagements = parsed.frontmatter.engagements.filter(
        (r) => r.delivers || r.profileId !== input.profileId,
      );
      // UX19-3 (mechanism 2): the removal side of the same stale cache. Dropping
      // the SOLE approving reviewer leaves `deriveValidation` at "changed" while
      // the cached `validation:` line still reads "healthy" — the review queue
      // and task hero both render that cache, so they advertise a green task the
      // acceptance gate refuses. One writer, on every roster change.
      parsed.frontmatter.validation = deriveValidation(parsed.frontmatter);
      parsed.timeline.unshift(event);
    },
  );
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);

  recordAudit(db, {
    action: "task.reviewer.removed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { profileId: input.profileId },
  });

  return { profileId: input.profileId, removed: true };
}
