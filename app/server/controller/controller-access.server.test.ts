import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import { callToolText } from "../../../test-support/mcp-tool-meta";
import type { JsonValue } from "~/features/runtime/runtime-types";

/**
 * Ruling 99/100 — the controller's THREE access chokepoints, driven directly.
 *
 * `canAccessConversation` and `canReadControllerRunLog` are the two predicates
 * every controller read funnels through (the dock loader, the controller
 * surface, `/resources/run-log`, `/resources/session-export`, and the
 * `viberr_ops.read_run_log` diagnostic), and `get_github_state` was the one
 * tool of the 38 in `viberr_controller` with no test anywhere. Nothing in the
 * suite called the two predicates by name, so their guards could be deleted
 * and every gate would stay green — ruling 65: "an owner ruling whose guard
 * cannot go red is a ruling that gets reverted in silence."
 *
 * What they guarantee:
 *
 *  - A conversation belongs to the person who started it. That person reads
 *    it. A LIVE-resolved org admin reads it (supervision). PROJECT MEMBERS DO
 *    NOT — a transcript is scoped to what ITS user was entitled to hear, which
 *    is not a project-level entitlement, so the project admin of the very
 *    board the conversation is bound to gets nothing.
 *  - A non-owner's refusal is 404-SHAPED and byte-identical to "never
 *    existed", so a probe cannot walk conversation ids (the members-only
 *    posture, R15-4).
 *  - A controller run's log follows CONVERSATION ownership, never project
 *    membership, and the same refusal shape holds on the wire.
 *  - `get_github_state` is a project READ behind the any-member gate, and a
 *    project the asker cannot see answers the toolkit's uniform not-visible
 *    sentence rather than admitting the project exists.
 *
 * Fixture roles on viberr-core (demo seed): selin = contributor (she owns the
 * conversation under test), elif = project ADMIN, arda = project admin + ORG
 * admin, deniz = org member and a member of nothing. Two org admins who are
 * members of NOTHING are added in setup: one never mutated, one whose org role
 * is moved around to prove the checks resolve live.
 */

let app: AppTestContext;

const SLUG = "viberr-core";
const REPO = "akin-ozer/viberr";
/** A controller turn on `owner`'s conversation. */
const CONTROLLER_RUN = "run_acc_controller";
/** A controller turn pointing at a conversation that is not there. */
const DANGLING_RUN = "run_acc_dangling";
/**
 * A PROJECT run whose `task_key` is deliberately set to the owner's
 * conversation id. Nothing in the app writes such a row; it exists so the
 * `kind !== "controller"` bail-out has something that would otherwise resolve.
 */
const PROJECT_RUN = "run_acc_project";
/** A run id that was never inserted. */
const GHOST_RUN = "run_acc_ghost";
const LOG_LINES = 6;

interface Actors {
  owner: string; // selin — contributor on viberr-core, owns the conversation
  projectAdmin: string; // elif — project ADMIN of the bound project
  orgAdmin: string; // arda — org admin AND project admin
  nonMember: string; // deniz — org member, member of nothing
  outsiderAdmin: string; // org admin, member of nothing, never mutated
  mutableAdmin: string; // org admin whose role/disabled flag the live tests move
}
let ids: Actors;
/** The conversation every access assertion below is about. */
let conversationId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });

  const { insertUser } = await import("~/server/auth/user-store.server");
  const outsider = insertUser(app.db, {
    id: "u_acc_outsider_admin",
    email: "outsider-admin@viberr.test",
    name: "Outsider Admin",
    role: "admin",
  });
  const mutable = insertUser(app.db, {
    id: "u_acc_mutable_admin",
    email: "mutable-admin@viberr.test",
    name: "Mutable Admin",
    role: "admin",
  });
  ids = {
    owner: userIds.selin,
    projectAdmin: userIds.elif,
    orgAdmin: userIds.arda,
    nonMember: userIds.deniz,
    outsiderAdmin: outsider.id,
    mutableAdmin: mutable.id,
  };

  const { createConversation } = await import(
    "./controller-conversations.server"
  );
  // Bound to viberr-core ON PURPOSE: the board binding is exactly what a
  // "project members can read it" regression would key off.
  conversationId = createConversation(app.db, {
    userId: ids.owner,
    userLabel: "selin@viberr.dev",
    projectSlug: SLUG,
  }).id;

  const { insertRunLine, upsertRun } = await import(
    "~/server/runtimes/run-store.server"
  );
  upsertRun(app.db, {
    id: CONTROLLER_RUN,
    // Ruling 99's controller scope: no project, `task_key` = conversation id.
    projectSlug: "",
    taskKey: conversationId,
    threadId: "thread_acc_controller",
    role: "Controller",
    kind: "controller",
    agentProfileId: "controller",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "finished",
  });
  upsertRun(app.db, {
    id: DANGLING_RUN,
    projectSlug: "",
    taskKey: "cnv_never_existed",
    threadId: "thread_acc_dangling",
    role: "Controller",
    kind: "controller",
    agentProfileId: "controller",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "error",
  });
  upsertRun(app.db, {
    id: PROJECT_RUN,
    projectSlug: SLUG,
    taskKey: conversationId,
    threadId: "thread_acc_project",
    role: "developer",
    kind: "primary",
    agentProfileId: "developer",
    agentName: "dev",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "finished",
  });
  for (const runId of [CONTROLLER_RUN, DANGLING_RUN, PROJECT_RUN]) {
    for (let i = 0; i < LOG_LINES; i += 1) {
      insertRunLine(app.db, {
        runId,
        seq: i,
        occurredAt: "2026-09-03T00:00:00.000Z",
        raw: JSON.stringify({ i }),
        display: { t: "00:00:00", ev: "text", tag: "assistant", text: `l${i}` },
      });
    }
  }
});
afterAll(() => app.cleanup());

/** The conversation row every predicate call below is handed. */
async function conversation() {
  const { getConversation } = await import("./controller-conversations.server");
  return getConversation(app.db, conversationId)!;
}

/** `canAccessConversation` for one asker, with the org role their SESSION claims. */
async function mayRead(
  userId: string,
  orgRole: "admin" | "member",
): Promise<boolean> {
  const { canAccessConversation } = await import(
    "./controller-conversations.server"
  );
  return canAccessConversation(app.db, await conversation(), {
    userId,
    orgRole,
  });
}

/** `canReadControllerRunLog` for one asker, against a stored run row. */
async function mayReadLog(userId: string, runId: string): Promise<boolean> {
  const [{ canReadControllerRunLog }, { getRun }] = await Promise.all([
    import("./controller-conversations.server"),
    import("~/server/runtimes/run-store.server"),
  ]);
  const run = getRun(app.db, runId);
  expect(run, `run ${runId} must exist for this assertion to mean anything`)
    .not.toBeNull();
  return canReadControllerRunLog(app.db, run!, { id: userId });
}

// ------------------------------------------------- canAccessConversation

describe("canAccessConversation: a transcript belongs to ONE person", () => {
  /**
   * The base grant. It is stated for BOTH session claims because the owner's
   * access must not depend on the org role the session happens to carry — a
   * regression that made ownership fall through to the admin branch would
   * still pass a member-only assertion.
   */
  it("the owner reads their own conversation whatever their session claims", async () => {
    expect(await mayRead(ids.owner, "member")).toBe(true);
    expect(await mayRead(ids.owner, "admin")).toBe(true);
  });

  /**
   * THE ruling-99 line, and the one most likely to be "fixed" by someone who
   * assumes a board-bound conversation is board-readable: elif is the PROJECT
   * ADMIN of viberr-core, the very project this conversation is bound to, and
   * she reads nothing. Project authority buys no transcript access; a
   * transcript is scoped to what its user was entitled to hear.
   */
  it("a project admin of the bound board reads NOTHING; supervision is org-level", async () => {
    expect(await mayRead(ids.projectAdmin, "member")).toBe(false);
    expect(await mayRead(ids.nonMember, "member")).toBe(false);
    // Org admins supervise — including one who is a member of no project at
    // all, which is what makes this org-level and not a project override.
    expect(await mayRead(ids.orgAdmin, "admin")).toBe(true);
    expect(await mayRead(ids.outsiderAdmin, "admin")).toBe(true);
  });

  /**
   * The session's `orgRole` is a HINT, never the authority: the check resolves
   * the role LIVE against the users table so a role revoked mid-session binds
   * immediately, and a claim nobody granted confers nothing. Both directions
   * are asserted because only one of them is the security-relevant one and
   * only the other is the availability-relevant one.
   */
  it("the admin claim is resolved live, in both directions", async () => {
    const { updateUserFields } = await import("~/server/auth/user-store.server");

    // A member CLAIMING admin gets nothing: the claim is not the grant.
    expect(await mayRead(ids.projectAdmin, "admin")).toBe(false);

    // A real org admin whose session still says "member" gets nothing either.
    // Both halves must agree, so the guard never hands out more authority than
    // the session it is answering actually carries.
    expect(await mayRead(ids.mutableAdmin, "member")).toBe(false);

    // Granted while the role is real…
    expect(await mayRead(ids.mutableAdmin, "admin")).toBe(true);
    // …and revoked the instant the row changes, with the STALE claim intact:
    // this is the whole reason the predicate takes `db`.
    updateUserFields(app.db, ids.mutableAdmin, { role: "member" });
    expect(await mayRead(ids.mutableAdmin, "admin")).toBe(false);
    updateUserFields(app.db, ids.mutableAdmin, { role: "admin" });
    expect(await mayRead(ids.mutableAdmin, "admin")).toBe(true);

    // A disabled account is not an admin (`isOrgAdmin` filters `disabled = 0`),
    // so deactivating someone closes their supervision window too.
    updateUserFields(app.db, ids.mutableAdmin, { disabled: true });
    expect(await mayRead(ids.mutableAdmin, "admin")).toBe(false);
    updateUserFields(app.db, ids.mutableAdmin, { disabled: false });
    expect(await mayRead(ids.mutableAdmin, "admin")).toBe(true);
  });

  /**
   * The refusal SHAPE, which is the half a boolean cannot express. "Not yours"
   * and "never existed" have to be the same answer or a probe can enumerate
   * conversation ids by watching which ones refuse differently. Asserted as an
   * equality between the two thrown errors rather than a regex, because a
   * regex passes on two different sentences that both say "not found".
   */
  it("requireConversation: 'not yours' and 'never existed' are the SAME refusal", async () => {
    const { requireConversation } = await import(
      "./controller-conversations.server"
    );
    const { AppError } = await import("~/server/errors/app-error.server");

    /** The refusal one asker gets for one id, reduced to what a caller sees. */
    const refusalFor = (userId: string, id: string) => {
      const refusal = (() => {
        try {
          requireConversation(app.db, id, { userId, orgRole: "member" });
          return null;
        } catch (error) {
          expect(error).toBeInstanceOf(AppError);
          // SAFETY: the assertion immediately above establishes the instance.
          const appError = error as InstanceType<typeof AppError>;
          return {
            status: appError.status,
            code: appError.code,
            message: appError.userMessage,
          };
        }
      })();
      // A silent grant is the failure this whole test exists to catch, so it
      // must read as one rather than as a confusing null dereference below.
      expect(refusal, `${userId} must be refused ${id}`).not.toBeNull();
      return refusal!;
    };

    // A real conversation the asker does not own…
    const forbidden = refusalFor(ids.projectAdmin, conversationId);
    // …and an id that was never issued, asked by the OWNER herself.
    const missing = refusalFor(ids.owner, "cnv_never_issued");

    expect(forbidden.status).toBe(404);
    expect(forbidden).toEqual(missing);
    // And the sentence discloses nothing about the thing it is hiding.
    expect(forbidden.message).not.toContain(conversationId);
    expect(forbidden.message).not.toContain("selin");
    expect(forbidden.message).not.toContain(SLUG);
  });
});

// ---------------------------------------------- canReadControllerRunLog

describe("canReadControllerRunLog: the log follows the conversation", () => {
  /**
   * Same ownership rule as the transcript, one level down: the raw log of a
   * controller turn carries the tool calls and prompts of that turn, so it is
   * readable by the conversation's owner and by org admins, and by nobody
   * else. Note this predicate takes NO session claim at all — there is nothing
   * to resolve against but the database.
   */
  it("the owner and a live org admin read the turn; the project admin does not", async () => {
    expect(await mayReadLog(ids.owner, CONTROLLER_RUN)).toBe(true);
    expect(await mayReadLog(ids.orgAdmin, CONTROLLER_RUN)).toBe(true);
    expect(await mayReadLog(ids.outsiderAdmin, CONTROLLER_RUN)).toBe(true);
    expect(await mayReadLog(ids.projectAdmin, CONTROLLER_RUN)).toBe(false);
    expect(await mayReadLog(ids.nonMember, CONTROLLER_RUN)).toBe(false);
  });

  /** Supervision is live here too: demote the admin, the log closes. */
  it("supervision ends when the org role does", async () => {
    const { updateUserFields } = await import("~/server/auth/user-store.server");
    expect(await mayReadLog(ids.mutableAdmin, CONTROLLER_RUN)).toBe(true);
    updateUserFields(app.db, ids.mutableAdmin, { role: "member" });
    expect(await mayReadLog(ids.mutableAdmin, CONTROLLER_RUN)).toBe(false);
    updateUserFields(app.db, ids.mutableAdmin, { role: "admin" });
    expect(await mayReadLog(ids.mutableAdmin, CONTROLLER_RUN)).toBe(true);
  });

  /**
   * The bail-out that keeps this predicate from becoming a SECOND door onto
   * project runs. Callers ask it FIRST and fall through to the project
   * membership gate only when it says no (resources.run-log.ts, the ops MCP),
   * so a `true` here skips membership entirely. `PROJECT_RUN` carries the
   * owner's own conversation id in `task_key` — the exact row that would
   * resolve if the `kind` check were dropped — and even she must be refused:
   * her authority over that run is her project membership, checked elsewhere.
   */
  it("answers only for controller runs — it is never a door onto a project run", async () => {
    expect(await mayReadLog(ids.owner, PROJECT_RUN)).toBe(false);
    expect(await mayReadLog(ids.orgAdmin, PROJECT_RUN)).toBe(false);
  });

  /**
   * A controller run whose conversation is gone must fail CLOSED. The tempting
   * shape ("no conversation, so nobody owns it, so there is nothing to
   * protect") turns every deleted conversation's transcript into a public run
   * log, and controller logs carry raw tool output.
   */
  it("a controller run with no conversation behind it refuses EVERYONE", async () => {
    expect(await mayReadLog(ids.owner, DANGLING_RUN)).toBe(false);
    expect(await mayReadLog(ids.orgAdmin, DANGLING_RUN)).toBe(false);
    expect(await mayReadLog(ids.outsiderAdmin, DANGLING_RUN)).toBe(false);
  });
});

// ---------------------------------------------- canInterruptControllerRun

/** `canInterruptControllerRun` for one asker, against a stored run row. */
async function mayInterrupt(userId: string, runId: string): Promise<boolean> {
  const [{ canInterruptControllerRun }, { getRun }] = await Promise.all([
    import("./controller-conversations.server"),
    import("~/server/runtimes/run-store.server"),
  ]);
  const run = getRun(app.db, runId);
  expect(run, `run ${runId} must exist for this assertion to mean anything`)
    .not.toBeNull();
  return canInterruptControllerRun(app.db, run!, { id: userId });
}

describe("canInterruptControllerRun: stopping a turn follows the conversation too", () => {
  /**
   * The run engine's `interruptRun` gates a task run on project membership
   * (`run-agents`), which a controller run has none of: before this predicate
   * the engine answered every controller interrupt with an empty member map,
   * i.e. a refusal for the owner of the very turn. Same two people as the
   * log, stated separately (a widening of one is a decision about that one).
   */
  it("the owner and a live org admin may stop the turn; a project admin may not", async () => {
    expect(await mayInterrupt(ids.owner, CONTROLLER_RUN)).toBe(true);
    expect(await mayInterrupt(ids.orgAdmin, CONTROLLER_RUN)).toBe(true);
    expect(await mayInterrupt(ids.outsiderAdmin, CONTROLLER_RUN)).toBe(true);
    expect(await mayInterrupt(ids.projectAdmin, CONTROLLER_RUN)).toBe(false);
    expect(await mayInterrupt(ids.nonMember, CONTROLLER_RUN)).toBe(false);
  });

  it("answers only for controller runs, and fails closed on a dangling one", async () => {
    expect(await mayInterrupt(ids.owner, PROJECT_RUN)).toBe(false);
    expect(await mayInterrupt(ids.orgAdmin, DANGLING_RUN)).toBe(false);
  });
});

// ----------------------------------------------------- controllerRunRoute

describe("controllerRunRoute: where a controller run's live frames go", () => {
  /**
   * Ruling 99: the frames of a controller turn route to its conversation
   * OWNER's user stream (there is no task scope to route on). The resolver is
   * asked once per run by the sink and by the engine's no-handle interrupt.
   */
  it("names the conversation and its owner for a controller run", async () => {
    const [{ controllerRunRoute }, { getRun }] = await Promise.all([
      import("./controller-conversations.server"),
      import("~/server/runtimes/run-store.server"),
    ]);
    expect(controllerRunRoute(app.db, getRun(app.db, CONTROLLER_RUN)!)).toEqual({
      conversationId,
      userId: ids.owner,
    });
    // A project run carrying the owner's conversation id in `task_key` (the
    // fixture that would resolve without the kind check) routes nowhere here:
    // its frames are task-scoped, and this must never re-route them.
    expect(controllerRunRoute(app.db, getRun(app.db, PROJECT_RUN)!)).toBeNull();
    // A controller run whose conversation is gone has no owner to stream to.
    expect(controllerRunRoute(app.db, getRun(app.db, DANGLING_RUN)!)).toBeNull();
  });
});

// ------------------------------------------- GET /resources/run-log wire

/** The route's answer for one asker and one run id. */
async function fetchRunLog(
  userId: string,
  runId: string,
): Promise<{ status: number; body: string }> {
  const { loader } = await import("~/routes/resources.run-log");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(`/resources/run-log?runId=${runId}`, { cookie });
  const response = await loader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/run-log",
    context: new RouterContextProvider(),
  });
  return { status: response.status, body: await response.text() };
}

describe("GET /resources/run-log applies the same gate on the wire", () => {
  /**
   * The predicate is only worth anything if the route actually consults it, so
   * this drives the real loader end to end with a signed session. Ruling 99:
   * the controller branch is chosen by `run.kind` BEFORE the membership gate,
   * because a controller run has no project to be a member of.
   */
  it("the owner and an org admin get the log; a project admin does not", async () => {
    const owner = await fetchRunLog(ids.owner, CONTROLLER_RUN);
    expect(owner.status).toBe(200);
    // SAFETY: a 200 rules out the route's error branches, so the body is the
    // success payload it builds from `getRunLog`.
    const payload = JSON.parse(owner.body) as { data: { lines: unknown[] } };
    expect(payload.data.lines).toHaveLength(LOG_LINES);

    const supervisor = await fetchRunLog(ids.orgAdmin, CONTROLLER_RUN);
    expect(supervisor.status).toBe(200);

    // elif administers viberr-core. The controller run is not viberr-core's.
    expect((await fetchRunLog(ids.projectAdmin, CONTROLLER_RUN)).status).toBe(404);
  });

  /**
   * The anti-probe property, stated as an identity rather than a status code:
   * for the SAME asker, a controller run that exists but is not hers and a run
   * id that was never issued must produce the same response once the id is
   * substituted out. If the forbidden branch ever grows a distinguishing
   * detail (a different code, "forbidden" copy, the project slug), run ids
   * become walkable.
   */
  it("a forbidden controller run and a run that never existed answer identically", async () => {
    const forbidden = await fetchRunLog(ids.projectAdmin, CONTROLLER_RUN);
    const missing = await fetchRunLog(ids.projectAdmin, GHOST_RUN);
    const withoutId = (payload: string, runId: string) =>
      payload.split(runId).join("<run>");

    expect(forbidden.status).toBe(missing.status);
    expect(withoutId(forbidden.body, CONTROLLER_RUN)).toBe(
      withoutId(missing.body, GHOST_RUN),
    );
    // Nothing about the conversation, its owner or its board leaks either.
    expect(forbidden.body).not.toContain(conversationId);
    expect(forbidden.body).not.toContain(SLUG);
    expect(forbidden.body).not.toContain("selin");
  });
});

// --------------------------------------- viberr_controller.get_github_state

/** Build the toolkit AS one user and call one tool; returns the text reply. */
async function callTool(
  userId: string,
  toolName: string,
  args: Record<string, JsonValue> = {},
): Promise<string> {
  const { buildControllerToolkit } = await import("./controller-toolkit.server");
  const { findUserById } = await import("~/server/auth/user-store.server");
  const user = findUserById(app.db, userId)!;
  const toolkit = buildControllerToolkit({
    db: app.db,
    ctx: { dataRoot: app.dataRoot },
    user: { id: user.id, email: user.email, name: user.name },
    projectSlug: SLUG,
  });
  return callToolText(toolkit.tools, toolName, args);
}

/** The shape `get_github_state` answers a permitted read with. */
interface GithubStateReply {
  repo: string | null;
  defaultBranch: string;
  connection: string;
  reconcile: { at: string | null; label: string | null; stale: boolean };
  prs: { task: string; number: number; state: string; checksUnread?: unknown }[];
  branches: { task: string; branch: string; sync: string }[];
}

describe("viberr_controller.get_github_state", () => {
  const refusal = (slug: string) => `[denied] No project "${slug}" is visible to you.`;

  /**
   * The visible answer. This tool is the model's only read of branch/PR state,
   * and the GitHub page it mirrors is behind the ANY-MEMBER gate, so a
   * contributor reads it — the read must not quietly drift up to project
   * admin, which would leave the controller unable to answer "what is the
   * state of my branch" for the people who mostly ask it.
   */
  it("a member reads the project's repo, branches and PRs", async () => {
    // SAFETY: a 200-path reply is the toolkit's `json()` over the object
    // literal the handler builds; the interface names that literal's fields.
    const state = JSON.parse(
      await callTool(ids.owner, "get_github_state"),
    ) as GithubStateReply;

    expect(state.repo).toBe(REPO);
    expect(state.defaultBranch).toBe("main");
    // No PAT is bound in the hermetic store, and the connection fact says so
    // honestly rather than throwing or claiming a healthy link.
    expect(state.connection).toBe("no_pat_configured");
    // The seeded board has task branches, and every row names the task it
    // belongs to plus a sync verdict — the two fields the model answers from.
    expect(state.branches.length).toBeGreaterThan(0);
    for (const branch of state.branches) {
      expect(branch.task).toMatch(/^VIB-\d+$/);
      expect(branch.branch.length).toBeGreaterThan(0);
      expect(branch.sync.length).toBeGreaterThan(0);
    }
    for (const pr of state.prs) {
      expect(pr.task).toMatch(/^VIB-\d+$/);
      expect(Number.isInteger(pr.number)).toBe(true);
      // Ruling 360: the THIRD kind of null `checks` — a read GitHub refused —
      // rides on every row (null here: nothing was refused in the seed), so
      // the controller never again takes a refusal for "nobody has looked".
      // CANARY: drop `checksUnread` from the reply.
      expect(Object.hasOwn(pr, "checksUnread")).toBe(true);
    }
    // Freshness is disclosed, and a board that was NEVER reconciled reads as
    // stale rather than as current — cached PR state must never pass for live.
    expect(state.reconcile.at).toBeNull();
    expect(state.reconcile.stale).toBe(true);
  });

  /**
   * Ruling 468 (F40-12): the model reads an empty repository as a fact
   * Viberr acts on. Live, `get_github_state` read "no branches" and the
   * operator asked the owner to push a README.
   */
  it("ruling 468: an empty repository says the first commit is Viberr's; one with commits says nothing", async () => {
    const { primeRepoAccessForTests, invalidateRepoAccess } = await import(
      "~/features/github/github-query.server"
    );
    primeRepoAccessForTests(app.db, SLUG, {
      status: "connected",
      repo: REPO,
      remoteDefaultBranch: "main",
      private: false,
      empty: true,
    });
    try {
      // SAFETY: as above — the permitted path is `json()` over the handler's literal.
      const state = JSON.parse(await callTool(ids.owner, "get_github_state")) as GithubStateReply & {
        contents: string | null;
      };
      // CANARY: drop `contents` from the reply and the model is told nothing.
      expect(state.connection).toBe("connected");
      expect(state.contents).toBe(
        "empty: viberr will create the first commit on main before the first task branch",
      );
      primeRepoAccessForTests(app.db, SLUG, {
        status: "connected",
        repo: REPO,
        remoteDefaultBranch: "main",
        private: false,
      });
      // SAFETY: as above.
      const full = JSON.parse(await callTool(ids.owner, "get_github_state")) as { contents: string | null };
      expect(full.contents).toBeNull();
    } finally {
      invalidateRepoAccess(app.db, SLUG);
    }
  });

  /**
   * The D2 emergency override reaches this read as well — and it is AUDITED,
   * which is the condition the owner attached to it: an org admin reading a
   * board they are not a member of leaves a row naming what they read.
   */
  it("an org admin who is a member of nothing reads it, and the override is on the record", async () => {
    // SAFETY: as above — the permitted path is `json()` over the handler's literal.
    const state = JSON.parse(
      await callTool(ids.outsiderAdmin, "get_github_state"),
    ) as GithubStateReply;
    expect(state.repo).toBe(REPO);

    const overrides = listAuditEvents(app.db, {
      action: "project.org_admin.override",
    }).filter((row) => row.actorUserId === ids.outsiderAdmin);
    expect(overrides.length).toBeGreaterThan(0);
    expect(overrides[0]!.projectSlug).toBe(SLUG);
    expect(overrides[0]!.details).toMatchObject({
      what: "read this project's GitHub state",
    });
  });

  /**
   * The refusal. `requireVisible` answers the toolkit's uniform not-visible
   * sentence, and the point of that sentence is that a project the asker may
   * not see and a project that does not exist read the same — otherwise a
   * model (or the person driving it) can enumerate the instance's projects by
   * asking about slugs and watching which ones refuse differently.
   */
  it("a non-member gets the uniform sentence, and existence is not disclosed", async () => {
    expect(await callTool(ids.nonMember, "get_github_state")).toBe(refusal(SLUG));

    // Substituting the slug is the ONLY difference between "you may not see
    // this real project" and "this project does not exist".
    const forbiddenReal = await callTool(ids.nonMember, "get_github_state", {
      projectSlug: SLUG,
    });
    const invented = await callTool(ids.nonMember, "get_github_state", {
      projectSlug: "no-such-project",
    });
    expect(forbiddenReal.split(SLUG).join("<slug>")).toBe(
      invented.split("no-such-project").join("<slug>"),
    );
    // A member asking about the invented slug gets the very same answer, so
    // the reply does not even disclose whose membership was the problem.
    expect(
      await callTool(ids.owner, "get_github_state", {
        projectSlug: "no-such-project",
      }),
    ).toBe(invented);
  });

  /** A refusal that leaves no trace is invisible: P13-D-8 audits the attempt. */
  it("the refusal leaks no repo or branch data, and is audited", async () => {
    const reply = await callTool(ids.nonMember, "get_github_state");
    expect(reply).not.toContain(REPO);
    expect(reply).not.toContain("main");
    expect(reply).not.toMatch(/VIB-\d+/);

    const denials = listAuditEvents(app.db, {
      action: "project.authority.denied",
    }).filter((row) => row.actorUserId === ids.nonMember);
    expect(denials.length).toBeGreaterThan(0);
    expect(denials[0]!.projectSlug).toBe(SLUG);
  });
});
