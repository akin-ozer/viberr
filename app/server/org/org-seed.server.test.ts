import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { runDemoSeed } from "~/server/seed/demo-seed.server";
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

function seedAll(reset = false) {
  const db = dbCtx.makeDb();
  const dataRoot = dbCtx.makeTempDir();
  const demo = runDemoSeed(db, { dataRoot, reset });
  const org = seedOrgResources(db, { dataRoot, reset });
  return { db, dataRoot, demo, org };
}

describe("seedOrgResources", () => {
  it("adds org resources with REAL files while the demo dataset stays intact", () => {
    const { db, dataRoot, demo, org } = seedAll();

    // Existing seed output regression (brief contract). 12 tasks = 10
    // viberr-core + 2 stub-project tasks (DEP-31/BIL-9); 3 profiles after the
    // Advisor/consultant removal AND the Tester→Reviewer merge (operator +
    // developer + reviewer).
    expect(demo).toMatchObject({
      users: 5,
      projects: 3,
      tasks: 12,
      events: 36,
      notifications: 10,
      agentProfiles: 3,
      runs: 18,
    });

    expect(org).toMatchObject({
      kbs: 3,
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
    ]);
    // Real files on disk, scanned counts match the mock spread (6/6/3).
    expect(kbs.map((k) => k.fileCount)).toEqual([6, 6, 3]);
    expect(
      existsSync(
        path.join(dataRoot, "kb", "architecture-notes", "decisions", "adr-001-task-store.md"),
      ),
    ).toBe(true);

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

  it("is idempotent and --reset restores a pristine org dataset", () => {
    const { db, dataRoot } = seedAll();

    // Second plain run: same counts, nothing duplicated. No fabricated
    // credentials are ever seeded (honest empty slate).
    seedOrgResources(db, { dataRoot });
    expect(listConnections(db)).toHaveLength(0);
    expect(listKnowledgeBases(db, { dataRoot })).toHaveLength(3);
    expect(
      db.prepare(`SELECT count(*) AS c FROM github_pats`).get(),
    ).toEqual({ c: 0 });

    // Mutate, then --reset: resource tables + folders rebuilt; still no
    // fabricated connection/MCP appears.
    db.prepare(`DELETE FROM org_skills`).run();
    runDemoSeed(db, { dataRoot, reset: true });
    const org = seedOrgResources(db, { dataRoot, reset: true });
    expect(org).toMatchObject({ kbs: 3, skills: 4, mcps: 0, connections: 0 });
    expect(listSkills(db, { dataRoot })).toHaveLength(4);
    expect(listConnections(db)).toHaveLength(0);
  });
});
