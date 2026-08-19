/**
 * Thin typed fetch wrapper for api.github.com (Phase 7).
 *
 * - Bearer token auth (or ANONYMOUS when `token` is null — GitHub serves
 *   public read endpoints unauthenticated, at the lower 60/hr IP quota).
 * - If-None-Match ETag support (pass `etag`, get a `not_modified` result).
 * - Rate-limit info surfaced on every response.
 * - NO retry storms: exactly ONE retry, only on 5xx responses.
 * - Network failures and HTTP failures come back as TYPED RESULTS, never
 *   throws — services build their degraded modes on top. `toAppError`
 *   converts a failure at a route boundary when throwing is wanted.
 * - Success bodies are decoded by a caller-supplied zod schema (see
 *   `GithubClient.request`); failure bodies stay unparsed.
 * - `fetchImpl` injection is the mock-transport hook for tests; nothing in
 *   this layer ever logs or re-emits the token.
 */

import { z } from "zod";

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

export interface GithubClientOptions {
  /** `null` = anonymous: no Authorization header, public endpoints only. */
  token: string | null;
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
  /** Override the per-request timeout (P13-UI-04). */
  timeoutMs?: number;
}

export type GithubMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface GithubClient {
  /**
   * Issue a request and decode the SUCCESS body with `schema`. Call-site
   * schemas model only the fields their reader consumes, carrying the
   * tolerance that reader already has (`.catch(undefined)` where the read
   * optional-chains, strict where a drifted value must not flow onward), so
   * payload drift degrades exactly the way the raw reads always did. Failure
   * results carry the body unparsed.
   */
  request<Schema extends z.ZodType>(
    method: GithubMethod,
    path: string,
    schema: Schema,
    options?: GithubRequestOptions,
  ): Promise<GithubResponse<z.output<Schema>>>;
  /**
   * @deprecated Schema-less form: the success body is handed over unchecked as
   * `T`. Kept only for the `task-actions.server.ts` call sites until they
   * migrate to schemas (phase 2) — new callers pass a schema.
   */
  request<T>(
    method: GithubMethod,
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

/**
 * GitHub's error envelope. `message` is the one field a failed response carries
 * that is safe to surface — human-readable and secret-free — so it is parsed
 * here rather than probed field by field at the failure site.
 */
const githubErrorSchema = z.object({ message: z.string() });

/** A JSON value: everything `JSON.parse` can hand back, and nothing wider. */
type JsonBody =
  | string
  | number
  | boolean
  | null
  | JsonBody[]
  | { [key: string]: JsonBody };

/**
 * The response body — parsed JSON when GitHub sent JSON, the raw text when it
 * sent something else (a proxy's HTML error page), null when it sent nothing.
 */
async function readBody(response: Response): Promise<JsonBody> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Outgoing request headers, lowercase-keyed the way this layer writes them. */
interface RequestHeaders {
  [name: string]: string;
}

/** Per-request budget for a GitHub API call (P13-UI-04). Generous enough for a
 *  slow tree/blob fetch, short enough that a hung endpoint surfaces. */
export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;

export function createGithubClient(options: GithubClientOptions): GithubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE;
  const { token } = options;

  async function doFetch(
    method: string,
    url: string,
    requestOptions: GithubRequestOptions,
  ): Promise<Response> {
    const headers: RequestHeaders = {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": API_VERSION,
    };
    // Anonymous when there is no token: GitHub answers public reads without
    // one. An EMPTY Authorization header is worse than none (401 on endpoints
    // that would otherwise have answered), so it is omitted entirely.
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (requestOptions.etag) headers["if-none-match"] = requestOptions.etag;
    // P13-UI-04: every GitHub call was unbounded, so an unreachable or hanging
    // api.github.com left a click looking dead (and, on a delivery path, held a
    // run's single-flight) until the socket eventually gave up. A request that
    // exceeds the budget now fails as a normal network error, which the callers
    // already surface honestly.
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(requestOptions.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS),
    };
    if (requestOptions.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(requestOptions.body);
    }
    return fetchImpl(url, init);
  }

  function request<Schema extends z.ZodType>(
    method: GithubMethod,
    path: string,
    schema: Schema,
    options?: GithubRequestOptions,
  ): Promise<GithubResponse<z.output<Schema>>>;
  function request<T>(
    method: GithubMethod,
    path: string,
    options?: GithubRequestOptions,
  ): Promise<GithubResponse<T>>;
  async function request(
    method: GithubMethod,
    path: string,
    schemaOrOptions?: z.ZodType | GithubRequestOptions,
    maybeOptions?: GithubRequestOptions,
  ): Promise<GithubResponse<unknown>> {
    let schema: z.ZodType | undefined;
    let requestOptions: GithubRequestOptions;
    if (schemaOrOptions instanceof z.ZodType) {
      schema = schemaOrOptions;
      requestOptions = maybeOptions ?? {};
    } else {
      schema = undefined;
      requestOptions = schemaOrOptions ?? {};
    }
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

    const data = await readBody(response);

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        data: schema === undefined ? data : schema.parse(data),
        etag,
        rateLimit,
        scopesHeader: response.headers.get("x-oauth-scopes"),
        tokenExpiration: tokenExpirationFrom(response.headers),
      };
    }
    const failure = githubErrorSchema.safeParse(data);
    return {
      ok: false,
      kind: "http",
      status: response.status,
      message: failure.success
        ? failure.data.message
        : response.statusText || "GitHub request failed",
      data,
      rateLimit,
    };
  }

  return { request };
}

/**
 * Web host for browse links (PR/branch/repo pages), derived from an API base
 * URL the way GitHub deployments lay them out:
 *   https://api.github.com          → https://github.com
 *   https://ghe.corp/api/v3         → https://ghe.corp   (GHE server)
 *   https://api.ghe.example.com/... → https://ghe.example.com
 * Defaults to https://github.com when no base is configured — the single
 * place UI links derive their host from instead of hardcoding github.com.
 */
export function githubWebHost(apiBaseUrl?: string | null): string {
  if (!apiBaseUrl || apiBaseUrl === GITHUB_API_BASE) return "https://github.com";
  try {
    const url = new URL(apiBaseUrl);
    if (url.hostname === "api.github.com") return "https://github.com";
    const host = url.hostname.replace(/^api\./, "");
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "https://github.com";
  }
}

/**
 * Encode a git ref (`heads/<branch>`) for a REST path.
 *
 * B11: encoded PER SEGMENT. `encodeURIComponent("heads/" + branch)` percent-
 * encodes the separator too, so the ref addressed `heads%2F<branch>` — which
 * GitHub does not resolve, and the caller could not tell a missing ref from a
 * malformed one. A branch may legitimately contain `/` (`feature/x`), so the
 * separators stay literal while every segment is escaped. For today's
 * `vib-142`-shaped names the output is byte-identical to a raw interpolation.
 */
export function encodeRefPath(ref: string): string {
  return ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** Convenience header read used by the PAT validator. */
export function tokenExpirationFrom(headers: Headers): string | null {
  const raw = headers.get("github-authentication-token-expiration");
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}
