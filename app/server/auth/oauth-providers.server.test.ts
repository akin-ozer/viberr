import { describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  deleteOAuthProvider,
  getOAuthProviderRow,
  oauthConfigFingerprint,
  readOAuthSecret,
  recordOAuthVerification,
  resolveOAuthProvider,
  saveOAuthProvider,
  setOAuthProviderEnabled,
} from "./oauth-providers.server";
import { testOAuthCredentials } from "./oauth-credential-test.server";

const dbCtx = createTestDbContext();
const ACTOR = { userId: "u_admin", label: "admin@viberr.dev" };

function setup() {
  return dbCtx.makeDb();
}

describe("R19-16 oauth provider store", () => {
  it("seals the secret — the stored column is never the plaintext", () => {
    const db = setup();
    saveOAuthProvider(
      db,
      { provider: "github", clientId: "Iv1.abc", clientSecret: "s3cr3t-value" },
      ACTOR,
    );
    // SAFETY: the SELECT names one column, declared `client_secret TEXT NOT
    // NULL`, and the save above inserted the row this WHERE matches — so the
    // read is one row of exactly this shape.
    const raw = db
      .prepare(`SELECT client_secret FROM oauth_providers WHERE provider = 'github'`)
      .get() as { client_secret: string };
    expect(raw.client_secret).not.toContain("s3cr3t-value");
    // …and still opens back to it for the auth handler.
    expect(readOAuthSecret(db, "github")).toBe("s3cr3t-value");
  });

  it("saving never enables, and enabling REFUSES without a passing test", () => {
    const db = setup();
    saveOAuthProvider(
      db,
      { provider: "github", clientId: "Iv1.abc", clientSecret: "shhh-secret" },
      ACTOR,
    );
    expect(getOAuthProviderRow(db, "github")!.enabled).toBe(false);

    const refused = setOAuthProviderEnabled(db, "github", true, ACTOR);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("Test the credentials first");
    expect(resolveOAuthProvider(db, "github").credentials).toBeNull();

    recordOAuthVerification(db, "github", { ok: true, detail: "accepted" }, ACTOR);
    const allowed = setOAuthProviderEnabled(db, "github", true, ACTOR);
    expect(allowed.ok).toBe(true);
    expect(resolveOAuthProvider(db, "github").credentials).toEqual({
      clientId: "Iv1.abc",
      clientSecret: "shhh-secret",
    });
  });

  it("changing a credential clears the verdict AND switches the method off", () => {
    const db = setup();
    saveOAuthProvider(
      db,
      { provider: "google", clientId: "id-one", clientSecret: "secret-one" },
      ACTOR,
    );
    recordOAuthVerification(db, "google", { ok: true, detail: "accepted" }, ACTOR);
    setOAuthProviderEnabled(db, "google", true, ACTOR);
    expect(getOAuthProviderRow(db, "google")!.enabled).toBe(true);

    // A proof belongs to the pair it was made against — rotating the secret
    // must not leave a live provider standing on it.
    saveOAuthProvider(
      db,
      { provider: "google", clientId: "id-one", clientSecret: "secret-two" },
      ACTOR,
    );
    const row = getOAuthProviderRow(db, "google")!;
    expect(row.verifiedAt).toBeNull();
    expect(row.enabled).toBe(false);
    expect(resolveOAuthProvider(db, "google").credentials).toBeNull();
  });

  it("a FAILED test takes a live provider back off", () => {
    const db = setup();
    saveOAuthProvider(
      db,
      { provider: "github", clientId: "Iv1.abc", clientSecret: "shhh-secret" },
      ACTOR,
    );
    recordOAuthVerification(db, "github", { ok: true, detail: "accepted" }, ACTOR);
    setOAuthProviderEnabled(db, "github", true, ACTOR);

    recordOAuthVerification(db, "github", { ok: false, detail: "rejected" }, ACTOR);
    const row = getOAuthProviderRow(db, "github")!;
    expect(row.enabled).toBe(false);
    expect(row.verifiedAt).toBeNull();
  });

  it("an omitted secret keeps the stored one (write-only field)", () => {
    const db = setup();
    saveOAuthProvider(
      db,
      { provider: "github", clientId: "Iv1.abc", clientSecret: "keep-this-one" },
      ACTOR,
    );
    saveOAuthProvider(db, { provider: "github", clientId: "Iv1.xyz" }, ACTOR);
    expect(readOAuthSecret(db, "github")).toBe("keep-this-one");
    expect(getOAuthProviderRow(db, "github")!.clientId).toBe("Iv1.xyz");
  });

  it("the fingerprint moves on every change the auth instance must see", () => {
    const db = setup();
    const empty = oauthConfigFingerprint(db);
    saveOAuthProvider(
      db,
      { provider: "github", clientId: "Iv1.abc", clientSecret: "shhh-secret" },
      ACTOR,
    );
    const saved = oauthConfigFingerprint(db);
    expect(saved).not.toBe(empty);

    recordOAuthVerification(db, "github", { ok: true, detail: "ok" }, ACTOR);
    setOAuthProviderEnabled(db, "github", true, ACTOR);
    const enabled = oauthConfigFingerprint(db);
    expect(enabled).not.toBe(saved);

    // Non-secret by construction: rotating the secret still moves it (via
    // updated_at) without the secret ever entering the string.
    saveOAuthProvider(
      db,
      { provider: "github", clientId: "Iv1.abc", clientSecret: "rotated-secret" },
      ACTOR,
    );
    expect(oauthConfigFingerprint(db)).not.toBe(enabled);
    expect(oauthConfigFingerprint(db)).not.toContain("rotated-secret");

    deleteOAuthProvider(db, "github", ACTOR);
    expect(oauthConfigFingerprint(db)).toBe(empty);
  });

  it("every mutation lands in the audit trail", () => {
    const db = setup();
    saveOAuthProvider(
      db,
      { provider: "github", clientId: "Iv1.abc", clientSecret: "shhh-secret" },
      ACTOR,
    );
    recordOAuthVerification(db, "github", { ok: true, detail: "ok" }, ACTOR);
    setOAuthProviderEnabled(db, "github", true, ACTOR);
    deleteOAuthProvider(db, "github", ACTOR);
    // SAFETY: the SELECT names one column, declared `action TEXT NOT NULL`.
    const actions = (
      db
        .prepare(`SELECT action FROM audit_events ORDER BY rowid`)
        .all() as { action: string }[]
    ).map((r) => r.action);
    expect(actions).toEqual([
      "org.oauth_provider.created",
      "org.oauth_provider.tested",
      "org.oauth_provider.enabled",
      "org.oauth_provider.removed",
    ]);
    // The secret never reaches the audit details.
    // SAFETY: the SELECT names one column, and every mutation above records a
    // `details` payload — so `details_json` is written on all four rows.
    const details = db
      .prepare(`SELECT details_json FROM audit_events`)
      .all() as { details_json: string }[];
    for (const d of details) expect(d.details_json).not.toContain("shhh-secret");
  });
});

describe("R19-16 credential test", () => {
  it("reads GitHub's 401 as a bad pair and its 404 as a good one", async () => {
    const bad = await testOAuthCredentials("github", "id", "secret", {
      fetchImpl: async () => new Response("{}", { status: 401 }),
    });
    expect(bad.ok).toBe(false);

    const good = await testOAuthCredentials("github", "id", "secret", {
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });
    expect(good.ok).toBe(true);
  });

  it("reads Google's invalid_client as bad and invalid_grant as good", async () => {
    const bad = await testOAuthCredentials("google", "id", "secret", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
        }),
    });
    expect(bad.ok).toBe(false);

    // The pair authenticated; only the deliberately-invalid code was refused.
    const good = await testOAuthCredentials("google", "id", "secret", {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    });
    expect(good.ok).toBe(true);
  });

  it("an unreachable provider is a NEGATIVE result, never a throw", async () => {
    const result = await testOAuthCredentials("github", "id", "secret", {
      fetchImpl: async () => {
        throw new Error("network down: Basic aWQ6c2VjcmV0");
      },
    });
    expect(result.ok).toBe(false);
    // The thrown error can carry the request — and the request carries the
    // secret, so its text must never be echoed.
    if (!result.ok) expect(result.reason).not.toContain("aWQ6c2VjcmV0");
  });
});
