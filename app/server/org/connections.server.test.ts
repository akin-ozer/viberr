import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  getPatValidationRateLimiter,
  PAT_VALIDATION_RATE_LIMIT,
} from "~/server/auth/rate-limit.server";
import { insertUser } from "~/server/auth/user-store.server";
import {
  createConnection,
  getDefaultConnection,
  getDefaultConnectionToken,
  listConnections,
  removeConnection,
  replaceConnectionToken,
  setDefaultConnection,
} from "./connections.server";

/**
 * Org GitHub connections: validation gating (canned transport — nothing is
 * saved unless validation passes), default handling, masked display.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_admin", label: "admin@test" };

// P13-D-33: token validation is rate-limited per actor and the limiter is a
// process-wide singleton, so every case here starts from a full bucket —
// otherwise a long file would fail on the eleventh save for the wrong reason.
beforeEach(() => {
  getPatValidationRateLimiter().reset(ACTOR.userId);
});

function makeDbWithUser() {
  const db = ctx.makeDb();
  insertUser(db, {
    id: "u_admin",
    email: "admin@test.dev",
    name: "Admin Test",
    role: "admin",
  });
  return db;
}

/** Classic token with all required scopes granted via the header. */
function validTransport(owner = "akin-ozer") {
  return fakeGithubFetch({
    "GET /user": {
      body: { login: "akin-ozer" },
      headers: {
        "x-oauth-scopes": "repo, workflow",
        "github-authentication-token-expiration": "2027-07-03 00:00:00 UTC",
      },
    },
    [`GET /users/${owner}`]: { body: { public_repos: 7 } },
  });
}

describe("createConnection", () => {
  it("saves nothing when a scope is missing (mock error copy shape)", async () => {
    const db = makeDbWithUser();
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "x" },
        headers: { "x-oauth-scopes": "repo" }, // workflow missing
      },
    });
    const result = await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_missing_scopes_0001", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("validation_failed");
    if (result.status === "validation_failed") {
      expect(result.message).toContain("Validation failed");
      expect(result.message).toContain("workflow");
      expect(result.message).toContain("Nothing was saved.");
    }
    expect(listConnections(db)).toHaveLength(0);
    expect(
      db.prepare(`SELECT count(*) AS c FROM github_pats`).get(),
    ).toEqual({ c: 0 });
  });

  it("saves nothing when GitHub is unreachable", async () => {
    const db = makeDbWithUser();
    const result = await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_network_down_0001", userId: "u_admin" },
      ACTOR,
      { fetchImpl: unreachableFetch() },
    );
    expect(result.status).toBe("validation_failed");
    expect(listConnections(db)).toHaveLength(0);
  });

  it("persists on success: masked suffix, repos, expiry, first = default", async () => {
    const db = makeDbWithUser();
    const gh = validTransport();
    const result = await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("saved");
    const [conn] = listConnections(db);
    expect(conn).toMatchObject({
      id: "akin-ozer",
      owner: "akin-ozer",
      method: "PAT",
      masked: "····42af",
      def: true,
      repos: 7,
      validationState: "valid",
    });
    expect(conn!.expiresAt).toBeTruthy();
    if (result.status === "saved") {
      expect(result.toast).toContain("akin-ozer connected — scopes verified");
    }
    // The plaintext token never appears in the record.
    expect(JSON.stringify(conn)).not.toContain("ghp_valid_token_42af");
  });

  it("refuses duplicates without a network round-trip", async () => {
    const db = makeDbWithUser();
    const gh = validTransport();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    const before = gh.calls.length;
    const dup = await createConnection(
      db,
      { owner: "Akin Ozer", token: "ghp_other_token_9999", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(dup.status).toBe("duplicate");
    expect(gh.calls.length).toBe(before);
    expect(listConnections(db)).toHaveLength(1);
  });
});

describe("replaceConnectionToken", () => {
  it("keeps the old token active when validation fails", async () => {
    const db = makeDbWithUser();
    const gh = validTransport();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    const bad = fakeGithubFetch({
      "GET /user": { status: 401, body: { message: "Bad credentials" } },
    });
    const result = await replaceConnectionToken(
      db,
      { connectionId: "akin-ozer", token: "ghp_revoked_token_0000" },
      ACTOR,
      { fetchImpl: bad.fetchImpl },
    );
    expect(result.status).toBe("validation_failed");
    // Old suffix survives — the stored token was not swapped.
    expect(listConnections(db)[0]!.masked).toBe("····42af");
  });

  it("swaps the token + refreshes facts on success", async () => {
    const db = makeDbWithUser();
    const gh = validTransport();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    const result = await replaceConnectionToken(
      db,
      { connectionId: "akin-ozer", token: "ghp_replacement_beef" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    expect(result.status).toBe("saved");
    if (result.status === "saved") {
      expect(result.toast).toContain("Token for akin-ozer replaced");
    }
    expect(listConnections(db)[0]!.masked).toBe("····beef");
  });
});

describe("default + remove", () => {
  async function twoConnections(db: ReturnType<typeof makeDbWithUser>) {
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    await createConnection(
      db,
      { owner: "hepapi", token: "ghp_valid_token_1111", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport("hepapi").fetchImpl },
    );
  }

  it("set-default keeps exactly one default", async () => {
    const db = makeDbWithUser();
    await twoConnections(db);
    const result = setDefaultConnection(db, "hepapi", ACTOR);
    expect(result.status).toBe("ok");
    const conns = listConnections(db);
    expect(conns.filter((c) => c.def).map((c) => c.id)).toEqual(["hepapi"]);
    expect(getDefaultConnection(db)!.id).toBe("hepapi");
  });

  it("refuses to remove the default; removing another deletes its PAT", async () => {
    const db = makeDbWithUser();
    await twoConnections(db);
    const refused = removeConnection(db, "akin-ozer", ACTOR);
    expect(refused.status).toBe("is_default");

    const removed = removeConnection(db, "hepapi", ACTOR);
    expect(removed.status).toBe("removed");
    expect(listConnections(db)).toHaveLength(1);
    expect(
      db.prepare(`SELECT count(*) AS c FROM github_pats`).get(),
    ).toEqual({ c: 1 });
  });

  it("default token is only handed out after a passing validation", async () => {
    const db = makeDbWithUser();
    await twoConnections(db);
    const info = getDefaultConnectionToken(db);
    expect(info).not.toBeNull();
    expect(info!.token).toBe("ghp_valid_token_42af");
    // Wipe the cached validation → honest null.
    db.prepare(`UPDATE github_pats SET validation_json = NULL`).run();
    expect(getDefaultConnectionToken(db)).toBeNull();
  });
});

/**
 * P13-D-33: `architecture.md` asks for a targeted limit on PAT validation and
 * there was none. Both save paths call GitHub with a token the CALLER typed,
 * so the connection form was an unmetered outbound-probe surface that also
 * spent the org's GitHub rate-limit budget on every retry.
 */
describe("PAT-validation rate limit", () => {
  it("refuses further validations after the bucket empties, without touching GitHub", async () => {
    const db = makeDbWithUser();
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "x" },
        headers: { "x-oauth-scopes": "repo" }, // workflow missing → always fails
      },
    });
    for (let i = 0; i < PAT_VALIDATION_RATE_LIMIT.capacity; i++) {
      const attempt = await createConnection(
        db,
        { owner: `owner-${i}`, token: "ghp_x", userId: "u_admin" },
        ACTOR,
        { fetchImpl: gh.fetchImpl },
      );
      expect(attempt.status).toBe("validation_failed");
    }
    const spent = gh.calls.length;

    const blocked = await createConnection(
      db,
      { owner: "one-too-many", token: "ghp_x", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(blocked.status).toBe("validation_failed");
    if (blocked.status === "validation_failed") {
      expect(blocked.message).toContain("Too many token validations");
      expect(blocked.message).toContain("Nothing was saved.");
    }
    // The refusal happens BEFORE the network call — that is the whole point.
    expect(gh.calls).toHaveLength(spent);
  });

  it("throttles the replace path too, and one admin never blocks another", async () => {
    const db = makeDbWithUser();
    insertUser(db, {
      id: "u_other",
      email: "other@test.dev",
      name: "Other Admin",
      role: "admin",
    });
    const saved = await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    expect(saved.status).toBe("saved");

    // Drain the rest of this actor's bucket.
    for (let i = 1; i < PAT_VALIDATION_RATE_LIMIT.capacity; i++) {
      getPatValidationRateLimiter().tryConsume(ACTOR.userId);
    }
    const throttled = await replaceConnectionToken(
      db,
      { connectionId: "akin-ozer", token: "ghp_valid_token_42af" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    expect(throttled.status).toBe("validation_failed");
    if (throttled.status === "validation_failed") {
      expect(throttled.message).toContain("Too many token validations");
    }

    // A different admin's bucket is untouched.
    const other = await replaceConnectionToken(
      db,
      { connectionId: "akin-ozer", token: "ghp_valid_token_42af" },
      { userId: "u_other", label: "other@test" },
      { fetchImpl: validTransport().fetchImpl },
    );
    expect(other.status).toBe("saved");
  });
});
