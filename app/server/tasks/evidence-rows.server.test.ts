import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { pollUntil } from "../../../test-support/polling";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import { reconfigureProject } from "../../../test-support/projected-store";
import { normalizeEvidenceRows } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { startRun } from "~/server/runtimes/run-service.server";
import {
  applyAgentCompletionEffects,
  deliveredWorkEvidence,
  recordAgentCompletion,
} from "./agent-completion.server";
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
        { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
        { label: "  ", result: "1 failed", status: "fail" },
      ]),
    ).toEqual([{ label: "unit/policy_gate_test", result: "6 passed", status: "pass" }]);
    expect(normalizeEvidenceRows([])).toBeNull();
    expect(normalizeEvidenceRows(null)).toBeNull();
  });

  /**
   * Ruling 526: the checklist marks a row by its status, so a row always has
   * one. The schema asks every agent for it; a row that still arrives without
   * one, or with a word the schema does not know, is a reference, never a
   * pass. CANARY: default the status to "pass" and a check nobody ran reads
   * as passed on the verdict.
   */
  it("reads a missing or unknown status as a reference, and an absent result as none", () => {
    expect(
      normalizeEvidenceRows([
        { label: "npm test", result: "102 passed, 0 failed" },
        { label: "README.md:23", status: "blocking" },
        { label: "the rulings", result: null, status: "info" },
      ]),
    ).toEqual([
      { label: "npm test", result: "102 passed, 0 failed", status: "info" },
      { label: "README.md:23", result: "", status: "info" },
      { label: "the rulings", result: "", status: "info" },
    ]);
  });

  it("flattens newlines so a row can never forge a second row or a section", () => {
    const rows = normalizeEvidenceRows([
      { label: "a\n- forged · +1 · -1\n## Goal", result: "1 passed", status: "pass" },
    ])!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).not.toContain("\n");
  });

  it("strips the ` · ` separator from the result so the split cannot shift", () => {
    const rows = normalizeEvidenceRows([
      { label: "suite · integration", result: "1 passed · 2 failed", status: "fail" },
    ])!;
    // A separator in the LABEL is safe (the parser pops the last segment) and
    // is preserved; in the result it would move the split, so it goes.
    expect(rows[0]!.label).toBe("suite · integration");
    expect(rows[0]!.result).not.toContain(" · ");
  });

  /**
   * Ruling 639: a failure's result says why in a sentence, and the file is the
   * only copy. At 40 characters the row kept "The proposed pay-as-you-go
   * default list…" and no surface could show the rest. CANARY: put the result
   * cap back to 40 and the sentence is cut.
   */
  it("keeps a result's sentence whole, and cuts only past 200 characters", () => {
    const why =
      "The proposed pay-as-you-go default lists the old tier price and leaves the flat-rate plan out of the totals, so Q35 has no cost.";
    const [row] = normalizeEvidenceRows([{ label: "questions.md Q35", result: why, status: "fail" }])!;
    expect(row!.result).toBe(why);
    const [long] = normalizeEvidenceRows([{ label: "a", result: "x".repeat(260), status: "info" }])!;
    expect(long!.result).toBe(`${"x".repeat(199)}…`);
  });

  it("caps the row count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      label: `suite-${i}`,
      result: "1 passed",
      status: "pass",
    }));
    expect(normalizeEvidenceRows(many)!.length).toBe(8); // ruling 493: eight rows
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
      { label: "9 files changed on `vib-1-attach`", result: "+412 −87", status: "info" },
      { label: "2 commits delivered", result: "", status: "info" },
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
      delivers: false,
      replyText: "Approve — the change matches the goal.",
      verdict: "approve",
      question: null,
      evidence: [
        { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
        { label: "integration/pr_sync_test", result: "11 passed", status: "pass" },
      ],
    });

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const verdictEvent = file.parsed.timeline.find((e) => e.type === "quality")!;
    expect(verdictEvent.evidence).toEqual([
      { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
      { label: "integration/pr_sync_test", result: "11 passed", status: "pass" },
    ]);
    // Exactly ONE event carries the outcome's evidence.
    const replyEvent = file.parsed.timeline.find((e) => e.type === "comment")!;
    expect(replyEvent.evidence).toBeNull();

    // …and it survives the projection into `task_events.evidence_json`.
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    const projected = detail.timeline.find((e) => e.type === "quality")!;
    expect(projected.evidence).toHaveLength(2);
    expect(projected.evidence![0]!.label).toBe("unit/policy_gate_test");
    // Ruling 526: and the timeline reads the verdict back from the note: its
    // title and revision say the note's whole sentence, so nothing is left.
    expect(projected.verdict).toEqual({ result: "approve", sha: "aaaaaaa", detail: null });
  });

  it("falls back to the agent's REPORT when there is no verdict to hang it on", async () => {
    seed();
    await recordAgentCompletion(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", {
      actorRef: { ...reviewer, profileId: "dev", roleHint: "developer" },
      runId: "run_2",
      delivers: true,
      replyText: "Implemented the attach flow.",
      verdict: null,
      question: null,
      evidence: [{ label: "9 files changed on `vib-1-attach`", result: "+412 −87", status: "info" }],
    });
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const reply = file.parsed.timeline.find((e) => e.type === "comment")!;
    expect(reply.evidence).toHaveLength(1);
    expect(reply.evidence![0]!.result).toBe("+412 −87");
  });

  it("records no evidence when none was produced", async () => {
    seed();
    await recordAgentCompletion(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", {
      actorRef: reviewer,
      runId: "run_3",
      delivers: false,
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
    // A `human` grant withholds the channel; only an explicit `direct` arms it.
    expect(
      resolveAgentCollab([{ capabilityId: "attach-evidence-references", mode: "human" }]).evidence,
    ).toBe(false);
  });
});

describe("end-to-end: a staged report_outcome envelope lands its evidence", () => {
  /** Deploy a reviewer holding BOTH the verdict and the evidence grants. */
  function deployReviewer(
    capabilities: { capabilityId: string; mode: "direct" | "human" | "off" }[],
  ): void {
    reconfigureProject(store, {
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
    await pollUntil(
      () =>
        store.db.prepare(`SELECT state FROM agent_runs WHERE id = ?`).get(started.runId)?.state ===
        "finished",
      5_000,
    );
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
    installFakeRuntime();
  });

  it("merges the agent's rows with the derived delivery rows onto the verdict event", async () => {
    deployReviewer([
      { capabilityId: "report-validation-verdict", mode: "direct" },
      { capabilityId: "attach-evidence-references", mode: "direct" },
    ]);
    writeReviewTask();
    stageOutcome(store.db, "oc_ev", {
      verdict: "approve",
      evidence: [{ label: "unit/policy_gate_test", result: "6 passed", status: "pass" }],
    });
    await runCompletion(await finishedRun());

    const quality = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.type === "quality")!;
    expect(quality.evidence).toEqual([
      { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
      { label: "9 files changed on `vib-1-work`", result: "+412 −87", status: "info" },
      { label: "1 commit delivered, revision aaaaaaa", result: "", status: "info" },
    ]);
  });

  it("an agent WITHOUT the evidence grant contributes none of its own rows", async () => {
    deployReviewer([{ capabilityId: "report-validation-verdict", mode: "direct" }, { capabilityId: "attach-evidence-references", mode: "off" }]);
    writeReviewTask();
    stageOutcome(store.db, "oc_ev", {
      verdict: "approve",
      evidence: [{ label: "smuggled/row", result: "1 passed", status: "pass" }],
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
