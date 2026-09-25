import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_UID_FLOOR,
  resetAgentIsolationForTests,
} from "~/server/runtimes/agent-isolation.server";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { reclaimTerminalTaskWorkspaces } from "./workspace-retention.server";

/**
 * P13 (ARCH-6 audit): task workspaces were never garbage-collected. Every task
 * that ran a specialist kept an 11-16 MB git clone forever, and no `rmSync`
 * anywhere in the tree targeted that path — a one-project test instance had
 * accumulated 101 MB across seven tasks.
 */
describe("reclaimTerminalTaskWorkspaces", () => {
  const ctx = createTestDbContext();

  /** Create a workspace clone with real bytes in it, return its root. */
  function seedWorkspace(store: TestStore, key: string): string {
    const root = path.join(taskDir(store.slug, key, store.dataRoot), "workspace");
    const repo = path.join(root, "viberr");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "chunk.bin"), "x".repeat(4096));
    return root;
  }

  function task(store: TestStore, key: string, stage: string) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, { stage }),
    });
  }

  it("removes a finished task's clone and leaves an in-flight one alone", () => {
    const store = setupTestStore(ctx);
    task(store, "VIB-1", "done");
    task(store, "VIB-2", "impl");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const finished = seedWorkspace(store, "VIB-1");
    const inFlight = seedWorkspace(store, "VIB-2");

    const result = reclaimTerminalTaskWorkspaces(store.db, {
      dataRoot: store.dataRoot,
    });

    expect(result.removed).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(finished)).toBe(false);
    expect(existsSync(inFlight)).toBe(true);
  });

  it("never touches the canonical task file or its directory", () => {
    // The workspace is a cache; task.md is the source of truth. A reclamation
    // that took the record with it would be data loss, not housekeeping.
    const store = setupTestStore(ctx);
    task(store, "VIB-1", "done");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedWorkspace(store, "VIB-1");

    reclaimTerminalTaskWorkspaces(store.db, { dataRoot: store.dataRoot });

    const dir = taskDir(store.slug, "VIB-1", store.dataRoot);
    expect(existsSync(path.join(dir, "task.md"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("is idempotent — it runs on every boot", () => {
    const store = setupTestStore(ctx);
    task(store, "VIB-1", "done");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    seedWorkspace(store, "VIB-1");

    expect(
      reclaimTerminalTaskWorkspaces(store.db, { dataRoot: store.dataRoot }).removed,
    ).toBe(1);
    expect(
      reclaimTerminalTaskWorkspaces(store.db, { dataRoot: store.dataRoot }).removed,
    ).toBe(0);
  });

  it("uses the project's LAST stage, not a hardcoded `done` id", () => {
    // The stage editor lets an admin rename or replace the terminal stage, and
    // P13-D-1 now splices new stages in ahead of it. Keying off the literal id
    // would silently stop reclaiming on any project whose final column is not
    // called `done`.
    const store = setupTestStore(ctx);
    writeProject(store.dataRoot, {
      name: "Viberr Core",
      slug: store.slug,
      repo: "akin-ozer/viberr",
      defaultBranch: "main",
      taskPrefix: "VIB",
      nextTaskNumber: 100,
      stages: [
        { id: "triage", name: "Triage", color: "slate" },
        { id: "impl", name: "In Progress", color: "violet" },
        { id: "shipped", name: "Shipped", color: "green" },
      ],
      workflow: [
        { from: "triage", to: "impl", boundary: "auto", by: "Operator", locked: false },
        { from: "impl", to: "shipped", boundary: "human", by: "Human", locked: true },
      ],
      members: Object.values(store.users)
        .filter((u) => u.projectRole !== null)
        .map((u) => ({ userId: u.id, role: u.projectRole! })),
      agents: [],
      credentialPolicy: null,
      guardrails: [],
      requiredReviewers: [],
    fileLeases: [],
    });
    task(store, "VIB-1", "shipped");
    task(store, "VIB-2", "impl");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const terminal = seedWorkspace(store, "VIB-1");
    const middle = seedWorkspace(store, "VIB-2");

    expect(
      reclaimTerminalTaskWorkspaces(store.db, { dataRoot: store.dataRoot }).removed,
    ).toBe(1);
    expect(existsSync(terminal)).toBe(false);
    expect(existsSync(middle)).toBe(true);
  });

  describe("ruling 485: as the task's person, never as the server", () => {
    /** Directories a test made unwritable, handed back before cleanup. */
    const locked: string[] = [];
    afterEach(() => {
      for (const dir of locked.splice(0)) if (existsSync(dir)) chmodSync(dir, 0o700);
      resetAgentIsolationForTests();
    });

    /** A stand-in `viberr-launch` (isolation `on`) that logs and execs. */
    function standInLauncher(): () => string[] {
      const dir = ctx.makeTempDir("viberr-launcher-");
      const log = path.join(dir, "launch.log");
      const launcher = path.join(dir, "viberr-launch");
      writeFileSync(
        launcher,
        [
          "#!/bin/sh",
          'if [ "$1" = "--prepare-home" ]; then mkdir -p "$3"; exit 0; fi',
          `printf 'uid=%s exec=%s args=%s\\n' "$VIBERR_LAUNCH_UID" "$(basename "$VIBERR_LAUNCH_EXEC")" "$*" >> '${log}'`,
          'target=$VIBERR_LAUNCH_EXEC',
          "unset VIBERR_LAUNCH_UID VIBERR_LAUNCH_EXEC VIBERR_LAUNCH_HOME",
          'exec "$target" "$@"',
          "",
        ].join("\n"),
      );
      chmodSync(launcher, 0o755);
      resetAgentIsolationForTests({ status: "on", uidFloor: AGENT_UID_FLOOR, reason: null }, { launcher });
      return () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    }

    it("a finished task's workspace goes through the launch as its owner, a tool's unwritable directory included; an unowned one is left, not removed as the server", () => {
      // CANARY: reclaim with `rmSync` again and the owned workspace throws on
      // the tool's directory (nothing reclaimed), while the unowned one is
      // removed by the server's own user.
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", { stage: "done", ownerUserId: store.users.arda.id }),
      });
      task(store, "VIB-2", "done");
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      const owned = seedWorkspace(store, "VIB-1");
      const tool = path.join(owned, "viberr", ".wrangler", "tmp", "dev-1wnDsF");
      mkdirSync(tool, { recursive: true });
      writeFileSync(path.join(tool, "bundle.js"), "export {};\n");
      chmodSync(tool, 0o500);
      locked.push(tool);
      const unowned = seedWorkspace(store, "VIB-2");
      const launched = standInLauncher();

      const result = reclaimTerminalTaskWorkspaces(store.db, { dataRoot: store.dataRoot });

      expect(result.removed).toBe(1);
      expect(existsSync(owned)).toBe(false);
      expect(launched()).toEqual([
        `uid=${AGENT_UID_FLOOR} exec=chmod args=-R u+rwX -- ${owned}`,
        `uid=${AGENT_UID_FLOOR} exec=rm args=-rf -- ${owned}`,
      ]);
      expect(existsSync(path.join(unowned, "viberr", "chunk.bin"))).toBe(true);
    });
  });
});
