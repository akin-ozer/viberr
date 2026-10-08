import { describe, expect, it } from "vitest";
import type { PrRef } from "~/schemas/task-file.schema";
import type { DependencyRender } from "~/shared/dependencies";
import {
  withLiveRun,
  isAtAcceptanceBoundary,
  mapPrChecks,
  mapPrChecksUnread,
  prChecksRead,
  mapPrMergeable,
  mapPrReview,
  mapTaskProjectionRow,
  withLiveAgentIdentities,
  type LiveAgentIdentity,
  type TaskProjectionRow,
} from "./task.server";

/** Minimal valid projection row — tests patch what they assert on. */
function row(patch: Partial<TaskProjectionRow> = {}): TaskProjectionRow {
  return {
    project_slug: "viberr-core",
    task_key: "VIB-1",
    epic_id: null,
    title: "A task",
    stage: "review",
    readiness: "ready",
    stored_readiness: "ready",
    schedules_json: "[]",
    waiting: "human",
    urgent: 0,
    priority: "normal",
    labels_json: "[]",
    due_date: null,
    blocked_by_json: "[]",
    archived: 0,
    validation: "healthy",
    validation_block_reason: null,
    acceptance: null,
    continuity: null,
    owner_user_id: null,
    specialist_json: null,
    reviewers_json: "[]",
    operator_json: null,
    branch: null,
    repo: null,
    pr_json: null,
    github_json: null,
    work_revision_sha: null,
    goal: "",
    packet_json: null,
    recommendation_count: 0,
    event_count: 0,
    comment_count: 0,
    diagnostic_count: 0,
    created_at: null,
    updated_at: null,
    board_rank: null,
    source_path: "projects/viberr-core/tasks/VIB-1/task.md",
    content_hash: "h",
    parsed_at: "2026-07-16T00:00:00.000Z",
    ...patch,
  };
}

const STAGES = [
  { id: "triage", name: "Triage" },
  { id: "ready", name: "Ready" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
];

/** The template graph: triage → ready → review → done. */
const WORKFLOW = [
  { from: "triage", to: "ready" },
  { from: "ready", to: "review" },
  { from: "review", to: "done" },
];

function summarize(
  r: TaskProjectionRow,
  accepted: boolean,
  workflow: { from: string; to: string }[] = WORKFLOW,
  blockedBy: DependencyRender[] = [],
) {
  return mapTaskProjectionRow(r, {
    stages: STAGES,
    workflow,
    owner: null,
    accepted,
    blockedBy,
  });
}

const WAITS_ON_VIB_2: DependencyRender[] = [
  { ref: "VIB-2", label: "VIB-2", state: "open", taskKey: "VIB-2" },
];

describe("ruling 131: the summary carries the caller's resolved dependency list", () => {
  it("passes the resolved entries through verbatim (the mapper resolves nothing itself)", () => {
    // Canary: omit `blockedBy` from the mapper's return object.
    const entries = [
      { ref: "VIB-2", label: "VIB-2", state: "open" as const, taskKey: "VIB-2" },
    ];
    const summary = mapTaskProjectionRow(row({ blocked_by_json: '["VIB-2"]' }), {
      stages: STAGES,
      workflow: WORKFLOW,
      owner: null,
      accepted: false,
      blockedBy: entries,
    });
    expect(summary.blockedBy).toBe(entries);
    expect(summarize(row(), false).blockedBy).toEqual([]);
  });
});

/**
 * Projected facts the summary carries through as they are, each one a surface
 * reads: the task's epic (ruling 503), a force-accept (N20-14), the delivered
 * revision the board's acceptance ceremony discloses and echoes back for the
 * server to compare with the live task (rulings 53/88), and degraded runtime
 * continuity (D4). Each is null while its column is.
 */
describe("the summary carries the projected facts its surfaces read", () => {
  it.each([
    { field: "epicId", patch: { epic_id: "epic-2" }, value: "epic-2" },
    { field: "acceptance", patch: { acceptance: "forced" }, value: "forced" },
    { field: "workRevisionSha", patch: { work_revision_sha: "a".repeat(40) }, value: "a".repeat(40) },
    { field: "continuity", patch: { continuity: "degraded" }, value: "degraded" },
  ] as const)("$field: the projected value, and null when the column is", ({ field, patch, value }) => {
    // CANARY: drop the field from the mapper's return object, or hard-code its null.
    expect(summarize(row(patch), false)[field]).toBe(value);
    expect(summarize(row(), false)[field]).toBeNull();
  });
});

describe("displayReadiness derivation (F7-UI3)", () => {
  it("non-terminal tasks pass raw readiness through", () => {
    expect(summarize(row({ readiness: "blocked" }), false).displayReadiness).toBe(
      "blocked",
    );
  });

  it('accepted + PR still merge-pending → "accepted"', () => {
    const r = row({
      stage: "done",
      pr_json: JSON.stringify({ number: 7, state: "accepted", title: "PR" }),
    });
    expect(summarize(r, true).displayReadiness).toBe("accepted");
  });

  it('accepted with no linked PR → "accepted"', () => {
    expect(summarize(row({ stage: "done" }), true).displayReadiness).toBe(
      "accepted",
    );
  });

  it('accepted + PR really merged → "merged", never a stale "accepted"', () => {
    const r = row({
      stage: "done",
      pr_json: JSON.stringify({ number: 7, state: "merged", title: "PR" }),
    });
    expect(summarize(r, true).displayReadiness).toBe("merged");
  });

  it("a merged PR on a NON-terminal task does not flip the pill", () => {
    const r = row({
      readiness: "ready",
      pr_json: JSON.stringify({ number: 7, state: "merged", title: "PR" }),
    });
    expect(summarize(r, false).displayReadiness).toBe("ready");
  });

  const inputPacket = JSON.stringify({
    id: "pkt_1",
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "PR closed without merging",
    body: "",
    options: [],
  });

  it("an open input packet awaiting a human lifts 'ready' → 'input required' (display only)", () => {
    const r = row({ readiness: "ready", waiting: "human", packet_json: inputPacket });
    const s = summarize(r, false);
    expect(s.displayReadiness).toBe("input_required");
    // The STORED readiness is untouched — the acceptance gate + board filter read it.
    expect(s.readiness).toBe("ready");
  });

  it("'ready' with no packet still reads 'ready'", () => {
    const r = row({ readiness: "ready", waiting: "human", packet_json: null });
    expect(summarize(r, false).displayReadiness).toBe("ready");
  });

  it("a blocked-type packet does not trigger the input-required lift", () => {
    const blockedPacket = JSON.stringify({
      id: "pkt_2",
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "x",
      body: "",
      options: [],
    });
    const r = row({ readiness: "ready", waiting: "human", packet_json: blockedPacket });
    expect(summarize(r, false).displayReadiness).toBe("ready");
  });

  it("an input packet never overrides a non-ready readiness (blocked stays blocked)", () => {
    const r = row({ readiness: "blocked", waiting: "human", packet_json: inputPacket });
    expect(summarize(r, false).displayReadiness).toBe("blocked");
  });

  it("ruling 138: a decided edit_goal packet reads 'goal edit pending' over input_required and a stored blocked, never over agent_working or a terminal state", () => {
    // Canary: make the goal-edit branch return `readiness` unchanged and the
    // input case reads "input_required" (the pill row is a TYPE, not a runtime,
    // canary).
    const decided = (type: "input" | "blocked") =>
      JSON.stringify({
        id: "pkt_2",
        type,
        kind: "Blocked decision",
        from: "operator",
        title: "Scope needed",
        body: "",
        options: [{ kind: "edit_goal", t: "Specify the goal", d: "", rec: true }],
        awaiting: "goal_edit",
        decided: { optionIndex: 0, at: "2026-09-04T10:00:00.000Z", byUserId: "u-murat" },
      });
    expect(summarize(row({ readiness: "ready", waiting: "human", packet_json: decided("input") }), false).displayReadiness).toBe("goal_edit_pending");
    expect(summarize(row({ readiness: "blocked", waiting: "human", packet_json: decided("blocked") }), false).displayReadiness).toBe("goal_edit_pending");
    // An agent carrying the task still owns the slot.
    expect(summarize(row({ readiness: "ready", waiting: "agent", packet_json: decided("input") }), false).displayReadiness).toBe("agent_working");
    expect(summarize(row({ readiness: "blocked", waiting: "agent", packet_json: decided("blocked") }), false).displayReadiness).toBe("blocked");
    // Never over a terminal state.
    expect(summarize(row({ readiness: "ready", waiting: "human", packet_json: decided("input") }), true).displayReadiness).toBe("accepted");
    // The render carries the decision for the card and the rail.
    const s = summarize(row({ readiness: "ready", waiting: "human", packet_json: decided("input") }), false);
    expect(s.packet?.awaiting).toBe("goal_edit");
    expect(s.packet?.decided?.optionIndex).toBe(0);
  });

  it("F35-6: a decided edit_goal packet carries the ONE goal draft every editor door opens with", () => {
    // Canary: drop the `goalDraft` derivation in `mapPacket` and the first
    // assert is red (the card, its button and the hero's Edit all read this).
    const withDraft = JSON.stringify({
      id: "pkt_3",
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "Scope needed",
      body: "",
      options: [
        { kind: "redirect", t: "Redirect", d: "", rec: false },
        {
          kind: "edit_goal",
          t: "Align the goal",
          d: "to the merged spec",
          rec: true,
          goalDraft: "Deliverable: the search page.\n\nAcceptance: results render.",
        },
      ],
      awaiting: "goal_edit",
      decided: { optionIndex: 1, at: "2026-09-06T10:00:00.000Z", byUserId: "u-arda" },
    });
    expect(summarize(row({ packet_json: withDraft }), false).packet?.goalDraft).toBe(
      "Deliverable: the search page.\n\nAcceptance: results render.",
    );
    // Without an explicit draft the composition is the option's title and
    // detail, the same `goalDraftForOption` the confirm response uses.
    const titled = JSON.parse(withDraft);
    delete titled.options[1].goalDraft;
    expect(summarize(row({ packet_json: JSON.stringify(titled) }), false).packet?.goalDraft).toBe(
      "Align the goal\n\nto the merged spec",
    );
    // An undecided packet, or one stamped awaiting with no decision, carries none.
    const undecided = JSON.parse(withDraft);
    delete undecided.decided;
    expect(summarize(row({ packet_json: JSON.stringify(undecided) }), false).packet?.goalDraft).toBeUndefined();
    expect(summarize(row({ packet_json: inputPacket }), false).packet?.goalDraft).toBeUndefined();
  });

  it("ruling 471: the render names the option each direct acceptance answers, so the dialog never guesses", () => {
    // Canary: drop the two `acceptanceAnswerOf` lines in `mapPacket` and the
    // first asserts read undefined (the dialog would say "Withdraws").
    const packet = (options: unknown[], extra: { awaiting?: "goal_edit" } = {}) =>
      JSON.stringify({
        id: "pkt_4",
        type: "input",
        kind: "Completion report",
        from: "operator",
        title: "Ready to accept?",
        body: "",
        options,
        ...extra,
      });
    const both = packet([
      { kind: "accept_completion", t: "Accept it", d: "", rec: false },
      { kind: "accept_completion", t: "Accept and merge", d: "", rec: true },
      { kind: "force_accept", t: "Force-accept it", d: "", rec: false },
    ]);
    const rendered = summarize(row({ packet_json: both }), false).packet;
    // The recommended option of the kind wins over the first one.
    expect(rendered?.acceptAnswersWith).toBe("Accept and merge");
    expect(rendered?.forceAnswersWith).toBe("Force-accept it");
    // Force falls back to accept_completion; the plain door never takes the
    // override.
    const acceptOnly = summarize(
      row({ packet_json: packet([{ kind: "accept_completion", t: "Accept it", d: "", rec: true }]) }),
      false,
    ).packet;
    expect(acceptOnly?.forceAnswersWith).toBe("Accept it");
    const forceOnly = summarize(
      row({ packet_json: packet([{ kind: "force_accept", t: "Force-accept it", d: "", rec: true }]) }),
      false,
    ).packet;
    expect(forceOnly?.acceptAnswersWith).toBeUndefined();
    expect(forceOnly?.forceAnswersWith).toBe("Force-accept it");
    // A decision no acceptance answers, and one already decided, carry neither.
    const plain = summarize(row({ packet_json: inputPacket }), false).packet;
    expect(plain?.acceptAnswersWith).toBeUndefined();
    expect(plain?.forceAnswersWith).toBeUndefined();
    const decided = summarize(
      row({ packet_json: packet(JSON.parse(both).options, { awaiting: "goal_edit" }) }),
      false,
    ).packet;
    expect(decided?.acceptAnswersWith).toBeUndefined();
  });

  it("ruling 478(e) (F40-31): an agent's question names the agent the answer goes back to", () => {
    // Canary: drop the `answerTo` line in `mapPacket` and the card labels the
    // box "Note for the operator" again.
    const question = (extra: { askedBy?: string; kind?: string }) =>
      JSON.stringify({
        id: "pkt_5",
        type: "input",
        kind: "Agent question",
        from: "agent:claude/platform-engineer (Platform Engineer)",
        title: "Is Workers Builds connected?",
        body: "",
        options: [{ kind: "custom", t: "Connected", d: "", rec: false, reply: true }],
        ...extra,
      });
    const asked = summarize(row({ packet_json: question({ askedBy: "platform-engineer" }) }), false).packet;
    expect(asked?.answerTo).toBe(asked?.from);
    expect(asked?.answerTo).toBeTruthy();
    // The same predicate the server routes on: no asker, or not an agent's
    // question, and the answer goes to the operator, so the card says that.
    expect(summarize(row({ packet_json: question({}) }), false).packet?.answerTo).toBeUndefined();
    expect(
      summarize(row({ packet_json: question({ askedBy: "platform-engineer", kind: "Decision" }) }), false).packet
        ?.answerTo,
    ).toBeUndefined();
    expect(summarize(row({ packet_json: inputPacket }), false).packet?.answerTo).toBeUndefined();
  });

  it("an input packet on the agent's turn does not raise 'input required'", () => {
    // The packet lift is for a HUMAN who owes an answer. On the agent's turn
    // the agent-working lift below owns the slot instead — what this must never
    // do is claim a human is needed.
    const r = row({ readiness: "ready", waiting: "agent", packet_json: inputPacket });
    expect(summarize(r, false).displayReadiness).not.toBe("input_required");
  });
});

/**
 * Ruling 157 (pass 35, F35-8). A stored `blocked` with no open packet and no
 * dependency list is a HOLD (`hold_runtime_debug`, the refused arm of a
 * collision ceremony), and the server lifts it on the record when a person
 * starts the operator or any dispatch starts a run. The display says the same
 * thing: while an agent carries such a hold the card reads "agent working",
 * never "blocked" and "agent working" on one line (KNC-25 live, 15:12Z). A
 * diagnostics floor (derived `blocked` over a stored `ready`), a dependency
 * hold (ruling 131's floor) and an open `blocked` packet all keep reading
 * `blocked`: a run outranks none of those.
 *
 * Canary: drop the first-priority branch in `deriveDisplayReadiness` and the
 * first assert is red.
 */
describe("ruling 157: a packet-less, list-less stored block carried by an agent reads 'agent working'", () => {
  it("lifts a hold on the display while an agent carries it", () => {
    const held = row({ readiness: "blocked", stored_readiness: "blocked", waiting: "agent" });
    expect(summarize(held, false).displayReadiness).toBe("agent_working");
    // The stored value is untouched: the acceptance gate and the attention
    // filter still read `blocked` until the server's lift lands.
    expect(summarize(held, false).readiness).toBe("blocked");
  });

  it("keeps 'blocked' for a dependency hold, a diagnostics floor, an open packet and a human's turn", () => {
    const held = row({ readiness: "blocked", stored_readiness: "blocked", waiting: "agent" });
    const blockedPacket = JSON.stringify({
      id: "pkt_4",
      type: "blocked",
      kind: "Blocked decision",
      from: "operator",
      title: "Work stalled",
      body: "",
      options: [{ kind: "hold_runtime_debug", t: "Hold", d: "", rec: false }],
    });
    // Ruling 131's floor: the list is the block, and a run does not answer it.
    expect(summarize(held, false, WORKFLOW, WAITS_ON_VIB_2).displayReadiness).toBe("blocked");
    // A diagnostic floored the derived value over a stored `ready`: not a hold.
    expect(
      summarize(row({ readiness: "blocked", stored_readiness: "ready", waiting: "agent" }), false)
        .displayReadiness,
    ).toBe("blocked");
    // An open blocked packet keeps the withdrawal paths as its only lift.
    expect(
      summarize(
        row({ readiness: "blocked", stored_readiness: "blocked", waiting: "agent", packet_json: blockedPacket }),
        false,
      ).displayReadiness,
    ).toBe("blocked");
    // Nobody is carrying it: a held task waiting on a human is held.
    expect(
      summarize(row({ readiness: "blocked", stored_readiness: "blocked", waiting: "human" }), false)
        .displayReadiness,
    ).toBe("blocked");
  });
});

/**
 * R21-8, generalised (pass 30). The ruling's own rule — while an agent carries
 * the task the slot says so — shipped as a UI special case for `input_required`
 * only, re-derived on three surfaces with two different gates. `ready` was left
 * behind, and `ready` is the state that actually dominates: the triage gate
 * clears `input_required` on leaving the entry stage, which is exactly when
 * agents start working, and three task actions write `waiting: "agent"` and
 * `readiness: "ready"` together as one "an agent now carries this" state. The
 * result was the app's green all-clear painted over work in flight.
 */
describe("R21-8: while an agent carries the task, readiness reads 'agent working'", () => {
  it("'ready' + waiting:agent no longer paints a green all-clear", () => {
    const s = summarize(row({ readiness: "ready", waiting: "agent" }), false);
    expect(s.displayReadiness).toBe("agent_working");
    // The STORED value is untouched: the acceptance gate and the board's
    // attention filter read `readiness`, never `displayReadiness`.
    expect(s.readiness).toBe("ready");
  });

  it("'input required' + waiting:agent yields, exactly as R21-8 shipped it", () => {
    const r = row({ readiness: "input_required", waiting: "agent" });
    expect(summarize(r, false).displayReadiness).toBe("agent_working");
  });

  it("a human's turn reasserts the readiness value immediately", () => {
    // Raising a packet flips `waiting` to "human" — the human's turn outranks
    // a run that is still winding down.
    const r = row({ readiness: "input_required", waiting: "human" });
    expect(summarize(r, false).displayReadiness).toBe("input_required");
  });

  it("'blocked' and 'inconsistency risk' never yield — a run does not answer them", () => {
    for (const readiness of ["blocked", "inconsistency_risk_detected"] as const) {
      expect(
        summarize(row({ readiness, waiting: "agent" }), false).displayReadiness,
      ).toBe(readiness);
    }
  });

  it("waiting:none is not an agent turn", () => {
    expect(
      summarize(row({ readiness: "ready", waiting: "none" }), false).displayReadiness,
    ).toBe("ready");
  });

  it("a terminal task keeps its terminal status even with waiting:agent", () => {
    // "accepted"/"merged" are the STATUS of finished work; a stale waiting flag
    // must not relabel a done task as in-flight.
    const r = row({ stage: "done", readiness: "ready", waiting: "agent" });
    expect(summarize(r, true).displayReadiness).toBe("accepted");
  });
});

describe("mapPrChecks / mapPrReview (P13-D-28)", () => {
  const pr = (patch: Partial<PrRef> = {}): PrRef => ({
    number: 7,
    state: "review",
    title: "PR",
    ...patch,
  });

  it("rolls check-runs up to failing > pending > passing", () => {
    expect(
      mapPrChecks(pr({ checks: { total: 4, passing: 2, failing: 1, pending: 1 } })),
    ).toMatchObject({ state: "failing", failing: 1, total: 4 });
    expect(
      mapPrChecks(pr({ checks: { total: 3, passing: 2, failing: 0, pending: 1 } })),
    ).toMatchObject({ state: "pending" });
    expect(
      mapPrChecks(pr({ checks: { total: 2, passing: 2, failing: 0, pending: 0 } })),
    ).toMatchObject({ state: "passing" });
  });

  /**
   * Ruling 276 (pass 37, F37-109): `prRefSchema` keeps "never read" (the key is
   * absent) apart from "read, and GitHub reported no check runs" (`total: 0`),
   * and says so in its own comment. `mapPrChecks` collapses both to null —
   * correctly, a display has nothing to draw either way — and every reader
   * inherited the collapse, including the one for whom the difference IS the
   * answer. Live, the controller read `checks: null` on all 30 PRs and could
   * not tell which; "no CI is configured" and "we have not looked" ask for
   * opposite next moves.
   */
  it("ruling 276: `never read` and `GitHub reported none` are told apart", () => {
    // CANARY: return `pr?.checks != null` without the undefined check, or read
    // it off `mapPrChecks`, and the two collapse again.
    expect(prChecksRead(pr())).toBe(false);
    expect(prChecksRead(pr({ checks: { total: 0, passing: 0, failing: 0, pending: 0 } }))).toBe(
      true,
    );
    // The DISPLAY is deliberately unchanged: both still render nothing.
    expect(mapPrChecks(pr())).toBeNull();
    expect(mapPrChecks(pr({ checks: { total: 0, passing: 0, failing: 0, pending: 0 } }))).toBeNull();
    // A hand-edited null is "never read" too — the writers omit rather than
    // persist one, so a null that reaches here came from outside.
    expect(prChecksRead(pr({ checks: null }))).toBe(false);
    expect(prChecksRead(null)).toBe(false);
  });

  it("ruling 360: a refused read is mapped only while nothing was ever read", () => {
    // CANARY: return the refusal regardless of `prChecksRead`.
    const refusal = {
      status: 403,
      message: "Resource not accessible by personal access token",
      at: "2026-09-18T08:00:00.000Z",
    };
    expect(mapPrChecksUnread(pr({ checksUnread: refusal }))).toEqual(refusal);
    expect(
      mapPrChecksUnread(
        pr({ checksUnread: refusal, checks: { total: 0, passing: 0, failing: 0, pending: 0 } }),
      ),
    ).toBeNull();
    expect(mapPrChecksUnread(pr())).toBeNull();
    expect(mapPrChecksUnread(null)).toBeNull();
  });

  it("F21-7: runs nobody could read degrade to unknown — never to passing", () => {
    // The linker's own count (a drifted check-runs payload).
    expect(
      mapPrChecks(
        pr({ checks: { total: 3, passing: 0, failing: 0, pending: 0, unknown: 3 } }),
      ),
    ).toMatchObject({ state: "unknown", unknown: 3, total: 3 });
    // The belt: counters that do not add up to `total` are short by the
    // difference, whoever wrote them and whether or not they said so.
    expect(
      mapPrChecks(pr({ checks: { total: 3, passing: 1, failing: 0, pending: 0 } })),
    ).toMatchObject({ state: "unknown", unknown: 2 });
    // A drifted `unknown` on the loose persisted object is read tolerantly, and
    // the arithmetic still answers.
    expect(
      mapPrChecks(
        pr({ checks: { total: 2, passing: 0, failing: 0, pending: 0, unknown: "lots" } }),
      ),
    ).toMatchObject({ state: "unknown", unknown: 2 });
    // Real failures and real running checks still outrank it.
    expect(
      mapPrChecks(
        pr({ checks: { total: 3, passing: 0, failing: 1, pending: 0, unknown: 2 } }),
      ),
    ).toMatchObject({ state: "failing" });
    expect(
      mapPrChecks(
        pr({ checks: { total: 3, passing: 0, failing: 0, pending: 1, unknown: 2 } }),
      ),
    ).toMatchObject({ state: "pending" });
    // A complete, clean read is still green.
    expect(
      mapPrChecks(pr({ checks: { total: 2, passing: 2, failing: 0, pending: 0 } })),
    ).toMatchObject({ state: "passing", unknown: 0 });
  });

  it("null when there is nothing honest to draw", () => {
    expect(mapPrChecks(null)).toBeNull();
    // Never read (the key is absent) is NOT "green".
    expect(mapPrChecks(pr())).toBeNull();
    // A repo with no CI must not render a passing pill off zero checks.
    expect(
      mapPrChecks(pr({ checks: { total: 0, passing: 0, failing: 0, pending: 0 } })),
    ).toBeNull();
  });

  it("the review verdict only shows while the PR is open or merge-pending", () => {
    expect(mapPrReview(pr({ review: "changes_requested" }))).toBe("changes_requested");
    expect(mapPrReview(pr({ state: "accepted", review: "approved" }))).toBe("approved");
    // Stale by construction next to a merged/closed PR pill.
    expect(mapPrReview(pr({ state: "merged", review: "approved" }))).toBeNull();
    expect(mapPrReview(pr({ state: "closed", review: "review_required" }))).toBeNull();
    expect(mapPrReview(pr())).toBeNull();
    expect(mapPrReview(null)).toBeNull();
  });

  it("mapTaskProjectionRow threads both onto the summary the UI renders", () => {
    const summary = summarize(
      row({
        pr_json: JSON.stringify({
          number: 318,
          state: "review",
          title: "PR",
          checks: { total: 3, passing: 1, failing: 2, pending: 0 },
          review: "changes_requested",
        }),
      }),
      false,
    );
    expect(summary.prChecks).toMatchObject({ state: "failing", failing: 2, total: 3 });
    expect(summary.prReview).toBe("changes_requested");
  });
});

/**
 * F19-27 — the STAGE gate the task file cannot answer. `blockReason` covers the
 * closed-PR / revision / verdict / packet / conflicting-PR refusals; the one it
 * deliberately leaves out is `acceptanceStageBlockedReason`, which turns on the
 * PROJECT's workflow graph. Projected here so the board's accept dialog can
 * name it instead of letting the click reach a 409.
 */
describe("isAtAcceptanceBoundary mirrors the server's stage gate", () => {
  it("accepts from the stage with a declared edge into the terminal one", () => {
    expect(isAtAcceptanceBoundary("review", STAGES, WORKFLOW)).toBe(true);
  });

  it("refuses every stage the workflow puts before that boundary", () => {
    expect(isAtAcceptanceBoundary("triage", STAGES, WORKFLOW)).toBe(false);
    expect(isAtAcceptanceBoundary("ready", STAGES, WORKFLOW)).toBe(false);
  });

  it("honors a custom graph with a SECOND edge into the terminal stage", () => {
    // The server allows any declared edge into terminal, not just the resolved
    // review stage — refusing this would be the forked mapping rulings 12/14 ban.
    expect(
      isAtAcceptanceBoundary("ready", STAGES, [
        ...WORKFLOW,
        { from: "ready", to: "done" },
      ]),
    ).toBe(true);
  });

  it("falls back positionally when the project declares no edges at all", () => {
    // resolveStageRoles' own fallback: review = the stage before terminal.
    expect(isAtAcceptanceBoundary("review", STAGES, [])).toBe(true);
    expect(isAtAcceptanceBoundary("ready", STAGES, [])).toBe(false);
  });

  it("refuses nothing when the task is already terminal, or there are no stages", () => {
    // The writers' idempotent "already Done" return owns the first; a projected
    // `false` would put a refusal on a click the server accepts.
    expect(isAtAcceptanceBoundary("done", STAGES, WORKFLOW)).toBe(true);
    expect(isAtAcceptanceBoundary("review", [], [])).toBe(true);
  });

  it("threads onto the summary the board renders", () => {
    expect(summarize(row({ stage: "review" }), false).atAcceptanceBoundary).toBe(
      true,
    );
    expect(summarize(row({ stage: "triage" }), false).atAcceptanceBoundary).toBe(
      false,
    );
  });
});

describe("the operator card names the stage it was assigned at (F7-UI2)", () => {
  it("renders the real stage NAME, not an index", () => {
    expect(
      summarize(row({ operator_json: JSON.stringify({ assignedAtStageId: "ready" }) }), false)
        .operator,
    ).toEqual({
      name: "Operator",
      assignedAtStageId: "ready",
      sinceStageIndex: 2,
      sinceLabel: "since Ready",
    });
  });

  it("an unknown/removed stage id renders an honest dash", () => {
    expect(
      summarize(row({ operator_json: JSON.stringify({ assignedAtStageId: "ghost" }) }), false)
        .operator,
    ).toMatchObject({ sinceStageIndex: null, sinceLabel: "since a removed stage" });
  });

  it("no operator maps to null", () => {
    expect(summarize(row(), false).operator).toBeNull();
  });
});

/**
 * Owner report 2026-08-21: the Developer profile was switched to Claude but
 * the task page's Delivering-agent card still said "Codex". The engagement
 * rows snapshot the backend at engage time and the run start heals them only
 * when the next run happens — so display must overlay the LIVE deployment's
 * backend (the one Run actually launches), keeping the snapshot solely for
 * profiles no longer deployed.
 */
describe("withLiveAgentIdentities (live deployment wins over the engage-time snapshot)", () => {
  const engaged = (profileId: string, backend: "codex" | "claude") =>
    ({ profileId, backend, role: "Implementation" });
  const base = () =>
    summarize(
      row({
        specialist_json: JSON.stringify(engaged("developer", "codex")),
        reviewers_json: JSON.stringify([engaged("reviewer", "codex")]),
      }),
      false,
    );
  const identities = (entries: [string, LiveAgentIdentity][]) =>
    new Map<string, LiveAgentIdentity>(entries);

  it("patches specialist AND reviewers to the deployed backend — name included — and carries the profile's name", () => {
    const live = identities([
      ["developer", { backend: "claude", name: "Developer" }],
      ["reviewer", { backend: "claude", name: "Reviewer" }],
    ]);
    const out = withLiveAgentIdentities(base(), live);
    expect(out.specialist).toMatchObject({
      backend: "claude",
      name: "Claude",
      profileName: "Developer",
    });
    expect(out.reviewers[0]).toMatchObject({
      backend: "claude",
      name: "Claude",
      profileName: "Reviewer",
    });
  });

  it("the engagement row stores no name: a fresh render reads profileName null until the overlay", () => {
    // The board card falls back to the role for exactly this null (an
    // undeployed profile never gets a live name).
    expect(base().specialist).toMatchObject({ profileName: null, role: "Implementation" });
  });

  it("F27-B1: a PINNED engagement keeps its backend — a stuck retry pin wins over the live deployment — but still takes the profile's name", () => {
    // The engagement was switched to Codex by a retry and PINNED there; the
    // profile is now Claude. The run resolves to the pin, so the card must too:
    // the overlay must NOT patch a pinned agent to the live Claude. The pin
    // says nothing about what the profile is called.
    const pinned = summarize(
      row({
        specialist_json: JSON.stringify({
          profileId: "developer",
          backend: "codex",
          role: "Implementation",
          pinnedBackend: "codex",
        }),
        reviewers_json: JSON.stringify([]),
      }),
      false,
    );
    const live = identities([["developer", { backend: "claude", name: "Developer" }]]);
    expect(withLiveAgentIdentities(pinned, live).specialist).toMatchObject({
      backend: "codex",
      name: "Codex",
      profileName: "Developer",
    });
  });

  it("a profile absent from the map (undeployed since engagement) keeps its snapshot, name and all", () => {
    const out = withLiveAgentIdentities(
      base(),
      identities([["someone-else", { backend: "claude", name: "Someone" }]]),
    );
    expect(out.specialist).toMatchObject({ backend: "codex", name: "Codex", profileName: null });
    expect(out.reviewers[0]).toMatchObject({ backend: "codex", name: "Codex", profileName: null });
  });

  it("an agreeing map returns the summary UNCHANGED (same reference)", () => {
    const live = identities([
      ["developer", { backend: "codex", name: "Developer" }],
      ["reviewer", { backend: "codex", name: "Reviewer" }],
    ]);
    // The first pass writes the names; a second pass with the same map has
    // nothing to change and hands back the same object.
    const summary = withLiveAgentIdentities(base(), live);
    expect(withLiveAgentIdentities(summary, live)).toBe(summary);
    expect(withLiveAgentIdentities(summary, new Map())).toBe(summary);
  });

  it("an unengaged task passes through", () => {
    const summary = summarize(row(), false);
    const live = identities([["developer", { backend: "claude", name: "Developer" }]]);
    expect(withLiveAgentIdentities(summary, live)).toBe(summary);
  });
});

/**
 * Ruling 225 (F37-45): the card names the instant a clock-resting task picks
 * itself back up. The read boundary is where a corrupt value must stop, the
 * same rule `parseTaskLabels` follows.
 */
describe("resumesAt: the schedule a clock-resting task picks itself back up on", () => {
  const occurrence = (dueAt: string, status: string) => ({
    id: `sch_${dueAt}`,
    action: "run-operator",
    dueAt,
    status,
  });
  const resumesAt = (schedulesJson: string, waiting: TaskProjectionRow["waiting"] = "schedule") =>
    summarize(row({ waiting, schedules_json: schedulesJson }), false).resumesAt;

  it("answers the occurrence that fires NEXT, not the one listed first", () => {
    expect(
      resumesAt(
        JSON.stringify([
          occurrence("2026-09-14T06:00:00.000Z", "pending"),
          occurrence("2026-09-14T02:28:00.000Z", "pending"),
        ]),
      ),
    ).toBe("2026-09-14T02:28:00.000Z");
  });

  it("ignores occurrences that already fired", () => {
    expect(
      resumesAt(
        JSON.stringify([
          occurrence("2026-09-13T08:19:58.271Z", "fired"),
          occurrence("2026-09-14T02:28:00.000Z", "pending"),
        ]),
      ),
    ).toBe("2026-09-14T02:28:00.000Z");
    expect(resumesAt(JSON.stringify([occurrence("2026-09-13T08:19:58.271Z", "fired")]))).toBeNull();
  });

  it("yields no time rather than throwing on a value it cannot read", () => {
    expect(resumesAt("not json")).toBeNull();
    expect(resumesAt("[]")).toBeNull();
    expect(resumesAt(JSON.stringify([{ nonsense: true }]))).toBeNull();
    expect(resumesAt(JSON.stringify([occurrence("whenever", "pending")]))).toBeNull();
  });

  it("is null while the task waits on anything but its schedule", () => {
    const pending = JSON.stringify([occurrence("2026-09-14T02:28:00.000Z", "pending")]);
    expect(resumesAt(pending, "human")).toBeNull();
  });
});

describe("ruling 349: withLiveRun reads the run row into the display state", () => {
  // A summary the mapper itself derived, so the test reads the real
  // `agent_working` and not a hand-written one.
  const agentCarried = summarize(row({ waiting: "agent", readiness: "ready" }), false);
  expect(agentCarried.displayReadiness).toBe("agent_working");

  it("downgrades 'agent working' to 'agent queued' while the run is parked behind the cap", () => {
    // Live before the fix: 129 queued runs across 33 tasks on one instance,
    // each one a card saying "agent working" with a pulsing dot while the
    // timeline said "Nothing is streaming yet". CANARY: return the task's own
    // displayReadiness whatever `liveRun` says.
    const queued = withLiveRun(agentCarried, "queued");
    expect(queued.displayReadiness).toBe("agent_queued");
    expect(queued.liveRun).toBe("queued");
  });

  it("keeps 'agent working' for a running run, and for a row it cannot see", () => {
    expect(withLiveRun(agentCarried, "running").displayReadiness).toBe("agent_working");
    expect(withLiveRun(agentCarried, null).displayReadiness).toBe("agent_working");
  });

  it("touches no other display state — a queued run under a human wait is still that wait", () => {
    const human = summarize(row({ waiting: "human", readiness: "input_required" }), false);
    expect(human.displayReadiness).toBe("input_required");
    expect(withLiveRun(human, "queued").displayReadiness).toBe("input_required");
  });
});

/**
 * Ruling 405(b): every surface reads the verdict's head pin, or two of them
 * disagree.
 *
 * `conflictingPrBlockedReason` (the acceptance gate), the GitHub page and the
 * review queue all go through this mapping. The task page did NOT -- it read
 * `task.pr.mergeable` raw -- so a conflict measured on a commit that has since
 * been superseded would still paint "conflicts" there while the gate let the
 * task through. Found by checking my own fix's consumers, which is the third
 * time this pass a change reached some of them and not all.
 */
describe("ruling 405(b): mapPrMergeable honours the head the verdict was measured on", () => {
  const pr = (mergeable: "conflicting" | "clean", at: string | null, headSha: string) => {
    const ref = {
      number: 15,
      state: "review" as const,
      title: "[VIB-1] work",
      mergeable,
      headSha,
    };
    if (at) return { ...ref, mergeableAt: at };
    return ref;
  };

  it("shows a conflict measured on the head that is live", () => {
    expect(mapPrMergeable(pr("conflicting", "e763b9f", "e763b9f"))).toBe("conflicting");
  });

  it("shows NOTHING once the head has moved past the commit it was measured on", () => {
    // CANARY: drop the pin check and this returns "conflicting" -- the pill
    // the task page used to paint over the commit that fixed it.
    expect(mapPrMergeable(pr("conflicting", "e763b9f", "d20be15"))).toBeNull();
  });

  it("still shows an unpinned verdict, so an old file is not silently cleared", () => {
    expect(mapPrMergeable(pr("conflicting", null, "d20be15"))).toBe("conflicting");
  });
});
