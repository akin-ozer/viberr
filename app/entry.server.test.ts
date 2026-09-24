import { createElement } from "react";
import {
  createRequestHandler,
  redirect,
  UNSAFE_withComponentProps,
  UNSAFE_withErrorBoundaryProps,
  type ServerBuild,
} from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../test-support/test-app";

/**
 * Ruling 458(d): every response carries its request's id as `X-Request-Id`, the
 * id the request's log records carry.
 *
 * React Router's own request handler, over the REAL entry module and the REAL
 * root route (its middleware, loader, Layout and ErrorBoundary), with a few
 * synthetic child routes for the shapes a response can take. Some responses
 * pass through the root middleware and some never reach it (an unmatched URL,
 * a 405, a refused `.data` mutation), which is why the entry stamps them too.
 */

/** The entry awaits `bootServer()` at module scope: the data-root lock, the
 *  watchers, the timers and the process crash handlers. None of that is under
 *  test, so its two once-only flags are set before the import, as a booted
 *  process would have them, and put back after. */
/** A route module as a server build's manifest holds it. */
type ServerRouteModule = NonNullable<ServerBuild["routes"][string]>["module"];

const BOOT_FLAGS = [
  Symbol.for("viberr.booted"),
  Symbol.for("viberr.crashVisibilityInstalled"),
];

let app: AppTestContext;
let handle: (request: Request) => Promise<Response>;

function Page() {
  return createElement("p", null, "the page");
}

const PAGE_URL = "http://localhost:5173";

beforeAll(async () => {
  app = await setupAppTest();
  // SAFETY: both keys are registry symbols under viberr-namespaced names that
  // only boot.server.ts reads; the only value it ever stores in them is `true`.
  const flags = globalThis as Record<symbol, boolean | undefined>;
  const before = BOOT_FLAGS.map((flag) => flags[flag]);
  for (const flag of BOOT_FLAGS) flags[flag] = true;
  const entry = await import("~/entry.server");
  BOOT_FLAGS.forEach((flag, i) => {
    flags[flag] = before[i];
  });
  const rootModule = await import("~/root");
  // What the React Router Vite plugin does to every route module in a build:
  // the component and the boundary read their props from the router.
  const root = {
    ...rootModule,
    default: UNSAFE_withComponentProps(rootModule.default),
    ErrorBoundary: UNSAFE_withErrorBoundaryProps(rootModule.ErrorBoundary),
  };

  const child = (id: string, path: string, module: Partial<ServerRouteModule>) => ({
    id,
    parentId: "root",
    path,
    module,
  });
  const manifest = {
    root: { id: "root", path: "", module: root },
    "routes/page": child("routes/page", "page", { default: Page, loader: () => ({ ok: true }) }),
    "routes/boom": child("routes/boom", "boom", {
      default: Page,
      loader: () => {
        throw new Error("the loader broke");
      },
    }),
    "routes/away": child("routes/away", "away", {
      default: Page,
      loader: () => {
        throw redirect("/page");
      },
    }),
    // A resource route: a loader, no component.
    "routes/resource": child("routes/resource", "resource", {
      loader: () => Response.json({ ok: true }),
    }),
  };
  // SAFETY: a build's server manifest is untyped JavaScript, and two of its
  // shapes are ones the typed manifest cannot say: a resource route has no
  // `default` component, and root's `liveHeadMiddleware` is typed
  // `MiddlewareFunction` (result unknown) where a route module's middleware
  // answers `Response` (it returns `next()`'s own Response).
  const routes = manifest as ServerBuild["routes"];
  // The client half of the build: what `<Scripts />` and the hydration data name.
  const clientRoute = (id: string) => ({
    id,
    ...(id === "root" ? { path: "" } : { parentId: "root", path: routes[id]!.path }),
    hasAction: false,
    hasLoader: true,
    hasClientAction: false,
    hasClientLoader: false,
    hasClientMiddleware: false,
    hasErrorBoundary: id === "root",
    module: `/assets/${id}.js`,
    clientActionModule: undefined,
    clientLoaderModule: undefined,
    clientMiddlewareModule: undefined,
    hydrateFallbackModule: undefined,
  });
  const build: ServerBuild = {
    entry: { module: entry },
    routes,
    assets: {
      entry: { module: "/assets/entry.client.js", imports: [] },
      routes: Object.fromEntries(
        Object.keys(routes).map((id) => [id, clientRoute(id)]),
      ),
      url: "/assets/manifest.js",
      version: "test",
    },
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
  };
  const handler = createRequestHandler(build, "production");
  handle = (request) => handler(request);
});

afterAll(() => app.cleanup());

const REQUEST_ID = /^[0-9a-f]{12}$/;

/** The JSON log records written while `fn` ran (the logger writes one per
 *  stdout line). */
async function capturingLog<T>(fn: () => Promise<T>): Promise<{ result: T; records: LogRecord[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    const result = await fn();
    const records = lines.flatMap((line) => logRecordOf(line) ?? []);
    return { result, records };
  } finally {
    spy.mockRestore();
  }
}

const logRecordSchema = z.looseObject({ msg: z.string(), requestId: z.string().optional() });
type LogRecord = z.infer<typeof logRecordSchema>;

/** A stdout line as a log record; null for anything else written there. */
function logRecordOf(line: string): LogRecord | null {
  try {
    const parsed = logRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return handle(new Request(new URL(path, PAGE_URL), init));
}

describe("X-Request-Id on every response (ruling 458(d))", () => {
  it("a document, its `.data`, a resource route and a redirect carry one", async () => {
    const answers = await Promise.all([
      get("/page"),
      get("/page.data"),
      get("/resource"),
      get("/away"),
      get("/away.data"),
    ]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200, 302, 202]);
    for (const response of answers) {
      expect(response.headers.get("X-Request-Id")).toMatch(REQUEST_ID);
    }
    // Five requests, five ids.
    expect(new Set(answers.map((r) => r.headers.get("X-Request-Id"))).size).toBe(5);
  });

  it("reuses an upstream proxy's id", async () => {
    const response = await get("/page", { headers: { "X-Request-Id": "proxy-7f3a" } });
    expect(response.headers.get("X-Request-Id")).toBe("proxy-7f3a");
  });

  it("responses React Router answers without route middleware carry one too", async () => {
    // CANARY: drop `handleDataRequest` from the entry and the `.data` answers
    // below have no header; drop the header line in `handleRequest` and the
    // unmatched document has none.
    const answers = await Promise.all([get("/nope"), get("/nope.data")]);
    expect(answers.map((r) => r.status)).toEqual([404, 404]);
    for (const response of answers) {
      expect(response.headers.get("X-Request-Id")).toMatch(REQUEST_ID);
    }
  });

  it("a failing loader's page carries the id its log record names", async () => {
    const { result: response, records } = await capturingLog(() => get("/boom"));
    expect(response.status).toBe(500);
    const id = response.headers.get("X-Request-Id");
    expect(id).toMatch(REQUEST_ID);
    expect(records.find((r) => r.msg === "request handler error")?.requestId).toBe(id);
  });

  it("the id on a response the middleware never saw is the one its log record carries", async () => {
    // A `.data` mutation from another origin is refused before any route
    // middleware runs, and `handleError` logs it; a 405 document likewise.
    const { result, records } = await capturingLog(() =>
      Promise.all([
        get("/page.data", { method: "POST", headers: { Origin: "http://elsewhere.example" } }),
        get("/page", { method: "PROPFIND" }),
      ]),
    );
    const [refused, notAllowed] = result;
    expect(refused.status).toBe(400);
    expect(notAllowed.status).toBe(405);
    const logged = records
      .filter((r) => r.msg === "request handler error")
      .map((r) => r.requestId);
    expect(logged).toHaveLength(2);
    expect(logged).toEqual(
      expect.arrayContaining([
        refused.headers.get("X-Request-Id"),
        notAllowed.headers.get("X-Request-Id"),
      ]),
    );
  });
});
