import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../../../test-support/env";
import { createTempDirs } from "../../../test-support/temp-dirs";
import { BROWSER_CALL_DEADLINE_MS } from "./browser-deadline.server";
import {
  BROWSER_MCP_NAME,
  attachmentsDropSection,
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

const temp = createTempDirs();
afterEach(temp.cleanup);

function tmpAttachments(): string {
  return path.join(temp.make("viberr-battach-"), "attachments");
}

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
  });

  it("mounts the Playwright MCP CLI for a granted profile, writing into the task's attachments dir", () => {
    const dir = tmpAttachments();
    const r = resolveBrowserMcp({
      // No `use-web-search-fetch` grant: absent egress is the catalog default, direct.
      grants: [g("use-browser", "direct")],
      attachmentsDir: dir,
      backend: "claude",
    });
    expect(r.refused).toBeNull();
    const server = r.server!;
    expect(server.command).toBe(process.execPath);
    // Ruling 554: the server runs under the supervisor, which node runs as
    // TypeScript. CANARY: mount the CLI bare and a page that stops answering
    // holds the agent's browser for the rest of the run.
    expect(server.args[0]).toMatch(/[\\/]browser-supervisor\.server\.ts$/);
    // The deadline the supervisor keeps is the one Codex is told to outwait.
    expect(server.args.slice(1, 3)).toEqual(["--deadline-ms", String(BROWSER_CALL_DEADLINE_MS)]);
    expect(server.args[3]).toMatch(/@playwright[\\/]mcp[\\/]cli\.js$/);
    // Both entries must actually exist — the config names real files, not a
    // package spec that would download on first use.
    expect(existsSync(server.args[0]!)).toBe(true);
    expect(existsSync(server.args[3]!)).toBe(true);
    expect(server.args).toContain("--headless");
    expect(server.args).toContain("--isolated");
    // A page's WebMCP tools would reach the agent's tool list with text the
    // page wrote; drop the flag and @playwright/mcp lists them by default.
    expect(server.args).toContain("--no-webmcp");
    expect(server.args).toContain(dir);
    expect(server.args[server.args.indexOf("--output-dir") + 1]).toBe(dir);
    // No env: the config survives codex --config argv with full parity.
    expect("env" in server).toBe(false);
    // The attachments dir now exists for the MCP child to write into.
    expect(existsSync(dir)).toBe(true);
    // Host default: no executable override, no sandbox opt-out.
    expect(server.args).not.toContain("--executable-path");
    expect(server.args).not.toContain("--no-sandbox");
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
  });

  it("drives the deployment's chromium when VIBERR_BROWSER_EXECUTABLE is set — and only then drops the sandbox", async () => {
    const dir = tmpAttachments();
    // A REAL executable on disk: the resolver now pre-flights the pinned binary
    // (a missing one is a refusal, below), so the passthrough test can only use
    // a path that actually exists. process.execPath is the portable stand-in.
    const server = await withEnv({ VIBERR_BROWSER_EXECUTABLE: process.execPath }, () =>
      resolveBrowserMcp({
        grants: [g("use-browser", "direct")],
        attachmentsDir: dir,
        backend: "claude",
      }).server!,
    );
    expect(server.args[server.args.indexOf("--executable-path") + 1]).toBe(
      process.execPath,
    );
    // docker's default seccomp blocks the user-namespace sandbox for the
    // non-root node user; the flag rides ONLY with the container executable.
    expect(server.args).toContain("--no-sandbox");
  });

  it("REFUSES the mount when the pinned browser executable is not on disk — a clean refusal, not a deep runtime failure", async () => {
    const dir = tmpAttachments();
    const r = await withEnv({ VIBERR_BROWSER_EXECUTABLE: "/nonexistent/chromium-not-installed" }, () =>
      resolveBrowserMcp({
        grants: [g("use-browser", "direct")],
        attachmentsDir: dir,
        backend: "claude",
      }),
    );
    expect(r.server).toBeNull();
    expect(r.refused).not.toBeNull();
    expect(r.refused!.name).toContain(BROWSER_MCP_NAME);
    expect(r.refused!.reason).toContain("VIBERR_BROWSER_EXECUTABLE");
    expect(r.refused!.reason).toContain("chromium is not installed");
    // A refused mount creates nothing — no empty attachments dir left behind.
    expect(existsSync(dir)).toBe(false);
  });
});

describe("browserRuntimeStatus — the same gates as the mount, before a run is spent", () => {
  it("is available on a host with @playwright/mcp installed and no executable pinned", () => {
    // @playwright/mcp is a production dependency, so the CLI resolves; with no
    // VIBERR_BROWSER_EXECUTABLE the host uses Playwright's own resolution.
    expect(browserRuntimeStatus()).toEqual({ available: true });
  });

  it("is unavailable, with a reason, when the pinned executable is missing", async () => {
    const s = await withEnv(
      { VIBERR_BROWSER_EXECUTABLE: "/nonexistent/chromium-not-installed" },
      browserRuntimeStatus,
    );
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
      const p = browserPersonaSection("/data/projects/vqp/tasks/VQP-1/attachments", backend);
      expect(p).toContain("WITHOUT a `filename`");
      expect(p).toContain("/data/projects/vqp/tasks/VQP-1/attachments");
    }
  });

  /**
   * Ruling 159 (pass 35, F35-10): the path the agent is handed is ABSOLUTE and
   * said to be outside the checkout. The store-relative form
   * (`projects/<slug>/tasks/<key>/attachments`, "reachable from your working
   * directory") was created inside the clone by KNC-9's agent and pushed.
   */
  it("ruling 159: the browser section says the dir is outside the checkout and never committed", () => {
    const p = browserPersonaSection("/data/projects/vqp/tasks/VQP-1/attachments", "claude");
    expect(p).toContain("outside the repository checkout");
    expect(p).toContain("never commit it");
  });
});

describe("attachmentsDropSection — ruling 159, an absolute path outside the checkout", () => {
  const dir = "/data/projects/knc/tasks/KNC-9/attachments";
  it("prints the absolute dir, says it is outside the checkout and never to commit it", () => {
    const p = attachmentsDropSection(dir);
    expect(path.isAbsolute(dir)).toBe(true);
    expect(p).toContain(`\`${dir}\``);
    expect(p).toContain("ABSOLUTE path");
    expect(p).toContain("outside the repository checkout");
    expect(p).toContain("never commit it");
    // The sentence that produced the stray folder is gone for good.
    expect(p).not.toContain("reachable from your working directory");
  });

  /**
   * Ruling 306 (pass 37, F37-141): the attachments directory is READ as well as
   * written, and nothing said so.
   *
   * It shipped as a drop box, which is half of what it is. On a task that has
   * run before it already holds what every earlier run attached — 27 files on
   * SHOP-11 of this instance's board, 90 on SHOP-15 — so an agent reworking
   * that task was standing next to the evidence its directive was summarising,
   * and was told only where to put things. That is rulings 285/292/293 one
   * actor over: the coordinator was given the evidence so it would stop
   * relaying claims about files it had not read, and the agent doing the work
   * was left relaying them.
   */
  it("ruling 306: names the directory as two-way, and says to read by citation rather than wholesale", () => {
    const text = attachmentsDropSection("/data/projects/p/tasks/P-1/attachments");
    // CANARY: restore the write-only framing.
    expect(text).toContain("TWO-WAY");
    expect(text).toContain("READING");
    expect(text).toContain("on a task that has run before, the files those runs attached");
    // The half that keeps it from eating a context: cite, do not sweep.
    expect(text).toContain("by name");
    expect(text).toContain("not the whole folder");
    // And the sentence that says why it matters at all.
    expect(text).toContain("only one of them is evidence");
    // The posting half survives intact.
    expect(text).toContain("POSTING");
    expect(text).toContain("images render inline");
  });

  /**
   * Ruling 530: on a board that delivers results, a task's input is usually a
   * person's attachment and its deliverable is the result's files. The section
   * named only earlier runs' files, and sent every large artifact to the
   * repository and the pull request, which is where an estimate the board was
   * asked to make would have gone.
   */
  it("ruling 530: names a person's attachment as input to read, and keeps a result that is the deliverable out of every commit", () => {
    const text = attachmentsDropSection("/data/projects/p/tasks/P-1/attachments");
    // CANARY: drop the result sentence, and an agent on a results board reads
    // only that large artifacts belong in the pull request.
    expect(text).toContain("it holds the files people attached to this task, such as an input the goal asks you to work from");
    expect(text).toContain("On a task that changes the repository, code and large artifacts belong in the repository and the pull request");
    expect(text).toContain("the result's files go here and never into a commit");
  });

  it("never prints a bare store-relative path as the instruction", () => {
    const p = attachmentsDropSection(dir);
    // Every `projects/...` mention in the section is the absolute dir itself.
    for (const m of p.matchAll(/`([^`]*projects\/[^`]*)`/g)) {
      expect(path.isAbsolute(m[1]!)).toBe(true);
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
