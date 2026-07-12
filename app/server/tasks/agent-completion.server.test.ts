import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { configureRunServiceForTests, startRun } from "~/server/runtimes/run-service.server";
import { insertRunLine, upsertRun } from "~/server/runtimes/run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { buildScript } from "~/server/runtimes/simulated-runtime.server";
import {
  applyAgentCompletionEffects,
  markWaitingAgent,
} from "./task-actions.server";
import {
  assignReviewer,
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
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  const fm = file.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
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
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
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
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
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
      occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
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
    // 1500 chars of filler BEFORE the verdict line: the truncated comment
    // (1200 chars) never contains it — the old classifier missed it.
    const filler = "Detailed review notes follow. ".repeat(50);
    const reply = `${filler}\nVerdict: request changes — the diff violates the spec.`;
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
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished", simulated: false },
    );
    const fm = taskFile().parsed.frontmatter;
    expect(fm.validation).toBe("failing");
    const quality = taskFile().parsed.timeline.find((e) => e.type === "quality");
    expect(quality).toBeTruthy();
  });

  it("posts the reply comment and flips waiting agent→human when no operator is deployed", async () => {
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
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
        workdir: null,
        agentHandle: "dev",
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
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
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
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        role: "Developer",
        kind: "primary",
        workdir: null,
        agentHandle: "dev",
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
    expect(parsed.packet, "a recovery packet must open on a failed run").toBeTruthy();
    expect(parsed.packet!.type).toBe("blocked");
    // The task owner + supervisors get a quality notification about the failure.
    const notif = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications WHERE task_key = 'VIB-1' AND kind = 'quality' AND text LIKE '%run failed%'`,
      )
      .get() as { n: number };
    expect(notif.n, "watchers are notified of the run failure").toBeGreaterThan(0);
    // waiting must be flipped off `agent` (no phantom "agent working").
    expect(parsed.frontmatter.waiting).toBe("human");
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
    // With a directive the simulated reviewer report closes with an explicit
    // "Verdict: **approve**" — the completion hook must classify it and flip
    // validation to healthy without any operator/@mention involvement.
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
    const changed = await waitFor(() => {
      const fm = taskFile().parsed.frontmatter;
      return fm.validation === "healthy";
    }, 25_000);
    expect(changed).toBe(true);
    expect(result.runId).toBeTruthy();
  }, 30_000);
});
