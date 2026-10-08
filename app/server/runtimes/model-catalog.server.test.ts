import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { AGENT_UID_FLOOR, resetAgentIsolationForTests } from "./agent-isolation.server";
import type { RunCredential } from "./backend-credentials.server";
import type { ClaudeSpawnedProcess } from "./claude-spawn.server";
import type {
  ClaudeQuery,
  ClaudeQueryFn,
  ClaudeQueryOptions,
} from "./claude-runtime.server";
import {
  assertEffortForBackend,
  assertModelForBackend,
  effortsFor,
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
  noteModelAvailabilityFromFailure,
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
    // `max` is offered on both backends since Codex CLI 0.153 (the SDK 0.153.4
    // upgrade), so a Claude `max` retried on Codex keeps its tier.
    expect(resolveRunEffort("codex", "max")).toBe("max");
    // A Codex-only tier Viberr does not offer (`ultra`, automatic delegation)
    // maps to the nearest offered one on either backend, never passed raw.
    expect(resolveRunEffort("codex", "ultra")).toBe("max");
    expect(resolveRunEffort("claude", "ultra")).toBe("max");
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
  it("claude curated: sonnet/opus/haiku aliases, effort levels, defaults", async () => {
    const cat = await getModelCatalog("claude");
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
    expect((await getModelCatalog("claude")).models.map((m) => m.value)).toEqual([
      ...CLAUDE_MODEL_ALIASES,
    ]);
    // And the shared predicate agrees with isKnownModel on its static half.
    expect(claudeModelRunsVerbatim("claude-opus-4-1-20250805")).toBe(true);
    expect(isKnownModel("claude", "claude-opus-4-1-20250805")).toBe(true);
    expect(claudeModelRunsVerbatim("claude-sonnet")).toBe(false);
    expect(claudeModelRunsVerbatim("gpt-5-codex")).toBe(false);
  });

  it("codex curated: the pinned CLI's bundled models + low…max efforts, per model", async () => {
    const cat = await getModelCatalog("codex");
    // Ruling 687: GPT-6.1 Sol is listed FIRST, so it is the fallback a
    // model-less operator or profile runs on (it replaced F20-33's Terra).
    // The rest follow the 0.160.1 bundled catalog's priority order, its
    // hidden models left out. CANARY: move GPT-6.1 Sol below another entry and
    // the Codex default becomes that model.
    expect(cat.models.map((m) => m.value)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    // `max` joined the offer with 0.153; `ultra` (automatic delegation) and
    // `persistent` (no bundled model) did not. Canary: put `ultra` in
    // CODEX_EFFORTS.
    expect(cat.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Per model, exactly as the bundled catalog lists them: GPT-5.5 stops at
    // `xhigh`, the rest reach `max`.
    const effortsOf = (id: string) => cat.models.find((m) => m.value === id)?.efforts;
    expect(effortsOf("gpt-5.5")).toEqual(["low", "medium", "high", "xhigh"]);
    for (const id of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(effortsOf(id), id).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
    expect(cat.defaultModel).toBe("gpt-6.1-sol");
    expect(cat.defaultEffort).toBe("medium");
  });

  it("returns fresh copies (callers cannot mutate the shared constant)", async () => {
    const a = await getModelCatalog("claude");
    a.models[0]!.value = "mutated";
    expect((await getModelCatalog("claude")).models[0]!.value).toBe("sonnet");
  });

  it("defaultModel is the FIRST available model (not a separate hardcoded id)", async () => {
    for (const backend of ["claude", "codex"] as const) {
      const cat = await getModelCatalog(backend);
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
  accountId: "ubc_viewer",
  accountHome: "/data/runtimes/users/u_viewer/claude-home",
  ownDirs: [],
};

describe("getModelCatalog", () => {
  it("codex is curated-only (never calls the SDK)", async () => {
    const queryFn = vi.fn<ClaudeQueryFn>();
    const cat = await getModelCatalog("codex", {
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(cat.defaultModel).toBe("gpt-6.1-sol");
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
      // The host-isolation options a run gets.
      expect(seen!.settingSources).toEqual([]);
      expect(seen!.skills).toEqual([]);
      expect(seen!.plugins).toEqual([]);
      // Isolation is off in the suite: where no agent is launched the probe
      // spawns as before (R-launcher-1 below is the launched arm).
      expect(seen!.spawnClaudeCodeProcess).toBeUndefined();
    } finally {
      delete process.env.VIBERR_CATALOG_PROBE_MARKER;
      delete process.env.MY_DEPLOY_SECRET;
      delete process.env.GITHUB_TOKEN;
      delete process.env.DATABASE_URL;
    }
  });
});

/**
 * Pass 40 review (R-launcher-1): the probe runs the vendored CLI against the
 * viewer's own `claude-home`, and a CLI with an expired OAuth token rewrites
 * `.credentials.json` there (0600). Run as the server, that file became
 * `node:node` and the viewer's agent uid could not read its own sign-in. So,
 * wherever this server launches agents, the probe goes through the launcher
 * as the viewer — or does not run at all. The stand-in launcher logs what the
 * real one reads.
 */
describe("the live probe runs as the viewer's own OS user (R-launcher-1)", () => {
  afterEach(() => resetAgentIsolationForTests());

  function standInLauncher(dir: string): string {
    const log = path.join(dir, "launch.log");
    const launcher = path.join(dir, "viberr-launch");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        'if [ "$1" = "--prepare-home" ]; then mkdir -p "$3"; exit 0; fi',
        `echo "uid=$VIBERR_LAUNCH_UID exec=$VIBERR_LAUNCH_EXEC home=$VIBERR_LAUNCH_HOME HOME=$HOME args=$*" >> '${log}'`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    resetAgentIsolationForTests(
      { status: "on", uidFloor: AGENT_UID_FLOOR, reason: null },
      { launcher },
    );
    return log;
  }

  it("spawns the CLI through the launcher as the viewer, with their home handed back afterwards", async () => {
    // Canary: drop `spawnClaudeCodeProcess` from `claudeProbeOptions` and the
    // SDK would spawn the CLI itself, as the server: no launched line.
    const ctx = createTestDbContext();
    try {
      const dir = ctx.makeTempDir("viberr-launcher-");
      const log = standInLauncher(dir);
      const cli = path.join(dir, "claude");
      writeFileSync(cli, "#!/bin/sh\nexit 0\n");
      chmodSync(cli, 0o755);
      const homeDir = path.join(ctx.makeTempDir("viberr-home-"), "claude-home");
      const credential: RunCredential = {
        ...VIEWER_CREDENTIAL,
        env: { ...VIEWER_CREDENTIAL.env, CLAUDE_CONFIG_DIR: homeDir },
        homeDir,
      };
      let spawned: ClaudeSpawnedProcess | undefined;
      const queryFn: ClaudeQueryFn = (params) => {
        // What the SDK does with the option: it hands its CLI command here.
        const options = params.options ?? {};
        spawned = options.spawnClaudeCodeProcess?.({
          command: cli,
          args: ["--output-format", "stream-json"],
          env: options.env ?? {},
        });
        return fakeQueryObject([
          { value: "sonnet", displayName: "S", description: "", supportsEffort: true },
        ]);
      };
      const cat = await getModelCatalog("claude", {
        claudeQueryFn: queryFn,
        credential,
        db: ctx.makeDb(),
        userId: "u_viewer",
      });
      expect(cat.models.map((m) => m.value)).toEqual(["sonnet"]);
      expect(spawned).toBeDefined();
      await new Promise<void>((resolve) => {
        if (spawned?.exitCode !== null) resolve();
        else spawned.once("exit", () => resolve());
      });
      const line = readFileSync(log, "utf8").trim();
      expect(line).toMatch(new RegExp(`^uid=${AGENT_UID_FLOOR} exec=${cli} home=${homeDir} `));
      expect(line).toMatch(/HOME=\S*\/runtimes\/users\/u_viewer\/home /);
      expect(line).toMatch(/args=--output-format stream-json$/);
    } finally {
      ctx.cleanup();
    }
  });

  it("serves the curated catalog rather than run the probe as the server when there is no viewer to run as", async () => {
    // Canary: skip the `launchesAgents()` guard and the probe runs as the
    // server (queryFn is called).
    const ctx = createTestDbContext();
    try {
      standInLauncher(ctx.makeTempDir("viberr-launcher-"));
      const queryFn = vi.fn<ClaudeQueryFn>();
      const cat = await getModelCatalog("claude", {
        claudeQueryFn: queryFn,
        credential: VIEWER_CREDENTIAL,
        db: ctx.makeDb(),
      });
      expect(cat.models.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
      expect(queryFn).not.toHaveBeenCalled();
    } finally {
      ctx.cleanup();
    }
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

  it("pass 34 (F34-7): a family alias with a context-window variant is known on a COLD process", () => {
    // The live catalog offers `opus[1m]` ("Opus (1M context)"); a profile
    // stores it; ten minutes later the cache is gone. The validator used to
    // substitute the catalog default and the editor rewrote the stored value.
    // Canary: remove the `CLAUDE_ALIAS_VARIANT_RE` clause from isKnownModel.
    resetModelCatalogCache();
    expect(isKnownModel("claude", "opus[1m]")).toBe(true);
    expect(resolveRunModel("claude", "opus[1m]")).toBe("opus[1m]");
    expect(isKnownModel("claude", "sonnet[1m]")).toBe(true);
    expect(isKnownModel("claude", "opus[]")).toBe(false);
    expect(isKnownModel("codex", "opus[1m]")).toBe(false);
  });

  it("pass 34 (F34-7): the variant's display name is the LIVE row's when cached, else the family name plus the variant", async () => {
    // Canary: delete the variant branch in modelDisplayName (the cold case
    // echoes the id) or the live lookup (the warm case does).
    resetModelCatalogCache();
    // Ruling 642: in the live row's words, never the bracketed id.
    expect(modelDisplayName("claude", "opus[1m]")).toBe("Claude Opus (1M context)");
    expect(modelDisplayName("claude", "opus-next")).toBe("opus-next");
    await getModelCatalog("claude", {
      credential: VIEWER_CREDENTIAL,
      claudeQueryFn: makeFakeQuery([
        {
          value: "opus[1m]",
          displayName: "Opus (1M context)",
          description: "",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
      ]),
    });
    expect(modelDisplayName("claude", "opus[1m]")).toBe("Opus (1M context)");
    // Codex has no live endpoint and no variants.
    expect(modelDisplayName("codex", "gpt-5.5[1m]")).toBe("gpt-5.5[1m]");
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
    noteModelAvailabilityFromFailure(db, {
      runId: "run_1",
      backend: "codex",
      model: "gpt-5.6-sol",
      providerText:
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    });
    const cat = await getModelCatalog("codex", { db });
    const sol = cat.models.find((m) => m.value === "gpt-5.6-sol");
    expect(sol?.unavailable?.reason).toContain("not supported");
    // An unmarked model is untouched.
    expect(
      cat.models.find((m) => m.value === "gpt-5.6-terra")?.unavailable,
    ).toBeUndefined();
  });

  it("stamps the curated Claude catalog served to a viewer with no credential", async () => {
    const db = dbCtx.makeDb();
    noteModelAvailabilityFromFailure(db, {
      runId: "run_1",
      backend: "claude",
      model: "opus",
      providerText: "model unavailable for this deployment",
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
    noteModelAvailabilityFromFailure(db, {
      runId: "run_1",
      backend: "claude",
      model: "sonnet",
      providerText: "The 'sonnet' model is not supported for this account",
    });
    const after = await getModelCatalog("claude", {
      db,
      claudeQueryFn: queryFn,
      credential: VIEWER_CREDENTIAL,
    });
    expect(after.models[0]!.unavailable?.reason).toBe(
      "The 'sonnet' model is not supported for this account",
    );
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

/**
 * Ruling 139 (pass 34, G34-1): the save-time effort/model assertions the
 * controller's typed write surfaces and the profile editor share.
 *
 * Canary: route `assertEffortForBackend` through `resolveRunEffort` (clamp
 * instead of refuse) and the refusal cases answer nothing.
 */
describe("assertEffortForBackend / assertModelForBackend (ruling 139)", () => {
  it("accepts every tier the backend offers and refuses the rest by name, listing the tiers", () => {
    for (const backend of ["claude", "codex"] as const) {
      for (const tier of effortsFor(backend)) {
        expect(() => assertEffortForBackend(backend, tier)).not.toThrow();
      }
    }
    expect(() => assertEffortForBackend("codex", "ultra")).toThrow(
      /"ultra" is not an effort tier Codex offers\. Codex takes: low, medium, high, xhigh, max\./,
    );
    expect(() => assertEffortForBackend("codex", "persistent")).toThrow(/Codex takes:/);
    expect(() => assertEffortForBackend("claude", "ultra")).toThrow(/Claude takes: low, medium, high, xhigh, max/);
    expect(() => assertEffortForBackend("claude", "")).toThrow(/"\(empty\)" is not an effort tier/);
    // Codex `minimal` is accepted at run time but NOT offered: the write
    // surfaces refuse it; the editor only refuses it when CHANGED (A34).
    expect(() => assertEffortForBackend("codex", "minimal")).toThrow();
  });

  it("refuses a model the OTHER backend recognises, with the F21-13 sentence, and passes an open Claude id", () => {
    expect(() => assertModelForBackend("claude", "gpt-5.6-terra")).toThrow(
      /GPT-5\.6 Terra is a Codex model\. Claude cannot run it\. Pick a model from the Claude list\./,
    );
    expect(() => assertModelForBackend("codex", "opus")).toThrow(/is a Claude model\. Codex cannot run it/);
    expect(() => assertModelForBackend("claude", "claude-sonnet-4-5")).not.toThrow();
    expect(() => assertModelForBackend("claude", "opus[1m]")).not.toThrow();
    expect(() => assertModelForBackend("codex", "gpt-5.6-terra")).not.toThrow();
  });

  it("pass 34 review: an id CODEX does not list is refused by name, never silently substituted", () => {
    // Canary: drop the closed-catalogue branch — the controller stores
    // `gpt-5.7-nova`, `resolveRunModel` substitutes the default at start, and
    // every surface reports a model that never ran.
    expect(() => assertModelForBackend("codex", "gpt-5.7-nova")).toThrow(
      /"gpt-5\.7-nova" is not a model Codex offers\. Codex takes: /,
    );
    // Claude stays OPEN (dated ids and account-listed models run verbatim).
    expect(() => assertModelForBackend("claude", "claude-fable-5-1")).not.toThrow();
  });
});
