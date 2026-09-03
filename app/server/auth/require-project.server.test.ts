import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { writeProject } from "../../../test-support/test-store";

/**
 * THE membership chokepoint — `requireProjectMember`, the guard the six project
 * config surfaces (activity, review, policy, agents, settings, github), the
 * controller, the task-attachment route and the two run-artifact resource
 * routes call before serving a byte.
 *
 * Ruling 25 (R15-4) makes projects MEMBERS-ONLY, and the docs state the
 * consequence sharply: a probe cannot learn a project exists. That is a claim
 * about BYTES, not about status codes. F19-28 was exactly this guard answering
 * a non-member with `assertProjectAction`'s own 403 ("Only project members can
 * view this project's policy.") — a project-existence oracle reachable by
 * asking for ONE child loader on its own
 * (`?_routes=routes/project.policy`, which skips the layout's 404).
 *
 * The route-level halves are pinned elsewhere: the six child loaders in
 * app/features/shell/workspace-routes.server.test.ts, the two resource routes
 * in app/features/runtime/run-artifact-routes.server.test.ts. Nothing imported
 * this MODULE, so its own contract — two failure modes collapsing into one
 * answer, the positional (not substring) slug echo, the archived-read
 * exemption, and the audit rows that keep the real reason after the client has
 * been told nothing — could be deleted with every gate staying green. Ruling
 * 65: "an owner ruling whose guard cannot go red is a ruling that gets
 * reverted in silence."
 *
 * These cases drive the guard DIRECTLY with real signed requests, because a
 * route test can only reach the surfaces that happen to exist — it cannot ask
 * what the guard does for a project literally named `resources`, or for an
 * archived one, or for a session that was disabled a moment ago.
 */

/** One signed-in actor: the users row plus a live session cookie. */
interface Probe {
  id: string;
  cookie: string;
}

interface Probes {
  /** VIEWER on viberr-core — the LOWEST membership tier, which must pass. */
  elif: Probe;
  /** Registered, a member of nothing — the ruling-25 probe. */
  deniz: Probe;
  /** ORG admin, a member of nothing — the D2 emergency-override subject. */
  orgAdmin: Probe;
  /** Project ADMIN whose account is disabled mid-session. */
  banned: Probe;
  /** Non-member dedicated to the deny-audit case: the audit collapse is keyed
   *  per (actor, project, action) for 60 s, so sharing an actor with the cases
   *  above would make the assertion depend on test ORDER. */
  denyProbe: Probe;
}

let app: AppTestContext;
let probes: Probes;
let requireProjectMember: typeof import("./require-project.server").requireProjectMember;

/** A live project every fixture actor is measured against. */
const SLUG = "viberr-core";
/** Archived — read-only under R6-3, but still READABLE by its members. */
const FROZEN = "frozen-core";
/** A real project whose slug collides with the `/resources/...` URL space. */
const COLLIDING = "resources";
/** A slug that has no project.md at all. */
const GHOST = "ghost-project";
/** The one refusal ruling 25 allows on a slug-addressed surface. */
const UNKNOWN_SLUG_404 = `No project at projects/${SLUG}.`;
/** The guard's own copy fragment, as project.policy.tsx passes it. */
const WHAT = "view this project's policy";

beforeAll(async () => {
  app = await setupAppTest();
  ({ requireProjectMember } = await import("./require-project.server"));

  const { insertUser } = await import("~/server/auth/user-store.server");
  const makeProbe = async (id: string, role: "admin" | "member") => {
    const user = insertUser(app.db, {
      id,
      email: `${id}@viberr.test`,
      name: id,
      role,
    });
    const { cookie } = await app.cookieFor(user.id);
    return { id: user.id, cookie };
  };

  probes = {
    elif: await makeProbe("u_elif_probe", "member"),
    deniz: await makeProbe("u_deniz_probe", "member"),
    orgAdmin: await makeProbe("u_orgadmin_probe", "admin"),
    banned: await makeProbe("u_banned_probe", "member"),
    denyProbe: await makeProbe("u_deny_probe", "member"),
  };

  writeProbeProject(SLUG, [
    { userId: probes.elif.id, role: "viewer" },
    { userId: probes.banned.id, role: "admin" },
  ]);
  writeProbeProject(FROZEN, [{ userId: probes.elif.id, role: "viewer" }], {
    archived: true,
  });
  writeProbeProject(COLLIDING, [{ userId: probes.elif.id, role: "viewer" }]);
});
afterAll(() => app.cleanup());

function writeProbeProject(
  slug: string,
  members: ProjectFrontmatter["members"],
  patch: Partial<ProjectFrontmatter> = {},
): void {
  writeProject(app.dataRoot, {
    name: `Probe ${slug}`,
    slug,
    repo: "akin-ozer/viberr",
    defaultBranch: "main",
    taskPrefix: "VIB",
    nextTaskNumber: 100,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members,
    agents: [],
    credentialPolicy: null,
    guardrails: [],
    ...patch,
  });
}

/**
 * The single-fetch address F19-28 named: one child loader, addressed alone, so
 * the layout's 404 never runs. Every case below uses this shape rather than the
 * document URL, because it is the shape an attacker actually sends.
 */
function childSurfaceUrl(slug: string, surface: string): string {
  return `/projects/${slug}/${surface}.data?_routes=routes/project.${surface}`;
}

/**
 * The guard refuses by THROWING: react-router's `data(message, { status })`
 * for the 404, a real `Response` for the login redirect. Both reach a caller
 * untyped, so they are parsed where they land.
 */
const thrownDataSchema = z.object({
  data: z.unknown(),
  init: z.object({ status: z.number() }).nullish(),
});

/** What a caller of the guard actually observes. */
interface GuardOutcome {
  /** 200 when the guard let the caller through. */
  status: number;
  /** The bytes the client would receive; "" on a pass. */
  body: string;
  /** The user the guard returned, or null when it refused. */
  userId: string | null;
  /** Set only when the guard answered with a redirect. */
  location: string | null;
}

async function callGuard(
  url: string,
  slug: string,
  what: string,
  cookie?: string,
): Promise<GuardOutcome> {
  const request = app.request(url, cookie ? { cookie } : {});
  try {
    const ctx = await requireProjectMember(request, slug, what);
    return { status: 200, body: "", userId: ctx.user.id, location: null };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return {
        status: thrown.status,
        body: await thrown.text(),
        userId: null,
        location: thrown.headers.get("Location"),
      };
    }
    const refusal = thrownDataSchema.safeParse(thrown);
    // Anything that is neither envelope is a real crash, not a refusal —
    // rethrow it rather than reporting a status this guard never produced.
    if (!refusal.success) throw thrown;
    return {
      status: refusal.data.init?.status ?? 0,
      body: String(refusal.data.data ?? ""),
      userId: null,
      location: null,
    };
  }
}

describe("ruling 25 — a probe cannot learn a project exists", () => {
  /**
   * The gate is `"any-member"`, not a role tier: a VIEWER, the lowest project
   * role there is, reaches every config surface. Tightening this (e.g. to
   * admins, which the surfaces' own EDIT actions do require) would lock most of
   * a project's members out of reading their own policy and activity.
   */
  it("lets the LOWEST project role through and hands back that caller's context", async () => {
    const res = await callGuard(
      childSurfaceUrl(SLUG, "policy"),
      SLUG,
      WHAT,
      probes.elif.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.userId).toBe(probes.elif.id);
  });

  /**
   * THE ruling. F19-28: a non-member used to get a 403 whose copy confirmed the
   * project existed, while a typo got a 404 — so "not yours" and "never
   * existed" were trivially distinguishable and a signed-in stranger could
   * enumerate the whole org's projects one slug at a time.
   */
  it("answers a non-member with the unknown-slug 404, byte for byte", async () => {
    const nonMember = await callGuard(
      childSurfaceUrl(SLUG, "policy"),
      SLUG,
      WHAT,
      probes.deniz.cookie,
    );
    const unknown = await callGuard(
      childSurfaceUrl(GHOST, "policy"),
      GHOST,
      WHAT,
      probes.deniz.cookie,
    );

    expect(nonMember.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Normalize the ONE thing the caller already knows — the slug it asked for
    // — and the two answers have to be the same string.
    expect(nonMember.body).toBe(unknown.body.replace(GHOST, SLUG));
    expect(nonMember.body).toBe(UNKNOWN_SLUG_404);
    // The exact oracle F19-28 removed: "Only project members can …".
    expect(nonMember.body).not.toMatch(/member/i);
  });

  /**
   * `what` is the guard's per-surface copy fragment ("view this project's
   * policy" / "…settings"). It survives ONLY as the audit row's wording — two
   * different refusal strings would be an oracle of their own, telling a probe
   * which surface it reached and therefore that the project is real.
   */
  it("keeps the guard's `what` out of the refusal — every surface answers alike", async () => {
    const policy = await callGuard(
      childSurfaceUrl(SLUG, "policy"),
      SLUG,
      WHAT,
      probes.deniz.cookie,
    );
    const settings = await callGuard(
      childSurfaceUrl(SLUG, "settings"),
      SLUG,
      "view this project's settings",
      probes.deniz.cookie,
    );
    expect(settings.status).toBe(policy.status);
    expect(settings.body).toBe(policy.body);
    expect(policy.body).not.toContain("policy");
    expect(settings.body).not.toContain("settings");
  });
});

describe("the 404 names only a project the caller already named", () => {
  /**
   * The two run-addressed resource routes resolve the slug from the RUN row, so
   * the caller never typed it. Echoing it there would hand a non-member the
   * name of a project they never asked about — a fresh leak opened in the
   * middle of closing one.
   */
  it("a RUN-addressed resource route gets the bare 404, with no project name", async () => {
    const res = await callGuard(
      "/resources/run-log?runId=run_probe",
      SLUG,
      "view raw run logs",
      probes.deniz.cookie,
    );
    expect(res.status).toBe(404);
    expect(res.body).toBe("Not found.");
    expect(res.body).not.toContain(SLUG);
  });

  /**
   * The naming check is POSITIONAL, not `pathname.includes(slug)`. A project
   * whose slug is literally `resources` would otherwise see its own name echoed
   * back on `/resources/run-log` — the substring match would call that request
   * "the caller already named it" when the caller named a run id. This is the
   * one case no route test can express, because it needs a project with that
   * exact slug.
   */
  it("is positional: a project actually called `resources` is still not echoed", async () => {
    const viaResourceRoute = await callGuard(
      "/resources/run-log?runId=run_probe",
      COLLIDING,
      "view raw run logs",
      probes.deniz.cookie,
    );
    expect(viaResourceRoute.body).toBe("Not found.");
    expect(viaResourceRoute.body).not.toContain(COLLIDING);

    // …and the same slug IS echoed when the caller really did address it.
    const viaProjectRoute = await callGuard(
      childSurfaceUrl(COLLIDING, "policy"),
      COLLIDING,
      WHAT,
      probes.deniz.cookie,
    );
    expect(viaProjectRoute.body).toBe(`No project at projects/${COLLIDING}.`);
  });

  /**
   * Single fetch appends `.data` to the LAST path segment, so the layout route's
   * own wire address is `/projects/<slug>.data` — the slug segment itself
   * carries the suffix. Missing that form would downgrade the layout's refusal
   * to the bare "Not found.", which no longer matches the child loaders' bytes
   * and reintroduces an oracle by DIFFERENCE.
   */
  it("recognizes the layout's own `/projects/<slug>.data` address", async () => {
    const res = await callGuard(
      `/projects/${SLUG}.data?_routes=routes/project`,
      SLUG,
      WHAT,
      probes.deniz.cookie,
    );
    expect(res.status).toBe(404);
    expect(res.body).toBe(UNKNOWN_SLUG_404);
  });
});

describe("authentication is resolved before membership", () => {
  /**
   * A signed-out visitor is not a probe — they get the normal login flow, with
   * the `.data` suffix stripped so they land on a navigable page. Answering
   * them 404 instead would make every project link a dead end for anyone whose
   * session merely expired.
   */
  it("sends a signed-out caller to /login rather than answering 404", async () => {
    const res = await callGuard(childSurfaceUrl(SLUG, "policy"), SLUG, WHAT);
    expect(res.status).toBe(302);
    expect(res.location).toBe(
      `/login?returnTo=${encodeURIComponent(`/projects/${SLUG}/policy`)}`,
    );
    expect(res.userId).toBeNull();
    expect(res.body).not.toContain(SLUG);
  });

  /**
   * Disabling an account has to take effect on the SESSION that account is
   * already holding, not merely at the next sign-in. The contrast is the point:
   * the same cookie, the same project, admin membership intact — the only thing
   * that changed is `users.disabled`, and the guard stops serving.
   */
  it("stops serving a live session the moment its account is disabled", async () => {
    const before = await callGuard(
      childSurfaceUrl(SLUG, "policy"),
      SLUG,
      WHAT,
      probes.banned.cookie,
    );
    expect(before.status).toBe(200);
    expect(before.userId).toBe(probes.banned.id);

    const { updateUserFields } = await import("~/server/auth/user-store.server");
    updateUserFields(app.db, probes.banned.id, { disabled: true });

    const after = await callGuard(
      childSurfaceUrl(SLUG, "policy"),
      SLUG,
      WHAT,
      probes.banned.cookie,
    );
    expect(after.status).toBe(302);
    expect(after.location).toMatch(/^\/login\?returnTo=/);
    expect(after.userId).toBeNull();
  });
});

/**
 * R6-3 freezes MUTATIONS on an archived project, not reads — timelines, policy
 * and audit stay legible so an archived project can be understood and restored.
 * This guard therefore passes `allowArchived: true`; drop it and
 * `assertProjectAction` throws the 409 archived error, which this module's
 * catch cannot tell apart from a membership refusal and converts into the same
 * 404 — telling a project's own members that their archived project does not
 * exist.
 */
describe("archived projects stay readable to their members (R6-3)", () => {
  it("a member still reaches the config surfaces of an archived project", async () => {
    const { assertProjectAction } = await import(
      "./project-authority.server"
    );
    // Fixture proof: without the exemption this project's read really is
    // refused, so the pass below is the exemption working and not an
    // accidentally-live project.
    expect(() =>
      assertProjectAction(
        app.db,
        "any-member",
        FROZEN,
        { userId: probes.elif.id, label: "elif" },
        WHAT,
      ),
    ).toThrowError(/archived/i);

    const res = await callGuard(
      childSurfaceUrl(FROZEN, "policy"),
      FROZEN,
      WHAT,
      probes.elif.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.userId).toBe(probes.elif.id);
  });

  it("and a non-member is refused there in the same words as anywhere else", async () => {
    const res = await callGuard(
      childSurfaceUrl(FROZEN, "policy"),
      FROZEN,
      WHAT,
      probes.deniz.cookie,
    );
    // Archived-ness must not become the oracle the 403 used to be.
    expect(res.status).toBe(404);
    expect(res.body).toBe(`No project at projects/${FROZEN}.`);
  });
});

/**
 * The client is deliberately told nothing, so the audit log is the ONLY place
 * the real answer survives. Two rows carry it: `project.authority.denied`
 * (P13-D-8 — NFR10's "unauthorized action attempts", the one audited category
 * that used to have no row anywhere) and `project.org_admin.override` (D2 —
 * EVERY emergency grant leaves a row, never a silent one).
 */
describe("the refusal is silent to the client, never to the audit log", () => {
  it("records a refused non-member, with the surface `what` the bytes withheld", async () => {
    const res = await callGuard(
      childSurfaceUrl(SLUG, "policy"),
      SLUG,
      WHAT,
      probes.denyProbe.cookie,
    );
    expect(res.status).toBe(404);

    const rows = listAuditEvents(app.db, {
      action: "project.authority.denied",
    }).filter((row) => row.actorUserId === probes.denyProbe.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectSlug: SLUG,
      subjectKind: "project",
      subjectId: SLUG,
    });
    // `what` never reached the client; it has to be here or the row cannot say
    // WHICH surface was probed.
    expect(rows[0]!.details).toMatchObject({
      action: "any-member",
      what: WHAT,
      memberRole: null,
    });
  });

  it("passes an org admin who is NOT a member as the audited D2 override", async () => {
    const res = await callGuard(
      childSurfaceUrl(SLUG, "policy"),
      SLUG,
      WHAT,
      probes.orgAdmin.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.userId).toBe(probes.orgAdmin.id);

    const rows = listAuditEvents(app.db, {
      action: "project.org_admin.override",
    }).filter((row) => row.actorUserId === probes.orgAdmin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectSlug: SLUG, subjectId: SLUG });
    // memberRole null is the fact that makes this an OVERRIDE and not a
    // membership pass — an org admin who is also a member leaves no row.
    expect(rows[0]!.details).toMatchObject({
      action: "any-member",
      what: WHAT,
      memberRole: null,
    });
  });

  /**
   * The mirror image of the ruling: identical on the wire, distinguishable in
   * the log. A slug that has no project.md is refused before authority is ever
   * resolved, so scanning invented slugs writes no `project.authority.denied`
   * rows — the deliberate probe at a REAL project stays visible instead of
   * being buried under a scan.
   */
  it("writes no authority row for a slug that does not exist", async () => {
    const ghostRows = listAuditEvents(app.db, { limit: 500 }).filter(
      (row) => row.subjectId === GHOST || row.projectSlug === GHOST,
    );
    expect(ghostRows).toEqual([]);
  });
});
