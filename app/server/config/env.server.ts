import dotenv from "dotenv";
import { z } from "zod";

// Load .env for local dev. Values already present in the real environment
// always win (dotenv never overrides). No-ops silently when .env is absent.
dotenv.config({ quiet: true });

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

  // Optional runtime-backend API keys (Phase 8). When absent the requested
  // real backend falls back to the simulated engine (simulated=1, requested
  // backend kept for glyph fidelity). Presence is a cheap auth check — the
  // registry NEVER makes a paid call to detect availability.
  //  - Claude Agent SDK: ANTHROPIC_API_KEY, or CLAUDE_CODE_OAUTH_TOKEN (from
  //    `claude setup-token` — the subscription/OAuth path), or set
  //    VIBERR_CLAUDE_USE_CLI_AUTH=1 to use an already-logged-in `claude` CLI.
  //  - Codex SDK: CODEX_API_KEY / OPENAI_API_KEY, or VIBERR_CODEX_USE_CLI_AUTH=1
  //    for an existing `codex login`.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1).optional(),
  VIBERR_CLAUDE_USE_CLI_AUTH: z.string().optional(),
  CODEX_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Codex ChatGPT-plan (subscription) login dir — `codex login` writes
  // auth.json here (default ~/.codex). Point it at a mounted volume in a
  // container so the subscription auth (and its token refresh) persists.
  CODEX_HOME: z.string().optional(),
  VIBERR_CODEX_USE_CLI_AUTH: z.string().optional(),
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

/**
 * Parses process.env exactly once per process and caches the result.
 * Call at boot so a bad configuration fails fast with a clear message.
 */
export function getEnv(): Env {
  const cache = globalThis as unknown as Record<symbol, Env | undefined>;
  let env = cache[ENV_CACHE_KEY];
  if (!env) {
    env = parseEnv(process.env);
    cache[ENV_CACHE_KEY] = env;
  }
  return env;
}

/** Test-only: clears the process-wide env cache. */
export function resetEnvCacheForTests(): void {
  const cache = globalThis as unknown as Record<symbol, Env | undefined>;
  cache[ENV_CACHE_KEY] = undefined;
}
