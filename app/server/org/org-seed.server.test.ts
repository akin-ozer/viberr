import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { runDemoSeed } from "../../../test-support/demo-seed";
import { listConnections } from "./connections.server";
import { listDomains } from "./org-users.server";
import { seedOrgResources } from "./org-seed.server";
import { listKnowledgeBases, listMcpServers, listSkills } from "./resources.server";

/**
 * Org-resource seed: additive to the phase-3/8 demo seed, idempotent under
 * --reset, and the EXISTING demo-seed expectations stay intact (10 tasks /
 * 32 events / 10 notifications / 18 runs — the count-regression guard the
 * 9B brief demands).
 */

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);

async function seedAll(reset = false) {
  const db = dbCtx.makeDb();
  const dataRoot = dbCtx.makeTempDir();
  const demo = await runDemoSeed(db, { dataRoot, reset });
  const org = seedOrgResources(db, { dataRoot, reset });
  return { db, dataRoot, demo, org };
}

describe("seedOrgResources", () => {
  it("adds org resources with REAL files while the demo dataset stays intact", async () => {
    const { db, dataRoot, demo, org } = await seedAll();

    // Existing seed output regression (brief contract). 12 tasks = 10
    // viberr-core + 2 stub-project tasks (DEP-31/BIL-9); 4 org-level profile
    // templates — operator, developer, reviewer, and frontend-design (every
    // catalog entry gets a template; only the first three auto-deploy into a
    // project's roster). No `runs` — the seed fabricates ZERO run
    // history (R7-2).
    expect(demo).toMatchObject({
      users: 5,
      projects: 3,
      tasks: 12,
      events: 36,
      notifications: 10,
      agentProfiles: 4,
    });

    expect(org).toMatchObject({
      kbs: 4,
      skills: 4,
      mcps: 0, // honest empty slate — no fabricated MCP health seeded
      domains: 1,
      connections: 0, // no placeholder GitHub connection seeded
    });

    const ctx = { dataRoot };
    const kbs = listKnowledgeBases(db, ctx);
    expect(kbs.map((k) => k.dir)).toEqual([
      "architecture-notes",
      "api-contracts",
      "deploy-runbooks",
      "repo-conventions",
    ]);
    // Real files on disk, scanned counts match the mock spread (6/6/3), plus
    // the repo-conventions KB's 4 real doc files.
    expect(kbs.map((k) => k.fileCount)).toEqual([6, 6, 3, 4]);
    expect(
      existsSync(
        path.join(dataRoot, "kb", "architecture-notes", "decisions", "adr-001-task-store.md"),
      ),
    ).toBe(true);
    // repo-conventions is grounded in THIS repo's real docs, not a fabricated
    // demo ADR — assert the real file landed with real content.
    expect(
      readFileSync(path.join(dataRoot, "kb", "repo-conventions", "contributing.md"), "utf8"),
    ).toContain("## Running the test suite");

    const skills = listSkills(db, ctx);
    expect(skills.map((s) => s.name)).toEqual([
      "conventional-commits",
      "terraform-review",
      "api-design",
      "changelog-writer",
    ]);
    for (const skill of skills) {
      expect(existsSync(path.join(dataRoot, "skills", skill.name, "SKILL.md"))).toBe(true);
      expect(skill.body.length).toBeGreaterThan(10);
    }
    expect(skills[1]!.fileCount).toBe(3); // SKILL.md + 2 checklists

    // Honest empty slate: no fabricated MCP health, no placeholder connection.
    expect(listMcpServers(db)).toHaveLength(0);
    expect(listConnections(db)).toHaveLength(0);

    expect(listDomains(db).map((d) => d.domain)).toEqual(["@viberr.dev"]);
  });

  it("is idempotent and --reset restores a pristine org dataset", async () => {
    const { db, dataRoot } = await seedAll();

    // Second plain run: same counts, nothing duplicated. No fabricated
    // credentials are ever seeded (honest empty slate).
    seedOrgResources(db, { dataRoot });
    expect(listConnections(db)).toHaveLength(0);
    expect(listKnowledgeBases(db, { dataRoot })).toHaveLength(4);
    expect(
      db.prepare(`SELECT count(*) AS c FROM github_pats`).get(),
    ).toEqual({ c: 0 });

    // Mutate, then --reset: resource tables + folders rebuilt; still no
    // fabricated connection/MCP appears.
    db.prepare(`DELETE FROM org_skills`).run();
    await runDemoSeed(db, { dataRoot, reset: true });
    const org = seedOrgResources(db, { dataRoot, reset: true });
    expect(org).toMatchObject({ kbs: 4, skills: 4, mcps: 0, connections: 0 });
    expect(listSkills(db, { dataRoot })).toHaveLength(4);
    expect(listConnections(db)).toHaveLength(0);
  });

  it("preserves human edits to existing KB/skill files on a plain re-seed (seed #5)", async () => {
    const { db, dataRoot } = await seedAll();
    const kbFile = path.join(dataRoot, "kb", "architecture-notes", "overview.md");
    const skillFile = path.join(dataRoot, "skills", "conventional-commits", "SKILL.md");
    writeFileSync(kbFile, "# Edited by a human\n");
    writeFileSync(skillFile, "## Edited skill body\n");
    // Row edits an admin could make in the UI (rename, change refresh cadence).
    db.prepare(
      `UPDATE org_knowledge_bases SET refresh = 'manual', name = 'Renamed' WHERE dir = 'architecture-notes'`,
    ).run();

    // Plain re-seed (no --reset) must NOT clobber existing resources.
    seedOrgResources(db, { dataRoot });

    expect(readFileSync(kbFile, "utf8")).toBe("# Edited by a human\n");
    expect(readFileSync(skillFile, "utf8")).toBe("## Edited skill body\n");
    expect(
      db
        .prepare(`SELECT refresh, name FROM org_knowledge_bases WHERE dir = 'architecture-notes'`)
        .get(),
    ).toMatchObject({ refresh: "manual", name: "Renamed" });

    // But a MISSING resource is (re)created — only-create-what's-absent.
    rmSync(path.join(dataRoot, "kb", "deploy-runbooks"), { recursive: true, force: true });
    seedOrgResources(db, { dataRoot });
    expect(
      existsSync(path.join(dataRoot, "kb", "deploy-runbooks", "release-checklist.md")),
    ).toBe(true);
  });
});
