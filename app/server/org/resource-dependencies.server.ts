import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AgentDeployment } from "~/schemas/project-file.schema";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import {
  agentProfilesDir,
  projectsDir,
} from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";

/** Canonical resource-reference namespaces used by agent definitions. */
export type AgentResourceKind = "skill" | "mcp" | "kb";

/** One explicit reason an org resource cannot be renamed/deleted. */
export interface AgentResourceUsage {
  kind: AgentResourceKind;
  /** The exact token stored in the profile/deployment. */
  ref: string;
  source: "global-template" | "template-deployment" | "project-inline";
  profileId: string;
  profileName: string;
  projectSlug?: string;
  projectName?: string;
  /** Compact, user-facing identity used in blocked-action messages. */
  label: string;
}

export interface ResourceDependencyContext {
  dataRoot?: string;
}

interface ResourceRefs {
  skills: string[];
  mcps: string[];
  kb: string[];
}

interface TemplateInfo {
  id: string;
  name: string;
  resources: ResourceRefs;
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is string => typeof item === "string"),
        ),
      ]
    : [];
}

function resourceRefs(value: unknown): ResourceRefs | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return {
    skills: uniqueStrings(raw.skills),
    mcps: uniqueStrings(raw.mcps),
    kb: uniqueStrings(raw.kb),
  };
}

function loadTemplates(
  ctx: ResourceDependencyContext,
): Map<string, TemplateInfo> {
  const templates = new Map<string, TemplateInfo>();
  const dir = agentProfilesDir(ctx.dataRoot);
  if (!existsSync(dir)) return templates;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    try {
      const { parsed } = parseAgentProfileContent(
        readFileSync(path.join(dir, entry), "utf8"),
        { fallbackId: id },
      );
      if (!parsed) continue;
      templates.set(id, {
        id,
        name: parsed.frontmatter.name,
        resources: parsed.frontmatter.resources,
      });
    } catch {
      // A malformed/unreadable template is already diagnosed by the file
      // projection. It cannot provide a trustworthy dependency edge here.
    }
  }
  return templates;
}

function addRefs(
  out: AgentResourceUsage[],
  resources: ResourceRefs,
  base: Omit<AgentResourceUsage, "kind" | "ref">,
): void {
  for (const ref of resources.skills) out.push({ ...base, kind: "skill", ref });
  for (const ref of resources.mcps) out.push({ ...base, kind: "mcp", ref });
  for (const ref of resources.kb) out.push({ ...base, kind: "kb", ref });
}

interface ProjectAgents {
  slug: string;
  name: string;
  agents: AgentDeployment[];
}

export interface ProjectAgentReference {
  projectSlug: string;
  projectName: string;
  profileId: string;
}

/**
 * Canonical project files first, projected DB rows only as a fallback. This
 * makes dependency guards safe even if a file changed just before reproject.
 */
function loadProjects(
  db: Database.Database,
  ctx: ResourceDependencyContext,
): ProjectAgents[] {
  const projects: ProjectAgents[] = [];
  const seen = new Set<string>();
  const root = projectsDir(ctx.dataRoot);
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const file = readProjectFile({
          projectSlug: entry.name,
          ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
        });
        if (!file) continue;
        const fm = file.parsed.frontmatter;
        projects.push({ slug: fm.slug, name: fm.name, agents: fm.agents });
        seen.add(fm.slug);
      } catch {
        // Fall through to a projected row for this slug when one exists.
      }
    }
  }

  const rows = db
    .prepare(`SELECT slug, name, agent_policy_json FROM projects`)
    .all() as { slug: string; name: string; agent_policy_json: string }[];
  for (const row of rows) {
    if (seen.has(row.slug)) continue;
    try {
      const agents = JSON.parse(row.agent_policy_json) as unknown;
      if (!Array.isArray(agents)) continue;
      projects.push({
        slug: row.slug,
        name: row.name,
        agents: agents as AgentDeployment[],
      });
    } catch {
      // A malformed projection contributes no trusted dependency edges.
    }
  }
  return projects;
}

/** Project → profile-id edges, also used to guard global-template deletion. */
export function listProjectAgentReferences(
  db: Database.Database,
  ctx: ResourceDependencyContext = {},
): ProjectAgentReference[] {
  const out: ProjectAgentReference[] = [];
  const seen = new Set<string>();
  for (const project of loadProjects(db, ctx)) {
    for (const deployment of project.agents) {
      if (!deployment || typeof deployment.profileId !== "string") continue;
      const key = `${project.slug}\0${deployment.profileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        projectSlug: project.slug,
        projectName: project.name,
        profileId: deployment.profileId,
      });
    }
  }
  return out;
}

/**
 * Complete dependency graph for skills, MCP servers, and KBs:
 *
 * - every org template (including an undeployed template, because it must not
 *   be silently broken),
 * - every project deployment inheriting a global template, and
 * - every project-inline/overridden deployment carrying its own resources.
 */
export function listAgentResourceUsages(
  db: Database.Database,
  ctx: ResourceDependencyContext = {},
): AgentResourceUsage[] {
  const templates = loadTemplates(ctx);
  const out: AgentResourceUsage[] = [];

  for (const template of templates.values()) {
    addRefs(out, template.resources, {
      source: "global-template",
      profileId: template.id,
      profileName: template.name,
      label: `Global profile · ${template.name}`,
    });
  }

  for (const project of loadProjects(db, ctx)) {
    for (const deployment of project.agents) {
      if (!deployment || typeof deployment.profileId !== "string") continue;
      const template = templates.get(deployment.profileId);
      const rawDefinition = (deployment as Record<string, unknown>).definition;
      const definition =
        rawDefinition &&
        typeof rawDefinition === "object" &&
        !Array.isArray(rawDefinition)
          ? (rawDefinition as Record<string, unknown>)
          : null;
      const ownResources = definition
        ? resourceRefs(definition.resources)
        : null;
      const resources = ownResources ?? template?.resources;
      if (!resources) continue;
      const profileName =
        (definition &&
          typeof definition.name === "string" &&
          definition.name) ||
        template?.name ||
        deployment.profileId;
      addRefs(out, resources, {
        source: ownResources ? "project-inline" : "template-deployment",
        profileId: deployment.profileId,
        profileName,
        projectSlug: project.slug,
        projectName: project.name,
        label: `${project.name} (${project.slug}) · ${profileName}`,
      });
    }
  }

  return out;
}

/** Match a resource by every stable/legacy alias its row currently has. */
export function findAgentResourceUsages(
  usages: readonly AgentResourceUsage[],
  kind: AgentResourceKind,
  aliases: readonly string[],
): AgentResourceUsage[] {
  const wanted = new Set(aliases.filter(Boolean));
  const seen = new Set<string>();
  return usages.filter((usage) => {
    if (usage.kind !== kind || !wanted.has(usage.ref)) return false;
    const key = [
      usage.source,
      usage.projectSlug ?? "",
      usage.profileId,
      usage.ref,
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resourceUsageLabels(
  usages: readonly AgentResourceUsage[],
): string[] {
  return [...new Set(usages.map((usage) => usage.label))];
}
