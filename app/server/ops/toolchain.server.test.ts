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
  shellInventoryPrompt,
  versionOf,
  type CommandRunner,
  type Toolchain,
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
        {
          npm: "11.19.1\n",
          git: "git version 2.45.0\n",
          python3: null,
          go: "go version go1.23.1 linux/arm64\n",
          // Ruling 191: `make` answers, the rest do not — the live shape.
          make: "GNU Make 4.4.1\n",
          docker: null,
          pnpm: null,
          yarn: null,
          curl: null,
        },
        seen,
      ),
    });
    expect(reading).toEqual({
      node: process.version.replace(/^v/, ""),
      npm: "11.19.1",
      git: "2.45.0",
      python3: null,
      go: "1.23.1",
      make: "4.4.1",
      docker: null,
      pnpm: null,
      yarn: null,
      curl: null,
      // The pins this checkout installs — real, read from the packages.
      codexCli: expect.stringMatching(/^\d+\.\d+\.\d+/),
      claudeAgentSdk: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
    // The key order is the health body's. Ruling 185 removed the trailing
    // `codexSandbox` verdict with the sandbox itself; ruling 191 added the five
    // a run reaches for and cannot install.
    expect(Object.keys(reading)).toEqual([
      "node", "npm", "git", "python3", "go",
      "make", "docker", "pnpm", "yarn", "curl",
      "codexCli", "claudeAgentSdk",
    ]);
    // argv only, never a shell; `go version` is go's own spelling.
    expect(seen.map((s) => `${s.command} ${s.args.join(" ")}`)).toEqual([
      "npm --version",
      "git --version",
      "python3 --version",
      "go version",
      "make --version",
      "docker --version",
      "pnpm --version",
      "yarn --version",
      "curl --version",
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

/**
 * Ruling 191 (F37-13, live): the reading existed and nobody who needed it could
 * see it. Pass 37's host had node, npm and git and nothing else; the controller
 * chose a pnpm + turbo monorepo with a root `Makefile` and a Docker Compose
 * stack, and chartered a REQUIRED reviewer whose pass opens "clean checkout,
 * `make up`, everything healthy" — so that reviewer's verdict could only ever
 * be request_changes, and the deliverer was sent back over it.
 */
describe("shellInventoryPrompt (ruling 191)", () => {
  const host = (over: Partial<Toolchain>): Toolchain => ({
    ...HERMETIC_TOOLCHAIN,
    ...over,
  });

  it("splits present from absent and names each tool the run can call", () => {
    const text = shellInventoryPrompt(host({}));
    expect(text).toContain("Present: node 26.0.0-test, npm 11.0.0-test, git 2.50.0-test.");
    // CANARY: drop a tool from SHELL_TOOLS and it stops being named at all —
    // which is the defect, not a tidier prompt.
    expect(text).toContain(
      "NOT installed: make, docker, pnpm, yarn, curl, python3, go.",
    );
  });

  it("separates what `npx` can rescue from what the OS was meant to provide", () => {
    const text = shellInventoryPrompt(host({}));
    // The two cases must not read alike: `npx pnpm` genuinely works here and
    // `npx make` never will, so one sentence cannot cover both.
    expect(text).toContain("npx <tool>");
    expect(text).toContain("cannot be installed from here at all");
  });

  it("tells a reviewer that an unrun check is not a pass and not the deliverable's fault", () => {
    const text = shellInventoryPrompt(host({}));
    expect(text).toContain("never report an unrun check as a pass");
    expect(text).toContain("never treat one as the deliverable's fault");
  });

  it("never prints an absence list on a host that has everything", () => {
    const full = host({
      python3: "3.12.3",
      go: "1.23.1",
      make: "4.4.1",
      docker: "27.0.0",
      pnpm: "9.0.0",
      yarn: "4.0.0",
      curl: "8.9.0",
    });
    const text = shellInventoryPrompt(full);
    expect(text).not.toContain("NOT installed");
    expect(text).toContain("Every tool this probe knows about is installed.");
  });

  it("does not offer the agent the runtimes that spawn it", () => {
    const text = shellInventoryPrompt(host({}));
    // `codexCli` and `claudeAgentSdk` are how the run STARTS. Listing them as
    // shell tools invites an agent to drive its own backend.
    expect(text).not.toContain("codexCli");
    expect(text).not.toContain("claudeAgentSdk");
  });
});

/**
 * Ruling 196 (owner, pass 37): the image ships the three tools an agent reaches
 * for first and cannot install for itself. Ruling 191 stopped agents
 * rediscovering the gap one exit-127 at a time; this closed the cheap part of
 * it. A unit test cannot inspect a built image, so it pins the Dockerfile —
 * which is the artifact that changed, and deleting the line makes this red.
 */
describe("ruling 196: the runtime image installs what a run reaches for", () => {
  const dockerfile = (): string =>
    readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");

  it("installs make, curl and a pinned pnpm", () => {
    const text = dockerfile();
    expect(text).toMatch(/apt-get install -y --no-install-recommends make curl/);
    // Pinned, not `pnpm@latest`: an image whose package manager changes under
    // a rebuild is a toolchain nobody measured.
    expect(text).toMatch(/npm install -g pnpm@\d+\.\d+\.\d+/);
  });

  it("does NOT install docker, and says why", () => {
    const text = dockerfile();
    // CANARY: add a docker install here and this fails. The daemon socket is a
    // posture change (an agent holding it controls every container on the
    // host), and ruling 196 deliberately left it out; the shell inventory tells
    // every run that a Compose stack cannot come up in this image.
    expect(text).not.toMatch(/install[^\n]*\bdocker(-ce|\.io)?\b/);
    expect(text).toMatch(/docker-in-docker is a posture change/);
  });
});
