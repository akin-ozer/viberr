import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fakeGithubFetch,
  unreachableFetch,
  type FakeResponder,
} from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  getPatValidationRateLimiter,
  PAT_VALIDATION_RATE_LIMIT,
} from "~/server/auth/rate-limit.server";
import { insertUser } from "~/server/auth/user-store.server";
import {
  DEFAULT_REQUIRED_SCOPES,
  getProjectCredentialHealth,
  markWriteScopeProven,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import { validatePat } from "~/server/secrets/pat-validator.server";
import {
  createConnection,
  ensureConnectionFresh,
  getDefaultConnection,
  getDefaultConnectionToken,
  getDefaultConnectionTokenFresh,
  listConnections,
  recheckConnection,
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
    // Ruling 463: what the token reaches, one of them private.
    "GET /user/repos": {
      body: [
        { full_name: `${owner}/site`, private: false, permissions: { push: true } },
        { full_name: `${owner}/website`, private: true, permissions: { push: true } },
      ],
    },
  });
}

describe("createConnection", () => {
  it("saves nothing when a scope is missing (mock error copy shape)", async () => {
    const db = makeDbWithUser();
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "x" },
        // `repo` missing (and with it the implied pull_request:write). The
        // former fixture was refused for the mock-era `workflow` — dropped by
        // owner ruling 2026-07-25, so a repo-scoped classic token now passes.
        headers: { "x-oauth-scopes": "gist" },
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
      expect(result.message).toContain("repo");
      expect(result.message).toContain("Nothing was saved.");
      // B-GH2/B-GH6: the refusal NAMES the one minimum the project scope chips
      // use. The sentence hard-coded "repo · workflow · pull_request:write" for
      // three passes after the owner dropped `workflow` — telling people to
      // widen a token Viberr no longer wants.
      expect(result.message).toContain(
        `Minimum scopes: ${DEFAULT_REQUIRED_SCOPES.join(" · ")}.`,
      );
      expect(result.message).not.toContain("workflow");
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

  it("persists on success: masked suffix, reach, expiry, first = default", async () => {
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
      validationState: "valid",
      tokenKind: "classic",
      reach: { status: "read", total: 2, privateCount: 1, capped: false },
    });
    // Ruling 463: the account's public count is no longer a field anyone reads.
    expect(conn).not.toHaveProperty("repos");
    expect(conn!.expiresAt).toBeTruthy();
    if (result.status === "saved") {
      expect(result.toast).toContain("akin-ozer connected — scopes verified");
    }
    // The plaintext token never appears in the record.
    expect(JSON.stringify(conn)).not.toContain("ghp_valid_token_42af");
  });

  it("ruling 144(a): the workflow-scope advisory rides the connection record from the token's header", async () => {
    // Canary: return `[]` for `advisories` in the record builder.
    const db = makeDbWithUser();
    const withWorkflow = await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    expect(withWorkflow.status).toBe("saved");
    expect(listConnections(db)[0]!.advisories).toEqual([]);

    const bare = makeDbWithUser();
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "other-owner" }, headers: { "x-oauth-scopes": "repo" } },
      "GET /users/other-owner": { body: { public_repos: 1 } },
    });
    const without = await createConnection(
      bare,
      { owner: "other-owner", token: "ghp_valid_token_beef", userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(without.status).toBe("saved");
    const [conn] = listConnections(bare);
    expect(conn!.advisories).toHaveLength(1);
    expect(conn!.advisories[0]).toMatchObject({ id: "workflow_scope", source: "header" });
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

/**
 * B-GH7: nothing polls GitHub for connection health, so a `valid` verdict was
 * trusted forever — a token revoked on github.com kept clearing every gate that
 * reads `validationState` until a human re-checked by hand.
 */
describe("stale connection revalidation", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("leaves a fresh verdict alone — no probe at all", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    const gh = fakeGithubFetch({});
    const fresh = await ensureConnectionFresh(db, "akin-ozer", {
      fetchImpl: gh.fetchImpl,
    });
    expect(fresh!.validationState).toBe("valid");
    expect(gh.calls).toHaveLength(0);
  });

  it("re-probes past the staleness window and DOWNGRADES a revoked token", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    const revoked = fakeGithubFetch({
      "GET /user": {
        status: 401,
        body: { message: "Bad credentials" },
      },
    });
    // Fails on main: `getDefaultConnectionTokenFresh` did not exist and the
    // cached "valid" was handed out unconditionally.
    const info = await getDefaultConnectionTokenFresh(db, {
      fetchImpl: revoked.fetchImpl,
      now: () => Date.now() + 2 * DAY,
    });
    expect(info).toBeNull();
    expect(getDefaultConnection(db)!.validationState).toBe("failed");
    expect(revoked.callsTo("GET /user")).toHaveLength(1);
  });

  it("an unreachable GitHub is NOT a downgrade", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    const after = await ensureConnectionFresh(db, "akin-ozer", {
      fetchImpl: unreachableFetch(),
      now: () => Date.now() + 2 * DAY,
    });
    expect(after!.validationState).toBe("valid");
  });
});

/**
 * Ruling 463 (pass 40, F40-6): a connection records which repositories its
 * TOKEN reaches. The card read "PAT ····k3ui · 3 public repos", the ACCOUNT's
 * public count, while the fine-grained token behind it was granted a private
 * repository that count could never show; and the controller could not tell
 * whether a token reached the repository it was asked to build on.
 */
describe("ruling 463: what the token reaches", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const TOKEN = "github_pat_reach_test_token_0000000000";

  /** A fine-grained token (no scope header) and a scripted `/user/repos`. */
  function reachTransport(repos: FakeResponder) {
    return fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /users/akin-ozer": { body: {} },
      "GET /user/repos": repos,
    });
  }

  /** `n` repositories named r-<offset+i>. */
  function page(n: number, offset = 0) {
    return Array.from({ length: n }, (_, i) => ({
      full_name: `akin-ozer/r-${offset + i}`,
      private: false,
      permissions: { push: true },
    }));
  }

  // CANARY: skip the reach read in `validateConnectionToken` (store NULL) and
  // `reach` reads null; drop `private` or `permissions.push` from the mapping
  // and the rows below differ.
  it("a save reads GET /user/repos for the token and records each repository with private and push", async () => {
    const db = makeDbWithUser();
    const gh = reachTransport({
      body: [
        { full_name: "akin-ozer/website", private: true, permissions: { admin: false, push: true, pull: true } },
        { full_name: "akin-ozer/docs", private: false, permissions: { push: false, pull: true } },
        { full_name: "someone/shared", private: false },
      ],
    });
    const saved = await createConnection(
      db,
      { owner: "akin-ozer", token: TOKEN, userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(saved.status).toBe("saved");
    if (saved.status === "saved") {
      expect(saved.toast).toContain("It reaches 3 repositories · 1 private");
    }
    const calls = gh.callsTo("GET /user/repos");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
    expect(calls[0]!.url.searchParams.get("affiliation")).toBe(
      "owner,collaborator,organization_member",
    );
    const [conn] = listConnections(db);
    expect(conn!.tokenKind).toBe("fine_grained");
    expect(conn!.reach).toMatchObject({
      status: "read",
      total: 3,
      privateCount: 1,
      capped: false,
      repos: [
        { fullName: "akin-ozer/website", private: true, canPush: true },
        { fullName: "akin-ozer/docs", private: false, canPush: false },
        // No permission block is "unknown", never "cannot push".
        { fullName: "someone/shared", private: false, canPush: null },
      ],
    });
    expect(JSON.stringify(conn)).not.toContain(TOKEN);
  });

  // CANARY: store `{status: "read", repos: []}` on a failed read and the
  // reach reads as zero repositories instead of unknown.
  it("a failed read is recorded as unknown with GitHub's reason, never as zero, and never refuses the save", async () => {
    const db = makeDbWithUser();
    const gh = reachTransport({
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
    });
    const saved = await createConnection(
      db,
      { owner: "akin-ozer", token: TOKEN, userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(saved.status).toBe("saved");
    const [conn] = listConnections(db);
    expect(conn!.reach).toEqual({
      status: "unknown",
      readAt: expect.any(String),
      reason:
        "GitHub answered 403 on /user/repos (Resource not accessible by personal access token)",
    });

    // The validation answers; the reach read then finds GitHub gone.
    const down = makeDbWithUser();
    getPatValidationRateLimiter().reset(ACTOR.userId);
    const upstream = reachTransport({ body: [] });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/user/repos")) throw new TypeError("fetch failed");
      return upstream.fetchImpl(input, init);
    };
    await createConnection(
      down,
      { owner: "akin-ozer", token: TOKEN, userId: "u_admin" },
      ACTOR,
      { fetchImpl },
    );
    expect(listConnections(down)[0]!.reach).toMatchObject({
      status: "unknown",
      reason: "GitHub was unreachable (fetch failed)",
    });
  });

  // CANARY: stop after the first page and the second is never asked for;
  // drop the page limit and a fourth page is requested.
  it("pages 100 at a time and stops at 300 with the cap stated", async () => {
    const db = makeDbWithUser();
    const gh = reachTransport((call) => {
      const n = Number(call.url.searchParams.get("page"));
      return { body: page(100, (n - 1) * 100) };
    });
    await createConnection(
      db,
      { owner: "akin-ozer", token: TOKEN, userId: "u_admin" },
      ACTOR,
      { fetchImpl: gh.fetchImpl },
    );
    expect(gh.callsTo("GET /user/repos").map((c) => c.url.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(listConnections(db)[0]!.reach).toMatchObject({
      status: "read",
      total: 300,
      capped: true,
    });

    const short = makeDbWithUser();
    getPatValidationRateLimiter().reset(ACTOR.userId);
    const two = reachTransport((call) =>
      call.url.searchParams.get("page") === "1" ? { body: page(100) } : { body: page(7, 100) },
    );
    await createConnection(
      short,
      { owner: "akin-ozer", token: TOKEN, userId: "u_admin" },
      ACTOR,
      { fetchImpl: two.fetchImpl },
    );
    expect(two.callsTo("GET /user/repos")).toHaveLength(2);
    expect(listConnections(short)[0]!.reach).toMatchObject({
      status: "read",
      total: 107,
      capped: false,
    });
  });

  // CANARY: leave `reach_json` out of the replace UPDATE and the old reach
  // survives the new token.
  it("a replaced token's reach replaces the old one", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    const narrower = reachTransport({
      body: [{ full_name: "akin-ozer/website", private: true, permissions: { push: true } }],
    });
    await replaceConnectionToken(
      db,
      { connectionId: "akin-ozer", token: TOKEN },
      ACTOR,
      { fetchImpl: narrower.fetchImpl },
    );
    expect(listConnections(db)[0]!.reach).toMatchObject({
      status: "read",
      total: 1,
      privateCount: 1,
    });
  });

  // CANARY: drop the reach from `ensureConnectionFresh`'s UPDATE and the
  // stale re-proof keeps the old list; read the reach of a refused token and
  // the second arm asks /user/repos.
  it("the 24-hour re-proof re-reads the reach; a token GitHub refuses has an unknown reach and no read is spent", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    const grown = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" }, headers: { "x-oauth-scopes": "repo" } },
      "GET /user/repos": { body: page(5) },
    });
    await ensureConnectionFresh(db, "akin-ozer", {
      fetchImpl: grown.fetchImpl,
      now: () => Date.now() + 2 * DAY,
    });
    expect(listConnections(db)[0]!.reach).toMatchObject({ status: "read", total: 5 });

    const revoked = fakeGithubFetch({
      "GET /user": { status: 401, body: { message: "Bad credentials" } },
      "GET /user/repos": { body: page(5) },
    });
    await ensureConnectionFresh(db, "akin-ozer", {
      fetchImpl: revoked.fetchImpl,
      now: () => Date.now() + 4 * DAY,
    });
    const after = listConnections(db)[0]!;
    expect(after.validationState).toBe("failed");
    expect(after.reach).toMatchObject({
      status: "unknown",
      reason: "The token failed validation (revoked), so which repositories it reaches was not read.",
    });
    expect(revoked.callsTo("GET /user/repos")).toHaveLength(0);
  });

  // CANARY: make `recheckConnection` return before its UPDATE and the reach
  // stays unread; drop its audit and the row is missing.
  it("Re-check reads the reach of a connection saved before the read existed, and audits it", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    // A root that predates ruling 463: the column is NULL.
    db.prepare(`UPDATE github_connections SET reach_json = NULL`).run();
    expect(listConnections(db)[0]!.reach).toBeNull();

    const result = await recheckConnection(db, "akin-ozer", ACTOR, {
      fetchImpl: validTransport().fetchImpl,
    });
    expect(result.status).toBe("rechecked");
    if (result.status === "rechecked") {
      expect(result.toast).toBe(
        "akin-ozer re-checked: scopes verified. It reaches 2 repositories · 1 private",
      );
    }
    expect(listConnections(db)[0]!.reach).toMatchObject({ status: "read", total: 2 });
    const rows = listAuditEvents(db, { action: "org.connection.rechecked" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({
      owner: "akin-ozer",
      status: "valid",
      reach: "2 repositories · 1 private",
    });
  });

  it("Re-check: an unreachable GitHub changes nothing, a refused token is refused out loud, a missing connection says so", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    const down = await recheckConnection(db, "akin-ozer", ACTOR, {
      fetchImpl: unreachableFetch(),
    });
    expect(down.status).toBe("refused");
    if (down.status === "refused") expect(down.message).toContain("Nothing changed.");
    expect(listConnections(db)[0]!.reach).toMatchObject({ status: "read", total: 2 });

    const revoked = await recheckConnection(db, "akin-ozer", ACTOR, {
      fetchImpl: fakeGithubFetch({
        "GET /user": { status: 401, body: { message: "Bad credentials" } },
      }).fetchImpl,
    });
    expect(revoked.status).toBe("refused");
    if (revoked.status === "refused") {
      expect(revoked.message).toContain("Re-checked akin-ozer: GitHub rejected the token");
    }
    const after = listConnections(db)[0]!;
    expect(after.validationState).toBe("failed");
    expect(after.reach?.status).toBe("unknown");

    expect((await recheckConnection(db, "nobody", ACTOR)).status).toBe("not_found");
  });
});

/**
 * Ruling 480 (F40-43), the live sequence: a fine-grained token is attached to
 * a project (GitHub's permission block proves `repo` on that repository), then
 * an admin presses Re-check on Instance settings. The Re-check asks about no
 * repository, and used to overwrite the one cached validation the project card
 * read, so the project's proven `repo` went back to "unproven".
 */
describe("ruling 480: a connection Re-check never unproves a repository", () => {
  const TOKEN = "github_pat_ruling480_token_00000000k3ui";
  const REPO = "akin-ozer/website";

  function transport() {
    return fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /users/akin-ozer": { body: {} },
      "GET /user/repos": {
        body: [{ full_name: REPO, private: true, permissions: { push: true } }],
      },
      [`GET /repos/${REPO}`]: { body: { permissions: { push: true, pull: true } } },
      [`GET /repos/${REPO}/pulls`]: { body: [] },
    });
  }

  // CANARY: make `repoScopesAfter` drop the proofs on a repo-less run and the
  // project's chip reads `assumed` after the Re-check; list the repository's
  // probe as a token-wide chip again and `scopes` carries `probe`.
  it("the project card keeps its proof, and the connection card lists it under the repository", async () => {
    const db = makeDbWithUser();
    const saved = await createConnection(
      db,
      { owner: "akin-ozer", token: TOKEN, userId: "u_admin" },
      ACTOR,
      { fetchImpl: transport().fetchImpl },
    );
    expect(saved.status).toBe("saved");
    const patId = listConnections(db)[0]!.patId;
    db.prepare(
      `INSERT INTO projects (slug, name, repo, task_prefix, source_path, content_hash, parsed_at)
       VALUES ('akinozer-com', 'akinozer.com', ?, 'WEB', 'projects/akinozer-com/project.md', 'x', '2026-09-24')`,
    ).run(REPO);
    setProjectCredential(db, { projectSlug: "akinozer-com", patId }, ACTOR);
    // The attach probe (`proveAttachedCredential` → `validatePat` with the
    // project's repository).
    await validatePat(db, patId, { repo: REPO, fetchImpl: transport().fetchImpl });
    const repoChip = () =>
      getProjectCredentialHealth(db, "akinozer-com").scopes.find((s) => s.id === "repo");
    expect(repoChip()).toEqual({ id: "repo", ok: true, source: "probe" });
    // The token's newest validation is now that repository's: the connection
    // card still keeps its chips token-wide and lists the repository instead.
    const attached = listConnections(db)[0]!;
    expect(attached.scopes.find((s) => s.id === "repo")).toMatchObject({ source: "assumed" });
    expect(attached.repoProofs).toEqual([{ repo: REPO, proven: ["repo"], refused: [] }]);

    getPatValidationRateLimiter().reset(ACTOR.userId);
    const rechecked = await recheckConnection(db, "akin-ozer", ACTOR, {
      fetchImpl: transport().fetchImpl,
    });
    expect(rechecked.status).toBe("rechecked");
    expect(repoChip()).toEqual({ id: "repo", ok: true, source: "probe" });

    const card = listConnections(db)[0]!;
    // Token-wide, a fine-grained token proves neither scope…
    expect(card.scopes.map((s) => `${s.id}:${s.source}`)).toEqual([
      "repo:assumed",
      "pull_request:write:assumed",
    ]);
    // …and the repository that proved `repo` says so.
    expect(card.repoProofs).toEqual([{ repo: REPO, proven: ["repo"], refused: [] }]);
  });

  it("a classic token's header answers for every repository, so no repository line repeats it", async () => {
    const db = makeDbWithUser();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_valid_token_42af", userId: "u_admin" },
      ACTOR,
      { fetchImpl: validTransport().fetchImpl },
    );
    const patId = listConnections(db)[0]!.patId;
    markWriteScopeProven(db, patId, REPO, "push");
    const card = listConnections(db)[0]!;
    expect(card.scopes.map((s) => `${s.id}:${s.source}`)).toEqual([
      "repo:header",
      "pull_request:write:header",
    ]);
    expect(card.repoProofs).toEqual([]);
  });
});
