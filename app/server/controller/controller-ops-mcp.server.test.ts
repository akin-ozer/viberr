import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import { callToolText, toolLoading } from "../../../test-support/mcp-tool-meta";
import { runConcurrencySnapshot } from "~/server/runtimes/run-service.server";
import type { JsonValue } from "~/features/runtime/runtime-types";

/**
 * Ruling 269 — `viberr_ops`, the controller's built-in diagnostics server.
 *
 * The contract under test: three READ-ONLY tools, each resolving the ASKING
 * PERSON's authority live, per call, and refusing in the toolkit's own voice.
 * `instance_health` answers anyone (the health probe is unauthenticated by
 * design); `read_run_log` applies the run-log route's exact gate and answers
 * ONE not-visible sentence to a missing run, a forbidden project and a
 * forbidden conversation alike; `list_runs` (ruling 269) answers the run ids
 * that gate admits and silently drops the rest; `read_store_doc` is org-admin
 * only.
 *
 * Fixture roles on viberr-core (demo seed): elif = project admin (org member),
 * arda = project admin + ORG admin, deniz = org member and a member of nothing.
 */

let app: AppTestContext;
const SLUG = "viberr-core";
const PROJECT_RUN = "run_ops_project";
const CONTROLLER_RUN = "run_ops_controller";
const LOG_LINES = 12;
/**
 * A run LONGER than both page bounds, because a fixture smaller than the clamp
 * cannot tell a working clamp from a missing one: the first version of this
 * suite proved its 500-line ceiling against a 12-line run, and the unbounded
 * default path it was meant to cover shipped anyway.
 */
const LONG_RUN = "run_ops_long";
const LONG_LINES = 620;
/** The tool's own page bounds, restated so the arithmetic below is readable. */
const DEFAULT_PAGE = 200;
const MAX_PAGE = 250;
/** Ruling 269: a run whose every line is long, so a page of them is bounded
 *  by what a reply carries before it is bounded by its count. */
const WORDY_RUN = "run_ops_wordy";
const WORDY_LINES = 60;
const WORDY_TEXT = "w".repeat(2_000);
/** `readStoreDoc`'s default ceiling, the most of a document the editor opens;
 *  `read_store_doc` must page past it (ruling 269). */
const READ_DOC_BYTES = 256 * 1024;
/** The long fixture document: longer than that ceiling. */
const LONG_DOC = "x".repeat(READ_DOC_BYTES) + "\n## Tail\n".padEnd(4_096, "t");
/** Ruling 269: one page of a store document, in bytes (`READ_PAGE_BYTES`). */
const READ_PAGE = 32_000;

interface Actors {
  orgAdmin: string; // arda
  projectAdmin: string; // elif — owns the controller conversation below
  nonMember: string; // deniz
}
let ids: Actors;
/** The KB the store-doc arm reads out of. */
let kbId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedDefaultAgentAssets } = await import(
    "~/server/seed/default-assets.server"
  );
  seedDefaultAgentAssets(app.dataRoot);

  ids = {
    orgAdmin: userIds.arda,
    projectAdmin: userIds.elif,
    nonMember: userIds.deniz,
  };

  // One project run and one controller turn, each with a readable log: the two
  // gates read_run_log has to tell apart.
  const { insertRunLine, upsertRun } = await import(
    "~/server/runtimes/run-store.server"
  );
  const { createConversation } = await import(
    "./controller-conversations.server"
  );
  const conversation = createConversation(app.db, {
    userId: ids.projectAdmin,
    userLabel: "elif@viberr.dev",
  });
  upsertRun(app.db, {
    id: PROJECT_RUN,
    projectSlug: SLUG,
    taskKey: "VIB-142",
    threadId: "thread_ops_project",
    role: "developer",
    kind: "primary",
    agentProfileId: "developer",
    agentName: "dev",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "finished",
  });
  upsertRun(app.db, {
    id: CONTROLLER_RUN,
    // Ruling 251's controller scope: no project, task_key = conversation id.
    projectSlug: "",
    taskKey: conversation.id,
    threadId: "thread_ops_controller",
    role: "Controller",
    kind: "controller",
    agentProfileId: "controller",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "finished",
  });
  upsertRun(app.db, {
    id: LONG_RUN,
    projectSlug: SLUG,
    taskKey: "VIB-142",
    threadId: "thread_ops_long",
    role: "developer",
    kind: "primary",
    agentProfileId: "developer",
    agentName: "dev",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "error",
  });
  upsertRun(app.db, {
    id: WORDY_RUN,
    projectSlug: SLUG,
    taskKey: "VIB-142",
    threadId: "thread_ops_wordy",
    role: "developer",
    kind: "primary",
    agentProfileId: "developer",
    agentName: "dev",
    backend: "claude",
    model: "claude-opus-4-8",
    sdk: "claude-agent-sdk",
    state: "finished",
  });
  for (const [runId, count] of [
    [PROJECT_RUN, LOG_LINES],
    [CONTROLLER_RUN, LOG_LINES],
    [LONG_RUN, LONG_LINES],
    [WORDY_RUN, WORDY_LINES],
  ] as const) {
    for (let i = 0; i < count; i += 1) {
      insertRunLine(app.db, {
        runId,
        seq: i,
        occurredAt: "2026-09-01T00:00:00.000Z",
        raw: JSON.stringify({ i }),
        display: { t: "00:00:00", ev: "text", tag: "assistant", text: runId === WORDY_RUN ? WORDY_TEXT : `l${i}` },
      });
    }
  }

  const { listKnowledgeBases, resolveStoreTarget } = await import(
    "~/server/org/resources.server"
  );
  const { writeStoreDoc } = await import("~/server/org/store-files.server");
  const kb = listKnowledgeBases(app.db, { dataRoot: app.dataRoot })[0]!;
  kbId = kb.id;
  const target = resolveStoreTarget(app.db, "kb", kb.id, {
    dataRoot: app.dataRoot,
  })!;
  const storeActor = { userId: ids.orgAdmin, label: "arda@viberr.dev" };
  writeStoreDoc(
    app.db,
    target,
    [],
    "ops-note.md",
    "the disk is fine",
    storeActor,
    { overwrite: true },
  );
  // A document that really is longer than one read: `truncated` has to be a
  // measurement, not a constant nobody can tell apart from the honest answer.
  writeStoreDoc(app.db, target, [], "ops-long.md", LONG_DOC, storeActor, { overwrite: true });
});
afterAll(() => app.cleanup());

/** Build the ops server AS one user and call one tool; returns the reply text. */
async function call(
  userId: string,
  toolName: string,
  args: Record<string, JsonValue> = {},
): Promise<string> {
  const { buildControllerOpsMcp } = await import("./controller-ops-mcp.server");
  const { findUserById } = await import("~/server/auth/user-store.server");
  const user = findUserById(app.db, userId)!;
  const ops = buildControllerOpsMcp({
    db: app.db,
    ctx: { dataRoot: app.dataRoot },
    user: { id: user.id, email: user.email, name: user.name },
  });
  return callToolText(ops.tools, toolName, args);
}

/**
 * The answer shapes these tests read. Declared as schemas rather than asserted:
 * a tool answer is a wire contract, and a cast would let a field quietly change
 * shape under an assertion that still passed.
 */
const HEALTH_REPLY = z.object({
  status: z.string(),
  degraded: z.array(z.string()),
  projections: z.object({ projects: z.number(), tasks: z.number() }),
  watcher: z.boolean(),
  kbWatcher: z.boolean(),
  backends: z.object({
    claude: z.object({ connectedUsers: z.number() }),
    codex: z.object({ connectedUsers: z.number() }),
  }),
  maintenance: z.object({ scheduled: z.boolean() }),
  build: z.object({ version: z.string().nullable() }),
  // Ruling 137: strict, and NOTHING is authority-gated any more — the org-admin
  // detail arm named a deployment config path, and there is no such path left.
  // Every asker gets the same two facts, one of which is about their own
  // account.
  backendCredentials: z.array(
    z.strictObject({
      backend: z.string(),
      connectedUsers: z.number(),
      askerConnected: z.boolean(),
    }),
  ),
  runs: z.object({ cap: z.number(), live: z.number(), queued: z.number() }),
  // C05-A (pass 32): the pinned browser executable's PATH, org admins only.
  browserDetail: z.string().optional(),
  // Ruling 40: the host toolchain. Its key list is toolchain.server.test.ts's;
  // this reply relays the snapshot's (asserted at the first instance_health case).
  toolchain: z.record(z.string(), z.string().nullable()),
  // F32-9 (pass 32): what each backend last told us — the reading the
  // Insights page shows, so the controller cannot answer "no quota exhaustion
  // flagged" from a poorer source than the admin's own page.
  quota: z.array(
    z.object({
      backend: z.string(),
      reading: z.unknown().nullable(),
      credentialRefused: z.object({ runId: z.string(), credentialLabel: z.string().nullable().optional() }).nullable(),
      exhausted: z.object({ runId: z.string(), credentialLabel: z.string().nullable().optional() }).nullable(),
    }),
  ),
});

const RUN_LOG_REPLY = z.strictObject({
  run: z.object({
    id: z.string(),
    kind: z.string(),
    state: z.string(),
    project: z.string(),
    task: z.string(),
    /** The run's TRUE line count, so an empty page is never read as "no log". */
    logLines: z.number(),
  }),
  /**
   * Page position stated in full. `runLogPage`'s own headSeq/oldestSeq/hasMore
   * are page-local cursors for a stateful console — the schema refuses them, so
   * relaying them again would fail here rather than reach a model that has no
   * second source to check them against.
   */
  page: z.strictObject({
    firstSeq: z.number().nullable(),
    lastSeq: z.number().nullable(),
    olderExist: z.boolean(),
    newerExist: z.boolean(),
    next: z.object({
      older: z.object({ before: z.number() }).nullable(),
      newer: z.object({ since: z.number() }).nullable(),
    }),
  }),
  lines: z.array(z.object({ seq: z.number(), at: z.string() })),
});

const STORE_DOC_REPLY = z.strictObject({
  resource: z.object({ kind: z.string(), id: z.string(), name: z.string() }),
  path: z.array(z.string()),
  truncated: z.boolean(),
  characters: z.number(),
  text: z.string(),
  offset: z.number().optional(),
  nextOffset: z.number().optional(),
});

/** A tool answer that is not a refusal, read through its schema. */
function parsed<T>(schema: z.ZodType<T>, reply: string): T {
  expect(reply.startsWith("["), `expected data, got: ${reply}`).toBe(false);
  return schema.parse(JSON.parse(reply));
}

// ------------------------------------------------------------ tool surface

describe("the diagnostics surface is read-only and named for the mount", () => {
  it("offers exactly the four read tools, under the viberr_ops tool names", async () => {
    const { buildControllerOpsMcp, CONTROLLER_OPS_MCP_NAME } = await import(
      "./controller-ops-mcp.server"
    );
    const ops = buildControllerOpsMcp({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: ids.orgAdmin, email: "arda@viberr.dev", name: "Arda" },
    });
    expect(ops.tools.map((t) => t.name).sort()).toEqual([
      "instance_health",
      "list_runs",
      "read_run_log",
      "read_store_doc",
    ]);
    expect(ops.allowedTools).toEqual([
      "mcp__viberr_ops__instance_health",
      "mcp__viberr_ops__list_runs",
      "mcp__viberr_ops__read_run_log",
      "mcp__viberr_ops__read_store_doc",
    ]);
    expect(Object.keys(ops.mcpServers)).toEqual([CONTROLLER_OPS_MCP_NAME]);
    // Option D PR 4(a): deferred like the controller's own toolkit.
    expect(toolLoading(ops.mcpServers[CONTROLLER_OPS_MCP_NAME]).loaded).toEqual([]);
    // Nothing here may write, start or destroy: the toolkit is the only
    // surface where a controller action is audited. Matched per NAME SEGMENT,
    // so the check reads verbs and not substrings (`read_run_log` is a read).
    const mutating = ["write", "save", "create", "update", "delete", "remove", "set", "start", "stop"];
    const verbs = ops.tools.flatMap((t) =>
      t.name.split("_").filter((segment) => mutating.includes(segment)),
    );
    expect(verbs, "a diagnostics tool named for a mutation").toEqual([]);
  });
});

// --------------------------------------------------------- instance_health

describe("instance_health: aggregates, open to any signed-in person", () => {
  it("answers a member of nothing with the probe's own reading plus backends and the run queue", async () => {
    const body = parsed(
      HEALTH_REPLY,
      await call(ids.nonMember, "instance_health"),
    );
    // The health route's derivation, not a second one.
    const { healthSnapshot } = await import(
      "~/server/ops/health-snapshot.server"
    );
    const snapshot = healthSnapshot(app.db);
    expect(body.status).toBe(snapshot.status);
    expect(body.degraded).toEqual(snapshot.degraded);
    expect(body.projections).toEqual(snapshot.projections);
    expect(body.backends).toEqual(snapshot.backends);
    expect(body.watcher).toBe(snapshot.watcher);
    expect(body.kbWatcher).toBe(snapshot.kbWatcher);
    // Whether each backend can run at all — the availability answer to "why has
    // nothing started".
    expect(body.backendCredentials.map((c) => c.backend)).toEqual([
      "claude",
      "codex",
    ]);
    // The concurrency gate, live: a queued run is the usual answer to "why has
    // nothing started".
    expect(body.runs.cap).toBe(runConcurrencySnapshot(app.db).cap);
    // F32-9: the quota/credential store rides along, one row per backend.
    expect(body.quota.map((q) => q.backend)).toEqual(["claude", "codex"]);
    // Ruling 40: the toolchain, the same reading the health route serves —
    // the controller answers "can this host build a Go service" from the
    // probe, not from a guess.
    expect(body.toolchain).toEqual(snapshot.toolchain);
  });

  it("ruling 160(a): instance_health carries the refusal's principal, which the unauthenticated body strips", async () => {
    // Canary: omit `{ principal: true }` from the tool's snapshot call.
    const { recordBackendCredentialRefusal, clearBackendCredentialRefusal } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    recordBackendCredentialRefusal(app.db, "codex", {
      providerText: "token revoked", runId: "run_p", observedAt: new Date().toISOString(),
      credentialUserId: ids.nonMember, credentialLabel: "Non Member",
    });
    try {
      const body = parsed(HEALTH_REPLY, await call(ids.nonMember, "instance_health"));
      const codex = body.quota.find((q) => q.backend === "codex")!;
      expect(codex.credentialRefused?.credentialLabel).toBe("Non Member");
      const { healthSnapshot } = await import("~/server/ops/health-snapshot.server");
      expect(healthSnapshot(app.db).quota.find((q) => q.backend === "codex")!.credentialRefused?.credentialLabel).toBeNull();
    } finally {
      clearBackendCredentialRefusal(app.db, "codex");
    }
  });

  it("leaves one `controller.ops.read` audit row per successful read, bound to the asker (owner ruling, pass 32)", async () => {
    const count = () =>
      (
        // SAFETY: `SELECT count(*) AS c` is an aggregate with no GROUP BY —
        // sqlite answers it with exactly one row carrying the integer `c`.
        app.db
          .prepare(
            `SELECT count(*) AS c FROM audit_events WHERE action = 'controller.ops.read' AND actor_user_id = ?`,
          )
          .get(ids.nonMember) as { c: number }
      ).c;
    const before = count();
    await call(ids.nonMember, "instance_health");
    expect(count()).toBe(before + 1);
    // SAFETY: the count above just proved a row exists for this actor, and the
    // four selected columns are NOT NULL text in `audit_events`.
    const row = app.db
      .prepare(
        `SELECT actor_label, subject_kind, subject_id, details_json FROM audit_events WHERE action = 'controller.ops.read' AND actor_user_id = ? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(ids.nonMember) as {
      actor_label: string;
      subject_kind: string;
      subject_id: string;
      details_json: string;
    };
    // The instrument is disclosed on the label; the person is the actor id.
    expect(row.actor_label).toContain("via controller");
    expect(row.subject_kind).toBe("controller");
    expect(JSON.parse(row.details_json)).toEqual({ tool: "instance_health" });
    // A DENIED read writes the denial row, never a read row.
    await call(ids.nonMember, "read_store_doc", { kind: "kb", id: "nope", path: ["x.md"] });
    expect(count()).toBe(before + 1);
  });

  it("names the pinned browser executable's path to org admins only (C05-A)", async () => {
    const { withEnv } = await import("../../../test-support/env");
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: "/nonexistent/chromium-not-installed" }, async () => {
      const member = parsed(HEALTH_REPLY, await call(ids.nonMember, "instance_health"));
      expect(JSON.stringify(member)).not.toContain("/nonexistent");
      expect(member.browserDetail).toBeUndefined();
      const admin = parsed(HEALTH_REPLY, await call(ids.orgAdmin, "instance_health"));
      expect(admin.browserDetail).toContain("/nonexistent/chromium-not-installed");
    });
  });

  it("ruling 40: carries a refused credential and a spent quota window, and neither is an INSTANCE fault", async () => {
    const {
      clearBackendCredentialRefusal,
      clearBackendQuotaExhaustion,
      recordBackendCredentialRefusal,
      recordBackendQuotaExhaustion,
    } = await import("~/server/runtimes/backend-quota.server");
    recordBackendCredentialRefusal(app.db, "codex", {
      credentialUserId: null,
      credentialLabel: null,
      providerText: "The provider reported: refresh token was already used",
      runId: "run_auth_probe",
      observedAt: new Date().toISOString(),
    });
    recordBackendQuotaExhaustion(app.db, "claude", {
      credentialUserId: null,
      credentialLabel: null,
      resetsAt: null,
      resetsAtPrecision: null,
      providerText: "The provider reported: You've hit your usage limit",
      runId: "run_quota_probe",
      observedAt: new Date().toISOString(),
    });
    try {
      const body = parsed(
        HEALTH_REPLY,
        await call(ids.nonMember, "instance_health"),
      );
      // The READINGS are the point of this tool and are unchanged: the asker
      // still learns exactly which account was refused and which window is
      // spent, with the refusing run named.
      const codex = body.quota.find((q) => q.backend === "codex")!;
      expect(codex.credentialRefused?.runId).toBe("run_auth_probe");
      const claude = body.quota.find((q) => q.backend === "claude")!;
      expect(claude.exhausted?.runId).toBe("run_quota_probe");

      // Ruling 40: an agent-backend credential belongs to a PERSON (ruling
      // 137), so one member's refused key or spent window is not a statement
      // about this deployment. It used
      // to push `credential:<backend>` / `quota:<backend>` into `degraded`,
      // which made `/resources/health?probe=readiness` answer 503 for the whole
      // instance and drained traffic from a deployment serving everyone else.
      // Canary: restore those two pushes in health-snapshot.server.ts.
      // (This harness may be degraded for unrelated reasons — a stopped
      // watcher from a neighbouring case — so assert the SPECIFIC entries,
      // not the aggregate verdict.)
      expect(body.degraded).not.toContain("credential:codex");
      expect(body.degraded).not.toContain("quota:claude");
    } finally {
      clearBackendCredentialRefusal(app.db, "codex");
      clearBackendQuotaExhaustion(app.db, "claude");
    }
  });

  it("answers every asker the same two facts, and `askerConnected` is about THEM (ruling 137)", async () => {
    // Ruling 269 split this reading in two — everyone learned WHETHER a backend
    // could run, only org admins learned WHY — because the "why" sentence
    // interpolated the deployment's config directory. Ruling 137 deleted that
    // sentence along with the instance credential it described, so the split
    // has nothing left to protect: the org-admin arm is gone, and no row here
    // names a host path, an environment variable or another person.
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    await connectFakeBackend(app.db, ids.orgAdmin, "claude");
    try {
      const member = parsed(
        HEALTH_REPLY,
        await call(ids.nonMember, "instance_health"),
      );
      const admin = parsed(
        HEALTH_REPLY,
        await call(ids.orgAdmin, "instance_health"),
      );
      // Both parsed through HEALTH_REPLY's strict row: its three keys, no other.
      // The instance-level count is the same for both — it is a fact about the
      // instance, not about the asker.
      expect(member.backendCredentials.map((c) => c.connectedUsers)).toEqual(
        admin.backendCredentials.map((c) => c.connectedUsers),
      );
      // …and the per-asker fact differs, which is the whole point of keeping it.
      const claudeFor = (rows: typeof member.backendCredentials) =>
        rows.find((c) => c.backend === "claude")!;
      expect(claudeFor(admin.backendCredentials).askerConnected).toBe(true);
      expect(claudeFor(member.backendCredentials).askerConnected).toBe(false);
      expect(claudeFor(admin.backendCredentials).connectedUsers).toBe(1);
    } finally {
      await disconnectFakeBackend(app.db, ids.orgAdmin, "claude");
    }
  });
});

// ----------------------------------------------------------- read_run_log

describe("read_run_log: the run-log route's gate, in one sentence", () => {
  const invisible = (runId: string) =>
    `[denied] No run "${runId}" is visible to you.`;

  it("a member of the run's project reads it", async () => {
    const body = parsed(
      RUN_LOG_REPLY,
      await call(ids.projectAdmin, "read_run_log", { runId: PROJECT_RUN }),
    );
    expect(body.run).toEqual(
      expect.objectContaining({ id: PROJECT_RUN, project: SLUG, state: "finished" }),
    );
    expect(body.lines.length).toBe(LOG_LINES);
  });

  it("a non-member is refused, and a run that never existed reads identically", async () => {
    expect(
      await call(ids.nonMember, "read_run_log", { runId: PROJECT_RUN }),
    ).toBe(invisible(PROJECT_RUN));
    // The whole point of the uniform sentence: a probe cannot tell a run it may
    // not read from one that does not exist, so run ids cannot be walked.
    expect(
      await call(ids.nonMember, "read_run_log", { runId: "run_nope" }),
    ).toBe(invisible("run_nope"));
    // …and it never leaks which project the run belongs to.
    expect(
      await call(ids.nonMember, "read_run_log", { runId: PROJECT_RUN }),
    ).not.toContain(SLUG);
  });

  it("a controller turn is readable by its own person and by an org admin, nobody else", async () => {
    const owner = parsed(
      RUN_LOG_REPLY,
      await call(ids.projectAdmin, "read_run_log", { runId: CONTROLLER_RUN }),
    );
    expect(owner.run).toEqual(
      expect.objectContaining({ id: CONTROLLER_RUN, kind: "controller" }),
    );
    // Org admins supervise.
    parsed(
      RUN_LOG_REPLY,
      await call(ids.orgAdmin, "read_run_log", { runId: CONTROLLER_RUN }),
    );
    // A project role buys nothing here: a transcript is scoped to the person
    // whose conversation it is (deniz is an org member of nothing, but so is
    // any other non-owner non-admin).
    expect(
      await call(ids.nonMember, "read_run_log", { runId: CONTROLLER_RUN }),
    ).toBe(invisible(CONTROLLER_RUN));
  });

});

/**
 * Ruling 269 (pass 37, F37-95): `read_run_log` takes a run id, and until this
 * existed nothing in either toolkit produced one. Its own description could
 * only point at "a task's console" — a place a model cannot look. Live, the
 * controller knew from `instance_health` that five runs were going, could not
 * learn which five, and read every task on the board matching `waiting:
 * "agent"` against timeline events to reconstruct it.
 */
describe("list_runs: the run ids read_run_log needs (ruling 269)", () => {
  const LIVE_RUN = "run_ops_live";
  const HIDDEN_LIVE = "run_ops_live_hidden";

  const RUNS_REPLY = z.object({
    scope: z.string(),
    // Ruling 117: always the real count, and the note only when it clipped.
    total: z.number(),
    truncated: z.string().optional(),
    runs: z.array(
      z.object({
        runId: z.string(),
        projectSlug: z.string().nullable(),
        taskKey: z.string().nullable(),
        state: z.string(),
        agent: z.string(),
      }).loose(),
    ),
  });

  beforeAll(async () => {
    const { upsertRun } = await import("~/server/runtimes/run-store.server");
    upsertRun(app.db, {
      id: LIVE_RUN,
      projectSlug: SLUG,
      taskKey: "VIB-142",
      threadId: "thread_ops_live",
      role: "developer",
      kind: "primary",
      agentProfileId: "developer",
      agentName: "dev",
      backend: "claude",
      model: "claude-opus-4-8",
      sdk: "claude-agent-sdk",
      state: "running",
    });
    // A live run in a project the asker below is not a member of: it must be
    // ABSENT from the listing, not refused (a refusal would disclose it).
    upsertRun(app.db, {
      id: HIDDEN_LIVE,
      projectSlug: "not-a-project-deniz-can-see",
      taskKey: "X-1",
      threadId: "thread_ops_hidden",
      role: "developer",
      kind: "primary",
      agentProfileId: "developer",
      agentName: "dev",
      backend: "claude",
      model: "claude-opus-4-8",
      sdk: "claude-agent-sdk",
      state: "running",
    });
  });

  it("lists the LIVE runs, and the id it returns is one read_run_log accepts", async () => {
    const body = parsed(
      RUNS_REPLY,
      await call(ids.projectAdmin, "list_runs"),
    );
    expect(body.scope).toBe("live");
    // CANARY: drop the `state IN ('queued','running')` filter in
    // `listLiveRunRows` and the finished fixtures come back too, which is the
    // listing being a history rather than "what is going right now".
    expect(body.runs.map((r) => r.runId)).toContain(LIVE_RUN);
    expect(body.runs.map((r) => r.runId)).not.toContain(PROJECT_RUN);
    expect(body.runs.every((r) => r.state === "running" || r.state === "queued")).toBe(true);
    // The point of the tool: the id it hands back is usable, in one hop.
    const log = parsed(
      RUN_LOG_REPLY,
      await call(ids.projectAdmin, "read_run_log", { runId: body.runs[0]!.runId }),
    );
    expect(log.run.id).toBe(body.runs[0]!.runId);
  });

  /**
   * Ruling 269 (F37-100): ruling 251 stores a controller turn's CONVERSATION id
   * in the runs table's `task_key` column, because that table has one identity
   * column. Reporting it raw put a `cnv_…` in a field named `taskKey` with
   * `projectSlug: ""` — the controller's own words: "a conversation id in a
   * field named taskKey, so anything filtering by task has to know to discard
   * that row". A storage shape is not a reply shape.
   */
  it("a controller turn names its conversation and carries no task (ruling 269)", async () => {
    const { upsertRun } = await import("~/server/runtimes/run-store.server");
    const { createConversation } = await import("./controller-conversations.server");
    const conversation = createConversation(app.db, {
      userId: ids.projectAdmin,
      userLabel: "elif@viberr.dev",
    });
    upsertRun(app.db, {
      id: "run_ops_live_ctl",
      projectSlug: "",
      taskKey: conversation.id,
      threadId: "thread_ops_live_ctl",
      role: "Controller",
      kind: "controller",
      agentProfileId: "controller",
      backend: "claude",
      model: "claude-opus-4-8",
      sdk: "claude-agent-sdk",
      state: "running",
    });
    const body = parsed(RUNS_REPLY, await call(ids.projectAdmin, "list_runs"));
    const row = body.runs.find((r) => r.runId === "run_ops_live_ctl")!;
    // CANARY: report `row.task_key` straight through again and a caller
    // filtering `taskKey` picks up a conversation id.
    expect(row.taskKey).toBeNull();
    expect(row.projectSlug).toBeNull();
    expect(row).toMatchObject({ conversationId: conversation.id, kind: "controller" });
    // A TASK run is untouched: the correction is scoped to the kind whose
    // column means something else.
    const task = body.runs.find((r) => r.runId === LIVE_RUN)!;
    expect(task.taskKey).toBe("VIB-142");
    expect(task).not.toHaveProperty("conversationId");
  });

  it("a run in a project you cannot see is absent, never refused", async () => {
    const body = parsed(RUNS_REPLY, await call(ids.nonMember, "list_runs"));
    // CANARY: let `requireRunVisible` throw inside the listing (or drop the
    // filter) and a non-member either learns a hidden project's slug or gets a
    // refusal that proves a run exists there.
    expect(body.runs.map((r) => r.runId)).not.toContain(HIDDEN_LIVE);
    expect(JSON.stringify(body)).not.toContain("not-a-project-deniz-can-see");
  });

  /**
   * Ruling 117's third sibling. `list_runs` clipped at `limit` and said
   * nothing: a caller asking "which runs are live right now" got a list that
   * looked complete and could not reconcile it with the count
   * `instance_health` reports for the same instant. `read_run_log` beside it
   * carries `olderExist`/`newerExist`, and `inspect_audit_log` carries
   * `total`/`shown`.
   */
  it("ruling 117: a clipped listing says how many it left out, and is silent when it left out none", async () => {
    const full = parsed(
      RUNS_REPLY,
      await call(ids.projectAdmin, "list_runs", { projectSlug: SLUG, taskKey: "VIB-142" }),
    );
    // Nothing hidden: no note at all, rather than a note claiming zero.
    // CANARY: return the note unconditionally.
    expect(full.total).toBe(full.runs.length);
    expect(full.truncated).toBeUndefined();

    const clipped = parsed(
      RUNS_REPLY,
      await call(ids.projectAdmin, "list_runs", {
        projectSlug: SLUG,
        taskKey: "VIB-142",
        limit: 1,
      }),
    );
    // CANARY: drop `total` and the window looks like the whole history.
    expect(clipped.runs).toHaveLength(1);
    expect(clipped.total).toBe(full.total);
    expect(clipped.truncated).toContain(String(full.total - 1));
    expect(clipped.truncated).toContain("limit");
  });

  it("a taskKey lists that task's runs, finished included, and needs its project", async () => {
    const body = parsed(
      RUNS_REPLY,
      await call(ids.projectAdmin, "list_runs", { projectSlug: SLUG, taskKey: "VIB-142" }),
    );
    expect(body.scope).toBe(`${SLUG}/VIB-142`);
    // This arm is how you reach the log of a run that ALREADY FAILED, so a
    // terminal run has to be in it. CANARY: reuse the live filter here.
    expect(body.runs.map((r) => r.runId)).toEqual(
      expect.arrayContaining([LIVE_RUN, PROJECT_RUN, LONG_RUN]),
    );
    // Newest first, so the run a person just watched fail is at the top.
    expect(body.runs[0]!.runId).toBe(LIVE_RUN);
    // No binding on this server, so the missing argument is NAMED rather than
    // answered with an empty list.
    expect(await call(ids.projectAdmin, "list_runs", { taskKey: "VIB-142" })).toContain(
      "Name projectSlug alongside taskKey",
    );
    // And the project gate answers out loud on this arm, because the listing
    // was asked FOR a project.
    expect(
      await call(ids.nonMember, "list_runs", { projectSlug: SLUG, taskKey: "VIB-142" }),
    ).toContain("[denied]");
  });
});

/**
 * Paging, on a run LONGER than both bounds (620 lines). The first version of
 * this suite proved its clamp against a 12-line fixture, so "limit: 99999
 * returned 12" was indistinguishable from no clamp at all — and the default
 * call, which named no page size, returned the whole log unbounded into a model
 * context (measured at 2.5 MB on a 1,500-line run).
 */
describe("read_run_log: every page is bounded, and says where it sits", () => {
  const page = (args: Record<string, JsonValue>) =>
    call(ids.projectAdmin, "read_run_log", { runId: LONG_RUN, ...args });

  it("defaults to the NEWEST page, bounded, with a cursor for the rest", async () => {
    const body = parsed(RUN_LOG_REPLY, await page({}));
    // Bounded by DEFAULT, not only by a limit the caller has to think to send.
    expect(body.lines.length).toBe(DEFAULT_PAGE);
    // The NEWEST page: "why did this run fail" is answered at the end of a log.
    expect(body.page.lastSeq).toBe(LONG_LINES - 1);
    expect(body.page.firstSeq).toBe(LONG_LINES - DEFAULT_PAGE);
    // And it says so: older lines exist, newer ones do not, and the argument
    // for the next call is handed over rather than left as arithmetic.
    expect(body.page.olderExist).toBe(true);
    expect(body.page.newerExist).toBe(false);
    expect(body.page.next.older).toEqual({ before: LONG_LINES - DEFAULT_PAGE });
    expect(body.page.next.newer).toBeNull();
    // The run's true size, so a page is never mistaken for the whole log.
    expect(body.run.logLines).toBe(LONG_LINES);
  });

  it("the handed-back older cursor really continues the read", async () => {
    const first = parsed(RUN_LOG_REPLY, await page({}));
    const older = parsed(
      RUN_LOG_REPLY,
      await page({ before: first.page.next.older!.before }),
    );
    // Contiguous, no gap and no overlap with the page it followed.
    expect(older.page.lastSeq).toBe(first.page.firstSeq! - 1);
    expect(older.lines.length).toBe(DEFAULT_PAGE);
    expect(older.page.newerExist).toBe(true);
    expect(older.page.next.newer).toEqual({ since: older.page.lastSeq });

    // The END of the walk, where the flag has to be computed against the RUN's
    // own first line rather than any page-local floor: the page that starts at
    // seq 0 must say there is nothing older and hand back no cursor.
    const oldest = parsed(RUN_LOG_REPLY, await page({ before: DEFAULT_PAGE }));
    expect(oldest.page.firstSeq).toBe(0);
    expect(oldest.page.olderExist).toBe(false);
    expect(oldest.page.next.older).toBeNull();
    expect(oldest.page.newerExist).toBe(true);
  });

  it("`since` reads FORWARD from the cursor, bounded — never the tail", async () => {
    const forward = parsed(RUN_LOG_REPLY, await page({ since: 10, limit: 5 }));
    expect(forward.lines.map((l) => l.seq)).toEqual([11, 12, 13, 14, 15]);
    expect(forward.page.newerExist).toBe(true);
    expect(forward.page.next.newer).toEqual({ since: 15 });
    expect(forward.page.olderExist).toBe(true);
    // The forward path is bounded even when no limit is named: `runLogPage`
    // ignores `limit` in forward mode by design, so the bound is the tool's.
    const unbounded = parsed(RUN_LOG_REPLY, await page({ since: 10 }));
    expect(unbounded.lines.length).toBe(DEFAULT_PAGE);
    expect(unbounded.page.firstSeq).toBe(11);
  });

  it("refuses the two cursors together instead of silently picking one", async () => {
    // They move opposite ways and the underlying query lets one win in silence,
    // which handed back a window the caller never asked for.
    expect(await page({ since: 10, before: 100 })).toBe(
      "[error] Name either since (a forward page) or before (a backward page), not both.",
    );
  });

  it("clamps a hostile page size at both ends, on both paths", async () => {
    const huge = parsed(RUN_LOG_REPLY, await page({ limit: 99_999 }));
    expect(huge.lines.length).toBe(MAX_PAGE); // the fixture is longer, so this bites
    const hugeForward = parsed(
      RUN_LOG_REPLY,
      await page({ since: 0, limit: 99_999 }),
    );
    expect(hugeForward.lines.length).toBe(MAX_PAGE);
    // Clamped UP to 1, never down to "everything".
    const zero = parsed(RUN_LOG_REPLY, await page({ before: 6, limit: 0 }));
    expect(zero.lines.length).toBe(1);
    const zeroForward = parsed(RUN_LOG_REPLY, await page({ since: 6, limit: 0 }));
    expect(zeroForward.lines.length).toBe(1);
  });

  /**
   * Ruling 269: a count alone bounds nothing. A line's `display` runs to
   * kilobytes, and a page of 200 of those is a reply no turn receives.
   */
  it("ruling 269: a page of long lines holds what a reply carries, from the end the cursor reads from, and its cursors reach the rest", async () => {
    const wordy = (args: Record<string, JsonValue>) =>
      call(ids.projectAdmin, "read_run_log", { runId: WORDY_RUN, ...args });
    // CANARY: return every line the count allows and this reply is 125 KB,
    // which the guards cut mid-line with the page's cursors already wrong.
    const reply = await wordy({});
    // Under the 50,000 characters the guards let through, so nothing is cut.
    expect(reply.length).toBeLessThan(50_000);
    expect(reply.startsWith("[cut]")).toBe(false);
    const newest = parsed(RUN_LOG_REPLY, reply);
    // Fewer than the 60 the run holds and the 200 the page allows, and more
    // than a handful: the bound is the reply's size, 44,000 bytes of lines.
    expect(newest.lines.length).toBeGreaterThan(15);
    expect(newest.lines.length).toBeLessThan(30);
    // CANARY: keep the oldest of a backward page and the failure at the end
    // of the log is the part left out.
    expect(newest.page.lastSeq).toBe(WORDY_LINES - 1);
    expect(newest.page.firstSeq).toBe(WORDY_LINES - newest.lines.length);
    expect(newest.page.next.older).toEqual({ before: newest.page.firstSeq });
    // The cursor continues with no gap and no overlap.
    const older = parsed(RUN_LOG_REPLY, await wordy(newest.page.next.older!));
    expect(older.page.lastSeq).toBe(newest.page.firstSeq! - 1);
    // CANARY: keep the newest of a forward page and the lines just after the
    // cursor are skipped.
    const forward = parsed(RUN_LOG_REPLY, await wordy({ since: 9 }));
    expect(forward.page.firstSeq).toBe(10);
    expect(forward.page.lastSeq).toBe(9 + forward.lines.length);
    expect(forward.page.next.newer).toEqual({ since: forward.page.lastSeq });
    expect(forward.lines.length).toBe(newest.lines.length);
  });

  it("an empty page says it is empty without inventing a sequence number", async () => {
    // Past the end of the run: `runLogPage` would answer headSeq = the cursor
    // the caller sent, a number that exists nowhere in the run.
    const body = parsed(RUN_LOG_REPLY, await page({ since: 10_000 }));
    expect(body.lines).toEqual([]);
    expect(body.page.firstSeq).toBeNull();
    expect(body.page.lastSeq).toBeNull();
    // C03-OC2 (pass 32): the flags describe the RUN, not the empty page. A
    // forward cursor past the end has every logged line BEHIND it, so "older
    // exists" is true and the handed-back cursor walks straight into the tail.
    expect(body.page.olderExist).toBe(true);
    expect(body.page.newerExist).toBe(false);
    expect(body.page.next.older).toEqual({ before: LONG_LINES });
    expect(body.page.next.newer).toBeNull();
    const recovered = parsed(RUN_LOG_REPLY, await page(body.page.next.older!));
    expect(recovered.page.lastSeq).toBe(LONG_LINES - 1);
    // …and the run's real size is still on the reply, so an empty page cannot
    // be read as "this run logged nothing".
    expect(body.run.logLines).toBe(LONG_LINES);
  });

  it("a backward cursor at or below the first line says newer lines exist and hands back the way up", async () => {
    const body = parsed(RUN_LOG_REPLY, await page({ before: 0 }));
    expect(body.lines).toEqual([]);
    expect(body.page.olderExist).toBe(false);
    expect(body.page.newerExist).toBe(true);
    expect(body.page.next.older).toBeNull();
    expect(body.page.next.newer).toEqual({ since: -1 });
    const recovered = parsed(RUN_LOG_REPLY, await page(body.page.next.newer!));
    expect(recovered.page.firstSeq).toBe(0);
  });
});

// --------------------------------------------------------- read_store_doc

describe("read_store_doc: org admins only, like the store browser", () => {
  it("refuses a member out loud, names their role, and audits the denial", async () => {
    const denied = await call(ids.projectAdmin, "read_store_doc", {
      kind: "kb",
      id: kbId,
      path: ["ops-note.md"],
    });
    expect(denied).toBe(
      "[denied] Only org admins can read store documents. Your org role is member.",
    );
    // P13-D-8 parity: an instance denial must not read cleaner than a project one.
    const rows = listAuditEvents(app.db, {
      action: "controller.authority.denied",
    });
    expect(
      rows.some(
        (r) =>
          r.actorUserId === ids.projectAdmin &&
          JSON.stringify(r.details).includes("read store documents"),
      ),
    ).toBe(true);
  });

  it("hands an org admin the document, and reports truncation honestly", async () => {
    const body = parsed(
      STORE_DOC_REPLY,
      await call(ids.orgAdmin, "read_store_doc", {
        kind: "kb",
        id: kbId,
        path: ["ops-note.md"],
      }),
    );
    expect(body.text).toBe("the disk is fine");
    expect(body.truncated).toBe(false);
    // `kbId` is the seeded folder's row-less `disk:controller-handbook` shape;
    // the doc write above adopted the folder into a row (touchResource). U36-4
    // (pass 36): a disk id whose folder has a row IS that row, so the reply
    // names the row's real id — the one `list_knowledge_bases` reports and the
    // next save takes — not the stale synthetic shape it was asked with.
    expect(kbId).toBe("disk:controller-handbook");
    expect(body.resource).toEqual(
      expect.objectContaining({ kind: "kb", name: "controller-handbook" }),
    );
    expect(body.resource.id).toMatch(/^kb_/);

    expect(body.characters).toBe(16);
    expect(body).not.toHaveProperty("nextOffset");

    // Ruling 269: a document longer than one page comes back a page at a time
    // and says so. Without this arm `truncated` could be the constant `false`
    // and read identically, which is how a model states half a file as the
    // whole of it.
    // CANARY: return the document whole and this reply is 260 KB, which no
    // turn receives: the document cannot be read at all.
    const doc = { kind: "kb", id: kbId, path: ["ops-long.md"] };
    const read = (offset: number) => call(ids.orgAdmin, "read_store_doc", { ...doc, offset });
    const first = parsed(STORE_DOC_REPLY, await call(ids.orgAdmin, "read_store_doc", doc));
    expect(first.text).toBe("x".repeat(READ_PAGE));
    expect(first).toMatchObject({ truncated: true, characters: LONG_DOC.length, nextOffset: READ_PAGE });
    expect(first).not.toHaveProperty("offset");
    // CANARY: start every page at 0 and the second read is the first again.
    const second = parsed(STORE_DOC_REPLY, await read(first.nextOffset!));
    expect(second).toMatchObject({ offset: READ_PAGE, nextOffset: 2 * READ_PAGE, truncated: true });
    expect(await read(LONG_DOC.length)).toBe(
      "[error] `ops-long.md` reads as 266,240 characters; offset 266,240 is past its end.",
    );
  });

  it("ruling 269: pages a document past 256 KB to its end, so a replace never drops a tail it did not read", async () => {
    // A replace names a version hashed from the whole file (ruling 212(a)), so
    // the pages must reach the whole file too. Pages that stopped at the store
    // reader's 256 KB cap ended with no `nextOffset`, and a caller that read
    // every page and sent the document back deleted the tail under a version
    // that matched.
    // CANARY: read through `readStoreDoc`'s default cap again and the joined
    // pages stop at 262,144 characters, without the tail.
    const doc = { kind: "kb", id: kbId, path: ["ops-long.md"] };
    const pages: string[] = [];
    let offset: number | undefined = 0;
    let last: z.infer<typeof STORE_DOC_REPLY> | undefined;
    while (offset !== undefined && pages.length < 20) {
      last = parsed(STORE_DOC_REPLY, await call(ids.orgAdmin, "read_store_doc", { ...doc, offset }));
      expect(last.characters).toBe(LONG_DOC.length);
      pages.push(last.text);
      offset = last.nextOffset;
    }
    expect(pages.join("")).toBe(LONG_DOC);
    // The last page says nothing follows, because nothing does.
    expect(last?.truncated).toBe(false);
  });

  it("says so when the target or the file is gone", async () => {
    // Ruling 260's rule holds for the resource too: an id that never named one
    // is not one that "no longer exists". CANARY: restore "That resource no
    // longer exists." and a mistyped id reads as a deletion, with no pointer
    // to the ids that are real.
    expect(
      await call(ids.orgAdmin, "read_store_doc", {
        kind: "kb",
        id: "kb_nope",
        path: ["ops-note.md"],
      }),
    ).toBe("[error] No knowledge base has the id kb_nope; list_knowledge_bases names them.");
    expect(
      await call(ids.orgAdmin, "read_store_doc", {
        kind: "skill",
        id: "sk_nope",
        path: ["SKILL.md"],
      }),
    ).toBe("[error] No skill has the id sk_nope; list_skills names them.");
    // Ruling 260 (F37-75): "no longer exists" claimed the file once did, and
    // sent the controller looking for a deletion that never happened. The
    // message now says what this reader IS. CANARY: restore the old sentence
    // and the caller most likely to hit this — one that confused the store
    // with the git repository — learns nothing about which place it asked.
    const missing = await call(ids.orgAdmin, "read_store_doc", {
      kind: "kb",
      id: kbId,
      path: ["gone.md"],
    });
    expect(missing).toContain("has no `gone.md`");
    expect(missing).toContain("not a git repository");
    // Ruling 260: and the doors that do read a repo file, which since ruling
    // 265 include the controller's own. CANARY: say "Viberr has no tool that
    // returns repository file contents" again and the controller is told it
    // cannot do what read_default_branch_file does.
    expect(missing).toContain(
      "read_default_branch_file reads a file as the project's default branch has it, and read_pull_request a pull request's changed files.",
    );
    expect(missing).not.toContain("no longer exists");
  });
});
