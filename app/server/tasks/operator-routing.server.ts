import type Database from "better-sqlite3";
import { effectiveProfileView } from "~/features/agents/agents-query.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  getBackendHealth,
  type BackendHealth,
  type RealBackend,
} from "~/server/runtimes/runtime-registry.server";
import { listMcpServers } from "~/server/org/resources.server";
import { mcpBackendSupport } from "./specialist-mcp.server";
import {
  specialistEligibleForStage,
  type DeployedSpecialistView,
} from "./specialist-run.server";
import type { TaskMutationContext } from "./task-actions.server";
import { specialistBackendCapabilitySupport } from "./specialist-tool-policy";

/**
 * Facts Viberr supplies to the intelligent operator before it routes work.
 * There is deliberately no score or suggested winner here: hard eligibility
 * removes impossible choices, then the operator compares the remaining facts
 * and records its own explanation.
 */
export interface OperatorRoutingCandidate {
  profileId: string;
  name: string;
  role: string;
  scope: string;
  description: string;
  backend: RealBackend;
  model: string;
  declaredBackends: RealBackend[];
  resources: {
    skills: string[];
    knowledgeBases: string[];
    mcps: Array<{
      name: string;
      configured: boolean;
      up: boolean | null;
      tools: number | null;
      backendCompatible: boolean;
    }>;
  };
  backendHealth: BackendHealth;
  workload: {
    scope: "organization";
    activeRuns: number;
    queuedRuns: number;
    currentAssignments: number;
    recentRuns: number;
    recentErrors: number;
  };
  cost: {
    basis: "observed provider runs across organization (30 days)";
    runsWithUsd: number;
    averageUsd: number | null;
    totalUsd: number | null;
    averageTokens: number | null;
  };
}

export interface ExcludedRoutingCandidate {
  profileId: string;
  name: string;
  reasons: string[];
}

export interface OperatorRoutingContext {
  eligible: OperatorRoutingCandidate[];
  excluded: ExcludedRoutingCandidate[];
  /** Explicitly reminds prompt consumers that this is decision context, not a ranking. */
  decisionRule: "operator_decides_no_static_score";
}

interface RunFactsRow {
  active_runs: number;
  queued_runs: number;
  recent_runs: number;
  recent_errors: number;
  usd_runs: number;
  avg_usd: number | null;
  total_usd: number | null;
  avg_tokens: number | null;
}

function runFacts(
  db: Database.Database,
  profileId: string,
): RunFactsRow {
  return db
    .prepare(
      `SELECT
         sum(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS active_runs,
         sum(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued_runs,
         sum(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS recent_runs,
         sum(CASE WHEN created_at >= datetime('now', '-30 days') AND state = 'error' THEN 1 ELSE 0 END) AS recent_errors,
         sum(CASE WHEN created_at >= datetime('now', '-30 days') AND simulated = 0 AND total_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS usd_runs,
         avg(CASE WHEN created_at >= datetime('now', '-30 days') AND simulated = 0 THEN total_cost_usd END) AS avg_usd,
         sum(CASE WHEN created_at >= datetime('now', '-30 days') AND simulated = 0 THEN total_cost_usd END) AS total_usd,
         avg(CASE WHEN created_at >= datetime('now', '-30 days') AND simulated = 0 THEN input_tokens + output_tokens END) AS avg_tokens
       FROM agent_runs
       WHERE agent_profile_id = ?`,
    )
    .get(profileId) as RunFactsRow;
}

function assignmentCount(
  db: Database.Database,
  profileId: string,
): number {
  const row = db
    .prepare(
      `SELECT count(*) AS c
       FROM task_projections t
       JOIN projects p ON p.slug = t.project_slug
       WHERE (
         json_extract(p.stages_json, '$[#-1].id') IS NULL
         OR t.stage != json_extract(p.stages_json, '$[#-1].id')
       )
         AND (
           json_extract(t.specialist_json, '$.profileId') = ?
           OR EXISTS (
             SELECT 1 FROM json_each(t.reviewers_json) r
             WHERE json_extract(r.value, '$.profileId') = ?
           )
       )`,
    )
    .get(profileId, profileId) as {
    c: number;
  };
  return row.c;
}

function round(value: number | null, places = 4): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Build the hard-filtered comparison set for one routing purpose. */
export function buildOperatorRoutingContext(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    stageId: string;
    purpose: "primary" | "reviewer";
    specialists: readonly DeployedSpecialistView[];
    primaryProfileId?: string | null;
    reviewerProfileIds?: readonly string[];
  },
): OperatorRoutingContext {
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project) {
    return { eligible: [], excluded: [], decisionRule: "operator_decides_no_static_score" };
  }
  const deployments = new Map(
    project.parsed.frontmatter.agents.map((deployment) => [deployment.profileId, deployment]),
  );
  const mcpByName = new Map(listMcpServers(db).map((mcp) => [mcp.name, mcp]));
  const reviewers = new Set(input.reviewerProfileIds ?? []);
  const eligible: OperatorRoutingCandidate[] = [];
  const excluded: ExcludedRoutingCandidate[] = [];

  for (const specialist of input.specialists) {
    const deployment = deployments.get(specialist.id);
    if (!deployment) continue;
    const view = effectiveProfileView(deployment, ctx.dataRoot);
    const reasons: string[] = [];
    if (!specialistEligibleForStage(specialist, input.stageId)) {
      reasons.push(`not eligible for stage ${input.stageId}`);
    }
    if (input.purpose === "reviewer" && specialist.id === input.primaryProfileId) {
      reasons.push("already the primary specialist");
    }
    if (input.purpose === "reviewer" && reviewers.has(specialist.id)) {
      reasons.push("already engaged as a reviewer");
    }
    const capabilitySupport = specialistBackendCapabilitySupport(
      view.capabilities,
      specialist.backend,
    );
    if (!capabilitySupport.supported) {
      reasons.push(
        `backend ${specialist.backend} cannot enforce withheld local capabilities: ${capabilitySupport.advisoryOnlyWithheld.join(
          ", ",
        )}`,
      );
    }

    const mcpFacts = view.resources.mcps.map((name) => {
      if (name === "viberr") {
        return {
          name,
          configured: true,
          up: true as const,
          tools: null,
          backendCompatible: true,
        };
      }
      const mcp = mcpByName.get(name);
      const compatible = mcp
        ? specialist.backend === "claude" || mcpBackendSupport(mcp).codex
        : false;
      if (!mcp) reasons.push(`declared MCP ${name} is not configured`);
      else if (!compatible) reasons.push(`declared MCP ${name} is incompatible with ${specialist.backend}`);
      return {
        name,
        configured: !!mcp,
        up: mcp?.up ?? null,
        tools: mcp?.tools ?? null,
        backendCompatible: compatible,
      };
    });

    if (reasons.length > 0) {
      excluded.push({ profileId: specialist.id, name: specialist.name, reasons });
      continue;
    }

    const facts = runFacts(db, specialist.id);
    const declaredBackends = view.backends.filter(
      (backend): backend is RealBackend => backend === "claude" || backend === "codex",
    );
    eligible.push({
      profileId: specialist.id,
      name: specialist.name,
      role: specialist.role,
      scope: view.scope,
      description: view.desc,
      backend: specialist.backend,
      model: specialist.model,
      declaredBackends,
      resources: {
        skills: view.resources.skills,
        knowledgeBases: view.resources.kb,
        mcps: mcpFacts,
      },
      backendHealth: getBackendHealth(specialist.backend),
      workload: {
        scope: "organization",
        activeRuns: Number(facts.active_runs ?? 0),
        queuedRuns: Number(facts.queued_runs ?? 0),
        currentAssignments: assignmentCount(db, specialist.id),
        recentRuns: Number(facts.recent_runs ?? 0),
        recentErrors: Number(facts.recent_errors ?? 0),
      },
      cost: {
        basis: "observed provider runs across organization (30 days)",
        runsWithUsd: Number(facts.usd_runs ?? 0),
        averageUsd: round(facts.avg_usd),
        totalUsd: round(facts.total_usd),
        averageTokens: round(facts.avg_tokens, 0),
      },
    });
  }

  return { eligible, excluded, decisionRule: "operator_decides_no_static_score" };
}
