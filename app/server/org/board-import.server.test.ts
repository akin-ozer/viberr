import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLibraryDeployment,
  readLibraryTemplate,
} from "~/features/agents/agent-profile-actions.server";
import type { AgentDeployment } from "~/schemas/project-file.schema";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { agentProfileFilePath, kbDirPath, skillDirPath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readZip, writeZip } from "~/server/files/zip.server";
import { listAuditLog } from "~/server/projections/activity-feed.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { createPat } from "~/server/secrets/pat-store.server";
import { baseAgentDeployments } from "~/server/seed/agent-catalog.server";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import { DEFAULT_GUARDRAILS } from "~/shared/workflow/templates";
import { listAuditEvents } from "../../../test-support/audit-log";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { createTestDbContext } from "../../../test-support/test-db";
import { actorOf, setupTestStore, writeProject, type TestStore } from "../../../test-support/test-store";
import { exportBoard } from "./board-export.server";
import {
  importBoard,
  previewBoardImport,
  type BoardImportInput,
  type BoardResourceChoice,
} from "./board-import.server";
import { saveGlobalAgentProfile } from "./gagents.server";
import {
  listMcpServers,
  registerMcpServer,
  resolveStoreTarget,
  saveKnowledgeBase,
  saveSkill,
} from "./resources.server";
import { writeStoreFiles } from "./store-files.server";

/**
 * Ruling 653: a board file carries a board's workflow from one instance to
 * another, and an import writes it as a new project without touching what the
 * instance already has. Every test here drives the real writers on both ends:
 * the source board is built through the org settings writers, exported with
 * `exportBoard`, and imported into a second store through `importBoard`.
 */

const ctx = createTestDbContext();
afterEach(() => ctx.cleanup());

const RULINGS_DOC = "# Release rulings\n\n- A breaking change is named in the first line.\n";
const SKILL_MD = "---\nname: release-notes\ndescription: Drafts release notes.\n---\n\n# Release notes\n\nGroup the merged pull requests by area.\n";
/** Bytes no text decoder would round-trip: a knowledge base's binary document. */
const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0xfe, 0x00, 0x01]);
const FINDER_ZIP = path.join(import.meta.dirname, "../../../test-support/fixtures/board-release-desk.zip");

/** The GitHub the target instance's connection reaches. */
function github() {
  return fakeGithubFetch({
    "GET /repos/acme/release-train": {
      body: { default_branch: "main", permissions: { admin: true, maintain: true, push: true }, size: 10 },
    },
  });
}

/** A validated `acme` connection the import binds to, as org settings stores one. */
function seedConnection(db: DatabaseSync, userId: string): void {
  const pat = createPat(
    db,
    { userId, label: "connection · acme", token: "ghp_boardboardboardboardboardboard0000" },
    { userId, label: "seed" },
  );
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
     VALUES ('acme', 'acme', ?, 1, ?, ?)`,
  ).run(pat.id, now, now);
}

/**
 * The board an export is taken from: a knowledge base with a markdown and a
 * binary document, a skill, an MCP server with a marked write tool, a global
 * template deployed from the library, the base agents (deployed with no
 * definition, so they run on their templates), a project-local agent, a
 * required reviewer, a gate, the rulings knowledge base, and the things a
 * board leaves behind (members, a lease, the repository).
 */
async function sourceBoard(): Promise<TestStore> {
  const store = setupTestStore(ctx);
  const actor = actorOf(store.users.arda);
  const orgCtx = { dataRoot: store.dataRoot };
  seedDefaultAgentAssets(store.dataRoot);
  const kb = await saveKnowledgeBase(store.db, { name: "Release rulings", refresh: "manual" }, actor, orgCtx);
  writeStoreFiles(
    store.db,
    resolveStoreTarget(store.db, "kb", kb.kb.id, orgCtx)!,
    [],
    [
      { relPath: "rulings.md", data: Buffer.from(RULINGS_DOC) },
      { relPath: "past/2025.pdf", data: PDF_BYTES },
    ],
    actor,
  );
  await saveSkill(
    store.db,
    { name: "release-notes", summary: "Drafts release notes from merged pull requests.", body: SKILL_MD },
    actor,
    orgCtx,
  );
  registerMcpServer(
    store.db,
    { name: "linear", transport: "HTTP", target: "https://mcp.linear.app/mcp", writeTools: ["create_issue"] },
    actor,
  );
  await saveGlobalAgentProfile(
    store.db,
    {
      name: "Release Manager",
      backend: "claude",
      summary: "Writes the release notes.",
      role: "Release notes",
      persona: "You write the release notes for a version.",
      stages: ["impl", "review"],
      skills: ["release-notes"],
      mcps: ["linear"],
      kbs: ["release-rulings"],
    },
    actor,
    orgCtx,
  );
  const releaseManager = buildLibraryDeployment(
    readLibraryTemplate("release-manager", store.dataRoot),
    {},
    "Viberr Core",
  ).deployment;
  const qaLead: AgentDeployment = {
    profileId: "qa-lead",
    capabilities: [],
    extras: [],
    definition: {
      kind: "specialist",
      name: "QA Lead",
      role: "Quality",
      backends: ["codex"],
      stages: ["review"],
      resources: { skills: ["release-notes"], mcps: [], kb: [] },
    },
  };
  const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter;
  writeProject(
    store.dataRoot,
    {
      ...project,
      agents: [...baseAgentDeployments(), releaseManager, qaLead],
      guardrails: DEFAULT_GUARDRAILS,
      requiredReviewers: [{ stageId: "review", profileId: "qa-lead" }],
      rulingsKb: "release-rulings",
      gates: [{ name: "test", command: "npm test" }],
      fileLeases: [{ paths: ["package-lock.json"], taskKey: "VIB-1", reason: "regenerating it" }],
    },
    "Ships a release from intake to done.",
  );
  reprojectProject(store.db, { dataRoot: store.dataRoot }, store.slug);
  return store;
}

/** A second instance with its shipped assets and an `acme` connection. */
function targetStore(): TestStore {
  const store = setupTestStore(ctx);
  seedDefaultAgentAssets(store.dataRoot);
  seedConnection(store.db, store.users.arda.id);
  return store;
}

function importInput(choices: Record<string, BoardResourceChoice> = {}): BoardImportInput {
  return {
    name: "Release Train",
    key: "REL",
    owner: "acme",
    repoName: "release-train",
    choices: new Map(Object.entries(choices)),
  };
}

function exported(store: TestStore) {
  const file = exportBoard(store.db, store.slug, { dataRoot: store.dataRoot }, new Date("2026-10-04T12:00:00.000Z"));
  return { name: file.fileName, bytes: file.bytes };
}

async function importInto(target: TestStore, file: { name: string; bytes: Uint8Array }, input = importInput()) {
  return importBoard(target.db, file, input, actorOf(target.users.arda), {
    dataRoot: target.dataRoot,
    fetchImpl: github().fetchImpl,
  });
}

describe("ruling 653: a board file carries the workflow and none of the work", () => {
  it("imports into a new project whose workflow keys equal the exported board's, and brings its resources", async () => {
    // CANARY: drop `agents`, `requiredReviewers`, `gates` or `rulingsKb` from
    // the board file, or skip a resource writer, and the board comes back
    // different from the one exported.
    const source = await sourceBoard();
    const target = targetStore();
    const file = exported(source);
    const result = await importInto(target, file);

    const before = readProjectFile({ projectSlug: source.slug, dataRoot: source.dataRoot })!.parsed;
    const after = readProjectFile({ projectSlug: result.slug, dataRoot: target.dataRoot })!.parsed;
    for (const key of ["stages", "workflow", "agents", "guardrails", "requiredReviewers", "rulingsKb", "gates"] as const) {
      expect(after.frontmatter[key], key).toEqual(before.frontmatter[key]);
    }
    expect(after.description).toBe(before.description);
    // What belongs to the instance stays there: the new project is the
    // importer's, on the repository the form named, with a fresh counter.
    expect(after.frontmatter).toMatchObject({
      name: "Release Train",
      slug: "release-train",
      taskPrefix: "REL",
      repo: "acme/release-train",
      nextTaskNumber: 1,
      members: [{ userId: target.users.arda.id, role: "admin" }],
      fileLeases: [],
    });

    const dataRoot = target.dataRoot;
    expect(readFileSync(path.join(kbDirPath("release-rulings", dataRoot), "rulings.md"), "utf8")).toBe(RULINGS_DOC);
    expect(readFileSync(path.join(kbDirPath("release-rulings", dataRoot), "past/2025.pdf"))).toEqual(PDF_BYTES);
    expect(readFileSync(path.join(skillDirPath("release-notes", dataRoot), "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(readFileSync(agentProfileFilePath("release-manager", dataRoot), "utf8")).toBe(
      readFileSync(agentProfileFilePath("release-manager", source.dataRoot), "utf8"),
    );
    const refresh = target.db.prepare(`SELECT refresh FROM org_knowledge_bases WHERE dir = 'release-rulings'`).get();
    expect(refresh).toEqual({ refresh: "manual" });
  });

  it("registers an MCP server unchecked, with its write tools and without any credential", async () => {
    // CANARY: register the server through `saveMcpServer` and the import
    // probes an address that arrived in a file (`last_checked_at` is set).
    const source = await sourceBoard();
    const target = targetStore();
    await importInto(target, exported(source));
    const linear = listMcpServers(target.db).find((m) => m.name === "linear")!;
    expect(linear).toMatchObject({
      transport: "HTTP",
      target: "https://mcp.linear.app/mcp",
      hasCred: false,
      up: null,
      lastCheckedAt: null,
      writeTools: ["create_issue"],
      writeToolsReviewed: true,
    });
    const added = listAuditEvents(target.db, { action: "org.mcp.added" })[0]!;
    expect(added.details).toMatchObject({ name: "linear", unchecked: true });
  });

  it("records the import on project.created, naming the file and what came in", async () => {
    // CANARY: record the import as a plain creation and its project's
    // Activity cannot say where the board came from.
    const source = await sourceBoard();
    const target = targetStore();
    const result = await importInto(target, exported(source));
    expect(listAuditLog(target.db, result.slug).map((e) => e.text)).toContain(
      `${target.users.arda.name} created the project from the board file **viberr-core.viberr-board.zip**.`,
    );
    const created = listAuditEvents(target.db, { action: "project.created" }).find((e) => e.projectSlug === result.slug)!;
    expect(created.details).toMatchObject({
      template: "imported",
      file: "viberr-core.viberr-board.zip",
      exportedFrom: "viberr-core",
      created: { kbs: ["release-rulings"], skills: ["release-notes"], mcps: ["linear"], templates: ["release-manager"] },
    });
    expect(result.toast).toContain("Release Train imported as REL");
    expect(result.toast).toContain("Test linear in Agent resources");
  });

  it("re-imported on the instance it came from, reuses every resource and writes only the project", async () => {
    // CANARY: compare folders by anything two copies of the same files do not
    // share (an mtime, a scan order) and a board imported where it was
    // exported duplicates every skill and knowledge base. (By paths alone, the
    // copy test below goes red instead.)
    const source = await sourceBoard();
    const file = exported(source);
    const preview = previewBoardImport(source.db, file, { dataRoot: source.dataRoot });
    expect(preview.problems).toEqual([]);
    // The base Developer and Reviewer run on their templates, so the file
    // carries those and the skills they grant, beside the board's own.
    expect(preview.resources.map((r) => `${r.kind}:${r.key}:${r.status}`).sort()).toEqual([
      "agent:developer:same",
      "agent:release-manager:same",
      "agent:reviewer:same",
      "kb:release-rulings:same",
      "mcp:linear:same",
      "skill:developer-expertise:same",
      "skill:release-notes:same",
      "skill:reviewer-expertise:same",
    ]);
    expect(preview.suggestedName).toBe("Viberr Core 2");
    seedConnection(source.db, source.users.arda.id);
    const result = await importInto(source, file);
    expect(existsSync(kbDirPath("release-rulings-2", source.dataRoot))).toBe(false);
    expect(existsSync(skillDirPath("release-notes-2", source.dataRoot))).toBe(false);
    expect(listMcpServers(source.db).map((m) => m.name)).toEqual(["linear"]);
    const created = listAuditEvents(source.db, { action: "project.created" }).find((e) => e.projectSlug === result.slug)!;
    expect(created.details).toMatchObject({
      created: { kbs: [], skills: [], mcps: [], templates: [] },
      reused: {
        kbs: ["release-rulings"],
        skills: ["developer-expertise", "release-notes", "reviewer-expertise"],
        mcps: ["linear"],
      },
    });
  });
});

describe("ruling 653: a name this instance already uses for something else", () => {
  /** A target whose `release-notes` skill says something else. */
  async function targetWithOtherSkill(): Promise<TestStore> {
    const target = targetStore();
    await saveSkill(
      target.db,
      { name: "release-notes", summary: "This instance's own.", body: "# Release notes\n\nOur house style.\n" },
      actorOf(target.users.arda),
      { dataRoot: target.dataRoot },
    );
    return target;
  }

  it("brings the file's skill in as a copy by default and points the board's grants at the copy", async () => {
    // CANARY: default a differing resource to "existing" (or write the copy
    // without rewriting the grants) and the board runs this instance's skill.
    const source = await sourceBoard();
    const target = await targetWithOtherSkill();
    const file = exported(source);
    const skill = previewBoardImport(target.db, file, { dataRoot: target.dataRoot }).resources.find(
      (r) => r.kind === "skill" && r.key === "release-notes",
    )!;
    expect(skill).toMatchObject({ key: "release-notes", status: "differs", createAs: "release-notes-2" });
    expect(skill.usedBy.sort()).toEqual(["QA Lead", "Release Manager"]);

    const result = await importInto(target, file);
    expect(readFileSync(path.join(skillDirPath("release-notes-2", target.dataRoot), "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(readFileSync(path.join(skillDirPath("release-notes", target.dataRoot), "SKILL.md"), "utf8")).toContain(
      "Our house style.",
    );
    const agents = readProjectFile({ projectSlug: result.slug, dataRoot: target.dataRoot })!.parsed.frontmatter.agents;
    expect(agents.find((a) => a.profileId === "release-manager")!.definition!.resources!.skills).toEqual(["release-notes-2"]);
    expect(agents.find((a) => a.profileId === "qa-lead")!.definition!.resources!.skills).toEqual(["release-notes-2"]);
    // The template the import adds to the library grants the copy too.
    expect(readFileSync(agentProfileFilePath("release-manager", target.dataRoot), "utf8")).toContain("- release-notes-2");
  });

  it("uses this instance's skill when the admin says so, writing no copy", async () => {
    // CANARY: ignore the choice and a copy appears that nobody asked for.
    const source = await sourceBoard();
    const target = await targetWithOtherSkill();
    const result = await importInto(target, exported(source), importInput({ "skill:release-notes": "existing" }));
    expect(existsSync(skillDirPath("release-notes-2", target.dataRoot))).toBe(false);
    const agents = readProjectFile({ projectSlug: result.slug, dataRoot: target.dataRoot })!.parsed.frontmatter.agents;
    expect(agents.find((a) => a.profileId === "release-manager")!.definition!.resources!.skills).toEqual(["release-notes"]);
  });

  it("keeps this instance's different template and gives the board's agent the file's settings", async () => {
    // CANARY: link the board's base Developer to this instance's template
    // without its own definition and it runs a persona nobody exported.
    const source = await sourceBoard();
    const target = targetStore();
    const developerFile = agentProfileFilePath("developer", target.dataRoot);
    const ours = readFileSync(developerFile, "utf8").replace(/\n\n[\s\S]*$/, "\n\nThis instance's own developer.\n");
    writeFileAtomic(developerFile, ours);
    const file = exported(source);
    const developer = previewBoardImport(target.db, file, { dataRoot: target.dataRoot }).resources.find(
      (r) => r.kind === "agent" && r.key === "developer",
    )!;
    expect(developer.status).toBe("differs");

    const result = await importInto(target, file);
    expect(readFileSync(developerFile, "utf8")).toBe(ours);
    const deployed = readProjectFile({ projectSlug: result.slug, dataRoot: target.dataRoot })!.parsed.frontmatter.agents.find(
      (a) => a.profileId === "developer",
    )!;
    const sourcePersona = readFileSync(agentProfileFilePath("developer", source.dataRoot), "utf8").split("\n---\n")[1]!.trim();
    expect(deployed.definition?.persona).toBe(sourcePersona);
    expect(deployed.definition?.name).toBe("Developer");
  });

  it("gives a project-local agent a free id when its id names a template here, and its required reviewer follows", async () => {
    // CANARY: keep `qa-lead` and the board's own agent reads as a copy of an
    // unrelated library template; rename it without the rule and the
    // required reviewer names an agent the board no longer has.
    const source = await sourceBoard();
    const target = targetStore();
    await saveGlobalAgentProfile(
      target.db,
      { name: "QA Lead", backend: "codex", summary: "Ours.", role: "Quality", persona: "Ours.", stages: ["review"] },
      actorOf(target.users.arda),
      { dataRoot: target.dataRoot },
    );
    const result = await importInto(target, exported(source));
    const fm = readProjectFile({ projectSlug: result.slug, dataRoot: target.dataRoot })!.parsed.frontmatter;
    expect(fm.agents.map((a) => a.profileId)).toContain("qa-lead-2");
    expect(fm.requiredReviewers).toEqual([{ stageId: "review", profileId: "qa-lead-2" }]);
  });
});

/**
 * Ruling 667: an imported board needs a repository only when one of its
 * agents may write one. The file carries each deployment's grants, so the
 * import reads what the board delivers off its own roster.
 */
describe("ruling 667: a board none of whose agents writes a repository imports without one", () => {
  const REPO_WRITE = ["execute-code-or-write-repo", "create-task-branch", "commit-push-branch", "open-review-pr"];
  const noRepository = { ...importInput(), owner: "", repoName: "" };

  it("reads what the board delivers from its roster, and takes a results board with no repository and no connection", async () => {
    // CANARY: read every imported board as software and a no-code board
    // cannot be imported on an instance with no GitHub connection; read every
    // one as results and a board whose Developer commits is written with
    // nowhere to commit.
    const source = await sourceBoard();
    // A second instance with its shipped assets and NO GitHub connection.
    const bare = setupTestStore(ctx);
    seedDefaultAgentAssets(bare.dataRoot);
    const into = { dataRoot: bare.dataRoot };
    const software = exported(source);
    expect(previewBoardImport(bare.db, software, into).delivers).toBe("software");
    await expect(importBoard(bare.db, software, noRepository, actorOf(bare.users.arda), into)).rejects.toThrow(
      "A GitHub repository is required for a board that delivers software.",
    );

    // The same board with repo-write withheld from every agent, as a board
    // that delivers results is deployed.
    const project = readProjectFile({ projectSlug: source.slug, dataRoot: source.dataRoot })!.parsed;
    writeProject(
      source.dataRoot,
      {
        ...project.frontmatter,
        agents: project.frontmatter.agents.map((a) =>
          a.profileId === "operator"
            ? a
            : {
                ...a,
                capabilities: [
                  ...a.capabilities.filter((c) => !REPO_WRITE.includes(c.capabilityId)),
                  ...REPO_WRITE.map((capabilityId) => ({ capabilityId, mode: "off" as const })),
                ],
              },
        ),
      },
      project.description,
    );
    reprojectProject(source.db, { dataRoot: source.dataRoot }, source.slug);
    const results = exported(source);
    expect(previewBoardImport(bare.db, results, into).delivers).toBe("results");
    const imported = await importBoard(bare.db, results, noRepository, actorOf(bare.users.arda), into);
    expect(imported.repo).toBeNull();
    expect(readProjectFile({ projectSlug: imported.slug, dataRoot: bare.dataRoot })!.parsed.frontmatter.repo).toBeNull();
  });
});

describe("ruling 671: an import names a repository GitHub confirms", () => {
  it("is refused before a single resource is written when GitHub does not show the repository", async () => {
    // The form fills the repository's name in from the board's and leaves the
    // create box unticked, so this is an import's ordinary first answer.
    // CANARY: reach the repository after writing the board's resources and a
    // refused import leaves its knowledge bases, skills and templates behind.
    const source = await sourceBoard();
    const target = targetStore();
    await expect(
      importBoard(target.db, exported(source), importInput(), actorOf(target.users.arda), {
        dataRoot: target.dataRoot,
        fetchImpl: fakeGithubFetch({}).fetchImpl,
      }),
    ).rejects.toMatchObject({
      status: 400,
      userMessage: expect.stringContaining(
        "GitHub has no repository acme/release-train that the acme connection can see.",
      ),
    });
    expect(readProjectFile({ projectSlug: "release-train", dataRoot: target.dataRoot })).toBeNull();
    expect(existsSync(kbDirPath("release-rulings", target.dataRoot))).toBe(false);
    expect(existsSync(skillDirPath("release-notes", target.dataRoot))).toBe(false);
    expect(existsSync(agentProfileFilePath("release-manager", target.dataRoot))).toBe(false);
  });
});

describe("ruling 653: what an import refuses", () => {
  it("lists every problem in board.md at once, and an import of it writes nothing", async () => {
    // CANARY: stop at the first problem, or write before checking, and a
    // person fixes one line per upload while debris collects.
    const source = await sourceBoard();
    const target = targetStore();
    const file = exported(source);
    const entries = readZip(file.bytes, { maxEntries: 100, maxTotalBytes: 10_000_000 });
    const board = entries.find((e) => e.path.endsWith("/board.md"))!;
    const text = board.data
      .toString("utf8")
      .replace("rulingsKb: release-rulings", "rulingsKb: nowhere\nstage: oops")
      .replace("agents:\n", "agents:\n  - profileId: controller\n")
      .replace("  - stageId: review\n    profileId: qa-lead", "  - stageId: done\n    profileId: qa-lead");
    board.data = Buffer.from(text);
    const broken = { name: "broken.zip", bytes: writeZip(entries, new Date()) };

    const preview = previewBoardImport(target.db, broken, { dataRoot: target.dataRoot });
    expect(preview.problems).toEqual([
      expect.stringContaining("a key Viberr does not read: `stage`"),
      expect.stringContaining("deploys `controller`, the instance's controller"),
      expect.stringContaining("Done, the final stage"),
      expect.stringContaining("names `nowhere` as the board's rulings knowledge base"),
    ]);
    await expect(importInto(target, broken)).rejects.toThrow(/cannot be imported until 4 problems/);
    expect(readProjectFile({ projectSlug: "release-train", dataRoot: target.dataRoot })).toBeNull();
    expect(existsSync(skillDirPath("release-notes", target.dataRoot))).toBe(false);
  });

  it("refuses a board file from a newer format, and a zip with no board.md", () => {
    // CANARY: read an unknown format as this one and keys it never had are
    // dropped without a word.
    const target = targetStore();
    const newer = writeZip(
      [{ path: "b/board.md", data: Buffer.from("---\nformat: viberr-board/2\nname: Later\n---\n") }],
      new Date(),
    );
    expect(previewBoardImport(target.db, { name: "later.zip", bytes: newer }).problems).toEqual([
      "board.md is viberr-board/2, written by a newer Viberr. This instance reads viberr-board/1.",
    ]);
    const none = writeZip(
      [
        { path: "a/notes.md", data: Buffer.from("x") },
        { path: "b/board.md", data: Buffer.from("x") },
      ],
      new Date(),
    );
    expect(() => previewBoardImport(target.db, { name: "none.zip", bytes: none })).toThrow(/no board\.md/);
  });
});

describe("ruling 653: a board folder a person zipped again", () => {
  it("reads Finder's zip of a hand-written board: its folder, its data descriptors, and nothing of __MACOSX or .DS_Store", async () => {
    // CANARY: trust a local header's sizes (Finder writes them as zero) or
    // keep __MACOSX's `._` files and this zip does not import.
    const target = targetStore();
    const file = { name: "release-desk.zip", bytes: readFileSync(FINDER_ZIP) };
    const preview = previewBoardImport(target.db, file, { dataRoot: target.dataRoot });
    expect(preview.problems).toEqual([]);
    expect(preview.name).toBe("Release desk");
    expect(preview.stages.map((s) => s.name)).toEqual(["Intake", "Draft", "Review", "Shipped"]);
    expect(preview.resources.map((r) => `${r.kind}:${r.key}:${r.status}`)).toEqual([
      "kb:release-rulings:new",
      "skill:release-notes:new",
      "agent:release-manager:new",
    ]);
    expect(preview.notes).toEqual([
      "1 file in the zip has no place in a board file and is left out: `notes-to-self.txt`.",
    ]);
    const result = await importInto(target, file, { ...importInput(), name: "Release Desk" });
    expect(readFileSync(path.join(skillDirPath("release-notes", target.dataRoot), "templates/notes.md"), "utf8")).toBe(
      "## {{version}}\n\n- \n",
    );
    const fm = readProjectFile({ projectSlug: result.slug, dataRoot: target.dataRoot })!.parsed.frontmatter;
    expect(fm.rulingsKb).toBe("release-rulings");
    expect(fm.requiredReviewers).toEqual([{ stageId: "review", profileId: "release-manager" }]);
  });
});
