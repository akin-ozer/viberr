import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { routeArgs, setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";

/**
 * Ruling 27 (R15-4) + D2, driven through the REAL route actions.
 *
 * Two invariants live here, and both were found by USING the app rather than
 * reading it:
 *
 *  1. **Members-only, on the ACTION side of every project surface.** React
 *     Router runs a child route's action without its parent's loader, so the
 *     layout's members-only 404 is not a chokepoint for POSTs — every
 *     project-scoped action needs `requireVisibleProject`, and its refusal must
 *     be the BYTE-IDENTICAL unknown-slug 404, never a 403 that would confirm the
 *     project exists (F19-28 was the same oracle on the loader side; the
 *     `?_routes=` single-fetch bypass and all six child LOADERS are pinned in
 *     app/features/shell/workspace-routes.server.test.ts). This suite drives
 *     every project ACTION route and then asserts the list is COMPLETE, so a
 *     new project-scoped route cannot ship without the gate.
 *
 *  2. **F19-30 — an org-admin non-member's COMMENT is audited.** Commenting is
 *     deliberately role-free (`appendComment`/`commentToAgent` never call
 *     `requireAction`), so the `any-member` gate is its ONLY authority. When
 *     that gate was exempt from the `project.org_admin.override` row, an org
 *     admin could write into a members-only project and leave no trace — against
 *     D2's "EVERY such grant leaves a row". The unit-level half is pinned in
 *     policy-rbac.server.test.ts; this is the whole path, from a real signed
 *     request to the bytes on disk.
 */

/** The three actors this file drives, by user id. */
interface ProbeActors {
  arda: string;
  deniz: string;
  orgAdmin: string;
}

let app: AppTestContext;
let ids: ProbeActors;

const SLUG = "viberr-core";
const TASK = "VIB-142";
/** The one refusal every project surface may give a non-member. */
const UNKNOWN_SLUG_404 = `No project at projects/${SLUG}.`;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { insertUser } = await import("~/server/auth/user-store.server");
  // A fresh ORG admin who is a member of nothing — the D2 override subject. A
  // dedicated user (rather than promoting a seeded one) keeps the override
  // audit's 60s per-(actor, project, what) collapse from making this file's
  // assertions depend on test ORDER.
  const orgAdmin = insertUser(app.db, {
    id: "u_override_probe",
    email: "override-probe@viberr.test",
    name: "Override Probe",
    role: "admin",
  });
  ids = {
    arda: userIds.arda,
    deniz: userIds.deniz,
    orgAdmin: orgAdmin.id,
  };
});
afterAll(() => app.cleanup());

interface GatedRoute {
  name: string;
  /** Route module id — the file that must carry the gate. */
  mod: string;
  path: string;
  params: Record<string, string>;
}

/** Every project-scoped route that exports an `action`. Asserted COMPLETE below. */
const ACTION_ROUTES: GatedRoute[] = [
  {
    name: "board",
    mod: "project.board",
    path: `/projects/${SLUG}/board`,
    params: { slug: SLUG },
  },
  {
    name: "task detail",
    mod: "project.task",
    path: `/projects/${SLUG}/tasks/${TASK}`,
    params: { slug: SLUG, key: TASK },
  },
  {
    name: "policy",
    mod: "project.policy",
    path: `/projects/${SLUG}/policy`,
    params: { slug: SLUG },
  },
  {
    name: "agents",
    mod: "project.agents",
    path: `/projects/${SLUG}/agents`,
    params: { slug: SLUG },
  },
  {
    name: "github",
    mod: "project.github",
    path: `/projects/${SLUG}/github`,
    params: { slug: SLUG },
  },
  {
    name: "settings",
    mod: "project.settings",
    path: `/projects/${SLUG}/settings`,
    params: { slug: SLUG },
  },
  // Ruling 247: the project controller surface.
  {
    name: "controller",
    mod: "project.controller",
    path: `/projects/${SLUG}/controller`,
    params: { slug: SLUG },
  },
  // Ruling 325: the project's epics, and one epic.
  {
    name: "epics",
    mod: "project.epics",
    path: `/projects/${SLUG}/epics`,
    params: { slug: SLUG },
  },
  {
    name: "epic",
    mod: "project.epic",
    path: `/projects/${SLUG}/epics/epic-1`,
    params: { slug: SLUG, epicId: "epic-1" },
  },
];

/** The argument set React Router hands a project-scoped action. */
interface ProjectActionArgs {
  request: Request;
  url: URL;
  params: Record<string, string>;
  pattern: string;
  context: Readonly<RouterContextProvider>;
}

/** Whatever the six actions answer with, straight from their own signatures —
 *  type-only imports, so the modules are still LOADED lazily inside `post`
 *  (after setupAppTest has pointed the env at the temp data root). */
type ProjectActionAnswer = Awaited<
  | ReturnType<typeof import("~/routes/project.board").action>
  | ReturnType<typeof import("~/routes/project.task").action>
  | ReturnType<typeof import("~/routes/project.policy").action>
  | ReturnType<typeof import("~/routes/project.agents").action>
  | ReturnType<typeof import("~/routes/project.github").action>
  | ReturnType<typeof import("~/routes/project.settings").action>
  | ReturnType<typeof import("~/routes/project.controller").action>
  | ReturnType<typeof import("~/routes/project.epics").action>
  | ReturnType<typeof import("~/routes/project.epic").action>
>;

interface ProjectActionModule {
  action: (args: ProjectActionArgs) => Promise<ProjectActionAnswer>;
}

async function post(
  route: GatedRoute,
  userId: string,
  fields: Record<string, string>,
) {
  // SAFETY: the module id is a `GatedRoute.mod`, and the completeness scan at
  // the bottom of this file fails unless ACTION_ROUTES is EXACTLY the set of
  // project route modules exporting an `action` — so every id resolves to a
  // module with one. Each of those actions reads `request` and `params.slug` /
  // `params.key`, which every GatedRoute supplies.
  const { action } = (await import(
    /* @vite-ignore */ `~/routes/${route.mod}`
  )) as ProjectActionModule;
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const request = app.request(route.path, {
    method: "POST",
    cookie,
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return action(routeArgs(request, route.params, route.path));
}

/** What a route answered: a thrown Response-ish refusal or a returned result.
 *  `data(payload, init)` carries its own status — returned for an in-band
 *  refusal, THROWN for the unknown-slug 404 — and anything else (a plain result
 *  object, a bare Error) reads as a 200 that is its own body. */
const answer = z.unknown().transform((value) => {
  const envelope = z
    .object({
      init: z.object({ status: z.number() }).partial().nullish(),
      status: z.number().optional(),
      data: z.unknown(),
    })
    .safeParse(value).data;
  return {
    status: envelope?.init?.status ?? envelope?.status ?? 200,
    body: envelope?.data ?? value,
  };
});

/** POST and report the answer whether the route RETURNED or THREW it. */
async function outcome(
  route: GatedRoute,
  userId: string,
  fields: Record<string, string>,
) {
  try {
    return answer.parse(await post(route, userId, fields));
  } catch (error) {
    return answer.parse(error);
  }
}

async function timelineTexts(taskKey: string): Promise<string[]> {
  const { readTaskFile } = await import("~/server/files/task-writer.server");
  const file = readTaskFile({
    projectSlug: SLUG,
    taskKey,
    dataRoot: app.dataRoot,
  })!;
  return file.parsed.timeline.map((e) => e.text);
}

/**
 * F19-30 runs FIRST and on its own user, so no other case in this file can
 * consume the 60s override-audit collapse window for it.
 */
describe("F19-30: an org-admin non-member's COMMENT is granted AND audited", () => {
  it("writes the comment through the real route and records the override row", async () => {
    const text = "Override probe comment — org admin, not a member.";
    const seen = new Set(
      listAuditEvents(app.db, { action: "project.org_admin.override" }).map(
        (r) => r.id,
      ),
    );

    const result = z.object({ ok: z.boolean(), toast: z.string() }).parse(
      await post(ACTION_ROUTES[1]!, ids.orgAdmin, {
        intent: "comment",
        text,
      }),
    );

    // The comment really happened — this is the mutation the gate is the ONLY
    // authority for, so "granted" has to mean bytes on disk.
    expect(result.ok).toBe(true);
    expect(result.toast).toBe("Comment posted");
    expect(await timelineTexts(TASK)).toContain(text);

    // …and it left the D2 trace. The gate is `any-member` (commenting names no
    // RbacAction), and the `what` is the WRITE intent the route passes — a page
    // READ can never stand in for it.
    const fresh = listAuditEvents(app.db, {
      action: "project.org_admin.override",
    }).filter((r) => !seen.has(r.id));
    expect(
      fresh.length,
      "an org-admin non-member's comment must leave an override row",
    ).toBeGreaterThan(0);
    const row = fresh.find((r) => r.details?.what === "act on this project")!;
    expect(row, "the override row must name the write gate").toBeTruthy();
    expect(row.details?.action).toBe("any-member");
    expect(row.actorUserId).toBe(ids.orgAdmin);
    expect(row.projectSlug).toBe(SLUG);
    expect(row.details?.projectSlug).toBe(SLUG);
  });
});

describe("R15-4 on the ACTION side of every project-scoped route", () => {
  for (const route of ACTION_ROUTES) {
    it(`${route.name}: a non-member is refused as an unknown slug`, async () => {
      const { status, body } = await outcome(route, ids.deniz, {
        intent: "no-such-intent",
      });
      expect(status, `${route.name} must refuse a non-member with 404`).toBe(404);
      // Byte-identical to the layout loader's unknown-slug refusal (and to the
      // six child loaders'): the response can never confirm that `viberr-core`
      // exists (WI-13). A 403 here — or different copy — IS the oracle.
      expect(String(body)).toBe(UNKNOWN_SLUG_404);
      expect(String(body)).not.toMatch(/member/i);
    });

    it(`${route.name}: a member, and an org admin who is none (the D2 override), reach the intent switch`, async () => {
      for (const userId of [ids.arda, ids.orgAdmin]) {
        const result = z
          .object({
            init: z.object({ status: z.number() }),
            data: z.object({ error: z.string() }),
          })
          .parse(await post(route, userId, { intent: "no-such-intent" }));
        expect(result.init.status, userId).toBe(400);
        expect(result.data.error, userId).toBe("Unknown action.");
      }
    });
  }

  it("a non-member's comment never reaches the timeline", async () => {
    const text = "Non-member comment — must never be written.";
    const before = await timelineTexts(TASK);
    const refused = await outcome(ACTION_ROUTES[1]!, ids.deniz, {
      intent: "comment",
      text,
    });
    expect(refused.status).toBe(404);
    // Commenting carries no RbacAction of its own — `requireVisibleProject` IS
    // its access control, so a refusal has to mean the write never happened.
    const after = await timelineTexts(TASK);
    expect(after).not.toContain(text);
    expect(after.length).toBe(before.length);
    // …and the refused attempt is on the record (P13-D-8 / NFR10).
    const denials = listAuditEvents(app.db, {
      action: "project.authority.denied",
    }).filter((r) => r.actorUserId === ids.deniz && r.projectSlug === SLUG);
    expect(denials.length).toBeGreaterThan(0);
    expect(denials[0]?.details?.action).toBe("any-member");
  });
});

/**
 * The behavioural cases above can only cover the routes they KNOW about. This
 * is the completeness half: it reads the route directory and fails when a
 * project-scoped route exports a loader or an action without the gate — the
 * shape F19-28 shipped in (six loaders, each individually reasonable, none of
 * them covered).
 */
describe("every project-scoped route carries a membership gate", () => {
  const routesDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../routes",
  );
  const files = readdirSync(routesDir)
    // Route MODULES only. Colocated component tests share the `project.` prefix
    // and the `.tsx` extension (e.g. `project.test.tsx`, which renders
    // ArchivedBanner), so exclude the `.test.tsx` suffix or the scan mistakes a
    // test file for an ungated route.
    .filter(
      (f) =>
        f.startsWith("project.") &&
        f.endsWith(".tsx") &&
        !f.endsWith(".test.tsx"),
    )
    .sort();
  const source = (f: string) => readFileSync(path.join(routesDir, f), "utf8");

  /**
   * Every project route module on disk. The two scans below assert their
   * scanned set EQUALS its expectation rather than clearing a floor — a floor is
   * what let BS-1 through (see `body`), because dropping a route out of the
   * scanned set left the count comfortably above it.
   */
  const EXPECTED_PROJECT_ROUTES = [
    "project._index.tsx",
    "project.activity.tsx",
    "project.agents.tsx",
    "project.board.tsx",
    "project.controller.tsx",
    "project.epic.tsx",
    "project.epics.tsx",
    "project.github.tsx",
    "project.policy.tsx",
    "project.review.tsx",
    "project.settings.tsx",
    "project.task.tsx",
    "project.tsx",
  ];
  /** Every project route: since ruling 11 (BOARD-6) the board serves its own
   *  columns instead of the layout serving them. */
  const EXPECTED_LOADER_ROUTES = EXPECTED_PROJECT_ROUTES;

  /** Ruling 11 (BOARD-6): the layout and the board read the project through
   *  ONE gated read, `readWorkspace` (routes/project-workspace.server.ts). */
  const WORKSPACE_READ = "readWorkspace(request, db, params.slug, user)";
  /** The loaders gated by that read: the layout, the board, and since ruling
   *  325 the two epic pages, which draw from the same members and stages. */
  const WORKSPACE_LOADERS = ["project.tsx", "project.board.tsx", "project.epics.tsx", "project.epic.tsx"];

  /**
   * The BODY of one exported entry point, not the whole module.
   *
   * A file-level `includes("requireVisibleProject(")` is not this test: a route
   * that exports both a gated action and an UNGATED loader satisfies it — which
   * is precisely F19-28's shape, and the reason this scan is worth having.
   *
   * BS-1 (pass-19 verifier): this matched `^export async function <entry>(` and
   * nothing else, so any other export form React Router accepts fell OUT of the
   * scanned set entirely — no assertion ran on it, and the scan reported green
   * for a route it had never looked at. That was live, not hypothetical:
   * `project._index.tsx` ships `export function loader` (no `async`) and was
   * invisible to both scans. The matcher now covers the declaration forms (async
   * or not) and the const forms (`export const loader = async (…) =>`, typed or
   * generic), and bodies end at the first column-0 closer — `}` for a
   * declaration, `};` for a const — since prettier indents every nested one.
   */
  function body(f: string, entry: "loader" | "action"): string | null {
    const lines = source(f).split("\n");
    const decl = new RegExp(
      `^export (?:async )?function ${entry}\\b|^export const ${entry}\\b`,
    );
    const start = lines.findIndex((l) => decl.test(l));
    if (start === -1) return null;
    const end = lines.findIndex((l, i) => i > start && l.startsWith("}"));
    return lines.slice(start, end === -1 ? undefined : end + 1).join("\n");
  }

  it("finds the project route modules (the scan itself is not vacuous)", () => {
    // The EXPECTED SET, not a floor: a new project route has to be classified
    // here before it can be scanned, and a deleted one cannot silently shrink
    // the surface either.
    expect(files).toEqual(EXPECTED_PROJECT_ROUTES);
    // The body extractor has to actually extract something, or every assertion
    // built on it is vacuously true.
    const taskLoader = body("project.task.tsx", "loader")!;
    expect(taskLoader.split("\n").length).toBeGreaterThan(5);
    expect(taskLoader).toContain("requireVisibleProject(");
    // Ruling 11 (BOARD-6): the board has its own loader, gated by the
    // layout's own read.
    expect(body("project.board.tsx", "loader")).toContain(WORKSPACE_READ);
    // …and it has to extract the NON-async form too — the exact shape BS-1 hid.
    const indexLoader = body("project._index.tsx", "loader");
    expect(
      indexLoader,
      "`export function loader` must be visible to the scan (BS-1)",
    ).not.toBeNull();
    expect(indexLoader).toContain("redirect(");
  });

  it("every project route that exports an action is in ACTION_ROUTES, so it is driven above", () => {
    const withAction = files.filter((f) => body(f, "action") !== null);
    // `ACTION_ROUTES` is the set the cases above DRIVE (a non-member gets the
    // unknown-slug 404, a member reaches the intent switch), so an action route
    // missing from it would ship with its gate never exercised.
    expect(withAction).toEqual(ACTION_ROUTES.map((r) => `${r.mod}.tsx`).sort());
  });

  it("every project route LOADER gates the read in its own body", () => {
    // `project.tsx` is the layout: it is the read chokepoint itself, and its
    // members-only 404 (the member lookup + `orgAdminOverride` resolution feed
    // the whole shell) lives in `readWorkspace`, which the board's loader reads
    // through too. Every other project loader runs alone under single fetch's
    // `?_routes=` filter and needs its own gate.
    const withLoader = files.filter((f) => body(f, "loader") !== null);
    expect(withLoader).toEqual(EXPECTED_LOADER_ROUTES);
    for (const f of withLoader) {
      if (WORKSPACE_LOADERS.includes(f)) {
        expect(body(f, "loader")).toContain(WORKSPACE_READ);
        continue;
      }
      if (f === "project._index.tsx") {
        // The one CONDITIONAL exemption. `/projects/:slug` is a pure redirect to
        // the board: it reads nothing, so it has nothing to leak — a stranger
        // gets 302 → /board → the layout's unknown-slug 404, byte-identical
        // whether or not the project exists. The exemption is conditional on
        // that shape, asserted here statement-by-statement: the moment this
        // loader reads anything, it stops being exempt and this line fails.
        const stmts = body(f, "loader")!
          .split("\n")
          .slice(1, -1)
          .map((l) => l.trim())
          .filter(Boolean);
        expect(
          stmts,
          `${f} is exempt ONLY while its loader is a bare redirect — it now does ` +
            `more than redirect, so it needs a membership gate of its own`,
        ).toEqual(["throw redirect(`/projects/${params.slug}/board`);"]);
        continue;
      }
      expect(
        body(f, "loader"),
        `${f} exports a loader with no membership gate — under \`?_routes=\` it ` +
          `serves project content with the layout's 404 never running (F19-28)`,
      ).toMatch(/requireProjectMember\(|requireVisibleProject\(/);
    }
  });
});
