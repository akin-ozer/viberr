import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeProject } from "../../../test-support/test-store";
import { serializeAgentProfile } from "~/server/files/agent-profile-file.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  kbDirPath,
  skillDirPath,
} from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  deleteKnowledgeBase,
  deleteMcpServer,
  deleteSkill,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
} from "./resources.server";
import {
  findAgentResourceUsages,
  listAgentResourceUsages,
  resourceUsageLabels,
} from "./resource-dependencies.server";

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);
const ACTOR = { userId: "u_test", label: "test@viberr.dev" };

function writeTemplate(
  dataRoot: string,
  id: string,
  resources: { skills: string[]; mcps: string[]; kb: string[] },
) {
  writeFileAtomic(
    agentProfileFilePath(id, dataRoot),
    serializeAgentProfile({
      frontmatter: {
        id,
        kind: "specialist",
        name: "Global Developer",
        role: "Implementation",
        icon: "agents",
        backends: ["codex"],
        model: "",
        scope: "Global base",
        stages: ["impl"],
        spanAll: false,
        capabilities: [],
        extras: [],
        resources,
      },
      description: "Shared specialist.",
    }),
  );
}

function configureDeployments(
  dataRoot: string,
  resources: { skills: string[]; mcps: string[]; kb: string[] },
) {
  const current = readProjectFile({ projectSlug: "viberr-core", dataRoot })!;
  current.parsed.frontmatter.agents = [
    {
      profileId: "global-developer",
      capabilities: [],
      extras: [],
    },
    {
      profileId: "inline-specialist",
      capabilities: [],
      extras: [],
      definition: {
        kind: "specialist",
        name: "Inline Specialist",
        resources,
      },
    },
  ];
  writeProject(
    dataRoot,
    current.parsed.frontmatter,
    current.parsed.description,
  );
}

function setupDependencies() {
  const store = setupTestStore(dbCtx);
  const ctx = { dataRoot: store.dataRoot };
  const skill = saveSkill(
    store.db,
    { name: "api-design", summary: "API conventions.", body: "# API" },
    ACTOR,
    ctx,
  ).skill;
  const kb = saveKnowledgeBase(
    store.db,
    { name: "Runbooks", refresh: "manual" },
    ACTOR,
    ctx,
  ).kb;
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO org_mcp_servers
         (id, name, transport, target, auth_json, created_at, updated_at)
       VALUES ('mcp_test', 'github-mcp', 'HTTP', 'https://mcp.test/rpc', '{}', ?, ?)`,
    )
    .run(now, now);
  const refs = {
    skills: [skill.name],
    mcps: ["github-mcp"],
    kb: [kb.dir],
  };
  writeTemplate(store.dataRoot, "global-developer", refs);
  configureDeployments(store.dataRoot, refs);
  return { ...store, ctx, skill, kb };
}

describe("agent resource dependency index (F16/D9)", () => {
  it("indexes global templates, template-backed deployments, and inline deployments", () => {
    const { db, ctx } = setupDependencies();
    const all = listAgentResourceUsages(db, ctx);
    const skill = findAgentResourceUsages(all, "skill", ["api-design"]);

    expect(skill.map((usage) => usage.source).sort()).toEqual([
      "global-template",
      "project-inline",
      "template-deployment",
    ]);
    expect(resourceUsageLabels(skill)).toEqual([
      "Global profile · Global Developer",
      "Viberr Core (viberr-core) · Global Developer",
      "Viberr Core (viberr-core) · Inline Specialist",
    ]);
    expect(findAgentResourceUsages(all, "mcp", ["github-mcp"])).toHaveLength(3);
    expect(findAgentResourceUsages(all, "kb", ["runbooks"])).toHaveLength(3);
  });

  it("blocks rename and delete with an explicit used-by list for every resource kind", async () => {
    const { db, dataRoot, ctx, skill, kb } = setupDependencies();

    expect(() =>
      saveSkill(
        db,
        {
          id: skill.id,
          name: "api-guidelines",
          summary: skill.summary,
          body: skill.body,
        },
        ACTOR,
        ctx,
      ),
    ).toThrow(
      /Global profile · Global Developer.*Viberr Core \(viberr-core\) · Inline Specialist/,
    );
    expect(existsSync(skillDirPath("api-design", dataRoot))).toBe(true);
    expect(() => deleteSkill(db, skill.id, ACTOR, ctx)).toThrow(/used by/);

    expect(() =>
      saveKnowledgeBase(
        db,
        { id: kb.id, name: "Operations runbooks", refresh: "manual" },
        ACTOR,
        ctx,
      ),
    ).toThrow(/used by/);
    expect(existsSync(kbDirPath("runbooks", dataRoot))).toBe(true);
    expect(() => deleteKnowledgeBase(db, kb.id, ACTOR, ctx)).toThrow(/used by/);

    await expect(
      saveMcpServer(
        db,
        {
          id: "mcp_test",
          name: "github-tools",
          transport: "HTTP",
          target: "https://mcp.test/rpc",
          auth: {},
        },
        ACTOR,
        {
          dataRoot,
          fetchImpl: async () => {
            throw new Error("probe must not run before the dependency guard");
          },
        },
      ),
    ).rejects.toThrow(/used by/);
    expect(() => deleteMcpServer(db, "mcp_test", ACTOR, ctx)).toThrow(
      /Viberr Core \(viberr-core\) · Inline Specialist/,
    );
  });
});
