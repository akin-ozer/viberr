import { logger } from "~/server/logging/logger.server";
import { isBackendAvailable, type RealBackend } from "./runtime-registry.server";
import type { ClaudeQueryFn } from "./claude-runtime.server";

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

const CLAUDE_CURATED: ModelCatalog = {
  models: [
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
  ],
  efforts: [...CLAUDE_EFFORTS],
  defaultModel: "sonnet",
  defaultEffort: "high",
};

/** Codex has NO list endpoint, so this is a hand-maintained snapshot of
 *  reasonable current ids — intentionally editable. */
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

const CODEX_CURATED: ModelCatalog = {
  models: [
    {
      value: "gpt-5-codex",
      displayName: "GPT-5 Codex",
      description: "Codex-tuned GPT-5 — the default for coding runs.",
      supportsEffort: true,
      efforts: [...CODEX_EFFORTS],
    },
    {
      value: "gpt-5",
      displayName: "GPT-5",
      description: "General-purpose GPT-5.",
      supportsEffort: true,
      efforts: [...CODEX_EFFORTS],
    },
    {
      value: "o4-mini",
      displayName: "o4-mini",
      description: "Small, fast reasoning model for lighter turns.",
      supportsEffort: true,
      efforts: [...CODEX_EFFORTS],
    },
  ],
  efforts: [...CODEX_EFFORTS],
  defaultModel: "gpt-5-codex",
  defaultEffort: "medium",
};

/** Deep clone so callers can't mutate the shared curated constants. */
function cloneCatalog(cat: ModelCatalog): ModelCatalog {
  return {
    models: cat.models.map((m) => ({
      ...m,
      ...(m.efforts ? { efforts: [...m.efforts] } : {}),
    })),
    efforts: [...cat.efforts],
    defaultModel: cat.defaultModel,
    defaultEffort: cat.defaultEffort,
  };
}

/** The always-available curated fallback for a backend (fresh copy). */
export function curatedCatalog(backend: RealBackend): ModelCatalog {
  return cloneCatalog(backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED);
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

/** A lightweight query whose ONLY purpose is calling `.supportedModels()`.
 *  We never iterate the stream — the query object exposes the method directly. */
async function fetchLiveClaudeModels(
  queryFn: ClaudeQueryFn,
  timeoutMs: number,
): Promise<SdkModelInfo[]> {
  const q = queryFn({ prompt: "", options: {} }) as unknown as {
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
