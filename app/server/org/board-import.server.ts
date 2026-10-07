import type { DatabaseSync } from "node:sqlite";
import {
  checkNewProjectIdentity,
  newProjectFrontmatter,
  reachProjectRepository,
  writeNewProject,
  type CreateProjectContext,
  type CreateProjectResult,
  type CreateRepositoryRequest,
} from "~/features/home/project-create.server";
import { validateProjectGates } from "~/features/project-settings/settings-actions.server";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  Boundary,
  ProjectFrontmatter,
  StageDef,
} from "~/schemas/project-file.schema";
import { withActionWatchdog } from "~/server/actions/action-watchdog.server";
import { readTemplate } from "~/server/agents/deployment-view.server";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  parseAgentProfileContent,
  readAgentProfileFile,
  serializeAgentProfile,
  type ParsedAgentProfile,
} from "~/server/files/agent-profile-file.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
  kbDirPath,
  skillDirPath,
} from "~/server/files/file-store-root.server";
import { assertSkillBodyWellFormed } from "~/server/files/skill-body.server";
import { getProject, listProjects } from "~/server/projections/board-query.server";
import { baseAgentDeployments } from "~/server/seed/agent-catalog.server";
import { grantsWriteRepository } from "~/server/tasks/specialist-tool-policy";
import type { BoardDelivers } from "~/shared/board-delivers";
import { errorMessage } from "~/shared/errors";
import { slugify } from "~/shared/ids/slugify";
import { countLabel } from "~/shared/text/plural";
import { realignChainToStages } from "~/shared/workflow/transitions";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { existsSync, readdirSync } from "node:fs";
import {
  BOARD_FILE_MAX_BYTES,
  boardKbFiles,
  parseBoardFile,
  readBoardFile,
  type BoardBundle,
  type BoardDefinition,
  type BoardFolderFile,
  type BoardKnowledgeBase,
  type BoardMcpServer,
  type BoardSkill,
} from "./board-file.server";
import {
  checkedMcpDefinition,
  listKnowledgeBases,
  listMcpServers,
  listSkillNames,
  registerMcpServer,
  resolveStoreTarget,
  saveKnowledgeBase,
  saveSkill,
  setKnowledgeBasePrivacy,
  type OrgSeedContext,
} from "./resources.server";
import { readStoreFolderFiles, writeStoreFiles } from "./store-files.server";

/**
 * Ruling 653: IMPORT a board file as a new project, from Instance settings
 * (an org admin's door, like every other change to the instance's agent
 * resources). Two steps, one plan:
 *
 * 1. PREVIEW reads the file and plans the import without writing anything:
 *    the board it describes, and for every knowledge base, skill, MCP server
 *    and agent template it carries, whether this instance has none by that
 *    name (it comes in), has the same one (it is used as it is) or has a
 *    different one. Problems that refuse the import are listed all at once,
 *    each naming its line.
 * 2. IMPORT plans again from the same bytes (nothing is kept between the two
 *    requests) and writes, in order: the project's identity and repository
 *    are checked and the repository probed or created exactly as the New
 *    project dialog does; then the resources come in through their own
 *    writers; then project.md.
 *
 * When this instance holds a DIFFERENT knowledge base, skill or MCP server
 * under a name the file uses, the admin chooses per resource: import the
 * file's as a copy under a free name (the default, so the board runs what
 * was exported and nothing else on the instance changes), or use this
 * instance's. Every grant, the rulings knowledge base and every required
 * reviewer is rewritten to the names that were written. A template is never
 * overwritten either: a different one stays as it is in the library, and the
 * board's agent deployed from it carries the file's settings as its own
 * definition, so it runs what was exported.
 *
 * MCP servers come in UNCHECKED and without credentials (`registerMcpServer`):
 * nothing in a file runs or is contacted until an admin tests it.
 */

export type BoardResourceKind = "kb" | "skill" | "mcp" | "agent";

/** `new`: this instance has none by that name. `same`: it has the same one.
 *  `differs`: it has a different one under that name. */
export type BoardResourceStatus = "new" | "same" | "differs";

/** What a `differs` resource does: come in as a copy, or yield to this
 *  instance's. Agent templates have no choice (see the module header). */
export type BoardResourceChoice = "copy" | "existing";

/** One resource a board file carries, as the import dialog lists it. Its
 *  choice is posted under `<kind>:<key>`. */
export interface BoardImportResource {
  kind: BoardResourceKind;
  /** Its key in the file: a knowledge base's folder, a skill's or an MCP
   *  server's name, a template's id. */
  key: string;
  /** What a person reads: a knowledge base's or a template's display name. */
  label: string;
  /** One line about it: "3 files", "stdio · npx -y @acme/mcp". */
  detail: string;
  status: BoardResourceStatus;
  /** The key it is written under when it comes in: its own, or a free one
   *  when this instance already uses its own. */
  createAs: string;
  /** The board's agents that are granted it or deployed from it. */
  usedBy: string[];
}

/** One agent the board deploys, as the import dialog lists it. */
export interface BoardImportAgent {
  profileId: string;
  name: string;
  role: string;
  backend: "claude" | "codex" | null;
  model: string;
  operator: boolean;
}

/** Everything the import dialog shows before anything is written. */
export interface BoardImportPreview {
  fileName: string;
  name: string;
  taskPrefix: string;
  description: string;
  /** A project name this instance has no project for: the board's own, or
   *  the board's with a number. */
  suggestedName: string;
  exportedAt: string | null;
  exportedFrom: string | null;
  viberrVersion: string | null;
  stages: StageDef[];
  /** The rule into each stage after the first, in stage order. */
  workflow: { from: string; to: string; boundary: Boundary }[];
  /** Ruling 667: `software` when an agent the board deploys may write a
   *  repository, so the import needs one; `results` when none may, so the
   *  repository is optional. */
  delivers: BoardDelivers;
  agents: BoardImportAgent[];
  guardrails: number;
  gates: string[];
  /** "Reviewer at Review". */
  requiredReviewers: string[];
  rulingsKb: string | null;
  resources: BoardImportResource[];
  /** Sentences that refuse the import until the file is fixed. */
  problems: string[];
  /** Sentences to read before importing. */
  notes: string[];
}

/** The import form: the new project's identity and repository, and the
 *  choices for the resources this instance holds differently. */
export interface BoardImportInput {
  name: string;
  key: string;
  owner: string;
  repoName: string;
  createRepository?: CreateRepositoryRequest;
  /** By `<kind>:<key>`; a resource not named here comes in as a copy. */
  choices: ReadonlyMap<string, BoardResourceChoice>;
}

/** What an import hands the route: the new project, and its toast. */
export interface BoardImportResult extends CreateProjectResult {
  toast: string;
}

/** The uploaded file: its name (for the dialog and the record) and bytes. */
export interface BoardFileUpload {
  name: string;
  bytes: Uint8Array;
}

const OPERATOR_PROFILE_ID = "operator";
const CONTROLLER_PROFILE_ID = "controller";

/** What the planner needs of each resource beyond its preview row. */
interface PlannedKb {
  view: BoardImportResource;
  meta: BoardKnowledgeBase;
  files: BoardFolderFile[];
  /** The display name its `createAs` folder is made from. */
  createName: string;
}

interface PlannedSkill {
  view: BoardImportResource;
  meta: BoardSkill;
  files: BoardFolderFile[];
}

interface PlannedMcp {
  view: BoardImportResource;
  meta: BoardMcpServer;
}

interface PlannedTemplate {
  view: BoardImportResource;
  template: ParsedAgentProfile;
}

interface ImportPlan {
  preview: BoardImportPreview;
  board: BoardDefinition;
  kbs: PlannedKb[];
  skills: PlannedSkill[];
  mcps: PlannedMcp[];
  templates: PlannedTemplate[];
}

/** A free name a create takes, and the store key it slugs to. */
interface ClaimedName {
  name: string;
  key: string;
}

/** The names a create may still take: this instance's, and those already
 *  claimed by an earlier resource of the same kind in this import. */
class NameClaims {
  private readonly taken: Set<string>;
  constructor(existing: Iterable<string>) {
    this.taken = new Set(existing);
  }
  /**
   * The first of `base`, `base 2`, `base 3`… whose key is free, claimed.
   * The key is the slug of the name (how every store writer keys a
   * resource), so a knowledge base named "Release rulings 2" lands in
   * `release-rulings-2`.
   */
  claim(base: string): ClaimedName {
    for (let n = 1; ; n += 1) {
      const name = n === 1 ? base : `${base} ${n}`;
      const key = slugify(name);
      if (!this.taken.has(key)) {
        this.taken.add(key);
        return { name, key };
      }
    }
  }
}

/** A folder's content, comparable: each path with its bytes' hash. */
function folderDigest(files: readonly BoardFolderFile[]): string {
  return files
    .map((f) => `${f.path}\u0000${sha256Hex(f.data)}`)
    .sort()
    .join("\n");
}

/** A template as compared: its frontmatter (defaults filled by the parse)
 *  and body, serialized under one id. */
function templateDigest(template: ParsedAgentProfile, id: string): string {
  return serializeAgentProfile({
    frontmatter: { ...template.frontmatter, id },
    description: template.description,
  });
}

/** Which of the board's agents use a resource, by name, for the dialog. */
function usersOf(
  board: BoardDefinition,
  templates: ReadonlyMap<string, ParsedAgentProfile>,
  kind: "skills" | "mcps" | "kb",
  key: string,
): string[] {
  const names: string[] = [];
  for (const d of board.agents) {
    const template = templates.get(d.profileId);
    const own = d.definition?.resources?.[kind];
    const granted = own ?? template?.frontmatter.resources[kind] ?? [];
    if (granted.includes(key)) {
      names.push(d.definition?.name ?? template?.frontmatter.name ?? d.profileId);
    }
  }
  return names;
}

/** The ids of project-local agents (deployed with no template here), which a
 *  new template must not take (P13-AP-12). */
function projectLocalIds(db: DatabaseSync, dataRoot: string | undefined): Set<string> {
  const ids = new Set<string>();
  for (const project of listProjects(db)) {
    for (const d of project.agentPolicy) {
      if (d.profileId === OPERATOR_PROFILE_ID) continue;
      if (!existsSync(agentProfileFilePath(d.profileId, dataRoot))) ids.add(d.profileId);
    }
  }
  return ids;
}

/** Every template file this instance holds, by id, whatever its kind. */
function templateIds(dataRoot: string | undefined): string[] {
  const dir = agentProfilesDir(dataRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -".md".length));
}

/**
 * The structural checks a project file's writers make one edit at a time,
 * made on the whole board at once. Normalizes what a stage edit would (the
 * workflow chain; the operator every board has) and says so in a note.
 */
function checkBoard(board: BoardDefinition, problems: string[], notes: string[]): void {
  if (board.stages.length < 2) {
    problems.push("board.md: a board needs at least two stages, one to start in and one to finish in.");
    return;
  }
  const stageIds = new Set<string>();
  for (const stage of board.stages) {
    if (stageIds.has(stage.id)) problems.push(`board.md: two stages have the id \`${stage.id}\`.`);
    stageIds.add(stage.id);
  }
  const terminal = board.stages[board.stages.length - 1]!;
  const intoTerminal = board.workflow.find((w) => w.to === terminal.id);
  if (intoTerminal && intoTerminal.boundary !== "human") {
    problems.push(
      `board.md: the move into ${terminal.name} is \`${intoTerminal.boundary}\`; it is always \`human\`, because a person accepts finished work.`,
    );
  }
  const chain = realignChainToStages(board.stages, board.workflow);
  const step = (w: { from: string; to: string; boundary: string }) => `${w.from}>${w.to}:${w.boundary}`;
  if (chain.map(step).join(",") !== board.workflow.map(step).join(",")) {
    notes.push(
      "board.md's workflow does not step through its stages one at a time, so the import wires it the way a stage edit would: one rule between each pair of neighbouring stages.",
    );
  }
  board.workflow = chain;

  const seen = new Set<string>();
  for (const d of board.agents) {
    if (seen.has(d.profileId)) problems.push(`board.md: the agent \`${d.profileId}\` is deployed twice.`);
    // Ruling 99: the controller is the instance's own, never one of a
    // board's agents.
    if (d.profileId === CONTROLLER_PROFILE_ID) {
      problems.push("board.md deploys `controller`, the instance's controller, which is never one of a board's agents.");
    }
    seen.add(d.profileId);
  }
  if (!seen.has(OPERATOR_PROFILE_ID)) {
    const operator = baseAgentDeployments().find((d) => d.profileId === OPERATOR_PROFILE_ID);
    if (operator) board.agents.unshift(operator);
    notes.push("board.md deploys no operator, so the import adds the base one: every board has it.");
  }
  for (const rule of board.requiredReviewers) {
    const stage = board.stages.find((s) => s.id === rule.stageId);
    if (!stage) problems.push(`board.md: a required reviewer names the stage \`${rule.stageId}\`, which the board does not have.`);
    else if (isTerminalStage(rule.stageId, board.stages)) {
      problems.push(`board.md: a required reviewer is set at ${stage.name}, the final stage; a review runs before it.`);
    }
    if (!seen.has(rule.profileId)) {
      problems.push(`board.md: a required reviewer names the agent \`${rule.profileId}\`, which the board does not deploy.`);
    }
  }
  if (board.gates) {
    try {
      board.gates = validateProjectGates(board.gates);
    } catch (error) {
      problems.push(`board.md: ${errorMessage(error).replace(/ Nothing was written\.$/, "")}`);
    }
  }
}

/** Read, decode and check the file, and plan every resource against this
 *  instance. Writes nothing. Throws only for a file that is not a board file
 *  at all; everything else is a problem in the preview. */
function planBoardImport(db: DatabaseSync, file: BoardFileUpload, ctx: OrgSeedContext): ImportPlan {
  if (file.bytes.byteLength > BOARD_FILE_MAX_BYTES) {
    throw AppError.validation(
      `${file.name} is ${Math.round(file.bytes.byteLength / 1024 / 1024)} MB; a board file is at most ${BOARD_FILE_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const bundle: BoardBundle = readBoardFile(file.bytes);
  const reading = parseBoardFile(bundle.board);
  const { board } = reading;
  const problems = [...reading.problems];
  const notes = [...reading.notes];
  if (bundle.ignored.length > 0) {
    const shown = bundle.ignored.slice(0, 5).map((p) => `\`${p}\``).join(", ");
    notes.push(
      `${countLabel(bundle.ignored.length, "file")} in the zip ${bundle.ignored.length === 1 ? "has" : "have"} no place in a board file and ${bundle.ignored.length === 1 ? "is" : "are"} left out: ${shown}${bundle.ignored.length > 5 ? "…" : ""}.`,
    );
  }
  // Every problem at once: the board's own checks run whatever else is
  // wrong in the file, unless there is no board to check.
  if (reading.readable) checkBoard(board, problems, notes);

  // ---- agent templates
  const parsedTemplates = new Map<string, ParsedAgentProfile>();
  for (const [id, text] of [...bundle.templates].sort((a, b) => a[0].localeCompare(b[0]))) {
    const { parsed, diagnostics } = parseAgentProfileContent(text, { fallbackId: id });
    if (!parsed) {
      problems.push(`agents/${id}.md is not an agent template: ${diagnostics.map((d) => d.message).join(" ")}`);
      continue;
    }
    if (parsed.frontmatter.kind !== "specialist") {
      problems.push(
        `agents/${id}.md is the ${parsed.frontmatter.kind}'s template, which belongs to the instance; a board file carries specialist templates only.`,
      );
      continue;
    }
    if (!slugify(id)) {
      problems.push(`agents/${id}.md: a template's file name is its id, in letters, digits and dashes.`);
      continue;
    }
    parsedTemplates.set(id, { frontmatter: { ...parsed.frontmatter, id }, description: parsed.description });
  }
  const localIds = projectLocalIds(db, ctx.dataRoot);
  const templateClaims = new NameClaims([...templateIds(ctx.dataRoot), ...localIds]);
  const templates: PlannedTemplate[] = [];
  for (const [id, template] of parsedTemplates) {
    const usedBy = board.agents.filter((d) => d.profileId === id).map((d) => d.definition?.name ?? template.frontmatter.name);
    // Only a specialist template of that id is this one's counterpart; the
    // id held by anything else (another project's own agent, the operator's
    // or the controller's file) is simply taken.
    const found = localIds.has(id)
      ? null
      : (readAgentProfileFile(agentProfileFilePath(id, ctx.dataRoot), id)?.parsed ?? null);
    const here = found?.frontmatter.kind === "specialist" ? found : null;
    const status: BoardResourceStatus = here
      ? templateDigest(here, id) === templateDigest(template, id)
        ? "same"
        : "differs"
      : "new";
    const createAs = status === "new" ? templateClaims.claim(id).key : id;
    const fm = template.frontmatter;
    templates.push({
      template,
      view: {
        kind: "agent",
        key: id,
        label: fm.name,
        detail: [fm.backends[0] === "codex" ? "Codex" : "Claude", fm.role].filter(Boolean).join(" · "),
        status,
        createAs,
        usedBy,
      },
    });
  }

  // ---- knowledge bases: the folders the file holds and the ones board.md lists
  const kbHere = new Map(listKnowledgeBases(db, ctx).map((kb) => [kb.dir, kb]));
  const kbClaims = new NameClaims(kbHere.keys());
  const kbs: PlannedKb[] = [];
  const kbDirs = new Set([...bundle.kbs.keys(), ...board.knowledgeBases.map((k) => k.dir)]);
  for (const dir of [...kbDirs].sort()) {
    const meta = board.knowledgeBases.find((k) => k.dir === dir) ?? {
      dir,
      name: dir,
      refresh: "on change" as const,
      private: false,
    };
    const files = bundle.kbs.get(dir) ?? [];
    const nameBase = slugify(meta.name) ? meta.name.trim() : dir;
    if (nameBase.length < 2 || !slugify(nameBase)) {
      problems.push(`board.md: the knowledge base \`${dir}\` needs a name of two characters or more.`);
      continue;
    }
    const here = kbHere.get(dir);
    // Compared as a board file carries it (`boardKbFiles`): the instance's
    // folder may hold a board's own "connects no repository" decision, which
    // no file carries and which is no difference between the two.
    const status: BoardResourceStatus = here
      ? folderDigest(boardKbFiles(readStoreFolderFiles(kbDirPath(dir, ctx.dataRoot)))) === folderDigest(files)
        ? "same"
        : "differs"
      : "new";
    // A knowledge base used as it is claims nothing; one that may come in
    // claims the free folder it would be written to.
    const created = status === "same" ? { name: meta.name, key: dir } : kbClaims.claim(nameBase);
    kbs.push({
      meta,
      files,
      createName: created.name,
      view: {
        kind: "kb",
        key: dir,
        label: meta.name,
        detail: `${countLabel(files.length, "file")}${meta.private ? " · private" : ""}`,
        status,
        createAs: created.key,
        usedBy: usersOf(board, parsedTemplates, "kb", dir),
      },
    });
  }

  // ---- skills
  const skillHere = new Set(listSkillNames(db, ctx));
  const skillClaims = new NameClaims(skillHere);
  const skills: PlannedSkill[] = [];
  const skillNames = new Set([...bundle.skills.keys(), ...board.skills.map((s) => s.name)]);
  // board.md's skill rows by name, built once: nothing caps how many rows a
  // received file lists. The first row of a repeated name wins.
  const skillMeta = new Map<string, BoardSkill>();
  for (const s of board.skills) if (!skillMeta.has(s.name)) skillMeta.set(s.name, s);
  for (const name of [...skillNames].sort()) {
    const meta = skillMeta.get(name) ?? { name, summary: "" };
    const files = bundle.skills.get(name) ?? [];
    if (slugify(name).length < 2) {
      problems.push(`The skill \`${name}\` needs a name of two characters or more.`);
      continue;
    }
    const skillMd = files.find((f) => f.path === "SKILL.md");
    if (skillMd) {
      try {
        assertSkillBodyWellFormed(skillMd.data.toString("utf8"));
      } catch (error) {
        problems.push(`skills/${name}/SKILL.md: ${errorMessage(error)}`);
      }
    } else {
      notes.push(`The skill \`${name}\` has no SKILL.md, so it gives an agent nothing until one is added.`);
    }
    const status: BoardResourceStatus = skillHere.has(name)
      ? folderDigest(readStoreFolderFiles(skillDirPath(name, ctx.dataRoot))) === folderDigest(files)
        ? "same"
        : "differs"
      : "new";
    const createAs = status === "same" ? name : skillClaims.claim(name).key;
    skills.push({
      meta,
      files,
      view: {
        kind: "skill",
        key: name,
        label: name,
        detail: meta.summary || countLabel(files.length, "file"),
        status,
        createAs,
        usedBy: usersOf(board, parsedTemplates, "skills", name),
      },
    });
  }

  // ---- MCP servers
  const mcpHere = new Map(listMcpServers(db).map((m) => [m.name, m]));
  const mcpClaims = new NameClaims(mcpHere.keys());
  const mcps: PlannedMcp[] = [];
  for (const meta of [...board.mcpServers].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      checkedMcpDefinition(meta);
    } catch (error) {
      problems.push(`board.md: the MCP server \`${meta.name}\`: ${errorMessage(error)}`);
      continue;
    }
    const here = mcpHere.get(meta.name);
    const status: BoardResourceStatus = here
      ? here.transport === meta.transport && here.target === meta.target.trim()
        ? "same"
        : "differs"
      : "new";
    const createAs = status === "same" ? meta.name : mcpClaims.claim(meta.name).key;
    mcps.push({
      meta,
      view: {
        kind: "mcp",
        key: meta.name,
        label: meta.name,
        detail: `${meta.transport} · ${meta.target.trim()}`,
        status,
        createAs,
        usedBy: usersOf(board, parsedTemplates, "mcps", meta.name),
      },
    });
  }

  // ---- references the file does not carry
  const carried = {
    kb: new Set(kbs.map((k) => k.view.key)),
    skills: new Set(skills.map((s) => s.view.key)),
    mcps: new Set(mcps.map((m) => m.view.key)),
  };
  const here = { kb: new Set(kbHere.keys()), skills: skillHere, mcps: new Set(mcpHere.keys()) };
  const dangling: string[] = [];
  const borrowed: string[] = [];
  const label = { kb: "knowledge base", skills: "skill", mcps: "MCP server" } as const;
  for (const kind of ["kb", "skills", "mcps"] as const) {
    const granted = new Set<string>();
    for (const d of board.agents) {
      for (const key of d.definition?.resources?.[kind] ?? parsedTemplates.get(d.profileId)?.frontmatter.resources[kind] ?? []) {
        granted.add(key);
      }
    }
    for (const t of parsedTemplates.values()) for (const key of t.frontmatter.resources[kind]) granted.add(key);
    for (const key of [...granted].sort()) {
      if (carried[kind].has(key)) continue;
      if (here[kind].has(key)) borrowed.push(`${label[kind]} \`${key}\``);
      else dangling.push(`${label[kind]} \`${key}\``);
    }
  }
  if (board.rulingsKb && !carried.kb.has(board.rulingsKb) && !here.kb.has(board.rulingsKb)) {
    problems.push(
      `board.md names \`${board.rulingsKb}\` as the board's rulings knowledge base, which neither this file nor this instance has. Every agent on the board reads it, so it must exist.`,
    );
  }
  if (borrowed.length > 0) {
    notes.push(`The agents are granted ${borrowed.join(", ")}, which the file does not carry; this instance has ${borrowed.length === 1 ? "one" : "them"} by that name, and the board uses ${borrowed.length === 1 ? "it" : "them"}.`);
  }
  if (dangling.length > 0) {
    notes.push(`The agents are granted ${dangling.join(", ")}, which neither the file nor this instance has. The grants come in as written and reach nothing until such a resource exists.`);
  }
  const unchecked = mcps.filter((m) => m.view.status !== "same");
  if (unchecked.length > 0) {
    const commands = unchecked.filter((m) => m.meta.transport === "stdio").map((m) => `\`${m.meta.target.trim()}\``);
    notes.push(
      `${countLabel(unchecked.length, "MCP server")} come${unchecked.length === 1 ? "s" : ""} in unchecked and without a credential. ` +
        (commands.length > 0
          ? `Nothing runs on import: ${commands.join(", ")} runs when an admin tests it and on every run granted it. `
          : "") +
        "Test each one in Agent resources, and give it its credential or sign-in if it needs one.",
    );
  }

  // ---- what the dialog shows of the board itself
  const templateFor = (profileId: string) => parsedTemplates.get(profileId)?.frontmatter ?? readTemplate(profileId, ctx.dataRoot);
  const agents: BoardImportAgent[] = board.agents.map((d) => {
    if (d.profileId === OPERATOR_PROFILE_ID) {
      return {
        profileId: d.profileId,
        name: "Operator",
        role: d.definition?.autonomy === "full" ? "Runs every task · full autonomy" : "Runs every task",
        backend: d.definition?.backends?.[0] ?? null,
        model: d.definition?.model ?? "",
        operator: true,
      };
    }
    const t = templateFor(d.profileId);
    const def = d.definition;
    return {
      profileId: d.profileId,
      name: def?.name ?? t?.name ?? d.profileId,
      role: def?.role ?? t?.role ?? "",
      backend: def?.backends?.[0] ?? t?.backends[0] ?? null,
      model: def?.model ?? t?.model ?? "",
      operator: false,
    };
  });
  const agentName = (id: string) => agents.find((a) => a.profileId === id)?.name ?? id;
  const stageName = (id: string) => board.stages.find((s) => s.id === id)?.name ?? id;
  let suggestedName = board.name;
  for (let n = 2; getProject(db, slugify(suggestedName)) && n < 100; n += 1) {
    suggestedName = `${board.name} ${n}`;
  }
  const preview: BoardImportPreview = {
    fileName: file.name,
    name: board.name,
    taskPrefix: board.taskPrefix,
    description: board.description,
    suggestedName,
    exportedAt: board.exportedAt,
    exportedFrom: board.exportedFrom,
    viberrVersion: board.viberrVersion,
    stages: board.stages,
    workflow: board.workflow.map((w) => ({ from: w.from, to: w.to, boundary: w.boundary })),
    delivers: boardDelivers(board.agents),
    agents,
    guardrails: board.guardrails.length,
    gates: (board.gates ?? []).map((g) => g.name),
    requiredReviewers: board.requiredReviewers.map((r) => `${agentName(r.profileId)} at ${stageName(r.stageId)}`),
    rulingsKb: board.rulingsKb,
    resources: [...kbs, ...skills, ...mcps, ...templates].map((r) => r.view),
    problems,
    notes,
  };
  return { preview, board, kbs, skills, mcps, templates };
}

/**
 * Ruling 667: what an imported board delivers, read off its own roster. The
 * file carries each deployment's grants as they were exported, so an agent
 * that may write a repository makes it a software board, which needs one.
 */
function boardDelivers(agents: readonly AgentDeployment[]): BoardDelivers {
  return agents.some(
    (a) => a.profileId !== OPERATOR_PROFILE_ID && grantsWriteRepository(a.capabilities),
  )
    ? "software"
    : "results";
}

/**
 * Read a board file and say what importing it would do, writing nothing.
 * Refuses only a file that is not a board file at all (not a zip, an unsafe
 * zip, no board.md); a board file with problems previews with them listed.
 */
export function previewBoardImport(
  db: DatabaseSync,
  file: BoardFileUpload,
  ctx: OrgSeedContext = {},
): BoardImportPreview {
  return planBoardImport(db, file, ctx).preview;
}

/** The names each kind of resource is written under, where they changed. */
interface Renames {
  kb: Map<string, string>;
  skills: Map<string, string>;
  mcps: Map<string, string>;
  /** Deployment ids: a template written under a free id, a project-local
   *  agent whose id names a template here. */
  agents: Map<string, string>;
}

/** Whether a resource the instance holds differently comes in as a copy. */
function comesIn(view: BoardImportResource, choices: ReadonlyMap<string, BoardResourceChoice>): boolean {
  if (view.status === "new") return true;
  if (view.status === "same") return false;
  return choices.get(`${view.kind}:${view.key}`) !== "existing";
}

function rename(list: readonly string[] | undefined, map: ReadonlyMap<string, string>): string[] | undefined {
  if (!list) return undefined;
  return list.map((key) => map.get(key) ?? key);
}

/** A deployment's or a template's grant lists, by kind. */
interface GrantLists {
  skills?: string[];
  mcps?: string[];
  kb?: string[];
}

function renameResources(resources: GrantLists, renames: Renames): GrantLists {
  const out: GrantLists = { ...resources };
  const skills = rename(resources.skills, renames.skills);
  const mcps = rename(resources.mcps, renames.mcps);
  const kb = rename(resources.kb, renames.kb);
  if (skills) out.skills = skills;
  if (mcps) out.mcps = mcps;
  if (kb) out.kb = kb;
  return out;
}

/**
 * A deployment's definition with every field it leaves to its template
 * filled from the FILE's template — what the runtime would resolve it to on
 * the instance it was exported from (`deploymentRuntimeIdentity`: the
 * override wins field by field). Used when this instance's template of that
 * id is not the file's, so the board still runs what was exported.
 */
function definitionFromTemplate(
  own: AgentDeploymentDefinition | undefined,
  template: ParsedAgentProfile,
): AgentDeploymentDefinition {
  const fm = template.frontmatter;
  const def: AgentDeploymentDefinition = { ...own };
  def.kind ??= "specialist";
  def.name ??= fm.name;
  def.role ??= fm.role ?? fm.name;
  def.icon ??= fm.icon;
  def.backends ??= [...fm.backends];
  if (def.model === undefined && fm.model) def.model = fm.model;
  if (def.effort === undefined && fm.effort) def.effort = fm.effort;
  def.scope ??= fm.scope;
  def.desc ??= fm.desc || template.description;
  if (def.persona === undefined && template.description) def.persona = template.description;
  def.stages ??= [...fm.stages];
  def.spanAll ??= fm.spanAll;
  def.resources ??= {
    skills: [...fm.resources.skills],
    mcps: [...fm.resources.mcps],
    kb: [...fm.resources.kb],
  };
  return def;
}

/** The board's deployments as the new project.md writes them. */
function importedAgents(plan: ImportPlan, renames: Renames, dataRoot: string | undefined, notes: string[]): AgentDeployment[] {
  const byId = new Map(plan.templates.map((t) => [t.view.key, t]));
  const taken = new NameClaims([...templateIds(dataRoot), ...plan.board.agents.map((d) => d.profileId)]);
  const resourcesRenamed = (resources: { skills: string[]; mcps: string[]; kb: string[] }) =>
    resources.skills.some((k) => renames.skills.has(k)) ||
    resources.mcps.some((k) => renames.mcps.has(k)) ||
    resources.kb.some((k) => renames.kb.has(k));
  return plan.board.agents.map((d) => {
    const planned = byId.get(d.profileId);
    let definition = d.definition;
    let profileId = d.profileId;
    if (planned) {
      if (planned.view.status === "new") {
        profileId = planned.view.createAs;
      } else if (planned.view.status === "differs" || resourcesRenamed(planned.template.frontmatter.resources)) {
        definition = definitionFromTemplate(definition, planned.template);
      }
    } else if (
      profileId !== OPERATOR_PROFILE_ID &&
      definition?.name &&
      existsSync(agentProfileFilePath(profileId, dataRoot))
    ) {
      // A project-local agent (its whole definition on the board) whose id
      // names a template here would read as a copy of that template; it
      // takes a free id, as `createAgentProfile` gives one (P13-AP-12).
      profileId = taken.claim(profileId).key;
      notes.push(`The board's own agent ${definition.name} takes the id \`${profileId}\`, because \`${d.profileId}\` names a template on this instance.`);
    }
    if (profileId !== d.profileId) renames.agents.set(d.profileId, profileId);
    const deployment: AgentDeployment = { ...d, profileId };
    if (definition) {
      deployment.definition = definition.resources
        ? { ...definition, resources: renameResources(definition.resources, renames) }
        : definition;
    }
    return deployment;
  });
}

/** The resources an import wrote, by kind, for its toast and its record. */
interface WrittenResources {
  kbs: string[];
  skills: string[];
  mcps: string[];
  templates: string[];
}

/** Write what the plan says comes in, through each resource's own writer.
 *  A failure part-way names what already came in. */
async function writeBoardResources(
  db: DatabaseSync,
  plan: ImportPlan,
  renames: Renames,
  choices: ReadonlyMap<string, BoardResourceChoice>,
  actor: AuditActor,
  ctx: OrgSeedContext,
  fileName: string,
): Promise<WrittenResources> {
  const written: WrittenResources = { kbs: [], skills: [], mcps: [], templates: [] };
  const step = async (what: string, write: () => Promise<void> | void) => {
    try {
      await write();
    } catch (error) {
      const already = [...written.kbs, ...written.skills, ...written.mcps, ...written.templates];
      throw AppError.validation(
        `The import stopped at ${what}: ${errorMessage(error)}` +
          (already.length > 0 ? ` What came in before it stays: ${already.join(", ")}. No project was written.` : " Nothing was written."),
      );
    }
  };
  for (const kb of plan.kbs) {
    if (!comesIn(kb.view, choices)) continue;
    await step(`the knowledge base ${kb.view.label}`, async () => {
      const saved = await saveKnowledgeBase(db, { name: kb.createName, refresh: kb.meta.refresh }, actor, ctx);
      if (kb.files.length > 0) {
        const target = resolveStoreTarget(db, "kb", saved.kb.id, ctx);
        if (target) writeStoreFiles(db, target, [], kb.files.map((f) => ({ relPath: f.path, data: f.data })), actor);
      }
      if (kb.meta.private) setKnowledgeBasePrivacy(db, { id: saved.kb.id, private: true }, actor, ctx);
      written.kbs.push(saved.kb.dir);
    });
  }
  for (const skill of plan.skills) {
    if (!comesIn(skill.view, choices)) continue;
    await step(`the skill ${skill.view.key}`, async () => {
      const saved = await saveSkill(
        db,
        { name: skill.view.createAs, summary: skill.meta.summary, body: "", contentMode: "files" },
        actor,
        ctx,
      );
      if (skill.files.length > 0) {
        const target = resolveStoreTarget(db, "skill", saved.skill.id, ctx);
        if (target) writeStoreFiles(db, target, [], skill.files.map((f) => ({ relPath: f.path, data: f.data })), actor);
      }
      written.skills.push(saved.skill.name);
    });
  }
  for (const mcp of plan.mcps) {
    if (!comesIn(mcp.view, choices)) continue;
    await step(`the MCP server ${mcp.view.key}`, () => {
      const input: Parameters<typeof registerMcpServer>[1] = {
        name: mcp.view.createAs,
        transport: mcp.meta.transport,
        target: mcp.meta.target,
      };
      if (mcp.meta.writeTools) input.writeTools = mcp.meta.writeTools;
      written.mcps.push(registerMcpServer(db, input, actor).name);
    });
  }
  for (const t of plan.templates) {
    if (t.view.status !== "new") continue;
    await step(`the agent template ${t.view.label}`, () => {
      const id = t.view.createAs;
      const fm = t.template.frontmatter;
      writeFileAtomic(
        agentProfileFilePath(id, ctx.dataRoot),
        serializeAgentProfile({
          frontmatter: { ...fm, id, resources: { ...fm.resources, ...renameResources(fm.resources, renames) } },
          description: t.template.description,
        }),
      );
      recordAudit(db, {
        action: "org.agent_profile.created",
        actor,
        subjectKind: "agent_profile",
        subjectId: id,
        details: { name: fm.name, backend: fm.backends[0] ?? null, model: fm.model, effort: fm.effort ?? "", importedFrom: fileName },
      });
      written.templates.push(id);
    });
  }
  return written;
}

/** "Release train imported as REL: 5 stages, 4 agents. New here: 2 skills
 *  and 1 MCP server. Test release-bot in Agent resources…" */
function importToast(
  result: CreateProjectResult,
  frontmatter: ProjectFrontmatter,
  written: WrittenResources,
): string {
  const parts = [
    written.kbs.length > 0 ? countLabel(written.kbs.length, "knowledge base") : null,
    written.skills.length > 0 ? countLabel(written.skills.length, "skill") : null,
    written.mcps.length > 0 ? countLabel(written.mcps.length, "MCP server") : null,
    written.templates.length > 0 ? countLabel(written.templates.length, "agent template") : null,
  ].filter((p): p is string => p !== null);
  const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
  let toast =
    `${result.name} imported as ${result.key}: ${countLabel(frontmatter.stages.length, "stage")}, ` +
    `${countLabel(frontmatter.agents.length, "agent")}.`;
  if (parts.length > 0) toast += ` New on this instance: ${list.format(parts)}.`;
  if (written.mcps.length > 0) {
    toast += ` Test ${list.format(written.mcps)} in Agent resources before an agent relies on ${written.mcps.length === 1 ? "it" : "them"}.`;
  }
  return toast;
}

/**
 * Import a board file as a new project: plan it again from the bytes,
 * refuse while the file has problems, then check the identity and reach the
 * repository (the New project dialog's own steps), write the resources the
 * plan brings in, and write project.md with every name rewritten to what was
 * written. Under the creation watchdog, like every project creation.
 */
export async function importBoard(
  db: DatabaseSync,
  file: BoardFileUpload,
  input: BoardImportInput,
  actor: AuditActor & { userId: string },
  ctx: CreateProjectContext = {},
): Promise<BoardImportResult> {
  const orgCtx: OrgSeedContext = {};
  if (ctx.dataRoot) orgCtx.dataRoot = ctx.dataRoot;
  const plan = planBoardImport(db, file, orgCtx);
  const { problems } = plan.preview;
  if (problems.length > 0) {
    throw AppError.validation(
      problems.length === 1
        ? `${file.name} cannot be imported: ${problems[0]}`
        : `${file.name} cannot be imported until ${countLabel(problems.length, "problem")} in it ${problems.length === 1 ? "is" : "are"} fixed. The first: ${problems[0]}`,
    );
  }
  return withActionWatchdog(`import-board:${input.key || "?"}`, async () => {
    // Ruling 667: a board none of whose agents writes a repository needs none.
    const identity = checkNewProjectIdentity(db, { ...input, delivers: plan.preview.delivers });
    const reached = await reachProjectRepository(db, identity, input.createRepository, actor, ctx);
    const renames: Renames = { kb: new Map(), skills: new Map(), mcps: new Map(), agents: new Map() };
    const record = (map: Map<string, string>, views: readonly BoardImportResource[]) => {
      for (const view of views) {
        if (comesIn(view, input.choices) && view.createAs !== view.key) map.set(view.key, view.createAs);
      }
    };
    record(renames.kb, plan.kbs.map((k) => k.view));
    record(renames.skills, plan.skills.map((s) => s.view));
    record(renames.mcps, plan.mcps.map((m) => m.view));
    const notes: string[] = [];
    const agents = importedAgents(plan, renames, ctx.dataRoot, notes);
    const written = await writeBoardResources(db, plan, renames, input.choices, actor, orgCtx, file.name);

    const { board } = plan;
    const frontmatter: ProjectFrontmatter = {
      ...newProjectFrontmatter(identity, reached),
      stages: board.stages,
      workflow: board.workflow,
      members: [{ userId: actor.userId, role: "admin" }],
      agents,
      guardrails: board.guardrails,
      requiredReviewers: board.requiredReviewers.map((r) => ({
        ...r,
        profileId: renames.agents.get(r.profileId) ?? r.profileId,
      })),
      rulingsKb: board.rulingsKb ? (renames.kb.get(board.rulingsKb) ?? board.rulingsKb) : null,
    };
    if (board.gates) frontmatter.gates = board.gates;
    const reused = (views: readonly BoardImportResource[]) =>
      views.filter((v) => !comesIn(v, input.choices)).map((v) => v.key);
    const result = await writeNewProject(
      db,
      {
        identity,
        reached,
        frontmatter,
        description: board.description,
        details: {
          template: "imported",
          file: file.name.slice(0, 200),
          exportedFrom: board.exportedFrom,
          created: {
            kbs: written.kbs,
            skills: written.skills,
            mcps: written.mcps,
            templates: written.templates,
          },
          reused: {
            kbs: reused(plan.kbs.map((k) => k.view)),
            skills: reused(plan.skills.map((s) => s.view)),
            mcps: reused(plan.mcps.map((m) => m.view)),
          },
          renamed: notes,
        },
      },
      actor,
      ctx,
    );
    return { ...result, toast: importToast(result, frontmatter, written) };
  });
}
