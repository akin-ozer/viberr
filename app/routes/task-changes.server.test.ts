import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SeedUserIds } from "../../test-support/demo-data";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 315 (pass 40, F40-54): the two doors the Changes panel uses, as real
 * requests against the routes: its read (`task-changes.ts`, member-only, a 401
 * rather than a login redirect because a fetcher loads it) and the notes'
 * post (`review-notes` on the task route, the comment door). The GitHub read
 * itself is `server/github/task-changes.server.test.ts`.
 */

let app: AppTestContext;
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
});
afterAll(() => app.cleanup());

/** VIB-142's delivered revision in the demo seed (its newest commit, padded). */
const VIB_142_HEAD = "a91f7c2".padEnd(40, "0");

/** What a loader or action throws: React Router's `data()` envelope. */
const thrownEnvelope = z.object({ init: z.object({ status: z.number() }) });

async function readChanges(key: string, userId: string | null) {
  const { loader } = await import("~/routes/task-changes");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  const request = app.request(`/projects/viberr-core/tasks/${key}/changes`, cookie ? { cookie } : {});
  return loader(routeArgs(request, { slug: "viberr-core", key }, "/projects/:slug/tasks/:key/changes"));
}

async function refusedStatus(read: Promise<unknown>): Promise<number | null> {
  try {
    await read;
    return null;
  } catch (error) {
    return thrownEnvelope.parse(error).init.status;
  }
}

async function postNotes(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const request = app.request("/projects/viberr-core/tasks/VIB-142", {
    method: "POST",
    cookie,
    body: new URLSearchParams({ _csrf: csrf, intent: "review-notes", ...fields }),
  });
  return action(routeArgs(request, { slug: "viberr-core", key: "VIB-142" }, "/projects/:slug/tasks/:key"));
}

const actionResult = z.union([
  z.object({ ok: z.literal(true), toast: z.string(), agent: z.string().nullable() }),
  z.object({ data: z.object({ ok: z.literal(false), error: z.string() }), init: z.object({ status: z.number() }) }),
]);

describe("ruling 315: the Changes panel's read", () => {
  it("answers a signed-out fetch 401 and a non-member the unknown-project 404", async () => {
    expect(await refusedStatus(readChanges("VIB-142", null))).toBe(401);
    expect(await refusedStatus(readChanges("VIB-142", ids.deniz))).toBe(404);
    expect(await refusedStatus(readChanges("VIB-999", ids.selin))).toBe(404);
  });

  it("says why it cannot read, for a member, without throwing", async () => {
    // The demo seed binds no credential, so GitHub cannot be asked.
    expect(await readChanges("VIB-142", ids.selin)).toEqual({
      ok: false,
      reason: "Could not read PR #318 from GitHub: no GitHub credential is configured for this project.",
    });
  });
});

describe("ruling 246: the review-notes intent", () => {
  const notes = JSON.stringify([
    { path: "app/server/github/reconcile.ts", line: 42, side: "new", body: "Name the refusal here." },
    { path: "app/server/github/reconcile.ts", line: 7, side: "old", body: "Keep this guard." },
    // Ruling 246: a note on several lines.
    { path: "app/server/github/reconcile.ts", line: 60, side: "new", startLine: 51, startSide: "new", body: "Split this loop." },
  ]);

  it("posts ONE comment addressed to the deliverer that quotes each file:line or range", async () => {
    const result = actionResult.parse(await postNotes(ids.selin, { headSha: VIB_142_HEAD, notes }));
    expect(result).toMatchObject({ ok: true });
    if (!("ok" in result)) return;
    // Selin is a contributor: the comment lands and names the deliverer; her
    // role cannot start its run, and the toast says so, as for any comment.
    expect(result.toast).toBe("3 notes sent · your role can't trigger agent runs");
    expect(result.agent).not.toBeNull();
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const newest = readTaskFile({ projectSlug: "viberr-core", taskKey: "VIB-142" })!.parsed
      .timeline[0]!;
    expect(newest).toMatchObject({ type: "comment", toAgent: true });
    expect(newest.text).toBe(
      [
        "@developer Review notes on `a91f7c2` (PR #318):",
        "",
        "- `app/server/github/reconcile.ts:42`: Name the refusal here.",
        "- `app/server/github/reconcile.ts:7` (removed line): Keep this guard.",
        "- `app/server/github/reconcile.ts:51-60`: Split this loop.",
      ].join("\n"),
    );
  });

  it("answers notes written on another revision 409 and malformed notes 400", async () => {
    const stale = actionResult.parse(await postNotes(ids.selin, { headSha: "0".repeat(40), notes }));
    expect(stale).toMatchObject({ init: { status: 409 } });
    const malformed = actionResult.parse(
      await postNotes(ids.selin, { headSha: VIB_142_HEAD, notes: "[]" }),
    );
    expect(malformed).toMatchObject({ init: { status: 400 } });
  });
});
