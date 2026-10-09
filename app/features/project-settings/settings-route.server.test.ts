import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  routeArgs,
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";
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

let app: AppTestContext;
/**
 * The seeded people this file drives the settings surface as: arda and elif
 * are project admins, murat a maintainer, selin a contributor, deniz a
 * registered non-member.
 */
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
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
  return loader(routeArgs(request, { slug }, SETTINGS_PATTERN));
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
  return action(routeArgs(request, { slug }, SETTINGS_PATTERN));
}

/**
 * `.get()` hands back untyped SQLite cells — values TypeScript knows nothing
 * about — so they are parsed where they enter.
 */
const stagesJsonRowSchema = z.object({ stages_json: z.string() });
const archivedRowSchema = z.object({ archived: z.number() });

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

  it("rejects stage mutations from a maintainer (edit-policy is admin-only)", async () => {
    // The tier just below the grant: a contributor would be refused by a
    // maintainer-level gate too.
    const result = actionOutcome(
      await postAction(ids.murat, { intent: "add-stage" }),
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

  it("invites an unregistered email by creating an account seated as Viewer", async () => {
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
    // Restore Selin as the contributor the later cases drive: the settings
    // invite always seats a Viewer, so her role goes back through the Policy
    // page's writer.
    await postAction(ids.arda, {
      intent: "invite",
      name: "Selin Aksoy",
      email: "selin@viberr.dev",
    });
    const { setMemberRole } = await import(
      "~/features/policy/policy-actions.server"
    );
    await setMemberRole(
      app.db,
      { projectSlug: "viberr-core", targetUserId: ids.selin, role: "contributor" },
      { userId: ids.arda, label: "arda@viberr.dev" },
    );
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

  it("grant-scope: a contributor is refused; an admin with no PAT gets the typed copy", async () => {
    const denied = actionOutcome(
      await postAction(ids.selin, { intent: "grant-scope" }),
    );
    // Selin is a contributor, below the admin|maintainer tier.
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

  /**
   * Ruling 15(b): a project slug is one folder under `projects/`. The slug
   * arrives from the URL decoded (a `%2F` is a `/`), so it can hold a path,
   * and `delete-project` builds the folder it `rmSync`s from `projectDir(slug)`.
   * A person holding `attach-file` (contributor and up) can put a `project.md`
   * into a task's own `attachments/`, and that folder, named as a slug, then
   * answers the membership guard as a project with whatever members the planted
   * file lists — here one naming arda admin, so the ONLY thing between the
   * request and the `rmSync` is the slug's containment.
   */
  it("ruling 15(b): a project.md planted in a task's attachments is not a project the delete door will erase", async () => {
    const attachments = path.join(
      app.dataRoot,
      "projects/viberr-core/tasks/VIB-142/attachments",
    );
    mkdirSync(attachments, { recursive: true });
    // A real, parseable project.md — viberr-core's own, renamed — so the guard
    // reads arda as an admin of this "project": the 404 is the containment, not
    // a missing or unreadable file (which would 404 for another reason).
    const planted = projectMd().replace(/^name: .*$/m, "name: Forged");
    writeFileSync(path.join(attachments, "project.md"), planted);

    const slug = "viberr-core/tasks/VIB-142/attachments";
    let status: number | undefined;
    try {
      await postAction(ids.arda, { intent: "delete-project", confirmName: "Forged" }, slug);
    } catch (thrown) {
      // SAFETY: the containment refusal is react-router's `data(message,
      // { status })`, thrown by `requireVisibleProject`, which carries the
      // status under `init` (as the task-attachment and other route suites read
      // a thrown refusal); any other throw leaves `status` undefined and fails.
      status = (thrown as { init?: { status?: number } }).init?.status;
    }
    // CANARY: drop the containment in `projectDir` and this is a 302 redirect —
    // the planted project.md passes the guard and `rmSync` takes the folder.
    expect(status).toBe(404);
    expect(existsSync(path.join(attachments, "project.md"))).toBe(true);
    expect(existsSync(path.join(app.dataRoot, "projects/viberr-core/project.md"))).toBe(true);
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

describe("E9: change-repo + set-branch-cleanup authority gates", () => {
  it("set-branch-cleanup is edit-policy (admin): a contributor is refused, an admin round-trips", async () => {
    const denied = actionOutcome(
      await postAction(ids.selin, { intent: "set-branch-cleanup", enabled: "0" }),
    );
    expect(denied.status).toBe(403);

    const ok = actionOutcome(
      await postAction(ids.arda, { intent: "set-branch-cleanup", enabled: "0" }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.toast).toMatch(/kept on GitHub/);

    // Round-trip the other way so the test leaves the default (on) in place.
    await postAction(ids.arda, { intent: "set-branch-cleanup", enabled: "1" });
  });

  it("change-repo is edit-policy (admin): a maintainer is refused before any GitHub probe", async () => {
    // Murat is a maintainer, above contributor but below the edit-policy tier
    // this destructive change demands — refused before it can touch GitHub.
    const denied = actionOutcome(
      await postAction(ids.murat, {
        intent: "change-repo",
        repo: "akin-ozer/viberr",
        confirmFootprint: "1",
      }),
    );
    expect(denied.status).toBe(403);
  });
});

/**
 * Ruling 89 (pass 36, G36-3): the Settings table posts its rules as one JSON
 * field; the route decodes it, the shared writer validates and audits, and
 * the loader hands the resolved rules (and the agents a rule may name) back.
 */
describe("set-required-reviewers (ruling 89)", () => {
  it("round-trips the table through the action into project.md and the loader; a maintainer is refused", async () => {
    const saved = actionOutcome(
      await postAction(ids.arda, {
        intent: "set-required-reviewers",
        rules: JSON.stringify([{ stageId: "review", profileId: "reviewer" }]),
      }),
    );
    expect(saved.ok).toBe(true);
    expect(saved.toast).toBe("Required reviewers saved: Reviewer at Review");
    expect(projectMd()).toContain("requiredReviewers:");
    const { loader } = await import("~/routes/project.settings");
    const { cookie } = await app.cookieFor(ids.arda);
    // SAFETY: as in the loader cases above — the loader reads `request` and
    // `params` only; the framework's `context` is never touched.
    const { view } = await loader({
      request: app.request("/projects/viberr-core/settings", { cookie }),
      params: { slug: "viberr-core" },
      context: {},
    } as never);
    expect(view.requiredReviewers).toEqual([
      { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Reviewer" },
    ]);
    expect(view.reviewerCandidates.map((c) => c.id)).toContain("reviewer");

    const denied = actionOutcome(
      await postAction(ids.murat, { intent: "set-required-reviewers", rules: "[]" }),
    );
    expect(denied.status).toBe(403);

    const unreadable = actionOutcome(
      await postAction(ids.arda, { intent: "set-required-reviewers", rules: "not json" }),
    );
    expect(unreadable.status).toBe(400);
    expect(unreadable.error).toContain("could not be read");

    const cleared = actionOutcome(
      await postAction(ids.arda, { intent: "set-required-reviewers", rules: "[]" }),
    );
    expect(cleared.toast).toBe("Required reviewers cleared");
  });
});

/**
 * Ruling 61 (F39-23): leases reach a human surface.
 *
 * Before this, `set_file_leases` was a controller tool and nothing else: no
 * route, no form, no panel. A delivery refused by a lease told the person to
 * "clear the lease once VIB-142 has landed" and there was nowhere to do it.
 */
describe("set-file-leases (ruling 61)", () => {
  it("round-trips a lease through the action into project.md and back out of the loader", async () => {
    const saved = actionOutcome(
      await postAction(ids.arda, {
        intent: "set-file-leases",
        leases: JSON.stringify([
          { paths: ["package-lock.json", "make/**"], taskKey: "VIB-142", reason: "owns the lockfile" },
        ]),
      }),
    );
    expect(saved.ok).toBe(true);
    expect(projectMd()).toContain("fileLeases:");
    expect(projectMd()).toContain("package-lock.json");

    const { loader } = await import("~/routes/project.settings");
    const { cookie } = await app.cookieFor(ids.arda);
    // SAFETY: as in the cases above — the loader reads `request` and `params`
    // only; the framework's `context` is never touched.
    const { view } = await loader({
      request: app.request("/projects/viberr-core/settings", { cookie }),
      params: { slug: "viberr-core" },
      context: {},
    } as never);
    // CANARY: drop `fileLeases` from the settings view and the panel has
    // nothing to render, which is the state this ruling found.
    expect(view.fileLeases).toEqual([
      {
        paths: ["package-lock.json", "make/**"],
        taskKey: "VIB-142",
        taskTitle: expect.any(String),
        reason: "owns the lockfile",
        spent: false,
      },
    ]);
    expect(view.leaseCandidates.map((c) => c.key)).toContain("VIB-142");

    // Same authority as every other project policy, and the same refusals.
    const denied = actionOutcome(
      await postAction(ids.murat, { intent: "set-file-leases", leases: "[]" }),
    );
    expect(denied.status).toBe(403);

    const unreadable = actionOutcome(
      await postAction(ids.arda, { intent: "set-file-leases", leases: "not json" }),
    );
    expect(unreadable.status).toBe(400);
    expect(unreadable.error).toContain("could not be read");

    // The writer's own board check reaches the form, in its own words.
    const ghost = actionOutcome(
      await postAction(ids.arda, {
        intent: "set-file-leases",
        leases: JSON.stringify([{ paths: ["x"], taskKey: "VIB-99999", reason: "" }]),
      }),
    );
    expect(ghost.status).toBe(400);
    expect(ghost.error).toContain("is not a task in this project");

    const cleared = actionOutcome(
      await postAction(ids.arda, { intent: "set-file-leases", leases: "[]" }),
    );
    expect(cleared.ok).toBe(true);
  });
});

/**
 * Ruling 17 (F40-52): the project's gates are declared on Settings, through
 * the writer the controller's `set_project_gates` calls. Before this the list
 * was prose in a knowledge base that every directive re-typed.
 */
describe("set-project-gates (ruling 17)", () => {
  it("round-trips the gate list into project.md and the loader, audited, with the writer's refusals", async () => {
    const saved = actionOutcome(
      await postAction(ids.arda, {
        intent: "set-project-gates",
        gates: JSON.stringify([
          { name: "install", command: "npm ci", timeoutSeconds: null },
          { name: "build", command: "npm run build", timeoutSeconds: 900 },
        ]),
      }),
    );
    expect(saved.ok).toBe(true);
    expect(saved.toast).toContain("Gates saved: install, build");
    // CANARY: drop the `gates` write in setProjectGates and project.md never
    // carries the list the runner reads.
    expect(projectMd()).toContain("gates:");
    expect(projectMd()).toContain("npm run build");
    const { view } = await runLoader(ids.arda);
    expect(view.gates).toEqual([
      { name: "install", command: "npm ci" },
      { name: "build", command: "npm run build", timeoutSeconds: 900 },
    ]);
    const audit = listAuditEvents(app.db, { action: "project.gates.updated" });
    expect(audit.at(-1)?.details).toMatchObject({ count: 2 });

    // The same list again writes nothing and audits nothing.
    const unchanged = actionOutcome(
      await postAction(ids.arda, {
        intent: "set-project-gates",
        gates: JSON.stringify([
          { name: "install", command: "npm ci" },
          { name: "build", command: "npm run build", timeoutSeconds: 900 },
        ]),
      }),
    );
    expect(unchanged.toast).toBe("Gates unchanged: install, build");
    expect(listAuditEvents(app.db, { action: "project.gates.updated" })).toHaveLength(audit.length);

    // Project policy: a maintainer is refused.
    const denied = actionOutcome(
      await postAction(ids.murat, { intent: "set-project-gates", gates: "[]" }),
    );
    expect(denied.status).toBe(403);

    const duplicate = actionOutcome(
      await postAction(ids.arda, {
        intent: "set-project-gates",
        gates: JSON.stringify([
          { name: "build", command: "a" },
          { name: "Build", command: "b" },
        ]),
      }),
    );
    expect(duplicate.status).toBe(400);
    expect(duplicate.error).toContain('Two gates are named "Build"');

    const timeout = actionOutcome(
      await postAction(ids.arda, {
        intent: "set-project-gates",
        gates: JSON.stringify([{ name: "build", command: "a", timeoutSeconds: 99999 }]),
      }),
    );
    expect(timeout.status).toBe(400);
    expect(timeout.error).toContain("1 to 3600");

    const cleared = actionOutcome(
      await postAction(ids.arda, { intent: "set-project-gates", gates: "[]" }),
    );
    expect(cleared.toast).toBe("Gates cleared: acceptance no longer waits on them");
    // A project that declares none carries no key at all.
    expect(projectMd()).not.toContain("gates:");
  });
});
