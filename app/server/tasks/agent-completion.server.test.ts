import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync } from "node:fs";
import path from "node:path";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  configureRunServiceForTests,
  startRun,
} from "~/server/runtimes/run-service.server";
import {
  getRun,
  insertRunLine,
  upsertRun,
} from "~/server/runtimes/run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { buildScript } from "~/server/runtimes/simulated-runtime.server";
import { taskFilePath } from "~/server/files/file-store-root.server";
import {
  advanceRunCompletionPhase,
  readRunCompletionPhase,
  RUN_COMPLETION_PHASE,
} from "~/server/runtimes/run-completion-state.server";
import {
  applyAgentCompletionEffects,
  markWaitingAgent,
} from "./task-actions.server";
import {
  assignReviewer,
  captureTaskLaunchAuthorization,
  startReviewerRun,
  startSpecialistRun,
  assignSpecialist,
} from "./specialist-run.server";

/**
 * The UNIFIED agent-run completion pipeline (fixes A1/A2/A11/X6/X9 from the
 * 2026-07-11 discovery pass): every start path installs ONE handler that posts
 * the reply, reconciles delivery, records a reviewer verdict from the FULL
 * (untruncated) reply, keeps `waiting` honest, and re-invokes the operator.
 */

let ctx: TestDbContext;
let store: TestStore;

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

function deployDevSpecialist(): void {
  const file = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  const fm = file.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
      {
        profileId: "implementer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "implementer",
          role: "Developer",
          backends: ["claude"],
          model: "sonnet",
          effort: "xhigh",
        },
      } as never,
      {
        profileId: "dev",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "dev",
          role: "Reviewer",
          backends: ["claude"],
          model: "sonnet",
          effort: "xhigh",
        },
      } as never,
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function taskFile() {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!;
}

function completionAuthorization(kind: "primary" | "reviewer") {
  return captureTaskLaunchAuthorization(
    { dataRoot: store.dataRoot },
    {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind,
      profileId: kind === "primary" ? "implementer" : "dev",
    },
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deployDevSpecialist();
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Unified completion pipeline probe",
      specialist: {
        profileId: "implementer",
        backend: "claude",
        role: "Developer",
      },
      reviewers: [{ profileId: "dev", backend: "claude", role: "developer" }],
    }),
    goal: "Exercise the canonical completion handler.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  configureRunServiceForTests();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("waiting-state bookkeeping (A2)", () => {
  it("startSpecialistRun marks waiting=agent while the run is in flight", async () => {
    await assignSpecialist(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "implementer",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile().parsed.frontmatter.waiting).not.toBe("agent");
    await startSpecialistRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
  });

  it("markWaitingAgent is idempotent and reprojects", async () => {
    await markWaitingAgent(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
    );
    await markWaitingAgent(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
    );
    expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
  });
});

describe("applyAgentCompletionEffects (the shared effects)", () => {
  /** Start a real (simulated-engine) run whose final assistant text is `text`,
   *  wait for it to finish, and return its run id. `autonomous` — no default
   *  completion hook is registered by startRun itself. */
  async function finishedRunWith(text: string): Promise<string> {
    const script = buildScript({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      occurredAt: [
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
      sessionId: "t",
      backend: "claude",
      model: "sonnet",
      op: false,
      keepRunning: false,
      instant: true,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "reviewer",
      role: "Reviewer",
      backend: "claude",
      model: "sonnet",
      prompt: "review",
      workdir: store.dataRoot,
      autonomous: true,
      script,
      dataRoot: store.dataRoot,
      actor: actor(store.users.arda),
    });
    await waitFor(() => {
      const row = store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get(started.runId) as { state: string } | undefined;
      return row?.state === "finished";
    });
    return started.runId;
  }

  it("records a reviewer verdict from the FULL reply even when the verdict sits past the 1200-char comment cut (X9)", async () => {
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.stage = "review";
        parsed.frontmatter.validation = "changed";
      },
    );
    // 1500 chars of filler BEFORE the verdict line: the truncated comment
    // (1200 chars) never contains it — the old classifier missed it.
    const filler = "Detailed review notes follow. ".repeat(50);
    const reply = `${filler}\nVIBERR_REVIEW_VERDICT: {"verdict":"request_changes","summary":"The diff violates the spec."}`;
    const runId = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        role: "Reviewer",
        kind: "reviewer",
        purpose: "governance_review",
        profileId: "dev",
        workdir: null,
        agentHandle: "reviewer",
        launchAuthorization: completionAuthorization("reviewer"),
      },
      { id: runId, state: "finished", simulated: false },
    );
    const fm = taskFile().parsed.frontmatter;
    expect(fm.validation).toBe("failing");
    const quality = taskFile().parsed.timeline.find(
      (e) => e.type === "quality",
    );
    expect(quality).toBeTruthy();
    expect(taskFile().parsed.packet).toBeNull();
    expect(
      taskFile().parsed.timeline.some(
        (event) =>
          event.type === "blocked" &&
          event.actor.kind === "system" &&
          event.actor.systemId.includes("agent-launch-authorization-changed"),
      ),
    ).toBe(false);
    expect(readRunCompletionPhase(store.db, runId)).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("never treats a reviewer conversation as a governance verdict", async () => {
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.stage = "review";
        parsed.frontmatter.validation = "changed";
      },
    );
    const runId = await finishedRunWith(
      'VIBERR_REVIEW_VERDICT: {"verdict":"approve","summary":"This was only a conversational reply."}',
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        role: "Reviewer",
        kind: "reviewer",
        purpose: "conversation",
        profileId: "dev",
        workdir: null,
        reviewEvidenceFingerprint: null,
        reviewHeadSha: null,
        agentHandle: "reviewer",
        launchAuthorization: completionAuthorization("reviewer"),
      },
      { id: runId, state: "finished", simulated: false },
    );
    const fm = taskFile().parsed.frontmatter;
    expect(fm.reviewerVerdicts).toEqual([]);
    expect(fm.validation).toBe("changed");
  });

  it("never delivers from a reviewer run even if generic delivery grants are supplied", async () => {
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.stage = "review";
        parsed.frontmatter.validation = "changed";
        parsed.frontmatter.branch = null;
        parsed.frontmatter.pr = null;
      },
    );
    const runId = await finishedRunWith(
      'VIBERR_REVIEW_VERDICT: {"verdict":"approve","summary":"Repo-less evidence is correct."}',
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        role: "Reviewer",
        kind: "reviewer",
        purpose: "governance_review",
        profileId: "dev",
        workdir: store.dataRoot,
        delivery: {
          canBranch: true,
          canCommitPush: true,
          canOpenPr: true,
        },
        agentHandle: "reviewer",
        launchAuthorization: completionAuthorization("reviewer"),
      },
      { id: runId, state: "finished", simulated: false },
    );
    const fm = taskFile().parsed.frontmatter;
    expect(fm.branch).toBeNull();
    expect(fm.pr).toBeNull();
    expect(fm.validation).toBe("healthy");
  });

  it("keeps a reviewer callback after Done informational", async () => {
    const launchAuthorization = completionAuthorization("reviewer");
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.stage = "done";
        parsed.frontmatter.validation = "healthy";
      },
    );
    const runId = await finishedRunWith(
      'VIBERR_REVIEW_VERDICT: {"verdict":"request_changes","summary":"Late result."}',
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        role: "Reviewer",
        kind: "reviewer",
        purpose: "governance_review",
        profileId: "dev",
        workdir: null,
        agentHandle: "reviewer",
        launchAuthorization,
      },
      { id: runId, state: "finished", simulated: false },
    );
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.stage).toBe("done");
    expect(parsed.frontmatter.validation).toBe("healthy");
    expect(parsed.frontmatter.reviewerVerdicts).toEqual([]);
    expect(parsed.packet).toBeNull();
    expect(parsed.frontmatter.readiness).not.toBe("blocked");
    expect(
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM notifications
              WHERE task_key = 'VIB-1'
                AND kind = 'quality'
                AND title = 'Late agent result retained in run history'`,
          )
          .get() as { n: number }
      ).n,
    ).toBeGreaterThan(0);
    expect(readRunCompletionPhase(store.db, runId)).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });

  it("posts the reply comment and flips waiting agent→human when no operator is deployed", async () => {
    await markWaitingAgent(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
    );
    const runId = await finishedRunWith("All done — summary of the work.");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        role: "developer",
        kind: "primary",
        purpose: "implementation",
        profileId: "implementer",
        workdir: null,
        agentHandle: "dev",
        launchAuthorization: completionAuthorization("primary"),
      },
      { id: runId, state: "finished", simulated: false },
    );
    const parsed = taskFile().parsed;
    expect(
      parsed.timeline.some(
        (e) => e.type === "comment" && e.actor.kind === "agent",
      ),
    ).toBe(true);
    // No operator deployed in this project → the chain ends and the task must
    // NOT read "agent working" forever.
    expect(parsed.frontmatter.waiting).toBe("human");
  });

  it("surfaces a FAILED run as a typed blocked event + recovery packet, not silence (F8)", async () => {
    // A run that ends in `error` (e.g. a Codex quota exhaustion) used to leave no
    // trace on the timeline and revert waiting=human silently. Now it must post a
    // blocked event naming the reason and open a recovery packet.
    // Deploy an operator (with generate-packets) alongside the dev — every active
    // task has one, and it's what opens the recovery packet on a failed run.
    const pf = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        } as never,
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // Build the errored run SYNCHRONOUSLY (no startRun/simulated-drip) so the
    // test is deterministic — a real async run's lifecycle raced CI's slower
    // SQLite (the "database connection is not open" flood) and intermittently
    // dropped the watcher notification. Here the run row + its error log line
    // exist before applyAgentCompletionEffects reads them.
    const runId = "run_f8_probe";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-f8",
      role: "Developer",
      kind: "primary",
      backend: "codex",
      simulated: false,
      model: "gpt-5.5",
      sdk: "codex",
      state: "error",
      taskIncarnation: taskFile().parsed.frontmatter.createdAt,
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-07-12T10:00:00.000Z",
      raw: JSON.stringify({ ev: "err", tag: "turn.failed" }),
      display: {
        t: "10:00:00",
        ev: "err",
        tag: "turn.failed",
        text: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
      },
    });
    await markWaitingAgent(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        role: "Developer",
        kind: "primary",
        purpose: "implementation",
        profileId: "implementer",
        workdir: null,
        agentHandle: "dev",
        launchAuthorization: completionAuthorization("primary"),
      },
      { id: runId, state: "error", simulated: false },
    );
    const parsed = taskFile().parsed;
    // The typed failure event naming the reason (distinct from the operator's
    // packet event that also lands).
    const failureEvent = parsed.timeline.find(
      (e) => e.type === "blocked" && /did not complete/.test(e.text),
    );
    expect(failureEvent, "a typed failure event must be posted").toBeTruthy();
    expect(failureEvent!.text.toLowerCase()).toContain("quota");
    // A recovery packet reaches the human's queue (not just a timeline note):
    // it must open and mark the task blocked so it surfaces as "waiting on you".
    expect(
      parsed.packet,
      "a recovery packet must open on a failed run",
    ).toBeTruthy();
    expect(parsed.packet!.type).toBe("blocked");
    // The task owner + supervisors get a quality notification about the failure.
    const notif = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE task_key = 'VIB-1' AND kind = 'quality' AND text LIKE '%run failed%'`,
      )
      .get() as { n: number };
    expect(notif.n, "watchers are notified of the run failure").toBeGreaterThan(
      0,
    );
    // waiting must be flipped off `agent` (no phantom "agent working").
    expect(parsed.frontmatter.waiting).toBe("human");
  });

  it("keeps the verdict checkpoint replayable when its canonical write fails", async () => {
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.stage = "review";
        parsed.frontmatter.validation = "changed";
      },
    );
    const runId = await finishedRunWith(
      'VIBERR_REVIEW_VERDICT: {"verdict":"request_changes","summary":"Retry this durable verdict."}',
    );
    advanceRunCompletionPhase(
      store.db,
      runId,
      RUN_COMPLETION_PHASE.evidence,
    );
    const taskDirectory = path.dirname(
      taskFilePath(store.slug, "VIB-1", store.dataRoot),
    );
    chmodSync(taskDirectory, 0o500);
    try {
      await expect(
        applyAgentCompletionEffects(
          store.db,
          { dataRoot: store.dataRoot },
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            backend: "claude",
            role: "Reviewer",
            kind: "reviewer",
            purpose: "governance_review",
            profileId: "dev",
            workdir: null,
            agentHandle: "reviewer",
            launchAuthorization: completionAuthorization("reviewer"),
          },
          { id: runId, state: "finished", simulated: false },
        ),
      ).rejects.toBeTruthy();
      expect(readRunCompletionPhase(store.db, runId)).toBe(
        RUN_COMPLETION_PHASE.evidence,
      );
    } finally {
      chmodSync(taskDirectory, 0o700);
    }

    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        role: "Reviewer",
        kind: "reviewer",
        purpose: "governance_review",
        profileId: "dev",
        workdir: null,
        agentHandle: "reviewer",
        launchAuthorization: completionAuthorization("reviewer"),
      },
      { id: runId, state: "finished", simulated: false },
    );
    expect(readRunCompletionPhase(store.db, runId)).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
    expect(
      taskFile().parsed.timeline.some(
        (event) => event.type === "quality" && event.sourceRunId === runId,
      ),
    ).toBe(true);
  });

  it("replays a canonical request-changes verdict without treating its own Review to Work transition as stale", async () => {
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.stage = "review";
        parsed.frontmatter.validation = "changed";
      },
    );
    const launchAuthorization = completionAuthorization("reviewer");
    const runId = await finishedRunWith(
      'VIBERR_REVIEW_VERDICT: {"verdict":"request_changes","summary":"Replay the canonical rejection effects."}',
    );
    const completionInput = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude" as const,
      role: "Reviewer",
      kind: "reviewer" as const,
      purpose: "governance_review" as const,
      profileId: "dev",
      workdir: null,
      agentHandle: "reviewer",
      launchAuthorization,
    };
    let injected = false;
    await expect(
      applyAgentCompletionEffects(
        store.db,
        {
          dataRoot: store.dataRoot,
          reviewerVerdictEffectHookForTests: () => {
            if (injected) return;
            injected = true;
            throw new Error("injected post-verdict convergence crash");
          },
        },
        completionInput,
        { id: runId, state: "finished", simulated: false },
      ),
    ).rejects.toThrow(/post-verdict convergence crash/);

    expect(taskFile().parsed.frontmatter.stage).toBe("impl");
    expect(
      taskFile().parsed.timeline.some(
        (event) =>
          event.type === "quality" && event.sourceRunId === runId,
      ),
    ).toBe(true);
    expect(readRunCompletionPhase(store.db, runId)).toBe(
      RUN_COMPLETION_PHASE.evidence,
    );
    expect(
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM audit_events
              WHERE action = 'task.quality.flagged'
                AND json_extract(details_json, '$.runId') = ?`,
          )
          .get(runId) as { n: number }
      ).n,
    ).toBe(0);

    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      completionInput,
      { id: runId, state: "finished", simulated: false },
    );

    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.stage).toBe("impl");
    expect(parsed.frontmatter.validation).toBe("failing");
    expect(parsed.packet).toBeNull();
    expect(
      parsed.timeline.some(
        (event) =>
          event.type === "blocked" &&
          event.actor.kind === "system" &&
          event.actor.systemId.includes("agent-launch-authorization-changed"),
      ),
    ).toBe(false);
    expect(readRunCompletionPhase(store.db, runId)).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
    expect(
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM audit_events
              WHERE action = 'task.quality.flagged'
                AND json_extract(details_json, '$.runId') = ?`,
          )
          .get(runId) as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM notifications
              WHERE task_key = 'VIB-1'
                AND kind = 'quality'
                AND title = 'Changes requested'`,
          )
          .get() as { n: number }
      ).n,
    ).toBeGreaterThan(0);
  });

  it("does not complete while waiting=agent cleanup failed", async () => {
    const runId = await finishedRunWith("History already persisted.");
    advanceRunCompletionPhase(
      store.db,
      runId,
      RUN_COMPLETION_PHASE.verdict,
    );
    await markWaitingAgent(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
    );
    const taskDirectory = path.dirname(
      taskFilePath(store.slug, "VIB-1", store.dataRoot),
    );
    chmodSync(taskDirectory, 0o500);
    try {
      await expect(
        applyAgentCompletionEffects(
          store.db,
          { dataRoot: store.dataRoot },
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            backend: "claude",
            role: "Developer",
            kind: "primary",
            purpose: "conversation",
            profileId: "implementer",
            workdir: null,
            agentHandle: "developer",
            launchAuthorization: completionAuthorization("primary"),
          },
          { id: runId, state: "finished", simulated: false },
        ),
      ).rejects.toBeTruthy();
      expect(readRunCompletionPhase(store.db, runId)).toBe(
        RUN_COMPLETION_PHASE.verdict,
      );
      expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
    } finally {
      chmodSync(taskDirectory, 0o700);
    }

    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        role: "Developer",
        kind: "primary",
        purpose: "conversation",
        profileId: "implementer",
        workdir: null,
        agentHandle: "developer",
        launchAuthorization: completionAuthorization("primary"),
      },
      { id: runId, state: "finished", simulated: false },
    );
    expect(taskFile().parsed.frontmatter.waiting).toBe("human");
    expect(readRunCompletionPhase(store.db, runId)).toBe(
      RUN_COMPLETION_PHASE.complete,
    );
  });
});

describe("reviewer verdict on the UI Run-button path (H2/A1 regression)", () => {
  it("startReviewerRun's own hook records the verdict when the run finishes", async () => {
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Simulated reviewer output may demonstrate the structured marker, but it
    // must never become approval evidence.
    const result = await startReviewerRun(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
        directive: "@reviewer verify the change end to end",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const completed = await waitFor(() => {
      const run = getRun(store.db, result.runId);
      return run?.state === "finished";
    }, 25_000);
    expect(completed).toBe(true);
    const changed = await waitFor(() => {
      const fm = taskFile().parsed.frontmatter;
      return fm.validation === "healthy";
    }, 250);
    expect(changed).toBe(false);
    expect(taskFile().parsed.frontmatter.reviewerVerdicts).toEqual([]);
    expect(result.runId).toBeTruthy();
  }, 30_000);
});
