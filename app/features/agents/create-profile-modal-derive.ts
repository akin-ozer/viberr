import type { ModelCatalog } from "~/server/runtimes/model-catalog.server";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  BROWSER_CAP_ID,
  GRANT_REQUIRED_CAPABILITY_IDS,
  WEB_EGRESS_CAP_ID,
} from "~/shared/capabilities";
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
} from "./capability-catalog";
import type { CapSelection } from "./create-profile-modal";

/**
 * What the agent profile editor reads off the profile it opens and the fields
 * it holds (ruling 13(b), the large-component split of
 * `create-profile-modal.tsx`, on the task page's recipe): the capability policy
 * for the profile's kind, the seed of its capability grants, where the form
 * stands against what a save requires, and the sentences the model picker and
 * the footer show. Pure functions, no React; `CreateProfileModal`, its form
 * hooks (`create-profile-modal-form.ts`) and `ModelEffortFields` call them.
 */

/** The capability rows, their defaults and the modes a row offers, for the
 *  profile's kind. The specialist picker offers 3 honest modes (`MODE_LABEL`:
 *  Acts directly, Human-only, Off; ruling 298); the operator keeps all 4
 *  (`recommend` is real for the operator only). */
export function capabilityPolicyFor(isOperator: boolean): {
  capCatalog: readonly ModalCapGroup[];
  capDefaults: Readonly<CapSelection>;
  capModes: readonly { id: CapMode; label: string }[];
} {
  return isOperator
    ? {
        capCatalog: OPERATOR_CAP_CATALOG,
        capDefaults: OPERATOR_CAP_DEFAULTS,
        capModes: OPERATOR_CAP_MODES,
      }
    : {
        capCatalog: CAP_MODAL_CATALOG,
        capDefaults: CAP_MODAL_DEFAULTS,
        capModes: SPECIALIST_CAP_MODES,
      };
}

/**
 * F19 UX-13 — the modes the SERVER refuses to store as submitted.
 *
 * Two rewrites happen unconditionally in `agent-profile-actions.server.ts`:
 *  - `grantsFor` (edit) / `createModalGrants` (create) — every id in
 *    `ALWAYS_HUMAN_CAPABILITY_IDS` is coerced to `human` "whatever the
 *    submitted form says";
 *  - the same two functions — `report-validation-verdict` persists `direct`
 *    iff the form said `direct`, and `off` for every other value.
 *
 * The picker used to offer the rewritten modes anyway: an admin could set
 * "Merge a pull request" to Allowed, get a success toast, and find it back on
 * Human-only; picking "Human-only" for the verdict silently stored `off`, which
 * the policy surfaces then count in a different bucket than the one chosen. The
 * control now refuses what the server refuses instead of accepting and
 * discarding it — the same locked treatment (`.cap-seg.locked`) the Policy sheet
 * already uses for its human-authorized boundary (`WorkflowRules` in
 * policy-page.tsx).
 */
export const ALWAYS_HUMAN = new Set<string>(ALWAYS_HUMAN_CAPABILITY_IDS);
export const VERDICT_CAP_ID = "report-validation-verdict";

/** Owner ruling (2026-08-20): a granted browser carries web egress with it —
 * the browser IS egress, and `resolveBrowserMcp` refuses to mount the pair in
 * disagreement, so the editor never lets the disagreement exist. Applied on
 * every state write AND on seed (a stored profile from before the rule can
 * still carry the contradiction; the save layer repairs it identically, so
 * seeding it coupled shows the admin what the next save persists — the same
 * F19 UX-13 round-trip honesty the verdict row follows below). */
export function coupleGrants(sel: CapSelection): CapSelection {
  return sel[BROWSER_CAP_ID] === "direct" &&
    sel[WEB_EGRESS_CAP_ID] !== "direct"
    ? { ...sel, [WEB_EGRESS_CAP_ID]: "direct" }
    : sel;
}

export function seedCaps(
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

/** The fields a save requires, as the form holds them. */
export interface ProfileDraft {
  name: string;
  role: string;
  backend: "codex" | "claude" | "";
  stg: string[];
  model: string;
}

/** A requirement a save can still miss, in the order the form asks for them. */
export type Requirement = "name" | "role" | "backend" | "stages" | "model";

/** Where the form stands against what a save requires. */
export interface SaveReadiness {
  /** Name and role (not on the operator's editor), a backend and a stage. */
  fieldsValid: boolean;
  /** A backend with no model for it yet (F21-13). */
  modelPending: boolean;
  valid: boolean;
  /** The first unmet requirement, which a refused save puts the person on. */
  missing: Requirement | null;
}

export function saveReadiness(draft: ProfileDraft, isOperator: boolean): SaveReadiness {
  const { name, role, backend, stg, model } = draft;
  // Ruling 176: the operator's editor has no name or role to fill.
  const identityValid = isOperator || Boolean(name.trim() && role.trim());
  const fieldsValid = Boolean(identityValid && backend && stg.length);
  // F21-13: this profile has a backend but no model for it — `pickBackend`
  // cleared the previous backend's id and the new catalog has not answered yet
  // (or, in create mode, none has). Save is HELD for that whole window and the
  // footer hint (`footHint`) says why: a save inside it is exactly how a Codex
  // model id reached a Claude-pinned profile. Deliberately NOT "the fetch is in
  // flight": opening the editor also fetches, and a stored model that is
  // already coherent with its own backend must not lock Save behind a
  // round-trip.
  const modelPending = Boolean(backend) && model === "";
  const valid = fieldsValid && !modelPending;
  const missing: Requirement | null =
    !isOperator && !name.trim()
      ? "name"
      : !isOperator && !role.trim()
        ? "role"
        : !backend
          ? "backend"
          : stg.length === 0
            ? "stages"
            : modelPending
              ? "model"
              : null;
  return { fieldsValid, modelPending, valid, missing };
}

/** What the footer's requirements line says about the form. */
export interface FootHintInput {
  /** Server-side failure copy, which wins over every other sentence. */
  error: string | null;
  isOperator: boolean;
  readiness: SaveReadiness;
  catalogLoading: boolean;
  catalogFailed: boolean;
  /** The picked backend's label, "" when none is picked. */
  backendLabel: string;
  /** The profile being edited, null in create mode. */
  initial: AgentProfileView | null;
  forksTemplate: boolean;
  projectName: string;
}

export function footHint(input: FootHintInput): string {
  const { error, isOperator, readiness, catalogLoading, catalogFailed } = input;
  const { backendLabel, initial, forksTemplate, projectName } = input;
  return error
    ? error
    : !readiness.fieldsValid
      ? isOperator
        ? "One execution backend and at least one stage are required."
        : "Name, role, one execution backend, and at least one stage are required."
      : // F21-13: the reason Save is disabled, in the same place every other
        // reason is given. Silence here is what made the disabled button read as
        // a glitch — and, before the hold existed, what let the click through.
        readiness.modelPending
        ? catalogLoading
          ? `Loading the models available on ${backendLabel}. Saving is held until this profile has one of them.`
          : catalogFailed
            ? // D5: don't say "pick a model" over an empty picker — the fetch failed.
              `Couldn't load the models available on ${backendLabel}. Retry above, then pick one. Saving is held until this profile has a model.`
            : `Pick a model available on ${backendLabel}. Saving is held until this profile has one.`
        : initial
          ? forksTemplate
            ? `Ready to save: this forks ${initial.name} for ${projectName}.`
            : "Ready to save changes."
          : `Ready to add to ${projectName}.`;
}

/** The hint beside the Model label: the load in flight, a failed load, or
 *  what the field is. */
export function modelHint(catalogLoading: boolean, catalogFailed: boolean): string {
  return catalogLoading
    ? "loading available models…"
    : catalogFailed
      ? "couldn't load the models"
      : "the model this profile runs on";
}

/** A seeded model the served catalog does not list (a dated Claude id or a
 *  family alias that runs verbatim), which the select keeps as an option of its
 *  own rather than showing a model that would not run. */
export function seededOffCatalog(
  backend: "codex" | "claude" | "",
  model: string,
  catalog: ModelCatalog | null,
): boolean {
  return Boolean(
    backend && model && catalog && !catalog.models.some((m) => m.value === model),
  );
}
