import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  kbDirPath,
  resolveStoreSegment,
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
