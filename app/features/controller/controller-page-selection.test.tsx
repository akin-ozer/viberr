import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";

/**
 * U33-8 — the two controller PAGE loaders open the same thread the dock would.
 *
 * Ruling 121 gave the dock a continuity rule ("the newest thread of the scope
 * you are standing in"); the page answered a blank composer, so one person on
 * one scope got two different answers from the two entry points. These pin the
 * page half of that rule: a bare URL opens the scope's newest thread, `?c=new`
 * is the blank composer the New link asks for, an explicit id still wins, and
 * the default is drawn from threads the viewer can actually talk in.
 *
 * (A `.tsx` test with no JSX: the cluster that owns this fix owns
 * `app/features/controller/*.test.tsx`, and these loaders had no test file.)
 */

let app: AppTestContext;
let arda: string; // org admin + project admin on viberr-core
let deniz: string; // org member, member of nothing
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  arda = userIds.arda;
  deniz = userIds.deniz;
});
afterAll(() => app.cleanup());

const surface = z.object({
  view: z.object({
    conversation: z.object({ id: z.string() }).nullable(),
    conversations: z.array(z.object({ id: z.string() })),
  }),
});

async function instancePage(userId: string, query: string) {
  const { loader } = await import("~/routes/controller");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(`/controller${query}`, { cookie });
  return surface.parse(
    await loader({
      request,
      url: new URL(request.url),
      params: {},
      pattern: "/controller",
      context: new RouterContextProvider(),
    }),
  );
}

async function projectPage(userId: string, query: string) {
  const { loader } = await import("~/routes/project.controller");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(`/projects/${SLUG}/controller${query}`, { cookie });
  return surface.parse(
    await loader({
      request,
      url: new URL(request.url),
      params: { slug: SLUG },
      pattern: "/projects/:slug/controller",
      context: new RouterContextProvider(),
    }),
  );
}

async function start(input: {
  userId: string;
  label: string;
  projectSlug?: string | null;
  taskKey?: string | null;
}) {
  const { createConversation } = await import(
    "~/server/controller/controller-conversations.server"
  );
  return createConversation(app.db, {
    userId: input.userId,
    userLabel: input.label,
    projectSlug: input.projectSlug ?? null,
    taskKey: input.taskKey ?? null,
  });
}

describe("the controller page's opening thread (U33-8)", () => {
  it("opens the instance scope's newest thread when nothing is selected", async () => {
    const older = await start({ userId: arda, label: "arda@viberr.dev" });
    const newest = await start({ userId: arda, label: "arda@viberr.dev" });
    expect((await instancePage(arda, "")).view.conversation?.id).toBe(newest.id);
    // "New" still starts a fresh thread, and an explicit id still wins.
    expect((await instancePage(arda, "?c=new")).view.conversation).toBeNull();
    expect((await instancePage(arda, `?c=${older.id}`)).view.conversation?.id).toBe(
      older.id,
    );
  });

  it("opens the project scope's newest thread, task-anchored ones included", async () => {
    const board = await start({
      userId: arda,
      label: "arda@viberr.dev",
      projectSlug: SLUG,
    });
    const task = await start({
      userId: arda,
      label: "arda@viberr.dev",
      projectSlug: SLUG,
      taskKey: "VIB-142",
    });
    // The rail lists both, so the default may be either — here, the task one.
    const opened = await projectPage(arda, "");
    expect(opened.view.conversation?.id).toBe(task.id);
    expect(opened.view.conversations.map((c) => c.id)).toContain(board.id);
    expect((await projectPage(arda, "?c=new")).view.conversation).toBeNull();
    expect((await projectPage(arda, `?c=${board.id}`)).view.conversation?.id).toBe(
      board.id,
    );
    // The instance page keeps its own scope: neither of these is its default.
    const elsewhere = (await instancePage(arda, "")).view.conversation?.id;
    expect([board.id, task.id]).not.toContain(elsewhere);
  });

  it("defaults to the viewer's own newest thread, never someone else's", async () => {
    // A scope with nothing in it still opens the blank composer.
    expect((await instancePage(deniz, "")).view.conversation).toBeNull();
    const mine = await start({ userId: arda, label: "arda@viberr.dev" });
    const theirs = await start({ userId: deniz, label: "deniz@viberr.dev" });
    // An org admin reading everyone's (?all=1) sees Deniz's newer thread in the
    // rail but opens their own: the default has to land somewhere they can talk.
    const all = await instancePage(arda, "?all=1");
    expect(all.view.conversations.map((c) => c.id)).toContain(theirs.id);
    expect(all.view.conversation?.id).toBe(mine.id);
    expect((await instancePage(arda, "")).view.conversation?.id).toBe(mine.id);
  });
});
