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
const runCommand: CommandRunner = (command, args, options) => {
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

// ------------------------------------------------- probing an arbitrary tool

/**
 * F39-1 (pass 39): whether ONE named command exists on this host.
 *
 * {@link Toolchain} is a fixed struct, and ruling 191 widened the LIST without
 * changing that: it still answers only for the ten names it was compiled with,
 * all of them npm-shaped. A project whose gates are `gofmt`, `go vet`,
 * `golangci-lint` and `go test` can therefore verify three of its four gates
 * and not the fourth, and nothing in the product can answer "is
 * `golangci-lint` on PATH?".
 *
 * Live in pass 39 the controller — briefed with those exact four gates, and
 * behaving correctly given what it could see — wrote "golangci-lint is NOT
 * preinstalled" into the project's binding rulings, budgeted a whole delivery
 * task to find out, and told its owner "I have no shell". golangci-lint was
 * installed. The fact was one `command -v` away and no surface could ask.
 *
 * Bounded by construction rather than by trust:
 *  - the NAME is matched against {@link PROBE_NAME_RE} — letters, digits, dot,
 *    dash, underscore, plus — so nothing that could be a path, a flag, a shell
 *    metacharacter or an option ever reaches a child;
 *  - `command -v` runs through `/bin/sh` with the name as an ARGUMENT (`-c` with
 *    `"$1"`), never interpolated into the script, so a name that slipped the
 *    regex still could not become code;
 *  - one `--version` follows only when the lookup SUCCEEDED, argv, no shell;
 *  - both children get the credential-free probe env every other probe gets.
 *
 * It reports presence and a version, never a path: where a binary lives is
 * deployment configuration, and this reading is open to any asker.
 */
export const PROBE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** The most names one call may probe: a bounded question, not an inventory. */
export const PROBE_LIMIT = 8;

export type ProbedTool =
  | { name: string; present: true; version: string | null }
  | { name: string; present: false; reason: string };

export function probeTool(name: string, deps: ToolchainDeps = {}): ProbedTool {
  const run = deps.run ?? runCommand;
  const cleaned = name.trim();
  if (!PROBE_NAME_RE.test(cleaned)) {
    return {
      name: cleaned,
      present: false,
      reason:
        "not a command name; probe a bare name like \"golangci-lint\", never a path, a flag or a shell fragment",
    };
  }
  // `command -v` is POSIX and answers for builtins and functions too, which
  // `which` does not. The name is argv, never part of the script.
  const found = run("/bin/sh", ["-c", 'command -v -- "$1"', "sh", cleaned], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  if (!found.ok || !found.stdout.trim()) {
    return { name: cleaned, present: false, reason: `${cleaned} is not on PATH` };
  }
  const version = run(cleaned, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  return {
    name: cleaned,
    present: true,
    version: version.ok ? versionOf(version.stdout) : null,
  };
}

/**
 * Probe up to {@link PROBE_LIMIT} names, de-duplicated, in the order asked.
 * A tool that was FOUND is memoized for the life of the process, like every
 * other probe here. A miss is asked again: the probe exists so a gate is
 * checked before it is promised, and the usual answer to "golangci-lint is
 * not on PATH" is a person installing it, which a cached miss would deny
 * until the next restart.
 */
const probeCache = new Map<string, ProbedTool>();

export function probeTools(
  names: readonly string[],
  deps: ToolchainDeps = {},
): ProbedTool[] {
  const seen = new Set<string>();
  const out: ProbedTool[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (out.length >= PROBE_LIMIT) break;
    const hit = probeCache.get(name);
    if (hit) {
      out.push(hit);
      continue;
    }
    const probed = probeTool(name, deps);
    // Only a tool that is there. A malformed NAME is not a host fact, and an
    // absent tool is one a person can fix while the server runs.
    if (probed.present) probeCache.set(name, probed);
    out.push(probed);
  }
  return out;
}

/** Test-only: forget probed names (the version cache is separate). */
export function resetProbeCacheForTests(): void {
  probeCache.clear();
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

/** The absent tools `npx` can still fetch, because npm publishes them. The rest
 *  come from the operating system and no run can install one. */
const NPM_REACHABLE: ReadonlySet<keyof Toolchain> = new Set(["pnpm", "yarn"]);

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
/**
 * Ruling 275 (pass 37, F37-108): the tools a piece of PROSE plans around that
 * this host does not have.
 *
 * Word-boundary, case-insensitive, over the labels the probe actually measured
 * — so it can only ever name a tool that was measured and found absent, and it
 * says nothing when the prose is clean. `go` is excluded: it is an ordinary
 * English word and a persona saying "go and read the tests" is not a plan
 * against a Go toolchain.
 */
function absentToolsNamedIn(tc: Toolchain, prose: string): string[] {
  if (!prose.trim()) return [];
  const named: string[] = [];
  for (const [field, label] of SHELL_TOOLS) {
    if (tc[field]) continue;
    if (label === "go") continue;
    if (new RegExp(`\\b${label}\\b`, "i").test(prose)) named.push(label);
  }
  return named;
}

export function shellInventoryPrompt(
  tc: Toolchain,
  /**
   * Ruling 275: the run's OWN role description, when there is one. Ruling 191
   * put this measurement into every prompt, and it says what the host lacks —
   * it did not say "and the role description above plans around three of
   * them". A contradiction inside one prompt is resolved by the model, and the
   * persona is the half written with more authority and read first. Live, this
   * instance's Infrastructure Engineer was told it owns "the Docker Compose
   * stack" and that "`make up` is your headline deliverable" while running two
   * tasks on a host with neither.
   */
  persona: string = "",
): string {
  const present: string[] = [];
  const absent: string[] = [];
  const fetchable: string[] = [];
  const osOnly: string[] = [];
  for (const [field, label] of SHELL_TOOLS) {
    const version = tc[field];
    if (version) {
      present.push(`${label} ${version}`);
      continue;
    }
    absent.push(label);
    (NPM_REACHABLE.has(field) ? fetchable : osOnly).push(label);
  }
  const lines = [
    "## Shell inventory (measured on this host, not a guess)",
    "",
    present.length > 0
      ? `Present: ${present.join(", ")}.`
      : "Present: nothing this probe recognises.",
  ];
  if (absent.length > 0) {
    // Both halves of the advice are derived, not asserted. Naming `npx` on a
    // host with no npm would be a lie, and listing an INSTALLED tool as the
    // example of something uninstallable reads as one.
    const routes: string[] = [];
    if (fetchable.length > 0 && tc.npm) {
      routes.push(
        `npm is here, so ${fetchable.map((t) => `\`${t}\``).join(" and ")} can still be ` +
          "fetched with `npx <tool>`",
      );
    }
    if (osOnly.length > 0) {
      routes.push(
        `${osOnly.map((t) => `\`${t}\``).join(", ")} come from the operating system and ` +
          "cannot be installed from here at all",
      );
    }
    if (!tc.npm) routes.push("npm is not here either, so nothing can be fetched");
    lines.push(
      `NOT installed: ${absent.join(", ")}.`,
      "",
      `A missing command exits 127 (\`command not found\`). ${routes.join("; ")}. ` +
        "Plan the work, and any verification you promise, around what is actually " +
        "present. A step that calls an absent tool will not run, and saying so plainly " +
        "is the honest outcome; never report an unrun check as a pass, and never treat " +
        "one as the deliverable's fault.",
    );
  } else {
    lines.push("", "Every tool this probe knows about is installed.");
  }
  // Ruling 275: named specifically, because "NOT installed: docker, make" a
  // paragraph below a role description that says the stack is yours is a
  // contradiction the reader has to notice on its own.
  const conflicts = absentToolsNamedIn(tc, persona);
  if (conflicts.length > 0) {
    lines.push(
      "",
      `Your own role description above mentions ${conflicts
        .map((t) => `\`${t}\``)
        .join(", ")} (not on this host). Where it plans around ` +
        `${conflicts.length === 1 ? "that" : "those"}, this measurement is the ` +
        "one that is true today: say so and work to what is here, rather than " +
        "following the description into a command that exits 127.",
    );
  }
  return lines.join("\n");
}
