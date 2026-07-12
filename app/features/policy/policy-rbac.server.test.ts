import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  createTask,
  setOwner,
  transitionStage,
  updateTaskGoal,
  reorderTask,
  dismissRecommendation,
} from "~/server/tasks/task-actions.server";
import {
  assignSpecialist,
} from "~/server/tasks/specialist-run.server";
import { isAppError } from "~/server/errors/app-error.server";
import { ROLE_RANK, rolesForAction, type ProjectRole, type RbacAction } from "~/shared/rbac";

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
 */

let ctx: TestDbContext;
let store: TestStore;

function actorOf(u: { id: string; email: string }) {
  return { userId: u.id, label: u.email };
}

/** Run `fn` and classify: true = guard ALLOWED (passed), false = guard DENIED (403). */
async function guardAllowed(fn: () => Promise<unknown>): Promise<boolean> {
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
  } as Record<ProjectRole, { id: string; email: string }>;
}

/**
 * For a canonical action, assert every role's guard outcome matches
 * `rolesForAction(action)`, and that a non-member is always denied.
 */
async function assertMatchesMatrix(
  action: RbacAction,
  run: (actor: { userId: string; label: string }) => Promise<unknown>,
  /** Restore task state before each actor so a successful mutation by an earlier
   *  (allowed) actor can't turn a later actor's attempt into a state-dependent
   *  no-op that bypasses the gate (e.g. an idempotent same-stage transition). */
  reset?: () => void,
) {
  const allowed = new Set(rolesForAction(action));
  const byRole = usersByRole();
  for (const role of Object.keys(byRole) as ProjectRole[]) {
    reset?.();
    const got = await guardAllowed(() => run(actorOf(byRole[role])));
    expect(
      got,
      `role "${role}" on action "${action}": expected ${allowed.has(role) ? "ALLOW" : "DENY"}`,
    ).toBe(allowed.has(role));
  }
  // Non-member (deniz) is never in any ACTION_ROLES set → always denied.
  reset?.();
  const nm = await guardAllowed(() => run(actorOf(store.users.deniz)));
  expect(nm, `non-member on action "${action}" must be denied`).toBe(false);
}

/** Rewrite VIB-1 to a known stage + rebuild (for state-dependent guards). */
function resetTaskStage(stage: string) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage, title: "RBAC binding probe" }),
    goal: "Exercise the canonical guards per role.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

describe("RBAC enforcement is bound to ACTION_ROLES (single-source guarantee)", () => {
  it("ROLE_RANK is a strict monotonic tier viewer<contributor<maintainer<admin", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.contributor);
    expect(ROLE_RANK.contributor).toBeLessThan(ROLE_RANK.maintainer);
    expect(ROLE_RANK.maintainer).toBeLessThan(ROLE_RANK.admin);
  });

  it("every ACTION_ROLES set is monotonic (if a role holds it, every higher role does)", () => {
    // The whole design assumes a tier; a non-monotonic set would be a bug.
    const actions: RbacAction[] = [
      "create-task", "own-task", "reconcile-github", "approve-transition",
      "resolve-packet", "accept-completion", "run-agents", "reorder-board",
      "update-goal", "grant-github-scope", "release-any-ownership",
      "manage-members", "manage-agents", "edit-policy",
    ];
    for (const a of actions) {
      const roles = rolesForAction(a).map((r) => ROLE_RANK[r]).sort((x, y) => x - y);
      const floor = roles[0]!;
      const holders = (["viewer", "contributor", "maintainer", "admin"] as ProjectRole[])
        .filter((r) => ROLE_RANK[r] >= floor);
      expect(new Set(rolesForAction(a)), `action ${a} must be a rank floor`).toEqual(
        new Set(holders),
      );
    }
  });

  it("create-task → contributor+ (viewer + non-member denied)", async () => {
    let n = 0;
    await assertMatchesMatrix("create-task", (actor) =>
      createTask(store.db, { projectSlug: store.slug, title: `Probe ${n++}` , goal: "a valid goal for the probe" }, actor, { dataRoot: store.dataRoot }),
    );
  });

  it("a nonmember org admin has audited emergency project-admin authority", async () => {
    const result = await createTask(
      store.db,
      {
        projectSlug: store.slug,
        title: "Emergency override probe",
        goal: "Verify org-admin project recovery authority.",
      },
      {
        ...actorOf(store.users.deniz),
        orgRole: "admin",
      },
      { dataRoot: store.dataRoot },
    );
    expect(result.task).toBeTruthy();
    const audit = store.db
      .prepare(
        `SELECT details_json FROM audit_events
         WHERE action = 'task.created' AND task_key = ?`,
      )
      .get(result.key) as { details_json: string };
    expect(JSON.parse(audit.details_json)).toMatchObject({
      authoritySource: "org_admin_override",
    });
    const member = store.db
      .prepare(
        `SELECT role FROM project_members
         WHERE project_slug = ? AND user_id = ?`,
      )
      .get(store.slug, store.users.deniz.id);
    expect(member).toBeUndefined();
  });

  it("own-task (take ownership) → contributor+ (viewer + non-member denied)", async () => {
    await assertMatchesMatrix("own-task", (actor) =>
      setOwner(store.db, { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: actor.userId }, actor, { dataRoot: store.dataRoot }),
    );
  });

  it("approve-transition (manual stage move) → maintainer+", async () => {
    // Reset to impl before each actor so every attempt is a real impl→ready move
    // that hits the gate (not an idempotent same-stage no-op after an earlier win).
    await assertMatchesMatrix(
      "approve-transition",
      (actor) =>
        transitionStage(store.db, { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true }, actor, { dataRoot: store.dataRoot }),
      () => resetTaskStage("impl"),
    );
  });

  it("update-goal → maintainer+", async () => {
    await assertMatchesMatrix("update-goal", (actor) =>
      updateTaskGoal(store.db, { projectSlug: store.slug, taskKey: "VIB-1", goal: "an updated goal that is long enough" }, actor, { dataRoot: store.dataRoot }),
    );
  });

  it("reorder-board → maintainer+", async () => {
    await assertMatchesMatrix("reorder-board", (actor) =>
      reorderTask(store.db, { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", beforeKey: null }, actor, { dataRoot: store.dataRoot }),
    );
  });

  it("resolve-packet (dismiss recommendation) → maintainer+", async () => {
    await assertMatchesMatrix("resolve-packet", (actor) =>
      dismissRecommendation(store.db, { projectSlug: store.slug, taskKey: "VIB-1", recId: "nope" }, actor, { dataRoot: store.dataRoot }),
    );
  });

  it("run-agents (assign specialist) → maintainer+", async () => {
    await assertMatchesMatrix("run-agents", (actor) =>
      assignSpecialist(store.db, { projectSlug: store.slug, taskKey: "VIB-1", profileId: "does-not-exist" }, actor, { dataRoot: store.dataRoot }),
    );
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
