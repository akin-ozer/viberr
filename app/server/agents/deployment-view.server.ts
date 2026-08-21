import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
} from "~/schemas/project-file.schema";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import { agentProfileFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * Server-layer resolution of a project.md agent DEPLOYMENT to its effective
 * runtime identity (template ⊕ override) and the backend a run would start on.
 *
 * Home rule (layering): the hottest read loaders — the board list, the task
 * page, the agents roster (all in `~/server/projections/*`) — need the live
 * `profileId → backend` overlay on every render, and the run path
 * (`~/server/tasks/specialist-run.server.ts`) needs `primaryRunBackend`. Those
 * are SERVER concerns, so they live in the server layer and the `features/agents`
 * display code imports them from here (features → server, the allowed direction)
 * — not the inversion where a projection reached up into a feature module.
 *
 * Single source of truth: `deploymentRuntimeIdentity` is the ONE place the
 * `override ?? template ?? default` rule for `kind`/`backends` is written.
 * `effectiveProfileView` (the full display view) calls it for those two fields
 * and reuses the `template`/`def` it already resolved, and
 * `deployedSpecialistBackends` calls it too — so the map that DISPLAYS a
 * backend and the value a run RESOLVES can never drift.
 */

/** Templates layer 1: `${dataRoot}/agents/profiles/<id>.md` frontmatter, read
 * for the fields a deployment override may leave unset. */
export interface TemplateProfile {
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

/** Read one org template file into the fields the effective view overlays.
 * Absent/unparseable ⇒ null (the deployment override, or a default, stands). */
export function readTemplate(
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

/** One YAML list of names: non-string members drop out (never the whole list),
 * and a value that is not a list at all reads as ABSENT so the org template's
 * value still wins downstream. */
const looseNameList = z
  .array(z.string().nullable().catch(null))
  .transform((items) => items.filter((item) => item !== null))
  .optional()
  .catch(undefined);

/**
 * The tolerant decode of the loose `definition` override. Every field catches
 * independently: a hand-edited project.md with one junk value must lose only
 * that field, never the whole override (the profile's name and persona live
 * here too). `name`/`role`/`icon`/`effort` treat an empty string as ABSENT —
 * the readers fall back with `??`, so a stored `name: ""` would otherwise
 * beat the template and render a nameless profile. `resources` fills all three
 * lists, so a partial override cannot silently inherit the template's grants
 * for the lists it omitted.
 *
 * Field order matches `agentDeploymentDefinitionSchema` (project-file.schema),
 * the single source of truth for which fields exist at all.
 */
const deploymentDefinitionOverrideSchema = z.object({
  kind: z.enum(["operator", "specialist"]).optional().catch(undefined),
  name: z.string().min(1).optional().catch(undefined),
  role: z.string().min(1).optional().catch(undefined),
  icon: z.string().min(1).optional().catch(undefined),
  backends: z
    .array(z.string().nullable().catch(null))
    .transform((items) =>
      items.filter((item): item is RealBackend => item === "codex" || item === "claude"),
    )
    .optional()
    .catch(undefined),
  model: z.string().optional().catch(undefined),
  effort: z.string().min(1).optional().catch(undefined),
  scope: z.string().optional().catch(undefined),
  desc: z.string().optional().catch(undefined),
  persona: z.string().optional().catch(undefined),
  stages: looseNameList,
  spanAll: z.boolean().optional().catch(undefined),
  autonomy: z.enum(["supervised", "full"]).optional().catch(undefined),
  resources: z
    .object({ skills: looseNameList, mcps: looseNameList, kb: looseNameList })
    .transform((r) => ({
      skills: r.skills ?? [],
      mcps: r.mcps ?? [],
      kb: r.kb ?? [],
    }))
    .optional()
    .catch(undefined),
});

/** Tolerant read of the loose `definition` field — junk fields ignored.
 *
 * The roster reads deployments out of the `agent_policy_json` projection
 * column, which `mapProjectRow` re-hydrates with an unchecked
 * `JSON.parse(...) as AgentDeployment[]` — so this is the one place on the read
 * path that actually validates the override against a schema. */
export function parseDeploymentDefinition(
  raw: AgentDeploymentDefinition | undefined,
): AgentDeploymentDefinition | null {
  const parsed = deploymentDefinitionOverrideSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The backend a run uses when a profile declares more than one: the FIRST real
 * one, Claude if none is named. The roster, board glyphs and review queue must
 * DISPLAY the same backend the run starts on, so the rule lives once and
 * everyone delegates.
 */
export function primaryRunBackend(
  backends: readonly string[],
): "codex" | "claude" {
  return backends.find((b) => b === "codex" || b === "claude") === "codex"
    ? "codex"
    : "claude";
}

/** The template + override a deployment resolved to, plus the two runtime
 * fields (`kind`, `backends`) every surface agrees on. The single writing of
 * the `override ?? template ?? default` rule — see the module doc. */
export interface DeploymentRuntimeIdentity {
  template: TemplateProfile | null;
  def: AgentDeploymentDefinition | null;
  kind: "operator" | "specialist";
  backends: ("codex" | "claude")[];
}

/** Resolve ONE deployment's template + override and its effective kind/backends. */
export function deploymentRuntimeIdentity(
  deployment: AgentDeployment,
  dataRoot: string | undefined,
): DeploymentRuntimeIdentity {
  const template = readTemplate(deployment.profileId, dataRoot);
  const def = parseDeploymentDefinition(deployment.definition);
  return {
    template,
    def,
    kind: def?.kind ?? template?.kind ?? "specialist",
    backends: def?.backends ?? template?.backends ?? [],
  };
}

/**
 * Live `profileId → backend` for a project's DEPLOYED specialist profiles —
 * the backend a run started right now would use (owner report 2026-08-21).
 *
 * The task file's engagement rows snapshot the backend at engage time, and the
 * run start heals that snapshot only when the next run actually happens
 * (specialist-run.server.ts: "the run follows the live profile, not the
 * engage-time snapshot"). Between a profile edit and that next run, every
 * surface mapping the snapshot (task exec profile, board card glyphs, review
 * queue) said the OLD backend while Run would launch the new one. The query
 * layer overlays THIS map so display always matches what Run does; a profile
 * that is no longer deployed contributes nothing, which leaves the snapshot
 * standing — exactly the run path's own fallback.
 *
 * Tolerant by design: any read/parse failure yields an empty map (display
 * falls back to the snapshot, never 500s a board over a profile file).
 */
export function deployedSpecialistBackends(
  projectSlug: string,
  dataRoot?: string,
): ReadonlyMap<string, "codex" | "claude"> {
  const map = new Map<string, "codex" | "claude">();
  try {
    const file = readProjectFile(
      dataRoot === undefined ? { projectSlug } : { projectSlug, dataRoot },
    );
    if (!file?.parsed) return map;
    for (const deployment of file.parsed.frontmatter.agents) {
      const { kind, backends } = deploymentRuntimeIdentity(deployment, dataRoot);
      if (kind === "operator") continue;
      map.set(deployment.profileId, primaryRunBackend(backends));
    }
  } catch {
    return map;
  }
  return map;
}
