import { describe, expect, it } from "vitest";
import YAML from "yaml";
import type { YamlMapping } from "~/server/files/frontmatter.server";
import { parseTaskFileContent } from "~/server/files/task-file.server";
import {
  acceptanceBlockedReason,
  deriveValidation,
  nextWorkRevision,
  parseTaskFrontmatter,
  requiredReviewers,
  sanitizeEventAttachmentNames,
  type Engagement,
  type ReviewVerdict,
  type WorkRevision,
} from "./task-file.schema";

describe("revision-bound review helpers (F10-15/F10-32)", () => {
  const rev1: WorkRevision = {
    id: "rev_1",
    headSha: "a".repeat(40),
    treeSha: "t1".padEnd(40, "0"),
    branch: "vib-1",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "developer",
  };
  const deliverer: Engagement = {
    profileId: "developer",
    backend: "claude",
    role: "developer",
    delivers: true,
    verdictCapable: false,
  };
  const reviewerA: Engagement = {
    profileId: "reviewer",
    backend: "claude",
    role: "Review",
    delivers: false,
    verdictCapable: true,
  };
  const reviewerB: Engagement = {
    profileId: "qa",
    backend: "codex",
    role: "QA",
    delivers: false,
    verdictCapable: true,
  };
  const nonVerdictReviewer: Engagement = {
    profileId: "docs",
    backend: "claude",
    role: "Docs",
    delivers: false,
    verdictCapable: false,
  };
  const verdict = (
    profileId: string,
    result: ReviewVerdict["result"],
    revisionId = "rev_1",
  ): ReviewVerdict => ({
    profileId,
    revisionId,
    headSha: "a".repeat(40),
    result,
    reason: "",
    at: "2026-07-04T01:00:00.000Z",
  });

  it("requiredReviewers = supporting AND verdict-capable only", () => {
    const fm = { engagements: [deliverer, reviewerA, nonVerdictReviewer] };
    expect(requiredReviewers(fm).map((r) => r.profileId)).toEqual(["reviewer"]);
  });

  it("deriveValidation: none without a revision", () => {
    expect(
      deriveValidation({ engagements: [reviewerA], workRevision: null, verdicts: [] }),
    ).toBe("none");
  });

  it("deriveValidation: request_changes on the current revision → failing", () => {
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
      }),
    ).toBe("failing");
  });

  it("deriveValidation: a same-revision approve does NOT mask another reviewer's rejection", () => {
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA, reviewerB],
        workRevision: rev1,
        verdicts: [
          verdict("reviewer", "request_changes"),
          verdict("qa", "approve"),
        ],
      }),
    ).toBe("failing");
  });

  // F19-27 — live-caught on VC-9: a verification-only task accepted through the
  // R19-8 no-change path sat in Done, pill "accepted", wearing "awaiting
  // verdict" on its board card. It has a work revision (its empty branch) and
  // no required reviewer, so the old fall-through returned `changed`. Nobody
  // owed that verdict; the task was closed.
  it("deriveValidation: a no-change completion owes no verdict — none, not 'awaiting verdict'", () => {
    // The exact VC-9 shape: an empty branch, a deliverer, no required reviewer.
    expect(
      deriveValidation({
        engagements: [deliverer],
        workRevision: rev1,
        verdicts: [],
        noChanges: true,
      }),
    ).toBe("none");
    // Same shape WITHOUT the flag still reports the pending state, so the fix
    // is scoped to a verified no-change completion and nothing else.
    expect(
      deriveValidation({ engagements: [deliverer], workRevision: rev1, verdicts: [] }),
    ).toBe("changed");
  });

  it("deriveValidation: a no-change flag never erases a reviewer's APPROVAL", () => {
    // The R19-8 review path mints a verification revision and binds a real
    // verdict to it. That approval is evidence — reporting "none" there would
    // throw away the only signal the acceptance gate has.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
        noChanges: true,
      }),
    ).toBe("healthy");
  });

  it("deriveValidation: a no-change flag never hides a recorded request-changes", () => {
    // Defensive ordering: an empty diff should not be able to carry a rejection,
    // but if one is on the record it outranks the flag rather than vanishing.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
        noChanges: true,
      }),
    ).toBe("failing");
  });

  it("deriveValidation: a force-accept overrides the pending state with 'bypassed' (N20-14/§5c)", () => {
    // The N20-14 repro: a delivered revision with no verdict recorded derives
    // "changed" (= "awaiting verdict"). Once a human force-accepts past the gate,
    // the durable `acceptance: "forced"` fact is the truth — the task is Done
    // because the gate was bypassed, not because a verdict landed.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [],
        acceptance: "forced",
      }),
    ).toBe("bypassed");
    // Canary: without the fact the same shape stays "changed" (awaiting verdict),
    // so the escape is scoped to a real force-accept and nothing else.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [],
      }),
    ).toBe("changed");
  });

  it("deriveValidation: a force-accept never erases a recorded verdict (N20-14)", () => {
    // The bypass fact yields to real evidence, exactly as the no-change arm does:
    // an approval stays "healthy" and a request-changes stays "failing" even on a
    // force-accepted task, so whoever reads it still sees the review that
    // actually happened.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
        acceptance: "forced",
      }),
    ).toBe("healthy");
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
        acceptance: "forced",
      }),
    ).toBe("failing");
  });

  it("deriveValidation: healthy only when EVERY required reviewer approves the current revision", () => {
    const base = { engagements: [deliverer, reviewerA, reviewerB], workRevision: rev1 };
    // Only one of two approved → still changed (pending).
    expect(deriveValidation({ ...base, verdicts: [verdict("reviewer", "approve")] })).toBe("changed");
    // Both approved → healthy.
    expect(
      deriveValidation({
        ...base,
        verdicts: [verdict("reviewer", "approve"), verdict("qa", "approve")],
      }),
    ).toBe("healthy");
  });

  it("deriveValidation: a NEW revision makes prior verdicts stale (F10-32)", () => {
    const rev2: WorkRevision = { ...rev1, id: "rev_2", treeSha: "t2".padEnd(40, "0") };
    // The approve targeted rev_1; against rev_2 it's stale → changed, not healthy.
    expect(
      deriveValidation({
        engagements: [deliverer, reviewerA],
        workRevision: rev2,
        verdicts: [verdict("reviewer", "approve", "rev_1")],
      }),
    ).toBe("changed");
  });

  it("acceptanceBlockedReason: blocks on request_changes, missing approvals, and no revision", () => {
    // No revision + a required reviewer → blocked.
    expect(
      acceptanceBlockedReason({ engagements: [reviewerA], workRevision: null, verdicts: [] }),
    ).toMatch(/no reviewed revision/i);
    // request_changes on current revision → blocked.
    expect(
      acceptanceBlockedReason({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "request_changes")],
      }),
    ).toMatch(/requests changes/i);
    // A required reviewer hasn't approved → blocked.
    expect(
      acceptanceBlockedReason({
        engagements: [deliverer, reviewerA, reviewerB],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
      }),
    ).toMatch(/waiting on 1 required reviewer/i);
    // All required reviewers approved current revision → null (allowed).
    expect(
      acceptanceBlockedReason({
        engagements: [deliverer, reviewerA],
        workRevision: rev1,
        verdicts: [verdict("reviewer", "approve")],
      }),
    ).toBeNull();
    // No revision AND no required reviewers → allowed (planning / non-repo work).
    expect(
      acceptanceBlockedReason({ engagements: [], workRevision: null, verdicts: [] }),
    ).toBeNull();
  });

  it("F19-21: the no-revision refusal names the way OUT of it", () => {
    // Live (VC-5) this refusal was a dead end on a verification-only task:
    // nothing that task would ever do produces a revision, so "nothing to
    // approve" read as permanent and the remaining exits were force-accept,
    // archive, or an operator packet recommending "manually mark Done" — the
    // ceremony bypass R17-2 exists to prevent. Running delivery once IS the
    // path: it inspects the workspace and records the verified no-change
    // outcome, minting the base revision these reviewers then approve.
    const reason = acceptanceBlockedReason({
      engagements: [reviewerA],
      workRevision: null,
      verdicts: [],
    });
    expect(reason).toContain("run delivery once to verify and record that");
    // Still the same refusal first — the guidance is an addition, not a swap.
    expect(reason).toMatch(/^No reviewed revision yet/);
  });

  it("nextWorkRevision: same tree = same subject (no invalidation); different tree = new revision", () => {
    const same = nextWorkRevision(rev1, {
      id: "rev_x",
      headSha: "b".repeat(40), // different head, SAME tree
      treeSha: rev1.treeSha,
      branch: "vib-1",
      sourceProfileId: "developer",
      createdAt: "2026-07-05T00:00:00.000Z",
    });
    expect(same.changed).toBe(false);
    expect(same.revision.id).toBe("rev_1");

    const diff = nextWorkRevision(rev1, {
      id: "rev_2",
      headSha: "c".repeat(40),
      treeSha: "t2".padEnd(40, "0"),
      branch: "vib-1",
      sourceProfileId: "developer",
      createdAt: "2026-07-05T00:00:00.000Z",
    });
    expect(diff.changed).toBe(true);
    expect(diff.revision.id).toBe("rev_2");
  });
});

/** A frontmatter mapping that parses without diagnostics (the first test
 *  below asserts that) — also the clean scaffold for the packet tests. */
const valid = {
  key: "VIB-142",
  title: "Attach execution workspace to task runtime",
  stage: "review",
  readiness: "input_required",
  waiting: "human",
  ownerUserId: "u_abc",
  engagements: [
    { profileId: "developer", backend: "codex", role: "Developer", delivers: true },
  ],
  operator: { assignedAtStageId: "triage" },
  urgent: true,
  validation: "changed",
  branch: "vib-142-attach-workspace",
  pr: { number: 318, state: "review", title: "Attach execution workspace" },
  github: null,
  createdAt: "2026-07-03T06:00:00.000Z",
  updatedAt: "2026-07-04T06:58:00.000Z",
};

describe("parseTaskFrontmatter (tolerant)", () => {
  /** `valid` without the modern `engagements` key — what a task.md written
   *  before the G1 rename carries, so the legacy slots below are the only
   *  source of engagements. */
  const { engagements: _engagements, ...preG1 } = valid;

  it("parses a fully valid frontmatter without diagnostics", () => {
    const result = parseTaskFrontmatter(valid, { fallbackKey: "VIB-142" });
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.key).toBe("VIB-142");
    expect(result.frontmatter.readiness).toBe("input_required");
    expect(result.frontmatter.urgent).toBe(true);
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
    ]);
    expect(result.unknown).toEqual({});
  });

  it("N20-14: the force-accept `acceptance` fact round-trips (and defaults absent)", () => {
    const bare = parseTaskFrontmatter(valid, { fallbackKey: "VIB-142" });
    expect(bare.diagnostics).toEqual([]);
    expect(bare.frontmatter.acceptance).toBeUndefined();

    const forced = parseTaskFrontmatter(
      { ...valid, acceptance: "forced" },
      { fallbackKey: "VIB-142" },
    );
    expect(forced.diagnostics).toEqual([]);
    expect(forced.frontmatter.acceptance).toBe("forced");

    // An unknown value is tolerated (diagnostic + safe fallback), never a throw.
    const bad = parseTaskFrontmatter(
      { ...valid, acceptance: "waived" },
      { fallbackKey: "VIB-142" },
    );
    expect(bad.frontmatter.acceptance).toBeUndefined();
  });

  it("preserves unknown fields without diagnostics", () => {
    const result = parseTaskFrontmatter(
      { ...valid, futureField: { nested: [1, 2] }, xCustom: "keep me" },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.unknown).toEqual({
      futureField: { nested: [1, 2] },
      xCustom: "keep me",
    });
  });

  it('pr.state is the 4-value enum; unknown strings coerce to "review" (never throw, never drop)', () => {
    // Canonical values pass through untouched.
    for (const state of ["review", "merged", "closed", "accepted"]) {
      const result = parseTaskFrontmatter(
        { ...valid, pr: { number: 318, state, title: "x" } },
        { fallbackKey: "VIB-142" },
      );
      expect(result.frontmatter.pr?.state).toBe(state);
    }
    // A legacy raw GitHub "open" (pre-B3 writes) coerces to "review" instead
    // of dropping the whole PR ref. `pr` is parsed through tolerant(…, null),
    // so a hard enum failure would null the number and title too — the link
    // would then be lost from task.md on the next write.
    const legacy = parseTaskFrontmatter(
      { ...valid, pr: { number: 318, state: "open", title: "x" } },
      { fallbackKey: "VIB-142" },
    );
    expect(legacy.frontmatter.pr).toMatchObject({
      number: 318,
      state: "review",
      title: "x",
    });
    expect(legacy.diagnostics).toEqual([]);
  });

  it("P13-D-28: pr.checks and pr.review are typed, optional, and round-trip", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        pr: {
          number: 318,
          state: "review",
          title: "x",
          checks: { total: 4, passing: 3, failing: 0, pending: 1 },
          review: "changes_requested",
        },
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.pr).toEqual({
      number: 318,
      state: "review",
      title: "x",
      checks: { total: 4, passing: 3, failing: 0, pending: 1 },
      review: "changes_requested",
    });
    // Neither key is invented when absent: a PR ref that has never been
    // reconciled must serialize back byte-identically (no `checks: null` churn
    // on every write, and "absent" stays distinguishable from "read: nothing").
    const bare = parseTaskFrontmatter(valid, { fallbackKey: "VIB-142" });
    expect(Object.keys(bare.frontmatter.pr!)).toEqual(["number", "state", "title"]);
  });

  it("P13-D-28: a garbage pr.review/pr.checks nulls the FIELD, never the whole ref", () => {
    // Same reasoning as `state`: `pr` is read through tolerant(…, null), so an
    // un-caught enum failure would drop number + title + link from task.md.
    const result = parseTaskFrontmatter(
      {
        ...valid,
        pr: { number: 318, state: "review", title: "x", review: "lgtm", checks: 7 },
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.pr).toMatchObject({ number: 318, title: "x" });
    expect(result.frontmatter.pr?.review).toBeNull();
    expect(result.frontmatter.pr?.checks).toBeNull();
  });

  it("P13-D-5: `repo` is no longer a known field — preserved verbatim, never resolved", () => {
    const result = parseTaskFrontmatter(
      { ...valid, repo: "akin-ozer/other-repo" },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    // Not dropped (an existing task.md keeps its line)…
    expect(result.unknown).toEqual({ repo: "akin-ozer/other-repo" });
    // …and not readable as frontmatter — the override is deleted, so no
    // resolver can pick it up again.
    expect("repo" in result.frontmatter).toBe(false);
  });

  // Dynamic-dispatch rework (2026-08-29): the legacy `specialist`/`reviewers`/
  // `consultants` slot absorption is DELETED (preprod, owner's no-back-compat
  // ruling). The three absorption tests that lived here became the two pins
  // below: engagements come ONLY from `engagements:`, and the legacy keys are
  // ordinary unknown keys.
  it("legacy `specialist`/`reviewers`/`consultants` slot keys are never read — engagements come only from `engagements:`", () => {
    const legacy = {
      ...preG1,
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
      consultants: [{ profileId: "old", backend: "codex", role: "Stale" }],
    };
    const result = parseTaskFrontmatter(legacy, { fallbackKey: "VIB-142" });
    // No diagnostic either: an absent `engagements` is an ordinary empty
    // roster, not a parse problem — the legacy keys are simply not consulted.
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.engagements).toEqual([]);
  });

  it("legacy slot keys survive as UNKNOWN keys on round-trip (preserved verbatim, never resolved)", () => {
    // The same contract `repo` pinned above (P13-D-5): a retired key keeps its
    // line in task.md — the parser must not silently EAT it on the next
    // rewrite. Round-trip preservation is exactly the `unknown` record.
    // (This CAUGHT a rework bug: the unknown-key sweep still carried the
    // pre-rework exclusion written for the deleted absorption, so the keys
    // were silently dropped on the next write. The exclusion is gone now.)
    const legacy = {
      ...preG1,
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
      consultants: [{ profileId: "old", backend: "codex", role: "Stale" }],
    };
    const result = parseTaskFrontmatter(legacy, { fallbackKey: "VIB-142" });
    expect(result.unknown).toEqual({
      specialist: { profileId: "developer", backend: "codex", role: "Developer" },
      reviewers: [{ profileId: "reviewer", backend: "claude", role: "Reviewer" }],
      consultants: [{ profileId: "old", backend: "codex", role: "Stale" }],
    });
  });

  it("an explicit `engagements` key wins over leftover legacy slots (no double-count)", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        specialist: { profileId: "stale-dev", backend: "codex", role: "Developer" },
        reviewers: [{ profileId: "stale-reviewer", backend: "claude", role: "Reviewer" }],
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    // Only the `engagements` rows are readable engagements — the legacy slots
    // are never appended (they are unknown keys, pinned above).
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
    ]);
  });

  it("demotes every delivering engagement after the first (single-writer invariant)", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        engagements: [
          { profileId: "developer", backend: "codex", role: "Developer", delivers: true },
          { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: true },
        ],
      },
      { fallbackKey: "VIB-142" },
    );
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
      { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: false, verdictCapable: false },
    ]);
    const demotion = result.diagnostics.find(
      (d) => d.code === "frontmatter.multiple_deliverers",
    );
    expect(demotion?.severity).toBe("warning");
  });

  it("dedupes a profile engaged more than once (profileId-uniqueness, keep first)", () => {
    const result = parseTaskFrontmatter(
      {
        ...valid,
        engagements: [
          { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: true },
          { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: false },
        ],
      },
      { fallbackKey: "VIB-142" },
    );
    // The same profileId corrupts run routing (startAgentRun resolves by the
    // first match) — keep only the first engagement.
    expect(result.frontmatter.engagements).toEqual([
      { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: true, verdictCapable: false },
    ]);
    expect(
      result.diagnostics.find((d) => d.code === "frontmatter.duplicate_engagement")?.severity,
    ).toBe("warning");
  });

  it("missing required fields → warnings + safe fallbacks, never a throw", () => {
    const result = parseTaskFrontmatter({}, { fallbackKey: "VIB-9" });
    expect(result.frontmatter.key).toBe("VIB-9");
    expect(result.frontmatter.title).toBe("VIB-9");
    // A missing stage is NOT invented as `triage` (which would relocate the
    // card): it stays blank + gets an `unresolved_stage` warning, so the board
    // shows it as an unknown stage instead of moving it.
    expect(result.frontmatter.stage).toBe("");
    expect(result.frontmatter.readiness).toBe("ready");
    expect(result.frontmatter.waiting).toBe("none");
    expect(result.frontmatter.urgent).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("frontmatter.missing_key");
    expect(codes).toContain("frontmatter.missing_field");
    expect(codes).toContain("frontmatter.unresolved_stage");
    expect(result.diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  it("broken/invalid stage → blank marker + unresolved_stage warning (no `triage` relocation)", () => {
    // A present-but-unparseable stage (empty string here; also non-strings)
    // must NOT jump to a hardcoded `triage`. It falls back to a blank stage so
    // the projection parks the card in the board's unknown-stage bucket.
    const result = parseTaskFrontmatter(
      { ...valid, stage: "" },
      { fallbackKey: "VIB-142" },
    );
    expect(result.frontmatter.stage).toBe("");
    const stageDiag = result.diagnostics.find((d) => d.path === "stage");
    expect(stageDiag?.code).toBe("frontmatter.unresolved_stage");
    // Warning severity → floors readiness at input_required (never invents a
    // healthier state); it is not an integrity error.
    expect(stageDiag?.severity).toBe("warning");
  });

  it("invalid enum values → warning diagnostics with field paths", () => {
    const result = parseTaskFrontmatter(
      { ...valid, readiness: "done", waiting: "everyone", validation: 42 },
      { fallbackKey: "VIB-142" },
    );
    expect(result.frontmatter.readiness).toBe("ready"); // fallback
    expect(result.frontmatter.waiting).toBe("none");
    expect(result.frontmatter.validation).toBe("none");
    const paths = result.diagnostics.map((d) => d.path);
    expect(paths).toContain("readiness");
    expect(paths).toContain("waiting");
    expect(paths).toContain("validation");
  });

  it("key mismatch with directory → directory wins + error diagnostic", () => {
    const result = parseTaskFrontmatter(valid, { fallbackKey: "VIB-999" });
    expect(result.frontmatter.key).toBe("VIB-999");
    const diag = result.diagnostics.find(
      (d) => d.code === "frontmatter.key_mismatch",
    );
    expect(diag?.severity).toBe("error");
  });

  it("non-mapping frontmatter → hard stop + all defaults", () => {
    const result = parseTaskFileContent("---\njust a string\n---\n", {
      fallbackKey: "VIB-7",
    });
    expect(result.parsed.frontmatter.key).toBe("VIB-7");
    expect(result.diagnostics.some((d) => d.hardStop)).toBe(true);
  });

  it("absent urgent stays false with NO diagnostic (optional by contract)", () => {
    const { urgent: _urgent, ...withoutUrgent } = valid;
    const result = parseTaskFrontmatter(withoutUrgent, {
      fallbackKey: "VIB-142",
    });
    expect(result.frontmatter.urgent).toBe(false);
    expect(result.diagnostics.filter((d) => d.path === "urgent")).toEqual([]);
  });
});

describe("packet block parse (tolerant)", () => {
  /** Routes a packet value through a full task.md parse — the packet decode
   *  lives at the file boundary in `parsePacketSection` (task-file.server.ts),
   *  under a scaffold (`valid` frontmatter, goal, timeline) that contributes
   *  no diagnostics of its own. */
  const parsePacket = (packet: YamlMapping | null) => {
    const content = [
      "---",
      YAML.stringify(valid).trimEnd(),
      "---",
      "",
      "## Goal",
      "",
      "g",
      "",
      "## Packet",
      "",
      "```yaml",
      YAML.stringify(packet).trimEnd(),
      "```",
      "",
      "## Timeline",
      "",
    ].join("\n");
    const { parsed, diagnostics } = parseTaskFileContent(content, {
      fallbackKey: "VIB-142",
    });
    return { packet: parsed.packet, diagnostics };
  };

  it("valid packet parses with option kinds intact", () => {
    const { packet, diagnostics } = parsePacket({
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "Accept completion, or send back for one fix?",
      body: "…",
      observations: [{ k: "Changed", v: "9 files", code: true }],
      options: [
        { kind: "accept_completion", t: "Accept completion", d: "", rec: true, accept: true },
        { kind: "request_edit", t: "Request one edit", d: "", rec: false, ev: "**Decision:** …" },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(packet?.options[0]?.kind).toBe("accept_completion");
    expect(packet?.options[1]?.ev).toBe("**Decision:** …");
  });

  it("F20-6: a discard_branch option parses with its kind intact", () => {
    const { packet, diagnostics } = parsePacket({
      type: "input",
      kind: "Completion report",
      title: "Discard the empty branch, or refine the goal?",
      options: [
        { kind: "discard_branch", t: "Discard the empty vib-2 branch", d: "", rec: true },
        { kind: "edit_goal", t: "Refine the goal", d: "", rec: false },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(packet?.options[0]?.kind).toBe("discard_branch");
  });

  it("F20-6: an unknown option kind still rejects the packet", () => {
    const { packet, diagnostics } = parsePacket({
      type: "input",
      kind: "Completion report",
      title: "t",
      options: [{ kind: "delete_everything", t: "nuke", d: "", rec: true }],
    });
    expect(packet).toBeNull();
    expect(diagnostics[0]?.code).toBe("packet.invalid");
  });

  it("invalid packet → null + error diagnostic (never a throw)", () => {
    const { packet, diagnostics } = parsePacket({ type: "nope" });
    expect(packet).toBeNull();
    expect(diagnostics[0]?.code).toBe("packet.invalid");
  });

  it("zero or multiple recommended options → info diagnostic", () => {
    const { diagnostics } = parsePacket({
      type: "blocked",
      kind: "Blocked decision",
      title: "t",
      options: [
        { kind: "redirect", t: "a", rec: true },
        { kind: "redirect", t: "b", rec: true },
      ],
    });
    expect(diagnostics.some((d) => d.code === "packet.rec_count")).toBe(true);
  });

  it("null/undefined → no packet, no diagnostics", () => {
    expect(parsePacket(null)).toEqual({ packet: null, diagnostics: [] });
  });
});

describe("sanitizeEventAttachmentNames (P21)", () => {
  it("keeps clean names, drops separators/control chars, dedupes, caps at 20", () => {
    const names = [
      "page-2026-08-19T17-38-40-756Z.png",
      "page-2026-08-19T17-38-40-756Z.png", // duplicate
      "../traversal.png",
      "nested/inside.png",
      "back\\slash.png",
      "forged\nrow.png",
      " padded.png", // trims differently — cannot round-trip
      "",
      "ok two words.yml",
    ];
    expect(sanitizeEventAttachmentNames(names)).toEqual([
      "page-2026-08-19T17-38-40-756Z.png",
      "ok two words.yml",
    ]);
    const many = Array.from({ length: 30 }, (_, i) => `shot-${i}.png`);
    expect(sanitizeEventAttachmentNames(many)).toHaveLength(20);
  });

  it("returns null when nothing usable survives — callers omit the field", () => {
    expect(sanitizeEventAttachmentNames(null)).toBeNull();
    expect(sanitizeEventAttachmentNames(undefined)).toBeNull();
    expect(sanitizeEventAttachmentNames([])).toBeNull();
    expect(sanitizeEventAttachmentNames(["../x", "a/b"])).toBeNull();
    expect(sanitizeEventAttachmentNames(["x".repeat(201)])).toBeNull();
  });
});
