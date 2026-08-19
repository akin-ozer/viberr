import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  parseAgentProfileContent,
  serializeAgentProfile,
  type AgentProfileFrontmatter,
} from "~/server/files/agent-profile-file.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
} from "~/server/files/file-store-root.server";
import { conservativeGrantsFor } from "~/shared/capabilities";
import { slugify } from "~/shared/ids/slugify";

/**
 * Global agent profile TEMPLATES (org-settings spec §3.7/§4.4) — the org
 * layer of the two-layer model: the panel CRUDs the phase-3 template files
 * under ${DATA_ROOT}/agents/profiles/<id>.md that 9A's project roster
 * consumes. The system `operator` template is not listed and never
 * editable here (mock parity: gagents are the four specialists).
 *
 * `used` is a PROJECTION over projects.agent_policy_json (deployments by
 * profileId) — it gates deletion ("Detach {name} from its N projects
 * first") and drives the row/footer copy. Deleting here removes only the
 * TEMPLATE file; project deployments carry their own definitions (9A).
 *
 * Edits preserve every field the modal doesn't own (capability policy,
 * extras, icon, model, scope, loose unknowns) via read → merge → serialize.
 */

export interface GagentView {
  id: string;
  name: string;
  backend: "codex" | "claude";
  /**
   * The SHORT operator-facing blurb (frontmatter `desc`) — one paragraph the
   * operator reads when picking an agent. P13-AP-01/AP-02: this used to be the
   * markdown BODY, i.e. the agent's whole persona, so the org card printed a
   * 600-word system prompt as a row subtitle and a one-line edit flattened the
   * persona; meanwhile `desc` was never rewritten on edit, so what the operator
   * actually reads never changed.
   */
  summary: string;
  /** The markdown body — the agent's persona / system-prompt material. */
  persona: string;
  stages: string[];
  skills: string[];
  mcps: string[];
  kbs: string[];
  used: number;
}

export interface GagentContext {
  dataRoot?: string;
}

interface ParsedTemplate {
  frontmatter: AgentProfileFrontmatter;
  description: string;
}

function readTemplateFile(
  profileId: string,
  ctx: GagentContext,
): ParsedTemplate | null {
  const abs = agentProfileFilePath(profileId, ctx.dataRoot);
  if (!existsSync(abs)) return null;
  const { parsed } = parseAgentProfileContent(readFileSync(abs, "utf8"), {
    fallbackId: profileId,
  });
  return parsed;
}

/**
 * The deployment list stored in `projects.agent_policy_json`, decoded down to
 * the only field these projections read. A single malformed ENTRY must count
 * as nothing rather than sink the whole row, so entries decode independently
 * and junk drops out of the list.
 */
const deployedProfileIdsSchema = z
  .array(z.object({ profileId: z.string() }).nullable().catch(null))
  .catch([])
  .transform((entries) =>
    entries.flatMap((entry) => (entry === null ? [] : [entry.profileId])),
  );

/** Profile ids one projection row deploys; empty when the row is unreadable. */
function deployedProfileIds(agentPolicyJson: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(agentPolicyJson);
  } catch {
    return [];
  }
  return deployedProfileIdsSchema.parse(raw);
}

/** Deployment count per profileId — how many projects carry the template. */
export interface ProfileDeploymentCounts {
  [profileId: string]: number;
}

/**
 * Distinct-project deployment counts per profileId (the `used` fact).
 *
 * P13-AP-10: archived projects were counted, so a template could be
 * undeletable ("detach it from its N projects first") because of a project
 * nobody can edit any more. Archived projects are excluded.
 */
export function usedByProject(db: DatabaseSync): ProfileDeploymentCounts {
  // SAFETY: the SELECT names exactly these two columns, and `projects.slug` /
  // `projects.agent_policy_json` are both TEXT NOT NULL (0001_baseline), so
  // every returned row really does carry both as a string.
  const rows = db
    .prepare(
      `SELECT slug, agent_policy_json FROM projects
       WHERE COALESCE(archived, 0) = 0`,
    )
    .all() as { slug: string; agent_policy_json: string }[];
  const counts: ProfileDeploymentCounts = {};
  for (const row of rows) {
    // Distinct per project: a template deployed twice in one project is one use.
    for (const profileId of new Set(
      deployedProfileIds(row.agent_policy_json),
    )) {
      counts[profileId] = (counts[profileId] ?? 0) + 1;
    }
  }
  return counts;
}

function toView(
  id: string,
  parsed: ParsedTemplate,
  used: number,
): GagentView {
  const fm = parsed.frontmatter;
  return {
    id,
    name: fm.name,
    backend: fm.backends[0] === "claude" ? "claude" : "codex",
    // `desc` is the blurb; the body is the persona. Fall back to the body only
    // when a legacy template carries no `desc` at all.
    summary: fm.desc.trim() || parsed.description,
    persona: parsed.description,
    stages: fm.stages,
    skills: fm.resources.skills,
    mcps: fm.resources.mcps,
    kbs: fm.resources.kb,
    used,
  };
}

/** Specialist templates only (the operator is a system profile). */
export function listGlobalAgentProfiles(
  db: DatabaseSync,
  ctx: GagentContext = {},
): GagentView[] {
  const dir = agentProfilesDir(ctx.dataRoot);
  if (!existsSync(dir)) return [];
  const used = usedByProject(db);
  const out: GagentView[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    const parsed = readTemplateFile(id, ctx);
    if (!parsed || parsed.frontmatter.kind !== "specialist") continue;
    out.push(toView(id, parsed, used[id] ?? 0));
  }
  return out;
}

/** Projects whose deployment list already carries `profileId`. */
function projectsUsingProfileId(db: DatabaseSync, profileId: string): string[] {
  // SAFETY: as in `usedByProject` — the SELECT names exactly these two columns
  // and both are TEXT NOT NULL in `projects` (0001_baseline).
  const rows = db
    .prepare(`SELECT slug, agent_policy_json FROM projects`)
    .all() as { slug: string; agent_policy_json: string }[];
  const out: string[] = [];
  for (const row of rows) {
    // A malformed projection row decodes to no ids, so it blocks nothing.
    if (deployedProfileIds(row.agent_policy_json).includes(profileId)) {
      out.push(row.slug);
    }
  }
  return out;
}

export interface SaveGagentInput {
  id?: string | null;
  name: string;
  backend: "codex" | "claude";
  /** Short operator-facing blurb → frontmatter `desc`. */
  summary: string;
  /** Persona / system-prompt material → the markdown body. */
  persona: string;
  stages: string[];
  skills: string[];
  mcps: string[];
  kbs: string[];
}

export interface SaveGagentResult {
  profile: GagentView;
  toast: string;
}

export function saveGlobalAgentProfile(
  db: DatabaseSync,
  input: SaveGagentInput,
  actor: AuditActor,
  ctx: GagentContext = {},
): SaveGagentResult {
  const name = input.name.trim();
  if (name.length < 2) throw AppError.validation("Give the profile a name.");
  if (input.stages.length === 0) {
    throw AppError.validation("Pick at least one eligible stage.");
  }
  const backend: "codex" | "claude" =
    input.backend === "claude" ? "claude" : "codex";
  const resources = {
    skills: input.skills,
    mcps: input.mcps,
    kb: input.kbs,
  };

  if (input.id) {
    const existing = readTemplateFile(input.id, ctx);
    if (!existing || existing.frontmatter.kind !== "specialist") {
      throw AppError.notFound("No such agent profile.");
    }
    // P13-AP-01/AP-02: `desc` (what the operator reads) is now rewritten on
    // edit, and the BODY carries the persona — an edited summary no longer
    // flattens a profile's system prompt, and a blank persona keeps the one
    // that is already there.
    const persona = input.persona.trim();
    const merged: ParsedTemplate = {
      frontmatter: {
        ...existing.frontmatter,
        name,
        role: existing.frontmatter.role || name,
        desc: input.summary.trim(),
        backends: [backend],
        stages: input.stages,
        resources: { ...existing.frontmatter.resources, ...resources },
      },
      description: persona || existing.description,
    };
    writeFileAtomic(
      agentProfileFilePath(input.id, ctx.dataRoot),
      serializeAgentProfile(merged),
    );
    recordAudit(db, {
      action: "org.agent_profile.updated",
      actor,
      subjectKind: "agent_profile",
      subjectId: input.id,
      details: { name, backend },
    });
    const used = usedByProject(db)[input.id] ?? 0;
    return {
      profile: toView(input.id, merged, used),
      toast: `${name} updated — running threads re-anchor on next turn`,
    };
  }

  const id = slugify(name);
  if (id.length < 2) throw AppError.validation("Give the profile a name.");
  if (existsSync(agentProfileFilePath(id, ctx.dataRoot))) {
    throw AppError.conflict(`A profile named ${name} already exists.`);
  }
  // P13-AP-12: a project-local profile already owns this id, so a template
  // under the same id would be ambiguous the moment a project adopts it.
  const localClash = projectsUsingProfileId(db, id);
  if (localClash.length > 0) {
    throw AppError.conflict(
      `${localClash[0]} already has a project profile with the id ${id} — pick another name.`,
    );
  }
  const created: ParsedTemplate = {
    frontmatter: {
      id,
      kind: "specialist",
      name,
      role: name,
      // Short scannable description for operator selection.
      desc: input.summary.trim(),
      icon: "cpu",
      backends: [backend],
      model: "",
      scope: "Global base",
      stages: input.stages,
      spanAll: false,
      // P13-AP-06: an empty grant list means "unspecified", which the tool
      // policy treats as FULL access — a casually created template would carry
      // silent repo-write power into every project that adopts it. Persist
      // explicit grants, and because THIS editor has no capability UI, start
      // delivery withheld rather than granting repo-write to a template nobody
      // could set permissions on (live: an "Org Docs Writer" described as
      // "never touches app code" was created holding all four delivery caps).
      capabilities: conservativeGrantsFor("agent"),
      extras: [],
      resources,
    },
    description: input.persona.trim() || input.summary.trim(),
  };
  writeFileAtomic(
    agentProfileFilePath(id, ctx.dataRoot),
    serializeAgentProfile(created),
  );
  recordAudit(db, {
    action: "org.agent_profile.created",
    actor,
    subjectKind: "agent_profile",
    subjectId: id,
    details: { name, backend },
  });
  return {
    profile: toView(id, created, 0),
    toast: `${name} created — add it to a project from Agents → Add from library`,
  };
}

export type DeleteGagentResult =
  | { status: "deleted"; toast: string }
  | { status: "in_use"; used: number; message: string };

export function deleteGlobalAgentProfile(
  db: DatabaseSync,
  id: string,
  actor: AuditActor,
  ctx: GagentContext = {},
): DeleteGagentResult {
  const existing = readTemplateFile(id, ctx);
  if (!existing) throw AppError.notFound("No such agent profile.");
  if (existing.frontmatter.kind !== "specialist") {
    throw AppError.validation(
      "The operator is a system profile and can't be deleted.",
    );
  }
  const used = usedByProject(db)[id] ?? 0;
  if (used > 0) {
    return {
      status: "in_use",
      used,
      message: `Detach ${existing.frontmatter.name} from its ${used} project${used === 1 ? "" : "s"} first`,
    };
  }
  rmSync(agentProfileFilePath(id, ctx.dataRoot), { force: true });
  recordAudit(db, {
    action: "org.agent_profile.deleted",
    actor,
    subjectKind: "agent_profile",
    subjectId: id,
    details: { name: existing.frontmatter.name },
  });
  return { status: "deleted", toast: `${existing.frontmatter.name} deleted` };
}
