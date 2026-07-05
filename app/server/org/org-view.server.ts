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
  stages: StageDef[];
}

export function getOrgSettingsView(
  db: Database.Database,
  ctx: OrgSeedContext = {},
): OrgSettingsView {
  return {
    connections: listConnections(db),
    users: listOrgUsers(db),
    domains: listDomains(db),
    kbs: listKnowledgeBases(db, ctx),
    mcps: listMcpServers(db),
    skills: listSkills(db, ctx),
    gagents: listGlobalAgentProfiles(db, ctx),
    stages: GOVERNED_TEMPLATE.stages,
  };
}
