import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type {
  Engagement,
  TaskFileEvent,
  WorkRevision,
} from "~/schemas/task-file.schema";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { insertUser } from "~/server/auth/user-store.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { startRun } from "~/server/runtimes/run-service.server";
import { insertRunLine, upsertRun } from "~/server/runtimes/run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import {
  applyAgentCompletionEffects,
  markWaitingAgent,
} from "./task-actions.server";
import {
  assignReviewer,
  startAgentRun,
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

/** A verdict-capable specialist deployment: an EXPLICIT
 *  `report-validation-verdict: direct` grant is what makes a supporting
 *  engagement a required reviewer whose verdict is recorded + gates acceptance
 *  (F10-14: verdict authority is explicit-only now, no implicit default). Both
 *  `dev` (run as a reviewer on the UI-Run path) and the dedicated `reviewer`
 *  profile (the direct-effects path) carry it. */
const VERDICT_GRANT = [
  { capabilityId: "report-validation-verdict", mode: "direct" },
] as const;

function deployDevSpecialist(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  const fm = file.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
      {
        profileId: "dev",
        capabilities: VERDICT_GRANT,
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
      {
        profileId: "reviewer",
        capabilities: VERDICT_GRANT,
        extras: [],
        definition: {
          kind: "specialist",
          name: "reviewer",
          role: "Review & validation",
          backends: ["claude"],
          model: "sonnet",
          effort: "xhigh",
        },
      } as never,
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** The delivering developer engagement (workspace owner; never a required
 *  reviewer). */
const DEV_DELIVERS_ENGAGEMENT: Engagement = {
  profileId: "dev",
  backend: "claude",
  role: "Reviewer",
  delivers: true,
  verdictCapable: false,
};
/** The verdict-capable reviewer engagement whose profileId matches the effects'
 *  `profileId: "reviewer"` — so the resolved verdict binds + derives validation. */
const REVIEWER_ENGAGEMENT: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};
/** An immutable delivered revision under review. */
function workRev(id = "rev_1"): WorkRevision {
  return {
    id,
    headSha: "a".repeat(40),
    treeSha: "t".repeat(40),
    branch: "vib-1-work",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "dev",
  };
}

/** Write VIB-1 as a review-state task: a delivered revision under review + a
 *  verdict-capable `reviewer` engagement, so a reviewer completion's verdict
 *  binds to the current revision and gates/derives validation (F10-15). */
function writeReviewTask(
  patch: Parameters<typeof baseTaskFrontmatter>[1] = {},
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      ownerUserId: store.users.arda.id,
      title: "Unified completion pipeline probe",
      branch: "vib-1-work",
      engagements: [DEV_DELIVERS_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      workRevision: workRev(),
      validation: "changed",
      ...patch,
    }),
    goal: "Exercise the reviewer reply + verdict.",
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
  installFakeRuntime();
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
    await startAgentRun(
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
  /** Start a fake provider run whose final assistant text is `text`, wait for
   *  it to finish, and return its run id. `autonomous` — no default
   *  completion hook is registered by startRun itself. Session/thread ids are
   *  unique per call so a test can drive more than one run without colliding on
   *  the (project, task, thread) uniqueness. */
  let runSeq = 0;
  async function finishedRunWith(text: string): Promise<string> {
    runSeq += 1;
    queueFakeRun({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
      sessionId: `t-${runSeq}`,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "reviewer",
      role: "Reviewer",
      agentProfileId: "reviewer",
      backend: "claude",
      model: "sonnet",
      prompt: "review",
      workdir: store.dataRoot,
      autonomous: true,
      dataRoot: store.dataRoot,
      actor: actor(store.users.arda),
      threadId: `th-${runSeq}`,
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
    // A delivered revision under review + a verdict-capable reviewer, so the
    // reviewer's verdict binds to the current revision and derives validation.
    writeReviewTask();
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
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const fm = taskFile().parsed.frontmatter;
    expect(fm.validation).toBe("failing");
    const quality = taskFile().parsed.timeline.find((e) => e.type === "quality");
    expect(quality).toBeTruthy();
  });

  it("still detects a verbatim repeat when the report tags an AMBIGUOUS name (G-A-1)", async () => {
    // The stored comment carries `withAmbiguityDisclosure`, but the no-progress
    // check compared that stored form against the RAW reply — so any repeating
    // agent whose report tagged an ambiguous handle never tripped the guard and
    // kept buying an operator run + an agent run per cycle until the depth cap.
    // Two enabled users share the first name, which is what makes "@arda"
    // ambiguous.
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.other@viberr.test",
      name: "Arda Other",
      role: "member",
    });
    writeReviewTask();
    const reply = "@arda the diff is unchanged since my last pass.";
    const effects = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude" as const,
      profileId: "reviewer",
      role: "Reviewer",
      delivers: false,
      workdir: null,
      agentHandle: "reviewer",
    };
    const first = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      effects,
      { id: first, state: "finished" },
    );
    const noProgressLog = vi.spyOn(logger, "info");
    const second = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      effects,
      { id: second, state: "finished" },
    );
    // The branch itself is the observable: with the comparison forms out of
    // sync the repeat reads as NEW work and this never logs.
    expect(
      noProgressLog.mock.calls.some(([msg]) =>
        String(msg).includes("agent made no progress"),
      ),
    ).toBe(true);
  });

  it("records a required reviewer's verdict from the ENGAGEMENT snapshot even if its LIVE grant was removed (adversarial-review: no stuck task)", async () => {
    // The required-reviewer set (acceptanceBlockedReason) uses the engage-time
    // `verdictCapable` snapshot. If verdict RECORDING used the live grant
    // instead, a reviewer whose grant was removed/undeployed after engagement
    // could approve but never record — leaving the task un-acceptable forever
    // (no force path). Recording must use the SAME snapshot the required set
    // does, so the two never diverge.
    writeReviewTask(); // reviewer engaged with verdictCapable: true (snapshot)
    // Re-deploy `reviewer` WITHOUT the verdict grant — the live grant now says
    // OFF while the engagement snapshot still says verdict-capable.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: file.parsed.frontmatter.agents.map((a) =>
        (a as { profileId: string }).profileId === "reviewer"
          ? ({ ...(a as object), capabilities: [] } as never)
          : a,
      ),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const runId = await finishedRunWith(
      "Verdict: approve\n\n@operator the change meets the spec.",
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    // The verdict was recorded (snapshot is authoritative) → the only required
    // reviewer approved the current revision → validation derives healthy →
    // acceptance is unblocked.
    const fm = taskFile().parsed.frontmatter;
    expect(fm.verdicts).toHaveLength(1);
    expect(fm.verdicts[0]).toMatchObject({ profileId: "reviewer", result: "approve" });
    expect(fm.validation).toBe("healthy");
  });

  /**
   * R15-7 (owner ruling): a run whose profile cannot be resolved is fully
   * conservative. The RUN layer withholds its toolkit, but completion re-derived
   * the gates from `[]`, which the catalog defaults read as comment/ask/evidence
   * GRANTED — so the same ghost profile's envelope could still open a question
   * packet and assert evidence rows in a vanished profile's name, one layer
   * later and out of sight.
   */
  it("R15-7: an UNRESOLVABLE profile's finished run opens no question packet and asserts no evidence", async () => {
    const runId = await finishedRunWith(
      JSON.stringify({
        summary: "Reviewed the change; one thing is unclear.",
        question: {
          title: "Which API surface should this use?",
          body: "Two candidates.",
        },
        evidence: [{ label: "unit suite", add: 12, del: 0 }],
      }),
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        // The Codex transport: the envelope rides the final reply text.
        backend: "codex",
        // Never deployed here — `resolveDeployedSpecialist` throws for it.
        profileId: "ghost-profile",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "ghost-profile",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.packet, "a ghost profile must not open a decision").toBeNull();
    expect(
      parsed.timeline.some((e) => e.text.includes("Question for a human")),
    ).toBe(false);
    const reply = parsed.timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "agent",
    )!;
    // Its report still lands (the run happened); the ASSERTIONS it carries do not.
    expect(reply.text).toContain("one thing is unclear");
    expect(reply.evidence ?? []).toHaveLength(0);
  });

  it("posts the reviewer's OWN reply comment atomically with the verdict — pass AND fail", async () => {
    // Regression (VIB-1…4, docker): the reviewer's reply comment used to be a
    // separate earlier write that the verdict's read-modify-write erased on the
    // VirtioFS mount, so only the operator's derived verdict event survived and
    // the reviewer never "spoke" on the timeline. Now they're ONE write.
    for (const [reply, wantValidation] of [
      ["Verdict: approve\n\n@operator the inventory is complete and accurate.", "healthy"],
      ["Verdict: request changes\n\n@operator six symlinks are missing.", "failing"],
    ] as const) {
      // fresh review-state task each iteration (delivered revision + reviewer)
      writeReviewTask();
      const runId = await finishedRunWith(reply);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "VIB-1", backend: "claude", profileId: "reviewer", role: "Reviewer", delivers: false, workdir: null, agentHandle: "reviewer" },
        { id: runId, state: "finished" },
      );
      const tl = taskFile().parsed.timeline;
      const reviewerComment = tl.find(
        (e) => e.type === "comment" && e.actor.kind === "agent" && e.actor.roleHint === "Reviewer",
      );
      const quality = tl.find((e) => e.type === "quality");
      expect(reviewerComment, `reviewer reply must be posted (${wantValidation})`).toBeTruthy();
      expect(reviewerComment!.text).toContain("@operator");
      expect(quality).toBeTruthy();
      expect(taskFile().parsed.frontmatter.validation).toBe(wantValidation);
    }
  });

  it("the reviewer's reply survives a following stale-read write (VirtioFS read-after-write loss)", async () => {
    // The VIB-1 incident, end to end: the reviewer completion posts its reply
    // comment + verdict, then an operator-style read-modify-write reacts
    // seconds later while the bind mount still serves the PRE-completion file
    // content. Before the canonical cache, that second write's stale base
    // erased the reviewer's comment permanently.
    writeReviewTask({ title: "Reviewer completion then a stale-read write" });
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    const absPath = resolveTaskFilePath(ref);
    const preCompletion = readFileSync(absPath, "utf8");

    const runId = await finishedRunWith(
      "Verdict: approve\n\n@operator the inventory is verified — ship it.",
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", backend: "claude", profileId: "reviewer", role: "Reviewer", delivers: false, workdir: null, agentHandle: "reviewer" },
      { id: runId, state: "finished" },
    );

    // VirtioFS serves the PRE-completion content to the next reader: revert
    // the on-disk file (the completion's write "hasn't landed" for readers).
    writeFileSync(absPath, preCompletion);

    // The operator reacts — a locked read-modify-write appending its comment.
    const operatorComment: TaskFileEvent = {
      occurredAt: new Date().toISOString(),
      type: "comment",
      actor: { kind: "operator" },
      title: "Recommendation",
      text: "Recommendation: accept — reviewer approved.",
      toAgent: false,
      evidence: null,
    };
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(operatorComment);
    });

    const tl = taskFile().parsed.timeline;
    const reviewerComment = tl.find(
      (e) => e.type === "comment" && e.actor.kind === "agent" && e.actor.roleHint === "Reviewer",
    );
    expect(reviewerComment, "reviewer reply must survive the stale-read write").toBeTruthy();
    expect(reviewerComment!.text).toContain("@operator the inventory is verified");
    expect(tl.some((e) => e.type === "quality")).toBe(true);
    expect(tl.some((e) => e.text?.includes("Recommendation: accept"))).toBe(true);

    // And the canonical FILE was repaired by the operator's write — the
    // reviewer's comment persists on disk, not just in memory.
    const disk = readFileSync(absPath, "utf8");
    expect(disk).toContain("@operator the inventory is verified");
    expect(disk).toContain("Recommendation: accept");
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
        profileId: "developer",
        role: "developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "finished" },
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
    // Build the errored run synchronously so the
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
      agentProfileId: "developer",
      backend: "codex",
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
        profileId: "developer",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "error" },
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

describe("unavailable backend through the specialist start path", () => {
  it("startSpecialistRun on an unavailable backend errors fast → blocked event with 'unavailable' copy + recovery packet", async () => {
    // Deploy an operator with generate-packets (opens the recovery packet).
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
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const { setBackendAvailability } = await import(
      "~/server/runtimes/runtime-registry.server"
    );
    setBackendAvailability("claude", false);
    const result = await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const row = store.db
      .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
      .get(result.runId) as { state: string };
    expect(row.state).toBe("error");

    const surfaced = await waitFor(() => {
      const parsed = taskFile().parsed;
      return (
        parsed.timeline.some(
          (e) => e.type === "blocked" && /unavailable/i.test(e.text),
        ) && parsed.packet?.type === "blocked"
      );
    });
    expect(surfaced, "blocked event + recovery packet must land").toBe(true);
    const parsed = taskFile().parsed;
    const failureEvent = parsed.timeline.find(
      (e) => e.type === "blocked" && /unavailable/i.test(e.text),
    )!;
    expect(failureEvent.text).toContain("no usable credential");
    expect(failureEvent.text).toContain("Configure a credential");
    expect(parsed.frontmatter.waiting).toBe("human");
  });
});

describe("reviewer verdict on the UI Run-button path (H2/A1 regression)", () => {
  it("startReviewerRun's own hook records the verdict when the run finishes", async () => {
    // A delivered revision under review, but NO pre-set reviewer engagement:
    // assignReviewer below makes `dev` the SOLE required reviewer (it carries an
    // explicit verdict grant), so its approve derives validation → healthy.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Unified completion pipeline probe",
        branch: "vib-1-work",
        workRevision: workRev(),
      }),
      goal: "Exercise the canonical completion handler.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    queueFakeRun({
      lines: [
        {
          t: "",
          ev: "text",
          tag: "assistant",
          text: "Review complete. Verdict: **approve**.",
        },
      ],
    });
    const result = await startAgentRun(
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

describe("superseded stuck-packet withdrawal (owner ruling 2026-07-18)", () => {
  /** A finished fake run whose final assistant text is `text` (local copy
   *  of the shared-effects describe's helper — that one is block-scoped).
   *  Session ids are unique so two runs in ONE test don't collide on the
   *  (project, task, thread) uniqueness. */
  let runSeq = 0;
  async function finishedRunWith(text: string): Promise<string> {
    runSeq += 1;
    queueFakeRun({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
      sessionId: `t-${runSeq}`,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "reviewer",
      role: "Reviewer",
      agentProfileId: "reviewer",
      backend: "claude",
      model: "sonnet",
      prompt: "review",
      workdir: store.dataRoot,
      autonomous: true,
      dataRoot: store.dataRoot,
      actor: actor(store.users.arda),
      // Distinct thread per helper call — two runs in one test otherwise
      // collide on the (project, task, thread) uniqueness.
      threadId: `th-${runSeq}`,
    });
    await waitFor(() => {
      const row = store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get(started.runId) as { state: string } | undefined;
      return row?.state === "finished";
    });
    return started.runId;
  }

  /** Write a `type: "blocked"` work-stalled packet straight into the task file
   *  (the schema shape operatorOpenPacket produces). */
  async function openBlockedPacket(
    options: Array<Record<string, unknown>>,
  ): Promise<void> {
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.packet = {
          type: "blocked",
          kind: "Blocked decision",
          from: "operator",
          title: "Work stalled — pick a recovery path",
          body: "The run failed. Coordination is paused until a human chooses how to proceed.",
          observations: [],
          options,
        } as never;
        parsed.frontmatter.readiness = "blocked";
      },
    );
  }

  const redirect = { kind: "redirect", t: "Redirect with sharper guidance", d: "", rec: false };
  // Deliberately UNSTAMPED — the operator's open_decision_packet option shape
  // has no profileId field, so a primary-subject retry never names one. Adding
  // a profileId here silently drops the unstamped case out of coverage.
  const retryPrimary = {
    kind: "retry_other_backend",
    t: "Retry on Claude Code",
    d: "",
    rec: true,
    backend: "claude",
  };
  const retryReviewer = { ...retryPrimary, profileId: "style" };

  async function runEffects(
    runId: string,
    engagement: { delivers: boolean; profileId?: string },
    state = "finished",
  ): Promise<void> {
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: engagement.profileId ?? "developer",
        role: "developer",
        delivers: engagement.delivers,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state },
    );
  }

  it("a successful PRIMARY run withdraws a primary-subject packet, lifts readiness, and audits", async () => {
    await openBlockedPacket([retryPrimary, redirect]);
    const runId = await finishedRunWith("Recovered — the work is delivered.");
    await runEffects(runId, { delivers: true });
    const parsed = taskFile().parsed;
    expect(parsed.packet).toBeNull();
    expect(parsed.frontmatter.readiness).toBe("ready");
    const note = parsed.timeline.find((e) =>
      (e.text ?? "").includes("**Packet withdrawn:**"),
    );
    expect(note).toBeTruthy();
    expect(note!.text).toContain("Work stalled — pick a recovery path");
    const { listAuditEvents } = await import("../../../test-support/audit-log");
    expect(
      listAuditEvents(store.db).some(
        (e) => e.action === "task.packet.withdrawn_superseded",
      ),
    ).toBe(true);
  });

  it("a FAILED run does not withdraw — the packet stays for the human", async () => {
    await openBlockedPacket([retryPrimary, redirect]);
    const runId = await finishedRunWith("It broke again.");
    await runEffects(runId, { delivers: true }, "error");
    expect(taskFile().parsed.packet).not.toBeNull();
  });

  it("an accept_completion packet is never auto-withdrawn (completion stays human)", async () => {
    await openBlockedPacket([
      { kind: "accept_completion", t: "Accept & move to Done", d: "", rec: true },
      redirect,
    ]);
    const runId = await finishedRunWith("More work landed.");
    await runEffects(runId, { delivers: true });
    expect(taskFile().parsed.packet).not.toBeNull();
  });

  it("a reviewer-subject packet ignores a primary success but withdraws when THAT reviewer profile succeeds", async () => {
    await openBlockedPacket([retryReviewer, redirect]);
    // Primary success — different subject, packet must stay.
    const primaryRun = await finishedRunWith("Primary delivered.");
    await runEffects(primaryRun, { delivers: true });
    expect(taskFile().parsed.packet).not.toBeNull();
    // The named reviewer profile succeeds — withdrawn (profileId is the join
    // key against the retry option's stamped profileId, never the role).
    const reviewerRun = await finishedRunWith("Review passed cleanly.");
    store.db
      .prepare(`UPDATE agent_runs SET agent_profile_id = ? WHERE id = ?`)
      .run("style", reviewerRun);
    await runEffects(reviewerRun, { delivers: false, profileId: "style" });
    expect(taskFile().parsed.packet).toBeNull();
  });

  it("an unstamped retry option is primary-subject — a reviewer success leaves it, the delivering run withdraws it", async () => {
    await openBlockedPacket([retryPrimary, redirect]);
    // No profileId on the option → the subject is the delivering specialist, so
    // a non-delivering reviewer's success must NOT withdraw it.
    const reviewerRun = await finishedRunWith("Read through the diff.");
    await runEffects(reviewerRun, { delivers: false, profileId: "style" });
    expect(taskFile().parsed.packet).not.toBeNull();
    // The delivering specialist then succeeds — that falsifies "work stalled".
    const primaryRun = await finishedRunWith("Primary delivered.");
    await runEffects(primaryRun, { delivers: true });
    expect(taskFile().parsed.packet).toBeNull();
  });

  it("an agent-agnostic packet (no retry option) withdraws on any successful run", async () => {
    await openBlockedPacket([redirect]);
    const runId = await finishedRunWith("Unblocked and finished.");
    await runEffects(runId, { delivers: true });
    expect(taskFile().parsed.packet).toBeNull();
  });
});
