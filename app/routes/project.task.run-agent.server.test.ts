import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";
import { connectFakeBackend } from "../../test-support/backend-credentials";
import { startedRunSpecs } from "../../test-support/fake-runtime";
import type { RunSpec } from "~/server/runtimes/adapter.server";

/**
 * Ruling 375 (live catch, 2026-09-21): the Run-an-agent control with a prompt
 * used to run the agent TWICE — the dispatch, then ruling 203's completion
 * hook redelivering the prompt it had just recorded as the person's own
 * `@<agent>` comment, because that comment was written after the run started
 * and so sat inside the "posted after this run started" window. The directive
 * is recorded first now; these cases pin the order and its consequence.
 */

let app: AppTestContext;
let arda: string;

const SLUG = "viberr-core";
const TASK = "VIB-151";
const PATTERN = "/projects/:slug/tasks/:key";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  arda = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  // VIB-151 is Selin's task and a run bills the OWNER's accounts (ruling 127).
  const selin = findUserByEmail(app.db, "selin@viberr.dev")!.id;
  for (const userId of [arda, selin]) {
    await connectFakeBackend(app.db, userId, "codex");
    await connectFakeBackend(app.db, userId, "claude");
  }
});
afterAll(async () => {
  // A dispatch's completion re-invokes the operator, whose fake run and its
  // completion effects write files after the case returned; removing the data
  // root under them raced (ENOTEMPTY in the full suite). Wait until every run
  // on the task is terminal, then remove, retrying once more on a straggler.
  const { listRunsForTaskRows } = await import("~/server/runtimes/run-store.server");
  for (let i = 0; i < 40; i += 1) {
    const live = listRunsForTaskRows(app.db, SLUG, TASK).filter(
      (row) => row.state === "queued" || row.state === "running",
    );
    if (live.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (let attempt = 0; ; attempt += 1) {
    try {
      app.cleanup();
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
});

/** The fake runtime finishes a run on a microtask and the completion hook
 *  (ruling 203's window included) runs after it; give both a beat. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

/** The developer's own runs; a completion re-invokes the operator (its run
 *  is the completion contract, not a second delivery of the prompt). */
function developerRuns(): RunSpec[] {
  return startedRunSpecs().filter((spec) => spec.kind !== "operator");
}

async function post(fields: Record<string, string>) {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(arda);
  const csrf = await app.csrfFor(sessionId);
  const request = app.request(`/projects/${SLUG}/tasks/${TASK}`, {
    method: "POST",
    cookie,
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  });
  return action({
    request,
    url: new URL(request.url),
    params: { slug: SLUG, key: TASK },
    pattern: PATTERN,
    context: new RouterContextProvider(),
  });
}

describe("ruling 375: a prompted manual dispatch runs once", () => {
  it("records the directive before the run, so ruling 203's window never redelivers it", async () => {
    const before = developerRuns().length;
    const prompt = "Prompt-cache check-in: reply with one sentence and stop.";
    const result = await post({ intent: "run-agent", profileId: "developer", prompt });
    expect(result).toMatchObject({ ok: true, intent: "run-agent" });
    await settle();
    expect(developerRuns().length).toBe(before + 1);

    const { listRunsForTaskRows } = await import("~/server/runtimes/run-store.server");
    const run = listRunsForTaskRows(app.db, SLUG, TASK)
      .filter((row) => row.agent_profile_id === "developer")
      .at(-1);
    expect(run?.agent_profile_id).toBe("developer");

    const [{ readTaskFile }, { taskRef }] = await Promise.all([
      import("~/server/files/task-writer.server"),
      import("~/server/tasks/task-mutation.server"),
    ]);
    const file = readTaskFile(taskRef({ dataRoot: app.dataRoot }, SLUG, TASK));
    const directive = file?.parsed.timeline.find(
      (event) =>
        event.type === "comment" &&
        event.actor.kind === "human" &&
        event.text === `@Developer ${prompt}`,
    );
    expect(directive, "the prompt is on the record as the person's own comment").toBeDefined();
    expect(directive?.toAgent).toBe(true);
    // The order is the fix: the record predates the run it is the directive of.
    expect(directive!.occurredAt <= run!.started_at!).toBe(true);

    // Ruling 203's completion hook, asked directly with this run's window:
    // nothing to redeliver, nothing started.
    const { deliverDeferredMention } = await import("~/server/tasks/task-actions.server");
    const delivered = await deliverDeferredMention(
      app.db,
      { dataRoot: app.dataRoot },
      { projectSlug: SLUG, taskKey: TASK, profileId: "developer", runStartedAt: run!.started_at! },
    );
    expect(delivered).toEqual({ started: false, pending: 0 });
    await settle();
    expect(developerRuns().length).toBe(before + 1);
  });

  it("a dispatch without a prompt records no comment and still runs once", async () => {
    const before = developerRuns().length;
    const [{ readTaskFile }, { taskRef }] = await Promise.all([
      import("~/server/files/task-writer.server"),
      import("~/server/tasks/task-mutation.server"),
    ]);
    const commentsBefore =
      readTaskFile(taskRef({ dataRoot: app.dataRoot }, SLUG, TASK))?.parsed.timeline.filter(
        (event) => event.type === "comment" && event.actor.kind === "human",
      ).length ?? 0;
    const result = await post({ intent: "run-agent", profileId: "developer" });
    expect(result).toMatchObject({ ok: true, intent: "run-agent" });
    await settle();
    expect(developerRuns().length).toBe(before + 1);
    const commentsAfter =
      readTaskFile(taskRef({ dataRoot: app.dataRoot }, SLUG, TASK))?.parsed.timeline.filter(
        (event) => event.type === "comment" && event.actor.kind === "human",
      ).length ?? 0;
    expect(commentsAfter).toBe(commentsBefore);
  });
});
