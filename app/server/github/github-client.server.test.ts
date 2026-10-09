import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import {
  createGithubClient,
  githubFailureMessage,
  githubWebHost,
  isMissingCommitAnswer,
  isMissingRefAnswer,
  type GithubResponse,
} from "./github-client.server";

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
    const result = await c.request("GET", "/user", z.object({ login: z.string() }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.login).toBe("octocat");
    const call = gh.calls[0]!;
    expect(call.headers.authorization).toBe("Bearer ghp_test_token");
    expect(call.headers["x-github-api-version"]).toBeTruthy();
    expect(call.headers.accept).toContain("application/vnd.github+json");
  });

  it("surfaces rate-limit info", async () => {
    const { client: c } = client({
      "GET /rate": {
        body: { ok: true },
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "4993",
          "x-ratelimit-reset": "1751700000",
        },
      },
    });
    const result = await c.request("GET", "/rate", z.unknown());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rateLimit).toEqual({
        limit: 5000,
        remaining: 4993,
        reset: 1751700000,
      });
    }
  });

  it("retries exactly once on 5xx, then reports the failure", async () => {
    // First 500 then 200 → success after one retry.
    const { gh, client: recovered } = client({
      "GET /flaky": (call) =>
        call.attempt === 1
          ? { status: 502, body: { message: "Bad gateway" } }
          : { body: { ok: true } },
    });
    const success = await recovered.request("GET", "/flaky", z.unknown());
    expect(success.ok).toBe(true);
    expect(gh.callsTo("GET /flaky")).toHaveLength(2);

    // Always-500 → exactly 2 attempts (no retry storm), typed http failure.
    const { gh: gh2, client: broken } = client({
      "GET /down": { status: 500, body: { message: "boom" } },
    });
    const failure = await broken.request("GET", "/down", z.unknown());
    expect(failure.ok).toBe(false);
    expect(failure.ok === false && failure.kind).toBe("http");
    if (!failure.ok && failure.kind === "http") {
      expect(failure.status).toBe(500);
      expect(failure.message).toBe("boom");
    }
    expect(gh2.callsTo("GET /down")).toHaveLength(2);
  });

  it("sends a write that must not be sent twice once, and hands its 5xx back (R-repo-1)", async () => {
    // A create GitHub made before answering 502 would be refused by the retry,
    // and the caller would read "nothing was made".
    // CANARY: ignore `retryServerError` and the POST goes out twice.
    const { gh, client: c } = client({
      "POST /user/repos": (call) =>
        call.attempt === 1
          ? { status: 502, body: { message: "Server Error" } }
          : { status: 422, body: { message: "Repository creation failed." } },
    });
    const result = await c.request("POST", "/user/repos", z.unknown(), {
      body: { name: "website" },
      retryServerError: false,
    });
    expect(gh.callsTo("POST /user/repos")).toHaveLength(1);
    expect(result.ok === false && result.kind === "http" ? result.status : null).toBe(502);
  });

  it("does NOT retry 4xx and extracts GitHub's error message", async () => {
    const { gh, client: c } = client({
      "GET /missing": { status: 404, body: { message: "Not Found" } },
    });
    const result = await c.request("GET", "/missing", z.unknown());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.kind).toBe("http");
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
    const result = await c.request("GET", "/user", z.unknown());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("network");
      if (result.kind === "network") expect(result.message).toBe("ENOTFOUND");
    }
  });

  it("F21-9: a body that dies MID-READ is a typed network failure, not a throw", async () => {
    // The fetch resolved — headers, status, the lot — and the BODY stream then
    // errored (a truncated response, an aborted socket, the timeout firing
    // between headers and body). Only the request was wrapped, so this rejected
    // out of the client and past every caller's degraded mode: a project sweep
    // 500ed on one bad response, and a merge's post-merge cleanup took the whole
    // completed merge down with it.
    // Canary: drop the try/catch around `readBody` → this test rejects.
    const c = createGithubClient({
      token: "ghp_x",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        ),
    });
    const result = await c.request("GET", "/user", z.object({ login: z.string() }));
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== "network") throw new Error("expected network");
    expect(result.message).toContain("terminated");
  });

  it("serializes JSON bodies and appends search params", async () => {
    const { gh, client: c } = client({
      "POST /repos/o/r/git/refs": { status: 201, body: {} },
      "GET /repos/o/r/pulls": { body: [] },
    });
    await c.request("POST", "/repos/o/r/git/refs", z.unknown(), {
      body: { ref: "refs/heads/x", sha: "abc" },
    });
    await c.request("GET", "/repos/o/r/pulls", z.unknown(), {
      searchParams: { state: "all", per_page: 5 },
    });
    expect(gh.calls[0]!.body).toEqual({ ref: "refs/heads/x", sha: "abc" });
    expect(gh.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(gh.calls[1]!.url.searchParams.get("state")).toBe("all");
    expect(gh.calls[1]!.url.searchParams.get("per_page")).toBe("5");
  });

  it("parses the success body with the given schema (call-site tolerance applies)", async () => {
    const { client: c } = client({
      "GET /pr": { body: { number: 7, head: "not-an-object", junk: true } },
    });
    const result = await c.request(
      "GET",
      "/pr",
      z.object({
        number: z.number(),
        head: z
          .object({ sha: z.string().optional().catch(undefined) })
          .optional()
          .catch(undefined),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Modeled field survives, drifted field degrades to its catch, unmodeled
      // junk is stripped.
      expect(result.data).toEqual({ number: 7 });
    }
  });

  it("F21-9: a body the schema REFUSES is a typed failure, never a throw", async () => {
    // The contract in this module's header is "typed results, never throws", and
    // `schema.parse` broke it: a strict field GitHub drifted on threw a ZodError
    // out of every caller — 500ing the route that clicked Reconcile, and (after
    // a POST) losing the record of a resource GitHub had already created.
    const { client: c } = client({
      "GET /pr": { body: { number: "not-a-number", html_url: "https://x" } },
    });
    const result = await c.request(
      "GET",
      "/pr",
      z.object({ number: z.number(), html_url: z.string() }),
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== "decode") throw new Error("expected decode");
    expect(result.status).toBe(200);
    // Names the shape problem and its path, and carries no payload value.
    expect(result.message).toContain("number");
    // The raw body rides along so a caller can salvage what it needs.
    expect(result.data).toEqual({ number: "not-a-number", html_url: "https://x" });
    expect(githubFailureMessage(result)).toBe(result.message);
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
    const result = await c.request("GET", "/user", z.unknown());
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

/**
 * Ruling 243 (F37-43): the fact this predicate exists to encode, pinned as a
 * test rather than as a fixture's guess.
 *
 * `GET /repos/{repo}/commits/{sha}` does NOT 404 a well-formed 40-character SHA
 * it cannot find — it answers 422 with "No commit found for SHA: <sha>",
 * verified against the live API. Ruling 243's never-pushed probe asked
 * `isMissingRefAnswer`, which knows only 404 and the empty-repository 409, so
 * the refusal it guards was unreachable and a never-pushed revision read as an
 * "unverifiable" head that acceptance merges anyway. On SHOP-17 that merged the
 * revision the required reviewer had rejected and discarded the one both
 * required reviewers had approved.
 */
describe("isMissingCommitAnswer (ruling 243)", () => {
  const http = (status: number, message: string): GithubResponse<unknown> => ({
    ok: false,
    kind: "http",
    status,
    message,
    data: null,
    rateLimit: { limit: null, remaining: null, reset: null },
  });

  it("reads GitHub's real 422 answer for an unknown commit as missing", () => {
    const real = http(422, `No commit found for SHA: ${"a".repeat(40)}`);
    // CANARY: drop the 422 arm and this is false — which is the state the
    // product shipped in, with a passing test above it.
    expect(isMissingCommitAnswer(real)).toBe(true);
    // …and the SHARED predicate must still say false, which is exactly why
    // this one is separate: 422 is GitHub's generic validation status, and
    // widening `isMissingRefAnswer` would make unrelated failures on every
    // other endpoint read as "the ref is gone".
    expect(isMissingRefAnswer(real)).toBe(false);
  });

  it("still reads a 404 and an empty-repository 409 as missing", () => {
    expect(isMissingCommitAnswer(http(404, "Not Found"))).toBe(true);
    expect(isMissingCommitAnswer(http(409, "Git Repository is empty."))).toBe(true);
  });

  it("does not read an unrelated 422 as a missing commit", () => {
    // A 422 is GitHub's answer to a great many things. Only the sentence that
    // endpoint returns for an unknown commit counts.
    expect(isMissingCommitAnswer(http(422, "Validation Failed"))).toBe(false);
    expect(isMissingCommitAnswer(http(403, "Resource not accessible"))).toBe(false);
    // An answer that SUCCEEDED is never a missing commit, whatever its status.
    expect(
      isMissingCommitAnswer({
        ok: true,
        status: 200,
        data: null,
        rateLimit: { limit: null, remaining: null, reset: null },
        scopesHeader: null,
        tokenExpiration: null,
      }),
    ).toBe(false);
  });
});
