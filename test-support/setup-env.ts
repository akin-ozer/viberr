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
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
 * (runtime-registry.server.ts) plus the CLI-auth flags, so
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
] as const) {
  process.env[key] = "";
}

/**
 * Pin the provider transcript stores to an empty temp directory (P13-D-2).
 *
 * The continuity probe added this pass asks the filesystem whether a stored
 * session id still has a transcript before resuming it. `CLAUDE_CONFIG_DIR`
 * was never set here, so `resolveClaudeConfigDir()` fell back to the AMBIENT
 * data root: on a developer machine `./data/runtimes/claude-home/projects`
 * exists and the suite took the continuity path, while on CI it does not and
 * the suite took the ordinary resume path. Same code, two behaviours, decided
 * by whether someone had run the app locally — and it produced a real test that
 * passed on CI and failed on a laptop.
 *
 * An empty real directory (not a missing one) is the deterministic answer: the
 * store EXISTS and holds no transcripts, so every probe returns `missing`
 * rather than the `unknown` a nonexistent store would report. A test that wants
 * a live session materializes one; a test that wants `unknown` points these at
 * a path that does not exist.
 *
 * `CODEX_HOME` is therefore no longer blanked with the credential keys above.
 * It was in that list because `codexCliAuthUsable()` requires
 * `$CODEX_HOME/auth.json` to exist — and this directory has no `auth.json`, so
 * the hermeticity invariant now holds by construction rather than by erasing a
 * path the continuity probe needs. `VIBERR_CODEX_USE_CLI_AUTH` is blank anyway,
 * so the flag half of that gate is closed independently.
 */
const transcriptRoot = mkdtempSync(path.join(tmpdir(), "viberr-test-transcripts-"));
process.env.CLAUDE_CONFIG_DIR = path.join(transcriptRoot, "claude-home");
process.env.CODEX_HOME = path.join(transcriptRoot, "codex-home");
mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true });
mkdirSync(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true });

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
