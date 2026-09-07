import type { DatabaseSync } from "node:sqlite";
import {
  assertEffortForBackend,
  assertModelForBackend,
  defaultEffortFor,
  defaultModelFor,
} from "~/server/runtimes/model-catalog.server";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  UNIFIED_CAP_CATALOG,
  capabilityById,
  type CapabilityKind,
} from "~/shared/capabilities";
import { capabilityPatchRefusal,
  OPERATOR_CAP_MODES,
  SPECIALIST_CAP_MODES,
} from "~/features/agents/capability-catalog";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { GOAL_ON_FAILURE_VALUES } from "~/schemas/goal-file.schema";
import { PROJECT_ROLES } from "~/schemas/project-file.schema";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  queryAuditEventsForExport,
  type AuditExportFilters,
} from "~/server/audit/audit-export.server";
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
  KB_REFRESH_MODES,
  type KbRefreshMode,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
  testMcpServer,
} from "~/server/org/resources.server";
import {
  listGlobalAgentProfiles,
  resolveResourceGrants,
  saveGlobalAgentProfile,
  type SaveGagentInput,
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
  deploymentFingerprint,
} from "~/features/agents/agent-profile-actions.server";
import {
  effectiveProfileView,
  VIEW_WITHOUT_POLICY,
  assembleAgentRoster,
  absentGrantMode,
  POLICY_DEPENDENT_CAPABILITY_IDS,
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
  setTaskMetadata,
  transitionStage,
  updateTaskGoal,
  userName,
  type CreateTaskInput,
} from "~/server/tasks/task-actions.server";
import { setTaskDependencies } from "~/server/tasks/dependencies.server";
import { PRIORITY_VALUES } from "~/schemas/task-file.schema";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import type { StartAgentRunInput } from "~/server/tasks/specialist-run.server";
import { canRunAgents } from "~/server/auth/project-authority.server";
import { listUsers } from "~/server/auth/user-store.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import {
  cancelScheduledAction,
  scheduleTaskAction,
} from "~/server/tasks/schedule.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  describeDriftLists,
  listTemplateResourceDrift,
  type TemplateCopyDrift,
} from "~/server/org/template-propagation.server";
import { displayNameRefusal, normalizeDisplayName } from "~/shared/names";
import {
  controllerToolGuards,
  NotVisibleError,
  notVisible,
} from "./controller-tool-guards.server";

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
  /** Ruling 121: the conversation's anchored task, when it has one — every
   *  task tool's `taskKey` defaults to it. */
  taskKey?: string | null;
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
  "accepts completions, resolves decision packets, or moves a task into its final stage. " +
  "When the conversation is bound to a project, tools default to it; when it is anchored to a " +
  "task, the task tools default to that task as well.";

const prose = normalizeEscapedNewlines;

/**
 * Ruling 156: "1 project copy does not carry this change: k9c-k9s-clone is
 * missing MCP server context7." One clause per project, joined with
 * semicolons; a copy holding grants the template does not says so too.
 */
function divergedSentence(diverged: TemplateCopyDrift[]): string {
  const clauses = diverged.map((d) => {
    const missing = describeDriftLists(d.drift.missing);
    const extra = describeDriftLists(d.drift.extra);
    const parts: string[] = [];
    if (missing.length) parts.push(`is missing ${missing.join(", ")}`);
    if (extra.length) parts.push(`holds ${extra.join(", ")} the template does not`);
    return `${d.projectSlug} ${parts.join(" and ")}`;
  });
  const n = diverged.length;
  return `${n} project cop${n === 1 ? "y does" : "ies do"} not carry this change: ${clauses.join("; ")}.`;
}

/** The ceiling the task page's schedule form applies (28 days). */
const SCHEDULE_MAX_MINUTES = 40_320;

/** Build the toolkit for one controller turn. */
export function buildControllerToolkit(deps: ControllerToolkitDeps): ControllerToolkit {
  const { db, ctx, user } = deps;
  const dataRoot = ctx.dataRoot;

  // The refusal voice, the live-authority gates and the audit actor are shared
  // with the controller's other in-process server (`viberr_ops`, ruling 107):
  // one definition, so a reworded refusal cannot drift between them.
  const { actor, orgAdmin, requireOrgAdmin, requireVisible, run, runWith, json } =
    controllerToolGuards(db, user, dataRoot);
  const auditActor: AuditActor = actor;

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
  const boundTask = deps.taskKey ?? null;
  /**
   * Resolve a task tool's key against the conversation's anchor (ruling 121).
   *
   * The anchor only applies to ITS OWN project. A call that overrides
   * `projectSlug` and leaves `taskKey` off used to silently inherit the
   * anchored key and act on a same-named task in the other project - a write
   * nobody named (review finding 4). Naming the task is required there.
   */
  function keyOf(given: string | undefined, slug: string): string {
    const named = given?.trim();
    if (named) return named;
    if (boundTask && slug === boundSlug) return boundTask;
    if (boundTask) {
      throw AppError.validation(
        `This conversation is anchored to ${boundTask} in ${boundSlug}; name the task in ${slug}.`,
      );
    }
    throw AppError.validation(
      "Name the task (this conversation is not anchored to one).",
    );
  }

  /**
   * U35-1 (pass 35): a display name as the person meant it. The model sent
   * `Test &amp; CI Engineer` and the writer stored the entity; decode once,
   * refuse markup, and let the writer derive the id from the clean text.
   */
  function personName(raw: string): string {
    const name = normalizeDisplayName(raw);
    const refusal = displayNameRefusal(name);
    if (refusal) throw AppError.validation(refusal);
    return name;
  }

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
      "The asking person's identity and live authority: org role, visible projects with their project role, and this conversation's bindings (project, and the anchored task when there is one). Call it when unsure what the person may do.",
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
          conversationTask: boundTask,
          projects,
        });
      }),
    ),
    "whoami",
  );

  add(
    tool(
      "list_capabilities",
      "The capability catalogue the deployments are written against (ruling 139): for each kind (the operator, a specialist) the settable ids with their label, the modes that kind takes, and `whenUngranted`, the mode a deployment RESOLVES to when project.md carries no grant for the id (not the create-seed default). `deliver-review-pr` and `update-task-branch` depend on the project's workflow policy: read get_project for a deployment's resolved mode. Any signed-in person; instance scope.",
      {},
      run(() => {
        const policyDependent = new Set(POLICY_DEPENDENT_CAPABILITY_IDS);
        const kindRows = (kind: CapabilityKind) =>
          UNIFIED_CAP_CATALOG.filter((c) => c.kinds.includes(kind) && c.group !== null).map(
            (c) => ({
              id: c.id,
              label: c.label,
              whenUngranted:
                kind === "operator" && policyDependent.has(c.id)
                  ? "project policy (see get_project)"
                  : absentGrantMode(kind, c),
              alwaysHuman: ALWAYS_HUMAN_CAPABILITY_IDS.includes(c.id),
            }),
          );
        return json({
          note:
            "whenUngranted is the mode a deployment resolves to when the grant is ABSENT from project.md. update_agent_deployment refuses an id outside the kind's list, a mode the kind does not take, a non-human mode on an always-human id, and report-validation-verdict at any mode but direct or off.",
          kinds: {
            operator: {
              modes: OPERATOR_CAP_MODES.map((m) => m.id),
              capabilities: kindRows("operator"),
            },
            agent: {
              modes: SPECIALIST_CAP_MODES.map((m) => m.id),
              capabilities: kindRows("agent"),
            },
          },
          alwaysHuman: [...ALWAYS_HUMAN_CAPABILITY_IDS],
        });
      }),
    ),
    "list_capabilities",
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
          { name: personName(args.name), email: args.email, role: args.role },
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
                name: args.name ? personName(args.name) : current.name,
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
      "List the org knowledge bases (grant key, name, folder, file count, refresh mode). Org admins only. `grantKey` is the store DIRECTORY — the only form save_global_agent's `kbs` accepts; `id` is for save_knowledge_base.",
      {},
      run(() => {
        requireOrgAdmin("read the org knowledge bases");
        return json(
          // F33-8: `grantKey` leads, because a grant is resolved at run time by
          // the store directory and the model reached for `id` — the first field
          // this list used to carry — and granted a dud on every template.
          listKnowledgeBases(db, { dataRoot }).map((kb) => ({
            grantKey: kb.dir,
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
        // The shared constant, not a hand-copied list: "nightly" was retired
        // when it turned out nothing ever scheduled it (see KB_REFRESH_MODES),
        // but this tool kept advertising it, so the controller could pick a
        // mode that was silently coerced to "on change" behind its back.
        refresh: z.enum(KB_REFRESH_MODES).optional(),
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
          refresh?: KbRefreshMode;
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
      "List the org skills (grant key, name, summary). Org admins only. `grantKey` is the skill FOLDER NAME — the only form save_global_agent's `skills` accepts; `id` is for save_skill.",
      {},
      run(() => {
        requireOrgAdmin("read the org skills");
        return json(
          // F33-8: a skill mounts by its folder name, so that is what a grant
          // must carry; `id` (a `disk:`/`sk_` handle) leading the row is what
          // the controller granted before, and it mounted nothing.
          listSkills(db, { dataRoot }).map((s) => ({
            grantKey: s.name,
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
      "List the org MCP connections (grant key, name, transport, target, health). Org admins only. Credentials are never shown. `grantKey` is the REGISTRY NAME — the only form save_global_agent's `mcps` accepts; `id` is for save_mcp_server and test_mcp_server.",
      {},
      run(() => {
        requireOrgAdmin("read the MCP connections");
        return json(
          // F33-8: a run resolves an MCP grant by registry name and drops an
          // unmatched one silently, so the name — not the `mcp_…` id this row
          // used to lead with — is what a grant must carry.
          listMcpServers(db).map((m) => ({
            grantKey: m.name,
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
      "List the org's global agent templates (specialists a project can deploy), each with the resource grants it holds, its default model and effort, and `copiesDiffering`: the projects whose deployed copy no longer carries the template's grants (ruling 156). Org admins only. Read this before save_global_agent so an edit is not blind.",
      {},
      run(() => {
        requireOrgAdmin("read the global agent templates");
        return json(
          // F33-7: the grants are HERE because `save_global_agent` rewrites
          // every field it is given and this was the only read of a template —
          // the model had no way to see what an edit was about to replace, and
          // the controller (rightly) refused to edit blind.
          listGlobalAgentProfiles(db, { dataRoot }).map((g) => ({
            id: g.id,
            name: g.name,
            backend: g.backend,
            model: g.model,
            effort: g.effort,
            summary: g.summary,
            stages: g.stages,
            skills: g.skills,
            mcps: g.mcps,
            kbs: g.kbs,
            usedByProjects: g.used,
            // Ruling 156: "is it granted on the project?" is answerable
            // without a run.
            copiesDiffering: listTemplateResourceDrift(db, g.id, { dataRoot }).map(
              (d) => d.projectSlug,
            ),
          })),
        );
      }),
    ),
    "list_global_agents",
  );

  add(
    tool(
      "save_global_agent",
      "Create or update a global agent template (name, backend, summary, persona, eligible stages, default model and effort, resource grants). Org admins only. The controller itself and the operator are system profiles this tool cannot touch. Grant merge semantics: an omitted skills/mcps/kbs list leaves the stored grants unchanged, and an empty list clears them — read list_global_agents first, and grant by grantKey, never by id. A project deployment keeps its own copy of the grants; the reply names every copy that now differs and how to update it.",
      {
        id: z.string().optional().describe("Existing template id to update; omit to create."),
        name: z.string(),
        backend: z.enum(["claude", "codex"]),
        summary: z.string().describe("One scannable paragraph the operator selects by."),
        persona: z.string().optional().describe("The long persona/system-prompt body."),
        stages: z.array(z.string()).min(1).describe("Eligible stage ids, e.g. ready, impl."),
        model: z
          .string()
          .optional()
          .describe(
            "Default model id for the template's backend, checked by name (ruling 139); deploy_agent uses it when no override is given. Omit to keep the stored default; \"\" clears it.",
          ),
        effort: z
          .string()
          .optional()
          .describe(
            "Default effort tier the backend offers: Claude low|medium|high|xhigh|max, Codex low|medium|high|xhigh. Omit to keep the stored tier; \"\" clears it.",
          ),
        propagate: z
          .boolean()
          .optional()
          .describe(
            "Also rewrite the grants of every project copy that no longer matches this template. Off by default: a project's copy is its own record.",
          ),
        skills: z
          .array(z.string())
          .optional()
          .describe(
            "Skill grants by grantKey — the skill FOLDER NAME from list_skills, never its id. Omit to keep the stored grants; [] clears them.",
          ),
        mcps: z
          .array(z.string())
          .optional()
          .describe(
            "MCP grants by grantKey — the REGISTRY NAME from list_mcp_servers, never its id. Omit to keep the stored grants; [] clears them.",
          ),
        kbs: z
          .array(z.string())
          .optional()
          .describe(
            "Knowledge-base grants by grantKey — the store DIRECTORY from list_knowledge_bases, never its id or display name. Omit to keep the stored grants; [] clears them.",
          ),
      },
      runWith(
        async (args: {
          id?: string;
          name: string;
          backend: "claude" | "codex";
          summary: string;
          persona?: string;
          stages: string[];
          model?: string;
          effort?: string;
          propagate?: boolean;
          skills?: string[];
          mcps?: string[];
          kbs?: string[];
        }) => {
          requireOrgAdmin("manage global agent templates");
          // F33-8: a grant is stored by store key, so a recognised id is
          // normalised here and an unknown key is refused by name — the model
          // used to hand back the ids `list_*` gave it and every grant landed
          // dangling. F33-7: only the lists it actually sent are passed on, so
          // an omitted one keeps what the template holds.
          const grants = resolveResourceGrants(
            db,
            { skills: args.skills, mcps: args.mcps, kbs: args.kbs },
            { dataRoot },
          );
          const input: SaveGagentInput = {
            id: args.id ?? null,
            name: args.name,
            backend: args.backend,
            summary: prose(args.summary),
            persona: prose(args.persona ?? ""),
            stages: args.stages,
          };
          if (grants.skills) input.skills = grants.skills;
          if (grants.mcps) input.mcps = grants.mcps;
          if (grants.kbs) input.kbs = grants.kbs;
          if (args.model !== undefined) input.model = args.model;
          if (args.effort !== undefined) input.effort = args.effort;
          if (args.propagate) input.propagate = true;
          const saved = await saveGlobalAgentProfile(db, input, auditActor, {
            dataRoot,
          });
          // Ruling 153: the reply states the defaults a deploy will take.
          const defaults =
            ` Template defaults: ${saved.profile.backend === "codex" ? "Codex" : "Claude"}, ` +
            `model ${saved.profile.model || defaultModelFor(saved.profile.backend)}, ` +
            `effort ${saved.profile.effort || defaultEffortFor(saved.profile.backend)}.`;
          // Ruling 156: the reply is built from the RESULT, not the toast. A
          // copy that differs is named with what it lacks and how to update
          // it; a propagation names what each copy gained.
          const verb = args.id ? "updated" : "created";
          const head = `[done] ${saved.profile.name} ${verb}.`;
          if (saved.propagated.length > 0) {
            const per = saved.propagated.map((p) => {
              const parts: string[] = [];
              if (p.added.length) parts.push(`added ${p.added.join(", ")}`);
              if (p.removed.length) parts.push(`dropped ${p.removed.join(", ")}`);
              return `${p.projectSlug}${parts.length ? ` (${parts.join("; ")})` : ""}`;
            });
            return `${head} Grants copied to ${saved.propagated.length} project${saved.propagated.length === 1 ? "" : "s"}: ${per.join("; ")}.${defaults}`;
          }
          if (saved.diverged.length > 0) {
            return `${head} ${divergedSentence(saved.diverged)} Call save_global_agent again with propagate: true to rewrite those copies, or an org admin takes the template's grants on that project's Agents page.${defaults}`;
          }
          if (args.id && saved.profile.used > 0) {
            return `${head} Every project copy carries the template's grants.${defaults}`;
          }
          return `${head}${defaults}`;
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
      "One project's live shape: stages with task counts, workflow boundaries, members with roles, deployed agents with their RESOLVED grants (every catalogued capability id at the mode the runtime applies, model, effort, and the operator's autonomy; ruling 139: read this before update_agent_deployment), goals summary. Membership gated.",
      { projectSlug: z.string().optional().describe("Defaults to this conversation's project.") },
      runWith((args: { projectSlug?: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project");
        const project = getProject(db, slug);
        const file = readProjectFile({ projectSlug: slug, dataRoot });
        if (!project || !file) throw new NotVisibleError(notVisible(slug));
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
          // Ruling 139: the deployments come from the Agents page's own roster
          // (the projection, which every agent writer reprojects before it
          // returns), so the controller reads exactly what the roster renders:
          // an absent `deliver-review-pr` at the project's delivery-gate mode,
          // the grant-required family at `off`, the model marks applied.
          agents: assembleAgentRoster(db, slug, { dataRoot }).map((row) => {
            const entry = {
              profileId: row.id,
              name: row.name,
              kind: row.kind,
              backends: row.backends,
              stages: row.stages,
              model: row.model,
              modelLabel: row.modelLabel,
              effort: row.effort,
              // Ruling 156: the grants a run on this project MOUNTS (the
              // deployment's own copy), and how that copy differs from the
              // template it came from (null when it does not).
              resources: row.resources,
              templateDrift: row.templateDrift,
              capabilities: row.capabilities.map((c) => ({
                capabilityId: c.capabilityId,
                mode: c.mode,
                // A retired id that is no longer in the catalogue keeps its
                // id as its label; nothing here assumes the lookup succeeds.
                label: capabilityById(c.capabilityId)?.label ?? c.capabilityId,
              })),
            };
            return row.kind === "operator"
              ? { ...entry, autonomy: row.autonomy ?? "supervised" }
              : entry;
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
      "A project's tasks: key, title, stage, readiness, waiting, owner, priority, goal-chain chip, and what each waits on (`waitsOn`, ruling 131). Membership gated. Includes Done; archived only when asked.",
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
            // Ruling 131: what the task waits on, each entry with its live state.
            waitsOn: t.blockedBy.map((e) => `${e.label} (${e.state})`),
          })),
        );
      }),
    ),
    "list_tasks",
  );

  add(
    tool(
      "get_task",
      "One task's live state: stage, readiness, goal text, engaged agents, PR state, open packet, its pending schedules (`schedules`, ruling 153), plus the newest timeline events. Membership gated. Historical (Done, archived) tasks read the same way.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        events: z.number().int().min(1).max(50).optional().describe("Newest timeline events to include (default 12)."),
      },
      runWith((args: { projectSlug?: string; taskKey?: string; events?: number }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
        requireVisible(slug, "read this task");
        const summary = getTaskSummary(db, slug, key);
        if (!summary) throw AppError.notFound(`No task ${key} in ${slug}.`);
        const events = listTaskEvents(db, slug, key)
          .slice(0, args.events ?? 12)
          .map((e) => ({
            at: e.occurredAt,
            type: e.type,
            by: e.actor.kind === "human" ? e.actor.name : e.actor.kind === "system" ? e.actor.name : `${e.actor.name} (agent)`,
            title: e.title,
            text: e.text.length > 700 ? `${e.text.slice(0, 700)}…` : e.text,
          }));
        // Ruling 153: the pending schedules, read from the task file itself
        // (the summary mapping carries none), so the controller can name and
        // cancel what it or a person set up.
        const schedules = (
          readTaskFile({ projectSlug: slug, taskKey: key, dataRoot })?.parsed
            .frontmatter.schedules ?? []
        )
          .filter((s) => s.status === "pending")
          .map((s) => ({
            id: s.id,
            action: s.action,
            dueAt: s.dueAt,
            profileId: s.profileId,
            prompt: s.prompt,
            status: s.status,
          }));
        return json({ task: summary, schedules, newestEvents: events });
      }),
    ),
    "get_task",
  );

  add(
    tool(
      "create_task",
      "Create a task at the project's entry stage (every task passes the triage gate). Contributor or above. `priority: urgent` IS the urgent flag (urgent is derived from priority, never a second input). Ruling 140: `owner` seats a member as owner in the same write that creates the task, BEFORE the first operator run, so that run bills the named owner; omit it to seat yourself. Use set_task_owner afterwards to release a seat; `none` is refused here.",
      {
        projectSlug: z.string().optional(),
        title: z.string(),
        goal: z.string().optional().describe("The task text: deliverable plus the done signal."),
        priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("urgent IS the urgent flag."),
        labels: z.array(z.string()).optional(),
        owner: z
          .string()
          .optional()
          .describe('A member email, or "me" (the default). Seated before the first operator run; "none" is refused at creation.'),
        dueDate: z.string().optional().describe("YYYY-MM-DD, or empty for none."),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe("Ruling 131: what the new task waits on (task keys like JC-6, goal links like 'goal-1 link 3', in this project). The task is born held and released by Viberr when every entry is done."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          title: string;
          goal?: string;
          priority?: "low" | "normal" | "high" | "urgent";
          labels?: string[];
          owner?: string;
          dueDate?: string;
          blockedBy?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          // Visibility BEFORE the action gate. `createTask` refuses a
          // non-member by naming the project and the role they lack, which
          // reads differently from the refusal an invented slug gets — exactly
          // the existence oracle R15-4 closes, and the posture every read tool
          // here already holds.
          requireVisible(slug, "create tasks");
          const taskInput: CreateTaskInput = {
            projectSlug: slug,
            title: args.title,
          };
          if (args.goal) taskInput.goal = prose(args.goal);
          if (args.priority) taskInput.priority = args.priority;
          if (args.labels) taskInput.labels = args.labels;
          if (args.dueDate !== undefined) taskInput.dueDate = args.dueDate.trim() || null;
          if (args.blockedBy?.length) taskInput.blockedBy = args.blockedBy;
          // Ruling 140(a): the owner is resolved BEFORE the write and seated in
          // it, so the operator's `create` trigger already reads the right
          // principal. The release word the sibling `set_task_owner` accepts is
          // refused by name here rather than falling through to a misleading
          // "No Viberr user with the email none."
          const who = (args.owner ?? "me").trim().toLowerCase();
          if (who === "none") {
            throw AppError.validation(
              "A new task is created with an owner; use `set_task_owner` to release the seat afterwards.",
            );
          }
          if (who !== "me") {
            const target = listUsers(db).find((u) => u.email.toLowerCase() === who)?.id;
            if (!target) throw AppError.notFound(`No Viberr user with the email ${args.owner}.`);
            taskInput.ownerUserId = target;
          }
          const created = await createTask(db, taskInput, actor, { dataRoot });
          const wait = created.task.blockedBy.length
            ? ` Waits on ${created.task.blockedBy.map((e) => e.label).join(", ")}; held until every entry is done.`
            : "";
          const seated =
            who !== "me" ? ` Owner: ${args.owner}, seated before the first operator run.` : "";
          return `[done] ${created.key} created in ${created.stageName}: ${created.task.title}.${seated}${wait}`;
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
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        toStageId: z.string().describe("Target stage id (from get_project)."),
      },
      runWith(async (args: { projectSlug?: string; taskKey?: string; toStageId: string }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
        requireVisible(slug, "move tasks");
        const project = getProject(db, slug);
        if (!project) throw new NotVisibleError(notVisible(slug));
        const terminal = project.stages[project.stages.length - 1];
        if (terminal && args.toStageId === terminal.id) {
          return (
            `[denied] Moving ${key} into ${terminal.name} means accepting its completion, ` +
            `which carries its own confirmation and merge consequences. Decide it on the task page: ` +
            `projects/${slug}/tasks/${key}.`
          );
        }
        const summary = getTaskSummary(db, slug, key);
        if (!summary) throw AppError.notFound(`No task ${key} in ${slug}.`);
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
          taskKey: key,
          toStageId: args.toStageId,
          manual: true,
        };
        const moved = await transitionStage(db, move, actor, { dataRoot });
        return `[done] ${key} is now in stage ${moved.stage}.`;
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
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        text: z.string(),
      },
      runWith(async (args: { projectSlug?: string; taskKey?: string; text: string }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
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
        const summary = getTaskSummary(db, slug, key);
        if (!summary) throw AppError.notFound(`No task ${key} in ${slug}.`);
        const text = `${prose(args.text).trim()}\n\n_Posted by the controller for ${userName(db, user.id)}._`;
        await postAgentComment(db, { dataRoot }, {
          projectSlug: slug,
          taskKey: key,
          actorRef: { kind: "controller" },
          text,
          // C03-OC1: the audit row names the asker, like every other tool.
          auditActor: actor,
        });
        return `[done] Comment posted on ${key}.`;
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
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        owner: z
          .string()
          .describe('A member email, "me" for the asking person, or "none" to release.'),
      },
      runWith(async (args: { projectSlug?: string; taskKey?: string; owner: string }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
        requireVisible(slug, "change task ownership");
        const who = args.owner.trim().toLowerCase();
        if (who === "none") {
          await releaseOwner(
            db,
            { projectSlug: slug, taskKey: key },
            actor,
            { dataRoot },
          );
          return `[done] ${key} is now unowned.`;
        }
        const target =
          who === "me"
            ? user.id
            : listUsers(db).find((u) => u.email.toLowerCase() === who)?.id;
        if (!target) throw AppError.notFound(`No Viberr user with the email ${args.owner}.`);
        const updated = await setOwner(
          db,
          { projectSlug: slug, taskKey: key, targetUserId: target },
          actor,
          { dataRoot },
        );
        return `[done] ${key} is owned by ${updated.owner?.name ?? target}.`;
      }),
    ),
    "set_task_owner",
  );

  add(
    tool(
      "update_task",
      "Edit a task's goal text, its metadata (priority, labels, due date) and/or what it waits on (blockedBy, ruling 131: the full list; [] clears it and RELEASES the task) — the same two writers the task page uses, behind the same gates: the goal needs maintainer or above, metadata needs the project's edit-task-meta grant. Metadata fields you pass are a full replace (an empty labels list clears them; dueDate \"\" clears the date). Never edits the title, stage, owner or engaged agents.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        goal: z.string().optional().describe("The new goal text (deliverable plus the done signal)."),
        priority: z.enum(PRIORITY_VALUES).optional(),
        labels: z.array(z.string()).optional().describe("The full label set; [] clears it."),
        dueDate: z.string().optional().describe("ISO date (YYYY-MM-DD), or \"\" to clear."),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe("The FULL list of what the task waits on (task keys like JC-6, goal links like 'goal-1 link 3'); [] clears it and releases the task."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          taskKey?: string;
          goal?: string;
          priority?: (typeof PRIORITY_VALUES)[number];
          labels?: string[];
          dueDate?: string;
          blockedBy?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          const key = keyOf(args.taskKey, slug);
          requireVisible(slug, "edit this task");
          const hasMeta =
            args.priority !== undefined || args.labels !== undefined || args.dueDate !== undefined;
          const hasWait = args.blockedBy !== undefined;
          if (args.goal === undefined && !hasMeta && !hasWait) {
            throw AppError.validation(
              "Pass a goal and/or at least one metadata field (priority, labels, dueDate, blockedBy).",
            );
          }
          // Two writers, two gates. Each part reports on its own so a goal that
          // wrote is never hidden behind a metadata refusal (or the reverse);
          // when nothing was applied the first refusal is the answer.
          //
          // Both writers short-circuit when the value is already what was
          // asked for: no file write, no timeline note, no audit row. Reporting
          // that as "[done] updated" told the person something happened when
          // nothing did (review finding 14), so the before/after comparison
          // below decides which axes really changed.
          const before = getTaskSummary(db, slug, key);
          const applied: string[] = [];
          const unchanged: string[] = [];
          const refused: string[] = [];
          let firstError: AppError | null = null;
          if (args.goal !== undefined) {
            try {
              await updateTaskGoal(
                db,
                { projectSlug: slug, taskKey: key, goal: prose(args.goal) },
                actor,
                { dataRoot },
              );
              if (before && before.goal === prose(args.goal).trim()) unchanged.push("goal");
              else applied.push("goal");
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              firstError ??= error;
              refused.push(`goal: ${error.userMessage}`);
            }
          }
          if (hasMeta) {
            const meta: Parameters<typeof setTaskMetadata>[1] = {
              projectSlug: slug,
              taskKey: key,
            };
            if (args.priority !== undefined) meta.priority = args.priority;
            if (args.labels !== undefined) meta.labels = args.labels;
            if (args.dueDate !== undefined) meta.dueDate = args.dueDate;
            const fields = [
              args.priority !== undefined ? "priority" : null,
              args.labels !== undefined ? "labels" : null,
              args.dueDate !== undefined ? "due date" : null,
            ].filter((f): f is string => f !== null);
            try {
              await setTaskMetadata(db, meta, actor, { dataRoot });
              const after = getTaskSummary(db, slug, key);
              for (const field of fields) {
                const same =
                  before !== null &&
                  after !== null &&
                  (field === "priority"
                    ? before.priority === after.priority
                    : field === "labels"
                      ? before.labels.join("\u0000") === after.labels.join("\u0000")
                      : before.dueDate === after.dueDate);
                if (same) unchanged.push(field);
                else applied.push(field);
              }
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              firstError ??= error;
              refused.push(`${fields.join(", ")}: ${error.userMessage}`);
            }
          }
          // Ruling 131: the wait has its own writer and its own report line; a
          // refusal names the reference and the reason in the validator's words.
          if (hasWait) {
            try {
              const wait = await setTaskDependencies(
                db,
                { projectSlug: slug, taskKey: key, blockedBy: args.blockedBy ?? [] },
                actor,
                { dataRoot },
              );
              if (!wait.changed) unchanged.push("blocked by");
              else if (wait.blockedBy.length === 0) applied.push("blocked by (cleared: the task is released)");
              else applied.push(`blocked by (${wait.blockedBy.join(", ")})`);
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              firstError ??= error;
              refused.push(`blocked by: ${error.userMessage}`);
            }
          }
          if (applied.length === 0 && firstError) throw firstError;
          const noted = refused.length ? ` Not applied: ${refused.join("; ")}` : "";
          if (applied.length === 0 && unchanged.length > 0) {
            return `[noop] ${key}: ${unchanged.join(", ")} already had that value; nothing was written.${noted}`;
          }
          return (
            `[done] ${key} updated: ${applied.join(", ")}.` +
            (unchanged.length
              ? ` Already set, nothing written: ${unchanged.join(", ")}.`
              : "") +
            noted
          );
        },
      ),
    ),
    "update_task",
  );

  add(
    tool(
      "run_agent_on_task",
      "Put an agent to work on a task with a directive: the operator (coordination) or a deployed agent profile (stage work). Maintainer or above. The result reports honestly whether a run started.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        agent: z
          .string()
          .describe('"operator", or a deployed profile id from get_project.'),
        prompt: z.string().optional().describe("The directive: what to do for this task."),
      },
      runWith(
        async (args: { projectSlug?: string; taskKey?: string; agent: string; prompt?: string }) => {
          const slug = slugOf(args.projectSlug);
          const key = keyOf(args.taskKey, slug);
          requireVisible(slug, "run agents");
          const file = readProjectFile({ projectSlug: slug, dataRoot });
          if (!file) throw new NotVisibleError(notVisible(slug));
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
              taskKey: key,
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
              return `[denied] ${key} is already Done; there is nothing for the operator to coordinate.`;
            }
            if (result.queued) {
              return `[done] The operator is already working ${key}; your directive was queued for it.`;
            }
            return `[done] Operator run started on ${key}.`;
          }
          const { startAgentRun } = await import(
            "~/server/tasks/specialist-run.server"
          );
          const runInput: StartAgentRunInput = {
            projectSlug: slug,
            taskKey: key,
            profileId: args.agent.trim(),
            triggeredByName: display,
            triggeredByUserId: user.id,
          };
          if (args.prompt) {
            runInput.directive = prose(args.prompt);
            runInput.directiveFrom = display;
          }
          const started = await startAgentRun(db, runInput, actor, { dataRoot });
          return `[done] ${started.name} run started on ${key} (${started.backend}).`;
        },
      ),
    ),
    "run_agent_on_task",
  );

  /** Ruling 153: the `run-agents` tier the task page's schedule form needs. */
  function requireScheduleTier(slug: string, what: string): string | null {
    const file = readProjectFile({ projectSlug: slug, dataRoot });
    if (!file) throw new NotVisibleError(notVisible(slug));
    const authority = {
      slug,
      memberRoles: new Map(
        file.parsed.frontmatter.members.map((m) => [m.userId, m.role] as const),
      ),
      archived: file.parsed.frontmatter.archived === true,
    };
    return canRunAgents(db, authority, actor, what)
      ? null
      : "[denied] Scheduling a run needs the maintainer role (or project admin) in this project.";
  }

  add(
    tool(
      "schedule_task_action",
      "Schedule a future run on a task (ruling 153): an operator re-run, or a deployed agent profile's run with a directive, between 1 minute and 28 days out. Maintainer or above. The entry lands on the task file and fires on the profile deployed when it fires; get_task lists the pending entries and cancel_task_schedule cancels one.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        agent: z
          .string()
          .describe('"operator", or a deployed profile id from get_project.'),
        delayMinutes: z
          .number()
          .optional()
          .describe("Minutes from now (1 to 40320). Give this or dueAt."),
        dueAt: z
          .string()
          .optional()
          .describe("An ISO instant (between 1 minute and 28 days out). Give this or delayMinutes."),
        prompt: z
          .string()
          .optional()
          .describe("The steer for the operator, or the agent's directive (under 4000 characters)."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          taskKey?: string;
          agent: string;
          delayMinutes?: number;
          dueAt?: string;
          prompt?: string;
        }) => {
          const slug = slugOf(args.projectSlug);
          const key = keyOf(args.taskKey, slug);
          requireVisible(slug, "schedule a run");
          const denied = requireScheduleTier(slug, "schedule a run through the controller");
          if (denied) return denied;
          // The task page's bounds and sentences (project.task.tsx
          // `schedule-action`): a crafted delay overflowed Date once, and a
          // schedule further out than the retention story is a note, not a plan.
          const now = Date.now();
          let dueMs: number;
          if (args.delayMinutes !== undefined) {
            const minutes = args.delayMinutes;
            if (!Number.isFinite(minutes) || minutes < 1 || minutes > SCHEDULE_MAX_MINUTES) {
              throw AppError.validation("Schedule between 1 minute and 28 days out.");
            }
            dueMs = now + Math.round(minutes) * 60_000;
          } else if (args.dueAt !== undefined) {
            dueMs = Date.parse(args.dueAt);
            if (!Number.isFinite(dueMs)) throw AppError.validation("Invalid schedule time.");
            const minutes = (dueMs - now) / 60_000;
            if (minutes < 1 || minutes > SCHEDULE_MAX_MINUTES) {
              throw AppError.validation("Schedule between 1 minute and 28 days out.");
            }
          } else {
            throw AppError.validation("Schedule between 1 minute and 28 days out.");
          }
          const steer = args.prompt ? prose(args.prompt) : "";
          if (steer.length > 4000) {
            throw AppError.validation("Keep the run prompt under 4000 characters.");
          }
          const dueAt = new Date(dueMs).toISOString();
          const operator = args.agent.trim().toLowerCase() === "operator";
          const profileId = args.agent.trim();
          const schedInput: Parameters<typeof scheduleTaskAction>[1] = {
            projectSlug: slug,
            taskKey: key,
            dueAt,
            prompt: steer,
          };
          if (!operator) {
            schedInput.action = "run-agent";
            schedInput.profileId = profileId;
          }
          // The actor is the audit actor (`<email> · via controller`): the
          // entry's `createdByLabel` discloses the instrument, as every other
          // controller write does.
          const sched = await scheduleTaskAction(db, schedInput, auditActor, {
            dataRoot,
          });
          let what = "an operator re-run";
          if (!operator) {
            const { listDeployedSpecialists } = await import(
              "~/server/tasks/specialist-run.server"
            );
            const name =
              listDeployedSpecialists(slug, { dataRoot }).find((s) => s.id === profileId)
                ?.name ?? profileId;
            what = `a ${name} run`;
          }
          return `[done] Scheduled: ${what} on ${key} at ${sched.dueAt} (${sched.id}). It runs on the profile deployed when it fires.`;
        },
      ),
    ),
    "schedule_task_action",
  );

  add(
    tool(
      "cancel_task_schedule",
      "Cancel one pending scheduled run on a task (ruling 153). Maintainer or above. The schedule id comes from get_task or from schedule_task_action's reply.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        scheduleId: z.string().describe("The pending entry's id (sch_...)."),
      },
      runWith(
        async (args: { projectSlug?: string; taskKey?: string; scheduleId: string }) => {
          const slug = slugOf(args.projectSlug);
          const key = keyOf(args.taskKey, slug);
          requireVisible(slug, "cancel a scheduled run");
          const denied = requireScheduleTier(slug, "cancel a scheduled run through the controller");
          if (denied) return denied;
          const scheduleId = args.scheduleId.trim();
          const result = await cancelScheduledAction(
            db,
            { projectSlug: slug, taskKey: key, scheduleId },
            auditActor,
            { dataRoot },
          );
          return result.cancelled
            ? `[done] Schedule ${scheduleId} on ${key} cancelled.`
            : `[noop] ${scheduleId} is not pending on ${key}.`;
        },
      ),
    ),
    "cancel_task_schedule",
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
        if (!data) throw new NotVisibleError(notVisible(slug));
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
          if (!project) throw new NotVisibleError(notVisible(slug));
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
      "Add a member to the project by email (an unknown email gets a new account with a one-time temporary password you must relay). Project admin. C4: `role` seats them in ONE write — members join as viewer unless you give one, and an unknown role is refused by name with nothing written.",
      {
        projectSlug: z.string().optional(),
        name: z.string(),
        email: z.string(),
        role: z
          .enum(PROJECT_ROLES)
          .optional()
          .describe("The seat they join in. Omitted: viewer, the narrowest."),
      },
      runWith(async (args: { projectSlug?: string; name: string; email: string; role?: (typeof PROJECT_ROLES)[number] }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "manage this project's members");
        const inviteInput: Parameters<typeof inviteMember>[1] = {
          projectSlug: slug,
          name: args.name,
          email: args.email,
        };
        if (args.role) inviteInput.role = args.role;
        const result = await inviteMember(
          db,
          inviteInput,
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
      "Deploy a global agent template into the project (from list_global_agents; delivery starts withheld until an admin opens it up). Project admin. No removal exists here. Ruling 139: `model` and `effort` override the template's defaults and are checked by name against the template's primary backend before the write (an unknown tier is refused, never clamped); omit them to keep the template's model and the backend's default effort. The reply states what was stored.",
      {
        projectSlug: z.string().optional(),
        profileId: z.string(),
        model: z.string().optional().describe("Model id for the template's backend (see the profile's backend in list_global_agents)."),
        effort: z.string().optional().describe("Effort tier the backend offers: Claude low|medium|high|xhigh|max, Codex low|medium|high|xhigh."),
      },
      runWith(async (args: { projectSlug?: string; profileId: string; model?: string; effort?: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "manage this project's agents");
        const deployInput: Parameters<typeof deployAgentProfileFromLibrary>[1] = {
          projectSlug: slug,
          profileId: args.profileId,
        };
        if (args.model) deployInput.model = args.model;
        if (args.effort) deployInput.effort = args.effort;
        const result = await deployAgentProfileFromLibrary(db, deployInput, actor, { dataRoot });
        const stored = result.applied
          ? ` Runs on ${result.applied.backend === "codex" ? "Codex" : "Claude"} with model ${result.applied.model} at effort ${result.applied.effort}.`
          : "";
        return `[done] ${result.name} deployed on ${slug}.${stored} Delivery starts withheld; open it up with update_agent_deployment when the profile should write the repo.`;
      }),
    ),
    "deploy_agent",
  );

  add(
    tool(
      "update_agent_deployment",
      "Update one deployed agent's project configuration: capability modes (direct, recommend for the operator, human, off), backend, model, eligible stages, or operator autonomy. Project admin. Merge semantics: only the fields you pass change. Ruling 139: every catalogued value is checked BEFORE anything is written and an unknown or impossible one is refused by name with nothing written: a capability id must be one the deployment's KIND takes (read list_capabilities first; get_project shows the deployment's resolved grants), a specialist takes no recommend, an always-human id takes only human, report-validation-verdict takes only direct or off, matrix-only advisory ids have no toggle, and every stage id must be one of the project's stages.",
      {
        projectSlug: z.string().optional(),
        profileId: z.string(),
        capabilities: z
          .array(z.object({ capabilityId: z.string(), mode: z.enum(["direct", "recommend", "human", "off"]) }))
          .optional(),
        backend: z.enum(["claude", "codex"]).optional(),
        model: z.string().optional(),
        effort: z
          .string()
          .optional()
          .describe(
            "Effort tier the deployment's backend offers (Claude low|medium|high|xhigh|max, Codex low|medium|high|xhigh); refused by name otherwise. A backend switch with no effort resets to that backend's default.",
          ),
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
          effort?: string;
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
          // Ruling 139 (pass 34, F34-2): read first, refuse by name, write
          // nothing. The capability check is KIND-aware (the operator and a
          // specialist take different ids and modes), which is why it lives
          // here and not in the kind-blind form parser.
          const refusal = capabilityPatchRefusal(
            view.kind === "operator" ? "operator" : "agent",
            args.capabilities ?? [],
          );
          if (refusal) throw AppError.validation(refusal);
          // Pass 34 review: `autonomy` is written only for an operator
          // (`updateAgentProfile` stores it under `if (isOperator)`), so a
          // specialist call used to answer [done] for a setting nothing kept.
          if (args.autonomy !== undefined && view.kind !== "operator") {
            throw AppError.validation(
              `autonomy is an operator setting; ${view.name} is a specialist. Nothing was written.`,
            );
          }
          const stageIds = file.parsed.frontmatter.stages.map((s) => s.id);
          const unknownStages = (args.stages ?? []).filter((id) => !stageIds.includes(id));
          if (unknownStages.length > 0) {
            throw AppError.validation(
              `${unknownStages.map((id) => `"${id}"`).join(", ")} ${unknownStages.length === 1 ? "is not a stage" : "are not stages"} of ${slug}. Nothing was written. The project's stage ids are: ${stageIds.join(", ")}.`,
            );
          }
          // Seed from the RESOLVED grants — the same view `get_project`
          // reports and the same one the agents-page modal seeds from
          // (`seedCaps`). Seeding from the RAW stored record instead let
          // `grantsFor` materialise every ABSENT id at its CATALOG default, so
          // an unrelated patch armed capabilities the deployment had withheld:
          // live in this pass's review, `comment-on-task: off` on the seeded
          // Reviewer stored `execute-code-or-write-repo`, `create-task-branch`
          // and `open-review-pr` as `direct`. Ruling 139 pairs the read with
          // the write; the write must not contradict the read.
          const resolved =
            assembleAgentRoster(db, slug, { dataRoot }).find((r) => r.id === args.profileId) ?? null;
          const caps: Record<string, string> = {};
          for (const grant of resolved?.capabilities ?? deployment.capabilities) {
            caps[grant.capabilityId] = grant.mode;
          }
          for (const patch of args.capabilities ?? []) caps[patch.capabilityId] = patch.mode;
          // Ruling 139: effort is settable wherever model is, judged by name
          // against the backend the deployment will run on, BEFORE the write.
          // A backend switch with no effort resets to that backend's default
          // and the reply says so; an unchanged backend keeps the stored tier.
          const currentBackend = view.backends[0] === "codex" ? "codex" : "claude";
          const backend = args.backend ?? currentBackend;
          const switched = backend !== currentBackend;
          if (args.effort !== undefined) assertEffortForBackend(backend, args.effort);
          if (args.model !== undefined) assertModelForBackend(backend, args.model);
          const effort = args.effort ?? (switched ? defaultEffortFor(backend) : view.effort);
          const baseForm = {
            name: view.name,
            role: view.role,
            // B5 (pass 34, U34-3): the record THIS tool just read. Its own
            // read-modify-write inside one turn is never refused by itself; a
            // hand-save landing between the read and the write is.
            fingerprint: deploymentFingerprint(deployment),
            backend,
            stages: args.stages ?? view.stages,
            definition: "",
            persona: "",
            model: args.model ?? (switched ? defaultModelFor(backend) : view.model),
            effort,
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
          const reset =
            switched && args.effort === undefined && result.applied
              ? ` Backend switched to ${backend === "codex" ? "Codex" : "Claude"}: effort reset to its default (${result.applied.effort})${args.model === undefined ? ` and model to ${result.applied.model}` : ""}.`
              : "";
          const stored =
            args.effort !== undefined && result.applied ? ` Effort is now ${result.applied.effort}.` : "";
          return `[done] ${result.name} updated on ${slug}.${reset}${stored}${governance}${notices}`;
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
              blockedBy: z
                .array(z.string())
                .optional()
                .describe("Ruling 131(c): what this link's task waits on (task keys, or other goals' links like 'goal-1 link 3'); the task is born held when the chain creates it."),
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
          links: { title: string; goal: string; blockedBy?: string[] }[];
        }) => {
          const slug = slugOf(args.projectSlug);
          // Same reason as `create_task`: the action gate below would refuse a
          // non-member in words that confirm the project exists.
          requireVisible(slug, "define goals");
          const goalInput: CreateGoalInput = {
            projectSlug: slug,
            title: args.title,
            links: args.links.map((l) => {
              const link: CreateGoalInput["links"][number] = { title: l.title, goal: prose(l.goal) };
              if (l.blockedBy?.length) link.blockedBy = l.blockedBy;
              return link;
            }),
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
              blockedBy: l.blockedBy,
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
        blockedBy: z
          .array(z.string())
          .optional()
          .describe("edit_link / add_link: what the link's task waits on (the full list; [] clears; omit on edit_link to leave it)."),
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
          blockedBy?: string[];
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
              // Ruling 131(c): absent leaves the link's wait; [] clears it.
              if (args.blockedBy !== undefined) edit.blockedBy = args.blockedBy;
              action = edit;
              break;
            }
            case "add_link": {
              if (!args.title) throw AppError.validation("add_link needs a title.");
              const added: Extract<UpdateGoalOp, { op: "add_link" }> = {
                op: "add_link",
                title: args.title,
                goal: prose(args.goal ?? ""),
              };
              if (args.blockedBy !== undefined) added.blockedBy = args.blockedBy;
              action = added;
              break;
            }
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
