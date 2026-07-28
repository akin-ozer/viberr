import {
  defaultGrantsFor,
  UNIFIED_CAP_CATALOG,
  type CapabilityKind,
} from "~/shared/capabilities";

/**
 * Per-kind editor views DERIVED from the unified capability catalog
 * (app/shared/capabilities.ts UNIFIED_CAP_CATALOG — generic-agents plan,
 * 2026-07-19). The former hand-maintained CAP_MODAL_CATALOG /
 * OPERATOR_CAP_CATALOG pair is now a projection: `kinds` + `group` on the
 * unified entry decide which editor shows which toggle, so the two views can
 * never drift from the catalog (asserted in capability-catalog.test.ts).
 *
 * Grouping + per-capability default modes drive the create/edit-profile
 * modal accordion and the CapabilityMatrixModal row groups. Capabilities a
 * profile holds that are OUTSIDE its kind's toggle set surface in the
 * matrix's "Other actions" group and are preserved untouched by the editor
 * (pass-4 ruling 7 — advisory ids with no runtime consumer get no toggle;
 * `group: null` in the unified catalog).
 */

export type CapMode = "direct" | "recommend" | "human" | "off";

export interface ModalCap {
  /** Shared CAP_CATALOG id. */
  id: string;
  label: string;
  def: Exclude<CapMode, "off">;
}

export interface ModalCapGroup {
  group: string;
  caps: ModalCap[];
}

/** Editor view for one profile kind: the unified entries applicable to that
 * kind that carry a toggle group, in catalog order, grouped. */
function editorCatalog(kind: CapabilityKind): readonly ModalCapGroup[] {
  const groups: ModalCapGroup[] = [];
  for (const entry of UNIFIED_CAP_CATALOG) {
    if (!entry.kinds.includes(kind) || entry.group === null) continue;
    // `off` defaults still render a toggle; the editor seeds them unchecked.
    const def = (entry.defaultMode === "off" ? "direct" : entry.defaultMode) as
      Exclude<CapMode, "off">;
    let group = groups.find((g) => g.group === entry.group);
    if (!group) {
      group = { group: entry.group, caps: [] };
      groups.push(group);
    }
    group.caps.push({ id: entry.id, label: entry.label, def });
  }
  return groups;
}

/** The generic-AGENT editor catalog (every non-operator profile). */
export const CAP_MODAL_CATALOG: readonly ModalCapGroup[] = editorCatalog("agent");

/** Every capability id the agent editor governs (others preserved untouched). */
export const MODAL_CAP_IDS: ReadonlySet<string> = new Set(
  CAP_MODAL_CATALOG.flatMap((g) => g.caps.map((c) => c.id)),
);

/** Default mode per agent capability (create-mode seeding) — honors the
 * unified catalog's real default (e.g. report-validation-verdict seeds `off`
 * so a new profile never silently acquires acceptance-veto power — G2/R2). */
export const CAP_MODAL_DEFAULTS: Readonly<Record<string, CapMode>> =
  Object.fromEntries(
    UNIFIED_CAP_CATALOG.filter(
      (e) => e.kinds.includes("agent") && e.group !== null,
    ).map((e) => [e.id, e.defaultMode]),
  );

/**
 * P13-AP-06 — every agent capability, EXPLICITLY WITHHELD.
 *
 * The RUN-time posture for a deployment that carries no grants at all (a
 * hand-edited or imported `project.md`): nobody granted it anything, so it gets
 * nothing — the same stance `resolveUndeployedDisallowedTools` takes.
 *
 * P14-LV-01 made the tool layer itself deny an ABSENT delivery/verdict grant, so
 * this is no longer the only thing standing between `capabilities: []` and full
 * repo-write. It stays because it makes the withholding VISIBLE — the capability
 * matrix and the agent panel render these grants, so an admin sees "withheld"
 * rather than an empty policy they have to know how to read.
 *
 * Derived from the same catalog list as the defaults so the two can't drift;
 * only the modes differ (always-human ids stay `human`, the rest become `off`).
 */
export function withheldAgentGrants(): { capabilityId: string; mode: CapMode }[] {
  return defaultGrantsFor("agent").map((g) => ({
    capabilityId: g.capabilityId,
    mode: (g.mode === "human" ? "human" : "off") as CapMode,
  }));
}

/** The OPERATOR editor catalog — derived from the same unified source. */
export const OPERATOR_CAP_CATALOG: readonly ModalCapGroup[] =
  editorCatalog("operator");

/** Every operator capability id the operator editor governs. */
export const OPERATOR_CAP_IDS: ReadonlySet<string> = new Set(
  OPERATOR_CAP_CATALOG.flatMap((g) => g.caps.map((c) => c.id)),
);

/** Default mode per operator capability. */
export const OPERATOR_CAP_DEFAULTS: Readonly<Record<string, CapMode>> =
  Object.fromEntries(
    UNIFIED_CAP_CATALOG.filter(
      (e) => e.kinds.includes("operator") && e.group !== null,
    ).map((e) => [e.id, e.defaultMode]),
  );

/**
 * Every capability label that carries an editor toggle for SOME kind — i.e. the
 * governed policy surface, operator and agent alike.
 *
 * F15-05/F15-06: the profile detail panel used to pour every stored grant into
 * its three capability columns, so the matrix-only advisory ids (`group: null` —
 * "Approve the review", "Read the repository & diff", …) rendered as held
 * authority beside the real ones. The matrix already segregates them ("Other
 * actions"); this is the same partition, so both surfaces read one policy the
 * same way.
 */
export const GOVERNED_CAP_LABELS: ReadonlySet<string> = new Set(
  UNIFIED_CAP_CATALOG.filter((e) => e.group !== null).map((e) => e.label),
);

/** The OPERATOR capability picker's modes — all 4, because `recommend`
 * (propose a card a human applies) has real semantics for the operator. */
export const OPERATOR_CAP_MODES: readonly { id: CapMode; label: string }[] = [
  { id: "direct", label: "Direct" },
  { id: "recommend", label: "Recommend" },
  { id: "human", label: "Human" },
  { id: "off", label: "Off" },
];

/** The SPECIALIST capability picker's modes — 3 HONEST values (R7-5).
 * `recommend` is omitted: it is an operator-only concept, and at runtime a
 * specialist `recommend` grant is identical to `direct` (F7-CAP1). Labels are
 * chosen for a specialist's mental model — "Allowed" persists `direct`,
 * "Human-only" persists `human`, "Off" persists `off`. */
export const SPECIALIST_CAP_MODES: readonly { id: CapMode; label: string }[] = [
  { id: "direct", label: "Allowed" },
  { id: "human", label: "Human-only" },
  { id: "off", label: "Off" },
];

/** Capability-policy column meta (mock CAP_META — icon repeats per row). */
export const CAP_META = {
  direct: { label: "Acts directly", icon: "check" },
  recommend: { label: "Recommends only", icon: "arrow" },
  forbidden: { label: "Reserved for humans", icon: "lock" },
} as const;

// ------------------------------------------------------- context resources

export interface ResCatalogGroup {
  group: string;
  key: "skills" | "mcps" | "kb";
  mono: boolean;
  items: { id: string; def: boolean }[];
}

export interface ResourceSelection {
  skills: string[];
  mcps: string[];
  kb: string[];
}

// The agent-profile picker is fed the project's REAL resource catalog
// (`buildResourceCatalog` — live disk skills/KBs + org MCP registry); a new
// profile starts with an EMPTY selection and the creator grants from that live
// catalog. The old mock `RES_CATALOG`/`RES_DEFAULTS` (pre-checked ids like
// `repo-write` / "Coding standards" that resolved to no real resource) are gone.
