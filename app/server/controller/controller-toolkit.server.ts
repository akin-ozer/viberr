import path from "node:path";
import {
  STAGE_COLORS,
  STAGE_COLOR_LIST,
  type StageColor,
} from "~/shared/workflow/stage-colors";
import type { DatabaseSync } from "node:sqlite";
import { KB_DOC_OFFSET_DESCRIPTION, readKbDocForRun } from "~/server/files/kb-injection.server";
import { pageEnd } from "~/server/runtimes/read-page-budget.server";
import { readTimelineEntry } from "~/server/tasks/board-read.server";
import {
  attachmentImageHeader,
  listTaskAttachments,
  readAttachmentContent,
  readTaskAttachment,
} from "~/server/files/task-attachments.server";
import { keptDeliveryMiss, listKeptDeliveries } from "~/server/files/kept-deliveries.server";
import { READ_TASK_ATTACHMENT_FIELDS } from "~/server/mcp-proxy/board-tool.server";
import { findMessageFile, listConversationFileNames } from "./controller-conversations.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { countLabel } from "~/shared/text/plural";
import {
  assertEffortForBackend,
  assertModelForBackend,
  defaultEffortFor,
  defaultModelFor,
  effortsFor,
} from "~/server/runtimes/model-catalog.server";
import {
  ADVISORY_CAPABILITY_NOTE,
  ALWAYS_HUMAN_CAPABILITY_IDS,
  UNIFIED_CAP_CATALOG,
  capabilityById,
  capabilityIsAdvisory,
  type CapabilityKind,
} from "~/shared/capabilities";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import { resolveDeclaredStages } from "~/shared/workflow/stage-eligibility";

/**
 * One capability row as `get_project` answers it (F39-4). `advisory` is present
 * only on a `group: null` catalogue row: persona guidance nothing enforces and
 * `update_agent_deployment` refuses. Its ABSENCE is the signal that a grant is
 * real, so this shape is a contract, not a convenience.
 */
interface DeployedGrantView {
  capabilityId: string;
  mode: CapabilityMode;
  label: string;
  advisory?: string;
}
import { capabilityPatchRefusal,
  OPERATOR_CAP_MODES,
  SPECIALIST_CAP_MODES,
} from "~/features/agents/capability-catalog";
import { z } from "zod";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
// Ruling 296: every tool on this server refuses arguments it does not
// declare, instead of silently dropping them and answering anyway.
import { imageResult, strictTool as tool } from "~/server/runtimes/strict-tool.server";
import { tasksReleasedBy } from "~/server/projections/dependencies.server";
import {
  defaultBranchPageNote,
  readProjectDefaultBranchFile,
} from "~/server/tasks/operator-repo-read.server";
import { EPIC_COLORS, EPIC_STATUS_VALUES, type EpicStatus } from "~/schemas/epic-file.schema";
import { PROJECT_ROLES } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
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
  publishResourceRequestChanged,
  raiseResourceRequest,
  REQUESTABLE_KINDS,
  resourceRequestRemedy,
  type RequestableKind,
} from "./controller-requests.server";
import { CONTROLLER_SECTION_LABEL } from "~/shared/controller-locks";
import { mcpGrantPhrase, mcpSignInNote, summarizeMcpGrant } from "~/shared/mcp-oauth";
import {
  listKnowledgeBases,
  listMcpServers,
  mcpStoreAccessNote,
  listSkills,
  resolveStoreTarget,
  KB_REFRESH_MODES,
  type KbRefreshMode,
  saveKnowledgeBase,
  setKnowledgeBasePrivacy,
  saveMcpServer,
  saveSkill,
  resolveMcpServerId,
  testMcpServer,
} from "~/server/org/resources.server";
import {
  listGlobalAgentProfiles,
  resolveResourceGrants,
  saveGlobalAgentProfile,
  type SaveGagentInput,
} from "~/server/org/gagents.server";
import {
  readStoreDoc,
  scanStoreTree,
  storeDocVersion,
  utf8Bytes,
  writeStoreDoc,
} from "~/server/org/store-files.server";
import {
  backendRuns,
  oversightSummary,
  runAnalytics,
} from "~/server/insights/insights-query.server";
import { describePersonaChange } from "~/server/agents/persona-change.server";
import { AppError } from "~/server/errors/app-error.server";
import { getGithubViewData } from "~/features/github/github-query.server";
import { listConnections } from "~/server/org/connections.server";
import { reachSummary } from "~/shared/connection-reach";
import {
  createProject,
  type CreateProjectInput,
  type CreateRepositoryRequest,
  type CustomProjectBlueprint,
  type OperatorOverrides,
  type RosterEntry,
} from "~/features/home/project-create.server";
import { listHomeProjectsForUser } from "~/features/home/home-query.server";
import {
  deleteAgentProfile,
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
  recolorStage,
  inviteMember,
  removeStage,
  renameStage,
  reorderStages,
  setProjectFileLeases,
  setProjectGates,
  setProjectRulingsKb,
  setRequiredReviewers,
  updateProjectIdentity,
} from "~/features/project-settings/settings-actions.server";
import { projectGatesView } from "~/shared/project-gates";
import { resolveRequiredReviewers } from "~/server/tasks/required-reviewers.server";
import {
  setMemberRole,
  setTransitionBoundary,
} from "~/features/policy/policy-actions.server";
import { getProject, listProjectTasks } from "~/server/projections/board-query.server";
import {
  decisionsRequiring,
  type DecisionRef,
} from "~/server/projections/decisions.server";
import {
  activeFileLeases,
  staleFileLeases,
} from "~/server/tasks/file-leases.server";
import {
  getTaskSummary,
  listTaskEvents,
} from "~/server/projections/task-query.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { postAgentComment } from "~/server/tasks/agent-toolkit.server";
import {
  createEpic,
  planTasksEpic,
  setTasksEpic,
  updateEpic,
  type CreateEpicInput,
  type UpdateEpicInput,
} from "~/server/tasks/epic-actions.server";
import {
  epicTaskKeys,
  getEpic,
  getEpicDetail,
  listEpics,
  type EpicSummary,
} from "~/server/projections/epic-query.server";
import {
  acceptanceRefusalFor,
  appendComment,
  createTask,
  loadProjectContext,
  releaseOwner,
  requireProjectMutable,
  setOwner,
  setTaskMetadata,
  transitionStage,
  updateTaskGoal,
  updateTaskTitle,
  userName,
  type CreateTaskInput,
} from "~/server/tasks/task-actions.server";
import { setTaskDependencies } from "~/server/tasks/dependencies.server";
import { DONE_SIGNAL_RULE } from "~/server/tasks/done-signal.server";
import {
  PRIORITY_VALUES,
  revisionLeftWorkspace,
} from "~/schemas/task-file.schema";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import type { StartAgentRunInput } from "~/server/tasks/specialist-run.server";
import { canRunAgents } from "~/server/auth/project-authority.server";
import { listUsers } from "~/server/auth/user-store.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import {
  cancelScheduledAction,
  scheduleDueMs,
  scheduleTaskAction,
  SCHEDULE_MAX_MINUTES,
} from "~/server/tasks/schedule.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  listProjectKbProposals,
  resolveKbProposal,
} from "~/server/org/kb-proposals.server";
import { editKbPassage, listKbCorrections } from "~/server/org/kb-corrections.server";
import { undoKbCorrectionOnTask } from "~/server/tasks/kb-correction-actions.server";
import {
  describeDriftLists,
  listTemplateResourceDrift,
  listTemplateTextDrift,
  type TemplateCopyDrift,
} from "~/server/org/template-propagation.server";
import { displayNameRefusal, normalizeDisplayName } from "~/shared/names";
import {
  controllerToolGuards,
  NotVisibleError,
  notVisible,
} from "./controller-tool-guards.server";
import { errorMessage } from "~/shared/errors";

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
 * NO DELETES: no tool destroys a project, task, user, template or resource, in
 * either scope. Ruling 464 amends the older "nothing is deleted" wording by
 * one edit: `remove_agent_deployment` takes a specialist off a project's
 * roster, the way `update_stages op: remove` takes a stage off its board, and
 * the global template stays. The always-human
 * decisions (merge, acceptance, force-accept, packet resolution, a move into
 * the terminal stage) have no tool here at all — the move tool refuses a
 * terminal target and points at the task page's own ceremony (ruling 88).
 *
 * Ruling 251 (pass 37, F37-80) keeps that line and fixes what it cost. The
 * boundary was right and unnavigable: live, the controller answered a person
 * who had said "I want to lean on you rather than clicking through task pages
 * myself" with "Resolving it is yours on the task page — I have no tool for
 * packet resolution", and earlier "I tried to withdraw it; only you can close
 * it". Both true, neither actionable: there was no way to SEE what was waiting
 * without calling `get_task` on a task you already suspected. `list_decisions`
 * reads the whole inbox — packets with every option, pending recommendations,
 * completions ready to accept — and hands over the link. It decides nothing.
 */

export interface ControllerToolkitDeps {
  db: DatabaseSync;
  /** `fetchImpl` is a test seam for the GitHub calls `create_project` makes
   *  (ruling 462); production leaves it off and reaches the real `fetch`. */
  ctx: { dataRoot?: string; fetchImpl?: typeof fetch };
  /** The asking user — the only authority anything here runs under. */
  user: { id: string; email: string; name: string };
  /** The conversation's bound project, when it has one (tool default). */
  projectSlug?: string | null;
  /** Ruling 121: the conversation's anchored task, when it has one — every
   *  task tool's `taskKey` defaults to it. */
  taskKey?: string | null;
  /** Ruling 476(h): the conversation this turn answers in. `create_epic`
   *  records it on the epic (ruling 503), so the epic's page can link back to
   *  where it was planned. */
  conversationId?: string | null;
  /** Ruling 283: the knowledge bases this turn's prompt INDEXED. The pull tool
   *  is mounted over exactly these — `controllerKbNames` builds the list once
   *  so the prompt and the tool cannot name different sets. */
  kb?: readonly string[];
}

export interface ControllerToolkit {
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  allowedTools: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: SdkMcpToolDefinition<any>[];
}

const CONTROLLER_TOOLKIT_INSTRUCTIONS =
  "Viberr controller tools. Every action runs under the ASKING PERSON's own permissions, " +
  "checked by the server per call: instance tools follow their org role, board tools follow " +
  "their role in that project. A [denied] answer is final; relay it with its reason. Reads " +
  "are your ground truth; call them before asserting state. Nothing here deletes a project, " +
  "task, user, template or resource (taking a deployment off a project's roster edits the " +
  "roster, ruling 464), merges, " +
  "accepts completions, resolves decision packets, or moves a task into its final stage. " +
  "Ruling 251: those stay with the person, and `list_decisions` is how you put each one in " +
  "front of them, with its options and the link that opens it. " +
  "When the conversation is bound to a project, tools default to it; when it is anchored to a " +
  "task, the task tools default to that task as well.";

const prose = normalizeEscapedNewlines;

/**
 * U36-5 (pass 36): the tier lists the three effort descriptions carry come
 * from the catalog, so a tier the catalog gains (Codex `max`, CLI 0.153) is
 * offered here the day it lands instead of being typed by hand three times.
 * Live, the descriptions still said Codex stops at `xhigh`; the write
 * succeeded and the controller told the owner it could not confirm `max` is
 * real.
 */
const EFFORT_TIERS_SENTENCE = `Claude ${effortsFor("claude").join("|")}, Codex ${effortsFor("codex").join("|")}`;

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

/**
 * Ruling 486: an OAuth sign-in's grant as `list_mcp_servers` reports it —
 * counted, labelled and with its writes by name, never the whole list (a
 * Cloudflare read-only grant is 194 scopes). Null when the server did not
 * say what it granted.
 */
function grantOf(scope: string | null) {
  const grant = summarizeMcpGrant(scope);
  if (!grant) return null;
  return {
    scopes: grant.scopes.length,
    writes: grant.writes.length,
    readOnly: grant.writes.length === 0,
    summary: mcpGrantPhrase(scope),
    writeScopes: grant.writes,
  };
}

/**
 * Ruling 302: the controller's own timeline window, and the most it will widen
 * to. The operator's twins are OPERATOR_TIMELINE_DEFAULT / _MAX; this window
 * is larger because a controller reads across tasks rather than coordinating
 * one, and smaller than the whole history because it reads MANY tasks a turn.
 */
const CONTROLLER_EVENTS_DEFAULT = 12;
const CONTROLLER_EVENTS_MAX = 50;

/** Ruling 302: present on a `get_task` reply ONLY when entries were left out,
 *  naming the count and both ways to reach them. */
interface TimelineWindowNote {
  timelineOlder?: string;
}

/** Build the toolkit for one controller turn. */
export function buildControllerToolkit(deps: ControllerToolkitDeps): ControllerToolkit {
  const { db, ctx, user } = deps;
  const dataRoot = ctx.dataRoot;

  // The refusal voice, the live-authority gates and the audit actor are shared
  // with the controller's other in-process server (`viberr_ops`, ruling 107):
  // one definition, so a reworded refusal cannot drift between them.
  const { actor, orgAdmin, requireOrgAdmin, requireVisible, run, runWith, json } =
    controllerToolGuards(db, user, dataRoot);

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

  /** Ruling 257: the document names a KB folder holds, so a write can see a
   *  collision coming. Names only — content comes from
   *  `read_knowledge_base_doc`, which is org-admin gated like every other read
   *  here. Best effort: a folder that cannot be scanned lists nothing rather
   *  than failing the whole listing. */
  function kbDocumentNames(kbId: string): string[] {
    const target = resolveStoreTarget(db, "kb", kbId, { dataRoot });
    if (!target) return [];
    try {
      return scanStoreTree(target.rootAbs)
        .filter((n) => n.type === "file")
        .map((n) => n.name);
    } catch {
      return [];
    }
  }
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
          actor,
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
              actor,
            );
            done.push(`profile updated (${updated.email}, org ${updated.role})`);
          }
          if (args.access === "disable") {
            await disableUser(db, args.userId, actor);
            done.push("account disabled");
          } else if (args.access === "enable") {
            await enableUser(db, args.userId, actor);
            done.push("account enabled");
          }
          if (args.resetPassword) {
            const reset = await resetLocalPassword(db, args.userId, actor);
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
          actor,
        );
        return `[done] ${updated.email} is now an org ${updated.role}.`;
      }),
    ),
    "set_user_org_role",
  );

  // Ruling 283: the controller's own granted knowledge bases are indexed into
  // its prompt, not injected, so it pulls the documents it needs. This is NOT
  // `read_store_doc` (ruling 107), which reads ANY knowledge base or skill in
  // the store and is org-admin only: this one reads only what was granted to
  // this turn, and needs no admin, because the text it replaces needed none.
  if (deps.kb && deps.kb.length > 0) {
    const grantedKb = deps.kb;
    add(
      tool(
        "read_knowledge_doc",
        "Read ONE document out of a knowledge base attached to THIS conversation. Your prompt lists each one as an index (every document, its size and its sections), and the text itself is not there; this is how you get it. Pass the knowledge base's name exactly as the index heading gives it and the document's path exactly as the index lists it. Read a project's settled rules before you plan against them, rather than working from what a document's title suggests it says. This reads YOUR OWN grants and needs no admin; `read_knowledge_base_doc` and `read_store_doc` read any knowledge base in the store by id and are org-admin only.",
        {
          kb: z
            .string()
            .describe("The knowledge base's name, as its index heading gives it."),
          path: z
            .string()
            .describe("The document's path inside that knowledge base, e.g. 'conventions.md'."),
          offset: z.number().int().min(0).optional().describe(KB_DOC_OFFSET_DESCRIPTION),
        },
        runWith((args: { kb: string; path: string; offset?: number }) =>
          readKbDocForRun(grantedKb, args.kb, args.path, dataRoot, args.offset ?? 0),
        ),
      ),
      "read_knowledge_doc",
    );
  }

  /** Ruling 390: the grant keys that exist for one locked section — what a
   *  request may name, and what the refusal lists when it names nothing real.
   *  A KB is granted by its store DIRECTORY (F33-8), never by its id. */
  const knownResourceNames = (kind: RequestableKind): string[] =>
    kind === "kb"
      ? listKnowledgeBases(db, { dataRoot }).map((kb) => kb.dir)
      : kind === "skills"
        ? listSkills(db, { dataRoot }).map((sk) => sk.name)
        : listMcpServers(db).map((m) => m.name);

  add(
    tool(
      "request_resource_grant",
      "Ask for a skill, knowledge base or MCP server to be attached to YOUR OWN profile, when you have created or found one your next conversation needs. Org admins only. You cannot grant it yourself (ruling 108 makes controller grants a deployment decision, with no in-app override for anyone), and this is how the ask survives the conversation: it goes on the record, it appears on the Controller tab of Instance settings for whoever runs this deployment, and it comes back in your own turn context until it is answered. Idempotent per (kind, name) while open, so re-asking never stacks duplicates on a person. Naming a resource that does not exist is refused: create it first.",
      {
        kind: z
          .enum(REQUESTABLE_KINDS)
          .describe("Which of your locked sections the grant belongs to."),
        name: z
          .string()
          .describe(
            "The resource's grant key exactly as its list tool prints it (a KB's `grantKey`, a skill's name, an MCP's name).",
          ),
        reason: z
          .string()
          .describe(
            "Why your next conversation needs it, in one or two sentences. An admin reads this and nothing else about the ask.",
          ),
      },
      runWith((args: { kind: RequestableKind; name: string; reason: string }) => {
        requireOrgAdmin("ask for a resource grant");
        const name = args.name.trim();
        if (!name) throw AppError.validation("Which resource?");
        // Ruling 390: refuse an ask nobody can answer. A request naming a
        // resource the store does not have would sit on an admin's screen
        // forever, and the remedy it prints would not work.
        const known = knownResourceNames(args.kind);
        if (!known.includes(name)) {
          return (
            `[denied] No ${CONTROLLER_SECTION_LABEL[args.kind].replace(" grants", "")} named "${name}" exists on this instance. ` +
            (known.length > 0
              ? `Create it first. Present: ${known.join(", ")}.`
              : "Create it first.")
          );
        }
        const { request, created } = raiseResourceRequest(
          {
            kind: args.kind,
            name,
            reason: args.reason,
            askedByUserId: actor.userId,
            askedByLabel: actor.label,
          },
          dataRoot,
        );
        if (created) {
          recordAudit(db, {
            action: "controller.resource_grant.requested",
            actor,
            subjectKind: "agent_profile",
            subjectId: "controller",
            details: { kind: request.kind, name: request.name },
          });
          // An open Instance settings tab lists open requests; without this
          // a new one appeared there only after a manual reload.
          publishResourceRequestChanged(request);
        }
        return (
          `[done] ${created ? "Recorded" : "Already open"}: a grant request for the ${CONTROLLER_SECTION_LABEL[request.kind].replace(" grants", "")} ` +
          `"${request.name}" (${request.id}). ${resourceRequestRemedy(request.kind)} ` +
          `It is on the Controller tab of Instance settings and in your own turn context until it is answered; do not say you have the resource until it is.`
        );
      }),
    ),
    "request_resource_grant",
  );

  add(
    tool(
      "list_knowledge_bases",
      "List the org knowledge bases (grant key, name, folder, file count, refresh mode). Org admins only. `grantKey` is the store DIRECTORY, the only form save_global_agent's `kbs` accepts; `id` is for save_knowledge_base.",
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
            // Ruling 257 (F37-88): the NAMES, not just a count. A `doc` write
            // replaces a whole file, and the model could not see that the name
            // it was about to write was already taken — the tool's own example
            // path, `conventions.md`, is the live rulings file on this very
            // instance.
            documents: kbDocumentNames(kb.id),
            // Ruling 578: closed to every agent's shell; only granted runs
            // read it, through their knowledge tool.
            private: kb.private,
          })),
        );
      }),
    ),
    "list_knowledge_bases",
  );

  add(
    tool(
      "read_knowledge_base_doc",
      "Read one document out of a knowledge base: the passage an `edit_knowledge_base_doc` replaces is copied from here, and a whole-document `save_knowledge_base` write carries the text forward from here instead of destroying it. Org admins only. Returns null when the KB or the file is not there (ruling 246: existence before type). Ruling 580: a long document comes back in pages; `nextOffset` is where the next read starts, null at the end, and a whole-document replace needs every page.",
      {
        id: z.string().describe("KB id, from list_knowledge_bases."),
        path: z.string().describe("File name inside the KB folder, e.g. conventions.md."),
        offset: z.number().int().min(0).optional().describe(KB_DOC_OFFSET_DESCRIPTION),
      },
      runWith((args: { id: string; path: string; offset?: number }) => {
        requireOrgAdmin("read the org knowledge bases");
        const target = resolveStoreTarget(db, "kb", args.id, { dataRoot });
        if (!target) return `[denied] No knowledge base with id ${args.id}.`;
        const doc = readStoreDoc(target, [args.path]);
        if (!doc) {
          return (
            `[denied] ${args.path} is not a document in that knowledge base. ` +
            `list_knowledge_bases names what it holds.`
          );
        }
        // Ruling 580: a long document comes back in pages. Whole, a 94 KB
        // document was more than the controller could take in, and it could
        // not safely change what it could not read.
        const start = Math.min(Math.max(0, args.offset ?? 0), doc.text.length);
        // Ruling 624: a page is bounded in UTF-8 bytes, as every agent read is.
        const end = pageEnd(doc.text, start);
        return json({
          path: args.path,
          // Ruling 466: UTF-8 bytes, the unit the write replies use.
          bytes: utf8Bytes(doc.text),
          truncated: doc.truncated,
          // Ruling 305: hand back the version this text IS, so a replace can
          // say which one it is replacing and Viberr can refuse when the
          // document moved underneath it.
          version: storeDocVersion(target, [args.path]),
          characters: doc.text.length,
          offset: start,
          nextOffset: end < doc.text.length ? end : null,
          text: doc.text.slice(start, end),
        });
      }),
    ),
    "read_knowledge_base_doc",
  );

  add(
    tool(
      "save_knowledge_base",
      "Create or update a knowledge base (name, refresh mode, `private`), optionally writing one document into its folder. Org admins only. Ruling 578: every agent can read an open knowledge base from its shell, granted or not (a grant decides what a run is given, not what it can read), so anything the agents under test must not see, such as a benchmark's answer key, goes into a private one. The reply names the KB's id (what the next save takes) and its grantKey (what a grant takes). Ruling 637: to change part of a document that exists, use edit_knowledge_base_doc, which replaces one passage in place: a replace sends the whole document back, so every line becomes your copy of it, and a document rebuilt over several calls is partial to every reader in between. A `doc` REPLACES the whole file, so a name that already exists is refused unless you pass `replace: true` AND `replaces`, the `version` read_knowledge_base_doc returned beside the text (rulings 257 and 305): read the existing text first, send it back with your change, or nothing you leave out survives. If the document moved between your read and your write the write is refused whole with both versions named, because somebody else's edit is in there. The reply says which happened, and how many bytes a replace destroyed. To BUILD a long document, pass `doc.append: true` and send it a section at a time: append destroys nothing, so it needs no version, and a 2 KB call is far likelier to arrive intact than an 8 KB one (F39-3: a 7,356-byte document write came back unparseable as JSON and had to be re-emitted whole). An append adds EXACTLY the text you send, nothing trimmed and nothing inserted (ruling 466), so you own the separators and newlines: end a part with a newline when the next part starts a new line, and a part may end mid-table, mid-list or inside a fenced block. Every size the reply names is in UTF-8 bytes.",
      {
        id: z
          .string()
          .optional()
          .describe(
            "Existing KB id to update, from list_knowledge_bases or this tool's own reply; omit to create.",
          ),
        name: z.string(),
        // The shared constant, not a hand-copied list: "nightly" was retired
        // when it turned out nothing ever scheduled it (see KB_REFRESH_MODES),
        // but this tool kept advertising it, so the controller could pick a
        // mode that was silently coerced to "on change" behind its back.
        refresh: z.enum(KB_REFRESH_MODES).optional(),
        private: z
          .boolean()
          .optional()
          .describe(
            "Ruling 578: true closes the KB's folder to every agent's shell; the runs it is granted to read it through read_knowledge_doc, which a Codex specialist gets from Viberr's MCP gateway (ruling 585). false opens it again. Omit to leave it as it is.",
          ),
        doc: z
          .strictObject({
            path: z.string().describe("File name inside the KB folder, e.g. conventions.md."),
            content: z
              .string()
              .describe(
                "The WHOLE file (what you omit is gone) UNLESS `append` is set, when it is the text to add at the end.",
              ),
            append: z
              .boolean()
              .optional()
              .describe(
                "F39-1: add `content` to the END of the document instead of replacing it, creating the file when it is absent. Destroys nothing, so no `replace`/`replaces` is needed (passing either with this is refused). Use it to build a long document in bounded calls rather than one large one. Ruling 466: `content` is appended byte for byte, with no trimming and no separator, so end a part with a newline if the next part starts a new line.",
              ),
            replace: z
              .boolean()
              .optional()
              .describe(
                "Required to overwrite a file that already exists. Read it first; `content` replaces all of it.",
              ),
            replaces: z
              .string()
              .optional()
              .describe(
                "Ruling 305: the `version` read_knowledge_base_doc returned beside the text you are replacing. Required to overwrite an existing file. If the document has changed since that read, the write is refused with nothing written and both versions named, because somebody else's edit is in there and a whole-document replace would delete it.",
              ),
          })
          .optional()
          .describe("A document to write into the KB folder."),
      },
      runWith(
        async (args: {
          id?: string;
          name: string;
          refresh?: KbRefreshMode;
          private?: boolean;
          doc?: {
            path: string;
            content: string;
            append?: boolean;
            replace?: boolean;
            replaces?: string;
          };
        }) => {
          requireOrgAdmin("manage knowledge bases");
          const saved = await saveKnowledgeBase(
            db,
            { id: args.id ?? null, name: args.name, refresh: args.refresh ?? "on change" },
            actor,
            { dataRoot },
          );
          // U36-4 (pass 36): the reply carries what the next call needs — the
          // id for a save, the grantKey for a grant. The toast alone named the
          // folder, and the controller then guessed `disk:<dir>`.
          // Ruling 578: the folder's own mode is the flag.
          const privacy =
            args.private === undefined
              ? ""
              : setKnowledgeBasePrivacy(db, { id: saved.kb.id, private: args.private }, actor, { dataRoot }).changed
                ? args.private
                  ? " It is now private: no agent's shell can open its folder, and the runs it is granted to read it through read_knowledge_doc."
                  : " It is open again: every agent can read its folder."
                : args.private
                  ? " It was already private."
                  : " It was already open.";
          const head = `[done] ${saved.toast} (id ${saved.kb.id}, grantKey ${saved.kb.dir}).${privacy}`;
          let docNote = "";
          if (args.doc) {
            const target = resolveStoreTarget(db, "kb", saved.kb.id, { dataRoot });
            if (!target) {
              return `${head} The document could not be written: the KB folder did not resolve.`;
            }
            // Ruling 257 (pass 37, F37-88): `overwrite: true` used to be
            // hardcoded, so the writer's own collision guard could never fire
            // and the returned `replaced` flag was discarded — the reply read
            // "Document conventions.md written" whether it created a file or
            // destroyed one. The HUMAN door for the same write refuses the
            // collision unless a replace confirmation says otherwise, and its
            // toast says "replaced" or "saved" from this same flag. Live, this
            // tool is the only way into an existing KB (a no-id create is
            // refused once the folder has a metadata row), and the project's
            // rulings KB — injected into EVERY run on the project — is one call
            // away from being erased by a model writing the obvious filename.
            // F39-1: APPEND. It cannot destroy anything, so rulings 257 and
            // 305 (the collision guard and the version check) do not apply —
            // they exist to stop a whole-document replace deleting text the
            // writer never read. Mixing the two modes would be a caller that
            // does not know which it meant, so it is refused rather than
            // resolved.
            if (args.doc.append === true) {
              if (args.doc.replace !== undefined || args.doc.replaces !== undefined) {
                return (
                  `${head} Nothing was written. append cannot be combined with ` +
                  "replace or replaces: an append adds to the end and destroys nothing, " +
                  "a replace overwrites the whole document. Send one or the other."
                );
              }
              // Ruling 466 (F40-13): the writer concatenates EXACTLY what was
              // sent. This used to trim the part and force a blank line before
              // it, so a part boundary inside a markdown table split the table
              // in two (live, the controller rewrote the whole document to
              // mend it), and it rebuilt the file from the editor's capped
              // read, so a document past the cap lost its tail.
              const appended = writeStoreDoc(
                db,
                target,
                [],
                args.doc.path,
                args.doc.content,
                actor,
                { append: true },
              );
              return (
                `${head} Appended ${appended.appendedBytes ?? 0} bytes to ` +
                `${appended.path.join("/")}${appended.previousBytes === null ? " (created)" : ""}; it is now ` +
                `${appended.bytes} bytes. Nothing was replaced.`
              );
            }
            const before = readStoreDoc(target, [args.doc.path]);
            // Ruling 305: a whole-document replace names the version it read.
            // `writeStoreDoc`'s own collision guard (ruling 257) asks whether
            // the file EXISTS; this asks whether it is still the one you read.
            // The controller hit the difference live: correcting one paragraph
            // of the 26 KB rulings document, it re-read first and found that
            // "§9 had grown a whole existence-oracle section I had not
            // written". A blind replace would have deleted that section and
            // reported only how many bytes it destroyed.
            if (before) {
              const current = storeDocVersion(target, [args.doc.path]);
              if (args.doc.replaces === undefined) {
                return (
                  `${head} Nothing was written. ${args.doc.path} already exists, and a ` +
                  `replace must name the version it read: pass replaces: "${current}", ` +
                  "which read_knowledge_base_doc returns beside the text. Read it first " +
                  "and send the whole document back with your change."
                );
              }
              if (args.doc.replaces !== current) {
                return (
                  `${head} Nothing was written. ${args.doc.path} has changed since you ` +
                  `read it: you replaced version ${args.doc.replaces}, it is now ` +
                  `${current}. Somebody else's edit is in there. Read it again and ` +
                  "redo your change on top of what is there now."
                );
              }
            }
            const written = writeStoreDoc(
              db,
              target,
              [],
              args.doc.path,
              args.doc.content,
              actor,
              { overwrite: args.doc.replace === true },
            );
            docNote = written.replaced
              ? ` Document ${written.path.join("/")} REPLACED: its previous ${written.previousBytes ?? 0} bytes are gone, ${written.bytes} written.`
              : ` Document ${written.path.join("/")} saved (${written.bytes} bytes).`;
          }
          return `${head}${docNote}`;
        },
      ),
    ),
    "save_knowledge_base",
  );

  // Ruling 637: one passage, in place. A whole-document replace was the only
  // way to change part of a document, and live it re-typed 104 KB in nine
  // calls to add three sentences.
  add(
    tool(
      "edit_knowledge_base_doc",
      "Replace ONE passage of a knowledge-base document in place (ruling 637). Org admins only. `was` is the passage exactly as the document has it: copy it character for character from read_knowledge_base_doc, list markers and emphasis included, and send enough of it to stand exactly once. `now` is what takes its place; an empty `now` deletes the passage. The document is written once, under the lock agent corrections take, so no reader ever sees half of it and nothing you did not send changes. Refused, with nothing written, when the passage is not there (the reply shows the closest lines) or stands more than once, when `now` changes nothing, and when either side is over 8 KB: change a long section in several edits. To add text at the end of a document, use save_knowledge_base with `doc.append`. Every size the reply names is in UTF-8 bytes.",
      {
        id: z.string().describe("KB id, from list_knowledge_bases."),
        path: z.string().describe("File name inside the KB folder, e.g. mapping.md."),
        was: z.string().describe("The passage to replace, exactly as the document has it, standing once in it."),
        now: z.string().describe("What takes its place. Empty deletes the passage."),
      },
      runWith(async (args: { id: string; path: string; was: string; now: string }) => {
        requireOrgAdmin("edit the org knowledge bases");
        const target = resolveStoreTarget(db, "kb", args.id, { dataRoot });
        if (!target) return `[denied] No knowledge base with id ${args.id}.`;
        const edited = await editKbPassage(
          db,
          { kb: path.basename(target.rootAbs), doc: args.path, was: args.was, now: args.now, actor },
          { dataRoot },
        );
        if (!edited.ok) return `[denied] ${edited.message}`;
        return (
          `[done] Edited ${args.path} in ${target.name}: one passage replaced; it went from ` +
          `${edited.previousBytes} to ${edited.bytes} bytes (version ${storeDocVersion(target, [args.path])}). ` +
          "Nothing else in it changed."
        );
      }),
    ),
    "edit_knowledge_base_doc",
  );

  // Ruling 483 (F40-59): the door a person's Promote or Dismiss button asks
  // the controller to walk. Ruling 378 left promotion to "a human or the
  // controller" and gave neither a way to find or close a proposal; live on
  // WEB-1 two sat unpromoted while the next packet asked the owner to type the
  // "not binding" build command into Cloudflare. Org-admin gated like every
  // other knowledge-base write, because a proposal lives in an org knowledge
  // base. Since ruling 498 nothing files a proposal; this closes the ones
  // documents still hold.
  add(
    tool(
      "resolve_kb_proposal",
      "Promote or dismiss one open knowledge-base proposal (ruling 483): an entry an agent filed, before corrections were written straight into the document (ruling 498), under \"Proposed corrections (not binding)\" in a knowledge-base document, listed in your turn context and in get_project's `openProposals` by id. Org admins only, and only when the person asked you to: their Promote, Dismiss and Promote all buttons on a project's Controller page send you exactly that request. `promote` writes `text` into the document's SETTLED text, in place of `replaces` (the exact passage it corrects, which must stand once in the settled text; read the document first with read_knowledge_base_doc) or appended to the settled text when `replaces` is omitted, and removes the entry in the same write. `dismiss` removes the entry and changes nothing else. `reason` is recorded on the audit row.",
      {
        id: z.string().describe("The proposal's id, e.g. 'kp-3f9a1c2b7d'."),
        action: z.enum(["promote", "dismiss"]),
        replaces: z
          .string()
          .optional()
          .describe(
            "promote only: the settled passage the correction takes the place of, exactly as the document has it. Omit to append `text` to the settled text instead.",
          ),
        text: z
          .string()
          .optional()
          .describe("promote only, and required there: the settled text to write."),
        reason: z
          .string()
          .describe("Why, in a sentence: what the person decided and on what evidence."),
      },
      runWith(
        async (args: {
          id: string;
          action: "promote" | "dismiss";
          replaces?: string;
          text?: string;
          reason: string;
        }) => {
          requireOrgAdmin("promote or dismiss knowledge-base proposals");
          const result = await resolveKbProposal(
            db,
            args.action === "promote"
              ? {
                  id: args.id,
                  action: "promote",
                  replaces: args.replaces ? prose(args.replaces) : null,
                  text: prose(args.text ?? ""),
                  reason: prose(args.reason),
                }
              : { id: args.id, action: "dismiss", reason: prose(args.reason) },
            actor,
            { dataRoot },
          );
          return `[${result.outcome}] ${result.message}`;
        },
      ),
    ),
    "resolve_kb_proposal",
  );

  // Ruling 498: an agent's knowledge-base correction is written as it is made,
  // and a person undoes the ones they disagree with. Their Undo on a project's
  // Controller page does it directly; this is the same undo for a person who
  // asks in a conversation. Org-admin gated like every knowledge-base write.
  add(
    tool(
      "undo_kb_correction",
      "Undo one knowledge-base correction an agent wrote (ruling 498), by its id (`kc-` and ten hex characters; get_project lists a project's in `kbCorrections`). Org admins only, and only when the person asked you to. It puts back the passage the correction replaced (or removes the text it added) and notes the undo on the task that made it; an agent that later tries to write the same text into that document is refused and told who undid it and why, so pass the person's `reason`. It refuses, writing nothing, when the document was edited since: then read it with read_knowledge_base_doc and change the passage with edit_knowledge_base_doc.",
      {
        id: z.string().describe("The correction's id, e.g. 'kc-3f9a1c2b7d'."),
        projectSlug: z
          .string()
          .optional()
          .describe("The project whose task made it; defaults to this conversation's project."),
        reason: z
          .string()
          .describe("Why, in a sentence: what the person said is wrong with it. Agents that try to write it again are shown this."),
      },
      runWith(async (args: { id: string; projectSlug?: string; reason: string }) => {
        requireOrgAdmin("undo knowledge-base corrections");
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "undo this project's knowledge-base corrections");
        const result = await undoKbCorrectionOnTask(
          db,
          { dataRoot },
          {
            id: args.id,
            projectSlug: slug,
            reason: prose(args.reason),
            // The audit names the person, as every controller write does.
            person: { userId: user.id, label: actor.label, name: user.name },
          },
        );
        return `[${result.outcome}] ${result.message}`;
      }),
    ),
    "undo_kb_correction",
  );

  add(
    tool(
      "list_skills",
      "List the org skills (grant key, name, summary). Org admins only. `grantKey` is the skill FOLDER NAME, the only form save_global_agent's `skills` accepts; `id` is for save_skill.",
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
      "Create or update an org skill (name, one-line summary, SKILL.md body). Org admins only. The reply names the skill's id (what the next save takes) and its grantKey (what a grant takes).",
      {
        id: z
          .string()
          .optional()
          .describe(
            "Existing skill id to update, from list_skills or this tool's own reply; omit to create.",
          ),
        name: z.string(),
        summary: z.string(),
        body: z
          .string()
          .optional()
          .describe(
            "SKILL.md content with REAL newlines: a --- frontmatter block (name, description) followed by markdown, or plain markdown. Required on a create; omit on an update to keep what is on disk. An empty, JSON-escaped (literal \\n and no newline) or unparseable body is refused, never rewritten (ruling 183).",
          ),
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
          actor,
          { dataRoot },
        );
        // U36-4: the same re-enterable reply as save_knowledge_base.
        return `[done] ${saved.toast} (id ${saved.skill.id}, grantKey ${saved.skill.name}).`;
      }),
    ),
    "save_skill",
  );

  add(
    tool(
      "list_mcp_servers",
      "List the org MCP connections (grant key, name, transport, target, health). Org admins only. `up` is a CACHED verdict: read `lastCheckedAt` for its age and `warmingSince` for a server still installing on first use, and call test_mcp_server rather than relaying a stale red. `storeAccessNote` is present when the server's command is pointed inside Viberr's own store, which lets an agent rewrite the knowledge bases, skills and agent profiles Viberr injects into runs (ruling 278) - relay it whenever you are asked about that server or asked to grant it. `signIn` is an HTTP server's OAuth sign-in (ruling 469): null when it is not an OAuth server, else `needs_sign_in` (runs do not mount it), `signed_in` (with `expiresAt` and whether it `renews`) or `expired` (with the reason); `signInNote` says it in words. A signed-in server's `signIn.grant` is what its authorization server granted (ruling 486): `scopes` and `writes` counted, `readOnly` when no scope writes, `summary` (such as read-only · 194 scopes), and `writeScopes` by name; null when the server did not say. A read-only grant refuses every call that writes, so relay it before anyone plans a write through that server. `requestedScopes` is what the next sign-in asks for (null asks for what the server advertises). Only an org admin signs a server in or out, in Instance settings → Agent resources; you cannot. Credentials and tokens are never shown. `grantKey` is the REGISTRY NAME, the only form save_global_agent's `mcps` accepts; `id` is for save_mcp_server and test_mcp_server.",
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
            // Ruling 278 (F37-111): `up` is a CACHED verdict and the row
            // carries when it was taken — this read did not. Live, the
            // controller saw `up: false` with the reason "no response in 20s.
            // npx fetches its package on first use, so this is probably still
            // downloading", probed it itself, and found it healthy in 10.3s: a
            // red server that is fine, with no way to tell how old the reading
            // was. `warmingSince` is the other half — a first-run install is
            // not a broken server (R19-18).
            lastCheckedAt: m.lastCheckedAt,
            warmingSince: m.warmingSince,
            tools: m.tools,
            hasCredential: m.hasCred,
            lastError: m.lastError,
            // Ruling 188 (pass 37, F37-6): ruling 176's marking, which the Org
            // settings row states ("N write tools withheld from read-only
            // runs") and this read did not carry at all. Live, the controller
            // reasoned correctly from what it could see — "if Viberr enforces
            // that marking, it does so somewhere I cannot read, and I won't
            // assert that it does" — and refused a grant that was in fact safe.
            writeTools: m.writeTools,
            writeToolsReviewed: m.writeToolsReviewed,
            writeToolsNote:
              m.writeTools.length > 0
                ? `${m.writeTools.length} write ${m.writeTools.length === 1 ? "tool is" : "tools are"} withheld from every run without execute-code-or-write-repo, and from every operator run (ruling 176).`
                : m.writeToolsReviewed
                  ? "Reviewed: no tool on this server is marked as a write tool, so none is withheld."
                  : "Not reviewed yet: nothing is withheld. Viberr makes no claim about the tools nobody has marked.",
            // Ruling 278: the one case that is qualitatively different from
            // writing a repo — a server pointed INSIDE Viberr's own store can
            // rewrite the knowledge bases, skills and agent profiles Viberr
            // injects into runs, including the rules its reviewers judge
            // against. Found live on this instance.
            storePaths: m.storePaths,
            storeAccessNote: mcpStoreAccessNote(m.storePaths),
            // Ruling 469: the public half of an OAuth sign-in, never a token.
            signIn: m.oauth
              ? {
                  status: m.oauth.status,
                  expiresAt: m.oauth.expiresAt,
                  renews: m.oauth.renews,
                  issuer: m.oauth.issuer,
                  reason: m.oauth.reason,
                  // Ruling 486 (F40-63): what the sign-in may do. Live, this
                  // read said "signed_in" over a grant of 194 read-only
                  // scopes, and the first write came back "Authentication
                  // error" with nothing here to say why.
                  grant: grantOf(m.oauth.scope),
                }
              : null,
            signInNote: mcpSignInNote(m.oauth),
            requestedScopes: m.requestedScope ?? null,
          })),
        );
      }),
    ),
    "list_mcp_servers",
  );

  add(
    tool(
      "save_mcp_server",
      "Create or update an org MCP connection (name, transport, endpoint or command). Org admins only. `requestedScopes` records the OAuth scopes an HTTP server's next sign-in asks for (ruling 486); it takes effect when an org admin signs in again, and the server decides what it grants. Credentials do NOT travel through chat: tell the admin to add the secret in Instance settings → Agent resources, then test the server. An HTTP server that asks for an OAuth sign-in (the reply says so) is signed in by an org admin from its editor in Instance settings → Agent resources (Sign in), which you cannot do: tell the admin, and until then runs do not mount it (ruling 469). `writeTools` marks the tools Viberr withholds from every run without execute-code-or-write-repo and from every operator run (ruling 176). Marking is a REVIEW, so nothing is marked unless you say so: a server saved without it withholds NOTHING, and the reply names the tools whose names look like writes so you can mark them in a second call. Pass [] to record that none should be withheld. On an UPDATE, omitting the field leaves the existing marking untouched.",
      {
        id: z.string().optional().describe("Existing server id to update; omit to create."),
        name: z.string(),
        transport: z.enum(["HTTP", "stdio"]),
        target: z.string().describe("HTTP endpoint, or the stdio command line."),
        writeTools: z
          .array(z.string())
          .optional()
          .describe(
            "Tool names to withhold from read-only runs. Omit on create for the heuristic default; omit on update to leave the marking unchanged; pass [] to mark none.",
          ),
        requestedScopes: z
          .string()
          .optional()
          .describe(
            "HTTP only (ruling 486): the OAuth scopes the next sign-in asks for, space-separated (e.g. \"workers-scripts.write zone.read\"). The authorization server decides what it grants; list_mcp_servers shows it. Omit to leave the stored request unchanged; \"\" clears it, so the server's advertised scopes are asked for.",
          ),
      },
      runWith(
        async (args: {
          id?: string;
          name: string;
          transport: "HTTP" | "stdio";
          target: string;
          writeTools?: string[];
          requestedScopes?: string;
        }) => {
          requireOrgAdmin("manage MCP connections");
          // Ruling 188 (pass 37, F37-7): this tool could create an MCP server
          // but never govern one. It took no `writeTools`, so every server the
          // controller made landed with a NULL tool policy — ungoverned — while
          // the human editor pre-ticked a default. Live, the controller created
          // two servers, reported "they were created unmarked" and asked a
          // person to go and fix them by hand.
          // `writeTools` is a SENTINEL field for the writer: absent means "leave
          // the marking alone" on an update and "mark nothing" on a create, so
          // it is set only when the caller actually named a list.
          const input: Parameters<typeof saveMcpServer>[1] = {
            id: args.id ?? null,
            name: args.name,
            transport: args.transport,
            target: args.target,
            cred: "",
          };
          if (args.writeTools !== undefined) input.writeTools = args.writeTools;
          if (args.requestedScopes !== undefined) input.requestedScopes = args.requestedScopes;
          const saved = await saveMcpServer(db, input, actor, {}, { dataRoot });
          // `saveMcpServer` answers with the row it wrote, so the reply states
          // the marking that actually landed rather than the one we asked for.
          const policy = saved.mcp.writeTools;
          const suggestion = saved.writeToolsSuggestion;
          // Ruling 278 (F37-111): said at the moment the server is saved,
          // because this is where the path is chosen. A command pointed inside
          // Viberr's own store is the one case ruling 176's marking cannot
          // cover — it binds only on a run that withholds
          // execute-code-or-write-repo, and an agent that runs tests holds it.
          const storeNote = mcpStoreAccessNote(saved.mcp.storePaths);
          return (
            `[done] ${saved.toast}. ` +
            (policy.length > 0
              ? `${countLabel(policy.length, "write tool")} withheld from every run without execute-code-or-write-repo and from every operator run (ruling 176): ${policy.join(", ")}. `
              : suggestion.length > 0
                ? `NOTHING is withheld: no tool on this server is marked, so every tool it exposes, including the ones that write, reaches every run that mounts it. From the names the probe listed, these look like write tools: ${suggestion.join(", ")}. Call save_mcp_server again with \`writeTools\` to mark them (or an explicit [] to record that none should be), then say which you chose. `
                : "Nothing is marked as a write tool, so nothing is withheld. The probe listed no tool whose name looks like a write. ") +
            (storeNote ? `${storeNote} ` : "") +
            // Ruling 469: a server that asked for an OAuth sign-in is the
            // admin's to sign in; the reply says so rather than "add a secret".
            (saved.mcp.oauth && saved.mcp.oauth.status !== "signed_in"
              ? `${mcpSignInNote(saved.mcp.oauth)} `
              : "If it needs a credential, the admin adds it in " +
                "Instance settings → Agent resources (secrets never travel through this chat).")
          );
        },
      ),
    ),
    "save_mcp_server",
  );

  add(
    tool(
      "test_mcp_server",
      "Probe one org MCP connection now and report its health in the command's own words; a server signed in with OAuth also names what its sign-in was granted (\"read-only · 194 scopes\", ruling 486). Org admins only.",
      { id: z.string().describe("The server's id or its name (from list_mcp_servers).") },
      runWith(async (args: { id: string }) => {
        requireOrgAdmin("test MCP connections");
        const result = await testMcpServer(db, resolveMcpServerId(db, args.id));
        return `[done] ${result.toast}`;
      }),
    ),
    "test_mcp_server",
  );

  add(
    tool(
      "list_global_agents",
      "List the org's global agent templates (specialists a project can deploy), each with its full persona, the resource grants it holds, its default model and effort, and `copiesDiffering`: the projects whose deployed copy no longer carries the template's grants (ruling 156). A deployment is a SNAPSHOT: editing a template does NOT reach a project that already deployed it, for the persona or the summary any more than for the grants, so `copiesWithOlderText` lists the projects still running the older text and which field it is (ruling 277). Fixing one is a project-level edit on that project's Agents page, or save_global_agent with propagate for the grants. Org admins only. Read this before save_global_agent so an edit is not blind.",
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
            // Ruling 197 (F37-18): F33-7 put the GRANTS here so an edit was not
            // blind, and left out the biggest field of all. Live pass 37 the
            // controller needed to correct three stale summaries, would not
            // risk the personas it could not read, and left summaries
            // advertising Testcontainers and Docker Compose on a host with
            // neither — to the operator, which selects agents by that text.
            persona: g.persona,
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
            // Ruling 277 (F37-110): the grants are not the only thing a
            // deployment SNAPSHOTS. The same copy holds the persona — the
            // run's whole system prompt — and the summary the operator selects
            // by, and nothing compared either, so `copiesDiffering: []` read as
            // "every copy is current" about copies that were not. Live, four
            // templates were rewritten to correct a persona describing a
            // machine this host is not; the check said no copy differed; the
            // four agents running at that moment still mounted the old text.
            copiesWithOlderText: listTemplateTextDrift(db, g.id, { dataRoot }).map(
              (d) => `${d.projectSlug} (${d.fields.join(", ")})`,
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
      "Create or update a global agent template (name, backend, summary, persona, eligible stages, default model and effort, resource grants). Org admins only. The controller itself and the operator are system profiles this tool cannot touch. Merge semantics: an omitted skills/mcps/kbs list leaves the stored grants unchanged and an empty list clears them; an omitted or empty PERSONA leaves the stored persona unchanged, so editing a summary alone is safe. Read list_global_agents first, which returns the persona and the grants, and grant by grantKey, never by id. A project deployment keeps its own copy of the grants; the reply names every copy that now differs and how to update it.",
      {
        id: z.string().optional().describe("Existing template id to update; omit to create."),
        name: z.string(),
        backend: z.enum(["claude", "codex"]),
        summary: z.string().describe("One scannable paragraph the operator selects by."),
        persona: z
          .string()
          .optional()
          .describe(
            "The long persona/system-prompt body. Same merge rule as the grants above: omit it (or pass \"\") and the stored persona is KEPT, so a summary-only edit is safe and cannot flatten an agent's system prompt. `list_global_agents` returns the current one.",
          ),
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
            `Default effort tier the backend offers: ${EFFORT_TIERS_SENTENCE}. Omit to keep the stored tier; "" clears it.`,
          ),
        propagate: z
          .boolean()
          .optional()
          .describe(
            "Also rewrite the grants of every project copy that no longer matches this template, and, when THIS call changes the persona, the persona of every copy still running older text (ruling 467); the reply names each copy and what it rewrote. Off by default: a project's copy is its own record.",
          ),
        skills: z
          .array(z.string())
          .optional()
          .describe(
            "Skill grants by grantKey: the skill FOLDER NAME from list_skills, never its id. Omit to keep the stored grants; [] clears them.",
          ),
        mcps: z
          .array(z.string())
          .optional()
          .describe(
            "MCP grants by grantKey: the REGISTRY NAME from list_mcp_servers, never its id. Omit to keep the stored grants; [] clears them.",
          ),
        kbs: z
          .array(z.string())
          .optional()
          .describe(
            "Knowledge-base grants by grantKey: the store DIRECTORY from list_knowledge_bases, never its id or display name. Omit to keep the stored grants; [] clears them.",
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
          const saved = await saveGlobalAgentProfile(db, input, actor, {
            dataRoot,
          });
          // Ruling 153: the reply states the defaults a deploy will take.
          const defaults =
            ` Template defaults: ${BACKEND_LABEL[saved.profile.backend]}, ` +
            `model ${saved.profile.model || defaultModelFor(saved.profile.backend)}, ` +
            `effort ${saved.profile.effort || defaultEffortFor(saved.profile.backend)}.`;
          // Ruling 156: the reply is built from the RESULT, not the toast. A
          // copy that differs is named with what it lacks and how to update
          // it; a propagation names what each copy gained.
          const verb = args.id ? "updated" : "created";
          const head = `[done] ${saved.profile.name} ${verb}.`;
          // Ruling 277 (F37-110): a deployment SNAPSHOTS the persona and the
          // summary, `propagate` rewrites only the grants, and every arm below
          // is built from `diverged` — which compares grants. So an edit that
          // corrected a persona reported success, and the agents running that
          // profile kept the old system prompt. Live, four templates were
          // rewritten to fix a persona describing a machine this host is not,
          // the grants check answered "every copy carries the template's
          // grants", and four runs still mounted the old text. This rides
          // EVERY arm because the two facts are independent: grants can be in
          // step while the text is not, which is exactly the case that misled.
          // Ruling 467: the doors that now exist for an older copy. Propagate
          // rewrites a persona only in a call that changes it, and never a
          // summary, so both of the other doors stay named.
          const olderFields = [...new Set(saved.textBehind.flatMap((d) => d.fields))];
          const doors = olderFields.includes("persona")
            ? "a save_global_agent call that changes the persona with propagate: true rewrites the copies' persona, " +
              "update_agent_deployment with persona sets one copy, and an org admin can edit each copy on that " +
              "project's Agents page."
            : "propagate does not rewrite a summary; an org admin fixes each copy on that project's Agents page.";
          const behind =
            saved.textBehind.length > 0
              ? ` ${saved.textBehind.length} project cop${saved.textBehind.length === 1 ? "y" : "ies"} still ` +
                `run${saved.textBehind.length === 1 ? "s" : ""} the older ${olderFields.join(" and ")}: ` +
                `${saved.textBehind.map((d) => d.projectSlug).join(", ")}. A deployment snapshots ` +
                `that text: ${doors}`
              : "";
          // Ruling 467: per project, what the persona propagation rewrote.
          const personaCopies =
            saved.personaPropagated.length > 0
              ? ` Persona rewritten on ${countLabel(saved.personaPropagated.length, "project copy", "project copies")}: ` +
                `${saved.personaPropagated.map((p) => `${p.projectSlug} (${p.change})`).join("; ")}.`
              : "";
          if (saved.propagated.length > 0) {
            const per = saved.propagated.map((p) => {
              const parts: string[] = [];
              if (p.added.length) parts.push(`added ${p.added.join(", ")}`);
              if (p.removed.length) parts.push(`dropped ${p.removed.join(", ")}`);
              return `${p.projectSlug}${parts.length ? ` (${parts.join("; ")})` : ""}`;
            });
            return `${head} Grants copied to ${countLabel(saved.propagated.length, "project")}: ${per.join("; ")}.${personaCopies}${behind}${defaults}`;
          }
          if (saved.diverged.length > 0) {
            return `${head} ${divergedSentence(saved.diverged)} Call save_global_agent again with propagate: true to rewrite those copies, or an org admin takes the template's grants on that project's Agents page.${personaCopies}${behind}${defaults}`;
          }
          if (args.id && saved.profile.used > 0) {
            return `${head} Every project copy carries the template's grants.${personaCopies}${behind}${defaults}`;
          }
          return `${head}${personaCopies}${behind}${defaults}`;
        },
      ),
    ),
    "save_global_agent",
  );

  add(
    tool(
      "inspect_audit_log",
      "Read the audit trail with filters (project, action, actor, time range). Org admins only. `action` is a PREFIX: \"task.\" reads every task action, \"task.transition\" narrows, a whole id matches exactly that one. A filter that matches nothing says so and lists the action ids the window DOES contain, because a wrong spelling and a quiet period used to look identical (ruling 279). `actions` on every reply is the vocabulary with a count each, so you never have to know an id before you can ask for it. Rows are retained 90 days.",
      {
        projectSlug: z.string().optional(),
        action: z
          .string()
          .optional()
          .describe('Action id PREFIX, e.g. "task." for all task actions or "task.created" for one.'),
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
          // Ruling 279 (F37-112): a PREFIX. The headline said "action prefix"
          // and the parameter said "Exact action id" — two descriptions of one
          // field, contradicting each other, and the behaviour followed the
          // stricter one. Live, the controller filtered `action: "task."`,
          // received `total: 0` with no error, and could not tell a wrong
          // spelling from a quiet period.
          if (args.action) filters.actionPrefix = args.action;
          if (args.actorUserId) filters.actorUserId = args.actorUserId;
          if (args.since) filters.since = args.since;
          if (args.until) filters.until = args.until;
          const rows = queryAuditEventsForExport(db, filters);
          const limit = args.limit ?? 50;
          // Ruling 279: the vocabulary, from the same window MINUS the action
          // filter — so an empty result can name what IS there instead of
          // leaving the caller to guess an id. It also answers "how many
          // decisions happened" without paging 8,282 rows at 200 a call, which
          // is what the controller had to do.
          const unfiltered = { ...filters };
          delete unfiltered.actionPrefix;
          const counts = new Map<string, number>();
          for (const r of queryAuditEventsForExport(db, unfiltered)) {
            counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
          }
          const actions = [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([action, n]) => `${action} (${n})`);
          return json({
            total: rows.length,
            shown: Math.min(limit, rows.length),
            // Named, not just counted: an empty result under a filter is the
            // case this exists for.
            noMatch:
              rows.length === 0 && args.action
                ? `No audit row in this window has an action starting with "${args.action}". The actions present are listed in \`actions\`.`
                : null,
            actions,
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
      "Agent-run analytics. Org admins only, optionally scoped to one project. Ruling 635: run figures are PER BACKEND and never summed across backends, because Claude and Codex do not measure alike: only Claude reports a cost, a Codex token and a Claude token are different models' tokens, and Codex reports no cache write. `runs.<backend>` holds each backend's totals, outcomes, coordination share and breakdowns by run kind, project, model, agent PROFILE and TASK; pass `backend` for one. Each is weighed in its `measure`: `cost` where the backend reported one, else `tokens`. `byProfile` answers which reviewer earns its runs, which `byKind` cannot because every reviewer is one kind; `byTask` answers what one task cost across its rework rounds, labelled `project/task` unless you scope to a project. Every breakdown is a WINDOW: `hidden`, `hiddenRuns`, `hiddenCost` and `hiddenTokens` give the groups the cap dropped, so eight of thirty never reads as thirty. A null cost or token figure means UNKNOWN, never zero. `oversight` (owner clarity, branch and PR traceability, decision waits, time to review, long timelines) is the instance's own record and covers every backend.",
      {
        projectSlug: z.string().optional(),
        backend: z.enum(["claude", "codex"]).optional(),
      },
      runWith((args: { projectSlug?: string; backend?: "claude" | "codex" }) => {
        requireOrgAdmin("inspect run analytics");
        const filter = args.projectSlug ? { projectSlug: args.projectSlug } : {};
        const now = new Date().toISOString();
        const backends = backendRuns(db, filter);
        // Every backend that ran, unless one was asked for: each its own
        // figures (ruling 635), so the reply cannot add a Codex token to a
        // Claude one or read Claude's dollars as the instance's.
        const read = args.backend
          ? [args.backend]
          : backends.filter((b) => b.runs > 0).map((b) => b.backend);
        const runs = Object.fromEntries(
          read.map((backend) => {
            const r = runAnalytics(db, now, { ...filter, backend });
            return [
              backend,
              {
                measure: r.measure,
                totals: r.totals,
                outcomes: r.outcomes,
                coordination: r.coordination,
                byKind: r.byKind,
                byProject: r.byProject,
                byModel: r.byModel,
                // Ruling 308: the two the controller asked for and could not
                // answer — "what did SHOP-27 cost across eleven rework rounds"
                // and "which reviewer earns its runs".
                byProfile: r.byProfile,
                byTask: r.byTask,
                avgDurationMs: r.avgDurationMs,
              },
            ];
          }),
        );
        return json({ backends, runs, oversight: oversightSummary(db, filter) });
      }),
    ),
    "inspect_run_analytics",
  );

  add(
    tool(
      "list_github_connections",
      "The instance's GitHub connections, the ones create_project needs (ruling 463). Per connection: `owner` (what create_project's `owner` takes), whether it is the `default`, the token's kind (classic or fine_grained), its validation (`valid`, `failed` with GitHub's reason, or `unvalidated`) and when it was last checked, its expiry, the required scopes it lacks, and `reach`: which repositories the TOKEN can reach, read from GitHub when the token was last validated, each with whether it is private and whether the token can push to it. `reach.status` is `read`, `unknown` (the read failed, with the reason; never read it as zero) or `not_read` (the connection predates the read; an org admin presses Re-check on it in Instance settings). A fine-grained token reaches exactly the repositories it was granted, so a repository missing from a `read` reach is one this token cannot see. Never carries token material. Open to any signed-in person, the same people the New project dialog shows these connections to.",
      {},
      run(() => {
        const connections = listConnections(db).map((c) => ({
          owner: c.owner,
          default: c.def,
          tokenKind: c.tokenKind ?? "unknown",
          validation: c.validationState,
          // The validator's own secret-free reason when the verdict failed.
          validationDetail: c.validationDetail,
          lastValidatedAt: c.lastValidatedAt,
          expiresAt: c.expiresAt,
          daysLeft: c.daysLeft,
          missingScopes: c.missingScopes,
          boundProjects: c.boundProjects,
          reach:
            c.reach === null
              ? {
                  status: "not_read" as const,
                  note: "Read when the token is next validated: an org admin presses Re-check on this connection in Instance settings → GitHub connections.",
                }
              : c.reach.status === "unknown"
                ? c.reach
                : {
                    status: c.reach.status,
                    readAt: c.reach.readAt,
                    summary: reachSummary(c.reach),
                    total: c.reach.total,
                    private: c.reach.privateCount,
                    capped: c.reach.capped,
                    repos: c.reach.repos,
                  },
        }));
        if (connections.length === 0) {
          return json({
            connections,
            note: "No GitHub connection exists, so create_project cannot run yet. An org admin adds one in Instance settings → GitHub connections.",
          });
        }
        return json({ connections });
      }),
    ),
    "list_github_connections",
  );

  add(
    tool(
      "create_project",
      "Create a project, optionally with the WHOLE custom shape in one request: stages (entry first, Done-equivalent last), boundary choices, members (existing users by email), description. Open to any signed-in person; the asker becomes the project's admin. Requires a GitHub connection for the repo owner: call list_github_connections FIRST, which names every connection's owner and the repositories its token reaches (ruling 463), so you never guess whether one exists or whether it can see the repository. The repository need not exist yet: `createRepository` has the server create it with the connection's token first (ruling 462). The move into the final stage stays a human decision whatever is asked. When you have designed the project's agents, pass them as `agents` (ruling 464), each with its model and effort: the project then gets the operator plus exactly that roster, not the generic Developer and Reviewer beside it. The reply lists every deployment written. deploy_agent adds one later; remove_agent_deployment takes one off.",
      {
        name: z.string(),
        key: z.string().describe("Task key prefix, 2 to 4 letters."),
        owner: z.string().describe("GitHub owner of the repo (a configured connection)."),
        repoName: z.string().describe("Repository name under that owner."),
        createRepository: z
          .strictObject({
            private: z
              .boolean()
              .describe("true unless the person asked for a public repository."),
            description: z
              .string()
              .optional()
              .describe("The repository's description on GitHub."),
          })
          .optional()
          .describe(
            "Pass it when the person wants the repository created, or says it does not exist yet. The server creates owner/repoName on GitHub through the connection's token BEFORE it writes the project; a repository that already exists is used as it is and the reply says so. When the token cannot create repositories the reply names what it lacks and nothing is created: relay that sentence, the person decides what to change.",
          ),
        policy: z.enum(["strict", "balanced", "auto"]).describe("strict = humans gate every advance · balanced = defaults · auto = full operator autonomy."),
        description: z.string().optional(),
        stages: z
          .array(
            z.strictObject({
              name: z.string(),
              color: z
                .enum(STAGE_COLORS)
                .optional()
                .describe(
                  `One of the stage colour presets (${STAGE_COLOR_LIST}); anything else is refused. Omit for the palette.`,
                ),
            }),
          )
          .optional()
          .describe("Custom stage list, 2 to 8, ordered, terminal LAST."),
        boundaries: z
          .array(
            z.strictObject({
              from: z.string().describe("Stage name."),
              to: z.string().describe("Adjacent next stage name."),
              boundary: z.enum(["auto", "approval", "human"]),
            }),
          )
          .optional(),
        members: z
          .array(
            z.strictObject({
              email: z.string(),
              role: z.enum(PROJECT_ROLES),
            }),
          )
          .optional(),
        agents: z
          .array(
            z.strictObject({
              profileId: z
                .string()
                .describe("A global template's store key from list_global_agents, as deploy_agent takes it."),
              model: z
                .string()
                .optional()
                .describe("Model id for the template's backend; omit for the template's own."),
              effort: z
                .string()
                .optional()
                .describe(`Effort tier the backend offers (${EFFORT_TIERS_SENTENCE}); omit for the template's own.`),
            }),
          )
          .optional()
          .describe(
            "Ruling 464: the roster you designed. Pass it when you have one: the project is then written with the operator plus EXACTLY these deployments and no generic Developer or Reviewer; leave it out and the base roster (operator, Developer, Reviewer) is written. Every entry is checked before anything is written, the repository included: an unknown template, a model or effort its backend does not offer, or an entry listed twice is refused by name. At least one entry.",
          ),
        operator: z
          .strictObject({
            backend: z
              .enum(["claude", "codex"])
              .optional()
              .describe("The backend the operator runs on; omit for its own (Claude). Its model and effort are checked against this backend."),
            model: z.string().optional(),
            effort: z
              .string()
              .optional()
              .describe(`Effort tier (${EFFORT_TIERS_SENTENCE}).`),
          })
          .optional()
          .describe("The operator's own backend, model and effort, checked the same way; omit to keep its defaults."),
      },
      runWith(
        async (args: {
          name: string;
          key: string;
          owner: string;
          repoName: string;
          createRepository?: CreateRepositoryRequest;
          policy: "strict" | "balanced" | "auto";
          description?: string;
          stages?: { name: string; color?: StageColor }[];
          boundaries?: { from: string; to: string; boundary: "auto" | "approval" | "human" }[];
          members?: { email: string; role: (typeof PROJECT_ROLES)[number] }[];
          agents?: RosterEntry[];
          operator?: OperatorOverrides;
        }) => {
          const input: CreateProjectInput = {
            name: args.name,
            key: args.key,
            owner: args.owner,
            repoName: args.repoName,
            policy: args.policy,
          };
          if (args.createRepository) input.createRepository = args.createRepository;
          if (args.agents) input.agents = args.agents;
          if (args.operator) input.operator = args.operator;
          if (args.description || args.stages || args.boundaries || args.members) {
            const custom: CustomProjectBlueprint = {};
            if (args.description) custom.description = args.description;
            if (args.stages) custom.stages = args.stages;
            if (args.boundaries) custom.boundaries = args.boundaries;
            if (args.members) custom.members = args.members;
            input.custom = custom;
          }
          const created = await createProject(db, input, actor, {
            dataRoot,
            fetchImpl: ctx.fetchImpl,
          });
          // Ruling 464: the reply lists what was deployed, read off the write.
          const deployed = created.agents
            .map((a) => `${a.name} (${a.profileId}, ${a.model || "default model"}, effort ${a.effort || "default"})`)
            .join("; ");
          return (
            `[done] Project ${created.name} created at ${created.storePath} (slug ${created.slug}, keys ${created.key}-n). ` +
            `You are its admin.` +
            (created.repoNote ? ` ${created.repoNote}` : "") +
            (created.repoWarning ? ` Warning: ${created.repoWarning}` : "") +
            ` Deployed: ${deployed}.`
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
      "One project's live shape: stages with task counts, workflow boundaries, members with roles, deployed agents with their RESOLVED grants (every stored capability id at the mode the runtime applies, model, effort, and the operator's autonomy; ruling 139: read this before update_agent_deployment; a grant carrying `advisory` is PERSONA GUIDANCE, not an authority: nothing enforces it, there is no toggle for it, and `update_agent_deployment` refuses it, so never read one as something the agent may do or as a setting you failed to change, F39-4), epics summary (ruling 503; list_epics and get_epic read them in full), and `rulingsKb`, the knowledge base every run on this project reads (ruling 239), null when none is named; `openProposals`, the knowledge-base corrections agents on its tasks filed under \"Proposed corrections (not binding)\" that nobody has promoted or dismissed yet (ruling 483: each with its id, knowledge base, document, the line it corrects, the correction and the evidence; resolve_kb_proposal closes one when a person asks); and `fileLeases`, which task owns which shared paths until it merges (ruling 245), resolved, so a lease whose holder has finished is NOT listed there but in `spentFileLeases`, which binds nobody and can be cleared (ruling 247); and `gates`, the commands Viberr itself runs on every delivered revision (ruling 482; set with set_project_gates); and `requiredReviewers`, the agent each review stage requires on every task (ruling 178), which never delivers on this project (ruling 556; set_required_reviewers says what that means for a plan). Membership gated.",
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
          // Ruling 178: the reviewers the project REQUIRES per review stage,
          // resolved to the names the acceptance gate prints; set with
          // set_required_reviewers.
          requiredReviewers: resolveRequiredReviewers(fm, dataRoot),
          // Ruling 239: the one KB every run on this project reads, whether or
          // not any profile grants it. Null means the project has named none,
          // and a settled rule has nowhere to live but each task's goal.
          rulingsKb: fm.rulingsKb ?? null,
          // Ruling 483 (F40-59): the knowledge-base corrections agents on this
          // project's tasks proposed and nobody has promoted or dismissed. Read
          // from the documents themselves, where every run reads them.
          openProposals: listProjectKbProposals(db, slug, dataRoot).map((p) => ({
            ...p,
            rulings: p.kb === (fm.rulingsKb ?? null),
          })),
          // Ruling 498: what agents on this project's tasks wrote into a
          // knowledge base, newest first, each with its id for
          // undo_kb_correction and whether a person already undid it.
          kbCorrections: listKbCorrections(db, { projectSlug: slug })
            .slice(0, 20)
            .map((c) => ({
              id: c.id,
              kb: c.kb,
              doc: c.doc,
              rulings: c.rulings,
              replaced: c.replaced,
              text: c.text,
              evidence: c.evidence,
              taskKey: c.taskKey,
              filedBy: c.filedBy,
              at: c.at,
              undone: c.undone,
            })),
          // Ruling 245: who owns which shared paths until they merge. Read here
          // rather than inferred from prose, which is what every agent was doing.
          //
          // Ruling 256 (pass 37, F37-85): RESOLVED, like the gates read it.
          // Ruling 247 made a lease whose holder has finished bind nobody, and
          // applied that at the push and the canonical anchor — not here, the
          // read the controller actually uses. So this reported spent leases as
          // live, and the controller said so out loud: "I cannot tell you from a
          // direct read whether SHOP-11's lease had already self-released when
          // it merged." It could not, because this line handed it the raw list.
          fileLeases: activeFileLeases(slug, dataRoot ? { dataRoot } : {}),
          // Named, not dropped: the declaration was made and is now spent, and
          // somebody may want to clear the row.
          spentFileLeases: staleFileLeases(db, slug, dataRoot ? { dataRoot } : {}),
          // Ruling 482: the commands Viberr itself runs on every delivered
          // revision; set with set_project_gates.
          gates: fm.gates ?? [],
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
              // Ruling 188 (pass 37, F37-3): the stages this profile may work
              // ON THIS BOARD, resolved through the SAME `resolveDeclaredStages`
              // the Agents page, the task page's run control and the dispatch
              // gate use (ruling R14-1: a declared id absent from this board is
              // remapped by structural role, and a declaration that resolves to
              // nothing is unrestricted). The raw declaration rides alongside so
              // a remap is visible rather than silent. Live in pass 37 this read
              // returned the raw ids and the controller reported to its owner
              // that two deployed profiles were "effectively unselectable" while
              // the audit trail showed one of them being selected.
              stages: resolveDeclaredStages(row.stages, project.stages, project.workflow),
              declaredStages: row.stages,
              spanAll: row.spanAll,
              model: row.model,
              modelLabel: row.modelLabel,
              effort: row.effort,
              // Ruling 156: the grants a run on this project MOUNTS (the
              // deployment's own copy), and how that copy differs from the
              // template it came from (null when it does not).
              resources: row.resources,
              templateDrift: row.templateDrift,
              capabilities: row.capabilities.map((c) => {
                const grant: DeployedGrantView = {
                  capabilityId: c.capabilityId,
                  mode: c.mode,
                  // A retired id that is no longer in the catalogue keeps its
                  // id as its label; nothing here assumes the lookup succeeds.
                  label: capabilityById(c.capabilityId)?.label ?? c.capabilityId,
                };
                // F39-4: an ADVISORY row says so, in the reply, next to its
                // mode. Both other renderers of these grants drop advisory
                // rows entirely; this one cannot (they are really in
                // `project.md` and really in the persona matrix), so it marks
                // them instead. No `advisory` key ⇒ a real, enforced,
                // settable grant.
                if (capabilityIsAdvisory(c.capabilityId)) {
                  grant.advisory = ADVISORY_CAPABILITY_NOTE;
                }
                return grant;
              }),
            };
            return row.kind === "operator"
              ? { ...entry, autonomy: row.autonomy ?? "supervised" }
              : entry;
          }),
          // Ruling 503: each epic as `list_epics` reads it.
          epics: listEpics(db, slug).map(epicRow),
        });
      }),
    ),
    "get_project",
  );

  add(
    tool(
      "list_tasks",
      "A project's tasks: key, title, stage, readiness, waiting, owner, priority, the epic each is in (ruling 503), and what each waits on (`waitsOn`, ruling 131). Membership gated. Includes Done; archived only when asked.",
      {
        projectSlug: z.string().optional(),
        stageId: z.string().optional().describe("Filter to one stage."),
        epicId: z
          .string()
          .optional()
          .describe('Filter to one epic (epic-3), or "none" for the tasks in no epic.'),
        includeArchived: z.boolean().optional(),
      },
      runWith((args: { projectSlug?: string; stageId?: string; epicId?: string; includeArchived?: boolean }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's tasks");
        const listOpts: NonNullable<Parameters<typeof listProjectTasks>[2]> = {
          dataRoot,
        };
        if (args.includeArchived) listOpts.includeArchived = true;
        const epicFilter = args.epicId?.trim();
        if (epicFilter) listOpts.epicId = epicFilter.toLowerCase() === "none" ? null : epicFilter;
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
            epic: t.epicId ?? null,
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
      "One task's live state: stage, readiness, goal text, engaged agents, PR state, open packet, its pending schedules (`schedules`, ruling 153), the files deliveries it kept as each was delivered (`deliveries`, ruling 597), plus the newest timeline events. Membership gated. Historical (Done, archived) tasks read the same way.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        events: z
          .number()
          .int()
          .min(1)
          .max(CONTROLLER_EVENTS_MAX)
          .optional()
          .describe(
            `Newest timeline events to include (default ${CONTROLLER_EVENTS_DEFAULT}, max ${CONTROLLER_EVENTS_MAX}). The reply always says how many the timeline HAS, and names this argument when it is showing you fewer.`,
          ),
      },
      runWith((args: { projectSlug?: string; taskKey?: string; events?: number }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
        requireVisible(slug, "read this task");
        const summary = getTaskSummary(db, slug, key);
        if (!summary) throw AppError.notFound(`No task ${key} in ${slug}.`);
        const allEvents = listTaskEvents(db, slug, key);
        const events = allEvents
          .slice(0, args.events ?? CONTROLLER_EVENTS_DEFAULT)
          .map((e) => ({
            at: e.occurredAt,
            type: e.type,
            by: e.actor.kind === "agent" ? `${e.actor.name} (agent)` : e.actor.name,
            title: e.title,
            // Ruling 292: the cut says it is a cut and names the way out. This
            // is ruling 285 for the CONTROLLER, which that ruling gave only to
            // the operator — a rule applied to one actor and not its sibling,
            // which is this pass's own defect shape inside this pass's own fix.
            // It is the sharper case of the two: the operator's cut was 1,500,
            // this one is 700, and the controller is the actor a PERSON asks
            // about an agent's report. `at` above is already the address the
            // reader takes, so nothing needed inventing.
            ...(e.text.length > 700
              ? {
                  text: `${e.text.slice(0, 700)}…`,
                  clipped:
                    "cut at 700 chars - read_timeline_entry with this `at` returns it whole",
                }
              : { text: e.text }),
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
        // Ruling 188 (pass 37, F37-5): `summary.blockReason` is the projected
        // `validation_block_reason`, whose own docstring says every consumer
        // "filters rows on `archived = 0` and on the resolved review stage
        // before it ever looks at this column". The board does exactly that
        // (`boardAcceptRefusal` asks `atAcceptanceBoundary` FIRST); this read
        // did not, so a Design-stage task reported "Required reviewer … has not
        // approved revision …  Run the review at Review, or an admin can
        // force-accept" — a Review-stage sentence recommending an action that
        // makes no sense three stages early. It is replaced by the acceptance
        // gate's OWN verdict, the same `acceptanceRefusalFor` the operator's
        // `notAcceptableReason` carries: every gate included, the stage one
        // among them.
        const { blockReason: _projectedBlockReason, ...task } = summary;
        const hidden = allEvents.length - events.length;
        const olderNote: TimelineWindowNote = {};
        if (hidden > 0) {
          olderNote.timelineOlder =
            `${hidden} older ${hidden === 1 ? "entry is" : "entries are"} not shown, ` +
            `newest first. Pass events up to ${CONTROLLER_EVENTS_MAX} to widen this ` +
            "window, and read_timeline_entry with an `at` for one in full.";
        }
        // Ruling 482: the project's gates as Viberr ran them on the revision
        // under review, in the PR card's own line.
        const gates = projectGatesView(
          readProjectFile({ projectSlug: slug, dataRoot })?.parsed.frontmatter.gates,
          readTaskFile({ projectSlug: slug, taskKey: key, dataRoot })?.parsed.frontmatter ?? {
            workRevision: null,
          },
        );
        return json({
          task: {
            ...task,
            notAcceptableReason: acceptanceRefusalFor(
              { projectSlug: slug, taskKey: key },
              { dataRoot },
            ),
            gates: gates
              ? {
                  line: gates.line,
                  state: gates.state,
                  results: gates.rows,
                  error: gates.error,
                }
              : null,
          },
          // Ruling 503: the epic the task is in, by name.
          epic: summary.epicId
            ? { id: summary.epicId, title: getEpic(db, slug, summary.epicId)?.title ?? null }
            : null,
          schedules,
          // Ruling 597: the files deliveries, as each was delivered, which
          // `read_task_attachment` opens with `delivery`.
          deliveries: listKeptDeliveries(slug, key, dataRoot),
          // Ruling 302, extended to the sibling it was first written without.
          // It fixed the OPERATOR's window and left this one, which is the
          // defect shape ruling 292's own comment had already named inside
          // this pass's own fix. The controller found it the way it finds
          // these: it read "5 of 121 entries on SHOP-36 and 4 of 111 on
          // SHOP-27, and coordinated from them". `eventCount` was there and
          // nothing prompted it to subtract.
          timelineTotal: allEvents.length,
          newestEvents: events,
          ...olderNote,
        });
      }),
    ),
    "get_task",
  );

  // Ruling 293: the EVIDENCE, not only the sentence claiming it. Attachments
  // are where every convention on this instance tells an agent to put its
  // proof, and the actor a person asks "did it actually prove that?" could
  // read the claim and never the file.
  add(
    tool(
      "read_task_attachment",
      "Read ONE of a task's attachments. Attachments are where agents put the PROOF - a mutation run with both vitest outputs, before/after captures, a cold-stack log, a spec written out in full - and where a person puts the INPUT a task works from: an inventory, a spreadsheet, a screenshot. A timeline entry names them under `attachments:` without carrying their contents. Call it before you tell a person a thing was proved, and before you repeat a report's claim about what its own evidence shows. A spreadsheet (.xlsx) comes back as its sheets in CSV, a PDF as its text (`pdftotext -layout`, a form feed between pages), an image (.png .jpg .jpeg .webp .gif) as the picture itself, and any other file whose bytes are text as text, whatever its name (a .tf, a .ps1, a Dockerfile); a binary file (a .docx, a zip) is named and refused rather than guessed at. A read returns one page of up to 32,000 bytes (ruling 624); when it says `truncated`, call again with `offset` set to its `nextOffset` for the next part (ruling 551). With `delivery`, a stamp `get_task` lists under the task's `deliveries`, it reads the file as that delivery held it, not as a rework left it (ruling 597). Read-only, membership gated.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        name: z
          .string()
          .describe("The attachment's file name, exactly as the timeline lists it."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Where to start reading, in characters: the `nextOffset` a truncated read returned. Omit for the start."),
        delivery: z.string().optional().describe(READ_TASK_ATTACHMENT_FIELDS.delivery),
      },
      runWith((args: { projectSlug?: string; taskKey?: string; name: string; offset?: number; delivery?: string }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
        requireVisible(slug, "read this task");
        const delivery = args.delivery?.trim() || undefined;
        const read = readTaskAttachment(slug, key, args.name, dataRoot, args.offset, delivery);
        if (!read && delivery) return keptDeliveryMiss(slug, key, delivery, args.name, dataRoot);
        if (!read) {
          const have = listTaskAttachments(slug, key, dataRoot).map((a) => a.name);
          // Ruling 246's shape: say what this reader IS and what it holds,
          // rather than implying the file was deleted.
          return (
            `[noop] ${key} has no attachment \`${args.name}\`. ` +
            (have.length
              ? `It holds: ${have.join(", ")}.`
              : "It has no attachments at all.")
          );
        }
        if ("unreadable" in read) return `[noop] ${read.unreadable}`;
        if (read.kind === "image") return imageResult(attachmentImageHeader(key, read), read);
        const { kind: _text, ...body } = read;
        return json(body);
      }),
    ),
    "read_task_attachment",
  );

  // Ruling 573: the files a person sends with a message, read the way a
  // task's attachments are. A screenshot of an error or an inventory handed
  // over in the dock was a name in the prompt and nothing the turn could open.
  add(
    tool(
      "read_message_file",
      "Read ONE file the person sent with a message in THIS conversation. Their message names each file it carried (\"A file came with this message: ...\"), and the recent exchange lists what earlier messages carried under `[sent with: ...]`. Read a file before you say what it holds or act on it. A spreadsheet (.xlsx) comes back as its sheets in CSV, a PDF as its text (`pdftotext -layout`, a form feed between pages), an image (.png .jpg .jpeg .webp .gif) as the picture itself, and any other file whose bytes are text as text, whatever its name (a .tf, a .ps1, a Dockerfile); a binary file (a .docx, a zip) is named and refused rather than guessed at. A read returns one page of up to 32,000 bytes (ruling 624); when it says `truncated`, call again with `offset` set to its `nextOffset`. Read-only; this conversation's files only.",
      {
        name: z.string().describe("The file's name, exactly as the message lists it."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Where to start reading, in characters: the `nextOffset` a truncated read returned. Omit for the start."),
      },
      runWith((args: { name: string; offset?: number }) => {
        if (!deps.conversationId) {
          return "[unavailable] This turn answers no conversation, so there are no sent files to read.";
        }
        const file = findMessageFile(db, deps.conversationId, args.name);
        if (!file) {
          const have = listConversationFileNames(db, deps.conversationId);
          return (
            `[noop] No file \`${args.name}\` was sent in this conversation. ` +
            (have.length ? `It holds: ${have.join(", ")}.` : "No file has been sent in it.")
          );
        }
        const read = readAttachmentContent(file.name, file.data, args.offset ?? 0, "in the conversation");
        if ("unreadable" in read) return `[noop] ${read.unreadable}`;
        if (read.kind === "image") {
          const kb = Math.max(1, Math.round(read.bytes / 1024));
          return imageResult(`\`${read.name}\` (${kb} KB, ${read.mimeType}), sent in this conversation. The image follows.`, read);
        }
        const { kind: _text, ...body } = read;
        return json(body);
      }),
    ),
    "read_message_file",
  );

  /**
   * Ruling 299: the controller reads the default branch, the way the operator
   * already could. It writes the architecture, the knowledge bases and the
   * goals every agent is measured against, and it reviews the packets those
   * agents raise -- and it could not open a file in the repository those are
   * all about. It reported the gap from inside a live decision: "verify the
   * claim against the repository yourself is the most-repeated rule in this
   * project's own rulings, and I am structurally unable to follow it."
   */
  add(
    tool(
      "read_default_branch_file",
      "Read one file AS THE PROJECT'S DEFAULT BRANCH HAS IT, out of the project's own git mirror. This is how you check a claim about the repository yourself instead of repeating somebody's read of it: what a goal says a file contains, whether a route or a contract is already there, what a report asserts about the tree. It answers about the DEFAULT branch only, never a task's branch or a pull request's head - `read_pull_request` is the one that reads a PR's changed files. A path that is not on that branch is named and reported ABSENT, which is an answer and not a failure. On a project whose repository has never been cloned here, the FIRST call builds the mirror and can take minutes; every call after it is fast. Read-only, membership gated.",
      {
        projectSlug: z.string().optional(),
        path: z
          .string()
          .describe("Repository-relative file path, e.g. 'docs/guide.md' (no leading slash)."),
        fromLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Ruling 436: the 1-based line to start at (default 1). A file longer than one read comes in pages of whole lines; each page names its lines and the fromLine that continues it, so read on until it says nothing more.",
          ),
      },
      runWith(async (args: { projectSlug?: string; path: string; fromLine?: number }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's repository");
        const project = getProject(db, slug);
        if (!project) throw new NotVisibleError(notVisible(slug));
        if (!project.repo) {
          // A project can exist with no remote at all. Saying which fact is
          // missing beats an empty read that reads like "the file is not
          // there" (ruling 246: existence before type).
          return (
            `[unavailable] ${project.name} has no GitHub repository set, so it has no default ` +
            "branch to read. Set one on the project's GitHub tab first."
          );
        }
        const request: Parameters<typeof readProjectDefaultBranchFile>[1] = {
          projectSlug: slug,
          repo: project.repo,
          defaultBranch: project.defaultBranch,
          path: args.path,
        };
        if (args.fromLine !== undefined) request.fromLine = args.fromLine;
        if (dataRoot) request.dataRoot = dataRoot;
        const read = await readProjectDefaultBranchFile(db, request);
        recordAudit(db, {
          action: "controller.repo.read",
          actor,
          subjectKind: "project",
          subjectId: slug,
          projectSlug: slug,
          details: { path: args.path, branch: project.defaultBranch, result: read.kind },
        });
        if (read.kind === "absent") {
          return `[absent] \`${args.path}\` does NOT exist on \`${project.defaultBranch}\`.`;
        }
        if (read.kind === "unavailable") {
          // Ruling 251: a refusal that names no way out is the defect. This one
          // says which branch it could not reach and why, so the answer is
          // never "I read something else instead".
          return (
            `[unavailable] \`${args.path}\` could not be read from \`${project.defaultBranch}\`: ` +
            `${read.reason}. Say so rather than answering from a task's workspace or a PR head, ` +
            "which are not this branch."
          );
        }
        const freshness = read.refreshed
          ? `\`${project.defaultBranch}\`, just refreshed from GitHub`
          : `\`${project.defaultBranch}\` as the project's mirror last had it (the refresh from ` +
            "GitHub did not run, so treat it as slightly stale)";
        // Ruling 285: a cut says it cut, and says where the rest is. Ruling
        // 436: the rest is the next page, named by the line it starts at.
        const page = defaultBranchPageNote(read);
        return `[found] \`${args.path}\` on ${freshness}${page.range}:\n\n${read.text}${page.note}`;
      }),
    ),
    "read_default_branch_file",
  );

  // Ruling 292: the controller reads a timeline entry whole, exactly as the
  // operator has since ruling 285. Project-scoped and membership gated like
  // every other task read here; `read_run_log` is the RUN's log, which is a
  // different thing from what an agent chose to report on the task.
  add(
    tool(
      "read_timeline_entry",
      "Read ONE timeline entry of a task in full, addressed by the `at` stamp `get_task` prints for it. `get_task` cuts every entry at 700 characters; this is how you read the rest. Call it before you summarise an agent's report for a person, before you raise anything that turns on what a report said, and before you conclude a report did not mention something - findings are routinely past the cut, and a report you only half-read is one you cannot coordinate from. Entries written in the same millisecond (a verdict's report and its quality marker) come back together, under `entries`, in the order they were written. A knowledge-base correction's entry comes back with the correction whole, under `correction`: the passage it replaced, the text it wrote, its evidence, and whether a person undid it. Read-only.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        at: z
          .string()
          .describe("The entry's `at` stamp, exactly as get_task prints it (ISO, to the millisecond)."),
      },
      runWith(async (args: { projectSlug?: string; taskKey?: string; at: string }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
        requireVisible(slug, "read this task");
        // Ruling 648: an org admin reads every knowledge base (the Controller
        // page shows each correction whole), so its corrections read whole.
        return await readTimelineEntry(
          { db, ctx: { dataRoot }, projectSlug: slug, readerKbs: orgAdmin() ? "all" : [] },
          key,
          args.at,
        );
      }),
    ),
    "read_timeline_entry",
  );

  add(
    tool(
      "create_task",
      "Create a task at the project's entry stage (every task passes the triage gate). Contributor or above. `priority: urgent` IS the urgent flag (urgent is derived from priority, never a second input). Ruling 140: `owner` seats a member as owner in the same write that creates the task, BEFORE the first operator run, so that run bills the named owner; omit it to seat yourself. Use set_task_owner afterwards to release a seat; `none` is refused here.",
      {
        projectSlug: z.string().optional(),
        title: z.string(),
        // Ruling 492: every door that writes a goal says what a done signal can be.
        goal: z
          .string()
          .optional()
          .describe("The task text: deliverable plus the done signal. " + DONE_SIGNAL_RULE),
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
          .describe("Ruling 131: what the new task waits on (task keys like JC-6, in this project). The task is born held and released by Viberr when every entry is done."),
        epic: z
          .string()
          .optional()
          .describe("Ruling 503: the epic the new task joins (epic-3, from list_epics). Omit for none."),
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
          epic?: string;
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
          if (args.epic?.trim()) taskInput.epic = args.epic.trim();
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
          const inEpic = created.task.epicId ? ` In ${created.task.epicId}.` : "";
          return `[done] ${created.key} created in ${created.stageName}: ${created.task.title}.${seated}${inEpic}${wait}`;
        },
      ),
    ),
    "create_task",
  );

  add(
    tool(
      "move_task",
      "Move a task to another stage. Workflow boundaries and your project role decide; a move into the final Done stage is refused here, because acceptance is decided on the task page with its own confirmation. A move to an EARLIER stage requires `reason` (ruling 381).",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        toStageId: z.string().describe("Target stage id (from get_project)."),
        reason: z
          .string()
          .optional()
          .describe(
            "Required for a move BACKWARD (ruling 381): what should change before the task comes back. It lands on the transition entry and the operator acts on it.",
          ),
      },
      runWith(async (args: { projectSlug?: string; taskKey?: string; toStageId: string; reason?: string }) => {
        const slug = slugOf(args.projectSlug);
        const key = keyOf(args.taskKey, slug);
        requireVisible(slug, "move tasks");
        const project = getProject(db, slug);
        if (!project) throw new NotVisibleError(notVisible(slug));
        const terminal = project.stages[project.stages.length - 1];
        if (terminal && args.toStageId === terminal.id) {
          // Ruling 246 (F37-75): name the door AND say whether it is open. The
          // refusal used to point at the task page and stop, so a person sent
          // there on a task still waiting for a reviewer followed a correct
          // pointer to a control that would refuse them. The gate's own sentence
          // is already computed; carrying it costs one read.
          const why = acceptanceRefusalFor({ projectSlug: slug, taskKey: key }, { dataRoot });
          return (
            `[denied] Moving ${key} into ${terminal.name} means accepting its completion, ` +
            `which carries its own confirmation and merge consequences. Decide it on the task page: ` +
            `projects/${slug}/tasks/${key}.` +
            (why ? ` Not acceptable yet, though: ${why}` : "")
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
        // Ruling 381: the same sentence the board's dialog collects. The
        // controller is a door onto the same act, so it asks the same thing —
        // and `transitionStage` refuses the move without it rather than
        // trusting the caller to have read the schema.
        if (args.reason?.trim()) move.reason = args.reason.trim();
        const moved = await transitionStage(db, move, actor, { dataRoot });
        return `[done] ${key} is now in stage ${moved.stage}.`;
      }),
    ),
    "move_task",
  );

  add(
    tool(
      "comment_on_task",
      "Post a controller comment on a task's timeline: publish information for the PEOPLE reading it. @mentions of people notify them. An @mention of an AGENT reaches nobody - a comment starts no run, and the line is stamped saying so (ruling 252); a later run reads it only if it happens to read the timeline. To put something to an agent, use run_agent_on_task.",
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
      "Edit a task's goal text, its metadata (priority, labels, due date), what it waits on (blockedBy, ruling 131: the full list; [] clears it and RELEASES the task) and/or the epic it is in (ruling 503). The same writers the task page uses, behind the same gates: the goal needs maintainer or above; metadata, the wait and the epic need the project's edit-task-meta grant. Metadata fields you pass are a full replace (an empty labels list clears them; dueDate \"\" clears the date). Ruling 295: `title` is editable too, behind the goal's own gate, because a title and a goal are the same claim at two lengths and the shorter one should not be the harder to correct; the rename is noted with BOTH titles, since the old wording is what every existing reference to this task says. Never edits the stage, owner or engaged agents.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        title: z
          .string()
          .optional()
          .describe(
            "A corrected title. This is the line every person scanning the board reads, so correct it when the goal's own evidence has outrun it rather than leaving the correction in a body nobody opens.",
          ),
        goal: z
          .string()
          .optional()
          .describe("The new goal text (deliverable plus the done signal). " + DONE_SIGNAL_RULE),
        priority: z.enum(PRIORITY_VALUES).optional(),
        labels: z.array(z.string()).optional().describe("The full label set; [] clears it."),
        dueDate: z.string().optional().describe("ISO date (YYYY-MM-DD), or \"\" to clear."),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe("The FULL list of what the task waits on (task keys like JC-6); [] clears it and releases the task."),
        epic: z
          .string()
          .optional()
          .describe(
            'Ruling 503: the epic the task belongs to (epic-3), or "" to take it out of its epic. A task is in at most one epic, so naming another moves it there.',
          ),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          taskKey?: string;
          title?: string;
          goal?: string;
          priority?: (typeof PRIORITY_VALUES)[number];
          labels?: string[];
          dueDate?: string;
          blockedBy?: string[];
          epic?: string;
        }) => {
          const slug = slugOf(args.projectSlug);
          const key = keyOf(args.taskKey, slug);
          requireVisible(slug, "edit this task");
          const hasMeta =
            args.priority !== undefined || args.labels !== undefined || args.dueDate !== undefined;
          const hasWait = args.blockedBy !== undefined;
          const hasEpic = args.epic !== undefined;
          if (args.title === undefined && args.goal === undefined && !hasMeta && !hasWait && !hasEpic) {
            throw AppError.validation(
              "Pass a title and/or a goal and/or at least one metadata field (priority, labels, dueDate, blockedBy, epic).",
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
          // Ruling 295: its own axis, reported on its own, exactly like the
          // goal and the metadata beside it — a title that wrote must not be
          // hidden behind a goal that was refused, or the reverse.
          if (args.title !== undefined) {
            try {
              const { changed } = await updateTaskTitle(
                db,
                { projectSlug: slug, taskKey: key, title: prose(args.title) },
                actor,
                { dataRoot },
              );
              if (changed) applied.push("title");
              else unchanged.push("title");
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              firstError ??= error;
              refused.push(`title: ${error.userMessage}`);
            }
          }
          if (args.goal !== undefined) {
            try {
              const { changed } = await updateTaskGoal(
                db,
                { projectSlug: slug, taskKey: key, goal: prose(args.goal) },
                actor,
                { dataRoot },
              );
              if (changed) applied.push("goal");
              else unchanged.push("goal");
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
              else if (wait.released) {
                applied.push(`blocked by (${wait.blockedBy.join(", ")}: every entry is done, so the task is released)`);
              } else applied.push(`blocked by (${wait.blockedBy.join(", ")})`);
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              firstError ??= error;
              refused.push(`blocked by: ${error.userMessage}`);
            }
          }
          // Ruling 503: the epic is its own axis too, through the one writer of
          // a task's `epic`.
          if (hasEpic) {
            const target = args.epic?.trim() || null;
            try {
              const moved = await setTasksEpic(
                db,
                { projectSlug: slug, taskKeys: [key], epicId: target },
                actor,
                { dataRoot },
              );
              if (moved.changed.length === 0) unchanged.push("epic");
              else applied.push(target ? `epic (${target})` : "epic (taken out)");
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
              firstError ??= error;
              refused.push(`epic: ${error.userMessage}`);
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
      "Put an agent to work on a task with a directive: the operator (coordination) or a deployed agent profile (stage work). Maintainer or above. The result reports honestly whether a run started, was queued behind the concurrent-run cap, was refused before any process existed, or waits because the agent is already running here (the directive is then delivered when that run finishes). The directive is also written on the task timeline as a comment addressed to the agent, so the people watching the task can read what it was asked to do.",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        agent: z
          .string()
          .describe('"operator", or a deployed profile id from get_project.'),
        prompt: z.string().optional().describe("The directive: what to do for this task."),
        noVerdict: z
          .boolean()
          .optional()
          .describe(
            "Ruling 583: for a deployed agent, true whenever this run must not judge: a verdict-capable agent run for its knowledge-base corrections or its files on a task a person closes by force-accept, or a question put before any verdict. Viberr withholds its verdict and reads nothing it writes as one. The operator never judges, so it ignores this.",
          ),
      },
      runWith(
        async (args: { projectSlug?: string; taskKey?: string; agent: string; prompt?: string; noVerdict?: boolean }) => {
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
              actor,
            };
            if (args.prompt) {
              operatorInput.humanComment = prose(args.prompt);
              operatorInput.humanCommentBy = display;
            }
            if (dataRoot) operatorInput.dataRoot = dataRoot;
            const result = await runOperator(db, operatorInput);
            if (result.refused === "open-packet") {
              // Ruling 251: a refusal that names no way out is the defect this
              // pass keeps finding. `list_decisions` reads the packet's own
              // options and the link that opens it.
              return (
                `[denied] The operator is not run while a decision packet is open on ${key}. ` +
                `Answer it first: call list_decisions for its options, then open ` +
                `projects/${slug}/tasks/${key}.`
              );
            }
            if (result.refused === "closed") {
              return `[denied] ${result.refusalReason ?? `${key} is closed`} There is nothing for the operator to coordinate on a closed task.`;
            }
            // Ruling 272: every OTHER refusal, named rather than fallen
            // through. The two arms above cover the two a manual trigger can
            // produce today; `blocked-by` is refused only for create,
            // transition and scheduled triggers (ruling 131(d)), so it cannot
            // reach here now. A third value added later must not arrive as
            // `[done] Operator run started` — which is exactly the sentence
            // ruling 263 exists to stop, and the one this arm would print.
            if (result.refused) {
              return (
                `[refused] The operator did not start on ${key}: ` +
                `${result.refusalReason ?? `the run was refused (${result.refused})`}`
              );
            }
            // Ruling 272 (F37-105): ruling 263 put R21-9's law on the
            // SPECIALIST arm and returned above it for the operator, so the
            // one dispatch door that still sent a human's words off the record
            // was the operator half of the door ruling 263 had just fixed.
            // Measured by the controller three minutes after the deploy, by
            // counting the task's own comments across two reads: "my directive
            // is nowhere in the +1". The task page's Run-operator control has
            // written this comment since 2026-08-21, for the reason its own
            // note gives — a directive that reaches an agent off the record is
            // invisible to supervision — and passes `humanComment` as well, as
            // this arm does. Written only when the run was NOT refused, like
            // the task page: a refused run would strand a comment with nothing
            // to address it.
            if (args.prompt) {
              await appendComment(
                db,
                {
                  projectSlug: slug,
                  taskKey: key,
                  text: `@operator ${prose(args.prompt)}`,
                  forceToAgent: true,
                },
                actor,
                { dataRoot },
              );
            }
            if (result.queued) {
              return `[done] The operator is already working ${key}; your directive was queued for it.`;
            }
            return `[done] Operator run started on ${key}.`;
          }
          const {
            directiveDeferredNote,
            isAgentBusy,
            isDispatchHeld,
            listDeployedSpecialists,
            startAgentRun,
          } = await import("~/server/tasks/specialist-run.server");
          const profileId = args.agent.trim();
          const runInput: StartAgentRunInput = {
            projectSlug: slug,
            taskKey: key,
            profileId,
            triggeredByName: display,
            triggeredByUserId: user.id,
          };
          if (args.prompt) {
            runInput.directive = prose(args.prompt);
            runInput.directiveFrom = display;
          }
          // Ruling 583, amended: the controller dispatches a run that must not
          // judge the way the operator's `run_agent` does. On AWSC-25 it had
          // to ask the operator to do it for it.
          if (args.noVerdict) runInput.withholdVerdict = true;
          // Ruling 263 (F37-93), second half: R21-9's law applied to the
          // dispatch prompt, on the one door that skipped it. Through the
          // controller the words went into the prompt and NOWHERE else: the
          // timeline showed a run appearing for no stated reason, and the
          // person who asked for it could not see what they had asked for. So
          // `@<agent> <prompt>` is written as that person's own comment,
          // addressed to the agent, as the task page and the operator's
          // `run_agent` write it. BEFORE the start (ruling 375): ruling 203's
          // redelivery window is "a human comment addressed to this agent,
          // posted after this run started", and this comment used to be
          // written after the start, so every prompted dispatch through the
          // controller ran twice — the run, then the same words redelivered
          // the moment it finished. Recorded first, it predates the run it is
          // the directive of. A start that throws leaves the words on the
          // record with the person's note of why nothing ran beside them.
          const handle =
            listDeployedSpecialists(slug, { dataRoot }).find((s) => s.id === profileId)
              ?.name ?? profileId;
          if (args.prompt) {
            await appendComment(
              db,
              {
                projectSlug: slug,
                taskKey: key,
                text: `@${handle} ${prose(args.prompt)}`,
                forceToAgent: true,
              },
              actor,
              { dataRoot },
            );
          }
          let started: Awaited<ReturnType<typeof startAgentRun>>;
          try {
            started = await startAgentRun(db, runInput, actor, { dataRoot });
          } catch (error) {
            // Ruling 452: refused because this agent is already running, the
            // directive recorded above sits inside that run's window, and
            // ruling 203 delivers it when the run finishes. Said here, where
            // "wait for it to finish … before starting another" sent the caller
            // back to deliver the same words a second time.
            if (args.prompt && isAgentBusy(error) && error.busyProfileId === profileId) {
              await appendComment(
                db,
                { projectSlug: slug, taskKey: key, text: directiveDeferredNote(handle) },
                actor,
                { dataRoot },
              );
              return (
                `[done] ${handle} is already running on ${key}, so no second run started. ` +
                `Your directive is on the timeline and is delivered to ${handle} when that run finishes; do not send it again.`
              );
            }
            // Ruling 152(c): a hold is not a refusal. The retry is already
            // scheduled with the directive on it, and the recorded comment
            // predates that later run too.
            if (args.prompt && !isDispatchHeld(error)) {
              const message = errorMessage(error);
              await appendComment(
                db,
                {
                  projectSlug: slug,
                  taskKey: key,
                  text: `No run started for ${handle}: ${message}`,
                },
                actor,
                { dataRoot },
              );
            }
            throw error;
          }
          // Ruling 263, first half: this tool's own description promises it
          // "reports honestly whether a run started". A refused run is a row
          // recording why no process will exist; a queued one is parked behind
          // the concurrency cap. Neither had a sentence of its own.
          if (started.outcome === "refused") {
            return (
              `[refused] ${started.name}'s run on ${key} did not start: ` +
              `${started.refusal ?? "the run was refused before any process started."} ` +
              `${args.prompt ? "The directive is on the timeline. " : ""}` +
              `Run it again once that is resolved.`
            );
          }
          if (started.outcome === "queued") {
            return (
              `[done] ${started.name} is queued on ${key} (${started.backend}): ` +
              `the instance is at its concurrent-run cap, so it starts when a slot frees. ` +
              `get_task shows it as queued until then.`
            );
          }
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
          .describe(`Minutes from now (1 to ${SCHEDULE_MAX_MINUTES}). Give this or dueAt.`),
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
          // `schedule-action`), shared with the operator's door (ruling 487).
          const dueMs = scheduleDueMs(args);
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
          const sched = await scheduleTaskAction(db, schedInput, actor, {
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
            actor,
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
      "The project's GitHub view: connection and credential health, task branches with sync state, pull requests with checks/review/mergeability, and how fresh the cache is. A PR's `checks` is null in three different cases: `checksRead` true with a null `checks` means GitHub reported NO check runs (no CI configured, or none has reported); `checksRead` false with a `checksUnread` object means GitHub REFUSED the read (its status and message are there, and `at` is when that refusal was first seen, not the last check; a 403 is the credential lacking Checks: read); `checksRead` false with `checksUnread` null means nobody has looked yet. `review` is GitHub's own review verdict, which is null on a repository where humans do not review there - viberr's own reviewer verdicts live on the task, not here. Membership gated. Read-only; Update status lives on the GitHub page.",
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
          // Ruling 468: say it, so nobody is asked to push a first commit.
          // Null when the repository has commits (or its state is unknown).
          // Its dated note (R-repo-2): a token that can only read gets that
          // commit refused, so the line names the token instead.
          contents:
            data.connection.status === "connected" && data.connection.empty
              ? data.connection.readOnly
                ? `empty, and this token can only read it: viberr cannot create the first commit on ${data.project.defaultBranch} until the token is granted write access (the fix is the token, not a pushed commit)`
                : `empty: viberr will create the first commit on ${data.project.defaultBranch} before the first task branch`
              : null,
          reconcile: data.reconcile,
          prs: data.prs.map((p) => ({
            task: p.taskKey,
            number: p.number,
            state: p.state,
            title: p.title,
            checks: p.checks,
            // Ruling 276 (F37-109): a null `checks` is TWO different facts and
            // the task file keeps them apart — an absent key is "never read",
            // a present one with `total: 0` is "GitHub reported no check runs".
            // `mapPrChecks` collapses both because a display has nothing to
            // draw either way, and every reader inherited that collapse. Live,
            // the controller read `checks: null` on all 30 PRs, could not tell
            // which it was, reconstructed review state from task timelines
            // instead, and learned only from prose an operator had written into
            // a task goal that this account's Actions are billing-blocked.
            // "No CI is configured" and "we have not looked" ask for opposite
            // next moves.
            checksRead: p.checksRead,
            // Ruling 360 (F38-14): the THIRD case — the read was made and GitHub
            // refused it. Ruling 276's own note says the controller learned that
            // this account's Actions were billing-blocked "only from prose an
            // operator had written"; it was never told the read itself failed.
            checksUnread: p.checksUnread ?? null,
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
      "read_pull_request",
      "What a task's review pull request CHANGED: every changed file with its status, its added/deleted counts, and its unified-diff hunks. Membership gated, read-only, one GitHub read. Use it to judge a delivery yourself instead of from a filename list - a reviewer's verdict says what an agent concluded, this says what is in the branch. On a PR of any size, START with `patches: false`: that lists every changed file with its counts and no hunks, so the first call is always small, and `path` then reads one file's hunks in full. Asking for every patch at once is bounded by a byte budget - the reply still lists every file and flags each one whose patch was withheld (`patchOmitted`), so nothing is dropped silently. `prNumber` overrides the task's own PR (it must belong to this project's repository).",
      {
        projectSlug: z.string().optional(),
        taskKey: z.string().optional().describe("Defaults to this conversation's task."),
        prNumber: z
          .number()
          .int()
          .optional()
          .describe("A PR in this project's repository; omit to read the task's own."),
        path: z
          .string()
          .optional()
          .describe("Read only this file's hunks (the path as the PR lists it)."),
        patches: z
          .boolean()
          .optional()
          .describe(
            "false lists the changed files with their counts and NO hunks - the safe first call on a PR whose size you do not know.",
          ),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          taskKey?: string;
          prNumber?: number;
          path?: string;
          patches?: boolean;
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "read this project's pull requests");
          let number = args.prNumber ?? null;
          let from = `#${number ?? 0}`;
          if (number === null) {
            const key = keyOf(args.taskKey, slug);
            const file = readTaskFile({ projectSlug: slug, taskKey: key, dataRoot });
            if (!file) throw AppError.notFound(`No task ${key} in ${slug}.`);
            const departure = revisionLeftWorkspace(file.parsed.frontmatter);
            if (!departure || departure.kind === "pushed") {
              // Say which of the two it is: a task that never opened a PR and
              // one whose branch is pushed but unreviewed need different moves.
              return (
                `[noop] ${key} has no pull request to read` +
                `${departure ? " yet: its branch is pushed but no PR is open" : ""}. ` +
                `Name prNumber to read another PR in this repository.`
              );
            }
            number = departure.number;
            from = `${key} (#${number})`;
          }
          const { readPullRequestDiff } = await import(
            "~/server/github/pr-diff.server"
          );
          const diffOpts: Parameters<typeof readPullRequestDiff>[3] = {};
          if (args.path) diffOpts.path = args.path;
          if (args.patches === false) diffOpts.patches = false;
          const result = await readPullRequestDiff(db, slug, number, diffOpts);
          if (!result.ok) return `[error] Could not read ${from}: ${result.reason}`;
          if (args.path && result.files.length === 0) {
            // An empty file list under a path filter means the PR does not
            // touch it — which is an ANSWER, and a different one from "the PR
            // changed nothing".
            return `[noop] PR #${number} does not change \`${args.path}\`.`;
          }
          // Ruling 266: this is the only controller tool that reads OUTSIDE
          // the instance on somebody's behalf — the request is made by the
          // server with the project's sealed credential, exactly the class
          // E32-5 made auditable in `viberr_ops`. "Who read which pull request
          // through the controller" has to be answerable from the trail.
          recordAudit(db, {
            action: "controller.github.read",
            actor,
            subjectKind: "project",
            subjectId: slug,
            projectSlug: slug,
            details: { pr: number, files: result.files.length },
          });
          return json({
            repo: result.repo,
            number: result.number,
            files: result.files,
            moreFiles: result.moreFiles,
            patchesWithheldForSize: result.truncated,
          });
        },
      ),
    ),
    "read_pull_request",
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
      "set_required_reviewers",
      "Declare the project's REQUIRED reviewers per review stage (ruling 178): the WHOLE list, replacing what project.md holds; `rules: []` clears it. Each rule names a non-terminal stage id and the profile id of a deployed agent that can report a validation verdict; get_project lists both (`stages`, `agents[].capabilities`) and the current rules (`requiredReviewers`). An unknown stage or profile, the terminal stage, or an agent without report-validation-verdict is refused by name with nothing written. While a rule stands, no task is acceptable until that agent holds an approve verdict on the delivered revision, engaged or not: the acceptance gate, the review queue and the operator's get_task read the same rule, so declare it here instead of asking the operator to remember. Ruling 556: the agent a rule names never delivers on this project, because its verdict on its own work would not count, so Viberr refuses to make it any task's deliverer. Work only that agent can do, such as correcting a knowledge base only it is granted, runs it as a supporting agent, and the task closes when a project admin force-accepts it. Write such a task's goal, and what you tell people about it, that way. Project admin (edit-policy).",
      {
        projectSlug: z.string().optional(),
        rules: z
          .array(z.strictObject({ stageId: z.string(), profileId: z.string() }))
          .describe("The full list; [] clears every rule."),
      },
      runWith(
        async (args: { projectSlug?: string; rules: { stageId: string; profileId: string }[] }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "edit this project's policy");
          const result = await setRequiredReviewers(
            db,
            { projectSlug: slug, rules: args.rules },
            actor,
            { dataRoot },
          );
          return result.changed ? `[done] ${result.toast}.` : `[noop] ${result.toast}; nothing was written.`;
        },
      ),
    ),
    "set_required_reviewers",
  );

  add(
    tool(
      "set_project_rulings_kb",
      "Name the project's RULINGS knowledge base by store DIRECTORY (ruling 239), or pass dir: null to clear it. Project admin (edit-policy). Unlike a per-profile `kbs` grant, this one KB is injected into EVERY run the project makes (each specialist, the operator, and your own conversation while it is scoped to this project), so nobody can forget it on the one profile that needed it. Use it for rules the project has SETTLED and should not re-litigate: a convention a review established, a shared-surface protocol, an environment fact reviewers keep re-deriving. `list_knowledge_bases` gives the grantKey to pass here; a directory no knowledge base occupies is refused by name with nothing written. Promoting an existing KB into this role is the expected move, and a profile that also grants it explicitly is not charged for it twice.",
      {
        projectSlug: z.string().optional(),
        dir: z
          .string()
          .nullable()
          .describe("The KB store directory (list_knowledge_bases `grantKey`), or null to clear."),
      },
      runWith(async (args: { projectSlug?: string; dir: string | null }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "change this project's policy");
        const result = await setProjectRulingsKb(
          db,
          { projectSlug: slug, dir: args.dir },
          actor,
          { dataRoot },
        );
        return `[done] ${result.toast}.`;
      }),
    ),
    "set_project_rulings_kb",
  );

  add(
    tool(
      "set_file_leases",
      "Ruling 245: declare which TASK owns which shared paths until it merges, or pass an empty list to clear. Project admin (edit-policy). This is the ordering statement `blockedBy` cannot make: `blockedBy` says \"do not START until done\", a lease says \"both may proceed, this one owns `pnpm-lock.yaml` until it lands\". Enforced at DELIVERY: another task whose BRANCH changes a leased path (measured from where it forked off the default branch, so a change pushed before the lease existed still counts) is refused by name, before anything reaches GitHub (ruling 353). The merge itself reads no lease. Globs: `*` matches within one segment, `**` spans segments and covers the directory itself. The whole list is replaced by what you pass, and operators lease files to their own tasks too (ruling 417), so read `fileLeases` from get_project first and pass every lease you mean to keep. A lease naming a task this project does not have is refused, and so are two leases held by different unfinished tasks whose globs can match one file (ruling 417: each would refuse the other's delivery, so neither could land).",
      {
        projectSlug: z.string().optional(),
        leases: z
          .array(
            z.strictObject({
              paths: z.array(z.string()).describe("Globs, e.g. [\"pnpm-lock.yaml\"] or [\"make/**\"]."),
              taskKey: z.string().describe("The one task that owns them until it merges."),
              reason: z.string().describe("Why, in one line. It is quoted in every refusal."),
            }),
          )
          .describe("The COMPLETE lease list; [] clears every lease."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          leases: { paths: string[]; taskKey: string; reason: string }[];
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "change this project's policy");
          const result = await setProjectFileLeases(
            db,
            { projectSlug: slug, leases: args.leases },
            actor,
            { dataRoot },
          );
          return `[done] ${result.toast}.`;
        },
      ),
    ),
    "set_file_leases",
  );

  add(
    tool(
      "set_project_gates",
      "Ruling 482: declare the project's GATES, the commands VIBERR ITSELF runs on every delivered revision, or pass [] to clear them. Project admin (edit-policy). The WHOLE list, in run order, replacing what project.md holds; read `gates` from get_project first. Each gate is `{name, command, timeoutSeconds?}` (a short unique name, a command run with `sh -c` in the checkout's root, and a timeout of 1 to 3600 seconds, 600 when omitted); at most 10. Viberr runs them itself, in a fresh checkout of the exact delivered revision, as the task owner's own agent user with no credentials, and records each exit code, wall time and log on the task: the PR card and the accept dialog print \"Gates on <sha>: N/M exit 0 (run by Viberr)\". A plain acceptance is refused until every gate exited 0 on the revision under review (force accept stays, on the record), and a failing gate hands the rework to the operator. This is where a MEASURED gate set belongs once a task has proven it on this host (`instance_health` and a task's run show what the host has): promote it here rather than writing the commands into the rulings knowledge base as prose, which every directive then re-types and no one can check. A changed list queues the gates on every open task that already has a delivered revision; an unchanged one answers `[noop]`. A duplicate or empty name, an empty command, or a timeout out of range is refused by name with nothing written.",
      {
        projectSlug: z.string().optional(),
        gates: z
          .array(
            z.strictObject({
              name: z.string().describe("Short and unique, e.g. \"build\"."),
              command: z.string().describe("Run with `sh -c` in the checkout's root, e.g. \"pnpm build\"."),
              timeoutSeconds: z
                .number()
                .int()
                .optional()
                .describe("1 to 3600; 600 when omitted."),
            }),
          )
          .describe("The COMPLETE gate list, in run order; [] clears it."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          gates: { name: string; command: string; timeoutSeconds?: number }[];
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "change this project's policy");
          const result = await setProjectGates(
            db,
            { projectSlug: slug, gates: args.gates },
            actor,
            { dataRoot },
          );
          return result.changed ? `[done] ${result.toast}.` : `[noop] ${result.toast}; nothing was written.`;
        },
      ),
    ),
    "set_project_gates",
  );

  add(
    tool(
      "update_stages",
      "Edit the project's stage list: add (inserted before the final stage), rename, recolor (one of the twenty presets), remove, or reorder. Project admin. The workflow chain follows automatically; removing a stage never loosens a boundary.",
      {
        projectSlug: z.string().optional(),
        op: z.enum(["add", "rename", "recolor", "remove", "reorder"]),
        stageId: z.string().optional().describe("rename/recolor/remove: the stage id."),
        color: z
          .enum(STAGE_COLORS)
          .optional()
          .describe(`recolor: the preset (${STAGE_COLOR_LIST}).`),
        name: z.string().optional().describe("add/rename: the stage name."),
        orderedIds: z.array(z.string()).optional().describe("reorder: every stage id, new order."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          op: "add" | "rename" | "recolor" | "remove" | "reorder";
          stageId?: string;
          name?: string;
          color?: StageColor;
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
          if (args.op === "recolor") {
            if (!args.stageId || !args.color) {
              throw AppError.validation("Recolouring needs stageId and color.");
            }
            const recoloured = await recolorStage(
              db,
              { projectSlug: slug, stageId: args.stageId, color: args.color },
              actor,
              { dataRoot },
            );
            return `[done] ${recoloured.toast}.`;
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
      "Add a member to the project by email (an unknown email gets a new account with a one-time temporary password you must relay). Project admin. C4: `role` seats them in ONE write; members join as viewer unless you give one, and an unknown role is refused by name with nothing written.",
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
      "Deploy a global agent template into the project (from list_global_agents). Project admin. remove_agent_deployment takes a deployment off again, the same removal as Delete on the project's Agents page (the Operator is a system profile and is never removable); use it rather than neutering a live deployment's grants, which leaves it selectable and is a workaround, not a removal. A deploy COPIES the template's own capability grants, so whether the profile can write the repo depends on the template: the reply says which, read off what was written. Ruling 139: `model` and `effort` override the template's defaults and are checked by name against the template's primary backend before the write (an unknown tier is refused, never clamped); omit them to keep the template's own model and effort (ruling 153; the backend's default stands in only when the template names none, or names a tier this backend does not offer). The reply states what was stored.",
      {
        projectSlug: z.string().optional(),
        profileId: z.string(),
        model: z.string().optional().describe("Model id for the template's backend (see the profile's backend in list_global_agents)."),
        effort: z
          .string()
          .optional()
          .describe(`Effort tier the backend offers: ${EFFORT_TIERS_SENTENCE}.`),
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
          ? ` Runs on ${BACKEND_LABEL[result.applied.backend]} with model ${result.applied.model} at effort ${result.applied.effort}.`
          : "";
        // Ruling 264 (F37-94): this used to promise "Delivery starts withheld"
        // on every deploy. Ruling 156 made a library deploy COPY the template's
        // grants, so a repo-write template deploys able to deliver and the
        // reply said the opposite — to the one reader whose next decision
        // (engage it as the deliverer, or not) turns on the answer. The fact
        // now comes from the grants that were written, through the predicate
        // the RUN is gated on.
        const delivery =
          result.delivery === "granted"
            ? " It carries repo write from the template, so it can deliver as soon as it is engaged. Withhold that with update_agent_deployment if this project should not let it."
            : " Delivery starts withheld; open it up with update_agent_deployment when the profile should write the repo.";
        return `[done] ${result.name} deployed on ${slug}.${stored}${delivery}`;
      }),
    ),
    "deploy_agent",
  );

  add(
    tool(
      "update_agent_deployment",
      "Update one deployed agent's project configuration: capability modes (direct, recommend for the operator, human, off), backend, model, effort, eligible stages, operator autonomy, the deployment's own resource grants (skills, mcps, kbs; every kind, the operator included), or its persona (ruling 467: the deployment's own system-prompt text, which a template edit does not reach). Project admin. Merge semantics: only the fields you pass change; an omitted grant list is left alone and [] clears it. Ruling 139: every catalogued value is checked BEFORE anything is written and an unknown or impossible one is refused by name with nothing written: a capability id must be one the deployment's KIND takes (read list_capabilities first; get_project shows the deployment's resolved grants and resources), a specialist takes no recommend, an always-human id takes only human, report-validation-verdict takes only direct or off, matrix-only advisory ids have no toggle, every stage id must be one of the project's stages, and every grant is a grantKey the store answers to (from list_skills, list_mcp_servers, list_knowledge_bases; never an id). The reply lists every field the call changed, old → new; a call that changes nothing says so.",
      {
        projectSlug: z.string().optional(),
        profileId: z.string(),
        capabilities: z
          .array(z.strictObject({ capabilityId: z.string(), mode: z.enum(["direct", "recommend", "human", "off"]) }))
          .optional(),
        backend: z.enum(["claude", "codex"]).optional(),
        model: z.string().optional(),
        effort: z
          .string()
          .optional()
          .describe(
            `Effort tier the deployment's backend offers (${EFFORT_TIERS_SENTENCE}); refused by name otherwise. A backend switch with no effort resets to that backend's default.`,
          ),
        stages: z.array(z.string()).optional(),
        autonomy: z.enum(["supervised", "full"]).optional().describe("Operator only."),
        persona: z
          .string()
          .optional()
          .describe(
            "Ruling 467: the deployment's WHOLE persona (its system prompt), replacing the copy it holds. Omit to keep it; an empty one is refused. Read the current text first (get_project lists the deployment; list_global_agents has the template's). The reply names the length before and after and the first and last changed lines.",
          ),
        skills: z
          .array(z.string())
          .optional()
          .describe(
            "Skill grants by grantKey: the skill FOLDER NAME from list_skills, never its id. Omit to keep the deployment's grants; [] clears them. Every kind, the operator included.",
          ),
        mcps: z
          .array(z.string())
          .optional()
          .describe(
            "MCP grants by grantKey: the REGISTRY NAME from list_mcp_servers, never its id. Omit to keep the deployment's grants; [] clears them.",
          ),
        kbs: z
          .array(z.string())
          .optional()
          .describe(
            "Knowledge-base grants by grantKey: the store DIRECTORY from list_knowledge_bases, never its id or display name. Omit to keep the deployment's grants; [] clears them.",
          ),
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
          persona?: string;
          skills?: string[];
          mcps?: string[];
          kbs?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "manage this project's agents");
          // Ruling 467: an empty persona would leave the agent with no system
          // prompt of its own, and the form writer reads "" as "keep", so an
          // empty one sent here is a request nothing could honour. Refused
          // before anything is read or written.
          const persona = args.persona === undefined ? undefined : prose(args.persona).trim();
          if (persona !== undefined && !persona) {
            throw AppError.validation(
              "An empty persona is refused: a deployment runs on its persona, and omitting the field keeps the one it has. Nothing was written.",
            );
          }
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
          // G36-1 (pass 36, owner Q36-7): the deployment's own copy of the
          // grants (ruling 156) is editable here for EVERY kind, the operator
          // included — the Agents page renders the picker for all of them,
          // while the controller answered "a system profile I can't give
          // resources to". Keys resolve exactly as save_global_agent's do
          // (F33-8): a recognised id is normalised to its key, an unknown key
          // is refused by name, and (ruling 139) this runs BEFORE the write.
          // An omitted list keeps the deployment's copy; [] clears it.
          const grants = resolveResourceGrants(
            db,
            { skills: args.skills, mcps: args.mcps, kbs: args.kbs },
            { dataRoot },
          );
          const resources = {
            skills: grants.skills ?? view.resources.skills,
            mcps: grants.mcps ?? view.resources.mcps,
            kb: grants.kbs ?? view.resources.kb,
          };
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
          const capsBefore = { ...caps };
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
          const stages = args.stages ?? view.stages;
          // The downstream form schema reads autonomy as optional, so an
          // undefined value and an absent key parse identically; a specialist
          // sends none.
          const autonomy =
            view.kind === "operator" ? (args.autonomy ?? view.autonomy ?? "supervised") : undefined;
          const baseForm = {
            name: view.name,
            role: view.role,
            // B5 (pass 34, U34-3): the record THIS tool just read. Its own
            // read-modify-write inside one turn is never refused by itself; a
            // hand-save landing between the read and the write is.
            fingerprint: deploymentFingerprint(deployment),
            backend,
            stages,
            definition: "",
            // Ruling 467: "" keeps the deployment's persona (the form writer's
            // own rule); a persona sent here replaces it whole.
            persona: persona ?? "",
            model: args.model ?? (switched ? defaultModelFor(backend) : view.model),
            effort,
            caps,
            resources,
          };
          const form: SubmittedProfileForm = autonomy ? { ...baseForm, autonomy } : baseForm;
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
          // U36-3 (pass 36): the reply lists EVERY field the call changed, old
          // → new, built from the record this tool read and the result the
          // writer returned — never from the request. One call that switched
          // backend, model, effort, stages and grants used to answer "Effort
          // is now max." and name the model only when the backend switched.
          const changes: string[] = [];
          const changed = (field: string, before: string, after: string, note = "") => {
            if (before !== after) {
              changes.push(`${field} ${before || "(none)"} → ${after || "(none)"}${note}`);
            }
          };
          changed("backend", BACKEND_LABEL[currentBackend], BACKEND_LABEL[backend]);
          if (result.applied) {
            // A backend switch with no value given resets to that backend's
            // default; the entry says so rather than reading as a choice.
            const fromSwitch = (given: string | undefined) =>
              switched && given === undefined ? ` (${BACKEND_LABEL[backend]} default: none given)` : "";
            changed("model", view.model, result.applied.model, fromSwitch(args.model));
            changed("effort", view.effort, result.applied.effort, fromSwitch(args.effort));
          }
          changed("stages", view.stages.join(", "), stages.join(", "));
          if (autonomy) changed("autonomy", view.autonomy ?? "supervised", autonomy);
          for (const patch of args.capabilities ?? []) {
            changed(`capability ${patch.capabilityId}`, capsBefore[patch.capabilityId] ?? "", patch.mode);
          }
          changed("skills", view.resources.skills.join(", "), resources.skills.join(", "));
          changed("mcps", view.resources.mcps.join(", "), resources.mcps.join(", "));
          changed("kb", view.resources.kb.join(", "), resources.kb.join(", "));
          if (persona !== undefined) {
            // Ruling 467: from the record the writer left, not the request.
            const written =
              readProjectFile({ projectSlug: slug, dataRoot })?.parsed.frontmatter.agents.find(
                (a) => a.profileId === args.profileId,
              )?.definition?.persona ?? view.definition;
            const personaChange = describePersonaChange(view.definition, written);
            if (personaChange) changes.push(`persona ${personaChange}`);
          }
          const summary = changes.length ? `: ${changes.join("; ")}.` : ". No field changed.";
          return `[done] ${result.name} updated on ${slug}${summary}${governance}${notices}`;
        },
      ),
    ),
    "update_agent_deployment",
  );

  add(
    tool(
      "remove_agent_deployment",
      "Take one specialist's deployment off a project (ruling 464): the same removal as Delete on the project's Agents page, under the same gate (project admin, `manage-agents`) and the same audit row, with your `reason` recorded in it. It edits the project's roster; the global template is untouched and can be deployed again with deploy_agent. Refused by name: the Operator (a system profile, never removable), and a profile that is the delivering or an engaged agent on any open task (the refusal names the tasks; finish, archive or re-engage that work first, so no task is left mid-work with an agent that can no longer deliver). A project left with no specialist at all gets the base Developer and Reviewer back at the next restart, and the reply says so.",
      {
        projectSlug: z.string().optional(),
        profileId: z.string().describe("The deployment's profile id, as get_project lists it."),
        reason: z
          .string()
          .min(1)
          .describe("Why it is coming off, in the person's words; recorded in the audit row."),
      },
      runWith(async (args: { projectSlug?: string; profileId: string; reason: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "manage this project's agents");
        const reason = args.reason.trim();
        if (!reason) {
          throw AppError.validation("Say why the deployment is coming off; the reason is recorded. Nothing was removed.");
        }
        const removed = await deleteAgentProfile(
          db,
          {
            projectSlug: slug,
            profileId: args.profileId.trim(),
            reason,
            refuseOpenEngagements: true,
          },
          actor,
          { dataRoot },
        );
        const left = readProjectFile({ projectSlug: slug, dataRoot })?.parsed.frontmatter.agents ?? [];
        const specialists = left.filter(
          (a) => effectiveProfileView(a, dataRoot, VIEW_WITHOUT_POLICY).kind !== "operator",
        );
        const tail =
          specialists.length === 0
            ? " The project has no specialist left, so the next restart deploys the base Developer and Reviewer again; deploy the one you want now to keep it that way."
            : ` Deployed now: ${specialists.map((a) => a.profileId).join(", ")}.`;
        return `[done] ${removed.name} (${removed.profileId}) removed from ${slug}. The global template is untouched.${tail}`;
      }),
    ),
    "remove_agent_deployment",
  );


  add(
    tool(
      "list_decisions",
      "Everything on a board that is waiting for a PERSON to decide: open packets with all their options, pending operator recommendations, and completions ready to accept. Read-only, and deliberately so (ruling 251): nothing here answers a decision. It exists so you can brief the person fully and hand them the one link that opens the control. Every packet carries `ownWords` as well as its options: the card always offers a free-text directive as its last choice, so a person is never limited to the options on it - brief that too, especially when none of the options fit. Every entry also carries `releases`, split by WHEN (ruling 336): `releases.direct` are the tasks whose LAST wait is this one (they move the moment it completes), and `releases.downstream` are the rest of the chain, each of which needs one of the direct ones to be built, reviewed and accepted first. Only `direct` is a number about this click: live, one acceptance freed its two direct dependents in two seconds and its one downstream task fifty-three minutes later, after another full cycle. Both count only waits that can actually clear. Read either as what a decision UNBLOCKS, never as what it FINISHES: an acceptance that releases nothing still completes real work and usually needs one click, while a design packet with two direct may be the longer road. `kind` and `notAcceptableReason` carry that other half. Scoped to the conversation's project by default, or pass `projectSlug`; with neither it reads every project this person can see.",
      {
        projectSlug: z.string().optional().describe("One project. Omit inside a project conversation to use it; omit outside one to read every project this person can see."),
        taskKey: z.string().optional().describe("Just this task. Defaults to the conversation's task when it is anchored to one."),
      },
      runWith((args: { projectSlug?: string; taskKey?: string }) => {
        // Scope, in the order a person means it: an explicit argument, then the
        // conversation's own anchor, then everything they can see.
        const explicit = args.projectSlug ?? boundSlug;
        if (explicit) requireVisible(explicit, "read this project's decisions");
        // Ruling 256: the anchor belongs to the project it was anchored IN. A
        // conversation anchored to VIB-1 in one project, asked about another,
        // used to filter that other project's decisions by a task key it does
        // not contain and answer "Nothing is waiting on a person here" — a
        // false all-clear, on the tool whose whole job is to say what is
        // waiting.
        const onlyTask =
          args.taskKey ?? (explicit !== null && explicit === boundSlug ? boundTask : null);

        // The SAME source the home page's "N decisions waiting on you" counts
        // (`decisionsRequiring`), so the controller and the page can never
        // answer this question differently — which is the whole point of
        // reading rather than re-deriving.
        const found = decisionsRequiring(
          db,
          user.id,
          explicit ? { projectSlug: explicit } : {},
        );

        const render = (refs: readonly DecisionRef[]) =>
          refs
            .filter((r) => !onlyTask || r.taskKey === onlyTask)
            .map((ref) => {
              const summary = getTaskSummary(db, ref.projectSlug, ref.taskKey);
              // `packet` lives on the parsed FILE and `recommendations` on its
              // frontmatter, so both come off one read.
              const parsed = readTaskFile({
                projectSlug: ref.projectSlug,
                taskKey: ref.taskKey,
                dataRoot,
              })?.parsed;
              const packet = summary?.packet ?? null;
              return {
                project: ref.projectSlug,
                task: ref.taskKey,
                title: summary?.title ?? ref.taskKey,
                stage: ref.stage,
                kind: ref.kind,
                // The one thing this tool exists to hand over. Same form the
                // move refusal uses, so a person meets one shape of link.
                answerAt: `projects/${ref.projectSlug}/tasks/${ref.taskKey}`,
                // Ruling 300: what answering this RELEASES, down the chain.
                // The controller had to walk `blockedBy` by hand across two
                // turns to learn that five tasks sat behind three cards, and
                // said it plainly: "the one number that should order a
                // decision queue does not exist, so the ordering depends on
                // whoever happens to have walked the graph recently." A wait
                // that can never clear is not counted, so this number never
                // argues for a decision that would free nothing.
                releases: tasksReleasedBy(db, ref.projectSlug, ref.taskKey),
                packet:
                  ref.kind === "packet" && packet
                    ? {
                        id: parsed?.packet?.id ?? null,
                        kind: packet.kind,
                        from: packet.from,
                        title: packet.title,
                        body: packet.body,
                        // Numbered, because a person reading your summary has to
                        // find the same option on the card.
                        // The stored keys are terse (`t`/`d`/`rec`) because a
                        // packet rides in every operator prompt; spell them out
                        // here, where a person reads the answer.
                        options: packet.options.map((o, i) => ({
                          n: i + 1,
                          kind: o.kind,
                          title: o.t,
                          detail: o.d,
                          recommended: o.rec === true,
                        })),
                        // Ruling 271 (pass 37, F37-103): the card ALWAYS offers
                        // one more answer than the packet stores — a directive
                        // in the person's own words, composed with the fixed
                        // choices as their last choice (`customOffered =
                        // canResolve`, decision-packet.tsx). It is not a stored
                        // option, so this tool listed the fixed choices and
                        // nothing else, and the one tool whose job is to "brief
                        // the person fully" left out the only answer that is
                        // always available. Live, the controller read a packet
                        // whose recommended option said "You create the task —
                        // no option here can", found no way to withdraw or
                        // re-raise it (a manual operator run is refused while a
                        // packet is open, correctly), and reported a deadlock:
                        // "there is no way to say 'these options are wrong'
                        // except to pick one of them." There was; it was the
                        // choice under the ones it could see.
                        //
                        // Numbered like the others, because a person reading
                        // the briefing has to find the same choice on the card,
                        // and named apart from them because it is not a
                        // PacketOptionKind and must never be passed as one.
                        ownWords: {
                          n: packet.options.length + 1,
                          title: "Write your own directive",
                          detail:
                            "Anyone who can resolve this packet can answer in their own words " +
                            "instead of picking an option. It is the last choice on the card; it " +
                            "resolves the packet and puts the directive to the operator (and to " +
                            "the agent that asked, when one raised it). This is how a person says " +
                            "the options are wrong, or asks for the decision to be put again.",
                        },
                        // Ruling 138: a decided edit_goal packet still waits,
                        // and saying so stops you reporting it as unanswered.
                        awaitingGoalEdit: packet.awaiting === "goal_edit",
                      }
                    : null,
                recommendations:
                  ref.kind === "recommendation"
                    ? (parsed?.frontmatter.recommendations ?? []).map((r) => ({
                        id: r.id,
                        kind: r.kind,
                        label: r.label,
                        detail: r.detail,
                      }))
                    : [],
                // Ruling 188's lesson: report the gate's own verdict, never a
                // sentence derived somewhere else. Null here means acceptable.
                notAcceptableReason: acceptanceRefusalFor(
                  { projectSlug: ref.projectSlug, taskKey: ref.taskKey },
                  { dataRoot },
                ),
              };
            });

        const forYou = render(found.mine);
        const viaOverride = render(found.overrideEligible);
        return json({
          forYou,
          // Named separately and never folded into the count: reach as an org
          // admin is not a personal inbox (the same line `decisionsRequiring`
          // draws), and telling someone these are "waiting on you" would be
          // false.
          onlyViaOrgAdminOverride: viaOverride,
          howToAnswer:
            forYou.length + viaOverride.length === 0
              ? "Nothing is waiting on a person here."
              : "Open the task page at `answerAt`, pick the option by its number, and confirm. A packet also takes a typed note that is recorded on the task's contract and read by every later run.",
        });
      }),
    ),
    "list_decisions",
  );

  // ================================================================ epics

  /** Ruling 503: one epic as the list and the project read report it. */
  function epicRow(e: EpicSummary) {
    return {
      id: e.id,
      title: e.title,
      status: e.status,
      lead: e.leadName,
      startDate: e.startDate,
      targetDate: e.targetDate,
      progress: {
        done: e.progress.done,
        total: e.progress.total,
        started: e.progress.started,
        notStarted: e.progress.notStarted,
        held: e.progress.held,
        archived: e.progress.archived,
        archivedDone: e.progress.archivedDone,
      },
    };
  }

  /** An epic's lead as a tool names them: a member's email, or "me"; "none"
   *  or "" is nobody. */
  function leadOf(raw: string): string | null {
    const who = raw.trim().toLowerCase();
    if (who === "" || who === "none") return null;
    if (who === "me") return user.id;
    const id = listUsers(db).find((u) => u.email.toLowerCase() === who)?.id;
    if (!id) throw AppError.notFound(`No Viberr user with the email ${raw}.`);
    return id;
  }

  const epicStatusArg = z
    .enum(EPIC_STATUS_VALUES)
    .optional()
    .describe(
      "planned, in_progress, paused, done or cancelled. A person's call, never derived from the tasks: progress is shown beside it.",
    );
  const epicColorArg = z
    .enum(EPIC_COLORS)
    .optional()
    .describe("Its colour: the dot on the Epics page and the chip on its tasks' pages. One is picked when omitted.");

  add(
    tool(
      "list_epics",
      "The project's epics (ruling 503). An epic is a named body of work that tasks join and leave one at a time, like a Jira epic or a Linear project. Each with its status, lead, dates and progress counted from its tasks at read time: done of total, started, not started and held. Archived tasks are counted apart: one archived when it was done stays in done and total (`archivedDone` counts those, ruling 651), and one archived unfinished is left out. Membership gated.",
      { projectSlug: z.string().optional() },
      runWith((args: { projectSlug?: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's epics");
        return json(listEpics(db, slug).map(epicRow));
      }),
    ),
    "list_epics",
  );

  add(
    tool(
      "get_epic",
      "One epic in full: what it is (description, status, lead, dates), its progress by stage, every task in it with its stage, readiness, owner and what it waits on, and the epic's own history, newest first. An epic starts, orders and holds nothing: the order of its work is what each task waits on (blockedBy). Membership gated.",
      { projectSlug: z.string().optional(), epicId: z.string() },
      runWith((args: { projectSlug?: string; epicId: string }) => {
        const slug = slugOf(args.projectSlug);
        requireVisible(slug, "read this project's epics");
        const epic = getEpicDetail(db, slug, args.epicId.trim(), { dataRoot });
        if (!epic) throw AppError.notFound(`No epic ${args.epicId} in ${slug}; list_epics names them.`);
        const tasks = listProjectTasks(db, slug, { dataRoot, includeArchived: true, epicId: epic.id });
        return json({
          ...epicRow(epic),
          description: epic.description,
          color: epic.color,
          createdBy: epic.createdByLabel || epic.createdBy,
          byStage: epic.progress.byStage,
          tasks: tasks.map((t) => ({
            key: t.key,
            title: t.title,
            stage: t.stage,
            readiness: t.readiness,
            waiting: t.waiting,
            owner: t.owner?.name ?? null,
            archived: t.archived,
            waitsOn: t.blockedBy.map((e) => `${e.label} (${e.state})`),
          })),
          history: epic.history.map((h) => `${h.occurredAt} · ${h.text}`),
        });
      }),
    ),
    "get_epic",
  );

  add(
    tool(
      "create_epic",
      "Create an epic (ruling 503): a named body of work in this project that tasks join and leave one at a time, like a Jira epic or a Linear project. It starts, orders and holds nothing, so say what each task waits on with its own blockedBy. `tasks` puts existing tasks in it as it is created; a task is in at most one epic, so one already in another moves. To plan new work in it, create the epic, then create_task with `epic`. Contributor or above; putting tasks in it needs the project's edit-task-meta grant as well.",
      {
        projectSlug: z.string().optional(),
        title: z.string().describe("The epic's name, at most 120 characters."),
        description: z.string().optional().describe("What the body of work is for, in prose."),
        status: epicStatusArg.describe("Defaults to planned."),
        color: epicColorArg,
        lead: z
          .string()
          .optional()
          .describe('The member who leads it, by email, or "me". Its notices reach them; with no lead they reach its creator.'),
        startDate: z.string().optional().describe("YYYY-MM-DD, when the work is meant to start."),
        targetDate: z.string().optional().describe("YYYY-MM-DD, when it is meant to land."),
        tasks: z.array(z.string()).optional().describe("Existing task keys to put in it."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          title: string;
          description?: string;
          status?: EpicStatus;
          color?: (typeof EPIC_COLORS)[number];
          lead?: string;
          startDate?: string;
          targetDate?: string;
          tasks?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          // Same reason as `create_task`: the action gate would refuse a
          // non-member in words that confirm the project exists.
          requireVisible(slug, "create epics");
          const input: CreateEpicInput = { projectSlug: slug, title: args.title };
          if (args.description) input.description = prose(args.description);
          if (args.status) input.status = args.status;
          if (args.color) input.color = args.color;
          if (args.lead !== undefined) input.leadUserId = leadOf(args.lead);
          if (args.startDate !== undefined) input.startDate = args.startDate;
          if (args.targetDate !== undefined) input.targetDate = args.targetDate;
          if (args.tasks?.length) input.taskKeys = args.tasks;
          // Where it was planned, for the epic page's "Planned in" link.
          if (deps.conversationId) input.conversationId = deps.conversationId;
          const result = await createEpic(db, input, actor, { dataRoot });
          return `[done] ${result.message}`;
        },
      ),
    ),
    "create_epic",
  );

  add(
    tool(
      "update_epic",
      "Change an epic: its name, description, status, colour, lead, start and target dates, and which tasks are in it. `addTasks` puts tasks in (a task in another epic moves here); `removeTasks` takes tasks out of THIS epic, and they stay on the board in no epic. Editing what the epic is needs contributor or above; moving tasks needs the project's edit-task-meta grant. There is no delete: close an epic by setting it done or cancelled, and it stays readable.",
      {
        projectSlug: z.string().optional(),
        epicId: z.string(),
        title: z.string().optional(),
        description: z.string().optional().describe('The full description; "" clears it.'),
        status: epicStatusArg,
        color: epicColorArg,
        lead: z.string().optional().describe('A member\'s email, "me", or "none" to clear.'),
        startDate: z.string().optional().describe('YYYY-MM-DD, or "" to clear.'),
        targetDate: z.string().optional().describe('YYYY-MM-DD, or "" to clear.'),
        addTasks: z.array(z.string()).optional(),
        removeTasks: z.array(z.string()).optional(),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          epicId: string;
          title?: string;
          description?: string;
          status?: EpicStatus;
          color?: (typeof EPIC_COLORS)[number];
          lead?: string;
          startDate?: string;
          targetDate?: string;
          addTasks?: string[];
          removeTasks?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "edit this project's epics");
          const epicId = args.epicId.trim();
          if (!getEpic(db, slug, epicId)) {
            throw AppError.notFound(`No epic ${args.epicId} in ${slug}; list_epics names them.`);
          }
          const input: UpdateEpicInput = { projectSlug: slug, epicId };
          if (args.title !== undefined) input.title = args.title;
          if (args.description !== undefined) input.description = prose(args.description);
          if (args.status !== undefined) input.status = args.status;
          if (args.color !== undefined) input.color = args.color;
          if (args.lead !== undefined) input.leadUserId = leadOf(args.lead);
          if (args.startDate !== undefined) input.startDate = args.startDate;
          if (args.targetDate !== undefined) input.targetDate = args.targetDate;
          const editsEpic = [
            args.title,
            args.description,
            args.status,
            args.color,
            args.lead,
            args.startDate,
            args.targetDate,
          ].some((v) => v !== undefined);
          const adding = args.addTasks ?? [];
          const removing = args.removeTasks ?? [];
          if (!editsEpic && adding.length === 0 && removing.length === 0) {
            throw AppError.validation(
              "Pass a field to change (title, description, status, color, lead, startDate, targetDate) or tasks to add or remove.",
            );
          }
          // Only tasks in THIS epic can leave it, checked before anything is
          // written so a wrong key changes nothing.
          if (removing.length > 0) {
            const inIt = new Set(epicTaskKeys(db, slug, epicId));
            const stray = removing.filter((k) => !inIt.has(k.trim().toUpperCase()));
            if (stray.length > 0) {
              throw AppError.validation(
                `${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} not in ${epicId}; nothing was changed.`,
              );
            }
          }
          // Every other refusal the moves can meet (an unknown or archived
          // task, a withheld edit-task-meta grant) is met here too, before
          // the epic's own fields are written, so the call lands whole or not
          // at all.
          const addition = { projectSlug: slug, taskKeys: adding, epicId };
          const removal = { projectSlug: slug, taskKeys: removing, epicId: null, fromEpicId: epicId };
          if (adding.length > 0) planTasksEpic(db, addition, actor, { dataRoot });
          if (removing.length > 0) planTasksEpic(db, removal, actor, { dataRoot });
          const said: string[] = [];
          if (editsEpic) said.push((await updateEpic(db, input, actor, { dataRoot })).message);
          if (adding.length > 0) {
            said.push((await setTasksEpic(db, addition, actor, { dataRoot })).message);
          }
          if (removing.length > 0) {
            said.push((await setTasksEpic(db, removal, actor, { dataRoot })).message);
          }
          return `[done] ${said.join(" ")}`;
        },
      ),
    ),
    "update_epic",
  );

  const server = createSdkMcpServer({
    name: "viberr_controller",
    version: "1.0.0",
    // Ruling 297, corrected: the manifest is NOT here. A server's
    // `instructions` are captured once, when a session starts, so a running
    // conversation kept a stale copy while new tool names arrived beside it.
    // `buildControllerMounts` hands the list to the system prompt instead,
    // which Viberr rebuilds every turn.
    instructions: CONTROLLER_TOOLKIT_INSTRUCTIONS,
    tools,
  });

  return {
    mcpServers: { viberr_controller: server },
    allowedTools: allowed,
    tools,
  };
}
