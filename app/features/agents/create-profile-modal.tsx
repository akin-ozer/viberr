import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { useDialog } from "~/ui/use-dialog";
import type { AgentProfileView } from "./agent-types";
import {
  CAP_MODAL_CATALOG,
  CAP_MODAL_DEFAULTS,
  OPERATOR_CAP_CATALOG,
  OPERATOR_CAP_DEFAULTS,
  OPERATOR_CAP_MODES,
  SPECIALIST_CAP_MODES,
  type CapMode,
  type ModalCapGroup,
  type ResCatalogGroup,
  type ResourceSelection,
} from "./capability-catalog";

/**
 * CreateProfileModal (agents.jsx §4.5) — create AND edit form (edit when
 * `initial` is set). Presentational: the page owns the fetcher; submit
 * hands back the form payload the action's zod schema expects. Server
 * failures render in the foot-hint (err) and the modal stays open.
 *
 * Edit-mode seeding is id-based (ruling 7): the profile's stored
 * `{capabilityId, mode}` grants seed the modal caps for catalog ids;
 * grants outside the modal catalog + display-only extras are preserved
 * server-side and never touched here.
 */

export interface ProfileFormPayload {
  name: string;
  role: string;
  backend: "codex" | "claude";
  stages: string[];
  definition: string;
  /** The long persona/instructions (system-prompt material, D6); "" = keep. */
  persona: string;
  /** Picked model id/alias + reasoning effort (from the model catalog). */
  model: string;
  effort: string;
  caps: Record<string, CapMode>;
  /** Operator only: default autonomy the run uses. */
  autonomy?: "supervised" | "full";
  resources: ResourceSelection;
}

const BACKENDS: { id: "codex" | "claude"; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
];

/** Client mirror of the /resources/model-catalog payload shape. */
interface CatalogModel {
  value: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  efforts?: string[];
}
interface ModelCatalog {
  models: CatalogModel[];
  efforts: string[];
  defaultModel: string;
  defaultEffort: string;
}

const EFFORT_LABEL: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

function effortLabel(id: string): string {
  return EFFORT_LABEL[id] ?? id;
}

/** Inline styling mirroring `.field input` (app.css) — the design system has
 * no `<select>` rule and this feature may not edit app.css, so the dropdowns
 * match the modal's other fields via matching tokens here. */
const selectStyle: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-button)",
  padding: ".55rem .7rem",
  background: "var(--surface)",
  color: "var(--fg)",
  fontFamily: "var(--font-body)",
  fontSize: ".9rem",
  outline: 0,
};

// Repo-write grants that mark a profile as a DELIVERING builder (mirrors
// listDeployedSpecialists' delivery heuristic) — used to seed the verdict
// toggle from its RUNTIME-effective mode below.
function seedCaps(
  initial: AgentProfileView | null,
  defaults: Readonly<Record<string, CapMode>>,
): Record<string, CapMode> {
  if (!initial) return { ...defaults };
  const caps: Record<string, CapMode> = {};
  for (const id of Object.keys(defaults)) caps[id] = "off";
  // F10-07: seed EVERY toggle from the STORED grant only — never synthesize an
  // implicit default. Verdict authority is explicit-only (F10-14), so an absent
  // `report-validation-verdict` grant stays OFF; the old code fabricated a
  // `direct` verdict for a non-delivering profile from the delivers-dependent
  // runtime default, and saving any unrelated field then PERSISTED that `direct`
  // — silently arming verdict veto. A legacy `recommend` (runtime-treats-as-off)
  // also seeds OFF so a lossless round-trip can only preserve or narrow
  // authority, never widen it.
  for (const grant of initial.capabilities) {
    if (grant.capabilityId in caps) {
      caps[grant.capabilityId] =
        grant.mode === "recommend" && grant.capabilityId === "report-validation-verdict"
          ? "off"
          : grant.mode;
    }
  }
  return caps;
}

/**
 * P13-AP-07 — say what saving actually DOES to a library-sourced profile.
 *
 * `updateAgentProfile` writes a COMPLETE definition snapshot onto the project's
 * deployment (name, role, backend, model, stages, desc, persona, resources),
 * and every one of those fields wins over the org template from then on. So the
 * first edit here permanently detaches this project's copy: a later org-level
 * rename, stage change, resource change or persona fix never reaches it. The
 * org modal meanwhile promises "used in N projects — changes apply on next
 * run". The snapshot model is deliberate (owner ruling: a project owns its
 * copy); the CLAIM was the lie, so the editor now states the fork up front.
 */
function ModalHead({
  editing,
  initialName,
  forksTemplate,
  projectName,
  onClose,
}: {
  editing: boolean;
  initialName: string | undefined;
  /** Editing a profile that still derives from an org template. */
  forksTemplate: boolean;
  projectName: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-head">
      <span className="agent-glyph lg">
        <Icon name="agents" />
      </span>
      <div className="mh-main">
        <h2>{editing ? "Edit " + initialName : "New specialist profile"}</h2>
        <div className="mh-sub">
          {!editing
            ? "A reusable agent the operator can assign to tasks."
            : forksTemplate
              ? `Saving forks this profile for ${projectName}: it keeps its own copy and stops tracking later changes to the global profile.`
              : "Update this project's copy — changes apply to future assignments."}
        </div>
      </div>
      <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="Close">
        <Icon name="x" />
      </button>
    </div>
  );
}

function IdentityFields({
  uid,
  name,
  setName,
  role,
  setRole,
}: {
  uid: string;
  name: string;
  setName: (v: string) => void;
  role: string;
  setRole: (v: string) => void;
}) {
  return (
    <div className="field-row">
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-name`}>
          Name<span className="req">*</span>
        </label>
        <input
          id={`${uid}-name`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Migrations"
          data-autofocus=""
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-role`}>
          Role<span className="req">*</span>
        </label>
        <input
          id={`${uid}-role`}
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. Schema changes"
        />
      </div>
    </div>
  );
}

function BackendField({
  backend,
  setBackend,
  available,
}: {
  backend: "codex" | "claude" | "";
  setBackend: (v: "codex" | "claude") => void;
  /** Per-backend credential availability (from the loader). An unconfigured
   *  backend is disabled so a profile can't be pinned to a runtime whose every
   *  run would fail — EXCEPT the one an edited profile already runs on, which
   *  stays selectable so re-saving doesn't force a backend change (RU-2). */
  available: Record<"codex" | "claude", boolean>;
}) {
  // Chip groups have no labelable control — a `<label>` here names nothing.
  // role="group" + aria-labelledby gives screen readers the same caption.
  const capId = useId();
  return (
    <div className="field" role="group" aria-labelledby={capId}>
      <span className="flabel" id={capId}>
        Execution backend<span className="req">*</span>
        <span className="fhint">pick exactly one</span>
      </span>
      <div className="pick-chips">
        {BACKENDS.map((b) => {
          const usable = available[b.id] || backend === b.id;
          return (
            <button
              type="button"
              key={b.id}
              className={"pick-chip" + (backend === b.id ? " on" : "")}
              onClick={() => setBackend(b.id)}
              disabled={!usable}
              title={
                usable
                  ? undefined
                  : `${b.label} isn't configured — add its credential to run agents on it`
              }
            >
              <AgentGlyph backend={b.id} />
              {b.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AutonomyField({
  autonomy,
  setAutonomy,
}: {
  autonomy: "supervised" | "full";
  setAutonomy: (v: "supervised" | "full") => void;
}) {
  const capId = useId();
  return (
    <div className="field" role="group" aria-labelledby={capId}>
      <span className="flabel" id={capId}>
        Default autonomy
        <span className="fhint">
          supervised recommends at approval boundaries · full performs
          them and may accept completion to Done
        </span>
      </span>
      <div className="pick-chips">
        {(
          [
            { id: "supervised", label: "Supervised" },
            { id: "full", label: "Full autonomy" },
          ] as const
        ).map((a) => (
          <button
            type="button"
            key={a.id}
            className={"pick-chip" + (autonomy === a.id ? " on" : "")}
            onClick={() => setAutonomy(a.id)}
          >
            <Icon name={a.id === "full" ? "bolt" : "shield"} />
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ModelEffortFields({
  uid,
  backend,
  model,
  setModel,
  effort,
  setEffort,
  catalog,
  catalogLoading,
  selectedModel,
  showEffort,
  effortOptions,
}: {
  uid: string;
  backend: "codex" | "claude" | "";
  model: string;
  setModel: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  catalog: ModelCatalog | null;
  catalogLoading: boolean;
  selectedModel: CatalogModel | null;
  showEffort: boolean;
  effortOptions: string[];
}) {
  return (
    <div className="field-row">
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-model`}>
          Model
          <span className="fhint">
            {catalogLoading
              ? "loading available models…"
              : "the model this profile runs on"}
          </span>
        </label>
        <select
          id={`${uid}-model`}
          aria-label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!backend || catalogLoading}
          style={selectStyle}
        >
          {!backend && <option value="">Pick a backend first</option>}
          {/* Preserve a seeded value that is not in the catalog. */}
          {backend &&
            model &&
            catalog &&
            !catalog.models.some((m) => m.value === model) && (
              <option value={model}>{model}</option>
            )}
          {(catalog?.models ?? []).map((m) => (
            <option key={m.value} value={m.value} title={m.description}>
              {m.displayName}
            </option>
          ))}
        </select>
        {selectedModel?.description && (
          <span className="fhint" style={{ marginLeft: 0 }}>
            {selectedModel.description}
          </span>
        )}
      </div>
      {showEffort && (
        <div className="field">
          <label className="flabel" htmlFor={`${uid}-effort`}>
            Effort
            <span className="fhint">reasoning level per turn</span>
          </label>
          <select
            id={`${uid}-effort`}
            aria-label="Effort"
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            disabled={!backend || catalogLoading}
            style={selectStyle}
          >
            {!backend && <option value="">—</option>}
            {effort && !effortOptions.includes(effort) && (
              <option value={effort}>{effortLabel(effort)}</option>
            )}
            {effortOptions.map((e) => (
              <option key={e} value={e}>
                {effortLabel(e)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function StagesField({
  stages,
  stg,
  toggleStage,
}: {
  stages: { id: string; name: string; color: string }[];
  stg: string[];
  toggleStage: (id: string) => void;
}) {
  const capId = useId();
  return (
    <div className="field" role="group" aria-labelledby={capId}>
      <span className="flabel" id={capId}>
        Eligible stages<span className="req">*</span>
        <span className="fhint">stages this profile may work in</span>
      </span>
      <div className="pick-chips">
        {stages.map((s) => (
          <button
            type="button"
            key={s.id}
            className={"pick-chip" + (stg.includes(s.id) ? " on" : "")}
            onClick={() => toggleStage(s.id)}
          >
            <span
              className="sdot"
              style={stg.includes(s.id) ? { background: s.color } : undefined}
            />
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function DefinitionField({
  uid,
  isOperator,
  definition,
  setDefinition,
  persona,
  setPersona,
}: {
  uid: string;
  isOperator: boolean;
  definition: string;
  setDefinition: (v: string) => void;
  persona: string;
  setPersona: (v: string) => void;
}) {
  return (
    <>
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-definition`}>
          Description
          <span className="fhint">
            {isOperator
              ? "one short paragraph — a human-readable summary of this operator"
              : "one short paragraph — the OPERATOR reads this to pick the right agent for a task"}
          </span>
        </label>
        <textarea
          id={`${uid}-definition`}
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          style={{ minHeight: "72px" }}
          placeholder="e.g. Owns database schema changes. Writes and verifies migrations against a shadow DB, and never touches application code without operator sign-off."
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-persona`}>
          Persona / instructions
          <span className="fhint">
            {isOperator
              ? "extra operator guidance — appended to the built-in operator manual on every run; markdown ok"
              : "the agent's working instructions — injected as its system prompt on every run; markdown ok"}
          </span>
        </label>
        <textarea
          id={`${uid}-persona`}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          style={{ minHeight: "120px" }}
          placeholder="How this agent works: its responsibilities, standards, review checklist, reporting format…"
        />
      </div>
    </>
  );
}

function CapabilityGrants({
  capCatalog,
  capModes,
  caps,
  setCaps,
  openGroups,
  setOpenGroups,
}: {
  capCatalog: readonly ModalCapGroup[];
  /** The mode buttons offered per row: 4 for the operator, 3 honest ones
   *  (Allowed/Human-only/Off) for a specialist (R7-5). */
  capModes: readonly { id: CapMode; label: string }[];
  caps: Record<string, CapMode>;
  setCaps: Dispatch<SetStateAction<Record<string, CapMode>>>;
  openGroups: Record<string, boolean>;
  setOpenGroups: Dispatch<SetStateAction<Record<string, boolean>>>;
}) {
  const capId = useId();
  return (
    <div className="field" role="group" aria-labelledby={capId}>
      <span className="flabel" id={capId}>
        Capability policy
        <span className="fhint">
          how each action is enforced — adjust the defaults
        </span>
      </span>
      <div className="cap-matrix">
        {capCatalog.map((g) => {
          const open = !!openGroups[g.group];
          const c = { direct: 0, recommend: 0, human: 0, off: 0 };
          g.caps.forEach((x) => {
            c[caps[x.id] ?? "off"] += 1;
          });
          return (
            <div className={"cap-mgroup" + (open ? " open" : "")} key={g.group}>
              <button
                type="button"
                className={"cap-mghead" + (open ? " open" : "")}
                onClick={() =>
                  setOpenGroups((p) => ({ ...p, [g.group]: !p[g.group] }))
                }
              >
                <Icon name="chevron" className="cap-chev" />
                <span className="cap-mglabel">{g.group}</span>
                <span className="cap-msum">
                  {c.direct > 0 && (
                    <span className="cs">
                      <span className="d" style={{ background: "var(--teal-dark)" }} />
                      {c.direct}
                    </span>
                  )}
                  {c.recommend > 0 && (
                    <span className="cs">
                      <span className="d" style={{ background: "var(--blue)" }} />
                      {c.recommend}
                    </span>
                  )}
                  {c.human > 0 && (
                    <span className="cs">
                      <span className="d" style={{ background: "var(--coral-dark)" }} />
                      {c.human}
                    </span>
                  )}
                  {c.off > 0 && (
                    <span className="cs">
                      <span className="d" style={{ background: "var(--placeholder)" }} />
                      {c.off}
                    </span>
                  )}
                </span>
              </button>
              {open && (
                <div className="cap-mbody">
                  {g.caps.map((capDef) => (
                    <div className="cap-mrow" key={capDef.id}>
                      <span className="cap-mname">{capDef.label}</span>
                      <div className="cap-seg">
                        {capModes.map((m) => (
                          <button
                            type="button"
                            key={m.id}
                            className={
                              m.id + (caps[capDef.id] === m.id ? " on" : "")
                            }
                            onClick={() =>
                              setCaps((p) => ({ ...p, [capDef.id]: m.id }))
                            }
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResourcePicker({
  resCatalog,
  res,
  toggleRes,
  openRes,
  setOpenRes,
}: {
  resCatalog: readonly ResCatalogGroup[];
  res: ResourceSelection;
  toggleRes: (key: keyof ResourceSelection, item: string) => void;
  openRes: Record<string, boolean>;
  setOpenRes: Dispatch<SetStateAction<Record<string, boolean>>>;
}) {
  const capId = useId();
  return (
    <div className="field" role="group" aria-labelledby={capId}>
      <span className="flabel" id={capId}>
        Context resources
        <span className="fhint">
          skills, MCP servers, knowledge bases this profile may load
        </span>
      </span>
      <div className="cap-matrix">
        {resCatalog.map((g) => {
          const open = !!openRes[g.group];
          const sel = res[g.key];
          const selSet = new Set(sel);
          const catalogIds = new Set(g.items.map((it) => it.id));
          // Dangling grants: ids this profile still references but the live
          // store no longer offers (a KB/skill/MCP deleted from org settings).
          // Surface them so the count is honest AND they stay removable — the
          // catalog is profile-agnostic, so without this a ghost grant reads as
          // "N of 0" and can never be unchecked (there's no chip to click).
          const displayItems: { id: string; missing?: boolean }[] = [
            ...g.items,
            ...sel
              .filter((id) => !catalogIds.has(id))
              .map((id) => ({ id, missing: true })),
          ];
          return (
            <div className={"cap-mgroup" + (open ? " open" : "")} key={g.group}>
              <button
                type="button"
                className={"cap-mghead" + (open ? " open" : "")}
                onClick={() =>
                  setOpenRes((p) => ({ ...p, [g.group]: !p[g.group] }))
                }
              >
                <Icon name="chevron" className="cap-chev" />
                <span className="cap-mglabel">{g.group}</span>
                <span className="cap-msum">
                  <span className="cs">
                    <span className="d" style={{ background: "var(--blue)" }} />
                    {sel.length} of {displayItems.length}
                  </span>
                </span>
              </button>
              {open && (
                <div className="cap-mbody">
                  <div className="pick-chips">
                    {displayItems.map((it) => (
                      <button
                        type="button"
                        key={it.id}
                        className={
                          "pick-chip" +
                          (g.mono ? " mono" : "") +
                          (selSet.has(it.id) ? " on" : "") +
                          (it.missing ? " missing" : "")
                        }
                        title={
                          it.missing
                            ? "No longer in the store — click to remove this grant"
                            : undefined
                        }
                        onClick={() => toggleRes(g.key, it.id)}
                      >
                        {selSet.has(it.id) && <Icon name="check" />}
                        {it.id}
                      </button>
                    ))}
                  </div>
                  {displayItems.length === 0 && (
                    <p className="ctx-empty">
                      None in the store yet — add {g.group.toLowerCase()} in org
                      settings.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ModalFooter({
  hint,
  valid,
  error,
  busy,
  editing,
  onClose,
  onSubmitClick,
}: {
  hint: string;
  valid: boolean;
  error: string | null;
  busy: boolean;
  editing: boolean;
  onClose: () => void;
  onSubmitClick: () => void;
}) {
  return (
    <div className="modal-foot">
      <span className={"foot-hint" + (valid && !error ? "" : " err")}>{hint}</span>
      <div className="foot-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={onSubmitClick}
          disabled={!valid || busy}
          style={!valid ? { opacity: 0.5, pointerEvents: "none" } : undefined}
        >
          <Icon name="check" />
          {editing ? "Save changes" : "Create profile"}
        </button>
      </div>
    </div>
  );
}

export function CreateProfileModal({
  initial,
  stages,
  projectName,
  busy,
  error,
  onClose,
  onSubmit,
  resourceCatalog,
  backendAvailable,
}: {
  /** Edit mode when set. */
  initial: AgentProfileView | null;
  stages: { id: string; name: string; color: string }[];
  projectName: string;
  busy: boolean;
  /** Server-side failure copy — renders in the foot hint, modal stays open. */
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: ProfileFormPayload) => void;
  /** Live store resources for the context-resource picker. Falls back to the
   *  built-in defaults when omitted (e.g. in isolated component tests). */
  resourceCatalog?: readonly ResCatalogGroup[];
  /** Per-backend credential availability (from the loader). Omitted defaults to
   *  both available (isolated component tests); the picker disables backends
   *  that aren't configured so a new profile can't be pinned to a dead runtime. */
  backendAvailable?: Record<"codex" | "claude", boolean>;
}) {
  const editing = initial !== null;
  const isOperator = initial?.kind === "operator";
  const capCatalog = isOperator ? OPERATOR_CAP_CATALOG : CAP_MODAL_CATALOG;
  const capDefaults = isOperator ? OPERATOR_CAP_DEFAULTS : CAP_MODAL_DEFAULTS;
  // R7-5: the specialist picker offers 3 honest modes (Allowed/Human-only/Off);
  // the operator keeps all 4 (`recommend` is real for the operator only).
  const capModes = isOperator ? OPERATOR_CAP_MODES : SPECIALIST_CAP_MODES;
  const available = backendAvailable ?? { codex: true, claude: true };
  const { ref: dialogRef, close } = useDialog(onClose);
  const uid = useId();
  const [name, setName] = useState(initial ? initial.name : "");
  const [role, setRole] = useState(initial ? initial.role : "");
  const [stg, setStg] = useState<string[]>(initial ? [...initial.stages] : []);
  const [backend, setBackend] = useState<"codex" | "claude" | "">(
    initial ? (initial.backends[0] ?? "") : "",
  );
  const [autonomy, setAutonomy] = useState<"supervised" | "full">(
    initial?.autonomy ?? "supervised",
  );
  const [definition, setDefinition] = useState(initial ? initial.desc : "");
  const [persona, setPersona] = useState(initial ? initial.definition : "");
  // Model + effort picks (seeded from the profile in edit mode). The catalog
  // (fetched below) supplies the option lists + defaults; a seeded value that
  // is not in the catalog is still preserved and rendered.
  const [model, setModel] = useState(initial ? initial.model : "");
  const [effort, setEffort] = useState(initial ? initial.effort : "");
  const [caps, setCaps] = useState<Record<string, CapMode>>(() =>
    seedCaps(initial, capDefaults),
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    [capCatalog[0]!.group]: true,
  });
  const [res, setRes] = useState<ResourceSelection>(() =>
    initial
      ? {
          skills: [...initial.resources.skills],
          mcps: [...initial.resources.mcps],
          kb: [...initial.resources.kb],
        }
      : // A NEW profile starts with NOTHING pre-selected — the user grants real
        // resources from the live catalog. (Pre-checking mock ids like
        // `repo-write` / "Coding standards" seeded grants for resources that
        // don't exist — finding #5.)
        { skills: [], mcps: [], kb: [] },
  );
  // The live store catalog (buildResourceCatalog) drives the picker; an empty
  // store means an empty picker — never a mock fallback.
  const resCatalog: readonly ResCatalogGroup[] = resourceCatalog ?? [];
  const [openRes, setOpenRes] = useState<Record<string, boolean>>(() =>
    resCatalog[0] ? { [resCatalog[0].group]: true } : {},
  );

  const toggleStage = (id: string) =>
    setStg((arr) =>
      arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id],
    );
  const toggleRes = (key: keyof ResourceSelection, item: string) =>
    setRes((p) => ({
      ...p,
      [key]: p[key].includes(item)
        ? p[key].filter((x) => x !== item)
        : [...p[key], item],
    }));

  const valid = Boolean(name.trim() && role.trim() && backend && stg.length);

  // Model + effort catalog — fetched from /resources/model-catalog whenever a
  // backend is selected (open in edit mode, or the backend radio changes in
  // create mode). The endpoint returns the curated fallback even with no
  // credential, so the pickers always populate.
  const catalogFetcher = useFetcher<{ data: ModelCatalog }>();
  useEffect(() => {
    if (!backend) return;
    catalogFetcher.load(`/resources/model-catalog?backend=${backend}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);
  const catalog = catalogFetcher.data?.data ?? null;
  const catalogLoading = catalogFetcher.state === "loading";

  // Default the picks to the catalog defaults once it loads and no pick is set
  // (create mode, or a backend switch that invalidated the prior model).
  useEffect(() => {
    if (!catalog) return;
    const known = catalog.models.some((m) => m.value === model);
    if (!model || !known) setModel(catalog.defaultModel);
    if (!effort) setEffort(catalog.defaultEffort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  // Effort options come from the selected model (when it constrains them),
  // else the backend-wide list. Hidden entirely when the model has no effort.
  const selectedModel = useMemo(
    () => catalog?.models.find((m) => m.value === model) ?? null,
    [catalog, model],
  );
  const showEffort = !catalog || !selectedModel || selectedModel.supportsEffort;
  const effortOptions =
    selectedModel?.efforts && selectedModel.efforts.length
      ? selectedModel.efforts
      : (catalog?.efforts ?? []);

  const submit = () => {
    if (!valid || busy) return;
    onSubmit({
      name: name.trim(),
      role: role.trim(),
      backend: backend as "codex" | "claude",
      stages: [...stg],
      definition,
      persona,
      model: model.trim(),
      effort: showEffort ? effort.trim() : "",
      caps,
      ...(isOperator ? { autonomy } : {}),
      resources: res,
    });
  };

  // AP-07: a template-sourced profile FORKS on save (the deployment stores a
  // full definition snapshot that wins over the org template from then on) —
  // the confirm button says so instead of promising an inheritance that stops.
  const forksTemplate = editing && initial.source === "template";
  const hint = error
    ? error
    : valid
      ? editing
        ? forksTemplate
          ? `Ready to save — this forks ${initial.name} for ${projectName}.`
          : "Ready to save changes."
        : `Ready to add to ${projectName}.`
      : "Name, role, one execution backend, and at least one stage are required.";

  return (
    // Native <dialog> — Escape, backdrop-click close, focus trap/restore and
    // the ::backdrop scrim all come from showModal() + useDialog.
    <dialog
      className="modal-card"
      aria-label={editing ? "Edit profile" : "New specialist profile"}
      ref={dialogRef}
    >
      <ModalHead
        editing={editing}
        initialName={initial?.name}
        forksTemplate={forksTemplate}
        projectName={projectName}
        onClose={close}
      />

      <div className="modal-body">
        <IdentityFields
          uid={uid}
          name={name}
          setName={setName}
          role={role}
          setRole={setRole}
        />

        <BackendField
          backend={backend}
          setBackend={setBackend}
          available={available}
        />

        {isOperator && (
          <AutonomyField autonomy={autonomy} setAutonomy={setAutonomy} />
        )}

        <ModelEffortFields
          uid={uid}
          backend={backend}
          model={model}
          setModel={setModel}
          effort={effort}
          setEffort={setEffort}
          catalog={catalog}
          catalogLoading={catalogLoading}
          selectedModel={selectedModel}
          showEffort={showEffort}
          effortOptions={effortOptions}
        />

        <StagesField stages={stages} stg={stg} toggleStage={toggleStage} />

        <DefinitionField
          uid={uid}
          isOperator={isOperator}
          definition={definition}
          setDefinition={setDefinition}
          persona={persona}
          setPersona={setPersona}
        />

        <CapabilityGrants
          capCatalog={capCatalog}
          capModes={capModes}
          caps={caps}
          setCaps={setCaps}
          openGroups={openGroups}
          setOpenGroups={setOpenGroups}
        />

        <ResourcePicker
          resCatalog={resCatalog}
          res={res}
          toggleRes={toggleRes}
          openRes={openRes}
          setOpenRes={setOpenRes}
        />
      </div>

      <ModalFooter
        hint={hint}
        valid={valid}
        error={error}
        busy={busy}
        editing={editing}
        onClose={close}
        onSubmitClick={submit}
      />
    </dialog>
  );
}
