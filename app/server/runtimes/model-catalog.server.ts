import type { DatabaseSync } from "node:sqlite";
import { AppError } from "~/server/errors/app-error.server";
import { logger } from "~/server/logging/logger.server";
import {
  CLAUDE_ALIAS_VARIANT_RE,
  DATED_CLAUDE_ID_RE,
  splitClaudeVariant,
} from "~/shared/model-ids";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import type { RunCredential } from "./backend-credentials.server";
import { unavailableModels } from "./model-availability.server";
import {
  filteredSpawnEnv,
  type RealBackend,
} from "./runtime-registry.server";
import type {
  ClaudeQueryFn,
  ClaudeQueryOptions,
} from "./claude-runtime.server";
import {
  agentLaunchFor,
  launchesAgents,
  type AgentLaunch,
} from "./agent-isolation.server";
import { spawnClaudeCli } from "./claude-spawn.server";
import { errorMessage } from "~/shared/errors";

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
 *   2. ENHANCED (claude only) — when the CALLER supplies a Claude
 *      `RunCredential` (ruling 127: the VIEWER's own, resolved by the route
 *      with `requireUser`), a lightweight `query()` + `.supportedModels()`
 *      returns the LIVE list for THAT account/subscription, mapped to the same
 *      shape, cached in-process with a short TTL. With no credential the
 *      curated list is the whole answer — there is no instance account to ask,
 *      and asking one person's account for another's picker would show models
 *      the second person cannot run. On any throw/timeout it silently falls
 *      back to curated. The SDK query fn is injectable so tests use a fake (no
 *      spawn).
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
  /** R20-3 (F20-4): set when the PROVIDER refused this model for this
   *  deployment's account (learned from a real run's failure, ruling 19). The
   *  picker disables it and shows the reason; it clears on the next success. */
  unavailable?: { reason: string; markedAt: string };
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
 *  a hand-maintained snapshot of the models the PINNED CLI can run
 *  (`CODEX_SDK_VERIFIED_VERSION`, codex-runtime.server.ts): the catalog JSON
 *  embedded in the `codex` binary (read off 0.153.4), plus the models the
 *  account's server sends only to a new enough client (GPT-6 Sol and Luna,
 *  added with 0.156.0; the CLI caches that list as `models_cache.json` in the
 *  principal's CODEX_HOME, with the `client_version` it was fetched for). Effort values
 *  stay inside the SDK's `ModelReasoningEffort` union, which gained `max`,
 *  `ultra` and `persistent` in 0.149–0.153. `max` is offered per model exactly
 *  where the catalog lists it. `ultra` is NOT offered: the catalog describes it
 *  as "maximum reasoning with automatic task delegation", i.e. the model
 *  spawning its own sub-agents, the orchestration Viberr reserves for the
 *  operator (Claude denies the whole Task family for the same reason).
 *  `persistent` is supported by no bundled model. The union's `minimal` is
 *  deliberately not OFFERED either; `resolveCodexReasoningEffort` still accepts
 *  it so a profile that already stored it keeps running on its tier. */
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** GPT-5.5's catalog entry stops at `xhigh`. */
const CODEX_EFFORTS_TO_XHIGH = ["low", "medium", "high", "xhigh"] as const;

// F20-33: Terra is listed FIRST, so it is the fallback default
// (`defaultModelFor("codex")` = `CODEX_MODELS[0]` — the "default is the first
// model" invariant). Sol is the flagship, but a ChatGPT-plan Codex account 400s
// on it ("The 'gpt-5.6-sol' model is not supported when using Codex with a
// ChatGPT account."), and this fallback is what an operator (or any profile)
// with no concrete Codex model resolves to — so a fresh operator-on-Codex must
// land on Terra, the CLI default that actually runs, not Sol. Sol stays offered
// (a profile can still pick it; F20-4 then marks it unavailable from a real
// failure) — it is just no longer the default.
const CODEX_MODELS: CatalogModel[] = [
  {
    value: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description:
      "Balanced everyday workhorse with strong reasoning and tool use.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  // Codex CLI 0.153 (the SDK 0.153.4 upgrade, 2026-09-06): the catalog's new
  // headline model — listed first in the CLI's own picker and its bundled
  // default when no model is configured (0.153.4 hotfix). Offered, NOT the
  // default: Terra keeps F20-33's reason (a ChatGPT-plan account 400s on
  // Sol, and Astra's plan availability is unverified here), and F20-4 marks
  // it unavailable from a real failure exactly as it does Sol.
  {
    value: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    description: "Most capable model for complex, demanding work.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  // Codex CLI 0.156.0 (2026-09-23, owner's request): GPT-6 Sol and GPT-6 Luna
  // are NOT in the binary's bundled catalog. The account's server sends them,
  // and only to a client at `minimal_client_version` 0.155.0 or later, so
  // 0.153.4 could never run them. Their levels are the server's: both stop at
  // `max` here, since `ultra` (Sol's) is the sub-agent tier Viberr never
  // offers. Offered, NOT the default (F20-33 still holds for the fallback).
  {
    value: "gpt-6-sol",
    displayName: "GPT-6 Sol",
    description: "Workhorse model for coding and everyday work.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  {
    value: "gpt-6-luna",
    displayName: "GPT-6 Luna",
    description: "Fast and affordable model for well-scoped tasks.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  {
    value: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description:
      "Previous-generation flagship for complex coding, research, and high-value work.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  {
    value: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    description: "Previous-generation fast model; GPT-6 Luna supersedes it.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS],
  },
  {
    value: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Previous-generation model retained for existing profiles.",
    supportsEffort: true,
    efforts: [...CODEX_EFFORTS_TO_XHIGH],
  },
];

const CODEX_CURATED: ModelCatalog = {
  models: CODEX_MODELS,
  efforts: [...CODEX_EFFORTS],
  // Default = the first available model (a changeable starting point). F20-33
  // put Terra first because Sol 400s on a ChatGPT-plan Codex account.
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

/** The effort tiers a backend OFFERS (the curated list; Codex's accepted but
 *  unoffered `minimal` is deliberately absent, see `CODEX_EFFORTS`). */
export function effortsFor(backend: RealBackend): readonly string[] {
  return (backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED).efforts;
}

/**
 * Ruling 139 (pass 34, G34-1): refuse an effort tier the backend does not
 * list, BY NAME, at save time. `resolveRunEffort` clamps an unknown tier at
 * run time, which is the same silent substitution F21-13 closed for models:
 * the controller answered `[done]` for an `effort: "max"` it had stripped, and
 * a Codex deployment saved with `max` would have run `xhigh`. Lives on the
 * write surfaces that take a typed argument (`deploy_agent`,
 * `update_agent_deployment`) and, for a CHANGED value only, in the profile
 * editor: an unconditional refusal there would make a deployment storing a
 * legitimately preserved tier (Codex `minimal`) unsaveable.
 */
export function assertEffortForBackend(backend: RealBackend, effort: string): void {
  const e = effort.trim();
  const tiers = effortsFor(backend);
  if (tiers.includes(e)) return;
  throw AppError.validation(
    `"${e || "(empty)"}" is not an effort tier ${BACKEND_LABEL[backend]} offers. ` +
      `${BACKEND_LABEL[backend]} takes: ${tiers.join(", ")}.`,
  );
}

/**
 * Ruling 139: the F21-13 check, extracted so the controller's typed write
 * surfaces and the profile editor refuse a foreign model with ONE sentence.
 * Only a model the OTHER backend recognises is refused: the Claude catalogue is
 * open (a dated id or a live-only id passes), so "unknown here" alone is not
 * evidence of a mistake.
 */
export function assertModelForBackend(backend: RealBackend, model: string): void {
  const foreign = foreignModelBackend(backend, model);
  // Pass 34 review: Codex's list is CLOSED (`CODEX_MODELS`), and
  // `resolveRunModel` silently substitutes anything else at start — the same
  // silent substitution ruling 139 refuses for effort. An id Codex does not
  // list is refused here, by name, rather than stored and reported as what
  // runs. The foreign-model sentence (F21-13) wins when it applies: it names
  // the backend that DOES run the id, which is the more useful answer.
  const id = model.trim();
  if (!foreign && backend === "codex" && id && !isKnownModel("codex", id)) {
    throw AppError.validation(
      `"${id}" is not a model Codex offers. Codex takes: ${CODEX_MODELS.map((m) => m.value).join(", ")}.`,
    );
  }
  if (!foreign) return;
  throw AppError.validation(
    `${modelDisplayName(foreign, model)} is a ${BACKEND_LABEL[foreign]} model. ` +
      `${BACKEND_LABEL[backend]} cannot run it. Pick a model from the ` +
      `${BACKEND_LABEL[backend]} list.`,
  );
}

// The dated-id rule lives in ~/shared/model-ids (ruling 106 review, D1): the
// client model pickers must ask the SAME "would a run execute this verbatim?"
// question, or an unlisted-but-valid stored id gets silently rewritten to the
// catalog default on open and repinned on the next save.

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
  // Pass 34 (F34-7): a family alias with a context-window variant (`opus[1m]`)
  // is what the live catalog offers and what a profile stores; it is known
  // BEFORE the live cache is consulted, so a cold process never substitutes
  // the catalog default for a value the picker itself offered.
  if (CLAUDE_ALIAS_VARIANT_RE.test(model)) return true;
  return liveCatalogModelValues("claude").has(model);
}

/**
 * The backend that DOES recognize `model`, when the chosen `backend` does not —
 * else null. F21-13.
 *
 * This is the precise shape of the live defect: the profile editor let Save race
 * the backend-switch model reload, so `backends: [claude]` was persisted next to
 * `model: gpt-5.6-terra`. Nothing rejected the pair; at run time
 * `resolveClaudeModel` simply didn't recognize the id, returned undefined, and
 * the SDK quietly ran its own default — the agents page said one thing and the
 * run did another, with no trace anywhere.
 *
 * Deliberately NARROWER than `!isKnownModel(backend, model)`: the Claude side of
 * the catalog is OPEN (a live `supportedModels()` id, a dated id, and on a cold
 * process an id whose live cache entry has been evicted all pass through
 * legitimately), so "unknown here" alone is not evidence of a mistake. "Known on
 * the OTHER backend" is. Codex's catalog is closed, so a foreign check there is
 * exact by construction.
 */
export function foreignModelBackend(
  backend: RealBackend,
  model: string | null | undefined,
): RealBackend | null {
  const m = (model ?? "").trim();
  if (!m || isKnownModel(backend, m)) return null;
  const other: RealBackend = backend === "codex" ? "claude" : "codex";
  return isKnownModel(other, m) ? other : null;
}

/**
 * F21-13 / F36-8 (pass 36): what a run on `backend` EXECUTES when handed
 * `model` — the model itself when this backend knows it, the backend default
 * when the id belongs to the OTHER backend (`foreignBackend` names it). ONE
 * home for the swap: `startRun` performs and discloses it (the row stores
 * `model`, the run log opens with the notice), and the callers that must name
 * the swap BEFORE the row exists — the specialist dispatch's timeline event, the
 * recovery packet's `retry_other_backend` option — read the same answer here
 * instead of pre-swapping, which is what used to hide the substitution from
 * run-service altogether.
 */
export interface ModelSubstitution {
  /** The model the run executes. */
  model: string;
  /** The backend that knows the requested id when THIS one does not; null
   *  when no substitution happened. */
  foreignBackend: RealBackend | null;
}

export function substituteRunModel(
  backend: RealBackend,
  model: string,
): ModelSubstitution {
  const foreignBackend = foreignModelBackend(backend, model);
  return {
    model: foreignBackend ? defaultModelFor(backend) : model,
    foreignBackend,
  };
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

/** Intensity rank of every effort tier either backend offers — the shared
 *  scale a cross-backend retry translates through. */
const EFFORT_RANK = new Map<string, number>([
  ["minimal", 0],
  ["low", 1],
  ["medium", 2],
  ["high", 3],
  ["xhigh", 4],
  ["max", 5],
  // Codex-only and unoffered (see CODEX_EFFORTS); ranked so a stored value
  // lands on the nearest offered tier instead of the default.
  ["ultra", 6],
]);

/**
 * Resolve a reasoning-effort tier to a VALID one for `backend`. The two tier
 * scales differ at the edges (Codex accepts `minimal` and ranks `ultra` above
 * `max`; both offer low…max since Codex CLI 0.153), so a "retry on the other
 * backend" (D4) must translate rather than pass a value raw. An unknown/empty
 * value, or one that doesn't exist on the target, falls back to that
 * backend's default effort. Same-backend valid values pass through unchanged.
 */
export function resolveRunEffort(
  backend: RealBackend,
  effort: string | null | undefined,
): string {
  const e = (effort ?? "").trim();
  const cat = backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED;
  if (e && cat.efforts.includes(e)) return e;
  // Map by intensity rank across the two tier scales so a cross-backend retry
  // keeps a comparable level instead of snapping to the default.
  const wanted = EFFORT_RANK.get(e);
  if (wanted !== undefined) {
    let best = cat.defaultEffort;
    let bestDist = Infinity;
    for (const opt of cat.efforts) {
      const d = Math.abs((EFFORT_RANK.get(opt) ?? 2) - wanted);
      if (d < bestDist) {
        bestDist = d;
        best = opt;
      }
    }
    return best;
  }
  return cat.defaultEffort;
}

/**
 * The friendly display name for a model id: the curated name; else the LIVE
 * catalog row's name whenever the cache holds the id ("Opus (1M context)" for
 * `opus[1m]`, pass 34 F34-7); else, for a family alias carrying a
 * context-window variant, the curated family name plus the variant ("Claude
 * Opus [1m]"), which is only the cold-process fallback; else the id itself
 * (a live-only or legacy value; the UI pairs that with a substitution flag).
 */
export function modelDisplayName(backend: RealBackend, model: string): string {
  const cat = backend === "codex" ? CODEX_CURATED : CLAUDE_CURATED;
  const curated = cat.models.find((m) => m.value === model)?.displayName;
  if (curated) return curated;
  if (backend === "codex") return model;
  const live = liveCatalogDisplayName("claude", model);
  if (live) return live;
  if (CLAUDE_ALIAS_VARIANT_RE.test(model)) {
    const { base, variant } = splitClaudeVariant(model);
    const family = cat.models.find((m) => m.value === base)?.displayName;
    if (family && variant) return `${family} ${variant}`;
  }
  return model;
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
  /** Ruling 127: the VIEWER's Claude credential, resolved by the caller
   *  (`runCredentialFor` after `requireUser`). Absent — the viewer has not
   *  connected Claude — means the curated list IS the answer; there is no
   *  instance account left to enumerate against. */
  credential?: RunCredential;
  /** Live-fetch timeout in ms (default 15000). */
  timeoutMs?: number;
  /** R20-3 (F20-4): the db to read `model_availability` marks from. When
   *  present, each returned model is stamped `unavailable` per its row. The
   *  read is per-request and applied AFTER `cloneCatalog`, so a mark that
   *  changes takes effect on the next call with NO cache invalidation — the
   *  TTL live cache never freezes an availability mark. */
  db?: DatabaseSync;
  /** Pass 40 review (R-launcher-1): the viewer, whose own OS user the live
   *  probe runs as when this server launches agents (ruling 460). Without it
   *  (or without `db`) a launching server serves the curated catalog rather
   *  than run the probe as itself. */
  userId?: string;
}

/**
 * Stamp `unavailable` onto a FRESH catalog copy from the `model_availability`
 * table. Mutates in place — every caller passes a clone (curatedCatalog /
 * cloneCatalog return fresh objects), so the shared curated constants and the
 * cached live catalog are never touched.
 */
function stampUnavailability(
  catalog: ModelCatalog,
  backend: RealBackend,
  db?: DatabaseSync,
): ModelCatalog {
  if (!db) return catalog;
  const marks = unavailableModels(db, backend);
  if (marks.size === 0) return catalog;
  for (const m of catalog.models) {
    const mark = marks.get(m.value);
    if (mark) m.unavailable = { reason: mark.reason, markedAt: mark.markedAt };
  }
  return catalog;
}

const LIVE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LIVE_TIMEOUT_MS = 15_000;

interface CacheEntry {
  at: number;
  catalog: ModelCatalog;
  /** Ruling 127: WHOSE account produced this list. A live catalog is what one
   *  person's Claude subscription offers, so serving it to a second viewer
   *  would show them models their own account may refuse. The home dir is the
   *  per-person identity `runCredentialFor` already hands us; a hit for a
   *  different one is a miss. */
  homeDir: string;
}

const CATALOG_KEY = Symbol.for("viberr.modelCatalog");

/** The process-global slot the live cache lives in — a well-known symbol, so a
 *  dev-server HMR reload of this module keeps serving the same cache. */
interface CatalogCacheHost {
  [CATALOG_KEY]?: Map<RealBackend, CacheEntry>;
}

function getCache(): Map<RealBackend, CacheEntry> {
  // SAFETY: `CATALOG_KEY` is a registry symbol under a viberr-namespaced key
  // that only this module reads or writes, so the slot holds either the map
  // this function put there or nothing at all.
  const g = globalThis as CatalogCacheHost;
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
 * Deliberately ignores the TTL — and, since ruling 127, whose account produced
 * the entry: the TTL governs when to REFETCH, and the owner governs what to
 * SHOW; neither governs whether a value the picker already offered (and a
 * profile already stored) is a real model id. On a cold process the cache is
 * empty and validation falls back to the curated aliases + the dated-id shape,
 * which covers the ids `supportedModels()` actually returns for Claude.
 */
function liveCatalogModelValues(backend: RealBackend): Set<string> {
  const entry = getCache().get(backend);
  return new Set(entry?.catalog.models.map((m) => m.value) ?? []);
}

/** The LIVE catalog's display name for an id it last offered, else null; the
 *  same TTL-blind read as {@link liveCatalogModelValues}. */
function liveCatalogDisplayName(backend: RealBackend, model: string): string | null {
  const entry = getCache().get(backend);
  return entry?.catalog.models.find((m) => m.value === model)?.displayName ?? null;
}

/** Map a `supportedModels()` row to a catalog model. */
function mapSdkModel(m: SdkModelInfo): CatalogModel {
  const supportsEffort = m.supportsEffort === true;
  const mapped: CatalogModel = {
    value: m.value,
    displayName: m.displayName || m.value,
    description: m.description || "",
    supportsEffort,
  };
  // A model the SDK gave no level list for carries NO `efforts` key at all, so
  // the picker falls back to the catalog's effort superset for it.
  if (supportsEffort && Array.isArray(m.supportedEffortLevels)) {
    mapped.efforts = [...m.supportedEffortLevels];
  }
  return mapped;
}

let cachedQueryFn: ClaudeQueryFn | null = null;
async function realQueryFn(): Promise<ClaudeQueryFn> {
  if (cachedQueryFn) return cachedQueryFn;
  // SAFETY: `ClaudeQueryFn` widens the SDK's own `query` signature (prompt
  // `AsyncIterable<unknown>`, our `ClaudeQueryOptions`), so the SDK type is not
  // directly assignable to it. The widening is unreachable here: the module's
  // ONLY call is `fetchLiveClaudeModels`, which passes the string prompt `""`
  // and `claudeProbeOptions()` — both inside what the SDK's signature accepts.
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
 * exactly like a run: `filteredSpawnEnv()` plus the ONE credential this probe
 * is allowed to use, and the host-isolation trio the adapter sets
 * (`settingSources`/`skills`/`plugins`).
 *
 * Ruling 127: that credential is the VIEWER's — their home and, if they pasted
 * one, their key, exactly as `runCredentialFor` assembles it for a run. The
 * probe spends nothing (listing models is free), but it does read a personal
 * account, so it reads the account of the person who asked.
 *
 * Exported so the confinement is assertable — see the model-catalog tests.
 */
export function claudeProbeOptions(
  credential: RunCredential,
  launch: AgentLaunch | null = null,
): ClaudeQueryOptions {
  const env = { ...filteredSpawnEnv(), ...credential.env };
  const options: ClaudeQueryOptions = {
    env,
    settingSources: [],
    skills: [],
    plugins: [],
    maxTurns: 1,
  };
  // Pass 40 review (R-launcher-1): the probe runs the vendored CLI against the
  // viewer's own `claude-home`, and a CLI whose OAuth token has expired
  // refreshes it and rewrites `.credentials.json` there (0600). Run as the
  // server, that left a `node:node` file the viewer's agent uid could not
  // read, and their next run failed as signed out. So it runs as the viewer,
  // through the launcher, exactly like their runs: the CLI is spawned by
  // `spawnClaudeCli` with the launch, `$HOME` is their agent home, and the
  // launcher hands the vendor home back once the probe exits. A throwaway
  // copy of the home would not do: the CLI ROTATES the refresh token when it
  // refreshes, so a refresh in a copy would spend the one in the real home.
  if (launch) {
    if (launch.home) env.HOME = launch.home;
    options.spawnClaudeCodeProcess = (request) =>
      spawnClaudeCli(request, undefined, undefined, launch).process;
  }
  return options;
}

/** The probe surface of an SDK query object. `ClaudeQuery` describes the
 *  STREAMING contract a run consumes; `supportedModels()` is the extra method
 *  this probe wants and older SDK builds may not carry, hence both optional. */
interface ModelProbeQuery {
  supportedModels?: () => Promise<SdkModelInfo[]>;
  interrupt?: () => Promise<void>;
}

/** A lightweight query whose ONLY purpose is calling `.supportedModels()`.
 *  We never iterate the stream — the query object exposes the method directly.
 *  The options are still the confined ones: constructing the query is what
 *  spawns the binary, so "we never iterate" is not isolation. */
async function fetchLiveClaudeModels(
  queryFn: ClaudeQueryFn,
  credential: RunCredential,
  timeoutMs: number,
  launch: AgentLaunch | null,
): Promise<SdkModelInfo[]> {
  const q: ModelProbeQuery = queryFn({
    prompt: "",
    options: claudeProbeOptions(credential, launch),
  });
  if (!q.supportedModels) {
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
 * fallback with the LIVE `supportedModels()` list when the CALLER supplies the
 * viewer's Claude credential (cached with a short TTL); codex is curated-only.
 * NEVER throws — any live failure logs and returns curated.
 */
export async function getModelCatalog(
  backend: RealBackend,
  deps: CatalogDeps = {},
): Promise<ModelCatalog> {
  // R20-3: `stampUnavailability` runs on the returned copy at EVERY exit, after
  // the (unstamped) catalog is cached — so the mark is fresh per request.
  const stamp = (c: ModelCatalog) => stampUnavailability(c, backend, deps.db);
  if (backend === "codex") return stamp(curatedCatalog("codex"));

  const credential = deps.credential;
  if (!credential) return stamp(curatedCatalog("claude"));

  // Serve a fresh cached live result — but only the one this viewer's own
  // account produced (ruling 127).
  const cache = getCache();
  const hit = cache.get("claude");
  if (
    hit &&
    hit.homeDir === credential.homeDir &&
    Date.now() - hit.at < LIVE_TTL_MS
  ) {
    return stamp(cloneCatalog(hit.catalog));
  }

  // R-launcher-1: with isolation on, the probe runs as the viewer or not at
  // all (ruling 460(h): never a silent fallback to the server's own user).
  let launch: AgentLaunch | null = null;
  if (launchesAgents()) {
    if (!deps.db || !deps.userId) {
      logger.info("model catalog live fetch skipped — no viewer to run the probe as", { backend });
      return stamp(curatedCatalog("claude"));
    }
    try {
      launch = agentLaunchFor(deps.db, deps.userId, credential.homeDir);
    } catch (error) {
      logger.info("model catalog live fetch skipped — the probe cannot run as the viewer", {
        backend,
        err: errorMessage(error),
      });
      return stamp(curatedCatalog("claude"));
    }
  }

  try {
    const queryFn = deps.claudeQueryFn ?? (await realQueryFn());
    const timeoutMs = deps.timeoutMs ?? LIVE_TIMEOUT_MS;
    const live = await fetchLiveClaudeModels(queryFn, credential, timeoutMs, launch);
    if (!Array.isArray(live) || live.length === 0) {
      return stamp(curatedCatalog("claude"));
    }
    const catalog = claudeCatalogFromLive(live);
    cache.set("claude", { at: Date.now(), catalog, homeDir: credential.homeDir });
    return stamp(cloneCatalog(catalog));
  } catch (error) {
    logger.info("model catalog live fetch failed — using curated", {
      backend,
      err: errorMessage(error),
    });
    return stamp(curatedCatalog("claude"));
  }
}
