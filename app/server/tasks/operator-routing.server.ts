import type Database from "better-sqlite3";
import { effectiveProfileView } from "~/features/agents/agents-query.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  getBackendHealth,
  type BackendHealth,
  type RealBackend,
} from "~/server/runtimes/runtime-registry.server";
import {
  defaultModelFor,
  resolveRunModel,
} from "~/server/runtimes/model-catalog.server";
import {
  listMcpServers,
  type McpView,
} from "~/server/org/resources.server";
import type { AgentDeployment } from "~/schemas/project-file.schema";
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
  backend: RealBackend;
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
  backend: RealBackend,
): RunFactsRow {
  return db
    .prepare(
      // created_at is an ISO-8601 string (…T…Z). datetime('now', …) renders a
      // space-separated, Z-less string, so comparing the two lexically widened
      // the 30-day window by up to a day; strftime with the ISO format matches
      // how the column is written.
      `SELECT
         sum(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS active_runs,
         sum(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued_runs,
         sum(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') THEN 1 ELSE 0 END) AS recent_runs,
         sum(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') AND state = 'error' THEN 1 ELSE 0 END) AS recent_errors,
         sum(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') AND total_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS usd_runs,
         avg(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') THEN total_cost_usd END) AS avg_usd,
         sum(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') THEN total_cost_usd END) AS total_usd,
         avg(CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days') THEN input_tokens + output_tokens END) AS avg_tokens
       FROM agent_runs
       WHERE agent_profile_id = ?
         AND backend = ?
         AND simulated = 0`,
    )
    .get(profileId, backend) as RunFactsRow;
}

function assignmentCount(
  db: Database.Database,
  profileId: string,
  backend: RealBackend,
): number {
  const row = db
    .prepare(
      `SELECT count(*) AS c
       FROM task_projections t
       JOIN projects p ON p.slug = t.project_slug
       WHERE p.archived = 0
         AND (
         json_extract(p.stages_json, '$[#-1].id') IS NULL
         OR t.stage != json_extract(p.stages_json, '$[#-1].id')
         )
         AND (
           (
             json_extract(t.specialist_json, '$.profileId') = ?
             AND json_extract(t.specialist_json, '$.backend') = ?
           )
           OR EXISTS (
             SELECT 1 FROM json_each(t.reviewers_json) r
             WHERE json_extract(r.value, '$.profileId') = ?
               AND json_extract(r.value, '$.backend') = ?
           )
       )`,
    )
    .get(profileId, backend, profileId, backend) as {
    c: number;
  };
  return row.c;
}

function round(value: number | null, places = 4): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

type RoutingPurpose = "primary" | "reviewer";

interface RoutingSharedContext {
  stageId: string;
  specialists: readonly DeployedSpecialistView[];
  deployments: Map<string, AgentDeployment>;
  mcpByName: Map<string, McpView>;
  baseByChoice: Map<
    string,
    { candidate: OperatorRoutingCandidate | null; reasons: string[] }
  >;
}

function routingSharedContext(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    stageId: string;
    specialists: readonly DeployedSpecialistView[];
  },
): RoutingSharedContext | null {
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project) return null;
  return {
    stageId: input.stageId,
    specialists: input.specialists,
    deployments: new Map(
      project.parsed.frontmatter.agents.map((deployment) => [
        deployment.profileId,
        deployment,
      ]),
    ),
    mcpByName: new Map(listMcpServers(db).map((mcp) => [mcp.name, mcp])),
    baseByChoice: new Map(),
  };
}

function declaredBackends(backends: readonly string[]): RealBackend[] {
  const declared = backends.filter(
    (backend): backend is RealBackend =>
      backend === "claude" || backend === "codex",
  );
  // Legacy/custom definitions that omitted the field historically ran on
  // Claude. Preserve that default while making every declared choice explicit.
  return declared.length > 0 ? [...new Set(declared)] : ["claude"];
}

function modelForBackend(
  backends: readonly RealBackend[],
  configuredModel: string,
  backend: RealBackend,
): string {
  const nativeBackend = backends[0] ?? "claude";
  return backend === nativeBackend
    ? resolveRunModel(backend, configuredModel)
    : defaultModelFor(backend);
}

function baseRoutingCandidate(
  db: Database.Database,
  ctx: TaskMutationContext,
  shared: RoutingSharedContext,
  specialist: DeployedSpecialistView,
  backend: RealBackend,
): { candidate: OperatorRoutingCandidate | null; reasons: string[] } | null {
  const choiceKey = `${specialist.id}:${backend}`;
  const cached = shared.baseByChoice.get(choiceKey);
  if (cached) return cached;
  const deployment = shared.deployments.get(specialist.id);
  if (!deployment) return null;
  const view = effectiveProfileView(deployment, ctx.dataRoot);
  const reasons: string[] = [];
  if (!specialistEligibleForStage(specialist, shared.stageId)) {
    reasons.push(`not eligible for stage ${shared.stageId}`);
  }
  const capabilitySupport = specialistBackendCapabilitySupport(
    view.capabilities,
    backend,
  );
  if (!capabilitySupport.supported) {
    reasons.push(
      `backend ${backend} cannot enforce withheld local capabilities: ${capabilitySupport.advisoryOnlyWithheld.join(
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
    const mcp = shared.mcpByName.get(name);
    const compatible = mcp
      ? backend === "claude" || mcpBackendSupport(mcp).codex
      : false;
    if (!mcp) reasons.push(`declared MCP ${name} is not configured`);
    else if (!compatible) {
      reasons.push(
        `declared MCP ${name} is incompatible with ${backend}`,
      );
    }
    return {
      name,
      configured: !!mcp,
      up: mcp?.up ?? null,
      tools: mcp?.tools ?? null,
      backendCompatible: compatible,
    };
  });

  let candidate: OperatorRoutingCandidate | null = null;
  const profileBackends = declaredBackends(view.backends);
  if (reasons.length === 0) {
    const facts = runFacts(db, specialist.id, backend);
    candidate = {
      profileId: specialist.id,
      name: specialist.name,
      role: specialist.role,
      scope: view.scope,
      description: view.desc,
      backend,
      model: modelForBackend(profileBackends, view.model, backend),
      declaredBackends: profileBackends,
      resources: {
        skills: view.resources.skills,
        knowledgeBases: view.resources.kb,
        mcps: mcpFacts,
      },
      backendHealth: getBackendHealth(backend),
      workload: {
        scope: "organization",
        activeRuns: Number(facts.active_runs ?? 0),
        queuedRuns: Number(facts.queued_runs ?? 0),
        currentAssignments: assignmentCount(db, specialist.id, backend),
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
    };
  }
  const result = { candidate, reasons };
  shared.baseByChoice.set(choiceKey, result);
  return result;
}

function routingContextFromShared(
  db: Database.Database,
  ctx: TaskMutationContext,
  shared: RoutingSharedContext | null,
  input: {
    purpose: RoutingPurpose;
    primaryProfileId?: string | null;
    reviewerProfileIds?: readonly string[];
  },
): OperatorRoutingContext {
  if (!shared) {
    return {
      eligible: [],
      excluded: [],
      decisionRule: "operator_decides_no_static_score",
    };
  }
  const reviewers = new Set(input.reviewerProfileIds ?? []);
  const eligible: OperatorRoutingCandidate[] = [];
  const excluded: ExcludedRoutingCandidate[] = [];
  for (const specialist of shared.specialists) {
    const deployment = shared.deployments.get(specialist.id);
    if (!deployment) continue;
    const view = effectiveProfileView(deployment, ctx.dataRoot);
    for (const backend of declaredBackends(view.backends)) {
      const base = baseRoutingCandidate(db, ctx, shared, specialist, backend);
      if (!base) continue;
      const reasons = [...base.reasons];
      if (
        input.purpose === "reviewer" &&
        specialist.id === input.primaryProfileId
      ) {
        reasons.push("already the primary specialist");
      }
      if (input.purpose === "reviewer" && reviewers.has(specialist.id)) {
        reasons.push("already engaged as a reviewer");
      }
      if (input.purpose === "primary" && reviewers.has(specialist.id)) {
        reasons.push("already engaged as a reviewer");
      }
      if (reasons.length > 0 || !base.candidate) {
        excluded.push({
          profileId: specialist.id,
          name: specialist.name,
          backend,
          reasons,
        });
      } else {
        eligible.push(base.candidate);
      }
    }
  }
  return { eligible, excluded, decisionRule: "operator_decides_no_static_score" };
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
  const shared = routingSharedContext(db, ctx, input);
  return routingContextFromShared(db, ctx, shared, input);
}

/** Build the primary and reviewer comparison sets from one shared fact pass. */
export function buildOperatorRoutingContexts(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    stageId: string;
    specialists: readonly DeployedSpecialistView[];
    primaryProfileId?: string | null;
    reviewerProfileIds?: readonly string[];
  },
): { primary: OperatorRoutingContext; reviewer: OperatorRoutingContext } {
  const shared = routingSharedContext(db, ctx, input);
  return {
    primary: routingContextFromShared(db, ctx, shared, {
      purpose: "primary",
      reviewerProfileIds: input.reviewerProfileIds,
    }),
    reviewer: routingContextFromShared(db, ctx, shared, {
      purpose: "reviewer",
      primaryProfileId: input.primaryProfileId,
      reviewerProfileIds: input.reviewerProfileIds,
    }),
  };
}
