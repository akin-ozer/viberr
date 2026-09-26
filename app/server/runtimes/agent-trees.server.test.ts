import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { AppError } from "~/server/errors/app-error.server";
import { logger } from "~/server/logging/logger.server";
import {
  AGENT_UID_FLOOR,
  resetAgentIsolationForTests,
  type AgentLaunch,
} from "./agent-isolation.server";
import {
  AgentTreeRemovalError,
  removalFailure,
  removalPlan,
  removeAgentTree,
  removeAgentTreeSync,
  type RemovalStep,
  type StepOutcome,
  type TreeView,
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
  vi.restoreAllMocks();
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

  it("ruling 495: reads the server's rmdir of an emptied root the same way, GNU and BSD", () => {
    expect(removalFailure("rmdir: failed to remove '/data/t/WEB-1/workspace': Directory not empty\n")).toBe(
      "ENOTEMPTY on /data/t/WEB-1/workspace",
    );
    expect(removalFailure("rmdir: /tmp/t/workspace: Permission denied\n")).toBe("EACCES on /tmp/t/workspace");
  });
});

/**
 * Ruling 495 (F40-71, live on deploy 10): what the SERVER wrote in a tree an
 * agent can write, no agent pass could remove. The skill mount's copies sat in
 * folders the store gave 0755, so the person could not unlink their files, and
 * a finished task's workspace root is `node`'s, in a task directory only
 * `node` writes, so no agent uid may unlink it even empty. Every boot logged
 * the same 15 workspaces it could not reclaim.
 *
 * The plan's decisions are pinned against a stand-in view of the tree, which
 * each step's answer changes; the drivers below run the real binaries.
 */
describe("the server opens its own residue and removes an emptied root it owns (ruling 495)", () => {
  const WORKSPACE = "/data/projects/site/tasks/WEB-1/workspace";
  const RESIDUE = `${WORKSPACE}/.viberr-plugins/run_Jd1RlrxTUlUN/skills/sourced-content/SKILL.md`;
  const PERSON: AgentLaunch = { uid: AGENT_UID_FLOOR, launcher: "/usr/local/libexec/viberr-launch" };
  const OTHER_UID = AGENT_UID_FLOOR + 1;

  /** The tree as the plan reads it between its steps. */
  interface FakeTree {
    present: boolean;
    left: ReturnType<TreeView["left"]>;
    owners: number[];
    linkAbove: string | null;
    /** The server's chmod has run. */
    opened: boolean;
  }

  const tree = (over: Partial<FakeTree> = {}): FakeTree => ({
    present: true,
    left: "entries",
    owners: [],
    linkAbove: null,
    opened: false,
    ...over,
  });

  const ok: StepOutcome = { ok: true, stderr: "" };
  /** What GNU rm says when it cannot unlink `where`. */
  const refusedOn = (where: string): StepOutcome => ({
    ok: false,
    stderr: `rm: cannot remove '${where}': Permission denied\n`,
  });

  /** Run the plan against `state`, answering each step with `act` (which may
   *  change the tree); every step reads `<uid or server> <command> <args>`. */
  function drive(
    state: FakeTree,
    person: AgentLaunch | null,
    act: (step: RemovalStep, state: FakeTree) => StepOutcome,
    target = WORKSPACE,
  ) {
    const view: TreeView = {
      present: () => state.present,
      agentOwners: () => (state.present ? state.owners : []),
      left: () => (state.present ? state.left : "other"),
      agentLinkAbove: () => state.linkAbove,
    };
    const plan = removalPlan(target, person, view);
    const steps: string[] = [];
    let next = plan.next();
    while (!next.done) {
      const step = next.value;
      steps.push(`${step.launch ? step.launch.uid : "server"} ${step.command} ${step.args.join(" ")}`);
      if (!step.launch && step.command === "chmod" && step.args.includes("-P")) state.opened = true;
      next = plan.next(act(step, state));
    }
    return { steps, left: next.value };
  }

  const pass = (uid: number | "server", mode = "u+rwX", target = WORKSPACE) => [
    `${uid} chmod -R ${mode} -- ${target}`,
    `${uid} rm -rf -- ${target}`,
  ];
  const SERVER_CHMOD = `server chmod -R -P g+rwX -- ${WORKSPACE}`;
  const SERVER_RMDIR = `server rmdir -- ${WORKSPACE}`;

  it("a tree the person's pass removes takes neither of the server's steps", () => {
    const { steps, left } = drive(tree(), PERSON, (step, state) => {
      if (step.command === "rm") state.present = false;
      return ok;
    });
    expect(steps).toEqual(pass(AGENT_UID_FLOOR));
    expect(left).toBeNull();
  });

  it("residue the agent passes leave is opened by the server's chmod -R -P g+rwX, then removed by the person's pass", () => {
    // CANARY: drop the server's chmod from the plan and the residue stays, a
    // fault naming the skill file the person could not unlink.
    const { steps, left } = drive(tree(), PERSON, (step, state) => {
      if (step.command !== "rm") return ok;
      if (!state.opened) return refusedOn(RESIDUE);
      state.present = false;
      return ok;
    });
    expect(steps).toEqual([...pass(AGENT_UID_FLOOR), SERVER_CHMOD, ...pass(AGENT_UID_FLOOR)]);
    expect(left).toBeNull();
  });

  it("an emptied root the server owns goes with the server's rmdir, and nothing is opened first", () => {
    // CANARY: drop the server's rmdir from the plan and WEB-1's empty
    // workspace stays, "EACCES on …/WEB-1/workspace", on every boot.
    const { steps, left } = drive(tree(), PERSON, (step, state) => {
      if (step.command === "rm") {
        state.left = "empty-server";
        return refusedOn(WORKSPACE);
      }
      if (step.command === "rmdir") state.present = false;
      return ok;
    });
    expect(steps).toEqual([...pass(AGENT_UID_FLOOR), SERVER_RMDIR]);
    expect(left).toBeNull();
  });

  it("WEB-2's workspace: the plugin residue is opened, the person empties the tree, and the server's rmdir takes the root", () => {
    const { steps, left } = drive(tree(), PERSON, (step, state) => {
      if (step.command === "rm") {
        if (!state.opened) return refusedOn(RESIDUE);
        state.left = "empty-server";
        return refusedOn(WORKSPACE);
      }
      if (step.command === "rmdir") state.present = false;
      return ok;
    });
    expect(steps).toEqual([...pass(AGENT_UID_FLOOR), SERVER_CHMOD, ...pass(AGENT_UID_FLOOR), SERVER_RMDIR]);
    expect(left).toBeNull();
  });

  it("a target that still holds entries after the server opened it gets no rmdir, and stays a fault naming the path and the errno", () => {
    // CANARY: rmdir whatever is left (not only an empty directory the server
    // owns) and the plan asks the server to remove a tree with entries in it.
    const { steps, left } = drive(tree(), PERSON, (step) =>
      step.command === "rm" ? refusedOn(`${WORKSPACE}/website/.wrangler/tmp/dev-1wnDsF`) : ok,
    );
    expect(steps).toEqual([...pass(AGENT_UID_FLOOR), SERVER_CHMOD, ...pass(AGENT_UID_FLOOR)]);
    expect(removalFailure(left ?? "")).toBe(`EACCES on ${WORKSPACE}/website/.wrangler/tmp/dev-1wnDsF`);
  });

  it("an emptied root an agent uid owns gets no rmdir: it is left to the agent passes", () => {
    const { steps, left } = drive(tree(), PERSON, (step, state) => {
      if (step.command !== "rm") return ok;
      state.left = "other";
      return refusedOn(WORKSPACE);
    });
    expect(steps).toEqual(pass(AGENT_UID_FLOOR));
    expect(removalFailure(left ?? "")).toBe(`EACCES on ${WORKSPACE}`);
  });

  it("the owner rounds run before the server's step and again after it", () => {
    // A layer another person's agent wrote under a folder of the server's is
    // reachable only once the server has opened that folder.
    let otherRuns = 0;
    const { steps, left } = drive(tree({ owners: [OTHER_UID] }), PERSON, (step, state) => {
      if (step.command !== "rm") return ok;
      if (step.launch?.uid === OTHER_UID) {
        otherRuns += 1;
        state.owners = [];
        if (otherRuns === 1) return refusedOn(RESIDUE);
        state.present = false;
        return ok;
      }
      if (state.opened) state.owners = [OTHER_UID];
      return refusedOn(RESIDUE);
    });
    expect(steps).toEqual([
      ...pass(AGENT_UID_FLOOR),
      ...pass(OTHER_UID, "u+rwX,g+rwX"),
      SERVER_CHMOD,
      ...pass(AGENT_UID_FLOOR),
      ...pass(OTHER_UID, "u+rwX,g+rwX"),
    ]);
    expect(left).toBeNull();
  });

  it("with isolation off the plan is the one user's, as before: no server step of ruling 495", () => {
    // CANARY: run the server's steps without a person too and the harness's
    // one user gets a chmod -P and an rmdir it never asked for.
    const { steps, left } = drive(tree(), null, (step, state) => {
      if (step.command === "rm") state.left = "empty-server";
      return step.command === "rm" ? refusedOn(WORKSPACE) : ok;
    });
    expect(steps).toEqual(pass("server"));
    expect(removalFailure(left ?? "")).toBe(`EACCES on ${WORKSPACE}`);
  });

  it("the server opens and removes nothing through a directory an agent uid swapped for a link", () => {
    // CANARY: drop the link check and the server's chmod follows the agent's
    // link to wherever it points, `/data` itself for a repository named `data`.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const link = `${WORKSPACE}/support/site-reviewer`;
    const target = `${link}/data`;
    for (const left of ["entries", "empty-server"] as const) {
      const { steps } = drive(
        tree({ left, linkAbove: link }),
        PERSON,
        (step) => (step.command === "rm" ? refusedOn(target) : ok),
        target,
      );
      expect(steps).toEqual(pass(AGENT_UID_FLOOR, "u+rwX", target));
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("link an agent could have put there"), {
      target,
      link,
    });
  });
});

/**
 * The same, through the drivers and the real binaries. The suite has one uid,
 * so the stand-in person below is held to what the agents' group may do: the
 * directories without group write (the task directory, a skill folder the
 * mount copied at the store's 0755) are closed to its `rm` while it runs, and
 * its `chmod` changes nothing, since the person owns nothing here. The
 * server's own steps run as the suite's user, as they would as `node`.
 */
describe("F40-71's trees, removed through the drivers (ruling 495)", () => {
  function groupBoundLauncher() {
    const dir = ctx.makeTempDir("viberr-launcher-");
    const log = path.join(dir, "launch.log");
    const launcher = path.join(dir, "viberr-launch");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        `printf 'uid=%s exec=%s args=%s\\n' "$VIBERR_LAUNCH_UID" "$(basename "$VIBERR_LAUNCH_EXEC")" "$*" >> '${log}'`,
        'target=$VIBERR_LAUNCH_EXEC',
        "unset VIBERR_LAUNCH_UID VIBERR_LAUNCH_EXEC VIBERR_LAUNCH_HOME",
        'case "$(basename "$target")" in',
        "  chmod) exit 0 ;;",
        "  rm)",
        '    for tree; do :; done',
        // Only what the owner could write and the group could not: those are
        // closed for this rm and reopened after it, and nothing else.
        '    closed=$( { find "$(dirname "$tree")" -maxdepth 0 -type d -perm -u+w ! -perm -g+w; find "$tree" -type d -perm -u+w ! -perm -g+w; } 2>/dev/null )',
        '    for d in $closed; do chmod u-w "$d"; done',
        '    "$target" "$@"',
        "    status=$?",
        '    for d in $closed; do [ -d "$d" ] && chmod u+w "$d"; done',
        "    exit $status ;;",
        "esac",
        'exec "$target" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    resetAgentIsolationForTests({ status: "on", uidFloor: AGENT_UID_FLOOR, reason: null }, { launcher });
    return {
      launch: { uid: AGENT_UID_FLOOR, launcher } satisfies AgentLaunch,
      launched: () =>
        (existsSync(log) ? readFileSync(log, "utf8") : "")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.replace(/ args=.*$/, "")),
    };
  }

  /** A task directory only the server writes (0755), holding a workspace
   *  the agents' group writes (0770), as `enforceStoreLayout` leaves them. */
  function taskWorkspace() {
    const task = path.join(ctx.makeTempDir("viberr-495-"), "WEB-2");
    const workspace = path.join(task, "workspace");
    mkdirSync(path.join(workspace, "website", "src"), { recursive: true });
    writeFileSync(path.join(workspace, "website", "src", "index.html"), "<h1>hi</h1>\n");
    for (const dir of [path.join(workspace, "website"), path.join(workspace, "website", "src")]) chmodSync(dir, 0o775);
    chmodSync(workspace, 0o770);
    chmodSync(task, 0o755);
    return { task, workspace };
  }

  it("a finished task's workspace holding a settled run's plugin, as the mount copied it before this ruling, is removed", () => {
    // CANARY: drop the server's chmod from the plan and this ends "EACCES on
    // …/skills/sourced-content/SKILL.md"; drop its rmdir and it ends "EACCES
    // on …/WEB-2/workspace".
    const { workspace } = taskWorkspace();
    const skill = path.join(workspace, ".viberr-plugins", "run_Jd1RlrxTUlUN", "skills", "sourced-content");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "# Sourced content\n");
    for (let dir = path.dirname(skill); dir !== workspace; dir = path.dirname(dir)) chmodSync(dir, 0o775);
    chmodSync(skill, 0o755);
    chmodSync(path.join(skill, "SKILL.md"), 0o644);
    const { launch, launched } = groupBoundLauncher();

    removeAgentTreeSync(workspace, launch);

    expect(existsSync(workspace)).toBe(false);
    // The person's pass, then (after the server's chmod) the person's pass
    // again; the server's own chmod and rmdir are not launched.
    expect(launched()).toEqual([
      `uid=${AGENT_UID_FLOOR} exec=chmod`,
      `uid=${AGENT_UID_FLOOR} exec=rm`,
      `uid=${AGENT_UID_FLOOR} exec=chmod`,
      `uid=${AGENT_UID_FLOOR} exec=rm`,
    ]);
  });

  it("an emptied workspace root the server owns goes with its rmdir, the person's pass having emptied it", async () => {
    // CANARY: drop the server's rmdir and it fails "EACCES on …/workspace",
    // WEB-1's line on every boot.
    const { task, workspace } = taskWorkspace();
    const { launch, launched } = groupBoundLauncher();

    await removeAgentTree(workspace, launch);

    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(task)).toBe(true);
    expect(launched()).toEqual([`uid=${AGENT_UID_FLOOR} exec=chmod`, `uid=${AGENT_UID_FLOOR} exec=rm`]);
  });

  it("a root that still holds what no one may remove stays a fault naming the path and the errno", async () => {
    // Held open under the person's rm: a folder the server's chmod cannot
    // open either, because the suite locks it again for every pass.
    const { workspace } = taskWorkspace();
    const stuck = path.join(workspace, "website", "stuck");
    mkdirSync(stuck);
    writeFileSync(path.join(stuck, "f"), "x");
    chmodSync(stuck, 0o555);
    locked.push(stuck);
    const { launch } = groupBoundLauncher();

    const failure = await removeAgentTree(workspace, launch).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(AgentTreeRemovalError);
    expect(failure?.message).toBe(`${workspace} could not be removed: EACCES on ${path.join(stuck, "f")}`);
    expect(existsSync(path.join(stuck, "f"))).toBe(true);
  });

  /** A folder of the server's the agents' group may enter and not write
   *  (0750), holding `data/kept/f`, and `holder`, the folder a link to it
   *  sits in. The link is the suite's own, as a symlink a repository commits
   *  is the server's once its clone checks it out. */
  function linkedServerFolder(holderMode: number) {
    const root = ctx.makeTempDir("viberr-495-link-");
    const outside = path.join(root, "server-owned");
    const kept = path.join(outside, "data", "kept");
    mkdirSync(kept, { recursive: true });
    writeFileSync(path.join(kept, "f"), "x");
    for (const dir of [outside, path.dirname(kept), kept]) chmodSync(dir, 0o750);
    const holder = path.join(root, "holder");
    mkdirSync(holder);
    chmodSync(holder, holderMode);
    const link = path.join(holder, "site-reviewer");
    symlinkSync(outside, link);
    return { outside, link, target: path.join(link, "data") };
  }

  it("opens and removes nothing through a link the server made that an agent moved into a folder it writes", async () => {
    // Review of ruling 495: an agent can move any link out of a checkout the
    // server cloned (its folders are the group's) to `<workspace>/support`,
    // `.viberr-plugins` or `.gates`, and the check read only links an agent
    // uid owns. CANARY: flag only those again and the server's chmod opens
    // `server-owned/data` through the link, and the person's pass removes it.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { outside, link, target } = linkedServerFolder(0o770);
    const { launch } = groupBoundLauncher();

    const failure = await removeAgentTree(target, launch).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(AgentTreeRemovalError);
    expect(existsSync(path.join(outside, "data", "kept", "f"))).toBe(true);
    expect(lstatSync(path.join(outside, "data")).mode & 0o7777).toBe(0o750);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("link an agent could have put there"), { target, link });
  });

  it("still acts through a link in a folder only the server writes (a system path such as macOS's /var)", async () => {
    // The check is not "any link above": the store may sit below a link no
    // agent could have made, and every tree there must still be removable.
    const { outside, target } = linkedServerFolder(0o755);
    const { launch } = groupBoundLauncher();

    await removeAgentTree(target, launch);

    expect(existsSync(path.join(outside, "data"))).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });
});
