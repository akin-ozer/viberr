import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  parseAgentProfileContent,
  serializeAgentProfile,
  type AgentProfileFrontmatter,
} from "~/server/files/agent-profile-file.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  ensureDataRootDirs,
} from "~/server/files/file-store-root.server";
import {
  deleteGlobalAgentProfile,
  listGlobalAgentProfiles,
  resolveResourceGrants,
  saveGlobalAgentProfile,
} from "./gagents.server";

/**
 * Global agent profile templates: the org panel CRUDs the phase-3 template
 * FILES; `used` is a projection over projects.agent_policy_json and gates
 * deletion; edits preserve the fields the modal doesn't own (capability
 * policy, extras, icon…).
 */

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);

const ACTOR = { userId: "u_t", label: "t@test" };

function writeTemplate(
  dataRoot: string,
  id: string,
  kind: "operator" | "specialist",
  extraFm: Partial<AgentProfileFrontmatter> = {},
) {
  writeFileAtomic(
    agentProfileFilePath(id, dataRoot),
    serializeAgentProfile({
      frontmatter: {
        id,
        kind,
        name: id[0]!.toUpperCase() + id.slice(1),
        role: "Implementation",
        desc: "Short operator-facing summary.",
        icon: "branch",
        backends: ["codex", "claude"],
        model: "codex-large",
        scope: "Global base",
        stages: ["ready", "impl"],
        spanAll: false,
        capabilities: [{ capabilityId: "cap.branch.create", mode: "direct" }],
        extras: [{ label: "Run the validation suite", mode: "direct" }],
        resources: { skills: ["repo-write"], mcps: ["github"], kb: ["Coding standards"] },
        ...extraFm,
      },
      description: "Implements stage work.",
    }),
  );
}

function insertProjectRow(db: ReturnType<typeof dbCtx.makeDb>, slug: string, profileIds: string[]) {
  db.prepare(
    `INSERT INTO projects (slug, name, task_prefix, agent_policy_json,
       source_path, content_hash, parsed_at)
     VALUES (?, ?, 'T', ?, ?, 'hash', ?)`,
  ).run(
    slug,
    slug,
    JSON.stringify(profileIds.map((profileId) => ({ profileId, capabilities: [], extras: [] }))),
    `projects/${slug}/project.md`,
    new Date().toISOString(),
  );
}

function setup() {
  const db = dbCtx.makeDb();
  const dataRoot = dbCtx.makeTempDir();
  ensureDataRootDirs(dataRoot);
  const ctx = { dataRoot };
  return { db, dataRoot, ctx };
}

describe("global agent profiles", () => {
  it("lists specialists only, with used counts from project deployments", () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "operator", "operator");
    writeTemplate(dataRoot, "developer", "specialist");
    writeTemplate(dataRoot, "reviewer", "specialist");
    insertProjectRow(db, "p-one", ["developer", "reviewer"]);
    insertProjectRow(db, "p-two", ["developer", "developer"]); // distinct per project

    const list = listGlobalAgentProfiles(db, ctx);
    expect(list.map((p) => p.id)).toEqual(["developer", "reviewer"]);
    expect(list[0]).toMatchObject({
      name: "Developer",
      backend: "codex",
      used: 2,
      skills: ["repo-write"],
      kbs: ["Coding standards"],
    });
    expect(list[1]!.used).toBe(1);
  });

  it("create writes a template file; duplicate names are refused", async () => {
    const { db, dataRoot, ctx } = setup();
    const { profile, toast } = await saveGlobalAgentProfile(
      db,
      {
        name: "Security reviewer",
        backend: "claude",
        summary: "Second pair of eyes on IAM.",
        persona: "",
        stages: ["review"],
        skills: ["terraform-review"],
        mcps: [],
        kbs: [],
      },
      ACTOR,
      ctx,
    );
    // P13-AP-05 (owner ruling 1): a template is ADOPTED by a project from the
    // Agents → Add from library action; it is never auto-deployed, and the old
    // toast pointed at a "grant eligibility in a project's policy" surface that
    // did not exist.
    expect(toast).toBe(
      "Security reviewer created · add it to a project from Agents → Add from library",
    );
    expect(profile.id).toBe("security-reviewer");
    expect(existsSync(agentProfileFilePath("security-reviewer", dataRoot))).toBe(true);

    await expect(
      saveGlobalAgentProfile(
        db,
        {
          name: "Security Reviewer",
          backend: "codex",
          summary: "dup",
          persona: "",
          stages: ["impl"],
          skills: [],
          mcps: [],
          kbs: [],
        },
        ACTOR,
        ctx,
      ),
    ).rejects.toThrowError(/already exists/);
  });

  /**
   * U35-1 (pass 35): the controller sent `Test &amp; CI Engineer` and this
   * writer stored the entity, derived the id from the escaped text
   * (`test-amp-ci-engineer`) and every card printed `&amp;` literally. Canary:
   * drop the `normalizeDisplayName` call.
   */
  it("U35-1: a name is stored as the person meant it, the id follows, and markup is refused", async () => {
    const { db, dataRoot, ctx } = setup();
    const { profile } = await saveGlobalAgentProfile(
      db,
      {
        name: "Test &amp; CI Engineer",
        backend: "claude",
        summary: "Runs the suite.",
        persona: "",
        stages: ["impl"],
      },
      ACTOR,
      ctx,
    );
    expect(profile.name).toBe("Test & CI Engineer");
    expect(profile.id).toBe("test-ci-engineer");
    expect(existsSync(agentProfileFilePath("test-ci-engineer", dataRoot))).toBe(true);
    await expect(
      saveGlobalAgentProfile(
        db,
        { name: "<b>x</b>", backend: "claude", summary: "s", persona: "", stages: ["impl"] },
        ACTOR,
        ctx,
      ),
    ).rejects.toThrowError("Names cannot contain < or > or control characters.");
  });

  /**
   * Ruling 153 (pass 35, G35-2): a template carries its default model and
   * effort, checked by name against its backend (ruling 139); an edit that
   * omits both keeps them. Canary: drop `effort` from the created frontmatter.
   */
  it("ruling 153: create stores model and effort, a foreign model is refused, and an edit omitting both keeps them", async () => {
    const { db, dataRoot, ctx } = setup();
    await saveGlobalAgentProfile(
      db,
      {
        name: "Astra Engineer",
        backend: "codex",
        summary: "Ships on Astra.",
        persona: "",
        stages: ["impl"],
        model: "gpt-6-astra",
        effort: "medium",
      },
      ACTOR,
      ctx,
    );
    const read = () =>
      parseAgentProfileContent(
        readFileSync(agentProfileFilePath("astra-engineer", dataRoot), "utf8"),
        { fallbackId: "astra-engineer" },
      ).parsed!.frontmatter;
    expect(read().model).toBe("gpt-6-astra");
    expect(read().effort).toBe("medium");
    expect(listGlobalAgentProfiles(db, ctx)[0]).toMatchObject({
      id: "astra-engineer",
      model: "gpt-6-astra",
      effort: "medium",
    });

    await expect(
      saveGlobalAgentProfile(
        db,
        { name: "Opus On Codex", backend: "codex", summary: "s", persona: "", stages: ["impl"], model: "opus" },
        ACTOR,
        ctx,
      ),
    ).rejects.toThrowError(/is a Claude model\. Codex cannot run it/);
    await expect(
      saveGlobalAgentProfile(
        db,
        { name: "Ultra On Codex", backend: "codex", summary: "s", persona: "", stages: ["impl"], effort: "ultra" },
        ACTOR,
        ctx,
      ),
    ).rejects.toThrowError(/not an effort tier Codex offers/);

    // An edit that names neither keeps both; "" clears the tier.
    const base = {
      id: "astra-engineer",
      name: "Astra Engineer",
      backend: "codex" as const,
      summary: "Ships on Astra, still.",
      persona: "",
      stages: ["impl"],
    };
    await saveGlobalAgentProfile(db, base, ACTOR, ctx);
    expect(read().model).toBe("gpt-6-astra");
    expect(read().effort).toBe("medium");
    await saveGlobalAgentProfile(db, { ...base, effort: "" }, ACTOR, ctx);
    expect(read().effort).toBeUndefined();

    // A backend switch whose stored model belongs to the other backend clears
    // it and the toast says so (Q35-11: no dash in the toast).
    const switched = await saveGlobalAgentProfile(
      db,
      { ...base, backend: "claude" },
      ACTOR,
      ctx,
    );
    expect(read().model).toBe("");
    expect(switched.toast).toContain(
      "backend is now Claude; the stored model belonged to Codex and was cleared",
    );
    expect(switched.toast).not.toMatch(/[–—]/);
  });

  it("D32-7: a role given here lands in the file; a blank one keeps the stored role", async () => {
    const { db, dataRoot, ctx } = setup();
    const { profile } = await saveGlobalAgentProfile(
      db,
      {
        name: "Docs writer",
        backend: "claude",
        summary: "Writes the docs.",
        role: "Documentation",
        persona: "",
        stages: ["impl"],
        skills: [],
        mcps: [],
        kbs: [],
      },
      ACTOR,
      ctx,
    );
    // The view carries the role the modal prefills from (a role that merely
    // repeats the name is the pre-pass-32 default and prefills empty there).
    expect(profile.role).toBe("Documentation");
    const read = () =>
      parseAgentProfileContent(
        readFileSync(agentProfileFilePath("docs-writer", dataRoot), "utf8"),
        { fallbackId: "docs-writer" },
      ).parsed!.frontmatter.role;
    expect(read()).toBe("Documentation");
    // Blank keeps the stored role (canary: replace the edit branch's
    // `input.role?.trim() || existing.frontmatter.role || name` with a bare
    // `name` and this reads "Docs writer").
    await saveGlobalAgentProfile(
      db,
      {
        id: "docs-writer",
        name: "Docs writer",
        backend: "claude",
        summary: "Writes the docs.",
        role: "",
        persona: "",
        stages: ["impl"],
        skills: [],
        mcps: [],
        kbs: [],
      },
      ACTOR,
      ctx,
    );
    expect(read()).toBe("Documentation");
    // A NEW role on edit lands (review F9a: this is the half the blank-edit
    // assertion alone could not lock — canary: drop `input.role?.trim() ||`
    // on the edit branch and this still reads "Documentation").
    await saveGlobalAgentProfile(
      db,
      {
        id: "docs-writer",
        name: "Docs writer",
        backend: "claude",
        summary: "Writes the docs.",
        role: "Docs lead",
        persona: "",
        stages: ["impl"],
        skills: [],
        mcps: [],
        kbs: [],
      },
      ACTOR,
      ctx,
    );
    expect(read()).toBe("Docs lead");
  });

  it("edit preserves capability policy + extras (fields the modal doesn't own)", async () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "developer", "specialist");
    await saveGlobalAgentProfile(
      db,
      {
        id: "developer",
        name: "Developer",
        backend: "claude",
        summary: "New summary.",
        persona: "",
        stages: ["impl"],
        skills: ["conventional-commits"],
        mcps: ["github-mcp"],
        kbs: [],
      },
      ACTOR,
      ctx,
    );
    const raw = readFileSync(agentProfileFilePath("developer", dataRoot), "utf8");
    const { parsed } = parseAgentProfileContent(raw, { fallbackId: "developer" });
    expect(parsed!.frontmatter.capabilities).toEqual([
      { capabilityId: "cap.branch.create", mode: "direct" },
    ]);
    expect(parsed!.frontmatter.extras).toEqual([
      { label: "Run the validation suite", mode: "direct" },
    ]);
    // P13-AP-02: `desc` IS the summary the operator reads, so an edited summary
    // must land there. It used to be left untouched while only the body changed,
    // so what the operator saw never updated. (The old test enshrined that bug.)
    expect(parsed!.frontmatter.desc).toBe("New summary.");
    expect(parsed!.frontmatter.backends).toEqual(["claude"]);
    expect(parsed!.frontmatter.stages).toEqual(["impl"]);
    expect(parsed!.frontmatter.resources.skills).toEqual(["conventional-commits"]);
    // P13-AP-01: a blank persona KEEPS the existing body — editing the one-line
    // summary must never flatten a profile's system prompt.
    expect(parsed!.description).toBe("Implements stage work.");
  });

  it("an edited persona replaces the body while the summary stays the blurb", async () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "developer", "specialist");
    await saveGlobalAgentProfile(
      db,
      {
        id: "developer",
        name: "Developer",
        backend: "claude",
        summary: "Implements stage work.",
        persona: "You are the Developer.\n\nShip the smallest correct change.",
        stages: ["impl"],
        skills: [],
        mcps: [],
        kbs: [],
      },
      ACTOR,
      ctx,
    );
    const raw = readFileSync(agentProfileFilePath("developer", dataRoot), "utf8");
    const { parsed } = parseAgentProfileContent(raw, { fallbackId: "developer" });
    expect(parsed!.frontmatter.desc).toBe("Implements stage work.");
    expect(parsed!.description).toBe(
      "You are the Developer.\n\nShip the smallest correct change.",
    );
  });

  it("a created template carries EXPLICIT capability grants, never an empty list", async () => {
    const { db, dataRoot, ctx } = setup();
    await saveGlobalAgentProfile(
      db,
      {
        name: "Doc writer",
        backend: "claude",
        summary: "Writes docs.",
        persona: "You write documentation.",
        stages: ["impl"],
        skills: [],
        mcps: [],
        kbs: [],
      },
      ACTOR,
      ctx,
    );
    const raw = readFileSync(agentProfileFilePath("doc-writer", dataRoot), "utf8");
    const { parsed } = parseAgentProfileContent(raw, { fallbackId: "doc-writer" });
    // P13-AP-06: `capabilities: []` means "unspecified", which the tool policy
    // reads as FULL access — a casually created template would carry silent
    // repo-write power into every project that adopts it.
    expect(parsed!.frontmatter.capabilities.length).toBeGreaterThan(0);
    const byId = new Map(
      parsed!.frontmatter.capabilities.map((c) => [c.capabilityId, c.mode]),
    );
    expect(byId.get("merge-pull-request")).toBe("human");
    expect(byId.get("report-validation-verdict")).toBe("off");
    expect(byId.get("use-web-search-fetch")).toBe("direct");
    // P13: this editor has no capability UI, so a template must NOT start with
    // repo-write. Live evidence: an "Org Docs Writer" whose own summary said
    // "never touches app code" was created holding all four delivery grants.
    expect(byId.get("execute-code-or-write-repo")).toBe("off");
    expect(byId.get("create-task-branch")).toBe("off");
    expect(byId.get("commit-push-branch")).toBe("off");
    expect(byId.get("open-review-pr")).toBe("off");
  });

  it("delete is refused while deployed; otherwise removes the file", () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "developer", "specialist");
    insertProjectRow(db, "p-one", ["developer"]);

    const refused = deleteGlobalAgentProfile(db, "developer", ACTOR, ctx);
    expect(refused).toMatchObject({ status: "in_use", used: 1 });
    if (refused.status === "in_use") {
      expect(refused.message).toBe("Detach Developer from its 1 project first");
    }
    expect(existsSync(agentProfileFilePath("developer", dataRoot))).toBe(true);

    db.prepare(`DELETE FROM projects`).run();
    const deleted = deleteGlobalAgentProfile(db, "developer", ACTOR, ctx);
    expect(deleted).toMatchObject({ status: "deleted", toast: "Developer deleted" });
    expect(existsSync(agentProfileFilePath("developer", dataRoot))).toBe(false);
  });

  it("the operator template can never be deleted here", () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "operator", "operator");
    expect(() => deleteGlobalAgentProfile(db, "operator", ACTOR, ctx)).toThrowError(
      /system profile/,
    );
  });
});

/**
 * Resource grants (pass 33, F33-7 + F33-8): what a template stores is the STORE
 * KEY the runtime mounts by, and a save touches only the lists it was given.
 */
describe("resource grants on a template", () => {
  /** Seed one skill row, one disk-only skill folder, one MCP row, one KB row. */
  function seedCatalog(db: ReturnType<typeof dbCtx.makeDb>, dataRoot: string) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO org_skills (id, name, summary, created_at, updated_at)
       VALUES ('sk_probe', 'developer-expertise', 'Ships features.', ?, ?)`,
    ).run(now, now);
    mkdirSync(join(dataRoot, "skills", "docs-style"), { recursive: true });
    db.prepare(
      `INSERT INTO org_mcp_servers (id, name, transport, target, created_at, updated_at)
       VALUES ('mcp_IIWTf6kB6cdd', 'pass33-probe', 'HTTP', 'https://probe.test/mcp', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO org_knowledge_bases (id, name, dir, refresh, created_at, updated_at)
       VALUES ('kb_ilN51XiiPkJA', 'Pass 33 Handbook', 'pass33-handbook', 'on change', ?, ?)`,
    ).run(now, now);
  }

  it("F33-8: a catalog id normalises to the store key; an unknown grant is refused by name", async () => {
    const { db, dataRoot, ctx } = setup();
    seedCatalog(db, dataRoot);

    // The three ids the controller's own read tools hand back — the exact
    // shapes that landed dangling in agents/profiles/docs-writer.md.
    expect(
      resolveResourceGrants(
        db,
        {
          skills: ["disk:docs-style", "sk_probe"],
          mcps: ["mcp_IIWTf6kB6cdd"],
          kbs: ["kb_ilN51XiiPkJA"],
        },
        ctx,
      ),
    ).toEqual({
      skills: ["docs-style", "developer-expertise"],
      mcps: ["pass33-probe"],
      kbs: ["pass33-handbook"],
    });

    // A key that is already the store key passes through untouched, and a KB
    // display name repairs to its directory (P13-KM-01 parity).
    expect(
      resolveResourceGrants(
        db,
        { skills: ["developer-expertise"], kbs: ["Pass 33 Handbook"] },
        ctx,
      ),
    ).toEqual({ skills: ["developer-expertise"], kbs: ["pass33-handbook"] });

    // Nothing answers to it → refused, naming what it could not find, rather
    // than written as a grant that mounts nothing.
    expect(() =>
      resolveResourceGrants(
        db,
        { skills: ["ghost-skill"], mcps: ["ghost-mcp"] },
        ctx,
      ),
    ).toThrowError(/skill "ghost-skill", MCP server "ghost-mcp"/);
  });

  it("F33-8: a list the caller never sent is not resolved and not returned", async () => {
    const { db, dataRoot, ctx } = setup();
    seedCatalog(db, dataRoot);
    expect(resolveResourceGrants(db, { mcps: ["pass33-probe"] }, ctx)).toEqual({
      mcps: ["pass33-probe"],
    });
    expect(resolveResourceGrants(db, {}, ctx)).toEqual({});
  });

  it("F33-7: an omitted grant list keeps what is stored; an empty one clears it", async () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "developer", "specialist");
    const base = {
      id: "developer",
      name: "Developer",
      backend: "claude" as const,
      summary: "Implements stage work.",
      persona: "",
      stages: ["impl"],
    };

    // A summary-only edit: every stored grant survives it.
    await saveGlobalAgentProfile(db, base, ACTOR, ctx);
    const kept = listGlobalAgentProfiles(db, ctx)[0]!;
    expect(kept).toMatchObject({
      skills: ["repo-write"],
      mcps: ["github"],
      kbs: ["Coding standards"],
    });

    // An empty list is still a decision: it clears that one list and no other.
    await saveGlobalAgentProfile(db, { ...base, kbs: [] }, ACTOR, ctx);
    const cleared = listGlobalAgentProfiles(db, ctx)[0]!;
    expect(cleared).toMatchObject({
      skills: ["repo-write"],
      mcps: ["github"],
      kbs: [],
    });
  });
});
