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
import {
  listKnowledgeBases,
  listMcpServers,
  listSkills,
} from "./resources.server";
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
  /** The role line (frontmatter `role`) a deployed copy renders under its name.
   *  D32-7 (pass 32): this editor had no role field, so every template saved
   *  here carried its NAME as its role and read as the generic "Agent profile"
   *  on every card, while seeded templates showed a real role. */
  role: string;
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
    role: fm.role,
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

/**
 * One resource as a grant sees it: the key that is stored, plus the other
 * handles a caller might name it by.
 */
interface GrantEntry {
  /** What the runtime keys off — the only form worth storing. */
  key: string;
  /** Catalog ids / display names normalised to `key` rather than stored. */
  aliases: string[];
}

/** Grant lists by resource kind; an absent list is one the caller didn't send. */
export interface ResourceGrants {
  skills?: string[];
  mcps?: string[];
  kbs?: string[];
}

function resolveOne(
  list: string[] | undefined,
  kind: string,
  catalog: () => GrantEntry[],
  unresolved: string[],
): string[] | undefined {
  if (!list) return undefined;
  const entries = catalog();
  const keys = new Set(entries.map((e) => e.key));
  const byAlias = new Map<string, string>();
  for (const entry of entries) {
    for (const alias of entry.aliases) byAlias.set(alias, entry.key);
  }
  const out: string[] = [];
  for (const raw of list) {
    const given = raw.trim();
    if (!given) continue;
    const key = keys.has(given) ? given : byAlias.get(given);
    if (key === undefined) {
      unresolved.push(`${kind} "${given}"`);
      continue;
    }
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Normalise grant lists to the STORE KEYS the runtime resolves by, refusing
 * anything the store does not answer to.
 *
 * A grant is keyed by the skill FOLDER NAME, the MCP REGISTRY NAME
 * (`byName.get(name)` in specialist-mcp.server drops an unmatched one as "no
 * MCP server by that name in the org registry") and the KB store DIRECTORY —
 * never by the catalog id.
 *
 * F33-8: the controller granted resources by the ids its own `list_*` tools
 * hand back (`disk:developer-expertise`, `mcp_IIWTf6kB6cdd`, `kb_ilN51XiiPkJA`)
 * and this module stored them verbatim, so EVERY grant the controller ever made
 * was dangling: the template editor drew three red missing chips, the roster row
 * counted "3 context resources", and a run mounted none of them. A recognised id
 * is normalised here; a key nothing answers to is refused by name rather than
 * written as a silent dud.
 *
 * The org-settings modal deliberately does NOT come through here: it already
 * picks keys from the live catalog, and it PRESERVES grants it cannot resolve
 * (`kbLegacyOf`) so an admin can see and drop them — a refusal would turn a
 * template with one stale grant into an unsaveable form.
 */
export function resolveResourceGrants(
  db: DatabaseSync,
  grants: ResourceGrants,
  ctx: GagentContext = {},
): ResourceGrants {
  const unresolved: string[] = [];
  // Each catalog is read only when its list was actually sent — `listSkills`
  // reads every SKILL.md body from disk (F31-3).
  const skills = resolveOne(
    grants.skills,
    "skill",
    () => listSkills(db, ctx).map((s) => ({ key: s.name, aliases: [s.id] })),
    unresolved,
  );
  const mcps = resolveOne(
    grants.mcps,
    "MCP server",
    () => listMcpServers(db).map((m) => ({ key: m.name, aliases: [m.id] })),
    unresolved,
  );
  const kbs = resolveOne(
    grants.kbs,
    "knowledge base",
    () =>
      // A KB's display name is an alias too: the modal's `kbDirsOf` already
      // repairs a name-keyed grant on open (P13-KM-01), so accepting one here
      // and writing the dir keeps the two paths saying the same thing.
      listKnowledgeBases(db, ctx).map((kb) => ({
        key: kb.dir,
        aliases: [kb.id, kb.name],
      })),
    unresolved,
  );
  if (unresolved.length > 0) {
    throw AppError.validation(
      `Nothing in the store answers to ${unresolved.join(", ")}. ` +
        "Grant a skill by its folder name, an MCP server by its registry name " +
        "and a knowledge base by its store directory — the grantKey each " +
        "resource list returns, never the id.",
    );
  }
  const resolved: ResourceGrants = {};
  if (skills) resolved.skills = skills;
  if (mcps) resolved.mcps = mcps;
  if (kbs) resolved.kbs = kbs;
  return resolved;
}

export interface SaveGagentInput {
  id?: string | null;
  name: string;
  backend: "codex" | "claude";
  /** Short operator-facing blurb → frontmatter `desc`. */
  summary: string;
  /** Role line → frontmatter `role` (D32-7). Blank keeps the stored role on an
   *  edit and falls back to the name on create — the pre-pass-32 behaviour,
   *  kept for scripted callers; the modal always sends one. */
  role?: string;
  /** Persona / system-prompt material → the markdown body. */
  persona: string;
  stages: string[];
  /**
   * Resource grants, each by its STORE KEY (`resolveResourceGrants`): the
   * skill folder name, the MCP registry name, the KB store directory.
   *
   * F33-7: all three are MERGE fields — omitted leaves the stored list alone,
   * `[]` clears it. They used to be required, and every save rewrote all three,
   * so a caller with no grants to change (the controller's `save_global_agent`,
   * whose lists are optional) silently emptied them.
   */
  skills?: string[];
  mcps?: string[];
  kbs?: string[];
}

type ProfileResources = AgentProfileFrontmatter["resources"];

/**
 * The stored grants after one save: only the lists the caller sent change.
 *
 * F33-7: the merge used to be `{...existing.resources, ...resources}` over an
 * object that ALWAYS carried all three keys, so an omitted list overwrote the
 * stored one with `[]` rather than leaving it. The spread of `existing` stays —
 * `resources` is a loose object and the keys this editor doesn't own must
 * survive the round trip.
 */
function mergedResources(
  existing: ProfileResources,
  input: SaveGagentInput,
): ProfileResources {
  const next: ProfileResources = { ...existing };
  if (input.skills) next.skills = input.skills;
  if (input.mcps) next.mcps = input.mcps;
  if (input.kbs) next.kb = input.kbs;
  return next;
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
        role: input.role?.trim() || existing.frontmatter.role || name,
        desc: input.summary.trim(),
        backends: [backend],
        stages: input.stages,
        resources: mergedResources(existing.frontmatter.resources, input),
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
      role: input.role?.trim() || name,
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
      // Nothing stored yet, so "omitted" and "empty" are the same list here.
      resources: {
        skills: input.skills ?? [],
        mcps: input.mcps ?? [],
        kb: input.kbs ?? [],
      },
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
