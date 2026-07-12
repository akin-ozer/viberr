import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KB_INJECTION_BUDGET, readKbBody } from "./kb-injection.server";

function freshKb(dir = "notes"): { dataRoot: string; kbDir: string } {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-kb-"));
  const kbDir = path.join(dataRoot, "kb", dir);
  mkdirSync(kbDir, { recursive: true });
  return { dataRoot, kbDir };
}

describe("readKbBody — recursive, multi-format KB injection", () => {
  it("reads a top-level .md doc (the previously-working seed shape)", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "overview.md"), "# Top\nMARKER-TOP", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-TOP");
    expect(body).toContain("### overview.md");
  });

  it("reads NESTED docs — the GitHub-import / folder-upload bug (was silently dropped)", () => {
    const { dataRoot, kbDir } = freshKb();
    // importGithubSnapshot always nests under <folder>/… — reproduce that shape.
    const nested = path.join(kbDir, "my-repo", "docs");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "guide.md"), "# Guide\nMARKER-NESTED-DEEP", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-NESTED-DEEP");
    // heading carries the store-relative path so the agent can cite it
    expect(body).toContain("### my-repo/docs/guide.md");
  });

  it("reads non-.md text docs (.txt/.mdx/.rst/.markdown), not only .md", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "a.txt"), "MARKER-TXT", "utf8");
    writeFileSync(path.join(kbDir, "b.mdx"), "MARKER-MDX", "utf8");
    writeFileSync(path.join(kbDir, "c.rst"), "MARKER-RST", "utf8");
    writeFileSync(path.join(kbDir, "d.markdown"), "MARKER-MARKDOWN", "utf8");
    const body = readKbBody("notes", dataRoot);
    for (const m of ["MARKER-TXT", "MARKER-MDX", "MARKER-RST", "MARKER-MARKDOWN"]) {
      expect(body).toContain(m);
    }
  });

  it("ignores non-text binary-ish extensions", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "keep.md"), "MARKER-KEEP", "utf8");
    writeFileSync(path.join(kbDir, "skip.png"), "not-text", "utf8");
    writeFileSync(path.join(kbDir, "skip.json"), '{"x":1}', "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-KEEP");
    expect(body).not.toContain("skip.png");
    expect(body).not.toContain("skip.json");
  });

  it("skips dotfiles and dot-directories", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, ".hidden.md"), "MARKER-HIDDEN", "utf8");
    const dotDir = path.join(kbDir, ".git");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(path.join(dotDir, "config.md"), "MARKER-GIT", "utf8");
    writeFileSync(path.join(kbDir, "real.md"), "MARKER-REAL", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-REAL");
    expect(body).not.toContain("MARKER-HIDDEN");
    expect(body).not.toContain("MARKER-GIT");
  });

  it("returns '' for an absent KB folder (no throw)", () => {
    const { dataRoot } = freshKb();
    expect(readKbBody("does-not-exist", dataRoot)).toBe("");
  });

  it("bounds total injected text at the budget and appends an honest truncation marker", () => {
    const { dataRoot, kbDir } = freshKb();
    // two docs that together blow a tiny budget — order is by relative path
    writeFileSync(path.join(kbDir, "a.md"), "A".repeat(50), "utf8");
    writeFileSync(path.join(kbDir, "b.md"), "B".repeat(50), "utf8");
    const body = readKbBody("notes", dataRoot, 40);
    expect(body.length).toBeLessThan(50 + 50 + 200); // clipped, not full
    expect(body).toContain("knowledge base truncated");
  });

  it("exposes a sane default budget", () => {
    expect(KB_INJECTION_BUDGET).toBe(24_000);
  });
});
