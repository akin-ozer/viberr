import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import { runConcurrencySnapshot } from "~/server/runtimes/run-service.server";
import type { JsonValue } from "~/features/runtime/runtime-types";

/**
 * Ruling 107 — `viberr_ops`, the controller's built-in diagnostics server.
 *
 * The contract under test: three READ-ONLY tools, each resolving the ASKING
 * PERSON's authority live, per call, and refusing in the toolkit's own voice.
 * `instance_health` answers anyone (the health probe is unauthenticated by
 * design); `read_run_log` applies the run-log route's exact gate and answers
 * ONE not-visible sentence to a missing run, a forbidden project and a
 * forbidden conversation alike; `read_store_doc` is org-admin only.
 *
 * Fixture roles on viberr-core (demo seed): elif = project admin (org member),
 * arda = project admin + ORG admin, deniz = org member and a member of nothing.
 */

let app: AppTestContext;
const SLUG = "viberr-core";
const PROJECT_RUN = "run_ops_project";
const CONTROLLER_RUN = "run_ops_controller";
const LOG_LINES = 12;
/** `readStoreDoc`'s own per-read ceiling, which the tool takes as its default. */
const READ_DOC_BYTES = 256 * 1024;

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
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedDefaultAgentAssets } = await import(
    "~/server/seed/default-assets.server"
  );
  seedDefaultAgentAssets(app.dataRoot);

  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    orgAdmin: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    projectAdmin: findUserByEmail(app.db, "elif@viberr.dev")!.id,
    nonMember: findUserByEmail(app.db, "deniz@viberr.dev")!.id,
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
    // Ruling 99's controller scope: no project, task_key = conversation id.
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
  for (const runId of [PROJECT_RUN, CONTROLLER_RUN]) {
    for (let i = 0; i < LOG_LINES; i += 1) {
      insertRunLine(app.db, {
        runId,
        seq: i,
        occurredAt: "2026-09-01T00:00:00.000Z",
        raw: JSON.stringify({ i }),
        display: { t: "00:00:00", ev: "text", tag: "assistant", text: `l${i}` },
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
  writeStoreDoc(
    app.db,
    target,
    [],
    "ops-long.md",
    "x".repeat(READ_DOC_BYTES + 4_096),
    storeActor,
    { overwrite: true },
  );
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
  const tool = ops.tools.find((t) => t.name === toolName);
  expect(tool, `tool ${toolName} must exist`).toBeTruthy();
  // SAFETY: every ops handler is wrapped by the shared `run`, which always
  // returns the text shape: { content: [{ type: "text", text }] }.
  const result = (await tool!.handler(args, {})) as {
    content: { text: string }[];
  };
  return result.content[0]!.text;
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
  backends: z.object({ claude: z.string(), codex: z.string() }),
  maintenance: z.object({ scheduled: z.boolean() }),
  build: z.object({ version: z.string().nullable() }),
  backendCredentials: z.array(
    z.object({
      backend: z.string(),
      available: z.boolean(),
      verification: z.string(),
      detail: z.string().nullable(),
    }),
  ),
  runs: z.object({ cap: z.number(), live: z.number(), queued: z.number() }),
});

const RUN_LOG_REPLY = z.object({
  run: z.object({
    id: z.string(),
    kind: z.string(),
    state: z.string(),
    project: z.string(),
    task: z.string(),
  }),
  headSeq: z.number(),
  oldestSeq: z.number(),
  hasMore: z.boolean(),
  lines: z.array(z.object({ seq: z.number(), at: z.string() })),
});

const STORE_DOC_REPLY = z.object({
  resource: z.object({ kind: z.string(), id: z.string(), name: z.string() }),
  path: z.array(z.string()),
  truncated: z.boolean(),
  text: z.string(),
});

/** A tool answer that is not a refusal, read through its schema. */
function parsed<T>(schema: z.ZodType<T>, reply: string): T {
  expect(reply.startsWith("["), `expected data, got: ${reply}`).toBe(false);
  return schema.parse(JSON.parse(reply));
}

// ------------------------------------------------------------ tool surface

describe("the diagnostics surface is read-only and named for the mount", () => {
  it("offers exactly the three read tools, under the viberr_ops tool names", async () => {
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
      "read_run_log",
      "read_store_doc",
    ]);
    expect(ops.allowedTools).toEqual([
      "mcp__viberr_ops__instance_health",
      "mcp__viberr_ops__read_run_log",
      "mcp__viberr_ops__read_store_doc",
    ]);
    expect(Object.keys(ops.mcpServers)).toEqual([CONTROLLER_OPS_MCP_NAME]);
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
    // Why a backend reads the way it does — the health probe reports env
    // presence only, and "unavailable" with no reason sends someone hunting.
    expect(body.backendCredentials.map((c) => c.backend)).toEqual([
      "claude",
      "codex",
    ]);
    // The concurrency gate, live: a queued run is the usual answer to "why has
    // nothing started".
    expect(body.runs.cap).toBe(runConcurrencySnapshot(app.db).cap);
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

  it("clamps the page size instead of serving what paging exists to avoid", async () => {
    const huge = parsed(
      RUN_LOG_REPLY,
      await call(ids.projectAdmin, "read_run_log", {
        runId: PROJECT_RUN,
        limit: 99_999,
      }),
    );
    expect(huge.lines.length).toBe(LOG_LINES); // 500, capped by reality
    const zero = parsed(
      RUN_LOG_REPLY,
      await call(ids.projectAdmin, "read_run_log", {
        runId: PROJECT_RUN,
        before: 6,
        limit: 0,
      }),
    );
    // Clamped UP to 1, never down to "everything".
    expect(zero.lines.length).toBe(1);
    const tail = parsed(
      RUN_LOG_REPLY,
      await call(ids.projectAdmin, "read_run_log", {
        runId: PROJECT_RUN,
        since: 9,
      }),
    );
    expect(tail.lines.length).toBe(2);
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
    expect(body.resource).toEqual(expect.objectContaining({ kind: "kb", id: kbId }));

    // A document longer than one read comes back CLIPPED and says so. Without
    // this arm `truncated` could be the constant `false` and read identically —
    // which is how a model states half a file as the whole of it.
    const long = parsed(
      STORE_DOC_REPLY,
      await call(ids.orgAdmin, "read_store_doc", {
        kind: "kb",
        id: kbId,
        path: ["ops-long.md"],
      }),
    );
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(READ_DOC_BYTES);
  });

  it("says so when the target or the file is gone", async () => {
    expect(
      await call(ids.orgAdmin, "read_store_doc", {
        kind: "kb",
        id: "kb_nope",
        path: ["ops-note.md"],
      }),
    ).toBe("[error] That resource no longer exists.");
    expect(
      await call(ids.orgAdmin, "read_store_doc", {
        kind: "kb",
        id: kbId,
        path: ["gone.md"],
      }),
    ).toBe("[error] That file no longer exists.");
  });
});
