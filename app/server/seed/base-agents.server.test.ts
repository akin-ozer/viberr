import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { runDemoSeed } from "./demo-seed.server";
import { seedDefaultAgentAssets } from "./default-assets.server";
import { ensureBaseAgentsDeployed } from "./ensure-base-agents.server";
import { baseAgentDeployments, BASE_AGENT_PROFILE_IDS } from "./demo-data.server";
import { buildSpecialistPersona } from "~/server/tasks/specialist-run.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("baseAgentDeployments", () => {
  it("is the operator plus Developer / Reviewer / Tester", () => {
    const ids = baseAgentDeployments().map((d) => d.profileId).sort();
    expect(ids).toEqual([...BASE_AGENT_PROFILE_IDS].sort());
    expect(ids).toContain("operator");
    expect(ids).toContain("developer");
    expect(ids).toContain("reviewer");
    expect(ids).toContain("tester");
    // The Advisor is NOT force-backfilled onto every board.
    expect(ids).not.toContain("consultant");
  });
});

describe("seedDefaultAgentAssets", () => {
  it("ships each built-in agent's definition, skill, and profile into a fresh store", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);

    const read = (...parts: string[]) =>
      readFileSync(path.join(dataRoot, ...parts), "utf8");

    // Definitions (the run persona) for every built-in agent.
    for (const id of ["operator", "developer", "reviewer", "tester"]) {
      expect(existsSync(path.join(dataRoot, "agents", "definitions", `${id}.md`))).toBe(true);
    }
    expect(read("agents", "definitions", "developer.md")).toContain("You are the Developer");
    expect(read("agents", "definitions", "reviewer.md")).toContain("You are the Reviewer");
    expect(read("agents", "definitions", "tester.md")).toContain("You are the Tester");

    // Real, loadable skills — one per specialist role.
    expect(read("skills", "developer-expertise", "SKILL.md")).toContain("developer expertise");
    expect(read("skills", "reviewer-expertise", "SKILL.md")).toContain("reviewer expertise");
    expect(read("skills", "tester-expertise", "SKILL.md")).toContain("tester expertise");

    // Profile templates so the deployments resolve in a never-seeded store.
    for (const id of ["operator", "developer", "reviewer", "tester"]) {
      expect(existsSync(path.join(dataRoot, "agents", "profiles", `${id}.md`))).toBe(true);
    }
    // The Developer profile references its real skill (not a placeholder name).
    expect(read("agents", "profiles", "developer.md")).toContain("developer-expertise");
  });

  it("never clobbers an existing asset (idempotent)", () => {
    const dataRoot = ctx.makeTempDir();
    const dest = path.join(dataRoot, "agents", "definitions", "developer.md");
    seedDefaultAgentAssets(dataRoot);
    writeFileAtomic(dest, "EDITED BY A HUMAN");
    seedDefaultAgentAssets(dataRoot);
    expect(readFileSync(dest, "utf8")).toBe("EDITED BY A HUMAN");
  });
});

describe("buildSpecialistPersona", () => {
  it("assembles the definition + declared skill body once the assets are shipped", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const persona = buildSpecialistPersona({
      profileId: "developer",
      skills: ["developer-expertise"],
      dataRoot,
    });
    expect(persona).toContain("You are the Developer"); // the definition
    expect(persona).toContain("developer-expertise (skill)"); // the skill header
    expect(persona).toContain("Reporting rules"); // skill body content
  });

  it("is empty when the store ships neither a definition nor the skill", () => {
    const dataRoot = ctx.makeTempDir();
    const persona = buildSpecialistPersona({
      profileId: "nonexistent",
      skills: ["also-nonexistent"],
      dataRoot,
    });
    expect(persona).toBe("");
  });
});

describe("ensureBaseAgentsDeployed", () => {
  it("backfills the missing built-in specialists into a project that only has the operator", () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    runDemoSeed(db, { dataRoot });

    // Trim viberr-core's roster down to just the operator, simulating a board
    // that predates the base specialists.
    const file = readProjectFile({ projectSlug: "viberr-core", dataRoot })!;
    const trimmed = {
      ...file.parsed,
      frontmatter: {
        ...file.parsed.frontmatter,
        agents: file.parsed.frontmatter.agents.filter((a) => a.profileId === "operator"),
      },
    };
    writeFileAtomic(projectFilePath("viberr-core", dataRoot), serializeProjectFile(trimmed));
    rebuildPath(db, projectFilePath("viberr-core", dataRoot), { dataRoot });

    ensureBaseAgentsDeployed(db, dataRoot);

    const after = readProjectFile({ projectSlug: "viberr-core", dataRoot })!;
    const ids = after.parsed.frontmatter.agents.map((a) => a.profileId);
    expect(ids).toContain("operator");
    expect(ids).toContain("developer");
    expect(ids).toContain("reviewer");
    expect(ids).toContain("tester");
  });

  it("is idempotent — a fully-rostered project is left untouched", () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    runDemoSeed(db, { dataRoot });

    const before = readProjectFile({ projectSlug: "viberr-core", dataRoot })!;
    const beforeIds = before.parsed.frontmatter.agents.map((a) => a.profileId);
    ensureBaseAgentsDeployed(db, dataRoot);
    const after = readProjectFile({ projectSlug: "viberr-core", dataRoot })!;
    const afterIds = after.parsed.frontmatter.agents.map((a) => a.profileId);
    expect(afterIds).toEqual(beforeIds);
  });
});
