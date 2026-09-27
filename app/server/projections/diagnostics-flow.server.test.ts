import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { taskFilePath } from "~/server/files/file-store-root.server";
import { rebuildAll, rebuildPath } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";

/**
 * Phase 10 — diagnostics end-to-end flow: a broken canonical file must
 * surface as (a) a readiness downgrade the board pill renders, (b) a
 * readable diagnostic row the task DiagnosticsPanel renders, and (c) it
 * must all CLEAR on file fix + rescan. Never a crash, never a silent drop
 * (tolerant-parsing contract, docs/architecture/decisions.md "Behavior rules").
 */

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-9", {
      stage: "impl",
      readiness: "ready",
      waiting: "agent",
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
});

afterEach(() => ctx.cleanup());

const filePath = () => taskFilePath(store.slug, "VIB-9", store.dataRoot);

function reproject() {
  return rebuildPath(store.db, filePath(), { dataRoot: store.dataRoot });
}

describe("malformed frontmatter → readiness floor + readable diagnostic → clears on fix", () => {
  it("broken YAML frontmatter floors readiness and lands readable diagnostics", () => {
    const pristine = readFileSync(filePath(), "utf8");

    // Break the frontmatter the way a hand edit does: invalid YAML.
    const broken = pristine.replace(
      "readiness: ready",
      "readiness: [unclosed",
    );
    writeFileSync(filePath(), broken, "utf8");
    const result = reproject();
    expect(result.action).toBe("projected"); // tolerant — never a crash

    const detail = getTaskDetail(store.db, store.slug, "VIB-9")!;
    // Readiness is floored (warning → input_required at minimum; the exact
    // floor depends on which diagnostics fire — never still "ready").
    expect(detail.readiness).not.toBe("ready");
    expect(detail.diagnosticCount).toBeGreaterThan(0);

    const diags = detail.diagnostics;
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) {
      // Readable: every finding has a code and a human sentence — the
      // DiagnosticsPanel renders `code — message` verbatim.
      expect(d.code.length).toBeGreaterThan(0);
      expect(d.message.length).toBeGreaterThan(10);
      expect(d.message).not.toMatch(/^\{/); // no raw JSON leaking
    }

    // Fix the file → reproject → diagnostics clear, readiness restored.
    writeFileSync(filePath(), pristine, "utf8");
    reproject();
    const healed = getTaskDetail(store.db, store.slug, "VIB-9")!;
    expect(healed.readiness).toBe("ready");
    expect(healed.diagnosticCount).toBe(0);
    expect(healed.diagnostics).toEqual([]);
  });

  it("entirely mangled frontmatter (no closing fence) still projects with a floor", () => {
    const pristine = readFileSync(filePath(), "utf8");
    writeFileSync(
      filePath(),
      "---\nkey VIB-9 title broken :: ::\n\n## Goal\n\nStill here.\n",
      "utf8",
    );
    const result = reproject();
    expect(result.action).toBe("projected");
    const detail = getTaskDetail(store.db, store.slug, "VIB-9");
    expect(detail).not.toBeNull();
    expect(detail!.readiness).not.toBe("ready");
    expect(detail!.diagnosticCount).toBeGreaterThan(0);

    writeFileSync(filePath(), pristine, "utf8");
    reproject();
    expect(getTaskDetail(store.db, store.slug, "VIB-9")!.diagnosticCount).toBe(
      0,
    );
  });

  it("unknown stage → warning + input_required floor; clears when the stage exists", () => {
    const pristine = readFileSync(filePath(), "utf8");
    writeFileSync(filePath(), pristine.replace("stage: impl", "stage: qa"), "utf8");
    reproject();

    const detail = getTaskDetail(store.db, store.slug, "VIB-9")!;
    expect(detail.readiness).toBe("input_required"); // warning floor
    const diags = detail.diagnostics;
    expect(diags.some((d) => d.code === "reference.unknown_stage")).toBe(true);
    const unknownStage = diags.find((d) => d.code === "reference.unknown_stage")!;
    expect(unknownStage.message).toContain("qa");
    // G2: the DiagnosticsPanel colors/labels each finding from its readiness
    // EFFECT, not the raw severity word — so this warning renders the SAME
    // "input required" pill the hero shows, never a crimson "blocked".
    expect(unknownStage.readinessEffect).toBe("input_required");

    writeFileSync(filePath(), pristine, "utf8");
    reproject();
    expect(getTaskDetail(store.db, store.slug, "VIB-9")!.readiness).toBe(
      "ready",
    );
  });

  it("duplicate ## Goal section → body.duplicate_section warning (phase-3 fix)", () => {
    const pristine = readFileSync(filePath(), "utf8");
    writeFileSync(
      filePath(),
      pristine + "\n## Goal\n\nA second goal section.\n",
      "utf8",
    );
    reproject();
    const detail = getTaskDetail(store.db, store.slug, "VIB-9")!;
    expect(detail.diagnostics.some((d) => d.code === "body.duplicate_section")).toBe(true);
    expect(detail.readiness).toBe("input_required"); // warning floor
    // FIRST occurrence wins — the projected goal is the original text.
    expect(detail.goal).toContain("Test goal.");

    writeFileSync(filePath(), pristine, "utf8");
    reproject();
    expect(getTaskDetail(store.db, store.slug, "VIB-9")!.diagnosticCount).toBe(
      0,
    );
  });
});
