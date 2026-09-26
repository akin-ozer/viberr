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

function writeRawEpic(
  dataRoot: string,
  slug: string,
  epicId: string,
  content: string,
): string {
  const dir = path.join(dataRoot, "projects", slug, "epics");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${epicId}.md`);
  writeFileSync(file, content, "utf8");
  return file;
}

/** An epic file whose required `title` was deleted by a hand edit: the schema
 *  rejects it outright, so the epic has no readable form at all. */
const BROKEN_EPIC = `---
id: epic-7
status: in_progress
createdBy: u_arda
---

## Description

Ship the release.

## Timeline

- 2026-09-26T10:00:00.000Z · Created by Arda.
`;

const HEALTHY_EPIC = `---
id: epic-1
title: Ship the release
status: in_progress
color: teal
leadUserId: null
startDate: null
targetDate: 2026-10-15
createdBy: u_arda
createdByLabel: arda@viberr.dev
conversationId: null
convertedFrom: null
createdAt: 2026-09-26T10:00:00.000Z
updatedAt: 2026-09-26T10:00:00.000Z
---

## Description

Ship the release.

## Timeline

- 2026-09-26T10:00:00.000Z · Created by Arda.
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
   * Ruling 99 added a THIRD canonical file class, the goal; ruling 503
   * replaced it with the epic. A rescan counts a broken epic file as an error
   * (the parse returns null, unlike the tolerant task parser), so the human
   * is told a number and, without the doctor walking epics, nothing names the
   * file.
   */
  it("names a broken epic file, the class ruling 503 introduced", () => {
    // CANARY: drop the epics walk from `checkStore`.
    const store = setupTestStore(ctx);
    writeRawEpic(store.dataRoot, store.slug, "epic-7", BROKEN_EPIC);

    const report = checkStore({ dataRoot: store.dataRoot });
    const broken = report.untrusted.find((f) => f.kind === "epic");
    expect(broken).toBeDefined();
    expect(broken!.path).toBe(`projects/${store.slug}/epics/epic-7.md`);
    expect(broken!.blocking.map((d) => d.path)).toContain("title");
    expect(report.text).toContain("epics/epic-7.md");
  });

  it("names an epic file whose id is not its file name", () => {
    // CANARY: stop passing the file's id to `diagnoseEpicFileContent`.
    const store = setupTestStore(ctx);
    writeRawEpic(store.dataRoot, store.slug, "epic-2", HEALTHY_EPIC);

    const report = checkStore({ dataRoot: store.dataRoot });
    const broken = report.untrusted.find((f) => f.kind === "epic");
    expect(broken?.blocking.map((d) => d.message)).toContain(
      "id: the file is named epic-2 but says it is epic-1.",
    );
  });

  it("trusts a well-formed epic file", () => {
    const store = setupTestStore(ctx);
    writeRawEpic(store.dataRoot, store.slug, "epic-1", HEALTHY_EPIC);

    const report = checkStore({ dataRoot: store.dataRoot });
    expect(report.untrusted).toEqual([]);
    expect(report.files.some((f) => f.kind === "epic")).toBe(true);
    expect(report.text).toContain("Every project, task and epic file parsed cleanly.");
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
