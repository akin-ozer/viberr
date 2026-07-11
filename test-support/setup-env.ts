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
