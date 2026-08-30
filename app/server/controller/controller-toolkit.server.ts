import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { GOAL_ON_FAILURE_VALUES } from "~/schemas/goal-file.schema";
import { PROJECT_ROLES } from "~/schemas/project-file.schema";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import {
  queryAuditEventsForExport,
  type AuditExportFilters,
} from "~/server/audit/audit-export.server";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { assertProjectAction } from "~/server/auth/project-authority.server";
import {
  createLocalAccount,
  listOrgUsers,
  resetLocalPassword,
  setOrgUserRole,
  updateOrgUser,
} from "~/server/org/org-users.server";
import { disableUser, enableUser } from "~/server/auth/user-admin.server";
import {
  listKnowledgeBases,
  listMcpServers,
  listSkills,
  resolveStoreTarget,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
  testMcpServer,
} from "~/server/org/resources.server";
import {
  listGlobalAgentProfiles,
  saveGlobalAgentProfile,
} from "~/server/org/gagents.server";
import { writeStoreDoc } from "~/server/org/store-files.server";
import { getInsightsSummary } from "~/server/insights/insights-query.server";
import { AppError } from "~/server/errors/app-error.server";
import { getGithubViewData } from "~/features/github/github-query.server";
import {
  createProject,
  type CreateProjectInput,
  type CustomProjectBlueprint,
} from "~/features/home/project-create.server";
import { listHomeProjectsForUser } from "~/features/home/home-query.server";
import {
  deployAgentProfileFromLibrary,
  updateAgentProfile,
  type SubmittedProfileForm,
} from "~/features/agents/agent-profile-actions.server";
import {
  effectiveProfileView,
  VIEW_WITHOUT_POLICY,
} from "~/features/agents/agents-query.server";
import {
  addStage,
  inviteMember,
  removeStage,
  renameStage,
  reorderStages,
  updateProjectIdentity,
} from "~/features/project-settings/settings-actions.server";
import {
  setMemberRole,
  setTransitionBoundary,
} from "~/features/policy/policy-actions.server";
import { getProject, listProjectTasks } from "~/server/projections/board-query.server";
import {
  getTaskSummary,
  listTaskEvents,
} from "~/server/projections/task-query.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { postAgentComment } from "~/server/tasks/agent-toolkit.server";
import {
  createGoal,
  getGoalView,
  listGoals,
  updateGoal,
  type CreateGoalInput,
  type UpdateGoalOp,
} from "~/server/tasks/goal-actions.server";
import {
  createTask,
  loadProjectContext,
  releaseOwner,
  requireProjectMutable,
  setOwner,
  transitionStage,
  userName,
  type CreateTaskInput,
} from "~/server/tasks/task-actions.server";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import type { StartAgentRunInput } from "~/server/tasks/specialist-run.server";
import { canRunAgents } from "~/server/auth/project-authority.server";
import { listUsers } from "~/server/auth/user-store.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import { logger } from "~/server/logging/logger.server";

/**
 * The controller's in-process toolkit (ruling 99) — a Claude Agent SDK MCP
 * server ("viberr_controller") whose handlers execute the SAME governed
 * mutations humans reach through routes, with the ASKING USER as the actor.
 *
 * AUTHORITY: every handler resolves the asking user's authority LIVE, per
 * call — org role for instance tools (the /org/settings gate), the project
 * RBAC matrix for board tools (`assertProjectAction` / the actions' own
 * `requireAction`, org-admin override and denial audit included). The
 * controller holds NO authority of its own: a stored grant row would be a
 * toggle with no effect, so none exists.
 *
 * REFUSAL: a gate that refuses answers `[denied] <the guard's own sentence>`
 * so the model can relay it out loud. Project reads answer a uniform
 * not-visible sentence for missing AND forbidden alike (R15-4's 404 posture:
 * a probe must not learn that a project exists).
 *
 * NO DELETES: no tool destroys anything, in either scope. The always-human
 * decisions (merge, acceptance, force-accept, packet resolution, a move into
 * the terminal stage) have no tool here at all — the move tool refuses a
 * terminal target and points at the task page's own ceremony (ruling 88).
 */

export interface ControllerToolkitDeps {
  db: DatabaseSync;
  ctx: { dataRoot?: string };
  /** The asking user — the only authority anything here runs under. */
  user: { id: string; email: string; name: string };
  /** The conversation's bound project, when it has one (tool default). */
  projectSlug?: string | null;
}

export interface ControllerToolkit {
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: SdkMcpToolDefinition<any>[];
}

export const CONTROLLER_TOOLKIT_INSTRUCTIONS =
  "Viberr controller tools. Every action runs under the ASKING PERSON's own permissions, " +
  "checked by the server per call: instance tools follow their org role, board tools follow " +
  "their role in that project. A [denied] answer is final — relay it with its reason. Reads " +
  "are your ground truth; call them before asserting state. Nothing here deletes, merges, " +
  "accepts completions, resolves decision packets, or moves a task into its final stage.";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const prose = normalizeEscapedNewlines;

/** Uniform not-visible copy — missing and forbidden projects read identically. */
function notVisible(slug: string): string {
  return `[denied] No project "${slug}" is visible to you.`;
}

/** Thrown wherever a project read must answer the uniform not-visible
 *  sentence; `run` relays its message verbatim. */
class ProjectNotVisibleError extends Error {}

/** Build the toolkit for one controller turn. */
export function buildControllerToolkit(deps: ControllerToolkitDeps): ControllerToolkit {
  const { db, ctx, user } = deps;
  const dataRoot = ctx.dataRoot;

  /** The authority + audit actor every mutation runs under: the human's id
   *  (guards bind to it) with the instrument disclosed in the label. */
  const actor = { userId: user.id, label: `${user.email} · via controller` };
  const auditActor: AuditActor = actor;

  /** LIVE org role — never snapshotted at conversation start. */
  const orgAdmin = () => isOrgAdmin(db, user.id);

  /** Org-scope gate: refuses with an audited denial row (P13-D-8 parity —
   *  project denials are audited; instance denials must not read cleaner). */
  function requireOrgAdmin(what: string): void {
    if (orgAdmin()) return;
    recordAudit(db, {
      action: "controller.authority.denied",
      actor: auditActor,
      details: { scope: "instance", what },
    });
    throw AppError.forbidden(
      `Only org admins can ${what}. Your org role is member.`,
    );
  }

  /** Membership gate for project READS: missing and forbidden both throw the
   *  same not-visible shape (R15-4). Org admins pass via the audited override. */
  function requireVisible(slug: string, what: string): void {
    try {
      assertProjectAction(db, "any-member", slug, actor, what, {
        dataRoot,
        allowArchived: true,
      });
    } catch {
      throw new ProjectNotVisibleError(notVisible(slug));
    }
  }

  const boundSlug = deps.projectSlug ?? null;
  /** Resolve the tool's project argument against the conversation binding. */
  function slugOf(given?: string): string {
    const slug = (given ?? boundSlug ?? "").trim();
    if (!slug) {
      throw AppError.validation(
        "Name the project (this conversation is not bound to one).",
      );
    }
    return slug;
  }

  /** Wrap a handler: AppError → [denied]/[error] text the model relays. */
  function run(fn: () => Promise<string> | string) {
    return async () => {
      try {
        return textResult(await fn());
      } catch (error) {
        if (error instanceof AppError) {
          const denied = error.status === 403 || error.status === 401;
          return textResult(`[${denied ? "denied" : "error"}] ${error.userMessage}`);
        }
        if (error instanceof ProjectNotVisibleError) {
          return textResult(error.message);
        }
        logger.error("controller tool failed", {
          err: error instanceof Error ? error : new Error(String(error)),
        });
        return textResult(
          "[error] That action failed unexpectedly. The details are in the server log; nothing was partially hidden from the audit trail.",
        );
      }
    };
  }

  /** Same wrapper for handlers that take validated args. */
  function runWith<A>(fn: (args: A) => Promise<string> | string) {
    return async (args: A) => {
      const wrapped = run(() => fn(args));
      return wrapped();
    };
  }

  const json = <T>(value: T) => JSON.stringify(value, null, 1);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [];
  const allowed: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (t: SdkMcpToolDefinition<any>, name: string) => {
    tools.push(t);
    allowed.push(`mcp__viberr_controller__${name}`);
  };

  // ============================================================= instance

  add(
    tool(
      "whoami",
      "The asking person's identity and live authority: org role, visible projects with their project role, and this conversation's project binding. Call it when unsure what the person may do.",
      {},
      run(() => {
        const admin = orgAdmin();
        const projects = listHomeProjectsForUser(db, {
          id: user.id,
          role: admin ? "admin" : "member",
        }).map((p) => {
          const file = readProjectFile({ projectSlug: p.slug, dataRoot });
          const role =
            file?.parsed.frontmatter.members.find((m) => m.userId === user.id)
              ?.role ?? (admin ? "org admin override" : null);
          return { slug: p.slug, name: p.name, role, archived: p.archived };
        });
        return json({
          userId: user.id,
          email: user.email,
          name: user.name,
          orgRole: admin ? "admin" : "member",
          conversationProject: boundSlug,
          projects,
        });
      }),
    ),
    "whoami",
  );

  add(
    tool(
      "list_users",
      "List every Viberr user (id, email, name, org role, status). Org admins only.",
      {},
      run(() => {
        requireOrgAdmin("list users");
        return json(
          listOrgUsers(db).map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            role: u.role,
            status: u.status,
          })),
        );
      }),
    ),
    "list_users",
  );

  add(
    tool(
      "create_user",
      "Create a local Viberr account. Org admins only. Returns a ONE-TIME temporary password you must relay in full: it works once and forces a new password at first sign in.",
      {
        name: z.string().describe("Display name."),
        email: z.string().describe("Sign-in email."),
        role: z.enum(["admin", "member"]).describe("Org role."),
      },
      runWith(async (args: { name: string; email: string; role: "admin" | "member" }) => {
        requireOrgAdmin("create users");
        const result = await createLocalAccount(
          db,
          { name: args.name, email: args.email, role: args.role },
          auditActor,
        );
        return (
          `[done] ${result.user.email} created (org ${result.user.role}). ` +
          `Temporary password (single use, must be changed at first sign in): ${result.tempPassword}`
        );
      }),
    ),
    "create_user",
  );

  add(
    tool(
      "update_user",
      "Update a user's name, email, or org role; enable or disable the account; or reset a local password (returns a new one-time temporary password). Org admins only. Nothing here deletes an account.",
      {
        userId: z.string().describe("The user id (from list_users)."),
        name: z.string().optional(),
        email: z.string().optional(),
        role: z.enum(["admin", "member"]).optional(),
        access: z
          .enum(["enable", "disable"])
          .optional()
          .describe("Flip account access."),
        resetPassword: z
          .boolean()
          .optional()
          .describe("Mint a new one-time temporary password (local accounts)."),
      },
      runWith(
        async (args: {
          userId: string;
          name?: string;
          email?: string;
          role?: "admin" | "member";
          access?: "enable" | "disable";
          resetPassword?: boolean;
        }) => {
          requireOrgAdmin("update users");
          const current = listOrgUsers(db).find((u) => u.id === args.userId);
          if (!current) throw AppError.notFound("No such user.");
          const done: string[] = [];
          if (args.name || args.email || args.role) {
            const updated = updateOrgUser(
              db,
              {
                userId: args.userId,
                name: args.name ?? current.name,
                email: args.email ?? current.email,
                role: args.role ?? current.role,
              },
              auditActor,
            );
            done.push(`profile updated (${updated.email}, org ${updated.role})`);
          }
          if (args.access === "disable") {
            await disableUser(db, args.userId, auditActor);
            done.push("account disabled");
          } else if (args.access === "enable") {
            await enableUser(db, args.userId, auditActor);
            done.push("account enabled");
          }
          if (args.resetPassword) {
            const reset = await resetLocalPassword(db, args.userId, auditActor);
            done.push(
              `password reset. Temporary password (single use): ${reset.tempPassword}`,
            );
          }
          if (done.length === 0) return "[noop] Nothing to change was given.";
          return `[done] ${done.join("; ")}.`;
        },
      ),
    ),
    "update_user",
  );

  add(
    tool(
      "set_user_org_role",
      "Change one user's org role (admin or member). Org admins only. The last active admin cannot be demoted.",
      {
        userId: z.string(),
        role: z.enum(["admin", "member"]),
      },
      runWith(async (args: { userId: string; role: "admin" | "member" }) => {
        requireOrgAdmin("change org roles");
        const updated = setOrgUserRole(
          db,
          { userId: args.userId, role: args.role },
          auditActor,
        );
        return `[done] ${updated.email} is now an org ${updated.role}.`;
      }),
    ),
    "set_user_org_role",
  );

  add(
    tool(
      "list_knowledge_bases",
      "List the org knowledge bases (name, folder, file count, refresh mode). Org admins only.",
      {},
      run(() => {
        requireOrgAdmin("read the org knowledge bases");
        return json(
          listKnowledgeBases(db, { dataRoot }).map((kb) => ({
            id: kb.id,
            name: kb.name,
            dir: kb.dir,
            refresh: kb.refresh,
            files: kb.fileCount,
          })),
        );
      }),
    ),
    "list_knowledge_bases",
  );

  add(
    tool(
      "save_knowledge_base",
      "Create or update a knowledge base (name, refresh mode), optionally writing one document into its folder. Org admins only. No delete exists here.",
      {
        id: z.string().optional().describe("Existing KB id to update; omit to create."),
        name: z.string(),
        refresh: z.enum(["manual", "on change", "nightly"]).optional(),
        doc: z
          .object({
            path: z.string().describe("File name inside the KB folder, e.g. conventions.md."),
            content: z.string(),
          })
          .optional()
          .describe("A document to write into the KB folder."),
      },
      runWith(
        async (args: {
          id?: string;
          name: string;
          refresh?: "manual" | "on change" | "nightly";
          doc?: { path: string; content: string };
        }) => {
          requireOrgAdmin("manage knowledge bases");
          const saved = await saveKnowledgeBase(
            db,
            { id: args.id ?? null, name: args.name, refresh: args.refresh ?? "on change" },
            auditActor,
            { dataRoot },
          );
          let docNote = "";
          if (args.doc) {
            const target = resolveStoreTarget(db, "kb", saved.kb.id, { dataRoot });
            if (!target) {
              return `[done] ${saved.toast}. The document could not be written: the KB folder did not resolve.`;
            }
            writeStoreDoc(db, target, [], args.doc.path, args.doc.content, auditActor, {
              overwrite: true,
            });
            docNote = ` Document ${args.doc.path} written.`;
          }
          return `[done] ${saved.toast}.${docNote}`;
        },
      ),
    ),
    "save_knowledge_base",
  );

  add(
    tool(
      "list_skills",
      "List the org skills (name, summary). Org admins only.",
      {},
      run(() => {
        requireOrgAdmin("read the org skills");
        return json(
          listSkills(db, { dataRoot }).map((s) => ({
            id: s.id,
            name: s.name,
            summary: s.summary,
          })),
        );
      }),
    ),
    "list_skills",
  );

  add(
    tool(
      "save_skill",
      "Create or update an org skill (name, one-line summary, SKILL.md body). Org admins only.",
      {
        id: z.string().optional().describe("Existing skill id to update; omit to create."),
        name: z.string(),
        summary: z.string(),
        body: z.string().optional().describe("SKILL.md content; omit to keep what is on disk."),
      },
      runWith(async (args: { id?: string; name: string; summary: string; body?: string }) => {
        requireOrgAdmin("manage skills");
        const saved = await saveSkill(
          db,
          {
            id: args.id ?? null,
            name: args.name,
            summary: args.summary,
            body: args.body ?? "",
          },
          auditActor,
          { dataRoot },
        );
        return `[done] ${saved.toast}.`;
      }),
    ),
    "save_skill",
  );

  add(
    tool(
      "list_mcp_servers",
      "List the org MCP connections (name, transport, target, health). Org admins only. Credentials are never shown.",
      {},
      run(() => {
        requireOrgAdmin("read the MCP connections");
        return json(
          listMcpServers(db).map((m) => ({
            id: m.id,
            name: m.name,
            transport: m.transport,
            target: m.target,
            up: m.up,
            tools: m.tools,
            hasCredential: m.hasCred,
            lastError: m.lastError,
          })),
        );
      }),
    ),
    "list_mcp_servers",
  );

  add(
    tool(
      "save_mcp_server",
      "Create or update an org MCP connection (name, transport, endpoint or command). Org admins only. Credentials do NOT travel through chat: tell the admin to add the secret in Org settings, then test the server.",
      {
        id: z.string().optional().describe("Existing server id to update; omit to create."),
        name: z.string(),
        transport: z.enum(["HTTP", "stdio"]),
        target: z.string().describe("HTTP endpoint, or the stdio command line."),
      },
      runWith(
        async (args: { id?: string; name: string; transport: "HTTP" | "stdio"; target: string }) => {
          requireOrgAdmin("manage MCP connections");
          const saved = await saveMcpServer(
            db,
            {
              id: args.id ?? null,
              name: args.name,
              transport: args.transport,
              target: args.target,
              cred: "",
            },
            auditActor,
            {},
            { dataRoot },
          );
          return (
            `[done] ${saved.toast}. If it needs a credential, the admin adds it in ` +
            "Org settings (secrets never travel through this chat)."
          );
        },
      ),
    ),
    "save_mcp_server",
  );

  add(
    tool(
      "test_mcp_server",
      "Probe one org MCP connection now and report its health in the command's own words. Org admins only.",
      { id: z.string().describe("The server id (from list_mcp_servers).") },
      runWith(async (args: { id: string }) => {
        requireOrgAdmin("test MCP connections");
        const result = await testMcpServer(db, args.id);
        return `[done] ${result.toast}`;
      }),
    ),
    "test_mcp_server",
  );

  add(
    tool(
      "list_global_agents",
      "List the org's global agent templates (specialists a project can deploy). Org admins only.",
      {},
      run(() => {
        requireOrgAdmin("read the global agent templates");
        return json(
          listGlobalAgentProfiles(db, { dataRoot }).map((g) => ({
            id: g.id,
            name: g.name,
            backend: g.backend,
            summary: g.summary,
            stages: g.stages,
            usedByProjects: g.used,
          })),
        );
      }),
    ),
    "list_global_agents",
  );

  add(
    tool(
      "save_global_agent",
      "Create or update a global agent template (name, backend, summary, persona, eligible stages, resource grants). Org admins only. The controller itself and the operator are system profiles this tool cannot touch.",
      {
        id: z.string().optional().describe("Existing template id to update; omit to create."),
        name: z.string(),
        backend: z.enum(["claude", "codex"]),
        summary: z.string().describe("One scannable paragraph the operator selects by."),
        persona: z.string().optional().describe("The long persona/system-prompt body."),
        stages: z.array(z.string()).min(1).describe("Eligible stage ids, e.g. ready, impl."),
        skills: z.array(z.string()).optional(),
        mcps: z.array(z.string()).optional(),
        kbs: z.array(z.string()).optional(),
      },
      runWith(
        async (args: {
          id?: string;
          name: string;
          backend: "claude" | "codex";
          summary: string;
          persona?: string;
          stages: string[];
          skills?: string[];
          mcps?: string[];
          kbs?: string[];
        }) => {
          requireOrgAdmin("manage global agent templates");
          const saved = saveGlobalAgentProfile(
            db,
            {
              id: args.id ?? null,
              name: args.name,
              backend: args.backend,
              summary: prose(args.summary),
              persona: prose(args.persona ?? ""),
              stages: args.stages,
              skills: args.skills ?? [],
              mcps: args.mcps ?? [],
              kbs: args.kbs ?? [],
            },
            auditActor,
            { dataRoot },
          );
          return `[done] ${saved.toast}.`;
        },
      ),
    ),
    "save_global_agent",
  );

  add(
    tool(
      "inspect_audit_log",
      "Read the audit trail with filters (project, action prefix, actor, time range). Org admins only. Rows are retained 90 days.",
      {
        projectSlug: z.string().optional(),
        action: z.string().optional().describe("Exact action id, e.g. task.created."),
        actorUserId: z.string().optional(),
        since: z.string().optional().describe("ISO timestamp lower bound."),
        until: z.string().optional().describe("ISO timestamp upper bound."),
        limit: z.number().int().min(1).max(200).optional(),
      },
      runWith(
        (args: {
          projectSlug?: string;
          action?: string;
          actorUserId?: string;
          since?: string;
          until?: string;
          limit?: number;
        }) => {
          requireOrgAdmin("inspect the audit log");
          const filters: AuditExportFilters = {};
          if (args.projectSlug) filters.projectSlug = args.projectSlug;
          if (args.action) filters.action = args.action;
          if (args.actorUserId) filters.actorUserId = args.actorUserId;
          if (args.since) filters.since = args.since;
          if (args.until) filters.until = args.until;
          const rows = queryAuditEventsForExport(db, filters);
          const limit = args.limit ?? 50;
          return json({
            total: rows.length,
            shown: Math.min(limit, rows.length),
            rows: rows.slice(0, limit).map((r) => ({
              at: r.occurredAt,
              action: r.action,
              actor: r.actorLabel,
              project: r.projectSlug,
              task: r.taskKey,
              subject: r.subjectId,
            })),
          });
        },
      ),
    ),
    "inspect_audit_log",
  );

  add(
    tool(
      "inspect_run_analytics",
      "Agent-run analytics: totals, success rate, cost and tokens, per-backend/kind/project/model breakdowns, oversight stats. Org admins only. Optionally scoped to one project.",
      { projectSlug: z.string().optional() },
      runWith((args: { projectSlug?: string }) => {
        requireOrgAdmin("inspect run analytics");
        const summary = getInsightsSummary(
          db,
          new Date().toISOString(),
          args.projectSlug ? { projectSlug: args.projectSlug } : undefined,
        );
        return json({
          totals: summary.totals,
          outcomes: summary.outcomes,
          byBackend: summary.byBackend,
          byKind: summary.byKind,
          byProject: summary.byProject,
          byModel: summary.byModel,
          avgDurationMs: summary.avgDurationMs,
          oversight: summary.oversight,
        });
      }),
    ),
    "inspect_run_analytics",
  );

  add(
    tool(
      "create_project",
      "Create a project, optionally with the WHOLE custom shape in one request: stages (entry first, Done-equivalent last), boundary choices, members (existing users by email), description. Open to any signed-in person; the asker becomes the project's admin. Requires a GitHub connection for the repo owner. The move into the final stage stays a human decision whatever is asked. Deploy extra agents afterward with deploy_agent.",
      {
        name: z.string(),
        key: z.string().describe("Task key prefix, 2 to 4 letters."),
        owner: z.string().describe("GitHub owner of the repo (a configured connection)."),
        repoName: z.string().describe("Repository name under that owner."),
        policy: z.enum(["strict", "balanced", "auto"]).describe("strict = humans gate every advance · balanced = defaults · auto = full operator autonomy."),
        description: z.string().optional(),
        stages: z
          .array(z.object({ name: z.string(), color: z.string().optional() }))
          .optional()
          .describe("Custom stage list, 2 to 8, ordered, terminal LAST."),
        boundaries: z
          .array(
            z.object({
              from: z.string().describe("Stage name."),
              to: z.string().describe("Adjacent next stage name."),
              boundary: z.enum(["auto", "approval", "human"]),
            }),
          )
          .optional(),
        members: z
          .array(
            z.object({
              email: z.string(),
              role: z.enum(PROJECT_ROLES),
            }),
          )
          .optional(),
      },
      runWith(
        async (args: {
          name: string;
          key: string;
          owner: string;
          repoName: string;
          policy: "strict" | "balanced" | "auto";
          description?: string;
          stages?: { name: string; color?: string }[];
          boundaries?: { from: string; to: string; boundary: "auto" | "approval" | "human" }[];
          members?: { email: string; role: (typeof PROJECT_ROLES)[number] }[];
        }) => {
          const input: CreateProjectInput = {
            name: args.name,
            key: args.key,
            owner: args.owner,
            repoName: args.repoName,
            policy: args.policy,
          };
          if (args.description || args.stages || args.boundaries || args.members) {
            const custom: CustomProjectBlueprint = {};
            if (args.description) custom.description = args.description;
            if (args.stages) custom.stages = args.stages;
            if (args.boundaries) custom.boundaries = args.boundaries;
            if (args.members) custom.members = args.members;
            input.custom = custom;
          }
          const created = await createProject(db, input, actor, { dataRoot });
          return (
            `[done] Project ${created.name} created at ${created.storePath} (slug ${created.slug}, keys ${created.key}-n). ` +
            `You are its admin.` +
            (created.repoWarning ? ` Warning: ${created.repoWarning}` : "")
          );
        },
      ),
    ),
    "create_project",
  );

  // ============================================================== project

  add(
    tool(
      "get_project",
      "One project's live shape: stages with task counts, workflow boundaries, members with roles, deployed agents, goals summary. Membership gated.",
      { projectSlug: z.string().optional().describe("Defaults to this conversation's project.") },
      runWith((args: { projectSlug?: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project");
        const project = getProject(db, slug);
        const file = readProjectFile({ projectSlug: slug, dataRoot });
        if (!project || !file) throw new ProjectNotVisibleError(notVisible(slug));
        const tasks = listProjectTasks(db, slug, { dataRoot });
        const users = new Map(listUsers(db).map((u) => [u.id, u]));
        const counts = new Map<string, number>();
        for (const t of tasks) counts.set(t.stage, (counts.get(t.stage) ?? 0) + 1);
        const fm = file.parsed.frontmatter;
        return json({
          slug,
          name: project.name,
          repo: project.repo,
          archived: project.archived,
          description: project.description,
          stages: project.stages.map((s) => ({
            id: s.id,
            name: s.name,
            tasks: counts.get(s.id) ?? 0,
          })),
          workflow: project.workflow,
          members: fm.members.map((m) => ({
            userId: m.userId,
            role: m.role,
            name: users.get(m.userId)?.name ?? m.userId,
            email: users.get(m.userId)?.email ?? null,
          })),
          agents: fm.agents.map((a) => {
            const view = effectiveProfileView(a, dataRoot, VIEW_WITHOUT_POLICY);
            return {
              profileId: a.profileId,
              name: view.name,
              kind: view.kind,
              backends: view.backends,
              stages: view.stages,
            };
          }),
          goals: listGoals(db, slug).map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
            link: g.currentIndex,
            links: g.links.length,
          })),
        });
      }),
    ),
    "get_project",
  );

  add(
    tool(
      "list_tasks",
      "A project's tasks: key, title, stage, readiness, waiting, owner, priority, goal-chain chip. Membership gated. Includes Done; archived only when asked.",
      {
        projectSlug: z.string().optional(),
        stageId: z.string().optional().describe("Filter to one stage."),
        includeArchived: z.boolean().optional(),
      },
      runWith((args: { projectSlug?: string; stageId?: string; includeArchived?: boolean }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's tasks");
        const listOpts: NonNullable<Parameters<typeof listProjectTasks>[2]> = {
          dataRoot,
        };
        if (args.includeArchived) listOpts.includeArchived = true;
        const rows = listProjectTasks(db, slug, listOpts).filter(
          (t) => !args.stageId || t.stage === args.stageId,
        );
        return json(
          rows.map((t) => ({
            key: t.key,
            title: t.title,
            stage: t.stage,
            readiness: t.readiness,
            waiting: t.waiting,
            owner: t.owner?.name ?? null,
            priority: t.priority,
            archived: t.archived,
            goal: t.goalRef ? { goalId: t.goalRef.goalId, link: t.goalRef.linkIndex } : null,
          })),
        );
      }),
    ),
    "list_tasks",
  );

  add(
    tool(
      "get_task",
      "One task's live state: stage, readiness, goal text, engaged agents, PR state, open packet, plus the newest timeline events. Membership gated. Historical (Done, archived) tasks read the same way.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string(),
        events: z.number().int().min(1).max(50).optional().describe("Newest timeline events to include (default 12)."),
      },
      runWith((args: { projectSlug?: string; taskKey: string; events?: number }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this task");
        const summary = getTaskSummary(db, slug, args.taskKey);
        if (!summary) throw AppError.notFound(`No task ${args.taskKey} in ${slug}.`);
        const events = listTaskEvents(db, slug, args.taskKey)
          .slice(0, args.events ?? 12)
          .map((e) => ({
            at: e.occurredAt,
            type: e.type,
            by: e.actor.kind === "human" ? e.actor.name : e.actor.kind === "system" ? e.actor.name : `${e.actor.name} (agent)`,
            title: e.title,
            text: e.text.length > 700 ? `${e.text.slice(0, 700)}…` : e.text,
          }));
        return json({ task: summary, newestEvents: events });
      }),
    ),
    "get_task",
  );

  add(
    tool(
      "create_task",
      "Create a task at the project's entry stage (every task passes the triage gate). Contributor or above.",
      {
        projectSlug: z.string().optional(),
        title: z.string(),
        goal: z.string().optional().describe("The task text: deliverable plus the done signal."),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
        labels: z.array(z.string()).optional(),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          title: string;
          goal?: string;
          priority?: "low" | "normal" | "high" | "urgent";
          labels?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          const taskInput: CreateTaskInput = {
            projectSlug: slug,
            title: args.title,
          };
          if (args.goal) taskInput.goal = prose(args.goal);
          if (args.priority) taskInput.priority = args.priority;
          if (args.labels) taskInput.labels = args.labels;
          const created = await createTask(db, taskInput, actor, { dataRoot });
          return `[done] ${created.key} created in ${created.stageName}: ${created.task.title}.`;
        },
      ),
    ),
    "create_task",
  );

  add(
    tool(
      "move_task",
      "Move a task to another stage. Workflow boundaries and your project role decide; a move into the final Done stage is refused here, because acceptance is decided on the task page with its own confirmation.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string(),
        toStageId: z.string().describe("Target stage id (from get_project)."),
      },
      runWith(async (args: { projectSlug?: string; taskKey: string; toStageId: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "move tasks");
        const project = getProject(db, slug);
        if (!project) throw new ProjectNotVisibleError(notVisible(slug));
        const terminal = project.stages[project.stages.length - 1];
        if (terminal && args.toStageId === terminal.id) {
          return (
            `[denied] Moving ${args.taskKey} into ${terminal.name} means accepting its completion, ` +
            `which carries its own confirmation and merge consequences. Decide it on the task page: ` +
            `projects/${slug}/tasks/${args.taskKey}.`
          );
        }
        const summary = getTaskSummary(db, slug, args.taskKey);
        if (!summary) throw AppError.notFound(`No task ${args.taskKey} in ${slug}.`);
        // `manual` ALWAYS, exactly as the board drag and the task dropdown send
        // it. It is what marks a move as a person's own decision, and it is
        // what puts every move behind `approve-transition`. Leaving it off for
        // declared edges would drop an `auto` boundary to the any-member gate
        // that `transitionStage` documents as unreachable from the UI — so a
        // viewer could cross through the controller what they cannot cross on
        // the board. The controller is the human's instrument, never a looser
        // door than the one they already have.
        const move: Parameters<typeof transitionStage>[1] = {
          projectSlug: slug,
          taskKey: args.taskKey,
          toStageId: args.toStageId,
          manual: true,
        };
        const moved = await transitionStage(db, move, actor, { dataRoot });
        return `[done] ${args.taskKey} is now in stage ${moved.stage}.`;
      }),
    ),
    "move_task",
  );

  add(
    tool(
      "comment_on_task",
      "Post a controller comment on a task's timeline: publish information for humans, or brief agents. @mentions notify people. It never starts a run by itself; use run_agent_on_task to put an agent to work.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string(),
        text: z.string(),
      },
      runWith(async (args: { projectSlug?: string; taskKey: string; text: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "comment on this task");
        // Commenting names no RbacAction, so it never passes through
        // `requireAction` — the chokepoint that freezes an archived project.
        // The human comment path guards it explicitly for exactly this reason
        // (R6-3), and `requireVisible` deliberately allows archived projects so
        // that READS keep working. Without this the controller is the one door
        // that writes into a frozen timeline.
        requireProjectMutable(
          loadProjectContext({ dataRoot }, slug),
          "comment on this task",
        );
        const summary = getTaskSummary(db, slug, args.taskKey);
        if (!summary) throw AppError.notFound(`No task ${args.taskKey} in ${slug}.`);
        const text = `${prose(args.text).trim()}\n\n_Posted by the controller for ${userName(db, user.id)}._`;
        await postAgentComment(db, { dataRoot }, {
          projectSlug: slug,
          taskKey: args.taskKey,
          actorRef: { kind: "controller" },
          text,
        });
        return `[done] Comment posted on ${args.taskKey}.`;
      }),
    ),
    "comment_on_task",
  );

  add(
    tool(
      "set_task_owner",
      "Assign a task's human owner: the asking person themselves, another member, or release it. Contributor+ for self, ownership rules apply for others.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string(),
        owner: z
          .string()
          .describe('A member email, "me" for the asking person, or "none" to release.'),
      },
      runWith(async (args: { projectSlug?: string; taskKey: string; owner: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "change task ownership");
        const who = args.owner.trim().toLowerCase();
        if (who === "none") {
          await releaseOwner(
            db,
            { projectSlug: slug, taskKey: args.taskKey },
            actor,
            { dataRoot },
          );
          return `[done] ${args.taskKey} is now unowned.`;
        }
        const target =
          who === "me"
            ? user.id
            : listUsers(db).find((u) => u.email.toLowerCase() === who)?.id;
        if (!target) throw AppError.notFound(`No Viberr user with the email ${args.owner}.`);
        const updated = await setOwner(
          db,
          { projectSlug: slug, taskKey: args.taskKey, targetUserId: target },
          actor,
          { dataRoot },
        );
        return `[done] ${args.taskKey} is owned by ${updated.owner?.name ?? target}.`;
      }),
    ),
    "set_task_owner",
  );

  add(
    tool(
      "run_agent_on_task",
      "Put an agent to work on a task with a directive: the operator (coordination) or a deployed agent profile (stage work). Maintainer or above. The result reports honestly whether a run started.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string(),
        agent: z
          .string()
          .describe('"operator", or a deployed profile id from get_project.'),
        prompt: z.string().optional().describe("The directive: what to do for this task."),
      },
      runWith(
        async (args: { projectSlug?: string; taskKey: string; agent: string; prompt?: string }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "run agents");
          const file = readProjectFile({ projectSlug: slug, dataRoot });
          if (!file) throw new ProjectNotVisibleError(notVisible(slug));
          const authority = {
            slug,
            memberRoles: new Map(
              file.parsed.frontmatter.members.map((m) => [m.userId, m.role] as const),
            ),
            archived: file.parsed.frontmatter.archived === true,
          };
          if (!canRunAgents(db, authority, actor, "run agents through the controller")) {
            return "[denied] Running agents needs the maintainer role (or project admin) in this project.";
          }
          const display = userName(db, user.id);
          if (args.agent.trim().toLowerCase() === "operator") {
            const { runOperator } = await import(
              "~/server/runtimes/operator-run.server"
            );
            const operatorInput: RunOperatorInput = {
              projectSlug: slug,
              taskKey: args.taskKey,
              trigger: "manual",
              actor: auditActor,
            };
            if (args.prompt) {
              operatorInput.humanComment = prose(args.prompt);
              operatorInput.humanCommentBy = display;
            }
            if (dataRoot) operatorInput.dataRoot = dataRoot;
            const result = await runOperator(db, operatorInput);
            if (result.refused === "open-packet") {
              return "[denied] The operator is not run while a decision packet is open. Answer the packet first.";
            }
            if (result.refused === "terminal-stage") {
              return `[denied] ${args.taskKey} is already Done; there is nothing for the operator to coordinate.`;
            }
            if (result.queued) {
              return `[done] The operator is already working ${args.taskKey}; your directive was queued for it.`;
            }
            return `[done] Operator run started on ${args.taskKey}.`;
          }
          const { startAgentRun } = await import(
            "~/server/tasks/specialist-run.server"
          );
          const runInput: StartAgentRunInput = {
            projectSlug: slug,
            taskKey: args.taskKey,
            profileId: args.agent.trim(),
            triggeredByName: display,
            triggeredByUserId: user.id,
          };
          if (args.prompt) {
            runInput.directive = prose(args.prompt);
            runInput.directiveFrom = display;
          }
          const started = await startAgentRun(db, runInput, actor, { dataRoot });
          return `[done] ${started.name} run started on ${args.taskKey} (${started.backend}).`;
        },
      ),
    ),
    "run_agent_on_task",
  );

  add(
    tool(
      "get_github_state",
      "The project's GitHub view: connection and credential health, task branches with sync state, pull requests with checks/review/mergeability, and how fresh the cache is. Membership gated. Read-only; Update status lives on the GitHub page.",
      { projectSlug: z.string().optional() },
      runWith(async (args: { projectSlug?: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's GitHub state");
        const data = await getGithubViewData(db, slug);
        if (!data) throw new ProjectNotVisibleError(notVisible(slug));
        return json({
          repo: data.project.repo,
          defaultBranch: data.project.defaultBranch,
          connection: data.connection.status,
          reconcile: data.reconcile,
          prs: data.prs.map((p) => ({
            task: p.taskKey,
            number: p.number,
            state: p.state,
            title: p.title,
            checks: p.checks,
            review: p.review,
            mergeable: p.mergeable,
          })),
          branches: data.branches.map((b) => ({
            task: b.taskKey,
            branch: b.branch,
            sync: b.sync,
          })),
        });
      }),
    ),
    "get_github_state",
  );

  add(
    tool(
      "update_project_settings",
      "Update a project's name, task-key prefix, or description. Project admin.",
      {
        projectSlug: z.string().optional(),
        name: z.string().optional(),
        prefix: z.string().optional(),
        description: z.string().optional(),
      },
      runWith(
        async (args: { projectSlug?: string; name?: string; prefix?: string; description?: string }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "read this project");
          const project = getProject(db, slug);
          if (!project) throw new ProjectNotVisibleError(notVisible(slug));
          const result = await updateProjectIdentity(
            db,
            {
              projectSlug: slug,
              name: args.name ?? project.name,
              prefix: args.prefix ?? project.taskPrefix,
              description: args.description ?? project.description,
            },
            actor,
            { dataRoot },
          );
          return `[done] ${result.toast}.`;
        },
      ),
    ),
    "update_project_settings",
  );

  add(
    tool(
      "update_stages",
      "Edit the project's stage list: add (inserted before the final stage), rename, remove, or reorder. Project admin. The workflow chain follows automatically; removing a stage never loosens a boundary.",
      {
        projectSlug: z.string().optional(),
        op: z.enum(["add", "rename", "remove", "reorder"]),
        stageId: z.string().optional().describe("rename/remove: the stage id."),
        name: z.string().optional().describe("add/rename: the stage name."),
        orderedIds: z.array(z.string()).optional().describe("reorder: every stage id, new order."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          op: "add" | "rename" | "remove" | "reorder";
          stageId?: string;
          name?: string;
          orderedIds?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "edit this project's stages");
          if (args.op === "add") {
            if (!args.name) throw AppError.validation("Give the new stage a name.");
            const added = await addStage(db, { projectSlug: slug, name: args.name }, actor, { dataRoot });
            return `[done] ${added.toast} (id ${added.stageId}).`;
          }
          if (args.op === "rename") {
            if (!args.stageId || !args.name) {
              throw AppError.validation("Renaming needs stageId and name.");
            }
            const renamed = await renameStage(
              db,
              { projectSlug: slug, stageId: args.stageId, name: args.name },
              actor,
              { dataRoot },
            );
            return `[done] ${renamed.toast}.`;
          }
          if (args.op === "remove") {
            if (!args.stageId) throw AppError.validation("Removing needs stageId.");
            const removed = await removeStage(
              db,
              { projectSlug: slug, stageId: args.stageId },
              actor,
              { dataRoot },
            );
            return `[done] ${removed.toast}.`;
          }
          if (!args.orderedIds?.length) {
            throw AppError.validation("Reordering needs orderedIds.");
          }
          const reordered = await reorderStages(
            db,
            { projectSlug: slug, orderedIds: args.orderedIds },
            actor,
            { dataRoot },
          );
          return `[done] ${reordered.toast}.`;
        },
      ),
    ),
    "update_stages",
  );

  add(
    tool(
      "set_transition_boundary",
      "Set who decides one workflow move: auto (the operator advances), approval (a human approves), or human (a human performs it). Project admin. The move into the final stage is locked human.",
      {
        projectSlug: z.string().optional(),
        from: z.string().describe("From-stage id."),
        to: z.string().describe("To-stage id (adjacent)."),
        boundary: z.enum(["auto", "approval", "human"]),
      },
      runWith(
        async (args: { projectSlug?: string; from: string; to: string; boundary: "auto" | "approval" | "human" }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "edit this project's policy");
          const result = await setTransitionBoundary(
            db,
            { projectSlug: slug, from: args.from, to: args.to, boundary: args.boundary },
            actor,
            { dataRoot },
          );
          return `[done] ${result.toast}.`;
        },
      ),
    ),
    "set_transition_boundary",
  );

  add(
    tool(
      "invite_member",
      "Add a member to the project by email (an unknown email gets a new account with a one-time temporary password you must relay). Project admin. Set the role afterward with set_member_role (new members join as contributor).",
      {
        projectSlug: z.string().optional(),
        name: z.string(),
        email: z.string(),
      },
      runWith(async (args: { projectSlug?: string; name: string; email: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "manage this project's members");
        const result = await inviteMember(
          db,
          { projectSlug: slug, name: args.name, email: args.email },
          actor,
          { dataRoot },
        );
        return (
          `[done] ${result.toast}` +
          (result.tempPassword
            ? ` Temporary password (single use, must be changed at first sign in): ${result.tempPassword}`
            : "")
        );
      }),
    ),
    "invite_member",
  );

  add(
    tool(
      "set_member_role",
      "Change one member's project role (admin, maintainer, contributor, viewer). Project admin. The last project admin cannot be demoted.",
      {
        projectSlug: z.string().optional(),
        email: z.string().describe("The member's email."),
        role: z.enum(PROJECT_ROLES),
      },
      runWith(
        async (args: { projectSlug?: string; email: string; role: (typeof PROJECT_ROLES)[number] }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "manage this project's members");
          const target = listUsers(db).find(
            (u) => u.email.toLowerCase() === args.email.trim().toLowerCase(),
          );
          if (!target) throw AppError.notFound(`No Viberr user with the email ${args.email}.`);
          const result = await setMemberRole(
            db,
            { projectSlug: slug, targetUserId: target.id, role: args.role },
            actor,
            { dataRoot },
          );
          return `[done] ${result.toast}.`;
        },
      ),
    ),
    "set_member_role",
  );

  add(
    tool(
      "deploy_agent",
      "Deploy a global agent template into the project (from list_global_agents; delivery starts withheld until an admin opens it up). Project admin. No removal exists here.",
      {
        projectSlug: z.string().optional(),
        profileId: z.string(),
      },
      runWith(async (args: { projectSlug?: string; profileId: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "manage this project's agents");
        const result = await deployAgentProfileFromLibrary(
          db,
          { projectSlug: slug, profileId: args.profileId },
          actor,
          { dataRoot },
        );
        return `[done] ${result.name} deployed on ${slug}. Delivery starts withheld; open it up with update_agent_deployment when the profile should write the repo.`;
      }),
    ),
    "deploy_agent",
  );

  add(
    tool(
      "update_agent_deployment",
      "Update one deployed agent's project configuration: capability modes (direct, recommend for the operator, human, off), backend, model, eligible stages, or operator autonomy. Project admin. Merge semantics: only the fields you pass change.",
      {
        projectSlug: z.string().optional(),
        profileId: z.string(),
        capabilities: z
          .array(z.object({ capabilityId: z.string(), mode: z.enum(["direct", "recommend", "human", "off"]) }))
          .optional(),
        backend: z.enum(["claude", "codex"]).optional(),
        model: z.string().optional(),
        stages: z.array(z.string()).optional(),
        autonomy: z.enum(["supervised", "full"]).optional().describe("Operator only."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          profileId: string;
          capabilities?: { capabilityId: string; mode: "direct" | "recommend" | "human" | "off" }[];
          backend?: "claude" | "codex";
          model?: string;
          stages?: string[];
          autonomy?: "supervised" | "full";
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "manage this project's agents");
          const file = readProjectFile({ projectSlug: slug, dataRoot });
          const deployment = file?.parsed.frontmatter.agents.find(
            (a) => a.profileId === args.profileId,
          );
          if (!file || !deployment) {
            throw AppError.notFound(`No agent ${args.profileId} is deployed on ${slug}.`);
          }
          const view = effectiveProfileView(deployment, dataRoot, VIEW_WITHOUT_POLICY);
          const caps: Record<string, string> = {};
          for (const grant of deployment.capabilities) caps[grant.capabilityId] = grant.mode;
          for (const patch of args.capabilities ?? []) caps[patch.capabilityId] = patch.mode;
          const baseForm = {
            name: view.name,
            role: view.role,
            backend: args.backend ?? (view.backends[0] === "codex" ? "codex" : "claude"),
            stages: args.stages ?? view.stages,
            definition: "",
            persona: "",
            model: args.model ?? view.model,
            effort: view.effort,
            caps,
            resources: view.resources,
          };
          // The downstream form schema reads autonomy as optional, so an
          // undefined value and an absent key parse identically.
          let form: SubmittedProfileForm = baseForm;
          if (view.kind === "operator") {
            const autonomy = args.autonomy ?? view.autonomy;
            if (autonomy) form = { ...baseForm, autonomy };
          }
          const result = await updateAgentProfile(
            db,
            { projectSlug: slug, profileId: args.profileId, form },
            actor,
            { dataRoot },
          );
          const notices = result.notices?.length
            ? ` Notes: ${result.notices.map((n) => n.message).join(" ")}`
            : "";
          const governance = result.governanceNotice
            ? ` ${result.governanceNotice.message}`
            : "";
          return `[done] ${result.name} updated on ${slug}.${governance}${notices}`;
        },
      ),
    ),
    "update_agent_deployment",
  );

  // ================================================================ goals

  add(
    tool(
      "create_goal",
      "Define a chained goal: one outcome decomposed into an ordered chain of tasks. Link 1's task is created now; each later task is created when the previous link completes, and every task's own operator does the work. Contributor or above (a chain is future task creation).",
      {
        projectSlug: z.string().optional(),
        title: z.string(),
        description: z.string().optional().describe("The outcome, in prose."),
        onFailure: z
          .enum(GOAL_ON_FAILURE_VALUES)
          .optional()
          .describe("pause (default): a failed link parks the chain for humans · continue: skip past failures."),
        links: z
          .array(
            z.object({
              title: z.string(),
              goal: z.string().describe("Self-standing task text: deliverable plus the done signal."),
            }),
          )
          .min(1)
          .max(20),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          title: string;
          description?: string;
          onFailure?: "pause" | "continue";
          links: { title: string; goal: string }[];
        }) => {
          const slug = slugOf(args.projectSlug);
          const goalInput: CreateGoalInput = {
            projectSlug: slug,
            title: args.title,
            links: args.links.map((l) => ({ title: l.title, goal: prose(l.goal) })),
          };
          if (args.description) goalInput.description = prose(args.description);
          if (args.onFailure) goalInput.onFailure = args.onFailure;
          const result = await createGoal(db, goalInput, actor, { dataRoot });
          return `[done] ${result.message}`;
        },
      ),
    ),
    "create_goal",
  );

  add(
    tool(
      "list_goals",
      "The project's goal chains with status and link progress. Membership gated.",
      { projectSlug: z.string().optional() },
      runWith((args: { projectSlug?: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's goals");
        return json(
          listGoals(db, slug).map((g) => ({
            id: g.id,
            title: g.title,
            status: g.status,
            createdBy: g.createdByLabel,
            currentLink: g.currentIndex,
            links: g.links.map((l) => ({
              index: l.index,
              title: l.title,
              status: l.status,
              taskKey: l.taskKey,
            })),
          })),
        );
      }),
    ),
    "list_goals",
  );

  add(
    tool(
      "get_goal",
      "One goal chain in full: description, every link with its task and status, and the chain's history. Membership gated.",
      { projectSlug: z.string().optional(), goalId: z.string() },
      runWith((args: { projectSlug?: string; goalId: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's goals");
        const goal = getGoalView(slug, args.goalId, { dataRoot });
        if (!goal) throw AppError.notFound(`No goal ${args.goalId} in ${slug}.`);
        return json(goal);
      }),
    ),
    "get_goal",
  );

  add(
    tool(
      "update_goal",
      "Redirect a goal chain: pause, resume, cancel, skip a link, retry a failed link (a fresh task), edit a pending or failed link, add a link, or remove a pending link. The creator or a maintainer+. Completed and cancelled chains stay readable; nothing is deleted.",
      {
        projectSlug: z.string().optional(),
        goalId: z.string(),
        op: z.enum([
          "pause",
          "resume",
          "cancel",
          "skip_link",
          "retry_link",
          "edit_link",
          "add_link",
          "remove_pending_link",
        ]),
        index: z.number().int().min(1).optional().describe("The link the op targets."),
        title: z.string().optional(),
        goal: z.string().optional(),
        reason: z.string().optional(),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          goalId: string;
          op:
            | "pause"
            | "resume"
            | "cancel"
            | "skip_link"
            | "retry_link"
            | "edit_link"
            | "add_link"
            | "remove_pending_link";
          index?: number;
          title?: string;
          goal?: string;
          reason?: string;
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "redirect this project's goals");
          const needIndex = ["skip_link", "retry_link", "edit_link", "remove_pending_link"];
          if (needIndex.includes(args.op) && !args.index) {
            throw AppError.validation(`${args.op} needs the link index.`);
          }
          let action: UpdateGoalOp;
          switch (args.op) {
            case "pause":
              action = { op: "pause" };
              break;
            case "resume":
              action = { op: "resume" };
              break;
            case "cancel":
              action = args.reason
                ? { op: "cancel", reason: args.reason }
                : { op: "cancel" };
              break;
            case "skip_link":
              action = args.reason
                ? { op: "skip_link", index: args.index!, reason: args.reason }
                : { op: "skip_link", index: args.index! };
              break;
            case "retry_link":
              action = { op: "retry_link", index: args.index! };
              break;
            case "edit_link": {
              const edit: Extract<UpdateGoalOp, { op: "edit_link" }> = {
                op: "edit_link",
                index: args.index!,
              };
              if (args.title) edit.title = args.title;
              if (args.goal) edit.goal = prose(args.goal);
              action = edit;
              break;
            }
            case "add_link":
              if (!args.title) throw AppError.validation("add_link needs a title.");
              action = { op: "add_link", title: args.title, goal: prose(args.goal ?? "") };
              break;
            case "remove_pending_link":
              action = { op: "remove_pending_link", index: args.index! };
              break;
          }
          const result = await updateGoal(
            db,
            { projectSlug: slug, goalId: args.goalId, action },
            actor,
            { dataRoot },
          );
          return `[done] ${result.message} Goal ${result.goalId} is ${result.status}${result.activeTaskKey ? ` on ${result.activeTaskKey}` : ""}.`;
        },
      ),
    ),
    "update_goal",
  );

  const server = createSdkMcpServer({
    name: "viberr_controller",
    version: "1.0.0",
    instructions: CONTROLLER_TOOLKIT_INSTRUCTIONS,
    tools,
  });

  return {
    mcpServers: { viberr_controller: server },
    allowedTools: allowed,
    tools,
  };
}
