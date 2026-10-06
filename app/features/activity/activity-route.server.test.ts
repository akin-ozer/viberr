import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { isRuntimeSessionOpen } from "./activity-page";

/**
 * Route-level tests for /projects/:slug/activity against the seeded demo
 * store: auth gating, the flattened cross-task stream (real projection over
 * task_events), and the audit panel reading the real scope_violations +
 * audit_events tables.
 */

let app: AppTestContext;
let ardaId: string;
/** The board's project admin, who is not an org admin. */
let elifId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
  elifId = userIds.elif;
});
afterAll(() => app.cleanup());

async function runLoader(slug: string, cookie?: string) {
  const { loader } = await import("~/routes/project.activity");
  // SAFETY: the loader reads only `request` and `params.slug`; the rest of the
  // generated `Route.LoaderArgs` (the router context provider, its matches) is
  // untouched on every path this file exercises.
  return loader({
    request: app.request(
      `/projects/${slug}/activity`,
      cookie ? { cookie } : {},
    ),
    params: { slug },
    context: {},
  } as never);
}

describe("/projects/:slug/activity", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader("viberr-core").catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above already failed the test if it is not one.
    expect((thrown as Response).status).toBe(302);
  });

  it("404s for an unknown project", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const thrown = await runLoader("nope", cookie).catch((e) => e);
    expect(thrown?.init?.status ?? thrown?.status).toBe(404);
  });

  it("returns the flattened seeded stream, newest first, with real actors", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = await runLoader("viberr-core", cookie);

    expect(result.projectName).toBe("Viberr Core");
    // All 32 seeded events across the 10 tasks, one flat feed.
    expect(result.stream.length).toBe(32);
    const times = result.stream.map((r) => r.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);

    // Every mock actor kind appears (drives the All/Humans/Agents/System filter).
    const kinds = new Set(result.stream.map((r) => r.actor?.kind));
    expect(kinds).toContain("human");
    expect(kinds).toContain("agent");
    expect(kinds).toContain("system");

    // Completion events carry the folded title (mock norm()).
    const completion = result.stream.find((r) => r.type === "completion");
    expect(completion?.text.startsWith("**Completion")).toBe(true);

    // Task keys link back to their tasks.
    expect(result.stream.every((r) => /^VIB-\d+$/.test(r.taskKey))).toBe(true);
  });

  it("audit panel carries the seeded open violation from scope_violations", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = await runLoader("viberr-core", cookie);
    const violation = result.audit.find((e) => e.kind === "violation");
    expect(violation).toBeDefined();
    expect(violation!.status).toBe("open");
    expect(violation!.taskKey).toBe("VIB-142");
    expect(violation!.text).toBe(
      "Project credential is missing `pull_request:write`. Flagged by the policy engine on",
    );
  });

  it("stub projects load their own task's stream (DEP-31 lives there now)", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = await runLoader("deploy-pipeline", cookie);
    // The stub project carries a real task (DEP-31) so its cross-project
    // notification navigates to a real record — the stream shows its events
    // and nothing from other projects.
    expect(result.stream.length).toBeGreaterThan(0);
    expect(result.stream.every((row) => row.taskKey === "DEP-31")).toBe(true);
  });

  it("R19-7: the audit column's fold recognises the session row the projection ships", async () => {
    // The view model carries no action name, so the page folds these rows by
    // their rendered sentence (`isRuntimeSessionOpen`). The sentence itself is
    // pinned at the projection (activity-feed-phase10.server.test.ts); this
    // binds the recogniser to the row the loader actually ships.
    // CANARY: reword the `runtime.run.started` case in activity-feed.server.ts
    // alone and this goes red instead of the column silently un-compacting.
    const { recordAudit, OPERATOR_AUDIT_ACTOR } = await import(
      "~/server/audit/audit-recorder.server"
    );
    const { cookie } = await app.cookieFor(ardaId);
    const shown = new Set((await runLoader("viberr-core", cookie)).audit.map((e) => e.id));
    // The run service's own call: no human actor, a role, a task.
    recordAudit(app.db, {
      action: "runtime.run.started",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "run",
      subjectId: "run_r19_7",
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      details: { role: "Reviewer" },
    });
    const added = (await runLoader("viberr-core", cookie)).audit.filter(
      (e) => !shown.has(e.id),
    );
    expect(added).toHaveLength(1);
    expect(isRuntimeSessionOpen(added[0]!)).toBe(true);
  });

  // CANARY: hand `docHref` to every viewer and a person who cannot open
  // Instance settings is given its link; send the row as the read model built
  // it and `doc` rides along to everyone.
  it("ruling 681: a row that wrote a knowledge-base document links it for an org admin, and for nobody else", async () => {
    const { recordAudit } = await import("~/server/audit/audit-recorder.server");
    recordAudit(app.db, {
      action: "org.store.doc_written",
      actor: { userId: ardaId, label: "arda@viberr.dev" },
      subjectKind: "org_kb",
      subjectId: "kb_house_rules",
      details: {
        path: "rules.md",
        replaced: true,
        resource: {
          kind: "kb",
          key: "house-rules",
          boards: [{ project: "viberr-core", rulings: true, agents: [] }],
        },
      },
    });
    const rowFor = async (userId: string) => {
      const { cookie } = await app.cookieFor(userId);
      const { audit } = await runLoader("viberr-core", cookie);
      return audit.find((e) => e.text.includes("**rules.md**"))!;
    };

    const admin = await rowFor(ardaId);
    expect(admin.text).toBe(
      "Arda Kaya replaced **rules.md** in the project's rulings **house-rules**.",
    );
    expect(admin).toMatchObject({
      docHref: "/org/settings?tab=resources&kb=house-rules&doc=rules.md",
    });
    const member = await rowFor(elifId);
    expect(member.text).toBe(admin.text);
    expect(Object.keys(member)).toEqual(Object.keys(admin).filter((key) => key !== "docHref"));
  });
});
