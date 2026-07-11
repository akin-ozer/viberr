import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { isSecretBox } from "./secret-box.server";
import {
  clearProjectCredential,
  createPat,
  deletePat,
  getPatMetadata,
  getPatToken,
  getProjectCredential,
  getProjectCredentialHealth,
  listPats,
  recordPatValidation,
  setProjectCredential,
} from "./pat-store.server";

// Hermetic env for the secret box (only set when .env didn't already).
process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_test", label: "arda@viberr.test" };
const TOKEN = "github_pat_11TESTTEST0123456789_secretsecret42af";

describe("pat-store", () => {
  it("creates a PAT encrypted at rest with a display suffix", () => {
    const store = setupTestStore(ctx);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "viberr-bot · fine-grained PAT", token: TOKEN },
      ACTOR,
    );
    expect(pat.tokenSuffix).toBe("42af");
    expect(pat.masked).toBe("····42af");
    expect(pat.label).toBe("viberr-bot · fine-grained PAT");

    // Encrypted at rest: the raw row never contains the token.
    const row = store.db
      .prepare(`SELECT encrypted_token FROM github_pats WHERE id = ?`)
      .get(pat.id) as { encrypted_token: string };
    expect(row.encrypted_token).not.toContain(TOKEN);
    expect(isSecretBox(row.encrypted_token)).toBe(true);

    // Only the dedicated decryptor returns the token.
    expect(getPatToken(store.db, pat.id)).toBe(TOKEN);
    expect(getPatToken(store.db, "pat_missing")).toBeNull();

    // Audit written; details are secret-free.
    const audit = listAuditEvents(store.db, { action: "github.pat.created" });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.details)).not.toContain(TOKEN);
  });

  it("rejects unusable labels/tokens", () => {
    const store = setupTestStore(ctx);
    expect(() =>
      createPat(store.db, { userId: store.users.arda.id, label: "  ", token: TOKEN }, ACTOR),
    ).toThrowError();
    expect(() =>
      createPat(store.db, { userId: store.users.arda.id, label: "x", token: "short" }, ACTOR),
    ).toThrowError();
    expect(() =>
      createPat(
        store.db,
        { userId: store.users.arda.id, label: "x", token: "has spaces inside!" },
        ACTOR,
      ),
    ).toThrowError();
  });

  it("lists metadata only (no token material), newest first", () => {
    const store = setupTestStore(ctx);
    createPat(
      store.db,
      { userId: store.users.arda.id, label: "one", token: "ghp_aaaaaaaaaaaa1111" },
      ACTOR,
    );
    createPat(
      store.db,
      { userId: store.users.arda.id, label: "two", token: "ghp_bbbbbbbbbbbb2222" },
      ACTOR,
    );
    const pats = listPats(store.db, store.users.arda.id);
    expect(pats).toHaveLength(2);
    expect(JSON.stringify(pats)).not.toContain("ghp_");
    expect(pats.map((p) => p.tokenSuffix).sort()).toEqual(["1111", "2222"]);
    expect(listPats(store.db, store.users.deniz.id)).toHaveLength(0);
  });

  it("caches validation results on the row", () => {
    const store = setupTestStore(ctx);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "x", token: TOKEN },
      ACTOR,
    );
    recordPatValidation(store.db, pat.id, {
      status: "valid",
      checkedAt: "2026-07-05T10:00:00.000Z",
      login: "viberr-bot",
      tokenKind: "fine_grained",
      expiresAt: "2026-12-31T00:00:00.000Z",
      repo: "akin-ozer/viberr",
      scopes: [{ id: "repo", ok: true, source: "probe" }],
      missingScopes: [],
      detail: "Authenticated as viberr-bot.",
    });
    const reloaded = getPatMetadata(store.db, pat.id);
    expect(reloaded?.lastValidatedAt).toBe("2026-07-05T10:00:00.000Z");
    expect(reloaded?.validation?.status).toBe("valid");
    expect(reloaded?.validation?.login).toBe("viberr-bot");
  });

  it("binds one credential per project; delete cascades the binding", () => {
    const store = setupTestStore(ctx);
    const a = createPat(
      store.db,
      { userId: store.users.arda.id, label: "a", token: "ghp_aaaaaaaaaaaa1111" },
      ACTOR,
    );
    const b = createPat(
      store.db,
      { userId: store.users.arda.id, label: "b", token: "ghp_bbbbbbbbbbbb2222" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: a.id }, ACTOR);
    expect(getProjectCredential(store.db, store.slug)?.id).toBe(a.id);
    // Rebinding replaces.
    setProjectCredential(store.db, { projectSlug: store.slug, patId: b.id }, ACTOR);
    expect(getProjectCredential(store.db, store.slug)?.id).toBe(b.id);
    // Deleting the bound PAT cascades the binding away.
    expect(deletePat(store.db, b.id, ACTOR)).toBe(true);
    expect(deletePat(store.db, b.id, ACTOR)).toBe(false); // idempotent
    expect(getProjectCredential(store.db, store.slug)).toBeNull();
    // Clearing an absent binding is a no-op.
    expect(clearProjectCredential(store.db, store.slug, ACTOR)).toBe(false);
  });

  it("credential health falls back to project.md credentialPolicy display (mock demo mode)", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot }); // project the store
    // Give the projected row the mock's credentialPolicy (test-store's
    // project.md carries none; the seed's viberr-core does).
    store.db
      .prepare(`UPDATE projects SET credential_policy_json = ? WHERE slug = ?`)
      .run(
        JSON.stringify({
          credentialLabel: "viberr-bot · fine-grained PAT",
          masked: "github_pat_••••42af",
          requiredScopes: ["repo", "workflow", "read:org", "pull_request:write"],
        }),
        store.slug,
      );

    const health = getProjectCredentialHealth(store.db, store.slug);
    expect(health.configured).toBe(false);
    expect(health.source).toBe("policy_display");
    expect(health.label).toBe("viberr-bot · fine-grained PAT");
    expect(health.masked).toBe("github_pat_••••42af");
    // The migration-seeded VIB-142 violation overlays the chip (test store
    // uses the viberr-core slug).
    const prWrite = health.scopes.find((s) => s.id === "pull_request:write");
    expect(prWrite).toMatchObject({
      ok: false,
      source: "violation",
      flaggedTaskKey: "VIB-142",
    });
    expect(
      health.scopes.filter((s) => s.id !== "pull_request:write").every((s) => s.ok),
    ).toBe(true);
    expect(health.openViolations).toHaveLength(1);
  });

  it("credential health prefers a real bound PAT (+ cached validation verdicts)", () => {
    const store = setupTestStore(ctx);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "real cred", token: TOKEN },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
    recordPatValidation(store.db, pat.id, {
      status: "insufficient_scope",
      checkedAt: "2026-07-05T10:00:00.000Z",
      login: "viberr-bot",
      tokenKind: "classic",
      expiresAt: null,
      repo: null,
      scopes: [
        { id: "repo", ok: true, source: "header" },
        { id: "workflow", ok: false, source: "header" },
        { id: "read:org", ok: true, source: "header" },
        { id: "pull_request:write", ok: true, source: "header" },
      ],
      missingScopes: ["workflow"],
      detail: "Missing scope: workflow.",
    });

    const health = getProjectCredentialHealth(store.db, store.slug);
    expect(health.configured).toBe(true);
    expect(health.source).toBe("pat");
    expect(health.patId).toBe(pat.id);
    expect(health.masked).toBe("····42af");
    // Validator verdict shows through…
    expect(health.scopes.find((s) => s.id === "workflow")).toMatchObject({
      ok: false,
      source: "header",
    });
    // …but an open violation still wins over a validator "ok"
    // (pull_request:write has the seeded VIB-142 violation on this slug).
    expect(health.scopes.find((s) => s.id === "pull_request:write")).toMatchObject(
      { ok: false, source: "violation", flaggedTaskKey: "VIB-142" },
    );
  });
});
