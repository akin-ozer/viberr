import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";
import type { RunLog } from "~/server/runtimes/run-service.server";
import { ERROR_CODES } from "~/server/errors/error-codes";

/**
 * P13-D-11 — the wire contract for `/resources/run-log`.
 *
 * The task loader now ships a BOUNDED window of each agent group's console
 * (NFR5: the client must not have to load the full raw execution history at
 * once), so this route grew a backward mode. The console pages back through a
 * group with `?before=`, and steps into an older run of the same group with a
 * bare `?limit=`. These tests pin the shape the UI codes against; the
 * membership gate itself is pinned in run-artifact-routes.server.test.ts.
 */

let app: AppTestContext;
let ardaId: string;

const RUN_ID = "run_pagefixture";
const LINES = 12;
/** A run one line past the route's 500-line page. */
const LONG_RUN = "run_longfixture";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;

  const { insertRunLine, upsertRun } = await import(
    "~/server/runtimes/run-store.server"
  );
  /** A finished developer run on `taskKey` holding `lines` lines, seq 0 up. */
  const plant = (id: string, taskKey: string, lines: number) => {
    upsertRun(app.db, {
      id,
      projectSlug: "viberr-core",
      taskKey,
      threadId: `thread_${id}`,
      role: "developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "claude",
      model: "claude-opus-4-8",
      sdk: "claude-agent-sdk",
      state: "finished",
    });
    for (let i = 0; i < lines; i++) {
      insertRunLine(app.db, {
        runId: id,
        seq: i,
        occurredAt: "2026-07-24T00:00:00.000Z",
        raw: JSON.stringify({ i }),
        display: { t: "00:00:00", ev: "text", tag: "assistant", text: `l${i}` },
      });
    }
  };
  plant(RUN_ID, "VIB-142", LINES);
  // On a task of its own, so it joins no console group of the run above.
  plant(LONG_RUN, "VIB-139", 501);
});
afterAll(() => app.cleanup());

/** The 200-branch wire body: the route wraps `runLogPage`'s own contract. */
interface RunLogBody {
  data: RunLog;
}

/** One read of a fixture run (the 12-line one unless `runId` names another),
 *  signed in with `cookie` or with no session. */
async function load(query: string, cookie?: string, runId = RUN_ID): Promise<Response> {
  const { loader } = await import("~/routes/resources.run-log");
  const request = app.request(
    `/resources/run-log?runId=${runId}&${query}`,
    cookie ? { cookie } : {},
  );
  return loader(routeArgs(request, {}, "/resources/run-log"));
}

async function get(query: string): Promise<RunLog> {
  const res = await load(query, (await app.cookieFor(ardaId)).cookie);
  // A 200 rules out the route's two error branches, so the body is the
  // success payload the route builds from `runLogPage`.
  expect(res.status).toBe(200);
  const body: RunLogBody = await res.json();
  return body.data;
}

const texts = (data: RunLog) => data.lines.map((l) => l.display.text);

describe("GET /resources/run-log paging (P13-D-11)", () => {
  it("forward `since` keeps its existing meaning and reports what is older", async () => {
    const data = await get("since=9");
    expect(texts(data)).toEqual(["l10", "l11"]);
    expect(data.headSeq).toBe(11);
    expect(data.oldestSeq).toBe(10);
    expect(data.hasMore).toBe(true); // seq 0..9 exist below this page
  });

  it("`before` + `limit` returns the newest page OLDER than the cursor", async () => {
    const data = await get("before=6&limit=3");
    expect(texts(data)).toEqual(["l3", "l4", "l5"]);
    expect(data.oldestSeq).toBe(3);
    expect(data.hasMore).toBe(true);
  });

  it("reports hasMore:false at the start of the run — the console then steps runs", async () => {
    const data = await get("before=3&limit=50");
    expect(texts(data)).toEqual(["l0", "l1", "l2"]);
    expect(data.hasMore).toBe(false);
  });

  it("a bare `limit` pages this run's newest lines (entering an older run)", async () => {
    const data = await get("limit=2");
    expect(texts(data)).toEqual(["l10", "l11"]);
    expect(data.hasMore).toBe(true);
  });

  it("clamps a hostile `limit` instead of serving the payload it exists to page", async () => {
    // CANARY: drop the route's 500 cap and this page carries all 501 lines.
    const res = await load("limit=99999", (await app.cookieFor(ardaId)).cookie, LONG_RUN);
    expect(res.status).toBe(200);
    const capped: RunLogBody = await res.json();
    expect(capped.data.lines.map((l) => l.seq)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(capped.data.hasMore).toBe(true);
    // A garbage limit falls back to the forward tail, never to "everything".
    const bad = await get("limit=abc");
    expect(bad.lines.length).toBe(LINES);
    const zero = await get("limit=0&before=6");
    expect(zero.lines.length).toBe(1); // clamped up to 1, not down to "all"
  });
});

/**
 * Ruling 300: the console's two ruling-300 asks of this route. `raw=0` leaves
 * the stored envelopes out (the console asks for them only while its raw view
 * is open), every answer carries the run row's live facts (the Live run strip
 * follows the tail, LIVE-1), and `window=1` answers the group's console window
 * the way a hard refresh ships it (TASK-1).
 */
describe("GET /resources/run-log for the console (ruling 300)", () => {
  it("`raw=0` drops each line's envelope and keeps its display", async () => {
    const data = await get("since=9&raw=0");
    expect(texts(data)).toEqual(["l10", "l11"]);
    for (const line of data.lines) expect(line).not.toHaveProperty("raw");
    const withRaw = await get("since=9");
    expect(withRaw.lines[0]!.raw).toBe(JSON.stringify({ i: 10 }));
  });

  it("carries the run row's live facts on every page", async () => {
    const data = await get("since=11");
    expect(data.lines).toEqual([]);
    expect(data.facts).toMatchObject({ phase: null, step: null, turns: 0, tokensEstimated: true });
  });

  it("`window=1` answers the group's window: display lines, keys, facts, no envelope", async () => {
    const { loader } = await import("~/routes/resources.run-log");
    const { cookie } = await app.cookieFor(ardaId);
    const request = app.request(`/resources/run-log?runId=${RUN_ID}&window=1`, { cookie });
    const res = await loader(routeArgs(request, {}, "/resources/run-log"));
    expect(res.status).toBe(200);
    // SAFETY: a 200 from the route's `window=1` branch, which answers
    // `Response.json({ data: runLogWindowFor(...) })` (`RunLogWindowPage`).
    const body = (await res.json()) as {
      data: { runId: string; lines: { text: string }[]; lineKeys: string[]; logWindow: { headSeq: number } };
    };
    expect(body.data.runId).toBe(RUN_ID);
    expect(body.data.lines.map((l) => l.text)).toEqual(Array.from({ length: LINES }, (_, i) => `l${i}`));
    expect(body.data.lineKeys.at(-1)).toBe(`0:${LINES - 1}`);
    expect(body.data.logWindow.headSeq).toBe(LINES - 1);
    expect(JSON.stringify(body)).not.toContain('"raw"');
  });
});

/**
 * Ruling 11, test audit L14-29. The run console reads this in the background
 * with a plain `fetch`, which follows a redirect without a word: behind
 * `requireUser`'s login redirect, every tail read from a signed-out tab
 * rendered /login on the server, failed to parse as the log, and was retried
 * in silence. No session, or a forced password reset pending, answers 401 in
 * the conventions' JSON error shape, which the console reports as a stopped
 * tail.
 */
describe("GET /resources/run-log signed out (ruling 11)", () => {
  it("answers 401 in the conventions' error shape, never a login redirect", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const { updateUserFields } = await import("~/server/auth/user-store.server");
    updateUserFields(app.db, ardaId, { pwresetRequired: true });
    try {
      // CANARY: guard with `requireUser` again and both reads reject with its
      // 302 to /login?returnTo=%2Fresources%2Frun-log%3FrunId%3D….
      for (const res of [await load("since=-1"), await load("since=-1", cookie)]) {
        expect({ status: res.status, body: await res.json() }).toEqual({
          status: 401,
          body: {
            error: { code: ERROR_CODES.UNAUTHORIZED, message: "Sign in to read this run's log." },
          },
        });
      }
    } finally {
      updateUserFields(app.db, ardaId, { pwresetRequired: false });
    }
  });
});
