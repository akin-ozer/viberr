import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  kbDirPath,
  resolveStoreSegment,
  resolveStoredSegment,
  skillDirPath,
  storedNameAmong,
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

describe("ruling 76: a typed name finds the file in whichever Unicode form it was stored", () => {
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

  it("keeps two entries that differ only in form apart: a name means the one spelled exactly so", () => {
    // A folder on the disk production runs on can hold both forms as two
    // files (an old upload, and a file a run's shell wrote). This is the rule
    // every caller asks, so it is stated on a list, whatever the test's disk.
    // CANARY: answer by composed name alone and a claim on one of the pair is
    // read as a claim on the other: removing a person's file takes the run's
    // tile with it.
    expect(storedNameAmong([decomposed, composed, "plain.md"], decomposed)).toBe(decomposed);
    expect(storedNameAmong([decomposed, composed, "plain.md"], composed)).toBe(composed);
    // One entry: either spelling means it.
    expect(storedNameAmong([decomposed, "plain.md"], composed)).toBe(decomposed);
    expect(storedNameAmong([composed], decomposed)).toBe(composed);
    // A third spelling of a pair means neither, and a stranger means nothing.
    // Its first accented letter composed, the rest decomposed.
    const third = `${composed.slice(0, 9)}${composed.slice(9).normalize("NFD")}`;
    expect([composed, decomposed]).not.toContain(third);
    expect(storedNameAmong([decomposed, composed], third)).toBeNull();
    expect(storedNameAmong([decomposed], "Çıktı.pdf")).toBeNull();
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
