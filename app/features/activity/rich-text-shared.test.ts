import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ruling 14 guard: there is exactly ONE rich-text renderer in the app —
 * app/ui/rich-text.tsx. The mock shipped two (`RichText` in task.jsx,
 * `RichA` in activity.jsx); Phase 9C surfaces must consume the shared one
 * with `mentions={false}`, never fork it.
 */

const FEATURES_DIR = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("rich-text renderer is shared, not forked (ruling 14)", () => {
  it("the 9C surfaces import ~/ui/rich-text", () => {
    for (const file of [
      "activity/activity-page.tsx",
      "notifications/notifications-page.tsx",
    ]) {
      const src = readFileSync(path.join(FEATURES_DIR, file), "utf8");
      expect(src, `${file} must import the shared renderer`).toContain(
        'from "~/ui/rich-text"',
      );
    }
  });

  it("no feature module re-implements the tokenizer", () => {
    const offenders = walk(FEATURES_DIR).filter((file) => {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return false;
      const src = readFileSync(file, "utf8");
      // The tokenizer's signature regex + a local RichText/RichA definition
      // are both forks; the shared module lives in app/ui only.
      return (
        /function\s+Rich(Text|A)\b/.test(src) ||
        src.includes("\\*\\*[^*]+\\*\\*")
      );
    });
    expect(offenders).toEqual([]);
  });
});
