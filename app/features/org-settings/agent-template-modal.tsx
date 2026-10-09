import { useState } from "react";
import type { GagentView } from "~/server/org/gagents.server";
import type { ProjectCustomStages } from "~/server/org/org-view.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { countLabel } from "~/shared/text/plural";
import { BackendField, EligibleStagesField, LoadableContextField } from "./agent-template-fields";
import { useContextGrants, useProfileFields, useStageEligibility } from "./agent-template-draft";
import { MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";

/**
 * The global agent-TEMPLATE editor for the Agent-resources tab. Split out of
 * `resources-panel.tsx` (pass 16, pure structural refactor — no behaviour or
 * copy change); it is the largest and least-shared of the four editors, so it
 * gets its own file. Ruling 13(b) split it again along the task-page recipe:
 * its draft lives in `agent-template-draft.ts` (hooks), what it reads off its
 * props in `agent-template-derive.ts`, and the fields that carry logic (the
 * backend pick, the eligible stages, the loadable context with its missing
 * chips) in `agent-template-fields.tsx`.
 */

export function AgentModal({
  initial,
  stages,
  projectStages,
  kbs,
  mcps,
  skills,
  onClose,
}: {
  initial: GagentView | null;
  stages: StageDef[];
  /** Ruling 326: each live project's stages outside the default workflow. */
  projectStages: ProjectCustomStages[];
  kbs: KbView[];
  mcps: McpView[];
  skills: SkillView[];
  onClose: () => void;
}) {
  const {
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
  } = useProfileFields(initial);
  const eligibility = useStageEligibility(initial, stages, projectStages);
  const grants = useContextGrants(initial, kbs, mcps, skills);
  const { selStages } = eligibility;
  const { selSkills, selMcps, selKbs, legacySkills, legacyMcps, legacyKbs } = grants;
  // Ruling 177 (pass 35, F35-7): a project's deployment is its own COPY of the
  // grants, taken at deploy time, so an edit here never reached an adopted
  // project and the old foot hint pointed at "re-adopt", a door the deploy
  // refuses ("already deployed in this project"). Unchecked by default: a
  // copy is its own record, and the org admin decides per save.
  const [propagate, setPropagate] = useState(false);
  // Ruling 287: a save plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);
  const { action, err, setErr } = useModalAction(() => setDone(true));

  const canSave =
    name.trim().length > 1 && role.trim().length > 0 && selStages.length > 0;

  return (
    <MiniModal
      icon={<AgentGlyph backend={backend} />}
      title={initial ? "Edit agent profile" : "New agent profile"}
      sub="Global base definition. Projects grant eligibility & capabilities"
      onClose={onClose}
      canSave={canSave}
      busy={action.busy}
      done={done}
      saveLabel={initial ? "Save changes" : "Create profile"}
      footHint={
        initial && initial.used > 0
          ? "adopted by " +
            countLabel(initial.used, "project") +
            ". Each project keeps its own copy of the grants and its own capability policy; the box above updates the grants with this save"
          : "a template: add it to a project from Agents → Add from library"
      }
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        const fields = {
          intent: "agent-save",
          name: name.trim(),
          backend,
          summary: summary.trim(),
          role: role.trim(),
          persona: persona.trim(),
          stages: JSON.stringify(selStages),
          skills: JSON.stringify([...selSkills, ...legacySkills]),
          mcps: JSON.stringify([...selMcps, ...legacyMcps]),
          kbs: JSON.stringify([...selKbs, ...legacyKbs]),
          // Ruling 177: "1" copies these grants onto every adopted project's
          // copy that differs; the default leaves each copy its own record.
          propagate: propagate ? "1" : "0",
        };
        // No `profileId` at all means "create"; an empty one would mean "edit
        // the profile with the empty id", so the field stays absent.
        action.submit(
          initial ? { ...fields, profileId: initial.id } : fields,
        );
      }}
    >
      <div className="field">
        <label className="flabel" htmlFor="ga-name">
          Profile name<span className="req">*</span>
        </label>
        <input
          id="ga-name"
          type="text"
          value={name}
          placeholder="e.g. Security reviewer"
          onChange={(e) => {
            setName(e.target.value);
            setErr(null);
          }}
          data-autofocus=""
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="ga-role">
          Role<span className="req">*</span>{" "}
          <span className="fhint">the line under the name on every card</span>
        </label>
        <input
          id="ga-role"
          type="text"
          value={role}
          placeholder="e.g. Schema changes"
          onChange={(e) => setRole(e.target.value)}
        />
        {/* Review F10 (pass 32): a pre-pass-32 template stored its NAME as its
            role, which prefills empty here and greys out Save — say why, so a
            routine edit is not a mystery. */}
        {storedRoleRepeatsName && role.trim().length === 0 && (
          <span className="fhint">
            This template&apos;s stored role repeated its name; give it a real
            role to save.
          </span>
        )}
      </div>
      <BackendField backend={backend} onPick={setBackend} />
      <div className="field">
        <label className="flabel" htmlFor="ga-sum">
          Role summary{" "}
          <span className="fhint">the OPERATOR reads this when choosing an agent</span>
        </label>
        <input
          id="ga-sum"
          type="text"
          value={summary}
          placeholder="One line the operator sees when assigning work"
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="def-note">
        <Icon name="shield" />
        <span>
          A template starts with <strong>delivery withheld</strong>. It can read,
          validate and comment, but not write to the repository. Capability policy is a
          per-project decision: open the profile in a project&rsquo;s Agents page to grant
          branch, commit or pull-request rights there.
        </span>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="ga-persona">
          Persona / instructions{" "}
          <span className="fhint">
            its system prompt on every run · markdown ok
          </span>
        </label>
        <textarea
          id="ga-persona"
          rows={6}
          value={persona}
          placeholder="How this agent works: its responsibilities, standards, reporting format…"
          onChange={(e) => setPersona(e.target.value)}
        />
      </div>
      <EligibleStagesField stages={stages} eligibility={eligibility} />
      <LoadableContextField skills={skills} mcps={mcps} kbs={kbs} grants={grants} />
      {initial && initial.used > 0 && (
        <div className="field">
          <label className="flabel" htmlFor="ga-propagate">
            <input
              id="ga-propagate"
              type="checkbox"
              checked={propagate}
              onChange={(e) => setPropagate(e.target.checked)}
            />{" "}
            Copy these grants to the {initial.used} project
            {initial.used === 1 ? "" : "s"} that adopted this profile
          </label>
          <span className="fhint">
            Replaces each copy&apos;s skills, MCP servers and knowledge bases with
            the lists above; a grant a project added on its own is dropped and the
            reply says so. When this save changes the persona, each copy&apos;s
            persona is replaced with it too. Capability policy, model and stages
            stay the project&apos;s.
          </span>
        </div>
      )}
      {err && (
        <div className="form-err">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}
