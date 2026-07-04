import { describe, expect, it } from "vitest";
import type { ParsedTaskFile } from "~/schemas/task-file.schema";
import { parseTaskFileContent, serializeTaskFile } from "./task-file.server";

/**
 * Round-trip contract: parse → write → parse identical, covering all 9
 * event types from contracts §1.3 (comment incl. `to: agent`, completion
 * incl. title + evidence, github, policy, quality, transition, blocked,
 * agent/operator, assign) plus packet, unknown frontmatter and unknown
 * sections.
 */

const FULL: ParsedTaskFile = {
  frontmatter: {
    key: "VIB-142",
    title: "Attach execution workspace to task runtime",
    stage: "review",
    readiness: "input_required",
    waiting: "human",
    ownerUserId: "u_arda01",
    specialist: { profileId: "developer", backend: "codex", role: "Developer" },
    consultants: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
    operator: { assignedAtStageId: "triage" },
    urgent: true,
    validation: "changed",
    branch: "vib-142-attach-workspace",
    repo: null,
    pr: { number: 318, state: "review", title: "Attach execution workspace" },
    github: {
      commits: [{ sha: "a91f7c2", msg: "[VIB-142] add repo attach policy gate" }],
      changed: { files: 9, add: 412, del: 87 },
    },
    createdAt: "2026-07-03T06:00:00.000Z",
    updatedAt: "2026-07-04T06:58:00.000Z",
  },
  unknownFrontmatter: { futureField: "preserved", nested: { a: [1, 2] } },
  goal: "Let the operator attach a single GitHub repo to a task, create the task-key branch, and reflect branch + PR state back into the canonical task file without treating GitHub as the source of truth.",
  packet: {
    type: "input",
    kind: "Completion report",
    from: "operator",
    title: "Accept completion, or send back for one fix?",
    body: "The developer specialist reports the workspace attach flow is implemented — but the PAT used in the run is missing `pull_request:write`.",
    observations: [
      { k: "Changed", v: "9 files · +412 / −87", code: true },
      { k: "Flag", v: "PAT scope missing pull_request:write", code: false },
    ],
    options: [
      { kind: "accept_completion", t: "Accept completion", d: "Mark task done and merge the review PR. Human-authorized.", rec: true, accept: true },
      { kind: "request_edit", t: "Request one edit", d: "Ask the developer to widen PAT scope.", rec: false, ev: "**Decision:** request one edit." },
      { kind: "block_on_policy", t: "Block on policy", d: "Hold until policy updates.", rec: false },
    ],
  },
  timeline: [
    { occurredAt: "2026-07-04T06:58:00.000Z", type: "comment", actor: { kind: "human", userId: "u_arda01", nameHint: "Arda Kaya" }, title: null, toAgent: true, evidence: null,
      text: "@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task." },
    { occurredAt: "2026-07-04T06:41:00.000Z", type: "completion", actor: { kind: "agent", backend: "codex", role: "Developer" }, title: "Completion report", toAgent: false,
      text: "Implemented repo attach, branch creation, and PR-sync projection.",
      evidence: [
        { label: "unit/policy_gate_test", add: "+14", del: "0" },
        { label: "integration/pr_sync_test", add: "+38", del: "−4" },
      ] },
    { occurredAt: "2026-07-04T06:39:00.000Z", type: "github", actor: { kind: "agent", backend: "codex", role: "Developer" }, title: null, toAgent: false, evidence: null,
      text: "Opened **PR #318** from `vib-142-attach-workspace` into `main`." },
    { occurredAt: "2026-07-04T06:38:00.000Z", type: "policy", actor: { kind: "system", systemId: "policy-engine" }, title: null, toAgent: false, evidence: null,
      text: "**Policy violation:** active PAT is missing `pull_request:write`." },
    { occurredAt: "2026-07-04T06:20:00.000Z", type: "quality", actor: { kind: "agent", backend: "claude", role: "Reviewer" }, title: null, toAgent: false, evidence: null,
      text: "**Quality flag:** snapshot `task_projection.json` changed — confirm the new compact shape." },
    { occurredAt: "2026-07-04T06:02:00.000Z", type: "transition", actor: { kind: "operator" }, title: null, toAgent: false, evidence: null,
      text: "**Transition request:** move VIB-142 from In Progress to Review." },
    { occurredAt: "2026-07-04T05:31:00.000Z", type: "blocked", actor: { kind: "operator" }, title: null, toAgent: false, evidence: null,
      text: "**Blocked decision:** recovery packet raised for human review." },
    { occurredAt: "2026-07-04T05:30:00.000Z", type: "agent", actor: { kind: "operator" }, title: null, toAgent: false, evidence: null,
      text: "Re-engaged **Claude Code (Reviewer)** as consultant; re-anchored on `task.md` before review." },
    { occurredAt: "2026-07-03T12:12:00.000Z", type: "assign", actor: { kind: "human", userId: "u_arda01", nameHint: "Arda Kaya" }, title: null, toAgent: false, evidence: null,
      text: "Took task ownership — owner is the human reviewer and acceptance authority for this task." },
  ],
  extraSections: [{ title: "Notes", raw: "Free-form section humans may add — preserved verbatim." }],
};

describe("task.md round-trip", () => {
  it("parse(write(x)) is structurally identical to x — all 9 event types", () => {
    const text = serializeTaskFile(FULL);
    const { parsed, diagnostics } = parseTaskFileContent(text, {
      fallbackKey: "VIB-142",
    });
    expect(diagnostics).toEqual([]);
    expect(parsed.frontmatter).toEqual(FULL.frontmatter);
    expect(parsed.unknownFrontmatter).toEqual(FULL.unknownFrontmatter);
    expect(parsed.goal).toBe(FULL.goal);
    expect(parsed.packet).toEqual(FULL.packet);
    expect(parsed.timeline).toEqual(FULL.timeline);
    expect(parsed.extraSections).toEqual(FULL.extraSections);
  });

  it("write(parse(write(x))) is byte-identical (stable serialization)", () => {
    const first = serializeTaskFile(FULL);
    const { parsed } = parseTaskFileContent(first, { fallbackKey: "VIB-142" });
    expect(serializeTaskFile(parsed)).toBe(first);
  });

  it("clearing the packet removes the section; round-trip still holds", () => {
    const noPacket = { ...FULL, packet: null };
    const text = serializeTaskFile(noPacket);
    expect(text).not.toContain("## Packet");
    const { parsed } = parseTaskFileContent(text, { fallbackKey: "VIB-142" });
    expect(parsed.packet).toBeNull();
  });

  it("empty timeline keeps the section heading for appenders", () => {
    const empty = { ...FULL, timeline: [], packet: null, extraSections: [] };
    const text = serializeTaskFile(empty);
    expect(text).toContain("## Timeline");
    const { parsed } = parseTaskFileContent(text, { fallbackKey: "VIB-142" });
    expect(parsed.timeline).toEqual([]);
  });
});

describe("task.md tolerant parsing", () => {
  it("malformed timeline entry is skipped with a diagnostic — task survives", () => {
    const text = serializeTaskFile(FULL).replace(
      "### 2026-07-04T06:39:00.000Z · github · agent:codex/developer",
      "### not-a-timestamp %% garbage",
    );
    const { parsed, diagnostics } = parseTaskFileContent(text, {
      fallbackKey: "VIB-142",
    });
    expect(parsed.timeline).toHaveLength(FULL.timeline.length - 1);
    expect(
      diagnostics.some((d) => d.code === "timeline.malformed_heading"),
    ).toBe(true);
  });

  it("unknown event types are kept as-is with an info diagnostic", () => {
    const text = serializeTaskFile({
      ...FULL,
      packet: null,
      extraSections: [],
      timeline: [
        { occurredAt: "2026-07-04T06:00:00.000Z", type: "escalation", actor: { kind: "operator" }, title: null, toAgent: false, evidence: null, text: "Future event type." },
      ],
    });
    const { parsed, diagnostics } = parseTaskFileContent(text, {
      fallbackKey: "VIB-142",
    });
    expect(parsed.timeline[0]?.type).toBe("escalation");
    expect(diagnostics.some((d) => d.code === "timeline.unknown_type")).toBe(true);
  });

  it("a file without frontmatter still yields a task (hard stop diagnostic)", () => {
    const { parsed, diagnostics } = parseTaskFileContent("just prose\n", {
      fallbackKey: "VIB-3",
    });
    expect(parsed.frontmatter.key).toBe("VIB-3");
    expect(diagnostics.some((d) => d.hardStop)).toBe(true);
  });
});
