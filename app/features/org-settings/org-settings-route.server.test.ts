import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import type {
  loader as orgLoader,
  action as orgAction,
} from "~/routes/org.settings";

/**
 * Route-level tests for /org/settings: admin-only RBAC on loader + action,
 * user-tab mutations through real Requests (phase-2 API + guards),
 * whitelist add, resource intents, and StoreBrowser fs intents (multipart
 * upload → REAL file under the data root).
 */

let app: AppTestContext;
/**
 * The seeded humans every request in this file is issued as: arda is an org
 * admin, selin an org member.
 */
let ids: SeedUserIds;

type SettingsActionData = Awaited<ReturnType<typeof orgAction>>;
type SettingsOkReply = Extract<SettingsActionData, { ok: true }>;

/**
 * One action reply with react-router's `data()` envelope already peeled off:
 * the success payload's per-intent fields (each optional — they belong to one
 * intent apiece) with `ok` widened and the refusal's `error` folded in, since
 * `unwrap` returns whichever arm the intent took.
 */
type SettingsReply = Omit<SettingsOkReply, "ok"> & {
  ok: boolean;
  error?: string;
};

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
  const { seedOrgResources } = await import("~/server/org/org-seed.server");
  seedOrgResources(app.db, { dataRoot: app.dataRoot });
  // Ships the *-expertise skill folders to disk (no DB rows) — the org view
  // must surface them too (disk is truth, finding #7).
  const { seedDefaultAgentAssets } = await import(
    "~/server/seed/default-assets.server"
  );
  seedDefaultAgentAssets(app.dataRoot);
});
afterAll(() => app.cleanup());

async function runLoader(
  userId?: string,
): Promise<Awaited<ReturnType<typeof orgLoader>>> {
  const { loader } = await import("~/routes/org.settings");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  // SAFETY: the loader reads `request` and nothing else; React Router's
  // generated `LoaderArgs` additionally carries the framework's `context`
  // provider, which cannot be built outside a real router.
  return loader({
    request: app.request("/org/settings", cookie ? { cookie } : {}),
    params: {},
    context: {},
  } as never);
}

/** Refusals travel inside react-router's `data()` envelope; every other reply
 *  is the body itself. Both arms carry `ok`, which is what the tests read. */
function unwrap(result: SettingsActionData): SettingsReply {
  return "data" in result ? result.data : result;
}

async function postAction(
  userId: string,
  fields: Record<string, string>,
): Promise<SettingsReply> {
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
  // SAFETY: as in runLoader — the action reads `request` only, so this stub
  // carries everything the call executes.
  const result = await action({ request, params: {}, context: {} } as never);
  return unwrap(result);
}

describe("RBAC", () => {
  it("loader: admin gets the full view; member gets 403; anonymous → login", async () => {
    const data = await runLoader(ids.arda);
    expect(data.meId).toBe(ids.arda);
    expect(data.view.users.length).toBeGreaterThan(0);

    await expect(runLoader(ids.selin)).rejects.toMatchObject({ status: 403 });
    await expect(runLoader()).rejects.toMatchObject({ status: 302 });
  });

  it("action: member is refused before any work happens", async () => {
    await expect(
      postAction(ids.selin, { intent: "kb-reindex", kbId: "kb_seed_arch" }),
    ).rejects.toMatchObject({ status: 403 });
    // Ruling 463: Re-check spends GitHub calls, so it is behind the same gate.
    await expect(
      postAction(ids.selin, { intent: "connection-recheck", connectionId: "akin-ozer" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("ruling 463: connection-recheck reaches recheckConnection (a missing connection says so)", async () => {
    // CANARY: drop the `connection-recheck` case and the route answers
    // "Unknown action." instead. No connection exists, so nothing calls GitHub.
    const reply = await postAction(ids.arda, {
      intent: "connection-recheck",
      connectionId: "no-such-owner",
    });
    expect(reply).toMatchObject({ ok: false, error: "That connection no longer exists." });
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
  it("kb re-index reports the real INJECTABLE doc count (P14-KM-13)", async () => {
    const result = await postAction(ids.arda, {
      intent: "kb-reindex",
      kbId: "kb_seed_arch",
    });
    expect(result).toMatchObject({
      ok: true,
      toast: "Architecture notes re-scanned: 6 docs agents can read",
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
    // SAFETY: as in postAction — the multipart upload goes through the same
    // action, which reads `request` only.
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

  // With no connection the import goes out ANONYMOUSLY (a public repo needs no
  // credential), so this route reaches the network — the transport is stubbed
  // to keep the suite hermetic, and answers 404 the way GitHub answers an
  // unauthenticated read of a private or nonexistent repo.
  it("github import a connection can't explain is the honest failure", async () => {
    const transport = fakeGithubFetch({});
    vi.stubGlobal("fetch", transport.fetchImpl);
    try {
      const result = await postAction(ids.arda, {
        intent: "store-import-github",
        kind: "kb",
        id: "kb_seed_arch",
        url: "https://github.com/owner/repo/tree/main/docs",
      });
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("add a GitHub connection");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Ruling 106 — controller-save persists the model AND the effort the panel's
 * catalog pickers submit, as a first-class frontmatter key (no drift warning),
 * and a blank effort removes the key rather than storing "".
 */
describe("controller-save (ruling 106)", () => {
  it("round-trips model + effort through the profile file without drift", async () => {
    const { resolveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    const before = resolveControllerConfig(app.dataRoot);
    expect(before.profilePresent).toBe(true);
    // Ruling 108: the grant sections are deployment-locked by default, so this
    // save round-trips the STORED grants and edits only model + effort.
    const reply = await postAction(ids.arda, {
      intent: "controller-save",
      model: "opus",
      effort: "max",
      definition: "",
      skills: before.skills.join("\n"),
      kb: before.kb.join("\n"),
      mcps: before.mcps.join("\n"),
    });
    expect(reply.ok).toBe(true);
    const after = resolveControllerConfig(app.dataRoot);
    expect(after.model).toBe("opus");
    expect(after.effort).toBe("max");
    // A blank definition keeps the stored doctrine (the panel posts the body
    // it loaded, so blank only happens when nothing was ever stored).
    expect(after.definition).toBe(before.definition);
    // `effort` is a schema-level key now: parsing the written file must not
    // report it as unrecognized-frontmatter drift.
    const { parseAgentProfileContent } = await import(
      "~/server/files/agent-profile-file.server"
    );
    const file = path.join(app.dataRoot, "agents", "profiles", "controller.md");
    const { diagnostics } = parseAgentProfileContent(
      readFileSync(file, "utf8"),
      { fallbackId: "controller" },
    );
    expect(
      diagnostics.filter((d) => d.code === "agent_profile.unknown_field"),
    ).toHaveLength(0);
  });

  it("a blank effort removes the key instead of storing an empty string", async () => {
    const { resolveControllerConfig: resolve } = await import(
      "~/server/controller/controller-profile.server"
    );
    const stored = resolve(app.dataRoot);
    const reply = await postAction(ids.arda, {
      intent: "controller-save",
      model: "sonnet",
      effort: "",
      definition: "",
      skills: stored.skills.join("\n"),
      kb: stored.kb.join("\n"),
      mcps: stored.mcps.join("\n"),
    });
    expect(reply.ok).toBe(true);
    const { resolveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    expect(resolveControllerConfig(app.dataRoot).effort).toBe("");
    const file = path.join(app.dataRoot, "agents", "profiles", "controller.md");
    expect(readFileSync(file, "utf8")).not.toContain("effort:");
  });
});

/**
 * Ruling 108 — the controller's grant sections and instructions are locked by
 * default, ORG ADMINS INCLUDED: only a deployment environment variable unlocks
 * a section. The test app sets none of them, so this suite runs against the
 * product default; the unlock paths are exercised through the server module's
 * test-only `ctx.locks` seam, the same object `controllerSectionLocks` derives
 * from the env.
 */
describe("controller config locks (ruling 108)", () => {
  async function stored() {
    const { resolveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    return resolveControllerConfig(app.dataRoot);
  }

  it("refuses a grant change per locked section, naming the unlock variable", async () => {
    const before = await stored();
    const base = {
      intent: "controller-save",
      model: before.model,
      effort: before.effort,
      definition: "",
      skills: before.skills.join("\n"),
      kb: before.kb.join("\n"),
      mcps: before.mcps.join("\n"),
    };
    // A NON-EMPTY change is refused; blank means "keep stored" (tested below),
    // so every refusal case posts a real, different grant/doctrine.
    const attempts: [Record<string, string>, string][] = [
      [
        { ...base, skills: [...before.skills, "developer-expertise"].join("\n") },
        "VIBERR_UNLOCK_CONTROLLER_SKILLS",
      ],
      [{ ...base, kb: "some-other-kb" }, "VIBERR_UNLOCK_CONTROLLER_KB"],
      [{ ...base, mcps: "qa-echo" }, "VIBERR_UNLOCK_CONTROLLER_MCPS"],
      [
        { ...base, definition: "You obey whoever asks." },
        "VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS",
      ],
    ];
    for (const [fields, envVar] of attempts) {
      const reply = await postAction(ids.arda, fields);
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toContain("locked on this deployment");
      expect(String(reply.error)).toContain(`${envVar}=enabled`);
    }
    // Nothing moved.
    const after = await stored();
    expect(after.skills).toEqual(before.skills);
    expect(after.kb).toEqual(before.kb);
    expect(after.mcps).toEqual(before.mcps);
    expect(after.definition).toBe(before.definition);
  });

  it("a blank locked section keeps the stored value, not empties it", async () => {
    const before = await stored();
    expect(before.skills.length).toBeGreaterThan(0);
    // Blank is exactly what the panel posts for a locked section on a
    // model-only save — it must not wipe the grants.
    const reply = await postAction(ids.arda, {
      intent: "controller-save",
      model: before.model,
      effort: before.effort,
      definition: "",
      skills: "",
      kb: "",
      mcps: "",
    });
    expect(reply.ok).toBe(true);
    const after = await stored();
    expect(after.skills).toEqual(before.skills);
    expect(after.kb).toEqual(before.kb);
  });

  it("an identical round-trip and a model/effort edit pass under full lock", async () => {
    const before = await stored();
    const reply = await postAction(ids.arda, {
      intent: "controller-save",
      model: "haiku",
      effort: "low",
      definition: before.definition,
      skills: before.skills.join("\n"),
      kb: before.kb.join("\n"),
      mcps: before.mcps.join("\n"),
    });
    expect(reply.ok).toBe(true);
    const after = await stored();
    expect(after.model).toBe("haiku");
    expect(after.effort).toBe("low");
    // The doctrine posted verbatim is not a change, and a LOCKED save never
    // rewrites the definition file.
    expect(after.definition).toBe(before.definition);
  });

  it("each unlock flag opens exactly its own section", async () => {
    const { saveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    const { getDb } = await import("~/server/db/sqlite.server");
    const before = await stored();
    const actor = { userId: ids.arda, label: "arda@viberr.dev" };
    const base = {
      model: before.model,
      effort: before.effort,
      definition: "",
      skills: before.skills,
      kb: before.kb,
      mcps: before.mcps,
    };
    const skillsOnly = { skills: false, kb: true, mcps: true, instructions: true };
    // Unlocked section: the change lands on disk — and the RESOLVED config
    // reports the controller guide for an empty list (C03-OC3, pass 32: the
    // one rule the panel and the runtime share; the file itself holds `[]`).
    saveControllerConfig(
      getDb(),
      { ...base, skills: [] },
      actor,
      { dataRoot: app.dataRoot, locks: skillsOnly },
    );
    expect((await stored()).skills).toEqual(["controller-guide"]);
    // A sibling section stays locked under the same flags.
    expect(() =>
      saveControllerConfig(
        getDb(),
        { ...base, skills: [], kb: [...before.kb, "extra-kb"] },
        actor,
        { dataRoot: app.dataRoot, locks: skillsOnly },
      ),
    ).toThrowError(/VIBERR_UNLOCK_CONTROLLER_KB=enabled/);
    // Restore.
    saveControllerConfig(getDb(), base, actor, {
      dataRoot: app.dataRoot,
      locks: skillsOnly,
    });
    expect((await stored()).skills).toEqual(before.skills);
  });

  it("a locked section writes the STORED list, ignoring a reordered same-set input", async () => {
    // Direct caller posts the same grants in a different order (passes the
    // set-equality check) — the on-disk list must not be perturbed (#3/#6).
    const { saveControllerConfig, resolveControllerConfig: resolve } =
      await import("~/server/controller/controller-profile.server");
    const { getDb } = await import("~/server/db/sqlite.server");
    const before = resolve(app.dataRoot);
    const file = path.join(app.dataRoot, "agents", "profiles", "controller.md");
    const bytesBefore = readFileSync(file, "utf8");
    saveControllerConfig(
      getDb(),
      {
        model: before.model,
        effort: before.effort,
        definition: "",
        // Reversed + duplicated, but the same SET.
        skills: [...before.skills].reverse().concat(before.skills[0] ?? []),
        kb: before.kb,
        mcps: before.mcps,
      },
      { userId: ids.arda, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot },
    );
    expect(resolve(app.dataRoot).skills).toEqual(before.skills);
    // The grants block is byte-identical (model/effort unchanged here too).
    expect(readFileSync(file, "utf8")).toBe(bytesBefore);
  });

  it("a locked or blank save never claims a doctrine edit in the audit trail", async () => {
    // #12: definitionEdited must be true only when the file was written.
    const { saveControllerConfig, resolveControllerConfig: resolve } =
      await import("~/server/controller/controller-profile.server");
    const { getDb } = await import("~/server/db/sqlite.server");
    const { queryAuditEventsForExport } = await import(
      "~/server/audit/audit-export.server"
    );
    const before = resolve(app.dataRoot);
    saveControllerConfig(
      getDb(),
      {
        model: "haiku",
        effort: before.effort,
        definition: "", // blank = keep, no write
        skills: before.skills,
        kb: before.kb,
        mcps: before.mcps,
      },
      { userId: ids.arda, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot },
    );
    // Newest-first, filtered to the controller action: the row we just wrote.
    const latest = queryAuditEventsForExport(getDb(), {
      action: "org.controller.updated",
    })[0];
    expect(latest).toBeTruthy();
    // SAFETY: saveControllerConfig writes this row's details with a boolean
    // `definitionEdited` (asserted below); the parse reads back that shape.
    const details = JSON.parse(latest!.detailsJson ?? "{}") as {
      definitionEdited: boolean;
    };
    expect(details.definitionEdited).toBe(false);
  });

  it("controllerSectionLocks: locked unless the env flag parses truthy", async () => {
    const { controllerSectionLocks } = await import(
      "~/server/controller/controller-profile.server"
    );
    expect(controllerSectionLocks({})).toEqual({
      skills: true,
      kb: true,
      mcps: true,
      instructions: true,
    });
    // Only `enabled` unlocks (case-insensitive, trimmed); `disabled`, a stale
    // `1`, and anything unexpected keep the section locked — a typo fails safe.
    expect(
      controllerSectionLocks({
        VIBERR_UNLOCK_CONTROLLER_KB: "enabled",
        VIBERR_UNLOCK_CONTROLLER_SKILLS: " ENABLED ",
        VIBERR_UNLOCK_CONTROLLER_MCPS: "disabled",
        VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS: "1",
      }),
    ).toEqual({ skills: false, kb: false, mcps: true, instructions: true });
  });
});

/**
 * Ruling 390, amended 2026-09-23. Before this, a grant request never left
 * `open`: `closeResourceRequest` had no caller outside tests. After an admin
 * granted the resource, the request stayed on this tab and in the controller's
 * own context, which told it that it did not have a knowledge base it was
 * reading. Now the Controller-tab save that leaves the resource granted closes
 * the request, and Decline closes it too. Both are audited and published.
 */
describe("controller grant requests are answered in the app (ruling 390)", () => {
  const ASKER = {
    askedByUserId: "u_controller_asker",
    askedByLabel: "arda@viberr.dev · via controller",
  };

  const answerDetails = z.object({
    requestId: z.string(),
    kind: z.string(),
    name: z.string(),
  });

  /** The newest audit row for `action`, with its details parsed. */
  async function latestAudit(action: string) {
    const { queryAuditEventsForExport } = await import(
      "~/server/audit/audit-export.server"
    );
    const { getDb } = await import("~/server/db/sqlite.server");
    const row = queryAuditEventsForExport(getDb(), { action })[0];
    expect(row, action).toBeTruthy();
    return {
      row: row!,
      details: answerDetails.parse(JSON.parse(row!.detailsJson ?? "{}")),
    };
  }

  /** `body`'s result, and everything the SSE broker sent a `user`-scoped
   *  watcher (what an open Instance settings tab holds) while it ran. */
  async function published<T>(
    body: () => Promise<T>,
  ): Promise<{ result: T; wire: string }> {
    const { connectSseClient, resetSseBrokerForTests } = await import(
      "~/server/events/sse-broker.server"
    );
    resetSseBrokerForTests();
    const writes: string[] = [];
    connectSseClient({
      userId: "u_watcher",
      scopes: [{ kind: "user" }],
      lastEventId: null,
      write: (chunk) => writes.push(chunk),
    });
    try {
      const result = await body();
      return { result, wire: writes.join("") };
    } finally {
      resetSseBrokerForTests();
    }
  }

  async function listedIds(): Promise<string[]> {
    return (await runLoader(ids.arda)).controllerRequests.map((r) => r.id);
  }

  it("a save that grants the requested knowledge base closes the request as granted", async () => {
    const { raiseResourceRequest, readResourceRequests, openRequestsContextLine } =
      await import("~/server/controller/controller-requests.server");
    const { resolveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    const { resetEnvCacheForTests } = await import("~/server/config/env.server");
    const before = resolveControllerConfig(app.dataRoot);
    expect(before.kb).not.toContain("architecture-notes");
    const { request: asked } = raiseResourceRequest(
      {
        kind: "kb",
        name: "architecture-notes",
        reason: "It carries the standing rule, as its heading.",
        ...ASKER,
      },
      app.dataRoot,
    );
    const { request: other } = raiseResourceRequest(
      { kind: "skills", name: "developer-expertise", reason: "Not granted here.", ...ASKER },
      app.dataRoot,
    );
    expect(await listedIds()).toEqual(expect.arrayContaining([asked.id, other.id]));

    // The deployment unlocks the knowledge-base section (ruling 108). The
    // restart is the env cache reset.
    vi.stubEnv("VIBERR_UNLOCK_CONTROLLER_KB", "enabled");
    resetEnvCacheForTests();
    try {
      const { result: reply, wire } = await published(() =>
        postAction(ids.arda, {
          intent: "controller-save",
          model: before.model,
          effort: before.effort,
          definition: "",
          skills: "",
          mcps: "",
          kb: [...before.kb, "architecture-notes"].join("\n"),
        }),
      );
      expect(reply.ok).toBe(true);
      expect(reply.toast).toContain(
        "which answers its grant request for “architecture-notes”",
      );
      // CANARY: drop the close from `saveControllerConfig` and the request is
      // still open here, still listed, and still in the controller's context.
      const rows = readResourceRequests(app.dataRoot);
      const answered = rows.find((r) => r.id === asked.id)!;
      expect(answered.status).toBe("granted");
      expect(answered.closedByLabel).toBe("arda@viberr.dev");
      expect(answered.closedAt).toBeTruthy();
      // Only the request this save answered. The skill was not granted.
      expect(rows.find((r) => r.id === other.id)!.status).toBe("open");
      const listed = await listedIds();
      expect(listed).not.toContain(asked.id);
      expect(listed).toContain(other.id);
      expect(openRequestsContextLine(app.dataRoot)).not.toContain("architecture-notes");

      const { row, details } = await latestAudit("controller.resource_grant.granted");
      expect(details).toEqual({
        requestId: asked.id,
        kind: "kb",
        name: "architecture-notes",
      });
      expect(row.actorLabel).toBe("arda@viberr.dev");
      // An open settings tab in another window revalidates.
      expect(wire).toContain("event: resource.updated");
      expect(wire).toContain("kb:architecture-notes");

      // Restore the controller's grants for the rest of the file.
      const restored = await postAction(ids.arda, {
        intent: "controller-save",
        model: before.model,
        effort: before.effort,
        definition: "",
        skills: "",
        mcps: "",
        kb: before.kb.join("\n"),
      });
      expect(restored.ok).toBe(true);
      expect(resolveControllerConfig(app.dataRoot).kb).toEqual(before.kb);
    } finally {
      vi.unstubAllEnvs();
      resetEnvCacheForTests();
    }
  });

  it("a request for a resource the controller already holds is answered by the next save, locked or not", async () => {
    const { raiseResourceRequest, readResourceRequests } = await import(
      "~/server/controller/controller-requests.server"
    );
    const { resolveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    const before = resolveControllerConfig(app.dataRoot);
    // The handbook is granted in the shipped profile (ruling 99). Nothing
    // stopped the controller asking for it anyway, and the context line kept
    // telling it that it did not have a base it was reading.
    expect(before.kb).toContain("controller-handbook");
    const { request } = raiseResourceRequest(
      { kind: "kb", name: "controller-handbook", reason: "Already there.", ...ASKER },
      app.dataRoot,
    );
    // A model-only save under the default full lock. What counts is that the
    // controller holds the resource, not which save added it.
    const reply = await postAction(ids.arda, {
      intent: "controller-save",
      model: before.model,
      effort: before.effort,
      definition: "",
      skills: "",
      kb: "",
      mcps: "",
    });
    expect(reply.ok).toBe(true);
    expect(readResourceRequests(app.dataRoot).find((r) => r.id === request.id)!.status).toBe(
      "granted",
    );
  });

  it("a save that leaves the requested resource ungranted answers nothing", async () => {
    const { raiseResourceRequest, readResourceRequests } = await import(
      "~/server/controller/controller-requests.server"
    );
    const { resolveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    const before = resolveControllerConfig(app.dataRoot);
    expect(before.skills).not.toContain("developer-expertise");
    const { request } = raiseResourceRequest(
      { kind: "skills", name: "developer-expertise", reason: "Not granted here.", ...ASKER },
      app.dataRoot,
    );
    const reply = await postAction(ids.arda, {
      intent: "controller-save",
      model: before.model,
      effort: before.effort,
      definition: "",
      skills: "",
      kb: "",
      mcps: "",
    });
    expect(reply.ok).toBe(true);
    // CANARY: close every open request on any save and this goes red.
    expect(reply.toast).toBe("Controller updated. Changes apply from its next turn");
    expect(readResourceRequests(app.dataRoot).find((r) => r.id === request.id)!.status).toBe(
      "open",
    );
    expect(await listedIds()).toContain(request.id);
  });

  it("Decline closes the request as declined, audited and announced, and grants nothing", async () => {
    const { raiseResourceRequest, readResourceRequests, openRequestsContextLine } =
      await import("~/server/controller/controller-requests.server");
    const profileFile = path.join(app.dataRoot, "agents", "profiles", "controller.md");
    const profileBefore = readFileSync(profileFile, "utf8");
    const { request } = raiseResourceRequest(
      { kind: "skills", name: "developer-expertise", reason: "Not granted here.", ...ASKER },
      app.dataRoot,
    );

    // Org admins only: the whole action is admin-gated, before any work.
    await expect(
      postAction(ids.selin, { intent: "controller-request-decline", requestId: request.id }),
    ).rejects.toMatchObject({ status: 403 });
    expect(readResourceRequests(app.dataRoot).find((r) => r.id === request.id)!.status).toBe(
      "open",
    );

    const { result: reply, wire } = await published(() =>
      postAction(ids.arda, {
        intent: "controller-request-decline",
        requestId: request.id,
      }),
    );
    expect(reply.ok).toBe(true);
    expect(reply.toast).toBe(
      "Declined the controller's request for “developer-expertise”",
    );
    const declined = readResourceRequests(app.dataRoot).find((r) => r.id === request.id)!;
    expect(declined.status).toBe("declined");
    expect(declined.closedByLabel).toBe("arda@viberr.dev");
    expect(await listedIds()).not.toContain(request.id);
    expect(openRequestsContextLine(app.dataRoot)).not.toContain("developer-expertise");
    const { row, details } = await latestAudit("controller.resource_grant.declined");
    expect(details).toEqual({
      requestId: request.id,
      kind: "skills",
      name: "developer-expertise",
    });
    expect(row.actorLabel).toBe("arda@viberr.dev");
    expect(wire).toContain("event: resource.updated");
    expect(wire).toContain("skill:developer-expertise");
    // Declining is an answer, not a grant change: the profile is untouched.
    expect(readFileSync(profileFile, "utf8")).toBe(profileBefore);

    // A second answer to the same request is refused with the stored answer,
    // not recorded twice; an id nobody raised is refused as not found.
    const again = await postAction(ids.arda, {
      intent: "controller-request-decline",
      requestId: request.id,
    });
    expect(again.ok).toBe(false);
    expect(again.error).toContain("already declined by arda@viberr.dev");
    const bogus = await postAction(ids.arda, {
      intent: "controller-request-decline",
      requestId: "rq_nobody_raised",
    });
    expect(bogus.ok).toBe(false);
    expect(bogus.error).toContain("No grant request carries that id");
    expect(
      readResourceRequests(app.dataRoot).find((r) => r.id === request.id)!.closedAt,
    ).toBe(declined.closedAt);
  });
});

/**
 * R19-16 — the whole point of the Sign-in & SSO tab: an admin can turn GitHub
 * sign-in on WITHOUT touching the deployment env, and cannot turn it on with a
 * credential the provider never accepted.
 */
describe("R19-16 sign-in providers, configured in the app", () => {
  it("save → refuse-to-enable → test → enable, and the login page follows", async () => {
    const loaderBefore = await runLoader(ids.arda);
    expect(loaderBefore.view.providers.github).toBe(false);

    const saved = await postAction(ids.arda, {
      intent: "oauth-save",
      provider: "github",
      clientId: "Iv1.livetest",
      clientSecret: "super-secret-value",
    });
    expect(saved).toMatchObject({ ok: true });

    // Saving alone must NOT light the method up.
    const afterSave = await runLoader(ids.arda);
    expect(afterSave.view.providers.github).toBe(false);
    expect(afterSave.view.authProviders[0]).toMatchObject({
      provider: "github",
      configuredInApp: true,
      active: false,
      clientId: "Iv1.livetest",
    });

    const refused = await postAction(ids.arda, {
      intent: "oauth-toggle",
      provider: "github",
      enabled: "1",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("Test the credentials first");

    // GitHub answering 404 to the app-authenticated probe = the pair is good.
    const transport = fakeGithubFetch({
      "POST /applications/Iv1.livetest/token": { status: 404, body: {} },
    });
    vi.stubGlobal("fetch", transport.fetchImpl);
    try {
      const tested = await postAction(ids.arda, {
        intent: "oauth-test",
        provider: "github",
      });
      expect(tested).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
    // The probe authenticates the APP with Basic auth — never the secret in a
    // query string or body.
    const probe = transport.callsTo("POST /applications/Iv1.livetest/token")[0]!;
    expect(probe.headers["authorization"]).toMatch(/^Basic /);
    expect(probe.url.search).toBe("");

    const enabled = await postAction(ids.arda, {
      intent: "oauth-toggle",
      provider: "github",
      enabled: "1",
    });
    expect(enabled).toMatchObject({ ok: true });

    const afterEnable = await runLoader(ids.arda);
    expect(afterEnable.view.providers.github).toBe(true);
    expect(afterEnable.view.authProviders[0]).toMatchObject({
      active: true,
      source: "app",
    });

    // …and the LOGIN page offers the button, from the same resolution.
    const { loader: loginLoader } = await import("~/routes/login");
    // SAFETY: the login loader reads `request` only — same generated-args
    // stand-in as runLoader above.
    const login = await loginLoader({
      request: app.request("/login"),
      params: {},
      context: {},
    } as never);
    expect(login.providers.github).toBe(true);
  });

});


describe("E5: route-only authority gates", () => {
  it("user-edit refuses a self-demotion (the guard the user-role twin has but this one lacked a test for)", async () => {
    // The self-demotion guard is DUPLICATED in user-edit; only its user-role twin
    // was tested. A regressed user-edit guard lets the last admin self-demote and
    // lock the org out of policy/members/delete.
    const self = await postAction(ids.arda, {
      intent: "user-edit",
      userId: ids.arda,
      role: "member",
      name: "Arda",
      email: "arda@viberr.dev",
    });
    expect(self).toMatchObject({ ok: false, error: "You can't demote yourself" });
  });

  it("user-edit of SOMEONE ELSE to member is allowed (the guard is self-only)", async () => {
    const other = await postAction(ids.arda, {
      intent: "user-edit",
      userId: ids.selin,
      role: "member",
      name: "Selin Aksoy",
      email: "selin@viberr.dev",
    });
    expect(other.ok).toBe(true);
  });

  it("agent-delete of a DEPLOYED profile is refused with a 409 (in_use → the route maps it)", async () => {
    // The demo seed deploys every template in viberr-core, so deleting one
    // must refuse — the route's in_use → 409 mapping.
    const result = await postAction(ids.arda, {
      intent: "agent-delete",
      profileId: "developer",
    });
    expect(result.ok).toBe(false);
    // The refusal names the profile and the deployments blocking it — a bare
    // "in use" would leave the admin nothing to act on.
    expect(result.error).toMatch(/^Detach .+ from its \d+ projects? first$/);
  });
});
