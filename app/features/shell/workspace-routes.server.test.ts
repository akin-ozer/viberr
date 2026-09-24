import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { RouterContextProvider } from "react-router";
import { z } from "zod";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";

/**
 * Route-level tests for the phase-4 shell: real Requests against the actual
 * route module loaders/actions (auth gating, seeded board shape, create-task
 * RBAC, notification reads, theme persistence).
 */

let app: AppTestContext;
/** The seeded people this file drives the shell routes as. */
let seedIds: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  seedIds = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
});
afterAll(() => app.cleanup());

/** Un-interpolated match patterns, the way React Router reports them. */
const HOME_PATTERN = "/";
const PROJECT_PATTERN = "/projects/:slug";

/**
 * A server loader/action is handed the request, the match pattern, the dynamic
 * params and a middleware context. Building the whole envelope rather than a
 * partial stand-in is what keeps the direct calls below type-checked against
 * the real route signatures.
 */
function loaderArgs<Params extends Record<string, string>>(
  url: string,
  pattern: string,
  params: Params,
  cookie?: string,
) {
  const request = app.request(url, cookie ? { cookie } : {});
  return {
    request,
    url: new URL(request.url),
    params,
    pattern,
    context: new RouterContextProvider(),
  };
}

type RouteActionResult = Awaited<
  ReturnType<
    | typeof import("~/routes/_index").action
    | typeof import("~/routes/notifications.read").action
    | typeof import("~/routes/prefs.theme").action
    | typeof import("~/routes/project.board").action
  >
>;

/**
 * An action answers on one of two envelopes: a bare success object, or
 * `data(payload, init)`. A test that reads a single member has to say which
 * envelope it expects, so read it through this projection — a member the
 * actual branch does not carry comes back `undefined` and fails its
 * assertion, rather than being asserted into existence.
 */
function actionOutcome(result: RouteActionResult) {
  return {
    ok: "ok" in result ? result.ok : undefined,
    key: "key" in result ? result.key : undefined,
    slug: "slug" in result ? result.slug : undefined,
    stageName: "stageName" in result ? result.stageName : undefined,
    changed: "changed" in result ? result.changed : undefined,
    payload: "data" in result ? result.data : undefined,
    error:
      "data" in result && "error" in result.data ? result.data.error : undefined,
    status: "init" in result ? result.init?.status : undefined,
    headers: "init" in result ? new Headers(result.init?.headers) : undefined,
  };
}

/**
 * A guard refuses by THROWING React Router's `data(message, { status })`, so
 * the rejection reaches the test untyped and is parsed where it lands.
 */
const thrownRefusalSchema = z.object({
  data: z.unknown(),
  init: z.object({ status: z.number() }).nullish(),
});

/** `.get()` hands back untyped SQLite cells, so the row is parsed on read. */
const memberRoleRowSchema = z.object({ role: z.string() }).optional();

describe("auth gating", () => {
  it("home loader redirects signed-out users to /login", async () => {
    const { loader } = await import("~/routes/_index");
    const thrown: unknown = await loader(
      loaderArgs("/", HOME_PATTERN, {}),
    ).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    const redirected = thrown instanceof Response ? thrown : null;
    expect(redirected?.status).toBe(302);
    expect(redirected?.headers.get("Location")).toBe("/login");
  });

  it("workspace layout loader redirects with returnTo", async () => {
    const { loader } = await import("~/routes/project");
    const thrown: unknown = await loader(
      loaderArgs("/projects/viberr-core/board", PROJECT_PATTERN, {
        slug: "viberr-core",
      }),
    ).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    const redirected = thrown instanceof Response ? thrown : null;
    expect(redirected?.status).toBe(302);
    expect(redirected?.headers.get("Location")).toBe(
      "/login?returnTo=" + encodeURIComponent("/projects/viberr-core/board"),
    );
  });
});

describe("workspace layout loader (seeded)", () => {
  it("404s for an unknown project slug", async () => {
    const { loader } = await import("~/routes/project");
    const { cookie } = await app.cookieFor(seedIds.arda);
    const thrown = await loader(
      loaderArgs("/projects/nope", PROJECT_PATTERN, { slug: "nope" }, cookie),
    ).catch((e) => e);
    expect(thrown?.init?.status ?? thrown?.status).toBe(404);
  });

  // R15-4: projects are members-only. The layout loader is the chokepoint for
  // EVERY project surface (board + task detail + the six config views are its
  // children), and the refusal must be indistinguishable from an unknown slug.
  describe("R15-4 members-only", () => {
    it("a project MEMBER sees the board", async () => {
      const { loader } = await import("~/routes/project");
      const { cookie } = await app.cookieFor(seedIds.selin); // contributor
      const result = await loader(
        loaderArgs(
          "/projects/viberr-core/board",
          PROJECT_PATTERN,
          { slug: "viberr-core" },
          cookie,
        ),
      );
      expect(result.myRole).toBe("contributor");
      expect(result.orgAdminOverride).toBe(false);
    });

    it("a non-member org member gets the unknown-slug 404, not a 403", async () => {
      const { loader } = await import("~/routes/project");
      // deniz is an org MEMBER with no membership on any seeded project.
      const { cookie } = await app.cookieFor(seedIds.deniz);
      const thrown = await loader(
        loaderArgs(
          "/projects/viberr-core/board",
          PROJECT_PATTERN,
          { slug: "viberr-core" },
          cookie,
        ),
      ).catch((e) => e);
      expect(thrown?.init?.status ?? thrown?.status).toBe(404);
      // Byte-identical to the unknown-slug refusal — the response must not
      // confirm that `viberr-core` exists (WI-13).
      const unknown = await loader(
        loaderArgs("/projects/nope", PROJECT_PATTERN, { slug: "nope" }, cookie),
      ).catch((e) => e);
      expect(String(thrown?.data ?? thrown)).toBe(
        String(unknown?.data ?? unknown).replace("nope", "viberr-core"),
      );
    });

    it("ruling 457: the board's own loader refuses a non-member the same way", async () => {
      // Single fetch honors `?_routes=`, so the board loader can run without
      // the layout's (F19-28): it carries the layout's refusal, byte for byte.
      const { loader } = await import("~/routes/project.board");
      const { cookie } = await app.cookieFor(seedIds.deniz);
      const thrown = await loader(
        loaderArgs(
          "/projects/viberr-core/board.data?_routes=routes/project.board",
          `${PROJECT_PATTERN}/board`,
          { slug: "viberr-core" },
          cookie,
        ),
      ).catch((e) => e);
      expect(thrown?.init?.status ?? thrown?.status).toBe(404);
      expect(String(thrown?.data ?? thrown)).toBe("No project at projects/viberr-core.");
    });

    it("the task-detail surface is refused too (the layout gate covers children)", async () => {
      const { loader } = await import("~/routes/project");
      const { cookie } = await app.cookieFor(seedIds.deniz);
      const thrown = await loader(
        loaderArgs(
          "/projects/viberr-core/tasks/VIB-142",
          PROJECT_PATTERN,
          { slug: "viberr-core" },
          cookie,
        ),
      ).catch((e) => e);
      expect(thrown?.init?.status ?? thrown?.status).toBe(404);
    });

    /**
     * F19-28: the layout loader is the chokepoint only when it RUNS. Single
     * fetch honors a client-supplied `?_routes=` filter, so
     * `GET /projects/<slug>/policy.data?_routes=routes/project.policy` executes
     * the CHILD loader alone — the layout's 404 never fires. Six config-surface
     * loaders answered that request with `requireProjectMember`'s 403 ("Only
     * project members can view this project's policy"), a project-existence
     * oracle: 403 = exists, 404 = does not. This drives each child loader in
     * isolation (exactly what the `?_routes=` request does) and pins that a
     * non-member and an unknown slug are indistinguishable.
     */
    const CHILD_SURFACES = [
      { mod: "~/routes/project.activity", path: "activity" },
      { mod: "~/routes/project.review", path: "review" },
      { mod: "~/routes/project.agents", path: "agents" },
      { mod: "~/routes/project.policy", path: "policy" },
      { mod: "~/routes/project.github", path: "github" },
      { mod: "~/routes/project.settings", path: "settings" },
    ] as const;

    /**
     * The six specifiers above are the only modules `childLoader` imports, so
     * their union is the honest type for the dynamic import — and the six
     * loaders share one args envelope.
     */
    type ChildRouteModule =
      | typeof import("~/routes/project.activity")
      | typeof import("~/routes/project.agents")
      | typeof import("~/routes/project.github")
      | typeof import("~/routes/project.policy")
      | typeof import("~/routes/project.review")
      | typeof import("~/routes/project.settings");

    /**
     * A child loader refuses by throwing React Router's
     * `data(message, { status })`; a plain Response carries the status itself.
     * Anything else (or a loader that resolved) reads as no refusal at all.
     */
    const childRefusalSchema = z.object({
      data: z.unknown(),
      init: z.object({ status: z.number() }).nullish(),
      status: z.number().optional(),
    });

    /** Run ONE child loader the way single fetch's `?_routes=` filter does. */
    async function childLoader(
      surface: (typeof CHILD_SURFACES)[number],
      slug: string,
      cookie: string,
    ): Promise<{ status: number; body: string }> {
      // `surface.mod` is one of the six literals above, so the module is typed
      // as their union rather than left untyped by the dynamic specifier.
      const routeModule: ChildRouteModule = await import(
        /* @vite-ignore */ surface.mod
      );
      const url =
        `/projects/${slug}/${surface.path}.data` +
        `?_routes=routes/project.${surface.path}`;
      const pattern = `${PROJECT_PATTERN}/${surface.path}`;
      const settled: unknown = await routeModule
        .loader(loaderArgs(url, pattern, { slug }, cookie))
        .then(
          () => null,
          (e) => e,
        );
      const refusal = childRefusalSchema.nullable().catch(null).parse(settled);
      return {
        status: refusal?.init?.status ?? refusal?.status ?? 200,
        body: String(refusal?.data ?? ""),
      };
    }

    for (const surface of CHILD_SURFACES) {
      it(`${surface.path}: the single-fetch child loader answers a non-member as an unknown slug`, async () => {
        const { cookie } = await app.cookieFor(seedIds.deniz);
        const nonMember = await childLoader(surface, "viberr-core", cookie);
        const unknown = await childLoader(surface, "nope", cookie);

        expect(nonMember.status).toBe(404);
        expect(unknown.status).toBe(404);
        // Byte-identical once the slug itself is normalized — the reply must
        // not confirm that `viberr-core` exists.
        expect(nonMember.body).toBe(unknown.body.replace("nope", "viberr-core"));
        // …and identical to the LAYOUT loader's refusal, so switching surfaces
        // cannot be used as the oracle either.
        expect(nonMember.body).toBe("No project at projects/viberr-core.");
        expect(nonMember.body).not.toMatch(/member/i);
      });
    }

    it("a project member still reaches each child loader", async () => {
      const { cookie } = await app.cookieFor(seedIds.selin); // contributor
      for (const surface of CHILD_SURFACES) {
        const res = await childLoader(surface, "viberr-core", cookie);
        expect(res.status, `${surface.path} must serve a member`).toBe(200);
      }
    });

    it("an ORG ADMIN who is not a member keeps access, with the override pill", async () => {
      const { loader } = await import("~/routes/project");
      const { updateUserFields } = await import("~/server/auth/user-store.server");
      updateUserFields(app.db, seedIds.deniz, { role: "admin" });
      try {
        const { cookie } = await app.cookieFor(seedIds.deniz);
        const result = await loader(
          loaderArgs(
            "/projects/viberr-core/board",
            PROJECT_PATTERN,
            { slug: "viberr-core" },
            cookie,
          ),
        );
        expect(result.myRole).toBe("admin");
        expect(result.orgAdminOverride).toBe(true);
      } finally {
        updateUserFields(app.db, seedIds.deniz, { role: "member" });
      }
    });
  });

  it("returns the seeded board: 5 columns, VIB-142 in Review with its chips", async () => {
    const [{ loader }, { loader: boardLoader }] = await Promise.all([
      import("~/routes/project"),
      import("~/routes/project.board"),
    ]);
    const { cookie } = await app.cookieFor(seedIds.arda);
    // One board request: the layout and the board's own loader (ruling 457,
    // BOARD-6) on one Request.
    const args = loaderArgs(
      "/projects/viberr-core/board",
      `${PROJECT_PATTERN}/board`,
      { slug: "viberr-core" },
      cookie,
    );
    const [result, board] = await Promise.all([loader(args), boardLoader(args)]);

    // The shell's slice: no columns ride the layout any more.
    expect(result).not.toHaveProperty("board");
    expect(result.project).toEqual({
      slug: "viberr-core",
      name: expect.any(String),
      repo: expect.any(String),
      archived: false,
    });
    expect(board.columns.map((c) => c.stage.id)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      "done",
    ]);
    expect(result.taskCount).toBe(10);
    // U35-5 (pass 35): the badge is the review queue's own `total`, and the
    // queue lists review work wherever it sits: VIB-142 and VIB-145 at Review,
    // plus VIB-160 at In Progress with changes requested by its reviewer.
    expect(result.reviewCount).toBe(3);
    expect(result.violations).toBe(1); // seeded VIB-142 PAT-scope violation
    expect(result.myRole).toBe("admin");
    // Ruling 457 (owner, 2026-09-24): the bell's counts, not its list.
    expect(result.unread).toBe(6);
    expect(result.orphanUnread).toBe(0);
    expect(result).not.toHaveProperty("notifications");

    const review = board.columns.find((c) => c.stage.id === "review")!;
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
    expect(vib142.owner?.name).toBe("Arda Kaya");
  });

  /**
   * UI-48: the board's "Waiting on me" and the review queue's "Waiting on your
   * acceptance" answered the same question with different predicates. The board
   * read decision-OBJECT presence (`decisionsRequiring` only scans tasks with a
   * packet or recommendations); the review queue deliberately does not require
   * one — a review-stage task waiting on a human can have no packet. So the same
   * task appeared under "Waiting on your acceptance" in Review while the board
   * chip excluded it. The board loader unions both predicates now.
   */
  it("waitingOnMe covers acceptance-ready review tasks with no decision object", async () => {
    const { loader } = await import("~/routes/project.board");
    const { baseTaskFrontmatter, writeTask } = await import(
      "../../../test-support/test-store"
    );
    const { rebuildAll } = await import("~/server/projections/rebuilder.server");
    const { decisionsRequiring } = await import(
      "~/server/projections/decisions.server"
    );
    const { getReviewQueue } = await import(
      "~/server/projections/review-queue.server"
    );
    // A review-stage task waiting on a human with NO packet and NO
    // recommendations — exactly the shape the review queue calls "ready" and
    // `decisionsRequiring` cannot see.
    writeTask(app.dataRoot, "viberr-core", {
      frontmatter: baseTaskFrontmatter("VIB-990", {
        stage: "review",
        waiting: "human",
      }),
    });
    rebuildAll(app.db, { dataRoot: app.dataRoot });

    const ready = getReviewQueue(app.db, "viberr-core", {
      viewerUserId: seedIds.arda,
    }).ready.map((r) => r.key);
    expect(ready).toContain("VIB-990");
    // B-FD5 (pass 15) moved the acceptance predicate INTO the shared helper, so
    // it now sees this task too — but only as an `acceptance` decision: the task
    // still carries no packet and no recommendation, which is what made the two
    // surfaces disagree in the first place.
    const mine = decisionsRequiring(app.db, seedIds.arda, {
      projectSlug: "viberr-core",
    }).mine;
    expect(mine.find((d) => d.taskKey === "VIB-990")?.kind).toBe("acceptance");
    expect(
      mine.filter(
        (d) => d.taskKey === "VIB-990" && d.kind !== "acceptance",
      ),
    ).toEqual([]);

    const { cookie } = await app.cookieFor(seedIds.arda);
    const result = await loader(
      loaderArgs(
        "/projects/viberr-core/board",
        `${PROJECT_PATTERN}/board`,
        { slug: "viberr-core" },
        cookie,
      ),
    );
    const flagged = new Set(
      result.columns
        .flatMap((c) => c.tasks)
        .filter((t) => t.waitingOnMe)
        .map((t) => t.key),
    );
    // Before the fix the board chip excluded it while Review listed it under
    // "Waiting on your acceptance".
    expect(flagged.has("VIB-990")).toBe(true);

    // Restore the seeded store — later tests in this file assert seed counts.
    const { rmSync } = await import("node:fs");
    rmSync(path.join(app.dataRoot, "projects", "viberr-core", "tasks", "VIB-990"), {
      recursive: true,
      force: true,
    });
    rebuildAll(app.db, { dataRoot: app.dataRoot });
  });
});

describe("home loader (seeded)", () => {
  it("lists the 3 seeded projects with real aggregates + Arda's pins", async () => {
    const { loader } = await import("~/routes/_index");
    const { cookie } = await app.cookieFor(seedIds.arda);
    const result = await loader(loaderArgs("/", HOME_PATTERN, {}, cookie));

    expect(result.projects.map((p) => p.slug).sort()).toEqual([
      "billing-service",
      "deploy-pipeline",
      "viberr-core",
    ]);
    const core = result.projects.find((p) => p.slug === "viberr-core")!;
    expect(core.total).toBe(10);
    // The demo seed has no fabricated runs, so Viberr Core stays quiet until an
    // agent actually runs.
    expect(core.running).toBe(0);
    expect(core.waiting).toBe(2); // open decision packets, project-wide
    expect(core.dist.review).toBe(2);
    expect(core.dist.done).toBe(2);
    expect(core.members.length).toBe(4);
    // Custom 3-stage board fixture carries its OWN stage list (ruling 15).
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
      url: new URL(request.url),
      params: { slug: "viberr-core" },
      pattern: `${PROJECT_PATTERN}/board`,
      context: new RouterContextProvider(),
    });
  }

  it("member creates a task → file on disk + board card", async () => {
    const result = actionOutcome(
      await postCreate(seedIds.arda, "Route-level create task"),
    );
    expect(result.ok).toBe(true);
    expect(result.key).toMatch(/^VIB-\d+$/);
    expect(result.stageName).toBe("Triage");

    const taskFile = path.join(
      app.dataRoot,
      "projects",
      "viberr-core",
      "tasks",
      result.key ?? "",
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

  // E2: this used to assert the inner guard's 403 ("Only project members can
  // create tasks") — the one reply in the app that confirmed a members-only
  // project exists. The board action now runs `requireVisibleProject` first, so
  // a non-member gets the same unknown-slug 404 as every other route and intent.
  // Per-intent coverage lives in app/routes/project.board.server.test.ts.
  it("non-member is refused as an unknown slug (R15-4 secrecy)", async () => {
    const thrown = thrownRefusalSchema.parse(
      await postCreate(seedIds.deniz, "Should not exist").catch((e) => e),
    );
    expect(thrown.init?.status).toBe(404);
    expect(String(thrown.data)).toBe("No project at projects/viberr-core.");
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

    const post = (body: Record<string, string>) => {
      const request = app.request("/notifications/read", {
        method: "POST",
        cookie,
        body: new URLSearchParams({ _csrf: csrf, ...body }),
      });
      return action({
        request,
        url: new URL(request.url),
        params: {},
        pattern: "/notifications/read",
        context: new RouterContextProvider(),
      });
    };

    const one = await post({ intent: "read", id: "n-142-packet" });
    expect(one).toEqual({ ok: true, changed: 1 });
    expect(countUnreadNotifications(app.db, seedIds.arda)).toBe(before - 1);

    // Idempotent re-mark.
    const again = actionOutcome(
      await post({ intent: "read", id: "n-142-packet" }),
    );
    expect(again.changed).toBe(0);

    const all = actionOutcome(await post({ intent: "read-all" }));
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
    const request = app.request("/prefs/theme", {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, theme: "dark" }),
    });
    const result = actionOutcome(
      await action({
        request,
        url: new URL(request.url),
        params: {},
        pattern: "/prefs/theme",
        context: new RouterContextProvider(),
      }),
    );
    expect(result.payload).toEqual({ ok: true, theme: "dark" });
    expect(result.headers?.get("Set-Cookie")).toContain("viberr_theme=dark");
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
    const request = app.request("/", {
      method: "POST",
      cookie,
      body: new URLSearchParams({
        _csrf: csrf,
        intent: "create-project",
        name,
        key: "PAY",
        owner: "akin-ozer",
        repoName: "payments-gateway",
        // P13-AP-04: no `template` field any more — the "Lightweight ·
        // 3 stages" preset was deleted (owner ruling 2), so creation always
        // produces the Standard 5-stage board.
        policy: "strict",
      }),
    });
    return action({
      request,
      url: new URL(request.url),
      params: {},
      pattern: HOME_PATTERN,
      context: new RouterContextProvider(),
    });
  }

  it("writes project.md from the template and projects it", async () => {
    const result = actionOutcome(await postCreateProject("Payments Gateway"));
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
    // P13-AP-04: the Standard 5-stage board is the ONLY template creation can
    // produce (this used to assert the deleted Lightweight preset's
    // todo/doing/done board and its description).
    expect(project.stages.map((s) => s.id)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      "done",
    ]);
    expect(project.description).toBe(
      "Standard 5-stage workflow · strict human-gate policy.",
    );
  });

  it("rejects a duplicate slug with a conflict", async () => {
    const result = actionOutcome(await postCreateProject("Payments Gateway"));
    expect(result.status).toBe(409);
    expect(result.error).toContain("already exists");
  });

  it("RBAC decision (pinned): any org MEMBER may create a project and is seeded its admin", async () => {
    // Deniz is a plain org member (not an org admin) — creation is self-serve,
    // no org-admin gate. This test pins the deliberate _index.tsx decision.
    const { action } = await import("~/routes/_index");
    const { cookie, sessionId } = await app.cookieFor(seedIds.deniz);
    const csrf = await app.csrfFor(sessionId);
    const request = app.request("/", {
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
    });
    const result = actionOutcome(
      await action({
        request,
        url: new URL(request.url),
        params: {},
        pattern: HOME_PATTERN,
        context: new RouterContextProvider(),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.slug).toBe("member-made");

    // The creating member is seeded as the new project's admin.
    const row = memberRoleRowSchema.parse(
      app.db
        .prepare(
          `SELECT role FROM project_members WHERE project_slug = 'member-made' AND user_id = ?`,
        )
        .get(seedIds.deniz),
    );
    expect(row?.role).toBe("admin");
  });

  it("ruling 462: the modal's createRepository choice reaches createProject with its visibility", async () => {
    // CANARY: stop reading `createRepository` off the form and no create is
    // asked of GitHub; read "public" as private and the body says so.
    const { fakeGithubFetch } = await import("../../../test-support/fake-github");
    let created = false;
    const gh = fakeGithubFetch({
      "GET /repos/akin-ozer/brand-site": () =>
        created
          ? { body: { default_branch: "main", permissions: { push: true } } }
          : { status: 404, body: { message: "Not Found" } },
      // The connection seeded above carries no stored login, so its owner is
      // treated as an organization.
      "POST /orgs/akin-ozer/repos": () => {
        created = true;
        return { status: 201, body: { full_name: "akin-ozer/brand-site" } };
      },
    });
    const previous = globalThis.fetch;
    vi.stubGlobal("fetch", gh.fetchImpl);
    try {
      const { action } = await import("~/routes/_index");
      const { cookie, sessionId } = await app.cookieFor(seedIds.arda);
      const csrf = await app.csrfFor(sessionId);
      const request = app.request("/", {
        method: "POST",
        cookie,
        body: new URLSearchParams({
          _csrf: csrf,
          intent: "create-project",
          name: "Brand Site",
          key: "BRS",
          owner: "akin-ozer",
          repoName: "brand-site",
          policy: "balanced",
          createRepository: "public",
        }),
      });
      const result = await action({
        request,
        url: new URL(request.url),
        params: {},
        pattern: HOME_PATTERN,
        context: new RouterContextProvider(),
      });
      expect(actionOutcome(result).ok).toBe(true);
      expect("repoNote" in result ? result.repoNote : null).toBe(
        "Created akin-ozer/brand-site on GitHub (public).",
      );
      const posts = gh.callsTo("POST /orgs/akin-ozer/repos");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toEqual({ name: "brand-site", private: false, auto_init: true });
    } finally {
      vi.stubGlobal("fetch", previous);
    }
  });
});
