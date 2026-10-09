import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBoardHolding } from "../../../test-support/resource-boards";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  auditedResource,
  auditedTemplate,
  countProjectDeploymentGrants,
  countTemplateGrants,
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

const yamlList = (key: string, items: string[]): string[] =>
  items.length === 0
    ? [`  ${key}: []`]
    : [`  ${key}:`, ...items.map((i) => `    - ${i}`)];

/** One org template, `agents/profiles/<id>.md`, named by its id. */
function writeProfile(
  dataRoot: string,
  id: string,
  kind: string,
  resources: { skills?: string[]; kb?: string[]; mcps?: string[] },
): void {
  const dir = path.join(dataRoot, "agents", "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${id}.md`),
    [
      "---",
      `id: ${id}`,
      `name: ${id}`,
      `kind: ${kind}`,
      "backends:",
      "  - claude",
      "role: Test",
      "stages: []",
      "resources:",
      ...yamlList("skills", resources.skills ?? []),
      ...yamlList("kb", resources.kb ?? []),
      ...yamlList("mcps", resources.mcps ?? []),
      "capabilities: []",
      "extras: []",
      "---",
      "",
      "A profile.",
      "",
    ].join("\n"),
    "utf8",
  );
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
    writeBoardHolding(store.dataRoot, store.slug, {
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
    writeBoardHolding(store.dataRoot, store.slug, {
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
    writeBoardHolding(store.dataRoot, store.slug, {
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
    writeBoardHolding(store.dataRoot, store.slug, { skills: [], mcps: [], kb: [] });

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
    writeBoardHolding(store.dataRoot, store.slug, { skills: [], mcps: ["vm-memory"], kb: [] });
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
    writeBoardHolding(store.dataRoot, store.slug, {
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
    writeBoardHolding(store.dataRoot, store.slug, { skills: [], mcps: ["vm-memory"], kb: [] });
    // A second project also granting the same MCP — both deployments count.
    writeBoardHolding(store.dataRoot, "second-project", {
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
    writeBoardHolding(store.dataRoot, store.slug, { skills: [], mcps: [], kb: [] });

    expect(
      countProjectDeploymentGrants("skills", "never-granted", store.dataRoot),
    ).toBe(0);
  });

  it("skips a malformed project.md instead of throwing", () => {
    const store = setupTestStore(ctx);
    writeBoardHolding(store.dataRoot, store.slug, { skills: [], mcps: ["vm-memory"], kb: [] });
    const brokenDir = path.join(store.dataRoot, "projects", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "project.md"), "not: [valid\n---\nnope");

    // The healthy deployment still counts; the broken one is skipped, not fatal.
    expect(
      countProjectDeploymentGrants("mcps", "vm-memory", store.dataRoot),
    ).toBe(1);
  });
});

/**
 * The delete-confirm's template count came from `listGlobalAgentProfiles`,
 * which is the specialist CRUD list and drops `controller.md` / `operator.md` —
 * while the delete's own `rewriteTemplates` strips the grant out of EVERY
 * profile file. So the three resources the shipped store attaches to those two
 * templates read as "Nothing grants it" immediately before the delete removed
 * their grants.
 */
describe("countTemplateGrants — the read-only twin of rewriteTemplates", () => {
  it("counts a grant held only by a template the specialist list hides", () => {
    const store = setupTestStore(ctx);
    // The shipped shape: a resource attached to the CONTROLLER template alone.
    writeProfile(store.dataRoot, "controller", "controller", {
      kb: ["controller-handbook"],
      skills: ["controller-guide"],
    });
    writeProfile(store.dataRoot, "operator", "operator", {
      skills: ["viberr-app-expertise"],
    });
    writeProfile(store.dataRoot, "developer", "specialist", { skills: [] });

    expect(
      countTemplateGrants("kb", "controller-handbook", store.dataRoot),
    ).toBe(1);
    expect(
      countTemplateGrants("skills", "controller-guide", store.dataRoot),
    ).toBe(1);
    expect(
      countTemplateGrants("skills", "viberr-app-expertise", store.dataRoot),
    ).toBe(1);
    // A resource nothing grants still counts zero.
    expect(countTemplateGrants("kb", "nothing-grants-this", store.dataRoot)).toBe(0);
  });

  it("counts every template that grants the slug, and skips an unreadable one", () => {
    const store = setupTestStore(ctx);
    writeProfile(store.dataRoot, "controller", "controller", { mcps: ["shared"] });
    writeProfile(store.dataRoot, "developer", "specialist", { mcps: ["shared"] });
    const dir = path.join(store.dataRoot, "agents", "profiles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "broken.md"), "not a profile at all", "utf8");

    expect(countTemplateGrants("mcps", "shared", store.dataRoot)).toBe(2);
  });
});

/**
 * Ruling 34: the boards whose runs are given a resource, which the audit row
 * of a write to it keeps, and which puts the write on those boards' Activity.
 */
describe("auditedResource — the boards given a resource (ruling 34)", () => {
  // CANARY: drop the `rulingsKb` leg and the board that only names the
  // knowledge base as its rulings is gone; skip the operator's deployment and
  // no board holds the operator's skill.
  it("names each board by the agents that hold the resource, and the board whose rulings it is", () => {
    const store = setupTestStore(ctx);
    writeBoardHolding(store.dataRoot, store.slug, { kb: ["mapping"] }, { rulingsKb: "house-rules" });
    writeBoardHolding(store.dataRoot, "second-project", { kb: ["house-rules", "mapping"] });
    // A board whose file cannot be read is not asked, and stops nobody.
    const brokenDir = path.join(store.dataRoot, "projects", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "project.md"), "not: [valid\n---\nnope");

    expect(auditedResource("kb", "house-rules", store.dataRoot)).toEqual({
      kind: "kb",
      key: "house-rules",
      boards: [
        { project: "second-project", rulings: false, agents: ["Scout"] },
        { project: store.slug, rulings: true, agents: [] },
      ],
    });
    expect(auditedResource("skill", "viberr-app-expertise", store.dataRoot).boards).toEqual([
      { project: "second-project", rulings: false, agents: ["Operator"] },
      { project: store.slug, rulings: false, agents: ["Operator"] },
    ]);
    expect(auditedResource("kb", "nobody-holds-this", store.dataRoot).boards).toEqual([]);
  });

  // CANARY: read `deployment.definition?.resources` alone, as the count above
  // does, and the judge that resolves its template holds nothing.
  it("asks a deployment that wrote no copy of its grants through its template", () => {
    const store = setupTestStore(ctx);
    writeProfile(store.dataRoot, "judge", "specialist", { kb: ["golden-set"], mcps: ["pricing"] });
    writeBoardHolding(
      store.dataRoot,
      store.slug,
      {},
      { agents: [{ profileId: "judge", capabilities: [], extras: [] }] },
    );

    expect(auditedResource("kb", "golden-set", store.dataRoot).boards).toEqual([
      { project: store.slug, rulings: false, agents: ["judge"] },
    ]);
    expect(auditedResource("mcp", "pricing", store.dataRoot).boards).toEqual([
      { project: store.slug, rulings: false, agents: ["judge"] },
    ]);
  });

  // CANARY: name every board that deploys the profile and the board whose
  // copy holds the changed field is told of an edit that never reaches it; ask
  // only whether a copy exists and the board whose copy left the persona to
  // the template is not told its agent's persona changed.
  it("names the boards an edit of a template reaches: a deployment with no copy, or a copy that leaves the template what the edit changed", () => {
    const store = setupTestStore(ctx);
    writeProfile(store.dataRoot, "judge", "specialist", {});
    const judge = { profileId: "judge", capabilities: [], extras: [] };
    const copy = { name: "Judge", model: "sonnet", stages: ["review"] };
    writeBoardHolding(store.dataRoot, "no-copy", {}, { agents: [judge] });
    writeBoardHolding(store.dataRoot, "own-model", {}, { agents: [{ ...judge, definition: copy }] });
    writeBoardHolding(store.dataRoot, "other-agent", {});

    // The persona changed: both boards leave it to the template.
    expect(auditedTemplate("judge", ["persona"], store.dataRoot)).toEqual({
      kind: "template",
      key: "judge",
      boards: [
        { project: "no-copy", rulings: false, agents: ["judge"] },
        { project: "own-model", rulings: false, agents: ["Judge"] },
      ],
    });
    // The model changed: one board's copy names its own.
    expect(auditedTemplate("judge", ["model"], store.dataRoot).boards).toEqual([
      { project: "no-copy", rulings: false, agents: ["judge"] },
    ]);
    // Nothing changed, or no such template: no board.
    expect(auditedTemplate("judge", [], store.dataRoot).boards).toEqual([]);
    expect(auditedTemplate("nobody", ["model"], store.dataRoot).boards).toEqual([]);
  });
});
