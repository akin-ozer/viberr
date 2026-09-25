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
 * profile holds that are OUTSIDE its kind's toggle set are preserved untouched
 * by the editor (pass-4 ruling 7 — advisory ids with no runtime consumer get
 * no toggle; `group: null` in the unified catalog). The matrix files the
 * operator's own capabilities under "Operator actions" and the advisory lines
 * under its collapsed "Advisory only" list, never in the grid (ruling 479(a)).
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
    const def = entry.defaultMode === "off" ? "direct" : entry.defaultMode;
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
    mode: g.mode === "human" ? "human" : "off",
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
 * authority beside the real ones. Both surfaces read the SAME stored grants
 * through the one server-side interpretation (`capabilitiesToActionLabels`).
 *
 * Ruling 479(a): the capability matrix partitions by this set too. Its grid is
 * the agent editor catalog plus an "Operator actions" group (the labels in this
 * set outside that catalog), and everything outside this set is an advisory
 * line, listed collapsed under the grid. So the grid, the panel's columns and
 * the Policy page's counts all count the same capabilities.
 */
export const GOVERNED_CAP_LABELS: ReadonlySet<string> = new Set(
  UNIFIED_CAP_CATALOG.filter((e) => e.group !== null).map((e) => e.label),
);

/**
 * D32-9 (owner ruling, pass 32): ONE vocabulary for capability modes on every
 * surface — the editor radios, the matrix cells and legend, the agent card
 * columns and the Policy counts. The file ids (direct | recommend | human |
 * off) are unchanged; only the words are. Before: "Allowed" (project editor),
 * "ACTS DIRECTLY" (card), "direct" (policy counts), "Reserved for humans" /
 * "Not granted" (matrix) all named the same four states.
 */
export const MODE_LABEL = {
  direct: "Acts directly",
  recommend: "Recommends only",
  human: "Human-only",
  off: "Off",
} as const satisfies Record<CapMode, string>;

/** The OPERATOR capability picker's modes — all 4, because `recommend`
 * (propose a card a human applies) has real semantics for the operator. */
export const OPERATOR_CAP_MODES: readonly { id: CapMode; label: string }[] = [
  { id: "direct", label: MODE_LABEL.direct },
  { id: "recommend", label: MODE_LABEL.recommend },
  { id: "human", label: MODE_LABEL.human },
  { id: "off", label: MODE_LABEL.off },
];

/** The SPECIALIST capability picker's modes — 3 HONEST values (R7-5).
 * `recommend` is omitted: it is an operator-only concept, and at runtime a
 * specialist `recommend` grant is identical to `direct` (F7-CAP1). Same words
 * as every other surface (D32-9). */
export const SPECIALIST_CAP_MODES: readonly { id: CapMode; label: string }[] = [
  { id: "direct", label: MODE_LABEL.direct },
  { id: "human", label: MODE_LABEL.human },
  { id: "off", label: MODE_LABEL.off },
];

/** Capability-policy column meta (mock CAP_META — icon repeats per row). The
 *  `forbidden` bucket is the `human` mode under its column name. */
export const CAP_META = {
  direct: { label: MODE_LABEL.direct, icon: "check" },
  recommend: { label: MODE_LABEL.recommend, icon: "arrow" },
  forbidden: { label: MODE_LABEL.human, icon: "lock" },
} as const;

// ------------------------------------------------------- context resources

export interface ResCatalogGroup {
  group: string;
  key: "skills" | "mcps" | "kb";
  mono: boolean;
  /** `id` is the STORE KEY the grant is written as — a skill folder, an MCP
   *  registry name, a knowledge-base directory. `label` is what a human reads
   *  when the store keeps a separate display name for it; absent means the key
   *  is the name. Ruling 106 settled this for the controller tab and the global
   *  template editor ("KBs displayed by name and stored by dir"); pass 33's
   *  U33-7 found the PROJECT editor was never brought along, so one concept had
   *  two vocabularies depending on which editor you opened. */
  items: { id: string; def: boolean; label?: string; warning?: ResItemWarning }[];
}

/**
 * Ruling 479(b): what the registry knows against one MCP server, when a run
 * would get none of its tools anyway: a sign-in it does not have (ruling 469),
 * a credential it cannot open, a last check that could not reach it. `note` is
 * the chip's word, `title` the sentence with the remedy. Absent claims nothing.
 */
export interface ResItemWarning {
  note: string;
  title: string;
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

// ------------------------------------------ patch refusal (ruling 139)

/** One capability patch as the controller's `update_agent_deployment` takes
 *  it: an id and the mode to set. */
export interface CapabilityPatch {
  capabilityId: string;
  mode: CapMode;
}

/** The ids the catalogue offers `kind` a toggle for. */
function toggleableIdsFor(kind: CapabilityKind): ReadonlySet<string> {
  return kind === "operator" ? OPERATOR_CAP_IDS : MODAL_CAP_IDS;
}

const ALWAYS_HUMAN_IDS: ReadonlySet<string> = new Set(
  UNIFIED_CAP_CATALOG.filter((e) => e.defaultMode === "human" && !e.promotable).map(
    (e) => e.id,
  ),
);

/** The matrix-only advisory ids (`group: null`): stored, displayed, never
 *  toggled. */
const ADVISORY_IDS: ReadonlySet<string> = new Set(
  UNIFIED_CAP_CATALOG.filter((e) => e.group === null).map((e) => e.id),
);

const KIND_WORD = {
  operator: "the operator",
  agent: "a specialist",
} as const satisfies Record<CapabilityKind, string>;

/**
 * Ruling 139 (pass 34, F34-2): the refusal sentence for a set of capability
 * patches aimed at a deployment of `kind`, or null when every patch is legal.
 * Built ONLY from the catalogue sets already in this module, so it can never
 * drift from what the editor offers and what `grantsFor` persists:
 *
 *   (a) an id outside the kind's governed set is named, with the valid ids and
 *       a pointer at `list_capabilities`; an id the catalogue holds for this
 *       kind with NO toggle (matrix-only, advisory) is refused AS SUCH, never as
 *       "no such id", which would be false;
 *   (b) `recommend` on a specialist (an operator-only mode; the runtime treats
 *       it as `direct` and `grantsFor` would store `off`);
 *   (c) a non-`human` mode on an always-human id;
 *   (e) `report-validation-verdict` at a mode other than `direct` or `off`
 *       (`grantsFor` forces exactly those two, so `human` would store `off`
 *       while the tool answered done).
 *
 * The check lives on the WRITE SURFACES that take a typed argument (the
 * controller tools), not in `grantsFor`: the project editor legitimately
 * preserves advisory and retired ids a strict check would refuse. Client-safe
 * copy (this module ships in the browser bundle): no dashes.
 */
export function capabilityPatchRefusal(
  kind: CapabilityKind,
  patches: readonly CapabilityPatch[],
): string | null {
  const toggleable = toggleableIdsFor(kind);
  const valid = [...toggleable].join(", ");
  for (const patch of patches) {
    const id = patch.capabilityId;
    if (!toggleable.has(id)) {
      if (ADVISORY_IDS.has(id)) {
        return `"${id}" is a matrix-only capability with no toggle: it describes persona guidance and cannot be granted or withheld. Nothing was written. The ids ${KIND_WORD[kind]} takes are: ${valid} (see list_capabilities).`;
      }
      const otherKind: CapabilityKind = kind === "operator" ? "agent" : "operator";
      const belongsToOther = toggleableIdsFor(otherKind).has(id);
      return belongsToOther
        ? `"${id}" is ${KIND_WORD[otherKind] === "the operator" ? "an operator" : "a specialist"} capability and cannot be set on ${KIND_WORD[kind]}. Nothing was written. The ids ${KIND_WORD[kind]} takes are: ${valid} (see list_capabilities).`
        : `No capability answers to "${id}". Nothing was written. The ids ${KIND_WORD[kind]} takes are: ${valid} (see list_capabilities).`;
    }
    if (kind === "agent" && patch.mode === "recommend") {
      return `"${id}" cannot be set to recommend on a specialist: recommend is an operator-only mode (a specialist runs a grant directly or not at all). Use direct, human or off. Nothing was written.`;
    }
    if (ALWAYS_HUMAN_IDS.has(id) && patch.mode !== "human") {
      return `"${id}" is reserved for humans and can only be human. Nothing was written.`;
    }
    if (id === "report-validation-verdict" && patch.mode !== "direct" && patch.mode !== "off") {
      return `"report-validation-verdict" takes only direct or off: verdict authority is explicit and is never widened or reserved. Nothing was written.`;
    }
  }
  return null;
}
