import type { DatabaseSync } from "node:sqlite";
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  readAgentProfileFile,
  type ParsedAgentProfile,
} from "~/server/files/agent-profile-file.server";
import {
  agentProfileFilePath,
  kbDirPath,
  skillDirPath,
} from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { getBuildInfo } from "~/server/ops/build-info.server";
import { getProject, listProjects } from "~/server/projections/board-query.server";
import { countLabel } from "~/shared/text/plural";
import { prettySize } from "~/shared/text/byte-size";
import {
  BOARD_FILE_EXTENSION,
  BOARD_FILE_LIMITS,
  BOARD_FILE_MAX_BYTES,
  boardKbFiles,
  serializeBoardFile,
  writeBoardFile,
  type BoardDefinition,
  type BoardFolderFile,
  type BoardKnowledgeBase,
  type BoardMcpServer,
  type BoardSkill,
} from "./board-file.server";
import { buildResourceCatalog } from "./resource-catalog.server";
import {
  listKnowledgeBases,
  listMcpServers,
  listSkills,
  type OrgSeedContext,
} from "./resources.server";
import { readStoreFolderFiles } from "./store-files.server";

/**
 * Ruling 32: EXPORT a board — any project, archived or not — as a board file
 * (`board-file.server.ts` has the layout). What it carries is the workflow a
 * board runs, so the same board can be started again here or on another
 * instance:
 *
 * - project.md's workflow keys, verbatim: stages, the rules between them,
 *   the agent deployments (capabilities, extras, definition overrides),
 *   guardrails, required reviewers, the rulings knowledge base and gates;
 * - the org templates those agents are deployed from (never the operator's or
 *   the controller's, which are the instance's own machinery);
 * - every skill, knowledge base and MCP server a deployment or one of those
 *   templates grants, and the rulings knowledge base: the skill and knowledge
 *   folders file by file, the MCP servers as registry rows.
 *
 * What stays is everything that belongs to the instance or to the work:
 * tasks, epics, members, the repository and its credential, file leases, and
 * every MCP credential and sign-in. A grant naming a resource this instance
 * does not have is carried as written and named in the README.
 */

/** One board as the Import & export tab lists it. */
export interface BoardExportSummary {
  slug: string;
  name: string;
  taskPrefix: string;
  archived: boolean;
  stages: number;
  agents: number;
  skills: number;
  knowledgeBases: number;
  mcpServers: number;
  /** Grants a board file cannot carry, because this instance has no such
   *  resource: "skill release-notes". */
  missing: string[];
}

/** What an export hands the route: the file's name and bytes. */
export interface BoardExport {
  fileName: string;
  bytes: Buffer;
}

/** A template a board's agents are deployed from, as the file carries it. */
interface CarriedTemplate {
  content: string;
  parsed: ParsedAgentProfile;
}

/** Everything a board grants, by store key, and the templates it carries. */
interface BoardGrants {
  templates: Map<string, CarriedTemplate>;
  skills: Set<string>;
  kbs: Set<string>;
  mcps: Set<string>;
}

/** The operator's template is the instance's one operator (ruling 106). */
const OPERATOR_PROFILE_ID = "operator";

/**
 * What a project's board grants: each deployment's own resource lists, the
 * templates its specialists are deployed from and THEIR lists (a deployment
 * with no definition runs on its template's), and the rulings knowledge base.
 */
function boardGrants(fm: ProjectFrontmatter, dataRoot: string | undefined): BoardGrants {
  const grants: BoardGrants = { templates: new Map(), skills: new Set(), kbs: new Set(), mcps: new Set() };
  const take = (resources: { skills?: string[]; mcps?: string[]; kb?: string[] } | undefined) => {
    for (const s of resources?.skills ?? []) grants.skills.add(s);
    for (const m of resources?.mcps ?? []) grants.mcps.add(m);
    for (const k of resources?.kb ?? []) grants.kbs.add(k);
  };
  for (const deployment of fm.agents) {
    take(deployment.definition?.resources);
    if (deployment.profileId === OPERATOR_PROFILE_ID) continue;
    let read: ReturnType<typeof readAgentProfileFile>;
    try {
      read = readAgentProfileFile(agentProfileFilePath(deployment.profileId, dataRoot), deployment.profileId);
    } catch {
      // Not a store segment: no template can live there.
      continue;
    }
    if (!read?.parsed || read.parsed.frontmatter.kind !== "specialist") continue;
    grants.templates.set(deployment.profileId, { content: read.content, parsed: read.parsed });
    take(read.parsed.frontmatter.resources);
  }
  if (fm.rulingsKb) grants.kbs.add(fm.rulingsKb);
  return grants;
}

/** The project file, or a refusal: absent, or one the store cannot read. */
function readBoardSource(slug: string, dataRoot: string | undefined): ProjectFrontmatter & { description: string } {
  const read = readProjectFile({ projectSlug: slug, dataRoot });
  if (!read) throw AppError.notFound(`No project at projects/${slug}.`);
  const blockers = read.diagnostics.filter((d) => d.hardStop);
  if (blockers.length > 0) {
    throw new AppError({
      code: ERROR_CODES.FILE_NOT_TRUSTED,
      status: 409,
      userMessage: `${slug}'s project file can't be read as a project file, so there is no board to export. ${blockers.map((d) => d.message).join(" ")} \`npm run store:check\` names the line.`,
    });
  }
  return { ...read.parsed.frontmatter, description: read.parsed.description };
}

/** The grant keys this instance answers to, by kind: the live catalog every
 *  agent editor offers (`buildResourceCatalog`). */
function instanceResources(db: DatabaseSync, dataRoot: string | undefined) {
  const groups = buildResourceCatalog(db, dataRoot);
  const ids = (key: string) => new Set(groups.find((g) => g.key === key)?.items.map((i) => i.id) ?? []);
  return { skills: ids("skills"), mcps: ids("mcps"), kbs: ids("kb") };
}

/** The sentences for grants this instance cannot carry. */
function missingGrants(grants: BoardGrants, known: ReturnType<typeof instanceResources>): string[] {
  const missing = (kind: string, wanted: Set<string>, have: Set<string>) =>
    [...wanted].filter((key) => !have.has(key)).map((key) => `${kind} ${key}`);
  return [
    ...missing("skill", grants.skills, known.skills),
    ...missing("knowledge base", grants.kbs, known.kbs),
    ...missing("MCP server", grants.mcps, known.mcps),
  ].sort();
}

/**
 * Every project as the tab lists it, archived ones last. Reads each
 * project.md and its templates (both through the parse memo); no folder is
 * read until a board is exported.
 */
export function listBoardExports(db: DatabaseSync, ctx: OrgSeedContext = {}): BoardExportSummary[] {
  const known = instanceResources(db, ctx.dataRoot);
  const out: BoardExportSummary[] = [];
  for (const project of listProjects(db)) {
    let source: ReturnType<typeof readBoardSource>;
    try {
      source = readBoardSource(project.slug, ctx.dataRoot);
    } catch {
      // An unreadable project file is the store doctor's to name; its row
      // would only refuse.
      continue;
    }
    const grants = boardGrants(source, ctx.dataRoot);
    const has = (wanted: Set<string>, have: Set<string>) => [...wanted].filter((k) => have.has(k)).length;
    out.push({
      slug: project.slug,
      name: source.name,
      taskPrefix: source.taskPrefix,
      archived: source.archived === true,
      stages: source.stages.length,
      agents: source.agents.length,
      skills: has(grants.skills, known.skills),
      knowledgeBases: has(grants.kbs, known.kbs),
      mcpServers: has(grants.mcps, known.mcps),
      missing: missingGrants(grants, known),
    });
  }
  return out.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
}

function folderBytes(files: readonly BoardFolderFile[]): number {
  return files.reduce((sum, f) => sum + f.data.length, 0);
}

/** "Triage → Ready → Build → Review → Done". */
function stagePath(board: BoardDefinition): string {
  return board.stages.map((s) => s.name).join(" → ");
}

/** The README every board file carries for the person who unzips it. */
function boardReadme(
  board: BoardDefinition,
  templates: ReadonlyMap<string, CarriedTemplate>,
  skills: ReadonlyMap<string, readonly BoardFolderFile[]>,
  kbs: ReadonlyMap<string, readonly BoardFolderFile[]>,
  missing: readonly string[],
): string {
  const names = (keys: Iterable<string>) => [...keys].sort().map((k) => `\`${k}\``).join(", ");
  const lines = [
    `# ${board.name}`,
    "",
    "A Viberr board file: this board's workflow, without its work.",
    `Exported from \`projects/${board.exportedFrom ?? "?"}\` on ${board.exportedAt?.slice(0, 10) ?? "?"}` +
      (board.viberrVersion ? ` by Viberr ${board.viberrVersion}.` : "."),
    "",
    "Import it under **Instance settings → Import & export → Import a board**, on this",
    "instance or another. Nothing is written until you have seen what it brings and confirmed.",
    "",
    "## What is in it",
    "",
    `- \`board.md\`: the board. ${countLabel(board.stages.length, "stage")} (${stagePath(board)}) and the rules`,
    `  between them, ${countLabel(board.agents.length, "agent")} with their capabilities and settings,`,
    `  ${countLabel(board.guardrails.length, "guardrail")}, ${countLabel(board.requiredReviewers.length, "required reviewer")}` +
      ` and ${countLabel(board.gates?.length ?? 0, "gate")}${board.rulingsKb ? `, and the rulings knowledge base \`${board.rulingsKb}\`` : ""}.`,
    "  Its keys are the ones a project's `project.md` uses, plus the knowledge bases, skills",
    "  and MCP servers below. The text under its frontmatter is the board's description.",
  ];
  if (templates.size > 0) {
    lines.push(`- \`agents/\`: ${countLabel(templates.size, "agent template")} the agents are deployed from (${names([...templates.keys()].map((id) => `${id}.md`))}).`);
  }
  if (skills.size > 0) {
    lines.push(`- \`skills/\`: ${countLabel(skills.size, "skill")}, each a folder with its \`SKILL.md\` (${names(skills.keys())}).`);
  }
  if (kbs.size > 0) {
    const docs = [...kbs].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, files]) => `\`${dir}\`: ${countLabel(files.length, "file")}`);
    lines.push(`- \`kb/\`: ${countLabel(kbs.size, "knowledge base")}, each a folder of documents (${docs.join(", ")}).`);
  }
  if (board.mcpServers.length > 0) {
    lines.push(`- MCP servers are listed in \`board.md\` (${names(board.mcpServers.map((m) => m.name))}); their credentials are not.`);
  }
  lines.push(
    "",
    "## What is not",
    "",
    "Tasks, epics, members, the repository, and every credential (MCP tokens and sign-ins,",
    "GitHub tokens) stay on the instance the board was exported from. After an import, give",
    "each MCP server that needs one its credential under Instance settings → Agent resources.",
  );
  if (missing.length > 0) {
    lines.push(
      "",
      `The agents are also granted ${missing.join(", ")}, which the exporting instance did not have,`,
      "so this file could not carry them. The grants stay as written.",
    );
  }
  lines.push(
    "",
    "## Editing it",
    "",
    "Every file is plain text. Rename the board or add a stage in `board.md`, rewrite an",
    "agent's persona in `agents/`, drop documents into a `kb/` folder, then zip the folder",
    "again and import the zip.",
    "",
  );
  return lines.join("\n");
}

/**
 * The board file for one project. Refuses a project that does not exist, a
 * project file the store cannot read, and a board whose folders hold more
 * than an import accepts (naming the largest), so every file this writes is
 * one an import reads back.
 */
export function exportBoard(
  db: DatabaseSync,
  slug: string,
  ctx: OrgSeedContext = {},
  now: Date = new Date(),
): BoardExport {
  // The projection is the gate: only a project the store knows is read, so a
  // crafted slug never names a path of its own.
  if (!getProject(db, slug)) throw AppError.notFound(`No project at projects/${slug}.`);
  const source = readBoardSource(slug, ctx.dataRoot);
  const grants = boardGrants(source, ctx.dataRoot);
  const known = instanceResources(db, ctx.dataRoot);

  const kbRows = new Map(listKnowledgeBases(db, ctx).map((kb) => [kb.dir, kb]));
  const knowledgeBases: BoardKnowledgeBase[] = [];
  const kbFiles = new Map<string, BoardFolderFile[]>();
  for (const dir of [...grants.kbs].sort()) {
    const kb = kbRows.get(dir);
    if (!kb) continue;
    knowledgeBases.push({ dir, name: kb.name, refresh: kb.refresh, private: kb.private });
    // Ruling 199: a decision that a board connects no repository is one
    // person's, on this instance, and does not travel with the board.
    kbFiles.set(
      dir,
      kb.folderExists ? boardKbFiles(readStoreFolderFiles(kbDirPath(dir, ctx.dataRoot))) : [],
    );
  }
  const skillRows = new Map(listSkills(db, ctx).map((s) => [s.name, s]));
  const skills: BoardSkill[] = [];
  const skillFiles = new Map<string, BoardFolderFile[]>();
  for (const name of [...grants.skills].sort()) {
    const skill = skillRows.get(name);
    if (!skill) continue;
    skills.push({ name, summary: skill.summary });
    skillFiles.set(name, readStoreFolderFiles(skillDirPath(name, ctx.dataRoot)));
  }
  const mcpRows = new Map(listMcpServers(db).map((m) => [m.name, m]));
  const mcpServers: BoardMcpServer[] = [];
  for (const name of [...grants.mcps].sort()) {
    const mcp = mcpRows.get(name);
    if (!mcp || !known.mcps.has(name)) continue;
    const server: BoardMcpServer = { name, transport: mcp.transport, target: mcp.target };
    if (mcp.writeToolsReviewed) server.writeTools = mcp.writeTools;
    mcpServers.push(server);
  }

  const board: BoardDefinition = {
    name: source.name,
    taskPrefix: source.taskPrefix,
    description: source.description,
    stages: source.stages,
    workflow: source.workflow,
    agents: source.agents,
    guardrails: source.guardrails,
    requiredReviewers: source.requiredReviewers,
    rulingsKb: source.rulingsKb ?? null,
    knowledgeBases,
    skills,
    mcpServers,
    exportedAt: now.toISOString(),
    exportedFrom: slug,
    viberrVersion: getBuildInfo().version,
  };
  if (source.gates) board.gates = source.gates;

  const folders = [
    ...[...skillFiles].map(([name, files]) => ({ label: `skills/${name}`, files })),
    ...[...kbFiles].map(([dir, files]) => ({ label: `kb/${dir}`, files })),
  ];
  const fileCount = folders.reduce((n, f) => n + f.files.length, 0) + grants.templates.size + 2;
  const byteCount = folders.reduce((n, f) => n + folderBytes(f.files), 0);
  if (fileCount > BOARD_FILE_LIMITS.maxEntries || byteCount > BOARD_FILE_LIMITS.maxTotalBytes) {
    const largest = folders
      .toSorted((a, b) => folderBytes(b.files) - folderBytes(a.files))
      .slice(0, 3)
      .map((f) => `${f.label} (${countLabel(f.files.length, "file")}, ${prettySize(folderBytes(f.files))})`);
    throw AppError.validation(
      `${source.name} carries ${countLabel(fileCount, "file")} and ${prettySize(byteCount)}; a board file holds at most ` +
        `${BOARD_FILE_LIMITS.maxEntries} files and ${prettySize(BOARD_FILE_LIMITS.maxTotalBytes)}. The largest folders: ${largest.join(", ")}.`,
    );
  }

  const templates = new Map([...grants.templates].map(([id, t]) => [id, t.content]));
  const bytes = writeBoardFile(
    {
      folder: slug,
      board: serializeBoardFile(board),
      readme: boardReadme(board, grants.templates, skillFiles, kbFiles, missingGrants(grants, known)),
      templates,
      skills: skillFiles,
      kbs: kbFiles,
    },
    now,
  );
  if (bytes.length > BOARD_FILE_MAX_BYTES) {
    throw AppError.validation(
      `${source.name}'s board file would be ${prettySize(bytes.length)} zipped; an import takes at most ${prettySize(BOARD_FILE_MAX_BYTES)}. Its knowledge bases are the place to make room.`,
    );
  }
  return { fileName: `${slug}${BOARD_FILE_EXTENSION}`, bytes };
}
