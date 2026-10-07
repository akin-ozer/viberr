import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
  projectsDir,
} from "~/server/files/file-store-root.server";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import {
  parseAgentProfileContent,
  serializeAgentProfile,
} from "~/server/files/agent-profile-file.server";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import {
  deploymentName,
  deploymentResources,
  deploymentRuntimeIdentity,
  type DeploymentRuntimeIdentity,
} from "~/server/agents/deployment-view.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import type { OrgResourceKind } from "./resource-events.server";

/**
 * Referential integrity for agent RESOURCES (P13-KM-07).
 *
 * A knowledge base, skill or MCP server is referenced by SLUG from two places:
 *
 *   - `${DATA_ROOT}/agents/profiles/<id>.md` → frontmatter `resources.{skills,
 *     mcps,kb}` (the global templates), and
 *   - `${DATA_ROOT}/projects/<slug>/project.md` → `agents[].definition
 *     .resources.{…}` (each project's deployed copy).
 *
 * Renaming a KB moved its folder and its metadata row but rewrote NEITHER, so
 * every grant silently pointed at a directory that no longer existed. Verified
 * live: renaming "P13 facts" → "P13 facts v2" left seven profile references on
 * `p13-facts`, no warning anywhere, and a fresh run reported "there is no
 * p13-facts knowledge base reaching this run". Deleting had the same shape.
 *
 * These helpers run inside the rename/delete mutations so a reference is either
 * rewritten (rename) or dropped (delete) atomically with the store change. They
 * are best-effort per file: one malformed profile can never block the rename.
 */

export type ResourceKind = "skills" | "mcps" | "kb";

export interface ReferenceUpdate {
  /** How many profile/deployment reference lists changed. */
  updated: number;
}

/** Rewrite `from` → `to` (rename) or drop `from` (`to: null`, delete). */
export async function updateResourceReferences(
  kind: ResourceKind,
  from: string,
  to: string | null,
  dataRoot?: string,
): Promise<ReferenceUpdate> {
  if (!from || from === to) return { updated: 0 };
  let updated = 0;
  updated += rewriteTemplates(kind, from, to, dataRoot);
  updated += await rewriteProjects(kind, from, to, dataRoot);
  if (updated > 0) {
    // A drop carries no `to` at all — the key stays absent rather than logging
    // a null target nobody asked for.
    const fields = to ? { kind, from, to, updated } : { kind, from, updated };
    logger.info(
      to
        ? "resource reference rewritten after rename"
        : "resource reference dropped after delete",
      fields,
    );
  }
  return { updated };
}

/** Apply the rename/drop to one reference list; null when unchanged.
 *
 * A grant list is a SET: renaming `a` → `b` on a profile that already granted
 * `b` must leave one `b`, not two. The old de-dup only looked at what had been
 * emitted so far, so it missed a target appearing LATER in the list (P14-KM-07,
 * caught by the first test the deployment leg ever had). */
function nextList(
  list: readonly string[] | undefined,
  from: string,
  to: string | null,
): string[] | null {
  if (!list || !list.includes(from)) return null;
  const out: string[] = [];
  for (const entry of list) {
    const next = entry === from ? to : entry;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

function rewriteTemplates(
  kind: ResourceKind,
  from: string,
  to: string | null,
  dataRoot?: string,
): number {
  const dir = agentProfilesDir(dataRoot);
  if (!existsSync(dir)) return 0;
  let updated = 0;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    const file = agentProfileFilePath(id, dataRoot);
    try {
      const { parsed } = parseAgentProfileContent(readFileSync(file, "utf8"));
      if (!parsed) continue;
      const resources = parsed.frontmatter.resources;
      const next = nextList(resources[kind], from, to);
      if (!next) continue;
      writeFileAtomic(
        file,
        serializeAgentProfile({
          frontmatter: {
            ...parsed.frontmatter,
            resources: { ...resources, [kind]: next },
          },
          description: parsed.description,
        }),
      );
      updated += 1;
    } catch (error) {
      logger.warn("could not rewrite resource reference in an agent template", {
        kind,
        from,
        profileId: id,
        err: toError(error),
      });
    }
  }
  return updated;
}

/**
 * Project deployments carry a full definition SNAPSHOT, so the reference lives
 * in `project.md`. The file is edited as text through its YAML frontmatter via
 * the project writer, but the shape is nested arbitrarily deep inside
 * `agents[].definition.resources`, so a targeted structural edit is done here
 * with the same parse → mutate → serialize contract the writer uses.
 */
async function rewriteProjects(
  kind: ResourceKind,
  from: string,
  to: string | null,
  dataRoot?: string,
): Promise<number> {
  const root = projectsDir(dataRoot);
  if (!existsSync(root)) return 0;
  let updated = 0;
  for (const slug of readdirSync(root).sort()) {
    const file = path.join(root, slug, "project.md");
    if (!existsSync(file)) continue;
    try {
      let changed = false;
      await updateProjectFile({ projectSlug: slug, dataRoot }, (parsed) => {
        const fm = parsed.frontmatter;
        const agents = fm.agents.map((deployment) => {
          const definition = deployment.definition;
          const resources = definition?.resources;
          if (!definition || !resources) return deployment;
          const next = nextList(resources[kind], from, to);
          if (!next) return deployment;
          changed = true;
          const nextResources = { ...resources };
          nextResources[kind] = next;
          return {
            ...deployment,
            definition: { ...definition, resources: nextResources },
          };
        });
        // Ruling 672: the project's RULINGS knowledge base is a reference to
        // the same folder (ruling 239), and a RENAME left it pointing at the
        // old name: every run then read no rulings at all, and a decision kept
        // there (that the board connects no repository) stopped standing. A
        // DELETE leaves the name as it is, as before: the project's settings
        // and its runs then say the knowledge base does not resolve, where
        // clearing it here would say nothing to anyone.
        const rulingsKb =
          kind === "kb" && to !== null && (fm.rulingsKb ?? null) === from
            ? to
            : (fm.rulingsKb ?? null);
        if (rulingsKb !== (fm.rulingsKb ?? null)) changed = true;
        if (!changed) return parsed;
        return { ...parsed, frontmatter: { ...fm, agents, rulingsKb } };
      });
      if (changed) updated += 1;
    } catch (error) {
      logger.warn("could not rewrite resource reference in a project", {
        kind,
        from,
        projectSlug: slug,
        err: toError(error),
      });
    }
  }
  return updated;
}

/**
 * A2 (pass 23): the read-only twin of `rewriteProjects`' walk — how many PROJECT
 * DEPLOYMENTS currently grant `slug` of `kind`. The org resource delete-confirm
 * counted only ORG TEMPLATE grants, so a KB/MCP/skill used ONLY by a project
 * agent read as "nothing uses this" right before the delete silently dropped
 * that project grant. This lets the dialog disclose it. Never throws — a
 * malformed project.md is skipped, exactly as the rewrite skips it.
 */
export function countProjectDeploymentGrants(
  kind: ResourceKind,
  slug: string,
  dataRoot?: string,
): number {
  const root = projectsDir(dataRoot);
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const projectSlug of readdirSync(root).sort()) {
    if (!existsSync(path.join(root, projectSlug, "project.md"))) continue;
    try {
      const read = readProjectFile({ projectSlug, dataRoot });
      if (!read) continue;
      for (const deployment of read.parsed.frontmatter.agents) {
        if (deployment.definition?.resources?.[kind]?.includes(slug)) count += 1;
      }
    } catch {
      // A project.md we cannot parse cannot be counted — skip it, as the
      // rewrite does; the delete still proceeds and best-effort-drops its grant.
    }
  }
  return count;
}

/**
 * The read-only twin of {@link rewriteTemplates}' walk: how many ORG TEMPLATES
 * currently grant `slug` of `kind`.
 *
 * It walks the profile FILES rather than `listGlobalAgentProfiles` because that
 * lister is the specialist CRUD list and drops `controller.md` / `operator.md`,
 * while the delete's rewrite strips the grant out of EVERY profile file. The
 * delete-confirm counting from the lister therefore said "Nothing grants it"
 * about the three resources the shipped store attaches to those two templates,
 * immediately before the delete took them away.
 *
 * Never throws: a malformed profile is skipped, exactly as the rewrite skips it.
 */
export function countTemplateGrants(
  kind: ResourceKind,
  slug: string,
  dataRoot?: string,
): number {
  const dir = agentProfilesDir(dataRoot);
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    try {
      const { parsed } = parseAgentProfileContent(
        readFileSync(agentProfileFilePath(entry.slice(0, -3), dataRoot), "utf8"),
      );
      if (parsed?.frontmatter.resources[kind]?.includes(slug)) count += 1;
    } catch {
      // Unreadable profile: not countable, and the rewrite skips it too.
    }
  }
  return count;
}

/** The grant list of a deployment each kind is held in. */
const GRANT_LIST = {
  kb: "kb",
  skill: "skills",
  mcp: "mcps",
} as const satisfies Record<OrgResourceKind, ResourceKind>;

/** One board whose runs are given a resource. A type literal, not an
 *  interface: it is written into an audit row's `details`. */
export type ResourceBoard = {
  project: string;
  /** A knowledge base the board names as its rulings (ruling 239): every run
   *  on the board reads it, whoever holds it. */
  rulings: boolean;
  /** The deployed agents that hold it, by name, the operator among them. */
  agents: string[];
};

/** The resource a write changed and the boards given it, as the write's audit
 *  row keeps them. `kind` is the row's `subject_kind` without `org_`, and
 *  `template` for an agent profile template. */
export type AuditedResource = {
  kind: OrgResourceKind | "template";
  /** The grant key: a knowledge base's store directory, a skill's folder
   *  name, an MCP server's name. A template's profile id. */
  key: string;
  boards: ResourceBoard[];
};

/**
 * Ruling 681: the boards whose runs are given one org resource right now, for
 * the audit row of a write to it.
 *
 * A knowledge base, a skill and an MCP server are kept for the instance, and a
 * write to one is audited with no project: live on 2026-10-07 the controller
 * edited the AWS calculator board's rulings and three of its agents' skills,
 * and the board's Activity showed none of it. A board is given a resource
 * when its `project.md` names it as `rulingsKb` or a deployed agent holds it
 * (`deploymentResources`: the deployment's own copy, or its template's when
 * it wrote none). The row keeps the answer as it stood at the write, so a
 * board's history does not change when a grant does, and a delete is asked
 * BEFORE it drops the grants.
 *
 * `heldAs` is the key the grants still carry when a rename is audited before
 * its references are rewritten. Never throws: a projects folder that cannot be
 * listed names no board and a project.md that cannot be read is skipped,
 * exactly as the rewrite skips it, because a write is never refused for its
 * audit row.
 */
export function auditedResource(
  kind: OrgResourceKind,
  key: string,
  dataRoot?: string,
  heldAs: string = key,
): AuditedResource {
  const boards = boardsWhere(dataRoot, (fm, holders) => ({
    rulings: kind === "kb" && (fm.rulingsKb ?? "").trim() === heldAs,
    agents: holders((_deployment, identity) =>
      deploymentResources(identity)[GRANT_LIST[kind]].includes(heldAs),
    ),
  }));
  return { kind, key, boards: heldAs ? boards : [] };
}

/**
 * Ruling 681: the boards an edit of one agent profile template reaches now.
 * `changed` is what the edit changed, as a deployment's copy names each field.
 * A deployment of the profile is reached when it wrote no copy at all, or when
 * its copy leaves one of those fields to the template. A copy that holds them,
 * as a library deploy holds the fields a save snapshots, keeps its own until a
 * person takes the template's again, and that is the board's own row
 * (`project.agent_profile.resources_synced`). An edit that changed nothing
 * reaches no board.
 */
export function auditedTemplate(
  profileId: string,
  changed: readonly (keyof AgentDeploymentDefinition)[],
  dataRoot?: string,
): AuditedResource {
  const boards = boardsWhere(dataRoot, (_fm, holders) => ({
    rulings: false,
    agents: holders(
      (deployment, { def, template }) =>
        deployment.profileId === profileId &&
        template !== null &&
        changed.some((field) => def === null || def[field] === undefined),
    ),
  }));
  return { kind: "template", key: profileId, boards };
}

/** The names of a board's deployed agents a predicate holds for. */
type Holders = (
  holds: (deployment: AgentDeployment, identity: DeploymentRuntimeIdentity) => boolean,
) => string[];

/**
 * Every board, asked what it is given; one that is given nothing is left out.
 * Never throws: a projects folder that cannot be listed names no board, and a
 * board that cannot be read is skipped.
 */
function boardsWhere(
  dataRoot: string | undefined,
  given: (fm: ProjectFrontmatter, holders: Holders) => Omit<ResourceBoard, "project">,
): ResourceBoard[] {
  const boards: ResourceBoard[] = [];
  const root = projectsDir(dataRoot);
  let projects: string[] = [];
  try {
    if (existsSync(root)) projects = readdirSync(root).sort();
  } catch {
    projects = [];
  }
  for (const project of projects) {
    if (!existsSync(path.join(root, project, "project.md"))) continue;
    try {
      const read = readProjectFile({ projectSlug: project, dataRoot });
      if (!read) continue;
      const fm = read.parsed.frontmatter;
      const board = given(fm, (holds) =>
        fm.agents.flatMap((deployment) => {
          const identity = deploymentRuntimeIdentity(deployment, dataRoot);
          return holds(deployment, identity) ? [deploymentName(deployment, identity)] : [];
        }),
      );
      if (board.rulings || board.agents.length > 0) boards.push({ project, ...board });
    } catch {
      // Unreadable project: it cannot be asked what it holds.
    }
  }
  return boards;
}
