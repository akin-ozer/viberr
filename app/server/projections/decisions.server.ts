import type { DatabaseSync } from "node:sqlite";

import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { listProjects } from "~/server/projections/board-query.server";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import { isRepositoryAskCause } from "~/shared/repository-ask";
import { isTerminalStage, resolveStageRoles } from "~/shared/workflow/stage-roles";

/**
 * THE single source of "which open decisions require a given user's action".
 *
 * Every surface that counts or lists decisions ("waiting on you" on Home, the
 * project cards, the notifications overlay, the board chip, the review queue)
 * consults THIS helper instead of its own predicate — so the numbers can never
 * disagree (pass-8 R8-3, replacing three independent non-member-scoped counts).
 *
 * An OPEN decision is one task, in a NON-terminal stage, that carries an open
 * packet, ≥1 pending operator recommendation, OR is sitting at the review stage
 * ready for this user's ACCEPTANCE. A task needs exactly one human action, so it
 * contributes exactly one decision (dedupe by task).
 *
 * B-FD5: acceptance used to be missing here. A review-stage task waiting on a
 * human can carry no packet and no recommendation (the operator could not open
 * a completion packet), so `decisionsRequiring` — the "single source" — did not
 * see it, while the review queue listed it under "Waiting on your acceptance".
 * The board patched over that by unioning the two predicates in its own loader
 * (UI-48); Home's per-project count and the notifications inbox did not, so the
 * one task most in need of a person was invisible everywhere but the board and
 * the queue. The union belongs HERE, in the shared helper, so every surface
 * inherits it. The acceptance predicate mirrors the review queue's `isReady`:
 * the resolved review stage, `waiting = human`, no projected acceptance block
 * (`validation_block_reason` — a closed PR, a failing verdict, an awaiting
 * reviewer, no delivered revision, R15-1's verdict gate on delivered work, an
 * open blocked packet, or a conflicting PR), and a review PR that was not closed
 * unmerged (a rejected PR needs a rework/reopen/archive call, not acceptance).
 * The gate reaches both queues through the PROJECTION (rebuilder.server.ts
 * `acceptanceBlockReason`) rather than being re-derived here, so this predicate
 * and the server's refusal cannot drift apart.
 *
 * Member-scoping (the fix): a decision is `mine` iff the user can actually act
 * on it — maintainer+ on that project (resolve-packet / accept-completion /
 * approve-transition all share the maintainer+ tier) OR the task's OWNER, who
 * governs every decision on their own task (R14-2, 2026-07-25). The pass-12
 * owner exception was narrower than this list — packets and `accept_completion`
 * only — but nothing server-side honored even that for recommendations, so a
 * contributor owner was counted "waiting on you" and then 403'd by both apply
 * and dismiss (P14-GV-01/GV-07). `applyRecommendation`/`dismissRecommendation`/
 * `resolvePacket` now all carry the owner exception, and dismissal is always
 * available to the owner, so every decision counted here is really actionable.
 * A decision the user could act on ONLY through the D2 org-admin
 * emergency override (org admin whose own project role — none, viewer, or a
 * below-tier membership — is insufficient) is `overrideEligible`, never `mine`:
 * governance reach, not a personal inbox. Viewers and contributor-non-owners
 * with no override see nothing.
 *
 * This is a READ (no audit): it classifies by project role + task ownership
 * directly, never calling the audited `resolveProjectAuthority` mutation path.
 */
export interface DecisionRef {
  projectSlug: string;
  taskKey: string;
  kind: "packet" | "recommendation" | "acceptance";
  stage: string;
}

export interface DecisionsForUser {
  /** Open decisions this user is authorized to act on (their real inbox). */
  mine: DecisionRef[];
  /** Open decisions the user could act on ONLY via the org-admin override. */
  overrideEligible: DecisionRef[];
  /** Ruling 65: open repository questions on boards this user is a member
   *  of and cannot answer. Both answers decide the board, so they wait on a
   *  project admin. Never this user's inbox; listed so that whoever asks what
   *  is waiting is not told "nothing" about a packet they can see. */
  needsProjectAdmin: DecisionRef[];
}

/** The columns the open-decision query below selects. A type alias, not an
 *  interface, so the row assertion is checked against SQLite's output types
 *  instead of having to launder the rows through `unknown` first. */
type OpenDecisionRow = {
  project_slug: string;
  task_key: string;
  stage: string;
  owner_user_id: string | null;
  has_packet: number;
  /** The open packet's `cause` (ruling 65), or null. */
  packet_cause: string | null;
  recommendation_count: number;
};

/**
 * The keys of a project's tasks whose next move is THIS viewer's: an open
 * decision they own (R8-3), or an acceptance they can give (the review queue's
 * viewer-scoped `ready`, UI-48). One answer for every surface that says
 * "waiting on you": the board's chip and cards, and the review queue's row
 * tag (interface review 2026-09-24, writ-3), so the two cannot disagree.
 */
export function waitingOnViewer(
  db: DatabaseSync,
  userId: string,
  projectSlug: string,
  readyKeys: Iterable<string>,
): Set<string> {
  return new Set([
    ...decisionsRequiring(db, userId, { projectSlug }).mine.map((d) => d.taskKey),
    ...readyKeys,
  ]);
}

export function decisionsRequiring(
  db: DatabaseSync,
  userId: string,
  opts: { projectSlug?: string } = {},
): DecisionsForUser {
  const orgAdmin = isOrgAdmin(db, userId);

  // This user's project role per project (null = not a member).
  // SAFETY: `project_members.role` is CHECK-constrained to exactly
  // PROJECT_ROLES ('admin' | 'maintainer' | 'contributor' | 'viewer') by
  // 0001_baseline.sql, and `project_slug` is TEXT NOT NULL.
  const roleBySlug = new Map<string, ProjectRole>(
    (
      db
        .prepare(`SELECT project_slug, role FROM project_members WHERE user_id = ?`)
        .all(userId) as { project_slug: string; role: ProjectRole }[]
    ).map((r) => [r.project_slug, r.role]),
  );

  // The project stage lists (to exclude terminal-stage tasks — a Done task's
  // leftover packet/recommendation is a resolved decision, not a pending one)
  // and each project's RESOLVED review stage (the acceptance boundary — never
  // the literal id "review", which a customized board need not use).
  // An ARCHIVED PROJECT is read-only (R6-3): `requireProjectMutable` refuses
  // every governed mutation inside it and `acceptanceStanding` denies
  // outright, so nothing in one is a decision anybody can act on. Dropping the
  // project here covers all three kinds at once — the task-level `archived = 0`
  // filters below only ever caught individually-archived tasks.
  const projects = listProjects(db).filter((p) => !p.archived);
  const stagesBySlug = new Map(projects.map((p) => [p.slug, p.stages]));
  const reviewIdBySlug = new Map(
    projects.map((p) => [p.slug, resolveStageRoles(p.stages, p.workflow).reviewId]),
  );

  // SAFETY: the four selected `task_projections` columns are TEXT NOT NULL
  // except the nullable `owner_user_id`; `has_packet` is a SQL boolean (0/1)
  // and `recommendation_count` is INTEGER NOT NULL (0001_baseline.sql).
  const rows = db
    .prepare(
      `SELECT project_slug, task_key, stage, owner_user_id,
              (CASE WHEN packet_json IS NOT NULL AND packet_json <> '' THEN 1 ELSE 0 END) AS has_packet,
              (CASE WHEN packet_json IS NOT NULL AND packet_json <> ''
                    THEN json_extract(packet_json, '$.cause') END) AS packet_cause,
              recommendation_count
         FROM task_projections
        WHERE ((packet_json IS NOT NULL AND packet_json <> '')
               -- F37-71: see the comment above the acceptance query below. UX19-3
               -- put both missing refusals into validation_block_reason and wired
               -- it into the ACCEPTANCE query only; an accept_completion
               -- recommendation IS an acceptance, so the same conflicting-PR task
               -- that query correctly drops walked straight back in here the
               -- moment the operator filed a card for it.
               --
               -- Gated on the kinds being EXACTLY acceptance, never on the block
               -- alone: a transition card is actionable whatever GitHub thinks of
               -- the merge, and hiding it would lose a real decision. The kinds
               -- column is sorted and deduped so this is an equality test.
               OR (recommendation_count > 0
                   AND NOT (recommendation_kinds = 'accept_completion'
                            AND validation_block_reason IS NOT NULL
                            AND validation_block_reason <> '')))
          -- R14-3: archiving already withdraws the packet and the pending
          -- recommendations, so an archived task drops out of the inbox by
          -- itself. This covers the other way in: a task archived by editing
          -- the file directly, which the projection picks up untouched.
          AND archived = 0
          ${opts.projectSlug ? "AND project_slug = ?" : ""}`,
    )
    .all(...(opts.projectSlug ? [opts.projectSlug] : [])) as OpenDecisionRow[];

  // B-FD5: acceptance-ready review-stage tasks — the class that carries no
  // decision OBJECT. Predicate parity with the review queue's `isReady`
  // (review-queue.server.ts): resolved review stage, waiting on a human, no
  // projected acceptance block, and no PR closed unmerged.
  //
  // UX19-3: that parity claim went STALE. `validation_block_reason` used to carry
  // only the reviewer/verdict half of the gate, so the queue compensated with a
  // LOCAL re-derivation of the two missing refusals (`gateBlockedByKey` — an open
  // blocked packet, a conflicting PR) and this query compensated with nothing. A
  // review-stage, human-waiting, packet-less task whose PR was
  // `mergeable: "conflicting"` therefore emitted `kind: "acceptance"` into
  // "decisions requiring you" — an acceptance `acceptanceRefusalReason` refuses —
  // while the queue correctly filed the same task under "Still in review". Both
  // refusals now live in the projected column itself, so the ONE predicate below
  // is again the whole gate and the two readers cannot drift.
  // SAFETY: same table as above — `project_slug`, `task_key` and `stage` are
  // TEXT NOT NULL, `owner_user_id` is the one nullable column selected.
  const acceptanceRows = db
    .prepare(
      `SELECT project_slug, task_key, stage, owner_user_id
         FROM task_projections
        WHERE archived = 0
          AND waiting = 'human'
          AND (validation_block_reason IS NULL OR validation_block_reason = '')
          AND (pr_json IS NULL OR json_extract(pr_json, '$.state') <> 'closed')
          ${opts.projectSlug ? "AND project_slug = ?" : ""}`,
    )
    .all(...(opts.projectSlug ? [opts.projectSlug] : [])) as {
    project_slug: string;
    task_key: string;
    stage: string;
    owner_user_id: string | null;
  }[];

  const mine: DecisionRef[] = [];
  const overrideEligible: DecisionRef[] = [];
  const needsProjectAdmin: DecisionRef[] = [];
  // A task needs exactly one human action, so it contributes exactly one
  // decision even when it carries a packet AND is acceptance-ready.
  const seen = new Set<string>();

  const classify = (
    ref: DecisionRef,
    ownerUserId: string | null,
    /** Ruling 65: the packet is the repository question, whose two answers
     *  both decide the board. It is a project admin's and nobody else's, so
     *  it is not "waiting on" a maintainer or the task's owner. */
    boardDecision = false,
  ): void => {
    const taskId = `${ref.projectSlug}::${ref.taskKey}`;
    if (seen.has(taskId)) return;
    seen.add(taskId);

    const role = roleBySlug.get(ref.projectSlug) ?? null;
    // Maintainer+ holds every governing action (resolve-packet / accept-
    // completion / approve-transition / dismiss-recommendation all share the
    // maintainer+ tier), so a maintainer+ can act on ANY open decision.
    const canGovern = roleCan(role, boardDecision ? "edit-policy" : "resolve-packet");
    // The task OWNER (contributor+) governs EVERY open decision on their own
    // task (R14-2): resolve the packet, accept the completion, apply what they
    // hold the inner authority for, and always dismiss. The old narrow rule
    // counted only packets and `accept_completion` recommendations — and the
    // server honored neither, which is exactly the dead-end this widening ends.
    const ownerCanAct = !boardDecision && ownerUserId === userId && roleCan(role, "own-task");

    if (canGovern || ownerCanAct) {
      mine.push(ref);
    } else if (orgAdmin) {
      // Org admin who can't act under their own project role (non-member, viewer,
      // or a below-tier member) — actionable only through the audited D2 override
      // (resolveProjectAuthority grants it whenever the member role is below the
      // required tier, not only to non-members).
      overrideEligible.push(ref);
    } else if (boardDecision && role !== null) {
      needsProjectAdmin.push(ref);
    }
    // viewer / contributor-non-owner (or owner of a maintainer-only rec) with no
    // org-admin override → nothing.
  };

  for (const row of rows) {
    const stages = stagesBySlug.get(row.project_slug);
    if (!stages || isTerminalStage(row.stage, stages)) continue;
    classify(
      {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        // A task carries at most one open packet; recommendations are otherwise
        // pending. Prefer the packet as the operative decision when both exist.
        kind: row.has_packet ? "packet" : "recommendation",
        stage: row.stage,
      },
      row.owner_user_id,
      isRepositoryAskCause(row.packet_cause),
    );
  }

  for (const row of acceptanceRows) {
    if (row.stage !== reviewIdBySlug.get(row.project_slug)) continue;
    classify(
      {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        kind: "acceptance",
        stage: row.stage,
      },
      row.owner_user_id,
    );
  }

  return { mine, overrideEligible, needsProjectAdmin };
}
