import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES, type ErrorCode } from "~/server/errors/error-codes";

/**
 * Thin typed fetch wrapper for api.github.com (Phase 7).
 *
 * - Bearer token auth, GitHub v3 JSON media type, X-GitHub-Api-Version.
 * - If-None-Match ETag support (pass `etag`, get a `not_modified` result).
 * - Rate-limit info surfaced on every response.
 * - NO retry storms: exactly ONE retry, only on 5xx responses.
 * - Network failures and HTTP failures come back as TYPED RESULTS, never
 *   throws — services build their degraded modes on top. `toAppError`
 *   converts a failure at a route boundary when throwing is wanted.
 * - `fetchImpl` injection is the mock-transport hook for tests; nothing in
 *   this layer ever logs or re-emits the token.
 */

export const GITHUB_API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "viberr";

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Unix epoch seconds when the window resets. */
  reset: number | null;
}

export type GithubResponse<T> =
  | {
      ok: true;
      status: number;
      data: T;
      etag: string | null;
      rateLimit: RateLimitInfo;
      /** `x-oauth-scopes` header — classic PATs only (null for fine-grained). */
      scopesHeader: string | null;
      /** `github-authentication-token-expiration` header, ISO-normalized. */
      tokenExpiration: string | null;
    }
  | {
      ok: false;
      kind: "not_modified";
      status: 304;
      etag: string | null;
      rateLimit: RateLimitInfo;
    }
  | {
      ok: false;
      kind: "http";
      status: number;
      /** GitHub's error `message` (secret-free), or the status text. */
      message: string;
      /** Parsed error body when JSON (for message sniffing), else null. */
      data: unknown;
      rateLimit: RateLimitInfo;
    }
  | { ok: false; kind: "network"; message: string };

export type GithubFailure<T = never> = Exclude<
  GithubResponse<T>,
  { ok: true }
>;

export interface GithubClientOptions {
  token: string;
  /** Mock-transport hook for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface GithubRequestOptions {
  /** Previous ETag — a 304 comes back as kind "not_modified". */
  etag?: string;
  /** JSON body for POST/PUT/PATCH. */
  body?: unknown;
  searchParams?: Record<string, string | number>;
}

export interface GithubClient {
  request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options?: GithubRequestOptions,
  ): Promise<GithubResponse<T>>;
}

function rateLimitFrom(headers: Headers): RateLimitInfo {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    reset: num("x-ratelimit-reset"),
  };
}

function messageFrom(data: unknown, statusText: string): string {
  if (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof (data as { message: unknown }).message === "string"
  ) {
    return (data as { message: string }).message;
  }
  return statusText || "GitHub request failed";
}

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE;
  const { token } = options;

  async function doFetch(
    method: string,
    url: string,
    requestOptions: GithubRequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": API_VERSION,
    };
    if (requestOptions.etag) headers["if-none-match"] = requestOptions.etag;
    const init: RequestInit = { method, headers };
    if (requestOptions.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(requestOptions.body);
    }
    return fetchImpl(url, init);
  }

  return {
    async request<T>(
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      requestOptions: GithubRequestOptions = {},
    ): Promise<GithubResponse<T>> {
      const url = new URL(
        path.startsWith("http") ? path : `${baseUrl}${path}`,
      );
      for (const [key, value] of Object.entries(
        requestOptions.searchParams ?? {},
      )) {
        url.searchParams.set(key, String(value));
      }

      let response: Response;
      try {
        response = await doFetch(method, url.toString(), requestOptions);
        // Exactly one retry, 5xx only (no retry storms).
        if (response.status >= 500) {
          response = await doFetch(method, url.toString(), requestOptions);
        }
      } catch (error) {
        return {
          ok: false,
          kind: "network",
          message: error instanceof Error ? error.message : String(error),
        };
      }

      const rateLimit = rateLimitFrom(response.headers);
      const etag = response.headers.get("etag");

      if (response.status === 304) {
        return { ok: false, kind: "not_modified", status: 304, etag, rateLimit };
      }

      let data: unknown = null;
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          data: data as T,
          etag,
          rateLimit,
          scopesHeader: response.headers.get("x-oauth-scopes"),
          tokenExpiration: tokenExpirationFrom(response.headers),
        };
      }
      return {
        ok: false,
        kind: "http",
        status: response.status,
        message: messageFrom(data, response.statusText),
        data,
        rateLimit,
      };
    },
  };
}

/** Convenience header read used by the PAT validator. */
export function tokenExpirationFrom(headers: Headers): string | null {
  const raw = headers.get("github-authentication-token-expiration");
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

/** Maps a typed GitHub failure to an AppError (route-boundary use). */
export function githubFailureToAppError(
  failure: GithubFailure,
  context: string,
): AppError {
  if (failure.kind === "network") {
    return new AppError({
      code: ERROR_CODES.GITHUB_UNAVAILABLE,
      status: 502,
      message: `${context}: network failure (${failure.message})`,
      userMessage: "GitHub is unreachable right now.",
      kind: "infrastructure",
    });
  }
  if (failure.kind === "not_modified") {
    return new AppError({
      code: ERROR_CODES.GITHUB_API_ERROR,
      status: 500,
      message: `${context}: unexpected 304 treated as failure`,
      kind: "infrastructure",
    });
  }
  const map: Record<number, { code: ErrorCode; userMessage: string }> = {
    401: {
      code: ERROR_CODES.GITHUB_AUTH_FAILED,
      userMessage: "The GitHub credential was rejected.",
    },
    403: {
      code: ERROR_CODES.GITHUB_FORBIDDEN,
      userMessage: "The GitHub credential is not allowed to do that.",
    },
    404: {
      code: ERROR_CODES.GITHUB_NOT_FOUND,
      userMessage: "GitHub couldn't find that resource.",
    },
  };
  const mapped = map[failure.status] ?? {
    code: ERROR_CODES.GITHUB_API_ERROR,
    userMessage: "GitHub returned an unexpected error.",
  };
  return new AppError({
    code: mapped.code,
    status: 502,
    message: `${context}: GitHub ${failure.status} ${failure.message}`,
    userMessage: mapped.userMessage,
    kind: "infrastructure",
  });
}
