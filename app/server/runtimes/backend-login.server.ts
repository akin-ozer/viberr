import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { logger } from "~/server/logging/logger.server";
import { ANSI_CSI_RE, redactGitOutput } from "~/server/secrets/git-output-redact.server";
import { newId } from "~/shared/ids/new-id.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import {
  loginTargetFor,
  recordBackendLogin,
  vendorCommand,
  type BackendBinaries,
  type BackendCredentialActor,
  type LoginMethod,
  type LoginTarget,
} from "./backend-credentials.server";
import { agentGitLaunchFor } from "./agent-isolation.server";
import { removeAgentTree } from "./agent-trees.server";
import type { RealBackend } from "./runtime-registry.server";
import { toError } from "~/shared/errors";

/**
 * The hosted sign-in driver (ruling 137).
 *
 * A person signs Claude or Codex in by driving the vendor's OWN unmodified
 * binary from this server: `claude auth login --claudeai|--console` and
 * `codex login --device-auth`. Anthropic's Claude Code legal page requires a
 * platform that hosts Claude Code to let each end user authenticate with their
 * own credentials through Anthropic's own flow, and forbids the platform from
 * collecting, storing or intermediating Claude.ai credentials. OpenAI ships
 * `--device-auth` for exactly this headless case. So Viberr implements no
 * OAuth of its own: it starts the vendor's process in that ONE person's runtime
 * home, relays what the vendor prints (a URL, a device code, a prompt for the
 * code Anthropic shows), and afterwards asks the SAME binary whether it is
 * signed in. The credential itself is written by the vendor client into the
 * account's own home under `<dataRoot>/runtimes/users/<id>/{claude-home,codex-home}`
 * (`accounts/<accountId>`, ruling 138) and is never read, copied or parsed
 * here.
 *
 * What this module deliberately never does:
 *
 *  - It never logs a stdout/stderr LINE verbatim. Those streams can carry a
 *    one-time code, a URL with a token in it, or the vendor's own diagnostics.
 *    Only state transitions are logged, and the one human-facing failure
 *    sentence goes through `redactGitOutput` (the shared child-process scrub)
 *    and a 200-char clamp before anybody sees it.
 *  - It never stores or logs the pasted code. `submitBackendLoginCode` writes it
 *    to the child's stdin and forgets it; stdin receives nothing else, ever.
 *  - It never runs a shell. argv only, on `vendorSpawnEnv` (the env
 *    `runVendorLogout` spawns on too): `filteredSpawnEnv()` plus the ONE home
 *    variable, with the other vendor's home variable deleted first (an ambient
 *    `CODEX_HOME` must not make a `claude auth login` act on a directory nobody
 *    chose).
 *  - It runs as the person's own OS user (ruling 139, `vendorCommand`): in the
 *    image the binary is started through the agent launcher, like their runs,
 *    so the sign-in it writes into their home is theirs.
 *
 * Sessions live in a process-global map keyed by (user, backend): one live
 * sign-in per person per backend, a new one replacing (and killing) the old.
 * Ended sessions stay readable for ten minutes so the Profile poller can show
 * the outcome, then are dropped.
 *
 * Ruling 138: a sign-in is for ONE account. Adding an account signs in inside
 * a new, empty account home minted before the vendor process starts, and the
 * person's other accounts on the backend are never touched: their sign-ins
 * sit in homes of their own. A sign-in that does not end connected takes its
 * half-made home with it (removed as the person, ruling 140, once the vendor
 * process has exited), so an abandoned attempt leaves no credential behind that
 * no account row accounts for. Signing an existing `login` account in again
 * runs in that account's own home and updates its row.
 */

// --------------------------------------------------------------- the shapes

export type LoginState =
  | "starting"
  | "awaiting-browser"
  | "awaiting-code"
  | "finishing"
  | "succeeded"
  | "failed"
  | "cancelled";

/** What the Profile card and the poll route render. It carries no secret: the
 *  URL and the device code are what the VENDOR displays to the person, and
 *  `error` is one already-redacted sentence. */
export interface LoginSessionView {
  id: string;
  backend: RealBackend;
  method: LoginMethod;
  /** Ruling 138: the account this sign-in records, and whether it is one the
   *  person already has (signed in again) rather than a new one. */
  accountId: string;
  existingAccount: boolean;
  state: LoginState;
  url: string | null;
  /** Codex: the one-time code the person types on the vendor's page. */
  userCode: string | null;
  /** Claude: Anthropic showed a code and the child is waiting for it on stdin. */
  needsCode: boolean;
  startedAt: string;
  expiresAt: string;
  error: string | null;
}

/** Re-exported so a caller that drives a sign-in needs one import, not two.
 *  The type is owned by `backend-credentials.server.ts`, which needs it for the
 *  vendor logout; the RESOLVER lives here because this is the module that knows
 *  how each vendor's SDK finds its own binary. */
export type { BackendBinaries };

const TERMINAL_STATES: ReadonlySet<LoginState> = new Set<LoginState>([
  "succeeded",
  "failed",
  "cancelled",
]);

function isTerminalLoginState(state: LoginState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Which sign-in flows each vendor actually offers, and the ONE home of that
 * fact (ruling 137).
 *
 * `startBackendLogin` validates against it, and Profile → Agent accounts builds
 * its "Sign in with …" buttons from the same table
 * (`features/profile/profile-query.server.ts`). A second copy for rendering
 * would let the card offer a flow this function then refuses, or hide one it
 * would happily run.
 *
 * A method the vendor does not have is a caller bug, not a user error, but it
 * still gets a sentence a person could act on.
 */
export const BACKEND_SIGN_IN_METHODS = {
  claude: ["claudeai", "console"],
  codex: ["device"],
} as const satisfies Record<RealBackend, readonly LoginMethod[]>;

/**
 * How long a person has to finish a vendor sign-in before the process is torn
 * down. Anthropic's console flow and OpenAI's device flow both expire their own
 * codes well inside this, so the timeout is a backstop against a child that
 * hangs with nobody watching, not a policy of ours.
 */
const LOGIN_TIMEOUT_MS = {
  claude: 15 * 60_000,
  codex: 16 * 60_000,
} as const;

/** A SIGTERM'd vendor binary gets five seconds to exit before SIGKILL. */
const KILL_ESCALATION_MS = 5_000;

/** How long a finished session stays readable so the poller can show its
 *  outcome. After this it is dropped: a terminal session is a fact about a
 *  moment, not state worth keeping. */
const ENDED_SESSION_TTL_MS = 10 * 60_000;

/** stdout is accumulated (the Claude prompt arrives with no trailing newline,
 *  so matching needs the running text) but never grows without bound. */
const OUTPUT_TAIL_CAP = 16_384;

/** One sentence, clamped. Longer than this is a log, not a message. */
const MAX_ERROR_CHARS = 200;

/** The confirmation probe is one local process asking one question. */
const CONFIRM_TIMEOUT_MS = 30_000;

const MAX_CODE_LEN = 512;

// ------------------------------------------------------- binary resolution

const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const CODEX_NPM_NAME = "@openai/codex";

/** `@openai/codex-sdk`'s own table, copied verbatim from its `findCodexPath`
 *  (node_modules/@openai/codex-sdk/dist/index.js). Resolving the binary the way
 *  the SDK does is the whole point: the sign-in must be performed by the SAME
 *  unmodified executable a run later spawns. */
const CODEX_PLATFORM_PACKAGE = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
} as const;

type CodexTargetTriple = keyof typeof CODEX_PLATFORM_PACKAGE;

/** `process.report.getReport()` is a diagnostic blob, so it is DECODED rather
 *  than duck-typed: a glibc runtime version present means glibc, absent means a
 *  musl host. Same test the Agent SDK's own resolver makes. */
const glibcReportSchema = z.object({
  header: z.object({ glibcVersionRuntime: z.string() }),
});

function prefersMuslBuild(platform: NodeJS.Platform): boolean {
  if (platform !== "linux") return false;
  try {
    return !glibcReportSchema.safeParse(process.report?.getReport()).success;
  } catch {
    // A host whose report cannot be produced is not evidence of glibc.
    return true;
  }
}

/**
 * The Agent SDK's native `claude` executable, resolved the way `sdk.mjs`
 * resolves it: `createRequire` against the SDK's own entry, then the
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` optional dependency and
 * its `claude` file. Resolving from the SDK (and not from this file) is what
 * keeps a hoisted or nested install working.
 */
function resolveClaudeBinary(
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const suffix = platform === "win32" ? ".exe" : "";
  const musl = prefersMuslBuild(platform);
  const packages =
    platform === "android"
      ? [`${CLAUDE_SDK_PACKAGE}-linux-${arch}-android`]
      : platform === "linux"
        ? musl
          ? [
              `${CLAUDE_SDK_PACKAGE}-linux-${arch}-musl`,
              `${CLAUDE_SDK_PACKAGE}-linux-${arch}`,
            ]
          : [
              `${CLAUDE_SDK_PACKAGE}-linux-${arch}`,
              `${CLAUDE_SDK_PACKAGE}-linux-${arch}-musl`,
            ]
        : [`${CLAUDE_SDK_PACKAGE}-${platform}-${arch}`];
  let sdkRequire: NodeRequire;
  try {
    sdkRequire = createRequire(
      createRequire(import.meta.url).resolve(CLAUDE_SDK_PACKAGE),
    );
  } catch {
    return null;
  }
  for (const pkg of packages) {
    try {
      const file = sdkRequire.resolve(`${pkg}/claude${suffix}`);
      if (existsSync(file)) return file;
    } catch {
      // Not installed for this platform; try the next candidate.
    }
  }
  return null;
}

function codexTargetTriple(
  platform: NodeJS.Platform,
  arch: string,
): CodexTargetTriple | null {
  if (platform === "linux" || platform === "android") {
    if (arch === "x64") return "x86_64-unknown-linux-musl";
    if (arch === "arm64") return "aarch64-unknown-linux-musl";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "x86_64-apple-darwin";
    if (arch === "arm64") return "aarch64-apple-darwin";
    return null;
  }
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    return null;
  }
  return null;
}

/**
 * The Codex CLI executable, resolved exactly as `@openai/codex-sdk` resolves it:
 * `@openai/codex` → the platform package for this target triple → its
 * `vendor/<triple>/bin/codex` (with the legacy `vendor/<triple>/codex/codex`
 * layout as the SDK's own fallback).
 */
function resolveCodexBinary(
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const triple = codexTargetTriple(platform, arch);
  if (!triple) return null;
  const binaryName = platform === "win32" ? "codex.exe" : "codex";
  let vendorRoot: string;
  try {
    const codexRequire = createRequire(
      createRequire(import.meta.url).resolve(`${CODEX_NPM_NAME}/package.json`),
    );
    const platformPackageJson = codexRequire.resolve(
      `${CODEX_PLATFORM_PACKAGE[triple]}/package.json`,
    );
    vendorRoot = path.join(path.dirname(platformPackageJson), "vendor");
  } catch {
    return null;
  }
  const root = path.join(vendorRoot, triple);
  const current = path.join(root, "bin", binaryName);
  if (existsSync(current) && existsSync(path.join(root, "codex-package.json"))) {
    return current;
  }
  const legacy = path.join(root, "codex", binaryName);
  return existsSync(legacy) ? legacy : null;
}

const BINARIES_OVERRIDE_KEY = Symbol.for("viberr.backendBinariesOverride");

function binariesOverride(): BackendBinaries | null {
  // SAFETY: `globalThis` carries no index signature, so the symbol slot has to
  // be named to be read at all. `Symbol.for("viberr.backendBinariesOverride")`
  // is written nowhere but `setBackendBinariesForTests` below.
  const slot = globalThis as Record<symbol, BackendBinaries | undefined>;
  return slot[BINARIES_OVERRIDE_KEY] ?? null;
}

/**
 * Point the resolver at fake executables for a route-level test.
 *
 * Necessary because the ROUTE is what must be exercised, and the route resolves
 * its own binaries (a form action has no business taking a path from its
 * caller). Without this seam, a test of the `backend-login-start` intent would
 * spawn the real `claude auth login`, which contacts Anthropic and then waits a
 * quarter of an hour for a browser nobody is driving. Same shape and same
 * naming as `configureRunServiceForTests`: an explicitly-named test entry
 * point, never consulted by anything a deployment can reach.
 */
export function setBackendBinariesForTests(
  binaries: BackendBinaries | null,
): void {
  // SAFETY: the same slot `binariesOverride` reads, named the same way and for
  // the same reason — `globalThis` has no index signature, and this line is the
  // only writer of that symbol key in the codebase.
  const slot = globalThis as Record<symbol, BackendBinaries | undefined>;
  if (binaries) slot[BINARIES_OVERRIDE_KEY] = binaries;
  else delete slot[BINARIES_OVERRIDE_KEY];
}

/** Which host the binaries are resolved for. Defaulted from the running
 *  process; named so a test can ask for a target this repo has no optional
 *  package for, the way `userBackendHealth` takes its `platform`. */
export interface BinaryTarget {
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * The refusal a missing vendor package produces.
 *
 * `message` is the diagnostic an operator reads in the log; `userMessage` is
 * the sentence the person who pressed "Sign in with Claude" sees, because an
 * `AppError` without one surfaces as the generic "Something went wrong on our
 * side." and leaves them with no idea that the remedy is an install flag
 * (spec §3.4: throw with an ACTIONABLE message).
 */
function missingBinaryError(
  backend: RealBackend,
  platform: NodeJS.Platform,
  arch: string,
): AppError {
  const pkg = backend === "claude" ? CLAUDE_SDK_PACKAGE : CODEX_NPM_NAME;
  return new AppError({
    code: ERROR_CODES.INTERNAL,
    status: 500,
    message:
      `agent backend binary missing for ${backend} on ${platform}-${arch}: ` +
      `no ${pkg} platform package resolved. Reinstall dependencies without --omit=optional.`,
    userMessage:
      `The bundled ${BACKEND_LABEL[backend]} binary is not installed on this server, so a hosted ` +
      `sign-in cannot start. Ask an admin to reinstall the dependencies without --omit=optional, ` +
      `or paste an API key instead.`,
  });
}

/**
 * The absolute path to ONE vendor's binary.
 *
 * Per backend on purpose (ruling 137): a host where only Anthropic's optional
 * package installed must still be able to sign Claude in, and the person doing
 * it must not be told about a Codex package they were not asking for. Nothing
 * here ever falls back to a PATH lookup, which would run whatever a shell
 * happened to find.
 */
export function resolveBackendBinary(
  backend: RealBackend,
  target: BinaryTarget = {},
): string {
  const override = binariesOverride();
  if (override) return override[backend];
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const resolved =
    backend === "claude"
      ? resolveClaudeBinary(platform, arch)
      : resolveCodexBinary(platform, arch);
  if (!resolved) throw missingBinaryError(backend, platform, arch);
  return resolved;
}

/**
 * One vendor's binary when this deployment installed that vendor's optional
 * package, and `undefined` when it did not.
 *
 * The ONE home of that tolerance (ruling 137). A disconnect, a paste that
 * replaces a sign-in and an account removal all stay correct without a binary:
 * the local half — the credential file and the row — is what makes the account
 * unusable from this server, and each of those paths says in the log that the
 * vendor-side session was left for the person to revoke. Per backend, so a host
 * missing ONE vendor's package still runs the OTHER vendor's logout instead of
 * skipping both. Starting a SIGN-IN is the opposite case and calls
 * {@link resolveBackendBinary} directly: there the binary IS the flow, so its
 * absence must surface as the actionable refusal rather than as silence.
 */
export function backendBinaryIfPresent(
  backend: RealBackend,
  target: BinaryTarget = {},
): string | undefined {
  try {
    return resolveBackendBinary(backend, target);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------- the session store

/** One live sign-in. The child process, its timers and the accumulated output
 *  live here; nothing in this record ever reaches a loader except through
 *  {@link viewOf}, which copies the seven display fields and nothing else. */
interface LoginSession {
  id: string;
  userId: string;
  backend: RealBackend;
  method: LoginMethod;
  /** Ruling 138: the account the sign-in records, and its home. */
  target: LoginTarget;
  accountHome: string;
  dataRoot: string | undefined;
  state: LoginState;
  url: string | null;
  userCode: string | null;
  needsCode: boolean;
  startedAt: string;
  expiresAt: string;
  error: string | null;
  child: ChildProcess | null;
  /** What is spawned: the vendor binary, or the agent launcher standing in
   *  for it (ruling 139, `launched`). */
  binary: string;
  env: Record<string, string>;
  launched: boolean;
  db: DatabaseSync;
  actor: BackendCredentialActor;
  /** Running stdout+stderr text, ANSI stripped, capped. Read for the URL, the
   *  device code, the Claude prompt and the final failure sentence. Never
   *  logged, never persisted. */
  output: string;
  /** Codex prints the one-time code on the line AFTER its instruction. */
  expectCodeLine: boolean;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  /** Epoch ms at which this session reached a terminal state; null while live. */
  endedAt: number | null;
  /** Set once a failed NEW account's home has been sent for removal. */
  discarded: boolean;
}

const SESSIONS_KEY = Symbol.for("viberr.backendLoginSessions");

/** Process-global, HMR-safe: a dev-server reload must not orphan a running
 *  vendor process whose only handle is a module-level map. */
function sessionStore(): Map<string, LoginSession> {
  // SAFETY: `globalThis` carries no index signature, so the symbol slot has to
  // be named to be read at all. `Symbol.for("viberr.backendLoginSessions")` is
  // written nowhere but the assignment below, which only ever stores this map.
  const slot = globalThis as Record<symbol, Map<string, LoginSession> | undefined>;
  let map = slot[SESSIONS_KEY];
  if (!map) {
    map = new Map<string, LoginSession>();
    slot[SESSIONS_KEY] = map;
  }
  return map;
}

function sessionKey(userId: string, backend: RealBackend): string {
  return `${userId}::${backend}`;
}

function viewOf(session: LoginSession): LoginSessionView {
  return {
    id: session.id,
    backend: session.backend,
    method: session.method,
    accountId: session.target.id,
    existingAccount: session.target.existing,
    state: session.state,
    url: session.url,
    userCode: session.userCode,
    needsCode: session.needsCode,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    error: session.error,
  };
}

/** Drop terminal sessions older than the readable window. Called on every read
 *  and every start, so nothing accumulates in a long-lived process. */
function pruneEndedSessions(nowMs: number): void {
  const store = sessionStore();
  for (const [key, session] of store) {
    if (session.endedAt !== null && nowMs - session.endedAt > ENDED_SESSION_TTL_MS) {
      store.delete(key);
    }
  }
}

// ------------------------------------------------------------ stdout parsing

/** Control characters that survive the strip (BEL from a prompt, NUL). */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Both CLIs colourise their prompts when they think they have a TTY, and a
 *  coloured `https://…` must still parse as a URL: ANSI CSI escapes go first
 *  (git-output-redact's `ANSI_CSI_RE`), then the stray controls. */
function stripAnsi(chunk: string): string {
  return chunk.replace(ANSI_CSI_RE, "").replace(CONTROL_RE, "");
}

/** The first `https://` URL in a line, without the trailing punctuation a
 *  sentence wraps it in. */
const URL_RE = /https:\/\/[^\s"'<>)\]]+/;

/** Anthropic's prompt. It arrives WITHOUT a trailing newline (the CLI is
 *  waiting on the same line), so it is matched against the accumulated text
 *  rather than against a completed line. */
const CLAUDE_CODE_PROMPT = "Paste code here if prompted";

/** OpenAI's device flow prints this, then the code on the next line. */
const CODEX_CODE_PROMPT = "Enter this one-time code";

/** A device code as OpenAI formats it. Deliberately narrow: a wide pattern
 *  would happily capture a heading and show the person the wrong thing. */
const DEVICE_CODE_RE = /^[A-Z0-9-]{6,32}$/;

/**
 * Fold one output chunk into the session: capture the URL, the device code and
 * the Claude prompt, and advance the state.
 *
 * Both streams feed this. The vendors print their instructions to stdout, but a
 * CLI that decides it has no TTY can send the same text to stderr, and a
 * sign-in that silently never shows its URL is worse than one that reads a
 * banner off the wrong stream.
 */
function consumeOutput(session: LoginSession, raw: string): void {
  const clean = stripAnsi(raw);
  session.output = (session.output + clean).slice(-OUTPUT_TAIL_CAP);
  if (isTerminalLoginState(session.state)) return;

  for (const line of clean.split(/\r\n|\r|\n/)) {
    const text = line.trim();
    if (session.backend === "codex" && session.expectCodeLine && text) {
      if (DEVICE_CODE_RE.test(text)) {
        session.userCode = text;
        session.expectCodeLine = false;
      }
    }
    if (!session.url) {
      const found = URL_RE.exec(text);
      if (found) {
        session.url = found[0];
        if (session.state === "starting") session.state = "awaiting-browser";
      }
    }
    if (session.backend === "codex" && text.includes(CODEX_CODE_PROMPT)) {
      session.expectCodeLine = true;
    }
  }

  // Claude's prompt has no line terminator, so the accumulated text is what
  // proves it arrived.
  if (
    session.backend === "claude" &&
    !session.needsCode &&
    session.output.includes(CLAUDE_CODE_PROMPT)
  ) {
    session.needsCode = true;
    session.state = "awaiting-code";
  }
}

/**
 * One redacted sentence describing why a sign-in failed, from whatever the
 * vendor last printed. `redactGitOutput` is the shared child-process scrub
 * (exact values, URL userinfo, token patterns, control characters); the last
 * non-empty line is the vendor's verdict, the same convention the run-failure
 * copy uses.
 */
function redactedReason(session: LoginSession, fallback: string): string {
  const scrubbed = redactGitOutput(session.output);
  const lines = scrubbed.split("\n").filter((line) => line.trim() !== "");
  const last = lines.length ? lines[lines.length - 1]!.trim() : "";
  if (!last) return fallback;
  return last.length > MAX_ERROR_CHARS ? last.slice(0, MAX_ERROR_CHARS) : last;
}

/** OpenAI refuses device-code sign-in for a workspace that has not enabled it,
 *  and its sentence names the setting without saying who can change it. */
const DEVICE_CODE_DISABLED_RE = /device[- ]code/i;

function codexFailureMessage(reason: string): string {
  return DEVICE_CODE_DISABLED_RE.test(reason)
    ? `${reason} Ask your ChatGPT workspace admin to enable device code authorization, or use an API key.`
    : reason;
}

// ----------------------------------------------------------- state changes

function clearTimers(session: LoginSession): void {
  if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
  if (session.killTimer) clearTimeout(session.killTimer);
  session.timeoutTimer = null;
  session.killTimer = null;
}

/** Terminate the vendor process: SIGTERM, then SIGKILL if it is still there
 *  five seconds later. Both timers are unref'd so a pending kill never holds
 *  the process open. */
function terminateChild(session: LoginSession): void {
  const child = session.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  // Ruling 139: a launched vendor process is another user's; the launcher's
  // hard kill (SIGUSR2) reaches it, a SIGKILL of the launcher would not.
  const hardKill = session.launched ? "SIGUSR2" : "SIGKILL";
  const hard = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill(hardKill);
  }, KILL_ESCALATION_MS);
  hard.unref?.();
  session.killTimer = hard;
}

/**
 * Take a session out of service without auditing anything: the replacement path
 * and the test reset.
 *
 * Marking it terminal BEFORE the kill is the point. `close` fires on the next
 * tick, and a handler that still believed the session was live would move a
 * session nobody is watching to `failed` and try to write an audit row for it,
 * long after the request (or the test) that owned it has gone.
 */
function retireSession(session: LoginSession): void {
  clearTimers(session);
  if (!isTerminalLoginState(session.state)) {
    session.state = "cancelled";
    session.endedAt = Date.now();
  }
  terminateChild(session);
}

function finish(session: LoginSession, state: LoginState, error: string | null): void {
  if (isTerminalLoginState(session.state)) return;
  session.state = state;
  session.error = error;
  session.endedAt = Date.now();
  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
    session.timeoutTimer = null;
  }
  logger.info("backend sign-in ended", {
    backend: session.backend,
    method: session.method,
    userId: session.userId,
    state,
  });
}

/**
 * Ruling 138: a sign-in for a NEW account that did not end connected takes its
 * half-made home with it — a vendor that got as far as writing its sign-in
 * before the flow failed must not leave a credential on this server that no
 * account row accounts for. Called only once the vendor process has exited
 * (its `close`, or a spawn that never produced one), so nothing is writing in
 * the home while it goes; removed as the person (ruling 140), never the
 * server. An existing account's home is never touched here, and neither is a
 * home whose sign-in succeeded. Fire-and-forget: the person is told about the
 * sign-in, not about housekeeping, and a failure is logged.
 */
function discardPendingAccount(session: LoginSession): void {
  if (session.discarded || session.target.existing || session.state === "succeeded") return;
  if (session.state !== "failed" && session.state !== "cancelled") return;
  session.discarded = true;
  let person: ReturnType<typeof agentGitLaunchFor>;
  try {
    person = agentGitLaunchFor(session.db, session.userId, session.dataRoot);
  } catch (error) {
    logger.warn("an abandoned sign-in's account home could not be removed", {
      backend: session.backend,
      err: toError(error),
    });
    return;
  }
  removeAgentTree(session.accountHome, person).catch((error) => {
    logger.warn("an abandoned sign-in's account home could not be removed", {
      backend: session.backend,
      err: toError(error),
    });
  });
}

function auditFailure(session: LoginSession, reason: string): void {
  recordAudit(session.db, {
    action: "profile.backend.login_failed",
    actor: session.actor,
    subjectKind: "backend_login",
    subjectId: session.id,
    details: { backend: session.backend, method: session.method, reason },
  });
}

/**
 * Ask the vendor's binary whether it is actually signed in, and only then
 * record the credential.
 *
 * A zero exit is the CLI's opinion about its own process, not proof that a
 * credential landed: `claude auth login` exits 0 on an abandoned flow, and a
 * row written on that basis would make every later run fail with no
 * explanation. So the confirmation is the vendor's own status command, run in
 * the same home, and its answer is what `recordBackendLogin` persists.
 */
async function confirmAndRecord(session: LoginSession): Promise<void> {
  const label = BACKEND_LABEL[session.backend];
  try {
    const detail =
      session.backend === "claude"
        ? await confirmClaude(session)
        : await confirmCodex(session);
    recordBackendLogin(
      session.db,
      session.actor,
      session.backend,
      session.method,
      detail,
      session.target,
    );
    finish(session, "succeeded", null);
  } catch (error) {
    const reason =
      error instanceof AppError
        ? error.userMessage
        : `${label} finished sign-in but could not confirm it. Start again.`;
    finish(session, "failed", reason);
    auditFailure(session, reason);
    // The vendor process exited before the confirmation ran.
    discardPendingAccount(session);
  }
}

const execFileAsync = promisify(execFile);

/** `claude auth status` prints JSON. Only the fields below are read, and only
 *  the non-secret ones are kept: a status blob is not a place to trust. */
const claudeAuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  email: z.string().optional(),
  organization: z.string().optional(),
});

async function confirmClaude(
  session: LoginSession,
): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync(session.binary, ["auth", "status"], {
    env: session.env,
    timeout: CONFIRM_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  let parsed: z.infer<typeof claudeAuthStatusSchema>;
  try {
    parsed = claudeAuthStatusSchema.parse(JSON.parse(stdout));
  } catch {
    throw AppError.validation(
      "Claude did not report a completed sign-in. Start again.",
    );
  }
  if (!parsed.loggedIn) {
    throw AppError.validation(
      "Claude reports this server is not signed in. Start again and finish the browser step.",
    );
  }
  const detail: Record<string, string> = {};
  if (parsed.authMethod) detail.authMethod = parsed.authMethod;
  if (parsed.apiProvider) detail.apiProvider = parsed.apiProvider;
  if (parsed.email) detail.email = parsed.email;
  if (parsed.organization) detail.organization = parsed.organization;
  return detail;
}

/** `codex login status` prints a sentence, not JSON. */
const LOGGED_IN_MARKER = "Logged in";

async function confirmCodex(
  session: LoginSession,
): Promise<Record<string, string>> {
  const { stdout, stderr } = await execFileAsync(
    session.binary,
    ["login", "status"],
    { env: session.env, timeout: CONFIRM_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  const line = stripAnsi(`${stdout}\n${stderr}`)
    .split(/\r\n|\r|\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.includes(LOGGED_IN_MARKER));
  if (!line) {
    throw AppError.validation(
      "Codex reports this server is not signed in. Start again and finish the browser step.",
    );
  }
  return { status: line.slice(0, MAX_ERROR_CHARS) };
}

// ------------------------------------------------------------------- start

export interface StartBackendLoginDeps {
  /** Tests point this at the fake vendor scripts. A caller that omits it gets
   *  `resolveBackendBinary(backend)`: only the vendor being signed in to has to
   *  be installed for the flow to start. */
  binaries?: BackendBinaries;
  dataRoot?: string;
  /** Overrides the vendor default so a test can drive the timeout path without
   *  waiting a quarter of an hour. */
  timeoutMs?: number;
  /** Ruling 138: sign THIS existing `login` account in again (its own home,
   *  its own row). Omitted, the sign-in adds a new account. */
  accountId?: string;
}

/**
 * Start (or restart) a hosted sign-in for one person and one backend — into a
 * new account, or (`deps.accountId`) into one of their existing sign-ins.
 *
 * Synchronous by design: the caller is a form action, and what it returns is
 * the FIRST view of a session the person then watches through the poll route.
 * Everything the vendor does afterwards moves the same session record.
 */
export function startBackendLogin(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  backend: RealBackend,
  method: LoginMethod,
  deps: StartBackendLoginDeps = {},
): LoginSessionView {
  const offered: readonly LoginMethod[] = BACKEND_SIGN_IN_METHODS[backend];
  if (!offered.includes(method)) {
    throw AppError.validation(
      `${BACKEND_LABEL[backend]} does not offer that sign-in method.`,
    );
  }
  // ONE binary, the one being signed in to: a host that installed Anthropic's
  // optional package but not OpenAI's can still connect Claude, and the failure
  // sentence names the vendor the person actually pressed.
  const binary = deps.binaries?.[backend] ?? resolveBackendBinary(backend);
  // Ruling 138: which account this sign-in becomes, decided before anything
  // is killed or spawned, so a refusal (the account ceiling, an account that
  // is not a sign-in) leaves a running sign-in exactly as it was.
  const target = loginTargetFor(db, actor.userId, backend, deps.accountId);
  const nowDate = new Date();
  pruneEndedSessions(nowDate.getTime());

  // Replacing a live sign-in kills the process behind it: two `claude auth
  // login` children writing the same home would race over one credential file.
  const store = sessionStore();
  const key = sessionKey(actor.userId, backend);
  const previous = store.get(key);
  if (previous) {
    retireSession(previous);
    store.delete(key);
  }

  // Ruling 139: the vendor binary runs as the person's own OS user, through the
  // launcher when this server launches agents, so the sign-in it writes into
  // their home is theirs. `binary` becomes the launcher then; the status
  // confirmation below reuses the same pair.
  const command = vendorCommand(db, actor.userId, backend, binary, target, deps.dataRoot);
  const env = command.env;

  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS[backend];
  const args =
    backend === "claude"
      ? ["auth", "login", method === "claudeai" ? "--claudeai" : "--console"]
      : ["login", "--device-auth"];

  const session: LoginSession = {
    id: newId("bkl"),
    userId: actor.userId,
    backend,
    method,
    target,
    accountHome: command.accountHome,
    dataRoot: deps.dataRoot,
    state: "starting",
    url: null,
    userCode: null,
    needsCode: false,
    startedAt: nowDate.toISOString(),
    expiresAt: new Date(nowDate.getTime() + timeoutMs).toISOString(),
    error: null,
    child: null,
    binary: command.file,
    env,
    launched: command.launched,
    db,
    actor,
    output: "",
    expectCodeLine: false,
    timeoutTimer: null,
    killTimer: null,
    endedAt: null,
    discarded: false,
  };
  // argv only, never a shell; every stream piped so nothing reaches the
  // server's own stdio and the person's code can be written to stdin. A spawn
  // that throws OUTRIGHT (a malformed argv, a permission the OS refuses before
  // any process exists) must not leave a session stuck in `starting` forever,
  // so the record is only published once there is a child behind it.
  let child: ChildProcess;
  try {
    child = spawn(session.binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    throw AppError.internal(
      `could not start the ${backend} sign-in process`,
      error,
    );
  }
  session.child = child;
  store.set(key, session);

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => consumeOutput(session, chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => consumeOutput(session, chunk));
  // A child that never starts (a binary that vanished between resolution and
  // spawn) must fail the session, not raise an unhandled error event.
  child.on("error", () => {
    const reason = `${BACKEND_LABEL[backend]} sign-in could not start on this server.`;
    finish(session, "failed", reason);
    auditFailure(session, reason);
    // A process that never started has nothing writing in the home.
    if (child.pid === undefined) discardPendingAccount(session);
  });
  child.on("close", (code) => {
    clearTimers(session);
    // Cancelled, replaced or timed out: the process is gone now, and so is
    // the reason to keep the new account's half-made home (ruling 138).
    if (isTerminalLoginState(session.state)) {
      discardPendingAccount(session);
      return;
    }
    if (code === 0) {
      session.state = "finishing";
      void confirmAndRecord(session);
      return;
    }
    const reason =
      backend === "codex"
        ? codexFailureMessage(
            redactedReason(session, "Codex sign-in did not complete. Start again."),
          )
        : redactedReason(session, "Claude sign-in did not complete. Start again.");
    finish(session, "failed", reason);
    auditFailure(session, reason);
    discardPendingAccount(session);
  });

  const timer = setTimeout(() => {
    terminateChild(session);
    const reason = "Sign-in timed out. Start again.";
    finish(session, "failed", reason);
    auditFailure(session, reason);
  }, timeoutMs);
  timer.unref?.();
  session.timeoutTimer = timer;

  recordAudit(db, {
    action: "profile.backend.login_started",
    actor,
    subjectKind: "backend_login",
    subjectId: session.id,
    details: { backend, method, accountId: target.id, existingAccount: target.existing },
  });
  logger.info("backend sign-in started", {
    backend,
    method,
    userId: actor.userId,
  });
  return viewOf(session);
}

// -------------------------------------------------------------- read / act

/** This person's own live (or recently ended) sign-in for one backend. Keyed by
 *  user id, so it can only ever answer for the caller. */
export function getBackendLogin(
  userId: string,
  backend: RealBackend,
): LoginSessionView | null {
  pruneEndedSessions(Date.now());
  const session = sessionStore().get(sessionKey(userId, backend));
  return session ? viewOf(session) : null;
}

/**
 * Hand Anthropic's one-time code to the waiting child (Claude only).
 *
 * The code goes to stdin and nowhere else: it is not stored on the session, not
 * logged, and not echoed in any error. stdin carries this one line for the
 * lifetime of the process.
 */
export function submitBackendLoginCode(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  backend: RealBackend,
  code: string,
): LoginSessionView {
  if (backend !== "claude") {
    throw AppError.validation(
      "Codex sign-in does not take a pasted code. Enter the one-time code on the OpenAI page.",
    );
  }
  const session = sessionStore().get(sessionKey(actor.userId, backend));
  if (!session || isTerminalLoginState(session.state)) {
    throw AppError.validation("That sign-in is no longer running. Start again.");
  }
  if (!session.needsCode) {
    throw AppError.validation("Claude has not asked for a code yet.");
  }
  const value = code.trim();
  if (!value) throw AppError.validation("Paste the code Anthropic showed you.");
  if (value.length > MAX_CODE_LEN) {
    throw AppError.validation("That code is too long to be the one Anthropic showed you.");
  }
  const stdin = session.child?.stdin;
  if (!stdin || stdin.destroyed) {
    throw AppError.validation("That sign-in is no longer running. Start again.");
  }
  stdin.write(`${value}\n`);
  session.state = "finishing";
  session.needsCode = false;
  // The confirmation that follows the child's exit writes through THIS request's
  // handle, not the one the session was started with. In a serving process they
  // are the same singleton; in a test they need not be, and a credential row
  // written into a closed handle would be lost with no signal.
  session.db = db;
  return viewOf(session);
}

/**
 * Cancel a running sign-in. Idempotent from the person's side: an already
 * terminal session is returned as it stands rather than re-audited, and a
 * person with no session at all gets null.
 */
export function cancelBackendLogin(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  backend: RealBackend,
): LoginSessionView | null {
  const session = sessionStore().get(sessionKey(actor.userId, backend));
  if (!session) return null;
  if (isTerminalLoginState(session.state)) return viewOf(session);
  terminateChild(session);
  finish(session, "cancelled", null);
  recordAudit(db, {
    action: "profile.backend.login_cancelled",
    actor,
    subjectKind: "backend_login",
    subjectId: session.id,
    details: { backend, method: session.method },
  });
  return viewOf(session);
}

/** Tear every session down. Tests only: a leaked vendor child would outlive the
 *  worker that spawned it. */
export function resetBackendLoginsForTests(): void {
  const store = sessionStore();
  for (const session of store.values()) {
    retireSession(session);
    const child = session.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      // Straight to SIGKILL: a test is not waiting for a graceful goodbye, and
      // a five-second escalation timer would outlive the worker.
      child.kill("SIGKILL");
    }
  }
  store.clear();
}
