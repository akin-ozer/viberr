import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  applyGrantCouplings,
  repairBrowserEgressGrants,
  UNIFIED_CAP_CATALOG,
  applyVerdictOutcomeGate,
  capabilityEnforcement,
  capabilityIsAdvisory,
  coerceSpecialistCapabilityMode,
  conservativeGrantsFor,
  normalizeDeliveryGrants,
  repairDeliveryGrants,
} from "./capabilities";

describe("capability catalog", () => {
  it("has no duplicate ids and every always-human id exists in the catalog", () => {
    const ids = UNIFIED_CAP_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const idSet = new Set(ids);
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(idSet.has(id), `${id} in ALWAYS_HUMAN but missing from catalog`).toBe(true);
    }
  });

  it("calls a row advisory exactly where it has no toggle (F39-4)", () => {
    // The matrix's enforcement badge and `get_project`'s advisory mark are two
    // readings of one fact: a row with a group has a runtime consumer, a row
    // without one binds nothing. CANARY: misspell an id in the enforced or the
    // claude-only set and that real toggle reads advisory here.
    for (const { id } of UNIFIED_CAP_CATALOG) {
      expect(capabilityEnforcement(id) === "advisory", id).toBe(capabilityIsAdvisory(id));
    }
  });
});

describe("capabilityEnforcement (S3 backend-asymmetry labeling)", () => {
  it("classifies structural ALWAYS_HUMAN caps as BOTH — never advisory-on-Codex", () => {
    // Regression for the adversarial-review finding: merge-pull-request was
    // mislabeled "claude-only" (⇒ the matrix badged it 'advisory on Codex'),
    // understating the single most safety-critical row. Always-human caps hold
    // on both backends because an agent never gets them in an actionable mode.
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(capabilityEnforcement(id), id).toBe("both");
    }
    expect(capabilityEnforcement("merge-pull-request")).toBe("both");
  });

  it("classifies operator-gate caps as both, and unknown/advisory caps as advisory", () => {
    // Dynamic-dispatch rework (2026-08-29): `dispatch-agents` is the ONE
    // operator dispatch gate — the retired slot pair (`assign-primary-specialist`
    // / `summon-reviewers`) collapsed into it below.
    for (const id of ["dispatch-agents", "generate-packets", "append-typed-events", "stage-transitions"]) {
      expect(capabilityEnforcement(id), id).toBe("both");
    }
    // The retired slot ids are unknown grants now — advisory, like any id the
    // catalog no longer knows (an old project.md row simply stops binding).
    expect(capabilityEnforcement("assign-primary-specialist")).toBe("advisory");
    expect(capabilityEnforcement("summon-reviewers")).toBe("advisory");
    expect(capabilityEnforcement("post-quality-flags")).toBe("advisory");
    expect(capabilityEnforcement("no-such-capability")).toBe("advisory");
  });

  it("classifies generic-agent collaboration gates by their real transport", () => {
    // verdict + ask-human gate server-side at completion → both backends;
    // the mid-run comment tool is Claude-only (Codex has no comment channel).
    expect(capabilityEnforcement("report-validation-verdict")).toBe("both");
    expect(capabilityEnforcement("ask-human")).toBe("both");
    expect(capabilityEnforcement("comment-on-task")).toBe("claude-only");
  });

  it("R19-19: classifies the browser as BOTH — withheld ⇒ the server is never mounted, either backend", () => {
    expect(capabilityEnforcement("use-browser")).toBe("both");
    // Default OFF: a casually created profile must not silently acquire a
    // driven browser (same rationale as report-validation-verdict).
    const entry = UNIFIED_CAP_CATALOG.find((c) => c.id === "use-browser")!;
    expect(entry.defaultMode).toBe("off");
    expect(entry.kinds).toEqual(["agent"]);
  });

  it("F4: classifies read-github-api as CLAUDE-ONLY — the in-process tool never mounts on Codex", () => {
    // The reader is an in-process Claude SDK tool (the PAT is decrypted in the
    // server, never handed to the agent); a Codex mount would leak the
    // credential into `--config`, so the tool simply is not built on Codex —
    // advisory there, same shape as comment-on-task.
    expect(capabilityEnforcement("read-github-api")).toBe("claude-only");
    // Default OFF, agent-only, and NOT promotable — raising a project's autonomy
    // never silently grants a private-repo reader.
    const entry = UNIFIED_CAP_CATALOG.find((c) => c.id === "read-github-api")!;
    expect(entry.defaultMode).toBe("off");
    expect(entry.kinds).toEqual(["agent"]);
    expect(entry.promotable).toBe(false);
  });

});

describe("delivery grants (F14 headline gate · B-AG1 no silent escalation)", () => {
  const mode = (capabilityId: string, m: string) => ({ capabilityId, mode: m });

  it("RESPECTS an explicit headline `off` and reports the contradiction instead of escalating", () => {
    const grants = [
      mode("execute-code-or-write-repo", "off"),
      mode("create-task-branch", "direct"),
      mode("commit-push-branch", "direct"),
      mode("open-review-pr", "direct"),
    ];
    const { grants: out, notice } = repairDeliveryGrants(grants);
    expect(out.find((g) => g.capabilityId === "execute-code-or-write-repo")?.mode).toBe("off");
    expect(notice?.kind).toBe("withheld");
    expect(notice?.message).toContain("cannot deliver");
    expect(notice?.scoped).toEqual([
      "create-task-branch",
      "commit-push-branch",
      "open-review-pr",
    ]);
    // Idempotent: a second save does not drift either.
    expect(normalizeDeliveryGrants(out)).toEqual(grants);
  });

  it("RESPECTS an explicit headline `human` (deliberate human gate)", () => {
    const grants = [
      mode("execute-code-or-write-repo", "human"),
      mode("commit-push-branch", "direct"),
    ];
    const { grants: out, notice } = repairDeliveryGrants(grants);
    expect(out.find((g) => g.capabilityId === "execute-code-or-write-repo")?.mode).toBe("human");
    expect(notice?.kind).toBe("withheld");
  });

  it("adds the headline grant when it is ABSENT but scoped delivery is actionable — and says so", () => {
    const grants = [mode("commit-push-branch", "direct")];
    const { grants: out, notice } = repairDeliveryGrants(grants);
    expect(out.some((g) => g.capabilityId === "execute-code-or-write-repo" && g.mode === "direct")).toBe(true);
    expect(notice?.kind).toBe("repaired");
    expect(notice?.message).toContain("Commit & push to the branch");
  });

  it("treats a specialist `recommend` scoped grant as actionable (absent headline repaired)", () => {
    const grants = [mode("open-review-pr", "recommend")];
    const out = normalizeDeliveryGrants(grants);
    expect(out.find((g) => g.capabilityId === "execute-code-or-write-repo")?.mode).toBe("direct");
  });

  it("leaves a non-deliverer (reviewer: scoped delivery off/human) untouched", () => {
    const grants = [
      mode("execute-code-or-write-repo", "off"),
      mode("create-task-branch", "off"),
      mode("commit-push-branch", "human"),
      mode("open-review-pr", "off"),
      mode("report-validation-verdict", "direct"),
    ];
    expect(normalizeDeliveryGrants(grants)).toEqual(grants);
  });

  it("leaves an already-correct deliverer (headline direct) untouched", () => {
    const grants = [
      mode("execute-code-or-write-repo", "direct"),
      mode("create-task-branch", "direct"),
    ];
    expect(normalizeDeliveryGrants(grants)).toEqual(grants);
    expect(repairDeliveryGrants(grants).notice).toBeNull();
  });
});

describe("applyVerdictOutcomeGate (F15-06 — verdict outcomes follow the verdict)", () => {
  const mode = (capabilityId: string, m: string) => ({ capabilityId, mode: m });

  it("withholds approve/request-changes/quality-flags when the verdict grant is off", () => {
    const out = applyVerdictOutcomeGate([
      mode("report-validation-verdict", "off"),
      mode("approve-review", "direct"),
      mode("request-changes", "direct"),
      mode("post-quality-flags", "direct"),
      mode("read-repo-diff", "direct"),
    ]);
    const modeOf = (id: string) => out.find((g) => g.capabilityId === id)?.mode;
    expect(modeOf("approve-review")).toBe("off");
    expect(modeOf("request-changes")).toBe("off");
    expect(modeOf("post-quality-flags")).toBe("off");
    // Unrelated advisory guidance is untouched.
    expect(modeOf("read-repo-diff")).toBe("direct");
  });

  it("withholds them when the verdict grant is ABSENT (catalog default is off)", () => {
    const out = applyVerdictOutcomeGate([mode("approve-review", "direct")]);
    expect(out[0]!.mode).toBe("off");
  });

  it("leaves them alone for a profile that explicitly holds the verdict", () => {
    const grants = [
      mode("report-validation-verdict", "direct"),
      mode("approve-review", "direct"),
      mode("request-changes", "recommend"),
    ];
    expect(applyVerdictOutcomeGate(grants)).toEqual(grants);
  });
});

describe("coerceSpecialistCapabilityMode (F20-21 / R20-6 — direct or withheld)", () => {
  it("normalizes a specialist `recommend` DOWN to `off`, never up to `direct`", () => {
    // R20-6: a specialist has no `recommend`. The old body WIDENED it to
    // `direct` (the dangerous direction — a stored `recommend` rendered/counted/
    // enforced as `direct`); the fix normalizes it DOWN to `off` (withheld, the
    // SAFE direction) at the write path and the display read, so file =
    // enforcement = display. Re-adding a `recommend → direct` transform here is
    // the F20-21 regression this canary guards.
    expect(coerceSpecialistCapabilityMode("recommend")).toBe("off");
  });

  it("passes direct / human / off through unchanged", () => {
    for (const m of ["direct", "human", "off"] as const) {
      expect(coerceSpecialistCapabilityMode(m)).toBe(m);
    }
  });
});

describe("conservativeGrantsFor (surfaces with no capability UI)", () => {
  it("starts delivery AND the review-verdict outcomes withheld (F15-06)", () => {
    const byId = new Map(
      conservativeGrantsFor("agent").map((g) => [g.capabilityId, g.mode]),
    );
    for (const id of [
      "execute-code-or-write-repo",
      "create-task-branch",
      "commit-push-branch",
      "open-review-pr",
      "approve-review",
      "request-changes",
      "post-quality-flags",
    ]) {
      expect(byId.get(id), id).toBe("off");
    }
    expect(byId.get("report-validation-verdict")).toBe("off");
  });
});

describe("browser→egress coupling (owner ruling 2026-08-20)", () => {
  const g = (capabilityId: string, mode: string) => ({ capabilityId, mode });

  it("flips an explicit egress `off` to `direct` when the browser is `direct`", () => {
    const { grants, notice } = repairBrowserEgressGrants([
      g("use-browser", "direct"),
      g("use-web-search-fetch", "off"),
    ]);
    const byId = new Map(grants.map((x) => [x.capabilityId, x.mode]));
    expect(byId.get("use-web-search-fetch")).toBe("direct");
    expect(notice?.rule).toBe("browser-egress");
    expect(notice?.kind).toBe("repaired");
    // The message names both rows and the reason — it becomes the audit note
    // and the save toast verbatim.
    expect(notice?.message).toContain("Search & fetch from the web");
    expect(notice?.message).toContain("Drive a live web browser");
    expect(notice?.message).toContain("web egress");
  });

  it("flips an explicit `human` and materializes an absent row the same way", () => {
    for (const stored of [
      [g("use-browser", "direct"), g("use-web-search-fetch", "human")],
      [g("use-browser", "direct")],
    ]) {
      const { grants, notice } = repairBrowserEgressGrants(stored);
      const byId = new Map(grants.map((x) => [x.capabilityId, x.mode]));
      expect(byId.get("use-web-search-fetch")).toBe("direct");
      expect(notice?.kind).toBe("repaired");
    }
  });

  it("touches nothing when the pair already agrees, or the browser is not direct", () => {
    for (const stored of [
      [g("use-browser", "direct"), g("use-web-search-fetch", "direct")],
      [g("use-browser", "off"), g("use-web-search-fetch", "off")],
      [g("use-browser", "human"), g("use-web-search-fetch", "off")],
      [g("use-web-search-fetch", "off")],
    ]) {
      const { grants, notice } = repairBrowserEgressGrants(stored);
      expect(notice).toBeNull();
      expect(grants).toEqual(stored);
    }
  });

  it("applyGrantCouplings runs delivery THEN browser and reports both", () => {
    // A profile that trips both rules in one save: scoped delivery submitted
    // with the headline absent, and a browser grant over withheld egress.
    const { grants, notices } = applyGrantCouplings([
      g("commit-push-branch", "direct"),
      g("use-browser", "direct"),
      g("use-web-search-fetch", "off"),
    ]);
    const byId = new Map(grants.map((x) => [x.capabilityId, x.mode]));
    expect(byId.get("execute-code-or-write-repo")).toBe("direct");
    expect(byId.get("use-web-search-fetch")).toBe("direct");
    expect(notices.map((n) => n.rule)).toEqual([
      "delivery-headline",
      "browser-egress",
    ]);
    expect(notices.map((n) => n.kind)).toEqual(["repaired", "repaired"]);
  });

  it("B-AG1 divergence is scoped: an explicit delivery `off` still stands", () => {
    // The browser rule overrides an explicit egress `off` (the contradiction
    // expresses no policy — the mount fails closed either way). The delivery
    // rule keeps its own semantics: an explicit headline `off` is reported,
    // never overturned.
    const { grants, notices } = applyGrantCouplings([
      g("commit-push-branch", "direct"),
      g("execute-code-or-write-repo", "off"),
      g("use-browser", "direct"),
      g("use-web-search-fetch", "off"),
    ]);
    const byId = new Map(grants.map((x) => [x.capabilityId, x.mode]));
    expect(byId.get("execute-code-or-write-repo")).toBe("off");
    expect(byId.get("use-web-search-fetch")).toBe("direct");
    expect(notices.map((n) => `${n.rule}:${n.kind}`)).toEqual([
      "delivery-headline:withheld",
      "browser-egress:repaired",
    ]);
  });
});
