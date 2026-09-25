import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  createLocalOrigin,
  withLocalGithub,
  type LocalOrigin,
} from "../../../test-support/git-origin";
import { taskDir } from "~/server/files/file-store-root.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import { updateWorkspaceBranchFromBase } from "~/server/github/update-branch.server";
import { reconcileWorkspaceDelivery } from "~/server/github/workspace-delivery.server";
import {
  AGENT_UID_FLOOR,
  resetAgentIsolationForTests,
} from "~/server/runtimes/agent-isolation.server";
import { filteredSpawnEnv } from "~/server/runtimes/spawn-env.server";
import { createGitHubAskpassEnv, serverGitEnv } from "./git-clone-auth.server";
import { refreshWorkspaceFromMirror } from "./workspace-refresh.server";

/**
 * Pass 40 review, R-seams-1: the server never executes git with an
 * agent-writable repository as its working repository under its own uid.
 *
 * Ruling 460 shares every task workspace with the agent group, so an agent
 * can plant hooks, `core.fsmonitor`, a credential helper or `url.insteadOf` in
 * a checkout's `.git`. These tests plant all of them and drive the server's
 * real paths — the pre-run refresh, the delivery push, the branch update, the
 * reconcile — against real git and a GitHub stand-in on disk, and assert that
 * nothing planted ever ran and that the PAT's push never went where the
 * checkout's config pointed. The suite runs with isolation off and one uid, so
 * the SHAPE isolation depends on (the launcher for every workspace git and for
 * the transport's `git-upload-pack`, no server secret or PAT in a launched
 * environment, the push from a stage the server owns) is proven with a
 * stand-in launcher that logs what the real one reads and then execs.
 */

const REPO = "akin-ozer/viberr";
const TOKEN = "ghp_workspacegitseam0000000000000000000";
const SYS = { userId: null, label: "test" };
/** Every hook a refresh, a delivery or a branch update could reach. */
const HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-checkout",
  "post-merge",
  "pre-merge-commit",
  "pre-push",
  "reference-transaction",
  "post-rewrite",
  "pre-auto-gc",
  "post-index-change",
];
/** The test's OWN git in the workspace never runs what it planted. */
const QUIET = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

let ctx: TestDbContext;
let store: TestStore;
let origins: string;
let origin: LocalOrigin;
let scratch: string;
/** Every planted program appends one line here when it runs. */
let marker: string;
/** Where the checkout's planted `insteadOf` points: a GitHub of the agent's. */
let evilRoot: string;
let savedPath: string | undefined;

function g(cwd: string, args: string[]): string {
  return execFileSync("git", [...QUIET, ...args], { cwd, stdio: "pipe" }).toString().trim();
}

function bare(dir: string, args: string[]): string {
  return execFileSync("git", ["--git-dir", dir, ...args], { stdio: "pipe" }).toString().trim();
}

function ran(): string {
  return existsSync(marker) ? readFileSync(marker, "utf8") : "";
}

function workspaceDir(): string {
  return path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr");
}

/** The task's checkout, cloned from the GitHub stand-in as Viberr leaves it. */
async function checkout(): Promise<string> {
  const dir = workspaceDir();
  mkdirSync(path.dirname(dir), { recursive: true });
  await withLocalGithub(origins, async () => {
    execFileSync("git", ["clone", "-q", `https://github.com/${REPO}`, dir], { stdio: "pipe" });
  });
  g(dir, ["config", "user.email", "agent@t.dev"]);
  g(dir, ["config", "user.name", "Agent"]);
  return dir;
}

/** What an agent can write into any checkout under ruling 460. */
function plant(dir: string): void {
  const script = path.join(scratch, "planted.sh");
  writeFileSync(
    script,
    "#!/bin/sh\n" +
      `printf '%s uid=%s secret=%s pat=%s\\n' "$(basename "$0")" "$(id -u)" ` +
      `"\${VIBERR_SECRET_ENCRYPTION_KEY:-}" "\${VIBERR_GIT_ASKPASS_PASSWORD:-}" >> '${marker}'\n` +
      "exit 0\n",
  );
  chmodSync(script, 0o755);
  const configured = path.join(dir, ".git", "planted-hooks");
  mkdirSync(configured, { recursive: true });
  for (const hooks of [path.join(dir, ".git", "hooks"), configured]) {
    for (const name of HOOKS) {
      writeFileSync(path.join(hooks, name), readFileSync(script));
      chmodSync(path.join(hooks, name), 0o755);
    }
  }
  g(dir, ["config", "core.hooksPath", configured]);
  g(dir, ["config", "core.fsmonitor", script]);
  g(dir, ["config", "credential.helper", `!${script}`]);
  g(dir, ["config", `url.${evilRoot}/.insteadOf`, "https://github.com/"]);
  g(dir, ["config", `url.${evilRoot}/.pushInsteadOf`, "https://github.com/"]);
}

function taskBranchWithWork(dir: string): string {
  g(dir, ["checkout", "-q", "-b", "vib-1-work"]);
  writeFileSync(path.join(dir, "work.txt"), "the agent's work\n");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-q", "-m", "agent work"]);
  return g(dir, ["rev-parse", "HEAD"]);
}

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      branch: "vib-1-work",
      ownerUserId: store.users.arda.id,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  const pat = createPat(store.db, { userId: store.users.arda.id, label: "t", token: TOKEN }, SYS);
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, SYS);
  origins = ctx.makeTempDir("viberr-origins-");
  origin = await createLocalOrigin(origins, { repo: REPO });
  scratch = ctx.makeTempDir("viberr-planted-");
  marker = path.join(scratch, "ran.log");
  evilRoot = path.join(scratch, "evil");
  execFileSync("git", ["init", "-q", "--bare", path.join(evilRoot, "akin-ozer", "viberr.git")]);
  savedPath = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  resetAgentIsolationForTests();
  ctx.cleanup();
});

describe("nothing an agent plants in a checkout runs under the server's git (R-seams-1)", () => {
  it("the pre-run refresh fast-forwards a checkout carrying planted hooks and fsmonitor, running none", async () => {
    // Canary: empty SERVER_GIT_CONFIG (git-clone-auth.server.ts) and the
    // refresh's `status` runs the planted fsmonitor, its `merge --ff-only`
    // the planted post-merge and reference-transaction hooks.
    const dir = await checkout();
    const advanced = await origin.advance({ message: "second" });
    plant(dir);
    const result = await withLocalGithub(origins, () =>
      refreshWorkspaceFromMirror(store.db, {
        projectSlug: store.slug,
        repo: REPO,
        dir,
        defaultBranch: "main",
        dataRoot: store.dataRoot,
        fastForward: true,
        taskKey: "VIB-1",
      }),
    );
    expect(result).toMatchObject({ status: "fast_forwarded", from: "behind", head: advanced });
    expect(g(dir, ["rev-parse", "HEAD"])).toBe(advanced);
    expect(ran()).toBe("");
  });

  it("the delivery commits and pushes a checkout that plants hooks, a helper and an insteadOf: nothing runs, and the push reaches the project's repository", async () => {
    // Canaries: push from the workspace again (`git -C <checkout> push origin
    // HEAD:…`) and the planted pushInsteadOf carries the push, and the PAT's
    // askpass, to the agent's repository; drop `core.hooksPath` from
    // SERVER_GIT_CONFIG and the auto-commit runs the planted pre-commit.
    const dir = await checkout();
    taskBranchWithWork(dir);
    // Left uncommitted: the delivery's own `add -A` and `commit` run.
    writeFileSync(path.join(dir, "left.txt"), "uncommitted work\n");
    plant(dir);

    const res = await withLocalGithub(origins, () =>
      pushWorkspaceBranch({
        db: store.db,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      }),
    );

    expect(res).toMatchObject({ status: "pushed", branch: "vib-1-work", remoteHeadBefore: null });
    const head = g(dir, ["rev-parse", "HEAD"]);
    expect(g(dir, ["log", "-1", "--format=%s"])).toBe(
      "[VIB-1] deliver working-tree changes from the agent run",
    );
    // The project's repository has the delivered head; the agent's has nothing.
    expect(bare(origin.bare, ["rev-parse", "refs/heads/vib-1-work"])).toBe(head);
    expect(bare(path.join(evilRoot, "akin-ozer", "viberr.git"), ["for-each-ref"])).toBe("");
    expect(ran()).toBe("");
    // The stage the push went out from is gone.
    expect(readdirSync(path.join(store.dataRoot, "projects", store.slug, ".repo-stage"))).toEqual([]);
  });

  it("the branch update merges and pushes through the stage: nothing planted runs, and the push is the project's", async () => {
    // Canaries: push from the workspace again (`publishFromWorkspace` running
    // `git -C <checkout> push origin HEAD:…`) and the planted pushInsteadOf
    // carries the merge to the agent's repository; empty SERVER_GIT_CONFIG
    // and the merge runs the planted pre-merge-commit and post-merge hooks.
    const dir = await checkout();
    taskBranchWithWork(dir);
    await origin.advance({ file: "BASE.md", message: "base moved" });
    plant(dir);

    const res = await withLocalGithub(origins, () =>
      updateWorkspaceBranchFromBase({
        db: store.db,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      }),
    );

    expect(res).toMatchObject({ status: "updated", branch: "vib-1-work", base: "main", commits: 1 });
    if (res.status !== "updated") throw new Error("unreachable");
    expect(g(dir, ["rev-parse", "HEAD"])).toBe(res.mergeSha);
    expect(bare(origin.bare, ["rev-parse", "refs/heads/vib-1-work"])).toBe(res.mergeSha);
    expect(bare(path.join(evilRoot, "akin-ozer", "viberr.git"), ["for-each-ref"])).toBe("");
    expect(ran()).toBe("");
  });

  it("the reconcile reads the checkout without running what it planted, and runs `gh` outside it", async () => {
    // Canary: hand `gh` the checkout as its cwd again (`reconcileExec`) and
    // the stand-in `gh` reports the workspace.
    const dir = await checkout();
    taskBranchWithWork(dir);
    plant(dir);
    const bin = ctx.makeTempDir("viberr-gh-");
    const ghLog = path.join(bin, "gh.log");
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\npwd -P >> '${ghLog}'\nexit 1\n`);
    chmodSync(path.join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;

    const res = await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
      profileId: "developer",
    });

    expect(res.status).toBe("reconciled");
    expect(res.commits).toBe(1);
    expect(readFileSync(ghLog, "utf8").trim()).toBe(
      realpathSync(taskDir(store.slug, "VIB-1", store.dataRoot)),
    );
    expect(ran()).toBe("");
  });
});

describe("the shape isolation depends on, with a stand-in launcher (R-seams-1)", () => {
  /** A stand-in for `viberr-launch`: it logs what the real one reads, scrubs
   *  the `VIBERR_LAUNCH_*` names as the real one does, and execs. */
  function standInLauncher(): string {
    const dir = ctx.makeTempDir("viberr-launcher-");
    const log = path.join(dir, "launch.log");
    const launcher = path.join(dir, "viberr-launch");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        'if [ "$1" = "--prepare-home" ]; then mkdir -p "$3"; exit 0; fi',
        `{`,
        `  printf 'uid=%s exec=%s args=%s\\n' "$VIBERR_LAUNCH_UID" "$VIBERR_LAUNCH_EXEC" "$*"`,
        `  env | grep -E '^(VIBERR_SECRET_ENCRYPTION_KEY|VIBERR_SESSION_SECRET|VIBERR_GIT_ASKPASS_PASSWORD|GIT_ASKPASS)=' | sed 's/^/  leaked /'`,
        `  env | grep -E '^GIT_CONFIG_(KEY|VALUE)_[0-9]+=(core.hooksPath|/dev/null|core.fsmonitor|false)$' | sort | tr '\\n' ' ' | sed 's/^/  config /'`,
        `  echo`,
        `} >> '${log}'`,
        'target=$VIBERR_LAUNCH_EXEC',
        "unset VIBERR_LAUNCH_UID VIBERR_LAUNCH_EXEC VIBERR_LAUNCH_HOME",
        'exec "$target" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    resetAgentIsolationForTests(
      { status: "on", uidFloor: AGENT_UID_FLOOR, reason: null },
      { launcher },
    );
    return log;
  }

  interface Launched {
    uid: string;
    exec: string;
    args: string;
    detail: string;
  }

  function launched(log: string): Launched[] {
    const text = existsSync(log) ? readFileSync(log, "utf8") : "";
    const out: Launched[] = [];
    for (const line of text.split("\n")) {
      const head = /^uid=(\S*) exec=(\S*) args=(.*)$/.exec(line);
      if (head) out.push({ uid: head[1]!, exec: head[2]!, args: head[3]!, detail: "" });
      else if (line.trim() && out.length > 0) out[out.length - 1]!.detail += `${line}\n`;
    }
    return out;
  }

  it("the delivery runs every workspace git and the transport's upload-pack as the owner's uid, with no secret, and pushes as the server from its stage", async () => {
    // Canaries: `workspaceSpawn` returning plain git for a launch (every
    // workspace git runs as the server: no launched lines); `workspaceUploadPack`
    // returning no `--upload-pack` (the server reads the checkout itself);
    // `serverGitEnv` spreading `process.env` (the secret is logged as leaked).
    const dir = await checkout();
    taskBranchWithWork(dir);
    writeFileSync(path.join(dir, "left.txt"), "uncommitted work\n");
    const log = standInLauncher();

    const res = await withLocalGithub(origins, () =>
      pushWorkspaceBranch({
        db: store.db,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      }),
    );

    expect(res).toMatchObject({ status: "pushed", branch: "vib-1-work" });
    expect(bare(origin.bare, ["rev-parse", "refs/heads/vib-1-work"])).toBe(
      g(dir, ["rev-parse", "HEAD"]),
    );
    const lines = launched(log);
    // The task owner is the first person given an agent uid.
    expect(new Set(lines.map((l) => l.uid))).toEqual(new Set([String(AGENT_UID_FLOOR)]));
    const gitLines = lines.filter((l) => path.basename(l.exec) === "git");
    for (const op of ["rev-parse", "status", "add", "commit", "ls-tree", "rev-list"]) {
      expect(gitLines.some((l) => l.args.startsWith(`-C ${dir} `) && l.args.includes(` ${op}`))).toBe(true);
    }
    // Every launched git carries the hook and fsmonitor overrides.
    for (const line of gitLines) {
      expect(line.detail).toContain("GIT_CONFIG_VALUE_");
      expect(line.detail).toMatch(/core\.hooksPath/);
      expect(line.detail).toMatch(/core\.fsmonitor/);
    }
    // The server read the branch OUT of the checkout through the transport,
    // with `git-upload-pack` launched as the person on the checkout's path.
    const uploads = lines.filter((l) => path.basename(l.exec) === "git-upload-pack");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.args).toBe(dir);
    // Nothing launched ever saw the server's secret or the PAT.
    expect(lines.every((l) => !l.detail.includes("leaked"))).toBe(true);
    // The push and the remote read are the server's, never launched.
    expect(lines.some((l) => /\b(push|ls-remote)\b/.test(l.args))).toBe(false);
  });

  it("the refresh runs the checkout's git as the owner's uid; with no task to name a person it refuses rather than run as the server", async () => {
    // Canary: make `workspaceSpawn` return plain git for a launch and no
    // launched line is found.
    const dir = await checkout();
    await origin.advance({ message: "second" });
    const log = standInLauncher();
    const input = {
      projectSlug: store.slug,
      repo: REPO,
      dir,
      defaultBranch: "main",
      dataRoot: store.dataRoot,
      fastForward: true,
    };
    const result = await withLocalGithub(origins, () =>
      refreshWorkspaceFromMirror(store.db, { ...input, taskKey: "VIB-1" }),
    );
    expect(result).toMatchObject({ status: "fast_forwarded", from: "behind" });
    const lines = launched(log);
    expect(lines.some((l) => l.args.includes(" status "))).toBe(true);
    expect(lines.some((l) => l.args.includes(" merge --ff-only "))).toBe(true);
    expect(lines.every((l) => l.uid === String(AGENT_UID_FLOOR))).toBe(true);

    const before = launched(log).length;
    const refused = await withLocalGithub(origins, () => refreshWorkspaceFromMirror(store.db, input));
    expect(refused.status).toBe("fetch_failed");
    if (refused.status !== "fetch_failed") throw new Error("unreachable");
    expect(refused.message).toContain("never falls back to the server's own user");
    expect(launched(log)).toHaveLength(before);
  });
});

describe("the environment of the server's git (R-seams-1)", () => {
  it("carries no server secret and switches hooks and fsmonitor off, without touching process.env or an agent's base", () => {
    // Canary: build `serverGitEnv` on `process.env` and the secret survives.
    const secret = process.env.VIBERR_SECRET_ENCRYPTION_KEY;
    expect(secret).toBeTruthy();
    const env = serverGitEnv();
    expect(env.VIBERR_SECRET_ENCRYPTION_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain(secret);
    const count = Number(env.GIT_CONFIG_COUNT);
    const config = Object.fromEntries(
      Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]),
    );
    expect(config).toMatchObject({ "core.hooksPath": "/dev/null", "core.fsmonitor": "false" });
    // Only the server's git gets them: an agent's own base keeps its hooks.
    expect(process.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(Object.keys(filteredSpawnEnv()).filter((k) => k.startsWith("GIT_CONFIG_"))).toEqual([]);

    // The credentialed git keeps the helper reset first and adds the same two.
    const askpass = createGitHubAskpassEnv({ token: TOKEN });
    try {
      expect(askpass.env.VIBERR_SECRET_ENCRYPTION_KEY).toBeUndefined();
      expect(askpass.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
      expect(askpass.env.GIT_CONFIG_VALUE_0).toBe("");
      expect(askpass.env.GIT_CONFIG_COUNT).toBe("3");
      expect([askpass.env.GIT_CONFIG_KEY_1, askpass.env.GIT_CONFIG_KEY_2]).toEqual([
        "core.hooksPath",
        "core.fsmonitor",
      ]);
    } finally {
      askpass.dispose();
    }
  });
});
