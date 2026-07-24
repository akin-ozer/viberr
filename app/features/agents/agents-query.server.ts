import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  CapabilityMode,
} from "~/schemas/project-file.schema";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import {
  agentProfileFilePath,
  agentProfilesDir,
} from "~/server/files/file-store-root.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  isKnownModel,
  modelDisplayName,
  resolveRunModel,
} from "~/server/runtimes/model-catalog.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  capabilityById,
  coerceSpecialistCapabilityMode,
} from "~/shared/capabilities";
import type { AgentProfileView, LibraryProfileView } from "./agent-types";

/**
 * Roster assembly for the Agents/Policy surfaces (two-layer agent model,
 * contracts §3.4):
 *
 *   layer 1 — org template files  ${dataRoot}/agents/profiles/<id>.md
 *   layer 2 — project.md `agents:` deployments ({profileId, capabilities,
 *             extras} + an optional loose `definition` override object)
 *
 * The effective profile = template fields overridden per-field by the
 * deployment's `definition` (project-created profiles carry their FULL
 * definition there and have no template). Capability policy ALWAYS comes
 * from the deployment (id-based + extras — ruling 7); display labels are
 * rendered from the shared CAP_CATALOG.
 */

/** Loose `definition` override carried on a project.md deployment entry.
 * Single source of truth is the zod schema in project-file.schema; re-exported
 * here for the roster/CRUD callers that assemble it. */
export type { AgentDeploymentDefinition };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out;
}

/** Tolerant read of the loose `definition` field — junk fields ignored. */
export function parseDeploymentDefinition(
  raw: unknown,
): AgentDeploymentDefinition | null {
  if (!isRecord(raw)) return null;
  const def: AgentDeploymentDefinition = {};
  if (raw.kind === "operator" || raw.kind === "specialist") def.kind = raw.kind;
  if (typeof raw.name === "string" && raw.name) def.name = raw.name;
  if (typeof raw.role === "string" && raw.role) def.role = raw.role;
  if (typeof raw.icon === "string" && raw.icon) def.icon = raw.icon;
  const backends = stringArray(raw.backends)?.filter(
    (b): b is "codex" | "claude" => b === "codex" || b === "claude",
  );
  if (backends) def.backends = backends;
  if (typeof raw.model === "string") def.model = raw.model;
  if (typeof raw.effort === "string" && raw.effort) def.effort = raw.effort;
  if (typeof raw.scope === "string") def.scope = raw.scope;
  if (typeof raw.desc === "string") def.desc = raw.desc;
  if (typeof raw.persona === "string") def.persona = raw.persona;
  const stages = stringArray(raw.stages);
  if (stages) def.stages = stages;
  if (typeof raw.spanAll === "boolean") def.spanAll = raw.spanAll;
  if (raw.autonomy === "supervised" || raw.autonomy === "full") def.autonomy = raw.autonomy;
  if (isRecord(raw.resources)) {
    def.resources = {
      skills: stringArray(raw.resources.skills) ?? [],
      mcps: stringArray(raw.resources.mcps) ?? [],
      kb: stringArray(raw.resources.kb) ?? [],
    };
  }
  return def;
}

/** Id-based capability policy → the mock's display-label buckets.
 * Catalog labels first (stored order), then extras — order deviation from
 * the mock (extras were interleaved there) noted in the phase report. */
export function capabilitiesToActionLabels(
  capabilities: { capabilityId: string; mode: CapabilityMode }[],
  extras: { label: string; mode: CapabilityMode }[],
): { direct: string[]; recommend: string[]; forbidden: string[]; off: string[] } {
  const buckets = {
    direct: [] as string[],
    recommend: [] as string[],
    forbidden: [] as string[],
    off: [] as string[],
  };
  // `human` = RESERVED for a human (a structural always-human lock) → `forbidden`.
  // `off` = simply WITHHELD from this agent (not granted) → its own `off` bucket.
  // These are semantically different (NEW-3): conflating them made an explicitly
  // withheld capability render as "Reserved for humans" in the matrix / profile
  // detail / policy "N human" count. The runtime already distinguished them.
  const bucketOf = (mode: CapabilityMode) =>
    mode === "human"
      ? buckets.forbidden
      : mode === "off"
        ? buckets.off
        : buckets[mode];
  for (const grant of capabilities) {
    const def = capabilityById(grant.capabilityId);
    bucketOf(grant.mode).push(def ? def.label : grant.capabilityId);
  }
  for (const extra of extras) {
    bucketOf(extra.mode).push(extra.label);
  }
  return buckets;
}

interface TemplateProfile {
  kind: "operator" | "specialist";
  name: string;
  role: string;
  icon: string;
  backends: ("codex" | "claude")[];
  model: string;
  scope: string;
  stages: string[];
  spanAll: boolean;
  resources: { skills: string[]; mcps: string[]; kb: string[] };
  /** Short scannable frontmatter `desc` (empty on older templates). */
  desc: string;
  description: string;
}

function readTemplate(
  profileId: string,
  dataRoot?: string,
): TemplateProfile | null {
  const absPath = agentProfileFilePath(profileId, dataRoot);
  if (!existsSync(absPath)) return null;
  const { parsed } = parseAgentProfileContent(readFileSync(absPath, "utf8"), {
    fallbackId: profileId,
  });
  if (!parsed) return null;
  const fm = parsed.frontmatter;
  return {
    kind: fm.kind,
    name: fm.name,
    role: fm.role,
    icon: fm.icon,
    backends: fm.backends,
    model: fm.model,
    scope: fm.scope,
    stages: fm.stages,
    spanAll: fm.spanAll,
    resources: {
      skills: fm.resources.skills,
      mcps: fm.resources.mcps,
      kb: fm.resources.kb,
    },
    /** Short scannable frontmatter desc (may be empty on older templates). */
    desc: fm.desc,
    description: parsed.description,
  };
}

/** First paragraph of a persona body, clamped — a template with no `desc` is
 * still scannable in the picker instead of dumping ~2,500 chars of persona. */
function firstParagraph(body: string, max = 240): string {
  const para = body.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return para.length > max ? para.slice(0, max - 1).trimEnd() + "…" : para;
}

/**
 * The org-level specialist TEMPLATES this project has NOT deployed — what the
 * project Agents page offers under "Add from library".
 *
 * P13-AP-05 (owner ruling 1, 2026-07-24): before this, NOTHING ever copied an
 * org template into a project's `agents:` list. A profile created in org
 * settings could never be deployed, run, or selected — `used` stayed 0 forever
 * and the create toast pointed at a project-policy control that did not exist.
 * The org layer is a real template LIBRARY now: an admin explicitly picks a
 * template and it is copied into the project (deployAgentProfileFromLibrary).
 */
export function listLibraryProfiles(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): LibraryProfileView[] {
  const project = getProject(db, projectSlug);
  if (!project) return [];
  const deployed = new Set(project.agentPolicy.map((d) => d.profileId));
  const dir = agentProfilesDir(ctx.dataRoot);
  if (!existsSync(dir)) return [];
  const out: LibraryProfileView[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    if (deployed.has(id)) continue;
    const template = readTemplate(id, ctx.dataRoot);
    // The operator is a system profile — one per project, never library-added.
    if (!template || template.kind !== "specialist") continue;
    out.push({
      id,
      name: template.name,
      role: template.role,
      desc: template.desc || firstParagraph(template.description),
      backends: template.backends,
      stages: template.stages,
      spanAll: template.spanAll,
      resources: template.resources,
    });
  }
  return out;
}

/** Effective profile for ONE deployment entry (exported for actions/tests). */
export function effectiveProfileView(
  deployment: AgentDeployment,
  dataRoot?: string,
): AgentProfileView {
  const template = readTemplate(deployment.profileId, dataRoot);
  const def = parseDeploymentDefinition(
    (deployment as Record<string, unknown>).definition,
  );
  const kind = def?.kind ?? template?.kind ?? "specialist";
  // R7-5: on a specialist profile, a stored `recommend` grant is runtime-
  // identical to `direct` and the picker no longer offers it — coerce it to
  // `direct` ('Allowed') on read so the roster, matrix, policy counts and the
  // edit-modal seed all show the honest mode. Seed/legacy files keep `recommend`
  // on disk (no migration); this normalizes only the view. The operator keeps
  // its real `recommend` modes. Runtime tool policy reads `deployment.capabilities`
  // directly (not this view), so no runtime behavior changes.
  const isSpecialist = kind !== "operator";
  const effectiveGrants = isSpecialist
    ? deployment.capabilities.map((c) => ({
        capabilityId: c.capabilityId,
        mode: coerceSpecialistCapabilityMode(c.mode),
      }))
    : deployment.capabilities;
  const capabilities = effectiveGrants.map((c) => ({
    capabilityId: c.capabilityId,
    mode: c.mode,
  }));
  const extras = deployment.extras.map((e) => ({ label: e.label, mode: e.mode }));
  const backends = def?.backends ?? template?.backends ?? [];
  const model = def?.model ?? template?.model ?? "";
  // The model that would actually RUN: the primary (first) backend's, resolved
  // to a valid catalog id. `modelKnown` is false for a legacy display-label
  // placeholder — the UI then flags the substitution instead of showing a value
  // that would fail at the SDK.
  const primaryBackend: RealBackend =
    backends.find((b) => b === "codex" || b === "claude") === "codex"
      ? "codex"
      : "claude";
  const modelKnown = isKnownModel(primaryBackend, model);
  const modelLabel = modelDisplayName(
    primaryBackend,
    resolveRunModel(primaryBackend, model),
  );
  return {
    id: deployment.profileId,
    kind,
    name: def?.name ?? template?.name ?? deployment.profileId,
    role: def?.role ?? template?.role ?? "Specialist",
    icon: def?.icon ?? template?.icon ?? "agents",
    backends,
    model,
    modelLabel,
    modelKnown,
    effort: def?.effort ?? "",
    scope: def?.scope ?? template?.scope ?? "",
    // Short scannable copy (operator selection + cards): deployment override,
    // else the template's dedicated `desc` field, else the body (legacy
    // templates whose body IS the short description).
    desc: def?.desc ?? (template?.desc || template?.description) ?? "",
    // The profile's long persona/instructions (D6): deployment override
    // first (project-created/edited profiles), else the template BODY —
    // startAgentRun feeds it to the run when no agents/definitions/<id>.md
    // override ships.
    definition: def?.persona ?? template?.description ?? "",
    stages: def?.stages ?? template?.stages ?? [],
    spanAll: def?.spanAll ?? template?.spanAll ?? false,
    // Operator only: default autonomy (supervised unless the deployment sets it).
    autonomy: kind === "operator" ? (def?.autonomy ?? "supervised") : undefined,
    actions: capabilitiesToActionLabels(effectiveGrants, deployment.extras),
    capabilities,
    extras,
    resources: {
      skills: def?.resources?.skills ?? template?.resources.skills ?? [],
      mcps: def?.resources?.mcps ?? template?.resources.mcps ?? [],
      kb: def?.resources?.kb ?? template?.resources.kb ?? [],
    },
    source: template ? "template" : "project",
  };
}

/**
 * The project's approved-profile roster: one view per project.md deployment,
 * operator first (mock list order), remaining entries in file order.
 */
export function assembleAgentRoster(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): AgentProfileView[] {
  const project = getProject(db, projectSlug);
  if (!project) return [];
  const views = project.agentPolicy.map((dep) =>
    effectiveProfileView(dep, ctx.dataRoot),
  );
  const operators = views.filter((v) => v.kind === "operator");
  const specialists = views.filter((v) => v.kind !== "operator");
  return [...operators, ...specialists];
}
