import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rescanProjections } from "../projections/rescan.server";
import { checkStore, untrustedFileReport } from "./store-check.server";

/**
 * Gap 22 — a corrupted or badly hand-edited canonical file had no recovery
 * path, and worse, no VISIBILITY: parsing is tolerant, so a broken task.md
 * projects with fallback defaults and `npm run rescan` prints "0 errors" over
 * it. These pin the doctor that names the file, the reason and the line.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function writeRawTask(
  dataRoot: string,
  slug: string,
  key: string,
  content: string,
): string {
  const dir = path.join(dataRoot, "projects", slug, "tasks", key);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "task.md");
  writeFileSync(file, content, "utf8");
  return file;
}

/** A botched hand-edit: an editor indented a frontmatter line with a TAB, so
 *  the whole YAML mapping stops parsing at that line. */
const BROKEN_YAML = `---
key: VIB-900
title: Broken by hand
\tstage: impl
owner: u_arda
---

## Goal

Ship the thing.

## Timeline

### 2026-08-01T10:00:00.000Z · comment · human:u_arda

Important context nobody wants to lose.
`;

/** A truncated editor write: the closing fence never landed. */
const TRUNCATED = `---
key: VIB-901
title: Truncated
stage: impl
`;

function writeRawGoal(
  dataRoot: string,
  slug: string,
  goalId: string,
  content: string,
): string {
  const dir = path.join(dataRoot, "projects", slug, "goals");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${goalId}.md`);
  writeFileSync(file, content, "utf8");
  return file;
}

/** A goal file whose required `title` was deleted by a hand edit: the schema
 *  rejects it outright, so the goal has no readable form at all. */
const BROKEN_GOAL = `---
id: goal-7
status: active
createdBy: u_arda
---

## Description

Ship the release.

## Timeline

- 2026-08-30T10:00:00.000Z · Goal created with 2 links by arda@viberr.dev.
`;

const HEALTHY_GOAL = `---
id: goal-1
title: Ship the release
status: active
createdBy: u_arda
createdByLabel: arda@viberr.dev
onFailure: pause
links:
  - index: 1
    title: Cut the branch
    goal: Branch exists.
    taskKey: null
    status: pending
    note: null
createdAt: 2026-08-30T10:00:00.000Z
updatedAt: 2026-08-30T10:00:00.000Z
---

## Description

Ship the release.

## Timeline

- 2026-08-30T10:00:00.000Z · Goal created with 1 link by arda@viberr.dev.
`;

describe("checkStore", () => {
  it("says nothing is wrong when every canonical file parses", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "Fine" }),
    });

    const report = checkStore({ dataRoot: store.dataRoot });
    expect(report.untrusted).toEqual([]);
    expect(report.files.length).toBeGreaterThan(0);
    expect(report.text).toContain("parsed cleanly");
  });

  it("names the broken file, the parse error AND the offending line", () => {
    const store = setupTestStore(ctx);
    writeRawTask(store.dataRoot, store.slug, "VIB-900", BROKEN_YAML);

    const report = checkStore({ dataRoot: store.dataRoot });
    expect(report.untrusted).toHaveLength(1);
    const broken = report.untrusted[0]!;
    // The file, by its store-relative path — the same string the task page shows.
    expect(broken.path).toBe(
      `projects/${store.slug}/tasks/VIB-900/task.md`,
    );
    expect(broken.trusted).toBe(false);
    expect(broken.blocking.map((d) => d.code)).toContain(
      "frontmatter.invalid_yaml",
    );
    // The parse error itself, not just "the file is broken".
    expect(broken.blocking[0]!.message).toMatch(/unparseable/i);
    // …and WHERE. The tab-indented line is line 4 of the file (line 3 of the
    // YAML block, offset by the opening `---` fence).
    expect(broken.location?.line).toBe(4);
    expect(broken.location?.excerpt).toContain("> 4 |");
    expect(broken.location?.excerpt).toContain("stage: impl");
    expect(report.text).toContain("VIB-900/task.md");
    expect(report.text).toContain("npm run restore");
  });

  it("catches a truncated write (no closing fence) — the case that erases a file", () => {
    const store = setupTestStore(ctx);
    writeRawTask(store.dataRoot, store.slug, "VIB-901", TRUNCATED);

    const report = checkStore({ dataRoot: store.dataRoot });
    const broken = report.untrusted.find((f) => f.path.includes("VIB-901"));
    expect(broken).toBeDefined();
    expect(broken!.blocking.map((d) => d.code)).toContain(
      "frontmatter.unterminated",
    );
  });

  /**
   * Ruling 99 added a THIRD canonical file class. A rescan counts a broken
   * goal file as an error (the parse returns null, unlike the tolerant task
   * parser), so the human is told a number and — until the doctor walked
   * goals — had nothing that named the file.
   */
  it("names a broken goal file, the class the controller pass introduced", () => {
    const store = setupTestStore(ctx);
    writeRawGoal(store.dataRoot, store.slug, "goal-7", BROKEN_GOAL);

    const report = checkStore({ dataRoot: store.dataRoot });
    const broken = report.untrusted.find((f) => f.kind === "goal");
    expect(broken).toBeDefined();
    expect(broken!.path).toBe(`projects/${store.slug}/goals/goal-7.md`);
    expect(broken!.blocking.length).toBeGreaterThan(0);
    expect(report.text).toContain("goals/goal-7.md");
  });

  it("trusts a well-formed goal file", () => {
    const store = setupTestStore(ctx);
    writeRawGoal(store.dataRoot, store.slug, "goal-1", HEALTHY_GOAL);

    const report = checkStore({ dataRoot: store.dataRoot });
    expect(report.untrusted).toEqual([]);
    expect(report.files.some((f) => f.kind === "goal")).toBe(true);
  });
});

describe("untrustedFileReport", () => {
  it("names the files a rescan reported ZERO errors for", () => {
    const store = setupTestStore(ctx);
    writeRawTask(store.dataRoot, store.slug, "VIB-900", BROKEN_YAML);

    const summary = rescanProjections(store.db, { dataRoot: store.dataRoot });
    // The rescan itself is serene about it: nothing threw, so nothing counted.
    expect(summary.errors).toBe(0);

    const report = untrustedFileReport(store.db);
    expect(report.files.map((f) => f.path)).toContain(
      `projects/${store.slug}/tasks/VIB-900/task.md`,
    );
    expect(report.text).toContain("NOT trusted");
    expect(report.text).toContain("frontmatter.invalid_yaml");
  });

  it("is silent on a healthy store", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "Fine" }),
    });
    rescanProjections(store.db, { dataRoot: store.dataRoot });
    expect(untrustedFileReport(store.db).files).toEqual([]);
    expect(untrustedFileReport(store.db).text).toBe("");
  });
});
