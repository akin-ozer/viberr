/**
 * Vitest setup: hermetic env for the test suite. The app's env parser
 * hard-requires two secrets at the first `getEnv()` call (fail-fast boot
 * validation), and some test paths reach it — e.g. `configureRunServiceForTests`
 * → `createAdapters` → `resolveClaudeConfigDir`. Locally a developer's `.env`
 * happens to satisfy it via dotenv; on CI and fresh clones nothing does, and
 * the whole suite fails on env validation.
 *
 * Seed deterministic test values BEFORE any app module loads (setup files run
 * first, and dotenv never overrides values already present). `??=` keeps an
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
 * call from `npm test`. Delete every variable `hasCredential()` inspects
 * (runtime-registry.server.ts) plus the CLI-auth flags and `CODEX_HOME`, so
 * `isBackendAvailable` reports false and `selectAdapter` yields the simulated
 * adapter under NODE_ENV=test. A test that deliberately exercises real-backend
 * detection must set these explicitly within the test (and clean up), which
 * still works. `delete` (not `??=`) is required: nullish assignment preserves
 * an ambient value, which is exactly the leak.
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
  delete process.env[key];
}
