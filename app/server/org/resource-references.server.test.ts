import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeProject } from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import {
  countProjectDeploymentGrants,
  updateResourceReferences,
} from "./resource-references.server";

/**
 * P14-KM-07: the DEPLOYMENT leg of reference rewriting had no test at all. The
 * pass-13 integrity suite covered `agents/profiles/*.md` only, so the harder
 * path — a slug buried in `agents[].definition.resources` inside project.md —
 * could break silently while the template assertions stayed green.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function deployProfile(
  dataRoot: string,
  slug: string,
  resources: { skills?: string[]; mcps?: string[]; kb?: string[] },
): void {
  writeProject(dataRoot, {
    name: "Viberr Core",
    slug,
    repo: "akin-ozer/viberr",
    defaultBranch: "main",
    taskPrefix: "VIB",
    nextTaskNumber: 100,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members: [],
    agents: [
      {
        profileId: "operator",
        capabilities: [],
        extras: [],
        definition: { name: "Operator", resources: { skills: ["viberr-app-expertise"] } },
      },
      {
        profileId: "scout",
        capabilities: [],
        extras: [],
        definition: { name: "Scout", resources },
      },
    ],
    credentialPolicy: null,
    guardrails: [],
  });
}

function deployedResources(
  dataRoot: string,
  slug: string,
  profileId: string,
): { skills?: string[]; mcps?: string[]; kb?: string[] } {
  const parsed = readProjectFile({ projectSlug: slug, dataRoot })!.parsed;
  const deployment = parsed.frontmatter.agents.find(
    (a) => a.profileId === profileId,
  )!;
  return deployment.definition!.resources!;
}

describe("updateResourceReferences — project deployments (rewriteProjects)", () => {
  it("rewrites a renamed MCP inside agents[].definition.resources", async () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, {
      skills: [],
      mcps: ["vm-memory", "billing-api"],
      kb: [],
    });

    const result = await updateResourceReferences(
      "mcps",
      "vm-memory",
      "vm-graph-memory",
      store.dataRoot,
    );

    expect(result.updated).toBe(1);
    expect(deployedResources(store.dataRoot, store.slug, "scout").mcps).toEqual([
      "vm-graph-memory",
      "billing-api",
    ]);
  });

  it("drops a deleted KB from the deployment and leaves the rest alone", async () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, {
      skills: ["reviewer"],
      mcps: [],
      kb: ["p13-facts", "release-checklist"],
    });

    await updateResourceReferences("kb", "p13-facts", null, store.dataRoot);

    const res = deployedResources(store.dataRoot, store.slug, "scout");
    expect(res.kb).toEqual(["release-checklist"]);
    expect(res.skills).toEqual(["reviewer"]);
    // Deployments that never referenced it are untouched.
    expect(deployedResources(store.dataRoot, store.slug, "operator").skills).toEqual([
      "viberr-app-expertise",
    ]);
  });

  it("does not duplicate the target when a profile already grants both names", async () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, {
      skills: ["old-craft", "new-craft"],
      mcps: [],
      kb: [],
    });

    await updateResourceReferences(
      "skills",
      "old-craft",
      "new-craft",
      store.dataRoot,
    );

    expect(deployedResources(store.dataRoot, store.slug, "scout").skills).toEqual([
      "new-craft",
    ]);
  });

  it("reports nothing changed when no deployment references the slug", async () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, { skills: [], mcps: [], kb: [] });

    const result = await updateResourceReferences(
      "kb",
      "never-granted",
      "renamed",
      store.dataRoot,
    );

    expect(result.updated).toBe(0);
  });

  it("a malformed project.md cannot block the rewrite of the healthy ones", async () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, { skills: [], mcps: ["vm-memory"], kb: [] });
    const brokenDir = path.join(store.dataRoot, "projects", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "project.md"), "not: [valid\n---\nnope");

    const result = await updateResourceReferences(
      "mcps",
      "vm-memory",
      "vm-graph-memory",
      store.dataRoot,
    );

    expect(result.updated).toBe(1);
    expect(deployedResources(store.dataRoot, store.slug, "scout").mcps).toEqual([
      "vm-graph-memory",
    ]);
  });
});

describe("countProjectDeploymentGrants — the read-only twin", () => {
  it("counts a KB granted ONLY by a project deployment (the org-template blind spot)", () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, {
      skills: [],
      mcps: [],
      kb: ["p13-facts", "release-checklist"],
    });

    // The delete-confirm counts org TEMPLATE grants; this KB has none, yet a
    // project agent grants it — the count the dialog was missing.
    expect(
      countProjectDeploymentGrants("kb", "p13-facts", store.dataRoot),
    ).toBe(1);
    expect(
      countProjectDeploymentGrants("kb", "release-checklist", store.dataRoot),
    ).toBe(1);
  });

  it("counts each deployment that grants the slug across projects", () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, { skills: [], mcps: ["vm-memory"], kb: [] });
    // A second project also granting the same MCP — both deployments count.
    deployProfile(store.dataRoot, "second-project", {
      skills: [],
      mcps: ["vm-memory"],
      kb: [],
    });

    expect(
      countProjectDeploymentGrants("mcps", "vm-memory", store.dataRoot),
    ).toBe(2);
  });

  it("returns 0 when no deployment grants the slug", () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, { skills: [], mcps: [], kb: [] });

    expect(
      countProjectDeploymentGrants("skills", "never-granted", store.dataRoot),
    ).toBe(0);
  });

  it("skips a malformed project.md instead of throwing", () => {
    const store = setupTestStore(ctx);
    deployProfile(store.dataRoot, store.slug, { skills: [], mcps: ["vm-memory"], kb: [] });
    const brokenDir = path.join(store.dataRoot, "projects", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "project.md"), "not: [valid\n---\nnope");

    // The healthy deployment still counts; the broken one is skipped, not fatal.
    expect(
      countProjectDeploymentGrants("mcps", "vm-memory", store.dataRoot),
    ).toBe(1);
  });
});
