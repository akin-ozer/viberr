/**
 * Canned-response fetch for GitHub-layer tests (Phase 7). NO live GitHub
 * calls in tests — every service takes a `fetchImpl` injection and tests
 * pass this.
 *
 * Routes are keyed `"METHOD /path"` (path only, query ignored for
 * matching). A responder is either a static spec or a function of the
 * recorded call (functions enable first-call-fails-then-succeeds retry
 * tests). Unmatched requests return 404 `{"message":"Not Found"}` and are
 * recorded, so tests can assert on them.
 */

export interface FakeCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
  /** 1-based per-route invocation counter. */
  attempt: number;
}

export interface FakeResponseSpec {
  status?: number;
  /** JSON-serialized unless a string is given. Ignored for 204/304. */
  body?: unknown;
  headers?: Record<string, string>;
}

export type FakeResponder =
  | FakeResponseSpec
  | ((call: FakeCall) => FakeResponseSpec);

export interface FakeGithub {
  fetchImpl: typeof fetch;
  /** Every request in order. */
  calls: FakeCall[];
  /** Requests for one route key, e.g. "GET /user". */
  callsTo(key: string): FakeCall[];
}

export function fakeGithubFetch(
  routes: Record<string, FakeResponder>,
): FakeGithub {
  const calls: FakeCall[] = [];
  const perRoute = new Map<string, number>();

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const attempt = (perRoute.get(key) ?? 0) + 1;
    perRoute.set(key, attempt);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[k.toLowerCase()] = v;
    }
    const call: FakeCall = {
      method,
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      attempt,
    };
    calls.push(call);

    const responder = routes[key];
    const spec: FakeResponseSpec = responder
      ? typeof responder === "function"
        ? responder(call)
        : responder
      : { status: 404, body: { message: "Not Found" } };

    const status = spec.status ?? 200;
    const responseHeaders = new Headers(spec.headers ?? {});
    if (status === 204 || status === 304) {
      return new Response(null, { status, headers: responseHeaders });
    }
    const bodyText =
      spec.body === undefined
        ? ""
        : typeof spec.body === "string"
          ? spec.body
          : JSON.stringify(spec.body);
    if (!responseHeaders.has("content-type") && bodyText) {
      responseHeaders.set("content-type", "application/json");
    }
    return new Response(bodyText, { status, headers: responseHeaders });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    callsTo(key: string): FakeCall[] {
      return calls.filter((c) => `${c.method} ${c.url.pathname}` === key);
    },
  };
}

/** A fetch that always fails at the network level. */
export function unreachableFetch(message = "getaddrinfo ENOTFOUND api.github.com"): typeof fetch {
  return (async () => {
    throw new TypeError(message);
  }) as typeof fetch;
}
