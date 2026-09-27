import { describe, expect, it } from "vitest";
import {
  VERDICT_REPORT_TITLE,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";
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

  /**
   * Ruling 257 (pass 37, F37-87). Ruling 99(b) made a controller write a
   * DIFFERENT actor kind on purpose — the person is the authority, the
   * controller is the instrument — and every other seam honours that: the audit
   * row reads "arda@viberr.dev · via controller", the comment is signed "Posted
   * by the controller for Arda". This was the one place that read `kind` as a
   * proxy for AUTHORSHIP.
   *
   * Measured on the live shopify-clone board before the fix: 19 controller
   * comments in the audit log, 8 left in the task files. Eleven of the owner's
   * own published comments deleted from canonical `task.md`, from `task_events`
   * and from the audit payload, including the two on SHOP-5 that explained a
   * lease the board was still enforcing — under a marker that says human
   * comments are never compacted, so nobody who saw the gap would look.
   */
  it("ruling 257: never folds a CONTROLLER comment either — it is a person publishing", () => {
    const controller = (i: number, text: string) =>
      comment(i, { actor: { kind: "controller" }, text });
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(100 + i)),
      ...Array.from({ length: 6 }, (_, i) => comment(20 + i)),
      controller(9, "pnpm-lock.yaml is leased to SHOP-20; here is why.\n\n_Posted by the controller for Arda._"),
      ...Array.from({ length: 6 }, (_, i) => comment(i)),
    ];
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    // CANARY: drop the `kind !== "controller"` clause and this prose is gone,
    // replaced by a line asserting that human comments are never compacted.
    expect(out.length).toBeLessThan(events.length); // machine prose still folds
    expect(out.some((e) => e.text.startsWith("pnpm-lock.yaml is leased"))).toBe(true);
    // And the marker's promise is now true of everything it covers.
    const marker = out.find((e) => e.title === COMPACTION_TITLE)!;
    expect(marker.text).toContain("human comments are never compacted");
    expect(
      out.filter((e) => e.actor.kind === "controller" || e.actor.kind === "human"),
    ).toHaveLength(1);
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
      evidence: [{ label: "Timed lifecycle log", result: "1 attachment: SHOP-15-run.log", status: "info" }],
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
    expect(kept!.evidence![0]!.result).toContain("1 attachment");
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

  /**
   * Ruling 382 (F39-9), live on ax-clone AX-9. The operator answered Arda by
   * name about a correction he had just filed; his question survived as human
   * prose and the answer was folded, so canonical task.md — the file the next
   * agent anchors on — read as a person correcting the record and nobody
   * replying. The notification row still quoted the comment and still offered a
   * button to the task, so following it landed on a page the text was no longer
   * on.
   */
  it("ruling 382: never folds a comment whose notification reached somebody", () => {
    const answered = (i: number): TaskFileEvent => ({
      ...comment(i),
      text: "@Arda Agreed — the corrected evidence settles the diagnosis.",
      notified: ["u_arda"],
    });
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(90 - i)),
      ...Array.from({ length: 4 }, (_, i) => comment(60 - i)),
      answered(55),
      ...Array.from({ length: 4 }, (_, i) => comment(50 - i)),
    ];
    // CANARY: drop the `notified` clause from `isRoutineComment` and the reply
    // disappears into the marker's count while its notification still quotes it.
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    expect(out.length).toBeLessThan(events.length); // the rest still folds
    const kept = out.find((e) => (e.notified?.length ?? 0) > 0);
    expect(kept, "a comment somebody was notified about must survive verbatim").toBeTruthy();
    expect(kept!.text).toContain("@Arda");
  });

  it("ruling 382: an empty recipient list is not a protection", () => {
    // The field is written only when the fan-out reached someone, but a file
    // edited by hand can carry `notified:` with nothing after it; that is not
    // evidence anybody was told.
    const events = [
      ...Array.from({ length: 10 }, (_, i) => comment(90 - i)),
      { ...comment(55), notified: [] },
      ...Array.from({ length: 4 }, (_, i) => comment(50 - i)),
    ];
    const out = compactTimelineEvents(events, { threshold: 12, keepRecent: 10 });
    expect(out.find((e) => e.occurredAt === comment(55).occurredAt && e.title !== COMPACTION_TITLE)).toBeUndefined();
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

  /**
   * Ruling 317. `clipVerdictReason` (ruling 292) stores 2,000 characters of a
   * reviewer's justification and appends "Its full report is on this task's
   * timeline, whole." Compaction then folded exactly that comment away.
   *
   * It was not covered by the evidence or attachment clauses, because those two
   * fields are moved OFF the reply precisely when it carries a verdict
   * (P13-D-26 puts them on the `quality` event) — so the protection was
   * inverted: a deliverer's report carried evidence and was immune, and the
   * record a stored pointer depends on was first to go.
   *
   * Live on SHOP-76, measured: three of four rounds of review reasoning gone
   * from canonical `task.md` while every `verdicts[].reason` still named the
   * timeline as the complete copy.
   */
  it("ruling 317: a verdict's justification is never folded", () => {
    const agent = {
      kind: "agent" as const,
      backend: "claude" as const,
      profileId: "rev",
      roleHint: null,
    };
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
    const routine = (n: number, title: string | null = null): TaskFileEvent => ({
      occurredAt: at(n),
      type: "comment",
      actor: agent,
      title,
      text: `comment ${n}`,
      toAgent: false,
      // The inversion: a verdict report has NEITHER, by the writer's own rule.
      evidence: null,
    });
    // Newest first. Enough routine comments past the window to force a fold.
    const events: TaskFileEvent[] = [];
    for (let n = 40; n > 20; n -= 1) events.push(routine(n));
    events.push(routine(20, VERDICT_REPORT_TITLE));
    for (let n = 19; n > 0; n -= 1) events.push(routine(n));

    const out = compactTimelineEvents(events, { threshold: 10, keepRecent: 5 });
    // CANARY: drop the `e.title !== VERDICT_REPORT_TITLE` clause and this
    // disappears, leaving every `verdicts[].reason` pointing at nothing.
    expect(out.some((e) => e.title === VERDICT_REPORT_TITLE)).toBe(true);
    // And the pass still did its job on the rest.
    expect(out.length).toBeLessThan(events.length);
  });
});
