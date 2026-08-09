import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";

/**
 * Ruling 25 (R15-4) + D2, driven through the REAL route actions.
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
 *     app/features/shell/workspace-routes.server.test.ts). Two of the six action
 *     routes were pinned in app/routes/project-visibility.server.test.ts; this
 *     drives ALL of them and then asserts the list is COMPLETE, so a new
 *     project-scoped route cannot ship without the gate.
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

let app: AppTestContext;
let ids: { arda: string; deniz: string; orgAdmin: string };

const SLUG = "viberr-core";
const TASK = "VIB-142";
/** The one refusal every project surface may give a non-member. */
const UNKNOWN_SLUG_404 = `No project at projects/${SLUG}.`;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail, insertUser } = await import(
    "~/server/auth/user-store.server"
  );
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
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id,
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
];

async function post(
  route: GatedRoute,
  userId: string,
  fields: Record<string, string>,
): Promise<unknown> {
  const { action } = (await import(
    /* @vite-ignore */ `~/routes/${route.mod}`
  )) as { action: (args: unknown) => Promise<unknown> };
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return action({
    request: app.request(route.path, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    params: route.params,
    context: {},
  });
}

/** What a route answered: a thrown Response-ish refusal or a returned result. */
function outcome(value: unknown): { status: number; body: unknown } {
  const v = value as
    | { init?: { status?: number }; status?: number; data?: unknown }
    | undefined;
  return { status: v?.init?.status ?? v?.status ?? 200, body: v?.data ?? v };
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

    const result = (await post(ACTION_ROUTES[1]!, ids.orgAdmin, {
      intent: "comment",
      text,
    })) as { ok: boolean; toast: string };

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
      const thrown = await post(route, ids.deniz, {
        intent: "no-such-intent",
      }).catch((e: unknown) => e);
      const { status, body } = outcome(thrown);
      expect(status, `${route.name} must refuse a non-member with 404`).toBe(404);
      // Byte-identical to the layout loader's unknown-slug refusal (and to the
      // six child loaders'): the response can never confirm that `viberr-core`
      // exists (WI-13). A 403 here — or different copy — IS the oracle.
      expect(String(body)).toBe(UNKNOWN_SLUG_404);
      expect(String(body)).not.toMatch(/member/i);
    });

    it(`${route.name}: a member reaches the intent switch`, async () => {
      const result = (await post(route, ids.arda, {
        intent: "no-such-intent",
      })) as { init: { status: number }; data: { error: string } };
      expect(result.init.status).toBe(400);
      expect(result.data.error).toBe("Unknown action.");
    });
  }

  it("a non-member's comment never reaches the timeline", async () => {
    const text = "Non-member comment — must never be written.";
    const before = await timelineTexts(TASK);
    const thrown = await post(ACTION_ROUTES[1]!, ids.deniz, {
      intent: "comment",
      text,
    }).catch((e: unknown) => e);
    expect(outcome(thrown).status).toBe(404);
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
    "project.github.tsx",
    "project.policy.tsx",
    "project.review.tsx",
    "project.settings.tsx",
    "project.task.tsx",
    "project.tsx",
  ];
  /** Everything except `project.board.tsx` — the layout serves the board's read. */
  const EXPECTED_LOADER_ROUTES = EXPECTED_PROJECT_ROUTES.filter(
    (f) => f !== "project.board.tsx",
  );

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
    expect(body("project.board.tsx", "loader")).toBeNull(); // the layout serves it
    // …and it has to extract the NON-async form too — the exact shape BS-1 hid.
    const indexLoader = body("project._index.tsx", "loader");
    expect(
      indexLoader,
      "`export function loader` must be visible to the scan (BS-1)",
    ).not.toBeNull();
    expect(indexLoader).toContain("redirect(");
  });

  it("every project route ACTION calls requireVisibleProject in its own body", () => {
    const withAction = files.filter((f) => body(f, "action") !== null);
    // The expected set FIRST: assert what was scanned before asserting about it,
    // so a route that fell out of the scan fails here instead of passing by
    // absence. `ACTION_ROUTES` is that expectation — every action route is also
    // DRIVEN above.
    expect(withAction).toEqual(ACTION_ROUTES.map((r) => `${r.mod}.tsx`).sort());
    for (const f of withAction) {
      expect(
        body(f, "action"),
        `${f} exports an action but never calls requireVisibleProject — a POST ` +
          `reaches the mutation without the layout loader ever running`,
      ).toContain("requireVisibleProject(");
    }
  });

  it("every project route LOADER gates the read in its own body", () => {
    // `project.tsx` is the layout: it is the read chokepoint itself and inlines
    // the members-only 404 (its member lookup + `orgAdminOverride` resolution
    // feed the whole shell), so it carries no guard CALL. Every other project
    // loader runs alone under single fetch's `?_routes=` filter and needs its
    // own gate.
    const withLoader = files.filter((f) => body(f, "loader") !== null);
    expect(withLoader).toEqual(EXPECTED_LOADER_ROUTES);
    for (const f of withLoader) {
      if (f === "project.tsx") {
        expect(body(f, "loader")).toContain(
          "No project at projects/${params.slug}.",
        );
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
