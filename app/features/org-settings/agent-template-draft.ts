import { useId, useState } from "react";
import type { GagentView } from "~/server/org/gagents.server";
import type { ProjectCustomStages } from "~/server/org/org-view.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import {
  defaultStageOf,
  match,
  projectsNamedFirst,
  storedOnlyStagesOf,
  unmatched,
} from "./agent-template-derive";
import { kbDirsOf, kbLegacyOf } from "./kb-grants";

/**
 * The global agent-template editor's draft (ruling 696(e), the split of
 * `agent-template-modal.tsx`): the profile's own fields, its eligible stages
 * with the Custom stages list's order and page, and its context grants. The
 * editor calls the three in the order its state always registered, so the two
 * ids its stage groups are labelled by are unchanged. No component lives
 * here, so the module is not a Fast Refresh boundary.
 */

/** The profile's name, backend, summary, role and persona. */
export function useProfileFields(initial: GagentView | null) {
  const [name, setName] = useState(initial ? initial.name : "");
  const [backend, setBackend] = useState<"codex" | "claude">(
    initial ? initial.backend : "codex",
  );
  const [summary, setSummary] = useState(initial ? initial.summary : "");
  // D32-7 (pass 32): the role line, the way the project editor asks for it.
  // A stored role that merely repeats the name is the pre-pass-32 default, so
  // it prefills EMPTY to invite a real one (the card falls back to "Agent
  // profile" for such a role either way — agent-types.ts profileRoleLabel).
  const storedRoleRepeatsName =
    !!initial && initial.role.trim().toLowerCase() === initial.name.trim().toLowerCase();
  const [role, setRole] = useState(
    initial && !storedRoleRepeatsName ? initial.role : "",
  );
  // P13-AP-01: the persona (the agent's system prompt) is edited on its own,
  // separately from the one-line blurb the operator reads. Editing the blurb no
  // longer flattens the persona.
  const [persona, setPersona] = useState(initial ? initial.persona : "");
  return {
    name,
    setName,
    backend,
    setBackend,
    summary,
    setSummary,
    storedRoleRepeatsName,
    role,
    setRole,
    persona,
    setPersona,
  };
}

/** The eligible stages, the stored ones no board offers, and the Custom
 *  stages list (ruling 618) with its page and the ids its groups are labelled
 *  by. */
export function useStageEligibility(
  initial: GagentView | null,
  stages: StageDef[],
  projectStages: ProjectCustomStages[],
) {
  const workStages = stages.filter((s) => s.id !== "done");
  const defaultStage = defaultStageOf(workStages);
  const [selStages, setSelStages] = useState<string[]>(
    initial ? initial.stages : defaultStage ? [defaultStage] : [],
  );
  // Ruling 479(h): held from the open, so a chip pressed off stays on screen
  // to be pressed back on.
  const [storedOnlyStages] = useState<string[]>(() =>
    storedOnlyStagesOf(initial, workStages, projectStages),
  );
  // Ruling 618: ordered once, at the open, so a press never moves a row to
  // another page.
  const [projects] = useState<ProjectCustomStages[]>(() =>
    projectsNamedFirst(initial, projectStages),
  );
  const [page, setPage] = useState(1);
  const defaultLabelId = useId();
  const customLabelId = useId();
  return {
    selStages,
    setSelStages,
    storedOnlyStages,
    projects,
    page,
    setPage,
    defaultLabelId,
    customLabelId,
  };
}

export type StageEligibility = ReturnType<typeof useStageEligibility>;

/** The skills, MCP servers and knowledge bases the profile may load, and the
 *  grants that match no org resource. */
export function useContextGrants(
  initial: GagentView | null,
  kbs: KbView[],
  mcps: McpView[],
  skills: SkillView[],
) {
  const skillNames = skills.map((s) => s.name);
  const mcpNames = mcps.map((m) => m.name);
  // P13-KM-01: a KB grant is stored — and resolved at run time — by its store
  // DIRECTORY (`readKbIndexDetailed` reads `${DATA_ROOT}/kb/<dir>`). This
  // picker used to key on the display NAME, so granting "P13 facts" wrote
  // `kb: ["P13 facts"]` and every run silently got zero bytes while both UIs
  // showed it attached.
  // `kbDirsOf` also repairs an existing display-name grant on open.
  const [selSkills, setSelSkills] = useState<string[]>(
    initial ? match(initial.skills, skillNames) : [],
  );
  const [selMcps, setSelMcps] = useState<string[]>(
    initial ? match(initial.mcps, mcpNames) : [],
  );
  const [selKbs, setSelKbs] = useState<string[]>(
    initial ? kbDirsOf(initial.kbs, kbs) : [],
  );
  // P14-KM-10: grants that match no org resource used to be preserved on save
  // and rendered NOWHERE, so an orphan — the standing residue of a rename or a
  // disk-side delete — was invisible and unremovable from org settings while
  // the project modal showed the same thing as a removable red chip. They are
  // state now, so they render and can be dropped.
  const [legacySkills, setLegacySkills] = useState<string[]>(
    initial ? unmatched(initial.skills, skillNames) : [],
  );
  const [legacyMcps, setLegacyMcps] = useState<string[]>(
    initial ? unmatched(initial.mcps, mcpNames) : [],
  );
  const [legacyKbs, setLegacyKbs] = useState<string[]>(
    initial ? kbLegacyOf(initial.kbs, kbs) : [],
  );
  return {
    selSkills,
    setSelSkills,
    selMcps,
    setSelMcps,
    selKbs,
    setSelKbs,
    legacySkills,
    setLegacySkills,
    legacyMcps,
    setLegacyMcps,
    legacyKbs,
    setLegacyKbs,
  };
}

export type ContextGrants = ReturnType<typeof useContextGrants>;
