import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { withEnv } from "../../../test-support/env";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  countOpenPolicyViolations,
  findOpenScopeViolation,
  openScopeViolation,
} from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  createPat,
  getPatMetadata,
  recordPatValidation,
  setProjectCredential,
} from "./pat-store.server";
import {
  repoPermissionsSchema,
  repoWritable,
  revalidateProjectCredential,
  validatePatToken,
} from "./pat-validator.server";

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

  // B11: an EMPTY `x-oauth-scopes` on a classic token is a positive fact — the
  // token holds no scopes. The header branch used to require a NON-empty header,
  // so this token fell into the fine-grained probe and came back
  // `pull_request:write: assumed` ("fine-grained tokens expose no scope
  // introspection") — an assumed-granted chip for a token GitHub had just told
  // us can do nothing — while `tokenKind` on the same result said `classic`.
  it("classic token with an EMPTY scopes header → insufficient_scope, not assumed", async () => {
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "" },
      },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
    });
    const result = await validatePatToken(CLASSIC, {
      repo: REPO,
      requiredScopes: SCOPES,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.tokenKind).toBe("classic");
    expect(result.status).toBe("insufficient_scope");
    expect(result.missingScopes.sort()).toEqual(SCOPES.slice().sort());
    for (const scope of result.scopes) {
      expect(scope).toMatchObject({ ok: false, source: "header" });
      expect(scope.note).toContain("no scopes at all");
    }
  });

  // …but an empty header on a token whose PREFIX proves nothing stays unknown:
  // GitHub omits the header entirely for fine-grained tokens, so absence there
  // really is missing information and the probe branch is the honest one.
  it("empty scopes header on an unknown-prefix token still probes", async () => {
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "" },
      },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: true } },
      },
      "GET /user/orgs": { body: [] },
    });
    const result = await validatePatToken("some_opaque_token_0123456789", {
      repo: REPO,
      requiredScopes: ["read:org"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.tokenKind).toBe("unknown");
    expect(result.scopes[0]).toMatchObject({ id: "read:org", source: "probe" });
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
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: true } },
      },
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

  /**
   * A8/pass-16 — validation must not WRITE to a user's repository.
   *
   * These tests previously asserted the opposite: that every revalidation
   * issued `PUT /repos/{repo}/contents/viberr-scope-probe`. That call is
   * non-destructive by construction (GitHub authorizes before validating the
   * body, so `{}` can only 422) but it is still a write REQUEST against a real
   * repository as a side effect of a health check — audit-log noise, ruleset
   * and branch-protection noise, and destructive the day GitHub reorders
   * validation. Repository write is now proven READ-ONLY from the `permissions`
   * block GitHub computes for the authenticated token.
   */
  it("proves repository write READ-ONLY from the repo permissions block — no write request", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { admin: false, push: true, pull: true } },
      },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
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
      note: "read + write reported by GitHub for this token",
    });
    // THE point of the fix: nothing was written to the repository.
    expect(
      gh.callsTo("PUT /repos/akin-ozer/viberr/contents/viberr-scope-probe"),
    ).toHaveLength(0);
    expect(gh.callsTo("POST /repos/akin-ozer/viberr/pulls")).toHaveLength(0);
  });

  it("a read-only permissions block is a REFUSED write — insufficient_scope, still no write request", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: false, pull: true } },
      },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: ["repo"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("insufficient_scope");
    expect(result.missingScopes).toEqual(["repo"]);
    expect(result.scopes[0]).toMatchObject({
      ok: false,
      source: "probe",
      note: "repository readable but not writable",
    });
    expect(
      gh.callsTo("PUT /repos/akin-ozer/viberr/contents/viberr-scope-probe"),
    ).toHaveLength(0);
  });

  it("F21-11: one drifted permission key does not void the block — a proven read-only repo still refuses", async () => {
    // The exact payload from the finding: GitHub asserts push:false (read-only)
    // next to a `triage` that is not a boolean. Five strict booleans inside a
    // block-level catch discarded the WHOLE block for that one key, so
    // repoWriteOk went null → scope `assumed` → status "valid": a silent
    // UPGRADE claiming write access GitHub had just denied.
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: {
          full_name: REPO,
          permissions: {
            admin: false,
            maintain: false,
            push: false,
            triage: "yes",
            pull: true,
          },
        },
      },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: ["repo"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("insufficient_scope");
    expect(result.missingScopes).toEqual(["repo"]);
    expect(result.scopes[0]).toMatchObject({
      ok: false,
      source: "probe",
      note: "repository readable but not writable",
    });
  });

  it("no permissions block → readable-but-unverified, reported as ASSUMED (never a false 'proven')", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } }, // no permissions
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    });
    const result = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: ["repo", "pull_request:write"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("valid");
    const byId = new Map(result.scopes.map((s) => [s.id, s]));
    // `assumed`, so B-GH8 will NOT clear a write violation off it.
    expect(byId.get("repo")).toMatchObject({ ok: true, source: "assumed" });
    expect(byId.get("repo")!.note).toContain("write is unverified");
    expect(byId.get("pull_request:write")).toMatchObject({
      ok: true,
      source: "assumed",
    });
    // The chip discloses the opt-in that WOULD prove it.
    expect(byId.get("pull_request:write")!.note).toContain(
      "VIBERR_GITHUB_WRITE_PROBE=1",
    );
  });

  it("the write dry-run runs ONLY when explicitly opted in (and then proves pull_request:write)", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: true } },
      },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      "POST /repos/akin-ozer/viberr/pulls": {
        status: 422,
        body: { message: "Validation Failed" },
      },
    });
    const result = await withEnv({ VIBERR_GITHUB_WRITE_PROBE: "1" }, () =>
      validatePatToken(FINE, {
        repo: REPO,
        requiredScopes: ["repo", "pull_request:write"],
        fetchImpl: gh.fetchImpl,
      }),
    );
    expect(result.status).toBe("valid");
    const byId = new Map(result.scopes.map((s) => [s.id, s]));
    expect(byId.get("pull_request:write")).toMatchObject({
      ok: true,
      source: "probe",
      note: "write proven by dry-run",
    });
    // Even opted in, the dry-run carries an empty body and never touches
    // repository CONTENTS — the contents PUT is gone for good.
    expect(gh.callsTo("POST /repos/akin-ozer/viberr/pulls")[0]!.body).toEqual({});
    expect(
      gh.callsTo("PUT /repos/akin-ozer/viberr/contents/viberr-scope-probe"),
    ).toHaveLength(0);
  });

  it("an opted-in dry-run 403 is a REFUSED write", async () => {
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: true } },
      },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      "POST /repos/akin-ozer/viberr/pulls": {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const result = await withEnv({ VIBERR_GITHUB_WRITE_PROBE: "1" }, () =>
      validatePatToken(FINE, {
        repo: REPO,
        requiredScopes: ["pull_request:write"],
        fetchImpl: gh.fetchImpl,
      }),
    );
    expect(result.status).toBe("insufficient_scope");
    expect(result.scopes[0]).toMatchObject({
      ok: false,
      source: "probe",
      note: "pull-request write refused",
    });
  });
});

describe("validatePat / revalidateProjectCredential (stored PAT + grant flow)", () => {
  it("caches the result on the PAT row", async () => {
    const store = setupTestStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: CLASSIC },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo, workflow, read:org" },
      },
    });
    const result = await revalidateProjectCredential(store.db, store.slug, actor, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("revalidated");
    const cached = getPatMetadata(store.db, pat.id);
    expect(cached?.validation?.status).toBe("valid");
    if (result.status === "revalidated") {
      expect(cached?.lastValidatedAt).toBe(result.validation.checkedAt);
    }
  });

  it("B-GH8: a WRITE violation survives read-only evidence — 'assumed' never clears it", async () => {
    // Fails before B-GH8: the sweep resolved every violation whose scope the
    // fresh run reported `ok`, including `ok: true, source: "assumed"`. For a
    // fine-grained token whose write dry-run never answered, "Re-check scopes"
    // turned "we don't know" into "granted" and the human found out at the
    // next failed delivery.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", {
        stage: "review",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail: "Project credential is missing pull_request:write.",
    });
    const actor = { userId: store.users.arda.id, label: "arda" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: FINE },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    // READ works; the write dry-run answers 500 — unknown, not proof.
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      "PUT /repos/akin-ozer/viberr/contents/viberr-scope-probe": {
        status: 500,
        body: { message: "boom" },
      },
      "POST /repos/akin-ozer/viberr/pulls": { status: 500, body: { message: "boom" } },
    });
    const result = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("revalidated");
    if (result.status === "revalidated") {
      expect(result.resolvedViolations).toHaveLength(0);
    }
    expect(
      findOpenScopeViolation(store.db, store.slug, "pull_request:write", "VIB-142"),
    ).not.toBeNull();
  });

  it("ruling 144(c): a re-check resolves an open `workflow` violation once the header lists it, and not before", async () => {
    // Canary: stop adding `headerScopes` to the granted set and the second
    // re-check leaves the violation open.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", { stage: "review", ownerUserId: store.users.arda.id }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-142",
      scope: "workflow",
      detail: "GitHub refused a push of .github/workflows/ci.yml.",
    });
    const actor = { userId: store.users.arda.id, label: "arda" };
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: CLASSIC }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    const without = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" }, headers: { "x-oauth-scopes": "repo" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO, permissions: { push: true } } },
    });
    await revalidateProjectCredential(store.db, store.slug, actor, { dataRoot: store.dataRoot, fetchImpl: without.fetchImpl, now: () => Date.now() });
    expect(findOpenScopeViolation(store.db, store.slug, "workflow", "VIB-142")).not.toBeNull();

    const withScope = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" }, headers: { "x-oauth-scopes": "repo, workflow" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO, permissions: { push: true } } },
    });
    const result = await revalidateProjectCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: withScope.fetchImpl,
      // Past the reuse cooldown, so the re-check really reads GitHub again.
      now: () => Date.now() + 60 * 60 * 1000,
    });
    expect(result.status).toBe("revalidated");
    if (result.status === "revalidated") {
      expect(result.resolvedViolations.map((v) => v.scope)).toEqual(["workflow"]);
    }
    expect(findOpenScopeViolation(store.db, store.slug, "workflow", "VIB-142")).toBeNull();
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

    // Healthy validation → violation resolves, typed policy event lands on
    // VIB-142, projections update.
    //
    // B-GH8: a WRITE scope needs WRITE evidence. `pull_request:write` is the one
    // scope with no read-only signal (A8: `permissions.push` proves Contents
    // write, NOT pull-request write), so proving it still needs the
    // authorization-only dry-run — which is now OPT-IN. Default-off means a
    // revalidation writes nothing; this flow asks for it explicitly.
    const gh = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: true } },
      },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
      "POST /repos/akin-ozer/viberr/pulls": {
        status: 422,
        body: { message: "Validation Failed" },
      },
    });
    const result = await withEnv({ VIBERR_GITHUB_WRITE_PROBE: "1" }, () =>
      revalidateProjectCredential(store.db, store.slug, actor, {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    );
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
    // SAFETY: the SELECT list is the single `task_events.text` column (TEXT NOT
    // NULL), and the timeline assertion above already failed the test unless the
    // event was written and reprojected at position 0.
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
  // A8: a healthy repo response carries the `permissions` block GitHub computes
  // for the authenticated token — the READ-ONLY proof of repository write that
  // replaced the contents write dry-run.
  const healthyGithub = () =>
    fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: true, pull: true } },
      },
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
    // The projects TABLE row (repo column) is what revalidation resolves the
    // target repo from — project the file into it.
    const store = setupProjectedStore(ctx);
    const { actor, pat } = bindCredential(store, FINE);

    // Same routes as the project-scoped fake MINUS the repo — so the cache is
    // a genuinely VALID repo-less result (all four default scopes pass), the
    // exact thing the connection modal produces.
    const orgLevel = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /user/orgs": { body: [] },
    });
    recordPatValidation(
      store.db,
      pat.id,
      await validatePatToken(FINE, { repo: null, fetchImpl: orgLevel.fetchImpl }),
    );

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
      now: () => Date.now() + 60_001,
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

/**
 * Ruling 144 (pass 34, G34-2): a CLASSIC token's full granted list is recorded
 * beside the required-scope verdicts, so the credential card can say a token
 * without `workflow` cannot push `.github/workflows/*` and delivery can refuse
 * such a push BEFORE GitHub is asked. Advisory only: `workflow` stays optional
 * (ruling 18) and a token without it is still `valid`.
 *
 * Canary: drop the `headerScopes` assignment in `validatePatToken` (leave the
 * base's `null`) and the first case fails.
 */
describe("ruling 144 — the classic token's header list is recorded", () => {
  it("records the full x-oauth-scopes list on a classic token, and the token without `workflow` stays valid", async () => {
    const gh = fakeGithubFetch({
      "GET /user": {
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo, read:org" },
      },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
    });
    const result = await validatePatToken(CLASSIC, {
      repo: REPO,
      requiredScopes: ["repo", "pull_request:write"],
      fetchImpl: gh.fetchImpl,
    });
    expect(result.status).toBe("valid");
    expect(result.headerScopes).toEqual(["repo", "read:org"]);
    expect(result.missingScopes).toEqual([]);
  });

  it("an EMPTY header on a classic token records [] (a positive fact), and a fine-grained token records null", async () => {
    const empty = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" }, headers: { "x-oauth-scopes": "" } },
    });
    const emptyResult = await validatePatToken(CLASSIC, {
      repo: null,
      requiredScopes: ["repo"],
      fetchImpl: empty.fetchImpl,
    });
    expect(emptyResult.headerScopes).toEqual([]);

    const fine = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": {
        body: { full_name: REPO, permissions: { push: true, pull: true } },
      },
    });
    const fineResult = await validatePatToken(FINE, {
      repo: REPO,
      requiredScopes: ["repo"],
      fetchImpl: fine.fetchImpl,
    });
    expect(fineResult.tokenKind).toBe("fine_grained");
    expect(fineResult.headerScopes).toBeNull();
  });

  it("a network failure before the header is read records null", async () => {
    const result = await validatePatToken(CLASSIC, {
      repo: null,
      requiredScopes: ["repo"],
      fetchImpl: unreachableFetch(),
    });
    expect(result.status).toBe("network_error");
    expect(result.headerScopes).toBeNull();
  });
});

/**
 * F20-15 / F21-11: the one decoder and verdict for the `permissions` block. The
 * validator, the project-repair probe (settings-actions) and the create probe
 * (project-create) all judge repository write through these, each inside its
 * own response wrapper — so the tri-state is pinned here once, including the
 * inputs the three used to decode differently (a missing, `null` or
 * non-boolean key).
 */
describe("repoWritable over repoPermissionsSchema (the shared write verdict)", () => {
  it.each([
    // [permissions block, verdict]
    [{ push: true }, true],
    [{ admin: true }, true],
    [{ maintain: true }, true],
    [{ admin: true, push: false }, true], // admin outranks a push: false
    [{ maintain: true, push: false }, true],
    [{ push: true, triage: "yes" }, true], // a drifted neighbour cannot void a grant
    [{ push: false }, false], // the PROVEN read-only repo
    [{ admin: false, maintain: false, push: false }, false],
    [{ push: false, triage: "yes", pull: 1 }, false], // a drifted neighbour cannot void it
    [{ admin: "true", maintain: 1, push: false }, false], // only a real `true` grants
    [{}, null],
    [{ admin: false, maintain: false }, null],
    [{ push: undefined }, null],
    [{ push: null }, null],
    [{ push: "yes" }, null],
    [{ push: 1 }, null],
    [{ admin: 1, maintain: "yes" }, null],
  ] as const)("%j → %s", (block, verdict) => {
    expect(repoWritable(repoPermissionsSchema.parse(block))).toBe(verdict);
  });

  it("reads an absent or undecodable block as unknown, never as read-only", () => {
    expect(repoWritable(undefined)).toBeNull();
    expect(repoWritable(null)).toBeNull();
    // Not an object at all: the schema refuses it, and each caller's wrapper
    // turns that into `undefined`/`null` (or a failed parse), which reads null.
    for (const block of [null, undefined, "x", 5, true, []]) {
      expect(repoPermissionsSchema.safeParse(block).success).toBe(false);
    }
  });
});
