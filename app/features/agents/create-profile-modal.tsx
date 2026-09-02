import type { Dispatch, SetStateAction } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  BROWSER_CAP_ID,
  capabilityEnforcement,
  GRANT_REQUIRED_CAPABILITY_IDS,
  WEB_EGRESS_CAP_ID,
} from "~/shared/capabilities";
import { claudeModelRunsVerbatim } from "~/shared/model-ids";
import {
  CODEX_REPO_WRITE_ADVISORY_NOTE,
  codexRepoWriteAdvisory,
} from "~/server/tasks/specialist-tool-policy";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { rovingRadioKeyDown } from "~/ui/roving-radio";
import { useDialog } from "~/ui/use-dialog";
import type { AgentProfileView } from "./agent-types";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
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

/** The editor's working policy: capability id → the mode its toggle shows.
 * Open by construction — the ids come from the catalog at runtime, and grants
 * outside it are preserved server-side rather than represented here. */
export interface CapSelection {
  [capabilityId: string]: CapMode;
}

/** The editor's live selection as the id-based grant list the runtime reads
 *  (only the four runtime modes; anything else the picker holds is not a
 *  grant the runtime would see). */
function grantsOf(caps: CapSelection): { capabilityId: string; mode: CapabilityGrant["mode"] }[] {
  const out: { capabilityId: string; mode: CapabilityGrant["mode"] }[] = [];
  for (const [capabilityId, mode] of Object.entries(caps)) {
    if (mode === "direct" || mode === "recommend" || mode === "human" || mode === "off") {
      out.push({ capabilityId, mode });
    }
  }
  return out;
}

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
  caps: CapSelection;
  /** Operator only: default autonomy the run uses. */
  autonomy?: "supervised" | "full";
  resources: ResourceSelection;
}

const BACKENDS: { id: "codex" | "claude"; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
];

/** Client mirror of the /resources/model-catalog payload shape. Exported for
 *  the controller settings panel, which picks its model/effort with the same
 *  machinery (ruling 106). */
export interface CatalogModel {
  value: string;
  displayName: string;
  description: string;
  supportsEffort: boolean;
  efforts?: string[];
  /** R20-3 / F20-4: set when a real run proved the provider refuses this model
   *  for this account — the option is disabled and the reason explained. */
  unavailable?: { reason: string; markedAt: string };
}
export interface ModelCatalog {
  models: CatalogModel[];
  efforts: string[];
  defaultModel: string;
  defaultEffort: string;
}

const EFFORT_LABEL = new Map<string, string>([
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Maximum"],
]);

export function effortLabel(id: string): string {
  return EFFORT_LABEL.get(id) ?? id;
}

/**
 * Model + effort catalog state for one backend, shared by this modal and the
 * controller settings panel (ruling 106): the /resources/model-catalog fetch,
 * the D5 failed-load detection with its retry, defaulting the picks once the
 * catalog answers, and the selected-model derivations the pickers render.
 *
 * The caller owns `model`/`effort` state (each editor seeds them from its own
 * stored config); this hook only writes them through the setters when the
 * current value is one `resolveRunModel` would itself SUBSTITUTE at run time
 * (empty, or unknown to both the served catalog and the shared
 * always-runs-verbatim rule), so the picker shows what would actually run. A
 * dated Claude id or family alias the catalog does not list is left standing
 * — the select renders it via its preserve-a-seeded-value option.
 */
export interface ModelCatalogState {
  catalog: ModelCatalog | null;
  catalogLoading: boolean;
  catalogFailed: boolean;
  loadCatalog: () => void;
  selectedModel: CatalogModel | null;
  showEffort: boolean;
  effortOptions: string[];
}

export function useModelCatalog(
  backend: "codex" | "claude" | "",
  model: string,
  setModel: (v: string) => void,
  effort: string,
  setEffort: (v: string) => void,
): ModelCatalogState {
  // Fetched whenever a backend is selected (open in edit mode, or the backend
  // radio changes in create mode). The endpoint returns the curated fallback
  // even with no credential, so the pickers always populate.
  const catalogFetcher = useFetcher<{ data: ModelCatalog }>();
  // D5 (pass 23): so a fetch that SETTLED with no data reads as a failure, not
  // as the pre-load window. Flipped true once a load has actually fired for the
  // current backend; a backend switch resets it.
  const catalogLoadFired = useRef(false);
  const loadCatalog = () => {
    if (!backend) return;
    catalogLoadFired.current = true;
    catalogFetcher.load(`/resources/model-catalog?backend=${backend}`);
  };
  useEffect(() => {
    if (!backend) return;
    catalogLoadFired.current = false;
    loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);
  const catalog = catalogFetcher.data?.data ?? null;
  const catalogLoading = catalogFetcher.state === "loading";
  // D5: a load fired and SETTLED (idle) with no catalog → the fetch failed. The
  // endpoint returns a curated fallback even without a credential, so this is a
  // real transport/500 failure. Without a signal, the pending state lasts
  // forever over an empty picker with no way out. This offers the retry.
  const catalogFailed =
    Boolean(backend) &&
    catalogLoadFired.current &&
    catalogFetcher.state === "idle" &&
    !catalog;

  // Default the picks to the catalog defaults once it loads and no valid pick
  // is set (create mode, or a backend switch that invalidated the prior model).
  // "Valid" mirrors the runtime's isKnownModel, not bare catalog membership
  // (ruling 106 review, D1): a dated Claude id or family alias runs VERBATIM
  // (`resolveRunModel` passes it through) even when the served catalog does
  // not list it, so rewriting it here would be a silent model change the next
  // save persists — the select keeps it via its preserve-a-seeded-value
  // option instead. Only a value the runtime would itself substitute (empty,
  // or truly unknown) seeds to the default the run would actually use.
  useEffect(() => {
    if (!catalog) return;
    const known =
      catalog.models.some((m) => m.value === model) ||
      (backend === "claude" && claudeModelRunsVerbatim(model));
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

  return {
    catalog,
    catalogLoading,
    catalogFailed,
    loadCatalog,
    selectedModel,
    showEffort,
    effortOptions,
  };
}

/**
 * F19 UX-13 — the modes the SERVER refuses to store as submitted.
 *
 * Two rewrites happen unconditionally in `agent-profile-actions.server.ts`:
 *  - `:185` (edit) / `:239` (create) — every id in `ALWAYS_HUMAN_CAPABILITY_IDS`
 *    is coerced to `human` "whatever the submitted form says";
 *  - `:180` (edit) / `:249` (create) — `report-validation-verdict` persists
 *    `direct` iff the form said `direct`, and `off` for every other value.
 *
 * The picker used to offer the rewritten modes anyway: an admin could set
 * "Merge a pull request" to Allowed, get a success toast, and find it back on
 * Human-only; picking "Human-only" for the verdict silently stored `off`, which
 * the policy surfaces then count in a different bucket than the one chosen. The
 * control now refuses what the server refuses instead of accepting and
 * discarding it — the same locked treatment (`.cap-seg.locked`) the Policy sheet
 * already uses for its human-authorized boundary (policy-page.tsx:471).
 */
const ALWAYS_HUMAN = new Set<string>(ALWAYS_HUMAN_CAPABILITY_IDS);
const VERDICT_CAP_ID = "report-validation-verdict";

/** Dot class + fallback word per mode for the collapsed group summary.
 *  `off` uses the SAME `.d.off` swatch as the capability matrix's "Not granted"
 *  legend entry (capability-matrix-modal.tsx:118) — the modal used to draw it in
 *  a `.d.none` grey the one legend in the product never showed. */
const SUMMARY_MODES: readonly { id: CapMode; word: string }[] = [
  { id: "direct", word: "Direct" },
  { id: "recommend", word: "Recommend" },
  { id: "human", word: "Human" },
  { id: "off", word: "Off" },
];

// Repo-write grants that mark a profile as a DELIVERING builder (mirrors
// listDeployedSpecialists' delivery heuristic) — used to seed the verdict
// toggle from its RUNTIME-effective mode below.
/** Owner ruling (2026-08-20): a granted browser carries web egress with it —
 * the browser IS egress, and `resolveBrowserMcp` refuses to mount the pair in
 * disagreement, so the editor never lets the disagreement exist. Applied on
 * every state write AND on seed (a stored profile from before the rule can
 * still carry the contradiction; the save layer repairs it identically, so
 * seeding it coupled shows the admin what the next save persists — the same
 * F19 UX-13 round-trip honesty the verdict row follows below). */
function coupleGrants(sel: CapSelection): CapSelection {
  return sel[BROWSER_CAP_ID] === "direct" &&
    sel[WEB_EGRESS_CAP_ID] !== "direct"
    ? { ...sel, [WEB_EGRESS_CAP_ID]: "direct" }
    : sel;
}

function seedCaps(
  initial: AgentProfileView | null,
  defaults: Readonly<CapSelection>,
): CapSelection {
  if (!initial) return coupleGrants({ ...defaults });
  const caps: CapSelection = {};
  // Seed each ABSENT toggle to the mode the RUNTIME uses for a missing grant, so
  // the editor shows exactly what the agent may do — not a hardcoded "off".
  //   - A GRANT-REQUIRED capability (repo write, branch, push, open-PR, merge,
  //     verdict) is withheld when absent, so it seeds OFF. This preserves the
  //     F10-07/F10-14 invariant: `report-validation-verdict` is grant-required,
  //     so an absent verdict still seeds OFF and a save can never silently arm
  //     the acceptance veto.
  //   - Every OTHER capability keeps its permissive default when absent, so it
  //     seeds from the catalog default. This fixes the BUG where
  //     `use-web-search-fetch` (catalog default `direct`, i.e. web egress ON)
  //     rendered as "Off" while WebFetch/WebSearch stayed available, and any
  //     save then persisted that phantom "off" and silently WITHHELD egress the
  //     admin never touched. Seeding from the effective default keeps the
  //     display truthful and the round-trip behaviour-preserving.
  for (const id of Object.keys(defaults)) {
    caps[id] = GRANT_REQUIRED_CAPABILITY_IDS.has(id) ? "off" : defaults[id];
  }
  // Stored grants win over the seed. Verdict stays explicit-only: a non-`direct`
  // stored verdict (a legacy `recommend`, or a `human` from some other path)
  // seeds OFF — exactly what the save layer persists for it
  // (`agent-profile-actions.server.ts` — `mode = mode === "direct" ? "direct" :
  // "off"`), so the admin never sees a mode the next save silently rewrites.
  for (const grant of initial.capabilities) {
    if (grant.capabilityId in caps) {
      caps[grant.capabilityId] =
        grant.capabilityId === VERDICT_CAP_ID && grant.mode !== "direct"
          ? "off"
          : grant.mode;
    }
  }
  return coupleGrants(caps);
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
        {/* C11: "specialist" is retired vocabulary — the object is an agent
            profile the operator engages per task (delivering / supporting). */}
        <h2>{editing ? "Edit " + initialName : "New agent profile"}</h2>
        <div className="mh-sub">
          {!editing
            ? "A reusable agent the operator can assign to tasks."
            : forksTemplate
              ? `Saving forks this profile for ${projectName}: it keeps its own copy and stops tracking later changes to the global profile.`
              : "Update this project's copy. Changes apply from the next run."}
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
  seededBackends,
}: {
  backend: "codex" | "claude" | "";
  setBackend: (v: "codex" | "claude") => void;
  /** Per-backend credential availability (from the loader). An unconfigured
   *  backend is disabled so a profile can't be pinned to a runtime whose every
   *  run would fail — EXCEPT the one an edited profile already runs on, which
   *  stays selectable so re-saving doesn't force a backend change (RU-2). */
  available: Record<"codex" | "claude", boolean>;
  /** P13-UI-52: the backends the profile being edited ALREADY declares. A
   *  seeded profile can list two; this form is single-select and saving writes
   *  exactly one, so editing anything else on such a profile silently dropped
   *  the second backend. Nothing here can widen the form (a run uses the first
   *  backend anyway — the roster says so), but the narrowing must be stated
   *  BEFORE the save, not discovered in the roster afterwards. */
  seededBackends?: readonly ("codex" | "claude")[];
}) {
  const dropping = (seededBackends ?? []).filter((b) => b !== backend);
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
              aria-pressed={backend === b.id}
              onClick={() => setBackend(b.id)}
              disabled={!usable}
              title={
                usable
                  ? undefined
                  : `${b.label} isn't configured. Add its credential to run agents on it`
              }
            >
              <AgentGlyph backend={b.id} />
              {b.label}
            </button>
          );
        })}
      </div>
      {dropping.length > 0 && (
        <p className="deny-note">
          <Icon name="alert" />
          <span>
            <strong>Saving pins this profile to one backend.</strong> It
            currently declares{" "}
            {(seededBackends ?? [])
              .map((b) => (b === "claude" ? "Claude" : "Codex"))
              .join(" and ")}
            ; {dropping.map((b) => (b === "claude" ? "Claude" : "Codex")).join(" and ")}{" "}
            will be dropped.
          </span>
        </p>
      )}
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
          {/* OBS-12: autonomy is a CEILING, not the whole answer — the
              capability rows below decide per action, and a row set to direct
              acts directly under either setting (live: a supervised operator
              with stage-transitions:direct moved approval boundaries itself).
              The old sentence read as a guarantee this control cannot make. */}
          supervised recommends at approval boundaries · full performs them and
          may accept completion to Done · capability rows may override this per
          action
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
            aria-pressed={autonomy === a.id}
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

/** The model + effort pickers, exported for the controller settings panel
 *  (ruling 106) — same select, loading/failed/retry, description and
 *  unavailable-model treatment everywhere a model is chosen. */
export function ModelEffortFields({
  uid,
  backend,
  model,
  setModel,
  effort,
  setEffort,
  catalog,
  catalogLoading,
  catalogFailed,
  onRetryCatalog,
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
  /** D5: the model-catalog load settled with no data — a real fetch failure. */
  catalogFailed: boolean;
  /** D5: re-fire the model-catalog load. */
  onRetryCatalog: () => void;
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
              : catalogFailed
                ? "couldn't load the models"
                : "the model this profile runs on"}
          </span>
          {/* D5 (pass 23): a fetch that failed used to strand Save forever with
              no error and no way out — the picker sat empty and the footer said
              "Saving is held until a model loads". Offer the retry. */}
          {catalogFailed && (
            <button
              type="button"
              className="btn ghost xs"
              onClick={onRetryCatalog}
            >
              Retry
            </button>
          )}
        </label>
        <select
          id={`${uid}-model`}
          aria-label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={!backend || catalogLoading}
        >
          {!backend && <option value="">Pick a backend first</option>}
          {/* F21-13: a backend is picked and its catalog has not answered yet
              (open, or a switch that cleared the previous backend's model). The
              select must carry the empty value it is showing, or the browser
              silently displays the first real option while `model` is still ""
              — the shape that made a stale id look picked. */}
          {backend && model === "" && (
            <option value="">
              {catalogLoading ? "loading available models…" : "no model yet"}
            </option>
          )}
          {/* Preserve a seeded value that is not in the catalog. */}
          {backend &&
            model &&
            catalog &&
            !catalog.models.some((m) => m.value === model) && (
              <option value={model}>{model}</option>
            )}
          {(catalog?.models ?? []).map((m) => (
            <option
              key={m.value}
              value={m.value}
              // R20-3/F20-4: a model a real run proved unusable for this account
              // is offered but not selectable — the reason rides its title.
              disabled={!!m.unavailable}
              title={m.unavailable ? m.unavailable.reason : m.description}
            >
              {m.displayName}
              {m.unavailable ? " (unavailable for this account)" : ""}
            </option>
          ))}
        </select>
        {selectedModel?.unavailable ? (
          // A stored profile pinned to a now-refused model: name the provider's
          // own sentence and tell the admin to pick another (a run would 400).
          <span className="fhint flush err">
            <Icon name="alert" /> Unavailable for this account:{" "}
            {selectedModel.unavailable.reason} Pick another model.
          </span>
        ) : selectedModel?.description ? (
          <span className="fhint flush">
            {selectedModel.description}
          </span>
        ) : null}
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
            >
            {(!backend || effort === "") && <option value="">no effort yet</option>}
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
            aria-pressed={stg.includes(s.id)}
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
              ? "one short paragraph: a human-readable summary of this operator"
              : "one short paragraph: the OPERATOR reads this to pick the right agent for a task"}
          </span>
        </label>
        <textarea
          id={`${uid}-definition`}
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
          className="ta-brief"
          placeholder="e.g. Owns database schema changes. Writes and verifies migrations against a shadow DB, and never touches application code without operator sign-off."
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor={`${uid}-persona`}>
          Persona / instructions
          <span className="fhint">
            {isOperator
              ? "extra operator guidance, appended to the built-in operator manual on every run; markdown ok"
              : "the agent's working instructions, injected as its system prompt on every run; markdown ok"}
          </span>
        </label>
        <textarea
          id={`${uid}-persona`}
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          className="ta-long"
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
  backend,
}: {
  capCatalog: readonly ModalCapGroup[];
  /** The mode buttons offered per row: 4 for the operator, 3 honest ones
   *  (Allowed/Human-only/Off) for a specialist (R7-5). */
  capModes: readonly { id: CapMode; label: string }[];
  caps: CapSelection;
  setCaps: Dispatch<SetStateAction<CapSelection>>;
  openGroups: Record<string, boolean>;
  setOpenGroups: Dispatch<SetStateAction<Record<string, boolean>>>;
  /** B1 (pass 23): the profile's pinned backend, so a claude-only withholding
   *  can be tagged advisory/inert on a Codex profile at the point it is set. */
  backend: "codex" | "claude" | "";
}) {
  const capId = useId();
  return (
    <div className="field" role="group" aria-labelledby={capId}>
      <span className="flabel" id={capId}>
        Capability policy
        <span className="fhint">
          how each action is enforced · adjust the defaults
        </span>
      </span>
      <div className="cap-matrix">
        {capCatalog.map((g, gi) => {
          const open = !!openGroups[g.group];
          const bodyId = `${capId}-cap-${gi}`;
          const c = { direct: 0, recommend: 0, human: 0, off: 0 };
          g.caps.forEach((x) => {
            c[caps[x.id] ?? "off"] += 1;
          });
          const anyLocked = g.caps.some((x) => ALWAYS_HUMAN.has(x.id));
          return (
            <div className={"cap-mgroup" + (open ? " open" : "")} key={g.group}>
              {/* F19-35: the disclosure state lived in the `open` CSS class
                  alone — the chevron rotates, and a screen reader learns
                  nothing. `aria-expanded` is the house pattern for every other
                  collapsible trigger in the app (settings-page.tsx:450,
                  runs-panels.tsx:98, timeline.tsx:93). */}
              <button
                type="button"
                className={"cap-mghead" + (open ? " open" : "")}
                // UX-21: every other custom disclosure in the product reports
                // its state; these two accordions carried it in a CSS class
                // (`.cap-mghead.open .cap-chev` rotation) alone, so a screen
                // reader could not tell a collapsed group from an expanded one
                // — and all groups after the first START collapsed. A dangling
                // `aria-controls` is worse than none (command-palette.tsx:153),
                // so it is set only while the body exists.
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                onClick={() =>
                  setOpenGroups((p) => ({ ...p, [g.group]: !p[g.group] }))
                }
              >
                <Icon name="chevron" className="cap-chev" />
                <span className="cap-mglabel">{g.group}</span>
                {/* UX-23: the counts used to be bare digits ("3 2 1") told
                    apart by dot colour alone — no text, no accessible name,
                    and position did not disambiguate either because a zero
                    count renders nothing. Each count now carries the SAME word
                    the expanded segment below uses for that mode on this
                    profile kind (Allowed/Human-only/Off for a specialist,
                    Direct/Recommend/Human/Off for the operator), the way the
                    Policy page's identical strip already reads
                    (policy-page.tsx:309-322). */}
                <span className="cap-msum">
                  {SUMMARY_MODES.filter((m) => c[m.id] > 0).map((m) => (
                    <span className="cs" key={m.id}>
                      <span className={"d " + m.id} />
                      {c[m.id]} {capModes.find((x) => x.id === m.id)?.label ?? m.word}
                    </span>
                  ))}
                </span>
              </button>
              {open && (
                <div className="cap-mbody" id={bodyId}>
                  {anyLocked && (
                    <p className="deny-note before">
                      <Icon name="lock" />
                      <span>
                        <strong>The locked rows can&apos;t be granted here.</strong>{" "}
                        They stay reserved for humans on every profile. Saving
                        stores <strong>Human-only</strong> whatever this form
                        sends.
                      </span>
                    </p>
                  )}
                  {g.caps.map((capDef) => {
                    // UX-13: the server rewrites these two classes of row
                    // unconditionally, so the picker no longer offers what it
                    // will discard. Always-human ids get the locked seg the
                    // Policy sheet uses (policy-page.tsx:471); the verdict row
                    // drops "Human-only", which persists `off` — it is an
                    // explicit-`direct`-or-nothing grant.
                    const locked = ALWAYS_HUMAN.has(capDef.id);
                    // Browser→egress coupling: while the browser is Allowed,
                    // the egress row is pinned to Allowed — `coupleGrants`
                    // keeps the STATE coherent, this keeps the CONTROL honest
                    // about it (a row that any click would instantly revert
                    // must not offer the click).
                    const pinned =
                      capDef.id === WEB_EGRESS_CAP_ID &&
                      caps[BROWSER_CAP_ID] === "direct";
                    const rowModes =
                      capDef.id === VERDICT_CAP_ID
                        ? capModes.filter((m) => m.id !== "human")
                        : capModes;
                    // Roving tabindex: the checked option is the group's single
                    // tab stop. A stored mode this picker does not offer (a
                    // legacy specialist `recommend`) leaves nothing checked, so
                    // the first option holds the tab stop rather than the group
                    // becoming unreachable.
                    const checkedIdx = rowModes.findIndex(
                      (m) => m.id === caps[capDef.id],
                    );
                    const tabIdx = checkedIdx < 0 ? 0 : checkedIdx;
                    // B1 (pass 23): on a Codex-pinned profile, a claude-only
                    // withholding is advisory (the Codex SDK ignores tool
                    // allow/deny lists; the server-owned delivery gate is the real
                    // boundary), and `read-github-api` is never mounted on Codex
                    // at all — the grant is inert. The editor is where the grant
                    // is MADE, so tag the row so an admin does not trust a toggle
                    // that cannot bind on the chosen backend. (The matrix tags the
                    // same rows via capabilityEnforcement; this is its editor
                    // twin, backend-aware because the editor is pinned to one.)
                    const codexAdvisory =
                      backend === "codex" &&
                      !locked &&
                      capabilityEnforcement(capDef.id) === "claude-only";
                    const codexInert = codexAdvisory && capDef.id === "read-github-api";
                    // Pass 32 (E32-3 fallback): the headline write family binds
                    // on Codex through the read-only sandbox — EXCEPT when this
                    // very selection withholds it while granting evidence, the
                    // shape the sandbox cannot express. Tag the row from the
                    // live selection so the admin sees the caveat as they make it.
                    const codexCarveOut =
                      backend === "codex" &&
                      capDef.id === "execute-code-or-write-repo" &&
                      codexRepoWriteAdvisory(grantsOf(caps));
                    return (
                      <div className="cap-mrow" key={capDef.id}>
                        <span className="cap-mname">
                          {capDef.label}
                          {codexAdvisory && (
                            <span
                              className="mx-scope"
                              title={
                                codexInert
                                  ? "This tool is Claude-only and is never mounted on Codex, so on this Codex profile the grant is inert."
                                  : "Enforced on Claude runs (tool denylist). On this Codex profile it is advisory only: the Codex SDK ignores tool allow/deny lists, so the server-owned delivery gate is the real boundary."
                              }
                            >
                              {codexInert ? "inert on Codex" : "advisory on Codex"}
                            </span>
                          )}
                          {codexCarveOut && (
                            <span
                              className="mx-scope"
                              title={`On this Codex profile ${CODEX_REPO_WRITE_ADVISORY_NOTE}. Withhold "Attach evidence references" too, or run the profile on Claude, to make the withholding bind.`}
                            >
                              advisory on Codex
                            </span>
                          )}
                        </span>
                        {/* UXA-4: the Direct/Recommend/Human/Off control is a
                            single-select whose state was carried by CSS alone.
                            The SAME control on the Policy sheet (the workflow
                            boundary seg) is a proper radiogroup — this one was
                            simply never brought along, so the capability policy,
                            the most consequential setting in the product, was the
                            one a screen reader could not read.
                            UX-19: it was brought along as far as the ROLE and
                            stopped there. A radiogroup promises arrow-key
                            traversal (roving-radio.ts), which UXA-7 wired into
                            the twin at policy-page.tsx:158/:474 and not into
                            this one — so the group announced an interaction
                            model it did not have, and every radio was its own
                            tab stop (15 instead of 5 for Collaboration). */}
                        <div
                          className={
                            "cap-seg" + (locked || pinned ? " locked" : "")
                          }
                          role="radiogroup"
                          aria-label={
                            locked
                              ? `Policy for ${capDef.label} (locked, reserved for humans)`
                              : pinned
                                ? `Policy for ${capDef.label} (required by Drive a live web browser: the browser is web egress)`
                                : `Policy for ${capDef.label}`
                          }
                          onKeyDown={rovingRadioKeyDown}
                        >
                          {rowModes.map((m, mi) => (
                            <button
                              type="button"
                              key={m.id}
                              role="radio"
                              aria-checked={caps[capDef.id] === m.id}
                              tabIndex={mi === tabIdx ? 0 : -1}
                              disabled={locked || pinned}
                              className={
                                m.id + (caps[capDef.id] === m.id ? " on" : "")
                              }
                              onClick={() =>
                                setCaps((p) =>
                                  coupleGrants({ ...p, [capDef.id]: m.id }),
                                )
                              }
                            >
                              {m.label}
                            </button>
                          ))}
                        </div>
                        {pinned && (
                          // P14: a disabled control's reason must be RENDERED,
                          // not parked in a title that never opens on it (nor
                          // in an aria-label a sighted admin can't see). Says
                          // why the row is locked and how to unlock it.
                          <p className="cap-mnote">
                            Required by Drive a live web browser: the browser is
                            web egress. Set the browser to Human-only or Off to
                            change this.
                          </p>
                        )}
                        {backend === "codex" &&
                          capDef.id === BROWSER_CAP_ID && (
                            // The Codex screenshot-invisibility asymmetry was
                            // disclosed on the capability-matrix modal and in the
                            // run persona, but NOT here — where the grant is
                            // actually made. An admin who ticks the browser on a
                            // Codex profile and never opens the matrix could be
                            // surprised the agent cannot "see" what it captures.
                            <p className="cap-mnote">
                              On Codex, screenshots are not returned to the model:
                              a Codex agent captures and attaches them as evidence
                              but cannot visually inspect them, and judges pages
                              from the accessibility tree and text tools instead.
                            </p>
                          )}
                      </div>
                    );
                  })}
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
  backend,
}: {
  resCatalog: readonly ResCatalogGroup[];
  res: ResourceSelection;
  toggleRes: (key: keyof ResourceSelection, item: string) => void;
  openRes: Record<string, boolean>;
  setOpenRes: Dispatch<SetStateAction<Record<string, boolean>>>;
  /** F-P3: the profile's pinned backend, so the MCP group can disclose the
   *  Codex auth-drop here too. The resource catalog does not carry each
   *  server's `hasCred` through to this picker (`buildResourceCatalog`
   *  collapses every MCP row to a bare id), so this is one group-level note
   *  rather than a per-chip tag. */
  backend: "codex" | "claude" | "";
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
        {resCatalog.map((g, gi) => {
          const open = !!openRes[g.group];
          const bodyId = `${capId}-res-${gi}`;
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
              {/* F19-35: same disclosure gap as the capability groups above. */}
              <button
                type="button"
                className={"cap-mghead" + (open ? " open" : "")}
                // UX-21: same omission as the capability accordion above —
                // state lived in the chevron's CSS rotation and nowhere an
                // assistive technology could read it.
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                onClick={() =>
                  setOpenRes((p) => ({ ...p, [g.group]: !p[g.group] }))
                }
              >
                <Icon name="chevron" className="cap-chev" />
                <span className="cap-mglabel">{g.group}</span>
                <span className="cap-msum">
                  <span className="cs">
                    <span className="d recommend" />
                    {sel.length} of {displayItems.length}
                  </span>
                </span>
              </button>
              {open && (
                <div className="cap-mbody" id={bodyId}>
                  <div className="pick-chips">
                    {displayItems.map((it) => (
                      /* F19-5: a grant chip is a toggle, and its granted state
                         was carried by the `on` class + a check glyph only —
                         so a screen reader announced a granted skill/MCP/KB
                         exactly like an ungranted one. Every sibling chip group
                         in this file already reports it (backend :243, autonomy
                         :304, stages :430). A `missing` chip is a GRANT too (it
                         comes from `sel`), so it reports pressed and clicking
                         it removes the grant. */
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
                            ? "No longer in the store. Click to remove this grant"
                            : undefined
                        }
                        // F19-5: these grant chips are toggles like the backend,
                        // autonomy and stage chips above, but were the one family
                        // left carrying their state in CSS only — a screen reader
                        // could not tell a granted resource from a withheld one.
                        aria-pressed={selSet.has(it.id)}
                        onClick={() => toggleRes(g.key, it.id)}
                      >
                        {selSet.has(it.id) && <Icon name="check" />}
                        {it.id}
                      </button>
                    ))}
                  </div>
                  {displayItems.length === 0 && (
                    <p className="ctx-empty">
                      None in the store yet. Add {g.group.toLowerCase()} in org
                      settings.
                    </p>
                  )}
                  {/* F-P3: a credentialed MCP server's credential is injected
                      only on Claude runs — Codex drops it (it would otherwise
                      leak into the Codex CLI's --config argv), so on this
                      Codex-pinned profile every server granted here mounts
                      unauthenticated regardless of which ones carry a
                      credential. */}
                  {g.key === "mcps" &&
                    backend === "codex" &&
                    displayItems.length > 0 && (
                      <p className="cap-mnote">
                        Codex mounts MCP servers unauthenticated. Any
                        credential a server needs is not sent on Codex runs.
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
  busy,
  editing,
  onClose,
  onSubmitClick,
  showError,
}: {
  hint: string;
  valid: boolean;
  busy: boolean;
  editing: boolean;
  onClose: () => void;
  onSubmitClick: () => void;
  /* The requirements line turns red only after a save was actually attempted
     (or the server errored) — never on a pristine form. */
  showError: boolean;
}) {
  return (
    <div className="modal-foot">
      <span
        className={"foot-hint" + (showError ? " err" : "")}
        role={showError ? "alert" : undefined}
      >
        {hint}
      </span>
      <div className="foot-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        {/* P13-UI-58 residual: the submit had no busy state for assistive tech —
            a save in flight looked idle to a screen reader. */}
        {/* Invalid is DIMMED but still clickable: the click reaches submit()'s
            refusal guard, which flips the requirements line red (the attempted
            gate) — a hard-disabled button made that state unreachable and the
            refusal silent. Busy stays a real disable. */}
        <button
          type="button"
          className="btn primary"
          onClick={onSubmitClick}
          disabled={busy}
          aria-disabled={!valid || busy || undefined}
          aria-busy={busy}
          style={!valid ? { opacity: 0.5 } : undefined}
        >
          <Icon name="check" />
          {busy ? "Saving…" : editing ? "Save changes" : "Create profile"}
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
  const [caps, setCaps] = useState<CapSelection>(() =>
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
  //
  // P13-KM-09/UI-28 wanted the operator's real `viberr` grant to stop rendering
  // as "no longer in the store", and did it by shipping a superset catalog and
  // filtering the reserved name back out for specialists. P14-KM-14 removed the
  // grant instead: the in-process toolkit mounts unconditionally, so the toggle
  // governed nothing. The catalog is now the registry for both kinds and needs
  // no per-kind filtering.
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

  /**
   * F21-13 — switching the backend clears the model and effort ON THE CLICK.
   *
   * The catalog fetch below is async, and until it answers, `catalog` still
   * holds the PREVIOUS backend's payload and `model` its previous id. Live, that
   * window was long enough to save through: Developer went Codex → Claude
   * while the picker read "loading available models…", Save was enabled, and the
   * deployment landed with `backends: [claude]` next to `model: gpt-5.6-terra`
   * — a pair no run can honour (the runtime silently substituted a Claude model,
   * so the profile said one thing and the run did another). Clearing here makes
   * the incoherent pair unrepresentable rather than merely unlikely: the model
   * select has nothing to submit and `valid` below refuses the save until the
   * new backend's catalog resolves. Re-picking the SAME chip is a no-op (an
   * edited profile keeps its stored model through an idle click).
   */
  const pickBackend = (next: "codex" | "claude") => {
    if (next === backend) return;
    setBackend(next);
    setModel("");
    setEffort("");
  };

  const fieldsValid = Boolean(name.trim() && role.trim() && backend && stg.length);

  // Model + effort catalog machinery — shared with the controller settings
  // panel (the hook holds the fetch, D5 failure/retry and default-seeding).
  const {
    catalog,
    catalogLoading,
    catalogFailed,
    loadCatalog,
    selectedModel,
    showEffort,
    effortOptions,
  } = useModelCatalog(backend, model, setModel, effort, setEffort);

  // F21-13: this profile has a backend but no model for it — `pickBackend`
  // cleared the previous backend's id and the new catalog has not answered yet
  // (or, in create mode, none has). Save is HELD for that whole window and the
  // footer hint below says why: a save inside it is exactly how a Codex model id
  // reached a Claude-pinned profile. Deliberately NOT "the fetch is in flight":
  // opening the editor also fetches, and a stored model that is already coherent
  // with its own backend must not lock Save behind a round-trip.
  const modelPending = Boolean(backend) && model === "";
  const valid = fieldsValid && !modelPending;
  // The requirements line is neutral guidance until the person actually tries
  // to save an invalid form — a modal that opens with red error text is
  // scolding them for something they haven't had a chance to do yet.
  const [attempted, setAttempted] = useState(false);

  const submit = () => {
    // `valid` already requires a picked backend; naming it in the guard is what
    // rules out the picker's initial "" for the payload below.
    if (!valid || busy || !backend) {
      setAttempted(true);
      return;
    }
    const payload: ProfileFormPayload = {
      name: name.trim(),
      role: role.trim(),
      backend,
      stages: [...stg],
      definition,
      persona,
      model: model.trim(),
      effort: showEffort ? effort.trim() : "",
      caps,
      resources: res,
    };
    // Autonomy is an OPERATOR field: a specialist payload must not carry the
    // key at all (the action's schema leaves it optional and the writer only
    // stores it for the operator).
    if (isOperator) payload.autonomy = autonomy;
    onSubmit(payload);
  };

  // AP-07: a template-sourced profile FORKS on save (the deployment stores a
  // full definition snapshot that wins over the org template from then on) —
  // the confirm button says so instead of promising an inheritance that stops.
  const forksTemplate = editing && initial.source === "template";
  const backendLabel = BACKENDS.find((b) => b.id === backend)?.label ?? "";
  const hint = error
    ? error
    : !fieldsValid
      ? "Name, role, one execution backend, and at least one stage are required."
      : // F21-13: the reason Save is disabled, in the same place every other
        // reason is given. Silence here is what made the disabled button read as
        // a glitch — and, before the hold existed, what let the click through.
        modelPending
        ? catalogLoading
          ? `Loading the models available on ${backendLabel}. Saving is held until this profile has one of them.`
          : catalogFailed
            ? // D5: don't say "pick a model" over an empty picker — the fetch failed.
              `Couldn't load the models available on ${backendLabel}. Retry above, then pick one. Saving is held until this profile has a model.`
            : `Pick a model available on ${backendLabel}. Saving is held until this profile has one.`
        : editing
          ? forksTemplate
            ? `Ready to save: this forks ${initial.name} for ${projectName}.`
            : "Ready to save changes."
          : `Ready to add to ${projectName}.`;

  return (
    // Native <dialog> — Escape, backdrop-click close, focus trap/restore and
    // the ::backdrop scrim all come from showModal() + useDialog.
    <dialog
      className="modal-card"
      aria-label={editing ? "Edit profile" : "New agent profile"}
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
          setBackend={pickBackend}
          available={available}
          {...(initial ? { seededBackends: initial.backends } : {})}
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
          catalogFailed={catalogFailed}
          onRetryCatalog={loadCatalog}
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
          backend={backend}
        />

        <ResourcePicker
          resCatalog={resCatalog}
          res={res}
          toggleRes={toggleRes}
          openRes={openRes}
          setOpenRes={setOpenRes}
          backend={backend}
        />
      </div>

      <ModalFooter
        hint={hint}
        valid={valid}
        busy={busy}
        editing={editing}
        onClose={close}
        onSubmitClick={submit}
        showError={Boolean(error) || (attempted && !valid)}
      />
    </dialog>
  );
}
