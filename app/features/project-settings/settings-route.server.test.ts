import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RouterContextProvider } from "react-router";
import { z } from "zod";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import { roleCan } from "~/shared/rbac";
import type { SettingsViewData } from "./settings-query.server";

/**
 * Route-level tests for /projects/:slug/settings: loader read model,
 * identity save, stage-editor mutations (add/remove/reorder/rename →
 * project.md → projection), membership CRUD with the self/last-admin
 * guards, grant-scope RBAC + degraded no-PAT result,
 * and the danger-zone delete (typed-name confirmation, run against a stub
 * project).
 */

/** The seeded people this file drives the settings surface as. */
interface SeedUserIds {
  arda: string;
  elif: string;
  murat: string;
  selin: string;
  deniz: string;
}

let app: AppTestContext;
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // project admin
    elif: findUserByEmail(app.db, "elif@viberr.dev")!.id, // project admin
    murat: findUserByEmail(app.db, "murat@viberr.dev")!.id, // maintainer
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // contributor
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id, // registered non-member
  };
});
afterAll(() => app.cleanup());

/** Un-interpolated match pattern, the way React Router reports it. */
const SETTINGS_PATTERN = "/projects/:slug/settings";

/**
 * A server loader/action is handed the request, the match pattern, the dynamic
 * params and a middleware context. Building the whole envelope rather than a
 * partial stand-in is what keeps the direct calls below type-checked against
 * the real route signatures.
 */
async function runLoader(
  userId: string,
  slug = "viberr-core",
): Promise<{ view: SettingsViewData }> {
  const { loader } = await import("~/routes/project.settings");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(`/projects/${slug}/settings`, { cookie });
  return loader({
    request,
    url: new URL(request.url),
    params: { slug },
    pattern: SETTINGS_PATTERN,
    context: new RouterContextProvider(),
  });
}

async function postAction(
  userId: string,
  fields: Record<string, string>,
  slug = "viberr-core",
) {
  const { action } = await import("~/routes/project.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ ...fields, _csrf: csrf });
  const request = app.request(`/projects/${slug}/settings`, {
    method: "POST",
    cookie,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return action({
    request,
    url: new URL(request.url),
    params: { slug },
    pattern: SETTINGS_PATTERN,
    context: new RouterContextProvider(),
  });
}

/**
 * `.get()` hands back untyped SQLite cells, and a guard refuses an action by
 * THROWING React Router's `data(message, { status })` — both arrive as values
 * TypeScript knows nothing about, so both are parsed where they enter.
 */
const stagesJsonRowSchema = z.object({ stages_json: z.string() });
const archivedRowSchema = z.object({ archived: z.number() });
const thrownRefusalSchema = z.object({
  init: z.object({ status: z.number() }).nullish(),
  data: z.unknown(),
});

type SettingsActionResult = Awaited<
  ReturnType<typeof import("~/routes/project.settings").action>
>;

/**
 * The action answers on one of three envelopes: a bare success object, a
 * `data(payload, { status })` refusal, or the delete branch's redirect. A test
 * that reads a single member has to say which envelope it expects, so read it
 * through this projection — a member the actual branch does not carry comes
 * back `undefined` and fails its assertion, rather than being asserted into
 * existence.
 */
function actionOutcome(result: SettingsActionResult) {
  return {
    ok: "ok" in result ? result.ok : undefined,
    toast: "toast" in result ? result.toast : undefined,
    stageId: "stageId" in result ? result.stageId : undefined,
    status: "init" in result ? result.init?.status : undefined,
    error: "data" in result ? result.data.error : undefined,
    redirected: result instanceof Response ? result : undefined,
  };
}

function projectMd(): string {
  return readFileSync(
    path.join(app.dataRoot, "projects/viberr-core/project.md"),
    "utf8",
  );
}

describe("loader", () => {
  it("returns identity, stages + counts, members, credential health", async () => {
    const { view } = await runLoader(ids.arda);
    expect(view.project).toMatchObject({
      slug: "viberr-core",
      name: "Viberr Core",
      prefix: "VIB",
      repo: "akin-ozer/viberr",
      taskFilePattern: "projects/viberr-core/tasks/<key>/task.md",
    });
    expect(view.stages.map((s) => s.id)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      "done",
    ]);
    // Seed: 2 review tasks (VIB-142, VIB-145), 2 done, 2 triage, 3 impl, 1 ready.
    expect(view.stageCounts.review).toBe(2);
    expect(view.members).toHaveLength(4);
    // Credential health (honest empty slate): a credentialPolicy with no bound
    // PAT reports source 'none' (no fabricated card), while the seeded VIB-142
    // violation still surfaces on the chip.
    expect(view.credential.source).toBe("none");
    expect(view.credential.scopes.find((s) => !s.ok)).toMatchObject({
      id: "pull_request:write",
      flaggedTaskKey: "VIB-142",
    });
  });
});

describe("identity", () => {
  it("saves name/prefix/description to project.md + audits", async () => {
    const result = await postAction(ids.arda, {
      intent: "save-project",
      name: "Viberr Core",
      prefix: "VIB",
      description: "Updated description for the settings test.",
    });
    expect(result).toEqual({ ok: true, toast: "Project settings saved" });
    const { view } = await runLoader(ids.arda);
    expect(view.project.description).toBe(
      "Updated description for the settings test.",
    );
    expect(
      listAuditEvents(app.db, { action: "project.settings.updated" })[0],
    ).toMatchObject({ details: { fields: ["description"] } });
  });

  it("rejects a non-letter prefix", async () => {
    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "save-project",
        name: "Viberr Core",
        prefix: "V1B",
        description: "x",
      }),
    );
    expect(result.status).toBe(400);
  });

  it("rejects non-admins (maintainer)", async () => {
    const result = actionOutcome(
      await postAction(ids.murat, {
        intent: "save-project",
        name: "X",
        prefix: "VIB",
        description: "x",
      }),
    );
    expect(result.status).toBe(403);
  });
});

describe("stage editor", () => {
  let newStageId = "";

  it("add-stage inserts before done, returns the id for inline rename", async () => {
    // Name-first (2026-07-28 ruling): the intent carries the name; the old
    // no-name POST minted a stage called "New stage" and is now refused.
    const refused = actionOutcome(
      await postAction(ids.arda, { intent: "add-stage" }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/name is required/i);

    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "add-stage",
        name: "Hardening pass",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.toast).toBe(
      '"Hardening pass" added. It appears on the board immediately',
    );
    newStageId = result.stageId ?? "";

    const { view } = await runLoader(ids.arda);
    expect(view.stages).toHaveLength(6);
    expect(view.stages[4]).toMatchObject({
      id: newStageId,
      name: "Hardening pass",
    });
    expect(view.stages[5]!.id).toBe("done");
    // Board columns read the same projection (stages_json).
    const row = stagesJsonRowSchema.parse(
      app.db
        .prepare(`SELECT stages_json FROM projects WHERE slug = 'viberr-core'`)
        .get(),
    );
    expect(JSON.parse(row.stages_json).map((s: { id: string }) => s.id)).toEqual(
      ["triage", "ready", "impl", "review", newStageId, "done"],
    );
  });

  it("rename-stage commits with the verbatim toast", async () => {
    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "rename-stage",
        stageId: newStageId,
        name: "Hardening",
      }),
    );
    expect(result.toast).toBe(
      'Stage renamed to "Hardening". Board and policy follow',
    );
    const { view } = await runLoader(ids.arda);
    expect(view.stages.find((s) => s.id === newStageId)!.name).toBe("Hardening");
  });

  it("reorder normalizes triage-first / done-last server-side", async () => {
    // Hostile client order: done first, triage last.
    const { view } = await runLoader(ids.arda);
    const shuffled = [
      "done",
      newStageId,
      "review",
      "impl",
      "ready",
      "triage",
    ].filter((id) => view.stages.some((s) => s.id === id));
    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "reorder-stages",
        orderedIds: shuffled.join(","),
      }),
    );
    expect(result.toast).toBe("Stage order updated. Board columns follow");
    const after = await runLoader(ids.arda);
    const orderedIds = after.view.stages.map((s) => s.id);
    expect(orderedIds[0]).toBe("triage");
    expect(orderedIds[orderedIds.length - 1]).toBe("done");
    expect(orderedIds).toContain(newStageId);
    // Restore the canonical order for later tests.
    await postAction(ids.arda, {
      intent: "reorder-stages",
      orderedIds: ["triage", "ready", "impl", "review", newStageId, "done"].join(","),
    });
  });

  it("remove-stage: locked + non-empty guards re-checked server-side", async () => {
    const locked = actionOutcome(
      await postAction(ids.arda, {
        intent: "remove-stage",
        stageId: "triage",
      }),
    );
    expect(locked.status).toBe(409);
    expect(locked.error).toBe("Triage can't be removed: it's the entry point");

    const nonEmpty = actionOutcome(
      await postAction(ids.arda, {
        intent: "remove-stage",
        stageId: "review",
      }),
    );
    expect(nonEmpty.status).toBe(409);
    expect(nonEmpty.error).toBe("Move 2 tasks out of Review first");

    const ok = await postAction(ids.arda, {
      intent: "remove-stage",
      stageId: newStageId,
    });
    expect(ok).toEqual({ ok: true, toast: 'Stage "Hardening" removed' });
    const { view } = await runLoader(ids.arda);
    expect(view.stages).toHaveLength(5);
  });

  it("rejects stage mutations from non-admins", async () => {
    const result = actionOutcome(
      await postAction(ids.selin, { intent: "add-stage" }),
    );
    expect(result.status).toBe(403);
  });
});

describe("members", () => {
  it("invites a registered user as Viewer — an invite IS the membership (X15: no decorative status)", async () => {
    const result = await postAction(ids.arda, {
      intent: "invite",
      name: "Deniz Şahin",
      email: "deniz@viberr.dev",
    });
    // N20-6: no mailer exists — the toast names what happened, not a sent email.
    expect(result).toEqual({
      ok: true,
      toast: "Added deniz@viberr.dev, who joins as Viewer",
    });
    const { view } = await runLoader(ids.arda);
    const deniz = view.members.find((m) => m.userId === ids.deniz)!;
    expect(deniz).toMatchObject({ role: "viewer" });
    // No decorative `status: invited` is written any more.
    expect(projectMd()).not.toContain("status: invited");
  });

  it("rejects a duplicate invite", async () => {
    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "invite",
        name: "Deniz Şahin",
        email: "deniz@viberr.dev",
      }),
    );
    expect(result.status).toBe(409);
    expect(result.error).toBe("deniz@viberr.dev is already a member");
  });

  it("invites an unregistered email by creating a passwordless whitelist user", async () => {
    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "invite",
        name: "Yeni Kişi",
        email: "yeni@viberr.dev",
      }),
    );
    expect(result.ok).toBe(true);
    const { findUserByEmail } = await import(
      "~/server/auth/user-store.server"
    );
    const created = findUserByEmail(app.db, "yeni@viberr.dev");
    expect(created).not.toBeNull();
    const { view } = await runLoader(ids.arda);
    expect(
      view.members.find((m) => m.userId === created!.id),
    ).toMatchObject({ role: "viewer", name: "Yeni Kişi" });
    // Clean up the seat.
    await postAction(ids.arda, {
      intent: "remove-member",
      userId: created!.id,
    });
  });

  it("removing an invited member uses the standard removed toast (X15)", async () => {
    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "remove-member",
        userId: ids.deniz,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.toast).toContain("removed from");
  });

  it("self-removal is refused server-side", async () => {
    const result = actionOutcome(
      await postAction(ids.arda, {
        intent: "remove-member",
        userId: ids.arda,
      }),
    );
    expect(result.status).toBe(409);
    expect(result.error).toBe("You can't remove yourself from Viberr Core");
  });

  it("removing an active member works with the removal toast + audit", async () => {
    const remove = await postAction(ids.arda, {
      intent: "remove-member",
      userId: ids.selin,
    });
    // A3 (pass 23): Selin owns a task in the demo seed; removing her RELEASES it
    // (clears the owner seat) so nothing strands on a ghost owner, and the toast
    // discloses the reassignment the dialog copy promises.
    expect(remove).toEqual({
      ok: true,
      toast:
        "Selin Aksoy removed from Viberr Core. 1 owned task released for reassignment.",
    });
    expect(
      listAuditEvents(app.db, { action: "project.member.removed" })[0],
    ).toMatchObject({
      subjectId: ids.selin,
      projectSlug: "viberr-core",
      details: { tasksReleased: 1 },
    });
    // The release is auditable per task, and no task still names her as owner.
    expect(
      listAuditEvents(app.db, {
        action: "task.ownership.released_on_removal",
      }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      app.db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_projections
            WHERE project_slug = 'viberr-core' AND owner_user_id = ?`,
        )
        .get(ids.selin),
    ).toMatchObject({ n: 0 });
    // Restore Selin via invite + role change back to reviewer (Policy owns
    // roles; the settings invite always lands on Viewer).
    await postAction(ids.arda, {
      intent: "invite",
      name: "Selin Aksoy",
      email: "selin@viberr.dev",
    });
  });

  it("membership CRUD is admin-only", async () => {
    const result = actionOutcome(
      await postAction(ids.murat, {
        intent: "invite",
        name: "X Y",
        email: "x@viberr.dev",
      }),
    );
    expect(result.status).toBe(403);
  });
});

describe("grant-scope", () => {
  // P13-D-5: the "persists the repo-override flag" test lived here. The toggle,
  // the `taskRepoOverride` key and the `project.repo_override.changed` audit
  // action are deleted — nothing ever wrote `task.repo`, so the flag gated
  // nothing in either direction. One project, one repository.

  it("grant-scope: reviewer refused; admin with no PAT gets the typed copy", async () => {
    const denied = actionOutcome(
      await postAction(ids.selin, { intent: "grant-scope" }),
    );
    // Selin was re-invited as viewer above → still not admin|maintainer.
    expect(denied.status).toBe(403);

    const result = await postAction(ids.arda, { intent: "grant-scope" });
    expect(result).toEqual({
      ok: true,
      toast:
        "No GitHub credential configured. Connect a PAT before re-checking scopes.",
      result: "no_pat_configured",
    });
  });
});

describe("danger zone", () => {
  it("delete requires the typed project name", async () => {
    const result = actionOutcome(
      await postAction(
        ids.arda,
        { intent: "delete-project", confirmName: "nope" },
        "billing-service",
      ),
    );
    expect(result.status).toBe(400);
  });

  it("deletes a project for real: files gone, projections pruned, audited", async () => {
    const result = await postAction(
      ids.arda,
      { intent: "delete-project", confirmName: "Billing Service" },
      "billing-service",
    );
    expect(result).toBeInstanceOf(Response);
    const { redirected } = actionOutcome(result);
    expect(redirected?.status).toBe(302);
    expect(redirected?.headers.get("Location")).toBe("/");

    expect(
      existsSync(path.join(app.dataRoot, "projects/billing-service")),
    ).toBe(false);
    expect(
      app.db
        .prepare(`SELECT slug FROM projects WHERE slug = 'billing-service'`)
        .get(),
    ).toBeUndefined();
    expect(listAuditEvents(app.db, { action: "project.deleted" })[0]).toMatchObject(
      { subjectId: "billing-service" },
    );
  });

  it("a NON-MEMBER gets the unknown-slug 404, not a 403 (E2)", async () => {
    // Murat is not a member of deploy-pipeline at all, so the project is
    // invisible to him (R15-4) — this used to answer 403, which confirmed the
    // project exists. Admin-only-ness for actual members is covered by the
    // archive-project case below, where Murat IS a member and is told plainly.
    const thrown = thrownRefusalSchema.parse(
      await postAction(
        ids.murat,
        { intent: "delete-project", confirmName: "Deploy Pipeline" },
        "deploy-pipeline",
      ).catch((e) => e),
    );
    expect(thrown.init?.status).toBe(404);
    expect(String(thrown.data)).toBe("No project at projects/deploy-pipeline.");
  });
});

describe("archive-project", () => {
  it("maintainer is rejected (admin-only)", async () => {
    const result = actionOutcome(
      await postAction(ids.murat, {
        intent: "archive-project",
        archived: "true",
      }),
    );
    expect(result.status).toBe(403);
  });

  it("admin archives then restores — file + projection + audit follow", async () => {
    // Archive: project.md flag set, projection column follows, loader reflects.
    const archived = await postAction(ids.arda, {
      intent: "archive-project",
      archived: "true",
    });
    expect(archived).toMatchObject({ ok: true, archived: true });
    expect(projectMd()).toMatch(/archived: true/);
    expect(
      archivedRowSchema.parse(
        app.db
          .prepare(`SELECT archived FROM projects WHERE slug = 'viberr-core'`)
          .get(),
      ).archived,
    ).toBe(1);
    expect((await runLoader(ids.arda)).view.project.archived).toBe(true);

    expect(
      listAuditEvents(app.db, { action: "project.archived" })[0],
    ).toMatchObject({ subjectId: "viberr-core" });

    // Restore: flag cleared, projection back to 0, so later tests see it active.
    const restored = await postAction(ids.arda, {
      intent: "archive-project",
      archived: "false",
    });
    expect(restored).toMatchObject({ ok: true, archived: false });
    expect(
      archivedRowSchema.parse(
        app.db
          .prepare(`SELECT archived FROM projects WHERE slug = 'viberr-core'`)
          .get(),
      ).archived,
    ).toBe(0);
    expect(
      listAuditEvents(app.db, { action: "project.unarchived" })[0],
    ).toMatchObject({ subjectId: "viberr-core" });
  });
});

/**
 * F21-5 (live, Selin) — R19-11 / owner ruling Q-V1, PAT half, applied to the
 * OTHER surface that renders the credential.
 *
 * "A read-only Viewer must not see the Danger zone or the PAT." Pass 19 closed
 * it on `/projects/:slug/github` and this loader kept shipping the whole
 * `ProjectCredentialHealth` — label, masked tail, per-scope verdicts — to every
 * member, straight into a Viewer's document via single-fetch. The bar is the
 * SERVER's own: `grant-github-scope` (admin|maintainer), the ACTION_ROLES entry
 * this route's action already enforces on grant-scope / set-credential /
 * clear-credential, which is why a contributor is refused here for the same
 * reason a viewer is. `roleCan` reads that entry; nothing names a role.
 *
 * These assert the PAYLOAD, not the DOM: hiding the card leaves the tail in the
 * HTML, which is the exact form the pass-18 session reported it in.
 *
 * Runs last: it binds a PAT and adds a viewer to project.md.
 */
describe("F21-5: the settings loader withholds credential detail without the grant", () => {
  const MASKED = "····f215";
  const LABEL = "f21-5 fixture PAT";

  beforeAll(async () => {
    const { createPat, setProjectCredential } = await import(
      "~/server/secrets/pat-store.server"
    );
    const actor = { userId: ids.arda, label: "arda@viberr.dev" };
    const pat = createPat(
      app.db,
      { userId: ids.arda, label: LABEL, token: "ghp_f215fixturef215" },
      actor,
    );
    setProjectCredential(app.db, { projectSlug: "viberr-core", patId: pat.id }, actor);

    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    await updateProjectFile({ projectSlug: "viberr-core" }, (parsed) => {
      if (!parsed.frontmatter.members.some((m) => m.userId === ids.deniz)) {
        parsed.frontmatter.members.push({ userId: ids.deniz, role: "viewer" });
      }
    });
  });

  it("hands a MAINTAINER the real credential — the control case", async () => {
    const { view } = await runLoader(ids.murat);
    expect(view.credential.source).toBe("pat");
    expect(view.credential.masked).toBe(MASKED);
    expect(view.credential.label).toBe(LABEL);
    expect(view.credential.patId).not.toBeNull();
    expect(view.credential.scopes.length).toBeGreaterThan(0);
  });

  it("strips the tail, label, id and scope verdicts for a VIEWER", async () => {
    const { view } = await runLoader(ids.deniz);
    expect(view.credential.masked).toBeNull();
    expect(view.credential.label).toBeNull();
    expect(view.credential.patId).toBeNull();
    expect(view.credential.lastValidatedAt).toBeNull();
    expect(view.credential.validation).toBeNull();
    expect(view.credential.scopes).toEqual([]);
    expect(view.credential.openViolations).toEqual([]);
    // Nowhere in the payload, not merely on a hidden card.
    expect(JSON.stringify(view)).not.toContain("f215");
    expect(JSON.stringify(view)).not.toContain(LABEL);
    // The rest of the settings view is untouched — this is a redaction, not a
    // refusal (a viewer legitimately reads stages, members and the repo).
    expect(view.project.slug).toBe("viberr-core");
    expect(view.members.length).toBeGreaterThan(0);
    // Project POLICY survives: required scopes are the same list the Policy
    // page publishes to every member (see withoutCredentialDetail).
    expect(view.credential.requiredScopes.length).toBeGreaterThan(0);
  });

  it("strips it for a CONTRIBUTOR too — the grant is maintainer+", async () => {
    expect(roleCan("contributor", "grant-github-scope")).toBe(false);
    const { view } = await runLoader(ids.selin);
    expect(view.credential.masked).toBeNull();
    expect(view.credential.label).toBeNull();
    expect(view.credential.scopes).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("f215");
  });
});
