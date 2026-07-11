import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { OrgSettingsView } from "~/server/org/org-view.server";

/**
 * Route-level tests for /org/settings: admin-only RBAC on loader + action,
 * user-tab mutations through real Requests (phase-2 API + guards),
 * whitelist add, resource intents, and StoreBrowser fs intents (multipart
 * upload → REAL file under the data root). The old /org/users redirects.
 */

let app: AppTestContext;
let ids: { arda: string; selin: string };

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedOrgResources } = await import("~/server/org/org-seed.server");
  seedOrgResources(app.db, { dataRoot: app.dataRoot });
  // Ships the *-expertise skill folders to disk (no DB rows) — the org view
  // must surface them too (disk is truth, finding #7).
  const { seedDefaultAgentAssets } = await import(
    "~/server/seed/default-assets.server"
  );
  seedDefaultAgentAssets(app.dataRoot);
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // org admin
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // org member
  };
});
afterAll(() => app.cleanup());

async function runLoader(userId?: string) {
  const { loader } = await import("~/routes/org.settings");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  return (await loader({
    request: app.request("/org/settings", cookie ? { cookie } : {}),
    params: {},
    context: {},
  } as never)) as { view: OrgSettingsView; meId: string };
}

type ActionBody = Record<string, unknown>;

function unwrap(result: unknown): ActionBody {
  if (result && typeof result === "object" && "data" in result) {
    return (result as { data: ActionBody }).data;
  }
  return result as ActionBody;
}

async function postAction(
  userId: string,
  fields: Record<string, string>,
): Promise<ActionBody> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ ...fields, _csrf: csrf });
  const request = app.request("/org/settings", {
    method: "POST",
    body,
    cookie,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const result = await action({ request, params: {}, context: {} } as never);
  return unwrap(result);
}

describe("RBAC", () => {
  it("loader: admin gets the full view; member gets 403; anonymous → login", async () => {
    const data = await runLoader(ids.arda);
    expect(data.meId).toBe(ids.arda);
    // Honest empty slate: no fabricated connection or MCP rows are seeded.
    expect(data.view.connections).toHaveLength(0);
    expect(data.view.users.length).toBeGreaterThanOrEqual(5);
    expect(data.view.domains).toHaveLength(1);
    expect(data.view.kbs).toHaveLength(3);
    expect(data.view.mcps).toHaveLength(0);
    // Disk is truth (finding #7): the 4 org-managed skill rows PLUS the 3
    // shipped *-expertise skill folders that have no row — all listed. (Tester
    // was merged into the Reviewer, so tester-expertise no longer ships.)
    expect(data.view.skills).toHaveLength(7);
    const skillNames = data.view.skills.map((s) => s.name);
    expect(skillNames).toContain("developer-expertise");
    expect(skillNames).toContain("reviewer-expertise");
    expect(skillNames).not.toContain("tester-expertise");
    const devSkill = data.view.skills.find((s) => s.name === "developer-expertise")!;
    // A disk-only skill: synthetic id + a summary derived from its SKILL.md.
    expect(devSkill.id).toBe("disk:developer-expertise");
    expect(devSkill.summary.length).toBeGreaterThan(0);
    // Specialists only — the operator template is not listed.
    expect(data.view.gagents.map((g) => g.id)).toEqual([
      "developer",
      "reviewer",
    ]);
    // Every seeded template is deployed in viberr-core → delete-guarded.
    expect(data.view.gagents.every((g) => g.used >= 1)).toBe(true);
    expect(data.view.stages.map((s) => s.id)).toEqual([
      "triage", "ready", "impl", "review", "done",
    ]);

    await expect(runLoader(ids.selin)).rejects.toMatchObject({ status: 403 });
    await expect(runLoader()).rejects.toMatchObject({ status: 302 });
  });

  it("action: member is refused before any work happens", async () => {
    await expect(
      postAction(ids.selin, { intent: "kb-reindex", kbId: "kb_seed_arch" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("users & access intents", () => {
  it("role toggle round-trips with the mock toast; self-demote is refused", async () => {
    const up = await postAction(ids.arda, {
      intent: "user-role",
      userId: ids.selin,
      role: "admin",
    });
    expect(up).toMatchObject({ ok: true, toast: "Selin Aksoy → admin" });

    const down = await postAction(ids.arda, {
      intent: "user-role",
      userId: ids.selin,
      role: "member",
    });
    expect(down).toMatchObject({ ok: true, toast: "Selin Aksoy → member" });

    const self = await postAction(ids.arda, {
      intent: "user-role",
      userId: ids.arda,
      role: "member",
    });
    expect(self).toMatchObject({ ok: false, error: "You can't demote yourself" });
  });

  it("local create surfaces the temp password once + renders setup pending", async () => {
    const result = await postAction(ids.arda, {
      intent: "invite-local",
      name: "Yeni Kişi",
      email: "yeni@viberr.dev",
      role: "member",
    });
    expect(result.ok).toBe(true);
    expect(String(result.tempPassword).length).toBeGreaterThanOrEqual(8);
    const { view } = await runLoader(ids.arda);
    const created = view.users.find((u) => u.email === "yeni@viberr.dev")!;
    expect(created.status).toBe("invited");

    // Reset flow reuses the phase-2 API.
    const reset = await postAction(ids.arda, {
      intent: "user-reset-password",
      userId: created.id,
    });
    expect(reset.ok).toBe(true);
    expect(String(reset.tempPassword).length).toBeGreaterThanOrEqual(8);

    // Whitelist removal deletes the row.
    const removed = await postAction(ids.arda, {
      intent: "user-remove",
      userId: created.id,
    });
    expect(removed).toMatchObject({ ok: true, toast: "Yeni Kişi removed" });
  });

  it("duplicate domain whitelist is refused like the other invite intents", async () => {
    const dup = await postAction(ids.arda, {
      intent: "invite-domain",
      email: "@viberr.dev",
      role: "member",
    });
    expect(dup).toMatchObject({
      ok: false,
      error: "@viberr.dev is already whitelisted",
    });

    const added = await postAction(ids.arda, {
      intent: "invite-domain",
      email: "someone@hepapi.com",
      role: "member",
    });
    expect(added).toMatchObject({ ok: true });
    const { view } = await runLoader(ids.arda);
    expect(view.domains.map((d) => d.domain)).toContain("@hepapi.com");
    const row = view.domains.find((d) => d.domain === "@hepapi.com")!;
    const removed = await postAction(ids.arda, {
      intent: "domain-remove",
      domainId: row.id,
    });
    expect(removed).toMatchObject({
      ok: true,
      toast: "@hepapi.com removed from the allowlist",
    });
  });

  it("disable/enable round-trips through the view; self-disable is refused", async () => {
    const disabled = await postAction(ids.arda, {
      intent: "user-disable",
      userId: ids.selin,
    });
    expect(disabled.ok).toBe(true);
    expect(String(disabled.toast)).toContain("disabled");
    const { view } = await runLoader(ids.arda);
    expect(view.users.find((u) => u.id === ids.selin)!.disabled).toBe(true);

    const enabled = await postAction(ids.arda, {
      intent: "user-enable",
      userId: ids.selin,
    });
    expect(enabled.ok).toBe(true);
    const { view: after } = await runLoader(ids.arda);
    expect(after.users.find((u) => u.id === ids.selin)!.disabled).toBe(false);

    // An admin can't disable their own account (the last-admin lockout).
    const self = await postAction(ids.arda, {
      intent: "user-disable",
      userId: ids.arda,
    });
    expect(self).toMatchObject({
      ok: false,
      error: "You can't disable your own account",
    });
  });
});

describe("resource + store intents", () => {
  it("kb re-index reports the real doc count", async () => {
    const result = await postAction(ids.arda, {
      intent: "kb-reindex",
      kbId: "kb_seed_arch",
    });
    expect(result).toMatchObject({
      ok: true,
      toast: "Architecture notes re-indexed — 6 docs",
    });
  });

  it("store-mkdir + multipart store-upload write REAL files under the data root", async () => {
    const { action } = await import("~/routes/org.settings");
    const { cookie, sessionId } = await app.cookieFor(ids.arda);
    const csrf = await app.csrfFor(sessionId);

    const made = await postAction(ids.arda, {
      intent: "store-mkdir",
      kind: "kb",
      id: "kb_seed_arch",
      path: "[]",
      name: "uploads/inbox",
    });
    expect(made).toMatchObject({ ok: true, toast: "Folder uploads/inbox/ ready" });
    expect(
      existsSync(path.join(app.dataRoot, "kb", "architecture-notes", "uploads", "inbox")),
    ).toBe(true);

    const fd = new FormData();
    fd.set("intent", "store-upload");
    fd.set("mode", "files");
    fd.set("kind", "kb");
    fd.set("id", "kb_seed_arch");
    fd.set("path", JSON.stringify(["uploads"]));
    fd.append("files", new File(["# hello store"], "hello.md", { type: "text/markdown" }));
    fd.append("filePaths", "hello.md");
    fd.set("_csrf", csrf);
    const request = app.request("/org/settings", { method: "POST", body: fd, cookie });
    const result = unwrap(await action({ request, params: {}, context: {} } as never));
    expect(result).toMatchObject({
      ok: true,
      toast: "1 file added to store://kb/architecture-notes/uploads/",
    });
    const abs = path.join(
      app.dataRoot, "kb", "architecture-notes", "uploads", "hello.md",
    );
    expect(readFileSync(abs, "utf8")).toBe("# hello store");

    const deleted = await postAction(ids.arda, {
      intent: "store-delete",
      kind: "kb",
      id: "kb_seed_arch",
      path: JSON.stringify(["uploads"]),
    });
    expect(deleted).toMatchObject({ ok: true, toast: "Folder “uploads” deleted" });
    expect(existsSync(path.dirname(abs))).toBe(false);
  });

  it("github import without a validated connection is the honest failure", async () => {
    const result = await postAction(ids.arda, {
      intent: "store-import-github",
      kind: "kb",
      id: "kb_seed_arch",
      url: "https://github.com/owner/repo/tree/main/docs",
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("No GitHub connection");
  });
});

describe("old /org/users", () => {
  it("redirects to the Users & access tab", async () => {
    const { loader } = await import("~/routes/org.users");
    const response = loader() as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/org/settings?tab=users");
  });
});
