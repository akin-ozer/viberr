/**
 * Vitest setup: hermetic env for the test suite. The app's env parser
 * hard-requires two secrets at the first `getEnv()` call (fail-fast boot
 * validation), and some test paths reach it — e.g. `configureRunServiceForTests`
 * → `createAdapters` → `resolveClaudeConfigDir`. Locally a developer's `.env`
 * may happen to satisfy it via a local .env; on CI and fresh clones nothing does, and
 * the whole suite fails on env validation.
 *
 * Seed deterministic test values BEFORE any app module loads (setup files run
 * first, and .env loading never overrides values already present). `??=` keeps an
 * explicitly-exported real value in charge, but on a normal run the suite uses
 * these fixed values everywhere — identical behavior locally and on CI, no
 * dependence on anyone's real secrets.
 */
process.env.VIBERR_SESSION_SECRET ??=
  "viberr-test-session-secret-0123456789abcdef";
// AES-256-GCM key: base64 of exactly 32 bytes, as the schema enforces.
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??=
  Buffer.alloc(32, 7).toString("base64");

/**
 * Fail closed against ambient real-backend credentials (F10-10). An ordinary
 * test must NEVER be able to construct a real Claude/Codex adapter from a
 * developer's `.env` or a CI host's environment — the risk is a paid provider
 * call from `npm test`. Blank every variable `hasCredential()` inspects
 * (runtime-registry.server.ts) plus the CLI-auth flags and `CODEX_HOME`, so
 * `isBackendAvailable` reports false under NODE_ENV=test. `""` reads as ABSENT
 * everywhere it matters: `hasCredential` tests `!!env.X` / `isTruthy(env.X)`
 * (which wants "1"/"true"/"yes"), and `parseEnv` drops empty strings before
 * validation. A test that deliberately exercises real-backend detection must
 * set these explicitly within the test (and clean up), which still works.
 *
 * Assign `""` — do NOT `delete`. env.server.ts calls `loadEnvFile()` at module
 * scope, i.e. AFTER this setup file has run, and loadEnvFile fills in every key
 * that is not already present in process.env. A deleted key is "not present",
 * so `delete` hands the developer's `.env` value straight back and re-opens the
 * leak; an empty string counts as present, so loadEnvFile leaves it alone.
 * (`??=` is equally wrong here — it preserves an ambient value outright.)
 */
for (const key of [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "VIBERR_CLAUDE_USE_CLI_AUTH",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "VIBERR_CODEX_USE_CLI_AUTH",
  "CODEX_HOME",
] as const) {
  process.env[key] = "";
}
