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

import { z } from "zod";

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
  /** JSON-serialized unless a string is given. Ignored for 204. */
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

/** A JSON string body, the only body shape the services under test send. */
const jsonRequestBody = z.string();
/** A response body given verbatim rather than JSON-serialized. */
const verbatimResponseBody = z.string();

/** Resolve the two responder forms once, where `routes` enters, so the request
 *  path below has a single kind of thing to call. */
function responderFns(
  routes: Record<string, FakeResponder>,
): Map<string, (call: FakeCall) => FakeResponseSpec> {
  return new Map(
    Object.entries(routes).map(([key, responder]) => [
      key,
      responder instanceof Function ? responder : () => responder,
    ]),
  );
}

export function fakeGithubFetch(
  routes: Record<string, FakeResponder>,
): FakeGithub {
  const calls: FakeCall[] = [];
  const perRoute = new Map<string, number>();
  const responders = responderFns(routes);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}`;
    const attempt = (perRoute.get(key) ?? 0) + 1;
    perRoute.set(key, attempt);

    // `Headers` is the platform's own decoder for every `HeadersInit` form and
    // lower-cases the names on the way in, which is the shape callers assert on.
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers)) {
      headers[name] = value;
    }
    const sentBody = jsonRequestBody.safeParse(init?.body);
    const call: FakeCall = {
      method,
      url,
      headers,
      body: sentBody.success ? JSON.parse(sentBody.data) : null,
      attempt,
    };
    calls.push(call);

    const responder = responders.get(key);
    const spec: FakeResponseSpec = responder
      ? responder(call)
      : { status: 404, body: { message: "Not Found" } };

    const status = spec.status ?? 200;
    const responseHeaders = new Headers(spec.headers ?? {});
    if (status === 204) {
      return new Response(null, { status, headers: responseHeaders });
    }
    const verbatim = verbatimResponseBody.safeParse(spec.body);
    const bodyText =
      spec.body === undefined
        ? ""
        : verbatim.success
          ? verbatim.data
          : JSON.stringify(spec.body);
    if (!responseHeaders.has("content-type") && bodyText) {
      responseHeaders.set("content-type", "application/json");
    }
    return new Response(bodyText, { status, headers: responseHeaders });
  };

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
  return async () => {
    throw new TypeError(message);
  };
}

/**
 * FAULT INJECTION: a 200 whose HEADERS throw on read. Every header read in the
 * GitHub client sits outside its try/catch, so this reaches the code paths that
 * must survive an unexpected throw from inside a pass.
 *
 * It used to be a truncated BODY, which no longer qualifies: F21-9 wraps the
 * body read, so a stream that dies mid-read is now a typed `network` failure —
 * a degraded mode the callers handle, not a throw that escapes them.
 */
export function unreadableResponse(): Response {
  const response = new Response("{}", { status: 200 });
  Object.defineProperty(response, "headers", {
    get(): never {
      throw new TypeError("terminated");
    },
  });
  return response;
}
