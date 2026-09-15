import type { DatabaseSync } from "node:sqlite";
import {
  BACKEND_LABEL,
  assertEffortForBackend,
  assertModelForBackend,
  defaultEffortFor,
  defaultModelFor,
  effortsFor,
} from "~/server/runtimes/model-catalog.server";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  UNIFIED_CAP_CATALOG,
  capabilityById,
  type CapabilityKind,
} from "~/shared/capabilities";
import { resolveDeclaredStages } from "~/shared/workflow/stage-eligibility";
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
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
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
import {
  readStoreDoc,
  scanStoreTree,
  writeStoreDoc,
} from "~/server/org/store-files.server";
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
  setProjectFileLeases,
  setProjectRulingsKb,
  setRequiredReviewers,
  updateProjectIdentity,
} from "~/features/project-settings/settings-actions.server";
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
  createGoal,
  getGoalView,
  listGoals,
  updateGoal,
  type CreateGoalInput,
  type UpdateGoalOp,
} from "~/server/tasks/goal-actions.server";
import {
  acceptanceRefusalFor,
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
  "accepts completions, resolves decision packets, or moves a task into its final stage \u2014 " +
  "ruling 251: those stay with the person, and `list_decisions` is how you put each one in " +
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
            // Ruling 257 (F37-88): the NAMES, not just a count. A `doc` write
            // replaces a whole file, and the model could not see that the name
            // it was about to write was already taken — the tool's own example
            // path, `conventions.md`, is the live rulings file on this very
            // instance.
            documents: kbDocumentNames(kb.id),
          })),
        );
      }),
    ),
    "list_knowledge_bases",
  );

  add(
    tool(
      "read_knowledge_base_doc",
      "Read one document out of a knowledge base, so a `save_knowledge_base` write can carry the text forward instead of destroying it. Org admins only. Returns null when the KB or the file is not there (ruling 246: existence before type).",
      {
        id: z.string().describe("KB id, from list_knowledge_bases."),
        path: z.string().describe("File name inside the KB folder, e.g. conventions.md."),
      },
      runWith((args: { id: string; path: string }) => {
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
        return json({
          path: args.path,
          bytes: doc.text.length,
          truncated: doc.truncated,
          text: doc.text,
        });
      }),
    ),
    "read_knowledge_base_doc",
  );

  add(
    tool(
      "save_knowledge_base",
      "Create or update a knowledge base (name, refresh mode), optionally writing one document into its folder. Org admins only. The reply names the KB's id (what the next save takes) and its grantKey (what a grant takes). A `doc` REPLACES the whole file, so a name that already exists is refused unless you pass `replace: true` (ruling 257): read the existing text first with read_knowledge_base_doc and send it back with your change, or nothing you leave out survives. The reply says which happened, and how many bytes a replace destroyed.",
      {
        id: z
          .string()
          .optional()
          .describe(
            "Existing KB id to update — from list_knowledge_bases or this tool's own reply; omit to create.",
          ),
        name: z.string(),
        // The shared constant, not a hand-copied list: "nightly" was retired
        // when it turned out nothing ever scheduled it (see KB_REFRESH_MODES),
        // but this tool kept advertising it, so the controller could pick a
        // mode that was silently coerced to "on change" behind its back.
        refresh: z.enum(KB_REFRESH_MODES).optional(),
        doc: z
          .object({
            path: z.string().describe("File name inside the KB folder, e.g. conventions.md."),
            content: z.string().describe("The WHOLE file. There is no append; what you omit is gone."),
            replace: z
              .boolean()
              .optional()
              .describe(
                "Required to overwrite a file that already exists. Read it first; `content` replaces all of it.",
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
          doc?: { path: string; content: string; replace?: boolean };
        }) => {
          requireOrgAdmin("manage knowledge bases");
          const saved = await saveKnowledgeBase(
            db,
            { id: args.id ?? null, name: args.name, refresh: args.refresh ?? "on change" },
            auditActor,
            { dataRoot },
          );
          // U36-4 (pass 36): the reply carries what the next call needs — the
          // id for a save, the grantKey for a grant. The toast alone named the
          // folder, and the controller then guessed `disk:<dir>`.
          const head = `[done] ${saved.toast} (id ${saved.kb.id}, grantKey ${saved.kb.dir}).`;
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
            const before = readStoreDoc(target, [args.doc.path]);
            const written = writeStoreDoc(
              db,
              target,
              [],
              args.doc.path,
              args.doc.content,
              auditActor,
              { overwrite: args.doc.replace === true },
            );
            docNote = written.replaced
              ? ` Document ${written.path.join("/")} REPLACED: its previous ${before?.text.length ?? "unknown"} bytes are gone, ${written.bytes} written.`
              : ` Document ${written.path.join("/")} saved (${written.bytes} bytes).`;
          }
          return `${head}${docNote}`;
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
      "Create or update an org skill (name, one-line summary, SKILL.md body). Org admins only. The reply names the skill's id (what the next save takes) and its grantKey (what a grant takes).",
      {
        id: z
          .string()
          .optional()
          .describe(
            "Existing skill id to update — from list_skills or this tool's own reply; omit to create.",
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
          auditActor,
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
          })),
        );
      }),
    ),
    "list_mcp_servers",
  );

  add(
    tool(
      "save_mcp_server",
      "Create or update an org MCP connection (name, transport, endpoint or command). Org admins only. Credentials do NOT travel through chat: tell the admin to add the secret in Org settings, then test the server. `writeTools` marks the tools Viberr withholds from every run without execute-code-or-write-repo and from every operator run (ruling 176). Marking is a REVIEW, so nothing is marked unless you say so: a server saved without it withholds NOTHING, and the reply names the tools whose names look like writes so you can mark them in a second call. Pass [] to record that none should be withheld. On an UPDATE, omitting the field leaves the existing marking untouched.",
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
      },
      runWith(
        async (args: {
          id?: string;
          name: string;
          transport: "HTTP" | "stdio";
          target: string;
          writeTools?: string[];
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
          const saved = await saveMcpServer(db, input, auditActor, {}, { dataRoot });
          // `saveMcpServer` answers with the row it wrote, so the reply states
          // the marking that actually landed rather than the one we asked for.
          const policy = saved.mcp.writeTools;
          const suggestion = saved.writeToolsSuggestion;
          return (
            `[done] ${saved.toast}. ` +
            (policy.length > 0
              ? `${policy.length} write ${policy.length === 1 ? "tool" : "tools"} withheld from every run without execute-code-or-write-repo and from every operator run (ruling 176): ${policy.join(", ")}. `
              : suggestion.length > 0
                ? `NOTHING is withheld: no tool on this server is marked, so every tool it exposes — including the ones that write — reaches every run that mounts it. From the names the probe listed, these look like write tools: ${suggestion.join(", ")}. Call save_mcp_server again with \`writeTools\` to mark them (or an explicit [] to record that none should be), then say which you chose. `
                : "Nothing is marked as a write tool, so nothing is withheld. The probe listed no tool whose name looks like a write. ") +
            "If it needs a credential, the admin adds it in " +
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
      "List the org's global agent templates (specialists a project can deploy), each with its full persona, the resource grants it holds, its default model and effort, and `copiesDiffering`: the projects whose deployed copy no longer carries the template's grants (ruling 156). Org admins only. Read this before save_global_agent so an edit is not blind.",
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
          })),
        );
      }),
    ),
    "list_global_agents",
  );

  add(
    tool(
      "save_global_agent",
      "Create or update a global agent template (name, backend, summary, persona, eligible stages, default model and effort, resource grants). Org admins only. The controller itself and the operator are system profiles this tool cannot touch. Merge semantics: an omitted skills/mcps/kbs list leaves the stored grants unchanged and an empty list clears them; an omitted or empty PERSONA leaves the stored persona unchanged, so editing a summary alone is safe — read list_global_agents first, which returns the persona and the grants, and grant by grantKey, never by id. A project deployment keeps its own copy of the grants; the reply names every copy that now differs and how to update it.",
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
      "One project's live shape: stages with task counts, workflow boundaries, members with roles, deployed agents with their RESOLVED grants (every catalogued capability id at the mode the runtime applies, model, effort, and the operator's autonomy; ruling 139: read this before update_agent_deployment), goals summary, and `rulingsKb` \u2014 the knowledge base every run on this project reads (ruling 239), null when none is named \u2014 and `fileLeases`, which task owns which shared paths until it merges (ruling 245) \u2014 resolved, so a lease whose holder has finished is NOT listed there but in `spentFileLeases`, which binds nobody and can be cleared (ruling 247). Membership gated.",
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
        return json({
          task: {
            ...task,
            notAcceptableReason: acceptanceRefusalFor(
              { projectSlug: slug, taskKey: key },
              { dataRoot },
            ),
          },
          schedules,
          newestEvents: events,
        });
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
      "Put an agent to work on a task with a directive: the operator (coordination) or a deployed agent profile (stage work). Maintainer or above. The result reports honestly whether a run started, was queued behind the concurrent-run cap, or was refused before any process existed. The directive is also written on the task timeline as a comment addressed to the agent, so the people watching the task can read what it was asked to do.",
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
            if (args.prompt && !result.refused) {
              const { appendComment } = await import("~/server/tasks/task-actions.server");
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
          // Ruling 263 (F37-93), second half: R21-9's law applied to the
          // dispatch prompt, on the one door that skipped it. The task page
          // writes `@<agent> <prompt>` as the dispatcher's own comment after
          // the start, and the operator's `run_agent` writes one before it —
          // so a directive that reaches an agent is on the record and
          // supervision can read it. Through the controller the same words
          // went into the prompt and NOWHERE else: the timeline showed a run
          // appearing for no stated reason, and the person who asked for it
          // could not see what they had asked for. After the start, like the
          // task page, so a dispatch that throws leaves no orphan hand-off.
          if (args.prompt) {
            const { appendComment } = await import("~/server/tasks/task-actions.server");
            await appendComment(
              db,
              {
                projectSlug: slug,
                taskKey: key,
                text: `@${started.name} ${prose(args.prompt)}`,
                forceToAgent: true,
              },
              actor,
              { dataRoot },
            );
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
                `${departure ? " yet — its branch is pushed but no PR is open" : ""}. ` +
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
            actor: auditActor,
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
      "Declare the project's REQUIRED reviewers per review stage (ruling 178): the WHOLE list, replacing what project.md holds; `rules: []` clears it. Each rule names a non-terminal stage id and the profile id of a deployed agent that can report a validation verdict — get_project lists both (`stages`, `agents[].capabilities`) and the current rules (`requiredReviewers`). An unknown stage or profile, the terminal stage, or an agent without report-validation-verdict is refused by name with nothing written. While a rule stands, no task is acceptable until that agent holds an approve verdict on the delivered revision, engaged or not: the acceptance gate, the review queue and the operator's get_task read the same rule, so declare it here instead of asking the operator to remember. Project admin (edit-policy).",
      {
        projectSlug: z.string().optional(),
        rules: z
          .array(z.object({ stageId: z.string(), profileId: z.string() }))
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
      "Name the project's RULINGS knowledge base by store DIRECTORY (ruling 239), or pass dir: null to clear it. Project admin (edit-policy). Unlike a per-profile `kbs` grant, this one KB is injected into EVERY run the project makes — each specialist, the operator, and your own conversation while it is scoped to this project — so nobody can forget it on the one profile that needed it. Use it for rules the project has SETTLED and should not re-litigate: a convention a review established, a shared-surface protocol, an environment fact reviewers keep re-deriving. `list_knowledge_bases` gives the grantKey to pass here; a directory no knowledge base occupies is refused by name with nothing written. Promoting an existing KB into this role is the expected move, and a profile that also grants it explicitly is not charged for it twice.",
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
      "Ruling 245: declare which TASK owns which shared paths until it merges, or pass an empty list to clear. Project admin (edit-policy). This is the ordering statement `blockedBy` cannot make: `blockedBy` says \"do not START until done\", a lease says \"both may proceed, this one owns `pnpm-lock.yaml` until it lands\". Enforced at DELIVERY — another task whose push changes a leased path is refused by name, before anything reaches GitHub. Globs: `*` matches within one segment, `**` spans segments and covers the directory itself. The whole list is replaced by what you pass. A lease naming a task this project does not have is refused, and two leases may not cover the same glob.",
      {
        projectSlug: z.string().optional(),
        leases: z
          .array(
            z.object({
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
      "Deploy a global agent template into the project (from list_global_agents). Project admin. No removal exists here. A deploy COPIES the template's own capability grants, so whether the profile can write the repo depends on the template: the reply says which, read off what was written. Ruling 139: `model` and `effort` override the template's defaults and are checked by name against the template's primary backend before the write (an unknown tier is refused, never clamped); omit them to keep the template's own model and effort (ruling 153; the backend's default stands in only when the template names none, or names a tier this backend does not offer). The reply states what was stored.",
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
          ? ` Runs on ${result.applied.backend === "codex" ? "Codex" : "Claude"} with model ${result.applied.model} at effort ${result.applied.effort}.`
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
      "Update one deployed agent's project configuration: capability modes (direct, recommend for the operator, human, off), backend, model, effort, eligible stages, operator autonomy, or the deployment's own resource grants (skills, mcps, kbs — every kind, the operator included). Project admin. Merge semantics: only the fields you pass change; an omitted grant list is left alone and [] clears it. Ruling 139: every catalogued value is checked BEFORE anything is written and an unknown or impossible one is refused by name with nothing written: a capability id must be one the deployment's KIND takes (read list_capabilities first; get_project shows the deployment's resolved grants and resources), a specialist takes no recommend, an always-human id takes only human, report-validation-verdict takes only direct or off, matrix-only advisory ids have no toggle, every stage id must be one of the project's stages, and every grant is a grantKey the store answers to (from list_skills, list_mcp_servers, list_knowledge_bases — never an id). The reply lists every field the call changed, old → new; a call that changes nothing says so.",
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
            `Effort tier the deployment's backend offers (${EFFORT_TIERS_SENTENCE}); refused by name otherwise. A backend switch with no effort resets to that backend's default.`,
          ),
        stages: z.array(z.string()).optional(),
        autonomy: z.enum(["supervised", "full"]).optional().describe("Operator only."),
        skills: z
          .array(z.string())
          .optional()
          .describe(
            "Skill grants by grantKey — the skill FOLDER NAME from list_skills, never its id. Omit to keep the deployment's grants; [] clears them. Every kind, the operator included.",
          ),
        mcps: z
          .array(z.string())
          .optional()
          .describe(
            "MCP grants by grantKey — the REGISTRY NAME from list_mcp_servers, never its id. Omit to keep the deployment's grants; [] clears them.",
          ),
        kbs: z
          .array(z.string())
          .optional()
          .describe(
            "Knowledge-base grants by grantKey — the store DIRECTORY from list_knowledge_bases, never its id or display name. Omit to keep the deployment's grants; [] clears them.",
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
          skills?: string[];
          mcps?: string[];
          kbs?: string[];
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
            persona: "",
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
          const summary = changes.length ? `: ${changes.join("; ")}.` : ". No field changed.";
          return `[done] ${result.name} updated on ${slug}${summary}${governance}${notices}`;
        },
      ),
    ),
    "update_agent_deployment",
  );


  add(
    tool(
      "list_decisions",
      "Everything on a board that is waiting for a PERSON to decide: open packets with all their options, pending operator recommendations, and completions ready to accept. Read-only, and deliberately so (ruling 251): nothing here answers a decision. It exists so you can brief the person fully and hand them the one link that opens the control. Every packet carries `ownWords` as well as its options: the card always offers a free-text directive as its last choice, so a person is never limited to the options on it - brief that too, especially when none of the options fit. Scoped to the conversation's project by default, or pass `projectSlug`; with neither it reads every project this person can see.",
      {
        projectSlug: z.string().optional().describe("One project. Omit inside a project conversation to use it; omit outside one to read every project this person can see."),
        taskKey: z.string().optional().describe("Just this task. Defaults to the conversation's task when it is anchored to one."),
      },
      runWith((args: { projectSlug?: string; taskKey?: string }) => {
        // Scope, in the order a person means it: an explicit argument, then the
        // conversation's own anchor, then everything they can see.
        const explicit = args.projectSlug ?? boundSlug ?? null;
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
      "One goal chain in full: description, every link with its task and status, and the chain's history. A link that has a task carries `liveGoal` — that task's CURRENT goal — whenever it has moved past the text the link was declared with; the link's own `title`/`goal` are what the chain declared, which is what a retry used to rebuild from. Membership gated.",
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
      "Redirect a goal chain: rename it (title and/or description), pause, resume, cancel, skip a link, retry a failed link (a fresh task, rebuilt from that task's own current text), edit a pending or failed link (an active link takes blockedBy only, written on its task), add a link, or remove a pending link. The creator or a maintainer+. Completed and cancelled chains stay readable and nothing is deleted; every op is refused on one EXCEPT rename, which corrects what a settled chain is called without changing what it did (ruling 267).",
      {
        projectSlug: z.string().optional(),
        goalId: z.string(),
        op: z.enum([
          "rename",
          "pause",
          "resume",
          "cancel",
          "skip_link",
          "retry_link",
          "edit_link",
          "add_link",
          "remove_pending_link",
          "adopt_task",
        ]),
        index: z.number().int().min(1).optional().describe("The link the op targets."),
        taskKey: z
          .string()
          .optional()
          .describe(
            "adopt_task: an EXISTING task in this project for the pending link to carry. Ruling 243 — use this instead of creating a task and deleting the link, which destroys the link's authored text. The task must not already belong to another chain.",
          ),
        title: z.string().optional(),
        goal: z.string().optional(),
        description: z
          .string()
          .optional()
          .describe("rename: the chain's description prose. `title` renames the chain itself."),
        reason: z.string().optional(),
        blockedBy: z
          .array(z.string())
          .optional()
          .describe("edit_link / add_link: what the link's task waits on (the full list; [] clears; omit on edit_link to leave it). On an active link this is the only editable field: it is written on the link's task, and the link mirrors it."),
      },
      runWith(
        async (args: {
          projectSlug?: string;
          goalId: string;
          op:
            | "rename"
            | "pause"
            | "resume"
            | "cancel"
            | "skip_link"
            | "retry_link"
            | "edit_link"
            | "add_link"
            | "remove_pending_link"
            | "adopt_task";
          index?: number;
          /** adopt_task: the existing task the pending link should carry. */
          taskKey?: string;
          title?: string;
          goal?: string;
          description?: string;
          reason?: string;
          blockedBy?: string[];
        }) => {
          const slug = slugOf(args.projectSlug);
          requireVisible(slug, "redirect this project's goals");
          const needIndex = ["skip_link", "retry_link", "edit_link", "remove_pending_link", "adopt_task"];
          if (needIndex.includes(args.op) && !args.index) {
            throw AppError.validation(`${args.op} needs the link index.`);
          }
          let action: UpdateGoalOp;
          switch (args.op) {
            case "rename": {
              // Ruling 192: a chain outlives the sentence it was created with.
              // Built as a typed local rather than a conditional spread (the
              // lint rule) so an omitted field stays omitted.
              const renamed: Extract<UpdateGoalOp, { op: "rename" }> = { op: "rename" };
              if (args.title !== undefined) renamed.title = args.title;
              if (args.description !== undefined) renamed.description = prose(args.description);
              action = renamed;
              break;
            }
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
              // Ruling 155: on an active link the writer is the task's.
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
            case "adopt_task": {
              // Ruling 243: bind an EXISTING task to a pending link, so work
              // created ahead of the chain is carried by it instead of
              // duplicated when the chain advances.
              if (!args.taskKey) {
                return "[refused] adopt_task needs `taskKey`: the existing task the pending link should carry.";
              }
              action = { op: "adopt_task", index: args.index!, taskKey: args.taskKey };
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
