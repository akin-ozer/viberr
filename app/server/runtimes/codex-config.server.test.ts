import { mkdirSync, mkdtempSync, lstatSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexSessionRoots,
  prepareCodexHome,
  resolveCodexAuthSource,
  resolveCodexHome,
} from "./codex-config.server";

/**
 * P13-LV-13 / LV-14: a Codex run's isolation boundary IS its `CODEX_HOME`. The
 * SDK offers no `settingSources: []`/`skills: []` equivalent, and the CLI merges
 * `--config` overrides into whatever the home's `config.toml` declares — so a
 * run pointed at the operator's personal `~/.codex` inherits its MCP servers,
 * global + plugin skills, marketplaces, hooks and `AGENTS.md`. Runs therefore
 * get an app-owned home with the login's `auth.json` mirrored in, and nothing
 * else.
 */

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "viberr-codex-home-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  dirs.length = 0;
});

describe("resolveCodexHome / resolveCodexAuthSource", () => {
  it("runs get an app-owned home under the data root, never the login dir", () => {
    const env = { VIBERR_DATA_ROOT: "/data" } as NodeJS.ProcessEnv;
    expect(resolveCodexHome(env)).toBe("/data/runtimes/codex-home");
    // No CODEX_HOME → the login lives in the conventional personal dir, which
    // is exactly the dir a run must NOT execute in.
    expect(resolveCodexAuthSource(env)).toBe(path.join(os.homedir(), ".codex"));
    expect(resolveCodexHome(env)).not.toBe(resolveCodexAuthSource(env));
  });

  it("the container's existing CODEX_HOME recipe still resolves to one dir", () => {
    // Dockerfile: CODEX_HOME=/data/runtimes/codex-home, VIBERR_DATA_ROOT=/data.
    // The documented "copy auth.json here" recipe must keep working unchanged.
    const env = {
      VIBERR_DATA_ROOT: "/data",
      CODEX_HOME: "/data/runtimes/codex-home",
    } as NodeJS.ProcessEnv;
    expect(resolveCodexHome(env)).toBe(resolveCodexAuthSource(env));
    expect(codexSessionRoots(env)).toEqual(["/data/runtimes/codex-home"]);
  });

  it("searches the login dir too, so pre-split transcripts stay exportable", () => {
    const env = {
      VIBERR_DATA_ROOT: "/data",
      CODEX_HOME: "/home/dev/.codex",
    } as NodeJS.ProcessEnv;
    expect(codexSessionRoots(env)).toEqual([
      "/data/runtimes/codex-home",
      "/home/dev/.codex",
    ]);
  });
});

describe("prepareCodexHome", () => {
  it("creates the run home and mirrors the login's auth.json into it", () => {
    const root = tmp();
    const login = path.join(root, "login-codex");
    mkdirSync(login, { recursive: true });
    writeFileSync(path.join(login, "auth.json"), '{"tokens":"live"}');
    // Host clutter that must NOT follow the run: skills, plugins, config.
    mkdirSync(path.join(login, "skills", "github-yeet"), { recursive: true });
    writeFileSync(path.join(login, "config.toml"), '[mcp_servers.host_only]\ncommand = "x"\n');

    const env = {
      VIBERR_DATA_ROOT: path.join(root, "data"),
      CODEX_HOME: login,
    } as NodeJS.ProcessEnv;
    const result = prepareCodexHome(env);

    expect(result.home).toBe(path.join(root, "data", "runtimes", "codex-home"));
    expect(result.authMirrored).toBe(true);
    // Auth crossed over…
    expect(readFileSync(path.join(result.home, "auth.json"), "utf8")).toBe(
      '{"tokens":"live"}',
    );
    // …as a symlink, so a CLI token refresh stays coherent with the login.
    expect(lstatSync(path.join(result.home, "auth.json")).isSymbolicLink()).toBe(true);
    // …and nothing else did.
    expect(() => lstatSync(path.join(result.home, "config.toml"))).toThrow();
    expect(() => lstatSync(path.join(result.home, "skills"))).toThrow();
  });

  it("is idempotent and does not re-link an existing mirror", () => {
    const root = tmp();
    const login = path.join(root, "login-codex");
    mkdirSync(login, { recursive: true });
    writeFileSync(path.join(login, "auth.json"), "{}");
    const env = {
      VIBERR_DATA_ROOT: path.join(root, "data"),
      CODEX_HOME: login,
    } as NodeJS.ProcessEnv;

    expect(prepareCodexHome(env).authMirrored).toBe(true);
    expect(prepareCodexHome(env).authMirrored).toBe(false);
  });

  it("refreshes a plain-file mirror after a re-login", () => {
    const root = tmp();
    const login = path.join(root, "login-codex");
    const home = path.join(root, "data", "runtimes", "codex-home");
    mkdirSync(login, { recursive: true });
    mkdirSync(home, { recursive: true });
    // Simulate the symlink having been replaced by a real file (the CLI
    // rewrites auth.json atomically when it refreshes a subscription token).
    writeFileSync(path.join(home, "auth.json"), '{"tokens":"stale"}');
    writeFileSync(path.join(login, "auth.json"), '{"tokens":"fresh"}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path.join(home, "auth.json"), old, old);

    const env = {
      VIBERR_DATA_ROOT: path.join(root, "data"),
      CODEX_HOME: login,
    } as NodeJS.ProcessEnv;
    expect(prepareCodexHome(env).authMirrored).toBe(true);
    expect(readFileSync(path.join(home, "auth.json"), "utf8")).toBe(
      '{"tokens":"fresh"}',
    );
  });

  it("no login to mirror is not an error — the run home still exists", () => {
    const root = tmp();
    const env = {
      VIBERR_DATA_ROOT: path.join(root, "data"),
      CODEX_HOME: path.join(root, "nope"),
    } as NodeJS.ProcessEnv;
    const result = prepareCodexHome(env);
    expect(result.authMirrored).toBe(false);
    expect(lstatSync(result.home).isDirectory()).toBe(true);
  });
});
