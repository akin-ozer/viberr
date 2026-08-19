import { useState } from "react";
import type { GagentView } from "~/server/org/gagents.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import type { StageDef } from "~/schemas/project-file.schema";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";

/**
 * The global agent-TEMPLATE editor for the Agent-resources tab, with its
 * resource-grant chip helpers. Split out of `resources-panel.tsx` (pass 16,
 * pure structural refactor — no behaviour or copy change); it is the largest
 * and least-shared of the four editors, so it gets its own file.
 */

const match = (list: string[], names: string[]) => {
  const set = new Set(names);
  return list.filter((x) => set.has(x));
};
const unmatched = (list: string[], names: string[]) => {
  const set = new Set(names);
  return list.filter((x) => !set.has(x));
};

/**
 * KB grants are stored by store DIR. Older profiles (and anything written by the
 * pre-P13-KM-01 editor) carry the DISPLAY NAME, which resolves to nothing at run
 * time. Rewrite what we can recognize, so opening and saving a profile repairs
 * it instead of preserving an unresolvable string forever.
 */
const kbDirsOf = (list: string[], kbs: KbView[]) => {
  const byDir = new Set(kbs.map((k) => k.dir));
  const nameToDir = new Map(kbs.map((k) => [k.name, k.dir]));
  const out: string[] = [];
  for (const entry of list) {
    const dir = byDir.has(entry) ? entry : nameToDir.get(entry);
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out;
};

/** Grants that match neither a dir nor a display name — preserved untouched. */
const kbLegacyOf = (list: string[], kbs: KbView[]) => {
  const known = new Set([...kbs.map((k) => k.dir), ...kbs.map((k) => k.name)]);
  return list.filter((x) => !known.has(x));
};
const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
  set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** Grants pointing at a resource this org no longer has, rendered removable —
 *  the same red `missing` chip the project profile modal uses (P14-KM-10).
 *
 *  F19-5: a missing chip only renders BECAUSE the id is still in the grant list,
 *  so it is by construction a granted toggle — `aria-pressed` is hardcoded true.
 *  Without it a screen reader announced a dangling grant identically to an
 *  ungranted resource, while its six sibling chip groups in this file all
 *  reported their state. */
function MissingChips({
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
          title="No longer in the store — click to remove this grant"
          onClick={() => onDrop(id)}
        >
          {id}
        </button>
      ))}
    </>
  );
}

export function AgentModal({
  initial,
  stages,
  kbs,
  mcps,
  skills,
  onClose,
}: {
  initial: GagentView | null;
  stages: StageDef[];
  kbs: KbView[];
  mcps: McpView[];
  skills: SkillView[];
  onClose: () => void;
}) {
  const skillNames = skills.map((s) => s.name);
  const mcpNames = mcps.map((m) => m.name);
  // P13-KM-01: a KB grant is stored — and resolved at run time — by its store
  // DIRECTORY (`readKbBody` reads `${DATA_ROOT}/kb/<dir>`). This picker used to
  // key on the display NAME, so granting "P13 facts" wrote `kb: ["P13 facts"]`
  // and every run silently got zero bytes while both UIs showed it attached.
  // `kbDirsOf` also repairs an existing display-name grant on open.

  const [name, setName] = useState(initial ? initial.name : "");
  const [backend, setBackend] = useState<"codex" | "claude">(
    initial ? initial.backend : "codex",
  );
  const [summary, setSummary] = useState(initial ? initial.summary : "");
  // P13-AP-01: the persona (the agent's system prompt) is edited on its own,
  // separately from the one-line blurb the operator reads. Editing the blurb no
  // longer flattens the persona.
  const [persona, setPersona] = useState(initial ? initial.persona : "");
  // P11-47: default a new profile's eligible stages to a real work stage that
  // exists, not a hardcoded "impl" that silently references nothing if the org
  // stage template renames/removes it. Prefer a stage literally named "impl",
  // else the middle non-terminal stage, else the first.
  const workStages = stages.filter((s) => s.id !== "done");
  const defaultStage =
    workStages.find((s) => s.id === "impl")?.id ??
    workStages[Math.floor(workStages.length / 2)]?.id ??
    workStages[0]?.id;
  const [selStages, setSelStages] = useState<string[]>(
    initial ? initial.stages : defaultStage ? [defaultStage] : [],
  );
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
  const drop = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.filter((x) => x !== id));
  const { action, err, setErr } = useModalAction(() => onClose());

  const stageOpts = stages.filter((s) => s.id !== "done");
  const canSave = !action.busy && name.trim().length > 1 && selStages.length > 0;
  const selStageSet = new Set(selStages);
  const selSkillSet = new Set(selSkills);
  const selMcpSet = new Set(selMcps);
  const selKbSet = new Set(selKbs);

  return (
    <MiniModal
      icon={<AgentGlyph backend={backend} />}
      title={initial ? "Edit agent profile" : "New agent profile"}
      sub="Global base definition — projects grant eligibility & capabilities"
      onClose={onClose}
      canSave={canSave}
      saveLabel={initial ? "Save changes" : "Create profile"}
      footHint={
        initial && initial.used > 0
          ? "adopted by " +
            initial.used +
            " project" +
            (initial.used === 1 ? "" : "s") +
            " — each keeps its own copy; re-adopt to pick up this edit"
          : "a template — add it to a project from Agents → Add from library"
      }
      onSave={() => {
        if (!canSave) return;
        setErr(null);
        const fields = {
          intent: "agent-save",
          name: name.trim(),
          backend,
          summary: summary.trim(),
          persona: persona.trim(),
          stages: JSON.stringify(selStages),
          skills: JSON.stringify([...selSkills, ...legacySkills]),
          mcps: JSON.stringify([...selMcps, ...legacyMcps]),
          kbs: JSON.stringify([...selKbs, ...legacyKbs]),
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
        <span className="flabel">Backend</span>
        <div className="be-pick">
          <button
            type="button"
            className={"be-opt" + (backend === "codex" ? " on" : "")}
            onClick={() => setBackend("codex")}
            aria-pressed={backend === "codex"}
          >
            <AgentGlyph backend="codex" />
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
            onClick={() => setBackend("claude")}
            aria-pressed={backend === "claude"}
          >
            <AgentGlyph backend="claude" />
            <span>
              <span className="bnm">Claude Code</span>
            </span>
            <span className="bcheck">
              <Icon name="check" />
            </span>
          </button>
        </div>
      </div>
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
          A template starts with <strong>delivery withheld</strong> — it can read,
          validate and comment, but not write to the repository. Capability policy is a
          per-project decision: open the profile in a project&rsquo;s Agents page to grant
          branch, commit or pull-request rights there.
        </span>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="ga-persona">
          Persona / instructions{" "}
          <span className="fhint">
            the agent's working instructions — its system prompt on every run; markdown ok
          </span>
        </label>
        <textarea
          id="ga-persona"
          className="ta"
          rows={6}
          value={persona}
          placeholder="How this agent works: its responsibilities, standards, reporting format…"
          onChange={(e) => setPersona(e.target.value)}
        />
      </div>
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
        <div className="pick-chips">
          {stageOpts.map((s) => (
            <button
              type="button"
              key={s.id}
              className={"pick-chip" + (selStageSet.has(s.id) ? " on" : "")}
              aria-pressed={selStageSet.has(s.id)}
              onClick={() => toggle(selStages, setSelStages, s.id)}
            >
              <span className="sdot" style={{ background: s.color }}></span>
              {s.name}
            </button>
          ))}
        </div>
      </div>
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
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}
