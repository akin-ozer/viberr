import type { DatabaseSync } from "node:sqlite";
import type { StageDef } from "~/schemas/project-file.schema";
import { getEnv } from "~/server/config/env.server";
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
  /**
   * F18-3: which OAuth sign-in providers are actually configured on this
   * deployment. The Allow-access modal keys its default method + which OAuth
   * options it offers off this — mirroring R17-4's login-page rule — so it never
   * defaults to (or promises) a GitHub/Google sign-in the deployment can't grant.
   */
  providers: { github: boolean; google: boolean };
}

export function getOrgSettingsView(
  db: DatabaseSync,
  ctx: OrgSeedContext = {},
): OrgSettingsView {
  const env = getEnv();
  return {
    connections: listConnections(db),
    users: listOrgUsers(db),
    domains: listDomains(db),
    kbs: listKnowledgeBases(db, ctx),
    mcps: listMcpServers(db),
    skills: listSkills(db, ctx),
    gagents: listGlobalAgentProfiles(db, ctx),
    stages: GOVERNED_TEMPLATE.stages,
    providers: {
      github: Boolean(
        env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET,
      ),
      google: Boolean(
        env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET,
      ),
    },
  };
}
