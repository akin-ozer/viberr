import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  COMPACT_AT_COMPLETION_TOKENS,
  COMPLETION_COMPACT_INSTRUCTIONS,
  FIRST_CALL_LARGE_WRITE_TOKENS,
  OPERATOR_BURST_WINDOW_MS,
  RESUME_FRESH_CONTEXT_TOKENS,
  RESUME_IDLE_EDGES_MS,
  cacheTtlMs,
  codexCompactionConfig,
  controllerCompactAnchor,
  resumeVerdict,
  specialistCompactAnchor,
  startTemperature,
} from "./context-policy.server";

/** Every clock in this file is pinned; nothing reads `Date.now()`. */
const NOW = "2026-09-21T12:00:00.000Z";
const minutesBefore = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

describe("ruling 169: the numbers have one home", () => {
  it("Codex carries the shared summarizer prompt and no limit; the operator carries nothing", () => {
    const shared = codexCompactionConfig("primary").compact_prompt;
    expect(shared).toContain("Do not invent");
    for (const kind of ["primary", "reviewer", "controller"] as const) {
      expect(codexCompactionConfig(kind), kind).toEqual({ compact_prompt: shared });
    }
    expect(codexCompactionConfig("operator")).toEqual({});
  });

  it("ruling 174: the completion threshold is the owner's 100k, with instructions that name what to keep", () => {
    expect(COMPACT_AT_COMPLETION_TOKENS).toBe(100_000);
    expect(COMPACT_AT_COMPLETION_TOKENS).toBeLessThan(RESUME_FRESH_CONTEXT_TOKENS);
    for (const must of ["task.md", "read_knowledge_doc", "branch", "pull request", "failed", "pending", "last report"]) {
      expect(COMPLETION_COMPACT_INSTRUCTIONS).toContain(must);
    }
  });

  it("the compaction prompt names what a Viberr run cannot recover from a summary", () => {
    const prompt = codexCompactionConfig("primary").compact_prompt ?? "";
    for (const must of [
      "task.md",
      "read_knowledge_doc",
      "branch",
      "pull request",
      "FAILED",
      "pending",
      "Do not invent",
    ]) {
      expect(prompt).toContain(must);
    }
    // Generic on purpose: the per-task facts survive in developer_instructions.
    expect(prompt).not.toMatch(/\/data\/|VIB-\d|run_/);
  });

  it("the TTL follows the backend and the credential kind, and an unknown kind reads as a sign-in", () => {
    expect(CACHE_TTL_MS.claude.login).toBe(60 * 60 * 1000);
    expect(CACHE_TTL_MS.claude.api_key).toBe(5 * 60 * 1000);
    expect(CACHE_TTL_MS.claude.access_token).toBe(5 * 60 * 1000);
    expect(CACHE_TTL_MS.codex.login).toBe(10 * 60 * 1000);
    expect(cacheTtlMs("claude", null)).toBe(60 * 60 * 1000);
    expect(cacheTtlMs("codex", "api_key")).toBe(10 * 60 * 1000);
  });
});

describe("ruling 173: the resume verdict", () => {
  it("starts fresh only when the session is BOTH past its TTL AND large", () => {
    const large = RESUME_FRESH_CONTEXT_TOKENS + 1;
    // Stale and large: fresh.
    expect(
      resumeVerdict({
        backend: "claude",
        credentialKind: "login",
        finishedAt: minutesBefore(74),
        nowIso: NOW,
        contextTokens: 298_000,
      }),
    ).toEqual({ fresh: true, idleMs: 74 * 60_000, ttlMs: 60 * 60_000, contextTokens: 298_000 });
    // Warm and large: resume.
    expect(
      resumeVerdict({
        backend: "claude",
        credentialKind: "login",
        finishedAt: minutesBefore(16),
        nowIso: NOW,
        contextTokens: large,
      }).fresh,
    ).toBe(false);
    // Stale and small: resume.
    expect(
      resumeVerdict({
        backend: "claude",
        credentialKind: "login",
        finishedAt: minutesBefore(600),
        nowIso: NOW,
        contextTokens: RESUME_FRESH_CONTEXT_TOKENS,
      }).fresh,
    ).toBe(false);
  });

  it("an API key's five-minute TTL makes a 6-minute-old large session fresh; a sign-in's hour does not", () => {
    const at = { finishedAt: minutesBefore(6), nowIso: NOW, contextTokens: 200_000 };
    expect(resumeVerdict({ backend: "claude", credentialKind: "api_key", ...at }).fresh).toBe(true);
    expect(resumeVerdict({ backend: "claude", credentialKind: "access_token", ...at }).fresh).toBe(true);
    expect(resumeVerdict({ backend: "claude", credentialKind: "login", ...at }).fresh).toBe(false);
  });

  it("Codex is ten minutes on every credential kind until measured", () => {
    const at = { nowIso: NOW, contextTokens: 200_000 };
    for (const credentialKind of ["login", "api_key", "access_token"] as const) {
      expect(
        resumeVerdict({ backend: "codex", credentialKind, finishedAt: minutesBefore(11), ...at }).fresh,
        credentialKind,
      ).toBe(true);
      expect(
        resumeVerdict({ backend: "codex", credentialKind, finishedAt: minutesBefore(9), ...at }).fresh,
        credentialKind,
      ).toBe(false);
    }
  });

  it("an unknown size never starts fresh, and a never-finished row is idle for ever", () => {
    expect(
      resumeVerdict({
        backend: "claude",
        credentialKind: "login",
        finishedAt: minutesBefore(600),
        nowIso: NOW,
        contextTokens: null,
      }),
    ).toMatchObject({ fresh: false, contextTokens: 0 });
    const never = resumeVerdict({
      backend: "claude",
      credentialKind: "login",
      finishedAt: null,
      nowIso: NOW,
      contextTokens: 200_000,
    });
    expect(never.fresh).toBe(true);
    expect(never.idleMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("a clock that ran backwards reads as no idle at all", () => {
    expect(
      resumeVerdict({
        backend: "claude",
        credentialKind: "api_key",
        finishedAt: new Date(Date.parse(NOW) + 60_000).toISOString(),
        nowIso: NOW,
        contextTokens: 200_000,
      }),
    ).toMatchObject({ fresh: false, idleMs: 0 });
  });
});

describe("ruling 172: start temperature and the large-write line", () => {
  it("warm reads more than it wrote; anything else is cold", () => {
    expect(startTemperature(4_200, 47_900)).toBe("warm");
    expect(startTemperature(14_100, 0)).toBe("cold");
    expect(startTemperature(0, 0)).toBe("cold");
    expect(startTemperature(10, 10)).toBe("cold");
  });

  it("pins the large-write threshold the Insights card counts against", () => {
    expect(FIRST_CALL_LARGE_WRITE_TOKENS).toBe(100_000);
  });
});

describe("ruling 172: what Insights measures the policy by", () => {
  it("sorts resumes at every TTL the policy assumes, then at the extended retention", () => {
    expect([...RESUME_IDLE_EDGES_MS]).toEqual([
      5 * 60_000,
      10 * 60_000,
      60 * 60_000,
      24 * 60 * 60_000,
    ]);
    // CANARY: spell the edges by hand and a TTL the table gains leaves no edge.
    for (const byKind of Object.values(CACHE_TTL_MS)) {
      for (const ttl of Object.values(byKind)) expect(RESUME_IDLE_EDGES_MS).toContain(ttl);
    }
  });

  it("counts an operator start as part of a burst for a minute after the one before it", () => {
    expect(OPERATOR_BURST_WINDOW_MS).toBe(60_000);
  });
});

describe("ruling 170: the compaction anchors", () => {
  it("the specialist anchor pins the task file, branch, PR, knowledge bases and the rulings note", () => {
    const text = specialistCompactAnchor({
      taskKey: "VIB-7",
      title: "Ship the thing",
      taskMdPath: "/data/projects/viberr/tasks/VIB-7/task.md",
      branch: "vib-7",
      pr: { number: 42, url: "https://github.com/o/r/pull/42" },
      kb: ["house-style", "rulings"],
      rulingsKb: "rulings",
    });
    expect(text).toContain("/data/projects/viberr/tasks/VIB-7/task.md");
    expect(text).toContain("`vib-7`");
    expect(text).toContain("#42 (https://github.com/o/r/pull/42)");
    expect(text).toContain("house-style, rulings");
    expect(text).toContain("read_knowledge_doc");
    expect(text).toContain("rulings (rulings) still bind you");
    expect(text).toContain("Re-read it before you act");
  });

  it("says plainly when there is no branch, PR or knowledge base yet", () => {
    const text = specialistCompactAnchor({
      taskKey: "VIB-8",
      title: "Triage",
      taskMdPath: "/data/projects/viberr/tasks/VIB-8/task.md",
      branch: null,
      pr: null,
      kb: [],
      rulingsKb: null,
    });
    expect(text).toContain("Branch: none allocated yet");
    expect(text).toContain("Pull request: none opened yet");
    expect(text).toContain("Knowledge bases: none attached.");
    expect(text).not.toContain("still bind you");
  });

  it("the controller anchor names the conversation, the person and the scope", () => {
    const task = controllerCompactAnchor({
      conversationId: "cnv_1",
      userLabel: "Arda",
      projectSlug: "viberr",
      taskKey: "VIB-1",
    });
    expect(task).toContain("cnv_1");
    expect(task).toContain("with Arda");
    expect(task).toContain("anchored to task `VIB-1` in project `viberr`");
    expect(task).toContain("viberr_ops");
    expect(
      controllerCompactAnchor({ conversationId: "c", userLabel: "A", projectSlug: "p", taskKey: null }),
    ).toContain("bound to the project `p`");
    expect(
      controllerCompactAnchor({ conversationId: "c", userLabel: "A", projectSlug: null, taskKey: null }),
    ).toContain("instance-scoped");
  });
});
