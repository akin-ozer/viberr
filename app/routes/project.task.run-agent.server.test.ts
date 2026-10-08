import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";
import { connectFakeBackend } from "../../test-support/backend-credentials";
import {
  drainRunCompletions,
  queueFakeRun,
  startedRunSpecs,
} from "../../test-support/fake-runtime";
import { waitFor } from "../../test-support/polling";
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
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  arda = userIds.arda;
  // VIB-151 is Selin's task and a run bills the OWNER's accounts (ruling 127).
  for (const userId of [arda, userIds.selin]) {
    await connectFakeBackend(app.db, userId, "codex");
    await connectFakeBackend(app.db, userId, "claude");
  }
});
afterAll(async () => {
  // A dispatch's completion re-invokes the operator, whose fake run and its
  // completion effects write files after the case returned; the data root
  // must outlive them.
  await drainRunCompletions();
  app.cleanup();
});

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
  return action(routeArgs(request, { slug: SLUG, key: TASK }, PATTERN));
}

/**
 * Ruling 449 (O39-c): the accept dialog's "update the branch and re-review
 * first" reaches the action through the task route. A refusal of the step
 * itself comes back as the toast's sentence.
 */
describe("ruling 449: the refresh-and-review intent", () => {
  it("answers a task with no open pull request with a 409 that says so", async () => {
    // CANARY: drop the route's `refresh-and-review` case and this is the
    // generic unknown-intent refusal instead.
    const result = await post({ intent: "refresh-and-review" });
    expect(result).toMatchObject({
      data: {
        ok: false,
        error: "`vib-151-timeline-compression` could not be brought up to date here (no open pull request). Nothing was started.",
      },
      init: { status: 409 },
    });
  });
});

describe("ruling 375: a prompted manual dispatch runs once", () => {
  it("records the directive before the run, so ruling 203's window never redelivers it", async () => {
    const before = developerRuns().length;
    const prompt = "Prompt-cache check-in: reply with one sentence and stop.";
    const result = await post({ intent: "run-agent", profileId: "developer", prompt });
    expect(result).toMatchObject({ ok: true, intent: "run-agent" });
    await drainRunCompletions();
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
    const { deliverDeferredMention } = await import("~/server/tasks/agent-completion.server");
    const delivered = await deliverDeferredMention(
      app.db,
      { dataRoot: app.dataRoot },
      { projectSlug: SLUG, taskKey: TASK, profileId: "developer", runStartedAt: run!.started_at! },
    );
    expect(delivered).toEqual({ started: false, pending: 0 });
    await drainRunCompletions();
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
    await drainRunCompletions();
    expect(developerRuns().length).toBe(before + 1);
    const commentsAfter =
      readTaskFile(taskRef({ dataRoot: app.dataRoot }, SLUG, TASK))?.parsed.timeline.filter(
        (event) => event.type === "comment" && event.actor.kind === "human",
      ).length ?? 0;
    expect(commentsAfter).toBe(commentsBefore);
  });
});

/**
 * Ruling 452 (owner, 2026-09-24): a prompted dispatch refused because the agent
 * is already running on the task. The directive is recorded first (ruling 375),
 * so it sits inside the live run's window and ruling 203 delivers it when that
 * run finishes. The person's note used to say "No run started", beside an error
 * telling them to wait and start another, which would deliver the words twice.
 */
describe("ruling 452: a dispatch refused because the agent is running is delivered when it finishes", () => {
  it("says so in the toast and the note, and the finished run hands the words over once", async () => {
    // Held live until released, then finished normally. VIB-151's developer
    // runs on Codex; were that to change, nothing would hold the run and the
    // prompted dispatch would start its own, failing this case loudly.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    queueFakeRun({ lines: [{ t: "", ev: "text", tag: "assistant", text: "working" }], gate }, "codex");
    const before = developerRuns().length;
    expect(await post({ intent: "run-agent", profileId: "developer" })).toMatchObject({
      ok: true,
      intent: "run-agent",
    });
    expect(developerRuns().length).toBe(before + 1);

    const prompt = "Also look at the retention window while you are in there.";
    const result = await post({ intent: "run-agent", profileId: "developer", prompt });
    // CANARY: drop the busy arm of the catch and this throws the 409.
    expect(result).toMatchObject({
      ok: true,
      intent: "run-agent",
      toast:
        "Developer is already running on this task, so no second run started. " +
        "Your prompt is on the timeline and is delivered to it when that run finishes.",
    });
    const [{ readTaskFile }, { taskRef }] = await Promise.all([
      import("~/server/files/task-writer.server"),
      import("~/server/tasks/task-mutation.server"),
    ]);
    const [note, directive] =
      readTaskFile(taskRef({ dataRoot: app.dataRoot }, SLUG, TASK))?.parsed.timeline.filter(
        (event) => event.type === "comment" && event.actor.kind === "human",
      ) ?? [];
    expect(directive?.text).toBe(`@Developer ${prompt}`);
    expect(note?.text).toBe(
      "Developer is already running on this task, so no second run started. " +
        "These words are delivered to it when that run finishes.",
    );
    expect(note?.toAgent).toBe(false);

    release();
    // The held run plays after the release, before any completion work the
    // drain could wait on: wait for the run its completion starts, then drain.
    await waitFor(() => developerRuns().length >= before + 2, "the deferred prompt's run", 5_000);
    await drainRunCompletions();
    expect(developerRuns().length, "delivered once, not twice").toBe(before + 2);
    expect(developerRuns().at(-1)?.prompt).toContain(prompt);
  });
});
