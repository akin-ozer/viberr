import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_INJECTION_BUDGET, readSkillBody } from "./skill-body.server";

/**
 * P14-KM-03: skill injection was the one unbounded prompt input. KBs have been
 * budgeted since F9; a SKILL.md — uploadable, importable, up to the editor's
 * 256 KB read cap — landed verbatim in every operator and specialist prompt.
 */

function freshSkill(name = "craft"): { dataRoot: string; skillDir: string } {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-skill-"));
  const skillDir = path.join(dataRoot, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  return { dataRoot, skillDir };
}

describe("readSkillBody", () => {
  it("returns the body with frontmatter stripped", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: craft\n---\n\n# Craft\nMARKER-BODY",
      "utf8",
    );
    const body = readSkillBody("craft", dataRoot);
    expect(body).toContain("MARKER-BODY");
    expect(body).not.toContain("name: craft");
  });

  it("returns '' for a skill with no folder on disk", () => {
    const { dataRoot } = freshSkill();
    expect(readSkillBody("does-not-exist", dataRoot)).toBe("");
  });

  it("clips an oversized SKILL.md at the budget and says so", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(path.join(skillDir, "SKILL.md"), "X".repeat(200), "utf8");
    const body = readSkillBody("craft", dataRoot, 50);
    expect(body).toContain("skill truncated");
    expect(body).toContain("200 chars");
    // The clipped text is the budget, not the whole file.
    expect(body.slice(0, 51)).toBe("X".repeat(50) + "\n");
  });

  it("leaves a body that fits untouched — no marker", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(path.join(skillDir, "SKILL.md"), "short", "utf8");
    expect(readSkillBody("craft", dataRoot, 50)).toBe("short");
  });

  it("defaults to the KB-sized budget rather than no cap at all", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "Y".repeat(SKILL_INJECTION_BUDGET + 5_000),
      "utf8",
    );
    const body = readSkillBody("craft", dataRoot);
    expect(body.length).toBeLessThan(SKILL_INJECTION_BUDGET + 300);
    expect(body).toContain("skill truncated");
  });
});
