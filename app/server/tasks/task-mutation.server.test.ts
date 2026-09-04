import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  createNotification,
  listNotifications,
} from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { ParsedTaskFile, Recommendation } from "~/schemas/task-file.schema";
import {  recordRecommendationWithdrawal,
  withdrawAcceptanceOffers,
  notifyOwnerSeatChange,
} from "./task-mutation.server";

/**
 * Ruling 137 (pass 34, F34-15): the acceptance offer is withdrawn, on the
 * record, when the revision it was written for is replaced or the task's
 * decision state changes; `run_agent` and `delivery` cards survive.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const accept: Recommendation = {
  id: "r-accept",
  kind: "accept_completion",
  label: "Accept completion and move JC-3 to Done",
  detail: "The review is clean.",
  forHeadSha: "6548677".padEnd(40, "0"),
};
const toDone: Recommendation = { id: "r-done", kind: "transition", toStageId: "done", label: "Move to Done", detail: "" };
const toQa: Recommendation = { id: "r-qa", kind: "transition", toStageId: "qa", label: "Move to QA", detail: "" };
const runAgent: Recommendation = { id: "r-run", kind: "run_agent", profileId: "dev", label: "Run Developer", detail: "" };
const delivery: Recommendation = { id: "r-deliver", kind: "delivery", label: "Deliver", detail: "" };
const OPERATOR = { kind: "operator" as const };

function file(recommendations: Recommendation[]): ParsedTaskFile {
  return {
    frontmatter: baseTaskFrontmatter("JC-3", { recommendations }),
    unknownFrontmatter: {},
    goal: "g",
    packet: null,
    timeline: [],
    extraSections: [],
  };
}

describe("withdrawAcceptanceOffers", () => {
  it("a new revision withdraws the accept card only, and writes the note naming the cause", () => {
    // Canary: make the `revision` cause also drop `transition` cards (or drop
    // nothing) and the survivors/removed assertions fail.
    const parsed = file([accept, toDone, toQa, runAgent, delivery]);
    const result = withdrawAcceptanceOffers(parsed, "done", { kind: "revision", headSha: "1215ab44".padEnd(40, "0") }, OPERATOR);
    expect(result.removed.map((r) => r.id)).toEqual(["r-accept"]);
    expect(result.surviving).toBe(4);
    expect(parsed.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-done", "r-qa", "r-run", "r-deliver"]);
    expect(parsed.timeline[0]).toMatchObject({ type: "note", title: "Recommendation withdrawn", actor: OPERATOR });
    expect(parsed.timeline[0]!.text).toContain('"Accept completion and move JC-3 to Done"');
    expect(parsed.timeline[0]!.text).toContain("a new revision `1215ab4` was delivered");
    expect(parsed.timeline[0]!.text).toContain("4 recommendations still stand");
  });

  it("a packet and a move off the boundary withdraw the accept card AND the terminal transition card; other cards survive", () => {
    const packet = file([accept, toDone, toQa, runAgent]);
    const p = withdrawAcceptanceOffers(packet, "done", { kind: "packet", title: "Branch conflicts with main" }, OPERATOR);
    expect(p.removed.map((r) => r.id)).toEqual(["r-accept", "r-done"]);
    expect(packet.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-qa", "r-run"]);
    expect(packet.timeline[0]!.text).toContain('a decision packet opened ("Branch conflicts with main")');

    const moved = file([accept, toDone]);
    const m = withdrawAcceptanceOffers(moved, "done", { kind: "stage_move", toStageId: "impl", toStageName: "Implementation" }, OPERATOR);
    expect(m.removed.map((r) => r.id)).toEqual(["r-accept", "r-done"]);
    expect(m.surviving).toBe(0);
    expect(moved.timeline[0]!.text).toContain("moved to **Implementation**");
    expect(moved.timeline[0]!.text).not.toContain("still stand");
  });

  it("nothing to withdraw writes nothing", () => {
    const parsed = file([runAgent, toQa]);
    const result = withdrawAcceptanceOffers(parsed, "done", { kind: "packet", title: "t" }, OPERATOR);
    expect(result).toEqual({ removed: [], surviving: 2, note: null });
    expect(parsed.timeline).toEqual([]);
  });
});

describe("recordRecommendationWithdrawal", () => {
  it("audits one row per withdrawal and marks the approval bell read ONLY when nothing survives", () => {
    // Canary: call `markTaskPacketApprovalRead` unconditionally and the
    // surviving-card case finds its approval row read.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("JC-3") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    // SAFETY: a `count(*) AS c` aggregate answers exactly one row with the integer `c`.
    const unread = () =>
      (store.db
        .prepare(`SELECT count(*) AS c FROM notifications WHERE task_key = 'JC-3' AND kind = 'approval' AND read_at IS NULL`)
        .get() as { c: number }).c;
    const seedBell = () =>
      createNotification(store.db, {
        userId: store.users.murat.id,
        kind: "approval",
        text: "Run Developer",
        projectSlug: store.slug,
        taskKey: "JC-3",
        bypassPrefs: true,
      });

    seedBell();
    const survivor = file([accept, runAgent]);
    const w1 = withdrawAcceptanceOffers(survivor, "done", { kind: "revision", headSha: "b".repeat(40) }, OPERATOR);
    recordRecommendationWithdrawal(store.db, { projectSlug: store.slug, taskKey: "JC-3", withdrawal: w1, cause: { kind: "revision", headSha: "b".repeat(40) }, actor });
    expect(unread()).toBe(1); // the run_agent card's bell stays unread
    const rows = listAuditEvents(store.db).filter((e) => e.action === "task.recommendation.withdrawn");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ cause: "revision", surviving: 1, removed: [{ id: "r-accept", kind: "accept_completion" }] });

    const alone = file([accept]);
    const w2 = withdrawAcceptanceOffers(alone, "done", { kind: "packet", title: "t" }, OPERATOR);
    recordRecommendationWithdrawal(store.db, { projectSlug: store.slug, taskKey: "JC-3", withdrawal: w2, cause: { kind: "packet", title: "t" }, actor });
    expect(unread()).toBe(0);

    // Nothing removed: no row, no bell change.
    seedBell();
    const none = file([runAgent]);
    const w3 = withdrawAcceptanceOffers(none, "done", { kind: "packet", title: "t" }, OPERATOR);
    recordRecommendationWithdrawal(store.db, { projectSlug: store.slug, taskKey: "JC-3", withdrawal: w3, cause: { kind: "packet", title: "t" }, actor });
    expect(unread()).toBe(1);
    expect(listAuditEvents(store.db).filter((e) => e.action === "task.recommendation.withdrawn")).toHaveLength(2);
  });
});

/**
 * Ruling 140(b) (pass 34, U34-11): the seat-change notifier never writes a row
 * to the person who performed the act, and fails OPEN when the store refuses.
 */
describe("notifyOwnerSeatChange", () => {
  it("writes the row for someone else, and NOTHING for the actor themselves", () => {
    // Canary: drop the `recipientUserId === actor.userId` guard — the actor
    // gets a row telling them about their own act.
    const store = setupTestStore(ctx);
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    const told = notifyOwnerSeatChange(store.db, {
      projectSlug: store.slug,
      recipientUserId: store.users.murat.id,
      actor,
      actorName: "Arda",
      change: { kind: "handed_off", taskKey: "JC-3" },
    });
    expect(told).toEqual({ userId: store.users.murat.id });
    const row = listNotifications(store.db, store.users.murat.id).find((n) => n.kind === "ownership")!;
    expect(row.title).toBe("Arda handed you JC-3");
    expect(row.taskKey).toBe("JC-3");

    const self = notifyOwnerSeatChange(store.db, {
      projectSlug: store.slug,
      recipientUserId: store.users.arda.id,
      actor,
      actorName: "Arda",
      change: { kind: "taken_over", taskKey: "JC-3" },
    });
    expect(self).toBeNull();
    expect(
      listNotifications(store.db, store.users.arda.id).filter((n) => n.kind === "ownership"),
    ).toHaveLength(0);
  });

  it("fails OPEN when the store refuses the row, and says the write failed", () => {
    // Canary: let the throw escape — a mutation that already landed would fail
    // on its notification.
    const store = setupTestStore(ctx);
    store.db.exec(`DROP TABLE notifications`);
    const answer = notifyOwnerSeatChange(store.db, {
      projectSlug: store.slug,
      recipientUserId: store.users.murat.id,
      actor: { userId: store.users.arda.id, label: store.users.arda.email },
      actorName: "Arda",
      change: { kind: "admin_released", taskKey: "JC-3" },
    });
    expect(answer).toEqual({ skipped: "failed" });
  });
});
