import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import { sha256Hex } from "~/server/files/content-hash.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { seedOrgResources } from "~/server/org/org-seed.server";
import { listSkills } from "~/server/org/resources.server";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import type { OperatorAuthority } from "~/server/tasks/operator-authority.server";
import {
  HUMANIZER_PROMPT_SECTION,
  HUMANIZER_SKILL_SHA256,
  HUMANIZER_SOURCE,
  humanizerSkillFile,
} from "./humanizer.server";
import { buildOperatorSystemPrompt } from "./operator-prompt.server";
import { createTempDirs } from "../../../test-support/temp-dirs";
import { createTestDbContext } from "../../../test-support/test-db";

/**
 * Ruling 502: every operator run and every controller turn writes under the
 * vendored Humanizer skill, and no surface a person uses names it. The
 * controller's prompt half is in `controller-run.server.test.ts`, beside its
 * app harness.
 */

const temp = createTempDirs();
afterAll(temp.cleanup);
const dbs = createTestDbContext();
afterEach(dbs.cleanup);

const VENDORED = path.dirname(humanizerSkillFile());
const SKILL = readFileSync(humanizerSkillFile(), "utf8");
const BODY = splitFrontmatter(SKILL).body.trim();

const skillFrontmatterSchema = z.object({
  name: z.string(),
  license: z.string(),
  metadata: z.object({ version: z.string() }),
});

describe("ruling 502: the vendored Humanizer skill", () => {
  it("is upstream's SKILL.md, byte for byte, at the pinned commit", () => {
    // CANARY: edit one word of humanizer/SKILL.md and this fails until the
    // file is re-vendored from upstream and the pin moves with it.
    expect(readdirSync(VENDORED).sort()).toEqual(["LICENSE", "SKILL.md"]);
    expect(sha256Hex(readFileSync(humanizerSkillFile()))).toBe(HUMANIZER_SKILL_SHA256);
    const frontmatter = skillFrontmatterSchema.parse(splitFrontmatter(SKILL).data);
    expect(frontmatter.name).toBe("humanizer");
    expect(frontmatter.license).toBe(HUMANIZER_SOURCE.license);
    expect(frontmatter.metadata.version).toBe(HUMANIZER_SOURCE.version);
  });

  it("never enters the store, so the Agent resources tab of a seeded instance cannot list it", () => {
    // Both of the product seed's writers: the org resources and the shipped
    // agent assets the boot step writes.
    const db = dbs.makeDb();
    const dataRoot = dbs.makeTempDir();
    seedOrgResources(db, { dataRoot });
    seedDefaultAgentAssets(dataRoot);
    const skills = listSkills(db, { dataRoot });
    expect(skills.map((s) => s.name)).toContain("viberr-app-expertise");
    expect(skills.map((s) => s.name)).not.toContain("humanizer");
    expect(skills.filter((s) => s.body.includes("# Humanizer:")).map((s) => s.name)).toEqual([]);
  });

  it("keeps its MIT licence beside it and in THIRD_PARTY_NOTICES.md", () => {
    const licence = readFileSync(path.join(VENDORED, "LICENSE"), "utf8").trim();
    expect(licence.startsWith("MIT License")).toBe(true);
    expect(licence).toContain("Copyright (c) 2025 Siqi Chen");
    const notices = readFileSync(path.join(process.cwd(), "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain(HUMANIZER_SOURCE.repository);
    expect(notices).toContain(HUMANIZER_SOURCE.commit);
    expect(notices).toContain(licence);
  });
});

describe("ruling 502: the prompt section", () => {
  it("frames the guide, then carries the skill's whole body without its frontmatter", () => {
    expect(HUMANIZER_PROMPT_SECTION.startsWith("\n\n---\n# How you write\n\n")).toBe(true);
    expect(HUMANIZER_PROMPT_SECTION.endsWith(`\n\n${BODY}`)).toBe(true);
    expect(BODY.startsWith("# Humanizer: remove AI writing patterns")).toBe(true);
    expect(HUMANIZER_PROMPT_SECTION).not.toContain("name: humanizer");
    expect(HUMANIZER_PROMPT_SECTION).not.toContain("metadata:");
  });

  it("puts the guide in its embedded mode, below every other instruction, and out of sight", () => {
    const framing = HUMANIZER_PROMPT_SECTION.slice(0, HUMANIZER_PROMPT_SECTION.indexOf(BODY));
    expect(framing).toContain("Use the guide's embedded mode as you write");
    expect(framing).toContain("never a draft, a list of patterns or a note about the rewrite");
    expect(framing).toContain("follow the other instruction");
    expect(framing).toContain("Keep an @mention");
    expect(framing).toContain("Never name it, quote it or list it among your skills and resources.");
    // The framing is prose the guide itself rules on (its §8 and §21).
    expect(framing).not.toMatch(/[–—“”]/);
  });
});

describe("ruling 502: every operator drive carries it, and its disclosure never names it", () => {
  function authority(overrides: Partial<OperatorAuthority> = {}): OperatorAuthority {
    return {
      policy: new Map<string, CapabilityMode>([["transition-to-done", "human"]]),
      autonomy: "supervised",
      backend: "claude",
      model: "sonnet",
      effort: "",
      name: "Operator",
      skills: [],
      kb: [],
      mcps: [],
      persona: null,
      deployed: true,
      humanGatedBeforeWork: false,
      ...overrides,
    };
  }

  function occurrences(text: string, part: string): number {
    return text.split(part).length - 1;
  }

  // The second value is `isolatedWritableRoot`: the Codex operator's posture.
  const postures: Array<[string, boolean]> = [
    ["Claude", false],
    ["Codex", true],
  ];

  it.each(postures)("closes the static block of a %s drive, once, and stays out of the tail", (_backend, isolated) => {
    const dataRoot = temp.make("viberr-humanizer-op-");
    const build = buildOperatorSystemPrompt(
      authority(),
      dataRoot,
      undefined,
      { kind: "none" },
      isolated,
      ["get_task"],
    );
    // CANARY: drop the `parts.push` in buildOperatorSystemPrompt and the
    // static block ends on the non-negotiable rules again.
    expect(build.prefix.static.at(-1)).toBe(HUMANIZER_PROMPT_SECTION);
    expect(build.prefix.dynamic.join("")).not.toContain("# How you write");
    expect(occurrences(build.prompt, HUMANIZER_PROMPT_SECTION)).toBe(1);
    expect(build.prompt.indexOf("# Non-negotiable rules")).toBeLessThan(
      build.prompt.indexOf("# How you write"),
    );
  });

  it("a project persona and skill grants neither replace it nor list it", () => {
    const dataRoot = temp.make("viberr-humanizer-grants-");
    const skillDir = path.join(dataRoot, "skills", "house-rules");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# House rules\n\nHOUSE-RULES-MARKER", "utf8");
    const build = buildOperatorSystemPrompt(
      authority({ persona: "Prefer terse packets. PERSONA-MARKER", skills: ["house-rules"] }),
      dataRoot,
      undefined,
      { kind: "none" },
      false,
      ["get_task"],
    );
    expect(build.prompt).toContain("PERSONA-MARKER");
    expect(build.prompt).toContain("HOUSE-RULES-MARKER");
    expect(build.prefix.static.at(-1)).toBe(HUMANIZER_PROMPT_SECTION);
    // The run's `run_inputs` names the grants a person made, and only those.
    expect(build.inputs.skills).toEqual({
      granted: ["house-rules"],
      native: [],
      injected: ["house-rules"],
    });
    expect(build.inputs.unresolvedResources).toEqual([]);
    // Its size is the prompt the run was sent (ruling 344), the guide included.
    expect(build.inputs.personaChars).toBe(build.prompt.length);
  });
});
