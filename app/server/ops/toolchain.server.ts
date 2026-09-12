import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { backendBinaryIfPresent } from "~/server/runtimes/backend-login.server";
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";

/**
 * What this host can run (ruling 182).
 *
 * G36-4 (pass 36): nothing probed whether a sandboxed Codex run could exec at
 * all. On the compose deployment bubblewrap answered `bwrap: No permissions to
 * create a new namespace` (Docker's default seccomp profile refuses
 * `unshare(CLONE_NEWUSER)` to the non-root app user), every `workspace-write` /
 * `read-only` Codex run failed at its first shell command, and the model
 * reported the environment failure as a verdict — `request-changes`, "missing
 * evidence" — on correct deliveries. Nothing in the run row, the timeline or a
 * packet named the sandbox.
 *
 * So the sandbox is probed ONCE per process, with the CLI's own sandbox helper
 * (`codex sandbox`, which runs a command under the same bubblewrap / seatbelt
 * confinement `codex exec` uses and makes no model call) on a trivial command
 * under a workspace-write-shaped permission profile, and the verdict rides
 * `healthSnapshot` (so `/resources/health` and the controller's
 * `instance_health` report it) beside the versions of the tools an agent's
 * shell finds. `startRun` reads the same verdict to REFUSE a sandboxed Codex
 * dispatch with a named remedy instead of starting a run that cannot exec.
 *
 * Memoized per process: versions cannot change while the process lives, and
 * the probe spawns the CLI. The unit suite never runs it — `setup-env.ts`
 * primes the override slot with a hermetic reading, the same way the sign-in
 * driver's binaries are overridden (`setBackendBinariesForTests`).
 */

/** The once-per-process sandbox verdict. `detail` is the CLI's own first
 *  line when it failed (`bwrap: …`), a sentence about what ran when it did.
 *  A type alias, like `BuildInfo`: only an alias gets the implicit index
 *  signature that lets the boot integrity line carry it as a log field. */
export type CodexSandboxProbe = {
  ok: boolean;
  detail: string;
  /**
   * Ruling 184 (pass 36, F36-11): whether a sandboxed command can start a
   * CHILD process through Node's SYNCHRONOUS `child_process` API. Null when
   * the sandbox could not run a command at all, so the question was never
   * asked. The sandbox that runs `/bin/echo` fine can still deny this: with
   * the network off the CLI installs a seccomp filter that refuses EVERY
   * socket syscall, `AF_UNIX` included, and libuv's synchronous spawn needs a
   * socketpair — so `spawnSync`/`execSync` report `EPERM` even though the
   * child ran, and `npm ci` dies on the first lifecycle script.
   */
  childProcesses: CodexSandboxChildProbe | null;
};

/** The second sandbox question's answer (ruling 184). */
export type CodexSandboxChildProbe = {
  ok: boolean;
  /** Node's own errno when it failed; a sentence about what ran when it did. */
  detail: string;
};

/** A type alias, not an interface, for the same reason as `BuildInfo`. */
export type Toolchain = {
  /** The running process's own version; never null. */
  node: string | null;
  /** Each null when the tool is not installed (or answered nothing usable). */
  npm: string | null;
  git: string | null;
  python3: string | null;
  go: string | null;
  /** The pinned `@openai/codex` package — the CLI the Codex SDK spawns. */
  codexCli: string | null;
  /** The pinned `@anthropic-ai/claude-agent-sdk` package, which bundles the
   *  Claude CLI it spawns. */
  claudeAgentSdk: string | null;
  codexSandbox: CodexSandboxProbe;
};

/** One command's outcome, as the two probes read it. */
export type CommandOutcome =
  | { ok: true; stdout: string }
  | { ok: false; detail: string };

export interface CommandOptions {
  timeoutMs: number;
  /** The child's WHOLE env (the runner adds nothing). Absent: a minimal,
   *  credential-free base. */
  env?: Record<string, string>;
}

/** Runs one program (argv, never a shell). Injectable so the suite can feed
 *  the probes a fake without spawning anything. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => CommandOutcome;

const VERSION_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 30_000;

/** Under `<dataRoot>/runtimes/` — NOT the OS temp dir: the CLI refuses to
 *  create its exec helpers under a temporary directory. Removed after. */
export const CODEX_SANDBOX_PROBE_DIR = "codex-sandbox-probe";
/** The permissions profile the probe declares in its own `config.toml`. */
export const CODEX_SANDBOX_PROBE_PROFILE = "viberr_sandbox_probe";

/** What `execFileSync` throws, decoded: only the fields the probes read. */
const execFailureSchema = z
  .object({
    code: z.string().optional().catch(undefined),
    status: z.number().nullable().optional().catch(undefined),
    signal: z.string().nullable().optional().catch(undefined),
    stderr: z.string().optional().catch(undefined),
    message: z.string().optional().catch(undefined),
  })
  .catch({});

/** The env a probe child gets: the process's PATH, HOME, locale and temp
 *  settings and nothing else — credential-free by construction rather than by
 *  filtering, because a probe has no principal. */
const PROBE_ENV_NAMES = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"] as const;

function probeBaseEnv() {
  const env = new Map<string, string>();
  for (const name of PROBE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env.set(name, value);
  }
  return Object.fromEntries(env);
}

/** The real runner. A non-zero exit, a signal, a timeout and a missing
 *  program all become `{ ok: false, detail }`, the detail being the child's
 *  first stderr line (scrubbed) when it said anything, else the exit shape. */
export const runCommand: CommandRunner = (command, args, options) => {
  try {
    const stdout = execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? probeBaseEnv(),
    });
    return { ok: true, stdout };
  } catch (error) {
    const failure = execFailureSchema.parse(error);
    const firstStderrLine = (failure.stderr ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstStderrLine) return { ok: false, detail: redactGitOutput(firstStderrLine) };
    if (failure.code === "ENOENT") return { ok: false, detail: `${command} is not installed` };
    if (failure.code === "ETIMEDOUT") {
      return { ok: false, detail: `${command} did not finish within ${options.timeoutMs} ms` };
    }
    if (failure.signal) return { ok: false, detail: `${command} was killed by ${failure.signal}` };
    if (failure.status !== null && failure.status !== undefined) {
      return { ok: false, detail: `${command} exited ${failure.status} with nothing on stderr` };
    }
    return { ok: false, detail: redactGitOutput(failure.message ?? `${command} failed`) };
  }
};

const VERSION_RE = /\d+\.\d+\.\d+[0-9A-Za-z.+-]*/;

/** The first semver-shaped token of a `--version` line, or null. */
export function versionOf(text: string | null | undefined): string | null {
  const match = text ? VERSION_RE.exec(text) : null;
  return match ? match[0] : null;
}

const VERSION_COMMANDS: ReadonlyArray<readonly [keyof Toolchain, string, readonly string[]]> = [
  ["npm", "npm", ["--version"]],
  ["git", "git", ["--version"]],
  ["python3", "python3", ["--version"]],
  ["go", "go", ["version"]],
];

const packageManifestSchema = z.object({
  name: z.string(),
  version: z.string().trim().min(1),
});

/**
 * A pinned package's `version`, resolved from THIS module's own dependency
 * tree (a hoisted or nested install both work), or null when the package is
 * not installed. `@openai/codex` exports its manifest; the Claude Agent SDK's
 * `exports` map does not, so the fallback resolves the package's entry and
 * walks up to the manifest that carries its name.
 */
function pinnedPackageVersion(packageName: string): string | null {
  const require = createRequire(import.meta.url);
  try {
    return readManifest(require.resolve(`${packageName}/package.json`), packageName);
  } catch {
    // Not exported: fall through to the entry file.
  }
  try {
    let dir = path.dirname(require.resolve(packageName));
    for (let depth = 0; depth < 8; depth += 1) {
      const version = readManifest(path.join(dir, "package.json"), packageName);
      if (version) return version;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Not installed at all.
  }
  return null;
}

/** The manifest's version when it is THIS package's manifest, else null. */
function readManifest(file: string, packageName: string): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const parsed = packageManifestSchema.safeParse(manifest);
  return parsed.success && parsed.data.name === packageName ? parsed.data.version : null;
}

export interface CodexSandboxProbeDeps {
  run?: CommandRunner;
  dataRoot?: string;
  /** The Codex CLI binary; `undefined` resolves it the way every other Codex
   *  spawn does (`backendBinaryIfPresent`), `null` stands for "not installed". */
  codexBinary?: string | null;
}

/** The probe's own `config.toml`: one named permissions profile that reads
 *  everything and writes the probe's workdir — the `workspace-write` shape —
 *  with the network off. The path is a TOML basic string; JSON's escapes are
 *  a subset of TOML's. */
export function codexSandboxProbeConfig(workDir: string): string {
  return [
    `[permissions.${CODEX_SANDBOX_PROBE_PROFILE}]`,
    `[permissions.${CODEX_SANDBOX_PROBE_PROFILE}.filesystem]`,
    `"/" = "read"`,
    `${JSON.stringify(workDir)} = "write"`,
    `[permissions.${CODEX_SANDBOX_PROBE_PROFILE}.network]`,
    `enabled = false`,
    "",
  ].join("\n");
}

/**
 * The canary the child-process probe runs INSIDE the sandbox: spawn
 * `/bin/echo` through Node's synchronous API and print what Node made of it.
 * `node -e` runs CommonJS, so `require` is available. One line, no quotes that
 * a shell could eat — it is passed as argv, never through a shell.
 */
export const CODEX_SANDBOX_CHILD_CANARY =
  'const r=require("node:child_process").spawnSync("/bin/echo",["viberr"],{encoding:"utf8"});' +
  'process.stdout.write(r.error?"child:"+(r.error.code||"failed"):' +
  'r.status===0?"child:ok":"child:exit "+r.status);';

/**
 * Ruling 184: ask the sandbox the SECOND question — can a command it runs
 * start a child process the way every JS build and test tool does? The echo
 * canary above proves exec works; this one proves `spawnSync` does. Run in the
 * SAME throwaway home and profile (network off, which is what installs the
 * seccomp filter that denies it).
 */
function probeCodexSandboxChildProcesses(
  binary: string,
  home: string,
  work: string,
  run: CommandRunner,
): CodexSandboxChildProbe {
  const outcome = run(
    binary,
    [
      "sandbox",
      "--permission-profile",
      CODEX_SANDBOX_PROBE_PROFILE,
      "-C",
      work,
      "--",
      process.execPath,
      "-e",
      CODEX_SANDBOX_CHILD_CANARY,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS, env: { ...probeBaseEnv(), CODEX_HOME: home, CODEX_SQLITE_HOME: home } },
  );
  if (!outcome.ok) return { ok: false, detail: outcome.detail };
  const answer = outcome.stdout.trim().split("\n").at(-1)?.trim() ?? "";
  if (answer === "child:ok") {
    return { ok: true, detail: "a sandboxed command started a child process through Node's synchronous API" };
  }
  if (answer.startsWith("child:")) {
    const code = answer.slice("child:".length).trim();
    return {
      ok: false,
      detail:
        `Node's synchronous \`spawnSync\` reported \`${code}\` inside the sandbox` +
        (code === "EPERM"
          ? " — the network-off seccomp filter denies every socket syscall, AF_UNIX included, and libuv's synchronous spawn needs a socketpair"
          : ""),
    };
  }
  return { ok: false, detail: "the sandboxed child-process canary printed nothing usable" };
}

/**
 * Run `/bin/echo <nonce>` under the CLI's sandbox in a throwaway home and
 * report whether the nonce came back. Everything the probe creates lives under
 * `<dataRoot>/runtimes/codex-sandbox-probe/` and is removed afterwards; the
 * home holds no sign-in, so nothing in the CLI's output can be a credential.
 */
export function probeCodexSandbox(deps: CodexSandboxProbeDeps = {}): CodexSandboxProbe {
  const binary =
    deps.codexBinary === undefined ? (backendBinaryIfPresent("codex") ?? null) : deps.codexBinary;
  if (!binary) {
    return {
      ok: false,
      detail: "the @openai/codex package is not installed in this deployment",
      childProcesses: null,
    };
  }
  const root = path.join(getDataRoot(deps.dataRoot), "runtimes", CODEX_SANDBOX_PROBE_DIR);
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  const run = deps.run ?? runCommand;
  try {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(home, "config.toml"), codexSandboxProbeConfig(work), { mode: 0o600 });
    const nonce = `viberr-sandbox-probe-${process.pid}-${Date.now().toString(36)}`;
    const outcome = run(
      binary,
      ["sandbox", "--permission-profile", CODEX_SANDBOX_PROBE_PROFILE, "-C", work, "--", "/bin/echo", nonce],
      { timeoutMs: PROBE_TIMEOUT_MS, env: { ...probeBaseEnv(), CODEX_HOME: home, CODEX_SQLITE_HOME: home } },
    );
    if (!outcome.ok) return { ok: false, detail: outcome.detail, childProcesses: null };
    if (outcome.stdout.trim() !== nonce) {
      return {
        ok: false,
        detail: "codex sandbox exited 0 but the sandboxed command's output did not come back",
        childProcesses: null,
      };
    }
    return {
      ok: true,
      detail: "codex sandbox ran /bin/echo under a workspace-write profile",
      // Ruling 184: the second question, asked only once exec itself works.
      childProcesses: probeCodexSandboxChildProcesses(binary, home, work, run),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      detail: redactGitOutput(message) || "the sandbox probe could not be set up",
      childProcesses: null,
    };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      logger.warn("codex sandbox probe directory could not be removed", {
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

export interface ToolchainDeps {
  run?: CommandRunner;
  probeCodexSandbox?: () => CodexSandboxProbe;
}

/** Resolve the reading now (pure over its deps — the test drives this). */
export function resolveToolchain(deps: ToolchainDeps = {}): Toolchain {
  const run = deps.run ?? runCommand;
  const versions: Partial<Record<keyof Toolchain, string | null>> = {};
  for (const [field, command, args] of VERSION_COMMANDS) {
    const outcome = run(command, args, { timeoutMs: VERSION_TIMEOUT_MS });
    versions[field] = outcome.ok ? versionOf(outcome.stdout) : null;
  }
  return {
    node: versionOf(process.version),
    npm: versions.npm ?? null,
    git: versions.git ?? null,
    python3: versions.python3 ?? null,
    go: versions.go ?? null,
    codexCli: pinnedPackageVersion("@openai/codex"),
    claudeAgentSdk: pinnedPackageVersion("@anthropic-ai/claude-agent-sdk"),
    codexSandbox: (deps.probeCodexSandbox ?? probeCodexSandbox)(),
  };
}

const TOOLCHAIN_OVERRIDE_KEY = Symbol.for("viberr.toolchainOverride");

/** The suite's hermetic reading, when `test-support/toolchain.ts` primed one:
 *  the ONE writer of that slot. Never set by anything a deployment can reach. */
function toolchainOverride(): Toolchain | null {
  // SAFETY: `globalThis` carries no index signature, so the symbol slot has to
  // be named to be read at all. `Symbol.for("viberr.toolchainOverride")` is
  // written nowhere but `test-support/toolchain.ts`.
  const slot = globalThis as Record<symbol, Toolchain | undefined>;
  return slot[TOOLCHAIN_OVERRIDE_KEY] ?? null;
}

let cached: Toolchain | null = null;

/** Process-wide reading, resolved on first call and cached. */
export function cachedToolchain(): Toolchain {
  const override = toolchainOverride();
  if (override) return override;
  cached ??= resolveToolchain();
  return cached;
}

/** Test-only: drop the cached resolution (the override, if any, still wins). */
export function resetToolchainCacheForTests(): void {
  cached = null;
}
