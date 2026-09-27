import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { staleViewOf } from "../../../test-support/stale-mount";
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
 * edits and the task-key counter. What counts as provably stale is
 * write-cache's own test (ruling 513); these prove the writer reads through it.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("updateProjectFile stale-read repair (P11-51)", () => {
  it("a stale (pre-write) disk read is repaired — the earlier edit survives", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);
    const stale = staleViewOf(absPath);

    // First edit: add a member.
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_first", role: "viewer" });
    });

    // The VirtioFS stale cache: the mount goes on serving the file that edit
    // replaced.
    stale.serve();

    // Second edit reads the (stale) disk — the repair restores our own write
    // as the base, so the first member is not erased.
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_second", role: "viewer" });
    });

    const ids = readProjectFile(ref)!.parsed.frontmatter.members.map((m) => m.userId);
    expect(ids).toContain("u_first");
    expect(ids).toContain("u_second");
  });

  it("a genuine external edit wins over the write cache", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);

    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_app", role: "viewer" });
    });

    // A human edits project.md AFTER our write — disk wins. (The stamp well
    // past ours keeps this about the writer; an edit landing straight after
    // ours is write-cache's own row.)
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
    const stale = staleViewOf(absPath);
    const second = await allocateTaskKey(ref);
    expect(second).not.toBe(first);

    // The mount serves the file as `first` left it (nextTaskNumber lower),
    // the one `second` replaced — the next allocation must NOT reuse `second`.
    stale.serve();

    const third = await allocateTaskKey(ref);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
  });
});

describe("project.md write guard (gap 22, for the writer that never got it)", () => {
  /** The whole point of the file: members, stages, workflow, repo, agents. */
  const membersOf = (ref: { projectSlug: string; dataRoot: string }) =>
    readProjectFile(ref)!.parsed.frontmatter.members.map((m) => m.userId);

  it("refuses to write over a project.md whose frontmatter cannot be read", async () => {
    // task.md and the goal files have refused this since gap 22; project.md
    // did not, so ONE unterminated fence or YAML typo in a hand-edited file
    // meant the next ordinary write serialized tolerant-parse DEFAULTS over
    // it — every member, stage, workflow, repo binding and agent deployment
    // replaced, and the toast said the save succeeded.
    // Canary: drop assertProjectFileTrusted from updateProjectFile and this
    // resolves instead of throwing (and the members below come back empty).
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);

    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.members.push({ userId: "u_real", role: "maintainer" });
    });
    expect(membersOf(ref)).toContain("u_real");

    // A truncated editor write: the fence never closes.
    const broken = "---\nname: Viberr\nmembers:\n  - userId: u_real\n";
    writeFileSync(absPath, broken);
    const future = (statSync(absPath).mtimeMs + 5_000) / 1000;
    utimesSync(absPath, future, future);

    await expect(
      updateProjectFile(ref, (parsed) => {
        parsed.frontmatter.members.push({ userId: "u_next", role: "viewer" });
      }),
    ).rejects.toThrow(/refusing to write .*project\.md/);

    // Refused BEFORE the write: the broken bytes are still on disk untouched,
    // so the operator's own copy is what they recover, not our defaults.
    expect(readFileSync(absPath, "utf8")).toBe(broken);
  });

  it("allocateTaskKey refuses on the same file — creating a task cannot eat the project", async () => {
    // The quieter door: nobody edits project.md to make a task, but the
    // allocation advances `nextTaskNumber`, which is a full read-modify-write
    // of the same file.
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, dataRoot: store.dataRoot };
    const absPath = resolveProjectFilePath(ref);

    const broken = "---\nname: Viberr\n  bad indent:\n   - [\n---\n\nDescription.\n";
    writeFileSync(absPath, broken);
    const future = (statSync(absPath).mtimeMs + 5_000) / 1000;
    utimesSync(absPath, future, future);

    await expect(allocateTaskKey(ref)).rejects.toThrow(
      /refusing to write .*project\.md/,
    );
    expect(readFileSync(absPath, "utf8")).toBe(broken);
  });
});
