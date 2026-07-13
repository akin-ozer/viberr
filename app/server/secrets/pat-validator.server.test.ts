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
} from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  allowProjectCompletionEffects,
  revokeProjectCompletionEffects,
  waitForProjectCompletionEffects,
} from "~/server/runtimes/run-completion-state.server";
import { createPat, getPatMetadata, setProjectCredential } from "./pat-store.server";
import {
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

  it("does not append an old scope-resolution event to a same-key replacement task", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", {
        stage: "review",
        createdAt: "2026-07-01T09:00:00.000Z",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: FINE },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );
    const healthy = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    }).fetchImpl;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstRequest = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!paused) {
        paused = true;
        entered();
        await gate;
      }
      return healthy(input, init);
    };

    const revalidation = revalidateProjectCredential(
      store.db,
      store.slug,
      actor,
      { dataRoot: store.dataRoot, fetchImpl },
    );
    await firstRequest;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", {
        stage: "review",
        createdAt: "2026-07-02T09:00:00.000Z",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    release();
    await expect(revalidation).rejects.toMatchObject({ name: "AbortError" });
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);

    const replacement = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(replacement.frontmatter.createdAt).toBe(
      "2026-07-02T09:00:00.000Z",
    );
    expect(
      replacement.timeline.some((event) =>
        event.text.includes("**Policy update:**"),
      ),
    ).toBe(false);
  });

  it("registers a paused scope revalidation in the project lifecycle drain", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: FINE },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );
    const healthy = fakeGithubFetch({
      "GET /user": { body: { login: "viberr-bot" } },
      "GET /repos/akin-ozer/viberr": { body: { full_name: REPO } },
      "GET /user/orgs": { body: [] },
      "GET /repos/akin-ozer/viberr/pulls": { body: [] },
    }).fetchImpl;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstRequest = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let paused = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (!paused) {
        paused = true;
        entered();
        await gate;
      }
      return healthy(input, init);
    };

    const revalidation = revalidateProjectCredential(
      store.db,
      store.slug,
      actor,
      { dataRoot: store.dataRoot, fetchImpl },
    );
    await firstRequest;
    revokeProjectCompletionEffects(store.db, store.slug);
    let drained = false;
    const drain = waitForProjectCompletionEffects(store.db, store.slug).then(
      () => {
        drained = true;
      },
    );
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await expect(revalidation).rejects.toMatchObject({ name: "AbortError" });
    await drain;
    expect(drained).toBe(true);
    allowProjectCompletionEffects(store.db, store.slug);
  });
});
