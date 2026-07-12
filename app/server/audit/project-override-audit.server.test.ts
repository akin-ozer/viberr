import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

/**
 * Cross-family regression for emergency project authority. These are real
 * route actions so the test covers the authorization result being carried
 * through task, runtime, GitHub, and projection services into recordAudit.
 */
let app: AppTestContext;
let ardaId: string;
let denizId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  denizId = findUserByEmail(app.db, "deniz@viberr.dev")!.id;

  // Deniz is intentionally not a Viberr Core member. Make only the org role
  // admin so every successful project mutation below must use the fallback.
  app.db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(denizId);
  const { configureRunServiceForTests } = await import(
    "~/server/runtimes/run-service.server"
  );
  configureRunServiceForTests();
});

afterAll(async () => {
  if (app) {
    const { listRunsForTaskRows } = await import(
      "~/server/runtimes/run-store.server"
    );
    const { interruptRun } = await import(
      "~/server/runtimes/run-service.server"
    );
    for (const key of ["VIB-151", "VIB-153"]) {
      for (const run of listRunsForTaskRows(app.db, "viberr-core", key)) {
        if (run.state === "queued" || run.state === "running") {
          try {
            interruptRun(
              app.db,
              { projectSlug: "viberr-core", taskKey: key, runId: run.id },
              {
                userId: denizId,
                label: "deniz@viberr.dev",
                orgRole: "admin",
              },
            );
          } catch {
            // A completion callback may have won the race; cleanup is best effort.
          }
        }
      }
    }
    // Let interruption completion callbacks drain before closing the DB.
    await new Promise((resolve) => setTimeout(resolve, 25));
    app.cleanup();
  }
});

async function formFor(userId: string, fields: Record<string, string>) {
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return {
    cookie,
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  };
}

function newestDetails(action: string, actorUserId: string): Record<string, unknown> {
  const row = app.db
    .prepare(
      `SELECT details_json FROM audit_events
       WHERE action = ? AND actor_user_id = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(action, actorUserId) as { details_json: string | null } | undefined;
  expect(row, `missing ${action} audit for ${actorUserId}`).toBeTruthy();
  return row?.details_json ? JSON.parse(row.details_json) : {};
}

async function postBoard(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.board");
  const form = await formFor(userId, fields);
  return action({
    request: app.request("/projects/viberr-core/board", {
      method: "POST",
      cookie: form.cookie,
      body: form.body,
    }),
    params: { slug: "viberr-core" },
    context: {},
  } as never);
}

async function postTask(
  userId: string,
  taskKey: string,
  fields: Record<string, string>,
) {
  const { action } = await import("~/routes/project.task");
  const form = await formFor(userId, fields);
  return action({
    request: app.request(`/projects/viberr-core/tasks/${taskKey}`, {
      method: "POST",
      cookie: form.cookie,
      body: form.body,
    }),
    params: { slug: "viberr-core", key: taskKey },
    context: {},
  } as never);
}

async function postGithub(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.github");
  const form = await formFor(userId, fields);
  return action({
    request: app.request("/projects/viberr-core/github", {
      method: "POST",
      cookie: form.cookie,
      body: form.body,
    }),
    params: { slug: "viberr-core" },
    context: {},
  } as never);
}

describe("organization-admin override audit propagation", () => {
  it("decorates every guarded mutation family and preserves explicit project-role shape", async () => {
    // Explicit project admin (also an org admin): project membership wins and
    // ordinary audit details remain free of emergency-override decoration.
    const { authorizeProjectAction } = await import("~/shared/rbac");
    expect(
      authorizeProjectAction("admin", "admin", "reorder-board").source,
    ).toBe("project_role");
    await postBoard(ardaId, {
      intent: "reorder",
      taskKey: "VIB-153",
      to: "impl",
      beforeKey: "",
    });
    expect(newestDetails("task.board.reordered", ardaId)).not.toHaveProperty(
      "authoritySource",
    );

    // Canonical task-action guard, including the previously unaudited
    // same-stage reorder mutation.
    await postBoard(denizId, {
      intent: "reorder",
      taskKey: "VIB-153",
      to: "impl",
      beforeKey: "",
    });
    expect(newestDetails("task.board.reordered", denizId)).toMatchObject({
      authoritySource: "org_admin_override",
    });

    // Specialist/reviewer runtime guard family.
    await postTask(denizId, "VIB-153", {
      intent: "assign-specialist",
      profileId: "developer",
    });
    expect(newestDetails("task.specialist.assigned", denizId)).toMatchObject({
      authoritySource: "org_admin_override",
    });

    // Manual operator launch route → runtime service audit.
    await postTask(denizId, "VIB-151", {
      intent: "run-operator",
      backend: "claude",
      autonomy: "supervised",
    });
    expect(newestDetails("runtime.run.started", denizId)).toMatchObject({
      authoritySource: "org_admin_override",
    });

    // GitHub route guard → credential validation service audit.
    await postGithub(denizId, { intent: "grant-scope" });
    expect(
      newestDetails("github.credential.revalidated", denizId),
    ).toMatchObject({ authoritySource: "org_admin_override" });

    // Route-level arbitrary-role guard → projection service audit.
    await postBoard(denizId, { intent: "rescan" });
    expect(newestDetails("projection.rescan", denizId)).toMatchObject({
      authoritySource: "org_admin_override",
    });

    // Mention runtime guard → resumed/fresh run audit. The human comment itself
    // is app-wide and intentionally does not claim emergency authority.
    await postTask(denizId, "VIB-153", {
      intent: "comment",
      text: "@codex verify the override audit propagation",
    });
    expect(newestDetails("runtime.run.started", denizId)).toMatchObject({
      authoritySource: "org_admin_override",
    });
    expect(newestDetails("task.comment", denizId)).not.toHaveProperty(
      "authoritySource",
    );
  });
});
