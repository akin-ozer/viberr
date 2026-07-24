import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
        { id: "triage", name: "Triage", color: "#a5a8b5" },
        { id: "impl", name: "In Progress", color: "#7b61ff" },
        { id: "shipped", name: "Shipped", color: "#00b473" },
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
});
