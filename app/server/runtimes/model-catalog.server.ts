import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import { resolveClaudeConfigDir } from "./claude-config.server";
import {
  claudeSpawnEnv,
  isBackendAvailable,
  type RealBackend,
} from "./runtime-registry.server";
import type {
  ClaudeQueryFn,
  ClaudeQueryOptions,
} from "./claude-runtime.server";

/**
 * Model + effort (reasoning) CATALOG for the agent create/edit UI.
 *
 * Agent profiles used to hardcode `model: "claude-sonnet"` — an INVALID model
 * id that makes a real Claude run fail ("model may not exist"). The picker
 * populated by this catalog offers real, valid choices per backend and lets a
 * profile store the selected model + effort; runs then pass the chosen effort
 * to the SDK.
 *
 * Two layers, both non-blocking and safe with no credential / offline / in
 * tests:
 *
 *   1. CURATED fallback — always available. Family aliases the CLI/SDK resolve
 *      to the latest model of that tier the account can use (claude), or a
 *      small hand-maintained model list (codex, which has NO list endpoint).
 *   2. ENHANCED (claude only) — when `isBackendAvailable('claude')`, a
 *      lightweight `query()` + `.supportedModels()` returns the LIVE list for
 *      the account/subscription, mapped to the same shape, cached in-process
 *      with a short TTL. On any throw/timeout it silently falls back to
 *      curated. The SDK query fn is injectable so tests use a fake (no spawn).
 *
 * The curated codex ids below are hand-maintained current ids and are
 * intentionally editable — Codex exposes no models endpoint, so the list is
 * a best-effort snapshot, not a live enumeration.
 */

// ------------------------------------------------------------------ shape

export interface CatalogModel {
  /** Value stored on the profile + passed to the runtime (alias or real id). */
  value: string;
  displayName: string;
  description: string;
  /** Whether this model accepts an effort/reasoning level. */
  supportsEffort: boolean;
  /** Effort levels valid for THIS model (subset of the backend efforts). */
  efforts?: string[];
}

export interface ModelCatalog {
  models: CatalogModel[];
  /** All effort levels the backend supports (superset used as the default set). */
  efforts: string[];
  defaultModel: string;
  defaultEffort: string;
}

// ------------------------------------------------------------ curated data

/** Claude family aliases — the CLI/SDK resolve each to the latest model of
 *  that tier the account can use, so they are always valid. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const CLAUDE_MODELS: CatalogModel[] = [
  {
    value: "sonnet",
    displayName: "Claude Sonnet",
    description: "Balanced speed and capability — the everyday default.",
    supportsEffort: true,
    efforts: [...CLAUDE_EFFORTS],
  },
  {
    value: "opus",
    displayName: "Claude Opus",
    description: "Most capable — deepest reasoning for the hardest work.",
    supportsEffort: true,
    efforts: [...CLAUDE_EFFORTS],
  },
  {
    value: "haiku",
    displayName: "Claude Haiku",
    description: "Fastest and lightest — quick, cheap turns.",
    supportsEffort: true,
    efforts: [...CLAUDE_EFFORTS],
  },
];

const CLAUDE_CURATED: ModelCatalog = {
  models: CLAUDE_MODELS,
  efforts: [...CLAUDE_EFFORTS],
  // The default is just the FIRST available model — it's a starting point the
  // user changes in the picker, so we never hardcode a specific id that could
  // drift out of the list.
  defaultModel: CLAUDE_MODELS[0]!.value,
  defaultEffort: "high",
};

/** Codex has no account-scoped list endpoint in the TypeScript SDK, so this is
 *  a hand-maintained snapshot of the current ChatGPT-plan model catalog. Keep
 *  effort values inside the SDK's ModelReasoningEffort union; the product's
 *  newer Max/Ultra UI modes are not ThreadOptions values in SDK 0.144.1. */
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

const CODEX_MODELS: CatalogModel[] = [
  {
    value: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description:
      "Flagship model for complex coding, research, and high-value work.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  {
    value: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description:
      "Balanced everyday workhorse with strong reasoning and tool use.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  {
    value: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Fast model for clear, repeatable, well-scoped tasks.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  {
    value: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Previous-generation model retained for existing profiles.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
];

const CODEX_CURATED: ModelCatalog = {
  models: CODEX_MODELS,
  efforts: [...CODEX_EFFORTS],
  // Default = the first available model (a changeable starting point). Sol is
  // the current recommended starting model for ChatGPT-plan Codex usage.
  defaultModel: CODEX_MODELS[0]!.value,
  defaultEffort: "medium",
};

/** Deep clone so callers can't mutate the shared curated constants. */
function cloneCatalog(cat: ModelCatalog): ModelCatalog {
  return structuredClone(cat);
}

/** The always-available curated fallback for a backend (fresh copy). */
export function curatedCatalog(backend: RealBackend): ModelCatalog {
  return cloneCatalog(backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED);
}

/**
 * The default model id for a backend — the FIRST available (curated) model.
 * Sync + always a valid, currently-available id, so run/reply/profile code can
 * fall back to it without hardcoding a specific model that might drift out of
 * the catalog (the user changes it in the picker anyway).
 */
export function defaultModelFor(backend: RealBackend): string {
  return (backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED).defaultModel;
}

/** The default reasoning effort for a backend (from the curated catalog). */
export function defaultEffortFor(backend: RealBackend): string {
  return (backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED).defaultEffort;
}

/**
 * A dated/versioned real Claude model id — `claude-` plus a digit somewhere,
 * e.g. `claude-sonnet-4-5`. Exactly what `resolveClaudeModel`
 * (claude-runtime) forwards to the SDK verbatim, and the shape a live
 * `supportedModels()` row can carry. Deliberately NOT matched by the seed
 * display labels this guard exists to reject (`claude-sonnet` has no digit).
 */
const DATED_CLAUDE_ID_RE = /^claude-.*\d/;

/**
 * Is `model` a real, valid model id for `backend`?
 *
 * Claude: the curated family aliases, PLUS anything the LIVE catalog offered
 * (see below), PLUS a dated `claude-*` id. Codex: the curated list only —
 * Codex exposes no list endpoint, so the picker can never offer anything else.
 * Display labels from seed profiles ("codex-large · claude-sonnet",
 * "claude-sonnet", "codex-large", "orchestration runtime") are NOT valid ids
 * and still return false.
 *
 * P13-RT-07: `getModelCatalog("claude")` serves the account's LIVE
 * `supportedModels()` list to the profile modal, which stores the chosen
 * `value` — but this validator consulted the three curated aliases only, so
 * `resolveRunModel` silently substituted `sonnet` for a value the picker itself
 * had offered. Every run then executed on Sonnet while the agents page showed
 * an "unknown model" badge, which read as a bug in the badge. The picker and
 * the validator now agree: whatever the live catalog listed is accepted, and a
 * dated id is accepted even when the live list has since been evicted from the
 * cache (that cache is a 10-minute in-process TTL, not a source of truth).
 */
export function isKnownModel(backend: RealBackend, model: string): boolean {
  const cat = backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED;
  if (cat.models.some((m) => m.value === model)) return true;
  if (backend === "codex") return false;
  if (DATED_CLAUDE_ID_RE.test(model)) return true;
  return liveCatalogModelValues("claude").has(model);
}

/**
 * Resolve a stored profile model to a valid RUN model id for `backend`: the
 * stored value when it is a real catalog id, else the backend default. This is
 * the guard that stops a display-label placeholder (e.g. "codex-large ·
 * claude-sonnet") from reaching the SDK, where it fails with "model not found"
 * / "not supported when using Codex with a ChatGPT account". Every path that
 * starts a real run resolves the model through here.
 */
export function resolveRunModel(
  backend: RealBackend,
  model: string | null | undefined,
): string {
  const m = (model ?? "").trim();
  return m && isKnownModel(backend, m) ? m : defaultModelFor(backend);
}

/**
 * Resolve a reasoning-effort tier to a VALID one for `backend`. Backends have
 * different tiers (Claude: low…max; Codex: low…xhigh), so a "retry on the
 * other backend" (D4) must translate — for example, passing Claude-only `max`
 * to Codex would be rejected. An unknown/empty value,
 * or one that doesn't exist on the target, falls back to that backend's default
 * effort. Same-backend valid values pass through unchanged.
 */
export function resolveRunEffort(
  backend: RealBackend,
  effort: string | null | undefined,
): string {
  const e = (effort ?? "").trim();
  const cat = backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED;
  if (e && cat.efforts.includes(e)) return e;
  // Map by intensity RANK across the two tier scales so a cross-backend retry
  // keeps a comparable level instead of snapping to the default.
  const RANK: Record<string, number> = {
    minimal: 0,
    low: 1,
    medium: 2,
    high: 3,
    xhigh: 4,
    max: 5,
  };
  if (e && e in RANK) {
    const wanted = RANK[e]!;
    let best = cat.defaultEffort;
    let bestDist = Infinity;
    for (const opt of cat.efforts) {
      const d = Math.abs((RANK[opt] ?? 2) - wanted);
      if (d < bestDist) {
        bestDist = d;
        best = opt;
      }
    }
    return best;
  }
  return cat.defaultEffort;
}

/** The friendly display name for a model id (from the curated catalog), or the
 *  id itself when it is not a curated model (e.g. a live-only or legacy value). */
export function modelDisplayName(backend: RealBackend, model: string): string {
  const cat = backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED;
  return cat.models.find((m) => m.value === model)?.displayName ?? model;
}

// ------------------------------------------------------------ live (claude)

/** One row of the Claude SDK's `supportedModels()` result (the subset we use). */
export interface SdkModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  /** SDK field name is `supportedEffortLevels`. */
  supportedEffortLevels?: string[];
}

interface CatalogDeps {
  /** Injected Claude SDK `query` (tests). Default: the real SDK, lazily loaded. */
  claudeQueryFn?: ClaudeQueryFn;
  /** Overridable availability check (tests). */
  isAvailable?: (backend: RealBackend) => boolean;
  /** Live-fetch timeout in ms (default 15000). */
  timeoutMs?: number;
}

const LIVE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LIVE_TIMEOUT_MS = 15_000;

interface CacheEntry {
  at: number;
  catalog: ModelCatalog;
}

const CATALOG_KEY = Symbol.for("viberr.modelCatalog");

function getCache(): Map<RealBackend, CacheEntry> {
  const g = globalThis as unknown as Record<symbol, Map<RealBackend, CacheEntry> | undefined>;
  let cache = g[CATALOG_KEY];
  if (!cache) {
    cache = new Map();
    g[CATALOG_KEY] = cache;
  }
  return cache;
}

/** Test-only: clear the in-process live cache. */
export function resetModelCatalogCache(): void {
  getCache().clear();
}

/**
 * The model ids the LIVE catalog last offered for a backend (P13-RT-07).
 * Deliberately ignores the TTL: the TTL governs when to REFETCH, not whether a
 * value the picker already offered (and a profile already stored) is real. On a
 * cold process the cache is empty and validation falls back to the curated
 * aliases + the dated-id shape, which covers the ids `supportedModels()`
 * actually returns for Claude.
 */
function liveCatalogModelValues(backend: RealBackend): Set<string> {
  const entry = getCache().get(backend);
  return new Set(entry?.catalog.models.map((m) => m.value) ?? []);
}

/** Map a `supportedModels()` row to a catalog model. */
function mapSdkModel(m: SdkModelInfo): CatalogModel {
  const supportsEffort = m.supportsEffort === true;
  return {
    value: m.value,
    displayName: m.displayName || m.value,
    description: m.description || "",
    supportsEffort,
    ...(supportsEffort && Array.isArray(m.supportedEffortLevels)
      ? { efforts: [...m.supportedEffortLevels] }
      : {}),
  };
}

let cachedQueryFn: ClaudeQueryFn | null = null;
async function realQueryFn(): Promise<ClaudeQueryFn> {
  if (cachedQueryFn) return cachedQueryFn;
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: ClaudeQueryFn;
  };
  cachedQueryFn = mod.query;
  return cachedQueryFn;
}

/**
 * The SDK options for the `supportedModels()` probe — the SAME confinement a
 * real run gets (F10-02, re-broken here and re-fixed).
 *
 * `query()` spawns the `claude` binary even when the stream is never iterated,
 * and the SDK **REPLACES** the child env with `options.env` (only defaulting to
 * `{...process.env}` when the field is ABSENT). Passing `options: {}` therefore
 * handed the probe the FULL server environment — the GitHub PAT, the session
 * signing secret, `VIBERR_SECRET_ENCRYPTION_KEY`, every provider key — and let
 * it read/write the operator's personal `~/.claude`. This probe is reachable
 * from the agent create/edit UI on every catalog miss, so it must be confined
 * exactly like a run: the filtered spawn env from `claudeSpawnEnv` plus a
 * deterministic `CLAUDE_CONFIG_DIR`, and the host-isolation trio the adapter
 * sets (`settingSources`/`skills`/`plugins`).
 *
 * Exported so the confinement is assertable — see the model-catalog tests.
 */
export function claudeProbeOptions(): ClaudeQueryOptions {
  const env = getEnv();
  return {
    env: claudeSpawnEnv(
      resolveClaudeConfigDir(),
      env.ANTHROPIC_API_KEY,
      env.CLAUDE_CODE_OAUTH_TOKEN,
    ),
    settingSources: [],
    skills: [],
    plugins: [],
    maxTurns: 1,
  };
}

/** A lightweight query whose ONLY purpose is calling `.supportedModels()`.
 *  We never iterate the stream — the query object exposes the method directly.
 *  The options are still the confined ones: constructing the query is what
 *  spawns the binary, so "we never iterate" is not isolation. */
async function fetchLiveClaudeModels(
  queryFn: ClaudeQueryFn,
  timeoutMs: number,
): Promise<SdkModelInfo[]> {
  const q = queryFn({ prompt: "", options: claudeProbeOptions() }) as unknown as {
    supportedModels?: () => Promise<SdkModelInfo[]>;
    interrupt?: () => Promise<void>;
  };
  if (typeof q.supportedModels !== "function") {
    throw new Error("query() has no supportedModels()");
  }
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("supportedModels timed out")), timeoutMs);
  });
  try {
    return await Promise.race([q.supportedModels(), timeout]);
  } finally {
    // Best-effort tidy of the lightweight query (never iterated).
    try {
      await q.interrupt?.();
    } catch {
      // Already settled — ignore.
    }
  }
}

/** Build a Claude catalog from a live `supportedModels()` list, keeping the
 *  curated defaults/effort superset as the anchor. */
function claudeCatalogFromLive(models: SdkModelInfo[]): ModelCatalog {
  const mapped = models.map(mapSdkModel);
  const base = cloneCatalog(CLAUDE_CURATED);
  const defaultModel =
    mapped.find((m) => m.value === base.defaultModel)?.value ??
    mapped[0]?.value ??
    base.defaultModel;
  return {
    models: mapped,
    efforts: base.efforts,
    defaultModel,
    defaultEffort: base.defaultEffort,
  };
}

// ------------------------------------------------------------ public API

/**
 * The model + effort catalog for a backend. Claude enhances the curated
 * fallback with the LIVE `supportedModels()` list when the backend is
 * available (cached with a short TTL); codex is curated-only. NEVER throws —
 * any live failure logs and returns curated.
 */
export async function getModelCatalog(
  backend: RealBackend,
  deps: CatalogDeps = {},
): Promise<ModelCatalog> {
  if (backend === "codex") return curatedCatalog("codex");

  const available = (deps.isAvailable ?? isBackendAvailable)("claude");
  if (!available) return curatedCatalog("claude");

  // Serve a fresh cached live result.
  const cache = getCache();
  const hit = cache.get("claude");
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) {
    return cloneCatalog(hit.catalog);
  }

  try {
    const queryFn = deps.claudeQueryFn ?? (await realQueryFn());
    const timeoutMs = deps.timeoutMs ?? LIVE_TIMEOUT_MS;
    const live = await fetchLiveClaudeModels(queryFn, timeoutMs);
    if (!Array.isArray(live) || live.length === 0) {
      return curatedCatalog("claude");
    }
    const catalog = claudeCatalogFromLive(live);
    cache.set("claude", { at: Date.now(), catalog });
    return cloneCatalog(catalog);
  } catch (error) {
    logger.info("model catalog live fetch failed — using curated", {
      backend,
      err: error instanceof Error ? error.message : String(error),
    });
    return curatedCatalog("claude");
  }
}
