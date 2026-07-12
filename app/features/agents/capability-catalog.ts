import { capabilityById } from "~/shared/capabilities";

/**
 * The MODAL capability catalog (design/html-app/app/agents.jsx CAP_CATALOG,
 * ported verbatim) re-keyed onto the shared id-based CAP_CATALOG
 * (app/shared/capabilities.ts — orchestrator ruling 7). The mock's short ids
 * (`read`, `merge`, …) are replaced by the canonical catalog ids; labels are
 * rendered FROM the shared catalog so the two can never drift (asserted in
 * capability-catalog.test.ts).
 *
 * Grouping + per-capability default modes drive the create/edit-profile
 * modal accordion and the CapabilityMatrixModal row groups. Capabilities a
 * profile holds that are OUTSIDE this curated set (e.g. the operator's
 * coordination actions) surface in the matrix's "Other actions" group and
 * are preserved untouched by the edit modal.
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

function cap(id: string, def: Exclude<CapMode, "off">): ModalCap {
  const found = capabilityById(id);
  return { id, label: found ? found.label : id, def };
}

// The toggleable specialist catalog holds ONLY capabilities whose mode is
// actually CONSULTED at runtime (pass-4 ruling 7 — "prune the fake toggles").
// Every id here binds via the specialist tool denylist
// (specialist-tool-policy.ts) or is a structural always-human lock. The former
// advisory rows (read-task-repo, run-validation-suites, author-test-cases,
// attach-evidence-references, post-quality-flags, comment-on-task,
// report-validation-verdict, approve-review, request-changes,
// flag-underspecified-tasks, move-task-to-review) had ZERO runtime references —
// setting them to human/off did nothing — so they are no longer presented as
// toggles. A profile that still carries them shows them read-only + advisory in
// the capability matrix's "Other actions" group.
export const CAP_MODAL_CATALOG: readonly ModalCapGroup[] = [
  {
    group: "Repository & execution",
    caps: [
      cap("create-task-branch", "direct"),
      cap("commit-push-branch", "direct"),
      // XS-8: `execute-code-or-write-repo` IS enforced (its withhold removes
      // Edit/Write/MultiEdit/NotebookEdit + denies git commit) but was
      // previously inexpressible in the modal.
      cap("execute-code-or-write-repo", "direct"),
      cap("open-review-pr", "recommend"),
    ],
  },
  {
    group: "Reserved for humans",
    caps: [
      cap("merge-pull-request", "human"),
      cap("transition-to-done", "human"),
      cap("change-project-policy", "human"),
    ],
  },
];

/** Every capability id the modal governs (others are preserved untouched). */
export const MODAL_CAP_IDS: ReadonlySet<string> = new Set(
  CAP_MODAL_CATALOG.flatMap((g) => g.caps.map((c) => c.id)),
);

/** Default mode per modal capability (create-mode seeding). */
export const CAP_MODAL_DEFAULTS: Readonly<Record<string, CapMode>> =
  Object.fromEntries(
    CAP_MODAL_CATALOG.flatMap((g) => g.caps.map((c) => [c.id, c.def])),
  );

/**
 * The OPERATOR's coordination capabilities — what the operator RBAC editor
 * shows when editing the operator profile (assignment recommend/assign/off,
 * governance modes). Distinct from the specialist catalog above.
 */
export const OPERATOR_CAP_CATALOG: readonly ModalCapGroup[] = [
  {
    group: "Assignment",
    caps: [
      cap("assign-primary-specialist", "direct"),
      cap("summon-reviewers", "direct"),
    ],
  },
  {
    group: "Coordination",
    caps: [
      cap("generate-packets", "direct"),
      cap("append-typed-events", "direct"),
    ],
  },
  {
    group: "Permissions",
    caps: [
      cap("stage-transitions", "recommend"),
      cap("completion-for-acceptance", "recommend"),
    ],
  },
];

/** Every operator capability id the operator editor governs. */
export const OPERATOR_CAP_IDS: ReadonlySet<string> = new Set(
  OPERATOR_CAP_CATALOG.flatMap((g) => g.caps.map((c) => c.id)),
);

/** Default mode per operator capability. */
export const OPERATOR_CAP_DEFAULTS: Readonly<Record<string, CapMode>> =
  Object.fromEntries(
    OPERATOR_CAP_CATALOG.flatMap((g) => g.caps.map((c) => [c.id, c.def])),
  );

export const CAP_MODES: readonly { id: CapMode; label: string }[] = [
  { id: "direct", label: "Direct" },
  { id: "recommend", label: "Recommend" },
  { id: "human", label: "Human" },
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
