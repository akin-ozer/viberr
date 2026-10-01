import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";

/**
 * Phase 10 route-level coverage:
 * - Home loader org tile: REAL KB/MCP/skill counts from the 0008 tables
 *   (the phase-4 loader predated them — honest zeros closed here).
 * - Home `rebuild-projections` intent: admin-only full drop + rebuild with
 *   identical counts and an audit row.
 * - /resources/health: `{ ok, projections: { projects, tasks }, watcher }`.
 * - Home `hide-setup` intent (ruling 618): the setup checklist closed for the
 *   sign-in that closed it.
 */

let app: AppTestContext;
let ardaId: string;
let denizId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedOrgResources } = await import("~/server/org/org-seed.server");
  seedOrgResources(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
  denizId = userIds.deniz; // org member
});
afterAll(() => app.cleanup());

/** The args the framework hands a server loader/action for `/` — every field
 *  carries the real value it would carry in a request, so the route functions
 *  can be called directly. */
function homeRouteArgs(request: Request) {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/",
    context: new RouterContextProvider(),
  };
}

async function runHomeLoader(cookie: string) {
  const { loader } = await import("~/routes/_index");
  return loader(homeRouteArgs(app.request("/", { cookie })));
}

/** Every branch of the home action: a bare payload on success, a react-router
 *  `data(body, init)` wrapper on every refusal and on the setup checklist's
 *  close, whose answer carries a cookie. */
type HomeActionResult = Awaited<
  ReturnType<typeof import("~/routes/_index").action>
>;

/** A signed-in session, as `app.cookieFor` makes it. */
type Session = Awaited<ReturnType<AppTestContext["cookieFor"]>>;

async function postHome(
  userId: string,
  fields: Record<string, string>,
): Promise<HomeActionResult> {
  return postHomeAs(await app.cookieFor(userId), fields);
}

async function postHomeAs(
  { cookie, sessionId }: Session,
  fields: Record<string, string>,
): Promise<HomeActionResult> {
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ _csrf: csrf, ...fields });
  const { action } = await import("~/routes/_index");
  return action(
    homeRouteArgs(
      app.request("/", {
        method: "POST",
        cookie,
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    ),
  );
}

/** A refusal carries the status in the `data(body, init)` wrapper and says
 *  `ok: false`; anything else took a branch the caller did not expect and
 *  should say so rather than read `undefined` off the wrong shape. */
function refusal(result: HomeActionResult) {
  if (!("init" in result) || result.data.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  }
  return { init: result.init, data: result.data };
}

/** The setup checklist's close answers `ok` in the wrapper that sets its
 *  cookie (ruling 618); this is that cookie's Set-Cookie value. */
function closeCookie(result: HomeActionResult): string {
  const cookie =
    "init" in result && result.data.ok
      ? new Headers(result.init?.headers).get("Set-Cookie")
      : null;
  if (!cookie) {
    throw new Error(`expected the close's cookie, got ${JSON.stringify(result)}`);
  }
  return cookie;
}

/** The rescan/rebuild intents are the only branches answering a projection
 *  summary (`{ ok, projects, tasks, errors, … }`). */
function projectionRun(result: HomeActionResult) {
  if (!("projects" in result)) {
    throw new Error(
      `expected a projection summary, got ${JSON.stringify(result)}`,
    );
  }
  return result;
}

describe("home org tile counts (Phase 10)", () => {
  it("counts KBs / MCP servers / skills from the real 0008 tables", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const data = await runHomeLoader(cookie);
    // seedOrgResources: 3 KBs · 4 skills · 0 MCP rows (honest empty slate — no
    // fabricated MCP health is seeded; an admin adds real servers).
    expect(data.org.knowledgeBases).toBe(3);
    expect(data.org.mcpServers).toBe(0);
    expect(data.org.skills).toBe(4);
    expect(data.org.globalAgents).toBeGreaterThan(0);
  });

  // F10-21: the tile reads "<n> agent profiles" — reusable templates the user
  // configured. The operator is a SYSTEM profile that ships with every store and
  // is not listed in the Org Resources catalog, so folding it in overstates what
  // was configured and makes the tile disagree with the catalog for no reason.
  it("counts SPECIALIST profiles only — the seeded operator is excluded", async () => {
    const { listGlobalAgentProfiles } = await import(
      "~/server/org/gagents.server"
    );
    const { cookie } = await app.cookieFor(ardaId);
    const data = await runHomeLoader(cookie);

    // runDemoSeed writes 3 profile templates: operator + developer + reviewer.
    const profiles = listGlobalAgentProfiles(app.db, { dataRoot: app.dataRoot });
    expect(profiles.map((p) => p.id)).toEqual(["developer", "reviewer"]);
    // The operator template IS on disk — the count excludes it by kind, not by
    // it being absent.
    const { existsSync } = await import("node:fs");
    const { default: path } = await import("node:path");
    expect(
      existsSync(path.join(app.dataRoot, "agents", "profiles", "operator.md")),
    ).toBe(true);

    // Exact count, same population the catalog lists — 2, not 3.
    expect(data.org.globalAgents).toBe(2);
    expect(data.org.globalAgents).toBe(profiles.length);
  });
});

describe("rebuild-projections intent (Phase 10 recovery)", () => {
  it("refuses non-admins with a 403", async () => {
    const result = await postHome(denizId, { intent: "rebuild-projections" });
    const status = refusal(result).init?.status;
    expect(status).toBe(403);
  });

  it("admin rebuild drops + re-projects to identical counts and audits", async () => {
    // SAFETY: `SELECT count(*) c` is an aggregate with no GROUP BY — sqlite
    // answers it with exactly one row carrying the single integer column `c`.
    const rowCount = (table: string) =>
      (app.db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number })
        .c;
    const counts = () => ({
      projects: rowCount("projects"),
      tasks: rowCount("task_projections"),
      events: rowCount("task_events"),
    });
    const before = counts();
    expect(before.projects).toBe(3); // seeded demo dataset
    expect(before.tasks).toBe(12);

    const result = projectionRun(
      await postHome(ardaId, { intent: "rebuild-projections" }),
    );
    expect(result.ok).toBe(true);
    expect(result.projects).toBe(before.projects);
    expect(result.tasks).toBe(before.tasks);
    expect(result.errors).toBe(0);
    expect(counts()).toEqual(before);

    const rows = listAuditEvents(app.db, { action: "projection.rebuild" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.actorUserId).toBe(ardaId);

    // P13-D-33: rescan and rebuild each walk the whole store and had no
    // limiter, lock or min-interval — holding the button ran one full sweep
    // per click. A repeat is refused with a 429 until the cooldown passes.
    const again = refusal(await postHome(ardaId, { intent: "rebuild-projections" }));
    expect(again.init?.status).toBe(429);
    expect(again.data.ok).toBe(false);
    expect(again.data.error).toContain("try again in");
    // Independent cooldowns: the rebuild's does not swallow the re-scan.
    expect(projectionRun(await postHome(ardaId, { intent: "rescan" })).ok).toBe(true);
    const rescanAgain = refusal(await postHome(ardaId, { intent: "rescan" }));
    expect(rescanAgain.init?.status).toBe(429);
  });
});

/**
 * Ruling 618: the setup checklist's close hides it for the sign-in that
 * pressed it, through a cookie that names that sign-in and has no expiry (the
 * browser drops it with its own session). The demo seed leaves Arda's
 * checklist open: he holds no Claude or Codex account of his own.
 */
describe("hide-setup intent (ruling 618)", () => {
  it("closes the checklist for this sign-in, and the next sign-in has it back", async () => {
    const session = await app.cookieFor(ardaId);
    expect((await runHomeLoader(session.cookie)).setup).not.toBeNull();

    const setCookie = closeCookie(await postHomeAs(session, { intent: "hide-setup" }));
    // CANARY: give the cookie a Max-Age and the card stays closed after the
    // browser's session ends.
    expect(setCookie).not.toMatch(/max-age|expires/i);
    expect(setCookie).toMatch(/; HttpOnly(;|$)/);
    const closed = setCookie.split(";")[0]!;
    expect((await runHomeLoader(`${session.cookie}; ${closed}`)).setup).toBeNull();

    // The same browser, signed in again: the cookie names the old sign-in.
    // CANARY: read the cookie as a flag, whoever's session it names, and the
    // next sign-in (the account the checklist asked for, say) finds it closed.
    const next = await app.cookieFor(ardaId);
    expect((await runHomeLoader(`${next.cookie}; ${closed}`)).setup).not.toBeNull();
  });

  it("leaves the checklist on a Home with no project", async () => {
    const { createUser } = await import("~/server/auth/user-admin.server");
    const newcomer = await createUser(
      app.db,
      { email: "newcomer@viberr.test", name: "Newcomer", role: "member", tempPassword: null },
      { userId: ardaId, label: "arda" },
    );
    const session = await app.cookieFor(newcomer.id);
    const closed = closeCookie(
      await postHomeAs(session, { intent: "hide-setup" }),
    ).split(";")[0]!;
    // CANARY: drop the project guard from the loader and the card leaves a
    // Home that has no other way to start a project.
    const home = await runHomeLoader(`${session.cookie}; ${closed}`);
    expect(home.projects).toEqual([]);
    expect(home.setup).not.toBeNull();
  });
});

describe("/resources/health (Phase 10 ops probe)", () => {
  it("returns ok + projection counts + watcher liveness, no auth required", async () => {
    const { loader } = await import("~/routes/resources.health");
    // react-router `data(body, init)` wrapper — the probe payload is `.data`.
    const { data: body } = await loader();
    expect(body).toMatchObject({
      ok: true,
      projections: { projects: 3, tasks: 12 },
    });
    // The `down` branch (SQLite unreadable) answers `ok`/`status` only, so
    // `watcher` is present exactly when the assertion above holds — branch on
    // the `ok` discriminant the payload carries, not on the key's presence.
    if (!body.ok) throw new Error("the probe answered its `down` branch");
    expect(body.watcher).toBeTypeOf("boolean");
  });
});
