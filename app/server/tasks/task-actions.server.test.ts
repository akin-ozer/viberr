import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { COMPACTION_TITLE } from "./timeline-compaction.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { deriveValidation } from "~/schemas/task-file.schema";
import type {
  Engagement,
  FileActorRef,
  TaskFileEvent,
  TaskFrontmatter,
  WorkRevision,
} from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { insertUser } from "~/server/auth/user-store.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import {
  attachmentProducers,
  getTaskDetail,
} from "~/server/projections/task-query.server";
import { setPref } from "~/server/prefs/user-prefs.server";
import { NOTIFS_PREF_KEY } from "~/features/profile/profile-query.server";
import {
  appendComment,
  classifyReviewerVerdict,
  createTask,
  DEFAULT_GOAL,
  notifyTaskWatchers,
  operatorPromptAgent,
  packetIdentity,
  postAgentReplyComment,
  recordAgentCompletion,
  releaseOwner,
  setOwner,
  clearWaitingToHuman,
  performDelivery,
  revisionDriftNote,
  specialistReplyDirective,
  transitionStage,
  acceptanceDisclosureOf,
  applyRecommendation,
  forceAcceptCompletion,
  reorderTask,
  resolvePacket,
} from "./task-actions.server";
import type { TaskActionDeps } from "./task-actions.server";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";
import type { TaskPacket } from "~/schemas/task-file.schema";

/**
 * `performDelivery`'s push is stubbed through its ctx `deps` seam — typed
 * against the real export, and inert for every test that doesn't hand the
 * seam over — so the push-failure branches run without git or a remote.
 *
 * F19-21 additionally needs GitHub to answer with the default-branch head (the
 * base the no-change revision anchors to): those tests seed a real credential
 * and run the REAL `getProjectGithubContext` over the canned transport
 * (`okGithub` below). With nothing seeded the context degrades to
 * `no_pat_configured`, so every other test behaves exactly as it always did.
 */
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import {
  fakeGithubFetch,
  type FakeGithub,
} from "../../../test-support/fake-github";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import type { TaskActionContext } from "./task-actions.server";

const pushMock = vi.fn<typeof pushWorkspaceBranch>();
let github: FakeGithub | null = null;

/** The delivery/acceptance ctx for this file: the push double rides the `deps`
 *  seam, and the canned transport rides along once a test installed one. */
function deliveryCtx(store: TestStore): TaskActionContext {
  const callCtx: TaskActionContext = {
    dataRoot: store.dataRoot,
    deps: { pushWorkspaceBranch: pushMock },
  };
  if (github) callCtx.fetchImpl = github.fetchImpl;
  return callCtx;
}

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

/**
 * sqlite hands its rows back as untyped cells, so every read below names the
 * columns it expects: a drifted SELECT fails on the decode instead of reading
 * `undefined` through a cast.
 */
function selectRows<T>(
  db: TestStore["db"],
  sql: string,
  row: z.ZodType<T>,
): T[] {
  return z.array(row).parse(db.prepare(sql).all());
}

/** `SELECT count(*) … c` — an aggregate with no GROUP BY, so exactly one row
 *  carrying the single integer column `c`. */
function countRow(db: TestStore["db"], sql: string): { c: number } {
  return z.object({ c: z.number() }).parse(db.prepare(sql).get());
}

describe("packetIdentity (F10-09 — replacement detection)", () => {
  const base: TaskPacket = {
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "Pick one",
    body: "",
    observations: [],
    options: [{ kind: "custom", t: "A", d: "", rec: true }],
  };

  it("an explicit id is authoritative — two ids differ, same id matches regardless of content", () => {
    expect(packetIdentity({ ...base, id: "pkt_1" })).not.toBe(
      packetIdentity({ ...base, id: "pkt_2" }),
    );
    expect(packetIdentity({ ...base, id: "pkt_1", title: "x" })).toBe(
      packetIdentity({ ...base, id: "pkt_1", title: "y" }),
    );
  });

  it("without an id, the content fingerprint separates different packets", () => {
    // Same content → same identity (resolving the same choice is harmless).
    expect(packetIdentity(base)).toBe(packetIdentity({ ...base }));
    // A REPLACEMENT with different options → different identity → the stale
    // resolution is rejected under the lock.
    expect(packetIdentity(base)).not.toBe(
      packetIdentity({
        ...base,
        options: [{ kind: "accept_completion", t: "Accept", d: "", rec: true }],
      }),
    );
    // A packet that gained an id is no longer the same identity as the id-less one.
    expect(packetIdentity(base)).not.toBe(packetIdentity({ ...base, id: "pkt_9" }));
  });
});

function prepared(): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

/** The reviewer agent's own ref (generic-agents D8): the quality event is now
 *  attributed to the agent that judged, not the operator. */
const REVIEWER_REF: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "reviewer",
  roleHint: "Review & validation",
};

/** A SECOND verdict-capable reviewer with a distinct profileId. Needed to prove
 *  one reviewer's approve cannot overwrite another's request_changes — verdicts
 *  key on (profileId, revisionId), so two distinct profiles never collide. */
const QA_REVIEWER_REF: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "qa-reviewer",
  roleHint: "QA review",
};

/** The delivering developer engagement (workspace/branch owner) — a deliverer
 *  is never a required reviewer regardless of its verdict flag. */
const DEV_ENGAGEMENT: Engagement = {
  profileId: "developer",
  backend: "claude",
  role: "developer",
  delivers: true,
  verdictCapable: false,
};
/** A verdict-capable reviewer engagement whose profileId matches REVIEWER_REF,
 *  so recordReviewerReply's verdict binds AND gates acceptance (F10-15). */
const REVIEWER_ENGAGEMENT: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};
/** A second verdict-capable reviewer engagement (pairs with QA_REVIEWER_REF). */
const QA_REVIEWER_ENGAGEMENT: Engagement = {
  profileId: "qa-reviewer",
  backend: "claude",
  role: "QA review",
  delivers: false,
  verdictCapable: true,
};

/** An immutable work revision under review. A new `id` + different `treeSha`
 *  models developer rework, which makes every prior verdict stale (F10-32). */
function workRev(id = "rev_1", treeSha = "t".repeat(40)): WorkRevision {
  return {
    id,
    headSha: "a".repeat(40),
    treeSha,
    branch: "vib-1-work",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "developer",
  };
}

/** Deliver a NEW work revision onto VIB-1 (developer rework): swap the
 *  workRevision, recompute the derived validation (verdicts on the OLD revision
 *  are now stale), reproject — the file-level equivalent of a delivering run
 *  minting a new head. */
function deliverRevision(store: TestStore, revision: WorkRevision): void {
  const parsed = readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!.parsed;
  const frontmatter = { ...parsed.frontmatter, workRevision: revision };
  frontmatter.validation = deriveValidation(frontmatter);
  writeTask(store.dataRoot, store.slug, {
    frontmatter,
    goal: parsed.goal,
    packet: parsed.packet,
    timeline: parsed.timeline,
    unknownFrontmatter: parsed.unknownFrontmatter,
    extraSections: parsed.extraSections,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

/** recordReviewerVerdict's replacement: the verdict is RESOLVED BY THE CALLER
 *  now — classifyReviewerVerdict over the same reply preserves each test's
 *  intent — and the reply comment always posts atomically with it. Run ids are
 *  unique per call (no agent_runs row needed). `ref` names WHICH reviewer
 *  judged (defaults to the primary reviewer; a multi-reviewer scenario passes a
 *  distinct one so the verdicts don't collide). */
let reviewerRunSeq = 0;
async function recordReviewerReply(
  store: TestStore,
  replyText: string,
  ref: FileActorRef = REVIEWER_REF,
): Promise<void> {
  await recordAgentCompletion(
    store.db,
    { dataRoot: store.dataRoot },
    store.slug,
    "VIB-1",
    {
      actorRef: ref,
      runId: `run_rv${++reviewerRunSeq}`,
      replyText,
      verdict: classifyReviewerVerdict(replyText),
      question: null,
    },
  );
}

describe("createTask", () => {
  it("writes task.md with the mock create defaults and projects it", async () => {
    const store = prepared();
    const result = await createTask(
      store.db,
      { projectSlug: store.slug, title: "A brand new task" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(result.key).toBe("VIB-100"); // per-project counter
    expect(result.stageName).toBe("Triage");
    expect(result.task.stage).toBe("triage");
    expect(result.task.readiness).toBe("input_required");
    expect(result.task.waiting).toBe("human");
    expect(result.task.validation).toBe("none");
    expect(result.task.urgent).toBe(false);
    expect(result.task.operator).toBeNull(); // no operator in triage
    expect(result.task.goal).toBe(DEFAULT_GOAL);
    expect(result.task.filePath).toBe(
      "projects/viberr-core/tasks/VIB-100/task.md",
    );

    // The file is canonical truth — verify it exists and parses clean.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-100",
      dataRoot: store.dataRoot,
    });
    expect(file?.diagnostics).toEqual([]);
    expect(file?.parsed.frontmatter.title).toBe("A brand new task");

    const audit = listAuditEvents(store.db, { action: "task.created" });
    expect(audit[0]?.taskKey).toBe("VIB-100");
  });

  // R19-14: every task passes the triage quality gate — creation lands at the
  // entry stage ONLY. The pre-ruling behavior (create mid-stage, operator
  // assigned at birth) is exactly what the ruling forbids.
  it("refuses a non-entry stage and names the entry stage (R19-14)", async () => {
    const store = prepared();
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Straight to ready", stageId: "ready" },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 400,
      message:
        "New tasks start at Triage, the triage gate where a goal is " +
        "refined. Move the task through the workflow after it is created.",
    });
  });

  it("accepts an explicit entry stageId, with no operator at birth (R19-14)", async () => {
    const store = prepared();
    const result = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Explicit triage", stageId: "triage" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(result.task.stage).toBe("triage");
    expect(result.task.operator).toBeNull();
  });

  it("allocates unique keys under concurrency and persists the counter", async () => {
    const store = prepared();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createTask(
          store.db,
          { projectSlug: store.slug, title: `Concurrent task ${i}` },
          actor(store.users.arda),
          { dataRoot: store.dataRoot },
        ),
      ),
    );
    const keys = results.map((r) => r.key);
    expect(new Set(keys).size).toBe(8);
    expect(keys.sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `VIB-${100 + i}`).sort(),
    );
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    });
    expect(project?.parsed.frontmatter.nextTaskNumber).toBe(108);
  });

  it("falls back to a directory max-scan when the counter is stale", async () => {
    const store = prepared();
    // A task numbered ABOVE the stored counter (external tool created it).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-250"),
    });
    const result = await createTask(
      store.db,
      { projectSlug: store.slug, title: "After external task" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.key).toBe("VIB-251");
  });

  it("rejects viewers, non-members, bad stages and short titles", async () => {
    const store = prepared();
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Viewer attempt" },
        actor(store.users.elif), // project viewer
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Guest attempt" },
        actor(store.users.deniz), // not a member
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // R19-14: "done" and a stage that does not exist are both refused the same
    // way now — they are not the entry stage.
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Done create", stageId: "done" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("New tasks start at Triage"),
    });
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Ghost stage", stageId: "nope" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("New tasks start at Triage"),
    });
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "ab" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("appendComment", () => {
  function withTask(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("appends a comment event (newest first) and reprojects", async () => {
    const store = prepared();
    withTask(store);
    const result = await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "First comment" },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(result.toAgent).toBe(false);
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "comment",
      text: "First comment",
      toAgent: false,
    });
    expect(detail?.commentCount).toBe(1);
  });

  it("routes @operator mentions to the agent side (toagent tint)", async () => {
    const store = prepared();
    withTask(store);
    const result = await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@operator widen the PAT scope please" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.toAgent).toBe(true);
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.toAgent).toBe(true);
  });

  it("guests (registered non-members) may comment — app-wide commenting", async () => {
    const store = prepared();
    withTask(store);
    await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "Following from the platform team." },
      actor(store.users.deniz),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.actor).toMatchObject({ guest: true });
  });

  it("fans out mention notifications by email local-part / first name — never to self", async () => {
    const store = prepared();
    withTask(store);
    const handle = store.users.selin.email.split("@")[0];
    const result = await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: `@${handle} can you take the acceptance gate? @operator fyi` },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.mentionedUserIds).toEqual([store.users.selin.id]);
    const rows = selectRows(
      store.db,
      `SELECT user_id, kind, task_key, read_at FROM notifications`,
      z.object({
        user_id: z.string(),
        kind: z.string(),
        task_key: z.string(),
        read_at: z.string().nullable(),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: store.users.selin.id,
      kind: "mention",
      task_key: "VIB-1",
      read_at: null,
    });
  });

  /**
   * B-FD2 (H3): the ladder drops a handle that matches several people, so the
   * comment reached nobody. The author is the only one who can retag and is
   * still on the page, so the non-delivery lands beside their comment instead
   * of being visible only in the fan-out's return value.
   */
  it("a HUMAN comment whose @handle matches two people carries the non-delivery note", async () => {
    const store = prepared();
    withTask(store);
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
    const firstName = store.users.arda.name.split(" ")[0]!.toLowerCase();
    const result = await appendComment(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: `@${firstName} can you take the acceptance gate?`,
      },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(result.mentionedUserIds).toEqual([]);
    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    const note = timeline.find((e) => e.type === "note");
    expect(note, "the dropped mention must be visible").toBeTruthy();
    expect(note!.text).toContain(`@${firstName}`);
    expect(note!.text).toContain("nobody was notified");
    expect(note!.actor).toMatchObject({ kind: "system", systemId: "policy-engine" });
    // The comment itself is still recorded, unmodified.
    expect(
      timeline.find((e) => e.type === "comment")!.text,
    ).toBe(`@${firstName} can you take the acceptance gate?`);
    expect(
      countRow(store.db, `SELECT COUNT(*) c FROM notifications`),
    ).toMatchObject({ c: 0 });
  });

  // NEW-4: an AGENT reply that tags a human must fan out the same `mention`
  // notification a human comment would — otherwise the tag the agents are now
  // instructed to write pings no one. The `from` chip is the agent, not a human.
  it("an agent reply that @tags a human notifies them, attributed to the agent", async () => {
    const store = prepared();
    withTask(store);
    await postAgentReplyComment(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      runId: "run_test",
      actorRef: REVIEWER_REF,
      replyText: `@${store.users.arda.name.split(" ")[0]} the review is clean — over to you for acceptance.`,
    });

    const rows = selectRows(
      store.db,
      `SELECT user_id, kind, actor_json FROM notifications`,
      z.object({
        user_id: z.string(),
        kind: z.string(),
        actor_json: z.string().nullable(),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(store.users.arda.id);
    expect(rows[0]!.kind).toBe("mention");
    // Attributed to the reviewer agent (kind agent + backend), NOT a human.
    expect(JSON.parse(rows[0]!.actor_json!)).toMatchObject({ kind: "agent", backend: "claude" });
  });

  // G7/B-FD9: the compression-threshold guardrail must fire on a pure
  // agent-reply flood — the case it exists for. It ran only on operator/human
  // comment writes, so a run of agent replies accreted with no compaction.
  it("an agent-reply flood triggers compaction when compression-threshold is on", async () => {
    const store = prepared();
    // Turn the guardrail ON at a low threshold.
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      guardrails: [
        { id: "compression-threshold", desc: "compress long timelines", on: true, value: 10, unit: "events" },
      ],
    });
    // Seed a flood of routine AGENT comments — no operator or human write.
    const flood: TaskFileEvent[] = Array.from({ length: 15 }, (_, i) => ({
      occurredAt: `2026-08-04T00:${String(i).padStart(2, "0")}:00.000Z`,
      type: "comment",
      actor: { kind: "agent", backend: "claude", profileId: "developer", roleHint: "Implementation" },
      title: null,
      text: `Progress note ${i}: still working through the implementation details here.`,
      toAgent: false,
      evidence: null,
    }));
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: flood,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // One more agent reply — the ONLY compaction trigger for an agent flood.
    await postAgentReplyComment(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      runId: "run_flood",
      actorRef: REVIEWER_REF,
      replyText: "Implementation reviewed end to end; the flow is correct and the tests pass.",
    });

    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    // The older routine comments folded into a compaction marker.
    expect(timeline.some((e) => e.title === COMPACTION_TITLE)).toBe(true);
    expect(timeline.length).toBeLessThan(flood.length + 1);
  });

  /**
   * G7's other half: compaction is ONE pass that every comment writer runs, at
   * the CONFIGURED threshold. The agent-reply site is pinned above; this pins
   * the human site, where two things have to hold at once — the human's write
   * triggers the fold, and the human's own prose is never what gets folded
   * (B-FD9: compaction rewrites canonical task.md, so folding a person's words
   * deletes them from the source of truth to save noise they did not make).
   */
  function withCompactionGuardrail(store: TestStore, value: number): void {
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      guardrails: [
        { id: "compression-threshold", desc: "compress long timelines", on: true, value, unit: "events" },
      ],
    });
  }

  /** Routine OPERATOR comments — foldable narration, no human prose. Written
   *  newest-first with real (in-range) timestamps, the way the file store
   *  stores them: a minute field above 59 is an invalid instant the parser
   *  drops on read, which would quietly shrink the fixture. */
  function operatorFlood(count = 15): TaskFileEvent[] {
    return Array.from({ length: count }, (_, i) => {
      const minute = count - 1 - i; // index 0 is the newest event
      const hh = String(Math.floor(minute / 60)).padStart(2, "0");
      const mm = String(minute % 60).padStart(2, "0");
      return {
        occurredAt: `2026-08-04T${hh}:${mm}:00.000Z`,
        type: "comment",
        actor: { kind: "operator" },
        title: null,
        text: `Operator narration ${i}: coordination continues on the implementation.`,
        toAgent: false,
        evidence: null,
      };
    });
  }

  it("a HUMAN comment runs the same compaction pass at the configured threshold, and its own prose survives", async () => {
    const store = prepared();
    withCompactionGuardrail(store, 10);
    const flood = operatorFlood();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: flood,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await appendComment(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: "Checked the staging deploy myself — the migration ran clean.",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    expect(timeline.some((e) => e.title === COMPACTION_TITLE)).toBe(true);
    // 15 events + this comment, folded well below the configured threshold of
    // 10 — proof the guardrail's VALUE drives the pass (it used to be a
    // hardcoded 60, which this timeline never reaches).
    expect(timeline.length).toBeLessThan(flood.length + 1);
    expect(
      timeline.find((e) => e.actor.kind === "human")?.text,
      "the commenter's own prose is never compacted away",
    ).toBe("Checked the staging deploy myself — the migration ran clean.");
  });

  it("with the compression-threshold guardrail OFF, a human comment compacts nothing", async () => {
    const store = prepared();
    // Long enough that the built-in DEFAULT_COMPACTION (60) would fold it —
    // so "nothing happened" means the guardrail gate held, not that the
    // timeline was too short to notice.
    const flood = operatorFlood(65);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: flood,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "Still watching this one." },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    expect(timeline.some((e) => e.title === COMPACTION_TITLE)).toBe(false);
    expect(timeline).toHaveLength(flood.length + 1);
  });

  // S5-G3: same reply, ambiguous handle. The agent was told to tag the person
  // it answers; when that tag routes to nobody the reply itself has to say so,
  // because the agent cannot retag and nothing else reports it.
  it("an agent reply whose @tag is ambiguous discloses the non-delivery in the reply", async () => {
    const store = prepared();
    withTask(store);
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
    const firstName = store.users.arda.name.split(" ")[0]!.toLowerCase();
    await postAgentReplyComment(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      runId: "run_test_ambiguous",
      actorRef: REVIEWER_REF,
      replyText: `@${firstName} the review is clean — over to you for acceptance.`,
    });
    const reply = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.actor.kind === "agent")!;
    expect(reply.text).toContain("the review is clean");
    expect(reply.text).toContain("nobody was notified");
    expect(
      countRow(store.db, `SELECT COUNT(*) c FROM notifications`),
    ).toMatchObject({ c: 0 });
  });

  /**
   * G1's rule on the agent-reply writer: a comment a guardrail DROPPED must
   * never be recorded as a comment that happened, and the drop must leave a
   * reason behind. Both halves matter for different readers — the timeline must
   * not gain chatter, and the audit row is what the boot recovery reads to know
   * this run's reply was already processed (a drop with no row is re-processed
   * on every restart, forever).
   */
  it("an agent reply dropped by the meaningful-comment guardrail records WHY, and posts nothing", async () => {
    const store = prepared();
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      guardrails: [
        { id: "meaningful-comment", desc: "drop trivial chatter", on: true },
      ],
    });
    withTask(store);

    await postAgentReplyComment(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      runId: "run_chatter",
      actorRef: REVIEWER_REF,
      replyText: "ok",
    });

    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    expect(timeline.some((e) => e.type === "comment")).toBe(false);
    const audit = listAuditEvents(store.db, { action: "task.agent.replied" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({
      runId: "run_chatter",
      droppedByGuardrail: "meaningful-comment",
    });
  });
});

describe("operatorPromptAgent directive fan-out (P14-GV-06)", () => {
  it("notifies a human @tagged inside the operator's directive comment", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const firstName = store.users.arda.name.split(" ")[0];
    // The run itself can't start here (no deployed profile) — the directive
    // COMMENT is written first, and that comment was the one writer in the app
    // that never fanned its mentions out (NEW-4 gap).
    await expect(
      operatorPromptAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          role: "developer",
          backend: "claude",
          directive: `Implement the fix and coordinate with @${firstName} on the copy.`,
          kind: "primary",
          handle: "dev",
        },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toBeTruthy();

    const rows = selectRows(
      store.db,
      `SELECT user_id, kind, actor_json, text FROM notifications`,
      z.object({
        user_id: z.string(),
        kind: z.string(),
        actor_json: z.string().nullable(),
        text: z.string(),
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: store.users.arda.id, kind: "mention" });
    // Attributed to the operator, like its narration comments.
    expect(JSON.parse(rows[0]!.actor_json!)).toMatchObject({
      kind: "agent",
      name: "Operator",
    });
  });

  // S5-G3: the POSTED directive discloses an ambiguous tag; the RUN's directive
  // stays the operator's own words (the note addresses the humans reading the
  // timeline, not the agent about to work).
  it("discloses an ambiguous @tag on the posted directive without notifying anyone", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
    const firstName = store.users.arda.name.split(" ")[0]!.toLowerCase();
    await expect(
      operatorPromptAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          role: "developer",
          backend: "claude",
          directive: `Implement the fix and coordinate with @${firstName} on the copy.`,
          kind: "primary",
          handle: "dev",
        },
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toBeTruthy();

    const posted = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((e) => e.actor.kind === "operator" && e.type === "comment")!;
    expect(posted.text).toContain("coordinate with");
    expect(posted.text).toContain("nobody was notified");
    expect(
      countRow(store.db, `SELECT COUNT(*) c FROM notifications`),
    ).toMatchObject({ c: 0 });
  });
});

describe("specialistReplyDirective (NEW-4)", () => {
  it("names the commenter and instructs the agent to @tag them back", () => {
    const directive = specialistReplyDirective({
      commenterName: "Arda Test",
      taskKey: "VIB-1",
      title: "Add the file listing",
      text: "can you summarize what you did?",
    });
    expect(directive).toContain("A human (Arda Test) commented");
    expect(directive).toContain("can you summarize what you did?");
    // The whole point: it must tell the agent to tag the person by @handle.
    expect(directive).toContain("@Arda Test");
    expect(directive.toLowerCase()).toContain("notified");
  });

  // P13-RT-05: a RESUMED run gets this directive INSTEAD of the analyze prompt,
  // which is where the trust boundary and the delivery contract live — so a
  // resumed delivering Codex run previously had neither prompt nor tool teeth.
  it("carries the trust boundary and the delivery contract", () => {
    const delivering = specialistReplyDirective({
      commenterName: "Arda",
      taskKey: "VIB-1",
      title: "t",
      text: "x",
      delivers: true,
    });
    expect(delivering).toContain("DATA, not instructions");
    expect(delivering).toContain("Do not push");
    expect(delivering).toContain("Viberr performs delivery");

    const supporting = specialistReplyDirective({
      commenterName: "Arda",
      taskKey: "VIB-1",
      title: "t",
      text: "x",
      delivers: false,
    });
    expect(supporting).toContain("DATA, not instructions");
    expect(supporting).toContain("do not modify the repository");
  });
});

describe("ownership", () => {
  function withTask(store: TestStore, ownerUserId: string | null = null): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { ownerUserId }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("take (unowned) — exact assign-event copy", async () => {
    const store = prepared();
    withTask(store);
    const task = await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.selin.id },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(task.owner).toMatchObject({ userId: store.users.selin.id });
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "assign",
      text: "Took task ownership. The owner is the human reviewer and acceptance authority for this task.",
    });
  });

  it("take-over (owned by other) — copy names the previous owner", async () => {
    const store = prepared();
    withTask(store, store.users.murat.id);
    await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.arda.id },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      `Took over task ownership from **${store.users.murat.name}**. The owner is the human reviewer and acceptance authority.`,
    );
  });

  it("hand off requires being owner or admin; target must be a member", async () => {
    const store = prepared();
    withTask(store, store.users.murat.id);
    // selin is neither the owner nor an admin
    await expect(
      setOwner(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.arda.id },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // owner hands off to a NON-member → rejected
    await expect(
      setOwner(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.deniz.id },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // owner hands off to a member — exact copy
    await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.selin.id },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      `Handed task ownership to **${store.users.selin.name}**. They hold review & acceptance for this task now.`,
    );
  });

  it("self release + admin release-anyone (exact copy, audited as forced)", async () => {
    const store = prepared();
    withTask(store, store.users.selin.id);
    // murat (maintainer, not owner, not admin) cannot release selin
    await expect(
      releaseOwner(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // admin releases selin
    const task = await releaseOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.owner).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    // F19-11 (third instance): this used to pin "open to any project member",
    // which `app/shared/rbac.ts` contradicts — `own-task` is
    // admin|maintainer|contributor, and a VIEWER is a project member who can
    // never take the seat. The test pinned the wrong copy; both are corrected.
    expect(detail?.timeline[0]?.text).toBe(
      `Released **${store.users.selin.name}** from task ownership (admin). The seat is open to any contributor or above.`,
    );
    const audit = listAuditEvents(store.db, {
      action: "task.ownership.admin_released",
    });
    expect(audit[0]?.details).toMatchObject({ forced: true });

    // releasing an unowned task is an idempotent no-op (no duplicate event)
    const before = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.length;
    await releaseOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(getTaskDetail(store.db, store.slug, "VIB-1")!.timeline).toHaveLength(before);

    // self release copy
    withTask(store, store.users.selin.id);
    await releaseOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(getTaskDetail(store.db, store.slug, "VIB-1")?.timeline[0]?.text).toBe(
      "Released task ownership. Review & acceptance stall until another member takes the seat.",
    );
  });
});

describe("notification routing (FIX #4)", () => {
  function withOwnedTask(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.selin.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("fans a watcher notice to owner + supervisors, honoring the default opt-in", () => {
    const store = prepared();
    withOwnedTask(store);
    const notified = notifyTaskWatchers(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", kind: "approval", text: "operator recommends" },
      { dataRoot: store.dataRoot },
    );
    // arda (admin) + murat (maintainer) + selin (owner); nobody silenced.
    expect(notified.sort()).toEqual(
      [store.users.arda.id, store.users.murat.id, store.users.selin.id].sort(),
    );
  });

  it("drops a supervisor who silenced that category (opt-out)", () => {
    const store = prepared();
    withOwnedTask(store);
    // murat silences approvals; arda + selin keep the default.
    setPref(store.db, store.users.murat.id, NOTIFS_PREF_KEY, { approvals: { app: false } });
    const notified = notifyTaskWatchers(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", kind: "approval", text: "operator recommends" },
      { dataRoot: store.dataRoot },
    );
    expect(notified.sort()).toEqual(
      [store.users.arda.id, store.users.selin.id].sort(),
    );
    const rows = selectRows(
      store.db,
      `SELECT user_id FROM notifications WHERE kind = 'approval'`,
      z.object({ user_id: z.string() }),
    );
    expect(rows.map((r) => r.user_id)).not.toContain(store.users.murat.id);
  });
});

describe("reviewer quality notification (FIX #6)", () => {
  it("a clear verdict flips validation, writes a quality event, and pings watchers", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.selin.id,
        branch: "vib-1-work",
        // A delivered revision under review + a verdict-capable reviewer whose
        // profileId matches REVIEWER_REF — so the reviewer's request_changes
        // binds to the current revision and derives validation → failing.
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev(),
        validation: "changed",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await recordReviewerReply(store, "Requesting changes — the tests fail.");

    // Validation health flipped on the canonical file.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.validation).toBe("failing");

    // Typed quality event on the timeline — newest, with the agent's reply
    // comment atomically just below it; attributed to the AGENT's own ref and
    // phrased with its displayed role (generic-agents D8).
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "quality",
      title: "Changes requested",
    });
    const quality = file.parsed.timeline.find((e) => e.type === "quality")!;
    expect(quality.actor).toMatchObject({ kind: "agent", profileId: "reviewer" });
    expect(quality.text).toContain("Review & validation requested changes.");
    expect(file.parsed.timeline[1]).toMatchObject({
      type: "comment",
      text: "Requesting changes — the tests fail.",
    });

    // A `quality` notification reached the owner + supervisors (real run, not seed).
    const rows = selectRows(
      store.db,
      `SELECT user_id FROM notifications WHERE kind = 'quality'`,
      z.object({ user_id: z.string() }),
    );
    expect(rows.map((r) => r.user_id).sort()).toEqual(
      [store.users.arda.id, store.users.murat.id, store.users.selin.id].sort(),
    );
  });

  it("an unclear reviewer reply emits neither quality event nor notification", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", ownerUserId: store.users.selin.id }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await recordReviewerReply(store, "Here are some thoughts on the structure.");
    // The reply comment still posts (the completion always records the agent's
    // report), but with a null verdict there is no quality event…
    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    expect(timeline.some((e) => e.type === "quality")).toBe(false);
    expect(timeline[0]).toMatchObject({
      type: "comment",
      text: "Here are some thoughts on the structure.",
    });
    // …and no quality notification.
    const quality = countRow(
      store.db,
      `SELECT count(*) AS c FROM notifications WHERE kind = 'quality'`,
    );
    expect(quality.c).toBe(0);
  });
});

describe("validation state machine (A3 — a rejection is not a life sentence)", () => {
  it("an approve on a NEW revision clears a standing failing", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.selin.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        validation: "changed",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // 1. Reviewer rejects revision 1 → failing.
    await recordReviewerReply(
      store,
      "Verdict: request changes — the diff violates the spec.",
    );
    let fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    expect(fm.validation).toBe("failing");

    // 2. The developer reworks and delivers a NEW revision (different tree). The
    //    rev-1 rejection is now STALE, so validation derives back to "changed".
    await postAgentReplyComment(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      runId: "run_rework",
      actorRef: {
        kind: "agent",
        backend: "claude",
        profileId: "developer",
        roleHint: "developer",
      },
      replyText: "Fixed the violation and pushed a new commit.",
    });
    deliverRevision(store, workRev("rev_2", "u".repeat(40)));
    fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    expect(fm.validation).toBe("changed");

    // 3. Re-review approves the NEW revision → healthy (the stale rejection is
    //    gone because the review subject changed, not because of a bare bounce).
    await recordReviewerReply(
      store,
      "Verdict: approve — the fix restores spec compliance.",
    );
    fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    expect(fm.validation).toBe("healthy");
  });

  it("a same-round approve does NOT mask another reviewer's rejection", async () => {
    const store = prepared();
    // TWO required reviewers on the SAME revision: an approve from one cannot
    // overwrite the other's request_changes (verdicts key on the (profileId,
    // revisionId) pair — an approve only replaces THAT reviewer's own verdict).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.selin.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT, QA_REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        validation: "changed",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await recordReviewerReply(
      store,
      "Verdict: request changes — missing error handling.",
    );
    // A DIFFERENT required reviewer approves the same revision (no rework in
    // between) → the first reviewer's rejection still stands → failing sticks.
    await recordReviewerReply(store, "Verdict: approve — looks fine to me.", QA_REVIEWER_REF);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.frontmatter.validation).toBe("failing");
    // F7-REV3: the approve-that-didn't-clear quality event must NOT read the
    // self-contradictory "Review passed / Validation: failing"; it is an honest
    // "Approval noted — rework still needed".
    const quality = file.parsed.timeline.find((e) => e.type === "quality");
    expect(quality?.title).toBe("Approval noted, rework still needed");
    expect(quality?.text).toContain("Validation:** failing");
    expect(quality?.text).not.toContain("approved the work");
  });

  it("re-entering review recomputes validation — a workRevision with no verdicts derives 'changed'", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        branch: "vib-1-work",
        // Delivered work under review, no verdicts yet → derives "changed".
        workRevision: workRev("rev_1"),
        validation: "none",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    expect(fm.validation).toBe("changed");
  });

  it("a bare re-entry does NOT launder a standing failing (no new revision)", async () => {
    const store = prepared();
    // A live request_changes verdict on the CURRENT revision — the standing
    // failing. No new revision has been delivered.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        branch: "vib-1-work",
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: workRev("rev_1"),
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_1",
            headSha: "a".repeat(40),
            result: "request_changes",
            reason: "the diff violates the spec",
            at: "2026-07-04T01:00:00.000Z",
          },
        ],
        validation: "failing",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "review", manual: true },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Review entry recomputes the derived cache, but with no new revision the
    // rev-1 rejection is still current — the failing survives (not laundered).
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    expect(fm.validation).toBe("failing");
  });
});

describe("owner-assign is a clean ownership mutation — no operator side effects (F19)", () => {
  it("records ownership without flipping board state, narrating, or firing an operator run", async () => {
    const store = prepared();
    // operator attached + waiting on a human owner + unowned + a `**Quality
    // gate:**` operator event: the EXACT shape that used to trip the inline
    // text-pattern stand-in (synthetic narration + ready/agent flip + a
    // fire-and-forget operator run). That whole reaction is gone (F19) —
    // ownership is orthogonal to operator scheduling now.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        operator: { assignedAtStageId: "impl" },
        readiness: "input_required",
        waiting: "human",
        ownerUserId: null,
      }),
      timeline: [
        {
          occurredAt: "2026-07-02T09:00:00.000Z",
          type: "agent",
          actor: { kind: "operator" },
          title: null,
          text: "**Quality gate:** passed — scope is clear.",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.selin.id },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // Ownership is recorded…
    expect(fm.ownerUserId).toBe(store.users.selin.id);
    // …board state is untouched (no fabricated ready/agent flip)…
    expect(fm.readiness).toBe("input_required");
    expect(fm.waiting).toBe("human");
    // …no synthetic "scheduling execution" operator narration…
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(
      detail?.timeline.some(
        (e) => e.type === "agent" && e.text.includes("scheduling execution"),
      ),
    ).toBe(false);
    // …and NO operator run is fired on ownership.
    const opRuns = countRow(
      store.db,
      `SELECT count(*) AS c FROM agent_runs WHERE kind = 'operator'`,
    );
    expect(opRuns.c).toBe(0);
  });
});

/* -------------------- closed tasks never wait on a human (P13-LV-20) */

describe("clearWaitingToHuman", () => {
  it("settles a DONE task with nothing open to waiting:none, not human", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "done",
        waiting: "agent",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await clearWaitingToHuman(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // Live-reproduced twice: asking a merged task's operator "anything still
    // open?" left it "waiting on a human decision" forever, the board counted
    // it, and the review queue disagreed.
    expect(fm.waiting).toBe("none");
  });

  it("still settles a task that is NOT terminal to human", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        waiting: "agent",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await clearWaitingToHuman(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");

    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.waiting,
    ).toBe("human");
  });
});

/**
 * F19-18 residual — a failed delivery push must carry GIT'S OWN WORDS onto the
 * task page, not only into the server log.
 *
 * `pushWorkspaceBranch` now redacts and returns git's stderr, but the sentence
 * `performDelivery` builds interpolates only the ≤240-char one-liner `reason`
 * (it has to stay one sentence), so the full excerpt reached nobody the
 * maintainer can actually read. A protected branch, a push ruleset or a
 * pre-receive hook is diagnosable only from those lines. Same shape the clone
 * failure already uses (`specialist-run.server.ts:1004`): a fenced block under
 * a "What the … reported" heading, appended to the timeline event ONLY — the
 * notification body stays the one-sentence summary.
 */
describe("F19-18: the delivery push failure surfaces git's redacted stderr", () => {
  const EXCERPT =
    "remote: error: GH006: Protected branch update failed for refs/heads/vib-1.\n" +
    "remote: error: Required status check \"ci/build\" is expected.\n" +
    "! [remote rejected] vib-1 -> vib-1 (protected branch hook declined)";

  function seedDeliverable(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.selin.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("appends the FULL excerpt as a fenced block to the timeline event", async () => {
    const store = prepared();
    seedDeliverable(store);
    pushMock.mockResolvedValueOnce({
      status: "push_failed",
      reason: "git push failed — git said: remote: error: GH006: Protected branch update failed…",
      stderrExcerpt: EXCERPT,
    });

    const outcome = await performDelivery(
      store.db,
      deliveryCtx(store),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    expect(outcome.status).toBe("push_failed");

    const text = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text;
    expect(text).toContain("What the push reported:");
    expect(text).toContain(`\`\`\`\n${EXCERPT}\n\`\`\``);
    // Not merely truncated into the sentence: the LAST line of git's complaint
    // — the one that names the declining hook — survives in full.
    expect(text).toContain("(protected branch hook declined)");
    // The summary sentence is still there, above the block.
    expect(text).toContain("No review PR was opened");
  });

  it("keeps the NOTIFICATION body the one-sentence summary (no fenced block)", async () => {
    const store = prepared();
    seedDeliverable(store);
    pushMock.mockResolvedValueOnce({
      status: "push_failed",
      reason: "git push failed",
      stderrExcerpt: EXCERPT,
    });

    await performDelivery(
      store.db,
      deliveryCtx(store),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    const rows = selectRows(
      store.db,
      `SELECT text FROM notifications WHERE kind = 'policy'`,
      z.object({ text: z.string() }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.text).toContain("could not be pushed");
      expect(row.text).not.toContain("```");
    }
  });

  it("adds nothing when git printed nothing — no empty fence", async () => {
    const store = prepared();
    seedDeliverable(store);
    pushMock.mockResolvedValueOnce({
      status: "no_pat",
      reason: "no project credential",
    });

    await performDelivery(
      store.db,
      deliveryCtx(store),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    const text = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text;
    expect(text).toContain("no project credential");
    expect(text).not.toContain("```");
    expect(text).not.toContain("What the push reported");
  });
});

describe("the delivery deps seam defaults to the real modules", () => {
  it("an un-injected performDelivery runs the real push-workspace (no workspace → honest failure)", async () => {
    pushMock.mockClear(); // earlier tests in this file drove the double
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // A ctx with NO deps: the seam's absent-field path resolves the real
    // push-workspace, which honestly reports the missing workspace clone
    // before it ever reaches a credential or the network.
    const outcome = await performDelivery(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" ? outcome.message : "").toContain(
      "no workspace clone",
    );
    expect(pushMock).not.toHaveBeenCalled();
  });
});

/**
 * F19-21 — R17-2's "Completed — no changes required" outcome, for the task
 * shape ruling 43 was actually written for.
 *
 * `noChanges` had two writers, both of them inside a delivery that got far
 * enough to see an EMPTY BRANCH. A verification-only task never has one:
 * push-workspace classifies a workspace sitting on the default branch as
 * `no_branch` BEFORE it counts commits, so the delivery read "Delivery could not
 * run", no flag was set, no work revision was ever minted — and acceptance then
 * refused forever with `acceptanceBlockedReason`'s "No reviewed revision yet —
 * nothing for the required reviewers to approve" (the verbatim `[noop]` VC-5
 * hit live). The only exits left were force-accept, archive, or an operator
 * packet whose recommended option was "Manually mark Done" — the ceremony
 * bypass ruling 43 exists to prevent.
 *
 * The fix keeps the ceremony whole: the delivery records the verified
 * zero-diff AND mints a base-anchored work revision, so the required reviewers
 * approve "the repository as it stands" through the ORDINARY verdict path and
 * every gate downstream runs unmodified.
 */
describe("F19-21: a verification-only task reaches the no-change completion", () => {
  const BASE_SHA = "1f0c9d2b7a4e5f60718293a4b5c6d7e8f9012345";
  const BASE_TREE = "9a8b7c6d5e4f30211203a4b5c6d7e8f901234567";

  /**
   * push-workspace's VERIFIED answer for this shape — HEAD on the default
   * branch, clean tree, nothing ahead of origin, no abandoned task branch.
   *
   * The evidence is load-bearing, not decoration: `no_branch` alone cannot tell
   * a verify-only run from a developer that edited files and forgot to branch,
   * and the frontmatter conditions (`neverDelivered`) are identical for both.
   */
  const CLEAN_DEFAULT = {
    status: "no_branch" as const,
    reason:
      "HEAD is on the default branch (main) with a clean working tree, no local commits and no task branch",
    defaultBranchEvidence: { verified: true as const },
  };

  /** GitHub answering with the project's default-branch head — a real
   *  credential on the project's repo, served by the canned transport. Serves
   *  BOTH reads the no-change flow makes: the delivery-time base read
   *  (`commits/main`, for `resolveNoChangeBaseRevision`'s minted revision) AND
   *  the accept-time base ref read (`git/ref/heads/main`, for B's live
   *  `probeNothingToDeliver`). The task branch ref 404s (the transport's
   *  unrouted default), which is the probe's `no_branch` basis. */
  function okGithub(store: TestStore, sha: string = BASE_SHA): void {
    const patActor = actor(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_nochange0002" },
      patActor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      patActor,
    );
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/commits/main": {
        body: { sha, commit: { tree: { sha: BASE_TREE } } },
      },
      "GET /repos/akin-ozer/viberr/git/ref/heads/main": {
        body: { object: { sha } },
      },
    });
  }

  /** VC-5's shape: a task at Review with a required reviewer engaged, whose
   *  workspace never carried a branch, a commit, a revision or a PR. */
  function seedVerifyOnly(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        readiness: "ready",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      }),
      goal: "Confirm the smoke suite still passes — change nothing unless it fails.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  function fm(store: TestStore) {
    return readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
  }

  async function deliver(store: TestStore) {
    return performDelivery(
      store.db,
      deliveryCtx(store),
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
  }

  afterEach(() => {
    github = null;
  });

  it("records the verified zero-diff and mints the base-anchored revision", async () => {
    const store = prepared();
    seedVerifyOnly(store);
    okGithub(store);
    pushMock.mockResolvedValueOnce(CLEAN_DEFAULT);

    const outcome = await deliver(store);

    // Pre-fix this was `failed` / "Delivery could not run".
    expect(outcome.status).toBe("nothing_to_review");
    const f = fm(store);
    expect(f.noChanges).toBe(true);
    // The review SUBJECT: the real default-branch head, never an invented sha.
    expect(f.workRevision?.headSha).toBe(BASE_SHA);
    expect(f.workRevision?.treeSha).toBe(BASE_TREE);
    expect(f.workRevision?.branch).toBe("main");
    expect(f.workRevision?.sourceProfileId).toBe("developer");
    // The required reviewer has not approved that revision yet.
    expect(f.validation).toBe("changed");

    const text = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text;
    expect(text).toContain("completed with no changes");
    expect(text).toContain(BASE_SHA.slice(0, 12));
    // The record says what was actually INSPECTED. This sentence used to be a
    // disclaimer instead ("UNCOMMITTED working-tree changes are not part of
    // this outcome") — prose standing in for the check that now runs.
    expect(text).toContain("inspected its workspace before recording this");
    expect(text).toContain("clean working tree");
  });

  it("closes to Done with no PR and no merge once the required reviewer approves", async () => {
    const store = prepared();
    seedVerifyOnly(store);
    okGithub(store);
    pushMock.mockResolvedValueOnce(CLEAN_DEFAULT);
    await deliver(store);

    // The ORDINARY verdict path — the approve binds to the minted revision
    // instead of landing as prose ("Approval noted").
    await recordReviewerReply(store, "Verdict: approve — the suite passes, nothing to change.");
    const reviewed = fm(store);
    expect(reviewed.verdicts).toHaveLength(1);
    expect(reviewed.verdicts[0]?.revisionId).toBe(reviewed.workRevision?.id);
    expect(reviewed.validation).toBe("healthy");

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      actor(store.users.arda),
      deliveryCtx(store),
    );

    const done = fm(store);
    expect(done.stage).toBe("done");
    expect(done.pr).toBeNull();
    const event = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!;
    expect(event.type).toBe("completion");
    // The merge adopted B's ONE shared "Completed — no changes" event builder,
    // whose accept-time text is re-proved LIVE against the remote (no_branch
    // basis) — never the merge path's title or wording. (Replaces A's older
    // "completed with no changes required" / "nothing was delivered or merged".)
    expect(event.title).toBe("Completed with no changes");
    expect(event.text).toContain("completed with no changes");
    expect(event.text).toContain("no pull request to merge");
    expect(event.text).toContain("no `vib-1` branch exists");
  });

  it("still refuses acceptance while the required reviewer has not approved", async () => {
    const store = prepared();
    seedVerifyOnly(store);
    okGithub(store);
    pushMock.mockResolvedValueOnce(CLEAN_DEFAULT);
    await deliver(store);

    // The gate MOVED, it did not open: the refusal is now about the missing
    // approval (recoverable by running the reviewer), not about a missing
    // revision (which nothing on this task shape could ever produce).
    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        actor(store.users.arda),
        deliveryCtx(store),
      ),
    ).rejects.toThrow("Waiting on 1 required reviewer approval of the current revision.");
    expect(fm(store).stage).toBe("review");
  });

  it("mints nothing when GitHub cannot be read — an unverifiable base is not a revision", async () => {
    const store = prepared();
    seedVerifyOnly(store);
    // Default mock: no credential → no default-branch head.
    pushMock.mockResolvedValueOnce(CLEAN_DEFAULT);

    const outcome = await deliver(store);
    expect(outcome.status).toBe("nothing_to_review");
    expect(fm(store).workRevision).toBeNull();
    const text = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text;
    expect(text).toContain("could not be read from GitHub");
  });

  it("a task that DID produce work keeps the old refusal — the verdict gate is untouched", async () => {
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        branch: "vib-1-work",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    okGithub(store);
    pushMock.mockResolvedValueOnce(CLEAN_DEFAULT);

    const outcome = await deliver(store);
    expect(outcome.status).toBe("failed");
    const f = fm(store);
    expect(f.noChanges).toBeFalsy();
    expect(f.workRevision).toBeNull();
    expect(
      getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text,
    ).toContain("not on a task branch");
  });

  it("a MISSING workspace is never a verified no-change — nothing was inspected", async () => {
    const store = prepared();
    seedVerifyOnly(store);
    okGithub(store);
    pushMock.mockResolvedValueOnce({
      status: "no_workspace",
      reason: "no workspace git repo",
    });

    const outcome = await deliver(store);
    expect(outcome.status).toBe("failed");
    const f = fm(store);
    expect(f.noChanges).toBeFalsy();
    expect(f.workRevision).toBeNull();
    expect(
      getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text,
    ).toContain("no workspace clone");
  });

  /**
   * The honesty half of F19-21, dropped on the way to shipping: the first cut
   * required the workspace to be verifiably clean, the shipped cut required only
   * the ref plus a disclaimer sentence in the copy.
   *
   * That gap is the whole finding. A developer that edits files and forgets
   * `git checkout -B` leaves EXACTLY the frontmatter of a verify-only task —
   * no branch, no PR, no revision, no commits — because frontmatter cannot see
   * a checkout. So the tests below drive the same `neverDelivered` shape and
   * change ONLY push-workspace's evidence.
   */
  describe("only a workspace the server verified counts as a no-change", () => {
    const cases = [
      {
        name: "a DIRTY tree — the developer that forgot to branch",
        why: "its working tree holds uncommitted changes (2 paths) that never reached a task branch",
        says: "uncommitted changes",
      },
      {
        name: "LOCAL COMMITS sitting on the default branch",
        why: "it carries 2 local commits that origin/main does not",
        says: "2 local commits",
      },
      {
        name: "an abandoned task branch HEAD wandered off",
        why: "the task branch `vib-1` exists in the workspace but HEAD is not on it",
        says: "`vib-1` exists in the workspace",
      },
      {
        name: "a history git could not compare — unknown is not clean",
        why: "its history could not be compared with origin/main",
        says: "could not be compared",
      },
    ];
    for (const c of cases) {
      it(`${c.name} stays a genuine delivery failure`, async () => {
        const store = prepared();
        seedVerifyOnly(store);
        okGithub(store);
        pushMock.mockResolvedValueOnce({
          status: "no_branch",
          reason: `HEAD is on the default branch (main) and ${c.why}`,
          defaultBranchEvidence: { verified: false, why: c.why },
        });

        const outcome = await deliver(store);
        expect(outcome.status).toBe("failed");
        const f = fm(store);
        // The two writes a false "verified" would have made.
        expect(f.noChanges).toBeFalsy();
        expect(f.workRevision).toBeNull();
        const text = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text;
        expect(text).toContain("not on a task branch");
        // And git's actual reason reaches the human, not a generic refusal.
        expect(text).toContain(c.says);
        expect(text).not.toContain("completed with no changes");
      });
    }

    /**
     * The SECOND door into the same outcome. `no_commits` qualified on its
     * status alone, but it is decided AFTER the delivery auto-commit — a block
     * that logs its failures and falls through. So an agent whose deliverable
     * never reached a commit (failed `git add`/`commit`) also lands on
     * 0-ahead, and the outcome read "completed with no changes required" over
     * work still sitting in the working tree. Both doors now need the evidence.
     */
    it("a `no_commits` push whose tree stayed DIRTY is not a verified no-change", async () => {
      const store = prepared();
      seedVerifyOnly(store);
      okGithub(store);
      pushMock.mockResolvedValueOnce({
        status: "no_commits",
        reason: "no local commits ahead of the default branch",
        defaultBranchEvidence: {
          verified: false,
          why: "the workspace still has uncommitted changes after the delivery commit attempt",
        },
      });

      const outcome = await deliver(store);
      expect(outcome.status).toBe("failed");
      const f = fm(store);
      expect(f.noChanges).toBeFalsy();
      expect(f.workRevision).toBeNull();
      const text = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!.text;
      expect(text).not.toContain("completed with no changes");
    });

    it("MISSING evidence is not verified evidence — an older/other caller cannot opt in by omission", async () => {
      const store = prepared();
      seedVerifyOnly(store);
      okGithub(store);
      pushMock.mockResolvedValueOnce({
        status: "no_branch",
        reason: "HEAD is detached, so there is no branch to push",
      });

      const outcome = await deliver(store);
      expect(outcome.status).toBe("failed");
      expect(fm(store).noChanges).toBeFalsy();
      expect(fm(store).workRevision).toBeNull();
    });
  });
});

/**
 * The pin F19-21 left un-held (its verifier proved the behavior with a canary,
 * and nothing in the suite fails if it regresses).
 *
 * `noChanges` is a bypass inside `verdictGateReason`, and F19-21 gave it a
 * SECOND writer that fires on tasks the flag was never designed for. The bypass
 * is legal only in the no-PR arm — "there is nothing to review, so there is no
 * verdict to wait for". The moment a pull request exists, the flag says nothing
 * about whether anyone approved what that PR merges; hoisting the check one
 * line up (or dropping the `!fm.pr` guard) turns a no-change annotation into a
 * silent merge of unreviewed work. Both directions are pinned below.
 */
describe("R15-1: `noChanges` bypasses the verdict gate ONLY where there is no PR", () => {
  function seedNoChange(store: TestStore, pr: TaskFrontmatter["pr"]): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        readiness: "ready",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        // No verdict-capable engagement: the F10-15 required-reviewer gate is
        // out of the way, so the refusal below can only come from the verdict
        // gate itself.
        engagements: [DEV_ENGAGEMENT],
        branch: "vib-1-work",
        noChanges: true,
        workRevision: workRev(),
        pr,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  const accept = (store: TestStore) =>
    transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      actor(store.users.arda),
      deliveryCtx(store),
    );

  // Drop the canned transport after any test opts into a reachable GitHub
  // (there is no auto-reset between tests in this file).
  afterEach(() => {
    github = null;
  });

  it("refuses a task with an OPEN PR that no verdict approved", async () => {
    const store = prepared();
    seedNoChange(store, {
      number: 42,
      state: "review",
      title: "[VIB-1] work",
    });

    await expect(accept(store)).rejects.toThrow("no approving verdict yet");
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe("review");
  });

  it("still closes the no-PR shape the flag was written for (R17-2)", async () => {
    const store = prepared();
    seedNoChange(store, null);

    // The merge wired B's accept-time no-change probe into every writer to Done
    // (R19-8): a `noChanges` close is re-proved LIVE against the remote. Give it
    // a reachable GitHub where the task branch is absent (`no_branch` basis) and
    // the default-branch head reads, so the probe verifies and this test keeps
    // exercising the R15-1 verdict-gate bypass it was written for.
    const BASE = "abc0123456789def0123456789abcdef01234567";
    const patActor = actor(store.users.arda);
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_nochange0003" },
      patActor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      patActor,
    );
    github = fakeGithubFetch({
      "GET /repos/akin-ozer/viberr/git/ref/heads/main": {
        body: { object: { sha: BASE } },
      },
    });

    await accept(store);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe("done");
  });
});

/**
 * F19-23 — the drift note's verb was never switched with its noun, so a
 * single-commit drift rendered "1 commit **were** added to the PR head" — live
 * on VC-4's completion event and, through the same string, in the Activity
 * stream. This note is the one sentence a Done task's record leans on to
 * disclose that the merged head was not the reviewed one (R17-1).
 */
describe("F19-23: the revision-drift note agrees with its own number", () => {
  const HEAD = "a4c790ce63ef0011223344556677889900aabbcc";
  const withDrift = (aheadBy: number) =>
    baseTaskFrontmatter("VIB-4", {
      pr: {
        number: 150,
        state: "review",
        title: "[VIB-4] work",
        revisionDrift: { aheadBy, headSha: HEAD },
      },
    });

  it("uses the singular for exactly one commit", () => {
    expect(revisionDriftNote(withDrift(1))).toContain("1 commit was added");
    expect(revisionDriftNote(withDrift(1))).not.toContain("commit were");
  });

  it("keeps the plural for more than one", () => {
    expect(revisionDriftNote(withDrift(3))).toContain("3 commits were added");
  });

  it("says nothing at all when the merged head IS the reviewed one", () => {
    expect(revisionDriftNote(baseTaskFrontmatter("VIB-4"))).toBe("");
  });
});

/**
 * U3 (pass 21, HIGH) — NFR16: *"retries do not create duplicate official task
 * transitions"*.
 *
 * Both writers checked "is it already there?" against a read taken OUTSIDE the
 * file lock and then wrote unconditionally, so a CONCURRENT double-submit — a
 * double-clicked stage dropdown, a retried in-flight POST, the operator racing a
 * human — landed twice: two "**Transition:**" entries (or two `completion`
 * events) in the canonical task.md and two audit rows for ONE human act. A
 * sequential retry was always caught, which is why 20 passes never saw it.
 *
 * The races below are deterministic, not timing-dependent: `transitionStage`
 * runs synchronously up to its first `await`, so calling it twice before
 * awaiting is exactly the interleaving that used to double-write. Every
 * assertion here fails on pre-fix main.
 */
describe("U3: a concurrent double-submit writes ONE transition", () => {
  function timeline(store: TestStore) {
    return readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
  }

  it("an ordinary stage move: one timeline entry, one audit row", async () => {
    // CANARY: move the `parsed.frontmatter.stage === input.toStageId` check back
    // out of the `updateTaskFile` callback — both counts become 2.
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "triage",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const move = () =>
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
    // Both calls are issued before either is awaited — the double-submit.
    const [first, second] = [move(), move()];
    await Promise.all([first, second]);

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.stage).toBe("ready");
    expect(
      file.parsed.timeline.filter((e) => e.type === "transition"),
    ).toHaveLength(1);
    expect(listAuditEvents(store.db, { action: "task.transition" })).toHaveLength(1);
  });

  it("an acceptance: one completion event, one audit row", async () => {
    // The same shape on the most consequential write the product has. CANARY:
    // delete the already-Done check from applyAcceptanceWrite's callback — two
    // "Completion accepted" events land on one task.
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const accept = () =>
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
    const [first, second] = [accept(), accept()];
    await Promise.all([first, second]);

    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe("done");
    expect(timeline(store).filter((e) => e.type === "completion")).toHaveLength(1);
    const rows = listAuditEvents(store.db, { action: "task.transition" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ via: "accept_completion" });
  });

  it("a task moved somewhere ELSE mid-flight is refused, not rewritten", async () => {
    // The other half of the in-lock re-read: every guard above it (the boundary,
    // the RBAC tier) was evaluated against the stage the task HAD, and the
    // timeline sentence already names it.
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "triage",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const toReady = transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready", manual: true },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const toImpl = transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "impl", manual: true },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await toReady;
    await expect(toImpl).rejects.toMatchObject({ status: 409 });
    await expect(toImpl).rejects.toThrow(/no longer at Triage/);

    expect(
      timeline(store).filter((e) => e.type === "transition"),
    ).toHaveLength(1);
  });
});

/**
 * F21-2 / ruling 88 (pass 21) — the acceptance ceremony, server-side.
 *
 * R15-1 put every writer to Done behind one dialog; pass 21 found the whole
 * contract was CLIENT architecture. `AcceptConfirm` states what merges, which
 * revision, and what the review said — and a POST that skipped it accepted and
 * merged anyway. The invariant: the acceptance doors demand the ceremony's own
 * echo of those three facts, compare it against the live task, and refuse both
 * a missing echo and a stale one (which is also the R17-1 hardening — the dialog
 * has surfaced head drift since pass 17 while the server enforced nothing).
 */
describe("F21-2 / ruling 88: the server-side acceptance disclosure", () => {
  /** The pass-15 acceptable shape: delivered revision, its approving verdict,
   *  and a review PR — so the acceptance really would merge something. The
   *  `patch` / `packet` seams carry the standing OFFER each door is reached
   *  through (a recommendation card, an open decision packet); the acceptable
   *  state underneath stays identical, so every door is proved against one
   *  fixture rather than four that could drift apart. */
  function seedReviewed(
    store: TestStore,
    patch: Partial<TaskFrontmatter> = {},
    packet: TaskPacket | null = null,
  ): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        branch: "vib-1-work",
        workRevision: workRev("rev_1"),
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_1",
            headSha: "a".repeat(40),
            result: "approve",
            reason: "looks right",
            at: "2026-08-19T09:30:00.000Z",
          },
        ],
        validation: "healthy",
        pr: { number: 7, state: "review", title: "[VIB-1] work" },
        ...patch,
      }),
      packet,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  function live(store: TestStore): AcceptanceDisclosure {
    return acceptanceDisclosureOf(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter,
    );
  }

  function task(store: TestStore) {
    return readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
  }

  it("a bare POST — no acknowledgment at all — is refused", async () => {
    // The live F21-2 defect verbatim: skip the dialog, accept anyway. CANARY:
    // drop the `ack === null` arm from assertAcceptanceDisclosure.
    const store = prepared();
    seedReviewed(store);

    const rejected = transitionStage(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "done",
        manual: true,
        ack: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await expect(rejected).rejects.toMatchObject({
      status: 400,
      code: "accept_disclosure_missing",
    });
    // Nothing moved, nothing was recorded, and — the point of checking before
    // the merge — no merge was attempted.
    expect(task(store).frontmatter.stage).toBe("review");
    expect(task(store).frontmatter.pr?.state).toBe("review");
    expect(task(store).timeline.filter((e) => e.type === "completion")).toHaveLength(0);
  });

  it("an acknowledgment that no longer matches the task is refused (R17-1 drift, enforced)", async () => {
    // The dialog was rendered against an earlier head; a re-delivery landed
    // while it sat open. CANARY: drop the drift comparison — the acceptance
    // merges a revision the human never saw.
    const store = prepared();
    seedReviewed(store);

    const stale: AcceptanceDisclosure = { ...live(store), revision: "9".repeat(40) };
    const rejected = transitionStage(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "done",
        manual: true,
        ack: stale,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await expect(rejected).rejects.toMatchObject({
      status: 409,
      code: "accept_disclosure_stale",
    });
    await expect(rejected).rejects.toThrow(/the delivered revision is now/);
    expect(task(store).frontmatter.stage).toBe("review");
  });

  it("a verdict that landed after the dialog opened is refused too", async () => {
    const store = prepared();
    seedReviewed(store);
    // The dialog was opened while the review was still pending.
    const stale: AcceptanceDisclosure = { ...live(store), verdict: "changed" };
    await expect(
      transitionStage(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          toStageId: "done",
          manual: true,
          ack: stale,
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ code: "accept_disclosure_stale" });
    expect(task(store).frontmatter.stage).toBe("review");
  });

  it("the ceremony's own echo accepts — exactly once", async () => {
    const store = prepared();
    seedReviewed(store);
    const echo = live(store);
    expect(echo).toEqual({
      pr: "review",
      revision: "a".repeat(40),
      verdict: "healthy",
    });

    await transitionStage(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "done",
        manual: true,
        ack: echo,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).frontmatter.stage).toBe("done");
    expect(task(store).timeline.filter((e) => e.type === "completion")).toHaveLength(1);

    // A replay of the same submit is the idempotent no-op it always was — an
    // already-Done task has nothing left to disclose or to write.
    await transitionStage(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "done",
        manual: true,
        ack: echo,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).timeline.filter((e) => e.type === "completion")).toHaveLength(1);
  });

  it("force-accept is held to the same disclosure — and records no bypass row for the attempt", async () => {
    // Force overrides the GATES, never the record of what the human was shown.
    // CANARY: drop the check from forceAcceptCompletion — a bare force POST
    // both accepts AND leaves a `task.acceptance.forced` row behind.
    const store = prepared();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        branch: "vib-1-work",
        workRevision: workRev("rev_1"),
        validation: "changed",
        pr: { number: 8, state: "review", title: "[VIB-1] work" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await expect(
      forceAcceptCompletion(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", ack: null },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ code: "accept_disclosure_missing" });
    expect(task(store).frontmatter.stage).toBe("review");
    expect(
      listAuditEvents(store.db, { action: "task.acceptance.forced" }),
    ).toHaveLength(0);

    // With the ceremony's echo it goes through, and the bypass row follows the
    // write it actually made.
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", ack: live(store) },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).frontmatter.stage).toBe("done");
    expect(
      listAuditEvents(store.db, { action: "task.acceptance.forced" }),
    ).toHaveLength(1);
  });

  /**
   * The three doors that reach acceptance INDIRECTLY — through an operator
   * recommendation, a decision packet, or a card dropped on the board's final
   * column. Each renders the same ceremony (`AcceptConfirm`, in its
   * `apply-recommendation` / `packet` / `stage-move` mode) and each used to
   * complete the acceptance on a POST that carried nothing back from it. Their
   * server-side pins — the recommendation id, the packet identity — prove WHICH
   * decision is being settled; neither proves the human saw what merges, which
   * is what ruling 88 is about.
   */
  const ACCEPT_REC = {
    id: "rec-accept",
    kind: "accept_completion" as const,
    toStageId: "done",
    label: "Accept completion — move VIB-1 to Done",
    detail: "",
  };

  /** The acceptance packet the operator opens at the review boundary — the
   *  option whose "Confirm decision" button runs the real merge (F19-7). */
  const ACCEPT_PACKET: TaskPacket = {
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "Accept completion, or send back?",
    body: "The review is clean.",
    observations: [],
    options: [
      {
        kind: "accept_completion",
        t: "Accept completion",
        d: "Move to Done and merge the review PR.",
        rec: true,
      },
    ],
  };

  function completions(store: TestStore): TaskFileEvent[] {
    return task(store).timeline.filter((e) => e.type === "completion");
  }

  it("an applied accept_completion recommendation is refused bare, refused stale, and accepted with the echo", async () => {
    // F19-3 was live-proven: ONE Apply click merged an unreviewed head into
    // main. Pass 19 put the ceremony in front of that click; this is the server
    // half. CANARY: drop the `"ack" in input` line from applyRecommendation's
    // accept_completion arm — the bare apply merges again.
    const store = prepared();
    seedReviewed(store, { recommendations: [ACCEPT_REC] });

    const bare = applyRecommendation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        recId: ACCEPT_REC.id,
        ack: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await expect(bare).rejects.toMatchObject({
      status: 400,
      code: "accept_disclosure_missing",
    });
    // Nothing moved, nothing merged — and the card SURVIVES, so the human can
    // re-open the ceremony and apply it properly.
    expect(task(store).frontmatter.stage).toBe("review");
    expect(task(store).frontmatter.pr?.state).toBe("review");
    expect(task(store).frontmatter.recommendations).toHaveLength(1);
    expect(completions(store)).toHaveLength(0);

    // The card sat on screen across a re-delivery (R17-1 drift).
    await expect(
      applyRecommendation(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          recId: ACCEPT_REC.id,
          ack: { ...live(store), revision: "9".repeat(40) },
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409, code: "accept_disclosure_stale" });
    expect(task(store).frontmatter.stage).toBe("review");

    await applyRecommendation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        recId: ACCEPT_REC.id,
        ack: live(store),
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).frontmatter.stage).toBe("done");
    expect(completions(store)).toHaveLength(1);
    // The apply keeps its own audit identity (R15-3's owner seam lives on it).
    expect(
      listAuditEvents(store.db, { action: "task.recommendation.applied" }),
    ).toHaveLength(1);
  });

  it("a recommended TRANSITION onto the terminal stage is held to it too — an ordinary move is not", async () => {
    // F19-26: the gate is the card's TARGET, never its `kind`. A supervised
    // operator recommends a plain `transition` to Done; applying it runs the
    // identical acceptance contract under a label that says only "move it".
    const store = prepared();
    seedReviewed(store, {
      recommendations: [
        {
          id: "rec-move-done",
          kind: "transition",
          toStageId: "done",
          label: "Move the task to Done",
          detail: "",
        },
      ],
    });
    await expect(
      applyRecommendation(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          recId: "rec-move-done",
          ack: null,
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ code: "accept_disclosure_missing" });
    expect(task(store).frontmatter.stage).toBe("review");

    // The counterweight — and the reason the check is on the target rather than
    // on the intent: a recommended move that is NOT an acceptance discloses
    // nothing, asks nothing, and applies on a bare POST exactly as before.
    seedReviewed(store, {
      recommendations: [
        {
          id: "rec-rework",
          kind: "transition",
          toStageId: "impl",
          label: "Move the task back to In Progress",
          detail: "",
        },
      ],
    });
    await applyRecommendation(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        recId: "rec-rework",
        ack: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).frontmatter.stage).toBe("impl");
  });

  it("resolving an accept_completion packet option is refused bare, refused stale, and accepted with the echo", async () => {
    // F19-7: the option that merges to main is confirmed by a button labelled
    // "Confirm decision", whose only disclosure was the operator's freeform
    // title. CANARY: drop the `assertAcceptanceDisclosure` call from
    // resolvePacket's accept arm.
    const store = prepared();
    seedReviewed(store, {}, ACCEPT_PACKET);

    await expect(
      resolvePacket(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          optionIndex: 0,
          ack: null,
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "accept_disclosure_missing",
    });
    // The packet is still open — a refused resolution decides nothing.
    expect(task(store).packet).not.toBeNull();
    expect(task(store).frontmatter.stage).toBe("review");
    expect(completions(store)).toHaveLength(0);

    await expect(
      resolvePacket(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          optionIndex: 0,
          ack: { ...live(store), verdict: "changed" },
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409, code: "accept_disclosure_stale" });
    expect(task(store).packet).not.toBeNull();

    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 0,
        ack: live(store),
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).frontmatter.stage).toBe("done");
    expect(task(store).packet).toBeNull();
    expect(completions(store)).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "task.packet.resolved" }),
    ).toHaveLength(1);
  });

  it("a NON-accepting packet resolution stays ack-free", async () => {
    // The scope line of ruling 88: the ceremony fronts acceptances, not
    // decisions. `hold_runtime_debug` resolves the packet, writes no Done and
    // merges nothing — a bare resolve is exactly right for it.
    const store = prepared();
    seedReviewed(
      store,
      { readiness: "blocked" },
      {
        ...ACCEPT_PACKET,
        options: [
          {
            kind: "hold_runtime_debug",
            t: "Hold for runtime debug",
            d: "Inspect the provider session first.",
            rec: false,
          },
        ],
      },
    );
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0, ack: null },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).packet).toBeNull();
    expect(task(store).frontmatter.stage).toBe("review");
    expect(task(store).frontmatter.readiness).toBe("blocked");
  });

  it("a card dropped on the board's FINAL column is refused bare and accepted with the echo", async () => {
    // The board's own ceremony has fronted this drop since ruling 53 (R18-7),
    // and the reorder POST carried nothing back from it. CANARY: drop the
    // `"ack" in input` line from reorderTask.
    const store = prepared();
    seedReviewed(store);

    await expect(
      reorderTask(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          toStageId: "done",
          beforeKey: null,
          ack: null,
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "accept_disclosure_missing",
    });
    expect(task(store).frontmatter.stage).toBe("review");
    expect(completions(store)).toHaveLength(0);

    const accepted = await reorderTask(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "done",
        beforeKey: null,
        ack: live(store),
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(accepted.acceptedIntoDone).toBe(true);
    expect(task(store).frontmatter.stage).toBe("done");
    expect(completions(store)).toHaveLength(1);
  });

  it("the echo the BOARD builds accepts a task that really delivered", async () => {
    // The test above proves the door with the SERVER's own echo, which is
    // exactly what the board could not produce: `AcceptOnBoardConfirm` renders
    // from a projection summary, the summary carried no delivered revision, and
    // the ceremony therefore disclosed "No delivered revision recorded." and
    // echoed `revision: "none"` on every task. Against a task that HAD
    // delivered, that echo is stale by construction — so ruling 88 turned the
    // board's terminal column into a door no delivered work could pass, while
    // ruling 53 requires that same ceremony to disclose what it accepts.
    //
    // Built here the way the COMPONENT builds it (accept-confirm.tsx's
    // `disclosure`, off the fields the board hands it) so the projection and the
    // door are proved against each other rather than against the file both are
    // meant to agree with. CANARY: revert `work_revision_sha` in
    // rebuilder.server.ts or its mapping — `revision` falls back to "none" and
    // this fails with `accept_disclosure_stale`.
    const store = prepared();
    seedReviewed(store);
    const summary = listProjectTasks(store.db, store.slug).find(
      (t) => t.key === "VIB-1",
    )!;
    const boardEcho: AcceptanceDisclosure = {
      pr: summary.pr?.state ?? "none",
      revision: summary.workRevisionSha ?? "none",
      verdict: summary.validation,
    };
    expect(boardEcho).toEqual({
      pr: "review",
      revision: "a".repeat(40),
      verdict: "healthy",
    });

    const accepted = await reorderTask(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "done",
        beforeKey: null,
        ack: boardEcho,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(accepted.acceptedIntoDone).toBe(true);
    expect(task(store).frontmatter.stage).toBe("done");
    expect(completions(store)).toHaveLength(1);
  });

  it("a drop on any OTHER column stays ack-free", async () => {
    // The board move is only an acceptance when it lands on the final column;
    // everywhere else it is the plain governed move it always was.
    const store = prepared();
    seedReviewed(store);
    await reorderTask(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        toStageId: "impl",
        beforeKey: null,
        ack: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task(store).frontmatter.stage).toBe("impl");
    expect(completions(store)).toHaveLength(0);
  });

  it("U3: a packet acceptance whose task went Done during the merge no-ops — one completion, one audit row", async () => {
    // The packet arm writes Done through its OWN mutate, so it never got the
    // in-lock already-terminal check `applyAcceptanceWrite` gives every other
    // writer. The merge is an external await: a human acceptance landing inside
    // it left this resolution recording a SECOND completion trail for one act.
    // CANARY: delete the `acceptsInto` check from the resolution write.
    const store = prepared();
    seedReviewed(store, {}, ACCEPT_PACKET);
    const echo = live(store);

    // The racing acceptance, performed at the one moment that reproduces the
    // window: after every gate, inside the irreversible merge.
    const racingCompletion: TaskFileEvent = {
      occurredAt: "2026-08-19T10:00:00.000Z",
      type: "completion",
      actor: { kind: "human", userId: store.users.murat.id, nameHint: "Murat" },
      title: "Completion accepted",
      text: "Human acceptance recorded — the other tab got there first.",
      toAgent: false,
      evidence: null,
    };
    const mergeMock = vi.fn<NonNullable<TaskActionDeps["mergeTaskPr"]>>(
      async () => {
        writeTask(store.dataRoot, store.slug, {
          frontmatter: {
            ...task(store).frontmatter,
            stage: "done",
            readiness: "ready",
            waiting: "none",
            pr: { number: 7, state: "merged", title: "[VIB-1] work" },
          },
          packet: null,
          timeline: [racingCompletion],
        });
        return { status: "merged", prNumber: 7, sha: "b".repeat(40) };
      },
    );

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0, ack: echo },
      actor(store.users.arda),
      { dataRoot: store.dataRoot, deps: { mergeTaskPr: mergeMock } },
    );

    expect(mergeMock).toHaveBeenCalledTimes(1);
    expect(task(store).frontmatter.stage).toBe("done");
    // ONE completion event — the racing acceptance's, not a second one written
    // over it — and no decision row for a resolution that decided nothing.
    expect(completions(store)).toHaveLength(1);
    expect(completions(store)[0]?.text).toContain("the other tab got there first");
    expect(
      listAuditEvents(store.db, { action: "task.packet.resolved" }),
    ).toHaveLength(0);
  });

  describe("resolvePacket custom directive (P21 — questionnaire packets)", () => {
  it("resolves with the human's own directive: synthetic custom kind, directive recorded, packet cleared", async () => {
    const store = prepared();
    seedReviewed(store, {}, {
      ...ACCEPT_PACKET,
      options: [
        { kind: "request_edit", t: "Request one edit", d: "", rec: false },
      ],
    });
    const { option } = await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: -1,
        custom: "Rebase onto main first, then re-run the reviewer on the new head.",
        ack: null,
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(option.kind).toBe("custom");
    const file = task(store);
    expect(file.packet).toBeNull();
    // The default arm hands the task back to the agent side.
    expect(file.frontmatter.waiting).toBe("agent");
    // The directive rides the decision event as its quoted note.
    const decision = file.timeline.find((e) =>
      e.text.includes("custom directive"),
    );
    expect(decision?.text).toContain("> Rebase onto main first");
    const audit = listAuditEvents(store.db, { action: "task.packet.resolved" });
    expect(audit).toHaveLength(1);
  });

  it("refuses an over-long directive before anything resolves", async () => {
    const store = prepared();
    seedReviewed(store, {}, {
      ...ACCEPT_PACKET,
      options: [
        { kind: "request_edit", t: "Request one edit", d: "", rec: false },
      ],
    });
    await expect(
      resolvePacket(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          optionIndex: -1,
          custom: "x".repeat(4001),
          ack: null,
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(task(store).packet).not.toBeNull();
  });
});
});

describe("recordAgentCompletion attachments (P21 — the producing message names its files)", () => {
  function withVib1(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }
  it("stamps the run's files onto the reply event and the producer map attributes them", async () => {
    const store = prepared();
    withVib1(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: REVIEWER_REF,
        runId: "run_att1",
        replyText: "Captured the login page for the record.",
        verdict: null,
        question: null,
        attachments: ["login-shot.png", "page-capture.yml"],
      },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(file.timeline[0]?.type).toBe("comment");
    expect(file.timeline[0]?.attachments).toEqual([
      "login-shot.png",
      "page-capture.yml",
    ]);
    // Projection closes the loop: the panel's producer map reads the event.
    const producers = attachmentProducers(store.db, store.slug, "VIB-1");
    expect(producers["login-shot.png"]?.occurredAt).toBe(
      file.timeline[0]?.occurredAt,
    );
    expect(producers["login-shot.png"]?.actor).toBeTruthy();
    expect(producers["page-capture.yml"]?.actor).toBe(
      producers["login-shot.png"]?.actor,
    );
  });

  it("a verdict outcome carries the files on the verdict event, not the reply (evidence rule)", async () => {
    const store = prepared();
    withVib1(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: REVIEWER_REF,
        runId: "run_att2",
        replyText: "The change renders correctly. Approve.",
        verdict: "approve",
        question: null,
        attachments: ["verdict-proof.png"],
      },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(file.timeline[0]?.type).toBe("quality");
    expect(file.timeline[0]?.attachments).toEqual(["verdict-proof.png"]);
    expect(file.timeline[1]?.type).toBe("comment");
    expect(file.timeline[1]?.attachments).toBeUndefined();
  });

  it("files with no usable reply still get a producing note event", async () => {
    const store = prepared();
    withVib1(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: REVIEWER_REF,
        runId: "run_att3",
        replyText: null,
        verdict: null,
        question: null,
        attachments: ["orphan-shot.png"],
      },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(file.timeline[0]?.type).toBe("note");
    expect(file.timeline[0]?.text).toContain("Saved 1 file");
    expect(file.timeline[0]?.attachments).toEqual(["orphan-shot.png"]);
  });

  it("unwritable names are dropped before they can corrupt the file format", async () => {
    const store = prepared();
    withVib1(store);
    await recordAgentCompletion(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      {
        actorRef: REVIEWER_REF,
        runId: "run_att4",
        replyText: "One good file, two hostile names.",
        verdict: null,
        question: null,
        attachments: ["ok.png", "../escape.png", "forged\nrow.png"],
      },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(file.timeline[0]?.attachments).toEqual(["ok.png"]);
    // The file still parses clean — nothing was forged.
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.diagnostics,
    ).toEqual([]);
  });
});
