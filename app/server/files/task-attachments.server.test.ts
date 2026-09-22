import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  UPLOADABLE_EXTENSIONS,
  attachmentContentType,
  attachmentNamesSince,
  countTaskAttachments,
  isBrowserWorkingArtifact,
  listTaskAttachments,
  pruneBrowserWorkingArtifacts,
  resolveTaskAttachment,
  writeTaskAttachment,
} from "./task-attachments.server";

/** R19-19 — the attachments read side: directory-is-truth listing, traversal
 *  containment, and the inline whitelist that keeps stored HTML inert. */

let root: string;

function seed(files: Record<string, { at: number }>): void {
  const dir = path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments");
  mkdirSync(dir, { recursive: true });
  for (const [name, meta] of Object.entries(files)) {
    const p = path.join(dir, name);
    writeFileSync(p, `content of ${name}`);
    utimesSync(p, new Date(meta.at), new Date(meta.at));
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("listTaskAttachments", () => {
  it("returns [] when the task has no attachments dir (the common case)", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    expect(listTaskAttachments("p1", "VIB-1", root)).toEqual([]);
  });

  it("lists files newest-first, skipping dotfiles and directories", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({
      "old-shot.png": { at: 1_000_000_000_000 },
      "new-shot.png": { at: 2_000_000_000_000 },
      ".DS_Store": { at: 3_000_000_000_000 },
    });
    mkdirSync(
      path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments", "sub"),
    );
    const names = listTaskAttachments("p1", "VIB-1", root).map((a) => a.name);
    expect(names).toEqual(["new-shot.png", "old-shot.png"]);
    const first = listTaskAttachments("p1", "VIB-1", root)[0]!;
    expect(first.size).toBeGreaterThan(0);
    expect(first.modifiedAt).toContain("2033");
  });
});

// C8: listTaskAttachments caps its return at LIST_CAP (100) with nothing
// telling a caller the store holds more. countTaskAttachments is the
// sibling that answers the true count, cheaply (dirent type check, no
// per-file stat) — kept separate so listTaskAttachments's shape (and every
// existing caller) stays untouched.
describe("countTaskAttachments", () => {
  it("returns 0 when the task has no attachments dir (the common case)", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("counts files, skipping dotfiles and directories, matching the list length under the cap", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({
      "old-shot.png": { at: 1_000_000_000_000 },
      "new-shot.png": { at: 2_000_000_000_000 },
      ".DS_Store": { at: 3_000_000_000_000 },
    });
    mkdirSync(
      path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments", "sub"),
    );
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(2);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(
      listTaskAttachments("p1", "VIB-1", root).length,
    );
  });

  it("keeps counting past LIST_CAP, unlike listTaskAttachments's capped return", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const files: Record<string, { at: number }> = {};
    for (let i = 0; i < 110; i++) {
      files[`shot-${i}.png`] = { at: 1_000_000_000_000 + i };
    }
    seed(files);
    expect(listTaskAttachments("p1", "VIB-1", root)).toHaveLength(100);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(110);
  });
});

describe("resolveTaskAttachment", () => {
  it("resolves a plain name inside the attachments dir", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const abs = resolveTaskAttachment("p1", "VIB-1", "shot.png", root);
    expect(abs).toBe(
      path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments", "shot.png"),
    );
  });

  it("REFUSES traversal — separators, dot-segments, absolute paths", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    for (const bad of ["../task.md", "..", "a/b.png", "a\\b.png", "/etc/passwd", ""]) {
      expect(() => resolveTaskAttachment("p1", "VIB-1", bad, root)).toThrow();
    }
  });
});

describe("attachmentContentType", () => {
  it("whitelists images/pdf/text inline", () => {
    expect(attachmentContentType("shot.png")).toEqual({
      type: "image/png",
      inline: true,
    });
    expect(attachmentContentType("Report.PDF").inline).toBe(true);
    expect(attachmentContentType("notes.txt").type).toContain("text/plain");
  });

  it("NEVER renders html/svg/unknown inline — stored pages must not execute on the app origin", () => {
    for (const name of ["page.html", "logo.svg", "payload.xhtml", "run.bin", "noext"]) {
      const { type, inline } = attachmentContentType(name);
      expect(inline).toBe(false);
      expect(type).toBe("application/octet-stream");
    }
  });
});

describe("attachmentNamesSince (P21 — a run's own files)", () => {
  it("names files written at-or-after the run start, newest first", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({
      "before-run.png": { at: Date.parse("2026-08-20T01:00:00.000Z") },
      "during-1.png": { at: Date.parse("2026-08-20T02:00:00.000Z") },
      "during-2.yml": { at: Date.parse("2026-08-20T02:30:00.000Z") },
    });
    expect(
      attachmentNamesSince("p1", "VIB-1", "2026-08-20T01:30:00.000Z", root),
    ).toEqual(["during-2.yml", "during-1.png"]);
  });

  it("claims nothing on an unparseable window start", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({ "shot.png": { at: Date.parse("2026-08-20T02:00:00.000Z") } });
    expect(attachmentNamesSince("p1", "VIB-1", "not-a-date", root)).toEqual([]);
  });

  it("returns [] when the task has no attachments dir", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    expect(
      attachmentNamesSince("p1", "VIB-1", "2026-08-20T00:00:00.000Z", root),
    ).toEqual([]);
  });
});

// Ruling 105 (owner ask 2026-08-31): the browser MCP's machine-stamped working
// files (page-*.yml aria snapshots, console-*.log dumps) land in the store
// because --output-dir IS the store. They are pruned at run completion unless
// the run cited the exact filename; visual evidence always stays.
describe("browser working artifacts (ruling 105)", () => {
  it("classifies machine-stamped non-visual outputs, and nothing else", () => {
    expect(isBrowserWorkingArtifact("page-2026-08-31T15-05-03-204Z.yml")).toBe(true);
    expect(isBrowserWorkingArtifact("console-2026-08-31T15-05-03-056Z.log")).toBe(true);
    // Visual evidence never counts, however the tool named it.
    expect(isBrowserWorkingArtifact("page-2026-08-31T15-05-18-081Z.png")).toBe(false);
    expect(isBrowserWorkingArtifact("element-2026-08-31T15-06-38-205Z.png")).toBe(false);
    expect(isBrowserWorkingArtifact("page-2026-08-31T15-05-18-081Z.pdf")).toBe(false);
    // Deliberately named files never match the machine stamp.
    expect(isBrowserWorkingArtifact("review-notes.yml")).toBe(false);
    expect(isBrowserWorkingArtifact("notes.txt")).toBe(false);
    // Review: the stamp itself classifies, not a prefix allowlist — a future
    // MCP tool's sibling artifact must not start drowning the panel again.
    expect(isBrowserWorkingArtifact("snapshot-2026-08-31T15-05-03-204Z.yml")).toBe(true);
    expect(isBrowserWorkingArtifact("trace-2026-08-31T15-05-03-204Z.zip")).toBe(true);
  });

  it("a name already gone from disk counts as pruned, never as kept (honesty)", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({ "console-2026-08-31T15-05-03-056Z.log": { at: 2_000_000_000_000 } });
    const ghost = "console-2026-08-31T15-06-00-000Z.log"; // in names, not on disk
    const result = pruneBrowserWorkingArtifacts(
      "p1",
      "VIB-1",
      ["console-2026-08-31T15-05-03-056Z.log", ghost],
      "",
      root,
    );
    // Both end up pruned: one really deleted, the ghost acknowledged as gone —
    // the producing event must never claim a file the directory does not hold.
    expect(result.pruned).toEqual([
      "console-2026-08-31T15-05-03-056Z.log",
      ghost,
    ]);
    expect(result.kept).toEqual([]);
  });

  it("the run window is UNCAPPED — the display cap must not starve the prune", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const files: Record<string, { at: number }> = {};
    for (let i = 0; i < 105; i++) {
      files[`console-2026-08-31T15-05-03-${String(i).padStart(3, "0")}Z.log`] = {
        at: 2_000_000_000_000 + i * 1000,
      };
    }
    seed(files);
    const names = attachmentNamesSince(
      "p1",
      "VIB-1",
      new Date(1_999_999_999_999).toISOString(),
      root,
    );
    expect(names).toHaveLength(105);
  });

  it("prunes uncited artifacts from disk, keeps cited ones and everything else", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const cited = "page-2026-08-31T15-05-03-204Z.yml";
    const uncited = "console-2026-08-31T15-05-03-056Z.log";
    const shot = "page-2026-08-31T15-05-18-081Z.png";
    seed({
      [cited]: { at: 2_000_000_000_000 },
      [uncited]: { at: 2_000_000_000_000 },
      [shot]: { at: 2_000_000_000_000 },
      "notes.txt": { at: 2_000_000_000_000 },
    });
    const result = pruneBrowserWorkingArtifacts(
      "p1",
      "VIB-1",
      [cited, uncited, shot, "notes.txt"],
      "Verified in the browser. The aria tree is in `" + cited + "`.",
      root,
    );
    expect(result.pruned).toEqual([uncited]);
    expect(result.kept).toEqual([cited, shot, "notes.txt"]);
    const left = listTaskAttachments("p1", "VIB-1", root).map((a) => a.name);
    expect(left).not.toContain(uncited);
    expect(left).toContain(cited);
    expect(left).toContain(shot);
  });

  it("yaml/csv serve as inert text for the read-only viewer, never renderable", () => {
    expect(attachmentContentType("page-snap.yml").type).toContain("text/plain");
    expect(attachmentContentType("page-snap.yml").inline).toBe(true);
    expect(attachmentContentType("data.csv").type).toContain("text/plain");
  });
});

/**
 * F39-6 (pass 39): the human writer. The directory had three readers and no way
 * for a PERSON to put a file in it — viberr's own controller planned around a
 * human attaching an authoritative fixture, and the only route was writing into
 * the data volume by hand.
 */
describe("writeTaskAttachment", () => {
  const setRoot = () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    mkdirSync(path.join(root, "projects", "p1", "tasks", "VIB-1"), {
      recursive: true,
    });
    return root;
  };
  const write = (name: string, body = "kind: Task\n") =>
    writeTaskAttachment("p1", "VIB-1", name, new TextEncoder().encode(body), root);

  it("writes the file, creates the directory, and reports a replace", () => {
    setRoot();
    const first = write("fixture.yaml");
    expect(first).toEqual({ name: "fixture.yaml", bytes: 11, replaced: false });
    expect(listTaskAttachments("p1", "VIB-1", root).map((a) => a.name)).toEqual([
      "fixture.yaml",
    ]);
    // The read side must be able to serve exactly what the write side accepted.
    expect(attachmentContentType("fixture.yaml").inline).toBe(true);
    const again = write("fixture.yaml", "kind: Workspace\n");
    expect(again.replaced).toBe(true);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(1);
  });

  it("refuses a traversing or separator-bearing name", () => {
    setRoot();
    for (const bad of ["../escape.txt", "sub/dir.txt", "..", "a/../../b.txt"]) {
      // CANARY: write to `path.join(dir, name)` instead of through
      // `resolveStoreSegment` and these land outside the task directory.
      expect(() => write(bad), bad).toThrow();
    }
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("refuses a dot-prefixed name, which the scanner would then hide", () => {
    setRoot();
    expect(() => write(".hidden.txt")).toThrow(/cannot start with a dot/);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("refuses an extension this product can neither render nor read back", () => {
    setRoot();
    // CANARY: widen UPLOADABLE_EXTENSIONS to allow these and a stored page is
    // served from the app origin — the stored XSS the serving rules prevent.
    for (const bad of ["page.html", "icon.svg", "run.js", "tool.sh", "blob.bin", "noext"]) {
      expect(() => write(bad), bad).toThrow(/does not store/);
    }
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
    // And the whitelist is exactly what the two read paths can handle.
    for (const good of [".png", ".pdf", ".txt", ".md", ".json", ".yaml", ".csv", ".diff", ".patch"]) {
      expect(UPLOADABLE_EXTENSIONS.has(good), good).toBe(true);
    }
    for (const bad of [".html", ".svg", ".js"]) {
      expect(UPLOADABLE_EXTENSIONS.has(bad), bad).toBe(false);
    }
  });

  it("refuses a file over the size cap", () => {
    setRoot();
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    expect(() =>
      writeTaskAttachment("p1", "VIB-1", "big.bin", tooBig, root),
    ).toThrow();
    // Named by the reason a reader can act on, not by the extension check.
    expect(() =>
      writeTaskAttachment("p1", "VIB-1", "big.txt", tooBig, root),
    ).toThrow(/may be up to/);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("refuses an empty name", () => {
    setRoot();
    expect(() => write("   ")).toThrow(/Give the file a name/);
  });
});
