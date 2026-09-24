/**
 * Thin typed fetch wrapper for api.github.com (Phase 7).
 *
 * - Bearer token auth (or ANONYMOUS when `token` is null — GitHub serves
 *   public read endpoints unauthenticated, at the lower 60/hr IP quota).
 * - If-None-Match ETag support (pass `etag`, get a `not_modified` result).
 * - Rate-limit info surfaced on every response.
 * - NO retry storms: exactly ONE retry, only on 5xx responses.
 * - Network failures and HTTP failures come back as TYPED RESULTS, never
 *   throws — services build their degraded modes on top, and a body that dies
 *   MID-READ (truncated/aborted stream) is a network failure like any other.
 *   `githubFailureMessage` reads any failure's human-readable line; a caller
 *   that wants a throw raises its own `AppError` from the result.
 * - Success bodies are decoded by a caller-supplied zod schema (see
 *   `GithubClient.request`); failure bodies stay unparsed. A success body the
 *   schema REFUSES is a typed `decode` failure carrying the raw body — the
 *   "never throws" rule covers payload drift too, and the caller decides
 *   whether anything in that body is still salvageable.
 * - `fetchImpl` injection is the mock-transport hook for tests; nothing in
 *   this layer ever logs or re-emits the token.
 */

import { z } from "zod";
import { errorMessage } from "../../shared/errors";

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
  /**
   * The request SUCCEEDED and the body did not decode: GitHub answered 2xx with
   * a payload the call-site schema refuses. Deliberately shaped like `http`
   * (status, message, data, rateLimit) so a caller that already narrowed to
   * "some failure with a message" keeps compiling — and so `data` is there for
   * the one thing this kind exists for: salvaging identity facts from a body a
   * strict field voided (e.g. the PR number of a PR that was really created).
   */
  | {
      ok: false;
      kind: "decode";
      status: number;
      /** Why the body was refused (zod's issue text) — never the body itself. */
      message: string;
      /** The raw 2xx body, UNPARSED. */
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
  /**
   * False for a write that must not be sent twice. The client retries once on
   * a 5xx, and a create GitHub made before answering 502 is refused by that
   * retry ("name already exists", "sha wasn't supplied"), which reads as
   * "nothing was made" (pre-merge review of pass 40, R-repo-1). Such a caller
   * takes the 5xx instead and reads back what GitHub holds.
   */
  retryServerError?: boolean;
}

export type GithubMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface GithubClient {
  /**
   * Issue a request and decode the SUCCESS body with `schema`. Call-site
   * schemas model only the fields their reader consumes, carrying the
   * tolerance that reader already has (`.catch(undefined)` where the read
   * optional-chains, strict where a drifted value must not flow onward), so
   * payload drift degrades exactly the way the raw reads always did. Failure
   * results carry the body unparsed — including a `decode` failure, which is
   * what a schema REFUSING a 2xx body produces instead of a throw.
   */
  request<Schema extends z.ZodType>(
    method: GithubMethod,
    path: string,
    schema: Schema,
    options?: GithubRequestOptions,
  ): Promise<GithubResponse<z.output<Schema>>>;
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

/**
 * Why a 2xx body was refused, in one line: the first issue's message and the
 * path it failed on. Zod's issue text names the EXPECTED shape, never the
 * received value, so nothing from the payload rides along.
 */
function decodeMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "GitHub's response did not match the expected shape";
  const at = issue.path.length > 0 ? ` at \`${issue.path.join(".")}\`` : "";
  const more =
    error.issues.length > 1 ? ` (+${error.issues.length - 1} more)` : "";
  return `GitHub's response did not match the expected shape${at}: ${issue.message}${more}`;
}

/**
 * The human-readable half of ANY non-ok result. Callers' residual branches used
 * to hardcode `"unknown"` for everything that was not `http`, which now would
 * swallow the one failure that can actually explain itself — a `decode`.
 */
export function githubFailureMessage(
  result: Extract<GithubResponse<unknown>, { ok: false }>,
): string {
  return result.kind === "not_modified"
    ? "GitHub reported the cached copy is still current"
    : result.message;
}

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
const GITHUB_REQUEST_TIMEOUT_MS = 20_000;

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

  async function request<Schema extends z.ZodType>(
    method: GithubMethod,
    path: string,
    schema: Schema,
    options?: GithubRequestOptions,
  ): Promise<GithubResponse<z.output<Schema>>> {
    const requestOptions = options ?? {};
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
      // Exactly one retry, 5xx only (no retry storms), unless the caller's
      // write must not be sent twice.
      if (response.status >= 500 && requestOptions.retryServerError !== false) {
        response = await doFetch(method, url.toString(), requestOptions);
      }
    } catch (error) {
      return {
        ok: false,
        kind: "network",
        message: errorMessage(error),
      };
    }

    const rateLimit = rateLimitFrom(response.headers);
    const etag = response.headers.get("etag");

    if (response.status === 304) {
      return { ok: false, kind: "not_modified", status: 304, etag, rateLimit };
    }

    // F21-9 (residual): reading the body is as much a network operation as the
    // fetch that started it. A truncated, aborted or timed-out response REJECTS
    // here — past the try/catch above, which only wraps the request — and threw
    // straight through the "never throws" contract into every caller. The
    // request happened either way, so it degrades exactly like an unreachable
    // host: a typed `network` failure carrying the transport's own reason.
    let data: JsonBody;
    try {
      data = await readBody(response);
    } catch (error) {
      return {
        ok: false,
        kind: "network",
        message: errorMessage(error),
      };
    }

    if (response.ok) {
      // A schema that REFUSES the body is a typed failure, not a throw: this
      // layer's whole contract is that services build degraded modes on values
      // (a thrown ZodError 500s the route that called it, and — worse — an
      // undecodable POST response threw AFTER the write GitHub had already
      // performed, leaving the created resource unrecorded).
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        return {
          ok: false,
          kind: "decode",
          status: response.status,
          message: decodeMessage(parsed.error),
          data,
          rateLimit,
        };
      }
      return {
        ok: true,
        status: response.status,
        data: parsed.data,
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
function tokenExpirationFrom(headers: Headers): string | null {
  const raw = headers.get("github-authentication-token-expiration");
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}


/**
 * Ruling 128 (pass 34): is this ref-read answer "there is no such ref"? A 404,
 * or a 409 whose message says the repository is empty (`Git Repository is
 * empty.`, what GitHub answers on a repository with no refs at all) — never a
 * network failure. Shared by the branch-name probe, `ensureTaskBranch` and the
 * repository bootstrap. Lives on the client leaf so both sides can import it
 * without a cycle.
 */
export function isMissingRefAnswer(result: GithubResponse<unknown>): boolean {
  if (result.ok || result.kind !== "http") return false;
  if (result.status === 404) return true;
  return result.status === 409 && /empty/i.test(result.message);
}

/**
 * Ruling 223 (F37-43): "this commit is not in the repository", as
 * `GET /repos/{repo}/commits/{sha}` actually answers it.
 *
 * That endpoint does NOT 404 a well-formed 40-character SHA it cannot find. It
 * answers **422 Unprocessable Entity** with `No commit found for SHA: <sha>`.
 * Ruling 135's never-pushed probe asked {@link isMissingRefAnswer}, which knows
 * 404 and the empty-repository 409 — so on the real API the probe could never
 * confirm a missing commit, the refusal it guards was unreachable, and a
 * never-pushed revision degraded to an "unverifiable" head that acceptance lets
 * through. Live on SHOP-17 that merged the revision the required reviewer had
 * REJECTED and discarded the one both reviewers had APPROVED, which existed
 * nowhere but a workspace.
 *
 * Kept separate from `isMissingRefAnswer` rather than folded into it: 422 is
 * GitHub's generic validation status and means something else on most
 * endpoints, so widening the shared predicate would make unrelated failures
 * read as "the ref is gone". This one is scoped to the commit read and to the
 * sentence that endpoint returns.
 */
export function isMissingCommitAnswer(result: GithubResponse<unknown>): boolean {
  if (isMissingRefAnswer(result)) return true;
  if (result.ok || result.kind !== "http") return false;
  return result.status === 422 && /no commit found/i.test(result.message);
}
