import type { AgentDeployment, CapabilityMode } from "~/schemas/project-file.schema";
import { capabilityByLabel, normalizeDeliveryGrants } from "~/shared/capabilities";
import type { AgentProfileFrontmatter } from "~/server/files/agent-profile-file.server";

/**
 * The built-in agent catalog — PRODUCT data, not demo data: the operator +
 * base specialist profiles (with their capability policies) that ship with
 * every instance, and the deployment sets derived from them. Consumed by the
 * seed (org profile templates), boot (default asset backfill), and project
 * creation (preinstalled roster).
 */

// ------------------------------------------------------- agent profiles

interface ProfileActionSpec {
  direct: string[];
  recommend: string[];
  forbidden: string[];
}

/** An action list split by what the catalog recognizes: real capability grants,
 *  and the labels that stay display-only. */
export interface MappedActions {
  capabilities: { capabilityId: string; mode: CapabilityMode }[];
  extras: { label: string; mode: CapabilityMode }[];
}

/** Maps mock action-label lists onto CAP_CATALOG ids; labels with no exact
 * catalog match stay as display-only extras (contracts §7 #7). */
export function mapActions(actions: ProfileActionSpec): MappedActions {
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
      desc: description,
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
        // B7 (pass 16): NO `viberr` grant — this writer was the last one that
        // still had it, disagreeing with `assets/operator.profile.md` (P14-KM-14).
        // `buildOperatorToolkit` mounts the in-process governance server
        // unconditionally and `buildResourceCatalog` filters the reserved name
        // out, so the grant resolved to nothing and painted the operator's own
        // toolkit as a red "no longer in the store" chip.
        skills: ["viberr-app-expertise"],
        mcps: [],
        kb: ["architecture-notes"],
      },
    },
    {
      // R15-2: delivery (push + review PR) is an operator decision — direct in
      // the shipped template (the Strict preset maps it to recommend).
      // F19-12: these are catalog LABELS resolved by `capabilityByLabel` above —
      // they must track `UNIFIED_CAP_CATALOG` exactly or the grant degrades to a
      // display-only extra. "Assign the delivering agent" is the current label
      // for capability id `assign-primary-specialist` (the id is persisted and
      // deliberately unchanged; see the note in app/shared/capabilities.ts).
      direct: ["Assign the delivering agent", "Summon reviewer specialists", "Generate decision & blocking packets", "Append typed important events", "Deliver the branch & open the review PR"],
      recommend: ["Stage transitions", "Accept completion into Done"],
      forbidden: ["Execute code or write to the repo", "Transition a task to Done", "Change project policy"],
    },
    "A dedicated operator is instantiated for every active task. It coordinates specialists, keeps the canonical task file authoritative, and turns agent work into concise decision packets for human review. It never writes code and never closes a task itself.",
  ),
  profile(
    {
      id: "developer", kind: "specialist", name: "Developer", role: "Implementation",
      // R20-8: this deployment's ChatGPT-account Codex cannot run `gpt-5.6-sol`;
      // `gpt-5.6-terra` is the CLI default that works, so the seed ships it.
      icon: "branch", backends: ["codex", "claude"], model: "gpt-5.6-terra",
      scope: "Global base",
      stages: ["ready", "impl"],
      resources: {
        skills: ["developer-expertise"],
        // No MCP is seeded (honest empty slate — the old "github-mcp" ref
        // pointed at a non-resolvable, unauthenticated endpoint). An admin
        // attaches a real MCP server and references it here.
        mcps: [],
        // Real KB folders on disk (data/kb/<dir>) so they inject into runs (F6).
        kb: ["architecture-notes", "api-contracts"],
      },
    },
    {
      // "Execute code or write to the repo" is the HEADLINE repo-write capability
      // and the master gate for ALL delivery (specialist-tool-policy.ts): with it
      // withheld, the fine-grained branch/commit/PR grants below are vetoed and the
      // developer silently delivers nothing (VIB-1 class). A deliverer MUST hold it.
      // F20-21/R20-6: a specialist acts DIRECTLY or is WITHHELD — no `recommend`.
      // "Move the task to Review" ships `direct` (it used to ship `recommend`,
      // which the runtime widened to `direct` behind the matrix's back), so the
      // file now literally matches what enforcement and the Policy counts show.
      direct: ["Execute code or write to the repo", "Create the task-key branch", "Commit & push to the branch", "Run unit & integration validation", "Open the review pull request", "Post mid-run comments", "Ask the human a question", "Move the task to Review"],
      recommend: [],
      forbidden: ["Merge a pull request", "Transition a task to Done"],
    },
    "Implements stage work on the task-key branch: writes code, runs local validation, and commits with traceable messages. Hands the committed branch back to the operator at the review boundary — Viberr pushes it and opens the review PR on the Review transition.",
  ),
  profile(
    {
      id: "reviewer", kind: "specialist", name: "Reviewer", role: "Review & validation",
      icon: "check", backends: ["claude"], model: "sonnet",
      scope: "Global base",
      stages: ["impl", "review"],
      resources: {
        skills: ["reviewer-expertise"],
        mcps: [],
        kb: ["api-contracts"],
      },
    },
    {
      // The single quality specialist: reviews the diff AND authors/runs the
      // validation suite (the former Tester role is folded in here).
      // F20-21/R20-6: a specialist acts DIRECTLY or is WITHHELD — no `recommend`.
      // "Approve the review" / "Request changes" ship `direct` (they used to ship
      // `recommend`, silently widened to `direct` at runtime), so the reviewer's
      // Policy count reads "10 direct · 0 recommend" honestly. They stay gated by
      // "Report a validation verdict" via applyVerdictOutcomeGate regardless.
      direct: ["Read the repository & diff", "Run validation suites", "Author test cases", "Attach evidence references", "Post quality-flag events", "Post mid-run comments", "Ask the human a question", "Report a validation verdict", "Approve the review", "Request changes"],
      recommend: [],
      // The reviewer must NOT push/commit — use the exact catalog label so this
      // becomes a REAL `commit-push-branch: human` grant (D4) that the tool
      // policy actually denies (git push + git commit), not a decorative extra.
      forbidden: ["Merge a pull request", "Transition a task to Done", "Commit & push to the branch"],
    },
    "The task's quality specialist: authors and runs the validation suite during implementation, then reviews the diff at the review boundary — raising typed quality flags and recommending approve or request-changes. Keeps raw validation output in evidence, not the timeline, and re-anchors on the canonical task file before each pass.",
  ),
];

// ------------------------------------------------------------ deployments

/** The default agent roster deployed into a project — the operator plus the
 *  base specialists, each carrying its capability policy. Used by app-created
 *  projects (and the demo test fixture) so the operator (and specialists it
 *  can assign) are preinstalled in every project. */
export function defaultAgentDeployments(): AgentDeployment[] {
  return deployments();
}

/** Profile ids of the built-in agents preinstalled on EVERY board: the operator
 *  plus the base specialists a task actually needs (Developer, Reviewer). The
 *  operator absorbs advisory duties (scope clarification, decision packets), and
 *  the Reviewer is the single quality specialist (it reviews AND tests), so there
 *  is no separate Advisor or Tester profile. */
export const BASE_AGENT_PROFILE_IDS = [
  "operator",
  "developer",
  "reviewer",
] as const;

/** The built-in agent deployments backfilled into every project so the operator
 *  and its core specialists are usable across all boards (ensureBaseAgentsDeployed). */
export function baseAgentDeployments(): AgentDeployment[] {
  const wanted = new Set<string>(BASE_AGENT_PROFILE_IDS);
  return deployments().filter((d) => wanted.has(d.profileId));
}

function deployments(): AgentDeployment[] {
  return SEED_AGENT_PROFILES.map((p) => {
    // F14: a deliverer must hold the headline repo-write capability (master gate);
    // repair any seed deliverer that grants scoped delivery without it.
    const capabilities = normalizeDeliveryGrants(p.frontmatter.capabilities);
    return { profileId: p.frontmatter.id, capabilities, extras: p.frontmatter.extras };
  });
}
