import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
  projectsDir,
} from "~/server/files/file-store-root.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import {
  parseAgentProfileContent,
  serializeAgentProfile,
} from "~/server/files/agent-profile-file.server";
import { logger } from "~/server/logging/logger.server";

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
        err: error instanceof Error ? error : new Error(String(error)),
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
        if (!changed) return parsed;
        return { ...parsed, frontmatter: { ...fm, agents } };
      });
      if (changed) updated += 1;
    } catch (error) {
      logger.warn("could not rewrite resource reference in a project", {
        kind,
        from,
        projectSlug: slug,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return updated;
}
