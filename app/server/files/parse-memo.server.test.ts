import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { baseTaskFrontmatter, setupTestStore, writeTask } from "../../../test-support/test-store";
import { parseProjectFileContent } from "./project-file.server";
import {
  parseStoreFile,
  resetParseMemoForTests,
  storeFileParseCounts,
} from "./parse-memo.server";
import { readProjectFile, resolveProjectFilePath, updateProjectFile } from "./project-writer.server";
import { appendTimelineEvent, readTaskFile } from "./task-writer.server";

/**
 * Ruling 454: the store readers skip the YAML parse only when the bytes on
 * disk are the bytes they last parsed. Files stay truth: every read still
 * reads, and whatever changed the file — a writer, an editor, a same-length
 * rewrite inside one mtime tick — is seen by the very next read.
 */

const ctx = createTestDbContext();
beforeEach(() => resetParseMemoForTests());
afterEach(ctx.cleanup);

const projectParses = () => storeFileParseCounts()["project-file"];

describe("store-file parse memo (ruling 454)", () => {
  it("parses unchanged bytes once and hands every caller its own copy", () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const first = readProjectFile(ref)!;
    const second = readProjectFile(ref)!;
    expect(projectParses()).toBe(1);
    // The same answer a fresh parse gives, class for class.
    expect(second.parsed).toStrictEqual(
      parseProjectFileContent(second.content, { fallbackSlug: store.slug }).parsed,
    );
    // A caller that mutates what it read (the writers do) cannot reach the
    // next caller's value.
    expect(second.parsed).not.toBe(first.parsed);
    second.parsed.frontmatter.members.length = 0;
    second.parsed.frontmatter.name = "Mutated";
    const third = readProjectFile(ref)!;
    expect(third.parsed.frontmatter.name).toBe(first.parsed.frontmatter.name);
    expect(third.parsed.frontmatter.members).toEqual(first.parsed.frontmatter.members);
    expect(projectParses()).toBe(1);
  });

  it("sees an edit made through the writer on the next read", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    readProjectFile(ref);
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.name = "Renamed through the writer";
    });
    expect(readProjectFile(ref)!.parsed.frontmatter.name).toBe("Renamed through the writer");

    const taskRef = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1") });
    expect(readTaskFile(taskRef)!.parsed.timeline).toHaveLength(0);
    await appendTimelineEvent(taskRef, {
      occurredAt: "2026-09-24T10:00:00.000Z",
      type: "comment",
      actor: { kind: "human", userId: store.users.arda.id, nameHint: null },
      title: null,
      text: "Seen on the next read.",
      toAgent: false,
      evidence: null,
    });
    expect(readTaskFile(taskRef)!.parsed.timeline.map((e) => e.text)).toEqual([
      "Seen on the next read.",
    ]);
  });

  it("sees an external in-place rewrite of the same length", () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);
    const before = readProjectFile(ref)!;
    const name = before.parsed.frontmatter.name;
    const renamed = `${name.slice(0, -1)}${name.endsWith("X") ? "Y" : "X"}`;
    const stat = statSync(absPath);
    // An editor writing in place: same file, same size, and the clock set
    // back — the attributes a stat-keyed cache compares barely move (utimes
    // keeps about a millisecond), or not at all on a coarse-mtime mount.
    writeFileSync(absPath, readFileSync(absPath, "utf8").replace(`name: ${name}`, `name: ${renamed}`));
    utimesSync(absPath, stat.atime, stat.mtime);
    const after = statSync(absPath);
    expect([after.ino, after.size]).toEqual([stat.ino, stat.size]);
    expect(Math.abs(after.mtimeMs - stat.mtimeMs)).toBeLessThan(2);

    expect(readProjectFile(ref)!.parsed.frontmatter.name).toBe(renamed);
    expect(projectParses()).toBe(2);
  });

  it("keys on the parse context as well as the bytes", () => {
    const parse = (fallback: string) => (c: string) => `${fallback}:${c}`;
    expect(parseStoreFile("task-file", "/x/task.md", "VIB-1", "same", parse("VIB-1"))).toBe("VIB-1:same");
    expect(parseStoreFile("task-file", "/x/task.md", "vib-1", "same", parse("vib-1"))).toBe("vib-1:same");
    expect(storeFileParseCounts()["task-file"]).toBe(2);
  });

  it("returns a value it cannot copy uncached rather than failing the read", () => {
    const make = () => ({ run: () => "not cloneable" });
    const first = parseStoreFile("agent-profile", "/x/p.md", "p", "c", make);
    const second = parseStoreFile("agent-profile", "/x/p.md", "p", "c", make);
    expect(first.run()).toBe("not cloneable");
    expect(second.run()).toBe("not cloneable");
    expect(storeFileParseCounts()["agent-profile"]).toBe(2);
  });
});
