import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";

/**
 * What this host can run (ruling 182, narrowed by ruling 185).
 *
 * G36-2 asked what an agent's shell would actually find here, so the versions
 * of the tools a run reaches for ride `healthSnapshot` — `/resources/health`
 * and the controller's `instance_health` both read them, and a controller can
 * answer "can this deployment build a Go service?" without guessing.
 *
 * The sandbox half is GONE with the sandbox: ruling 185 (owner, 2026-09-12)
 * removed Viberr's use of the Codex CLI's OS sandbox, so there is no longer a
 * confinement to probe, nothing to refuse a run over, and no second question
 * about child processes (ruling 184). What remains is the honest inventory.
 *
 * Memoized per process: versions cannot change while the process lives, and
 * each probe spawns a binary. The unit suite never runs them — `setup-env.ts`
 * primes the override slot with a hermetic reading, the same way the sign-in
 * driver's binaries are overridden (`setBackendBinariesForTests`).
 */

/** A type alias, not an interface, for the same reason as `BuildInfo`. */
export type Toolchain = {
  /** The running process's own version; never null. */
  node: string | null;
  /** Each null when the tool is not installed (or answered nothing usable). */
  npm: string | null;
  git: string | null;
  python3: string | null;
  go: string | null;
  /** Ruling 191: the four a run reaches for before anything else and cannot
   *  install when they are missing. `make` and `docker` drive nearly every
   *  "one command to bring it up" contract; `pnpm` and `yarn` decide whether a
   *  workspace's own lockfile can be honoured; `curl` is how a health check
   *  gets made. Live pass 37: all five absent, 75 `command not found` lines,
   *  and a required reviewer chartered to run a stack that cannot exist. */
  make: string | null;
  docker: string | null;
  pnpm: string | null;
  yarn: string | null;
  curl: string | null;
  /** The pinned `@openai/codex` package — the CLI the Codex SDK spawns. */
  codexCli: string | null;
  /** The pinned `@anthropic-ai/claude-agent-sdk` package, which bundles the
   *  Claude CLI it spawns. */
  claudeAgentSdk: string | null;
};

/** One command's outcome, as the version probes read it. */
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
  ["make", "make", ["--version"]],
  ["docker", "docker", ["--version"]],
  ["pnpm", "pnpm", ["--version"]],
  ["yarn", "yarn", ["--version"]],
  ["curl", "curl", ["--version"]],
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

export interface ToolchainDeps {
  run?: CommandRunner;
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
    make: versions.make ?? null,
    docker: versions.docker ?? null,
    pnpm: versions.pnpm ?? null,
    yarn: versions.yarn ?? null,
    curl: versions.curl ?? null,
    codexCli: pinnedPackageVersion("@openai/codex"),
    claudeAgentSdk: pinnedPackageVersion("@anthropic-ai/claude-agent-sdk"),
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

/**
 * The shell tools a run can invoke, in the order a reader wants them — the
 * runtimes (`codexCli`, `claudeAgentSdk`) are deliberately out: they are what
 * SPAWNS the agent, not something the agent calls.
 */
const SHELL_TOOLS: ReadonlyArray<readonly [keyof Toolchain, string]> = [
  ["node", "node"],
  ["npm", "npm"],
  ["git", "git"],
  ["make", "make"],
  ["docker", "docker"],
  ["pnpm", "pnpm"],
  ["yarn", "yarn"],
  ["curl", "curl"],
  ["python3", "python3"],
  ["go", "go"],
];

/**
 * Ruling 191: what a run's shell will and will not find, as a paragraph for
 * the agent, the operator and the controller alike.
 *
 * Until this existed the reading was reachable only through the controller's
 * opt-in `instance_health`, and the people whose shell it actually is — every
 * delivering and reviewing agent — could not see it at all. Live pass 37 they
 * discovered it one exit-127 at a time: 75 `command not found` lines, a
 * monorepo committed around `pnpm` and `turbo`, a root `Makefile` nothing can
 * run, an architecture built on Docker Compose, and a REQUIRED reviewer whose
 * entire pass begins "clean checkout, `make up`, everything healthy" on a host
 * with neither `make` nor Docker — so its verdict could only ever be
 * `request_changes`, and the work went back for rework over it.
 *
 * The advice half matters as much as the inventory: `npx` genuinely rescues an
 * npm-published tool, and nothing rescues one the operating system was meant
 * to provide, so the two cases must not read alike.
 */
export function shellInventoryPrompt(tc: Toolchain): string {
  const present: string[] = [];
  const absent: string[] = [];
  for (const [field, label] of SHELL_TOOLS) {
    const version = tc[field];
    if (version) present.push(`${label} ${version}`);
    else absent.push(label);
  }
  const lines = [
    "## Shell inventory (measured on this host, not a guess)",
    "",
    present.length > 0
      ? `Present: ${present.join(", ")}.`
      : "Present: nothing this probe recognises.",
  ];
  if (absent.length > 0) {
    lines.push(
      `NOT installed: ${absent.join(", ")}.`,
      "",
      "A missing command exits 127 (`command not found`). npm is here, so an " +
        "npm-published tool can still be fetched with `npx <tool>`; anything the " +
        "operating system provides — `make`, `docker`, `curl` — cannot be " +
        "installed from here at all. Plan the work, and any verification you " +
        "promise, around what is actually present. A step that calls an absent " +
        "tool will not run, and saying so plainly is the honest outcome — never " +
        "report an unrun check as a pass, and never treat one as the " +
        "deliverable's fault.",
    );
  } else {
    lines.push("", "Every tool this probe knows about is installed.");
  }
  return lines.join("\n");
}
