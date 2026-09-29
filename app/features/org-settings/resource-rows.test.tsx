// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { KbView, McpView } from "~/server/org/resources.server";
import { KbPanel, McpPanel } from "./resource-rows";

afterEach(cleanup);

const MCP: McpView = {
  id: "mcp_1",
  name: "github-mcp",
  transport: "HTTP",
  target: "https://mcp.example/github",
  hasCred: false,
  tools: 4,
  up: true,
  lastCheckedAt: null,
  lastError: null,
  warmingSince: null,
  writeTools: [],
  writeToolsReviewed: true,
  discoveredTools: null,
  storePaths: [],
};

const KB: KbView = {
  id: "kb_1",
  name: "Architecture",
  dir: "architecture",
  refresh: "on change",
  lastIndexedAt: null,
  tree: [],
  fileCount: 3,
  injectableCount: 3,
  folderExists: true,
  private: false,
  uri: "store://kb/architecture",
};

const noop = () => {};

/**
 * Ruling 368: a probe in flight shows itself on the row control that started
 * it. The Test and Re-scan icons spun, but the button stayed pressable (a
 * second press re-posted the probe) and its name still offered the action.
 * Now the one in flight is `aria-busy` and disabled, the loader spins where
 * the refresh glyph was, and its name says the work.
 * Canary: drop `aria-busy` from the MCP Test button in `resource-rows.tsx`.
 */
describe("resource rows: the probe in flight", () => {
  it("an MCP test in flight: Testing, busy, the loader spinning; the other row at rest", () => {
    const { getByLabelText } = render(
      <McpPanel
        mcps={[MCP, { ...MCP, id: "mcp_2", name: "linear-mcp" }]}
        usedBy={() => 0}
        testing="mcp_1"
        onNew={noop}
        onTest={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    const busy = getByLabelText("Testing github-mcp");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.getAttribute("title")).toBe("Testing…");
    expect(busy.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
    const idle = getByLabelText("Test linear-mcp");
    expect(idle.hasAttribute("aria-busy")).toBe(false);
    expect(idle.hasAttribute("disabled")).toBe(false);
    // Ruling 459: the loader rests hidden in the glyph's cell (GlyphSwap).
    expect(idle.querySelector(".copy-glyph[data-copied]")).toBeNull();
  });

  it("a knowledge-base re-scan in flight: Re-scanning, busy, the loader spinning", () => {
    const { getByLabelText } = render(
      <KbPanel
        kbs={[KB]}
        usedBy={() => 0}
        reindexing="kb_1"
        onNew={noop}
        onBrowse={noop}
        onReindex={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    const busy = getByLabelText("Re-scanning Architecture");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(busy.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
  });
});

describe("resource rows: a private knowledge base (ruling 578)", () => {
  it("says who reads a private one, and keeps the live-folder line for an open one", () => {
    // CANARY: drop the `kb.private` branch and the private row reads like an
    // open one, which every agent's shell can read.
    const { container } = render(
      <KbPanel
        kbs={[{ ...KB, id: "kb_2", name: "Answer keys", dir: "answer-keys", private: true }, KB]}
        usedBy={() => 0}
        reindexing={null}
        onNew={noop}
        onBrowse={noop}
        onReindex={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    const rows = [...container.querySelectorAll(".rsrc-row")].map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("private: only the runs it is granted read it");
    expect(rows[0]).not.toContain("agents read the live folder");
    expect(rows[1]).toContain("agents read the live folder");
  });
});
