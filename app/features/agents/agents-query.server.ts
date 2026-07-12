import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  CapabilityMode,
} from "~/schemas/project-file.schema";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import { agentProfileFilePath } from "~/server/files/file-store-root.server";
import { getProject } from "~/server/projections/board-query.server";
import {
  isKnownModel,
  modelDisplayName,
  resolveRunModel,
} from "~/server/runtimes/model-catalog.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { capabilityById } from "~/shared/capabilities";
import type { AgentProfileView } from "./agent-types";

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
): {
  direct: string[];
  recommend: string[];
  forbidden: string[];
  off: string[];
} {
  const buckets = {
    direct: [] as string[],
    recommend: [] as string[],
    forbidden: [] as string[],
    off: [] as string[],
  };
  // Preserve all four stored modes. `human` is a structural human boundary;
  // `off` is an ordinary withheld grant and must not be relabelled as human.
  const bucketOf = (mode: CapabilityMode) =>
    mode === "human" ? buckets.forbidden : buckets[mode];
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
    description: parsed.description,
  };
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
  const capabilities = deployment.capabilities.map((c) => ({
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
    desc: def?.desc ?? template?.description ?? "",
    stages: def?.stages ?? template?.stages ?? [],
    spanAll: def?.spanAll ?? template?.spanAll ?? false,
    // Operator only: default autonomy (supervised unless the deployment sets it).
    autonomy: kind === "operator" ? (def?.autonomy ?? "supervised") : undefined,
    actions: capabilitiesToActionLabels(deployment.capabilities, deployment.extras),
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
  db: Database.Database,
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
