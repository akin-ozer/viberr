import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import {
  normalizeEvidenceRows,
  EVIDENCE_MAX_ROWS,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";
import {
  parseTaskFileContent,
  serializeTaskFile,
} from "~/server/files/task-file.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { startRun } from "~/server/runtimes/run-service.server";
import {
  applyAgentCompletionEffects,
  deliveredWorkEvidence,
  recordAgentCompletion,
} from "./task-actions.server";
import { resolveAgentCollab, stageOutcome } from "./agent-outcome.server";

/**
 * P13-D-26 — the `evidence:` block gets producers (owner ruling: WIRE IT).
 *
 * Parser, serializer, escape rule, `evidence_json` column, projection decode
 * and renderer all shipped; the tree held 42 `evidence: null` literals and ZERO
 * non-null writes, and `composePrBody`'s `evidence` param was never passed by
 * its one caller. These tests cover the producers that close that; the PR
 * body's read of the newest rows is proven through `openTaskPr`
 * (pr-open.server.test.ts).
 */

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => {
  ctx.cleanup();
});

describe("normalizeEvidenceRows", () => {
  it("keeps well-formed rows and drops unlabeled ones", () => {
    expect(
      normalizeEvidenceRows([
        { label: "unit/policy_gate_test", add: "+14", del: "0" },
        { label: "  ", add: "+1", del: "-1" },
      ]),
    ).toEqual([{ label: "unit/policy_gate_test", add: "+14", del: "0" }]);
    expect(normalizeEvidenceRows([])).toBeNull();
    expect(normalizeEvidenceRows(null)).toBeNull();
  });

  it("flattens newlines so a row can never forge a second row or a section", () => {
    const rows = normalizeEvidenceRows([
      { label: "a\n- forged · +1 · -1\n## Goal", add: "+1", del: "0" },
    ])!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).not.toContain("\n");
  });

  it("strips the ` · ` separator from add/del so the columns cannot shift", () => {
    const rows = normalizeEvidenceRows([
      { label: "suite · integration", add: "+1 · +2", del: "0" },
    ])!;
    // A separator in the LABEL is safe (the parser pops the last two segments)
    // and is preserved; in a count column it would shift them, so it goes.
    expect(rows[0]!.label).toBe("suite · integration");
    expect(rows[0]!.add).not.toContain(" · ");
  });

  it("caps the row count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      label: `suite-${i}`,
      add: "+1",
      del: "0",
    }));
    expect(normalizeEvidenceRows(many)!.length).toBe(EVIDENCE_MAX_ROWS);
  });

  it("round-trips through the task.md serializer/parser", () => {
    const rows = normalizeEvidenceRows([
      { label: "suite · integration", add: "+38", del: "−4" },
      { label: "9 file(s) changed on `vib-1`", add: "+412", del: "−87" },
    ])!;
    const event: TaskFileEvent = {
      occurredAt: "2026-07-24T10:00:00.000Z",
      type: "quality",
      actor: { kind: "agent", backend: "claude", profileId: "reviewer", roleHint: "Review" },
      title: "Review passed",
      text: "**Validation:** healthy. Reviewer approved the work.",
      toAgent: false,
      evidence: rows,
    };
    const text = serializeTaskFile({
      frontmatter: baseTaskFrontmatter("VIB-1"),
      unknownFrontmatter: {},
      goal: "g",
      packet: null,
      timeline: [event],
      extraSections: [],
    });
    const back = parseTaskFileContent(text).parsed.timeline[0]!;
    expect(back.evidence).toEqual(rows);
  });
});

describe("deliveredWorkEvidence (server-derived rows — reuse, don't invent)", () => {
  it("derives a changed-files row and a commits row from the reconciled facts", () => {
    expect(
      deliveredWorkEvidence({
        branch: "vib-1-attach",
        workRevision: null,
        github: {
          commits: [
            { sha: "abc1234", msg: "[VIB-1] add the thing" },
            { sha: "def5678", msg: "[VIB-1] test the thing" },
          ],
          changed: { files: 9, add: 412, del: 87 },
        },
      }),
    ).toEqual([
      { label: "9 file(s) changed on `vib-1-attach`", add: "+412", del: "−87" },
      { label: "2 commit(s) delivered", add: "—", del: "—" },
    ]);
  });

  it("is empty when the task has no delivery facts yet", () => {
    expect(
      deliveredWorkEvidence({ branch: null, workRevision: null, github: null }),
    ).toEqual([]);
  });
});

describe("recordAgentCompletion attaches evidence to the outcome event", () => {
  const reviewer = {
    kind: "agent" as const,
    backend: "claude" as const,
    profileId: "reviewer",
    roleHint: "Review & validation",
  };

  function seed(): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        engagements: [
          {
            profileId: "reviewer",
            backend: "claude",
            role: "Review & validation",
            delivers: false,
            verdictCapable: true,
          },
        ],
        workRevision: {
          id: "rev_1",
          headSha: "a".repeat(40),
          treeSha: "b".repeat(40),
          branch: "vib-1-attach",
          sourceProfileId: "dev",
          createdAt: "2026-07-24T09:00:00.000Z",
        },
      }),
      goal: "Prove evidence rows land.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("lands the rows on the VERDICT event and projects them through evidence_json", async () => {
    seed();
    await recordAgentCompletion(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", {
      actorRef: reviewer,
      runId: "run_1",
      replyText: "Approve — the change matches the goal.",
      verdict: "approve",
      question: null,
      evidence: [
        { label: "unit/policy_gate_test", add: "+14", del: "0" },
        { label: "integration/pr_sync_test", add: "+38", del: "−4" },
      ],
    });

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const verdictEvent = file.parsed.timeline.find((e) => e.type === "quality")!;
    expect(verdictEvent.evidence).toEqual([
      { label: "unit/policy_gate_test", add: "+14", del: "0" },
      { label: "integration/pr_sync_test", add: "+38", del: "−4" },
    ]);
    // Exactly ONE event carries the outcome's evidence.
    const replyEvent = file.parsed.timeline.find((e) => e.type === "comment")!;
    expect(replyEvent.evidence).toBeNull();

    // …and it survives the projection into `task_events.evidence_json`.
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    const projected = detail.timeline.find((e) => e.type === "quality")!;
    expect(projected.evidence).toHaveLength(2);
    expect(projected.evidence![0]!.label).toBe("unit/policy_gate_test");
  });

  it("falls back to the agent's REPORT when there is no verdict to hang it on", async () => {
    seed();
    await recordAgentCompletion(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", {
      actorRef: { ...reviewer, profileId: "dev", roleHint: "developer" },
      runId: "run_2",
      replyText: "Implemented the attach flow.",
      verdict: null,
      question: null,
      evidence: [{ label: "9 file(s) changed on `vib-1-attach`", add: "+412", del: "−87" }],
    });
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const reply = file.parsed.timeline.find((e) => e.type === "comment")!;
    expect(reply.evidence).toHaveLength(1);
    expect(reply.evidence![0]!.add).toBe("+412");
  });

  it("records no evidence when none was produced", async () => {
    seed();
    await recordAgentCompletion(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", {
      actorRef: reviewer,
      runId: "run_3",
      replyText: "Approve.",
      verdict: "approve",
      question: null,
      evidence: [],
    });
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.timeline.find((e) => e.type === "quality")!.evidence).toBeNull();
  });
});

describe("the agent's channel: attach-evidence-references is a REAL grant", () => {
  it("the SEEDED reviewer profile actually holds it (its advertised label is now true)", async () => {
    const { SEED_AGENT_PROFILES } = await import("~/server/seed/agent-catalog.server");
    const reviewer = SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === "reviewer")!;
    expect(
      reviewer.frontmatter.capabilities.some(
        (c) => c.capabilityId === "attach-evidence-references" && c.mode === "direct",
      ),
    ).toBe(true);
    expect(resolveAgentCollab(reviewer.frontmatter.capabilities).evidence).toBe(true);
  });
});

describe("end-to-end: a staged report_outcome envelope lands its evidence", () => {
  /** Deploy a reviewer holding BOTH the verdict and the evidence grants. */
  function deployReviewer(
    capabilities: { capabilityId: string; mode: "direct" | "human" | "off" }[],
  ): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "reviewer",
          capabilities,
          extras: [],
          definition: {
            kind: "specialist",
            name: "Reviewer",
            role: "Review & validation",
            backends: ["claude"],
            model: "sonnet",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  function writeReviewTask(): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        title: "Attach execution workspace",
        branch: "vib-1-work",
        validation: "changed",
        engagements: [
          {
            profileId: "reviewer",
            backend: "claude",
            role: "Review & validation",
            delivers: false,
            verdictCapable: true,
          },
        ],
        workRevision: {
          id: "rev_1",
          headSha: "a".repeat(40),
          treeSha: "t".repeat(40),
          branch: "vib-1-work",
          createdAt: "2026-07-24T00:00:00.000Z",
          sourceProfileId: "dev",
        },
        github: {
          commits: [{ sha: "abc1234", msg: "[VIB-1] attach" }],
          changed: { files: 9, add: 412, del: 87 },
        },
      }),
      goal: "Exercise the evidence channel end to end.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  async function finishedRun(): Promise<string> {
    queueFakeRun({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text: "Approve — matches the goal." },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      sessionId: "sess_ev",
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "reviewer",
      role: "Review & validation",
      agentProfileId: "reviewer",
      credentialUserId: store.users.arda.id,
      backend: "claude",
      model: "sonnet",
      prompt: "review",
      workdir: store.dataRoot,
      autonomous: true,
      dataRoot: store.dataRoot,
      actor: { userId: store.users.arda.id, label: store.users.arda.email },
      threadId: "th-ev",
    });
    for (let i = 0; i < 200; i++) {
      const row = store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get(started.runId);
      if (row?.state === "finished") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return started.runId;
  }

  async function runCompletion(runId: string): Promise<void> {
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: false,
        outcomeKey: "oc_ev",
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
  }

  beforeEach(() => {
    resetSseBrokerForTests();
    installFakeRuntime();
  });
  afterEach(resetSseBrokerForTests);

  it("merges the agent's rows with the derived delivery rows onto the verdict event", async () => {
    deployReviewer([
      { capabilityId: "report-validation-verdict", mode: "direct" },
      { capabilityId: "attach-evidence-references", mode: "direct" },
    ]);
    writeReviewTask();
    stageOutcome(store.db, "oc_ev", {
      verdict: "approve",
      evidence: [{ label: "unit/policy_gate_test", add: "+14", del: "0" }],
    });
    await runCompletion(await finishedRun());

    const quality = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.type === "quality")!;
    expect(quality.evidence).toEqual([
      { label: "unit/policy_gate_test", add: "+14", del: "0" },
      { label: "9 file(s) changed on `vib-1-work`", add: "+412", del: "−87" },
      { label: "1 commit(s) delivered, revision aaaaaaa", add: "—", del: "—" },
    ]);
  });

  it("an agent WITHOUT the evidence grant contributes none of its own rows", async () => {
    deployReviewer([{ capabilityId: "report-validation-verdict", mode: "direct" }, { capabilityId: "attach-evidence-references", mode: "off" }]);
    writeReviewTask();
    stageOutcome(store.db, "oc_ev", {
      verdict: "approve",
      evidence: [{ label: "smuggled/row", add: "+1", del: "0" }],
    });
    await runCompletion(await finishedRun());

    const quality = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.type === "quality")!;
    expect(JSON.stringify(quality.evidence)).not.toContain("smuggled/row");
    // The server-derived delivery rows still land.
    expect(quality.evidence).toHaveLength(2);
  });
});
