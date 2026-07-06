import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { useDialog } from "~/ui/use-dialog";
import type { AgentProfileView } from "./agent-types";
import {
  CAP_MODAL_CATALOG,
  CAP_MODAL_DEFAULTS,
  CAP_MODES,
  OPERATOR_CAP_CATALOG,
  OPERATOR_CAP_DEFAULTS,
  RES_CATALOG,
  RES_DEFAULTS,
  type CapMode,
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

function seedCaps(
  initial: AgentProfileView | null,
  defaults: Readonly<Record<string, CapMode>>,
): Record<string, CapMode> {
  if (!initial) return { ...defaults };
  const caps: Record<string, CapMode> = {};
  for (const id of Object.keys(defaults)) caps[id] = "off";
  for (const grant of initial.capabilities) {
    if (grant.capabilityId in caps) caps[grant.capabilityId] = grant.mode;
  }
  return caps;
}

export function CreateProfileModal({
  initial,
  stages,
  projectName,
  busy,
  error,
  onClose,
  onSubmit,
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
}) {
  const editing = initial !== null;
  const isOperator = initial?.kind === "operator";
  const capCatalog = isOperator ? OPERATOR_CAP_CATALOG : CAP_MODAL_CATALOG;
  const capDefaults = isOperator ? OPERATOR_CAP_DEFAULTS : CAP_MODAL_DEFAULTS;
  const dialogRef = useDialog(onClose);
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
      : {
          skills: [...RES_DEFAULTS.skills],
          mcps: [...RES_DEFAULTS.mcps],
          kb: [...RES_DEFAULTS.kb],
        },
  );
  const [openRes, setOpenRes] = useState<Record<string, boolean>>({
    [RES_CATALOG[0]!.group]: true,
  });

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
      model: model.trim(),
      effort: showEffort ? effort.trim() : "",
      caps,
      ...(isOperator ? { autonomy } : {}),
      resources: res,
    });
  };

  const hint = error
    ? error
    : valid
      ? editing
        ? "Ready to save changes."
        : `Ready to add to ${projectName}.`
      : "Name, role, one execution backend, and at least one stage are required.";

  return (
    <>
      <div className="confirm-scrim" onClick={onClose} />
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "Edit profile" : "New specialist profile"}
        ref={dialogRef}
      >
        <div className="modal-head">
          <span className="agent-glyph lg">
            <Icon name="agents" />
          </span>
          <div className="mh-main">
            <h2>{editing ? "Edit " + initial.name : "New specialist profile"}</h2>
            <div className="mh-sub">
              {editing
                ? "Update this profile — changes apply to future assignments."
                : "A reusable agent the operator can assign to tasks."}
            </div>
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="flabel">
                Name<span className="req">*</span>
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Migrations"
                autoFocus
              />
            </div>
            <div className="field">
              <label className="flabel">
                Role<span className="req">*</span>
              </label>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Schema changes"
              />
            </div>
          </div>

          <div className="field">
            <label className="flabel">
              Execution backend<span className="req">*</span>
              <span className="fhint">pick exactly one</span>
            </label>
            <div className="pick-chips">
              {BACKENDS.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  className={"pick-chip" + (backend === b.id ? " on" : "")}
                  onClick={() => setBackend(b.id)}
                >
                  <AgentGlyph backend={b.id} />
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {isOperator && (
            <div className="field">
              <label className="flabel">
                Default autonomy
                <span className="fhint">
                  supervised recommends at governed boundaries · full performs
                  them and may accept completion to Done
                </span>
              </label>
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
          )}

          <div className="field-row">
            <div className="field">
              <label className="flabel">
                Model
                <span className="fhint">
                  {catalogLoading
                    ? "loading available models…"
                    : "the model this profile runs on"}
                </span>
              </label>
              <select
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
                <label className="flabel">
                  Effort
                  <span className="fhint">reasoning level per turn</span>
                </label>
                <select
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

          <div className="field">
            <label className="flabel">
              Eligible stages<span className="req">*</span>
              <span className="fhint">stages this profile may work in</span>
            </label>
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

          <div className="field">
            <label className="flabel">
              Definition
              <span className="fhint">
                what this agent is for, in your words — markdown ok
              </span>
            </label>
            <textarea
              value={definition}
              onChange={(e) => setDefinition(e.target.value)}
              style={{ minHeight: "96px" }}
              placeholder="e.g. Owns database schema changes. Writes and verifies migrations against a shadow DB, and never touches application code without operator sign-off."
            />
          </div>

          <div className="field">
            <label className="flabel">
              Capability policy
              <span className="fhint">
                how each action is enforced — adjust the defaults
              </span>
            </label>
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
                              {CAP_MODES.map((m) => (
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

          <div className="field">
            <label className="flabel">
              Context resources
              <span className="fhint">
                skills, MCP servers, knowledge bases this profile may load
              </span>
            </label>
            <div className="cap-matrix">
              {RES_CATALOG.map((g) => {
                const open = !!openRes[g.group];
                const sel = res[g.key];
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
                          {sel.length} of {g.items.length}
                        </span>
                      </span>
                    </button>
                    {open && (
                      <div className="cap-mbody">
                        <div className="pick-chips">
                          {g.items.map((it) => (
                            <button
                              type="button"
                              key={it.id}
                              className={
                                "pick-chip" +
                                (g.mono ? " mono" : "") +
                                (sel.includes(it.id) ? " on" : "")
                              }
                              onClick={() => toggleRes(g.key, it.id)}
                            >
                              {sel.includes(it.id) && <Icon name="check" />}
                              {it.id}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span className={"foot-hint" + (valid && !error ? "" : " err")}>{hint}</span>
          <div className="foot-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={submit}
              disabled={!valid || busy}
              style={!valid ? { opacity: 0.5, pointerEvents: "none" } : undefined}
            >
              <Icon name="check" />
              {editing ? "Save changes" : "Create profile"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
