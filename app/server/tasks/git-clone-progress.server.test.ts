import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { gitErrorText } from "~/server/secrets/git-output-redact.server";
import {
  parseCloneProgressFraction,
  runGitCloneWithProgress,
} from "./git-clone-progress.server";

const exec = promisify(execFile);

describe("parseCloneProgressFraction", () => {
  it("maps 'Receiving objects' into the first 90%", () => {
    // A real git progress line (note git's variable leading spacing).
    expect(
      parseCloneProgressFraction(
        "Receiving objects:  43% (5000/11626), 12.34 MiB | 5.00 MiB/s",
      ),
    ).toBeCloseTo(0.387, 5); // 0.43 * 0.9
    expect(parseCloneProgressFraction("Receiving objects:   0% (1/11626)")).toBeCloseTo(0, 5);
    expect(
      parseCloneProgressFraction("Receiving objects: 100% (11626/11626), done."),
    ).toBeCloseTo(0.9, 5);
  });

  it("maps 'Resolving deltas' into the last 10%, monotonic after receiving", () => {
    expect(parseCloneProgressFraction("Resolving deltas:   0% (0/8000)")).toBeCloseTo(0.9, 5);
    expect(parseCloneProgressFraction("Resolving deltas:  50% (4000/8000)")).toBeCloseTo(
      0.95,
      5,
    );
    expect(
      parseCloneProgressFraction("Resolving deltas: 100% (8000/8000), done."),
    ).toBeCloseTo(1, 5);
    // Never goes backward across the phase boundary: receiving maxes at exactly
    // where resolving starts.
    expect(parseCloneProgressFraction("Receiving objects: 100% (1/1)")).toBeLessThanOrEqual(
      parseCloneProgressFraction("Resolving deltas: 0% (0/1)")!,
    );
  });

  it("ignores phases it does not track and non-progress lines", () => {
    // Remote-side pack prep is not tracked (it would make the bar jump back to 0
    // when Receiving starts).
    expect(
      parseCloneProgressFraction("remote: Compressing objects: 100% (45/45), done."),
    ).toBeNull();
    expect(parseCloneProgressFraction("remote: Counting objects: 100% (123/123)")).toBeNull();
    expect(parseCloneProgressFraction("Cloning into bare repository 'x.git'...")).toBeNull();
    expect(parseCloneProgressFraction("")).toBeNull();
  });

  it("clamps a malformed percentage into range", () => {
    expect(parseCloneProgressFraction("Receiving objects: 250% (x)")).toBeCloseTo(0.9, 5);
  });
});

/** A bare origin with enough objects that git emits real transfer progress. */
function makeOrigin(root: string): string {
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  execFileSyncQuiet(["init", "-q", "--bare", "-b", "main", bare]);
  execFileSyncQuiet(["init", "-q", "-b", "main", seed]);
  execFileSyncQuiet(["-C", seed, "config", "user.email", "t@t.dev"]);
  execFileSyncQuiet(["-C", seed, "config", "user.name", "T"]);
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(path.join(seed, `f${i}.txt`), `content ${i}\n`.repeat(50));
    execFileSyncQuiet(["-C", seed, "add", "-A"]);
    execFileSyncQuiet(["-C", seed, "commit", "-qm", `c${i}`]);
  }
  execFileSyncQuiet(["-C", seed, "push", "-q", bare, "HEAD:refs/heads/main"]);
  return bare;
}

/** Synchronous git, kept quiet — setup only, never the code under test. */
function execFileSyncQuiet(args: string[]): void {
  execFileSync("git", args, { stdio: "ignore" });
}

describe("runGitCloneWithProgress (integration, real git)", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("clones and streams a monotonic 0..1 progress that ends at completion", async () => {
    root = mkdtempSync(path.join(tmpdir(), "clone-progress-"));
    const bare = makeOrigin(root);
    const dest = path.join(root, "work");

    const fractions: number[] = [];
    await runGitCloneWithProgress(
      // `--no-local` forces the pack transport over file://, so git actually
      // transfers objects and prints "Receiving objects" — a plain local clone
      // hardlinks and prints nothing.
      ["clone", "--progress", "--no-local", `file://${bare}`, dest],
      { timeout: 60_000, env: process.env },
      (f) => fractions.push(f),
    );

    // The clone succeeded.
    const head = await exec("git", ["-C", dest, "rev-parse", "HEAD"]);
    expect(head.stdout.trim()).toHaveLength(40);

    // Progress fired, in range, non-decreasing, and reached the top of the bar.
    expect(fractions.length).toBeGreaterThan(0);
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < fractions.length; i += 1) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    expect(fractions[fractions.length - 1]!).toBeGreaterThanOrEqual(0.9);
  });

  it("rejects a failed clone with git's stderr intact (feeds gitErrorText/redaction)", async () => {
    root = mkdtempSync(path.join(tmpdir(), "clone-progress-fail-"));
    const dest = path.join(root, "work");
    const missing = path.join(root, "no-such-repo.git");

    // Three assertions must run: this fails outright if the clone did NOT throw.
    expect.assertions(3);
    try {
      await runGitCloneWithProgress(
        ["clone", "--progress", "--no-local", `file://${missing}`, dest],
        { timeout: 60_000, env: process.env },
      );
    } catch (error) {
      // The reject shape gitErrorText reads: a non-empty `.stderr` string.
      // `gitErrorText` takes `unknown` and parses internally — no cast here.
      expect(gitErrorText(error).length).toBeGreaterThan(0);
      // `.code` is validated with a schema, the same idiom gitErrorText uses.
      const rejection = z.object({ code: z.number().nullable() }).safeParse(error);
      expect(rejection.success).toBe(true);
      if (rejection.success) expect(rejection.data.code).not.toBe(0);
    }
  });
});
