import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  parseAgentProfileContent,
  serializeAgentProfile,
} from "~/server/files/agent-profile-file.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  ensureDataRootDirs,
} from "~/server/files/file-store-root.server";
import {
  deleteGlobalAgentProfile,
  listGlobalAgentProfiles,
  saveGlobalAgentProfile,
  usedByProject,
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
  extraFm: Record<string, unknown> = {},
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
    expect(usedByProject(db)).toEqual({ developer: 2, reviewer: 1 });
  });

  it("create writes a template file; duplicate names are refused", () => {
    const { db, dataRoot, ctx } = setup();
    const { profile, toast } = saveGlobalAgentProfile(
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
      "Security reviewer created — add it to a project from Agents → Add from library",
    );
    expect(profile.id).toBe("security-reviewer");
    expect(existsSync(agentProfileFilePath("security-reviewer", dataRoot))).toBe(true);

    expect(() =>
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
    ).toThrowError(/already exists/);
  });

  it("edit preserves capability policy + extras (fields the modal doesn't own)", () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "developer", "specialist");
    saveGlobalAgentProfile(
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

  it("an edited persona replaces the body while the summary stays the blurb", () => {
    const { db, dataRoot, ctx } = setup();
    writeTemplate(dataRoot, "developer", "specialist");
    saveGlobalAgentProfile(
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

  it("a created template carries EXPLICIT capability grants, never an empty list", () => {
    const { db, dataRoot, ctx } = setup();
    saveGlobalAgentProfile(
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
