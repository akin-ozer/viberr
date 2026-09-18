import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  openScopeViolation,
  type OpenScopeViolationInput,
} from "~/server/projections/policy-violations.server";
import { isSecretBox } from "./secret-box.server";

/** The VIB-142 pull_request:write violation these tests exercise. It used to be
 *  migration-seeded; the squashed baseline is schema-only, so tests open it
 *  explicitly. */
const VIB142_VIOLATION = (slug: string): OpenScopeViolationInput => ({
  projectSlug: slug,
  taskKey: "VIB-142",
  scope: "pull_request:write",
  detail: "Project credential is missing pull_request:write.",
});
import {
  clearProjectCredential,
  createPat,
  deletePat,
  getPatMetadata,
  getPatToken,
  getProjectCredential,
  getProjectCredentialHealth,
  credentialAdvisories,
  markWriteScopeProven,
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
    // SAFETY: the SELECT list is the single `github_pats.encrypted_token` column
    // (TEXT NOT NULL), read back by the id `createPat` just returned.
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
      headerScopes: null,
      detail: "Authenticated as viberr-bot.",
    });
    const reloaded = getPatMetadata(store.db, pat.id);
    expect(reloaded?.lastValidatedAt).toBe("2026-07-05T10:00:00.000Z");
    expect(reloaded?.validation?.status).toBe("valid");
    expect(reloaded?.validation?.login).toBe("viberr-bot");
  });

  it("F27-U2: a real write proves pull_request:write on the bound credential", () => {
    const store = setupTestStore(ctx);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: TOKEN },
      ACTOR,
    );
    // The honest "verified on first use" state: a fine-grained token whose
    // pull_request:write was ASSUMED (never write-probed).
    recordPatValidation(store.db, pat.id, {
      status: "valid",
      checkedAt: "2026-08-24T00:00:00.000Z",
      login: "viberr-bot",
      tokenKind: "fine_grained",
      expiresAt: null,
      repo: "akin-ozer/viberr",
      scopes: [
        { id: "repo", ok: true, source: "probe" },
        { id: "pull_request:write", ok: true, source: "assumed" },
      ],
      missingScopes: [],
      headerScopes: null,
      detail: "Authenticated as viberr-bot.",
    });
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);

    const scopeOf = () =>
      getProjectCredential(store.db, store.slug)!.validation!.scopes.find(
        (s) => s.id === "pull_request:write",
      );
    expect(scopeOf()).toMatchObject({ source: "assumed" });

    // A real PR opened → the write proves the scope; the cached chip flips.
    // F28-U2b: proven BY the credential id that made the call, not by slug.
    markWriteScopeProven(store.db, pat.id);
    expect(scopeOf()).toMatchObject({ ok: true, source: "probe" });

    // No-op for an unknown credential (must never throw).
    markWriteScopeProven(store.db, "no-such-pat");
  });

  it("F28-U2b: proves the SPECIFIC credential, never whichever is bound now", () => {
    const store = setupTestStore(ctx);
    const mk = (label: string, token: string) => {
      const pat = createPat(
        store.db,
        { userId: store.users.arda.id, label, token },
        ACTOR,
      );
      recordPatValidation(store.db, pat.id, {
        status: "valid",
        checkedAt: "2026-08-24T00:00:00.000Z",
        login: `viberr-${label}`,
        tokenKind: "fine_grained",
        expiresAt: null,
        repo: "akin-ozer/viberr",
        scopes: [
          { id: "repo", ok: true, source: "probe" },
          { id: "pull_request:write", ok: true, source: "assumed" },
        ],
        missingScopes: [],
        headerScopes: null,
        detail: "Authenticated.",
      });
      return pat;
    };
    const a = mk("a", "ghp_aaaaaaaaaaaa1111");
    const b = mk("b", "ghp_bbbbbbbbbbbb2222");
    // B is the project's CURRENTLY-bound credential; A is the one that actually
    // made an in-flight PR-open call before a rotation to B.
    setProjectCredential(store.db, { projectSlug: store.slug, patId: b.id }, ACTOR);
    const scope = (patId: string) =>
      getPatMetadata(store.db, patId)!.validation!.scopes.find(
        (s) => s.id === "pull_request:write",
      );

    // The call that authenticated with A proves A — even though B is bound now.
    markWriteScopeProven(store.db, a.id);
    expect(scope(a.id)).toMatchObject({ ok: true, source: "probe" });
    // B — which made no GitHub call — is untouched (still the honest "assumed").
    expect(scope(b.id)).toMatchObject({ source: "assumed" });
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

  it("a credentialPolicy with NO bound PAT stays source 'none' — never fabricates a card (honest empty slate)", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot }); // project the store
    // A project may declare what scopes it REQUIRES without a credential bound.
    store.db
      .prepare(`UPDATE projects SET credential_policy_json = ? WHERE slug = ?`)
      .run(
        JSON.stringify({
          credentialLabel: "viberr-bot · fine-grained PAT",
          masked: "github_pat_••••42af", // even a masked value must NOT surface
          requiredScopes: ["repo", "workflow", "read:org", "pull_request:write"],
        }),
        store.slug,
      );

    openScopeViolation(store.db, VIB142_VIOLATION(store.slug));
    const health = getProjectCredentialHealth(store.db, store.slug);
    // A policy is not a credential: no fabricated card, no leaked masked token.
    expect(health.configured).toBe(false);
    expect(health.source).toBe("none");
    expect(health.label).toBeNull();
    expect(health.masked).toBeNull();
    // requiredScopes still surface (they drive the pre-flight scope check)…
    expect(health.requiredScopes).toEqual([
      "repo",
      "workflow",
      "read:org",
      "pull_request:write",
    ]);
    // …but an open violation is still reported so a blocked task stays visible.
    const prWrite = health.scopes.find((s) => s.id === "pull_request:write");
    expect(prWrite).toMatchObject({
      ok: false,
      source: "violation",
      flaggedTaskKey: "VIB-142",
    });
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
        { id: "repo", ok: false, source: "header" },
        { id: "pull_request:write", ok: true, source: "header" },
      ],
      missingScopes: ["repo"],
      headerScopes: null,
      detail: "Missing scope: repo.",
    });

    openScopeViolation(store.db, VIB142_VIOLATION(store.slug));
    const health = getProjectCredentialHealth(store.db, store.slug);
    expect(health.configured).toBe(true);
    expect(health.source).toBe("pat");
    expect(health.patId).toBe(pat.id);
    expect(health.masked).toBe("····42af");
    // Validator verdict shows through…
    expect(health.scopes.find((s) => s.id === "repo")).toMatchObject({
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

/**
 * Ruling 144(a): the workflow-scope advisory, from a classic token's published
 * list or from an open violation; never for a fine-grained token, never a
 * verdict. Canary: derive it from `validation.scopes` (return [] when the
 * header lacks the scope).
 */
describe("credentialAdvisories (ruling 144)", () => {
  const validation = (tokenKind: "classic" | "fine_grained", headerScopes: string[] | null) => ({
    status: "valid" as const,
    checkedAt: "2026-09-04T00:00:00.000Z",
    login: "bot",
    tokenKind,
    expiresAt: null,
    repo: null,
    scopes: [],
    missingScopes: [],
    headerScopes,
    detail: "",
  });
  it("a classic token without `workflow` gets the header advisory; with it, none; fine-grained, none", () => {
    const [advisory] = credentialAdvisories(validation("classic", ["repo"]), []);
    expect(advisory).toMatchObject({ id: "workflow_scope", scope: "workflow", source: "header" });
    expect(advisory!.text).toContain("cannot push changes under .github/workflows/");
    expect(credentialAdvisories(validation("classic", ["repo", "workflow"]), [])).toEqual([]);
    expect(credentialAdvisories(validation("fine_grained", null), [])).toEqual([]);
    expect(credentialAdvisories(null, [])).toEqual([]);
  });
  it("ruling 360: an open `checks:read` violation is an advisory naming the task and the consequence", () => {
    // CANARY: drop the checks:read arm.
    const advisories = credentialAdvisories(validation("fine_grained", null), [{ scope: "checks:read", taskKey: "BNB-14" }]);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ id: "checks_read", scope: "checks:read", source: "violation" });
    expect(advisories[0]!.text).toContain("(BNB-14)");
    expect(advisories[0]!.text).toContain("Checks: read");
    expect(advisories[0]!.text).toContain("accept dialogs");
    // Beside a workflow advisory, both stand.
    expect(credentialAdvisories(validation("classic", ["repo"]), [{ scope: "checks:read", taskKey: null }])).toHaveLength(2);
  });

  it("an open `workflow` violation names the task and outranks the header", () => {
    const [advisory] = credentialAdvisories(validation("classic", ["repo", "workflow"]), [{ scope: "workflow", taskKey: "JC-6" }]);
    expect(advisory).toMatchObject({ source: "violation" });
    expect(advisory!.text).toContain("(JC-6)");
    expect(advisory!.text).toContain("Re-check");
  });
  it("rides the project credential health", () => {
    const store = setupTestStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda" };
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_advisory0001" }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    recordPatValidation(store.db, pat.id, validation("classic", ["repo"]));
    expect(getProjectCredentialHealth(store.db, store.slug).advisories).toHaveLength(1);
  });
});
