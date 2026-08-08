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
  transitionStage,
  updateTaskGoal,
  reorderTask,
  dismissRecommendation,
  applyRecommendation,
  forceAcceptCompletion,
} from "~/server/tasks/task-actions.server";
import {
  assignSpecialist,
} from "~/server/tasks/specialist-run.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { updateProjectIdentity, inviteMember } from "~/features/project-settings/settings-actions.server";
import { createAgentProfile } from "~/features/agents/agent-profile-actions.server";
import { setMemberRole } from "~/features/policy/policy-actions.server";
import { insertUser } from "~/server/auth/user-store.server";
import { isAppError } from "~/server/errors/app-error.server";
import { ROLE_RANK, RBAC_DEFINITIONS,
  rolesForAction, type ProjectRole, type RbacAction } from "~/shared/rbac";
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
 * Pass-7 (R7-1 / D2): every guard is ALSO driven as an ORG-admin who is NOT a
 * project member — the emergency override must grant project-admin authority
 * AND leave a `project.org_admin.override` audit row on every use, while a
 * plain org member who is a non-member stays denied.
 */

const OVERRIDE_AUDIT_ACTION = "project.org_admin.override";

let ctx: TestDbContext;
let store: TestStore;
let orgAdmin: { id: string; email: string };

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
  } as Record<ProjectRole, { id: string; email: string }>;
}

/**
 * For a canonical action, assert every role's guard outcome matches
 * `rolesForAction(action)`, that a non-member is always denied, and that an
 * ORG-admin non-member is always ALLOWED via the audited D2 override.
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
  // Non-member (deniz, org role: member) is never in any ACTION_ROLES set →
  // always denied.
  reset?.();
  const nm = await guardAllowed(() => run(actorOf(store.users.deniz)));
  expect(nm, `non-member on action "${action}" must be denied`).toBe(false);
  // ORG-admin non-member → ALLOWED as the D2 emergency override, and EVERY use
  // writes a `project.org_admin.override` audit row naming the action.
  reset?.();
  const before = listAuditEvents(store.db, { action: OVERRIDE_AUDIT_ACTION }).length;
  const oa = await guardAllowed(() => run(actorOf(orgAdmin)));
  expect(
    oa,
    `org-admin non-member on action "${action}" must be ALLOWED (D2 override)`,
  ).toBe(true);
  const rows = listAuditEvents(store.db, { action: OVERRIDE_AUDIT_ACTION });
  expect(
    rows.length,
    `org-admin override on "${action}" must record an audit row`,
  ).toBeGreaterThan(before);
  expect(rows[0]!.details?.action).toBe(action);
  expect(rows[0]!.details?.projectSlug).toBe(store.slug);
  expect(rows[0]!.projectSlug).toBe(store.slug);
  expect(rows[0]!.actorUserId).toBe(orgAdmin.id);
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
function resetTaskOwner(ownerUserId: string) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      title: "RBAC binding probe",
      ownerUserId,
    }),
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
      const holders = (["viewer", "contributor", "maintainer", "admin"] as ProjectRole[])
        .filter((r) => ROLE_RANK[r] >= floor);
      expect(new Set(rolesForAction(a)), `action ${a} must be a rank floor`).toEqual(
        new Set(holders),
      );
    }
  });

  it("force-accept-completion → admin ONLY (the audited escape hatch)", async () => {
    // P13: the narrowest grant in the matrix had no enforcement test at all,
    // even though it deliberately bypasses the review gate (DG-2).
    await assertMatchesMatrix("force-accept-completion", (actor) =>
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor,
        { dataRoot: store.dataRoot },
      ),
    );
  });

  it("create-task → contributor+ (viewer + non-member denied)", async () => {
    let n = 0;
    await assertMatchesMatrix("create-task", (actor) =>
      createTask(store.db, { projectSlug: store.slug, title: `Probe ${n++}` , goal: "a valid goal for the probe" }, actor, { dataRoot: store.dataRoot }),
    );
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

  it("resolve-packet (apply recommendation) → maintainer+, authorized BEFORE the task read (F20)", async () => {
    // A bogus recId only reaches the notFound/conflict read AFTER the guard, so
    // the matrix outcome is a clean read of the guard: viewers/non-members are
    // denied with 403 up front (no task/recommendation existence leak), while
    // maintainer+ pass the guard and fail downstream (non-403) — exactly the
    // dismiss symmetry F20 restores.
    await assertMatchesMatrix("resolve-packet", (actor) =>
      applyRecommendation(store.db, { projectSlug: store.slug, taskKey: "VIB-1", recId: "nope" }, actor, { dataRoot: store.dataRoot }),
    );
  });

  it("run-agents (assign specialist) → maintainer+", async () => {
    await assertMatchesMatrix("run-agents", (actor) =>
      assignSpecialist(store.db, { projectSlug: store.slug, taskKey: "VIB-1", profileId: "does-not-exist" }, actor, { dataRoot: store.dataRoot }),
    );
  });

  it("rescan-project (board re-scan) → maintainer+ (action id, not a hardcoded role list)", async () => {
    await assertMatchesMatrix("rescan-project", async (actor) =>
      assertProjectAction(store.db, "rescan-project", store.slug, actor, "re-scan the project", { dataRoot: store.dataRoot }),
    );
  });

  it("reconcile-github → maintainer+ (R8-4: aligned with rescan-project, was contributor+)", async () => {
    await assertMatchesMatrix("reconcile-github", async (actor) =>
      assertProjectAction(store.db, "reconcile-github", store.slug, actor, "reconcile with GitHub", { dataRoot: store.dataRoot }),
    );
  });

  // ---------------------------------------------------------------------
  // E7: the six ROLE-GATED actions the matrix declared but no driver drove.
  // Every one of them was reachable only through the org-admin override test
  // (four of them) or not at all, so `ACTION_ROLES` could have named any tier
  // for them and nothing would have failed.
  // ---------------------------------------------------------------------

  it("accept-completion → maintainer+ (completeTaskMerge shares the acceptance gate)", async () => {
    // VIB-1 has no owner, so the R6-2 owner exception cannot mask the tier, and
    // no PR, so maintainer+ pass the guard and fail downstream (non-403).
    await assertMatchesMatrix("accept-completion", (actor) =>
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor,
        { dataRoot: store.dataRoot },
      ),
    );
  });

  it("accept-completion: the task's CONTRIBUTOR owner passes the same gate (R6-2)", async () => {
    // The exception the review queue promises when it puts a contributor-owned
    // task under "Waiting on your acceptance" — asserted against the guard, not
    // just against the queue's own predicate.
    resetTaskOwner(store.users.selin.id);
    const owner = await guardAllowed(() =>
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    );
    expect(owner, "a contributor OWNER may accept their own task").toBe(true);
    // …and a contributor who does NOT own it is still denied.
    const other = await guardAllowed(() =>
      completeTaskMerge(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.deniz),
        { dataRoot: store.dataRoot },
      ),
    );
    expect(other).toBe(false);
  });

  it("grant-github-scope → maintainer+", async () => {
    await assertMatchesMatrix("grant-github-scope", async (actor) =>
      assertProjectAction(
        store.db,
        "grant-github-scope",
        store.slug,
        actor,
        "change the credential",
        { dataRoot: store.dataRoot },
      ),
    );
  });

  it("release-any-ownership → admin ONLY (releasing SOMEONE ELSE's seat)", async () => {
    // The owner is deniz — a former member who kept the seat. That makes the
    // release FOREIGN for all four roles (so the own-task path can't stand in),
    // while deniz's own attempt is a self-release that still needs `own-task`,
    // which a non-member does not hold. Re-seated before each actor because a
    // successful release clears the seat and the next attempt would take the
    // idempotent "nothing to release" branch, which only needs membership.
    await assertMatchesMatrix(
      "release-any-ownership",
      (actor) =>
        releaseOwner(store.db, { projectSlug: store.slug, taskKey: "VIB-1" }, actor, {
          dataRoot: store.dataRoot,
        }),
      () => resetTaskOwner(store.users.deniz.id),
    );
  });

  it("manage-members → admin ONLY", async () => {
    let n = 0;
    await assertMatchesMatrix("manage-members", (actor) =>
      inviteMember(
        store.db,
        {
          projectSlug: store.slug,
          name: `Invitee ${n}`,
          email: `invitee-${n++}@viberr.test`,
        },
        actor,
        { dataRoot: store.dataRoot },
      ),
    );
  });

  it("manage-agents → admin ONLY", async () => {
    // An empty form only reaches its validation error AFTER the guard, so the
    // matrix reads the guard cleanly (403 = denied, validation = allowed).
    await assertMatchesMatrix("manage-agents", (actor) =>
      createAgentProfile(store.db, { projectSlug: store.slug, form: {} }, actor, {
        dataRoot: store.dataRoot,
      }),
    );
  });

  it("edit-policy → admin ONLY", async () => {
    await assertMatchesMatrix("edit-policy", (actor) =>
      updateProjectIdentity(
        store.db,
        {
          projectSlug: store.slug,
          name: "Viberr Core",
          prefix: "VIB",
          description: "Edited by the matrix driver.",
        },
        actor,
        { dataRoot: store.dataRoot },
      ),
    );
  });

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
 * tier narrows, and they had no per-role driver at all. That is exactly why the
 * Policy page could go on rendering them as "any signed-in user · membership not
 * required" long after R15-4 made projects members-only: nothing drove the
 * question. These cases pin what the live HTTP probe found — a viewer reads and
 * comments (200/200), a non-member gets 404 on both, and the comment a
 * non-member tried to write is never in the file.
 */
describe("view + comment are enforced as MEMBERSHIP, not as a role tier", () => {
  /** Run and return what was thrown (or undefined). */
  async function caught(fn: () => unknown): Promise<unknown> {
    try {
      await fn();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  /**
   * The membership gate itself. `requireVisibleProject` (the route wrapper)
   * calls exactly this and re-clothes its refusal as the unknown-slug 404; that
   * conversion is asserted at the route level in
   * app/routes/project-visibility.server.test.ts and
   * app/routes/project.board.server.test.ts. Here we drive the gate, which is
   * where the per-role answer is actually decided — and which needs the test
   * store's dataRoot, so the route wrapper cannot be called from this suite.
   */
  function visibilityGate(user: { id: string; email: string }) {
    return assertProjectAction(
      store.db,
      "any-member",
      store.slug,
      actorOf(user),
      "act on this project",
      { dataRoot: store.dataRoot, allowArchived: true },
    );
  }

  /** The composition every project-scoped action uses: visibility, then work. */
  async function commentAs(
    user: { id: string; email: string },
    text: string,
  ): Promise<unknown> {
    visibilityGate(user);
    return appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text },
      actorOf(user),
      { dataRoot: store.dataRoot },
    );
  }

  function commentTexts(): string[] {
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    return file.parsed.timeline
      .filter((e) => e.type === "comment")
      .map((e) => e.text);
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
    for (const role of Object.keys(byRole) as ProjectRole[]) {
      const grant = visibilityGate(byRole[role]);
      expect(grant.role, `role "${role}" must be able to open the project`).toBe(role);
      expect(grant.isOrgAdminOverride).toBe(false);
    }
    const refusal = (await caught(() => visibilityGate(store.users.deniz))) as {
      status?: number;
    };
    expect(isAppError(refusal)).toBe(true);
    expect(refusal.status).toBe(403); // the ROUTE turns this into the 404
    // The D2 override reaches reads too (no audit row — it is a read gate).
    const override = visibilityGate(orgAdmin);
    expect(override.role).toBe("admin");
    expect(override.isOrgAdminOverride).toBe(true);
  });

  it("a VIEWER may comment; a non-member's comment is refused before a byte is written", async () => {
    expect(await caught(() => commentAs(store.users.elif, "Viewer says hello"))).toBeUndefined();
    expect(commentTexts()).toContain("Viewer says hello");

    const refusal = (await caught(() =>
      commentAs(store.users.deniz, "Non-member says hello"),
    )) as { status?: number };
    expect(isAppError(refusal)).toBe(true);
    expect(refusal.status).toBe(403); // → the route's unknown-slug 404
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
   * governance decision, so it should never move as a side effect of a refactor.
   */
  const EXPECTED_TIERS: Record<RbacAction, ProjectRole[]> = {
    view: ["admin", "maintainer", "contributor", "viewer"],
    comment: ["admin", "maintainer", "contributor", "viewer"],
    "create-task": ["admin", "maintainer", "contributor"],
    "own-task": ["admin", "maintainer", "contributor"],
    "approve-transition": ["admin", "maintainer"],
    "resolve-packet": ["admin", "maintainer"],
    "accept-completion": ["admin", "maintainer"],
    "update-goal": ["admin", "maintainer"],
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
  };

  it("every action holds exactly the roles governance assigned it", () => {
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
