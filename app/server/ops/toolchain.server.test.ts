import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
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
  PROBE_LIMIT,
  cachedToolchain,
  probeTool,
  probeTools,
  resolveToolchain,
  shellInventoryPrompt,
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
});
afterEach(() => {
  ctx.cleanup();
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

describe("the version a --version answer carries", () => {
  it.each([
    ["v26.8.2\n", "26.8.2"],
    ["11.19.1\n", "11.19.1"],
    ["git version 2.45.0", "2.45.0"],
    ["Python 3.12.3", "3.12.3"],
    ["go version go1.23.1 darwin/arm64", "1.23.1"],
    ["1.2.3-rc.1+build", "1.2.3-rc.1+build"],
    ["not a version", null],
    ["", null],
  ])("reads %j as %j", (stdout, expected) => {
    expect(resolveToolchain({ run: () => ({ ok: true, stdout }) }).npm).toBe(expected);
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
    // Resolved the way Node resolves, never from the cwd. A git worktree has
    // no `node_modules` of its own and borrows the parent checkout's install,
    // so `process.cwd()/node_modules/...` named a path that does not exist and
    // this test — alone in the whole suite — died on ENOENT while the resolver
    // it checks worked fine. `resolveToolchain` anchors its own lookup on
    // `import.meta.url` (`pinnedPackageVersion`), so anchoring here too is what
    // makes the two agree on WHICH install they are reading.
    //
    // `findPackageJSON` and not `require.resolve`: the SDK's `exports` map
    // publishes `.` under the `import` condition alone, which hides both
    // `./package.json` and the CJS entry, so every `resolve` spelling of this
    // package throws ERR_PACKAGE_PATH_NOT_EXPORTED. Finding the manifest of a
    // package Node can resolve is exactly what this call is for.
    //
    // An absent package throws out of `findPackageJSON` itself, naming the
    // package and the importer; `undefined` is the narrower case of a package
    // that resolves with no manifest above its entry, so say THAT rather than
    // reporting every failure here as "not installed".
    const manifest = findPackageJSON("@openai/codex-sdk", import.meta.url);
    if (!manifest) throw new Error("@openai/codex-sdk resolved with no package.json above it");
    const codexSdk = z.object({ version: z.string() }).parse(
      JSON.parse(readFileSync(manifest, "utf8")),
    );
    expect(reading.codexCli).toBe(codexSdk.version);
  });
});

describe("cachedToolchain", () => {
  it("returns the primed reading, and a re-prime wins over it", () => {
    // Without the override the real resolver would run and spawn the host's
    // programs, so only the override path is driven here.
    primeToolchain({ ...HERMETIC_TOOLCHAIN, npm: "primed" });
    expect(cachedToolchain().npm).toBe("primed");
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

  /**
   * Ruling 275 (pass 37, F37-108): ruling 191 put this measurement into every
   * prompt and it says what the host lacks — it did not say "and the role
   * description above plans around three of them". A contradiction inside one
   * prompt is resolved by the model, and the persona is the half written with
   * more authority and read first. Live on this instance: the Infrastructure
   * Engineer's persona said "you own … the Docker Compose stack" and "`make
   * up` is your headline deliverable and it must be honest", while it ran two
   * tasks on a host with neither.
   */
  it("ruling 275: names the absent tools the run's OWN persona plans around", () => {
    const persona =
      "You own the shared surfaces: the workspace scaffolding, the Docker Compose stack, " +
      "and the CI pipeline. `make up` is your headline deliverable.";
    const text = shellInventoryPrompt(host({}), persona);
    // CANARY: drop the persona scan and the prompt lists "NOT installed:
    // make, docker, …" a paragraph under a role description that says the
    // stack is yours, and leaves the reader to notice.
    expect(text).toContain("Your own role description above mentions `make`, `docker`");
    expect(text).toContain("not on this host");
    expect(text).toContain("exits 127");
  });

  it("ruling 636: sends scratch files to the run's own $TMPDIR, never /tmp itself", () => {
    // Every prompt that describes the shell says it: a specialist's, and the
    // operator's and the controller's about the agents they dispatch.
    // CANARY: drop the push and nothing says where scratch goes, so an agent
    // writes /tmp, which every later run of its person can read.
    const text = shellInventoryPrompt(host({}));
    expect(text).toContain("Temporary files go in `$TMPDIR`: each run has its own");
    expect(text).toContain("Nothing goes in `/tmp` itself");
  });

  it("ruling 275: says nothing when the persona plans around what is actually here", () => {
    // CANARY: match on substrings instead of word boundaries and "nodemon" or
    // "encurl" would name `node`/`curl`; scan the PRESENT tools too and a
    // persona that correctly says "run npm test" gets contradicted.
    const clean = shellInventoryPrompt(
      host({}),
      "You write TypeScript and run the suite with npm. Read the git history first. " +
        "Prefer curly braces on every block.",
    );
    // "curly" contains "curl", and `curl` is absent here — a substring match
    // would name it off a sentence about brace style.
    expect(clean).not.toContain("Your own role description");
    // A tool that is PRESENT is never flagged, however often it is named.
    expect(shellInventoryPrompt(host({ docker: "27.0" }), "Bring the docker stack up.")).not.toContain(
      "Your own role description",
    );
    // `go` is excluded on purpose: it is an ordinary English word, and a
    // persona saying "go and read the tests" is not a plan against a Go
    // toolchain. CANARY: include it and every prose persona trips this.
    expect(
      shellInventoryPrompt(host({}), "Go and read the tests before you change anything."),
    ).not.toContain("Your own role description");
  });

  it("separates what `npx` can rescue from what the OS was meant to provide", () => {
    const text = shellInventoryPrompt(host({}));
    // The two cases must not read alike: `npx pnpm` genuinely works here and
    // `npx make` never will, so one sentence cannot cover both.
    expect(text).toContain("`pnpm` and `yarn` can still be fetched with `npx <tool>`");
    expect(text).toContain(
      "`make`, `docker`, `curl`, `python3`, `go` come from the operating system and " +
        "cannot be installed from here at all",
    );
  });

  /**
   * Self-review: the advice half was two hardcoded sentences. Both could lie —
   * one by promising `npx` on a host with no npm, the other by naming an
   * INSTALLED tool as its example of something uninstallable, which is exactly
   * what happened the moment ruling 196 put `make` and `curl` in the image.
   */
  it("derives both halves of the advice from the reading, so neither can go stale", () => {
    // Ruling 196's host: make and curl present, docker still absent.
    const shipped = shellInventoryPrompt(
      host({ make: "4.4.1", curl: "8.14.1", pnpm: "12.4.1" }),
    );
    // CANARY: hardcode the examples again and `make`/`curl` reappear in the
    // uninstallable list on a host that has them.
    expect(shipped).toContain("`docker`, `python3`, `go` come from the operating system");
    expect(shipped).not.toContain("`make`, `docker`");
    // pnpm is present now, so only yarn is offered through npx.
    expect(shipped).toContain("`yarn` can still be fetched");

    // A host with no npm must not be told to run `npx`.
    const bare = shellInventoryPrompt(host({ npm: null }));
    expect(bare).not.toContain("npx <tool>");
    expect(bare).toContain("npm is not here either, so nothing can be fetched");
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

  it("ruling 566: installs poppler-utils, in a layer after chromium", () => {
    // Live on the AWS calculator board three of four result runs could not
    // render a PDF export, and one that decoded it by hand was killed past 5 GB
    // of output. CANARY: delete the install line and this fails; move it before
    // chromium and the second expectation fails (the chromium layer re-fetches).
    const text = dockerfile();
    const poppler = text.search(/apt-get install -y --no-install-recommends poppler-utils/);
    expect(poppler).toBeGreaterThan(-1);
    expect(poppler).toBeGreaterThan(text.search(/install -y --no-install-recommends chromium/));
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

/**
 * F39-1 (pass 39): probing a command the fixed {@link Toolchain} struct does
 * not name.
 *
 * Live, the controller was briefed with four Go gates, could verify three of
 * them off `instance_health`, and had no way at all to ask about the fourth. It
 * wrote "golangci-lint is NOT preinstalled" into the project's BINDING rulings
 * and spent a delivery task discovering it was wrong. Nothing here spawns a
 * program: the runner is the seam, exactly as above.
 */
describe("F39-1: probeTool", () => {
  /** A runner that reports which argv it was handed, and answers for `present`. */
  const runnerFor = (present: readonly string[], version = "golangci-lint 2.6.0") => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const run: CommandRunner = (command, args) => {
      calls.push({ command, args });
      if (command === "/bin/sh") {
        const name = args[args.length - 1]!;
        return present.includes(name)
          ? { ok: true, stdout: `/usr/local/bin/${name}\n` }
          : { ok: false, detail: "exit 1" };
      }
      return { ok: true, stdout: version };
    };
    return { run, calls };
  };

  it("reports a present command with its version, and an absent one with a reason", () => {
    const { run } = runnerFor(["golangci-lint"]);
    expect(probeTool("golangci-lint", { run })).toEqual({
      name: "golangci-lint",
      present: true,
      version: "2.6.0",
    });
    expect(probeTool("gofmt", { run })).toEqual({
      name: "gofmt",
      present: false,
      reason: "gofmt is not on PATH",
    });
  });

  it("a present command whose --version says nothing is still present", () => {
    const { run } = runnerFor(["ssh"], "OpenSSH_9.6p1");
    // No semver-shaped token: `present` is the fact the caller asked for, and
    // a missing version must not read as a missing binary.
    expect(probeTool("ssh", { run })).toEqual({
      name: "ssh",
      present: true,
      version: null,
    });
  });

  it("passes the name as an ARGUMENT, never interpolated into the script", () => {
    const { run, calls } = runnerFor(["gofmt"]);
    probeTool("gofmt", { run });
    const lookup = calls[0]!;
    expect(lookup.command).toBe("/bin/sh");
    // CANARY: build the script as `command -v ${name}` and this goes red — the
    // name would then be shell code rather than data.
    expect(lookup.args[1]).toBe('command -v -- "$1"');
    expect(lookup.args[1]).not.toContain("gofmt");
    expect(lookup.args[lookup.args.length - 1]).toBe("gofmt");
  });

  it("refuses a name that is a path, a flag or a shell fragment WITHOUT running anything", () => {
    for (const bad of [
      "/usr/bin/go",
      "go; rm -rf /",
      "go && curl evil",
      "--version",
      "$(whoami)",
      "go test",
      "",
      "a".repeat(65),
    ]) {
      const { run, calls } = runnerFor([]);
      const probed = probeTool(bad, { run });
      expect(probed.present, bad).toBe(false);
      expect(probed.present === false && probed.reason, bad).toContain(
        "not a command name",
      );
      // CANARY: relax PROBE_NAME_RE and these reach a child process.
      expect(calls, bad).toHaveLength(0);
    }
    // A dot, a plus or a dash still makes a bare command name, which is probed.
    for (const good of ["golangci-lint", "go1.25.1", "g++"]) {
      expect(probeTool(good, { run: runnerFor([good]).run }).present, good).toBe(true);
    }
  });

  it("probeTools de-duplicates, keeps order, caps the count and memoizes a tool it found", () => {
    const { run, calls } = runnerFor(["go"]);
    const first = probeTools(["go", "gofmt", "go", " gofmt "], { run });
    expect(first.map((p) => p.name)).toEqual(["go", "gofmt"]);
    const spawnsAfterFirst = calls.length;
    // Memoized: a second ask for a tool that was there spawns nothing more.
    probeTools(["go"], { run });
    expect(calls).toHaveLength(spawnsAfterFirst);

    const many = probeTools(
      Array.from({ length: PROBE_LIMIT + 5 }, (_, i) => `tool${i}`),
      { run },
    );
    // CANARY: drop the cap and an unbounded list becomes an unbounded number of
    // child processes on a read any asker can make.
    expect(many).toHaveLength(PROBE_LIMIT);
  });

  /**
   * The probe is how a gate is checked before it is promised, and the answer
   * to "golangci-lint is not on PATH" is a person installing it. A cached miss
   * kept saying it was absent until the server restarted.
   */
  it("asks again about a tool it did not find, so an install is seen", () => {
    const before = runnerFor([]);
    expect(probeTools(["golangci-lint"], { run: before.run })[0]!.present).toBe(false);
    const after = runnerFor(["golangci-lint"]);
    // CANARY: cache the miss again and this still reads absent.
    expect(probeTools(["golangci-lint"], { run: after.run })[0]).toEqual({
      name: "golangci-lint",
      present: true,
      version: "2.6.0",
    });
  });
});
