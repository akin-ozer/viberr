import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  HERMETIC_TOOLCHAIN,
  primeHermeticToolchain,
  primeToolchain,
} from "../../../test-support/toolchain";
import {
  cachedToolchain,
  CODEX_SANDBOX_PROBE_DIR,
  CODEX_SANDBOX_PROBE_PROFILE,
  codexSandboxProbeConfig,
  probeCodexSandbox,
  resetToolchainCacheForTests,
  resolveToolchain,
  versionOf,
  type CommandRunner,
} from "./toolchain.server";

/**
 * Ruling 182: the once-per-process reading of what this host can run, and the
 * Codex sandbox probe that decides whether a sandboxed dispatch is refused.
 * Nothing here spawns a program: the runner is the seam.
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
  it("reports each tool's version, an honest null for an absent one, the pinned CLI packages and the sandbox verdict", () => {
    const seen: { command: string; args: readonly string[] }[] = [];
    const reading = resolveToolchain({
      run: scriptedRunner(
        { npm: "11.19.1\n", git: "git version 2.45.0\n", python3: null, go: "go version go1.23.1 linux/arm64\n" },
        seen,
      ),
      probeCodexSandbox: () => ({ ok: false, detail: "bwrap: No permissions to create a new namespace" }),
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
      codexSandbox: { ok: false, detail: "bwrap: No permissions to create a new namespace" },
    });
    // The key order is the health body's; `codexSandbox` comes last.
    expect(Object.keys(reading)).toEqual([
      "node", "npm", "git", "python3", "go", "codexCli", "claudeAgentSdk", "codexSandbox",
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
    const reading = resolveToolchain({
      run: scriptedRunner({}),
      probeCodexSandbox: () => ({ ok: true, detail: "faked" }),
    });
    const codexSdk = JSON.parse(
      readFileSync(path.join(process.cwd(), "node_modules", "@openai", "codex-sdk", "package.json"), "utf8"),
    ) as { version: string };
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

describe("probeCodexSandbox", () => {
  it("runs the CLI's own sandbox helper on /bin/echo in a throwaway home under the data root, and reads ok from the echo", () => {
    const root = ctx.makeTempDir();
    const seen: { command: string; args: readonly string[]; env?: Record<string, string> }[] = [];
    let configSeen: string | null = null;
    let homeExistedDuringRun = false;
    const run: CommandRunner = (command, args, options) => {
      seen.push({ command, args, env: options.env });
      const home = options.env?.CODEX_HOME ?? "";
      homeExistedDuringRun = existsSync(path.join(home, "config.toml"));
      configSeen = readFileSync(path.join(home, "config.toml"), "utf8");
      // The helper echoes the nonce back from inside the sandbox.
      return { ok: true, stdout: `${args.at(-1)}\n` };
    };
    const verdict = probeCodexSandbox({ run, dataRoot: root, codexBinary: "/opt/codex/bin/codex" });
    expect(verdict).toEqual({
      ok: true,
      detail: "codex sandbox ran /bin/echo under a workspace-write profile",
    });
    const call = seen[0]!;
    expect(call.command).toBe("/opt/codex/bin/codex");
    const probeRoot = path.join(root, "runtimes", CODEX_SANDBOX_PROBE_DIR);
    const work = path.join(probeRoot, "work");
    expect(call.args.slice(0, 7)).toEqual([
      "sandbox", "--permission-profile", CODEX_SANDBOX_PROBE_PROFILE, "-C", work, "--", "/bin/echo",
    ]);
    expect(call.args[7]).toMatch(/^viberr-sandbox-probe-\d+-/);
    // A throwaway home UNDER THE DATA ROOT (the CLI refuses helpers under a
    // temp dir), holding only the probe profile, and no credential-shaped env.
    expect(call.env?.CODEX_HOME).toBe(path.join(probeRoot, "home"));
    expect(call.env?.CODEX_SQLITE_HOME).toBe(path.join(probeRoot, "home"));
    expect(Object.keys(call.env ?? {}).filter((k) => /KEY|TOKEN|SECRET|AUTH/i.test(k))).toEqual([]);
    expect(homeExistedDuringRun).toBe(true);
    expect(configSeen).toBe(codexSandboxProbeConfig(work));
    expect(configSeen).toContain(`[permissions.${CODEX_SANDBOX_PROBE_PROFILE}.filesystem]`);
    expect(configSeen).toContain('"/" = "read"');
    expect(configSeen).toContain(`${JSON.stringify(work)} = "write"`);
    expect(configSeen).toContain("enabled = false");
    // Nothing is left behind.
    expect(existsSync(probeRoot)).toBe(false);
  });

  it("reports the CLI's own first line when the sandbox cannot start (F36-1's bwrap refusal)", () => {
    const root = ctx.makeTempDir();
    const verdict = probeCodexSandbox({
      run: () => ({ ok: false, detail: "bwrap: No permissions to create a new namespace" }),
      dataRoot: root,
      codexBinary: "/opt/codex/bin/codex",
    });
    expect(verdict).toEqual({ ok: false, detail: "bwrap: No permissions to create a new namespace" });
    expect(existsSync(path.join(root, "runtimes", CODEX_SANDBOX_PROBE_DIR))).toBe(false);
  });

  it("does not trust a zero exit whose output is not the nonce", () => {
    const verdict = probeCodexSandbox({
      run: () => ({ ok: true, stdout: "something else\n" }),
      dataRoot: ctx.makeTempDir(),
      codexBinary: "/opt/codex/bin/codex",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("did not come back");
  });

  it("names a missing Codex package instead of probing nothing", () => {
    let ran = false;
    const verdict = probeCodexSandbox({
      run: () => {
        ran = true;
        return { ok: true, stdout: "" };
      },
      dataRoot: ctx.makeTempDir(),
      codexBinary: null,
    });
    expect(ran).toBe(false);
    expect(verdict).toEqual({
      ok: false,
      detail: "the @openai/codex package is not installed in this deployment",
    });
  });
});
