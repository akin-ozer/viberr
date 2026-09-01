import { loadEnvFile } from "node:process";
import { z } from "zod";

/** No `.env` at all is the normal case (container, CI, a shell-exported env) —
 *  any OTHER failure is a real configuration fault and must reach the operator. */
const missingEnvFile = z.object({ code: z.literal("ENOENT") });

try {
  loadEnvFile();
} catch (error) {
  if (!missingEnvFile.safeParse(error).success) throw error;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  /** Port for the HTTP server (dev server and react-router-serve). */
  PORT: z.coerce.number().int().min(1).max(65535).default(5173),

  /** Signs the session cookie. Random string, at least 32 characters. */
  VIBERR_SESSION_SECRET: z
    .string({
      error:
        "required — random string of at least 32 characters (generate: openssl rand -base64 48)",
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
   * by better-auth to build OAuth callback + cookie URLs. Optional in dev
   * (better-auth infers the origin from the request); REQUIRED behind a
   * reverse proxy so redirects and cookies resolve to the public host.
   */
  BETTER_AUTH_URL: z.url("must be an absolute URL").optional(),

  /**
   * AES-256-GCM key for encrypting stored secrets (e.g. GitHub PATs).
   * Must be base64 that decodes to exactly 32 bytes. Parsed into a Buffer.
   */
  VIBERR_SECRET_ENCRYPTION_KEY: z
    .string({
      error:
        "required — base64 encoding of exactly 32 random bytes (generate: openssl rand -base64 32)",
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
  VIBERR_DATA_ROOT: z.string().min(1).default("./data"),

  // B-FD1: boot takes an exclusive single-writer lock on the data root, so a
  // second process pointed at the same volume refuses to start instead of
  // clobbering the WAL. Set to 1/true to take a live-looking lock over — for a
  // lock orphaned by a host that no longer exists, which no liveness probe on
  // this machine can rule out.
  VIBERR_FORCE_DATA_ROOT_LOCK: z.string().optional(),

  // R19-19: absolute path of the chromium binary the browser MCP server drives.
  // The image sets it (/usr/bin/chromium); when set, the mount builder passes
  // --executable-path AND --no-sandbox (docker's default seccomp blocks the
  // user-namespace sandbox for non-root). Unset on a dev host, Playwright's own
  // browser resolution applies — which may require `npx playwright install
  // chromium` for the alpha playwright @playwright/mcp pins, or pointing this
  // at a local Chrome build.
  VIBERR_BROWSER_EXECUTABLE: z.string().min(1).optional(),

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

  // Optional runtime-backend API keys. When absent, runs fail fast with an
  // availability error. Presence is a cheap auth check; the
  // registry NEVER makes a paid call to detect availability.
  //  - Claude Agent SDK: ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN (from
  //    `claude setup-token` — the subscription/OAuth path), or set
  //    VIBERR_CLAUDE_USE_CLI_AUTH=1 to use an already-logged-in `claude` CLI.
  //  - Codex SDK: CODEX_ACCESS_TOKEN (ChatGPT Business/Enterprise subscription
  //    automation), CODEX_API_KEY / OPENAI_API_KEY, or
  //    VIBERR_CODEX_USE_CLI_AUTH=1 for an existing `codex login`.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  VIBERR_CLAUDE_USE_CLI_AUTH: z.string().optional(),
  // Claude Agent SDK config/session dir. Sessions live at
  // $CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl; default it under the data
  // volume so a resumed session (commenting an agent) survives restarts.
  CLAUDE_CONFIG_DIR: z.string().optional(),
  // ChatGPT-workspace Codex credential for trusted non-interactive workflows.
  // Unlike CODEX_API_KEY / OPENAI_API_KEY, this uses workspace subscription
  // entitlements rather than Platform API billing.
  CODEX_ACCESS_TOKEN: z.string().min(1).optional(),
  CODEX_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Codex ChatGPT-plan (subscription) login dir — `codex login` writes
  // auth.json here (default ~/.codex). Point it at a mounted volume in a
  // container so the subscription auth (and its token refresh) persists.
  CODEX_HOME: z.string().optional(),
  VIBERR_CODEX_USE_CLI_AUTH: z.string().optional(),

  // Optional runtime tuning knobs. Parsed as raw strings here (the call sites
  // apply their own numeric coercion + fallback default); declaring them keeps
  // the validated env surface complete instead of reading raw process.env.
  //  - VIBERR_CLAUDE_MAX_TURNS: runaway turn cap for a Claude run (default 2000).
  //  - VIBERR_CODEX_IDLE_TIMEOUT_MS: idle window before a Codex run is treated as
  //    hung, in ms (default 15 minutes).
  //  - VIBERR_CLAUDE_IDLE_TIMEOUT_MS: the same guard for a Claude run (P13-RT-11 —
  //    Claude runs had no hang guard at all, so a stalled run pinned the
  //    delivering single-flight until the next restart).
  //  - VIBERR_GIT_CLONE_TIMEOUT_MS: ceiling on one `git clone`/mirror fetch, in
  //    ms (default 15 minutes; `cloneTimeoutMs()` in git-clone-auth.server.ts,
  //    which the scheduler's claim lease is sized against). Ignored unless it
  //    parses to a positive integer.
  //  - VIBERR_TRANSCRIPT_RETENTION_DAYS: age at which a raw `runtimes/<backend>/
  //    <runId>.jsonl` transcript is pruned (default 30; `0` keeps them forever).
  //  - VIBERR_SESSION_HOME_RETENTION_DAYS: the same window for the provider
  //    session homes the app owns (default 30; `0` keeps them forever).
  //
  // C3 (pass 31): the last three were read straight off `process.env` with no
  // declaration here, so `.env.example` and this schema — the two places an
  // operator looks for "what can I configure" — both denied they existed.
  VIBERR_CLAUDE_MAX_TURNS: z.string().optional(),
  VIBERR_CODEX_IDLE_TIMEOUT_MS: z.string().optional(),
  VIBERR_CLAUDE_IDLE_TIMEOUT_MS: z.string().optional(),
  VIBERR_GIT_CLONE_TIMEOUT_MS: z.string().optional(),
  VIBERR_TRANSCRIPT_RETENTION_DAYS: z.string().optional(),
  VIBERR_SESSION_HOME_RETENTION_DAYS: z.string().optional(),
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

function formatEnvError(error: z.ZodError): string {
  const lines = error.issues.map(
    (issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`,
  );
  return [
    "Invalid environment configuration:",
    ...lines,
    "",
    "Fix the variables above and restart. See .env.example for documentation of every variable.",
  ].join("\n");
}

/**
 * Pure parser: validates a raw env record and returns the typed config.
 * Empty-string values are treated as unset (common in .env files).
 * Throws an Error with a multi-line message listing every problem at once.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== "") cleaned[key] = value;
  }
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(formatEnvError(result.error));
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
 */
export function getEnv(): Env {
  const cache = envSlot();
  let env = cache[ENV_CACHE_KEY];
  if (!env) {
    env = parseEnv(process.env);
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
    "session cookies are issued WITHOUT Secure and travel in cleartext — any " +
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
