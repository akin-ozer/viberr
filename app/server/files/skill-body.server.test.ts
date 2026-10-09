import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SKILL_INJECTION_BUDGET,
  assertSkillBodyWellFormed,
  lstatOr,
  readSkillBodies,
} from "./skill-body.server";
import { createTempDirs } from "../../../test-support/temp-dirs";

const temp = createTempDirs();
afterAll(temp.cleanup);

/**
 * P14-KM-03: skill injection was the one unbounded prompt input. KBs have been
 * budgeted since F9; a SKILL.md — uploadable, importable, up to the editor's
 * 256 KB read cap — landed verbatim in every operator and specialist prompt.
 */

function freshSkill(name = "craft") {
  const dataRoot = temp.make("viberr-skill-");
  const skillDir = path.join(dataRoot, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  return { dataRoot, skillDir };
}

/** One skill as a run is given it: `readSkillBodies`, the reader a run's
 *  prompt is built from, for that one name under `budget`. */
function skillOf(name: string, dataRoot: string, budget?: number) {
  const set = readSkillBodies([name], dataRoot, budget);
  return { body: set.parts[0]?.body ?? "", unresolved: set.unresolved[0] };
}

describe("one skill's body", () => {
  it("returns the body with frontmatter stripped", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: craft\n---\n\n# Craft\nMARKER-BODY",
      "utf8",
    );
    const body = skillOf("craft", dataRoot).body;
    expect(body).toContain("MARKER-BODY");
    expect(body).not.toContain("name: craft");
  });

  it("returns '' for a skill with no folder on disk", () => {
    const { dataRoot } = freshSkill();
    expect(skillOf("does-not-exist", dataRoot).body).toBe("");
  });

  it("clips an oversized SKILL.md at the budget and says so", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(path.join(skillDir, "SKILL.md"), "X".repeat(200), "utf8");
    const body = skillOf("craft", dataRoot, 50).body;
    expect(body).toContain("skill truncated");
    expect(body).toContain("200 chars");
    // The clipped text is the budget, not the whole file.
    expect(body.slice(0, 51)).toBe("X".repeat(50) + "\n");
  });

  it("leaves a body that fits untouched — no marker", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(path.join(skillDir, "SKILL.md"), "short", "utf8");
    expect(skillOf("craft", dataRoot, 50).body).toBe("short");
  });

  it("defaults to the KB-sized budget rather than no cap at all", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "Y".repeat(SKILL_INJECTION_BUDGET + 5_000),
      "utf8",
    );
    const body = skillOf("craft", dataRoot).body;
    expect(body.length).toBeLessThan(SKILL_INJECTION_BUDGET + 300);
    expect(body).toContain("skill truncated");
  });
});

/**
 * A5/pass-16 — a skill body is injected under the "Attached resources (trusted
 * — configured for you)" banner, i.e. the run is explicitly told to follow its
 * instructions. The KB reader (`readKbIndexDetailed` today) has refused to
 * follow symlinks out of the store since F9 and every other store path agreed
 * after P14-RV-02; this reader dereferenced them, so a symlinked SKILL.md (or
 * skill folder) put arbitrary host content into the model's context AS TRUSTED
 * PERSONA.
 */
describe("one skill's body — store containment (A5)", () => {
  function outsideFile(body: string): string {
    const outside = temp.make("viberr-outside-");
    writeFileSync(path.join(outside, "SKILL.md"), body, "utf8");
    return outside;
  }

  it("refuses a symlinked SKILL.md instead of injecting the link target", () => {
    const { dataRoot, skillDir } = freshSkill();
    const outside = outsideFile("MARKER-EVIL-INSTRUCTIONS");
    symlinkSync(path.join(outside, "SKILL.md"), path.join(skillDir, "SKILL.md"));
    const detailed = skillOf("craft", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.body).not.toContain("MARKER-EVIL-INSTRUCTIONS");
    expect(detailed.unresolved?.reason).toContain("symlink");
  });

  it("refuses a skill FOLDER that is a symlink out of the store", () => {
    const { dataRoot } = freshSkill();
    const outside = outsideFile("MARKER-EVIL-FOLDER");
    symlinkSync(outside, path.join(dataRoot, "skills", "linked"));
    const detailed = skillOf("linked", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.body).not.toContain("MARKER-EVIL-FOLDER");
    expect(detailed.unresolved?.reason).toContain("symlink");
  });

  it("a real SKILL.md in a real folder still reads (containment is not a ban)", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(path.join(skillDir, "SKILL.md"), "MARKER-REAL", "utf8");
    expect(skillOf("craft", dataRoot).body).toContain("MARKER-REAL");
  });
});

/**
 * C1/pass-16 — a skill grant that resolves to nothing used to be a
 * `logger.warn` and nothing else, so a typo'd or renamed skill folder was
 * invisible to the run while every UI still showed it attached.
 */
describe("one skill's body — structured misses (C1)", () => {
  it("names a missing skill folder as an unresolved grant", () => {
    const { dataRoot } = freshSkill();
    const detailed = skillOf("typo-expertise", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.unresolved).toEqual({
      name: "typo-expertise",
      reason: "no skill folder by that name in the store",
    });
  });

  it("names a folder that exists but ships no SKILL.md", () => {
    const { dataRoot } = freshSkill();
    expect(skillOf("craft", dataRoot).unresolved?.reason).toBe(
      "its folder holds no SKILL.md",
    );
  });

  it("a traversal-shaped grant is DENIED, never escaped", () => {
    const { dataRoot } = freshSkill();
    const detailed = skillOf("../../projects", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.unresolved?.name).toBe("../../projects");
  });

  it("a resolvable skill carries NO unresolved row", () => {
    const { dataRoot, skillDir } = freshSkill();
    writeFileSync(path.join(skillDir, "SKILL.md"), "MARKER", "utf8");
    expect(skillOf("craft", dataRoot).unresolved).toBeUndefined();
  });
});

/**
 * C2/pass-16 — the skill budget was PER SKILL: it re-armed on every call inside
 * the caller's loop, so N skills contributed N × 24k. The KB leg has spent one
 * shared budget since F9 precisely to prevent that.
 */
describe("readSkillBodies — ONE shared budget (C2)", () => {
  function skillWith(dataRoot: string, name: string, body: string): void {
    const dir = path.join(dataRoot, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
  }

  it("later skills draw from what earlier ones left — total is bounded", () => {
    const { dataRoot } = freshSkill();
    skillWith(dataRoot, "one", "A".repeat(400));
    skillWith(dataRoot, "two", "B".repeat(400));
    skillWith(dataRoot, "three", "C".repeat(400));

    const set = readSkillBodies(["one", "two", "three"], dataRoot, 500);
    const total = set.parts.reduce((n, p) => n + p.body.length, 0);
    // Per-skill budgeting would have produced ~1200 chars of content; the shared
    // budget keeps the injected content at/below the cap (plus honest markers).
    expect(
      set.parts.reduce(
        (n, p) => n + (p.body.includes("omitted entirely") ? 0 : p.body.length),
        0,
      ),
    ).toBeLessThanOrEqual(500 + 200);
    expect(total).toBeLessThan(1200);
  });

  it("a skill squeezed out entirely announces itself and is reported unresolved", () => {
    const { dataRoot } = freshSkill();
    skillWith(dataRoot, "one", "A".repeat(400));
    skillWith(dataRoot, "two", "B".repeat(400));

    const set = readSkillBodies(["one", "two"], dataRoot, 400);
    expect(set.parts[0]!.body).toBe("A".repeat(400));
    expect(set.parts[1]!.body).toContain("omitted entirely");
    expect(set.unresolved.map((u) => u.name)).toEqual(["two"]);
  });

  it("collects misses across the whole declared list", () => {
    const { dataRoot } = freshSkill();
    skillWith(dataRoot, "one", "real");
    const set = readSkillBodies(["one", "ghost"], dataRoot);
    expect(set.parts.map((p) => p.name)).toEqual(["one"]);
    expect(set.unresolved.map((u) => u.name)).toEqual(["ghost"]);
  });
});

/**
 * Ruling 186 (pass 36, F36-2): the one judgement every SKILL.md writer makes
 * before it writes. Refuse by name, never rewrite.
 */
describe("assertSkillBodyWellFormed (ruling 186)", () => {
  it("refuses an empty body", () => {
    expect(() => assertSkillBodyWellFormed("")).toThrowError(/empty/);
    expect(() => assertSkillBodyWellFormed(" \n\t")).toThrowError(/empty/);
  });

  it("refuses a body with no real newline and literal \\n sequences, naming the remedy", () => {
    expect(() => assertSkillBodyWellFormed("# Skill\\n\\n- step")).toThrowError(
      /JSON-escaped.*real newlines/,
    );
    // A one-line body with no escape in it is a skill.
    expect(() => assertSkillBodyWellFormed("Use conventional commits.")).not.toThrow();
    // Real newlines beside a literal `\n` (a code sample) are not the escape.
    expect(() =>
      assertSkillBodyWellFormed("# Skill\n\nJoin lines with `\\n`."),
    ).not.toThrow();
  });

  it("refuses a frontmatter block that does not parse, and accepts one that does or none at all", () => {
    expect(() => assertSkillBodyWellFormed("---\nname: x\n# no closing fence")).toThrowError(
      /frontmatter/,
    );
    expect(() => assertSkillBodyWellFormed("---\ndescription: [\n---\n# Body")).toThrowError(
      /frontmatter/,
    );
    expect(() => assertSkillBodyWellFormed("---\n- a\n- b\n---\n# Body")).toThrowError(
      /frontmatter/,
    );
    expect(() =>
      assertSkillBodyWellFormed("---\nname: x\ndescription: Fine.\n---\n# Body"),
    ).not.toThrow();
    expect(() => assertSkillBodyWellFormed("# Plain\n- markdown")).not.toThrow();
  });
});

describe("lstatOr", () => {
  it("stats the link itself, never its target, and answers null for a missing path", () => {
    const { skillDir } = freshSkill();
    const file = path.join(skillDir, "SKILL.md");
    writeFileSync(file, "# Craft", "utf8");
    symlinkSync(file, path.join(skillDir, "linked.md"));
    expect(lstatOr(file)?.isFile()).toBe(true);
    expect(lstatOr(path.join(skillDir, "linked.md"))?.isSymbolicLink()).toBe(true);
    // A dangling link is still a link: it stats, where `existsSync` says no.
    symlinkSync(path.join(skillDir, "gone.md"), path.join(skillDir, "dangling.md"));
    expect(lstatOr(path.join(skillDir, "dangling.md"))?.isSymbolicLink()).toBe(true);
    expect(lstatOr(path.join(skillDir, "missing.md"))).toBeNull();
  });
});
