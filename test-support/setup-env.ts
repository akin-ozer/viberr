/**
 * Vitest setup: hermetic env for the test suite. The app's env parser
 * hard-requires two secrets at the first `getEnv()` call (fail-fast boot
 * validation), and some test paths reach it — e.g. `configureRunServiceForTests`
 * → `createAdapters` → `filteredSpawnEnv`. Locally a developer's `.env`
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
 * Fail closed against ambient real-backend credentials (F10-10, ruling 127).
 *
 * Since ruling 127 no deployment-wide credential is DECLARED any more — a run's
 * env is built from the credential of the ONE person it bills. But the spawn
 * env still starts from `process.env` (`filteredSpawnEnv`), and a developer's
 * `.env` or a CI host may carry a real provider key under one of these names.
 * `filteredSpawnEnv` strips every one of them by regex, so this is belt and
 * braces — and the braces matter: the risk is a paid provider call from
 * `npm test`.
 *
 * Assign `""` — do NOT `delete`. env.server.ts calls `loadEnvFile()` at module
 * scope, i.e. AFTER this setup file has run, and loadEnvFile fills in every key
 * that is not already present in process.env. A deleted key is "not present",
 * so `delete` hands the developer's `.env` value straight back and re-opens the
 * leak; an empty string counts as present, so loadEnvFile leaves it alone.
 * (`??=` is equally wrong here — it preserves an ambient value outright.)
 *
 * The `VIBERR_*_USE_CLI_AUTH` flags and the `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
 * pins are gone with the shared homes: a run reads its home from the
 * credential principal's own `runtimes/users/<id>/…` (user-homes.server.ts),
 * which every harness roots in its own temp data root, so there is no ambient
 * path left for a probe to find.
 */
for (const key of [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  // R19-19: a dev host may point this at a local Chrome; the browser-mount
  // tests must see the deterministic "unset" shape (no --executable-path /
  // --no-sandbox args), same hermeticity rule as the credentials above.
  "VIBERR_BROWSER_EXECUTABLE",
] as const) {
  process.env[key] = "";
}

/**
 * Fail closed against real NETWORK access from git (N19-6).
 *
 * Two tests reach `cloneRepo` with a repository name that resolves publicly
 * (`akin-ozer/viberr`), so `npm test` made a real `git clone` over the network:
 * `task-detail-route.server.test.ts` and `specialist-run.server.test.ts` each
 * failed intermittently under parallel load and passed in isolation — the
 * classic shape of a suite that depends on a socket. Neither test WANTS a
 * checkout; both assert what the app does when the clone does not produce one.
 *
 * `GIT_ALLOW_PROTOCOL` is git's own allow-list. Restricting it to `file` makes
 * every https/ssh transport fail instantly and offline ("transport 'https' not
 * allowed") instead of resolving DNS and opening a connection, so the failure
 * these tests already expect arrives deterministically and costs nothing. Local
 * fixtures are unaffected: `git init` / `add` / `commit` and `file://` remotes
 * use no transport at all, which is what the skill-mount fixtures rely on.
 *
 * A test that genuinely needs the network must set this explicitly for its own
 * child process — and should not exist in this suite.
 */
process.env.GIT_ALLOW_PROTOCOL = "file";
