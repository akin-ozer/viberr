import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { deriveValidation } from "~/schemas/task-file.schema";
import type {
  Engagement,
  FileActorRef,
  WorkRevision,
} from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
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
  packetIdentity,
  postAgentReplyComment,
  recordAgentCompletion,
  releaseOwner,
  setOwner,
  specialistReplyDirective,
  transitionStage,
} from "./task-actions.server";
import type { TaskPacket } from "~/schemas/task-file.schema";

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
    expect(detail?.timeline[0]?.text).toBe(
      `Released **${store.users.selin.name}** from task ownership (admin) — the seat is open to any project member.`,
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
