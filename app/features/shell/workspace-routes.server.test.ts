import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

/**
 * Route-level tests for the phase-4 shell: real Requests against the actual
 * route module loaders/actions (auth gating, seeded board shape, create-task
 * RBAC, notification reads, theme persistence).
 */

let app: AppTestContext;
let seedIds: { arda: string; deniz: string; selin: string };

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  const arda = findUserByEmail(app.db, "arda@viberr.dev")!;
  const deniz = findUserByEmail(app.db, "deniz@viberr.dev")!;
  const selin = findUserByEmail(app.db, "selin@viberr.dev")!;
  seedIds = { arda: arda.id, deniz: deniz.id, selin: selin.id };
});
afterAll(() => app.cleanup());

async function loaderArgs(url: string, params: Record<string, string>, cookie?: string) {
  return {
    request: app.request(url, cookie ? { cookie } : {}),
    params,
    context: {},
  };
}

describe("auth gating", () => {
  it("home loader redirects signed-out users to /login", async () => {
    const { loader } = await import("~/routes/_index");
    const thrown = await loader(
      (await loaderArgs("/", {})) as never,
    ).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/login");
  });

  it("workspace layout loader redirects with returnTo", async () => {
    const { loader } = await import("~/routes/project");
    const thrown = await loader(
      (await loaderArgs("/projects/viberr-core/board", {
        slug: "viberr-core",
      })) as never,
    ).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe(
      "/login?returnTo=" + encodeURIComponent("/projects/viberr-core/board"),
    );
  });
});

describe("workspace layout loader (seeded)", () => {
  it("404s for an unknown project slug", async () => {
    const { loader } = await import("~/routes/project");
    const { cookie } = await app.cookieFor(seedIds.arda);
    const thrown = await loader(
      (await loaderArgs("/projects/nope", { slug: "nope" }, cookie)) as never,
    ).catch((e) => e);
    expect(thrown?.init?.status ?? thrown?.status).toBe(404);
  });

  it("returns the seeded board: 5 columns, VIB-142 in Review with its chips", async () => {
    const { loader } = await import("~/routes/project");
    const { cookie } = await app.cookieFor(seedIds.arda);
    const result = (await loader(
      (await loaderArgs("/projects/viberr-core", {
        slug: "viberr-core",
      }, cookie)) as never,
    )) as {
      board: {
        columns: {
          stage: { id: string; name: string };
          tasks: {
            key: string;
            urgent: boolean;
            displayReadiness: string;
            waiting: string;
            branch: string | null;
            pr: { number: number } | null;
            packet: unknown;
            owner: { kind: string; name?: string } | null;
            validation: string;
          }[];
        }[];
      };
      taskCount: number;
      reviewCount: number;
      violations: number;
      myRole: string | null;
      unread: number;
      notifications: unknown[];
    };

    expect(result.board.columns.map((c) => c.stage.id)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      "done",
    ]);
    expect(result.taskCount).toBe(10);
    expect(result.reviewCount).toBe(2);
    expect(result.violations).toBe(1); // seeded VIB-142 PAT-scope violation
    expect(result.myRole).toBe("admin");
    expect(result.notifications.length).toBe(10);

    const review = result.board.columns.find((c) => c.stage.id === "review")!;
    const vib142 = review.tasks.find((t) => t.key === "VIB-142")!;
    expect(vib142).toBeDefined();
    expect(vib142.urgent).toBe(true);
    expect(vib142.displayReadiness).toBe("input_required");
    expect(vib142.waiting).toBe("human");
    expect(vib142.branch).toBe("vib-142-attach-workspace");
    expect(vib142.pr?.number).toBe(318);
    expect(vib142.packet).not.toBeNull();
    expect(vib142.validation).toBe("changed");
    expect(vib142.owner?.kind).toBe("human");
    expect((vib142.owner as { name: string }).name).toBe("Arda Kaya");
  });
});

describe("home loader (seeded)", () => {
  it("lists the 3 seeded projects with real aggregates + Arda's pins", async () => {
    const { loader } = await import("~/routes/_index");
    const { cookie } = await app.cookieFor(seedIds.arda);
    const result = (await loader(
      (await loaderArgs("/", {}, cookie)) as never,
    )) as {
      projects: {
        slug: string;
        total: number;
        running: number;
        waiting: number;
        dist: Record<string, number>;
        stages: { id: string }[];
        members: unknown[];
      }[];
      prefs: { view: string; stars: Record<string, boolean> };
      unread: number;
      org: { users: { total: number; admins: number } };
    };

    expect(result.projects.map((p) => p.slug).sort()).toEqual([
      "billing-service",
      "deploy-pipeline",
      "viberr-core",
    ]);
    const core = result.projects.find((p) => p.slug === "viberr-core")!;
    expect(core.total).toBe(10);
    // R6-5: "runs active" counts REAL (non-simulated) in-flight runs only. The
    // seed's running runs are simulated demo dressing, so they must NOT show as
    // live agents on Home — Viberr Core reads "quiet" until a real agent runs.
    expect(core.running).toBe(0);
    expect(core.waiting).toBe(2); // open decision packets, project-wide
    expect(core.dist.review).toBe(2);
    expect(core.dist.done).toBe(2);
    expect(core.members.length).toBe(4);
    // Lightweight stub project carries its OWN 3-stage list (ruling 15).
    const billing = result.projects.find((p) => p.slug === "billing-service")!;
    expect(billing.stages.map((s) => s.id)).toEqual(["todo", "doing", "done"]);
    // Seeded pins mirror the mock's starred flags.
    expect(result.prefs.stars["viberr-core"]).toBe(true);
    expect(result.prefs.stars["deploy-pipeline"]).toBe(true);
    expect(result.unread).toBe(6);
    expect(result.org.users.admins).toBeGreaterThanOrEqual(1);
  });
});

describe("board create-task action", () => {
  async function postCreate(userId: string, title: string) {
    const { action } = await import("~/routes/project.board");
    const { cookie, sessionId } = await app.cookieFor(userId);
    const csrf = await app.csrfFor(sessionId);
    const body = new URLSearchParams({
      _csrf: csrf,
      intent: "create-task",
      title,
      goal: "",
      stage: "triage",
    });
    const request = app.request("/projects/viberr-core/board", {
      method: "POST",
      cookie,
      body,
    });
    return action({
      request,
      params: { slug: "viberr-core" },
      context: {},
    } as never);
  }

  it("member creates a task → file on disk + board card", async () => {
    const result = (await postCreate(
      seedIds.arda,
      "Route-level create task",
    )) as { ok: boolean; key: string; stageName: string };
    expect(result.ok).toBe(true);
    expect(result.key).toMatch(/^VIB-\d+$/);
    expect(result.stageName).toBe("Triage");

    const taskFile = path.join(
      app.dataRoot,
      "projects",
      "viberr-core",
      "tasks",
      result.key,
      "task.md",
    );
    expect(existsSync(taskFile)).toBe(true);

    const { getBoard } = await import(
      "~/server/projections/board-query.server"
    );
    const board = getBoard(app.db, "viberr-core")!;
    const triage = board.columns.find((c) => c.stage.id === "triage")!;
    const created = triage.tasks.find((t) => t.key === result.key)!;
    expect(created).toBeDefined();
    expect(created.readiness).toBe("input_required");
    expect(created.waiting).toBe("human");
    expect(created.goal).toBe("Goal to be refined at the triage quality gate.");
    expect(created.operator).toBeNull(); // triage tasks get no operator
  });

  it("non-member is denied (RBAC in the phase-3 mutation)", async () => {
    const result = (await postCreate(seedIds.deniz, "Should not exist")) as {
      data: { ok: boolean; error: string };
      init: { status: number };
    };
    expect(result.init?.status).toBe(403);
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toContain("Only project members");
  });
});

describe("notification read actions", () => {
  it("marks one read, then all read, idempotently", async () => {
    const { action } = await import("~/routes/notifications.read");
    const { countUnreadNotifications } = await import(
      "~/server/projections/notifications.server"
    );
    const { cookie, sessionId } = await app.cookieFor(seedIds.arda);
    const csrf = await app.csrfFor(sessionId);
    const before = countUnreadNotifications(app.db, seedIds.arda);
    expect(before).toBeGreaterThan(0);

    const post = (body: Record<string, string>) =>
      action({
        request: app.request("/notifications/read", {
          method: "POST",
          cookie,
          body: new URLSearchParams({ _csrf: csrf, ...body }),
        }),
        params: {},
        context: {},
      } as never);

    const one = (await post({ intent: "read", id: "n-142-packet" })) as {
      ok: boolean;
      changed: number;
    };
    expect(one).toEqual({ ok: true, changed: 1 });
    expect(countUnreadNotifications(app.db, seedIds.arda)).toBe(before - 1);

    // Idempotent re-mark.
    const again = (await post({ intent: "read", id: "n-142-packet" })) as {
      changed: number;
    };
    expect(again.changed).toBe(0);

    const all = (await post({ intent: "read-all" })) as { changed: number };
    expect(all.changed).toBe(before - 1);
    expect(countUnreadNotifications(app.db, seedIds.arda)).toBe(0);
  });
});

describe("theme action", () => {
  it("persists to the user row and re-issues the cookie", async () => {
    const { action } = await import("~/routes/prefs.theme");
    const { findUserById } = await import("~/server/auth/user-store.server");
    const { cookie, sessionId } = await app.cookieFor(seedIds.selin);
    const csrf = await app.csrfFor(sessionId);
    const result = (await action({
      request: app.request("/prefs/theme", {
        method: "POST",
        cookie,
        body: new URLSearchParams({ _csrf: csrf, theme: "dark" }),
      }),
      params: {},
      context: {},
    } as never)) as {
      data: { ok: boolean; theme: string };
      init: { headers: Record<string, string> };
    };
    expect(result.data).toEqual({ ok: true, theme: "dark" });
    expect(result.init.headers["Set-Cookie"]).toContain("viberr_theme=dark");
    expect(findUserById(app.db, seedIds.selin)?.theme).toBe("dark");
  });
});

describe("create-project action (home)", () => {
  // Projects are repo-bound (2026-07-17 ruling): creation requires a PAT
  // connection for the chosen owner, seeded here the way org settings would.
  // The bound PAT makes createProject probe the repo's default branch — stub
  // fetch so the suite stays offline.
  afterAll(() => vi.unstubAllGlobals());
  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ default_branch: "main" }), {
            status: 200,
          }),
      ),
    );
    const { createPat } = await import("~/server/secrets/pat-store.server");
    const pat = createPat(
      app.db,
      {
        userId: seedIds.arda,
        label: "connection · akin-ozer",
        token: "ghp_testtesttesttesttesttesttesttest0000",
      },
      { userId: seedIds.arda, label: "arda@viberr.dev" },
    );
    const now = new Date().toISOString();
    app.db
      .prepare(
        `INSERT INTO github_connections (id, owner, pat_id, is_default, repos_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?)`,
      )
      .run("akin-ozer", "akin-ozer", pat.id, now, now);
  });

  async function postCreateProject(name: string) {
    const { action } = await import("~/routes/_index");
    const { cookie, sessionId } = await app.cookieFor(seedIds.arda);
    const csrf = await app.csrfFor(sessionId);
    return action({
      request: app.request("/", {
        method: "POST",
        cookie,
        body: new URLSearchParams({
          _csrf: csrf,
          intent: "create-project",
          name,
          key: "PAY",
          owner: "akin-ozer",
          repoName: "payments-gateway",
          template: "light",
          policy: "strict",
        }),
      }),
      params: {},
      context: {},
    } as never);
  }

  it("writes project.md from the template and projects it", async () => {
    const result = (await postCreateProject("Payments Gateway")) as {
      ok: boolean;
      slug: string;
      key: string;
      storePath: string;
    };
    expect(result.ok).toBe(true);
    expect(result.slug).toBe("payments-gateway");
    expect(result.key).toBe("PAY");
    expect(
      existsSync(
        path.join(app.dataRoot, "projects", "payments-gateway", "project.md"),
      ),
    ).toBe(true);

    const { getProject } = await import(
      "~/server/projections/board-query.server"
    );
    const project = getProject(app.db, "payments-gateway")!;
    expect(project.name).toBe("Payments Gateway");
    expect(project.taskPrefix).toBe("PAY");
    expect(project.repo).toBe("akin-ozer/payments-gateway");
    // Lightweight template stages (ruling 15).
    expect(project.stages.map((s) => s.id)).toEqual(["todo", "doing", "done"]);
    expect(project.description).toBe(
      "Lightweight 3-stage workflow · strict human-gate policy.",
    );
  });

  it("rejects a duplicate slug with a conflict", async () => {
    const result = (await postCreateProject("Payments Gateway")) as {
      data: { ok: boolean; error: string };
      init: { status: number };
    };
    expect(result.init?.status).toBe(409);
    expect(result.data.error).toContain("already exists");
  });

  it("RBAC decision (pinned): any org MEMBER may create a project and is seeded its admin", async () => {
    // Deniz is a plain org member (not an org admin) — creation is self-serve,
    // no org-admin gate. This test pins the deliberate _index.tsx decision.
    const { action } = await import("~/routes/_index");
    const { cookie, sessionId } = await app.cookieFor(seedIds.deniz);
    const csrf = await app.csrfFor(sessionId);
    const result = (await action({
      request: app.request("/", {
        method: "POST",
        cookie,
        body: new URLSearchParams({
          _csrf: csrf,
          intent: "create-project",
          name: "Member Made",
          key: "MEM",
          owner: "akin-ozer",
          repoName: "member-made",
          template: "light",
          policy: "balanced",
        }),
      }),
      params: {},
      context: {},
    } as never)) as { ok: boolean; slug: string };
    expect(result.ok).toBe(true);
    expect(result.slug).toBe("member-made");

    // The creating member is seeded as the new project's admin.
    const row = app.db
      .prepare(
        `SELECT role FROM project_members WHERE project_slug = 'member-made' AND user_id = ?`,
      )
      .get(seedIds.deniz) as { role: string } | undefined;
    expect(row?.role).toBe("admin");
  });
});
