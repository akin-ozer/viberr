import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 230 (pass 37, F37-126) — Viberr never tells anyone to REBASE.
 *
 * `update_branch_from_base` "merge[s] the base into the branch and push[es] it",
 * and its own tool text tells the operator to "never ask an agent to rebase,
 * merge or force-push". A rebase rewrites commits a pull request has already
 * published; on this instance one diverged SHOP-11's branch from its own PR #15,
 * and the shopify-clone board's rulings open with "merge main in, never rebase".
 *
 * The first fix for this changed the TWO strings a grep for one sentence found,
 * and the ruling claimed "one string, shared by both call sites, so they cannot
 * drift". Five more were live at that moment: the review queue's own wording,
 * two short `cause` strings, the github tab's comment, a note to the operator —
 * and the decision packet's PLACEHOLDER, which is Viberr modelling a good
 * directive at the exact moment a person writes one, using the operation the
 * product forbids. Counting the sites is the only way to know they are all
 * closed, so this counts them rather than trusting a grep I ran by hand.
 */
describe("ruling 230: no surface tells a person to rebase", () => {
  const appDir = fileURLToPath(new URL("../", import.meta.url));

  /** Every source file under `app/`, excluding tests — the assertion cannot be
   *  scoped away to the directory someone remembered. */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) sources(abs, out);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(abs);
    }
    return out;
  }

  it("no source suggests a rebase as the remedy", () => {
    // Phrases that RECOMMEND one. A file may say the word — this very rule has
    // to, and so does every comment explaining why not — so the test matches
    // the recommendation, not the noun.
    const suggests =
      /(?:rebase (?:it|the branch|onto)|needs? a rebase|need a rebase|is rebased|be rebased|rebase first|rebase and)/i;
    const offenders: string[] = [];
    const files = sources(appDir);
    // A scan that reads nothing passes everything.
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!suggests.test(line)) return;
        // A line that says NOT to is the rule itself, not a violation.
        if (/never|not a rebase|rather than a rebase|no rebase|forbid|instead of/i.test(line)) return;
        offenders.push(`${file.slice(file.indexOf("/app/") + 1)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
