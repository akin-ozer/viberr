import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS,
  type NotificationKind,
} from "~/shared/mapping/notification.server";
import {
  DEFAULT_NOTIF_PREFS,
  NOTIF_PREF_CATEGORIES,
  PROFILE_NTF,
  mergeNotifPrefs,
  notifCategoryForKind,
} from "./notification-prefs";

/**
 * Rulings 131 and 140 (pass 34): the two new notification kinds route through
 * their own categories, with their own toggles, defaulting ON like every other.
 *
 * Canary: map `dependency` to `controller` (or `ownership` to `packets`) in
 * `KIND_TO_CATEGORY` and the routing case fails.
 */
describe("notification routing — the pass-34 kinds", () => {
  it("routes dependency → dependencies and ownership → ownership", () => {
    expect(notifCategoryForKind("dependency")).toBe("dependencies");
    expect(notifCategoryForKind("ownership")).toBe("ownership");
  });

  it("every kind routes to a category that has a profile row and a default", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const category = notifCategoryForKind(kind);
      expect(NOTIF_PREF_CATEGORIES).toContain(category);
      expect(PROFILE_NTF.map((row) => row.id)).toContain(category);
      expect(DEFAULT_NOTIF_PREFS[category]).toEqual({ app: true });
    }
  });

  it("a stored pref written before the categories existed reads them as ON (questions too, ruling 481)", () => {
    const merged = mergeNotifPrefs({
      packets: { app: false },
      approvals: { app: true },
      mentions: { app: true },
      policy: { app: true },
      quality: { app: true },
      controller: { app: true },
    });
    expect(merged.packets).toEqual({ app: false });
    expect(merged.dependencies).toEqual({ app: true });
    expect(merged.ownership).toEqual({ app: true });
    expect(merged.questions).toEqual({ app: true });
    // …and a silenced new category is honoured once stored.
    expect(mergeNotifPrefs({ ...merged, ownership: { app: false } }).ownership).toEqual({
      app: false,
    });
  });
});

/**
 * Ruling 481(a) (F40-48): every writer of a decision notification, the kind it
 * writes, and the words the toggle it routes through must use to name it. The
 * "Approval requests" row said "Operator transition requests at boundaries you
 * can approve" while it carried every agent question, so switching it off to
 * quiet stage traffic silenced the agents waiting on the person, and nothing on
 * the toggle said so.
 *
 * Canary: route `question` back to `approvals` in `KIND_TO_CATEGORY` (or put
 * the old "transition requests" copy back on the approvals row) and this fails.
 */
describe("each toggle names what its writers send (ruling 481)", () => {
  const WRITERS: { writer: string; kind: NotificationKind; names: RegExp[] }[] = [
    // agent-toolkit.server.ts `openAgentQuestionPacket` (Claude `ask_human`)
    // and task-actions.server.ts's Codex outcome-envelope question.
    { writer: "an agent's question", kind: "question", names: [/agent/i, /question/i] },
    // operator-actions.server.ts: `Operator recommends: <label>`.
    { writer: "the operator's recommendation", kind: "approval", names: [/recommendations/i] },
    // task-actions.server.ts: `Next step recorded: <label>` after a delivery.
    { writer: "the delivery's next step", kind: "approval", names: [/next step/i, /delivery/i] },
    // operator-actions.server.ts `operatorOpenPacket`, blocked and input.
    { writer: "a blocked operator packet", kind: "packet", names: [/blocked/i] },
    { writer: "an operator completion report", kind: "packet", names: [/completion report/i] },
  ];

  it.each(WRITERS)("$writer routes through a toggle that names it", ({ kind, names }) => {
    const row = PROFILE_NTF.find((r) => r.id === notifCategoryForKind(kind));
    expect(row).toBeTruthy();
    const copy = `${row!.n} ${row!.d}`;
    for (const name of names) expect(copy).toMatch(name);
  });

  it("agent questions have their own toggle, apart from approvals", () => {
    expect(notifCategoryForKind("question")).toBe("questions");
    expect(notifCategoryForKind("approval")).toBe("approvals");
    const approvals = PROFILE_NTF.find((r) => r.id === "approvals")!;
    // Nothing on the approvals row claims a traffic it does not carry.
    expect(approvals.d).not.toMatch(/transition|question/i);
  });
});
