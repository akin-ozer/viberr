import { useId, type ReactNode } from "react";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { Pagination } from "~/ui/pagination";
import { drop, stagePage, toggle } from "./agent-template-derive";
import type { ContextGrants, StageEligibility } from "./agent-template-draft";

/**
 * The global agent-template editor's fields that carry its logic (ruling
 * 13(b), the split of `agent-template-modal.tsx`): the backend pick, the
 * default eligible stages with the Custom stages list, and the loadable
 * context with its missing chips. Each takes the slot its markup held in the
 * editor and calls no hook of its own (StageRow keeps the one id it always
 * owned), so the markup, and every id React derives from its place in the
 * tree, are what they were. The editor owns the draft and hands it in.
 */

/** Ruling 326: one row of the Custom stages list, a project's own stages under
 *  its name and task key, or the stored ids no board has. The row is a named
 *  group, so a chip that reads "To do" is heard with the project it is on. */
function StageRow({
  label,
  tag,
  on,
  children,
}: {
  label: string;
  /** The project's task key; absent on the stored-ids row. */
  tag?: string;
  /** How many of the row's stages the profile names. */
  on: number;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="elig-proj" role="group" aria-labelledby={labelId}>
      <div className="elig-proj-head">
        <span className="elig-proj-name" id={labelId}>
          {label}
        </span>
        {tag && <span className="elig-proj-key">{tag}</span>}
        {on > 0 && <span className="elig-count">{on} selected</span>}
      </div>
      <div className="pick-chips">{children}</div>
    </div>
  );
}

/** Grants pointing at a resource this org no longer has, rendered removable —
 *  the same red `missing` chip the project profile modal uses (P14-KM-10).
 *  Exported for the controller settings panel (ruling 270), so the missing
 *  treatment — class, copy, a11y state — has ONE implementation here.
 *
 *  F19-5: a missing chip only renders BECAUSE the id is still in the grant list,
 *  so it is by construction a granted toggle — `aria-pressed` is hardcoded true.
 *  Without it a screen reader announced a dangling grant identically to an
 *  ungranted resource, while its six sibling chip groups in this file all
 *  reported their state. */
export function MissingChips({
  ids,
  mono,
  onDrop,
}: {
  ids: string[];
  mono?: boolean;
  onDrop: (id: string) => void;
}) {
  return (
    <>
      {ids.map((id) => (
        <button
          type="button"
          key={id}
          className={"pick-chip missing on" + (mono ? " mono" : "")}
          aria-pressed={true}
          title="No longer in the store. Click to remove this grant"
          onClick={() => onDrop(id)}
        >
          {/* Interface review 2026-09-24 (acce-33): the amber alone was the
              only cue; the icon and word are the profile page's res-chip ones. */}
          <Icon name="alert" />
          {id}
          <span className="res-chip-note">missing</span>
        </button>
      ))}
    </>
  );
}

/** The backend a run of this profile starts on. */
export function BackendField({
  backend,
  onPick,
}: {
  backend: "codex" | "claude";
  onPick: (backend: "codex" | "claude") => void;
}) {
  return (
    <div className="field">
      <span className="flabel">Backend</span>
      <div className="be-pick">
        <button
          type="button"
          className={"be-opt" + (backend === "codex" ? " on" : "")}
          onClick={() => onPick("codex")}
          aria-pressed={backend === "codex"}
        >
          <AgentGlyph backend="codex" decorative />
          <span>
            <span className="bnm">Codex</span>
          </span>
          <span className="bcheck">
            <Icon name="check" />
          </span>
        </button>
        <button
          type="button"
          className={"be-opt" + (backend === "claude" ? " on" : "")}
          onClick={() => onPick("claude")}
          aria-pressed={backend === "claude"}
        >
          <AgentGlyph backend="claude" decorative />
          <span>
            <span className="bnm">Claude</span>
          </span>
          <span className="bcheck">
            <Icon name="check" />
          </span>
        </button>
      </div>
    </div>
  );
}

/** Default eligible stages: the default workflow's chips, then the Custom
 *  stages list (ruling 326), paged three projects at a time. */
export function EligibleStagesField({
  stages,
  eligibility,
}: {
  stages: StageDef[];
  eligibility: StageEligibility;
}) {
  const {
    selStages,
    setSelStages,
    storedOnlyStages,
    projects,
    page,
    setPage,
    defaultLabelId,
    customLabelId,
  } = eligibility;
  const stageOpts = stages.filter((s) => s.id !== "done");
  const selStageSet = new Set(selStages);
  const offeredByDefault = new Set(stageOpts.map((s) => s.id));
  const customOn = selStages.filter((id) => !offeredByDefault.has(id)).length;
  const { pages, pageStart, pageProjects, pageEnd } = stagePage(projects, page);
  const stageChip = (s: StageDef, title?: string) => (
    <button
      type="button"
      key={s.id}
      className={"pick-chip" + (selStageSet.has(s.id) ? " on" : "")}
      aria-pressed={selStageSet.has(s.id)}
      title={title}
      onClick={() => toggle(selStages, setSelStages, s.id)}
    >
      <span className="sdot" data-stage-color={s.color}></span>
      {s.name}
    </button>
  );
  return (
    <div className="field">
      <span className="flabel">
        Default eligible stages<span className="req">*</span>{" "}
        {/* P13-D-9: "always" was an over-promise. No AGENT profile can ever
            transition a task to Done — that part holds for everything this
            org-level editor creates — but a project's operator can, under the
            auto preset with an explicit grant. This panel is org-scoped and
            cannot know a project's policy, so it states the guarantee it
            actually makes rather than one it cannot. */}
        <span className="fhint">Done is closed by a human, never by an agent</span>
      </span>
      {/* Ruling 326 (2026-10-01): the stages a project's own board
          adds were echoed only once a profile already stored one, as a
          pressed chip after the defaults that repeated "not in the default
          workflow". They are offered now, grouped by the project whose board
          has them and paged three projects at a time. */}
      <div className="elig-groups">
        <div className="elig-group" role="group" aria-labelledby={defaultLabelId}>
          <span className="ctx-lbl" id={defaultLabelId}>
            Default workflow
          </span>
          <div className="pick-chips">{stageOpts.map((s) => stageChip(s))}</div>
        </div>
        <div className="elig-group" role="group" aria-labelledby={customLabelId}>
          <div className="elig-head">
            <span className="ctx-lbl" id={customLabelId}>
              Custom stages
            </span>
            {customOn > 0 && <span className="elig-count">{customOn} selected</span>}
          </div>
          {projects.length === 0 && storedOnlyStages.length === 0 ? (
            <span className="ctx-none">No project&apos;s board adds a stage of its own.</span>
          ) : (
            <p className="elig-note">
              From each project&apos;s own board. A profile names stages by id, so a
              stage counts on every board that has it.
            </p>
          )}
          {storedOnlyStages.length > 0 && (
            <div className="elig-stray">
              <StageRow
                label="On no project's board"
                on={storedOnlyStages.filter((id) => selStageSet.has(id)).length}
              >
                {storedOnlyStages.map((id) => {
                  const known = stages.find((s) => s.id === id);
                  const on = selStageSet.has(id);
                  return (
                    <button
                      type="button"
                      key={id}
                      className={"pick-chip" + (known ? "" : " mono") + (on ? " on" : "")}
                      aria-pressed={on}
                      title={`This profile names the stage “${id}”, which neither the default workflow nor any project's own stages offer. A board with a stage of this id, or one in the same role, reads it. Press to ${on ? "remove" : "keep"} it.`}
                      onClick={() => toggle(selStages, setSelStages, id)}
                    >
                      <span className="sdot" data-stage-color={known?.color}></span>
                      {known ? known.name : id}
                    </button>
                  );
                })}
              </StageRow>
            </div>
          )}
          {pageProjects.length > 0 && (
            <div className="elig-projs">
              {pageProjects.map((p) => (
                <StageRow
                  key={p.slug}
                  label={p.name}
                  tag={p.prefix}
                  on={p.stages.filter((s) => selStageSet.has(s.id)).length}
                >
                  {p.stages.map((s) => stageChip(s, `“${s.id}” on ${p.name}'s board`))}
                </StageRow>
              ))}
            </div>
          )}
          {pages > 1 && (
            <div className="elig-foot">
              <span className="elig-range" aria-live="polite">
                {pageEnd - pageStart === 1
                  ? `Project ${pageEnd} of ${projects.length}`
                  : `Projects ${pageStart + 1} to ${pageEnd} of ${projects.length}`}
              </span>
              <Pagination page={page} pages={pages} label="Custom stage pages" onPage={setPage} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Loadable context: the skills, MCP servers and knowledge bases the profile
 *  may pull into a run, each group ending in its missing chips. */
export function LoadableContextField({
  skills,
  mcps,
  kbs,
  grants,
}: {
  skills: SkillView[];
  mcps: McpView[];
  kbs: KbView[];
  grants: ContextGrants;
}) {
  const {
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
  } = grants;
  const selSkillSet = new Set(selSkills);
  const selMcpSet = new Set(selMcps);
  const selKbSet = new Set(selKbs);
  return (
    <div className="field">
      <span className="flabel">
        Loadable context <span className="fhint">what this profile may pull into a run</span>
      </span>
      <div className="ctx-groups">
        <div className="ctx-group">
          <span className="ctx-lbl">Skills</span>
          <div className="pick-chips">
            {skills.map((s) => (
              <button
                type="button"
                key={s.id}
                className={"pick-chip mono" + (selSkillSet.has(s.name) ? " on" : "")}
                aria-pressed={selSkillSet.has(s.name)}
                onClick={() => toggle(selSkills, setSelSkills, s.name)}
              >
                {s.name}
              </button>
            ))}
            <MissingChips
              ids={legacySkills}
              mono
              onDrop={(id) => drop(legacySkills, setLegacySkills, id)}
            />
            {skills.length === 0 && legacySkills.length === 0 && (
              <span className="ctx-none">none defined</span>
            )}
          </div>
        </div>
        <div className="ctx-group">
          <span className="ctx-lbl">MCP servers</span>
          <div className="pick-chips">
            {mcps.map((m) => (
              <button
                type="button"
                key={m.id}
                className={"pick-chip mono" + (selMcpSet.has(m.name) ? " on" : "")}
                aria-pressed={selMcpSet.has(m.name)}
                onClick={() => toggle(selMcps, setSelMcps, m.name)}
              >
                {m.name}
              </button>
            ))}
            <MissingChips
              ids={legacyMcps}
              mono
              onDrop={(id) => drop(legacyMcps, setLegacyMcps, id)}
            />
            {mcps.length === 0 && legacyMcps.length === 0 && (
              <span className="ctx-none">none defined</span>
            )}
          </div>
        </div>
        <div className="ctx-group">
          <span className="ctx-lbl">Knowledge bases</span>
          <div className="pick-chips">
            {kbs.map((k) => (
              <button
                type="button"
                key={k.id}
                className={"pick-chip" + (selKbSet.has(k.dir) ? " on" : "")}
                aria-pressed={selKbSet.has(k.dir)}
                onClick={() => toggle(selKbs, setSelKbs, k.dir)}
                title={k.uri + "/"}
              >
                {k.name}
              </button>
            ))}
            <MissingChips
              ids={legacyKbs}
              onDrop={(id) => drop(legacyKbs, setLegacyKbs, id)}
            />
            {kbs.length === 0 && legacyKbs.length === 0 && (
              <span className="ctx-none">none defined</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
