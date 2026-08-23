import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  appendComment,
  completeTaskMerge,
  createTask,
  releaseOwner,
  setOwner,
  setTaskMetadata,
  transitionStage,
  updateTaskGoal,
  reorderTask,
  dismissRecommendation,
  applyRecommendation,
  forceAcceptCompletion,
  resolvePacket,
  requestPacketMaintainerDecision,
  manualDeliverForReview,
} from "~/server/tasks/task-actions.server";
import {
  assignSpecialist,
} from "~/server/tasks/specialist-run.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { updateProjectIdentity, inviteMember } from "~/features/project-settings/settings-actions.server";
import { createAgentProfile } from "~/features/agents/agent-profile-actions.server";
import {
  setMemberRole,
  setTransitionBoundary,
} from "~/features/policy/policy-actions.server";
import { insertUser } from "~/server/auth/user-store.server";
import { isAppError, type AppError } from "~/server/errors/app-error.server";
import { ROLE_RANK, RBAC_DEFINITIONS, PROJECT_ROLES,
  roleCan, rolesForAction, type ProjectRole, type RbacAction } from "~/shared/rbac";
import { ALWAYS_HUMAN_CAPABILITY_IDS } from "~/shared/capabilities";
import { resolveSpecialistDisallowedTools } from "~/server/tasks/specialist-tool-policy";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import type { TaskFrontmatter, TaskPacket } from "~/schemas/task-file.schema";
import { listAuditEvents } from "../../../test-support/audit-log";

/**
 * THE binding test the matrix-as-source design promises (app/shared/rbac.ts):
 * it drives each REAL server guard as every project role AND a non-member, and
 * asserts the allow/deny outcome matches `ACTION_ROLES`. Without this, only the
 * *display* table is tested — a call site passing the wrong RbacAction, or an
 * edit to ACTION_ROLES, could silently diverge from enforcement. This closes
 * that gap: enforcement can no longer drift from the single source.
 *
 * A guard that lets the actor THROUGH is detected by the action either
 * succeeding OR failing with a NON-403 error (a downstream validation past the
 * gate). A 403 (forbidden) means the guard denied. That lets us test the guard
 * without every action having to fully succeed.
 *
 * P19 (UC-11): the per-action cases are no longer hand-written `it` blocks —
 * they are GENERATED from `RBAC_DEFINITIONS` itself, one per row, against a
 * `Record<RbacAction, MatrixDriver[]>` table. A hand-written list stops covering
 * the matrix the moment an action is added (that is how `force-accept-completion`
 * went untested for a whole pass), and the two halves it used to be split into
 * ("here is a driver" / "here is the tier") could drift apart silently. Now:
 * TypeScript refuses a driver table with a missing key, `covers every action`
 * refuses it at runtime too, and the expectation of each generated case is read
 * from the same object the guards read.
 *
 * Pass-7 (R7-1 / D2): every guard is ALSO driven as an ORG-admin who is NOT a
 * project member — the emergency override must grant project-admin authority
 * AND leave a `project.org_admin.override` audit row on every use, while a
 * plain org member who is a non-member stays denied.
 */

const OVERRIDE_AUDIT_ACTION = "project.org_admin.override";
/** The Done-equivalent stage of the template every test project is built from. */
const TERMINAL_STAGE = GOVERNED_TEMPLATE.stages[GOVERNED_TEMPLATE.stages.length - 1]!.id;

/** How every helper here identifies one of the fixture users. */
interface TestUserRef {
  id: string;
  email: string;
}

let ctx: TestDbContext;
let store: TestStore;
let orgAdmin: TestUserRef;

function actorOf(u: TestUserRef) {
  return { userId: u.id, label: u.email };
}

type Actor = ReturnType<typeof actorOf>;

/** Run `fn` and classify: true = guard ALLOWED (passed), false = guard DENIED (403). */
async function guardAllowed<T>(fn: () => Promise<T>): Promise<boolean> {
  try {
    await fn();
    return true; // action completed → the guard let it through
  } catch (e) {
    if (isAppError(e) && e.status === 403) return false; // forbidden → denied
    return true; // a non-403 error is a downstream failure PAST the guard → allowed
  }
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  // An ORG admin who is NOT a member of the test project — the D2 override
  // subject (test-store's arda is org admin but also the project admin, so it
  // never exercises the override path).
  const record = insertUser(store.db, {
    id: "u_orgadmin",
    email: "orgadmin@viberr.test",
    name: "Org Admin",
    role: "admin",
  });
  orgAdmin = { id: record.id, email: record.email };
  // A task at the work stage with an owner, so ownership/transition/packet paths
  // have something to act on.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      title: "RBAC binding probe",
    }),
    goal: "Exercise the canonical guards per role.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
});

afterEach(() => ctx.cleanup());

// role → the test user with that role (deniz = non-member, always denied)
function usersByRole() {
  return {
    admin: store.users.arda,
    maintainer: store.users.murat,
    contributor: store.users.selin,
    viewer: store.users.elif,
  } satisfies Record<ProjectRole, TestUserRef>;
}

/**
 * The membership gate itself. `requireVisibleProject` (the route wrapper) and
 * `requireProjectMember` (the six config-surface loaders) both call exactly
 * this and re-clothe its refusal as the unknown-slug 404; that conversion is
 * asserted at the route level (app/features/policy/project-authority-routes.server.test.ts,
 * app/features/shell/workspace-routes.server.test.ts). Here we drive the gate,
 * which is where the per-role answer is actually decided — and which needs the
 * test store's dataRoot, so the route wrapper cannot be called from this suite.
 */
function visibilityGate(user: TestUserRef, what = "act on this project") {
  return assertProjectAction(store.db, "any-member", store.slug, actorOf(user), what, {
    dataRoot: store.dataRoot,
    allowArchived: true,
  });
}

/** The composition every project-scoped action uses: visibility, then work. */
async function commentAs(user: TestUserRef, text: string) {
  visibilityGate(user);
  return appendComment(
    store.db,
    { projectSlug: store.slug, taskKey: "VIB-1", text },
    actorOf(user),
    { dataRoot: store.dataRoot },
  );
}

function commentTexts(taskKey = "VIB-1"): string[] {
  const file = readTaskFile({
    projectSlug: store.slug,
    taskKey,
    dataRoot: store.dataRoot,
  })!;
  return file.parsed.timeline
    .filter((e) => e.type === "comment")
    .map((e) => e.text);
}

/** Rewrite VIB-1 to a known stage + rebuild (for state-dependent guards). */
function resetTaskStage(stage: string) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage, title: "RBAC binding probe" }),
    goal: "Exercise the canonical guards per role.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** Rewrite VIB-1 with an owner + rebuild (for the ownership guards). */
function resetTaskOwner(ownerUserId: string, patch: Partial<TaskFrontmatter> = {}) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      title: "RBAC binding probe",
      ownerUserId,
      ...patch,
    }),
    goal: "Exercise the canonical guards per role.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** A SECOND task, so "authority on my task" can be told apart from "authority". */
function writeOtherTask(key: string, patch: Partial<TaskFrontmatter> = {}) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, {
      stage: "impl",
      title: `Other task ${key}`,
      ...patch,
    }),
    goal: "A task the actor does not own.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

interface MatrixDriver {
  /** How this action is reached in the shipping server code. */
  label: string;
  /** The REAL server function, driven as `actor`. Its result is never read —
   *  the matrix records only whether the call threw. */
  run: (actor: Actor) => Promise<void>;
  /** Restore state before each actor so a successful mutation by an earlier
   *  (allowed) actor can't turn a later actor's attempt into a state-dependent
   *  no-op that bypasses the gate (e.g. an idempotent same-stage transition). */
  reset?: () => void;
  /** The action name the D2 override AUDIT row carries. Differs from the matrix
   *  action only for the two rows no role tier narrows: their whole enforcement
   *  IS the `any-member` membership gate, so that is what gets audited. */
  auditAction?: string;
}

/**
 * EVERY row of `RBAC_DEFINITIONS` → the real server function(s) that enforce it.
 *
 * `Record<RbacAction, …>` is deliberate: adding a row to the matrix without a
 * driver here is a TYPE error, and `covers every action in the matrix` fails at
 * runtime too (for the case where someone widens the type instead).
 */
function matrixDrivers() {
  let taskN = 0;
  let inviteN = 0;
  return {
    // `view` and `comment` are the two rows NO role tier narrows: every role
    // holds them, so their entire enforcement is the membership gate (they never
    // call `requireAction`). E1: the Policy page rendered them as "any signed-in
    // user · membership not required" long after R15-4 made projects
    // members-only — because nothing drove the question.
    view: [
      {
        label: "assertProjectAction any-member (the read gate every project surface uses)",
        run: async (actor) => {
          await assertProjectAction(store.db, "any-member", store.slug, actor, "read this project", {
            dataRoot: store.dataRoot,
            allowArchived: true,
          });
        },
        auditAction: "any-member",
      },
    ],
    comment: [
      {
        label: "requireVisibleProject + appendComment",
        run: async (actor) => {
          assertProjectAction(store.db, "any-member", store.slug, actor, "act on this project", {
            dataRoot: store.dataRoot,
            allowArchived: true,
          });
          await appendComment(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              text: `Matrix driver comment from ${actor.label}.`,
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
        auditAction: "any-member",
      },
    ],
    "create-task": [
      {
        label: "createTask",
        run: async (actor) => {
          await createTask(
            store.db,
            {
              projectSlug: store.slug,
              title: `Probe ${taskN++}`,
              goal: "a valid goal for the probe",
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "own-task": [
      {
        label: "setOwner (take ownership)",
        run: async (actor) => {
          await setOwner(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: actor.userId },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "approve-transition": [
      {
        label: "transitionStage (manual stage move)",
        // Reset to impl before each actor so every attempt is a real impl→ready
        // move that hits the gate (not an idempotent same-stage no-op after an
        // earlier win).
        run: async (actor) => {
          await transitionStage(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
        reset: () => resetTaskStage("impl"),
      },
    ],
    "resolve-packet": [
      {
        label: "dismissRecommendation",
        run: async (actor) => {
          await dismissRecommendation(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", recId: "nope" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
      {
        // F20: a bogus recId only reaches the notFound/conflict read AFTER the
        // guard, so the matrix outcome is a clean read of the guard —
        // viewers/non-members are denied up front (no recommendation-existence
        // leak) while maintainer+ pass and fail downstream. That is the dismiss
        // symmetry F20 restored.
        label: "applyRecommendation (authorized BEFORE the task read — F20)",
        run: async (actor) => {
          await applyRecommendation(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", recId: "nope" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "accept-completion": [
      {
        // VIB-1 has no owner, so the R6-2 owner exception cannot mask the tier,
        // and no PR, so maintainer+ pass the guard and fail downstream (non-403).
        label: "completeTaskMerge (merge-pending acceptance)",
        run: async (actor) => {
          await completeTaskMerge(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
      {
        // The Stage-dropdown / board-drag route into Done: a HUMAN manual move
        // to the terminal stage is an ACCEPTANCE, so it must be gated by
        // `accept-completion` and not by the (identically-tiered today)
        // `approve-transition` its `manual: true` shape would otherwise pick up.
        // Pass 19 found this path skipping the acceptance DISCLOSURE; this pins
        // that it never skips the acceptance AUTHORITY.
        label: `transitionStage manual → ${TERMINAL_STAGE} (acceptance contract)`,
        run: async (actor) => {
          await transitionStage(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              toStageId: TERMINAL_STAGE,
              manual: true,
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
        reset: () => resetTaskStage("review"),
      },
    ],
    "update-goal": [
      {
        label: "updateTaskGoal",
        run: async (actor) => {
          await updateTaskGoal(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              goal: "an updated goal that is long enough",
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "edit-task-meta": [
      {
        label: "setTaskMetadata",
        run: async (actor) => {
          await setTaskMetadata(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              priority: "high",
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "run-agents": [
      {
        label: "assignSpecialist",
        run: async (actor) => {
          await assignSpecialist(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", profileId: "does-not-exist" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "reorder-board": [
      {
        label: "reorderTask",
        run: async (actor) => {
          await reorderTask(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: null },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "reconcile-github": [
      {
        // R8-4: aligned with rescan-project (was contributor+).
        label: "assertProjectAction reconcile-github",
        run: async (actor) => {
          await assertProjectAction(
            store.db,
            "reconcile-github",
            store.slug,
            actor,
            "reconcile with GitHub",
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "grant-github-scope": [
      {
        label: "assertProjectAction grant-github-scope",
        run: async (actor) => {
          await assertProjectAction(
            store.db,
            "grant-github-scope",
            store.slug,
            actor,
            "change the credential",
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "rescan-project": [
      {
        label: "assertProjectAction rescan-project (action id, not a hardcoded role list)",
        run: async (actor) => {
          await assertProjectAction(
            store.db,
            "rescan-project",
            store.slug,
            actor,
            "re-scan the project",
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "release-any-ownership": [
      {
        // The owner is deniz — a former member who kept the seat. That makes the
        // release FOREIGN for all four roles (so the own-task path can't stand
        // in), while deniz's own attempt is a self-release that still needs
        // `own-task`, which a non-member does not hold. Re-seated before each
        // actor because a successful release clears the seat and the next
        // attempt takes the idempotent "nothing to release" branch, which only
        // needs membership.
        label: "releaseOwner (releasing SOMEONE ELSE's seat)",
        run: async (actor) => {
          await releaseOwner(store.db, { projectSlug: store.slug, taskKey: "VIB-1" }, actor, {
            dataRoot: store.dataRoot,
          });
        },
        reset: () => resetTaskOwner(store.users.deniz.id),
      },
    ],
    "manage-members": [
      {
        label: "inviteMember",
        run: async (actor) => {
          await inviteMember(
            store.db,
            {
              projectSlug: store.slug,
              name: `Invitee ${inviteN}`,
              email: `invitee-${inviteN++}@viberr.test`,
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "manage-agents": [
      {
        // An empty form only reaches its validation error AFTER the guard, so
        // the matrix reads the guard cleanly (403 = denied, validation = allowed).
        label: "createAgentProfile",
        run: async (actor) => {
          await createAgentProfile(store.db, { projectSlug: store.slug, form: {} }, actor, {
            dataRoot: store.dataRoot,
          });
        },
      },
    ],
    "edit-policy": [
      {
        label: "updateProjectIdentity",
        run: async (actor) => {
          await updateProjectIdentity(
            store.db,
            {
              projectSlug: store.slug,
              name: "Viberr Core",
              prefix: "VIB",
              description: "Edited by the matrix driver.",
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
      {
        // The WORKFLOW half of edit-policy, and the one the always-human
        // `change-project-policy` capability names: changing who authorizes a
        // stage boundary is how a project would delegate its transitions. The
        // identity path above (name/prefix/description) shares the action id but
        // not the consequence, so on its own it never proved this door was
        // locked to contributors.
        label: "setTransitionBoundary (the workflow-boundary path)",
        run: async (actor) => {
          await setTransitionBoundary(
            store.db,
            {
              projectSlug: store.slug,
              from: "triage",
              to: "ready",
              boundary: "approval",
            },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    "force-accept-completion": [
      {
        // The narrowest grant in the matrix, and the one that deliberately
        // bypasses the review gate (DG-2) — so its tier is the one that must
        // never widen by accident.
        label: "forceAcceptCompletion",
        run: async (actor) => {
          await forceAcceptCompletion(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
  } satisfies Record<RbacAction, MatrixDriver[]>;
}

/**
 * For a canonical action, assert every role's guard outcome matches
 * `rolesForAction(action)`, that a non-member is always denied, and that an
 * ORG-admin non-member is always ALLOWED via the audited D2 override.
 */
async function assertMatchesMatrix(action: RbacAction, driver: MatrixDriver) {
  const where = `${action} via ${driver.label}`;
  const allowed = new Set(rolesForAction(action));
  const byRole = usersByRole();
  for (const role of PROJECT_ROLES) {
    driver.reset?.();
    const got = await guardAllowed(() => driver.run(actorOf(byRole[role])));
    expect(
      got,
      `role "${role}" on ${where}: expected ${allowed.has(role) ? "ALLOW" : "DENY"}`,
    ).toBe(allowed.has(role));
  }
  // Non-member (deniz, org role: member) is never in any ACTION_ROLES set →
  // always denied.
  driver.reset?.();
  const nm = await guardAllowed(() => driver.run(actorOf(store.users.deniz)));
  expect(nm, `non-member on ${where} must be denied`).toBe(false);
  // ORG-admin non-member → ALLOWED as the D2 emergency override, and EVERY use
  // writes a `project.org_admin.override` audit row naming the action.
  driver.reset?.();
  const seen = new Set(
    listAuditEvents(store.db, { action: OVERRIDE_AUDIT_ACTION }).map((r) => r.id),
  );
  const oa = await guardAllowed(() => driver.run(actorOf(orgAdmin)));
  expect(oa, `org-admin non-member on ${where} must be ALLOWED (D2 override)`).toBe(true);
  const fresh = listAuditEvents(store.db, { action: OVERRIDE_AUDIT_ACTION }).filter(
    (r) => !seen.has(r.id),
  );
  expect(fresh.length, `org-admin override on ${where} must record an audit row`)
    .toBeGreaterThan(0);
  // One of the fresh rows names THIS gate (a driver may pass through more than
  // one gate — reorderTask delegates a cross-stage drop to a transition).
  expect(
    fresh.map((r) => r.details?.action),
    `the override row for ${where} must name the gate that granted it`,
  ).toContain(driver.auditAction ?? action);
  for (const row of fresh) {
    expect(row.details?.projectSlug).toBe(store.slug);
    expect(row.projectSlug).toBe(store.slug);
    expect(row.actorUserId).toBe(orgAdmin.id);
  }
}

describe("RBAC enforcement is bound to ACTION_ROLES (single-source guarantee)", () => {
  it("ROLE_RANK is a strict monotonic tier viewer<contributor<maintainer<admin", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.contributor);
    expect(ROLE_RANK.contributor).toBeLessThan(ROLE_RANK.maintainer);
    expect(ROLE_RANK.maintainer).toBeLessThan(ROLE_RANK.admin);
  });

  it("every ACTION_ROLES set is monotonic (if a role holds it, every higher role does)", () => {
    // The whole design assumes a tier; a non-monotonic set would be a bug.
    //
    // P13: this list used to be hand-maintained, so it silently stopped covering
    // the matrix the moment an action was added — `force-accept-completion`
    // (pass 12) was never checked here. Derive it from RBAC_DEFINITIONS so a new
    // action is covered the day it lands.
    const actions: RbacAction[] = RBAC_DEFINITIONS.map((d) => d.id);
    expect(actions.length).toBe(RBAC_DEFINITIONS.length);
    for (const a of actions) {
      const roles = rolesForAction(a).map((r) => ROLE_RANK[r]).sort((x, y) => x - y);
      const floor = roles[0]!;
      const holders = PROJECT_ROLES.filter((r) => ROLE_RANK[r] >= floor);
      expect(new Set(rolesForAction(a)), `action ${a} must be a rank floor`).toEqual(
        new Set(holders),
      );
    }
  });

  /**
   * `roleCan` is the predicate the guards (and `ownerException`) actually call,
   * and it is what the Policy table renders through — so the tier claim has to
   * hold THERE, not only in the raw sets. UPWARD-CLOSED in one direction and
   * STRICT in the other: a contributor grant reaches maintainer and admin; a
   * maintainer grant never reaches contributor or viewer.
   */
  it("roleCan is upward-closed and strictly denies below the floor", () => {
    const ordered = [...PROJECT_ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
    for (const def of RBAC_DEFINITIONS) {
      const floor = Math.min(...def.roles.map((r) => ROLE_RANK[r]));
      for (const role of ordered) {
        expect(
          roleCan(role, def.id),
          `roleCan("${role}", "${def.id}") must be ${ROLE_RANK[role] >= floor}`,
        ).toBe(ROLE_RANK[role] >= floor);
      }
      // A NON-member (null role) holds nothing at all, whatever the tier says —
      // membership is the outer gate on every row (R15-4).
      expect(roleCan(null, def.id), `a non-member must not hold "${def.id}"`).toBe(false);
      expect(roleCan(undefined, def.id)).toBe(false);
    }
  });

  it("covers every action in the matrix — a new action cannot ship untested", () => {
    // The completeness half of the table-driven design. Without it, adding a row
    // to RBAC_DEFINITIONS would ship an action whose SERVER enforcement nothing
    // ever drove (the display table would still render it, which is exactly the
    // drift this file exists to prevent).
    const drivers = matrixDrivers();
    expect(Object.keys(drivers).sort()).toEqual(
      RBAC_DEFINITIONS.map((d) => d.id).sort(),
    );
    for (const [action, list] of Object.entries(drivers)) {
      expect(list.length, `action "${action}" has no server driver`).toBeGreaterThan(0);
      for (const d of list) expect(d.run).toBeTypeOf("function");
    }
  });

  // One generated case per matrix row: every role, plus a non-member, plus the
  // org-admin override — against the REAL server function.
  for (const def of RBAC_DEFINITIONS) {
    it(`${def.id} → ${[...def.roles].sort().join("|")} (server guards, every role)`, async () => {
      for (const driver of matrixDrivers()[def.id]) {
        await assertMatchesMatrix(def.id, driver);
      }
    });
  }

  it("archived project FREEZES github/credential mutation (R8-5): even an admin is denied (409)", () => {
    // Archive the project (read-only per R6-3). Credential mutation no longer
    // passes allowArchived, so the mutable gate fires BEFORE the role check.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, { ...file.parsed.frontmatter, archived: true });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const admin = actorOf(store.users.arda);
    // grant-github-scope (change the credential) is admin-held, yet the archived
    // gate rejects it with a 409 (not a 403) — restore first.
    expect(() =>
      assertProjectAction(store.db, "grant-github-scope", store.slug, admin, "change the credential", {
        dataRoot: store.dataRoot,
      }),
    ).toThrow(/archived/i);
    // reconcile likewise frozen on an archived project.
    expect(() =>
      assertProjectAction(store.db, "reconcile-github", store.slug, admin, "reconcile with GitHub", {
        dataRoot: store.dataRoot,
      }),
    ).toThrow(/archived/i);
    // But a plain task READ gate still admits (allowArchived at the read path is unchanged).
    expect(() =>
      assertProjectAction(store.db, "grant-github-scope", store.slug, admin, "change the credential", {
        dataRoot: store.dataRoot,
        allowArchived: true,
      }),
    ).not.toThrow();
  });

  it("ownership hand-off REQUIRES the target can own (contributor+) — a viewer target is rejected", async () => {
    // Clean tiering: a viewer can't hold the owner seat, so an admin can't hand
    // ownership TO a viewer (elif) even though the admin may otherwise assign it.
    const admin = actorOf(store.users.arda);
    await expect(
      setOwner(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.elif.id },
        admin,
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // But handing off to a contributor (selin) is allowed.
    const ok = await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.selin.id },
      admin,
      { dataRoot: store.dataRoot },
    );
    expect(ok).toBeTruthy();
  });
});

/**
 * R6-2 / R14-2 / FR37 — a task's human OWNER holds the decisions ON THEIR OWN
 * TASK whatever their project role. BOTH halves matter, and only the first one
 * used to be tested here: the "…and a contributor who does NOT own it is still
 * denied" leg drove DENIZ, who is a NON-MEMBER — that assertion passes on the
 * membership gate alone and would still pass if `ownerException` handed
 * acceptance authority to every contributor in the project. The second task
 * below is the real control.
 */
describe("R6-2: task-owner authority is scoped to THAT task", () => {
  const acceptOn = (taskKey: string, user: { id: string; email: string }) =>
    guardAllowed(() =>
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey },
        actorOf(user),
        { dataRoot: store.dataRoot },
      ),
    );

  it("a CONTRIBUTOR owner may accept their own task — and no other task", async () => {
    resetTaskOwner(store.users.selin.id); // selin owns VIB-1
    // VIB-2 is owned by SOMEONE ELSE, not merely unowned. An unowned control
    // proves nothing: `ownerException` short-circuits on a null owner, so the
    // identity comparison — the half that makes the authority task-scoped — is
    // only load-bearing when there IS an owner to be confused with. (Caught by
    // canarying this case: with `ownerUserId === actor.userId` deleted from
    // ownerException, an unowned VIB-2 still refused selin and the test stayed
    // green.)
    writeOtherTask("VIB-2", { ownerUserId: store.users.arda.id });
    expect(
      await acceptOn("VIB-1", store.users.selin),
      "a contributor OWNER may accept their own task (R6-2)",
    ).toBe(true);
    expect(
      await acceptOn("VIB-2", store.users.selin),
      "the SAME contributor must be denied on a task they do not own",
    ).toBe(false);
    // A maintainer needs no ownership at all — the tier still works.
    expect(await acceptOn("VIB-2", store.users.murat)).toBe(true);
  });

  it("the owner exception needs a LIVE own-task role: a viewer owner is still denied", async () => {
    // `ownerException` re-checks `roleCan(role, "own-task")`, so a seat left
    // behind by a demotion (or hand-written into the file) does not carry
    // acceptance authority. elif is a viewer.
    resetTaskOwner(store.users.elif.id);
    expect(await acceptOn("VIB-1", store.users.elif)).toBe(false);
    // …and a seat held by someone who is no longer a member at all.
    resetTaskOwner(store.users.deniz.id);
    expect(await acceptOn("VIB-1", store.users.deniz)).toBe(false);
  });

  it("the owner exception does NOT reach the admin-only escape hatch (force-accept)", async () => {
    // force-accept-completion deliberately bypasses the review gate (DG-2), so
    // it is admin-only and takes no owner exception — otherwise any contributor
    // could hand themselves the bypass by taking the seat.
    resetTaskOwner(store.users.selin.id);
    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/**
 * The SECOND half of R6-2 / FR37, and the one a single-consumer test cannot
 * reach: `ownerException` is consulted by SEVEN different entry points, and the
 * "…for that task only" clause is ONE shared line
 * (`ownerUserId === actor.userId`) that every one of them depends on.
 *
 * This was not theory. The working tree of this very pass carried that line
 * DELETED — an unrestored canary — which handed acceptance, packet-resolution,
 * recommendation and manual-delivery authority on ANY owned task to every
 * contributor in the project. Exactly one test caught it (acceptance), so six
 * of the seven doors were standing open with a green suite. They are all driven
 * here now, and `covers every consumer` fails the day an eighth appears.
 *
 * Shape per driver: the SAME contributor, on a task they own vs a task someone
 * else owns — an UNOWNED control proves nothing, because the exception
 * short-circuits on a null owner.
 */
describe("R6-2: EVERY owner-exception consumer is scoped to the owner's own task", () => {
  const MINE = "VIB-1";
  const OTHER = "VIB-2";

  /** A packet whose single option drives the branch under test. */
  function probePacket(kind: "edit_goal" | "accept_completion"): TaskPacket {
    return {
      id: `pk-${kind}`,
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "Owner-authority probe",
      body: "",
      observations: [],
      options: [
        {
          kind,
          t: kind === "edit_goal" ? "Refine the goal" : "Accept completion",
          d: "",
          rec: false,
        },
      ],
    };
  }

  /**
   * Both tasks, at the stage the driver needs, each with a REAL owner: `MINE`
   * belongs to the actor under test, `OTHER` to the project admin.
   *
   * The project's `impl → review` boundary is rewritten to `human` so the one
   * consult that only a mid-graph human boundary reaches (transitionStage's
   * else-branch) is actually exercised — in the stock template the only `human`
   * boundary is the terminal one, which the acceptance route intercepts first.
   */
  function seedPair(
    ownerUserId: string,
    stage: string,
    packet: TaskPacket | null,
  ) {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      workflow: file.parsed.frontmatter.workflow.map((w) =>
        w.from === "impl" && w.to === "review" ? { ...w, boundary: "human" as const } : w,
      ),
    });
    for (const [key, owner] of [
      [MINE, ownerUserId],
      [OTHER, store.users.arda.id],
    ] as const) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, {
          stage,
          title: `Owner probe ${key}`,
          ownerUserId: owner,
        }),
        goal: "Exercise the owner exception on every consumer.",
        packet,
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  interface OwnerConsumerDriver {
    /** How this consult is reached in the shipping server code. */
    label: string;
    /** Stage both tasks are written at before each attempt. */
    stage: string;
    /** The packet both tasks carry, when the driver resolves one. */
    packet?: "edit_goal" | "accept_completion";
    /** The result is never read — only whether the consult threw. */
    run: (taskKey: string, actor: Actor) => Promise<void>;
  }

  /**
   * Keyed by the FUNCTION the consult lives in, so the source scan below can
   * compare this table against the real call sites.
   */
  const OWNER_CONSUMERS = {
    completeTaskMerge: [
      {
        label: "completeTaskMerge (merge-pending acceptance)",
        stage: "review",
        run: async (taskKey, actor) => {
          await completeTaskMerge(store.db, { projectSlug: store.slug, taskKey }, actor, {
            dataRoot: store.dataRoot,
          });
        },
      },
    ],
    transitionStage: [
      {
        // A `human` boundary that is NOT the terminal one — a custom board can
        // declare it, and it is the only path that reaches transitionStage's own
        // requireAcceptCompletion.
        label: "transitionStage across a mid-graph human boundary (impl → review)",
        stage: "impl",
        run: async (taskKey, actor) => {
          await transitionStage(
            store.db,
            { projectSlug: store.slug, taskKey, toStageId: "review" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    acceptCompletion: [
      {
        // The Stage-dropdown / board-drag route into Done, which hands off to
        // the private acceptCompletion and its own re-check.
        label: `manual transition → ${TERMINAL_STAGE} (the acceptance contract)`,
        stage: "review",
        run: async (taskKey, actor) => {
          await transitionStage(
            store.db,
            { projectSlug: store.slug, taskKey, toStageId: TERMINAL_STAGE, manual: true },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    resolvePacket: [
      {
        label: "resolvePacket, non-acceptance option (the packet is addressed to the owner)",
        stage: "impl",
        packet: "edit_goal",
        run: async (taskKey, actor) => {
          await resolvePacket(
            store.db,
            { projectSlug: store.slug, taskKey, optionIndex: 0 },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
      {
        label: "resolvePacket, accept_completion option (acceptance through the packet)",
        stage: "review",
        packet: "accept_completion",
        run: async (taskKey, actor) => {
          await resolvePacket(
            store.db,
            { projectSlug: store.slug, taskKey, optionIndex: 0 },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    applyRecommendation: [
      {
        label: "applyRecommendation (authorized before the recommendation read)",
        stage: "impl",
        run: async (taskKey, actor) => {
          await applyRecommendation(
            store.db,
            { projectSlug: store.slug, taskKey, recId: "nope" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    dismissRecommendation: [
      {
        label: "dismissRecommendation",
        stage: "impl",
        run: async (taskKey, actor) => {
          await dismissRecommendation(
            store.db,
            { projectSlug: store.slug, taskKey, recId: "nope" },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
    manualDeliverForReview: [
      {
        // R15-2 safety net (b): the owner ships their OWN task's branch. Anyone
        // else needs run-agents (maintainer+).
        label: "manualDeliverForReview (the GitHub panel's deliver button)",
        stage: "impl",
        run: async (taskKey, actor) => {
          await manualDeliverForReview(store.db, { projectSlug: store.slug, taskKey }, actor, {
            dataRoot: store.dataRoot,
          });
        },
      },
    ],
    requestPacketMaintainerDecision: [
      {
        // F20-18: a contributor-OWNER routes their own stranded packet UP to a
        // maintainer. A non-owner (and a demoted/removed owner) hits the
        // resolve-packet gate's 403 — the owner exception is per-task authority.
        label: "requestPacketMaintainerDecision (owner escalates a stranded packet)",
        stage: "impl",
        packet: "edit_goal",
        run: async (taskKey, actor) => {
          await requestPacketMaintainerDecision(
            store.db,
            { projectSlug: store.slug, taskKey },
            actor,
            { dataRoot: store.dataRoot },
          );
        },
      },
    ],
  } satisfies Record<string, OwnerConsumerDriver[]>;

  async function attempt(
    driver: OwnerConsumerDriver,
    owner: TestUserRef,
    taskKey: string,
    actor: TestUserRef,
  ): Promise<boolean> {
    seedPair(owner.id, driver.stage, driver.packet ? probePacket(driver.packet) : null);
    return guardAllowed(() => driver.run(taskKey, actorOf(actor)));
  }

  for (const [fn, drivers] of Object.entries(OWNER_CONSUMERS)) {
    for (const driver of drivers) {
      it(`${fn}: a contributor OWNER passes, the same contributor on someone else's task does not — ${driver.label}`, async () => {
        const selin = store.users.selin;
        expect(
          await attempt(driver, selin, MINE, selin),
          `a contributor OWNER must clear ${fn} on their own task (R6-2)`,
        ).toBe(true);
        expect(
          await attempt(driver, selin, OTHER, selin),
          `the SAME contributor must be refused by ${fn} on a task ARDA owns — ` +
            `the owner exception is authority over one task, not the project`,
        ).toBe(false);
        // The exception also needs a LIVE own-task role, on every consumer: a
        // viewer who kept the seat through a demotion, and a former member who
        // kept it through a removal, hold nothing.
        expect(
          await attempt(driver, store.users.elif, MINE, store.users.elif),
          `a VIEWER owner must still be refused by ${fn}`,
        ).toBe(false);
        expect(
          await attempt(driver, store.users.deniz, MINE, store.users.deniz),
          `a NON-MEMBER owner must still be refused by ${fn}`,
        ).toBe(false);
      });
    }
  }

  it("covers every consumer of the owner exception — a new one cannot ship undriven", () => {
    // The completeness half. `ownerException` is private, so the drivers above
    // can only cover the call sites they KNOW about; this reads the source and
    // fails when a function consults the exception (directly or through the two
    // shared helpers) without appearing in the table.
    //
    // BS-2 (pass-19 verifier): the first version of this scan tracked only
    // `function` DECLARATIONS, so a consult inside a top-level arrow const was
    // credited to the last preceding `function` — a name already in the table.
    // Appending `export const probeOwnerConsumer = async (…) => {
    // requireAcceptCompletion(…) }` to task-actions.server.ts left the suite
    // GREEN: a brand-new consumer of the owner exception, undriven, invisible.
    // Two things fix it, and the scan needs BOTH:
    //
    //  1. the attribution tracks arrow/function CONSTS as well as declarations
    //     (restricted to function-SHAPED consts — `const re = /…\(/;` must not
    //     become an enclosing scope and swallow the next function's consults);
    //  2. attribution is RANGE-CHECKED. A consult that falls outside the block
    //     currently being tracked (a class/object method, an unusual formatting
    //     the regexes miss) is credited to `<module>` and fails the equality
    //     below — the scan reports "I could not attribute this" instead of
    //     silently crediting whichever name it happened to be holding.
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../server/tasks/task-actions.server.ts",
      ),
      "utf8",
    ).split("\n");
    const fnDecl = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/;
    /** `const f = (…) =>` / `= async (…) =>` / `= function` / `= <T,>(…) =>`. */
    const fnConst =
      /^(?:export )?const ([A-Za-z0-9_]+)(?::[^=]*)?\s*=\s*(?:async\s*)?(?:function\b|<[^>]*>\s*\(|\()/;
    const consult = /(?:ownerException|requireAcceptCompletion|requireDecisionAuthority)\(/;
    const helpers = new Set([
      "ownerException",
      "requireAcceptCompletion",
      "requireDecisionAuthority",
    ]);
    let current = "<module>";
    /** Last line index of `current`'s block — prettier closes it at column 0. */
    let currentEnd = -1;
    const consumers = new Set<string>();
    for (let i = 0; i < source.length; i++) {
      const line = source[i]!;
      const name = fnDecl.exec(line)?.[1] ?? fnConst.exec(line)?.[1];
      if (name) {
        current = name;
        const rel = source.slice(i + 1).findIndex((l) => l.startsWith("}"));
        currentEnd = rel === -1 ? source.length - 1 : i + 1 + rel;
      }
      if (!consult.test(line)) continue;
      const owner = i <= currentEnd ? current : "<module>";
      if (!helpers.has(owner)) consumers.add(owner);
    }
    // Non-vacuity: the file was read and the consult pattern matches real lines.
    // (The set equality below is the completeness assertion — it names the
    // EXPECTED consumers, so a floor on `consumers.size` would add nothing.)
    expect(
      source.filter((l) => consult.test(l)).length,
      "the scan must actually be reading task-actions.server.ts",
    ).toBeGreaterThan(10);
    expect([...consumers].sort()).toEqual(Object.keys(OWNER_CONSUMERS).sort());
  });
});

/**
 * ALWAYS_HUMAN_CAPABILITY_IDS (app/shared/capabilities.ts) — merge a pull
 * request · transition a task to Done · change project policy. These are
 * STRUCTURAL locks, not defaults: no stored grant, at any mode, may make one of
 * them reachable from an agent path.
 *
 * The WRITE half (every profile write path coerces them to `human`) is pinned in
 * app/features/agents/agents-route.server.test.ts. This is the READ half — the
 * one that has to hold for grants nobody wrote through those paths: `project.md`
 * is a hand-editable file, and the runtime must not trust what it says here.
 */
describe("ALWAYS_HUMAN capabilities are unreachable whatever the grants say", () => {
  const grant = (
    capabilityId: string,
    mode: CapabilityGrant["mode"],
  ): CapabilityGrant => ({ capabilityId, mode });

  it("the set is exactly the three structural locks — each with a server invariant below", () => {
    // Dropping an id from this constant unlocks it EVERYWHERE at once (the
    // profile-write coercion, the tool denylist, the Codex enforcement class,
    // the Policy page's reserved-for-humans rows), and every other test in the
    // family iterates the constant — so they would all keep passing while the
    // lock disappeared. This is the one assertion that does not read the list
    // it is checking.
    expect([...ALWAYS_HUMAN_CAPABILITY_IDS]).toEqual([
      "merge-pull-request", // → the deny-list cases + "the operator flag is not a bypass"
      "transition-to-done", // → the operator bare-transition case + the boundary lock
      "change-project-policy", // → the edit-policy matrix driver + the boundary lock
    ]);
  });

  it("an actionable grant never RELAXES the tool confinement", () => {
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      const withheld = resolveSpecialistDisallowedTools([grant(id, "off")]);
      for (const mode of ["direct", "recommend", "human"] as const) {
        const denied = resolveSpecialistDisallowedTools([grant(id, mode)]);
        for (const tool of withheld) {
          expect(
            denied,
            `"${id}" granted at "${mode}" must not unlock ${tool}`,
          ).toContain(tool);
        }
      }
    }
  });

  it("merge-pull-request stays denied even when the file grants it directly", () => {
    // The concrete, observable instance of the rule above: a hand-edited (or
    // hostile) profile that says `merge-pull-request: direct` still cannot run
    // `gh pr merge` — the SDK deny list wins over bypassPermissions.
    expect(
      resolveSpecialistDisallowedTools([grant("merge-pull-request", "direct")]),
    ).toContain("Bash(gh pr merge:*)");
    // …including alongside a full delivery grant, which is when a specialist
    // would otherwise have everything it needs to merge its own PR.
    const fullyPowered = resolveSpecialistDisallowedTools([
      grant("execute-code-or-write-repo", "direct"),
      grant("create-task-branch", "direct"),
      grant("commit-push-branch", "direct"),
      grant("open-review-pr", "direct"),
      grant("merge-pull-request", "direct"),
    ]);
    expect(fullyPowered).toContain("Bash(gh pr merge:*)");
    expect(fullyPowered).not.toContain("Bash(git push:*)"); // the granted ones DO open
  });

  it("transition-to-done: the operator cannot bare-transition a task into Done", async () => {
    // The runtime half of the `transition-to-done` lock. Operator authority
    // skips human RBAC by design (its capability policy is the gate), so the
    // terminal stage is refused explicitly on that path — the operator reaches
    // Done only through the controlled acceptance route (owner ruling Q1), never
    // a bare stage move.
    resetTaskStage("review");
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: TERMINAL_STAGE },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot, operatorAuthorized: true },
      ),
    ).rejects.toMatchObject({
      status: 403,
      message:
        "The operator reaches Done only by accepting completion, not a bare transition.",
    });
    // Nothing moved.
    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(after.parsed.frontmatter.stage).toBe("review");
    // …and the refusal is about the TERMINAL stage, not about the operator: the
    // same call to a non-terminal stage goes through.
    resetTaskStage("impl");
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot, operatorAuthorized: true },
    );
    const moved = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(moved.parsed.frontmatter.stage).toBe("review");
  });

  /**
   * transition-to-done · change-project-policy, one rung UP: the two locks
   * above stop an agent from walking through the door, and this stops anyone
   * from taking the door off its hinges. A project whose `→ Done` boundary
   * could be set to `auto` would hand the operator a machine transition into
   * Done through the ORDINARY path, with every always-human check intact and
   * irrelevant. `setTransitionBoundary` refuses that, and nothing tested it.
   */
  it("policy cannot delegate the boundary INTO Done — refused for an admin, with no partial write", async () => {
    const admin = actorOf(store.users.arda);
    const boundaryTo = (boundary: string) =>
      setTransitionBoundary(
        store.db,
        { projectSlug: store.slug, from: "review", to: TERMINAL_STAGE, boundary },
        admin,
        { dataRoot: store.dataRoot },
      );
    for (const boundary of ["auto", "approval"]) {
      await expect(boundaryTo(boundary), `→ Done must refuse "${boundary}"`).rejects.toMatchObject({
        status: 403,
        message:
          "Completion is human-authorized in V1, so this boundary can't be delegated",
      });
    }
    // Nothing moved on disk — a refusal is not a partial write.
    const after = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    expect(
      after.parsed.frontmatter.workflow.find((w) => w.to === TERMINAL_STAGE)?.boundary,
    ).toBe("human");
    // …and the refusal is about DONE, not about admins editing boundaries: the
    // same admin retunes a mid-graph boundary freely.
    const ok = await setTransitionBoundary(
      store.db,
      { projectSlug: store.slug, from: "triage", to: "ready", boundary: "approval" },
      admin,
      { dataRoot: store.dataRoot },
    );
    expect(ok.changed).toBe(true);
  });

  it("an UNLOCKED rule into the final stage is refused too — the lock is the STAGE, not the row flag", async () => {
    // A custom board can add its own edge into Done (the stage editor maintains
    // the chain), and such a row carries no `locked` flag. If the guard rested
    // on that flag alone, `impl → Done: auto` would be accepted and the terminal
    // stage would be machine-reachable on a perfectly ordinary project.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      workflow: [
        ...file.parsed.frontmatter.workflow,
        {
          from: "impl",
          to: TERMINAL_STAGE,
          boundary: "human" as const,
          by: "Human acceptance, on a custom board's extra edge",
          locked: false,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const admin = actorOf(store.users.arda);
    for (const boundary of ["auto", "approval"]) {
      await expect(
        setTransitionBoundary(
          store.db,
          { projectSlug: store.slug, from: "impl", to: TERMINAL_STAGE, boundary },
          admin,
          { dataRoot: store.dataRoot },
        ),
        `an unlocked → Done row must still refuse "${boundary}"`,
      ).rejects.toMatchObject({ status: 403 });
    }
    const after = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    expect(
      after.parsed.frontmatter.workflow.find(
        (w) => w.from === "impl" && w.to === TERMINAL_STAGE,
      )?.boundary,
    ).toBe("human");
  });

  it("a LOCKED row refuses every boundary change, wherever it sits in the graph", async () => {
    // The other half of the same guard, and the only one the → Done cases above
    // cannot see (that edge is refused by the terminal-stage clause whether or
    // not the row is locked). `locked` is how a workflow row declares itself
    // non-negotiable; without this, deleting the flag check would be invisible.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      workflow: file.parsed.frontmatter.workflow.map((w) =>
        w.from === "triage" && w.to === "ready" ? { ...w, locked: true } : w,
      ),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await expect(
      setTransitionBoundary(
        store.db,
        { projectSlug: store.slug, from: "triage", to: "ready", boundary: "approval" },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    const after = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    expect(
      after.parsed.frontmatter.workflow.find((w) => w.from === "triage")?.boundary,
    ).toBe("auto");
  });

  /**
   * `operatorAuthorized` is the runtime's "this call comes from the operator,
   * its capability policy already gated it" flag, and it deliberately skips
   * human RBAC on the paths it is allowed on. These are the paths it is NOT
   * allowed on — the two always-human ones a run could otherwise reach by
   * carrying the flag into a shared server function.
   */
  it("the operator flag is not an ACCEPTANCE bypass (merge-pull-request)", async () => {
    resetTaskStage("review");
    for (const user of [store.users.elif, store.users.selin, store.users.deniz]) {
      await expect(
        completeTaskMerge(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1" },
          actorOf(user),
          { dataRoot: store.dataRoot, operatorAuthorized: true },
        ),
        `${user.email} must not gain the merge by carrying the operator flag`,
      ).rejects.toMatchObject({ status: 403 });
    }
    // The control: the flag changes nothing for a maintainer either — they pass
    // on their OWN authority and fail downstream on the missing PR (400), so the
    // 403s above are the guard, not an unrelated refusal.
    await expect(
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.murat),
        { dataRoot: store.dataRoot, operatorAuthorized: true },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("the operator flag does not INHERIT the human owner's authority (resolvePacket)", async () => {
    // `resolvePacket` computes `isOwner` as `!ctx.operatorAuthorized && ownerException(…)`:
    // an operator-authorized call must name its own authority, never borrow the
    // seat of the human who happens to own the task.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        title: "RBAC binding probe",
        ownerUserId: store.users.selin.id,
      }),
      goal: "Exercise the canonical guards per role.",
      packet: {
        id: "pk-operator-probe",
        type: "input",
        kind: "Blocked decision",
        from: "operator",
        title: "Operator-authority probe",
        body: "",
        observations: [],
        options: [{ kind: "edit_goal", t: "Refine the goal", d: "", rec: false }],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const resolveAs = (ctx: { operatorAuthorized?: boolean }) =>
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot, ...ctx },
      );
    await expect(resolveAs({ operatorAuthorized: true })).rejects.toMatchObject({
      status: 403,
    });
    // …and the same call WITHOUT the flag is the owner's own decision, allowed.
    await expect(resolveAs({})).resolves.toBeTruthy();
  });
});

describe("D2 org-admin emergency override (R7-1)", () => {
  const fileCtx = () => ({ dataRoot: store.dataRoot });
  const overrideRows = () =>
    listAuditEvents(store.db, { action: OVERRIDE_AUDIT_ACTION });

  it("config-surface guards admit an org-admin non-member — audited per use", async () => {
    // edit-policy (project settings identity).
    const settings = await updateProjectIdentity(
      store.db,
      { projectSlug: store.slug, name: "Viberr Core", prefix: "VIB", description: "Overridden." },
      actorOf(orgAdmin),
      fileCtx(),
    );
    expect(settings.toast).toBeTruthy();
    // manage-members (invite + role change).
    await inviteMember(
      store.db,
      { projectSlug: store.slug, name: "New Person", email: "newperson@viberr.test" },
      actorOf(orgAdmin),
      fileCtx(),
    );
    await setMemberRole(
      store.db,
      { projectSlug: store.slug, targetUserId: store.users.elif.id, role: "contributor" },
      actorOf(orgAdmin),
      fileCtx(),
    );
    const rows = overrideRows();
    expect(rows.length).toBe(3);
    const auditedActions = rows.map((r) => r.details?.action).sort();
    expect(auditedActions).toEqual(["edit-policy", "manage-members", "manage-members"]);
    for (const row of rows) {
      expect(row.actorUserId).toBe(orgAdmin.id);
      expect(row.projectSlug).toBe(store.slug);
      expect(row.details?.projectSlug).toBe(store.slug);
    }
  });

  it("the any-member gate admits an org-admin non-member AND audits it (F19-30)", () => {
    // This used to assert `toHaveLength(0)` — the `any-member` gate was exempt
    // from the override row, justified as "config-surface route READs only;
    // every real mutation names a concrete RbacAction and IS audited". False:
    // COMMENTING is a real, role-free mutation whose ONLY authority is this
    // gate, so an org-admin non-member could write into a members-only project
    // leaving no trace — contradicting D2's "EVERY such grant leaves a row".
    // The F7 audit-noise complaint (a row per page load) is answered by the
    // 60s per-`what` collapse below, not by silence.
    const grant = assertProjectAction(
      store.db,
      "any-member",
      store.slug,
      actorOf(orgAdmin),
      "view this project's policy",
      { dataRoot: store.dataRoot, allowArchived: true },
    );
    expect(grant.role).toBe("admin");
    expect(grant.isOrgAdminOverride).toBe(true);
    const rows = overrideRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details?.action).toBe("any-member");
    expect(rows[0]?.details?.what).toBe("view this project's policy");

    // A second page load inside the window collapses into that one row…
    assertProjectAction(
      store.db,
      "any-member",
      store.slug,
      actorOf(orgAdmin),
      "view this project's policy",
      { dataRoot: store.dataRoot, allowArchived: true },
    );
    expect(overrideRows()).toHaveLength(1);
    // …but the WRITE gate (`act on this project` — the comment path) is keyed
    // separately, so a read can never mask it.
    assertProjectAction(
      store.db,
      "any-member",
      store.slug,
      actorOf(orgAdmin),
      "act on this project",
      { dataRoot: store.dataRoot, allowArchived: true },
    );
    expect(overrideRows().map((r) => r.details?.what)).toContain(
      "act on this project",
    );
  });

  it("an org admin acting within their OWN sufficient membership is NOT an override (no row)", async () => {
    // arda is org admin AND the project admin — the membership role grants.
    const grant = assertProjectAction(
      store.db,
      "edit-policy",
      store.slug,
      actorOf(store.users.arda),
      "change project settings",
      { dataRoot: store.dataRoot },
    );
    expect(grant.role).toBe("admin");
    expect(grant.isOrgAdminOverride).toBe(false);
    await createTask(
      store.db,
      { projectSlug: store.slug, title: "No override here", goal: "a valid goal for the probe" },
      actorOf(store.users.arda),
      fileCtx(),
    );
    expect(overrideRows()).toHaveLength(0);
  });

  it("a plain org MEMBER non-member stays denied on config surfaces (no override, no row)", async () => {
    await expect(
      updateProjectIdentity(
        store.db,
        { projectSlug: store.slug, name: "Nope", prefix: "VIB", description: "" },
        actorOf(store.users.deniz),
        fileCtx(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(() =>
      assertProjectAction(
        store.db,
        "any-member",
        store.slug,
        actorOf(store.users.deniz),
        "view this project's policy",
        { dataRoot: store.dataRoot, allowArchived: true },
      ),
    ).toThrowError(/Only project members/);
    expect(overrideRows()).toHaveLength(0);
  });
});

/**
 * B-WF7: `reorderTask` requires `reorder-board`, then delegates a cross-stage
 * drop to a `manual: true` transition requiring `approve-transition`. The two
 * are the same tier TODAY, so the split cannot 403 halfway — but nothing said
 * so, and a future tier change on either one would fail a drag AFTER the
 * visible gate had already passed. This is that statement, in code.
 */
describe("B-WF7: reorder-board and approve-transition stay one tier", () => {
  it("every role that may reorder the board may also authorize the transition it implies", () => {
    const reorder = rolesForAction("reorder-board");
    const transition = rolesForAction("approve-transition");
    for (const role of reorder) {
      expect(
        transition,
        `role "${role}" can reorder the board but could not authorize the ` +
          `cross-stage move a drag performs — reorderTask would 403 after the ` +
          `visible gate passed`,
      ).toContain(role);
    }
  });
});

/**
 * E7 + E1: `view` and `comment` are the two rows in the matrix that NO role
 * tier narrows. The matrix drivers above prove the per-role answer; these cases
 * pin what the live HTTP probe found on top of it — that a refusal is refused
 * BEFORE the write, so "denied" means the timeline never took the comment.
 */
describe("view + comment are enforced as MEMBERSHIP, not as a role tier", () => {
  /** Run and return the refusal it threw: the `AppError` every guard raises,
   *  `null` for a throw of any other kind, `undefined` when nothing threw — the
   *  three stay distinct so `isAppError` below still tells them apart. */
  async function caught<T>(fn: () => T): Promise<AppError | null | undefined> {
    try {
      await fn();
      return undefined;
    } catch (error) {
      return isAppError(error) ? error : null;
    }
  }

  it("both rows are held by EVERY role — the matrix says so and no guard narrows it", () => {
    for (const action of ["view", "comment"] as const) {
      expect(new Set(rolesForAction(action))).toEqual(
        new Set(["admin", "maintainer", "contributor", "viewer"]),
      );
    }
  });

  it("every role reaches the project; a non-member is refused by the same gate", async () => {
    const byRole = usersByRole();
    for (const role of PROJECT_ROLES) {
      const grant = visibilityGate(byRole[role]);
      expect(grant.role, `role "${role}" must be able to open the project`).toBe(role);
      expect(grant.isOrgAdminOverride).toBe(false);
    }
    const refusal = await caught(() => visibilityGate(store.users.deniz));
    expect(isAppError(refusal)).toBe(true);
    expect(refusal?.status).toBe(403); // the ROUTE turns this into the 404
    // The D2 override reaches reads too (audited, per F19-30).
    const override = visibilityGate(orgAdmin);
    expect(override.role).toBe("admin");
    expect(override.isOrgAdminOverride).toBe(true);
  });

  it("a VIEWER may comment; a non-member's comment is refused before a byte is written", async () => {
    expect(await caught(() => commentAs(store.users.elif, "Viewer says hello"))).toBeUndefined();
    expect(commentTexts()).toContain("Viewer says hello");

    const refusal = await caught(() =>
      commentAs(store.users.deniz, "Non-member says hello"),
    );
    expect(isAppError(refusal)).toBe(true);
    expect(refusal?.status).toBe(403); // → the route's unknown-slug 404
    // The comment path itself carries no authorization (task-actions §7.7) —
    // `requireVisibleProject` IS its access control, so "refused" has to mean
    // the timeline never took the write.
    expect(commentTexts()).not.toContain("Non-member says hello");
  });
});

describe("the matrix itself is pinned, not just the call sites", () => {
  /**
   * Everything above derives its expectation from `rolesForAction` — the same
   * map the guards read — so it binds CALL SITES to the matrix but cannot see a
   * change to the matrix. Widening a tier (e.g. `manage-agents` to maintainer)
   * keeps every one of those tests green while silently handing out authority.
   *
   * This is the other half: the tiers written out by hand. Editing ACTION_ROLES
   * now requires editing this table too, which is the point — a role tier is a
   * policy decision, so it should never move as a side effect of a refactor.
   */
  const EXPECTED_TIERS = {
    view: ["admin", "maintainer", "contributor", "viewer"],
    comment: ["admin", "maintainer", "contributor", "viewer"],
    "create-task": ["admin", "maintainer", "contributor"],
    "own-task": ["admin", "maintainer", "contributor"],
    "approve-transition": ["admin", "maintainer"],
    "resolve-packet": ["admin", "maintainer"],
    "accept-completion": ["admin", "maintainer"],
    "update-goal": ["admin", "maintainer"],
    "edit-task-meta": ["admin", "maintainer", "contributor"],
    "run-agents": ["admin", "maintainer"],
    "reorder-board": ["admin", "maintainer"],
    "reconcile-github": ["admin", "maintainer"],
    "grant-github-scope": ["admin", "maintainer"],
    "rescan-project": ["admin", "maintainer"],
    "release-any-ownership": ["admin"],
    "manage-members": ["admin"],
    "manage-agents": ["admin"],
    "edit-policy": ["admin"],
    "force-accept-completion": ["admin"],
  } satisfies Record<RbacAction, ProjectRole[]>;

  it("every action holds exactly the roles the policy decision assigned it", () => {
    const actual = Object.fromEntries(
      RBAC_DEFINITIONS.map((d) => [d.id, [...d.roles]]),
    );
    expect(actual).toEqual(EXPECTED_TIERS);
  });

  it("covers every action in the matrix — a new action cannot slip in untiered", () => {
    expect(RBAC_DEFINITIONS.map((d) => d.id).sort()).toEqual(
      Object.keys(EXPECTED_TIERS).sort(),
    );
  });
});
