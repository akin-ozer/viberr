import { z } from "zod";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
} from "~/schemas/project-file.schema";
import type { LiveAgentIdentity } from "~/shared/mapping/task.server";
import { readAgentProfileFile } from "~/server/files/agent-profile-file.server";
import { agentProfileFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * Server-layer resolution of a project.md agent DEPLOYMENT to its effective
 * runtime identity (template ⊕ override) and the backend a run would start on.
 *
 * Home rule (layering): the hottest read loaders — the board list, the task
 * page, the agents roster (all in `~/server/projections/*`) — need the live
 * `profileId → backend` overlay on every render, and the run path's specialist
 * resolution (`~/server/tasks/specialist-roster.server.ts`) needs
 * `primaryRunBackend`. Those are SERVER concerns, so they live in the server
 * layer and the `features/agents` display code imports them from here
 * (features → server, the allowed direction) — not the inversion where a
 * projection reached up into a feature module.
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
  /** Empty on the operator, which has no role (ruling 518). */
  role: string;
  icon: string;
  backends: ("codex" | "claude")[];
  model: string;
  /** Ruling 153 (pass 35): the template's default effort tier, undefined when
   *  the file names none (the backend default applies at deploy). */
  effort: string | undefined;
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
  const parsed = readAgentProfileFile(
    agentProfileFilePath(profileId, dataRoot),
    profileId,
  )?.parsed;
  if (!parsed) return null;
  const fm = parsed.frontmatter;
  // Ruling 99: the controller is instance machinery, never a deployable
  // template — a deployment row naming it resolves as if no template existed,
  // so the two-kind deployment world stays closed.
  if (fm.kind === "controller") return null;
  return {
    kind: fm.kind,
    name: fm.name,
    role: fm.role ?? "",
    icon: fm.icon,
    backends: fm.backends,
    model: fm.model,
    effort: fm.effort,
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
function parseDeploymentDefinition(
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

/** Ruling 518: the operator's one name, on every surface. */
const OPERATOR_NAME = "Operator";

/** Ruling 518: the line under the operator's name, whatever its template says.
 *  A store copy seeded before the ruling still reads "System role · one per
 *  active task", and `npm run seed` writes a copy boot never refreshes. */
export const OPERATOR_SCOPE = "Built in · runs on every task";

/**
 * Ruling 518: the operator is one agent, called Operator, with no role, so no
 * deployment may rename it, give it a role or reword the line that says what
 * it is. The override's copy of these fields is dropped when the deployment
 * resolves; a save no longer writes them, and boot removes the copies a save
 * made before the ruling (`ensureBaseAgentsDeployed`).
 */
export const OPERATOR_FIXED_FIELDS = [
  "name",
  "role",
  "scope",
] as const satisfies readonly (keyof AgentDeploymentDefinition)[];

/** Resolve ONE deployment's template + override and its effective kind/backends. */
export function deploymentRuntimeIdentity(
  deployment: AgentDeployment,
  dataRoot: string | undefined,
): DeploymentRuntimeIdentity {
  const template = readTemplate(deployment.profileId, dataRoot);
  const parsed = parseDeploymentDefinition(deployment.definition);
  const kind = parsed?.kind ?? template?.kind ?? "specialist";
  let def = parsed;
  if (def && kind === "operator") {
    def = { ...def };
    for (const field of OPERATOR_FIXED_FIELDS) delete def[field];
  }
  return {
    template,
    def,
    kind,
    backends: def?.backends ?? template?.backends ?? [],
  };
}

/** A deployment's grant lists: the copy it wrote, else its template's, which a
 *  deployment with no copy resolves live. The one writing of that rule: the
 *  roster shows these lists, a run mounts them, and an audit row of a write to
 *  one of them names the boards that hold it (ruling 681). */
export function deploymentResources(
  identity: Pick<DeploymentRuntimeIdentity, "def" | "template">,
): TemplateProfile["resources"] {
  const { def, template } = identity;
  return {
    skills: def?.resources?.skills ?? template?.resources.skills ?? [],
    mcps: def?.resources?.mcps ?? template?.resources.mcps ?? [],
    kb: def?.resources?.kb ?? template?.resources.kb ?? [],
  };
}

/** The name a deployment goes by: the operator's one name (ruling 518), else
 *  the override's, the template's, then the profile id. */
export function deploymentName(
  deployment: AgentDeployment,
  identity: Pick<DeploymentRuntimeIdentity, "def" | "template" | "kind">,
): string {
  if (identity.kind === "operator") return OPERATOR_NAME;
  return identity.def?.name ?? identity.template?.name ?? deployment.profileId;
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
  for (const [profileId, live] of deployedSpecialistIdentities(projectSlug, dataRoot)) {
    map.set(profileId, live.backend);
  }
  return map;
}

/**
 * The live map above, with the profile's current display NAME beside the
 * backend (owner, 2026-09-08: the board card named an engaged agent by its
 * backend and its ROLE — "Claude · Implementation" — when the roster and the
 * task page call it "Developer"). The name resolves as `effectiveProfileView`
 * writes it — override, then template, then the id — so the card, the roster
 * and the engagement rows print one name for one profile. The engagement rows
 * in task.md never stored a name (only the role; the ruling is to join by
 * profile id, never by role string), so this overlay is where the name comes
 * from. A profile no longer deployed contributes nothing, and the render keeps
 * its role as the only descriptor it has.
 *
 * Tolerant like the backend map: any read/parse failure yields an empty map.
 */
export function deployedSpecialistIdentities(
  projectSlug: string,
  dataRoot?: string,
): ReadonlyMap<string, LiveAgentIdentity> {
  const map = new Map<string, LiveAgentIdentity>();
  try {
    const file = readProjectFile(
      dataRoot === undefined ? { projectSlug } : { projectSlug, dataRoot },
    );
    if (!file?.parsed) return map;
    for (const deployment of file.parsed.frontmatter.agents) {
      const identity = deploymentRuntimeIdentity(deployment, dataRoot);
      if (identity.kind === "operator") continue;
      map.set(deployment.profileId, {
        backend: primaryRunBackend(identity.backends),
        name: deploymentName(deployment, identity),
      });
    }
  } catch {
    return map;
  }
  return map;
}
