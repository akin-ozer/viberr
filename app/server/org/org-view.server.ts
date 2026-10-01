import type { DatabaseSync } from "node:sqlite";
import type { StageDef } from "~/schemas/project-file.schema";
import { getEnv } from "~/server/config/env.server";
import { listProjects } from "~/server/projections/board-query.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import type { OAuthProvider } from "~/server/auth/oauth-credential-test.server";
import {
  getOAuthProviderRow,
  resolveOAuthProvider,
  type OAuthSource,
} from "~/server/auth/oauth-providers.server";
import {
  cachedDataRootSpace,
  type DiskSpace,
} from "~/server/ops/disk-space.server";
import {
  maintenanceState,
  type MaintenanceState,
} from "~/server/ops/maintenance.server";
import { listConnections, type ConnectionRecord } from "./connections.server";
import { listGlobalAgentProfiles, type GagentView } from "./gagents.server";
import {
  listDomains,
  listOrgUsers,
  type DomainRecord,
  type OrgUserView,
} from "./org-users.server";
import {
  listKnowledgeBases,
  listMcpServers,
  listSkills,
  type KbView,
  type McpView,
  type OrgSeedContext,
  type SkillView,
} from "./resources.server";
import {
  countProjectDeploymentGrants,
  countTemplateGrants,
} from "./resource-references.server";

/**
 * The /org/settings loader payload — all slices at once (they're small,
 * org-settings spec §3). `stages` is the instance-default workflow's stage
 * list (ruling 15) feeding the AgentModal's eligible-stage chips.
 */

export interface OrgSettingsView {
  connections: ConnectionRecord[];
  users: OrgUserView[];
  domains: DomainRecord[];
  kbs: KbView[];
  mcps: McpView[];
  skills: SkillView[];
  gagents: GagentView[];
  /**
   * A2 (pass 23): how many PROJECT DEPLOYMENTS grant each resource, keyed by the
   * same slug the delete-confirm passes (`kbs` by dir, `mcps`/`skills` by name).
   * The confirm dialog's grant tail counts only org TEMPLATES from `gagents`; a
   * resource used ONLY by a project agent read as "nothing uses this" while the
   * delete silently dropped that project grant. This lets the dialog say so.
   */
  projectGrants: {
    kbs: Record<string, number>;
    mcps: Record<string, number>;
    skills: Record<string, number>;
  };
  /**
   * How many ORG TEMPLATES grant each resource, on the same keys. Counted over
   * the profile FILES because `gagents` is the specialist CRUD list (the
   * controller and operator templates are never in it) while the delete
   * rewrites every profile file — a panel deriving this from `gagents` told an
   * admin "Nothing grants it" about the controller's and operator's own
   * resources, right before the delete stripped those grants.
   */
  templateGrants: {
    kbs: Record<string, number>;
    mcps: Record<string, number>;
    skills: Record<string, number>;
  };
  stages: StageDef[];
  /**
   * Ruling 614: each live project whose board has stages the default workflow
   * lacks, so the AgentModal can offer them grouped by project (its Custom
   * stages section) instead of only echoing an id a profile already stores.
   */
  projectStages: ProjectCustomStages[];
  /**
   * F18-3: which OAuth sign-in providers are actually configured on this
   * deployment. The Allow-access modal keys its default method + which OAuth
   * options it offers off this — mirroring R17-4's login-page rule — so it never
   * defaults to (or promises) a GitHub/Google sign-in the deployment can't grant.
   */
  providers: { github: boolean; google: boolean };
  /**
   * R19-16: the Sign-in & SSO tab's cards — one per provider, configured here
   * or inherited from the deployment env, with the last live verdict. Never
   * carries a client secret.
   */
  authProviders: AuthProviderView[];
  /**
   * C9 (pass 23): instance storage health for the settings UI. The periodic
   * maintenance scheduler (ops/maintenance.server) already reclaims finished-task
   * clones on an interval and reports to `/resources/health`, but that ops probe
   * is JSON only — an admin had no in-app view of free space or whether the
   * cleanup is alive. Both reads are cheap process-global snapshots (the disk
   * measurement is cached), so surfacing them here costs nothing per load.
   */
  storage: {
    disk: DiskSpace | null;
    maintenance: MaintenanceState;
  };
}

export interface AuthProviderView {
  provider: OAuthProvider;
  /** Which configuration the running app is actually using. */
  source: OAuthSource;
  /** Live for sign-in right now. */
  active: boolean;
  /** An app row exists and holds it off — overriding any env pair. */
  disabledInApp: boolean;
  /** Present only when configured in-app (env values are never echoed). */
  clientId: string | null;
  /** Whether an app row exists at all (vs env-only / unconfigured). */
  configuredInApp: boolean;
  verifiedAt: string | null;
  verifiedDetail: string | null;
  /** True when the deployment env also carries a pair for this provider. */
  envAvailable: boolean;
}

/**
 * Ruling 614: one live project's board stages outside the default workflow.
 * A global profile names its eligible stages by id, and a project's own board
 * can add ids the default workflow has never had (akinozer.com's `build`, or
 * `intake`, `mapping` and `estimate`).
 */
export interface ProjectCustomStages {
  slug: string;
  name: string;
  /** The project's task-key prefix ("BIL"), shown beside its name. */
  prefix: string;
  /** In board order. Never the board's terminal stage: Done is closed by a
   *  human, never by an agent, whatever the board calls it. */
  stages: StageDef[];
}

/** Archived projects are left out, as `usedByProject` leaves them out of a
 *  profile's adoption count: nobody can edit their boards any more. Ordered by
 *  name the way a person reads a list: SQLite's `ORDER BY name` is binary, so
 *  `akinozer.com` would follow every capitalised name. */
function projectCustomStages(db: DatabaseSync): ProjectCustomStages[] {
  const defaultIds = new Set(GOVERNED_TEMPLATE.stages.map((s) => s.id));
  return listProjects(db)
    .flatMap((project) => {
      if (project.archived) return [];
      const stages = project.stages.filter(
        (s) => !defaultIds.has(s.id) && !isTerminalStage(s.id, project.stages),
      );
      return stages.length === 0
        ? []
        : [{ slug: project.slug, name: project.name, prefix: project.taskPrefix, stages }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * R19-16: one provider card. `active` is the SAME resolution better-auth runs
 * on (`resolveOAuthProvider`), so the tab can never advertise a state the
 * running handler disagrees with.
 */
function authProviderView(
  db: DatabaseSync,
  provider: OAuthProvider,
): AuthProviderView {
  const resolved = resolveOAuthProvider(db, provider);
  const row = getOAuthProviderRow(db, provider);
  return {
    provider,
    source: resolved.source,
    active: resolved.credentials !== null,
    disabledInApp: resolved.disabledInApp,
    clientId: row?.clientId ?? null,
    configuredInApp: row !== null,
    verifiedAt: row?.verifiedAt ?? null,
    verifiedDetail: row?.verifiedDetail ?? null,
    envAvailable: envPairPresent(provider),
  };
}

function envPairPresent(provider: OAuthProvider): boolean {
  const env = getEnv();
  return provider === "github"
    ? Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET)
    : Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function getOrgSettingsView(
  db: DatabaseSync,
  ctx: OrgSeedContext = {},
): OrgSettingsView {
  const authProviders = [
    authProviderView(db, "github"),
    authProviderView(db, "google"),
  ];
  const kbs = listKnowledgeBases(db, ctx);
  const mcps = listMcpServers(db);
  const skills = listSkills(db, ctx);
  // A2: count project-deployment grants for each resource, keyed by the slug the
  // delete-confirm passes (KB by `dir`; MCP/skill by `name`). The `ResourceKind`
  // the deployment stores is `kb` (singular) / `mcps` / `skills`.
  const countGrants = (
    slugs: string[],
    kind: "kb" | "mcps" | "skills",
    count: typeof countProjectDeploymentGrants,
  ): Record<string, number> =>
    Object.fromEntries(
      slugs.map((slug): [string, number] => [
        slug,
        count(kind, slug, ctx.dataRoot),
      ]),
    );
  return {
    connections: listConnections(db),
    users: listOrgUsers(db),
    domains: listDomains(db),
    kbs,
    mcps,
    skills,
    gagents: listGlobalAgentProfiles(db, ctx),
    projectGrants: {
      kbs: countGrants(kbs.map((k) => k.dir), "kb", countProjectDeploymentGrants),
      mcps: countGrants(mcps.map((m) => m.name), "mcps", countProjectDeploymentGrants),
      skills: countGrants(skills.map((s) => s.name), "skills", countProjectDeploymentGrants),
    },
    templateGrants: {
      kbs: countGrants(kbs.map((k) => k.dir), "kb", countTemplateGrants),
      mcps: countGrants(mcps.map((m) => m.name), "mcps", countTemplateGrants),
      skills: countGrants(skills.map((s) => s.name), "skills", countTemplateGrants),
    },
    stages: GOVERNED_TEMPLATE.stages,
    projectStages: projectCustomStages(db),
    // R19-16: what the app can ACTUALLY grant now (app row overriding env),
    // not what the process happened to boot with.
    providers: {
      github: authProviders[0]!.active,
      google: authProviders[1]!.active,
    },
    authProviders,
    // C9: instance storage health (cheap cached reads).
    storage: {
      disk: cachedDataRootSpace(),
      maintenance: maintenanceState(),
    },
  };
}
