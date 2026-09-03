import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import type { RunCredential } from "./backend-credentials.server";
import type {
  ClaudeQuery,
  ClaudeQueryFn,
  ClaudeQueryOptions,
} from "./claude-runtime.server";
import {
  claudeProbeOptions,
  curatedCatalog,
  defaultEffortFor,
  defaultModelFor,
  foreignModelBackend,
  getModelCatalog,
  isKnownModel,
  modelDisplayName,
  resetModelCatalogCache,
  resolveRunModel,
  type SdkModelInfo,
} from "./model-catalog.server";
import {
  clearModelMark,
  markModelUnavailable,
} from "./model-availability.server";

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

  it("the shared always-valid alias list matches the curated values (ruling 106 D1)", async () => {
    // The client pickers use CLAUDE_MODEL_ALIASES + DATED_CLAUDE_ID_RE to
    // decide whether a stored model would run verbatim; if the curated values
    // and the shared list drift, the pickers start rewriting valid models (or
    // preserving invalid ones).
    const { CLAUDE_MODEL_ALIASES, claudeModelRunsVerbatim } = await import(
      "~/shared/model-ids"
    );
    expect(curatedCatalog("claude").models.map((m) => m.value)).toEqual([
      ...CLAUDE_MODEL_ALIASES,
    ]);
    // And the shared predicate agrees with isKnownModel on its static half.
    expect(claudeModelRunsVerbatim("claude-opus-4-1-20250805")).toBe(true);
    expect(isKnownModel("claude", "claude-opus-4-1-20250805")).toBe(true);
    expect(claudeModelRunsVerbatim("claude-sonnet")).toBe(false);
    expect(claudeModelRunsVerbatim("gpt-5-codex")).toBe(false);
  });

  it("codex curated: current subscription models + low…xhigh efforts", () => {
    const cat = curatedCatalog("codex");
    // F20-33: Terra is listed FIRST (so it is the fallback default) — Sol 400s
    // on a ChatGPT-plan Codex account and must not be what a model-less operator
    // falls back to. Sol stays offered, just no longer first/default.
    expect(cat.models.map((m) => m.value)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(cat.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cat.defaultModel).toBe("gpt-5.6-terra");
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

/**
 * Ruling 127: the enhanced probe reads the VIEWER's OWN Claude account. There
 * is no instance account left to enumerate against, so "available" is replaced
 * by "the caller handed us a credential" — and a caller that hands none gets
 * the curated list, which is a complete answer for somebody who has not
 * connected Claude.
 */
const VIEWER_CREDENTIAL: RunCredential = {
  env: {
    CLAUDE_CONFIG_DIR: "/data/runtimes/users/u_viewer/claude-home",
    ANTHROPIC_API_KEY: "sk-ant-viewer-key-000000000000",
  },
  secrets: ["sk-ant-viewer-key-000000000000"],
  kind: "api_key",
  homeDir: "/data/runtimes/users/u_viewer/claude-home",
};

describe("getModelCatalog", () => {
  it("codex is curated-only (never calls the SDK)", async () => {
    const queryFn = vi.fn<ClaudeQueryFn>();
    const cat = await getModelCatalog("codex", {
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(cat.defaultModel).toBe("gpt-5.6-terra");
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("claude falls back to curated when the VIEWER has no Claude connected", async () => {
    const queryFn = vi.fn<ClaudeQueryFn>();
    const cat = await getModelCatalog("claude", { claudeQueryFn: queryFn });
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
      credential: VIEWER_CREDENTIAL,
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
    const queryFn: ClaudeQueryFn = () => {
      calls += 1;
      return fakeQueryObject(live);
    };

    const first = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    const second = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(first.models.map((m) => m.value)).toEqual(["sonnet"]);
    expect(second.models.map((m) => m.value)).toEqual(["sonnet"]);
    expect(calls).toBe(1); // second served from cache
  });

  it("falls back to curated when the live fetch throws", async () => {
    const queryFn: ClaudeQueryFn = () =>
      fakeQuery(async () => {
        throw new Error("network down");
      });
    const cat = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("falls back to curated when the live list is empty", async () => {
    const queryFn = makeFakeQuery([]);
    const cat = await getModelCatalog("claude", {
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
  });
});

describe("the live probe is CONFINED like a real run (A1, F10-02 regression)", () => {
  /**
   * `query()` spawns the `claude` binary as soon as it is constructed, and the
   * SDK REPLACES the child env with `options.env` — falling back to the FULL
   * `process.env` only when the field is absent. The probe used to pass
   * `options: {}`, so every catalog miss from the agent create/edit UI handed a
   * spawned process the GitHub PAT, the session secret, the secret-box
   * encryption key and every provider key, and pointed it at the operator's
   * personal `~/.claude`.
   */
  it("passes an explicit, credential-filtered env (never process.env)", async () => {
    process.env.VIBERR_CATALOG_PROBE_MARKER = "ordinary";
    process.env.MY_DEPLOY_SECRET = "server-deploy-secret";
    process.env.GITHUB_TOKEN = "ghp_should_not_leak";
    process.env.DATABASE_URL = "postgres://secret";
    let seen: ClaudeQueryOptions | undefined;
    const queryFn: ClaudeQueryFn = (params) => {
      seen = params.options;
      return fakeQueryObject([
        { value: "sonnet", displayName: "S", description: "", supportsEffort: true },
      ]);
    };
    try {
      await getModelCatalog("claude", {
        claudeQueryFn: queryFn,
        credential: VIEWER_CREDENTIAL,
      });
      // The field must EXIST — an absent `env` is the leak, not a neutral default.
      expect(seen?.env).toBeDefined();
      const env = seen!.env!;
      expect(env.VIBERR_CATALOG_PROBE_MARKER).toBe("ordinary"); // PATH-like vars survive
      expect(env.MY_DEPLOY_SECRET).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.VIBERR_SESSION_SECRET).toBeUndefined();
      expect(env.VIBERR_SECRET_ENCRYPTION_KEY).toBeUndefined();
      // …and it reads/writes the VIEWER's own home, carrying THEIR key and no
      // other — the probe bills nothing, but it does read a personal account,
      // so it reads the account of the person who asked (ruling 127).
      expect(env.CLAUDE_CONFIG_DIR).toBe(VIEWER_CREDENTIAL.homeDir);
      expect(env.ANTHROPIC_API_KEY).toBe(VIEWER_CREDENTIAL.secrets[0]);
    } finally {
      delete process.env.VIBERR_CATALOG_PROBE_MARKER;
      delete process.env.MY_DEPLOY_SECRET;
      delete process.env.GITHUB_TOKEN;
      delete process.env.DATABASE_URL;
    }
  });

  it("carries the same host-isolation options a run gets", () => {
    const options = claudeProbeOptions(VIEWER_CREDENTIAL);
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([]);
  });
});

// -------------------------------------------------------------- test helpers

/** A fake query exposing supportedModels()/interrupt(). `ClaudeQuery` is the
 *  STREAMING contract, so the fake is built on a real async generator — the
 *  probe never iterates it, and an unstarted generator runs no body. */
function fakeQuery(supportedModels: () => Promise<SdkModelInfo[]>): ClaudeQuery {
  async function* stream(): AsyncGenerator<unknown, void> {}
  return Object.assign(stream(), {
    supportedModels,
    interrupt: async () => {},
  });
}

/** A fake query object answering supportedModels() with `models`. */
function fakeQueryObject(models: SdkModelInfo[]): ClaudeQuery {
  return fakeQuery(async () => models);
}

function makeFakeQuery(models: SdkModelInfo[]): ClaudeQueryFn {
  return () => fakeQueryObject(models);
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
      credential: VIEWER_CREDENTIAL,
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

describe("R20-3 (F20-4): the catalog stamps provider-refused models unavailable", () => {
  const dbCtx = createTestDbContext();
  afterEach(dbCtx.cleanup);
  afterEach(() => resetModelCatalogCache());

  it("stamps a marked model in the curated (codex) catalog", async () => {
    const db = dbCtx.makeDb();
    markModelUnavailable(db, {
      backend: "codex",
      model: "gpt-5.6-sol",
      reason: "not supported on this account",
    });
    const cat = await getModelCatalog("codex", { db });
    const sol = cat.models.find((m) => m.value === "gpt-5.6-sol");
    expect(sol?.unavailable?.reason).toContain("not supported");
    // An unmarked model is untouched.
    expect(
      cat.models.find((m) => m.value === "gpt-5.6-terra")?.unavailable,
    ).toBeUndefined();
  });

  it("stamps the LIVE-enhanced claude catalog too", async () => {
    const db = dbCtx.makeDb();
    markModelUnavailable(db, {
      backend: "claude",
      model: "opus",
      reason: "model unavailable for this deployment",
    });
    const cat = await getModelCatalog("claude", {
      db,
      // No credential: the curated path still carries all three.
    });
    expect(cat.models.find((m) => m.value === "opus")?.unavailable).toBeTruthy();
  });

  it("the TTL live cache does NOT freeze the mark (applied after cloneCatalog)", async () => {
    const db = dbCtx.makeDb();
    const live: SdkModelInfo[] = [
      { value: "sonnet", displayName: "S", description: "", supportsEffort: true },
    ];
    const queryFn = makeFakeQuery(live);
    // First call: no mark yet.
    const before = await getModelCatalog("claude", {
      db,
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(before.models[0]!.unavailable).toBeUndefined();
    // Mark it — no cache reset — the very next call reflects it.
    markModelUnavailable(db, { backend: "claude", model: "sonnet", reason: "gone" });
    const after = await getModelCatalog("claude", {
      db,
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(after.models[0]!.unavailable?.reason).toBe("gone");
    // And clearing it takes effect the next call with no reset either.
    clearModelMark(db, "claude", "sonnet");
    const cleared = await getModelCatalog("claude", {
      db,
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(cleared.models[0]!.unavailable).toBeUndefined();
  });
});

/**
 * F21-13 — "this model belongs to the OTHER backend" is a different question
 * from "this backend doesn't know this model", and only the first is evidence
 * of a mistake.
 *
 * The Claude catalog is OPEN: a live `supportedModels()` id, a dated id, and an
 * id whose live-cache entry has been evicted on a cold process all reach the
 * validator legitimately. Rejecting on `!isKnownModel` alone would refuse saves
 * the picker itself had offered (the P13-RT-07 failure, from the other side).
 */
describe("foreignModelBackend (F21-13)", () => {
  afterEach(() => resetModelCatalogCache());

  it("names the owning backend for a genuinely cross-backend id", () => {
    // The live pair: `backends: [claude]` saved next to `model: gpt-5.6-terra`.
    expect(foreignModelBackend("claude", "gpt-5.6-terra")).toBe("codex");
    expect(foreignModelBackend("codex", "sonnet")).toBe("claude");
    expect(foreignModelBackend("codex", "claude-sonnet-4-5")).toBe("claude");
  });

  it("is null for a model the chosen backend accepts", () => {
    expect(foreignModelBackend("claude", "sonnet")).toBeNull();
    expect(foreignModelBackend("claude", "claude-opus-4-5")).toBeNull();
    expect(foreignModelBackend("codex", "gpt-5.6-terra")).toBeNull();
  });

  it("is null for an id NEITHER backend knows — unknown is not foreign", () => {
    // A legacy display label, a typo, an id from a future catalog: none of these
    // are evidence that the human picked the wrong backend, and the runtime
    // already has honest paths for them (alias mapping / a real provider error).
    expect(foreignModelBackend("claude", "claude-sonnet")).toBeNull();
    expect(foreignModelBackend("codex", "gpt-9-imaginary")).toBeNull();
    expect(foreignModelBackend("claude", "")).toBeNull();
    expect(foreignModelBackend("claude", null)).toBeNull();
  });
});
