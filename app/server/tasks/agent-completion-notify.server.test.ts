import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { recordAgentCompletion } from "./agent-completion.server";

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
    .all();
}

function timeline(store: TestStore, key = "VIB-1") {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: key,
    dataRoot: store.dataRoot,
  })!.parsed.timeline;
}

describe("recordAgentCompletion notifies the humans the report @tags (P13-RT-01)", () => {
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
        delivers: true,
        replyText:
          "Rewrote the onboarding guide and split the CLI section into its own page.",
        verdict: null,
        question: null,
      },
    );
    expect(notifications(store)).toHaveLength(0);
  });

  it("a deduped report still delivers the dispatch cc's ADDED @tag (bug-sweep #7)", async () => {
    // A dispatched run whose final report REPEATS its mid-run comment verbatim
    // (F22-12) is deduped and not re-posted — but the dispatch-completion cc line
    // (ruling 98) tags the dispatcher, a mention that comment never carried.
    // stripCcLine equalised the two, the reply was dropped, and the guaranteed
    // ping — fanned out only when the reply POSTED — never fired.
    const store = setupTestStore(ctx);
    seedTask(store);
    const runId = "run_dedup";
    const startedAt = "2026-08-31T00:00:00.000Z";
    // A real run row so the mid-run-comment dedup can bound on started_at.
    store.db
      .prepare(
        `INSERT INTO agent_runs (id, task_key, project_slug, thread_id, role, kind,
           backend, model, state, started_at, created_at, updated_at, agent_profile_id)
         VALUES (?, 'VIB-1', ?, 'th_dedup', 'Docs Writer', 'primary',
           'codex', 'gpt-test', 'finished', ?, ?, ?, 'docs-writer')`,
      )
      .run(runId, store.slug, startedAt, startedAt, startedAt);

    // The agent's mid-run comment — the body its report repeats. Tags NOBODY, so
    // the dispatch cc below is a genuinely NEW mention (not a re-notify).
    const body = "The refactor is done and every test passes.";
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.timeline.unshift({
          occurredAt: "2026-08-31T00:05:00.000Z",
          type: "comment",
          actor: AGENT,
          title: null,
          text: body,
          toAgent: false,
          evidence: null,
        });
      },
    );

    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: AGENT,
        runId,
        delivers: true,
        // Body repeats the mid-run comment (deduped); the cc line is the new tag.
        replyText: `${body}\n\ncc @${store.users.arda.name} @operator`,
        verdict: null,
        question: null,
      },
    );

    // The dispatcher (Arda) is notified even though the reply body deduped.
    const rows = notifications(store).filter((r) => r.kind === "mention");
    expect(rows.map((r) => r.user_id)).toEqual([store.users.arda.id]);
    // The duplicate body did NOT post a second comment.
    const comments = timeline(store).filter((e) => e.type === "comment");
    expect(comments).toHaveLength(1);
  });

  it("notifies a handle that evidence-separation cut from the stored reply (B-FD8b)", async () => {
    // The fan-out scans the PRE-trim reply text: a @tag sitting inside a fenced
    // block longer than the evidence cap is gone from the stored comment (only
    // the head survives), but the tagged human must still be notified.
    const store = setupTestStore(ctx);
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      guardrails: [{ id: "evidence-separation", desc: "on", on: true }],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedTask(store);
    const firstName = store.users.arda.name.split(" ")[0]!;
    const fenceBody = Array.from({ length: 30 }, (_, i) =>
      i === 17 ? `@${firstName} please decide on this line` : `log line ${i}`,
    ).join("\n");
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: AGENT,
        runId: "run_fence",
        delivers: true,
        replyText: `Validation output:\n\`\`\`\n${fenceBody}\n\`\`\`\nDone.`,
        verdict: null,
        question: null,
      },
    );
    // The stored record really lost the handle to the trim…
    const stored = timeline(store).find((e) => e.type === "comment")!;
    expect(stored.text).toContain("evidence-separation guardrail");
    expect(stored.text).not.toContain(`@${firstName}`);
    // …but the tagged human was still notified.
    const rows = notifications(store).filter((r) => r.kind === "mention");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(store.users.arda.id);
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
        delivers: false,
        replyText: "@Arda approving — the docs match the shipped flags now.",
        verdict: "approve",
        question: null,
      },
    );
    const rows = notifications(store).filter((r) => r.kind === "mention");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(store.users.arda.id);
    // Ruling 497: the verdict's row opens the verdict ("Approval noted…",
    // "Review passed", "Changes requested"), and the mention's row opens the
    // report that tagged the person. CANARY: drop `verdictAt` from the
    // verdict notice and its rows open the task's top.
    const events = timeline(store);
    const verdictAt = events.find((e) => e.type === "quality")!.occurredAt;
    const reportAt = events.find((e) => e.type === "comment")!.occurredAt;
    const hrefs = store.db
      .prepare(`SELECT DISTINCT kind, href FROM notifications ORDER BY kind`)
      .all();
    expect(hrefs).toEqual([
      { kind: "mention", href: `/projects/${store.slug}/tasks/VIB-1#event-${reportAt}` },
      { kind: "quality", href: `/projects/${store.slug}/tasks/VIB-1#event-${verdictAt}` },
    ]);
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
        delivers: true,
        replyText: "I need a decision before continuing.",
        verdict: null,
        question: {
          title: "Which changelog format do you want?",
          body: "keep-a-changelog or plain prose?",
        },
      },
    );

    const audit = listAuditEvents(store.db, {
      action: "task.agent.packet_opened",
    })[0]!;
    // Was OPERATOR_AUDIT_ACTOR ("operator") on this transport, so an
    // actor-filtered audit view credited every Codex agent's question to the
    // operator — the exact misreporting P11-23 fixed on the Claude transport.
    expect(audit.actorLabel).toMatch(/^agent:codex\/docs-writer/);
    expect(audit.details!.actorRef).toMatch(/^agent:codex\/docs-writer/);
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
        delivers: true,
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
        delivers: true,
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
