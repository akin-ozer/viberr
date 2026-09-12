import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  HERMETIC_TOOLCHAIN,
  primeHermeticToolchain,
  primeToolchain,
} from "../../../test-support/toolchain";
import {
  cachedToolchain,
  resetToolchainCacheForTests,
  resolveToolchain,
  versionOf,
  type CommandRunner,
} from "./toolchain.server";

/**
 * Ruling 182, narrowed by ruling 185: the once-per-process reading of what an
 * agent's shell would find on this host. The sandbox probe went with the
 * sandbox. Nothing here spawns a program: the runner is the seam.
 */
const ctx = createTestDbContext();

beforeEach(() => {
  // The suite is primed hermetic (setup-env); these tests drive the resolver.
  primeToolchain(null);
  resetToolchainCacheForTests();
});
afterEach(() => {
  ctx.cleanup();
  resetToolchainCacheForTests();
  primeHermeticToolchain();
});

/** A runner scripted per program: `null` stands for "not installed". */
function scriptedRunner(
  answers: Record<string, string | null>,
  seen: { command: string; args: readonly string[]; env?: Record<string, string> }[] = [],
): CommandRunner {
  return (command, args, options) => {
    seen.push({ command, args, env: options.env });
    const answer = answers[path.basename(command)];
    if (answer === null || answer === undefined) {
      return { ok: false, detail: `${command} is not installed` };
    }
    return { ok: true, stdout: answer };
  };
}

describe("versionOf", () => {
  it.each([
    ["v26.8.2\n", "26.8.2"],
    ["11.19.1\n", "11.19.1"],
    ["git version 2.45.0", "2.45.0"],
    ["Python 3.12.3", "3.12.3"],
    ["go version go1.23.1 darwin/arm64", "1.23.1"],
    ["1.2.3-rc.1+build", "1.2.3-rc.1+build"],
    ["not a version", null],
    ["", null],
    [null, null],
  ])("reads %j as %j", (text, expected) => {
    expect(versionOf(text)).toBe(expected);
  });
});

describe("resolveToolchain", () => {
  it("reports each tool's version, an honest null for an absent one, and the pinned CLI packages", () => {
    const seen: { command: string; args: readonly string[] }[] = [];
    const reading = resolveToolchain({
      run: scriptedRunner(
        { npm: "11.19.1\n", git: "git version 2.45.0\n", python3: null, go: "go version go1.23.1 linux/arm64\n" },
        seen,
      ),
    });
    expect(reading).toEqual({
      node: process.version.replace(/^v/, ""),
      npm: "11.19.1",
      git: "2.45.0",
      python3: null,
      go: "1.23.1",
      // The pins this checkout installs — real, read from the packages.
      codexCli: expect.stringMatching(/^\d+\.\d+\.\d+/),
      claudeAgentSdk: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
    // The key order is the health body's. Ruling 185 removed the trailing
    // `codexSandbox` verdict with the sandbox itself.
    expect(Object.keys(reading)).toEqual([
      "node", "npm", "git", "python3", "go", "codexCli", "claudeAgentSdk",
    ]);
    // argv only, never a shell; `go version` is go's own spelling.
    expect(seen.map((s) => `${s.command} ${s.args.join(" ")}`)).toEqual([
      "npm --version",
      "git --version",
      "python3 --version",
      "go version",
    ]);
  });

  it("matches the pinned @openai/codex the Codex SDK depends on", () => {
    const reading = resolveToolchain({ run: scriptedRunner({}) });
    const codexSdk = z.object({ version: z.string() }).parse(
      JSON.parse(
        readFileSync(path.join(process.cwd(), "node_modules", "@openai", "codex-sdk", "package.json"), "utf8"),
      ),
    );
    expect(reading.codexCli).toBe(codexSdk.version);
  });
});

describe("cachedToolchain", () => {
  it("resolves once per process and honours the suite's hermetic override", () => {
    // Without the override the real resolver would run: prove memoization on
    // a primed reading instead, then that the prime wins over the cache.
    primeToolchain({ ...HERMETIC_TOOLCHAIN, npm: "primed" });
    expect(cachedToolchain().npm).toBe("primed");
    expect(cachedToolchain()).toBe(cachedToolchain());
    primeToolchain({ ...HERMETIC_TOOLCHAIN, npm: "re-primed" });
    expect(cachedToolchain().npm).toBe("re-primed");
  });
});
