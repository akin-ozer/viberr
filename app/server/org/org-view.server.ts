import type Database from "better-sqlite3";
import type { StageDef } from "~/schemas/project-file.schema";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
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
  listOrgSecrets,
  type OrgSecretMetadata,
} from "~/server/secrets/org-secret-store.server";
import {
  buildAgentResourceDependencyIndex,
  type AgentResourceUsage,
} from "./resource-dependencies.server";

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
  secrets: OrgSecretMetadata[];
  skills: SkillView[];
  gagents: GagentView[];
  stages: StageDef[];
  resourceUsages: AgentResourceUsage[];
}

export function getOrgSettingsView(
  db: Database.Database,
  ctx: OrgSeedContext = {},
): OrgSettingsView {
  const dependencies = buildAgentResourceDependencyIndex(db, ctx);
  return {
    connections: listConnections(db),
    users: listOrgUsers(db),
    domains: listDomains(db),
    kbs: listKnowledgeBases(db, ctx),
    mcps: listMcpServers(db),
    secrets: listOrgSecrets(db),
    skills: listSkills(db, ctx),
    gagents: listGlobalAgentProfiles(db, ctx, dependencies.projectReferences),
    stages: GOVERNED_TEMPLATE.stages,
    resourceUsages: dependencies.resourceUsages,
  };
}
