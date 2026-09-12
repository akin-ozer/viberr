import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  setupTestStore,
  writeProject,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { deployAgentProfileFromLibrary } from "~/features/agents/agent-profile-actions.server";
import { saveGlobalAgentProfile } from "./gagents.server";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import {
  listTemplateResourceDrift,
  propagateTemplateResources,
  resourceDrift,
} from "./template-propagation.server";

/**
 * Ruling 156 (pass 35, F35-7): a library deploy COPIES the template's grants
 * onto `project.md`, a run mounts that copy, and a template edit never reached
 * it. This module is the one writer of a copy's grants from its template.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const DEVELOPER_STAGES = ["ready", "impl"];

function arda(store: TestStore) {
  return { userId: store.users.arda.id, label: store.users.arda.email };
}

/** The seeded store with the Developer template deployed on viberr-core. */
async function storeWithDeployedDeveloper(): Promise<TestStore> {
  const store = setupTestStore(ctx);
  seedDefaultAgentAssets(store.dataRoot);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  await deployAgentProfileFromLibrary(
    store.db,
    { projectSlug: store.slug, profileId: "developer" },
    arda(store),
    { dataRoot: store.dataRoot },
  );
  return store;
}

/** Grant `mcps` on the Developer TEMPLATE (the org writer, no propagation). */
async function grantOnTemplate(
  store: TestStore,
  mcps: string[],
  propagate = false,
) {
  return saveGlobalAgentProfile(
    store.db,
    {
      id: "developer",
      name: "Developer",
      backend: "claude",
      summary: "Implements the change.",
      persona: "",
      stages: DEVELOPER_STAGES,
      mcps,
      propagate,
    },
    arda(store),
    { dataRoot: store.dataRoot },
  );
}

function copyOf(store: TestStore, slug = store.slug) {
  return readProjectFile({ projectSlug: slug, dataRoot: store.dataRoot })!.parsed
    .frontmatter.agents.find((a) => a.profileId === "developer")!;
}

describe("resourceDrift", () => {
  it("names what the copy lacks and what it holds beyond the template", () => {
    expect(resourceDrift({ mcps: [] }, { mcps: ["context7"] })).toMatchObject({
      missing: { mcps: ["context7"], skills: [], kb: [] },
      extra: { mcps: [], skills: [], kb: [] },
    });
    expect(
      resourceDrift({ skills: ["k8s-notes"] }, { skills: [] }),
    ).toMatchObject({ extra: { skills: ["k8s-notes"] } });
  });

  it("is order-insensitive and null for equal lists", () => {
    expect(
      resourceDrift(
        { skills: ["b", "a"], mcps: [], kb: ["x"] },
        { skills: ["a", "b"], mcps: [], kb: ["x"] },
      ),
    ).toBeNull();
    expect(resourceDrift({}, {})).toBeNull();
  });
});

describe("listTemplateResourceDrift", () => {
  it("lists the non-archived project whose copy no longer carries the template's grants", async () => {
    const store = await storeWithDeployedDeveloper();
    // The deploy copied the template as it was: nothing differs yet.
    expect(listTemplateResourceDrift(store.db, "developer", { dataRoot: store.dataRoot })).toEqual([]);
    await grantOnTemplate(store, ["github"]);
    const drift = listTemplateResourceDrift(store.db, "developer", { dataRoot: store.dataRoot });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      projectSlug: "viberr-core",
      projectName: "Viberr Core",
      drift: { missing: { mcps: ["github"] } },
    });
  });

  it("skips an archived project and a definition-less deployment", async () => {
    const store = await storeWithDeployedDeveloper();
    const base = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    // An archived project carrying a diverged copy: nobody can bring it up to date.
    writeProject(store.dataRoot, {
      name: "Archived Service",
      slug: "archived-service",
      repo: "akin-ozer/archived-service",
      defaultBranch: "main",
      taskPrefix: "ARC",
      nextTaskNumber: 1,
      stages: GOVERNED_TEMPLATE.stages,
      workflow: GOVERNED_TEMPLATE.workflow,
      members: base.members,
      agents: [copyOf(store)],
      credentialPolicy: null,
      guardrails: [],
      requiredReviewers: [],
      archived: true,
    });
    // A seeded-shape deployment: profileId + capabilities, no definition, so
    // it resolves the template live and cannot drift.
    writeProject(store.dataRoot, {
      name: "Live Service",
      slug: "live-service",
      repo: "akin-ozer/live-service",
      defaultBranch: "main",
      taskPrefix: "LIV",
      nextTaskNumber: 1,
      stages: GOVERNED_TEMPLATE.stages,
      workflow: GOVERNED_TEMPLATE.workflow,
      members: base.members,
      agents: [{ profileId: "developer", capabilities: [], extras: [] }],
      credentialPolicy: null,
      guardrails: [],
      requiredReviewers: [],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await grantOnTemplate(store, ["github"]);
    const slugs = listTemplateResourceDrift(store.db, "developer", { dataRoot: store.dataRoot }).map(
      (d) => d.projectSlug,
    );
    expect(slugs).toEqual(["viberr-core"]);
  });
});

describe("propagateTemplateResources", () => {
  it("rewrites the copy's grants only, audits per project, and leaves policy and backends alone", async () => {
    const store = await storeWithDeployedDeveloper();
    await grantOnTemplate(store, ["github"]);
    const before = copyOf(store);
    const capabilitiesBefore = JSON.stringify(before.capabilities);
    const backendsBefore = JSON.stringify(before.definition?.backends);
    expect(before.definition?.resources?.mcps).toEqual([]);

    const copies = await propagateTemplateResources(
      store.db,
      { profileId: "developer", projectSlugs: [store.slug] },
      arda(store),
      { dataRoot: store.dataRoot },
    );
    expect(copies).toEqual([
      {
        projectSlug: "viberr-core",
        projectName: "Viberr Core",
        name: "Developer",
        added: ["MCP server github"],
        removed: [],
      },
    ]);
    const after = copyOf(store);
    // Canary: make the writer set `definition.resources` only when it is
    // undefined and this reads `[]`.
    expect(after.definition?.resources?.mcps).toEqual(["github"]);
    expect(JSON.stringify(after.capabilities)).toBe(capabilitiesBefore);
    expect(JSON.stringify(after.definition?.backends)).toBe(backendsBefore);
    const audit = listAuditEvents(store.db, {
      action: "project.agent_profile.resources_synced",
    });
    expect(audit[0]).toMatchObject({
      projectSlug: "viberr-core",
      subjectId: "developer",
      details: { templateId: "developer", mcps: ["github"], source: "org-template" },
    });
    // Nothing differs any more.
    expect(listTemplateResourceDrift(store.db, "developer", { dataRoot: store.dataRoot })).toEqual([]);
  });

  it("refuses a stale fingerprint and writes nothing", async () => {
    const store = await storeWithDeployedDeveloper();
    await grantOnTemplate(store, ["github"]);
    await expect(
      propagateTemplateResources(
        store.db,
        { profileId: "developer", projectSlugs: [store.slug], expectFingerprint: "stale" },
        arda(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrowError(/changed while the editor was open/);
    expect(copyOf(store).definition?.resources?.mcps).toEqual([]);
    expect(
      listAuditEvents(store.db, { action: "project.agent_profile.resources_synced" }),
    ).toEqual([]);
  });

  it("refuses a project that does not deploy the template", async () => {
    const store = await storeWithDeployedDeveloper();
    await expect(
      propagateTemplateResources(
        store.db,
        { profileId: "reviewer", projectSlugs: [store.slug] },
        arda(store),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toThrowError(/No agent Reviewer is deployed on viberr-core/);
  });
});

describe("saveGlobalAgentProfile reports and propagates (ruling 156)", () => {
  it("names the diverged copy after a template edit, and rewrites it with propagate: true", async () => {
    const store = await storeWithDeployedDeveloper();
    const edited = await grantOnTemplate(store, ["github"]);
    expect(edited.diverged).toHaveLength(1);
    expect(edited.diverged[0]).toMatchObject({
      projectSlug: "viberr-core",
      drift: { missing: { mcps: ["github"] } },
    });
    expect(edited.propagated).toEqual([]);
    expect(edited.toast).toBe(
      "Developer updated · running threads re-anchor on the next turn · 1 project copy keeps its own grants",
    );
    expect(copyOf(store).definition?.resources?.mcps).toEqual([]);

    // Canary: drop the `propagate` branch and `propagated` reads `[]`.
    const propagated = await grantOnTemplate(store, ["github"], true);
    expect(propagated.propagated.map((p) => p.projectSlug)).toEqual(["viberr-core"]);
    expect(propagated.diverged).toEqual([]);
    expect(propagated.toast).toBe(
      "Developer updated · running threads re-anchor on the next turn · grants copied to 1 project",
    );
    expect(copyOf(store).definition?.resources?.mcps).toEqual(["github"]);
    const updated = listAuditEvents(store.db, { action: "org.agent_profile.updated" })[0]!;
    expect(updated.details).toMatchObject({ propagated: ["viberr-core"], diverged: [] });
  });
});
