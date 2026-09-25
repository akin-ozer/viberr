import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createGoalFile,
  parseGoalFileContent,
  readGoalFile,
  serializeGoalFile,
  updateGoalFile,
} from "./goal-writer.server";
import { goalFilePath } from "./file-store-root.server";
import { createTempDirs } from "../../../test-support/temp-dirs";

const temp = createTempDirs();
afterAll(temp.cleanup);

describe("updateGoalFile stale-read repair (C01-A2, pass 32)", () => {
  it("a stale (pre-write) disk read is repaired — the earlier write survives", async () => {
    // The task and project writers carried this VirtioFS read-your-own-writes
    // repair; the goal writer had none, so two back-to-back link-status
    // writes on a cached bind mount could lose the first (pass-31 gotcha 10).
    // Canary: read the raw file instead of `freshestContent` in updateGoalFile.
    const dataRoot = temp.make("viberr-goal-stale-");
    const ref = { projectSlug: "viberr-core", goalId: "goal-1", dataRoot };
    const abs = goalFilePath(ref.projectSlug, ref.goalId, dataRoot);
    mkdirSync(path.dirname(abs), { recursive: true });
    await createGoalFile(ref, {
      frontmatter: {
        id: "goal-1",
        title: "Ship the thing",
        status: "active",
        createdBy: "user-1",
        createdByLabel: "Ada",
        conversationId: null,
        onFailure: "pause",
        links: [],
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
      description: "Do the thing well.",
    });
    const preContent = readFileSync(abs, "utf8");

    await updateGoalFile(ref, (parsed) => {
      parsed.frontmatter.title = "Ship the thing — link 1 advanced";
      return "LINK 1 ADVANCED — must survive";
    });

    // Simulate the VirtioFS stale cache: disk "reverts" to the pre-write
    // content with an mtime OLDER than our write.
    writeFileSync(abs, preContent);
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(abs, past, past);

    await updateGoalFile(ref, (parsed) => {
      parsed.frontmatter.title = "Ship the thing — link 2 advanced";
      return "LINK 2 ADVANCED — second write";
    });

    const after = readGoalFile(ref)!;
    const texts = after.parsed.timeline.map((e) => e.text);
    expect(texts).toContain("LINK 1 ADVANCED — must survive");
    expect(texts).toContain("LINK 2 ADVANCED — second write");
    expect(after.parsed.frontmatter.title).toBe("Ship the thing — link 2 advanced");
  });

  it("a genuine EXTERNAL edit (newer mtime) still wins over the write cache", async () => {
    const dataRoot = temp.make("viberr-goal-ext-");
    const ref = { projectSlug: "viberr-core", goalId: "goal-2", dataRoot };
    const abs = goalFilePath(ref.projectSlug, ref.goalId, dataRoot);
    mkdirSync(path.dirname(abs), { recursive: true });
    await createGoalFile(ref, {
      frontmatter: {
        id: "goal-2",
        title: "Original",
        status: "active",
        createdBy: "user-1",
        createdByLabel: "Ada",
        conversationId: null,
        onFailure: "pause",
        links: [],
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
      description: "d",
    });
    await updateGoalFile(ref, (parsed) => {
      parsed.frontmatter.title = "Written by the app";
    });
    // A human edits the file AFTER our write (mtime in the future, well past the
    // slack) — that content must win.
    const external = readFileSync(abs, "utf8").replace("Written by the app", "Edited by a human");
    writeFileSync(abs, external);
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(abs, future, future);
    await updateGoalFile(ref, () => "touch");
    expect(readGoalFile(ref)!.parsed.frontmatter.title).toBe("Edited by a human");
  });
});

/**
 * file-formats §2: the writers ALWAYS preserve unknown frontmatter fields, so a
 * hand-added or future/foreign key round-trips. serializeGoalFile used to emit
 * only the schema keys with `{}` extras, so the FIRST reconcile write (a link
 * completing, or even a no-op advance tick) silently destroyed any such key —
 * unlike the task and project writers, which preserve them.
 */
describe("goal-writer round-trip", () => {
  const RAW = [
    "---",
    "id: goal-1",
    "title: Ship the thing",
    "status: active",
    "createdBy: user-1",
    "createdByLabel: Ada",
    "onFailure: pause",
    "links: []",
    "createdAt: 2026-08-31T00:00:00.000Z",
    "updatedAt: 2026-08-31T00:00:00.000Z",
    "reviewLink: https://example.test/goal-1",
    "customNote: keep me",
    "---",
    "",
    "## Description",
    "",
    "Do the thing well.",
    "",
    "## Timeline",
    "",
    "- 2026-08-31T00:00:00.000Z · Goal created with 0 links by Ada.",
    "",
  ].join("\n");

  it("preserves unknown frontmatter keys through parse→serialize", () => {
    const parsed = parseGoalFileContent(RAW);
    expect(parsed).not.toBeNull();
    expect(parsed!.unknownFrontmatter).toMatchObject({
      reviewLink: "https://example.test/goal-1",
      customNote: "keep me",
    });

    const out = serializeGoalFile(parsed!);
    expect(out).toContain("reviewLink: https://example.test/goal-1");
    expect(out).toContain("customNote: keep me");
  });

  it("is stable on a second round-trip (the no-op-write guard holds)", () => {
    const once = serializeGoalFile(parseGoalFileContent(RAW)!);
    const twice = serializeGoalFile(parseGoalFileContent(once)!);
    expect(twice).toBe(once);
    // And the preserved key is still there after two passes.
    expect(twice).toContain("customNote: keep me");
  });
});
