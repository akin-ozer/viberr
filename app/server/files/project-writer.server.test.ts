import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import {
  allocateTaskKey,
  readProjectFile,
  resolveProjectFilePath,
  updateProjectFile,
} from "./project-writer.server";

/**
 * Read-your-own-writes repair for project.md (P11-51) — the same VirtioFS
 * stale-read hazard the task writer guards, extended to member/agent/policy
 * edits and the task-key counter.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("updateProjectFile stale-read repair (P11-51)", () => {
  it("a stale (pre-write) disk read is repaired — the earlier edit survives", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);
    const preContent = readFileSync(absPath, "utf8");

    // First edit: add a member.
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_first", role: "viewer" });
    });

    // Simulate the VirtioFS stale cache: disk reverts to pre-write with an
    // OLDER mtime.
    writeFileSync(absPath, preContent);
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(absPath, past, past);

    // Second edit reads the (stale) disk — the repair restores our own write
    // as the base, so the first member is not erased.
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_second", role: "viewer" });
    });

    const ids = readProjectFile(ref)!.parsed.frontmatter.members.map((m) => m.userId);
    expect(ids).toContain("u_first");
    expect(ids).toContain("u_second");
  });

  it("a genuine external edit (newer mtime) wins over the write cache", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);

    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_app", role: "viewer" });
    });

    // A human edits project.md AFTER our write (newer mtime) — disk wins.
    const external = readFileSync(absPath, "utf8").replace("u_app", "u_hand_edited");
    writeFileSync(absPath, external);
    const future = (statSync(absPath).mtimeMs + 5_000) / 1000;
    utimesSync(absPath, future, future);

    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_after", role: "viewer" });
    });

    const ids = readProjectFile(ref)!.parsed.frontmatter.members.map((m) => m.userId);
    expect(ids).toContain("u_hand_edited");
    expect(ids).not.toContain("u_app");
    expect(ids).toContain("u_after");
  });

  it("allocateTaskKey does not rewind the counter from a stale read", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);

    const first = await allocateTaskKey(ref);
    const preContent = readFileSync(absPath, "utf8");
    const second = await allocateTaskKey(ref);
    expect(second).not.toBe(first);

    // Revert the file to the state after `first` (nextTaskNumber lower) with an
    // older mtime — the next allocation must NOT reuse `second`.
    writeFileSync(absPath, preContent);
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(absPath, past, past);

    const third = await allocateTaskKey(ref);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
});
