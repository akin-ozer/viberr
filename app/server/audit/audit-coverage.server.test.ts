import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { taskDir } from "~/server/files/file-store-root.server";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { rescanProjections } from "~/server/projections/rescan.server";
import { rebuildProjections } from "~/server/projections/rebuild.server";
import {
  openScopeViolation,
  resolveScopeViolation,
} from "~/server/projections/policy-violations.server";
import { revalidateProjectCredential } from "~/server/secrets/pat-validator.server";
import { appendComment, resolvePacket, transitionStage } from "~/server/tasks/task-actions.server";
import { releaseOwner, setOwner } from "~/server/tasks/task-ownership.server";
import { createTask } from "~/server/tasks/task-edits.server";
import {
  interruptRun,
  startRun,
} from "~/server/runtimes/run-service.server";
import {
  disconnectBackendAccount,
  renameBackendAccount,
  setBackendApiKey,
  switchBackendAccount,
} from "~/server/runtimes/backend-credentials.server";
import {
  cancelBackendLogin,
  resetBackendLoginsForTests,
  startBackendLogin,
} from "~/server/runtimes/backend-login.server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  bindRunToMcpGateway,
  startMcpGateway,
  stopMcpGateway,
} from "~/server/mcp-proxy/gateway.server";
import { sealSecret } from "~/server/secrets/secret-box.server";
import { resolveSpecialistMcpServersDetailed } from "~/server/tasks/specialist-mcp.server";
import { startHttpUpstream } from "../../../test-support/mcp-upstream";
import { signInWithOAuth, startOAuthMcpServer } from "../../../test-support/mcp-oauth-server";
import { resetMcpOAuthForTests, signOutMcpOAuth } from "~/server/org/mcp-oauth.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import { deployAgentProfileFromLibrary } from "~/features/agents/agent-profile-actions.server";
import { saveGlobalAgentProfile } from "~/server/org/gagents.server";
import { propagateTemplateResources } from "~/server/org/template-propagation.server";
import {
  resetFakeVendorEnv,
  setFakeVendorMode,
  writeFakeVendorBinaries,
  type FakeVendorBinaries,
} from "../../../test-support/fake-vendor-binary";

let ctx: TestDbContext;
let store: TestStore;
/** Ruling 127: the sign-in actions are audited by a driver that spawns the
 *  vendor's own binary, so the sweep drives real (fake) executables. */
let vendors: FakeVendorBinaries;

/** The vendors' free key probe, answered without a network (ruling 127). */
const acceptingProvider: typeof fetch = () =>
  Promise.resolve(new Response("{}", { status: 200 }));

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  vendors = writeFakeVendorBinaries();
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "triage",
      readiness: "ready",
    }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-2", {
      stage: "review",
      readiness: "ready",
      waiting: "human",
      ownerUserId: null,
    }),
    packet: {
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "Accept?",
      body: "Done.",
      observations: [],
      options: [
        {
          kind: "request_edit",
          t: "Request one edit",
          d: "",
          rec: true,
        },
      ],
    },
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
  // Ruling 127: an agent run bills the TASK OWNER's own accounts, so a run
  // only reaches an adapter when the owner has that backend connected. Arda
  // owns the tasks in this file; connecting both backends for him is the
  // ordinary state of somebody using the product.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
  await connectFakeBackend(store.db, store.users.arda.id, "codex");
});

afterEach(() => {
  resetBackendLoginsForTests();
  resetFakeVendorEnv();
  vendors.cleanup();
  ctx.cleanup();
});

interface CoverageRow {
  name: string;
  action: string;
  /**
   * Runs the governed entry point for its EFFECT — this table asserts on the
   * audit rows it writes, never on what it hands back, which is why the
   * contract returns nothing. The loop below still awaits the call: several of
   * these entry points are async.
   */
  run: () => void;
  /** Expected taskKey (task-scoped rows). */
  taskKey?: string;
  /** Instance-wide maintenance events have no project subject. */
  instanceWide?: boolean;
  /** A row about a project other than the fixture's (one being created). */
  projectSlug?: string;
}

describe("governed actions record audit rows (table-driven)", () => {
  it("runs the table and finds every expected audit row", async () => {
    const actorArda = () => ({
      userId: store.users.arda.id,
      label: store.users.arda.email,
    });
    const fileCtx = { dataRoot: store.dataRoot };

    const table: CoverageRow[] = [
      {
        name: "createTask",
        action: "task.created",
        run: () =>
          createTask(
            store.db,
            { projectSlug: store.slug, title: "Audit sweep task" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        // Ruling 131: the dependency writer and the human release.
        name: "setTaskDependencies",
        action: "task.dependencies.updated",
        taskKey: "VIB-1",
        run: async () => {
          const { setTaskDependencies } = await import("~/server/tasks/dependencies.server");
          await setTaskDependencies(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-2"] },
            actorArda(),
            fileCtx,
          );
        },
      },
      {
        name: "setTaskDependencies (a person empties the list)",
        action: "task.dependencies.released",
        taskKey: "VIB-1",
        run: async () => {
          const { setTaskDependencies } = await import("~/server/tasks/dependencies.server");
          await setTaskDependencies(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: ["VIB-2"] },
            actorArda(),
            fileCtx,
          );
          await setTaskDependencies(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", blockedBy: [] },
            actorArda(),
            fileCtx,
          );
        },
      },
      {
        // Ruling 137: a withdrawal writes its own row. The accept card is
        // seeded on a task with NO open packet, and the packet the question
        // opens is cleared afterwards so later rows in this sequential store
        // are unaffected.
        name: "withdrawAcceptanceOffers (an agent question opens)",
        action: "task.recommendation.withdrawn",
        taskKey: "VIB-1",
        run: async () => {
          const { openAgentQuestionPacket } = await import("~/server/tasks/agent-toolkit.server");
          const { updateTaskFile } = await import("~/server/files/task-writer.server");
          const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
          await updateTaskFile(ref, (parsed) => {
            parsed.packet = null;
            parsed.frontmatter.recommendations = [
              { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion", detail: "" },
            ];
          });
          await openAgentQuestionPacket(store.db, fileCtx, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            actorRef: { kind: "agent", backend: "claude", profileId: "reviewer", roleHint: "Reviewer" },
            title: "Which base branch should this target?",
          });
          await updateTaskFile(ref, (parsed) => {
            parsed.packet = null;
          });
        },
      },
      {
        // Ruling 521: the completion packet the operator writes before it
        // offers a task for acceptance, here over files a run delivered.
        name: "writeCompletionPacket",
        action: "task.completion_packet.written",
        taskKey: "VIB-1",
        run: async () => {
          const { updateTaskFile } = await import("~/server/files/task-writer.server");
          const { writeCompletionPacket } = await import("~/server/tasks/completion-packet.server");
          await updateTaskFile(
            { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
            (parsed) => {
              parsed.frontmatter.deliveredAt = "2026-09-27T09:00:00.000Z";
            },
          );
          await writeCompletionPacket(store.db, fileCtx, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            summary: "The report is written and checked against the goal.",
          });
        },
      },
      {
        // Ruling 488: a relay from one task to another, audited on the target.
        name: "relayToTask",
        action: "task.relayed",
        taskKey: "VIB-2",
        run: async () => {
          const { relayToTask } = await import("~/server/tasks/task-relay.server");
          await relayToTask(store.db, fileCtx, {
            projectSlug: store.slug,
            fromTaskKey: "VIB-1",
            toTaskKey: "VIB-2",
            text: "The numbers VIB-2 waits on.",
            author: {
              actorRef: { kind: "operator" },
              name: "operator",
              auditActor: { userId: null, label: "operator" },
              notifyFrom: { kind: "agent", name: "Operator" },
            },
          });
        },
      },
      {
        name: "appendComment",
        action: "task.comment",
        taskKey: "VIB-1",
        run: () =>
          appendComment(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", text: "hello" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner (take)",
        action: "task.ownership.taken",
        taskKey: "VIB-1",
        run: () =>
          setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.arda.id,
            },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner (hand-off)",
        action: "task.ownership.handed_off",
        taskKey: "VIB-1",
        run: () =>
          setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.murat.id,
            },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "releaseOwner (admin forced)",
        action: "task.ownership.admin_released",
        taskKey: "VIB-1",
        run: () =>
          releaseOwner(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner + releaseOwner (self)",
        action: "task.ownership.released",
        taskKey: "VIB-1",
        run: async () => {
          await setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.murat.id,
            },
            {
              userId: store.users.murat.id,
              label: store.users.murat.email,
            },
            fileCtx,
          );
          await releaseOwner(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            {
              userId: store.users.murat.id,
              label: store.users.murat.email,
            },
            fileCtx,
          );
        },
      },
      {
        name: "transitionStage (triage→ready, approval boundary)",
        action: "task.transition",
        taskKey: "VIB-1",
        run: () =>
          transitionStage(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        // Ruling 157 (pass 35, F35-8): the one lift of a packet-less hold.
        // VIB-1 carries no packet and no dependency list in this store, so a
        // stored `blocked` is the hold shape a dispatch lifts.
        name: "liftHoldForRun (a dispatch lifts a hold)",
        action: "task.hold.lifted",
        taskKey: "VIB-1",
        run: async () => {
          const { liftHoldForRun } = await import("~/server/tasks/task-actions.server");
          const { updateTaskFile } = await import("~/server/files/task-writer.server");
          await updateTaskFile(
            { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
            (parsed) => {
              parsed.frontmatter.readiness = "blocked";
              parsed.frontmatter.blockedBy = [];
            },
          );
          await liftHoldForRun(store.db, fileCtx, store.slug, "VIB-1", {
            kind: "dispatch",
            profileId: "developer",
            name: "Developer",
            by: null,
          });
        },
      },
      {
        name: "resolvePacket (request_edit)",
        action: "task.packet.resolved",
        taskKey: "VIB-2",
        run: () =>
          resolvePacket(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-2", optionIndex: 0 },
            actorArda(),
            fileCtx,
          ),
      },
      {
        // Ruling 161 (pass 35): the discard row now carries `localSha`,
        // `remoteSha` (null for a local-only discard) and the retired revision.
        name: "resolvePacket (discard_branch)",
        action: "task.branch.discarded",
        taskKey: "VIB-3",
        run: () => {
          writeTask(store.dataRoot, store.slug, {
            frontmatter: baseTaskFrontmatter("VIB-3", {
              stage: "review",
              readiness: "ready",
              waiting: "human",
              ownerUserId: store.users.arda.id,
              branch: "vib-3-work",
            }),
            packet: {
              type: "input",
              kind: "Completion report",
              from: "operator",
              title: "Throw the local draft away?",
              body: "vib-3-work was never pushed.",
              observations: [],
              options: [
                { kind: "discard_branch", t: "Discard vib-3-work", d: "", rec: true },
              ],
            },
          });
          rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
          const repoDir = path.join(
            taskDir(store.slug, "VIB-3", store.dataRoot),
            "workspace",
            "viberr",
          );
          rmSync(repoDir, { recursive: true, force: true });
          mkdirSync(repoDir, { recursive: true });
          const git = (args: string[]) =>
            execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
          git(["init", "-q", "-b", "main"]);
          git(["config", "user.email", "t@viberr.local"]);
          git(["config", "user.name", "Test"]);
          writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
          git(["add", "-A"]);
          git(["commit", "-q", "-m", "init"]);
          git(["checkout", "-q", "-b", "vib-3-work"]);
          writeFileSync(path.join(repoDir, "w.txt"), "w\n");
          git(["add", "-A"]);
          git(["commit", "-q", "-m", "work"]);
          git(["checkout", "-q", "main"]);
          return resolvePacket(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-3", optionIndex: 0 },
            actorArda(),
            fileCtx,
          );
        },
      },
      {
        name: "startRun",
        action: "runtime.run.started",
        taskKey: "VIB-1",
        run: () => {
          queueFakeRun({
            lines: [{ t: "1", ev: "text", tag: "assistant", text: "hi" }],
            sessionId: "s",
            keepRunning: true,
          });
          return startRun(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            role: "Primary specialist",
            kind: "primary",
            agentProfileId: "developer",
            credentialUserId: store.users.arda.id,
            backend: "claude",
            model: "m",
            prompt: "go",
            actor: actorArda(),
            dataRoot: store.dataRoot,
          });
        },
      },
      {
        name: "interruptRun",
        action: "runtime.run.interrupted",
        taskKey: "VIB-1",
        run: async () => {
          queueFakeRun({
            lines: [{ t: "1", ev: "text", tag: "assistant", text: "w" }],
            sessionId: "s2",
            keepRunning: true,
          });
          const { runId } = await startRun(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            role: "R",
            kind: "reviewer", // distinct thread — VIB-1 already has a primary
            agentProfileId: "reviewer",
            credentialUserId: store.users.arda.id,
            backend: "claude",
            model: "m",
            prompt: "go",
            dataRoot: store.dataRoot,
          });
          for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
          // D32-18: interruptRun also notes the interrupt on the task timeline,
          // so it is async and needs the store's data root.
          await interruptRun(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", runId, dataRoot: store.dataRoot },
            actorArda(),
          );
        },
      },
      {
        // Ruling 461: a call to an admin-marked MCP write tool, made through
        // Viberr's gateway by a run whose token opens that server.
        name: "an MCP write-tool call through the gateway",
        action: "task.agent.mcp_write_call",
        taskKey: "VIB-1",
        run: async () => {
          const upstream = await startHttpUpstream("audit-sentinel");
          await startMcpGateway({ port: 0 });
          const client = new Client({ name: "agent-cli", version: "1.0.0" });
          try {
            const now = new Date().toISOString();
            store.db
              .prepare(
                `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, tool_policy_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                "mcp_audit",
                "cloudflare",
                "HTTP",
                upstream.url,
                sealSecret("audit-sentinel"),
                JSON.stringify([{ name: "delete_zone", gate: "repo-write" }]),
                now,
                now,
              );
            const resolution = resolveSpecialistMcpServersDetailed(store.db, ["cloudflare"]);
            const mount = z
              .object({ url: z.string(), headers: z.object({ Authorization: z.string() }) })
              .parse(
                bindRunToMcpGateway({
                  db: store.db,
                  runId: "run_audit_gateway",
                  servers: resolution.servers,
                  toolDenials: resolution.toolDenials,
                  actor: { userId: null, label: "agent:claude/developer (Developer)" },
                  projectSlug: store.slug,
                  taskKey: "VIB-1",
                  isLive: () => true,
                }).cloudflare,
              );
            await client.connect(
              new StreamableHTTPClientTransport(new URL(mount.url), {
                requestInit: { headers: mount.headers },
              }),
            );
            await client.callTool({ name: "delete_zone", arguments: {} });
          } finally {
            await client.close();
            await stopMcpGateway();
            await upstream.close();
          }
        },
      },
      {
        name: "openScopeViolation",
        action: "github.scope_violation.opened",
        run: () =>
          openScopeViolation(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            scope: "pull_request:write",
            detail: "audit sweep",
            actor: actorArda(),
          }),
      },
      {
        name: "resolveScopeViolation",
        action: "github.scope_violation.resolved",
        run: () => {
          const { violation } = openScopeViolation(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-2",
            scope: "repo",
            actor: actorArda(),
          });
          resolveScopeViolation(store.db, violation.id, actorArda());
        },
      },
      {
        // Ruling 128 (pass 34): an empty repository is bootstrapped, and the
        // repository-level write is audited like a credential assignment.
        name: "ensureDefaultBranch (bootstraps an empty repository)",
        action: "github.repo.bootstrapped",
        taskKey: "VIB-1",
        run: async () => {
          const { fakeGithubFetch } = await import("../../../test-support/fake-github");
          const { createPat, setProjectCredential } = await import(
            "~/server/secrets/pat-store.server"
          );
          const { getProjectGithubContext } = await import("~/server/github/github-context.server");
          const { ensureDefaultBranch } = await import("~/server/github/repo-bootstrap.server");
          const patActor = { userId: store.users.arda.id, label: store.users.arda.email };
          const pat = createPat(
            store.db,
            { userId: store.users.arda.id, label: "bot", token: "ghp_coverage000000000000000000000002" },
            patActor,
          );
          setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
          let bootstrapped = false;
          const gh = fakeGithubFetch({
            "GET /repos/akin-ozer/viberr/git/ref/heads/main": () =>
              bootstrapped
                ? { body: { object: { sha: "d".repeat(40) } } }
                : { status: 409, body: { message: "Git Repository is empty." } },
            "GET /repos/akin-ozer/viberr/branches": { body: [] },
            "PUT /repos/akin-ozer/viberr/contents/README.md": () => {
              bootstrapped = true;
              return { status: 201, body: { commit: { sha: "d".repeat(40) } } };
            },
          });
          const context = getProjectGithubContext(store.db, store.slug, { fetchImpl: gh.fetchImpl });
          if (context.status !== "ok") throw new Error(context.status);
          await ensureDefaultBranch(
            store.db,
            context,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            patActor,
            { dataRoot: store.dataRoot },
          );
        },
      },
      {
        // Pass 34 (F34-9): a PR adoption is recorded by every door.
        name: "recordPrAdoption (a human-opened PR replaces the task's closed one)",
        action: "github.pr.adopted",
        taskKey: "VIB-1",
        run: async () => {
          const { recordPrAdoption } = await import("~/server/github/pr-adoption-record.server");
          await recordPrAdoption(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
            {
              repo: "akin-ozer/viberr",
              branch: "vib-1",
              prNumber: 6,
              previousPrNumber: 5,
              previousState: "closed",
              headSha: "e".repeat(40),
              source: "reconciler",
            },
            { userId: null, label: "system:policy-engine" },
          );
        },
      },
      {
        // C05-H (pass 32): the collision remedy's PR close was locked only in
        // task-governance; the designated coverage file names it too.
        name: "resolveRemoteBranchCollision (closes the unowned PR)",
        action: "github.pr.closed_unowned",
        taskKey: "VIB-1",
        run: async () => {
          const { fakeGithubFetch } = await import("../../../test-support/fake-github");
          const { createPat, setProjectCredential } = await import(
            "~/server/secrets/pat-store.server"
          );
          const { resolveRemoteBranchCollision } = await import(
            "~/server/github/github-reconciler.server"
          );
          const patActor = { userId: store.users.arda.id, label: store.users.arda.email };
          const pat = createPat(
            store.db,
            { userId: store.users.arda.id, label: "bot", token: "ghp_coverage000000000000000000000001" },
            patActor,
          );
          setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
          writeTask(store.dataRoot, store.slug, {
            frontmatter: baseTaskFrontmatter("VIB-1", {
              stage: "review",
              branch: "vib-1-work",
              github: { commits: [], changed: null, unownedPr: 232 },
            }),
          });
          rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
          const github = fakeGithubFetch({
            "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
            "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
          });
          await resolveRemoteBranchCollision(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actorArda(),
            { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
          );
        },
      },
      ...(["updated", "update_failed"] as const).map(
        (outcome): CoverageRow => ({
          // Ruling 474: a re-delivery brings the reused PR's body up to date,
          // and a PATCH GitHub refuses is recorded too.
          name: `openTaskPr (a reused PR's body, ${outcome === "updated" ? "rewritten" : "refused"})`,
          action: `github.pr.body_${outcome}`,
          taskKey: "VIB-74",
          run: async () => {
            const { fakeGithubFetch } = await import("../../../test-support/fake-github");
            const { createPat, setProjectCredential } = await import(
              "~/server/secrets/pat-store.server"
            );
            const { openTaskPr } = await import("~/server/github/pr-open.server");
            const patActor = { userId: store.users.arda.id, label: store.users.arda.email };
            const pat = createPat(
              store.db,
              {
                userId: store.users.arda.id,
                label: "bot",
                token: `ghp_coverage0000000000000000000474${outcome === "updated" ? "0" : "1"}`,
              },
              patActor,
            );
            setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
            writeTask(store.dataRoot, store.slug, {
              frontmatter: baseTaskFrontmatter("VIB-74", {
                stage: "review",
                branch: "vib-74-work",
                pr: { number: 74, state: "review", title: "[VIB-74] work" },
                workRevision: {
                  id: "rev_74",
                  headSha: "f".repeat(40),
                  treeSha: null,
                  branch: "vib-74-work",
                  createdAt: "2026-09-25T08:00:00.000Z",
                  sourceProfileId: "developer",
                },
              }),
            });
            rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
            const github = fakeGithubFetch({
              "GET /repos/akin-ozer/viberr/pulls/74": {
                body: {
                  number: 74,
                  html_url: "https://github.com/akin-ozer/viberr/pull/74",
                  title: "[VIB-74] work",
                  state: "open",
                  head: { sha: "f".repeat(40) },
                  body: "An older description.",
                },
              },
              "PATCH /repos/akin-ozer/viberr/pulls/74":
                outcome === "updated"
                  ? { body: { number: 74 } }
                  : { status: 422, body: { message: "Validation Failed" } },
            });
            await openTaskPr(
              store.db,
              { projectSlug: store.slug, taskKey: "VIB-74" },
              actorArda(),
              { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
            );
          },
        }),
      ),
      {
        // Ruling 136: one row per collision ceremony with its typed outcome.
        // No credential here, so the ceremony refuses (`no_context`) and is
        // still audited; the fuller arms are locked in task-governance and
        // delivery-actionable, which supply `fetchImpl` and the delivery deps.
        name: "resolvePacket (resolve_remote_collision ceremony)",
        action: "github.collision.resolved",
        taskKey: "VIB-77",
        run: async () => {
          writeTask(store.dataRoot, store.slug, {
            frontmatter: baseTaskFrontmatter("VIB-77", {
              stage: "review",
              waiting: "human",
              readiness: "blocked",
              branch: "vib-1-work",
              github: { commits: [], changed: null, unownedPr: 232 },
            }),
            packet: {
              type: "blocked",
              kind: "Blocked decision",
              from: "operator",
              title: "Branch vib-1-work collides with an unrelated remote branch",
              body: "b",
              observations: [],
              options: [
                { kind: "resolve_remote_collision", t: "Delete the stale remote branch, then redeliver", d: "", rec: true },
              ],
            },
          });
          rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
          await resolvePacket(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-77", optionIndex: 0 },
            actorArda(),
            { dataRoot: store.dataRoot },
          );
        },
      },
      {
        // F34-3: a pre-dispatch branch preparation failure is audited.
        name: "ensureTaskBranchBestEffort (network failure before dispatch)",
        action: "github.branch.prepare_failed",
        taskKey: "VIB-1",
        run: async () => {
          const { unreachableFetch } = await import("../../../test-support/fake-github");
          const { createPat, setProjectCredential } = await import(
            "~/server/secrets/pat-store.server"
          );
          const { ensureTaskBranchBestEffort } = await import("~/server/github/branch-sync.server");
          const patActor = { userId: store.users.arda.id, label: store.users.arda.email };
          const pat = createPat(
            store.db,
            { userId: store.users.arda.id, label: "bot", token: "ghp_coverage000000000000000000000003" },
            patActor,
          );
          setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
          await ensureTaskBranchBestEffort(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actorArda(),
            { dataRoot: store.dataRoot, fetchImpl: unreachableFetch() },
          );
        },
      },
      {
        name: "revalidateProjectCredential (grant-scope attempt, no PAT)",
        action: "github.credential.revalidated",
        run: () =>
          revalidateProjectCredential(store.db, store.slug, actorArda(), {
            dataRoot: store.dataRoot,
          }),
      },
      {
        // Ruling 127: connecting and disconnecting a PERSONAL agent account is
        // governed — it changes whose provider account this instance's runs
        // bill — so both leave an audit row. Instance-wide: a personal
        // credential belongs to no project and no task.
        name: "setBackendApiKey (personal Claude key)",
        action: "profile.backend.connected",
        instanceWide: true,
        run: () =>
          setBackendApiKey(
            store.db,
            actorArda(),
            "claude",
            "api_key",
            "sk-ant-api03-audit-sweep-key",
            { fetchImpl: acceptingProvider },
          ),
      },
      {
        name: "disconnectBackendAccount",
        action: "profile.backend.disconnected",
        instanceWide: true,
        run: async () => {
          const row = await setBackendApiKey(
            store.db,
            actorArda(),
            "codex",
            "api_key",
            "sk-proj-audit-sweep-key",
            { fetchImpl: acceptingProvider },
          );
          await disconnectBackendAccount(store.db, actorArda(), row.id, {
            dataRoot: store.dataRoot,
          });
        },
      },
      {
        // Ruling 507: which of a person's accounts bills their runs is the
        // same governed fact as connecting one, so switching leaves a row too.
        name: "switchBackendAccount",
        action: "profile.backend.switched",
        instanceWide: true,
        run: async () => {
          const first = await setBackendApiKey(
            store.db,
            actorArda(),
            "codex",
            "api_key",
            "sk-proj-audit-sweep-first",
            { fetchImpl: acceptingProvider },
          );
          await setBackendApiKey(
            store.db,
            actorArda(),
            "codex",
            "api_key",
            "sk-proj-audit-sweep-second",
            { fetchImpl: acceptingProvider },
          );
          switchBackendAccount(store.db, actorArda(), first.id, { dataRoot: store.dataRoot });
        },
      },
      {
        name: "renameBackendAccount",
        action: "profile.backend.renamed",
        instanceWide: true,
        run: async () => {
          const row = await setBackendApiKey(
            store.db,
            actorArda(),
            "claude",
            "api_key",
            "sk-ant-api03-audit-sweep-named",
            { fetchImpl: acceptingProvider },
          );
          renameBackendAccount(store.db, actorArda(), row.id, "Work");
        },
      },
      {
        // Ruling 127: a hosted sign-in is a governed action at every step. The
        // vendor's own binary is spawned here (a fake executable), so what the
        // sweep proves is the DRIVER's audit trail, not a stub's.
        name: "startBackendLogin",
        action: "profile.backend.login_started",
        instanceWide: true,
        run: () => {
          setFakeVendorMode("hang");
          startBackendLogin(store.db, actorArda(), "claude", "claudeai", {
            binaries: vendors.binaries,
            dataRoot: store.dataRoot,
          });
        },
      },
      {
        name: "cancelBackendLogin",
        action: "profile.backend.login_cancelled",
        instanceWide: true,
        run: () => {
          setFakeVendorMode("hang");
          startBackendLogin(store.db, actorArda(), "codex", "device", {
            binaries: vendors.binaries,
            dataRoot: store.dataRoot,
          });
          cancelBackendLogin(store.db, actorArda(), "codex");
        },
      },
      {
        // The timeout is the failure path a person is most likely to meet, and
        // the one nothing else would notice: it is audited by a TIMER, with no
        // request in flight to carry the news.
        name: "startBackendLogin (timed out)",
        action: "profile.backend.login_failed",
        instanceWide: true,
        run: async () => {
          setFakeVendorMode("hang");
          startBackendLogin(store.db, actorArda(), "claude", "console", {
            binaries: vendors.binaries,
            dataRoot: store.dataRoot,
            timeoutMs: 40,
          });
          const deadline = Date.now() + 5_000;
          while (
            listAuditEvents(store.db, {
              action: "profile.backend.login_failed",
            }).length === 0 &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        },
      },
      {
        name: "rescanProjections",
        action: "projection.rescan",
        instanceWide: true,
        run: () =>
          rescanProjections(store.db, {
            dataRoot: store.dataRoot,
            actor: actorArda(),
          }),
      },
      {
        name: "rebuildProjections (full drop + rebuild)",
        action: "projection.rebuild",
        instanceWide: true,
        run: () =>
          rebuildProjections(store.db, {
            dataRoot: store.dataRoot,
            actor: actorArda(),
          }),
      },
      {
        // Ruling 462: a repository created on GitHub for a project being
        // created. Its row names the NEW project, not the fixture's.
        name: "createProject (createRepository: a missing repository is created)",
        action: "project.repository.created",
        projectSlug: "audit-site",
        run: async () => {
          const { fakeGithubFetch } = await import("../../../test-support/fake-github");
          const { createPat } = await import("~/server/secrets/pat-store.server");
          const { createProject } = await import("~/features/home/project-create.server");
          const pat = createPat(
            store.db,
            { userId: store.users.arda.id, label: "connection · audit-org", token: "ghp_coverage000000000000000000000462" },
            actorArda(),
          );
          const now = new Date().toISOString();
          store.db
            .prepare(
              `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
               VALUES (?, ?, ?, 0, ?, ?)`,
            )
            .run("audit-org", "audit-org", pat.id, now, now);
          let created = false;
          const gh = fakeGithubFetch({
            "GET /repos/audit-org/audit-site": () =>
              created
                ? { body: { default_branch: "main", permissions: { push: true } } }
                : { status: 404, body: { message: "Not Found" } },
            "POST /orgs/audit-org/repos": () => {
              created = true;
              return { status: 201, body: { full_name: "audit-org/audit-site" } };
            },
          });
          await createProject(
            store.db,
            {
              name: "Audit Site",
              key: "AUS",
              owner: "audit-org",
              repoName: "audit-site",
              policy: "balanced",
              createRepository: { private: true },
            },
            actorArda(),
            { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
          );
        },
      },
      {
        // Ruling 463: Re-check on a GitHub connection's card re-validates the
        // stored token and re-reads what it reaches. Instance-wide.
        name: "recheckConnection",
        action: "org.connection.rechecked",
        instanceWide: true,
        run: async () => {
          const { fakeGithubFetch } = await import("../../../test-support/fake-github");
          const { createConnection, recheckConnection } = await import(
            "~/server/org/connections.server"
          );
          const gh = fakeGithubFetch({
            "GET /user": { body: { login: "audit-reach" }, headers: { "x-oauth-scopes": "repo" } },
            "GET /users/audit-reach": { body: {} },
            "GET /user/repos": { body: [] },
          });
          await createConnection(
            store.db,
            { owner: "audit-reach", token: "ghp_auditreach00000000000000000463", userId: store.users.arda.id },
            actorArda(),
            { fetchImpl: gh.fetchImpl },
          );
          await recheckConnection(store.db, "audit-reach", actorArda(), {
            fetchImpl: gh.fetchImpl,
          });
        },
      },
      {
        // Ruling 464: the controller's `remove_agent_deployment` reaches the
        // Agents page's own removal, with its reason and the open-engagement
        // refusal, and records the page's own audit action.
        name: "deleteAgentProfile (the controller's removal, with a reason)",
        action: "project.agent_profile.deleted",
        run: async () => {
          seedDefaultAgentAssets(store.dataRoot);
          writeFileSync(
            path.join(store.dataRoot, "agents", "profiles", "audit-removal.md"),
            "---\nid: audit-removal\nkind: specialist\nname: Audit Removal\nrole: Docs\nbackends:\n  - claude\nmodel: sonnet\nstages:\n  - impl\n---\n\nA probe.\n",
            "utf8",
          );
          await deployAgentProfileFromLibrary(
            store.db,
            { projectSlug: store.slug, profileId: "audit-removal" },
            actorArda(),
            fileCtx,
          );
          const { deleteAgentProfile } = await import(
            "~/features/agents/agent-profile-actions.server"
          );
          await deleteAgentProfile(
            store.db,
            {
              projectSlug: store.slug,
              profileId: "audit-removal",
              reason: "Not in the designed roster.",
              refuseOpenEngagements: true,
            },
            actorArda(),
            fileCtx,
          );
        },
      },
      {
        // Ruling 156 (pass 35): a template's grants copied onto a project's
        // deployment, one row per project.
        name: "propagateTemplateResources",
        action: "project.agent_profile.resources_synced",
        run: async () => {
          seedDefaultAgentAssets(store.dataRoot);
          rebuildAll(store.db, fileCtx);
          await deployAgentProfileFromLibrary(
            store.db,
            { projectSlug: store.slug, profileId: "developer" },
            actorArda(),
            fileCtx,
          );
          await saveGlobalAgentProfile(
            store.db,
            {
              id: "developer",
              name: "Developer",
              backend: "claude",
              summary: "Implements the change.",
              persona: "",
              stages: ["ready", "impl"],
              mcps: ["github"],
            },
            actorArda(),
            fileCtx,
          );
          await propagateTemplateResources(
            store.db,
            { profileId: "developer", projectSlugs: [store.slug] },
            actorArda(),
            fileCtx,
          );
        },
      },
      {
        // Ruling 482: the project's gates (Settings → Gates, the controller's
        // set_project_gates).
        name: "setProjectGates",
        action: "project.gates.updated",
        run: async () => {
          const { setProjectGates } = await import(
            "~/features/project-settings/settings-actions.server"
          );
          await setProjectGates(
            store.db,
            { projectSlug: store.slug, gates: [{ name: "build", command: "true" }] },
            actorArda(),
            fileCtx,
          );
        },
      },
      {
        // Ruling 482: a person asks Viberr to run the gates again.
        name: "runProjectGatesByHand",
        action: "task.gates.requested",
        taskKey: "VIB-2",
        run: async () => {
          const { runProjectGatesByHand } = await import("~/server/tasks/task-delivery.server");
          await runProjectGatesByHand(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-2" },
            actorArda(),
            fileCtx,
          );
        },
      },
      {
        // Ruling 525: a person deletes a controller conversation, here their
        // own thread anchored to a task, so the row names the task it was
        // about.
        name: "deleteControllerConversation",
        action: "controller.conversation.deleted",
        taskKey: "VIB-1",
        run: async () => {
          const { createConversation } = await import(
            "~/server/controller/controller-conversations.server"
          );
          const { deleteControllerConversation } = await import(
            "~/server/controller/controller-deletion.server"
          );
          const conversation = createConversation(store.db, {
            userId: store.users.arda.id,
            userLabel: store.users.arda.email,
            projectSlug: store.slug,
            taskKey: "VIB-1",
          });
          deleteControllerConversation(
            store.db,
            { conversationId: conversation.id, projectSlug: store.slug, dataRoot: store.dataRoot },
            actorArda(),
          );
        },
      },
      // Ruling 469: an MCP connection's OAuth sign-in, against the in-test
      // authorization server. Instance-wide: the registry is org-level.
      ...(["org.mcp.oauth_connected", "org.mcp.oauth_failed", "org.mcp.oauth_signed_out"] as const).map(
        (action): CoverageRow => ({
          name: `MCP OAuth sign-in (${action})`,
          action,
          instanceWide: true,
          run: async () => {
            const oauth = await startOAuthMcpServer(
              action === "org.mcp.oauth_failed" ? { consent: "deny" } : {},
            );
            try {
              const id = `mcp_${action.replace(/\W/g, "_")}`;
              const now = new Date().toISOString();
              store.db
                .prepare(
                  `INSERT INTO org_mcp_servers (id, name, transport, target, created_at, updated_at)
                   VALUES (?, ?, 'HTTP', ?, ?, ?)`,
                )
                .run(id, id.replace(/_/g, "-"), oauth.url, now, now);
              await signInWithOAuth(store.db, id);
              if (action === "org.mcp.oauth_signed_out") {
                await signOutMcpOAuth(store.db, id, actorArda());
              }
            } finally {
              resetMcpOAuthForTests();
              await oauth.close();
            }
          },
        }),
      ),
    ];

    for (const row of table) {
      const before = listAuditEvents(store.db, { action: row.action }).length;
      await row.run();
      const rows = listAuditEvents(store.db, { action: row.action });
      expect(
        rows.length,
        `${row.name} did not record audit action ${row.action}`,
      ).toBeGreaterThan(before);

      const newest = rows[0]!;
      expect(
        newest.projectSlug,
        `${row.name}: ${row.action} must carry projectSlug`,
      ).toBe(row.instanceWide ? null : (row.projectSlug ?? store.slug));
      const taskless = [
        "github.credential.revalidated",
        "projection.rescan",
        "projection.rebuild",
        // Ruling 127: a person's own agent account, connected on their profile.
        "profile.backend.connected",
        "profile.backend.disconnected",
        "profile.backend.login_started",
        "profile.backend.login_failed",
        "profile.backend.login_cancelled",
        // Ruling 507: which of those accounts runs bill, and its name.
        "profile.backend.switched",
        "profile.backend.renamed",
        // Ruling 156: a project-scoped row with no task.
        "project.agent_profile.resources_synced",
        // Ruling 462: the repository a new project is created with.
        "project.repository.created",
        // Ruling 463: a GitHub connection belongs to the instance.
        "org.connection.rechecked",
        // Ruling 464: a deployment taken off a project's roster.
        "project.agent_profile.deleted",
        // Ruling 469: an org MCP connection's OAuth sign-in.
        "org.mcp.oauth_connected",
        "org.mcp.oauth_failed",
        "org.mcp.oauth_signed_out",
        // Ruling 482: the project's gate list, a project-scoped row.
        "project.gates.updated",
      ].includes(row.action);
      if (!taskless) {
        expect(
          newest.taskKey,
          `${row.name}: ${row.action} must carry taskKey`,
        ).toBeTruthy();
        if (row.taskKey) expect(newest.taskKey).toBe(row.taskKey);
      }
      expect(newest.actorLabel.length).toBeGreaterThan(0);
    }
  });
});
