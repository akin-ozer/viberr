import { loadEnvFile } from "node:process";
import { z } from "zod";
import { withInstanceSecrets } from "./instance-secrets.server";

/** No `.env` at all is the normal case (container, CI, a shell-exported env) —
 *  any OTHER failure is a real configuration fault and must reach the operator. */
const missingEnvFile = z.object({ code: z.literal("ENOENT") });

try {
  loadEnvFile();
} catch (error) {
  if (!missingEnvFile.safeParse(error).success) throw error;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const DEFAULT_DATA_ROOT = "./data";

const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const MINUTE_MS = 60_000;

/** Ruling 458(i): the longest period either maintenance timer may be set to —
 *  a day. */
const MAX_PERIOD_SECONDS = 24 * HOUR_S;
/** Maintenance-pass cadence. Six hours: retention windows are 30-90 days, so a
 *  pass is cheap and rarely finds anything; the point is that a 90-day uptime
 *  gets ~360 passes instead of zero. `VIBERR_MAINTENANCE_INTERVAL_SECONDS`
 *  overrides it. */
export const DEFAULT_MAINTENANCE_INTERVAL_SECONDS = 6 * HOUR_S;
/** Free-space check cadence. Five minutes: disks fill over hours, and this is
 *  the signal that must arrive BEFORE the volume is full, not after. */
const DEFAULT_DISK_CHECK_INTERVAL_SECONDS = 5 * MINUTE_S;
/** Free space on the data root, in MB, below which the deployment is degraded
 *  but still working (why absolute sizes: `disk-space.server.ts`). */
export const DEFAULT_DISK_LOW_FREE_MB = 2048;
/** Free space, in MB, below which a single run can plausibly fill the volume. */
export const DEFAULT_DISK_CRITICAL_FREE_MB = 512;

/** Turn cap for a Claude run — a RUNAWAY guard, not a work budget. The old
 *  hard-coded 50 cut off legitimate dev runs mid-delivery (observed live: a
 *  completed implementation died at turn 51 on `gh --version`). Deliberately
 *  huge (owner ruling 2026-07-17): real runs should never hit it. */
const DEFAULT_CLAUDE_MAX_TURNS = 2000;
/** The idle window before a run is treated as hung, for both backends: 15
 *  minutes (owner ruling A8). */
const DEFAULT_RUN_IDLE_TIMEOUT_MS = 15 * MINUTE_MS;
/** The ceiling on one `git clone` / mirror fetch: 15 minutes. It stops a hung
 *  clone; it does not rule on how big a repository may be (`cloneTimeoutMs`). */
const DEFAULT_GIT_CLONE_TIMEOUT_MS = 15 * MINUTE_MS;
/** Raw run transcripts: aligned with RUN_LOG_RETENTION_DAYS so the file and its
 *  projection disappear together instead of contradicting each other. */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 30;
/** Provider session homes: the window the providers themselves keep. */
export const DEFAULT_SESSION_HOME_RETENTION_DAYS = 30;

/**
 * Ruling 458(c): a knob that must be a positive number. `Number()` coercion,
 * as the modules applied it, and a value that is not a finite number above zero
 * fails boot instead of quietly running the default.
 */
function positiveNumber(unit: string, fallback: number) {
  const message = `must be a positive number of ${unit}`;
  return z.coerce
    .number({ error: message })
    .positive(message)
    .default(fallback);
}

/** Ruling 458(j): a count of at least one, rounded down as its call site did
 *  (`Math.floor`), so a fraction below one fails boot instead of meaning 0. */
function wholeCount(unit: string, fallback: number) {
  const message = `must be a number of ${unit}, 1 or more`;
  return z.coerce
    .number({ error: message })
    .min(1, message)
    .transform(Math.floor)
    .default(fallback);
}

/** Ruling 458(i): a timer period in seconds, above zero and at most a day. */
function periodSeconds(fallback: number) {
  const message = `must be a number of seconds above 0 and at most ${MAX_PERIOD_SECONDS} (24 hours)`;
  return z.coerce
    .number({ error: message })
    .positive(message)
    .max(MAX_PERIOD_SECONDS, message)
    .default(fallback);
}

/** Ruling 458(j): a retention window in days, where `0` is a real setting that
 *  keeps the files forever (not an absent one). */
function retentionDays(fallback: number) {
  const message = "must be a number of days, 0 or more (0 keeps them forever)";
  return z.coerce
    .number({ error: message })
    .min(0, message)
    .default(fallback);
}

/**
 * Ruling 458(i): variables the app no longer reads, each with the message that
 * names its replacement. A deployment that still sets one fails boot with the
 * rest of the invalid variables, instead of silently running the default.
 */
const RETIRED_ENV = {
  VIBERR_MAINTENANCE_INTERVAL_MS:
    "retired; set VIBERR_MAINTENANCE_INTERVAL_SECONDS instead (the period in seconds, default 21600)",
  VIBERR_DISK_CHECK_INTERVAL_MS:
    "retired; set VIBERR_DISK_CHECK_INTERVAL_SECONDS instead (the period in seconds, default 300)",
} as const;

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  /** Port for the HTTP server (dev server and react-router-serve). */
  PORT: z.coerce.number().int().min(1).max(65535).default(5173),

  /** Signs the session cookie. Random string, at least 32 characters.
   *  `getEnv()` fills it from the data root when unset (ruling 504). */
  VIBERR_SESSION_SECRET: z
    .string({
      error:
        "required, random string of at least 32 characters (generate: openssl rand -base64 48)",
    })
    .min(32, "must be at least 32 characters of random data"),

  /**
   * better-auth cookie-signing secret. Optional — defaults to
   * VIBERR_SESSION_SECRET so no new required config. Set it only to rotate the
   * auth secret independently of the legacy session secret.
   */
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "must be at least 32 characters of random data")
    .optional(),

  /**
   * Absolute public origin of the app, e.g. https://viberr.example.com. Used
   * by better-auth to build OAuth callback + cookie URLs, and by
   * `assertTrustedOrigin` as the origin form posts are accepted from (ruling
   * 683). Optional in dev (better-auth infers the origin from the request);
   * REQUIRED behind a reverse proxy so redirects, cookies and form posts
   * resolve to the public host.
   */
  BETTER_AUTH_URL: z.url("must be an absolute URL").optional(),

  /**
   * AES-256-GCM key for encrypting stored secrets (e.g. GitHub PATs).
   * Must be base64 that decodes to exactly 32 bytes. Parsed into a Buffer.
   * `getEnv()` fills it from the data root when unset (ruling 504).
   */
  VIBERR_SECRET_ENCRYPTION_KEY: z
    .string({
      error:
        "required, base64 encoding of exactly 32 random bytes (generate: openssl rand -base64 32)",
    })
    .transform((value, ctx) => {
      const normalized = value.trim();
      if (!BASE64_RE.test(normalized) || normalized.length % 4 !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "must be valid base64 (generate: openssl rand -base64 32)",
        });
        return z.NEVER;
      }
      const key = Buffer.from(normalized, "base64");
      if (key.byteLength !== 32) {
        ctx.addIssue({
          code: "custom",
          message: `must decode to exactly 32 bytes, got ${key.byteLength} (generate: openssl rand -base64 32)`,
        });
        return z.NEVER;
      }
      return key;
    }),

  /** Runtime data root (canonical files, sqlite projections, logs). */
  VIBERR_DATA_ROOT: z.string().min(1).default(DEFAULT_DATA_ROOT),

  // B-FD1: boot takes an exclusive single-writer lock on the data root, so a
  // second process pointed at the same volume refuses to start instead of
  // clobbering the WAL. Set to 1/true to take a live-looking lock over — for a
  // lock orphaned by a host that no longer exists, which no liveness probe on
  // this machine can rule out.
  VIBERR_FORCE_DATA_ROOT_LOCK: z.string().optional(),

  // Ruling 636: where each agent run's own temporary directory is made
  // (`<root>/<runId>`, the run's TMPDIR), removed when the run settles. Unset,
  // it is `viberr-runs` under the server's temp directory: in the image the
  // container's /tmp, which goes with the container.
  VIBERR_RUN_TMP_ROOT: z.string().min(1).optional(),

  // R19-19: absolute path of the chromium binary the browser MCP server drives.
  // The image sets it (/usr/bin/chromium); when set, the mount builder passes
  // --executable-path AND --no-sandbox (docker's default seccomp blocks the
  // user-namespace sandbox for non-root). Unset on a dev host, Playwright's own
  // browser resolution applies — which may require `npx playwright install
  // chromium` for the alpha playwright @playwright/mcp pins, or pointing this
  // at a local Chrome build.
  VIBERR_BROWSER_EXECUTABLE: z.string().min(1).optional(),

  // Ruling 461: the port of the loopback MCP gateway (always bound to
  // 127.0.0.1) that a run reaches a credentialed org MCP server through.
  // 0, the default, picks a free port at boot and reads it back; set it only
  // when something on the host needs the port fixed.
  VIBERR_MCP_PROXY_PORT: z.coerce
    .number({ error: "must be a port number, 0-65535 (0 picks a free port)" })
    .int("must be a port number, 0-65535 (0 picks a free port)")
    .min(0, "must be a port number, 0-65535 (0 picks a free port)")
    .max(65535, "must be a port number, 0-65535 (0 picks a free port)")
    .default(0),

  // Optional OAuth providers — the login buttons stay disabled when unset.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),

  // Optional seed admin credentials (consumed by `npm run seed`, phase 3).
  VIBERR_SEED_ADMIN_EMAIL: z.email("must be a valid email address").optional(),
  VIBERR_SEED_ADMIN_PASSWORD: z
    .string()
    .min(8, "must be at least 8 characters")
    .optional(),

  // Ruling 127: the deployment-wide agent-backend credentials are GONE
  // (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, VIBERR_CLAUDE_USE_CLI_AUTH,
  // CLAUDE_CONFIG_DIR, CODEX_ACCESS_TOKEN, CODEX_API_KEY, OPENAI_API_KEY,
  // CODEX_HOME, VIBERR_CODEX_USE_CLI_AUTH). Every person connects Claude and
  // Codex on Profile -> Agent accounts; the credential lives in that person's
  // runtime home or sealed in `user_backend_credentials`, and each run's
  // spawn env is built from the credential of the ONE person it bills. An
  // instance-wide key would bill every run to whoever owns it, which is
  // exactly what the ruling forbids — so there is nothing to declare here.

  // Optional runtime tuning knobs. Ruling 458(j): the schema parses them, as it
  // does the C01-A6 knobs below, so each call site reads a typed value and a
  // value that does not parse fails boot, where the call sites' own coercion
  // used to run the default in silence:
  //  - VIBERR_CLAUDE_MAX_TURNS: runaway turn cap for a Claude run (default 2000).
  //  - VIBERR_CODEX_IDLE_TIMEOUT_MS: idle window before a Codex run is treated as
  //    hung, in ms (default 15 minutes).
  //  - VIBERR_CLAUDE_IDLE_TIMEOUT_MS: the same guard for a Claude run (P13-RT-11 —
  //    Claude runs had no hang guard at all, so a stalled run pinned the
  //    delivering single-flight until the next restart).
  //  - VIBERR_GIT_CLONE_TIMEOUT_MS: ceiling on one `git clone`/mirror fetch, in
  //    ms (default 15 minutes; `cloneTimeoutMs()` in git-clone-auth.server.ts,
  //    which the scheduler's claim lease is sized against).
  //  - VIBERR_TRANSCRIPT_RETENTION_DAYS: age at which a raw `runtimes/<backend>/
  //    <runId>.jsonl` transcript is pruned (default 30; `0` keeps them forever).
  //  - VIBERR_SESSION_HOME_RETENTION_DAYS: the same window for the provider
  //    session homes the app owns (default 30; `0` keeps them forever).
  //
  // C3 (pass 31): the last three were read straight off `process.env` with no
  // declaration here, so `.env.example` and this schema — the two places an
  // operator looks for "what can I configure" — both denied they existed.
  VIBERR_CLAUDE_MAX_TURNS: wholeCount("turns", DEFAULT_CLAUDE_MAX_TURNS),
  VIBERR_CODEX_IDLE_TIMEOUT_MS: positiveNumber("ms", DEFAULT_RUN_IDLE_TIMEOUT_MS),
  VIBERR_CLAUDE_IDLE_TIMEOUT_MS: positiveNumber("ms", DEFAULT_RUN_IDLE_TIMEOUT_MS),
  VIBERR_GIT_CLONE_TIMEOUT_MS: positiveNumber("ms", DEFAULT_GIT_CLONE_TIMEOUT_MS),
  VIBERR_TRANSCRIPT_RETENTION_DAYS: retentionDays(DEFAULT_TRANSCRIPT_RETENTION_DAYS),
  VIBERR_SESSION_HOME_RETENTION_DAYS: retentionDays(
    DEFAULT_SESSION_HOME_RETENTION_DAYS,
  ),
  // C01-A6 (pass 32) declared the last raw `process.env` readers so the schema
  // and `.env.example` stop denying they exist. Ruling 458(c): the schema also
  // parses the first five, and their modules read the typed value through
  // `getEnv()`. A value that does not parse fails boot like every other key,
  // where each module's own fallback used to run the default in silence:
  //  - VIBERR_MAINTENANCE_INTERVAL_SECONDS: period of the maintenance pass
  //    (retention, transcript pruning; default 6 h).
  //  - VIBERR_DISK_CHECK_INTERVAL_SECONDS: period of the free-space check
  //    (default 5 minutes).
  //    Ruling 458(i): both periods are in seconds, at most a day (a longer
  //    period is refused, not stretched), and the `_MS` names they replace
  //    are refused at boot (`RETIRED_ENV`).
  //  - VIBERR_DISK_LOW_FREE_MB / VIBERR_DISK_CRITICAL_FREE_MB: the free-space
  //    thresholds behind health's `disk.status` (defaults 2048 / 512).
  //  - VIBERR_GITHUB_WRITE_PROBE: `1`/`true`/`yes` opts PAT validation into the
  //    empty-payload write dry-run (ruling 18); `0`/`false`/`no`, or unset,
  //    leaves it off.
  //  - VIBERR_BUILD_VERSION / VIBERR_BUILD_SHA / VIBERR_BUILD_TIME: build
  //    identity baked into the image (build-info.server.ts); null when unset.
  VIBERR_MAINTENANCE_INTERVAL_SECONDS: periodSeconds(
    DEFAULT_MAINTENANCE_INTERVAL_SECONDS,
  ),
  VIBERR_DISK_CHECK_INTERVAL_SECONDS: periodSeconds(
    DEFAULT_DISK_CHECK_INTERVAL_SECONDS,
  ),
  VIBERR_DISK_LOW_FREE_MB: positiveNumber("MB", DEFAULT_DISK_LOW_FREE_MB),
  VIBERR_DISK_CRITICAL_FREE_MB: positiveNumber(
    "MB",
    DEFAULT_DISK_CRITICAL_FREE_MB,
  ),
  // Ruling 603: a directory on the host disk the data root's filesystem lives
  // on, measured beside the data root (`measureDataRootSpace`). Compose sets
  // it to its read-only `/host-disk` mount, because Docker Desktop's volume
  // reports the VM disk image's virtual size, not the host's free space.
  // Unset, only the data root is measured.
  VIBERR_HOST_DISK_PATH: z.string().min(1).optional(),
  VIBERR_GITHUB_WRITE_PROBE: z
    .enum(["1", "true", "yes", "0", "false", "no"], {
      error:
        "must be 1, true or yes to turn the write dry-run on (0, false or no leaves it off)",
    })
    .transform((value) => value === "1" || value === "true" || value === "yes")
    .default(false),
  VIBERR_BUILD_VERSION: z.string().optional(),
  VIBERR_BUILD_SHA: z.string().optional(),
  VIBERR_BUILD_TIME: z.string().optional(),
  // Ruling 108: the controller's configuration sections are LOCKED by default
  // — the Controller settings tab shows them read-only and `saveControllerConfig`
  // refuses a change, org admins included. A variable set to `enabled` unlocks
  // ONE section for in-app editing; `disabled` (or any other value, or unset)
  // keeps it locked. Set them in the deployment environment and restart. Model
  // and effort stay editable either way, and the built-in `viberr_ops`
  // diagnostics mount is not a section: it is never removable.
  VIBERR_UNLOCK_CONTROLLER_SKILLS: z.string().optional(),
  VIBERR_UNLOCK_CONTROLLER_KB: z.string().optional(),
  VIBERR_UNLOCK_CONTROLLER_MCPS: z.string().optional(),
  VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS: z.string().optional(),
  // Number of trusted reverse proxies in front of the app (default 0 = none).
  // Only when set does the login throttle read X-Forwarded-For, and then as the
  // Nth hop from the right — the ip the outermost trusted proxy saw. Left unset
  // in the shipped proxy-less deployment, where the header is pure client input
  // (see clientIpOf in rate-limit.server.ts).
  VIBERR_TRUST_PROXY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Every variable the schema declares — the list the "no undeclared env reads"
 * gate (`env.server.test.ts`) compares raw `process.env.VIBERR_*` reads
 * against, and holds `.env.example` to, so a knob cannot ship that neither
 * this file nor `.env.example` admits exists (C3, pass 31; C01-A6, pass 32).
 */
export const ENV_KEYS: readonly string[] = envSchema.keyof().options;

function formatEnvError(
  problems: readonly { path: string; message: string }[],
): string {
  return [
    "Invalid environment configuration:",
    ...problems.map(({ path, message }) => `  - ${path}: ${message}`),
    "",
    "Fix the variables above and restart. See .env.example for documentation of every variable.",
  ].join("\n");
}

/**
 * Pure parser: validates a raw env record and returns the typed config.
 * Empty-string values are treated as unset (common in .env files).
 * Throws an Error with a multi-line message listing every problem at once,
 * a retired variable (`RETIRED_ENV`) included.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== "") cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  const problems = [
    ...(result.success ? [] : result.error.issues).map((issue) => ({
      path: issue.path.join(".") || "(env)",
      message: issue.message,
    })),
    ...Object.entries(RETIRED_ENV)
      .filter(([key]) => key in cleaned)
      .map(([path, message]) => ({ path, message })),
  ];
  if (!result.success || problems.length > 0) {
    throw new Error(formatEnvError(problems));
  }
  return result.data;
}

// Cached across dev-server HMR module reloads via a well-known global symbol.
const ENV_CACHE_KEY = Symbol.for("viberr.env");

interface EnvSlot {
  [ENV_CACHE_KEY]?: Env;
}

function envSlot(): EnvSlot {
  // SAFETY: `globalThis` carries no static type for a symbol-keyed slot. The key
  // is module-private, and the only writes to it anywhere in the process are the
  // two below (`getEnv` stores what it just parsed, `resetEnvCacheForTests`
  // clears it), so the slot holds a parsed Env or nothing.
  return globalThis as EnvSlot;
}

/**
 * Parses process.env exactly once per process and caches the result.
 * Call at boot so a bad configuration fails fast with a clear message.
 * A secret the environment leaves unset comes from the data root, generated
 * there by the first process to get here (ruling 504).
 */
export function getEnv(): Env {
  const cache = envSlot();
  let env = cache[ENV_CACHE_KEY];
  if (!env) {
    env = parseEnv(withInstanceSecrets(process.env, DEFAULT_DATA_ROOT));
    cache[ENV_CACHE_KEY] = env;
  }
  return env;
}

/** Test-only: clears the process-wide env cache. */
export function resetEnvCacheForTests(): void {
  envSlot()[ENV_CACHE_KEY] = undefined;
}

/**
 * N20-4 (§5a) — the app's absolute public origin, or `null` when it cannot be
 * known here. Derived from `BETTER_AUTH_URL`, the only configured absolute
 * origin: R19-16's request-derived `callbackOrigin` is unavailable off-request,
 * and PR bodies are composed from background operator runs (no request to
 * derive one from). Trimmed and trailing-slash-stripped; `null` unless it is an
 * `http(s)` origin.
 *
 * A `null` result is honest, not a fallback to a relative path: a relative
 * `/projects/…` link 404s on github.com (worse than none), so the composer
 * omits the link and writes the plain store-relative task key instead.
 */
/**
 * U8 — the session cookie's `Secure` attribute is derived from this URL, and
 * nothing said so.
 *
 * Viberr never sets a cookie security flag itself: better-auth reads
 * `BETTER_AUTH_URL` and issues `__Secure-` cookies only when it starts with
 * `https://`. So `BETTER_AUTH_URL=http://viberr.internal` silently downgrades
 * every production session cookie to cleartext — AND removes the one accidental
 * signal `docs/operations/deployment.md` documents as the symptom of a missing
 * TLS proxy (the `__Secure-` login loop). The failure was silent in both
 * directions, against NFR6.
 *
 * A WARNING, not a refusal: this value is `.optional()` and legitimate
 * deployments set it late, so refusing at boot would brick a running install
 * over a misconfiguration the operator can fix in seconds. It fires only where
 * it is unambiguous — production, an explicit `http://` origin, and a host that
 * is not a loopback name (a `http://localhost:5173` production build is someone
 * testing the image locally, where cleartext to itself is not the finding).
 *
 * Exported as a pure function so the rule is testable without booting: `null`
 * means nothing to say.
 */
export function insecureAuthOriginWarning(
  env: Pick<Env, "NODE_ENV" | "BETTER_AUTH_URL">,
): string | null {
  if (env.NODE_ENV !== "production") return null;
  const raw = env.BETTER_AUTH_URL?.trim();
  if (!raw || !/^http:\/\//i.test(raw)) return null;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    // An unparseable value is the schema's problem, not this check's.
    return null;
  }
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";
  if (loopback) return null;
  return (
    `BETTER_AUTH_URL is an http:// origin in production (${raw}). ` +
    "better-auth derives the session cookie's Secure attribute from it, so " +
    "session cookies are issued WITHOUT Secure and travel in cleartext; any " +
    "listener on the network path can replay them. Set BETTER_AUTH_URL to the " +
    "https:// origin your reverse proxy terminates TLS on (NFR6; see " +
    "docs/operations/deployment.md)."
  );
}

export function appOrigin(): string | null {
  const raw = getEnv().BETTER_AUTH_URL;
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed || null;
}
