import { describe, expect, it } from "vitest";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { createGithubClient, githubWebHost } from "./github-client.server";

function client(routes: Parameters<typeof fakeGithubFetch>[0]) {
  const gh = fakeGithubFetch(routes);
  return {
    gh,
    client: createGithubClient({ token: "ghp_test_token", fetchImpl: gh.fetchImpl }),
  };
}

describe("github-client", () => {
  it("sends bearer auth, api version and accept headers", async () => {
    const { gh, client: c } = client({
      "GET /user": { body: { login: "octocat" } },
    });
    const result = await c.request<{ login: string }>("GET", "/user");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.login).toBe("octocat");
    const call = gh.calls[0]!;
    expect(call.headers.authorization).toBe("Bearer ghp_test_token");
    expect(call.headers["x-github-api-version"]).toBeTruthy();
    expect(call.headers.accept).toContain("application/vnd.github+json");
  });

  it("surfaces rate-limit info and etag", async () => {
    const { client: c } = client({
      "GET /rate": {
        body: { ok: true },
        headers: {
          etag: 'W/"abc123"',
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4993",
          "x-ratelimit-reset": "1751700000",
        },
      },
    });
    const result = await c.request("GET", "/rate");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.etag).toBe('W/"abc123"');
      expect(result.rateLimit).toEqual({
        limit: 5000,
        remaining: 4993,
        reset: 1751700000,
      });
    }
  });

  it("returns a typed not_modified result for 304 + If-None-Match", async () => {
    const { gh, client: c } = client({
      "GET /cached": (call) =>
        call.headers["if-none-match"] === 'W/"abc"'
          ? { status: 304, headers: { "x-ratelimit-remaining": "10" } }
          : { body: { fresh: true } },
    });
    const result = await c.request("GET", "/cached", { etag: 'W/"abc"' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("not_modified");
      if (result.kind === "not_modified") {
        expect(result.rateLimit.remaining).toBe(10);
      }
    }
    expect(gh.calls[0]!.headers["if-none-match"]).toBe('W/"abc"');
  });

  it("retries exactly once on 5xx, then reports the failure", async () => {
    // First 500 then 200 → success after one retry.
    const { gh, client: recovered } = client({
      "GET /flaky": (call) =>
        call.attempt === 1
          ? { status: 502, body: { message: "Bad gateway" } }
          : { body: { ok: true } },
    });
    const success = await recovered.request("GET", "/flaky");
    expect(success.ok).toBe(true);
    expect(gh.callsTo("GET /flaky")).toHaveLength(2);

    // Always-500 → exactly 2 attempts (no retry storm), typed http failure.
    const { gh: gh2, client: broken } = client({
      "GET /down": { status: 500, body: { message: "boom" } },
    });
    const failure = await broken.request("GET", "/down");
    expect(failure.ok).toBe(false);
    if (!failure.ok && failure.kind === "http") {
      expect(failure.status).toBe(500);
      expect(failure.message).toBe("boom");
    }
    expect(gh2.callsTo("GET /down")).toHaveLength(2);
  });

  it("does NOT retry 4xx and extracts GitHub's error message", async () => {
    const { gh, client: c } = client({
      "GET /missing": { status: 404, body: { message: "Not Found" } },
    });
    const result = await c.request("GET", "/missing");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "http") {
      expect(result.status).toBe(404);
      expect(result.message).toBe("Not Found");
    }
    expect(gh.callsTo("GET /missing")).toHaveLength(1);
  });

  it("returns a typed network failure instead of throwing", async () => {
    const c = createGithubClient({
      token: "ghp_x",
      fetchImpl: unreachableFetch("ENOTFOUND"),
    });
    const result = await c.request("GET", "/user");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      if (result.kind === "network") expect(result.message).toBe("ENOTFOUND");
    }
  });

  it("serializes JSON bodies and appends search params", async () => {
    const { gh, client: c } = client({
      "POST /repos/o/r/git/refs": { status: 201, body: {} },
      "GET /repos/o/r/pulls": { body: [] },
    });
    await c.request("POST", "/repos/o/r/git/refs", {
      body: { ref: "refs/heads/x", sha: "abc" },
    });
    await c.request("GET", "/repos/o/r/pulls", {
      searchParams: { state: "all", per_page: 5 },
    });
    expect(gh.calls[0]!.body).toEqual({ ref: "refs/heads/x", sha: "abc" });
    expect(gh.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(gh.calls[1]!.url.searchParams.get("state")).toBe("all");
    expect(gh.calls[1]!.url.searchParams.get("per_page")).toBe("5");
  });

  it("exposes scope + token-expiration headers on success", async () => {
    const { client: c } = client({
      "GET /user": {
        body: { login: "octocat" },
        headers: {
          "x-oauth-scopes": "repo, workflow",
          "github-authentication-token-expiration": "2026-12-31 23:59:59 UTC",
        },
      },
    });
    const result = await c.request("GET", "/user");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopesHeader).toBe("repo, workflow");
      expect(result.tokenExpiration).toMatch(/^2026-12-31T/);
    }
  });
});

describe("githubWebHost (B11: browse-link host derivation)", () => {
  it("defaults to https://github.com when no base is configured", () => {
    expect(githubWebHost()).toBe("https://github.com");
    expect(githubWebHost(null)).toBe("https://github.com");
    expect(githubWebHost("https://api.github.com")).toBe("https://github.com");
  });

  it("derives the GHE web host from its API base", () => {
    expect(githubWebHost("https://ghe.corp/api/v3")).toBe("https://ghe.corp");
    expect(githubWebHost("https://api.ghe.example.com/v3")).toBe(
      "https://ghe.example.com",
    );
    expect(githubWebHost("https://ghe.corp:8443/api/v3")).toBe(
      "https://ghe.corp:8443",
    );
  });

  it("falls back to github.com on an unparseable base", () => {
    expect(githubWebHost("not a url")).toBe("https://github.com");
  });
});
