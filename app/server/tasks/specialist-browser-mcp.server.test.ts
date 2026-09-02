import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import {
  BROWSER_MCP_NAME,
  browserPersonaSection,
  browserRuntimeStatus,
  resolveBrowserMcp,
} from "./specialist-browser-mcp.server";

/** R19-19 — the browser mount is CAPABILITY enforcement: granted ⇒ a real
 *  stdio config; withheld ⇒ the server simply does not exist for the run. */

const g = (
  capabilityId: string,
  mode: "direct" | "recommend" | "human" | "off",
) => ({ capabilityId, mode });

function tmpAttachments(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "viberr-battach-")), "attachments");
}

afterEach(() => {
  process.env.VIBERR_BROWSER_EXECUTABLE = "";
  resetEnvCacheForTests();
});

describe("R19-19 resolveBrowserMcp", () => {
  it("mounts NOTHING without an explicit direct grant — absence, off, and recommend are all withheld", () => {
    const dir = tmpAttachments();
    for (const grants of [
      [],
      [g("use-browser", "off")],
      [g("use-browser", "human")],
      // `recommend` has no agent runtime meaning and falls to the catalog
      // default (off) — the same polarity effectiveCollabMode gives verdicts.
      [g("use-browser", "recommend")],
    ]) {
      const r = resolveBrowserMcp({ grants, attachmentsDir: dir, backend: "claude" });
      expect(r.server).toBeNull();
      expect(r.refused).toBeNull();
    }
    // An ungranted browser creates no attachments dir either.
    expect(existsSync(dir)).toBe(false);
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("mounts the Playwright MCP CLI for a granted profile, writing into the task's attachments dir", () => {
    const dir = tmpAttachments();
    const r = resolveBrowserMcp({
      grants: [g("use-browser", "direct")],
      attachmentsDir: dir,
      backend: "claude",
    });
    expect(r.refused).toBeNull();
    const server = r.server!;
    expect(server.command).toBe(process.execPath);
    expect(server.args[0]).toMatch(/@playwright[\\/]mcp[\\/]cli\.js$/);
    // The CLI entry must actually exist — the config names a real file, not a
    // package spec that would download on first use.
    expect(existsSync(server.args[0]!)).toBe(true);
    expect(server.args).toContain("--headless");
    expect(server.args).toContain("--isolated");
    expect(server.args).toContain(dir);
    expect(server.args[server.args.indexOf("--output-dir") + 1]).toBe(dir);
    // No env: the config survives codex --config argv with full parity.
    expect("env" in server).toBe(false);
    // The attachments dir now exists for the MCP child to write into.
    expect(existsSync(dir)).toBe(true);
    // Host default: no executable override, no sandbox opt-out.
    expect(server.args).not.toContain("--executable-path");
    expect(server.args).not.toContain("--no-sandbox");
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("REFUSES the mount when web egress is withheld — the browser cannot re-acquire revoked egress", () => {
    const dir = tmpAttachments();
    const r = resolveBrowserMcp({
      grants: [g("use-browser", "direct"), g("use-web-search-fetch", "off")],
      attachmentsDir: dir,
      backend: "claude",
    });
    expect(r.server).toBeNull();
    expect(r.refused).not.toBeNull();
    expect(r.refused!.name).toContain(BROWSER_MCP_NAME);
    expect(r.refused!.reason).toContain("use-web-search-fetch");
    // A refused mount creates nothing.
    expect(existsSync(dir)).toBe(false);
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("absent egress means GRANTED egress (catalog default direct) — the browser mounts", () => {
    const dir = tmpAttachments();
    const r = resolveBrowserMcp({
      grants: [g("use-browser", "direct")],
      attachmentsDir: dir,
      backend: "claude",
    });
    expect(r.server).not.toBeNull();
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("omits image responses on codex, keeps them on claude", () => {
    const dir = tmpAttachments();
    const claude = resolveBrowserMcp({
      grants: [g("use-browser", "direct")],
      attachmentsDir: dir,
      backend: "claude",
    }).server!;
    const codex = resolveBrowserMcp({
      grants: [g("use-browser", "direct")],
      attachmentsDir: dir,
      backend: "codex",
    }).server!;
    expect(claude.args).not.toContain("--image-responses");
    expect(codex.args[codex.args.indexOf("--image-responses") + 1]).toBe("omit");
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("drives the deployment's chromium when VIBERR_BROWSER_EXECUTABLE is set — and only then drops the sandbox", () => {
    const dir = tmpAttachments();
    // A REAL executable on disk: the resolver now pre-flights the pinned binary
    // (a missing one is a refusal, below), so the passthrough test can only use
    // a path that actually exists. process.execPath is the portable stand-in.
    process.env.VIBERR_BROWSER_EXECUTABLE = process.execPath;
    resetEnvCacheForTests();
    const server = resolveBrowserMcp({
      grants: [g("use-browser", "direct")],
      attachmentsDir: dir,
      backend: "claude",
    }).server!;
    expect(server.args[server.args.indexOf("--executable-path") + 1]).toBe(
      process.execPath,
    );
    // docker's default seccomp blocks the user-namespace sandbox for the
    // non-root node user; the flag rides ONLY with the container executable.
    expect(server.args).toContain("--no-sandbox");
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("REFUSES the mount when the pinned browser executable is not on disk — a clean refusal, not a deep runtime failure", () => {
    const dir = tmpAttachments();
    process.env.VIBERR_BROWSER_EXECUTABLE =
      "/nonexistent/chromium-not-installed";
    resetEnvCacheForTests();
    const r = resolveBrowserMcp({
      grants: [g("use-browser", "direct")],
      attachmentsDir: dir,
      backend: "claude",
    });
    expect(r.server).toBeNull();
    expect(r.refused).not.toBeNull();
    expect(r.refused!.name).toContain(BROWSER_MCP_NAME);
    expect(r.refused!.reason).toContain("VIBERR_BROWSER_EXECUTABLE");
    expect(r.refused!.reason).toContain("chromium is not installed");
    // A refused mount creates nothing — no empty attachments dir left behind.
    expect(existsSync(dir)).toBe(false);
    rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});

describe("browserRuntimeStatus — the same gates as the mount, before a run is spent", () => {
  it("is available on a host with @playwright/mcp installed and no executable pinned", () => {
    // @playwright/mcp is a production dependency, so the CLI resolves; with no
    // VIBERR_BROWSER_EXECUTABLE the host uses Playwright's own resolution.
    expect(browserRuntimeStatus()).toEqual({ available: true });
  });

  it("is unavailable, with a reason, when the pinned executable is missing", () => {
    process.env.VIBERR_BROWSER_EXECUTABLE =
      "/nonexistent/chromium-not-installed";
    resetEnvCacheForTests();
    const s = browserRuntimeStatus();
    expect(s.available).toBe(false);
    expect(s.reason).toContain("VIBERR_BROWSER_EXECUTABLE");
    // C05-A (pass 32): the reason is served unauthenticated on the health
    // probe — it names the variable, never the configured host path. The path
    // rides on `detail`, which only org-admin surfaces relay.
    expect(s.reason).not.toContain("/nonexistent");
    expect(s.detail).toContain("/nonexistent/chromium-not-installed");
  });
});

describe("browserPersonaSection — the load-bearing screenshot contract", () => {
  // The whole default-name-vs-filename strategy hinges on the agent NOT passing
  // a filename (a self-named screenshot lands in the run workspace where no
  // human sees it). Pin the instruction so a persona reword can't silently drop
  // it, on both backends.
  it("always instructs a filename-less screenshot and points at the attachments dir", () => {
    for (const backend of ["claude", "codex"] as const) {
      const p = browserPersonaSection("tasks/VQP-1/attachments", backend);
      expect(p).toContain("WITHOUT a `filename`");
      expect(p).toContain("tasks/VQP-1/attachments");
    }
  });

  it("tells a Codex agent screenshots are not visible to it — and does NOT tell a Claude agent that", () => {
    const codex = browserPersonaSection("a/b", "codex");
    const claude = browserPersonaSection("a/b", "claude");
    expect(codex).toContain("does NOT return to you as an image");
    expect(codex).toContain("never claim you visually inspected");
    expect(claude).not.toContain("does NOT return to you as an image");
  });
});
