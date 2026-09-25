import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUser } from "~/server/auth/user-store.server";
import { healthSnapshot } from "~/server/ops/health-snapshot.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  AGENT_GID,
  AGENT_UID_FLOOR,
  AGENT_UID_MAX,
  agentIsolation,
  agentLaunchFor,
  agentUidFor,
  enforceStoreLayout,
  measureAgentIsolation,
  resetAgentIsolationForTests,
  shareTreeBuiltForAgents,
} from "./agent-isolation.server";

/**
 * Ruling 460: every agent process runs as the OS user of the person it bills.
 * What the kernel enforces is checked inside the image
 * (`scripts/check-agent-isolation.sh`, run by the e2e job); these pin what the
 * server decides: the uid each person gets, the layout it asserts at boot, and
 * what `/resources/health` says about it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let ctx: TestDbContext;

beforeEach(() => {
  ctx = createTestDbContext();
});

afterEach(() => {
  resetAgentIsolationForTests();
  ctx.cleanup();
});

/** A stand-in launcher: records its argv, answers `--probe` with `probeExit`. */
function fakeLauncher(probeExit: number) {
  const dir = ctx.makeTempDir("viberr-launcher-");
  const log = path.join(dir, "calls.log");
  const file = path.join(dir, "viberr-launch");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      `if [ "$1" = "--probe" ]; then exit ${probeExit}; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return {
    path: file,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

function mode(file: string): number {
  return statSync(file).mode & 0o7777;
}

describe("agentUidFor: one stable, unique, never-reused uid per person (ruling 460)", () => {
  it("allocates from the floor, keeps a person's uid, and never hands a removed person's uid on", () => {
    const db = ctx.makeDb();
    for (const id of ["u_ada", "u_bo", "u_cy"]) {
      insertUser(db, { id, email: `${id}@viberr.dev`, name: id, role: "member" });
    }
    const ada = agentUidFor(db, "u_ada");
    const bo = agentUidFor(db, "u_bo");
    expect(ada).toBe(AGENT_UID_FLOOR);
    expect(bo).toBe(AGENT_UID_FLOOR + 1);
    // Stable: asking again is the same answer, not a new allocation.
    expect(agentUidFor(db, "u_ada")).toBe(ada);
    expect(agentUidFor(db, "u_bo")).toBe(bo);
    // Removing the account does not free its uid: the transcripts it left on
    // disk are still owned by it. The next person gets a fresh one.
    db.prepare(`DELETE FROM users WHERE id = ?`).run("u_bo");
    expect(agentUidFor(db, "u_cy")).toBe(AGENT_UID_FLOOR + 2);
    const uids = db.prepare(`SELECT os_uid FROM agent_os_users ORDER BY os_uid`).all();
    expect(uids).toEqual([
      { os_uid: AGENT_UID_FLOOR },
      { os_uid: AGENT_UID_FLOOR + 1 },
      { os_uid: AGENT_UID_FLOOR + 2 },
    ]);
  });

  it("refuses a uid past the range instead of running someone as it", () => {
    const db = ctx.makeDb();
    db.prepare(`INSERT INTO agent_os_users (user_id, os_uid, created_at) VALUES (?, ?, ?)`).run(
      "u_last",
      AGENT_UID_MAX,
      "2026-09-24T00:00:00Z",
    );
    expect(() => agentUidFor(db, "u_next")).toThrow(/no agent user left/);
  });
});

describe("the launcher's compiled numbers are the server's (ruling 460)", () => {
  it("the Dockerfile's ARG defaults equal the constants the server allocates and chgrps with", () => {
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    const arg = (name: string) => Number(new RegExp(`^ARG ${name}=(\\d+)$`, "m").exec(dockerfile)?.[1]);
    expect(arg("VIBERR_AGENT_UID_FLOOR")).toBe(AGENT_UID_FLOOR);
    expect(arg("VIBERR_AGENT_UID_MAX")).toBe(AGENT_UID_MAX);
    expect(arg("VIBERR_AGENT_GID")).toBe(AGENT_GID);
  });
});

describe("enforceStoreLayout: the store layout asserted at boot (ruling 460)", () => {
  const gid = process.getgid?.() ?? 0;

  function preRulingStore(): string {
    const root = ctx.makeTempDir("viberr-layout-");
    for (const dir of ["state", "audit-exports", "agents", "kb", "skills", "runtimes/users/u_ada"]) {
      mkdirSync(path.join(root, dir), { recursive: true, mode: 0o755 });
    }
    const checkout = path.join(root, "projects/demo/tasks/DEMO-1/workspace/repo");
    mkdirSync(checkout, { recursive: true, mode: 0o755 });
    writeFileSync(path.join(checkout, "README.md"), "hi\n", { mode: 0o644 });
    writeFileSync(path.join(root, "projects/demo/tasks/DEMO-1/task.md"), "---\n---\n", {
      mode: 0o644,
    });
    writeFileSync(path.join(root, "state/projection.sqlite"), "", { mode: 0o644 });
    return root;
  }

  it("closes what holds secrets, opens what runs write, and hands a pre-460 checkout over once", () => {
    const root = preRulingStore();
    const homes: string[] = [];
    const report = enforceStoreLayout(root, {
      gid,
      prepareHome: (userId) => homes.push(userId),
    });
    expect(report.failures).toEqual([]);
    // Traversable by the agent group, nobody else.
    expect(mode(root)).toBe(0o750);
    // The database, the writer lock, the audit exports and the raw run logs.
    expect(mode(path.join(root, "state"))).toBe(0o700);
    expect(mode(path.join(root, "audit-exports"))).toBe(0o700);
    expect(mode(path.join(root, "runtimes/claude"))).toBe(0o700);
    expect(mode(path.join(root, "runtimes/codex"))).toBe(0o700);
    // An agent reaches its own home and lists nobody's.
    expect(mode(path.join(root, "runtimes"))).toBe(0o750);
    expect(mode(path.join(root, "runtimes/users"))).toBe(0o710);
    // Readable, never writable, by an agent.
    for (const dir of ["agents", "kb", "skills", "projects"]) {
      expect(mode(path.join(root, dir)), dir).toBe(0o755);
    }
    // What runs write: the agent group's, setgid.
    for (const dir of ["controller-scratch", "uv-cache", "uv-python"]) {
      expect(mode(path.join(root, "runtimes", dir)), dir).toBe(0o2770);
      expect(statSync(path.join(root, "runtimes", dir)).gid).toBe(gid);
    }
    const workspace = path.join(root, "projects/demo/tasks/DEMO-1/workspace");
    expect(mode(workspace)).toBe(0o2770);
    // The checkout inside, cloned before the ruling: group-writable now, so an
    // agent (another uid, same group) can edit what the server cloned.
    expect(mode(path.join(workspace, "repo")) & 0o2070).toBe(0o2070);
    expect(mode(path.join(workspace, "repo/README.md")) & 0o060).toBe(0o060);
    // The canonical file beside it is untouched.
    expect(mode(path.join(root, "projects/demo/tasks/DEMO-1/task.md"))).toBe(0o644);
    expect(report.sharedTrees).toBeGreaterThanOrEqual(4);
    // Every person's runtime root goes to the launcher.
    expect(homes).toEqual(["u_ada"]);
  });

  it("leaves a shared tree alone once it is shared: the recursive handover is a one-time cost", () => {
    const root = preRulingStore();
    enforceStoreLayout(root, { gid });
    expect(enforceStoreLayout(root, { gid }).sharedTrees).toBe(0);
  });

  /**
   * Pass 40 review (R-seams-1): a checkout cloned from the project mirror
   * shares its object files with the mirror (hardlinks). The hand-over used to
   * add group write to them, which reached the MIRROR's inode, so any agent
   * could rewrite an object every later checkout is cut from. A linked file is
   * never widened now, and boot takes group and other write back off every
   * mirror file.
   */
  it("never widens a file linked from the mirror, and takes back a write an earlier hand-over gave", () => {
    // Canaries: drop the `nlink > 1` skip in `shareTreeWithAgents` (the
    // linked object gains group write) or make `revokeMirrorWrites` a no-op
    // (the widened mirror file keeps it).
    const root = preRulingStore();
    const mirrorObject = path.join(root, "projects/demo/.repo-mirror/acme__app.git/objects/ab/cdef");
    mkdirSync(path.dirname(mirrorObject), { recursive: true });
    writeFileSync(mirrorObject, "object\n", { mode: 0o444 });
    chmodSync(mirrorObject, 0o444);
    const linked = path.join(root, "projects/demo/tasks/DEMO-1/workspace/repo/.git/objects/ab/cdef");
    mkdirSync(path.dirname(linked), { recursive: true });
    linkSync(mirrorObject, linked);
    // A mirror file an earlier hand-over widened (0444 | 060).
    const widened = path.join(root, "projects/demo/.repo-mirror/acme__app.git/objects/ab/widened");
    writeFileSync(widened, "object\n");
    chmodSync(widened, 0o464);

    const report = enforceStoreLayout(root, { gid });

    expect(report.failures).toEqual([]);
    // The checkout's own file is handed over; the linked object is not.
    expect(mode(path.join(root, "projects/demo/tasks/DEMO-1/workspace/repo/README.md")) & 0o060).toBe(0o060);
    expect(mode(linked)).toBe(0o444);
    expect(mode(mirrorObject)).toBe(0o444);
    expect(mode(widened)).toBe(0o444);
    expect(report.mirrorWritesRevoked).toBe(1);

    // The same rule for a checkout built in a stage and moved in.
    const staged = path.join(root, "staged");
    mkdirSync(path.join(staged, "objects"), { recursive: true });
    writeFileSync(path.join(staged, "config"), "[core]\n", { mode: 0o644 });
    linkSync(mirrorObject, path.join(staged, "objects", "cdef"));
    shareTreeBuiltForAgents(staged, { gid });
    expect(mode(path.join(staged, "config")) & 0o060).toBe(0o060);
    expect(mode(path.join(staged, "objects", "cdef"))).toBe(0o444);
    expect(mode(staged) & 0o2070).toBe(0o2070);
  });
});

describe("agentIsolation in /resources/health (ruling 460)", () => {
  function dataRootWithStore(): string {
    const root = ctx.makeTempDir("viberr-probe-");
    mkdirSync(path.join(root, "state"), { recursive: true });
    writeFileSync(path.join(root, "state/projection.sqlite"), "");
    return root;
  }

  it("is `off`, and not a fault, where there is no launcher (the dev host, this harness)", () => {
    resetAgentIsolationForTests(null, { launcher: path.join(ctx.makeTempDir(), "absent") });
    const snapshot = healthSnapshot(ctx.makeDb());
    expect(snapshot.agentIsolation.status).toBe("off");
    expect(snapshot.agentIsolation.uidFloor).toBe(AGENT_UID_FLOOR);
    expect(snapshot.agentIsolation.reason).toMatch(/no agent launcher/);
    expect(snapshot.degraded).not.toContain("agentIsolation");
  });

  it("is `on` when the launcher's probe is refused the store", () => {
    const launcher = fakeLauncher(0);
    const root = dataRootWithStore();
    expect(measureAgentIsolation({ launcher: launcher.path, dataRoot: root })).toEqual({
      status: "on",
      uidFloor: AGENT_UID_FLOOR,
      reason: null,
    });
    expect(launcher.calls()).toEqual([`--probe ${path.join(root, "state/projection.sqlite")}`]);
    const snapshot = healthSnapshot(ctx.makeDb());
    expect(snapshot.agentIsolation.status).toBe("on");
    expect(snapshot.degraded).not.toContain("agentIsolation");
  });

  it("is `degraded`, named in `degraded`, when the probe READ the store (a bind mount)", () => {
    const launcher = fakeLauncher(3);
    measureAgentIsolation({ launcher: launcher.path, dataRoot: dataRootWithStore() });
    const snapshot = healthSnapshot(ctx.makeDb());
    expect(snapshot.agentIsolation.status).toBe("degraded");
    expect(snapshot.agentIsolation.reason).toMatch(/does not enforce file permissions/);
    expect(snapshot.agentIsolation.reason).toMatch(/named volume/);
    expect(snapshot.degraded).toContain("agentIsolation");
    expect(snapshot.status).toBe("degraded");
  });

  it("is `degraded` when the probe itself fails", () => {
    const launcher = fakeLauncher(2);
    measureAgentIsolation({ launcher: launcher.path, dataRoot: dataRootWithStore() });
    expect(agentIsolation().status).toBe("degraded");
    expect(agentIsolation().reason).toMatch(/probe failed \(exit 2\)/);
  });

  it("is appended LAST: the health body's key order is part of its contract", () => {
    const keys = Object.keys(healthSnapshot(ctx.makeDb()));
    expect(keys.at(-1)).toBe("agentIsolation");
    // Ruling 461's mcpProxy sits between toolchain and this key.
    expect(keys.slice(-3)).toEqual(["toolchain", "mcpProxy", "agentIsolation"]);
  });
});

describe("agentLaunchFor (ruling 460)", () => {
  it("launches nothing where there is no launcher: the run spawns as before", () => {
    resetAgentIsolationForTests(null, { launcher: path.join(ctx.makeTempDir(), "absent") });
    const db = ctx.makeDb();
    expect(agentLaunchFor(db, "u_ada", "/nowhere/claude-home")).toBeNull();
    // …and allocates no uid for it.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_os_users`).get()).toEqual({ n: 0 });
  });

  it("hands the person's runtime root, vendor home and agent $HOME to their uid", () => {
    const launcher = fakeLauncher(0);
    resetAgentIsolationForTests(
      { status: "on", uidFloor: AGENT_UID_FLOOR, reason: null },
      { launcher: launcher.path },
    );
    const dataRoot = ctx.makeTempDir("viberr-launch-root-");
    const db = ctx.makeDb();
    const userRoot = path.join(dataRoot, "runtimes/users/u_ada");
    const backendHome = path.join(userRoot, "claude-home");
    const launch = agentLaunchFor(db, "u_ada", backendHome, dataRoot);
    expect(launch).toEqual({
      uid: AGENT_UID_FLOOR,
      launcher: launcher.path,
      launchHome: backendHome,
      home: path.join(userRoot, "home"),
    });
    expect(launcher.calls()).toEqual([
      `--prepare-home ${AGENT_UID_FLOOR} ${userRoot}`,
      `--prepare-home ${AGENT_UID_FLOOR} ${backendHome}`,
      `--prepare-home ${AGENT_UID_FLOOR} ${path.join(userRoot, "home")}`,
    ]);
  });

  it("refuses, naming the launcher, when the home cannot be handed over — never a silent fallback", () => {
    const dir = ctx.makeTempDir("viberr-launcher-");
    const failing = path.join(dir, "viberr-launch");
    writeFileSync(failing, "#!/bin/sh\necho 'viberr-launch: the path is not under /data/runtimes/users' >&2\nexit 126\n");
    chmodSync(failing, 0o755);
    resetAgentIsolationForTests(
      { status: "on", uidFloor: AGENT_UID_FLOOR, reason: null },
      { launcher: failing },
    );
    expect(() =>
      agentLaunchFor(ctx.makeDb(), "u_ada", "/elsewhere/claude-home", ctx.makeTempDir()),
    ).toThrow(/could not prepare .*the path is not under/);
  });
});
