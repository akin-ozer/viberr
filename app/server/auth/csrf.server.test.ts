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
