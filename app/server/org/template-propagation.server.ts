import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { readTemplate } from "~/server/agents/deployment-view.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import {
  readProjectFile,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { deploymentFingerprint } from "~/features/agents/agent-profile-actions.server";
import type {
  ResourceDrift,
  ResourceLists,
} from "~/features/agents/agent-types";

/**
 * Template grant propagation (ruling 156, pass 35 F35-7).
 *
 * A library deploy copies the template's `resources` onto the project's
 * deployment (`definition.resources`, `agent-profile-actions.server.ts`), and
 * a run mounts THAT copy: `effectiveProfileView` reads the deployment's lists
 * first and the template's only when the deployment carries no definition.
 * So a grant added to the template after the deploy never reached a project,
 * `unresolvedResources: []` was honest about the snapshot and silent about the
 * template, and `save_global_agent` answered `[done]` with no word that one
 * deployment held a diverged copy (live: `context7` granted to the template,
 * `run_inputs.mcp.mounted: ["viberr_agent"]` on the next run).
 *
 * This module is the ONE writer of a copy's grants from its template:
 *  · `resourceDrift` says how a copy differs (pure, order-insensitive);
 *  · `listTemplateResourceDrift` names every non-archived project whose copy
 *    differs, for the template writer's reply and the org modal;
 *  · `propagateTemplateResources` REPLACES a copy's three lists with the
 *    template's (owner, Q35-7: a project-local extra is dropped and the reply
 *    says so) and nothing else: never the capability policy, model, backend,
 *    stages or persona. The form writer `updateAgentProfile` is deliberately
 *    NOT used, because its contract rewrites every identity field and
 *    collapses `backends` to the form's one.
 *
 * It sits beside the resource-rename rewriter (`resource-references.server.ts`),
 * which already walks every `project.md` and edits `definition.resources` in
 * place, and it keeps `gagents.server.ts` and the profile actions from
 * importing each other.
 */

const KINDS = ["skills", "mcps", "kb"] as const;
type ResourceKind = (typeof KINDS)[number];

/** The rendered noun for one grant, as the replies and the card spell it. */
export function describeGrant(kind: ResourceKind, name: string): string {
  const noun =
    kind === "skills" ? "skill" : kind === "mcps" ? "MCP server" : "knowledge base";
  return `${noun} ${name}`;
}

/** A deployment's stored lists may omit a kind (the schema keeps each list
 *  optional); an absent list is an empty one for the comparison. */
export type PartialResourceLists = Partial<ResourceLists>;

function listOf(lists: PartialResourceLists, kind: ResourceKind): string[] {
  return lists[kind] ?? [];
}

function difference(a: readonly string[], b: readonly string[]): string[] {
  const have = new Set(b);
  const out: string[] = [];
  for (const x of a) if (!have.has(x) && !out.includes(x)) out.push(x);
  return out;
}

/**
 * How `copy` differs from `template`: `missing` is on the template and not
 * on the copy, `extra` is on the copy and not on the template. Null when every
 * list holds the same keys, whatever their order.
 */
export function resourceDrift(
  copy: PartialResourceLists,
  template: PartialResourceLists,
): ResourceDrift | null {
  const missing: ResourceLists = { skills: [], mcps: [], kb: [] };
  const extra: ResourceLists = { skills: [], mcps: [], kb: [] };
  let differs = false;
  for (const kind of KINDS) {
    missing[kind] = difference(listOf(template, kind), listOf(copy, kind));
    extra[kind] = difference(listOf(copy, kind), listOf(template, kind));
    if (missing[kind].length > 0 || extra[kind].length > 0) differs = true;
  }
  return differs ? { missing, extra } : null;
}

/** Every grant named in a drift half, rendered (`MCP server context7`). */
export function describeDriftLists(lists: ResourceLists): string[] {
  const out: string[] = [];
  for (const kind of KINDS) {
    for (const name of lists[kind]) out.push(describeGrant(kind, name));
  }
  return out;
}

export interface TemplateCopyDrift {
  projectSlug: string;
  projectName: string;
  drift: ResourceDrift;
}

export interface PropagationContext {
  dataRoot?: string;
}

/** `projects.slug` and `projects.name` are TEXT NOT NULL (0001_baseline). */
const projectRowSchema = z.object({ slug: z.string(), name: z.string() });

/** Non-archived projects, the same filter `usedByProject` applies: a project
 *  nobody can edit any more is not a copy anyone can bring up to date. */
function liveProjectRows(db: DatabaseSync): { slug: string; name: string }[] {
  const rows = db
    .prepare(
      `SELECT slug, name FROM projects WHERE COALESCE(archived, 0) = 0 ORDER BY slug`,
    )
    .all();
  const out: { slug: string; name: string }[] = [];
  for (const raw of rows) {
    const row = projectRowSchema.safeParse(raw);
    if (row.success) out.push(row.data);
  }
  return out;
}

/**
 * The non-archived projects whose deployment of `profileId` carries a copy of
 * the grants (`definition.resources`) that no longer matches the template. A
 * deployment without a definition is not listed: it already resolves the
 * template live. A missing template lists nothing.
 */
export function listTemplateResourceDrift(
  db: DatabaseSync,
  profileId: string,
  ctx: PropagationContext = {},
): TemplateCopyDrift[] {
  const template = readTemplate(profileId, ctx.dataRoot);
  if (!template) return [];
  const out: TemplateCopyDrift[] = [];
  for (const row of liveProjectRows(db)) {
    const file = readProjectFile({ projectSlug: row.slug, dataRoot: ctx.dataRoot });
    if (!file) continue;
    const deployment = file.parsed.frontmatter.agents.find(
      (a) => a.profileId === profileId,
    );
    const copy = deployment?.definition?.resources;
    if (!copy) continue;
    const drift = resourceDrift(copy, template.resources);
    if (!drift) continue;
    out.push({
      projectSlug: row.slug,
      projectName: file.parsed.frontmatter.name,
      drift,
    });
  }
  return out;
}

export interface PropagatedCopy {
  projectSlug: string;
  projectName: string;
  /** The template's display name, for the sentences that name the profile. */
  name: string;
  /** Grants the copy now carries that it did not (rendered nouns). */
  added: string[];
  /** Grants the copy held beyond the template and lost (rendered nouns). */
  removed: string[];
}

export interface PropagateInput {
  profileId: string;
  projectSlugs: string[];
  /** B5's guard for the Agents page button: the deployment record the page
   *  rendered. A stale one is refused with the editor's own sentence and
   *  nothing is written. */
  expectFingerprint?: string;
}

/**
 * Rewrite each named project's copy of `profileId`'s grants to the template's
 * three lists. One audit row per project
 * (`project.agent_profile.resources_synced`). A deployment that carries no
 * definition is left alone (it resolves the template live) and reported with
 * nothing added or removed.
 */
export async function propagateTemplateResources(
  db: DatabaseSync,
  input: PropagateInput,
  actor: AuditActor,
  ctx: PropagationContext = {},
): Promise<PropagatedCopy[]> {
  const template = readTemplate(input.profileId, ctx.dataRoot);
  if (!template || template.kind !== "specialist") {
    throw AppError.notFound("No such agent profile.");
  }
  const out: PropagatedCopy[] = [];
  for (const slug of input.projectSlugs) {
    let projectName = slug;
    let added: string[] = [];
    let removed: string[] = [];
    let written = false;
    await updateProjectFile({ projectSlug: slug, dataRoot: ctx.dataRoot }, (parsed) => {
      projectName = parsed.frontmatter.name;
      const deployment = parsed.frontmatter.agents.find(
        (a) => a.profileId === input.profileId,
      );
      if (!deployment) {
        throw AppError.notFound(`No agent ${template.name} is deployed on ${slug}.`);
      }
      if (
        input.expectFingerprint !== undefined &&
        input.expectFingerprint !== deploymentFingerprint(deployment)
      ) {
        throw AppError.conflict(
          "This profile changed while the editor was open. Reopen it to see the current grants, then save again.",
        );
      }
      if (!deployment.definition) return;
      const before = deployment.definition.resources ?? {};
      const drift = resourceDrift(before, template.resources);
      added = drift ? describeDriftLists(drift.missing) : [];
      removed = drift ? describeDriftLists(drift.extra) : [];
      deployment.definition.resources = {
        skills: template.resources.skills.slice(),
        mcps: template.resources.mcps.slice(),
        kb: template.resources.kb.slice(),
      };
      written = true;
    });
    if (written) {
      rebuildPath(db, projectFilePath(slug, ctx.dataRoot), { dataRoot: ctx.dataRoot });
      recordAudit(db, {
        action: "project.agent_profile.resources_synced",
        actor,
        subjectKind: "agent_profile",
        subjectId: input.profileId,
        projectSlug: slug,
        details: {
          name: template.name,
          templateId: input.profileId,
          skills: template.resources.skills,
          mcps: template.resources.mcps,
          kb: template.resources.kb,
          added,
          removed,
          source: "org-template",
        },
      });
    }
    out.push({ projectSlug: slug, projectName, name: template.name, added, removed });
  }
  return out;
}
