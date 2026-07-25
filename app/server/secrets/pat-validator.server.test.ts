import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  countOpenPolicyViolations,
  findOpenScopeViolation,
  openScopeViolation,
} from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { createPat, getPatMetadata, setProjectCredential } from "./pat-store.server";
import {
  REVALIDATE_COOLDOWN_MS,
  revalidateProjectCredential,
  validatePat,
  validatePatToken,
} from "./pat-validator.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const CLASSIC = "ghp_classic0123456789";
const FINE = "github_pat_11FINE0123456789_finefinefine";
const REPO = "akin-ozer/viberr";
const SCOPES = ["repo", "workflow", "read:org", "pull_request:write"];

describe("pat-validator diagnostic matrix (canned responses)", () => {
  it("classic token with all scopes → valid (header-authoritative)", async () => {
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: {
          "x-oauth-scopes": "repo, workflow, read:org",
          "github-authentication-token-expiration": "2026-12-31 23:59:59 UTC",
        },
      },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
    });
    const result = await validatePatToken(CLASSIC, {
      repo: REPO,
      requiredScopes: SCOPES,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("valid");
    expect(result.login).toBe("viberr-bot");
    expect(result.tokenKind).toBe("classic");
    expect(result.expiresAt).toMatch(/^2026-12-31T/);
    // pull_request:write is implied by classic `repo`.
    const prWrite = result.scopes.find((s) => s.id === "pull_request:write");
    expect(prWrite).toMatchObject({ ok: true, source: "header" });
    expect(result.missingScopes).toEqual([]);
  });

  it("classic token missing scopes → insufficient_scope naming them", async () => {
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo" },
      },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
    });
    const result = await validatePatToken(CLASSIC, {
      repo: REPO,
      requiredScopes: SCOPES,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("insufficient_scope");
    expect(result.missingScopes.sort()).toEqual(["read:org", "workflow"]);
    expect(result.detail).toContain("workflow");
  });

  it("401 with an 'expired' message → expired", async () => {
    const gh = fakeGithubFetch({
      "GET /user": {
        status: 401,
        body: { message: "This personal access token has expired." },
      },
    });
    const result = await validatePatToken(FINE, { fetchImpl: gh.fetchImpl });
    expect(result.status).toBe("expired");
  });

  it("401 'Bad credentials' → revoked, unless a cached expiration passed → expired", async () => {
    const routes = {
      "GET /user": { status: 401, body: { message: "Bad credentials" } },
    };
    const revoked = await validatePatToken(FINE, {
      fetchImpl: fakeGithubFetch(routes).fetchImpl,
    });
    expect(revoked.status).toBe("revoked");

    const expired = await validatePatToken(FINE, {
      fetchImpl: fakeGithubFetch(routes).fetchImpl,
      knownExpiresAt: "2026-01-01T00:00:00.000Z", // in the past
    });
    expect(expired.status).toBe("expired");
  });

  it("repo 404 → repo_not_found (documents the org-approval ambiguity)", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        status: 404,
        body: { message: "Not Found" },
      },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("repo_not_found");
    expect(result.detail).toContain("approval");
  });

  it("repo 403 mentioning approval → org_approval_missing", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        status: 403,
        body: {
          message:
            "This token is pending organization approval before it can access this resource.",
        },
      },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("org_approval_missing");
  });

  it("unreachable network → network_error", async () => {
    const result = await validatePatToken(FINE, {
      fetchImpl: unreachableFetch(),
    });
    expect(result.status).toBe("network_error");
    expect(result.detail).toContain("unreachable");
  });

  it("/user 5xx (GitHub outage) → network_error saying the token was NOT rejected", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { status: 503, body: "upstream unavailable" },
    });
    const result = await validatePatToken(CLASSIC, { fetchImpl: gh.fetchImpl });
    expect(result.status).toBe("network_error");
    expect(result.detail).toContain("degraded");
    expect(result.detail).toContain("NOT rejected");
  });

  it("repo probe 5xx (GitHub outage) → network_error, not repo_not_found/insufficient_scope", async () => {
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo, workflow, read:org" },
      },
      "GET /repos/akin-ozer/viberr": { status: 503, body: "upstream unavailable" },
    });
    const result = await validatePatToken(CLASSIC, {
      repo: REPO,
      requiredScopes: SCOPES,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("network_error");
    expect(result.detail).toContain("NOT rejected");
  });

  it("fine-grained token: probes what it can, assumes the rest (honestly labeled)", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } }, // no scopes header
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: SCOPES,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("valid");
    expect(result.tokenKind).toBe("fine_grained");
    const byId = new Map(result.scopes.map((s) => [s.id, s]));
    expect(byId.get("repo")).toMatchObject({ ok: true, source: "probe" });
    expect(byId.get("read:org")).toMatchObject({ ok: true, source: "probe" });
    expect(byId.get("workflow")).toMatchObject({ ok: true, source: "assumed" });
    expect(byId.get("pull_request:write")).toMatchObject({
      ok: true,
      source: "assumed", // write is unverifiable — documented limitation
    });
  });

  it("fine-grained token refused the pulls read probe → insufficient_scope", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: SCOPES,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("insufficient_scope");
    expect(result.missingScopes).toEqual(["pull_request:write"]);
  });

  // The empty-payload dry-run: GitHub authorizes BEFORE validating the body,
  // so `{}` against a write endpoint answers 422 when the permission is held
  // (nothing can be created from an empty payload) and 403 when it is refused.
  // This is what turns the write scopes from eternal "assumed" chips into
  // probe verdicts for fine-grained tokens.
  it("write dry-runs: 422 on contents + pulls proves both write scopes", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      "PUT /repos/akin-ozer/viberr/contents/viberr-scope-probe": {
        status: 422,
        body: { message: "Invalid request.\n\n\"message\", \"content\" weren't supplied." },
      },
      "POST /repos/akin-ozer/viberr/pulls": {
        status: 422,
        body: { message: "Validation Failed" },
      },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: ["repo", "pull_request:write"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("valid");
    const byId = new Map(result.scopes.map((s) => [s.id, s]));
    expect(byId.get("repo")).toMatchObject({
      ok: true,
      source: "probe",
      note: "read + write proven by dry-run",
    });
    expect(byId.get("pull_request:write")).toMatchObject({
      ok: true,
      source: "probe",
      note: "write proven by dry-run",
    });
    // The dry-runs never mutate: both write calls carried an empty body.
    expect(gh.callsTo("PUT /repos/akin-ozer/viberr/contents/viberr-scope-probe")[0]!.body).toEqual({});
    expect(gh.callsTo("POST /repos/akin-ozer/viberr/pulls")[0]!.body).toEqual({});
  });

  it("write dry-runs: a 403 is a REFUSED write — readable repo goes insufficient_scope", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      "PUT /repos/akin-ozer/viberr/contents/viberr-scope-probe": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
      "POST /repos/akin-ozer/viberr/pulls": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: ["repo", "pull_request:write"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("insufficient_scope");
    expect(result.missingScopes.sort()).toEqual(["pull_request:write", "repo"]);
    const byId = new Map(result.scopes.map((s) => [s.id, s]));
    expect(byId.get("repo")).toMatchObject({
      ok: false,
      source: "probe",
      note: "repository readable but not writable",
    });
    expect(byId.get("pull_request:write")).toMatchObject({
      ok: false,
      source: "probe",
      note: "pull-request write refused",
    });
  });

  it("write dry-runs: an INCONCLUSIVE answer (404/5xx) degrades to the honest fallback, never a false verdict", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      // No PUT/POST routes → the fake answers 404 (resource-hiding ambiguity).
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: ["repo", "pull_request:write"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("valid");
    const byId = new Map(result.scopes.map((s) => [s.id, s]));
    expect(byId.get("repo")).toMatchObject({
      ok: true,
      source: "probe",
      note: "repository readable; write unverified",
    });
    expect(byId.get("pull_request:write")).toMatchObject({
      ok: true,
      source: "assumed",
      note: "read proven; write is unverifiable until used",
    });
  });
});

describe("validatePat / revalidateProjectCredential (stored PAT + grant flow)", () => {
  it("caches the result on the PAT row", async () => {
    const store = setupTestStore(ctx);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: CLASSIC },
      { userId: store.users.arda.id, label: "arda" },
    );
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo, workflow, read:org" },
      },
    });
    const result = await validatePat(store.db, pat.id, {
      requiredScopes: SCOPES,
      fetchImpl: gh.fetchImpl,
    });
    expect(result?.status).toBe("valid");
    const cached = getPatMetadata(store.db, pat.id);
    expect(cached?.validation?.status).toBe("valid");
    expect(cached?.lastValidatedAt).toBe(result?.checkedAt);
    expect(await validatePat(store.db, "pat_missing", {})).toBeNull();
  });

  it("grant flow: revalidation resolves the seeded VIB-142 violation and writes the policy event", async () => {
    const store = setupTestStore(ctx); // slug = viberr-core
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", {
        stage: "review",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // Open the VIB-142 violation the grant flow resolves — it used to be
    // migration-seeded; the squashed baseline is schema-only.
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail: "Project credential is missing pull_request:write.",
    });
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);

    const actor = { userId: store.users.arda.id, label: "arda" };
    // No credential bound yet → typed degraded result.
    expect(
      await revalidateProjectCredential(store.db, store.slug, actor, {
        dataRoot: store.dataRoot,
      }),
    ).toEqual({ status: "no_pat_configured" });

    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: FINE },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    // Network down → typed degraded result, violation untouched.
    const offline = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: unreachableFetch(),
    });
    expect(offline.status).toBe("network_unavailable");
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);

    // Healthy validation (fine-grained: pull_request:write is assumed
    // granted per the documented optimistic contract) → violation resolves,
    // typed policy event lands on VIB-142, projections update.
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    });
    const result = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("revalidated");
    if (result.status === "revalidated") {
      expect(result.resolvedViolations).toHaveLength(1);
      expect(result.resolvedViolations[0]!.taskKey).toBe("VIB-142");
    }
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(0);
    expect(
      findOpenScopeViolation(store.db, store.slug, "pull_request:write", "VIB-142"),
    ).toBeNull();

    // The typed `policy` update event was written to the flagged task…
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.timeline[0]).toMatchObject({
      type: "policy",
      text: expect.stringContaining(
        "**Policy update:** `pull_request:write` granted on the project credential.",
      ),
    });
    // …and reprojected into task_events.
    const eventRow = store.db
      .prepare(
        `SELECT text FROM task_events
         WHERE project_slug = ? AND task_key = 'VIB-142' AND position = 0`,
      )
      .get(store.slug) as { text: string };
    expect(eventRow.text).toContain("**Policy update:**");

    // Re-running is a no-op (idempotent — no second event).
    const again = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch({
        "GET /user": { body: { login: "viberr-bot" } },
        "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
        "GET /user/orgs": { body: [] },
        "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      }).fetchImpl,
    });
    expect(again.status).toBe("revalidated");
    if (again.status === "revalidated") {
      expect(again.resolvedViolations).toHaveLength(0);
    }
    const policyEvents = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.filter((e) => e.type === "policy");
    expect(policyEvents).toHaveLength(1);
  });
});

/**
 * P13-D-33: `last_validated_at` was written and never read, so every press of
 * "Re-check scopes" made a fresh GitHub round trip even on a credential that
 * had just been confirmed valid. The cooldown must suppress ONLY that case —
 * a failing credential is exactly the one an operator re-checks after fixing
 * something on GitHub's side.
 */
describe("PAT revalidation cooldown (P13-D-33)", () => {
  const healthyGithub = () =>
    fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    });

  function bindCredential(store: ReturnType<typeof setupTestStore>, token: string) {
    const actor = { userId: store.users.arda.id, label: "arda" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );
    return { actor, pat };
  }

  it("skips the network call when a VALID result is still fresh", async () => {
    const store = setupTestStore(ctx);
    const { actor } = bindCredential(store, FINE);

    const first = healthyGithub();
    await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: first.fetchImpl,
    });
    expect(first.calls.length).toBeGreaterThan(0);

    // A second press moments later must not touch GitHub at all.
    const second = healthyGithub();
    const result = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: second.fetchImpl,
    });
    expect(second.calls).toHaveLength(0);
    expect(result.status).toBe("revalidated");
    if (result.status === "revalidated") {
      expect(result.validation.status).toBe("valid");
    }
  });

  it("a fresh repo-LESS validation never suppresses the first project-scoped run", async () => {
    // The connection modal validates with `repo: null` (org level — no repo
    // exists yet). That fresh "valid" used to satisfy the cooldown and
    // suppress the attach-time revalidation, pinning a fine-grained token at
    // all-"assumed" chips a repo probe would have upgraded — on the org card
    // too, since both surfaces render the same per-PAT cache.
    const store = setupTestStore(ctx);
    // The projects TABLE row (repo column) is what revalidation resolves the
    // target repo from — project the file into it.
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const { actor, pat } = bindCredential(store, FINE);

    // Same routes as the project-scoped fake MINUS the repo — so the cache is
    // a genuinely VALID repo-less result (all four default scopes pass), the
    // exact thing the connection modal produces.
    const orgLevel = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /user/orgs": { body: [] },
    });
    await validatePat(store.db, pat.id, { repo: null, fetchImpl: orgLevel.fetchImpl });

    const projectScoped = healthyGithub();
    const result = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: projectScoped.fetchImpl,
    });
    // The repo-context change re-probed despite the fresh cache…
    expect(projectScoped.calls.length).toBeGreaterThan(0);
    expect(result.status).toBe("revalidated");
    if (result.status === "revalidated") {
      // …and the shared cache now carries probe-backed verdicts.
      expect(result.validation.repo).toBe(REPO);
      const repoScope = result.validation.scopes.find((s) => s.id === "repo");
      expect(repoScope).toMatchObject({ ok: true, source: "probe" });
    }
  });

  it("re-probes once the cooldown has elapsed", async () => {
    const store = setupTestStore(ctx);
    const { actor } = bindCredential(store, FINE);

    const first = healthyGithub();
    await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: first.fetchImpl,
    });

    const later = healthyGithub();
    await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: later.fetchImpl,
      now: () => Date.now() + REVALIDATE_COOLDOWN_MS + 1,
    });
    expect(later.calls.length).toBeGreaterThan(0);
  });

  it("NEVER suppresses a re-check of a failing credential", async () => {
    const store = setupTestStore(ctx);
    const { actor } = bindCredential(store, CLASSIC);

    // Classic token missing `repo` (only `gist`) → insufficient_scope, cached
    // as such. (The fixture used to miss the mock-era `workflow`, dropped by
    // owner ruling 2026-07-25 — a repo-scoped token is no longer failing.)
    const failing = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "gist" },
      },
    });
    const before = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: failing.fetchImpl,
    });
    expect(before.status).toBe("revalidated");
    if (before.status === "revalidated") {
      expect(before.validation.status).toBe("insufficient_scope");
    }

    // The operator grants the scope on GitHub and presses re-check immediately:
    // the cooldown must not stand between them and the fixed answer.
    const fixed = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo" },
      },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
    });
    const after = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fixed.fetchImpl,
    });
    expect(fixed.calls.length).toBeGreaterThan(0);
    if (after.status === "revalidated") {
      expect(after.validation.status).toBe("valid");
    }
  });

  it("records whether the attempt was served from cache", async () => {
    const store = setupTestStore(ctx);
    const { actor } = bindCredential(store, FINE);

    await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: healthyGithub().fetchImpl,
    });
    await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: healthyGithub().fetchImpl,
    });

    // Both attempts are audited; exactly one of them touched GitHub. (Order is
    // not asserted — both rows land in the same ISO second.)
    const cachedFlags = listAuditEvents(store.db, {
      action: "github.credential.revalidated",
    }).map((r) => r.details?.cached);
    expect(cachedFlags).toHaveLength(2);
    expect([...cachedFlags].sort()).toEqual([false, true]);
  });
});
