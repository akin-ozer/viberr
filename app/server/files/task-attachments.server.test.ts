import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachmentContentType,
  attachmentNamesSince,
  countTaskAttachments,
  listTaskAttachments,
  resolveTaskAttachment,
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
