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
import { assertProjectAction } from "~/server/auth/project-authority.server";
import { updateProjectIdentity, inviteMember } from "~/features/project-settings/settings-actions.server";
import { setMemberRole } from "~/features/policy/policy-actions.server";
import { insertUser } from "~/server/auth/user-store.server";
import { isAppError } from "~/server/errors/app-error.server";
import { ROLE_RANK, rolesForAction, type ProjectRole, type RbacAction } from "~/shared/rbac";
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
    passwordHash: null,
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
      "update-goal", "grant-github-scope", "rescan-project",
      "release-any-ownership", "manage-members", "manage-agents", "edit-policy",
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

  it("the any-member route READ gate admits an org-admin non-member (override flag) but does NOT audit", () => {
    // The `any-member` gate is the config-surface route READ (Policy/Settings/
    // Agents/GitHub loaders); an org-admin non-member opens those constantly, so
    // auditing an override there would write a row per page load (the F7 audit-
    // noise fix). The override flag is still set so the UI shows the honest
    // override pill — only the audit is suppressed for reads. Every genuine
    // governed MUTATION names a concrete RbacAction and IS audited (below).
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
    expect(overrideRows()).toHaveLength(0);
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
