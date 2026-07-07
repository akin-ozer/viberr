import type {
  AgentDeployment,
  CapabilityMode,
  ProjectFrontmatter,
} from "~/schemas/project-file.schema";
import type {
  TaskFileEvent,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { capabilityByLabel } from "~/shared/capabilities";
import {
  GOVERNED_TEMPLATE,
  LIGHTWEIGHT_TEMPLATE,
} from "~/shared/workflow/templates";
import type { AgentProfileFrontmatter } from "~/server/files/agent-profile-file.server";
import type { ActorRender } from "~/shared/mapping/actor.server";

/**
 * The demo dataset — a faithful transcription of design/html-app/app/data.js
 * (domain-model spec) into the canonical file formats. Copy is VERBATIM
 * (curly quotes, U+00B7 middots, U+2212 minus signs, Turkish characters);
 * display timestamps become back-dated local-time ISO instants so Phase 4's
 * formatter reproduces the mock strings exactly (ruling 4).
 */

// ------------------------------------------------------------- timestamps

const NOW = new Date();
const YESTERDAY = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

function at(base: Date, h: number, m: number): string {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    h,
    m,
    0,
    0,
  ).toISOString();
}

/** Mock "today H:MM" → today at that LOCAL wall-clock time. */
export function todayAt(h: number, m: number): string {
  return at(NOW, h, m);
}

/** Mock "Yesterday H:MM". */
export function yesterdayAt(h: number, m: number): string {
  return at(YESTERDAY, h, m);
}

/** Mock "Mar 30 H:MM" → March 30 of the current year. */
export function mar30At(h: number, m: number): string {
  return at(new Date(NOW.getFullYear(), 2, 30), h, m);
}

// ----------------------------------------------------------------- people

export interface SeedPerson {
  handle: "arda" | "elif" | "murat" | "selin" | "deniz";
  name: string;
  email: string;
  tone: "" | "rose" | "teal" | "violet";
  initials: string;
  orgRole: "admin" | "member";
}

/** Org roles per the phase brief: Arda admin; everyone else member.
 * (Deviation from the mock's ORG_DEFAULTS, where Elif is also org admin —
 * documented in the phase report.) */
export const SEED_PEOPLE: SeedPerson[] = [
  { handle: "arda", name: "Arda Kaya", email: "arda@viberr.dev", tone: "", initials: "AK", orgRole: "admin" },
  { handle: "elif", name: "Elif Demir", email: "elif@viberr.dev", tone: "rose", initials: "ED", orgRole: "member" },
  { handle: "murat", name: "Murat Yıldız", email: "murat@viberr.dev", tone: "teal", initials: "MY", orgRole: "member" },
  { handle: "selin", name: "Selin Aksoy", email: "selin@viberr.dev", tone: "violet", initials: "SA", orgRole: "member" },
  // Registered app user, NOT a member of any seeded project (guest).
  { handle: "deniz", name: "Deniz Şahin", email: "deniz@viberr.dev", tone: "", initials: "DŞ", orgRole: "member" },
];

export type SeedUserIds = Record<SeedPerson["handle"], string>;

// ------------------------------------------------------------- actor refs

const codexRef = (role: string) =>
  ({ kind: "agent", backend: "codex", role }) as const;
const claudeRef = (role: string) =>
  ({ kind: "agent", backend: "claude", role }) as const;
const OP = { kind: "operator" } as const;
const POLICY_ENGINE = { kind: "system", systemId: "policy-engine" } as const;

function humanRef(ids: SeedUserIds, handle: SeedPerson["handle"]) {
  const person = SEED_PEOPLE.find((p) => p.handle === handle)!;
  return { kind: "human", userId: ids[handle], nameHint: person.name } as const;
}

function humanRender(ids: SeedUserIds, handle: SeedPerson["handle"]): ActorRender {
  const person = SEED_PEOPLE.find((p) => p.handle === handle)!;
  return {
    kind: "human",
    userId: ids[handle],
    name: person.name,
    initials: person.initials,
    tone: person.tone,
  };
}

const OPERATOR_RENDER: ActorRender = { kind: "agent", name: "Operator" };
const POLICY_ENGINE_RENDER: ActorRender = { kind: "system", name: "Policy engine" };
const CLAUDE_REVIEWER_RENDER: ActorRender = {
  kind: "agent",
  backend: "claude",
  name: "Claude Code",
  role: "Reviewer",
};

// ------------------------------------------------------- agent profiles

interface ProfileActionSpec {
  direct: string[];
  recommend: string[];
  forbidden: string[];
}

/** Maps mock action-label lists onto CAP_CATALOG ids; labels with no exact
 * catalog match stay as display-only extras (contracts §7 #7). */
export function mapActions(actions: ProfileActionSpec): {
  capabilities: { capabilityId: string; mode: CapabilityMode }[];
  extras: { label: string; mode: CapabilityMode }[];
} {
  const capabilities: { capabilityId: string; mode: CapabilityMode }[] = [];
  const extras: { label: string; mode: CapabilityMode }[] = [];
  const add = (labels: string[], mode: CapabilityMode) => {
    for (const label of labels) {
      const def = capabilityByLabel(label);
      if (def) capabilities.push({ capabilityId: def.id, mode });
      else extras.push({ label, mode });
    }
  };
  add(actions.direct, "direct");
  add(actions.recommend, "recommend");
  add(actions.forbidden, "human");
  return { capabilities, extras };
}

export interface SeedAgentProfile {
  frontmatter: AgentProfileFrontmatter;
  description: string;
}

interface ProfileBase {
  id: string;
  kind: "operator" | "specialist";
  name: string;
  role: string;
  icon: string;
  backends: ("codex" | "claude")[];
  model: string;
  scope: string;
  stages: string[];
  spanAll?: boolean;
  resources: { skills: string[]; mcps: string[]; kb: string[] };
}

function profile(
  base: ProfileBase,
  actions: ProfileActionSpec,
  description: string,
): SeedAgentProfile {
  const { capabilities, extras } = mapActions(actions);
  return {
    frontmatter: {
      ...base,
      spanAll: base.spanAll ?? false,
      capabilities,
      extras,
    },
    description,
  };
}

export const SEED_AGENT_PROFILES: SeedAgentProfile[] = [
  profile(
    {
      id: "operator", kind: "operator", name: "Operator", role: "Task coordinator",
      icon: "shield", backends: ["claude", "codex"], model: "orchestration runtime",
      scope: "System role · one per active task",
      stages: ["triage", "ready", "impl", "review", "done"], spanAll: true,
      resources: {
        // Real, non-placeholder resources: the shipped skill, the actual
        // in-process governance MCP server ("viberr"), and a real KB on disk.
        skills: ["viberr-app-expertise"],
        mcps: ["viberr"],
        kb: ["architecture-notes"],
      },
    },
    {
      direct: ["Assign the primary specialist", "Summon reviewer specialists", "Generate decision & blocking packets", "Append typed important events", "Compress long-running timelines"],
      recommend: ["Stage transitions", "Completion for human acceptance", "Owner re-assignment"],
      forbidden: ["Execute code or write to the repo", "Transition a task to Done", "Change project policy"],
    },
    "A dedicated operator is instantiated for every active task. It coordinates specialists, keeps the canonical task file authoritative, and turns agent work into concise decision packets for human review. It never writes code and never closes a task itself.",
  ),
  profile(
    {
      id: "developer", kind: "specialist", name: "Developer", role: "Implementation",
      icon: "branch", backends: ["codex", "claude"], model: "gpt-5.5",
      scope: "Global base · customized for Viberr Core",
      stages: ["ready", "impl"],
      resources: {
        skills: ["developer-expertise"],
        mcps: ["github", "filesystem"],
        kb: ["Viberr Core architecture", "Coding standards"],
      },
    },
    {
      direct: ["Create the task-key branch", "Commit & push to the branch", "Run unit & integration validation", "Open the review pull request"],
      recommend: ["Move the task to Review", "Report a validation verdict"],
      forbidden: ["Merge a pull request", "Transition a task to Done", "Edit another task's branch"],
    },
    "Implements stage work on the task-key branch: writes code, runs local validation, and opens the review PR. Hands back to the operator at the review boundary.",
  ),
  profile(
    {
      id: "reviewer", kind: "specialist", name: "Reviewer", role: "Code review",
      icon: "check", backends: ["claude"], model: "sonnet",
      scope: "Global base · customized for Viberr Core",
      stages: ["review"],
      resources: {
        skills: ["reviewer-expertise"],
        mcps: ["github"],
        kb: ["Review checklist", "Security guidelines"],
      },
    },
    {
      direct: ["Read the repository & diff", "Run validation suites", "Post quality-flag events", "Comment on the task"],
      recommend: ["Approve the review", "Request changes"],
      // "Push commits to the branch" is a known near-miss → stays an extra.
      forbidden: ["Merge a pull request", "Transition a task to Done", "Push commits to the branch"],
    },
    "Reviews the diff at the review boundary, raises typed quality flags, and recommends approve or request-changes. Re-anchors on the canonical task file before each review.",
  ),
  profile(
    {
      id: "tester", kind: "specialist", name: "Tester", role: "Validation",
      icon: "bolt", backends: ["codex"], model: "gpt-5.5",
      scope: "Global base · default settings",
      stages: ["impl", "review"],
      resources: {
        skills: ["tester-expertise"],
        mcps: ["github", "filesystem"],
        kb: ["Test strategy"],
      },
    },
    {
      // "Run the validation suite" is a known near-miss → stays an extra.
      direct: ["Author test cases", "Run the validation suite", "Attach evidence references"],
      recommend: ["Validation verdict", "Hold the task on failing checks"],
      forbidden: ["Merge a pull request", "Transition a task to Done"],
    },
    "Authors and runs the validation suite, attaches evidence to the task, and reports a clear pass/fail verdict — keeping raw validation output out of the timeline.",
  ),
  profile(
    {
      id: "consultant", kind: "specialist", name: "Advisor", role: "Advisory",
      icon: "message", backends: ["claude", "codex"], model: "sonnet",
      scope: "Global base · customized for Viberr Core",
      stages: ["triage", "ready", "impl", "review"],
      resources: {
        skills: ["domain-advisor"],
        mcps: ["github"],
        kb: ["Product brief", "Domain glossary", "Prior decisions"],
      },
    },
    {
      direct: ["Read the task & repository", "Comment with guidance"],
      recommend: ["Flag underspecified tasks"],
      forbidden: ["Write to the repository", "Open or merge a PR", "Any stage transition"],
    },
    "Persistent expert memory the operator can re-engage across stages. Reads and advises only — never writes to the repository or moves the task.",
  ),
];

// --------------------------------------------------------------- projects

export interface SeedProject {
  frontmatter: ProjectFrontmatter;
  description: string;
}

/** The default agent roster deployed into a project — the operator plus the
 *  base specialists, each carrying its capability policy. Used by the demo seed
 *  AND by app-created projects so the operator (and specialists it can assign)
 *  are preinstalled in every project. */
export function defaultAgentDeployments(): AgentDeployment[] {
  return deployments();
}

/** Just the operator's deployment (profileId + its capability policy) — used to
 *  backfill the operator into projects that predate it (ensureBaseAgentsDeployed). */
export function operatorDeployment(): AgentDeployment {
  const op = deployments().find((d) => d.profileId === "operator");
  if (!op) throw new Error("operator profile missing from SEED_AGENT_PROFILES");
  return op;
}

/** Profile ids of the built-in agents preinstalled on EVERY board: the operator
 *  plus the base specialists a task actually needs (Developer, Reviewer, Tester).
 *  The Advisor is offered to new projects (defaultAgentDeployments) but not
 *  force-backfilled, so it never appears on a board that never wanted it. */
export const BASE_AGENT_PROFILE_IDS = [
  "operator",
  "developer",
  "reviewer",
  "tester",
] as const;

/** The built-in agent deployments backfilled into every project so the operator
 *  and its core specialists are usable across all boards (ensureBaseAgentsDeployed). */
export function baseAgentDeployments(): AgentDeployment[] {
  const wanted = new Set<string>(BASE_AGENT_PROFILE_IDS);
  return deployments().filter((d) => wanted.has(d.profileId));
}

function deployments(): AgentDeployment[] {
  return SEED_AGENT_PROFILES.map((p) => {
    const { capabilities, extras } = {
      capabilities: p.frontmatter.capabilities,
      extras: p.frontmatter.extras,
    };
    return { profileId: p.frontmatter.id, capabilities, extras };
  });
}

export function seedProjects(ids: SeedUserIds): SeedProject[] {
  return [
    {
      frontmatter: {
        name: "Viberr Core",
        slug: "viberr-core",
        repo: "akin-ozer/viberr",
        defaultBranch: "main",
        taskPrefix: "VIB",
        nextTaskNumber: 169,
        stages: GOVERNED_TEMPLATE.stages,
        workflow: GOVERNED_TEMPLATE.workflow,
        members: [
          { userId: ids.elif, role: "admin" },
          { userId: ids.arda, role: "admin" },
          { userId: ids.murat, role: "maintainer" },
          { userId: ids.selin, role: "reviewer" },
        ],
        agents: deployments(),
        credentialPolicy: {
          credentialLabel: "viberr-bot · fine-grained PAT",
          masked: "github_pat_••••42af",
          requiredScopes: ["repo", "workflow", "read:org", "pull_request:write"],
        },
        guardrails: [
          { id: "meaningful-comment", desc: "Agent comments must add information — status chatter is rejected before it reaches the timeline.", on: true },
          { id: "operator-brevity", desc: "Operator packets keep to observed → changed → recommended → decision required.", on: true },
          { id: "no-duplicate-summary", desc: "A summary that restates an earlier one is dropped instead of appended.", on: true },
          { id: "compression-threshold", desc: "Long timelines compress once routine events pass the threshold; typed events are always kept.", on: true, value: 40, unit: "events" },
          { id: "evidence-separation", desc: "Raw validation output stays in evidence references — never inline in the task record.", on: true },
        ],
      },
      description:
        "Viberr Core is the canonical delivery workspace: agents do the stage work, humans govern flow, review and acceptance. Tasks live as markdown files in this store — the board, timelines and packets you see in the app are projections of these files.",
    },
    {
      frontmatter: {
        name: "Deploy Pipeline",
        slug: "deploy-pipeline",
        repo: "akin-ozer/deploy-pipeline",
        defaultBranch: "main",
        taskPrefix: "DEP",
        nextTaskNumber: 32,
        stages: GOVERNED_TEMPLATE.stages,
        workflow: GOVERNED_TEMPLATE.workflow,
        members: [
          { userId: ids.arda, role: "admin" },
          { userId: ids.elif, role: "maintainer" },
        ],
        agents: [],
        credentialPolicy: null,
        guardrails: [],
      },
      description:
        "Continuous delivery pipeline for the Viberr platform. Stub project seeded so cross-project notifications navigate for real.",
    },
    {
      frontmatter: {
        name: "Billing Service",
        slug: "billing-service",
        repo: "akin-ozer/billing-service",
        defaultBranch: "main",
        taskPrefix: "BIL",
        nextTaskNumber: 10,
        stages: LIGHTWEIGHT_TEMPLATE.stages,
        workflow: LIGHTWEIGHT_TEMPLATE.workflow,
        members: [{ userId: ids.arda, role: "admin" }],
        agents: [],
        credentialPolicy: null,
        guardrails: [],
      },
      description:
        "Strict human-gate billing service. Stub project seeded so cross-project notifications navigate for real (Lightweight · 3 stages template).",
    },
  ];
}

// ------------------------------------------------------------------ tasks

export interface SeedTask {
  frontmatter: TaskFrontmatter;
  goal: string;
  packet: TaskPacket | null;
  timeline: TaskFileEvent[];
}

const REPO = null; // task-level repo override — null → project default

function fm(input: {
  key: string;
  title: string;
  stage: string;
  readiness: TaskFrontmatter["readiness"];
  waiting: TaskFrontmatter["waiting"];
  owner: string | null;
  specialist: TaskFrontmatter["specialist"];
  reviewers: TaskFrontmatter["reviewers"];
  operator: TaskFrontmatter["operator"];
  urgent: boolean;
  validation: TaskFrontmatter["validation"];
  branch: string | null;
  pr: TaskFrontmatter["pr"];
  github?: TaskFrontmatter["github"];
  createdAt: string;
  updatedAt: string;
}): TaskFrontmatter {
  return {
    key: input.key,
    title: input.title,
    stage: input.stage,
    readiness: input.readiness,
    waiting: input.waiting,
    ownerUserId: input.owner,
    specialist: input.specialist,
    reviewers: input.reviewers,
    operator: input.operator,
    recommendations: [],
    urgent: input.urgent,
    validation: input.validation,
    branch: input.branch,
    repo: REPO,
    pr: input.pr,
    github: input.github ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

const dev = (backend: "codex" | "claude") =>
  ({ profileId: "developer", backend, role: "Developer" }) as const;
const reviewer = (backend: "codex" | "claude") =>
  ({ profileId: "reviewer", backend, role: "Reviewer" }) as const;
const consultant = (backend: "codex" | "claude") =>
  ({ profileId: "consultant", backend, role: "Advisory" }) as const;

export function seedTasks(ids: SeedUserIds): SeedTask[] {
  return [
    // ------------------------------------------------------------ VIB-142
    {
      frontmatter: fm({
        key: "VIB-142",
        title: "Attach execution workspace to task runtime",
        stage: "review",
        readiness: "input_required",
        waiting: "human",
        owner: ids.arda,
        specialist: dev("codex"),
        reviewers: [reviewer("claude")],
        operator: { assignedAtStageId: "triage" },
        urgent: true,
        validation: "changed",
        branch: "vib-142-attach-workspace",
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
        github: {
          commits: [
            { sha: "a91f7c2", msg: "[VIB-142] add repo attach policy gate" },
            { sha: "4ce0b18", msg: "[VIB-142] branch reconciler + task projection" },
            { sha: "12dd9af", msg: "[VIB-142] tests for PR sync boundary" },
          ],
          changed: { files: 9, add: 412, del: 87 },
        },
        createdAt: yesterdayAt(9, 0),
        updatedAt: todayAt(9, 58),
      }),
      goal: "Let the operator attach a single GitHub repo to a task, create the task-key branch, and reflect branch + PR state back into the canonical task file without treating GitHub as the source of truth.",
      packet: {
        type: "input",
        kind: "Completion report",
        from: "operator",
        title: "Accept completion, or send back for one fix?",
        body: "The developer specialist reports the workspace attach flow is implemented and the review PR is open. All requested files changed and validation evidence is attached — but the PAT used in the run is missing `pull_request:write`, so PR status can't auto-sync after merge. Completion still requires explicit human acceptance.",
        observations: [
          { k: "Changed", v: "9 files · +412 / −87", code: true },
          { k: "Validation", v: "unit + integration green; 1 snapshot updated", code: false },
          { k: "Branch", v: "vib-142-attach-workspace · synced", code: true },
          { k: "Flag", v: "PAT scope missing pull_request:write", code: false },
        ],
        options: [
          { kind: "accept_completion", t: "Accept completion", d: "Mark task done and merge the review PR. Human-authorized.", rec: true, accept: true },
          { kind: "request_edit", t: "Request one edit", d: "Ask the developer to widen PAT scope before acceptance.", rec: false, ev: "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance." },
          { kind: "block_on_policy", t: "Block on policy", d: "Hold until Elif updates the project credential policy.", rec: false },
        ],
      },
      timeline: [
        { occurredAt: todayAt(9, 58), type: "comment", actor: humanRef(ids, "arda"), title: null, toAgent: true, evidence: null,
          text: "@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task." },
        { occurredAt: todayAt(9, 41), type: "completion", actor: codexRef("Developer"), title: "Completion report", toAgent: false,
          text: "Implemented repo attach, branch creation, and PR-sync projection. Validation green except one snapshot intentionally updated.",
          evidence: [
            { label: "unit/policy_gate_test", add: "+14", del: "0" },
            { label: "integration/pr_sync_test", add: "+38", del: "−4" },
          ] },
        { occurredAt: todayAt(9, 39), type: "github", actor: codexRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Opened **PR #318** from `vib-142-attach-workspace` into `main`." },
        { occurredAt: todayAt(9, 38), type: "policy", actor: POLICY_ENGINE, title: null, toAgent: false, evidence: null,
          text: "**Policy violation:** active PAT is missing `pull_request:write`. Auto-sync after merge will fail." },
        { occurredAt: todayAt(9, 20), type: "quality", actor: claudeRef("Reviewer"), title: null, toAgent: false, evidence: null,
          text: "**Quality flag:** snapshot `task_projection.json` changed — confirm the new compact shape is intended before review." },
        { occurredAt: todayAt(9, 2), type: "transition", actor: OP, title: null, toAgent: false, evidence: null,
          text: "**Transition request:** move VIB-142 from In Progress to Review. Branch healthy, evidence attached." },
        { occurredAt: todayAt(8, 30), type: "agent", actor: OP, title: null, toAgent: false, evidence: null,
          text: "Re-engaged **Claude Code (Reviewer)** as reviewer; re-anchored on `task.md` before review." },
        { occurredAt: todayAt(8, 12), type: "comment", actor: codexRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Branch work complete. Handing back to operator for the review boundary." },
        { occurredAt: yesterdayAt(15, 12), type: "assign", actor: humanRef(ids, "arda"), title: null, toAgent: false, evidence: null,
          text: "Took task ownership — owner is the human reviewer and acceptance authority for this task." },
      ],
    },
    // ------------------------------------------------------------ VIB-148
    {
      frontmatter: fm({
        key: "VIB-148",
        title: "Validate PAT scope before GitHub sync",
        stage: "ready",
        readiness: "input_required",
        waiting: "human",
        owner: null,
        specialist: null,
        reviewers: [],
        operator: { assignedAtStageId: "triage" },
        urgent: false,
        validation: "none",
        branch: null,
        pr: null,
        createdAt: yesterdayAt(17, 0),
        updatedAt: todayAt(8, 36),
      }),
      goal: "Pre-flight the project's GitHub credential against required scopes and surface a typed policy event if anything is missing, before any branch is created.",
      packet: null,
      timeline: [
        { occurredAt: todayAt(8, 36), type: "agent", actor: OP, title: null, toAgent: false, evidence: null,
          text: "**Quality gate:** goal and scope are executable. Waiting on a human owner for the acceptance boundary before execution is scheduled." },
        { occurredAt: todayAt(8, 20), type: "comment", actor: humanRef(ids, "elif"), title: null, toAgent: false, evidence: null,
          text: "Scoped the pre-flight checks. Needs an owner on the acceptance gate before any branch is created." },
      ],
    },
    // ------------------------------------------------------------ VIB-151
    {
      frontmatter: fm({
        key: "VIB-151",
        title: "Compress long-running task timelines",
        stage: "impl",
        readiness: "ready",
        waiting: "agent",
        owner: ids.selin,
        specialist: dev("claude"),
        reviewers: [consultant("codex")],
        operator: { assignedAtStageId: "ready" },
        urgent: false,
        validation: "healthy",
        branch: "vib-151-timeline-compression",
        pr: null,
        createdAt: yesterdayAt(13, 30),
        updatedAt: todayAt(10, 24),
      }),
      goal: "Apply the compression threshold so long task histories stay readable: collapse routine chatter, keep typed important events, preserve continuity for re-anchoring.",
      packet: null,
      timeline: [
        { occurredAt: todayAt(10, 24), type: "comment", actor: claudeRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Threshold sweep running against the 40-event fixture. Typed events survive every compression pass so far." },
        { occurredAt: todayAt(9, 47), type: "agent", actor: OP, title: null, toAgent: false, evidence: null,
          text: "Re-anchored **Codex (Advisor)** on `task.md` for a second opinion on threshold defaults." },
        { occurredAt: todayAt(9, 31), type: "github", actor: claudeRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Pushed 2 commits to `vib-151-timeline-compression` — compaction map and threshold config." },
        { occurredAt: yesterdayAt(14, 20), type: "assign", actor: humanRef(ids, "selin"), title: null, toAgent: false, evidence: null,
          text: "Took task ownership ahead of the review boundary." },
        { occurredAt: yesterdayAt(14, 5), type: "agent", actor: OP, title: null, toAgent: false, evidence: null,
          text: "Assigned **Claude Code (Developer)** as primary specialist — branch `vib-151-timeline-compression` created." },
      ],
    },
    // ------------------------------------------------------------ VIB-153
    {
      frontmatter: fm({
        key: "VIB-153",
        title: "Operator brevity guardrail for packets",
        stage: "impl",
        readiness: "ready",
        waiting: "agent",
        owner: null,
        specialist: dev("codex"),
        reviewers: [],
        operator: { assignedAtStageId: "ready" },
        urgent: false,
        validation: "healthy",
        branch: "vib-153-operator-brevity",
        pr: null,
        createdAt: yesterdayAt(18, 0),
        updatedAt: todayAt(10, 12),
      }),
      goal: "Constrain operator packets to observed → changed → recommended → decision, rejecting verbose or duplicated summaries.",
      packet: null,
      timeline: [
        { occurredAt: todayAt(10, 12), type: "comment", actor: humanRef(ids, "deniz"), title: null, toAgent: false, evidence: null,
          text: "Following from the platform team — this packet budget will matter for our ops rollout too." },
        { occurredAt: todayAt(10, 2), type: "comment", actor: codexRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Brevity linter drafted — packets past the length budget bounce back to the operator with a diff of what to cut." },
        { occurredAt: todayAt(8, 58), type: "agent", actor: OP, title: null, toAgent: false, evidence: null,
          text: "Assigned **Codex (Developer)** as primary specialist — branch `vib-153-operator-brevity` created." },
      ],
    },
    // ------------------------------------------------------------ VIB-160
    {
      frontmatter: fm({
        key: "VIB-160",
        title: "Rehydrate specialist from canonical file",
        stage: "impl",
        readiness: "input_required",
        waiting: "human",
        owner: ids.murat,
        specialist: dev("claude"),
        reviewers: [consultant("codex")],
        operator: { assignedAtStageId: "impl" },
        urgent: false,
        validation: "failing",
        branch: "vib-160-rehydrate",
        pr: null,
        createdAt: yesterdayAt(10, 0),
        updatedAt: todayAt(10, 31),
      }),
      goal: "When provider-side runtime history is unavailable, continue specialist work from the canonical task file and record a continuity warning instead of failing.",
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Continuity degraded — pick a recovery path",
        body: "Provider-side history for the Developer thread is unavailable. The specialist was rehydrated from the canonical task file and can continue safely, but two rehydrate-path checks are failing and the earlier direction may be stale.",
        observations: [
          { k: "Observed", v: "provider session 404 · thread claude-dev-160", code: true },
          { k: "Changed", v: "specialist rehydrated from task.md · continuity warning recorded", code: false },
          { k: "Validation", v: "2 rehydrate-path checks failing", code: false },
          { k: "Branch", v: "vib-160-rehydrate · 2 commits behind main", code: true },
        ],
        options: [
          { kind: "redirect", t: "Resume rehydrated thread", d: "Continue from canonical state; re-run the failing checks before any new commits.", rec: true, ev: "**Decision:** resume the rehydrated thread. Operator re-anchors Claude Code (Developer) on `task.md` and re-runs the failing checks before new commits." },
          { kind: "redirect", t: "Start a fresh specialist", d: "Retire the degraded thread; a new Developer anchors on task.md.", rec: false, ev: "**Decision:** start a fresh specialist. The degraded thread is retired and a new Developer thread anchors on the canonical file." },
          { kind: "hold_runtime_debug", t: "Hold for runtime debug", d: "Keep the task blocked while the provider-native session is inspected.", rec: false },
        ],
      },
      timeline: [
        { occurredAt: todayAt(10, 31), type: "blocked", actor: OP, title: null, toAgent: false, evidence: null,
          text: "**Blocked decision:** provider history unavailable and two rehydrate checks failing — recovery packet raised for human review." },
        { occurredAt: todayAt(10, 18), type: "quality", actor: codexRef("Advisor"), title: null, toAgent: false, evidence: null,
          text: "**Quality flag:** the rehydrate path drops evidence references recorded before the continuity break." },
        { occurredAt: todayAt(10, 5), type: "agent", actor: OP, title: null, toAgent: false, evidence: null,
          text: "**Continuity warning:** runtime history unavailable — re-anchored **Claude Code (Developer)** on the canonical task file." },
        { occurredAt: todayAt(9, 52), type: "github", actor: claudeRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Pushed `vib-160-rehydrate` — recovery shim and continuity marker." },
        { occurredAt: yesterdayAt(12, 10), type: "quality", actor: codexRef("Advisor"), title: null, toAgent: false, evidence: null,
          text: "**Validation failing** on the rehydrate path — evidence attached, re-run requested." },
        { occurredAt: yesterdayAt(11, 20), type: "comment", actor: humanRef(ids, "murat"), title: null, toAgent: false, evidence: null,
          text: "Opened the Developer runtime session to debug continuity — session recorded per audit policy." },
      ],
    },
    // ------------------------------------------------------------ VIB-145
    {
      frontmatter: fm({
        key: "VIB-145",
        title: "Board card SSE revalidation",
        stage: "review",
        readiness: "ready",
        waiting: "agent",
        owner: null,
        specialist: dev("codex"),
        reviewers: [],
        operator: { assignedAtStageId: "ready" },
        urgent: false,
        validation: "healthy",
        branch: "vib-145-sse-revalidate",
        pr: { number: 311, state: "review", title: "SSE board revalidation" },
        createdAt: yesterdayAt(15, 0),
        updatedAt: todayAt(9, 12),
      }),
      goal: "Push task-state changes to all connected users within 5 seconds using server-sent events and route-local revalidation.",
      packet: null,
      timeline: [
        { occurredAt: todayAt(9, 12), type: "transition", actor: OP, title: null, toAgent: false, evidence: null,
          text: "**Transition request:** move VIB-145 from In Progress to Review — SSE fan-out demo recorded, evidence attached." },
        { occurredAt: todayAt(8, 51), type: "comment", actor: codexRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Review build is green across the three desktop browser targets. Reviewer thread can start on the diff." },
        { occurredAt: yesterdayAt(16, 40), type: "github", actor: codexRef("Developer"), title: null, toAgent: false, evidence: null,
          text: "Opened **PR #311** from `vib-145-sse-revalidate` into `main`." },
      ],
    },
    // ------------------------------------------------------------ VIB-139
    {
      frontmatter: fm({
        key: "VIB-139",
        title: "Separate human RBAC from agent capability policy",
        stage: "done",
        readiness: "ready", // mock "done" readiness = derived accepted display state (ruling 1)
        waiting: "none",
        owner: ids.elif,
        specialist: null,
        reviewers: [],
        operator: { assignedAtStageId: "triage" },
        urgent: false,
        validation: "healthy",
        branch: "vib-139-policy-split",
        pr: { number: 298, state: "merged", title: "Policy split" },
        createdAt: mar30At(9, 0),
        updatedAt: mar30At(17, 26),
      }),
      goal: "Model human roles and agent capabilities as two distinct policy surfaces so managing people and managing agents never collide.",
      packet: null,
      timeline: [
        { occurredAt: mar30At(17, 26), type: "completion", actor: humanRef(ids, "elif"), title: "Completion accepted", toAgent: false, evidence: null,
          text: "Human acceptance recorded — **PR #298** merged. Human RBAC and agent capability are now separate policy surfaces." },
        { occurredAt: mar30At(17, 10), type: "transition", actor: OP, title: null, toAgent: false, evidence: null,
          text: "**Transition request:** move VIB-139 from Review to Done — both policy surfaces validated." },
      ],
    },
    // ------------------------------------------------------------ VIB-141
    {
      frontmatter: fm({
        key: "VIB-141",
        title: "Typed important-event schema",
        stage: "done",
        readiness: "ready", // mock "done" — see VIB-139 note
        waiting: "none",
        owner: ids.murat,
        specialist: dev("codex"),
        reviewers: [],
        operator: { assignedAtStageId: "triage" },
        urgent: false,
        validation: "healthy",
        branch: "vib-141-typed-events",
        pr: { number: 287, state: "merged", title: "Typed events" },
        createdAt: mar30At(8, 30),
        updatedAt: mar30At(15, 2),
      }),
      goal: "Define the five typed events — quality flag, transition request, blocked decision, completion report, policy violation — as first-class records.",
      packet: null,
      timeline: [
        { occurredAt: mar30At(15, 2), type: "github", actor: humanRef(ids, "murat"), title: null, toAgent: false, evidence: null,
          text: "Merged **PR #287** — the typed important-event schema is live." },
        { occurredAt: mar30At(14, 31), type: "quality", actor: claudeRef("Reviewer"), title: null, toAgent: false, evidence: null,
          text: "**Quality flag resolved:** typed payloads carry actor identity and task references." },
      ],
    },
    // ------------------------------------------------------------ VIB-166
    {
      frontmatter: fm({
        key: "VIB-166",
        title: "Manual re-scan & state reconciliation",
        stage: "triage",
        readiness: "input_required",
        waiting: "human",
        owner: null,
        specialist: null,
        reviewers: [],
        operator: null,
        urgent: false,
        validation: "none",
        branch: null,
        pr: null,
        createdAt: todayAt(7, 45),
        updatedAt: todayAt(7, 45),
      }),
      goal: "Give users a manual re-scan action that reconciles the file-native store when automated change detection misses a directly-edited task file.",
      packet: null,
      timeline: [],
    },
    // ------------------------------------------------------------ VIB-168
    {
      frontmatter: fm({
        key: "VIB-168",
        title: "Agent profile templates (eligible stages)",
        stage: "triage",
        readiness: "input_required",
        waiting: "human",
        owner: null,
        specialist: null,
        reviewers: [],
        operator: null,
        urgent: false,
        validation: "none",
        branch: null,
        pr: null,
        createdAt: todayAt(7, 50),
        updatedAt: todayAt(7, 50),
      }),
      goal: "Reusable agent profiles defining eligible stages, permitted actions, context resources, and backend — global base with per-project overrides.",
      packet: null,
      timeline: [],
    },
  ];
}

// ------------------------------------------------------------ notifications

export interface SeedNotification {
  id: string;
  kind: "packet" | "approval" | "mention" | "quality" | "policy";
  ptype?: "input" | "blocked";
  unread: boolean;
  occurredAt: string;
  from: ActorRender;
  projectSlug: string;
  taskKey: string;
  title?: string;
  text: string;
}

/** Arda's inbox — the mock's 10 rows (incl. the two cross-project splices),
 * with real timestamps; the query sorts DESC (ruling 9 supersedes the
 * mock's unsorted splice order). Curly quotes preserved verbatim. */
export function seedNotifications(ids: SeedUserIds): SeedNotification[] {
  return [
    { id: "n-160-packet", kind: "packet", ptype: "blocked", unread: true, occurredAt: todayAt(10, 31), from: OPERATOR_RENDER, projectSlug: "viberr-core", taskKey: "VIB-160",
      title: "Blocked decision — pick a recovery path",
      text: "Provider history unavailable and two rehydrate checks failing. The specialist continues from `task.md` once you choose." },
    { id: "n-dep-31", kind: "packet", ptype: "input", unread: true, occurredAt: todayAt(10, 12), from: OPERATOR_RENDER, projectSlug: "deploy-pipeline", taskKey: "DEP-31",
      title: "Completion report — staging promotion ready",
      text: "Pipeline stage rework validated on a dry run. Promotion to staging needs your acceptance." },
    { id: "n-142-packet", kind: "packet", ptype: "input", unread: true, occurredAt: todayAt(9, 41), from: OPERATOR_RENDER, projectSlug: "viberr-core", taskKey: "VIB-142",
      title: "Completion report — waiting on your acceptance",
      text: "Workspace attach implemented, **PR #318** open, validation green. Only a human can move it to Done." },
    { id: "n-bil-9", kind: "approval", unread: true, occurredAt: todayAt(8, 47), from: OPERATOR_RENDER, projectSlug: "billing-service", taskKey: "BIL-9",
      title: "Transition request — Ready → In Progress",
      text: "Strict human-gate project: execution can't start without a maintainer approval." },
    { id: "n-145-approval", kind: "approval", unread: true, occurredAt: todayAt(9, 12), from: OPERATOR_RENDER, projectSlug: "viberr-core", taskKey: "VIB-145",
      title: "Transition request — In Progress → Review",
      text: "SSE fan-out demo recorded and evidence attached. This boundary needs a maintainer approval." },
    { id: "n-142-policy", kind: "policy", unread: true, occurredAt: todayAt(9, 38), from: POLICY_ENGINE_RENDER, projectSlug: "viberr-core", taskKey: "VIB-142",
      text: "**Policy violation:** the active PAT is missing `pull_request:write` — PR auto-sync will fail after merge." },
    { id: "n-142-quality", kind: "quality", unread: false, occurredAt: todayAt(9, 20), from: CLAUDE_REVIEWER_RENDER, projectSlug: "viberr-core", taskKey: "VIB-142",
      text: "**Quality flag:** snapshot `task_projection.json` changed — confirm the compact shape before review." },
    { id: "n-148-mention", kind: "mention", unread: false, occurredAt: todayAt(8, 20), from: humanRender(ids, "elif"), projectSlug: "viberr-core", taskKey: "VIB-148",
      text: "mentioned you — “needs a reviewer to own the acceptance gate. **@arda** can you take it?”" },
    { id: "n-145-blockedact", kind: "policy", unread: false, occurredAt: yesterdayAt(16, 4), from: POLICY_ENGINE_RENDER, projectSlug: "viberr-core", taskKey: "VIB-145",
      text: "Blocked agent action: Developer (Codex) attempted **Merge a pull request** — reserved for humans." },
    { id: "n-160-reply", kind: "mention", unread: false, occurredAt: yesterdayAt(11, 20), from: humanRender(ids, "murat"), projectSlug: "viberr-core", taskKey: "VIB-160",
      text: "replied to you — “opened the Developer runtime session to debug continuity; findings come back as task comments.”" },
  ];
}
