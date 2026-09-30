import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { deployDeliveryOperator } from "../../../test-support/delivery-operator";
import { listAuditEvents } from "../../../test-support/audit-log";
import { flush } from "../../../test-support/polling";
import type { Engagement, TaskPacket, WorkRevision } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import {
  createNotification,
  listNotifications,
} from "~/server/projections/notifications.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
// Loaded up front so a hand-off, were one made, reaches the stub within the
// settle below instead of waiting on a cold dynamic import.
import "./operator-actions.server";
import {
  applyAcceptanceWrite,
  forceAcceptCompletion,
  resolvePacket,
  transitionStage,
} from "./task-actions.server";

/**
 * Ruling 471: a direct acceptance answers the open decision that offers it.
 *
 * Live on WEB-1 (2026-09-24) the operator's decision recommended
 * `accept_completion` ("Accept WEB-1 and merge PR #1"), the owner pressed the
 * task page's Accept, and the timeline said the decision "was never answered"
 * with a `task.packet.withdrawn` row. The packet door choosing the same option
 * records `task.packet.resolved`. These cases pin the direct doors to the
 * packet door's record, and pin F32-11's withdrawal to the decisions the
 * acceptance does not answer.
 */

const runOp = vi.fn<typeof runOperator>(async () => ({
  runId: null,
  queued: true,
  backend: "claude" as const,
  autonomy: "supervised" as const,
}));

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupProjectedStore(ctx);
  runOp.mockClear();
});

afterEach(() => ctx.cleanup());

const ACCEPT_TITLE = "Accept VIB-1 and merge PR #1";
const FORCE_TITLE = "Force-accept as admin without a fresh verdict";

/** The WEB-1 shape: an acceptance decision whose recommended option is the
 *  acceptance itself, beside a send-back. */
const READY_PACKET: TaskPacket = {
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "VIB-1 ready to accept: both reviewers approved",
  body: "",
  observations: [],
  options: [
    { kind: "request_edit", t: "Send back for one fix", d: "", rec: false },
    { kind: "accept_completion", t: ACCEPT_TITLE, d: "", rec: true },
  ],
};

/** A decision that offers neither acceptance option. */
const OTHER_PACKET: TaskPacket = {
  type: "input",
  kind: "Decision required",
  from: "operator",
  title: "Which environment should the smoke suite target?",
  body: "",
  observations: [],
  options: [
    { kind: "request_edit", t: "Staging", d: "", rec: true },
    { kind: "redirect", t: "Production", d: "", rec: false },
  ],
};

/** The KNC-3 shape: a wedged task whose decision offers the override. */
const FORCE_PACKET: TaskPacket = {
  type: "blocked",
  kind: "Blocked decision",
  from: "operator",
  title: "No verdict-capable agent can run at this stage",
  body: "",
  observations: [],
  options: [
    { kind: "accept_completion", t: ACCEPT_TITLE, d: "", rec: false },
    { kind: "force_accept", t: FORCE_TITLE, d: "", rec: true },
  ],
};

const DEV: Engagement = {
  profileId: "dev",
  backend: "codex",
  role: "developer",
  delivers: true,
  verdictCapable: false,
};
const REVIEWER: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};
const REVISION: WorkRevision = {
  id: "rev_1",
  headSha: "a".repeat(40),
  treeSha: "t".repeat(40),
  branch: "vib-1-work",
  createdAt: "2026-07-04T00:00:00.000Z",
  sourceProfileId: "dev",
};

/** A task at Review that a plain acceptance closes. */
function atReview(packet: TaskPacket | null): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      ownerUserId: store.users.arda.id,
    }),
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

/** A task only the override closes: a standing rejection on its revision. */
function wedged(packet: TaskPacket): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      branch: "vib-1-work",
      engagements: [DEV, REVIEWER],
      workRevision: REVISION,
      verdicts: [
        {
          profileId: "reviewer",
          revisionId: "rev_1",
          headSha: "a".repeat(40),
          result: "request_changes",
          reason: "standing rejection",
          at: "2026-07-04T01:00:00.000Z",
          rounds: 1,
        },
      ],
      validation: "failing",
    }),
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

/** The Accept button's own call (`accept-completion` in project.task.tsx). */
async function pressAccept(): Promise<void> {
  await transitionStage(
    store.db,
    { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
    actorOf(store.users.arda),
    { dataRoot: store.dataRoot, deps: { runOperator: runOp } },
  );
}

function file() {
  return readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
    .parsed;
}

function completionText(): string {
  return file().timeline.find((e) => e.type === "completion")!.text;
}

function withdrawalNotes(): string[] {
  return file()
    .timeline.map((e) => e.text)
    .filter((t) => t.includes("Withdrew the open decision") || t.includes("never answered"));
}

describe("ruling 471: a plain acceptance answers a decision that offers accept_completion", () => {
  it("records the packet door's resolution, withdraws nothing, and hands nothing to the operator", async () => {
    // An operator is deployed, so a `packet-resolved` hand-off would reach
    // the stub: the answer must not make one (the task is Done).
    deployDeliveryOperator(store, "supervised");
    atReview(READY_PACKET);
    createNotification(store.db, {
      id: "n-packet",
      userId: store.users.arda.id,
      kind: "packet",
      ptype: "input",
      text: READY_PACKET.title,
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });

    await pressAccept();

    // The task ends Done with no decision standing, in the file and the
    // projection alike.
    expect(file().frontmatter.stage).toBe("done");
    expect(file().packet).toBeNull();
    expect(getTaskDetail(store.db, store.slug, "VIB-1")!.packet).toBeNull();

    // CANARY: drop `answerer: actor` from acceptCompletion's write input and
    // this row is missing (the decision is withdrawn instead).
    const resolved = listAuditEvents(store.db, { action: "task.packet.resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.actorUserId).toBe(store.users.arda.id);
    expect(resolved[0]!.details).toEqual({
      optionKind: "accept_completion",
      optionTitle: ACCEPT_TITLE,
      packetKind: READY_PACKET.kind,
      via: "accept",
    });
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn" })).toHaveLength(0);
    expect(withdrawalNotes()).toEqual([]);

    // One clause on the completion event says which decision was answered.
    expect(completionText()).toContain(
      `This acceptance answers the open decision "${READY_PACKET.title}" with "${ACCEPT_TITLE}".`,
    );

    // The decision's notification is settled, as the packet door settles it.
    // CANARY: drop `markTaskPacketApprovalRead` from the acceptance.
    expect(
      listNotifications(store.db, store.users.arda.id).filter((n) => n.unread && n.kind === "packet"),
    ).toHaveLength(0);

    // No operator run is queued by the answer.
    // CANARY: fire `autoInvokeOperator(..., "packet-resolved")` after the
    // resolved row and the stub is called.
    await flush();
    await new Promise((r) => setTimeout(r, 150));
    expect(runOp).not.toHaveBeenCalled();
  });

  it("a plain acceptance never answers a force_accept option: that decision is withdrawn", async () => {
    // Only the override is offered, and a plain acceptance overrode nothing.
    // CANARY: give the plain door `force_accept` too and this is answered.
    atReview({ ...FORCE_PACKET, type: "input", options: [FORCE_PACKET.options[1]!] });
    await pressAccept();
    expect(listAuditEvents(store.db, { action: "task.packet.resolved" })).toHaveLength(0);
    const withdrawn = listAuditEvents(store.db, { action: "task.packet.withdrawn" });
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]!.details).toMatchObject({ title: FORCE_PACKET.title, by: "accept" });
  });

  it("a decision offering neither option is withdrawn exactly as before (F32-11)", async () => {
    // The note and the row, as F32-11 wrote them. CANARY: have
    // `acceptanceAnswerOf` answer with the recommended option of ANY kind.
    atReview(OTHER_PACKET);
    await pressAccept();
    expect(file().frontmatter.stage).toBe("done");
    expect(listAuditEvents(store.db, { action: "task.packet.resolved" })).toHaveLength(0);
    const withdrawn = listAuditEvents(store.db, { action: "task.packet.withdrawn" });
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]!.details).toMatchObject({ title: OTHER_PACKET.title, by: "accept" });
    expect(withdrawalNotes()).toEqual([
      `Withdrew the open decision "${OTHER_PACKET.title}": this acceptance closed the task, ` +
        `so the decision was never answered.`,
    ]);
    expect(completionText()).not.toContain("answers the open decision");
  });

  it("the operator's own acceptance answers no question put to a person: it still withdraws", async () => {
    // `operatorAcceptCompletion` reaches the shared write with no answerer.
    // CANARY: ignore `input.answerer` in the in-lock answer and this reads
    // `task.packet.resolved`.
    atReview(READY_PACKET);
    await applyAcceptanceWrite(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      doneStageId: "done",
      prState: "accepted",
      event: {
        occurredAt: new Date().toISOString(),
        type: "completion",
        actor: { kind: "operator" },
        title: "Completion accepted",
        text: "Operator acceptance recorded.",
        toAgent: false,
        evidence: null,
      },
    });
    expect(file().frontmatter.stage).toBe("done");
    expect(listAuditEvents(store.db, { action: "task.packet.resolved" })).toHaveLength(0);
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn" })).toHaveLength(1);
  });
});

/**
 * Ruling 600: an acceptance leaves no decision on the task, so it leaves no
 * decision row unread. Live on AWSC-12 (2026-09-29) the operator's "Accept
 * completion" card was consumed by a direct Accept, and its `approval` row
 * stayed unread: every tab's title counted it for a day and a half. Only an
 * acceptance that answered a packet read the rows. CANARY: put
 * `markTaskPacketApprovalRead` back under `answered.current && input.answerer`
 * and all three cases go red.
 */
describe("ruling 600: an acceptance reads every decision row on the task", () => {
  function unreadDecisions(): string[] {
    return listNotifications(store.db, store.users.arda.id)
      .filter((n) => n.unread && ["packet", "question", "approval"].includes(n.kind))
      .map((n) => n.kind);
  }

  function notify(kind: "packet" | "approval", text: string): void {
    createNotification(store.db, {
      id: `n-${kind}`,
      userId: store.users.arda.id,
      kind,
      ptype: kind === "packet" ? "input" : null,
      text,
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });
  }

  it("a recommendation card the acceptance consumed", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        recommendations: [
          { id: "r1", kind: "accept_completion", label: "Accept completion", detail: "" },
        ],
      }),
      packet: null,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    notify("approval", "Operator recommends: Accept completion and move VIB-1 to Done");
    await pressAccept();
    expect(file().frontmatter.recommendations).toEqual([]);
    expect(unreadDecisions()).toEqual([]);
  });

  it("a packet the acceptance withdrew", async () => {
    atReview(OTHER_PACKET);
    notify("packet", OTHER_PACKET.title);
    await pressAccept();
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn" })).toHaveLength(1);
    expect(unreadDecisions()).toEqual([]);
  });

  it("the operator's own acceptance, which answers no person", async () => {
    atReview(READY_PACKET);
    notify("packet", READY_PACKET.title);
    await applyAcceptanceWrite(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      doneStageId: "done",
      prState: "accepted",
      event: {
        occurredAt: new Date().toISOString(),
        type: "completion",
        actor: { kind: "operator" },
        title: "Completion accepted",
        text: "Operator acceptance recorded.",
        toAgent: false,
        evidence: null,
      },
    });
    expect(unreadDecisions()).toEqual([]);
  });
});

describe("ruling 471: a forced acceptance answers force_accept, else accept_completion", () => {
  it("the Force accept button answers a force_accept option with that option", async () => {
    wedged(FORCE_PACKET);
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(file().frontmatter.stage).toBe("done");
    expect(file().frontmatter.acceptance).toBe("forced");
    // Force prefers the override option over accept_completion.
    // CANARY: swap the force door's kinds to ["accept_completion",
    // "force_accept"] and this names accept_completion.
    const resolved = listAuditEvents(store.db, { action: "task.packet.resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.details).toEqual({
      optionKind: "force_accept",
      optionTitle: FORCE_TITLE,
      packetKind: FORCE_PACKET.kind,
      via: "force-accept",
    });
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn" })).toHaveLength(0);
    expect(withdrawalNotes()).toEqual([]);
    // The override record does not call the answered decision withdrawn.
    // CANARY: restore `withdrawnPacket: parsed.packet?.title ?? null` in
    // forceAcceptDisclosure.
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(forced[0]!.details!.withdrawnPacket).toBeNull();
    const text = completionText();
    expect(text).not.toContain("withdrawn unanswered");
    // The bypass list ends its sentence before the answer's clause starts one.
    expect(text).toMatch(/Bypassed: [^\n]*\. This acceptance answers the open decision /);
    expect(text).toContain(`with "${FORCE_TITLE}".`);
  });

  it("with no force_accept option, a forced acceptance answers accept_completion", async () => {
    wedged({ ...FORCE_PACKET, options: [FORCE_PACKET.options[0]!] });
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // CANARY: drop "accept_completion" from the force door's kinds and this
    // decision is withdrawn instead.
    const resolved = listAuditEvents(store.db, { action: "task.packet.resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.details).toMatchObject({
      optionKind: "accept_completion",
      via: "force-accept",
    });
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn" })).toHaveLength(0);
  });

  it("the packet door's force_accept still records ONE resolution: the override it runs finds no decision left to answer", async () => {
    wedged({ ...FORCE_PACKET, options: [FORCE_PACKET.options[1]!] });
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(file().frontmatter.stage).toBe("done");
    // CANARY: leave the packet in place on the force_accept arm (`clearPacket
    // = false`) and `forceAcceptCompletion` answers it a second time.
    const resolved = listAuditEvents(store.db, { action: "task.packet.resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.details).toEqual({
      optionKind: "force_accept",
      optionTitle: FORCE_TITLE,
      packetKind: FORCE_PACKET.kind,
    });
  });
});
