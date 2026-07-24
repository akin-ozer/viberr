import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { recordAgentCompletion } from "./task-actions.server";

/**
 * The FINISHED-run completion path (`recordAgentCompletion`), which is the one
 * every successful agent run takes. Its failure mode was exactly what NEW-4 set
 * out to close: an agent's final report is the ONLY agent comment most tasks
 * ever get, and its @tags reached nobody.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const AGENT: FileActorRef = {
  kind: "agent",
  backend: "codex",
  profileId: "docs-writer",
  roleHint: "Docs Writer",
};

function seedTask(store: TestStore, key = "VIB-1"): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { stage: "build", waiting: "agent" }),
  });
}

function notifications(store: TestStore) {
  return store.db
    .prepare(`SELECT user_id, kind, text FROM notifications ORDER BY user_id`)
    .all() as { user_id: string; kind: string; text: string }[];
}

function timeline(store: TestStore, key = "VIB-1") {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: key,
    dataRoot: store.dataRoot,
  })!.parsed.timeline;
}

describe("recordAgentCompletion notifies the humans the report @tags (P13-RT-01)", () => {
  it("a completed run's reply fans out a mention notification", async () => {
    // BEFORE: the reply comment landed on the timeline and ZERO `mention`
    // notifications were created — live-proven with a Docs Writer reply opening
    // "@Arda …". Only the interrupted/errored path (postAgentReplyComment) and
    // Claude's mid-run post_comment fanned out, so on Codex — which has no
    // mid-run comment channel at all — an agent tag NEVER reached anyone.
    const store = setupTestStore(ctx);
    seedTask(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: AGENT,
        runId: "run_1",
        replyText:
          "@Arda I rewrote the onboarding guide and split the CLI section out. " +
          "Please confirm the new ordering before I touch the API reference.",
        verdict: null,
        question: null,
      },
    );

    const rows = notifications(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: store.users.arda.id,
      kind: "mention",
    });
    expect(rows[0]!.text).toContain("mentioned you");
    // The comment itself is still the timeline event it always was.
    expect(timeline(store)[0]).toMatchObject({ type: "comment", actor: AGENT });
  });

  it("notifies every tagged human, including a multi-word display name", async () => {
    const store = setupTestStore(ctx);
    seedTask(store);
    const selinLocal = store.users.selin.email.split("@")[0]!;
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: AGENT,
        runId: "run_1",
        replyText: `@${store.users.arda.name} the migration is written. @${selinLocal} can you take acceptance once CI is green?`,
        verdict: null,
        question: null,
      },
    );
    expect(new Set(notifications(store).map((r) => r.user_id))).toEqual(
      new Set([store.users.arda.id, store.users.selin.id]),
    );
  });

  it("an untagged report notifies nobody", async () => {
    const store = setupTestStore(ctx);
    seedTask(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: AGENT,
        runId: "run_1",
        replyText:
          "Rewrote the onboarding guide and split the CLI section into its own page.",
        verdict: null,
        question: null,
      },
    );
    expect(notifications(store)).toHaveLength(0);
  });

  it("fans out on the other backend's shape too — a verdict report that tags a human", async () => {
    // Codex delivers its report as the envelope `summary`; Claude delivers the
    // last assistant text line. Both arrive here as `replyText`, and a verdict
    // run is the case where the reply also writes frontmatter — the fan-out
    // must survive that branch.
    const store = setupTestStore(ctx);
    seedTask(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: { ...AGENT, backend: "claude", profileId: "reviewer" },
        runId: "run_2",
        replyText: "@Arda approving — the docs match the shipped flags now.",
        verdict: "approve",
        question: null,
      },
    );
    const rows = notifications(store).filter((r) => r.kind === "mention");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(store.users.arda.id);
  });
});

describe("the completion path attributes and preserves the agent's question (P13-RT-06)", () => {
  it("audits the packet as the AGENT, not the operator", async () => {
    const store = setupTestStore(ctx);
    seedTask(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: AGENT,
        runId: "run_1",
        replyText: "I need a decision before continuing.",
        verdict: null,
        question: {
          title: "Which changelog format do you want?",
          body: "keep-a-changelog or plain prose?",
        },
      },
    );

    const audit = store.db
      .prepare(
        `SELECT actor_label, details_json FROM audit_events WHERE action = 'task.agent.packet_opened'`,
      )
      .get() as { actor_label: string; details_json: string };
    // Was OPERATOR_AUDIT_ACTOR ("operator") on this transport, so an
    // actor-filtered audit view credited every Codex agent's question to the
    // operator — the exact misreporting P11-23 fixed on the Claude transport.
    expect(audit.actor_label).toMatch(/^agent:codex\/docs-writer/);
    expect(JSON.parse(audit.details_json).actorRef).toMatch(
      /^agent:codex\/docs-writer/,
    );
  });

  it("records a question it could not open, instead of dropping it silently", async () => {
    const store = setupTestStore(ctx);
    seedTask(store);
    // The first question takes the single packet slot.
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: AGENT,
        runId: "run_1",
        replyText: "Blocked on the format decision.",
        verdict: null,
        question: { title: "Which changelog format?" },
      },
    );
    // A second agent finishes while that decision is still open. Claude's
    // ask_human tool tells the model mid-run ("[refused] … mention your question
    // there instead"); the envelope transport had no channel and the question
    // vanished with no timeline trace at all.
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: { ...AGENT, profileId: "api-writer" },
        runId: "run_2",
        replyText: "Also blocked.",
        verdict: null,
        question: { title: "Do we still document the v1 endpoints?" },
      },
    );

    const held = timeline(store).find(
      (e) => e.type === "note" && e.text.includes("Question held"),
    );
    expect(held).toBeDefined();
    expect(held!.text).toContain("Do we still document the v1 endpoints?");
    // The open packet is still the FIRST question — never clobbered.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    });
    expect(file!.parsed.packet?.title).toContain("Which changelog format?");
  });
});
