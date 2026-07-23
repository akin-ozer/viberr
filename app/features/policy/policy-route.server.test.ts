import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { PolicyViewData } from "./policy-query.server";
import { RBAC_ROWS, ROLE_IDS } from "./policy-data";

/**
 * Route-level tests for /projects/:slug/policy: loader read model from the
 * seeded store, the 9-row RBAC grant table (contracts §3.2 verbatim), role
 * change round trip (project.md + project_members + audit), the last-admin
 * guard, boundary changes with the review→done human lock, and RBAC
 * denials for non-admins.
 */

let app: AppTestContext;
let ids: { arda: string; elif: string; murat: string; selin: string };

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // project admin
    elif: findUserByEmail(app.db, "elif@viberr.dev")!.id, // project admin
    murat: findUserByEmail(app.db, "murat@viberr.dev")!.id, // maintainer
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // contributor
  };
});
afterAll(() => app.cleanup());

async function runLoader(userId: string): Promise<{ view: PolicyViewData }> {
  const { loader } = await import("~/routes/project.policy");
  const { cookie } = await app.cookieFor(userId);
  return (await loader({
    request: app.request("/projects/viberr-core/policy", { cookie }),
    params: { slug: "viberr-core" },
    context: {},
  } as never)) as { view: PolicyViewData };
}

async function postAction(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.policy");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ ...fields, _csrf: csrf });
  const request = app.request("/projects/viberr-core/policy", {
    method: "POST",
    cookie,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return action({ request, params: { slug: "viberr-core" }, context: {} } as never);
}

describe("RBAC grant table (derived from PROJECT_CAP_MATRIX)", () => {
  it("carries the canonical rows in broadest→narrowest order", () => {
    expect(RBAC_ROWS.map((r) => r.action)).toEqual([
      "View board, tasks & timelines",
      "Comment on tasks",
      "Create tasks",
      "Take / release own task ownership",
      "Approve stage transitions",
      "Resolve decision packets",
      "Accept completion → Done",
      "Edit the task goal",
      "Run agents",
      "Reorder the board",
      "Reconcile GitHub state",
      "Grant GitHub scope",
      "Re-scan project files & projections",
      "Release any task owner",
      "Manage members & roles",
      "Manage agent profiles",
      "Edit workflow & policy",
    ]);
    expect(ROLE_IDS).toEqual(["admin", "maintainer", "contributor", "viewer"]);
    // Admin holds everything. Q5 clean tiering: a viewer is strictly read +
    // comment; the contributor tier adds "Create tasks" AND task ownership.
    // R8-4: reconcile-github is now maintainer+ (was contributor+).
    expect(RBAC_ROWS.every((r) => r.grant.admin === 1)).toBe(true);
    // view/comment are app-wide (informational role columns); the table row
    // renders them as "any signed-in user".
    expect(RBAC_ROWS.filter((r) => r.appWide).map((r) => r.action)).toEqual([
      "View board, tasks & timelines",
      "Comment on tasks",
    ]);
    expect(RBAC_ROWS.map((r) => r.grant.viewer)).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(RBAC_ROWS.map((r) => r.grant.contributor)).toEqual([
      1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(RBAC_ROWS.map((r) => r.grant.maintainer)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0,
    ]);
  });
});

describe("loader", () => {
  it("returns members, transitions, stages and the shared roster", async () => {
    const { view } = await runLoader(ids.arda);
    expect(view.projectName).toBe("Viberr Core");
    expect(view.members.map((m) => [m.userId, m.role])).toEqual([
      [ids.elif, "admin"],
      [ids.arda, "admin"],
      [ids.murat, "maintainer"],
      [ids.selin, "contributor"],
    ]);
    expect(view.transitions.map((t) => [t.from, t.to, t.boundary, t.locked])).toEqual([
      ["triage", "ready", "auto", false],
      ["ready", "impl", "auto", false],
      ["impl", "review", "approval", false],
      ["review", "done", "human", true],
    ]);
    // Profile roster is the SAME assembly the Agents surface renders.
    expect(view.profiles.map((p) => p.id)).toEqual([
      "operator",
      "developer",
      "reviewer",
    ]);
    // Fresh seed: no policy-change audit yet → the chip hides.
    expect(view.edited).toBeNull();
  });
});

describe("set-role", () => {
  it("rejects a maintainer (Manage members & roles is admin-only)", async () => {
    const result = (await postAction(ids.murat, {
      intent: "set-role",
      userId: ids.selin,
      role: "viewer",
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });

  it("round trip: project.md → projection → audit → toast, chip appears", async () => {
    const result = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.selin,
      role: "viewer",
    })) as { ok: boolean; toast: string };
    expect(result).toEqual({
      ok: true,
      toast: "Selin is now Viewer · enforced on the next action",
    });

    // Canonical file updated…
    const file = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    expect(file).toMatch(new RegExp(`userId: ${ids.selin}\\s*\\n\\s*role: viewer`));
    // …projection follows…
    const row = app.db
      .prepare(
        `SELECT role FROM project_members WHERE project_slug = 'viberr-core' AND user_id = ?`,
      )
      .get(ids.selin) as { role: string };
    expect(row.role).toBe("viewer");
    // …audit row written…
    const audit = listAuditEvents(app.db, {
      action: "project.member.role_changed",
    });
    expect(audit[0]).toMatchObject({
      actorUserId: ids.arda,
      subjectId: ids.selin,
      projectSlug: "viberr-core",
      details: { from: "contributor", to: "viewer" },
    });
    // …and the last-change chip now derives from it.
    const { view } = await runLoader(ids.arda);
    expect(view.edited).toEqual({ by: "Arda Kaya", t: "Today" });

    // Restore.
    await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.selin,
      role: "contributor",
    });
  });

  it("last-admin guard: demoting the only admin is blocked server-side", async () => {
    // Two seeded admins — demote elif first (allowed, arda remains).
    const demoteElif = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.elif,
      role: "maintainer",
    })) as { ok: boolean };
    expect(demoteElif.ok).toBe(true);

    // Now arda is the only admin — self-demotion must be refused.
    const demoteArda = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.arda,
      role: "viewer",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(demoteArda.init?.status).toBe(409);
    expect(demoteArda.data?.error).toBe(
      "Viberr Core needs at least one admin — promote someone else first",
    );

    // Restore elif.
    const restore = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.elif,
      role: "admin",
    })) as { ok: boolean };
    expect(restore.ok).toBe(true);
  });
});

describe("set-boundary", () => {
  it("rejects a reviewer (Edit workflow & policy is admin-only)", async () => {
    const result = (await postAction(ids.selin, {
      intent: "set-boundary",
      from: "impl",
      to: "review",
      boundary: "auto",
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });

  it("persists a boundary change with the verbatim toast + audit", async () => {
    const result = (await postAction(ids.arda, {
      intent: "set-boundary",
      from: "impl",
      to: "review",
      boundary: "auto",
    })) as { ok: boolean; toast: string };
    expect(result).toEqual({
      ok: true,
      toast: "In Progress → Review: auto-advance · applies to future transitions",
    });
    const { view } = await runLoader(ids.arda);
    expect(
      view.transitions.find((t) => t.from === "impl" && t.to === "review")!
        .boundary,
    ).toBe("auto");
    const audit = listAuditEvents(app.db, {
      action: "project.policy.boundary_changed",
    });
    expect(audit[0]).toMatchObject({
      details: { from: "impl", to: "review", boundary: "auto" },
    });

    // Restore.
    await postAction(ids.arda, {
      intent: "set-boundary",
      from: "impl",
      to: "review",
      boundary: "approval",
    });
  });

  it("review→done stays LOCKED human — server hard-reject", async () => {
    const result = (await postAction(ids.arda, {
      intent: "set-boundary",
      from: "review",
      to: "done",
      boundary: "auto",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(result.init?.status).toBe(403);
    expect(result.data?.error).toBe(
      "Completion is human-authorized in V1 — this boundary can't be delegated",
    );
    const { view } = await runLoader(ids.arda);
    expect(
      view.transitions.find((t) => t.from === "review" && t.to === "done")!
        .boundary,
    ).toBe("human");
  });
});
