import { z } from "zod";
import {
  parseProjectFrontmatter,
  type AgentDeployment,
  type Guardrail,
  type ProjectGate,
  type RequiredReviewerRule,
  type StageDef,
  type WorkflowBoundary,
} from "~/schemas/project-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import {
  serializeFrontmatterFile,
  splitFrontmatterMapping,
  type YamlMapping,
} from "~/server/files/frontmatter.server";
import { readZip, writeZip, type ZipFileInput } from "~/server/files/zip.server";
import { KB_REFRESH_MODES, type KbRefreshMode } from "./resources.server";

/**
 * Ruling 653: the BOARD FILE — one board's workflow without its work, as a
 * zip in which every part is a plain file a person can read, edit and keep in
 * git. Export and import both go through this module, so the layout below is
 * written in one place:
 *
 * ```
 * <slug>/board.md               the board: project.md's workflow keys, the
 *                               knowledge bases, skills and MCP servers it
 *                               carries, and the description as its body
 * <slug>/README.md              what the folder is and how to import it
 * <slug>/agents/<id>.md         the agent templates its agents are deployed
 *                               from, in the agents/profiles/<id>.md format
 * <slug>/skills/<name>/…        each skill folder, SKILL.md and the rest
 * <slug>/kb/<dir>/…             each knowledge base's documents
 * ```
 *
 * The reader takes the folder at the top of the zip or its contents at the
 * root (a person re-zips the extracted folder either way), and leaves out
 * what a zip tool adds on its own: `__MACOSX/`, `.DS_Store` and every other
 * dot-name, which the store never keeps either.
 */

/** board.md's `format`: the file's kind and the version of its keys. */
export const BOARD_FILE_FORMAT = "viberr-board/1";
/** What an export is named after its board: `release-train.viberr-board.zip`. */
export const BOARD_FILE_EXTENSION = ".viberr-board.zip";
/** The zip as uploaded. */
export const BOARD_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** What it may unpack to. An export that would pass either is refused, so
 *  every board file Viberr writes is one it reads back. */
export const BOARD_FILE_LIMITS = { maxEntries: 2000, maxTotalBytes: 100 * 1024 * 1024 };

/** One knowledge base a board file carries: its store folder and settings. */
export interface BoardKnowledgeBase {
  dir: string;
  name: string;
  refresh: KbRefreshMode;
  /** Ruling 578: its folder is closed to every agent's shell. */
  private: boolean;
}

/** One skill a board file carries: its folder name and one-line summary. */
export interface BoardSkill {
  name: string;
  summary: string;
}

/**
 * One MCP server a board file carries. Never a credential or a sign-in: a
 * server that needs one is given it again on the instance it lands on.
 */
export interface BoardMcpServer {
  name: string;
  transport: "HTTP" | "stdio";
  target: string;
  /** Ruling 176: the tools an admin marked as writes; absent when the
   *  server's tools were never reviewed. */
  writeTools?: string[];
}

/** Everything board.md says, decoded. */
export interface BoardDefinition {
  name: string;
  taskPrefix: string;
  description: string;
  stages: StageDef[];
  workflow: WorkflowBoundary[];
  agents: AgentDeployment[];
  guardrails: Guardrail[];
  requiredReviewers: RequiredReviewerRule[];
  rulingsKb: string | null;
  /** Ruling 482: absent when the board declares no gates. */
  gates?: ProjectGate[];
  knowledgeBases: BoardKnowledgeBase[];
  skills: BoardSkill[];
  mcpServers: BoardMcpServer[];
  exportedAt: string | null;
  /** The slug of the project it was exported from. */
  exportedFrom: string | null;
  viberrVersion: string | null;
}

/** One file inside a skill or knowledge-base folder, by its path in it. */
export interface BoardFolderFile {
  path: string;
  data: Buffer;
}

/** A board file unpacked into its parts. */
export interface BoardBundle {
  /** board.md's text. */
  board: string;
  /** agents/<id>.md, by id. */
  templates: Map<string, string>;
  /** skills/<name>/…, by folder name. */
  skills: Map<string, BoardFolderFile[]>;
  /** kb/<dir>/…, by folder name. */
  kbs: Map<string, BoardFolderFile[]>;
  /** Paths the layout has no place for, which an import leaves out. */
  ignored: string[];
}

/** board.md's keys, in the order an export writes them. */
const BOARD_KEYS: readonly string[] = [
  "format",
  "name",
  "taskPrefix",
  "stages",
  "workflow",
  "agents",
  "guardrails",
  "requiredReviewers",
  "rulingsKb",
  "gates",
  "knowledgeBases",
  "skills",
  "mcpServers",
  "exportedAt",
  "exportedFrom",
  "viberrVersion",
];

/** project.md keys a board leaves behind: they belong to one instance's
 *  project (its repository, people, counter and leases), not to the workflow. */
const PROJECT_ONLY_KEYS: readonly string[] = [
  "slug",
  "archived",
  "repo",
  "defaultBranch",
  "nextTaskNumber",
  "members",
  "credentialPolicy",
  "fileLeases",
];

// ------------------------------------------------------------------ write

/** board.md for a board, keys in `BOARD_KEYS` order. */
export function serializeBoardFile(board: BoardDefinition): string {
  const fields: YamlMapping = {
    format: BOARD_FILE_FORMAT,
    name: board.name,
    taskPrefix: board.taskPrefix,
    stages: board.stages,
    workflow: board.workflow,
    agents: board.agents,
    guardrails: board.guardrails,
    requiredReviewers: board.requiredReviewers,
  };
  if (board.rulingsKb) fields.rulingsKb = board.rulingsKb;
  if (board.gates) fields.gates = board.gates;
  fields.knowledgeBases = board.knowledgeBases;
  fields.skills = board.skills;
  fields.mcpServers = board.mcpServers;
  if (board.exportedAt) fields.exportedAt = board.exportedAt;
  if (board.exportedFrom) fields.exportedFrom = board.exportedFrom;
  if (board.viberrVersion) fields.viberrVersion = board.viberrVersion;
  return serializeFrontmatterFile(fields, {}, board.description);
}

/** The parts of a board file, as an export assembles them. */
export interface BoardFileParts {
  /** The folder every path sits in: the board's slug. */
  folder: string;
  board: string;
  readme: string;
  templates: ReadonlyMap<string, string>;
  skills: ReadonlyMap<string, readonly BoardFolderFile[]>;
  kbs: ReadonlyMap<string, readonly BoardFolderFile[]>;
}

/** The zip of a board file. Paths are sorted, so one board exports to the
 *  same bytes for the same moment. */
export function writeBoardFile(parts: BoardFileParts, at: Date): Buffer {
  const inFolder = (rel: string) => `${parts.folder}/${rel}`;
  const files: ZipFileInput[] = [
    { path: inFolder("board.md"), data: Buffer.from(parts.board, "utf8") },
    { path: inFolder("README.md"), data: Buffer.from(parts.readme, "utf8") },
  ];
  for (const [id, text] of [...parts.templates].sort(byKey)) {
    files.push({ path: inFolder(`agents/${id}.md`), data: Buffer.from(text, "utf8") });
  }
  const folders = (root: string, map: ReadonlyMap<string, readonly BoardFolderFile[]>) => {
    for (const [name, list] of [...map].sort(byKey)) {
      for (const file of [...list].sort((a, b) => a.path.localeCompare(b.path))) {
        files.push({ path: inFolder(`${root}/${name}/${file.path}`), data: file.data });
      }
    }
  };
  folders("skills", parts.skills);
  folders("kb", parts.kbs);
  return writeZip(files, at);
}

function byKey<T>(a: readonly [string, T], b: readonly [string, T]): number {
  return a[0].localeCompare(b[0]);
}

// ------------------------------------------------------------------- read

/** A zip tool's own litter, and every dot-name, which the store never keeps. */
function isLeftOut(path: string): boolean {
  const segments = path.split("/");
  return segments[0] === "__MACOSX" || segments.some((s) => s.startsWith("."));
}

/**
 * Unpack an uploaded board file into its parts. Refuses (a validation error
 * naming why) a file that is not a zip, a zip the reader refuses, and a zip
 * with no board.md at its top or in its one top folder.
 */
export function readBoardFile(bytes: Uint8Array): BoardBundle {
  const files = readZip(bytes, BOARD_FILE_LIMITS).filter((f) => !isLeftOut(f.path));
  let prefix = "";
  if (!files.some((f) => f.path === "board.md")) {
    const tops = new Set(files.map((f) => f.path.split("/")[0]));
    const only = tops.size === 1 ? [...tops][0] : undefined;
    if (!only || !files.some((f) => f.path === `${only}/board.md`)) {
      throw AppError.validation(
        "This zip has no board.md, at its top or in its one folder, so it is not a board file. " +
          "Export a board from Instance settings → Import & export to see the layout.",
      );
    }
    prefix = `${only}/`;
  }
  const bundle: BoardBundle = {
    board: "",
    templates: new Map(),
    skills: new Map(),
    kbs: new Map(),
    ignored: [],
  };
  const addTo = (map: Map<string, BoardFolderFile[]>, name: string, file: BoardFolderFile) => {
    const list = map.get(name);
    if (list) list.push(file);
    else map.set(name, [file]);
  };
  for (const file of files) {
    if (!file.path.startsWith(prefix)) {
      bundle.ignored.push(file.path);
      continue;
    }
    const rel = file.path.slice(prefix.length);
    const segments = rel.split("/");
    const [top, name] = segments;
    if (rel === "board.md") {
      bundle.board = file.data.toString("utf8");
    } else if (rel === "README.md") {
      // Written by every export for the person who unzips it; an import reads
      // nothing from it.
    } else if (top === "agents" && segments.length === 2 && name?.endsWith(".md")) {
      bundle.templates.set(name.slice(0, -".md".length), file.data.toString("utf8"));
    } else if (top === "skills" && name && segments.length > 2) {
      addTo(bundle.skills, name, { path: segments.slice(2).join("/"), data: file.data });
    } else if (top === "kb" && name && segments.length > 2) {
      addTo(bundle.kbs, name, { path: segments.slice(2).join("/"), data: file.data });
    } else {
      bundle.ignored.push(rel);
    }
  }
  return bundle;
}

const kbRowSchema = z
  .object({
    dir: z.string().min(1),
    name: z.string().min(1).optional(),
    refresh: z.enum(KB_REFRESH_MODES).default("on change"),
    private: z.boolean().default(false),
  })
  .strict();

const skillRowSchema = z
  .object({ name: z.string().min(1), summary: z.string().default("") })
  .strict();

const mcpRowSchema = z
  .object({
    name: z.string().min(1),
    transport: z.enum(["HTTP", "stdio"]),
    target: z.string().min(1),
    writeTools: z.array(z.string()).optional(),
  })
  .strict();

/** A list of board.md rows, each decoded alone so every bad row is named. */
function boardRows<T>(
  data: YamlMapping,
  key: string,
  row: z.ZodType<T>,
  problems: string[],
): T[] {
  const raw = data[key];
  if (raw === undefined || raw === null) return [];
  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) {
    problems.push(`board.md: \`${key}\` is not a list.`);
    return [];
  }
  const out: T[] = [];
  list.data.forEach((entry, i) => {
    const parsed = row.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
    else {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `.${issue.path.join(".")}` : "";
      problems.push(`board.md: \`${key}[${i}]${where}\` ${issue?.message ?? "is invalid"}.`);
    }
  });
  return out;
}

const optionalText = z.string().nullish().catch(null);

/** What board.md decodes to: the board, the problems that refuse an import
 *  (each a sentence naming its key), and notes about keys it leaves behind. */
export interface BoardFileReading {
  board: BoardDefinition;
  /** False when board.md could not be read as a board file at all (no
   *  frontmatter, another format), so nothing in `board` is the file's. */
  readable: boolean;
  problems: string[];
  notes: string[];
}

/**
 * Decode board.md. The workflow keys go through project.md's own parser
 * (`parseProjectFrontmatter`), so a board file is held to exactly the rules a
 * project file is; but where a project file falls back and carries on, every
 * diagnostic here is a problem, because an import is a person waiting to fix
 * the line rather than a store that must keep running.
 */
export function parseBoardFile(text: string): BoardFileReading {
  const problems: string[] = [];
  const notes: string[] = [];
  const { data, body, diagnostics } = splitFrontmatterMapping(text);
  const board: BoardDefinition = {
    name: "",
    taskPrefix: "",
    description: body.trim(),
    stages: [],
    workflow: [],
    agents: [],
    guardrails: [],
    requiredReviewers: [],
    rulingsKb: null,
    knowledgeBases: [],
    skills: [],
    mcpServers: [],
    exportedAt: optionalText.parse(data.exportedAt) ?? null,
    exportedFrom: optionalText.parse(data.exportedFrom) ?? null,
    viberrVersion: optionalText.parse(data.viberrVersion) ?? null,
  };
  const unreadable = diagnostics.filter((d) => d.hardStop);
  if (unreadable.length > 0) {
    problems.push(`board.md cannot be read: ${unreadable.map((d) => d.message).join(" ")}`);
    return { board, readable: false, problems, notes };
  }
  const format = optionalText.parse(data.format);
  if (!format) {
    problems.push(`board.md has no \`format: ${BOARD_FILE_FORMAT}\` line, so it is not a Viberr board file.`);
    return { board, readable: false, problems, notes };
  }
  if (format !== BOARD_FILE_FORMAT) {
    problems.push(
      /^viberr-board\/\d+$/.test(format)
        ? `board.md is ${format}, written by a newer Viberr. This instance reads ${BOARD_FILE_FORMAT}.`
        : `board.md says \`format: ${format}\`; a Viberr board file says \`format: ${BOARD_FILE_FORMAT}\`.`,
    );
    return { board, readable: false, problems, notes };
  }
  for (const key of Object.keys(data)) {
    if (PROJECT_ONLY_KEYS.includes(key)) {
      notes.push(`board.md sets \`${key}\`, which belongs to a project rather than its workflow, so the import leaves it out.`);
    } else if (!BOARD_KEYS.includes(key)) {
      problems.push(`board.md has a key Viberr does not read: \`${key}\`. Its keys are ${BOARD_KEYS.map((k) => `\`${k}\``).join(", ")}.`);
    }
  }

  const name = optionalText.parse(data.name) ?? "";
  const project: YamlMapping = {
    name: data.name,
    slug: "board",
    repo: null,
    defaultBranch: "main",
    // A board written by hand may leave the key out: its name's first
    // letters stand in, and the import form shows the key either way.
    taskPrefix: data.taskPrefix ?? (name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "BRD"),
    nextTaskNumber: 1,
    stages: data.stages,
    workflow: data.workflow ?? [],
    members: [],
    agents: data.agents ?? [],
    credentialPolicy: null,
    guardrails: data.guardrails ?? [],
    requiredReviewers: data.requiredReviewers ?? [],
    rulingsKb: data.rulingsKb ?? null,
    fileLeases: [],
  };
  if (data.gates !== undefined) project.gates = data.gates;
  const parsed = parseProjectFrontmatter(project, { fallbackSlug: "board" });
  for (const d of parsed.diagnostics) problems.push(`board.md: ${d.message}`);
  const fm = parsed.frontmatter;
  board.name = fm.name;
  board.taskPrefix = fm.taskPrefix.toUpperCase();
  board.stages = fm.stages;
  board.workflow = fm.workflow;
  board.agents = fm.agents;
  board.guardrails = fm.guardrails;
  board.requiredReviewers = fm.requiredReviewers;
  board.rulingsKb = fm.rulingsKb ?? null;
  if (fm.gates) board.gates = fm.gates;

  board.knowledgeBases = boardRows(data, "knowledgeBases", kbRowSchema, problems).map((kb) => ({
    dir: kb.dir,
    name: kb.name ?? kb.dir,
    refresh: kb.refresh,
    private: kb.private,
  }));
  board.skills = boardRows(data, "skills", skillRowSchema, problems);
  board.mcpServers = boardRows(data, "mcpServers", mcpRowSchema, problems).map((m) => {
    const server: BoardMcpServer = { name: m.name, transport: m.transport, target: m.target };
    if (m.writeTools) server.writeTools = m.writeTools;
    return server;
  });
  return { board, readable: true, problems, notes };
}
