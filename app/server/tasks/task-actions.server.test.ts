import { afterEach, describe, expect, it, vi } from "vitest";
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
import { getTaskDetail } from "~/server/projections/task-query.server";
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
} from "./task-actions.server";
import type { TaskPacket } from "~/schemas/task-file.schema";

/**
 * `performDelivery` reaches the push through a dynamic import, and nothing else
 * in this file touches that module — so the mock is inert for every other test
 * here and lets the push-failure branch run without git or a remote.
 */
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("~/server/github/push-workspace.server", () => ({
  pushWorkspaceBranch: pushMock,
}));

/**
 * F19-21 needs GitHub to answer with the default-branch head (the base the
 * no-change revision anchors to). The default is the DEGRADED answer — the same
 * one the real resolver returns for a project with no stored credential — so
 * every other test in this file behaves exactly as it did before the mock
 * existed; the no-change tests opt in to the `ok` context explicitly.
 */
const { ghCtxMock } = vi.hoisted(() => ({
  ghCtxMock: vi.fn((): unknown => ({
    status: "no_pat_configured" as const,
    repo: null,
  })),
}));
vi.mock("~/server/github/github-context.server", () => ({
  getProjectGithubContext: ghCtxMock,
}));

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
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

  it("assigns the operator when created outside triage", async () => {
    const store = prepared();
    const result = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Straight to ready", stageId: "ready" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(result.task.operator).toMatchObject({
      assignedAtStageId: "ready",
      sinceLabel: "since Ready", // real stage NAME, not a bare index (F7-UI2)
    });
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
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Done create", stageId: "done" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
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
    const rows = store.db
      .prepare(`SELECT user_id, kind, task_key, read_at FROM notifications`)
      .all() as { user_id: string; kind: string; task_key: string; read_at: string | null }[];
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
      store.db.prepare(`SELECT COUNT(*) c FROM notifications`).get() as { c: number },
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

    const rows = store.db
      .prepare(`SELECT user_id, kind, actor_json FROM notifications`)
      .all() as { user_id: string; kind: string; actor_json: string | null }[];
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
    } as never);
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
    } as never);
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
      store.db.prepare(`SELECT COUNT(*) c FROM notifications`).get() as { c: number },
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
    } as never);
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

    const rows = store.db
      .prepare(`SELECT user_id, kind, actor_json, text FROM notifications`)
      .all() as {
      user_id: string;
      kind: string;
      actor_json: string | null;
      text: string;
    }[];
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
      store.db.prepare(`SELECT COUNT(*) c FROM notifications`).get() as { c: number },
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
      text: "Took task ownership — owner is the human reviewer and acceptance authority for this task.",
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
      `Took over task ownership from **${store.users.murat.name}** — owner is the human reviewer and acceptance authority.`,
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
      `Handed task ownership to **${store.users.selin.name}** — they hold review & acceptance for this task now.`,
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
      `Released **${store.users.selin.name}** from task ownership (admin) — the seat is open to any contributor or above.`,
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
      "Released task ownership — review & acceptance stall until another member takes the seat.",
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
    const rows = store.db
      .prepare(`SELECT user_id FROM notifications WHERE kind = 'approval'`)
      .all() as { user_id: string }[];
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
    const rows = store.db
      .prepare(`SELECT user_id FROM notifications WHERE kind = 'quality'`)
      .all() as { user_id: string }[];
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
    const quality = store.db
      .prepare(`SELECT count(*) AS c FROM notifications WHERE kind = 'quality'`)
      .get() as { c: number };
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
    expect(quality?.title).toBe("Approval noted — rework still needed");
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
    const opRuns = store.db
      .prepare(`SELECT count(*) AS c FROM agent_runs WHERE kind = 'operator'`)
      .get() as { c: number };
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
      { dataRoot: store.dataRoot },
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
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
    const rows = store.db
      .prepare(`SELECT text FROM notifications WHERE kind = 'policy'`)
      .all() as { text: string }[];
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
      { dataRoot: store.dataRoot },
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

  /** GitHub answering with the project's default-branch head. */
  function okGithub(sha: string = BASE_SHA): void {
    ghCtxMock.mockReturnValue({
      status: "ok",
      repo: "akin-ozer/viberr",
      owner: "akin-ozer",
      defaultBranch: "main",
      patId: "pat_test",
      client: {
        request: async (_method: string, path: string) =>
          path === "/repos/akin-ozer/viberr/commits/main"
            ? {
                ok: true,
                status: 200,
                data: { sha, commit: { tree: { sha: BASE_TREE } } },
                etag: null,
                rateLimit: { limit: null, remaining: null, reset: null },
                scopesHeader: null,
                tokenExpiration: null,
              }
            : { ok: false, kind: "http", status: 404, message: "not found" },
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
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      actor(store.users.arda),
    );
  }

  afterEach(() => {
    ghCtxMock.mockReturnValue({ status: "no_pat_configured", repo: null });
  });

  it("records the verified zero-diff and mints the base-anchored revision", async () => {
    const store = prepared();
    seedVerifyOnly(store);
    okGithub();
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
    okGithub();
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
      { dataRoot: store.dataRoot },
    );

    const done = fm(store);
    expect(done.stage).toBe("done");
    expect(done.pr).toBeNull();
    const event = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline[0]!;
    expect(event.type).toBe("completion");
    expect(event.text).toContain("completed with no changes required");
    expect(event.text).toContain("nothing was delivered or merged");
  });

  it("still refuses acceptance while the required reviewer has not approved", async () => {
    const store = prepared();
    seedVerifyOnly(store);
    okGithub();
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
        { dataRoot: store.dataRoot },
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
    okGithub();
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
    okGithub();
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
        okGithub();
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
      okGithub();
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
      okGithub();
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
      { dataRoot: store.dataRoot },
    );

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
