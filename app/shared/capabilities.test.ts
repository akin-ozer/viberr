import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  applyGrantCouplings,
  repairBrowserEgressGrants,
  CAP_CATALOG,
  CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS,
  ENFORCED_CAPABILITY_IDS,
  UNIFIED_CAP_CATALOG,
  applyVerdictOutcomeGate,
  capabilityByLabel,
  capabilityEnforcement,
  coerceSpecialistCapabilityMode,
  conservativeGrantsFor,
  normalizeDeliveryGrants,
  repairDeliveryGrants,
} from "./capabilities";

describe("capability catalog", () => {
  it("A00-8 (pass 32): the ENFORCED_CAPABILITY_IDS literal lists each id exactly once", async () => {
    // A Set swallows a duplicate silently, so `execute-code-or-write-repo` sat
    // in ENFORCED_CAPABILITY_IDS twice for a whole pass — a future edit would
    // have deleted the wrong copy and changed nothing. The literal is read from
    // the source so a duplicate cannot hide inside the Set again. (The set
    // deliberately OVERLAPS the claude-only one — those ids have a runtime
    // consumer, scoped to Claude; capabilityEnforcement checks that set first.)
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./capabilities.ts", import.meta.url), "utf8");
    const start = source.indexOf("export const ENFORCED_CAPABILITY_IDS");
    const end = source.indexOf("]);", start);
    const literal = source.slice(start, end);
    const seen = new Map<string, number>();
    for (const m of literal.matchAll(/^\s*"([a-z-]+)",/gm)) {
      seen.set(m[1]!, (seen.get(m[1]!) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    expect(duplicated).toEqual([]);
    // Ruling 185 moved the headline write family OUT of this literal (Codex is
    // no longer OS-confined, so it binds on Claude alone).
    expect(seen.has("execute-code-or-write-repo")).toBe(false);
    expect(seen.has("use-web-search-fetch")).toBe(true);
  });

  it("has no duplicate ids and every enforced id exists in the catalog", () => {
    const ids = CAP_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const idSet = new Set(ids);
    for (const id of ENFORCED_CAPABILITY_IDS) {
      expect(idSet.has(id), `${id} in ENFORCED but missing from catalog`).toBe(true);
    }
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(idSet.has(id), `${id} in ALWAYS_HUMAN but missing from catalog`).toBe(true);
    }
  });

  it("pruned ids (F11/R3, dynamic-dispatch) are gone from the catalog", () => {
    const ids = new Set(CAP_CATALOG.map((c) => c.id));
    // The last two retired in the dynamic-dispatch rework (2026-08-29),
    // collapsed into the single `dispatch-agents` gate.
    for (const gone of ["edit-other-task-branch", "open-or-merge-pr", "compress-timelines", "owner-reassignment", "assign-primary-specialist", "summon-reviewers"]) {
      expect(ids.has(gone), `${gone} should have been pruned`).toBe(false);
    }
    expect(ids.has("dispatch-agents")).toBe(true);
  });
});

describe("capabilityEnforcement (S3 backend-asymmetry labeling)", () => {
  it("classifies the FINE-GRAINED tool-denylist caps as claude-only", () => {
    for (const id of ["create-task-branch", "commit-push-branch", "open-review-pr"]) {
      expect(capabilityEnforcement(id), id).toBe("claude-only");
    }
  });

  it("ruling 185: the headline repo-write cap is claude-only again — Codex is not OS-confined", () => {
    // History: P13-RT-02 labeled it BOTH (withheld Codex runs got the
    // read-only sandbox), R22 removed the sandbox and made it claude-only, the
    // 2026-08-31 parity ruling restored the sandbox for withheld runs, and
    // ruling 185 removed the sandbox for good — bubblewrap could not start
    // under Docker's default seccomp profile (F36-1) and the network-off
    // filter broke every synchronous child process (F36-11). On Codex the
    // prompt and the server-owned delivery gate carry it, which the matrix
    // renders as "advisory on Codex". Canary: move the cap back to
    // ENFORCED_CAPABILITY_IDS and this reads "both".
    expect(capabilityEnforcement("execute-code-or-write-repo")).toBe("claude-only");
    expect(
      CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has("execute-code-or-write-repo"),
    ).toBe(true);
    // Web search still binds on both: it is the CLI's own tool switch.
    expect(capabilityEnforcement("use-web-search-fetch")).toBe("both");
  });

  it("classifies structural ALWAYS_HUMAN caps as BOTH — never advisory-on-Codex", () => {
    // Regression for the adversarial-review finding: merge-pull-request was
    // mislabeled "claude-only" (⇒ the matrix badged it 'advisory on Codex'),
    // understating the single most safety-critical row. Always-human caps hold
    // on both backends because an agent never gets them in an actionable mode.
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(capabilityEnforcement(id), id).toBe("both");
    }
    expect(capabilityEnforcement("merge-pull-request")).toBe("both");
    expect(CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has("merge-pull-request")).toBe(false);
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

  it("classifies web egress as BOTH — the Codex webSearchMode channel enforces it (P14-RT-06)", () => {
    // It used to be labeled claude-only on the strength of a "prompt-level on
    // Codex" fallback that never existed in any prompt. Codex now disables web
    // search for a withheld grant, so both backends remove the built-in tool.
    expect(capabilityEnforcement("use-web-search-fetch")).toBe("both");
    expect(CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has("use-web-search-fetch")).toBe(
      false,
    );
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
    expect(CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has("read-github-api")).toBe(true);
    // Default OFF, agent-only, and NOT promotable — raising a project's autonomy
    // never silently grants a private-repo reader.
    const entry = UNIFIED_CAP_CATALOG.find((c) => c.id === "read-github-api")!;
    expect(entry.defaultMode).toBe("off");
    expect(entry.kinds).toEqual(["agent"]);
    expect(entry.promotable).toBe(false);
  });

  it("matrix badges: claude-only for the SCOPED delivery commands; the headline binds on both", () => {
    // What the CapabilityMatrixModal actually does: label → id → enforcement.
    // Parity ruling (2026-08-31): the headline "Execute code or write to the
    // repo" moved back to both-backend enforcement (read-only sandbox on a
    // withheld Codex run); the scoped commands stay claude-only at the tool
    // layer — the codex sandbox cannot deny `git push` for a write-granted
    // run, and their real Codex boundary is the credential-less agent + the
    // server-owned delivery gate.
    const claudeOnlyLabels = [
      "Create the task-key branch",
      "Commit & push to the branch",
      "Open the review pull request",
    ];
    for (const label of claudeOnlyLabels) {
      const id = capabilityByLabel(label)?.id;
      expect(id, label).toBeTruthy();
      expect(capabilityEnforcement(id!), label).toBe("claude-only");
    }
    // Merge a pull request is ALWAYS_HUMAN → both backends, never claude-only.
    expect(capabilityEnforcement(capabilityByLabel("Merge a pull request")!.id)).toBe("both");
    // Ruling 185: the headline write family joined the claude-only list.
    expect(
      capabilityEnforcement(capabilityByLabel("Execute code or write to the repo")!.id),
    ).toBe("claude-only");
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
