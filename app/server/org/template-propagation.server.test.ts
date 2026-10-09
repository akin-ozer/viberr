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
import { readTemplate } from "~/server/agents/deployment-view.server";
import {
  listTemplateResourceDrift,
  propagateTemplateResources,
  resourceDrift,
} from "./template-propagation.server";

/**
 * Ruling 177 (pass 35, F35-7): a library deploy COPIES the template's grants
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
      fileLeases: [],
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
    fileLeases: [],
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

  /**
   * Ruling 177 (F40-38): the Agents page offers "Use the template's grants"
   * on the Operator too (its drift is computed like any profile's), and every
   * press answered "No such agent profile." about the profile on screen,
   * because this writer took specialist templates only. Canary: restore the
   * `template.kind !== "specialist"` refusal.
   */
  it("rewrites the operator's copy from the operator template, removing a grant the project added", async () => {
    const store = setupTestStore(ctx);
    seedDefaultAgentAssets(store.dataRoot);
    const template = readTemplate("operator", store.dataRoot)!;
    expect(template.kind).toBe("operator");
    const base = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    writeProject(store.dataRoot, {
      ...base,
      agents: [
        {
          profileId: "operator",
          capabilities: [],
          extras: [],
          definition: {
            kind: "operator",
            resources: {
              skills: [...template.resources.skills],
              mcps: [...template.resources.mcps],
              kb: [...template.resources.kb, "akin-dossier"],
            },
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const copies = await propagateTemplateResources(
      store.db,
      { profileId: "operator", projectSlugs: [store.slug] },
      arda(store),
      { dataRoot: store.dataRoot },
    );
    expect(copies).toEqual([
      {
        projectSlug: "viberr-core",
        projectName: "Viberr Core",
        name: template.name,
        added: [],
        removed: ["knowledge base akin-dossier"],
      },
    ]);
    const after = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.agents.find((a) => a.profileId === "operator")!;
    expect(after.definition?.resources?.kb).toEqual(template.resources.kb);
    expect(after.definition?.kind).toBe("operator");
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

describe("saveGlobalAgentProfile reports and propagates (ruling 177)", () => {
  it("names the diverged copy after a template edit, and rewrites it with propagate: true", async () => {
    const store = await storeWithDeployedDeveloper();
    const edited = await grantOnTemplate(store, ["github"]);
    expect(edited.diverged).toHaveLength(1);
    expect(edited.diverged[0]).toMatchObject({
      projectSlug: "viberr-core",
      drift: { missing: { mcps: ["github"] } },
    });
    expect(edited.propagated).toEqual([]);
    // Ruling 177: the same edit also left this copy's SUMMARY behind — a
    // deployment snapshots it and `propagate` rewrites only the grants. This
    // fixture always had that drift; nothing said so until now.
    expect(edited.toast).toBe(
      "Developer updated · running threads re-anchor on the next turn · 1 project copy keeps its own grants" +
        " · 1 project copy still runs the older summary: viberr-core. A deployment snapshots the" +
        " summary, and propagate does not rewrite it; fix each copy on that project's Agents page",
    );
    expect(copyOf(store).definition?.resources?.mcps).toEqual([]);

    // Canary: drop the `propagate` branch and `propagated` reads `[]`.
    const propagated = await grantOnTemplate(store, ["github"], true);
    expect(propagated.propagated.map((p) => p.projectSlug)).toEqual(["viberr-core"]);
    expect(propagated.diverged).toEqual([]);
    expect(propagated.toast).toBe(
      "Developer updated · running threads re-anchor on the next turn · grants copied to 1 project" +
        " · 1 project copy still runs the older summary: viberr-core. A deployment snapshots the" +
        " summary, and propagate does not rewrite it; fix each copy on that project's Agents page",
    );
    expect(copyOf(store).definition?.resources?.mcps).toEqual(["github"]);
    const updated = listAuditEvents(store.db, { action: "org.agent_profile.updated" })[0]!;
    expect(updated.details).toMatchObject({ propagated: ["viberr-core"], diverged: [] });
  });
});

/**
 * Ruling 177 (pass 40, F40-11): the org door's `propagate` also carries a
 * persona the save CHANGED, and the toast names the copies it rewrote; the
 * summary is never propagated, and a save that leaves the persona alone
 * rewrites none.
 */
describe("saveGlobalAgentProfile propagates a changed persona (ruling 177)", () => {
  async function savePersona(store: TestStore, persona: string, propagate: boolean) {
    return saveGlobalAgentProfile(
      store.db,
      {
        id: "developer",
        name: "Developer",
        backend: "claude",
        summary: "Implements the change.",
        persona,
        stages: DEVELOPER_STAGES,
        propagate,
      },
      arda(store),
      { dataRoot: store.dataRoot },
    );
  }

  it("rewrites the older copy's persona, audits it as a persona edit, and says so", async () => {
    const store = await storeWithDeployedDeveloper();
    const before = copyOf(store).definition?.persona;
    expect(before).toBeTruthy();
    const saved = await savePersona(store, "You build what the rulings say, in Go.", true);
    // CANARY: skip `propagateTemplatePersona` and the copy keeps its old text.
    expect(copyOf(store).definition?.persona).toBe("You build what the rulings say, in Go.");
    expect(saved.personaPropagated.map((p) => p.projectSlug)).toEqual(["viberr-core"]);
    expect(saved.toast).toContain("persona rewritten on 1 project copy: viberr-core");
    // The summary still differs and is still named: it is never propagated.
    expect(saved.toast).toContain("still runs the older summary");
    const row = listAuditEvents(store.db, { action: "project.agent_profile.updated" })[0]!;
    expect(row).toMatchObject({ projectSlug: "viberr-core", subjectId: "developer" });
    expect(row.details).toMatchObject({
      personaChanged: true,
      personaChars: "You build what the rulings say, in Go.".length,
      source: "org-template",
    });
    expect(
      listAuditEvents(store.db, { action: "org.agent_profile.updated" })[0]!.details,
    ).toMatchObject({ personaPropagated: ["viberr-core"] });
  });

  it("without propagate, or on a save that leaves the persona alone, no copy is rewritten", async () => {
    const store = await storeWithDeployedDeveloper();
    const before = copyOf(store).definition?.persona;
    const quiet = await savePersona(store, "A new persona nobody propagated.", false);
    expect(quiet.personaPropagated).toEqual([]);
    expect(copyOf(store).definition?.persona).toBe(before);
    // The same persona again, now with propagate: this save changed nothing.
    const again = await savePersona(store, "A new persona nobody propagated.", true);
    expect(again.personaPropagated).toEqual([]);
    expect(copyOf(store).definition?.persona).toBe(before);
    expect(again.toast).toContain("propagate rewrites a persona only on a save that changes it");
  });
});
