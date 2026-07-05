import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeTask, baseTaskFrontmatter, type TestStore } from "../../../test-support/test-store";
import { seedRuntimes } from "./runtime-seed.server";
import { RUNTIME_SEED } from "./runtime-seed-data.server";
import { listRunsForTask } from "./run-service.server";
import { projectEnvelope } from "./wire-format.server";
import { listRunLines } from "./run-store.server";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  // The runtime seed references viberr-core tasks; write the runtime-bearing
  // ones so listRunsForTask has a home (the runtime rows carry their own keys).
  for (const key of Object.keys(RUNTIME_SEED)) {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key) });
  }
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
});

afterEach(() => ctx.cleanup());

describe("seedRuntimes — counts + fidelity", () => {
  it("materializes 18 runs / 96 log lines across 8 tasks", () => {
    const summary = seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    expect(summary.runs).toBe(18);
    expect(summary.lines).toBe(96);
    const taskCount = Object.keys(RUNTIME_SEED).length;
    expect(taskCount).toBe(8);
  });

  it("is idempotent without --reset (re-seed keeps the same counts)", () => {
    seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    const second = seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    expect(second.runs).toBe(18);
    const runsForTask = listRunsForTask(store.db, store.slug, "VIB-151");
    // Still exactly the 3 VIB-151 threads, not duplicated.
    expect(runsForTask.length).toBe(3);
  });

  it("VIB-142 fidelity: op idle, primary+consultant finished, correct backends/tokens", () => {
    seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    const runs = listRunsForTask(store.db, store.slug, "VIB-142");
    expect(runs.map((r) => r.id)).toEqual(["op", "primary", "c0"]); // stored order preserved

    const op = runs.find((r) => r.id === "op")!;
    expect(op.op).toBe(true);
    expect(op.state).toBe("idle"); // finished lifecycle w/ no finished label → idle render
    expect(op.who.name).toBe("Operator");

    const primary = runs.find((r) => r.id === "primary")!;
    expect(primary.state).toBe("done");
    expect(primary.backend).toBe("codex");
    expect(primary.finished).toBe("9:41");
    // Real usage from the codex turn.completed envelope (in + out).
    expect(primary.tokens).toBe(128034 + 6188);

    const c0 = runs.find((r) => r.id === "c0")!;
    expect(c0.backend).toBe("claude");
    expect(c0.state).toBe("done");
  });

  it("VIB-151 has 2 running specialists + 1 idle operator (the demo case)", () => {
    seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    const runs = listRunsForTask(store.db, store.slug, "VIB-151");
    expect(runs.filter((r) => r.state === "running").length).toBe(2);
    expect(runs.filter((r) => r.op).length).toBe(1);
    const op = runs.find((r) => r.op)!;
    expect(op.state).toBe("idle");
  });

  it("VIB-160 primary is a continuity error", () => {
    seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    const runs = listRunsForTask(store.db, store.slug, "VIB-160");
    expect(runs.find((r) => r.id === "primary")!.state).toBe("error");
  });

  it("triage tasks VIB-166/168 get no runs", () => {
    seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    expect(listRunsForTask(store.db, store.slug, "VIB-166")).toEqual([]);
    expect(listRunsForTask(store.db, store.slug, "VIB-168")).toEqual([]);
  });

  it("log projection round-trip: stored raw_json re-projects to the stored display", () => {
    seedRuntimes(store.db, { dataRoot: store.dataRoot, projectSlug: store.slug });
    // VIB-142 c0 is claude; VIB-142 primary is codex — check both.
    const runs = listRunsForTask(store.db, store.slug, "VIB-142");
    for (const run of runs) {
      const stored = listRunLines(store.db, run.serverRunId);
      for (const line of stored) {
        const reprojected = projectEnvelope(run.backend, JSON.parse(line.raw));
        // The ev derived from the stored raw must match the stored display ev.
        expect(reprojected.display?.ev).toBe(line.display.ev);
      }
    }
  });
});
