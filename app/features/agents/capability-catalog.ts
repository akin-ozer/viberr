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

export const CAP_MODAL_CATALOG: readonly ModalCapGroup[] = [
  {
    group: "Repository & execution",
    caps: [
      cap("read-task-repo", "direct"),
      cap("comment-on-task", "direct"),
      cap("create-task-branch", "direct"),
      cap("commit-push-branch", "direct"),
      cap("open-review-pr", "recommend"),
      cap("edit-other-task-branch", "human"),
    ],
  },
  {
    group: "Validation & review",
    caps: [
      cap("run-validation-suites", "direct"),
      cap("author-test-cases", "direct"),
      cap("attach-evidence-references", "direct"),
      cap("post-quality-flags", "direct"),
      cap("report-validation-verdict", "recommend"),
      cap("approve-review", "recommend"),
      cap("request-changes", "recommend"),
      cap("flag-underspecified-tasks", "recommend"),
    ],
  },
  {
    group: "Workflow & approvals",
    caps: [
      cap("move-task-to-review", "recommend"),
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
      cap("compress-timelines", "direct"),
    ],
  },
  {
    group: "Governance",
    caps: [
      cap("stage-transitions", "recommend"),
      cap("completion-for-acceptance", "recommend"),
      cap("owner-reassignment", "recommend"),
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

/** Grantable context resources with defaults (mock RES_CATALOG, verbatim). */
export const RES_CATALOG: readonly ResCatalogGroup[] = [
  {
    group: "Skills",
    key: "skills",
    mono: true,
    items: [
      { id: "viberr-app-expertise", def: false },
      { id: "repo-write", def: true },
      { id: "test-runner", def: true },
      { id: "lint-autofix", def: false },
      { id: "diff-review", def: false },
      { id: "security-scan", def: false },
      { id: "test-author", def: false },
      { id: "coverage-report", def: false },
      { id: "refactor", def: false },
      { id: "dependency-audit", def: false },
      { id: "domain-advisor", def: false },
    ],
  },
  {
    group: "MCP servers",
    key: "mcps",
    mono: true,
    items: [
      { id: "viberr", def: false },
      { id: "github", def: true },
      { id: "filesystem", def: false },
      { id: "http-fetch", def: false },
      { id: "postgres", def: false },
      { id: "docker", def: false },
    ],
  },
  {
    group: "Knowledge bases",
    key: "kb",
    mono: false,
    items: [
      { id: "architecture-notes", def: false },
      { id: "api-contracts", def: false },
      { id: "deploy-runbooks", def: false },
      { id: "Viberr Core architecture", def: true },
      { id: "Coding standards", def: true },
      { id: "Review checklist", def: false },
      { id: "Security guidelines", def: false },
      { id: "Test strategy", def: false },
      { id: "Product brief", def: false },
      { id: "Domain glossary", def: false },
      { id: "Prior decisions", def: false },
    ],
  },
];

export interface ResourceSelection {
  skills: string[];
  mcps: string[];
  kb: string[];
}

export const RES_DEFAULTS: ResourceSelection = {
  skills: RES_CATALOG.find((g) => g.key === "skills")!
    .items.filter((i) => i.def)
    .map((i) => i.id),
  mcps: RES_CATALOG.find((g) => g.key === "mcps")!
    .items.filter((i) => i.def)
    .map((i) => i.id),
  kb: RES_CATALOG.find((g) => g.key === "kb")!
    .items.filter((i) => i.def)
    .map((i) => i.id),
};
