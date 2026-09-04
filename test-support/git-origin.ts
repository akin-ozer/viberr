import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * A LOCAL GitHub stand-in for tests that drive the real git paths (the mirror
 * cache, the operator checkout, the workspace refresh, the branch update).
 *
 * `https://github.com/<owner>/<name>` is rewritten to a bare repository on
 * disk through a temp `GIT_CONFIG_GLOBAL` (`url.<dir>.insteadOf`), and
 * `GIT_ALLOW_PROTOCOL=file` keeps a rewrite that stopped applying from
 * dialling out: git FAILS rather than reaching the network from a unit test.
 * Extracted in pass 34 from `repo-mirror.server.test.ts` and
 * `operator-run.server.test.ts`, which each carried their own copy.
 */

const exec = promisify(execFile);

export interface LocalOrigin {
  /** The bare repository's path. */
  bare: string;
  /** The seed working tree that pushes commits into `bare`. */
  seed: string;
  /** The root commit's full sha. */
  firstCommit: string;
  /** Land one more commit on `branch` (default `main`) and return its sha. */
  advance(options?: { file?: string; branch?: string; message?: string }): Promise<string>;
  /** The sha `bare` currently holds for `refs/heads/<branch>`. */
  head(branch?: string): Promise<string>;
}

export interface CreateLocalOriginOptions {
  /** `owner/name`, the repository the origin stands in for. */
  repo: string;
  /** Files the root commit carries; `README.md` when omitted. */
  files?: Record<string, string>;
  /** When true, `bare` is created with NO commits (an EMPTY repository). */
  empty?: boolean;
}

/**
 * Create `<origins>/<owner>/<name>.git` with one root commit on `main`
 * (or none when `empty`). Several origins may share one `origins` directory,
 * one per repo name.
 */
export async function createLocalOrigin(
  origins: string,
  options: CreateLocalOriginOptions,
): Promise<LocalOrigin> {
  const [owner, name] = options.repo.split("/");
  const bare = path.join(origins, owner!, `${name}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  await exec("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const seed = path.join(origins, `seed-${owner}-${name}`);
  mkdirSync(seed, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main", seed]);
  await exec("git", ["-C", seed, "config", "user.email", "t@t.dev"]);
  await exec("git", ["-C", seed, "config", "user.name", "T"]);
  let firstCommit = "";
  if (!options.empty) {
    const files = options.files ?? { "README.md": `# ${name}\n` };
    for (const [rel, body] of Object.entries(files)) {
      const target = path.join(seed, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    await exec("git", ["-C", seed, "add", "-A"]);
    await exec("git", ["-C", seed, "commit", "-qm", "init"]);
    await exec("git", ["-C", seed, "push", "-q", bare, "HEAD:refs/heads/main"]);
    firstCommit = (await exec("git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();
  }
  let advanceCount = 0;
  return {
    bare,
    seed,
    firstCommit,
    async advance(options = {}) {
      advanceCount += 1;
      const file = options.file ?? "CHANGELOG.md";
      const branch = options.branch ?? "main";
      const message = options.message ?? `change ${advanceCount}`;
      writeFileSync(path.join(seed, file), `${message}\n`);
      await exec("git", ["-C", seed, "add", "-A"]);
      await exec("git", ["-C", seed, "commit", "-qm", message]);
      await exec("git", ["-C", seed, "push", "-q", bare, `HEAD:refs/heads/${branch}`]);
      return (await exec("git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();
    },
    async head(branch = "main") {
      const out = await exec("git", ["-C", bare, "rev-parse", "--verify", `refs/heads/${branch}`]);
      return out.stdout.trim();
    },
  };
}

/**
 * Point `https://github.com/` at `root` for the duration of `work` — an
 * existing origins directory for the success arm, a missing one to make the
 * real clone fail instantly and offline.
 */
export async function withLocalGithub<T>(root: string, work: () => Promise<T>): Promise<T> {
  // The config file lives INSIDE the origins directory when it exists (so the
  // test context cleans it up) and beside a deliberately missing one.
  const configPath = path.join(
    existsSync(root) ? root : path.dirname(root),
    `gitconfig-${path.basename(root)}-${process.pid}-${Date.now()}`,
  );
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `[url "${root}${path.sep}"]\n\tinsteadOf = https://github.com/\n`,
  );
  const saved = {
    global: process.env.GIT_CONFIG_GLOBAL,
    system: process.env.GIT_CONFIG_SYSTEM,
    protocol: process.env.GIT_ALLOW_PROTOCOL,
  };
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  // Belt and braces: if the rewrite ever stopped applying, git must FAIL
  // rather than quietly reach github.com from a unit test.
  process.env.GIT_ALLOW_PROTOCOL = "file";
  try {
    return await work();
  } finally {
    for (const [key, value] of [
      ["GIT_CONFIG_GLOBAL", saved.global],
      ["GIT_CONFIG_SYSTEM", saved.system],
      ["GIT_ALLOW_PROTOCOL", saved.protocol],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run a git command in `cwd` and return trimmed stdout. */
export async function gitOut(cwd: string, args: string[]): Promise<string> {
  const out = await exec("git", ["-C", cwd, ...args]);
  return out.stdout.trim();
}
