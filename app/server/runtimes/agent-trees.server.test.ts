import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { AppError } from "~/server/errors/app-error.server";
import {
  AGENT_UID_FLOOR,
  resetAgentIsolationForTests,
  type AgentLaunch,
} from "./agent-isolation.server";
import {
  AgentTreeRemovalError,
  removalFailure,
  removeAgentTree,
  removeAgentTreeSync,
} from "./agent-trees.server";

/**
 * Ruling 485 (F40-62, live on WEB-5): a tree an agent can write is removed as
 * its person, through the launcher, never by the server's own recursive
 * remove. Wrangler left 0700 `mkdtemp` directories in a supporting checkout;
 * the server's `rmSync` deleted what the group could (`.git` first), threw
 * EACCES on the rest, and every later review ran with no checkout.
 *
 * The suite runs as one uid, so a directory with no write bit stands in for
 * another uid's 0700 directory: the server's own recursive remove cannot empty
 * either, and its owner can once it has made it removable (`chmod -R u+rwX`).
 * The launcher is a stand-in that logs what the real one reads and then
 * execs, like `workspace-git.server.test.ts`'s. The kernel's half (two real
 * agent uids, the multi-owner fallback) is `scripts/check-agent-isolation.sh`.
 */

const ctx = createTestDbContext();
/** Directories a test made unwritable, handed back before cleanup. */
const locked: string[] = [];

afterEach(() => {
  for (const dir of locked.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Already removed: nothing to hand back.
    }
  }
  resetAgentIsolationForTests();
  ctx.cleanup();
});

/** A checkout with what wrangler leaves behind: a directory with a file in
 *  it that the server's own recursive remove cannot empty. */
function checkoutWithToolDir() {
  const dir = path.join(ctx.makeTempDir("viberr-tree-"), "website");
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(dir, "index.html"), "<h1>hi</h1>\n");
  const toolDir = path.join(dir, ".wrangler", "tmp", "dev-1wnDsF");
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(path.join(toolDir, "bundle.js"), "export {};\n");
  chmodSync(toolDir, 0o500);
  locked.push(toolDir);
  return { dir, toolDir };
}

interface Launched {
  uid: string;
  exec: string;
  args: string;
}

/** A stand-in `viberr-launch` (isolation `on`): logs the uid, the binary and
 *  the argv, scrubs the `VIBERR_LAUNCH_*` names and execs. */
function standInLauncher() {
  const dir = ctx.makeTempDir("viberr-launcher-");
  const log = path.join(dir, "launch.log");
  const launcher = path.join(dir, "viberr-launch");
  writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      `printf 'uid=%s exec=%s args=%s\\n' "$VIBERR_LAUNCH_UID" "$VIBERR_LAUNCH_EXEC" "$*" >> '${log}'`,
      'target=$VIBERR_LAUNCH_EXEC',
      "unset VIBERR_LAUNCH_UID VIBERR_LAUNCH_EXEC VIBERR_LAUNCH_HOME",
      'exec "$target" "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(launcher, 0o755);
  resetAgentIsolationForTests({ status: "on", uidFloor: AGENT_UID_FLOOR, reason: null }, { launcher });
  return {
    launch: { uid: AGENT_UID_FLOOR, launcher, launchHome: path.join(dir, "vendor-home") } satisfies AgentLaunch,
    launched: () =>
      (existsSync(log) ? readFileSync(log, "utf8") : "")
        .split("\n")
        .map((line) => /^uid=(\S*) exec=(\S*) args=(.*)$/.exec(line))
        .filter((match) => match !== null)
        .map((match): Launched => ({ uid: match[1] ?? "", exec: match[2] ?? "", args: match[3] ?? "" })),
  };
}

describe("a tree an agent writes is removed as its person (ruling 485)", () => {
  it("removes a checkout holding a directory the server cannot empty, through the launch as the person's uid", async () => {
    // CANARY: make `removeAgentTree` the server's `rmSync(target, {recursive,
    // force})` again and it throws EACCES on the tool's directory, half-way.
    const { dir, toolDir } = checkoutWithToolDir();
    // What the server's own recursive remove does to it (F40-62): it throws
    // (EACCES on Linux, ENOTEMPTY on macOS) and the file is still there.
    expect(() => rmSync(toolDir, { recursive: true, force: true })).toThrow(/EACCES|ENOTEMPTY/);
    expect(existsSync(path.join(toolDir, "bundle.js"))).toBe(true);
    const { launch, launched } = standInLauncher();

    await removeAgentTree(dir, launch);

    expect(existsSync(dir)).toBe(false);
    const lines = launched();
    expect(lines.map((l) => [l.uid, path.basename(l.exec), l.args])).toEqual([
      [String(AGENT_UID_FLOOR), "chmod", `-R u+rwX -- ${dir}`],
      [String(AGENT_UID_FLOOR), "rm", `-rf -- ${dir}`],
    ]);
    // Absolute binaries: the launcher execs nothing else.
    expect(lines.every((l) => path.isAbsolute(l.exec))).toBe(true);
  });

  it("the synchronous form does the same, for a settle and boot's reclaim", () => {
    const { dir } = checkoutWithToolDir();
    const { launch, launched } = standInLauncher();
    removeAgentTreeSync(dir, launch);
    expect(existsSync(dir)).toBe(false);
    expect(launched().map((l) => path.basename(l.exec))).toEqual(["chmod", "rm"]);
  });

  it("with isolation on and no person named, refuses and removes nothing", async () => {
    // CANARY: let a null person fall through to the server's own user and the
    // tree is gone with nothing launched.
    const { dir } = checkoutWithToolDir();
    const { launched } = standInLauncher();
    await expect(removeAgentTree(dir, null)).rejects.toBeInstanceOf(AppError);
    await expect(removeAgentTree(dir, null)).rejects.toThrow(/no person is named to remove it as/);
    expect(() => removeAgentTreeSync(dir, null)).toThrow(/never removed as the server's own user/);
    expect(existsSync(path.join(dir, "index.html"))).toBe(true);
    expect(existsSync(path.join(dir, ".git", "HEAD"))).toBe(true);
    expect(launched()).toEqual([]);
  });

  it("with isolation off, the server removes it itself, a directory a tool left unwritable included", async () => {
    // CANARY: the isolation-off path as `rmSync` (no chmod) and it throws
    // EACCES with the tree half there.
    const { dir } = checkoutWithToolDir();
    await removeAgentTree(dir, null);
    expect(existsSync(dir)).toBe(false);
  });

  it("a tree that cannot be removed is a fault naming the path it stopped at and the OS error", async () => {
    // Its parent is not writable: the tree empties, and the directory itself
    // cannot be unlinked.
    const parent = ctx.makeTempDir("viberr-tree-parent-");
    const dir = path.join(parent, "website");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "index.html"), "x");
    chmodSync(parent, 0o500);
    locked.push(parent);
    const failure = await removeAgentTree(dir, null).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(AgentTreeRemovalError);
    expect(failure?.message).toBe(`${dir} could not be removed: EACCES on ${dir}`);
    expect(existsSync(dir)).toBe(true);
  });

  it("an absent tree is nothing to do, whoever is named", async () => {
    const { launched } = standInLauncher();
    await removeAgentTree(path.join(ctx.makeTempDir(), "never-cloned"), null);
    expect(launched()).toEqual([]);
  });

  it("refuses a relative path or a root outright", async () => {
    await expect(removeAgentTree("workspace/website", null)).rejects.toThrow(/not an absolute path/);
    await expect(removeAgentTree("/", null)).rejects.toThrow(/not an absolute path/);
  });
});

describe("rm's refusal, read (ruling 485)", () => {
  it("names the errno and the path from GNU and BSD rm alike", () => {
    expect(removalFailure("rm: cannot remove '/data/w/.wrangler/tmp/dev-1': Permission denied\n")).toBe(
      "EACCES on /data/w/.wrangler/tmp/dev-1",
    );
    expect(removalFailure("rm: /tmp/w: Operation not permitted\nrm: /tmp: Directory not empty\n")).toBe(
      "EPERM on /tmp/w",
    );
    expect(removalFailure("rm: cannot remove '/x': Some new error\n")).toBe("Some new error on /x");
    expect(removalFailure("chmod: nothing\n")).toBeNull();
  });
});
