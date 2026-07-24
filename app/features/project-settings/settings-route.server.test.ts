import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { SettingsViewData } from "./settings-query.server";

/**
 * Route-level tests for /projects/:slug/settings: loader read model,
 * identity save, stage-editor mutations (add/remove/reorder/rename →
 * project.md → projection), membership CRUD with the self/last-admin
 * guards, the override toggle, grant-scope RBAC + degraded no-PAT result,
 * and the danger-zone delete (typed-name confirmation, run against a stub
 * project).
 */

let app: AppTestContext;
let ids: {
  arda: string;
  elif: string;
  murat: string;
  selin: string;
  deniz: string;
};

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

async function runLoader(
  userId: string,
  slug = "viberr-core",
): Promise<{ view: SettingsViewData }> {
  const { loader } = await import("~/routes/project.settings");
  const { cookie } = await app.cookieFor(userId);
  return (await loader({
    request: app.request(`/projects/${slug}/settings`, { cookie }),
    params: { slug },
    context: {},
  } as never)) as { view: SettingsViewData };
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
  return action({ request, params: { slug }, context: {} } as never);
}

function projectMd(): string {
  return readFileSync(
    path.join(app.dataRoot, "projects/viberr-core/project.md"),
    "utf8",
  );
}

describe("loader", () => {
  it("returns identity, stages + counts, members, credential health, override", async () => {
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
    expect(view.repoOverride).toBe(true); // default when the key is absent
  });
});

describe("identity", () => {
  it("saves name/prefix/description to project.md + audits", async () => {
    const result = (await postAction(ids.arda, {
      intent: "save-project",
      name: "Viberr Core",
      prefix: "VIB",
      description: "Updated description for the settings test.",
    })) as { ok: boolean; toast: string };
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
    const result = (await postAction(ids.arda, {
      intent: "save-project",
      name: "Viberr Core",
      prefix: "V1B",
      description: "x",
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(400);
  });

  it("rejects non-admins (maintainer)", async () => {
    const result = (await postAction(ids.murat, {
      intent: "save-project",
      name: "X",
      prefix: "VIB",
      description: "x",
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });
});

describe("stage editor", () => {
  let newStageId = "";

  it("add-stage inserts before done, returns the id for inline rename", async () => {
    const result = (await postAction(ids.arda, { intent: "add-stage" })) as {
      ok: boolean;
      toast: string;
      stageId: string;
    };
    expect(result.ok).toBe(true);
    expect(result.toast).toBe("Stage added — it appears on the board immediately");
    newStageId = result.stageId;

    const { view } = await runLoader(ids.arda);
    expect(view.stages).toHaveLength(6);
    expect(view.stages[4]).toMatchObject({ id: newStageId, name: "New stage" });
    expect(view.stages[5]!.id).toBe("done");
    // Board columns read the same projection (stages_json).
    const row = app.db
      .prepare(`SELECT stages_json FROM projects WHERE slug = 'viberr-core'`)
      .get() as { stages_json: string };
    expect(JSON.parse(row.stages_json).map((s: { id: string }) => s.id)).toEqual(
      ["triage", "ready", "impl", "review", newStageId, "done"],
    );
  });

  it("rename-stage commits with the verbatim toast", async () => {
    const result = (await postAction(ids.arda, {
      intent: "rename-stage",
      stageId: newStageId,
      name: "Hardening",
    })) as { ok: boolean; toast: string };
    expect(result.toast).toBe(
      'Stage renamed to "Hardening" — board and policy follow',
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
    const result = (await postAction(ids.arda, {
      intent: "reorder-stages",
      orderedIds: shuffled.join(","),
    })) as { ok: boolean; toast: string };
    expect(result.toast).toBe("Stage order updated — board columns follow");
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
    const locked = (await postAction(ids.arda, {
      intent: "remove-stage",
      stageId: "triage",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(locked.init?.status).toBe(409);
    expect(locked.data?.error).toBe(
      "Triage can't be removed — it's the entry point",
    );

    const nonEmpty = (await postAction(ids.arda, {
      intent: "remove-stage",
      stageId: "review",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(nonEmpty.init?.status).toBe(409);
    expect(nonEmpty.data?.error).toBe("Move 2 tasks out of Review first");

    const ok = (await postAction(ids.arda, {
      intent: "remove-stage",
      stageId: newStageId,
    })) as { ok: boolean; toast: string };
    expect(ok).toEqual({ ok: true, toast: 'Stage "Hardening" removed' });
    const { view } = await runLoader(ids.arda);
    expect(view.stages).toHaveLength(5);
  });

  it("rejects stage mutations from non-admins", async () => {
    const result = (await postAction(ids.selin, { intent: "add-stage" })) as {
      init?: { status?: number };
    };
    expect(result.init?.status).toBe(403);
  });
});

describe("members", () => {
  it("invites a registered user as Viewer — an invite IS the membership (X15: no decorative status)", async () => {
    const result = (await postAction(ids.arda, {
      intent: "invite",
      name: "Deniz Şahin",
      email: "deniz@viberr.dev",
    })) as { ok: boolean; toast: string };
    expect(result).toEqual({
      ok: true,
      toast: "Invite sent to deniz@viberr.dev · joins as Viewer",
    });
    const { view } = await runLoader(ids.arda);
    const deniz = view.members.find((m) => m.userId === ids.deniz)!;
    expect(deniz).toMatchObject({ role: "viewer" });
    // No decorative `status: invited` is written any more.
    expect(projectMd()).not.toContain("status: invited");
  });

  it("rejects a duplicate invite", async () => {
    const result = (await postAction(ids.arda, {
      intent: "invite",
      name: "Deniz Şahin",
      email: "deniz@viberr.dev",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(result.init?.status).toBe(409);
    expect(result.data?.error).toBe("deniz@viberr.dev is already a member");
  });

  it("invites an unregistered email by creating a passwordless whitelist user", async () => {
    const result = (await postAction(ids.arda, {
      intent: "invite",
      name: "Yeni Kişi",
      email: "yeni@viberr.dev",
    })) as { ok: boolean; toast: string };
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
    const result = (await postAction(ids.arda, {
      intent: "remove-member",
      userId: ids.deniz,
    })) as { ok: boolean; toast: string };
    expect(result.ok).toBe(true);
    expect(result.toast).toContain("removed from");
  });

  it("self-removal is refused server-side", async () => {
    const result = (await postAction(ids.arda, {
      intent: "remove-member",
      userId: ids.arda,
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(result.init?.status).toBe(409);
    expect(result.data?.error).toBe("You can't remove yourself from Viberr Core");
  });

  it("removing an active member works with the removal toast + audit", async () => {
    const remove = (await postAction(ids.arda, {
      intent: "remove-member",
      userId: ids.selin,
    })) as { ok: boolean; toast: string };
    expect(remove).toEqual({
      ok: true,
      toast: "Selin Aksoy removed from Viberr Core",
    });
    expect(
      listAuditEvents(app.db, { action: "project.member.removed" })[0],
    ).toMatchObject({ subjectId: ids.selin, projectSlug: "viberr-core" });
    // Restore Selin via invite + role change back to reviewer (Policy owns
    // roles; the settings invite always lands on Viewer).
    await postAction(ids.arda, {
      intent: "invite",
      name: "Selin Aksoy",
      email: "selin@viberr.dev",
    });
  });

  it("membership CRUD is admin-only", async () => {
    const result = (await postAction(ids.murat, {
      intent: "invite",
      name: "X Y",
      email: "x@viberr.dev",
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });
});

describe("override + grant-scope", () => {
  it("persists the repo-override flag in project.md", async () => {
    const off = (await postAction(ids.arda, {
      intent: "override",
      enabled: "false",
    })) as { ok: boolean; toast: string };
    expect(off.toast).toBe("Task-level repo override disabled");
    expect((await runLoader(ids.arda)).view.repoOverride).toBe(false);
    expect(projectMd()).toContain("taskRepoOverride: false");

    const on = (await postAction(ids.arda, {
      intent: "override",
      enabled: "true",
    })) as { ok: boolean; toast: string };
    expect(on.toast).toBe("Task-level repo override enabled");
    expect((await runLoader(ids.arda)).view.repoOverride).toBe(true);
  });

  it("grant-scope: reviewer refused; admin with no PAT gets the typed copy", async () => {
    const denied = (await postAction(ids.selin, {
      intent: "grant-scope",
    })) as { init?: { status?: number } };
    // Selin was re-invited as viewer above → still not admin|maintainer.
    expect(denied.init?.status).toBe(403);

    const result = (await postAction(ids.arda, { intent: "grant-scope" })) as {
      ok: boolean;
      toast: string;
      result: string;
    };
    expect(result).toEqual({
      ok: true,
      toast:
        "No GitHub credential configured — connect a PAT before re-checking scopes.",
      result: "no_pat_configured",
    });
  });
});

describe("danger zone", () => {
  it("delete requires the typed project name", async () => {
    const result = (await postAction(
      ids.arda,
      { intent: "delete-project", confirmName: "nope" },
      "billing-service",
    )) as { init?: { status?: number } };
    expect(result.init?.status).toBe(400);
  });

  it("deletes a project for real: files gone, projections pruned, audited", async () => {
    const result = (await postAction(
      ids.arda,
      { intent: "delete-project", confirmName: "Billing Service" },
      "billing-service",
    )) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/");

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

  it("delete is admin-only (per-project membership)", async () => {
    // Murat is not a member of deploy-pipeline at all.
    const result = (await postAction(
      ids.murat,
      { intent: "delete-project", confirmName: "Deploy Pipeline" },
      "deploy-pipeline",
    )) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });
});

describe("archive-project", () => {
  it("maintainer is rejected (admin-only)", async () => {
    const result = (await postAction(ids.murat, {
      intent: "archive-project",
      archived: "true",
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });

  it("admin archives then restores — file + projection + audit follow", async () => {
    // Archive: project.md flag set, projection column follows, loader reflects.
    const archived = (await postAction(ids.arda, {
      intent: "archive-project",
      archived: "true",
    })) as { ok: boolean; archived: boolean };
    expect(archived).toMatchObject({ ok: true, archived: true });
    expect(projectMd()).toMatch(/archived: true/);
    expect(
      (
        app.db
          .prepare(`SELECT archived FROM projects WHERE slug = 'viberr-core'`)
          .get() as { archived: number }
      ).archived,
    ).toBe(1);
    expect((await runLoader(ids.arda)).view.project.archived).toBe(true);

    expect(
      listAuditEvents(app.db, { action: "project.archived" })[0],
    ).toMatchObject({ subjectId: "viberr-core" });

    // Restore: flag cleared, projection back to 0, so later tests see it active.
    const restored = (await postAction(ids.arda, {
      intent: "archive-project",
      archived: "false",
    })) as { ok: boolean; archived: boolean };
    expect(restored).toMatchObject({ ok: true, archived: false });
    expect(
      (
        app.db
          .prepare(`SELECT archived FROM projects WHERE slug = 'viberr-core'`)
          .get() as { archived: number }
      ).archived,
    ).toBe(0);
    expect(
      listAuditEvents(app.db, { action: "project.unarchived" })[0],
    ).toMatchObject({ subjectId: "viberr-core" });
  });
});
