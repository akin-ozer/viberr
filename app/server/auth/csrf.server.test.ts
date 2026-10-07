import { describe, expect, it, vi } from "vitest";
import { resetEnvCacheForTests } from "../config/env.server";
import { assertTrustedOrigin, getCsrfToken } from "./csrf.server";

const SESSION_ID = "abc123sessionhash";

const SAME_ORIGIN = "http://localhost:5173";

function postRequest(options: {
  origin?: string;
  secFetchSite?: string;
  referer?: string;
  /** Send no origin signal at all — the shape a non-browser caller produces. */
  bare?: boolean;
} = {}): Request {
  const headers = new Headers();
  // Every app form post is a same-origin browser POST, which always carries at
  // least Origin — so that is the default here, and a case that wants the
  // header-less shape asks for it with `bare`.
  if (options.origin) headers.set("Origin", options.origin);
  else if (!options.bare && !options.secFetchSite && !options.referer) {
    headers.set("Origin", SAME_ORIGIN);
  }
  if (options.secFetchSite) headers.set("Sec-Fetch-Site", options.secFetchSite);
  if (options.referer) headers.set("Referer", options.referer);
  return new Request("http://localhost:5173/logout", {
    method: "POST",
    headers,
  });
}

describe("getCsrfToken", () => {
  it("is deterministic per session and differs across sessions and secrets", () => {
    const token = getCsrfToken(SESSION_ID);
    expect(getCsrfToken(SESSION_ID)).toBe(token);
    expect(getCsrfToken("other")).not.toBe(token);
    vi.stubEnv("VIBERR_SESSION_SECRET", "another-secret-value-here-another-secret");
    resetEnvCacheForTests();
    try {
      expect(getCsrfToken(SESSION_ID)).not.toBe(token);
    } finally {
      vi.unstubAllEnvs();
      resetEnvCacheForTests();
    }
  });
});

describe("assertTrustedOrigin", () => {
  it("accepts the shapes a same-origin browser form post actually sends", () => {
    // Origin alone (every cross-origin-capable POST carries it), Sec-Fetch-Site
    // alone, a same-origin Referer alone, and all of them together.
    expect(() =>
      assertTrustedOrigin(postRequest({ origin: SAME_ORIGIN })),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(postRequest({ secFetchSite: "same-origin" })),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(postRequest({ secFetchSite: "none" })),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(
        postRequest({ referer: `${SAME_ORIGIN}/projects/viberr-core/board` }),
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(
        postRequest({
          origin: SAME_ORIGIN,
          secFetchSite: "same-origin",
          referer: `${SAME_ORIGIN}/logout`,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects cross-origin and cross-site requests with 403", () => {
    for (const bad of [
      postRequest({ origin: "https://evil.example" }),
      postRequest({ origin: "null" }),
      postRequest({ secFetchSite: "cross-site" }),
      postRequest({ secFetchSite: "same-site" }),
      // A same-origin Origin cannot launder a foreign Referer, and vice versa:
      // every signal the request DOES carry has to agree.
      postRequest({ origin: SAME_ORIGIN, referer: "https://evil.example/x" }),
      postRequest({ secFetchSite: "same-origin", referer: "https://evil.example/x" }),
    ]) {
      let thrown: unknown;
      try {
        assertTrustedOrigin(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Response);
      // SAFETY: the assertion above throws unless `thrown` is a Response, so
      // reaching this line means the catch binding is one.
      expect((thrown as Response).status).toBe(403);
    }
  });

  // §7.10 / A7: this used to PASS. A request carrying no Origin, no
  // Sec-Fetch-Site and no Referer proves nothing about where it came from, and
  // the layer whose entire job is that proof was letting it through on the
  // strength of a curl/server-to-server concession the app never uses.
  it("rejects a request that carries NO origin signal at all (fails closed)", () => {
    let thrown: unknown;
    try {
      assertTrustedOrigin(postRequest({ bare: true }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above throws unless `thrown` is a Response, so
    // reaching this line means the catch binding is one.
    expect((thrown as Response).status).toBe(403);
  });
});

/**
 * Ruling 683: behind the TLS-terminating proxy deployment.md requires,
 * react-router-serve builds request.url from the plain-HTTP socket while the
 * browser sends the https:// origin it is on. The guard accepts the configured
 * public origin (BETTER_AUTH_URL) as well as the request's own, except the
 * public host over plain http, and nothing else about it loosens.
 */
describe("assertTrustedOrigin and the configured public origin", () => {
  const PUBLIC = "https://viberr.example.com";
  /** What react-router-serve sees behind the proxy, with Host forwarded. */
  const UPSTREAM = "http://viberr.example.com/login";

  /** "passed", or the status of the Response the guard threw. */
  function verdict(
    betterAuthUrl: string | undefined,
    headers: Record<string, string>,
    url: string,
  ): "passed" | number {
    vi.stubEnv("BETTER_AUTH_URL", betterAuthUrl);
    resetEnvCacheForTests();
    try {
      assertTrustedOrigin(new Request(url, { method: "POST", headers }));
      return "passed";
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      return error.status;
    } finally {
      vi.unstubAllEnvs();
      resetEnvCacheForTests();
    }
  }

  it.each<[string, string | undefined, Record<string, string>, "passed" | number, string?]>([
    // CANARY: leave the configured origin out of the accepted set and every
    // login and form post behind the proxy is refused.
    ["passes the public origin's Origin", PUBLIC, { Origin: PUBLIC }, "passed"],
    // CANARY: compare Referer with the request's own origin only.
    ["passes the public origin's Referer", PUBLIC, { Referer: `${PUBLIC}/x` }, "passed"],
    // CANARY: replace the request's own origin with the configured one and the
    // app reached under another name, such as the upstream port, refuses posts.
    [
      "passes the request's own origin under another name",
      PUBLIC,
      { Origin: "http://localhost:3000" },
      "passed",
      "http://localhost:3000/login",
    ],
    // CANARY: count the request's own origin unconditionally and, behind the
    // proxy, a page on the public host's plain-HTTP listener, or one injected
    // before HSTS, passes the origin check.
    ["refuses the public host over plain http", PUBLIC, { Origin: "http://viberr.example.com" }, 403],
    // CANARY: accept any Origin once BETTER_AUTH_URL is set.
    ["refuses a foreign Origin", PUBLIC, { Origin: "https://evil.example.com" }, 403],
    // CANARY: match the configured origin by hostname and another service on
    // the public host, on another port, can post.
    ["refuses another port on the public host", PUBLIC, { Origin: "https://viberr.example.com:8443" }, 403],
    // CANARY: compare hosts only, or believe the forwarded headers, and the
    // scheme stops being checked on a deployment that configured nothing.
    [
      "refuses the https Origin when BETTER_AUTH_URL is unset, even with X-Forwarded-*",
      undefined,
      {
        Origin: PUBLIC,
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "viberr.example.com",
      },
      403,
    ],
    // CANARY: let an accepted Origin short-circuit the Sec-Fetch-Site rule.
    [
      "refuses Sec-Fetch-Site cross-site beside the public Origin",
      PUBLIC,
      { Origin: PUBLIC, "Sec-Fetch-Site": "cross-site" },
      403,
    ],
    // CANARY: treat Origin: null as absent and the public Referer carries an
    // opaque-origin post through.
    ["refuses Origin null beside the public Referer", PUBLIC, { Origin: "null", Referer: `${PUBLIC}/x` }, 403],
  ])("%s", (_name, betterAuthUrl, headers, expected, url = UPSTREAM) => {
    expect(verdict(betterAuthUrl, headers, url)).toBe(expected);
  });
});
