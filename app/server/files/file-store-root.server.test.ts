import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  kbDirPath,
  resolveStoreSegment,
  resolveStoredSegment,
  skillDirPath,
} from "./file-store-root.server";

describe("resolveStoreSegment — traversal containment (F10-18)", () => {
  const root = "/data/kb";

  it("resolves a plain single segment beneath the root", () => {
    expect(resolveStoreSegment(root, "api-contracts")).toBe(
      path.join(root, "api-contracts"),
    );
  });

  it("rejects separators, dot-segments, absolute paths, and NUL", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "../secret",
      "../../projects/x/secret",
      "a/b",
      "a\\b",
      "/etc/passwd",
      "with\0nul",
    ]) {
      expect(() => resolveStoreSegment(root, bad)).toThrow();
    }
  });

  it("kbDirPath / skillDirPath refuse to escape their store roots", () => {
    // A hand-edited profile resource string can't traverse out of the store.
    expect(() => kbDirPath("../../projects/viberr/tasks")).toThrow();
    expect(() => skillDirPath("../../../etc")).toThrow();
    // Normal names still resolve.
    expect(kbDirPath("api-contracts")).toContain(path.join("kb", "api-contracts"));
    expect(skillDirPath("developer-expertise")).toContain(
      path.join("skills", "developer-expertise"),
    );
  });
});

describe("ruling 675: a typed name finds the file in whichever Unicode form it was stored", () => {
  // The name a Mac's browser sends: every accented letter as a base letter
  // and a combining mark.
  const composed = "Aidea _ İçerik ve Eğitim Üretim _ AWS Maliyet Teklifi.pdf";
  const decomposed = composed.normalize("NFD");

  it("resolves the composed name to the decomposed entry, and an exact name to itself", () => {
    // CANARY: return `exact` without consulting the folder's listing and the
    // composed name resolves to a path a Linux disk holds nothing at, which is
    // what answered "has no attachment X. It holds: X." on AWSC-117.
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-675-"));
    try {
      writeFileSync(path.join(dir, decomposed), "the estate");
      writeFileSync(path.join(dir, "plain.md"), "plain");
      expect(decomposed).not.toBe(composed);
      const found = resolveStoredSegment(dir, composed);
      expect(path.basename(found)).toBe(decomposed);
      expect(readFileSync(found, "utf8")).toBe("the estate");
      expect(resolveStoredSegment(dir, decomposed)).toBe(path.join(dir, decomposed));
      expect(resolveStoredSegment(dir, "plain.md")).toBe(path.join(dir, "plain.md"));
      // A name the folder holds in no form stays as typed, for the caller to miss.
      expect(resolveStoredSegment(dir, "Çıktı.pdf")).toBe(path.join(dir, "Çıktı.pdf"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still refuses a name that is not one path segment", () => {
    // CANARY: match the listing before `resolveStoreSegment` checks the name
    // and `../x` is looked up in the folder instead of refused.
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-675-"));
    try {
      for (const bad of ["../escape.txt", "a/b.txt", ".."]) {
        expect(() => resolveStoredSegment(dir, bad), bad).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
