import { describe, expect, it } from "vitest";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import {
  COMPACTION_TITLE,
  compactTimelineEvents,
} from "./timeline-compaction.server";

function comment(i: number, opts: Partial<TaskFileEvent> = {}): TaskFileEvent {
  return {
    occurredAt: `2026-07-10T00:00:${String(i).padStart(2, "0")}.000Z`,
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text: `routine comment ${i}`,
    toAgent: false,
    evidence: null,
    ...opts,
  };
}

function typed(i: number, type: string): TaskFileEvent {
  return {
    occurredAt: `2026-07-10T00:00:${String(i).padStart(2, "0")}.000Z`,
    type,
    actor: { kind: "operator" },
    title: null,
    text: `${type} event ${i}`,
    toAgent: false,
    evidence: null,
  };
}

describe("compactTimelineEvents", () => {
  it("leaves a short timeline untouched (same reference)", () => {
    const events = [comment(1), comment(2), typed(3, "transition")];
    expect(compactTimelineEvents(events, { threshold: 60, keepRecent: 24 })).toBe(events);
  });

  it("collapses old routine comments into one marker, keeps the recent window", () => {
    // 10 recent + 20 old routine comments, over a low threshold.
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(100 + i)),
      ...Array.from({ length: 20 }, (_, i) => comment(i)),
    ];
    const out = compactTimelineEvents(events, { threshold: 15, keepRecent: 10 });
    // The 10 recent survive verbatim.
    expect(out.slice(0, 10)).toEqual(events.slice(0, 10));
    // The 20 old routine comments collapse to a single marker.
    const markers = out.filter((e) => e.title === COMPACTION_TITLE);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toContain("20 earlier routine comments");
    expect(markers[0]!.text).toContain("human comments are never compacted");
    expect(out.length).toBeLessThan(events.length);
  });

  it("NEVER compacts typed governance events", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(100 + i)),
      typed(9, "blocked"),
      ...Array.from({ length: 8 }, (_, i) => comment(i)),
      typed(0, "transition"),
    ];
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    // Both typed events survive.
    expect(out.some((e) => e.type === "blocked")).toBe(true);
    expect(out.some((e) => e.type === "transition")).toBe(true);
  });

  it("does not fold to-agent prompts or existing markers (idempotent)", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(100 + i)),
      comment(5, { toAgent: true }), // a hand-off, not routine chatter
      ...Array.from({ length: 12 }, (_, i) => comment(i)),
    ];
    const once = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    expect(once.some((e) => e.toAgent)).toBe(true); // the prompt survived
    // Running compaction again does not change an already-compacted timeline.
    const twice = compactTimelineEvents(once, { threshold: 12, keepRecent: 10 });
    expect(twice.filter((e) => e.title === COMPACTION_TITLE).length).toBe(
      once.filter((e) => e.title === COMPACTION_TITLE).length,
    );
  });
});

/**
 * B-FD9: compaction rewrites canonical `task.md`, so what it deletes is gone.
 */
describe("compactTimelineEvents — who may be compacted (B-FD9)", () => {
  const human = (i: number, opts: Partial<TaskFileEvent> = {}) =>
    comment(i, { actor: { kind: "human", userId: "u_arda", nameHint: "Arda" }, ...opts });
  const agent = (i: number, opts: Partial<TaskFileEvent> = {}) =>
    comment(i, {
      actor: { kind: "agent", backend: "claude", profileId: "developer", roleHint: null },
      ...opts,
    });

  it("never folds a HUMAN comment out of the canonical file", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(100 + i)),
      ...Array.from({ length: 6 }, (_, i) => comment(20 + i)),
      human(9, { text: "the acceptance criteria changed — see the ticket" }),
      ...Array.from({ length: 6 }, (_, i) => comment(i)),
    ];
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    expect(out.length).toBeLessThan(events.length); // machine prose still folded
    expect(
      out.some((e) => e.text === "the acceptance criteria changed — see the ticket"),
    ).toBe(true);
  });

  it("folds an AGENT-reply flood but keeps the newest reply of each run", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(100 + i)),
      ...Array.from({ length: 8 }, (_, i) => agent(50 - i)), // newest agent reply first
    ];
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    // Before B-FD9 an agent-only tail compacted to nothing at all.
    expect(out.length).toBeLessThan(events.length);
    const agentReplies = out.filter((e) => e.actor.kind === "agent");
    expect(agentReplies).toHaveLength(1);
    expect(agentReplies[0]!.text).toBe("routine comment 50"); // the newest one
  });

  it("keeps ordering newest-first when an agent reply is preserved mid-run", () => {
    // Two-digit seconds only — the fixture's timestamps are compared as strings.
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(90 - i)),
      comment(40),
      comment(39),
      agent(38),
      comment(37),
      comment(36),
    ];
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    const times = out.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  /**
   * Ruling 206 (F37-26, measured on the live board). Every fixture above puts
   * the foldable comments NEXT TO each other, and the adjacency requirement is
   * invisible under that shape. Viberr's own timeline never has it: a typed
   * `agent` / `quality` / `github` / `transition` event lands between every pair
   * of agent replies, and the operator's prompt in between is excluded as a
   * `toAgent` hand-off. Live, the longest consecutive routine-comment run on the
   * six tasks past their threshold was TWO, and not one compaction marker
   * existed anywhere — while the foldable comments were 29% of SHOP-7's
   * timeline bytes and 34% of SHOP-6's.
   */
  it("ruling 206: folds routine comments that are SEPARATED by typed events", () => {
    // The live shape: reply, typed, reply, typed, reply… for the whole tail.
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(90 - i)),
      ...Array.from({ length: 8 }, (_, i) => [
        agent(60 - i * 2),
        typed(59 - i * 2, "quality"),
      ]).flat(),
    ];
    // CANARY: restore the adjacency grouping (collapse each run of CONSECUTIVE
    // routine comments) and this returns `events` unchanged — every run has
    // length 1, so nothing ever folds.
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    expect(out.length).toBeLessThan(events.length);

    // Every typed event survives, in place.
    expect(out.filter((e) => e.type === "quality")).toHaveLength(8);
    // The newest agent reply outside the recent window is kept verbatim; the
    // seven behind it fold into one marker.
    const replies = out.filter((e) => e.actor.kind === "agent");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe("routine comment 60");
    const markers = out.filter((e) => e.title === COMPACTION_TITLE);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.text).toContain("7 earlier routine comments");

    // And the file stays newest-first, which is what the marker's placement is for.
    const times = out.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  /**
   * Ruling 209. The evidence-separation guardrail takes an agent's raw output
   * OFF the timeline and onto disk, leaving a reference behind. A comment
   * carrying one is therefore not disposable prose: folding it keeps a count
   * and drops the pointer, orphaning a file that is still there and still the
   * proof behind a verdict. Live shape on SHOP-15: an Infrastructure
   * Engineer's reply with "1 attachment: …" rows — agent-authored, not
   * `toAgent`, matching every other foldable clause.
   */
  it("ruling 209: never folds a comment that carries an evidence reference", () => {
    const withEvidence = (i: number): TaskFileEvent => ({
      ...agent(i),
      evidence: [{ label: "Timed lifecycle log", add: "1 attachment: SHOP-15-run.log", del: "—" }],
    });
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(90 - i)),
      ...Array.from({ length: 4 }, (_, i) => agent(60 - i)),
      withEvidence(55),
      ...Array.from({ length: 4 }, (_, i) => agent(50 - i)),
    ];
    // CANARY: drop the `evidence` clause from `isRoutineComment` and the
    // attachment reference disappears into the marker's count.
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    expect(out.length).toBeLessThan(events.length); // the rest still folds
    const kept = out.find((e) => (e.evidence?.length ?? 0) > 0);
    expect(kept, "the evidence-bearing reply must survive verbatim").toBeTruthy();
    expect(kept!.evidence![0]!.add).toContain("1 attachment");
  });

  /**
   * Ruling 211(e), from the adversarial self-review of 209: `attachments` is a
   * SECOND, separate pointer list on the same event — the browser captures a run
   * saved into `attachments/` — and 209 excluded only `evidence`. The files
   * survive in the directory either way; what folding deletes permanently from
   * canonical task.md is the chips AND the prose saying what each capture shows.
   */
  it("ruling 211(e): never folds a comment carrying ATTACHMENTS either", () => {
    const withFiles = (i: number): TaskFileEvent => ({
      ...agent(i),
      attachments: ["shop-15-checkout.png", "shop-15-orders.png"],
    });
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(90 - i)),
      ...Array.from({ length: 4 }, (_, i) => agent(60 - i)),
      withFiles(55),
      ...Array.from({ length: 4 }, (_, i) => agent(50 - i)),
    ];
    // CANARY: drop the `attachments` clause and the chips vanish into the
    // marker's count while the PNGs stay on disk, unexplained.
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    expect(out.length).toBeLessThan(events.length);
    const kept = out.find((e) => (e.attachments?.length ?? 0) > 0);
    expect(kept, "the attachment-bearing reply must survive verbatim").toBeTruthy();
    expect(kept!.attachments).toEqual(["shop-15-checkout.png", "shop-15-orders.png"]);
  });

  it("stays idempotent with agent replies in the mix", () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(100 + i)),
      ...Array.from({ length: 8 }, (_, i) => agent(50 - i)),
    ];
    const once = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    const twice = compactTimelineEvents(once, { threshold: 12, keepRecent: 10 });
    expect(twice).toEqual(once);
  });
});
