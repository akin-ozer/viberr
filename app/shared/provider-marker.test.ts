import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDER_TEXT_MARKER, withProviderText } from "./provider-marker";

describe("provider marker (P07-C, pass 32)", () => {
  it("is written in exactly ONE module — every writer imports it", () => {
    // The literal used to exist five times with no pin; a writer drifting by
    // one character would have made the quota classifier judge the whole
    // failure line (the V4 transient-429 defect). Any new inline copy fails
    // here, naming the file.
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        if (full.endsWith(path.join("shared", "provider-marker.ts"))) continue;
        scanned += 1;
        const text = readFileSync(full, "utf8");
        // The marker's own escape sequence (`\n\nThe provider reported:`) is
        // what a copied literal or template carries; a comment merely naming
        // the phrase (this module's rationale, quoted elsewhere) is not one.
        if (/\\n\\nThe provider reported:/.test(text)) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    // A scan that reads nothing passes everything.
    expect(scanned).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it("withProviderText appends the sentence behind the marker, or nothing", () => {
    expect(withProviderText("Claude usage limit was reached.", "429 rate_limit_error")).toBe(
      `Claude usage limit was reached.${PROVIDER_TEXT_MARKER}429 rate_limit_error`,
    );
    expect(withProviderText("Run failed.", null)).toBe("Run failed.");
    expect(withProviderText("Run failed.", "")).toBe("Run failed.");
  });
});
