import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeQuery, ClaudeQueryFn } from "./claude-runtime.server";
import {
  curatedCatalog,
  defaultEffortFor,
  defaultModelFor,
  getModelCatalog,
  isKnownModel,
  modelDisplayName,
  resetModelCatalogCache,
  resolveRunModel,
  type SdkModelInfo,
} from "./model-catalog.server";

/**
 * Catalog tests: curated fallback for both backends (works offline, no
 * credential), the claude LIVE-fetch path via an injected fake SDK query
 * (respecting supportsEffort + supportedEffortLevels), the in-process cache,
 * and graceful degradation to curated on a throwing/empty live fetch.
 */

afterEach(() => resetModelCatalogCache());

describe("resolveRunModel — the SDK-safety sanitizer", () => {
  it("accepts a real catalog id and rejects legacy display-label placeholders", () => {
    // Valid ids pass through untouched.
    expect(resolveRunModel("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveRunModel("claude", "sonnet")).toBe("sonnet");
    expect(resolveRunModel("claude", "opus")).toBe("opus");

    // The seed/legacy display labels that caused the "model not supported when
    // using Codex with a ChatGPT account" 400 all resolve to the backend default.
    expect(isKnownModel("codex", "codex-large · claude-sonnet")).toBe(false);
    expect(resolveRunModel("codex", "codex-large · claude-sonnet")).toBe(
      defaultModelFor("codex"),
    );
    expect(resolveRunModel("codex", "codex-large")).toBe(defaultModelFor("codex"));
    expect(resolveRunModel("claude", "claude-sonnet")).toBe(
      defaultModelFor("claude"),
    );
    expect(resolveRunModel("claude", "orchestration runtime")).toBe(
      defaultModelFor("claude"),
    );

    // Empty / missing → default (never an empty model id to the SDK).
    expect(resolveRunModel("codex", "")).toBe(defaultModelFor("codex"));
    expect(resolveRunModel("codex", null)).toBe(defaultModelFor("codex"));
    expect(resolveRunModel("codex", undefined)).toBe(defaultModelFor("codex"));

    // A codex id passed to claude (wrong backend) is rejected, and vice versa.
    expect(resolveRunModel("claude", "gpt-5.6-sol")).toBe(defaultModelFor("claude"));
    expect(resolveRunModel("codex", "sonnet")).toBe(defaultModelFor("codex"));
  });

  it("resolveRunEffort translates a cross-backend effort tier (D4 retry)", async () => {
    const { resolveRunEffort } = await import("./model-catalog.server");
    // Same-backend valid values pass through.
    expect(resolveRunEffort("claude", "high")).toBe("high");
    expect(resolveRunEffort("codex", "low")).toBe("low");
    // Claude-only "max" retried on Codex maps to Codex's nearest (xhigh), never
    // passed raw (Codex would reject it).
    expect(resolveRunEffort("codex", "max")).toBe("xhigh");
    // A legacy "minimal" setting maps to the nearest supported tier.
    expect(resolveRunEffort("codex", "minimal")).toBe("low");
    expect(resolveRunEffort("claude", "minimal")).toBe("low");
    // Unknown/empty → the backend default.
    expect(resolveRunEffort("codex", "")).toBe(defaultEffortFor("codex"));
    expect(resolveRunEffort("claude", "bogus")).toBe(defaultEffortFor("claude"));
  });

  it("modelDisplayName gives the friendly name for a known id, else the raw value", () => {
    expect(modelDisplayName("codex", "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelDisplayName("claude", "sonnet")).toBe("Claude Sonnet");
    // Unknown → echoed back (the UI pairs this with a substitution flag).
    expect(modelDisplayName("codex", "codex-large · claude-sonnet")).toBe(
      "codex-large · claude-sonnet",
    );
  });
});

describe("curated catalog", () => {
  it("claude curated: sonnet/opus/haiku aliases, effort levels, defaults", () => {
    const cat = curatedCatalog("claude");
    expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
    expect(cat.models.every((m) => m.supportsEffort)).toBe(true);
    expect(cat.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cat.defaultModel).toBe("sonnet");
    expect(cat.defaultEffort).toBe("high");
  });

  it("codex curated: current subscription models + low…xhigh efforts", () => {
    const cat = curatedCatalog("codex");
    expect(cat.models.map((m) => m.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(cat.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cat.defaultModel).toBe("gpt-5.6-sol");
    expect(cat.defaultEffort).toBe("medium");
  });

  it("returns fresh copies (callers cannot mutate the shared constant)", () => {
    const a = curatedCatalog("claude");
    a.models[0]!.value = "mutated";
    expect(curatedCatalog("claude").models[0]!.value).toBe("sonnet");
  });

  it("defaultModel is the FIRST available model (not a separate hardcoded id)", () => {
    for (const backend of ["claude", "codex"] as const) {
      const cat = curatedCatalog(backend);
      expect(cat.defaultModel).toBe(cat.models[0]!.value);
      // defaultModelFor mirrors the catalog default (what run/reply fall back to).
      expect(defaultModelFor(backend)).toBe(cat.models[0]!.value);
      expect(cat.models.some((m) => m.value === defaultModelFor(backend))).toBe(true);
      // the default effort is one the backend actually supports
      expect(cat.efforts).toContain(defaultEffortFor(backend));
    }
  });
});

describe("getModelCatalog", () => {
  it("codex is curated-only (never calls the SDK)", async () => {
    const queryFn = vi.fn();
    const cat = await getModelCatalog("codex", {
      claudeQueryFn: queryFn as unknown as ClaudeQueryFn,
      isAvailable: () => true,
    });
    expect(cat.defaultModel).toBe("gpt-5.6-sol");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("claude falls back to curated when the backend is unavailable", async () => {
    const queryFn = vi.fn();
    const cat = await getModelCatalog("claude", {
      claudeQueryFn: queryFn as unknown as ClaudeQueryFn,
      isAvailable: () => false,
    });
    expect(cat.defaultModel).toBe("sonnet");
    expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("claude enhances with the LIVE supportedModels() list when available", async () => {
    const live: SdkModelInfo[] = [
      {
        value: "sonnet",
        displayName: "Claude Sonnet (live)",
        description: "live sonnet",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "max"],
      },
      {
        value: "haiku-lite",
        displayName: "Haiku Lite",
        description: "no effort",
        supportsEffort: false,
      },
    ];
    const queryFn = makeFakeQuery(live);
    const cat = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      isAvailable: () => true,
    });
    expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "haiku-lite"]);
    // Effort levels are taken per-model from supportedEffortLevels.
    expect(cat.models[0]).toMatchObject({
      value: "sonnet",
      displayName: "Claude Sonnet (live)",
      supportsEffort: true,
      efforts: ["low", "high", "max"],
    });
    // A non-effort model carries no efforts list.
    expect(cat.models[1]!.supportsEffort).toBe(false);
    expect(cat.models[1]!.efforts).toBeUndefined();
    // Curated default anchors the default selection.
    expect(cat.defaultModel).toBe("sonnet");
    expect(cat.defaultEffort).toBe("high");
  });

  it("caches the live result (a second call does not re-query)", async () => {
    const live: SdkModelInfo[] = [
      { value: "sonnet", displayName: "S", description: "", supportsEffort: true },
    ];
    let calls = 0;
    const queryFn = ((_params: unknown) => {
      calls += 1;
      return fakeQueryObject(live);
    }) as unknown as ClaudeQueryFn;

    const first = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      isAvailable: () => true,
    });
    const second = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      isAvailable: () => true,
    });
    expect(first.models.map((m) => m.value)).toEqual(["sonnet"]);
    expect(second.models.map((m) => m.value)).toEqual(["sonnet"]);
    expect(calls).toBe(1); // second served from cache
  });

  it("falls back to curated when the live fetch throws", async () => {
    const queryFn = (() => {
      const q = {
        supportedModels: async () => {
          throw new Error("network down");
        },
        interrupt: async () => {},
      };
      return q as unknown as ClaudeQuery;
    }) as unknown as ClaudeQueryFn;
    const cat = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      isAvailable: () => true,
    });
    expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("falls back to curated when the live list is empty", async () => {
    const queryFn = makeFakeQuery([]);
    const cat = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      isAvailable: () => true,
    });
    expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
  });
});

// -------------------------------------------------------------- test helpers

/** A fake query object exposing supportedModels()/interrupt() (never iterated). */
function fakeQueryObject(models: SdkModelInfo[]): ClaudeQuery {
  const q = {
    supportedModels: async () => models,
    interrupt: async () => {},
  };
  return q as unknown as ClaudeQuery;
}

function makeFakeQuery(models: SdkModelInfo[]): ClaudeQueryFn {
  return (() => fakeQueryObject(models)) as unknown as ClaudeQueryFn;
}

describe("isKnownModel agrees with what the picker offered (P13-RT-07)", () => {
  afterEach(() => resetModelCatalogCache());

  it("accepts a dated claude id the picker can serve from the live list", () => {
    // `getModelCatalog("claude")` serves the account's LIVE supportedModels()
    // list to the profile modal, which stores the chosen `value`. The validator
    // used to accept only the three curated aliases, so `resolveRunModel`
    // silently substituted `sonnet` for a value the picker itself had offered —
    // every run then executed on Sonnet while the agents page showed an
    // "unknown model" badge that read as a bug in the badge.
    expect(isKnownModel("claude", "claude-sonnet-4-5")).toBe(true);
    expect(resolveRunModel("claude", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("still rejects the seed display placeholders it exists to catch", () => {
    for (const junk of [
      "claude-sonnet",
      "codex-large",
      "codex-large · claude-sonnet",
      "orchestration runtime",
      "",
    ]) {
      expect(isKnownModel("claude", junk)).toBe(false);
    }
    expect(resolveRunModel("claude", "claude-sonnet")).toBe("sonnet");
  });

  it("accepts a non-dated value the live catalog actually listed", async () => {
    const catalog = await getModelCatalog("claude", {
      isAvailable: () => true,
      claudeQueryFn: makeFakeQuery([
        {
          value: "opus-next",
          displayName: "Claude Opus Next",
          description: "",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
      ]),
    });
    expect(catalog.models.map((m) => m.value)).toContain("opus-next");
    // The picker offered it → the run-time validator must not downgrade it.
    expect(isKnownModel("claude", "opus-next")).toBe(true);
    expect(resolveRunModel("claude", "opus-next")).toBe("opus-next");
    // Codex has no live endpoint, so its curated list stays authoritative.
    expect(isKnownModel("codex", "opus-next")).toBe(false);
  });
});
