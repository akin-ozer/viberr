import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
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
  summary: string;
  stages: string[];
  skills: string[];
  mcps: string[];
  kbs: string[];
  used: number;
}

function conflict(userMessage: string): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage,
    kind: "user",
  });
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

/** Distinct-project deployment counts per profileId (the `used` fact). */
export function usedByProject(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(`SELECT slug, agent_policy_json FROM projects`)
    .all() as { slug: string; agent_policy_json: string }[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    try {
      const deployments = JSON.parse(row.agent_policy_json) as unknown;
      if (!Array.isArray(deployments)) continue;
      const seen = new Set<string>();
      for (const d of deployments) {
        const profileId =
          typeof d === "object" && d !== null
            ? (d as { profileId?: unknown }).profileId
            : null;
        if (typeof profileId === "string" && !seen.has(profileId)) {
          seen.add(profileId);
          counts[profileId] = (counts[profileId] ?? 0) + 1;
        }
      }
    } catch {
      // tolerated — a malformed projection row counts nothing
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
    summary: parsed.description,
    stages: fm.stages,
    skills: fm.resources.skills,
    mcps: fm.resources.mcps,
    kbs: fm.resources.kb,
    used,
  };
}

/** Specialist templates only (the operator is a system profile). */
export function listGlobalAgentProfiles(
  db: Database.Database,
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

export interface SaveGagentInput {
  id?: string | null;
  name: string;
  backend: "codex" | "claude";
  summary: string;
  stages: string[];
  skills: string[];
  mcps: string[];
  kbs: string[];
}

export function saveGlobalAgentProfile(
  db: Database.Database,
  input: SaveGagentInput,
  actor: AuditActor,
  ctx: GagentContext = {},
): { profile: GagentView; toast: string } {
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
    const merged: ParsedTemplate = {
      frontmatter: {
        ...existing.frontmatter,
        name,
        role: existing.frontmatter.role || name,
        backends: [backend],
        stages: input.stages,
        resources: { ...existing.frontmatter.resources, ...resources },
      },
      description: input.summary.trim(),
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
    throw conflict(`A profile named ${name} already exists.`);
  }
  const created: ParsedTemplate = {
    frontmatter: {
      id,
      kind: "specialist",
      name,
      role: name,
      // Short scannable description for operator selection; the body carries
      // the same summary until a dedicated persona is written.
      desc: input.summary.trim(),
      icon: "cpu",
      backends: [backend],
      model: "",
      scope: "Global base",
      stages: input.stages,
      spanAll: false,
      capabilities: [],
      extras: [],
      resources,
    },
    description: input.summary.trim(),
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
    toast: `${name} created — grant it eligibility in a project's policy to deploy`,
  };
}

export type DeleteGagentResult =
  | { status: "deleted"; toast: string }
  | { status: "in_use"; used: number; message: string };

export function deleteGlobalAgentProfile(
  db: Database.Database,
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
