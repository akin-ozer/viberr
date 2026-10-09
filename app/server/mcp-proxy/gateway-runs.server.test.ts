import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import {
  compactedRunSpecs,
  drainRunCompletions,
  installFakeRuntime,
  lastRunSpec,
  queueFakeCompaction,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import { settle, waitFor } from "../../../test-support/polling";
import { withEnv } from "../../../test-support/env";
import { writeFakeBrowser } from "../../../test-support/fake-browser";
import { startHttpUpstream, type UpstreamHandle } from "../../../test-support/mcp-upstream";
import { reconfigureProject } from "../../../test-support/projected-store";
import { appendTimelineEvent, readTaskFile } from "~/server/files/task-writer.server";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import { keepDelivery } from "~/server/files/kept-deliveries.server";
import { readTaskSources } from "~/server/files/task-sources.server";
import { imageHeader } from "~/server/files/task-attachments.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { interruptRun, startRun } from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";
import { sealSecret } from "~/server/secrets/secret-box.server";
import { SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { setMaxConcurrentRuns } from "~/server/settings/instance-settings.server";
import { resolveBoardMcp, resolveKnowledgeMcp, resolveSpecialistMcpServersDetailed } from "~/server/tasks/specialist-mcp.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { errorMessage } from "~/shared/errors";
import { runFailureReason } from "~/server/tasks/agent-reply.server";
import { mcpGatewayStatus, startMcpGateway, stopMcpGateway } from "./gateway.server";

/**
 * Ruling 191 through the run service: `startRun` is the one funnel that puts a
 * run's token on its gateway mounts (both backends), and every path that ends
 * a run — the settle after success or failure, an interrupt, and an interrupt
 * of a run that never had a live handle — revokes it.
 */

const SECRET = "cf-api-token-sentinel-runs";
/** Ruling 82: a board mount's other inputs, for a run that reads the board
 *  and may not save a file on its task. */
const READS_ONLY = {
  keepsSources: false,
  webEgress: true,
  browser: false,
  agent: { profileId: "workflow-researcher", roleHint: "Workflow Researcher" },
};
/** Ruling 158(b): one call with one answer, 100 times within 60 seconds. */
const LOOP_REPEATS = 100;
let ctx: TestDbContext;
let store: TestStore;
let upstream: UpstreamHandle;

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  for (const key of ["VIB-1", "VIB-2"]) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, { stage: "impl", ownerUserId: store.users.arda.id }),
    });
  }
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
  await connectFakeBackend(store.db, store.users.arda.id, "codex");
  await startMcpGateway({ port: 0 });
  upstream = await startHttpUpstream(SECRET);
  const now = new Date().toISOString();
  const insert = store.db.prepare(
    `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("mcp_cf", "cloudflare", "HTTP", upstream.url, sealSecret(SECRET), now, now);
  insert.run("mcp_pg", "pg", "stdio", "npx -y @mcp/server-postgres", sealSecret(SECRET), now, now);
  insert.run("mcp_docs", "docs", "HTTP", "https://docs.example.test/mcp", null, now, now);
});

afterEach(async () => {
  await drainRunCompletions();
  await stopMcpGateway();
  await upstream.close();
  ctx.cleanup();
});

const mountSchema = z.strictObject({
  type: z.literal("http"),
  url: z.string(),
  headers: z.strictObject({ Authorization: z.string() }),
});

async function startWithMounts(
  backend: RealBackend,
  run: { keepRunning?: boolean; outcome?: "finished" | "error"; taskKey?: string } = {},
): Promise<{ runId: string; outcome: string }> {
  queueFakeRun(
    {
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
      sessionId: "s",
      backend,
      keepRunning: run.keepRunning ?? false,
      outcome: run.outcome ?? "finished",
    },
    backend,
  );
  // The resolver skips no step here: what a run mounts is what it resolved.
  const { servers } = resolveSpecialistMcpServersDetailed(store.db, ["cloudflare", "pg", "docs"]);
  const result = await startRun(store.db, {
    projectSlug: store.slug,
    taskKey: run.taskKey ?? "VIB-1",
    role: "Developer",
    kind: "primary",
    backend,
    model: defaultModelFor(backend),
    prompt: "go",
    dataRoot: store.dataRoot,
    mcpServers: servers,
    agentProfileId: "developer",
    credentialUserId: store.users.arda.id,
  });
  await settle();
  return { runId: result.runId, outcome: result.outcome };
}

async function gatewayAnswers(url: string, authorization: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    }),
  });
  await response.body?.cancel();
  return response.status;
}

const interrupt = (runId: string, taskKey = "VIB-1") =>
  interruptRun(
    store.db,
    { projectSlug: store.slug, taskKey, dataRoot: store.dataRoot, runId },
    { userId: store.users.arda.id, label: store.users.arda.email },
  );

describe("startRun puts the run's token on its gateway mounts (ruling 191)", () => {
  for (const backend of ["claude", "codex"] satisfies RealBackend[]) {
    it(`${backend}: a credentialed HTTP and stdio server are gateway mounts with ONE run token; the spec never holds the credential`, async () => {
      const { runId } = await startWithMounts(backend, { keepRunning: true });
      const spec = lastRunSpec();
      expect(spec?.runId).toBe(runId);
      const cloudflare = mountSchema.parse(spec?.mcpServers?.cloudflare);
      const pg = mountSchema.parse(spec?.mcpServers?.pg);
      expect(cloudflare.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/cloudflare$/);
      expect(pg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/pg$/);
      expect(cloudflare.headers.Authorization).toMatch(/^Bearer \S{43}$/);
      expect(pg.headers).toEqual(cloudflare.headers);
      // An uncredentialed server mounts directly, untouched.
      expect(spec?.mcpServers?.docs).toEqual({ type: "http", url: "https://docs.example.test/mcp" });
      // CANARY: attach the credential anywhere in the run's config and this is red.
      expect(JSON.stringify(spec)).not.toContain(SECRET);

      // The token works through the gateway while the run is live …
      const client = new Client({ name: "agent-cli", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(cloudflare.url), {
          requestInit: { headers: cloudflare.headers },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("whoami");
      await client.close();
      expect(upstream.authorizations.every((header) => header === `Bearer ${SECRET}`)).toBe(true);
      await interrupt(runId);
    });
  }
});

describe("every path that ends a run revokes its token (ruling 191)", () => {
  it.each([
    { backend: "claude", outcome: "finished" },
    { backend: "codex", outcome: "error" },
  ] as const)("a $backend run that ends $outcome: the settle revokes its token", async ({ backend, outcome }) => {
    await startWithMounts(backend, { outcome });
    const cloudflare = mountSchema.parse(lastRunSpec()?.mcpServers?.cloudflare);
    expect(getRun(store.db, lastRunSpec()!.runId)?.state).toBe(outcome);
    // CANARY: drop the settle's revoke (before the finalize) and a token outlives its run.
    expect(mcpGatewayStatus().liveTokens).toBe(0);
    expect(await gatewayAnswers(cloudflare.url, cloudflare.headers.Authorization)).toBe(401);
  });

  it("interrupt: a live run's token stops working", async () => {
    const { runId } = await startWithMounts("claude", { keepRunning: true });
    const cloudflare = mountSchema.parse(lastRunSpec()?.mcpServers?.cloudflare);
    expect(mcpGatewayStatus().liveTokens).toBe(1);
    expect(await gatewayAnswers(cloudflare.url, cloudflare.headers.Authorization)).toBe(200);
    await interrupt(runId);
    await settle();
    expect(mcpGatewayStatus().liveTokens).toBe(0);
    expect(await gatewayAnswers(cloudflare.url, cloudflare.headers.Authorization)).toBe(401);
  });

  it("R-gateway-4: the completion compaction still lists the run's gateway servers, calls none, and the token dies after it", async () => {
    // Ruling 174: the compaction replays the session with the run's own MCP
    // servers, or its prefix misses the cache it exists to read. CANARY:
    // revoke first thing in `settleRun` again, and the compaction's listing
    // is refused 401.
    let during: { listed: string[]; call: string } | null = null;
    queueFakeRun(
      {
        sessionId: "sess-big",
        lines: [
          { t: "1", ev: "text", tag: "assistant", text: "read a lot" },
          { t: "2", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 2, cost: 4, in: 120_000, cached: 0, out: 500 } },
        ],
        extraFacts: [
          {
            cache: {
              messageId: "m1",
              promptTokens: 120_000,
              cacheWrite: 2_000,
              cacheRead: 118_000,
              perCall: true,
              ttl: { fiveMinute: 0, oneHour: 2_000 },
              missReason: null,
            },
          },
          undefined,
        ],
      },
      "claude",
    );
    queueFakeCompaction("claude", { compacted: true, preTokens: 120_000, postTokens: 18_000 }, async () => {
      const cloudflare = mountSchema.parse(lastRunSpec()?.mcpServers?.cloudflare);
      const client = new Client({ name: "agent-cli-compaction", version: "1.0.0" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(cloudflare.url), { requestInit: { headers: cloudflare.headers } }),
        );
        const listed = (await client.listTools()).tools.map((tool) => tool.name);
        const [called] = await Promise.allSettled([client.callTool({ name: "whoami", arguments: {} })]);
        during = { listed, call: called.status === "fulfilled" ? "called" : errorMessage(called.reason) };
      } catch (error) {
        during = { listed: [], call: `the compaction could not reach the gateway: ${errorMessage(error)}` };
      } finally {
        await client.close();
      }
    });
    const { servers } = resolveSpecialistMcpServersDetailed(store.db, ["cloudflare"]);
    await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Developer",
      kind: "primary",
      backend: "claude",
      model: defaultModelFor("claude"),
      prompt: "go",
      dataRoot: store.dataRoot,
      mcpServers: servers,
      agentProfileId: "developer",
      credentialUserId: store.users.arda.id,
    });
    await waitFor(() => during !== null && mcpGatewayStatus().liveTokens === 0, "the compaction and the revoke");
    expect(compactedRunSpecs()).toHaveLength(1);
    expect(during).toEqual({ listed: ["whoami", "delete_zone", "slow", "fail"], call: expect.stringContaining("has ended") });
    // Nothing was called upstream for a run that was over.
    expect(upstream.calls).toEqual([]);
    const cloudflare = mountSchema.parse(lastRunSpec()?.mcpServers?.cloudflare);
    expect(await gatewayAnswers(cloudflare.url, cloudflare.headers.Authorization)).toBe(401);
  });

  it("no live handle: a queued run interrupted before it ever started loses its token", async () => {
    setMaxConcurrentRuns(store.db, 1, SYSTEM_ACTOR);
    const first = await startWithMounts("claude", { keepRunning: true });
    expect(first.outcome).toBe("started");
    const queued = await startWithMounts("claude", { keepRunning: true, taskKey: "VIB-2" });
    expect(queued.outcome).toBe("queued");
    // Both hold a token: the queued one was bound in `startRun`, before the cap.
    expect(mcpGatewayStatus().liveTokens).toBe(2);

    await interrupt(queued.runId, "VIB-2");
    // CANARY: drop the revoke in `stopRunProcess` and the queued run's token
    // lives on with no process that could ever settle it.
    expect(mcpGatewayStatus().liveTokens).toBe(1);
    await interrupt(first.runId);
    await settle();
    expect(mcpGatewayStatus().liveTokens).toBe(0);
  });
});

describe("ruling 216: the gateway answers a Codex run's knowledge server itself", () => {
  it("reads and corrects the knowledge bases the run holds, a private one included, and nothing else, while the run lives", async () => {
    // An agent on the project is not given `answer-keys`, as AWSC-97's
    // Inventory Analyst is not given the calculator research.
    reconfigureProject(store, (fm) => ({
      agents: [
        ...fm.agents,
        {
          profileId: "inventory-analyst",
          capabilities: [],
          extras: [],
          definition: { kind: "specialist", name: "Inventory Analyst", role: "Intake", backends: ["codex"], model: defaultModelFor("codex") },
        },
      ],
    }));
    const dir = path.join(store.dataRoot, "kb", "answer-keys");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sample-01.md"), "# Sample 01\n\nThe expected total is 1234.56.\n");
    chmodSync(dir, 0o700);
    const agent = { profileId: "estimate-judge", roleHint: "Estimate Judge" };
    // A Claude run has these tools in its toolkit, and a run with no
    // knowledge base needs none.
    expect(resolveKnowledgeMcp({ backend: "claude", kb: ["answer-keys"], dataRoot: store.dataRoot, agent })).toBeNull();
    expect(resolveKnowledgeMcp({ backend: "codex", kb: [], dataRoot: store.dataRoot, agent })).toBeNull();
    const mount = resolveKnowledgeMcp({ backend: "codex", kb: ["answer-keys"], dataRoot: store.dataRoot, agent });
    const boardMount = resolveBoardMcp({ backend: "codex", collaborates: true, ...READS_ONLY, dataRoot: store.dataRoot });
    queueFakeRun({ lines: [{ t: "1", ev: "text", tag: "assistant", text: "scoring" }], sessionId: "s", backend: "codex", keepRunning: true }, "codex");
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Estimate Judge",
      kind: "reviewer",
      backend: "codex",
      model: defaultModelFor("codex"),
      prompt: "go",
      dataRoot: store.dataRoot,
      mcpServers: { viberr_knowledge: mount!, viberr_board: boardMount! },
      agentProfileId: "estimate-judge",
      credentialUserId: store.users.arda.id,
    });
    await settle();
    // CANARY: leave the mount's list on the run's config and this parse fails:
    // the run is handed the URL and its token, never the list or the store.
    const knowledge = mountSchema.parse(lastRunSpec()?.mcpServers?.viberr_knowledge);
    expect(knowledge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/viberr_knowledge$/);

    const client = new Client({ name: "codex-cli", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(knowledge.url), { requestInit: { headers: knowledge.headers } }));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["read_knowledge_doc", "correct_knowledge_doc"]);
    const call = async (name: string, args: Record<string, string>) => {
      const result = await client.callTool({ name, arguments: args });
      return z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text;
    };
    // CANARY: route the knowledge server to an upstream and nothing answers.
    expect(await call("read_knowledge_doc", { kb: "answer-keys", path: "sample-01.md" })).toContain("The expected total is 1234.56.");
    expect(await call("read_knowledge_doc", { kb: "aws-calculator-research", path: "calculator.md" })).toContain(
      "No knowledge base `aws-calculator-research` is attached to this run",
    );
    // The correction is written as the run's agent, on the run's task.
    expect(
      await call("correct_knowledge_doc", {
        kb: "answer-keys",
        // Ruling 210(a): the document is `path`, as read_knowledge_doc names it.
        path: "sample-01.md",
        replaces: "The expected total is 1234.56.",
        text: "The expected total is 1250.00.",
        evidence: "The calculator's own total for the saved estimate.",
      }),
    ).toMatch(/^\[done\]/);
    expect(readFileSync(path.join(dir, "sample-01.md"), "utf8")).toContain("The expected total is 1250.00.");
    const [entry] = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline;
    expect(entry).toMatchObject({ type: "kb_correction", actor: { kind: "agent", backend: "codex", profileId: "estimate-judge" } });
    await client.close();

    // Ruling 211: the run is given `answer-keys`, so its board server reads
    // the correction whole, though the entry quotes none of it for the agents
    // that are not (ruling 211). Live on AWSC-97 the Estimate Judge, given the
    // calculator research, could not read the evidence of a correction to it.
    // CANARY: drop `readerKbs` from the board session and this reads
    // `notQuoted`.
    expect(entry!.text).toContain("The passage is not quoted here");
    const boardConfig = mountSchema.parse(lastRunSpec()?.mcpServers?.viberr_board);
    const board = new Client({ name: "codex-cli", version: "1.0.0" });
    await board.connect(new StreamableHTTPClientTransport(new URL(boardConfig.url), { requestInit: { headers: boardConfig.headers } }));
    const read = await board.callTool({ name: "read_timeline_entry", arguments: { occurredAt: entry!.occurredAt } });
    const reading = z
      .object({ correction: z.object({ now: z.string(), evidence: z.string() }) })
      .parse(JSON.parse(z.array(z.object({ text: z.string() })).parse(read.content)[0]!.text));
    expect(reading.correction.now).toContain("The expected total is 1250.00.");
    expect(reading.correction.evidence).toBe("The calculator's own total for the saved estimate.");
    await board.close();

    await interrupt(runId);
    await settle();
    expect(await gatewayAnswers(knowledge.url, knowledge.headers.Authorization)).toBe(401);
  });
});

describe("ruling 216: the gateway answers a Codex run's board server itself", () => {
  it("reads the board, another task's verdict and one entry of the run's own task, while the run lives", async () => {
    // Live on AWSC-24 the Workflow Researcher, on Codex, could not read the
    // Judge's verdicts on the tasks it compared and used the operator's
    // summaries instead.
    const deliveredAt = "2026-09-29T10:06:43.529Z";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        stage: "done",
        ownerUserId: store.users.arda.id,
        deliveredAt,
        verdicts: [
          {
            profileId: "estimate-judge",
            revisionId: `files:${deliveredAt}`,
            result: "approve",
            reason: "## Verdict: approve, 95/100",
            at: "2026-09-29T10:10:00.000Z",
            rounds: 1,
          },
        ],
      }),
      timeline: [
        {
          occurredAt: "2026-09-29T10:10:00.000Z",
          type: "comment",
          actor: { kind: "agent", backend: "codex", profileId: "estimate-judge", roleHint: "Estimate Judge" },
          title: "Review verdict",
          text: "## Verdict: approve, 95/100",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    const answer = `1: Yes, the owner approves the redesign. ${"2: the address is app01's own. ".repeat(12).trim()}`;
    // Ruling 72: a report longer than a page, beside its marker.
    const longAt = "2026-09-29T11:30:00.000Z";
    const longReport = `## Findings\n\n${"A finding with its file and line. ".repeat(2_500)}\n\nSENTINEL-AT-THE-END`;
    const judge = { kind: "agent" as const, backend: "codex" as const, profileId: "estimate-judge", roleHint: "Estimate Judge" };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", ownerUserId: store.users.arda.id }),
      timeline: [
        { occurredAt: longAt, type: "quality", actor: judge, title: "Changes requested", text: "**Validation:** failing.", toAgent: false, evidence: null },
        { occurredAt: longAt, type: "comment", actor: judge, title: "Review verdict", text: longReport, toAgent: false, evidence: null },
        {
          occurredAt: "2026-09-29T11:11:33.126Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.arda.id, nameHint: "Arda" },
          title: null,
          text: answer,
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // A Claude run has these tools in its toolkit, and a run that holds no
    // collaboration grant reads no more of the board than its prompt.
    expect(resolveBoardMcp({ backend: "claude", collaborates: true, ...READS_ONLY, dataRoot: store.dataRoot })).toBeNull();
    expect(resolveBoardMcp({ backend: "codex", collaborates: false, ...READS_ONLY, dataRoot: store.dataRoot })).toBeNull();
    const mount = resolveBoardMcp({ backend: "codex", collaborates: true, ...READS_ONLY, dataRoot: store.dataRoot });
    queueFakeRun({ lines: [{ t: "1", ev: "text", tag: "assistant", text: "comparing" }], sessionId: "s", backend: "codex", keepRunning: true }, "codex");
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Workflow Researcher",
      kind: "primary",
      backend: "codex",
      model: defaultModelFor("codex"),
      prompt: "go",
      dataRoot: store.dataRoot,
      mcpServers: { viberr_board: mount! },
      agentProfileId: "workflow-researcher",
      credentialUserId: store.users.arda.id,
    });
    await settle();
    // CANARY: leave the store on the run's config and this parse fails.
    const board = mountSchema.parse(lastRunSpec()?.mcpServers?.viberr_board);
    expect(board.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/viberr_board$/);

    const client = new Client({ name: "codex-cli", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(board.url), { requestInit: { headers: board.headers } }));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "read_board",
      "read_timeline_entry",
      "read_task_attachment",
      "read_task_source",
    ]);
    const call = async (name: string, args: Record<string, string>) => {
      const result = await client.callTool({ name, arguments: args });
      return z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text;
    };
    // CANARY: route the board server to an upstream and nothing answers.
    const list = z.array(z.object({ key: z.string() })).parse(JSON.parse(await call("read_board", {})));
    expect(list.map((task) => task.key).sort()).toEqual(["VIB-1", "VIB-2"]);
    const other = z
      .object({ outcome: z.object({ verdicts: z.array(z.object({ agent: z.string(), result: z.string(), report: z.string() })) }) })
      .parse(JSON.parse(await call("read_board", { taskKey: "VIB-2" })));
    expect(other.outcome.verdicts).toEqual([{ agent: "estimate-judge", result: "approve", report: "## Verdict: approve, 95/100" }]);
    // CANARY: read another task's timeline and the whole answer is not there.
    const entry = z.object({ text: z.string() }).parse(JSON.parse(await call("read_timeline_entry", { occurredAt: "2026-09-29T11:11:33.126Z" })));
    expect(entry.text).toBe(answer);
    const refused = await client.callTool({ name: "read_timeline_entry", arguments: { at: "2026-09-29T11:11:33.126Z" } });
    expect(refused.isError).toBe(true);
    // Ruling 213(d): a long entry in pages, through the door a Codex run has.
    // This is the run a page was sized for (ruling 215): over about 40,000
    // bytes its tool output is cut from the middle. CANARY: drop `offset` or
    // `entry` on the way from this door to the reader, and a Codex run's
    // second read is the first page again.
    const entryPage = z.object({ entry: z.number(), truncated: z.boolean(), text: z.string(), nextOffset: z.number().optional() });
    const readPage = async (args: Record<string, number>) => {
      const result = await client.callTool({ name: "read_timeline_entry", arguments: { occurredAt: longAt, ...args } });
      const printedAs = z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text;
      expect(Buffer.byteLength(JSON.stringify(result.content)) / 4).toBeLessThanOrEqual(10_000);
      return entryPage.parse(JSON.parse(printedAs));
    };
    let part = await readPage({ entry: 1 });
    expect(part.truncated).toBe(true);
    let joined = part.text;
    // Bounded, so a door that drops `offset` fails here and does not spin.
    for (let pages = 1; part.nextOffset !== undefined && pages < 10; pages += 1) {
      part = await readPage({ entry: 1, offset: part.nextOffset });
      joined += part.text;
    }
    expect(joined).toBe(longReport);
    expect((await readPage({ entry: 2 })).text).toBe("**Validation:** failing.");
    // What this door refuses, it refuses in words a run can act on: each
    // argument by what it takes. A run told a number is text sends "32000"
    // and is refused again.
    // CANARIES: take a fraction, a negative offset or `entry: 0`; say "as
    // text" of the two numbers.
    const refusedWith = async (name: string, args: Record<string, string | number>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      return z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text;
    };
    const entryRefusal =
      "read_timeline_entry takes `occurredAt` and `taskKey` as text, `offset` as a whole number from 0 and `entry` as a whole number from 1, " +
      "and nothing else; `occurredAt` is required. Nothing was read.";
    const badPages: Record<string, string | number>[] = [{ offset: 1.5 }, { offset: -1 }, { offset: "32000" }, { entry: 0 }, { entry: 1.5 }, { entry: "1" }];
    for (const bad of badPages) {
      expect(await refusedWith("read_timeline_entry", { occurredAt: longAt, ...bad })).toBe(entryRefusal);
    }
    // An argument the tool does not declare is refused, as on Claude, never
    // dropped (ruling 216): a run that passes back `nextOffset` under its own
    // name, or asks for `page: 2`, is not answered the first page again as a
    // good read. CANARY: parse this door's arguments loosely.
    expect(await refusedWith("read_timeline_entry", { occurredAt: longAt, nextOffset: 31_976 })).toBe(entryRefusal);
    expect(await refusedWith("read_timeline_entry", { occurredAt: longAt, entry: 1, page: 2 })).toBe(entryRefusal);
    // The other readers of this server hold to the same two rules: the
    // attachment reader pages too, and parsed loosely it would answer
    // `nextOffset` under its own name with the first page again. CANARY:
    // leave either parser loose, or either published schema silent on it.
    const attachmentRefusal =
      "read_task_attachment takes `name`, `taskKey` and `delivery` as text and `offset` as a whole number from 0, and nothing else; `name` is required. Nothing was read.";
    expect(await refusedWith("read_task_attachment", { name: "holdout-comparison.md", offset: "5" })).toBe(attachmentRefusal);
    expect(await refusedWith("read_task_attachment", { name: "holdout-comparison.md", nextOffset: 32_000 })).toBe(attachmentRefusal);
    expect(await refusedWith("read_task_source", { id: "S1", page: 2 })).toBe(
      "read_task_source takes `id`, `taskKey` and `find` as text and `offset` as a whole number from 0, and nothing else. Nothing was read.",
    );
    const boardRefusal = "read_board takes `taskKey` as text, and nothing else. Nothing was read.";
    expect(await refusedWith("read_board", { taskKey: 5 })).toBe(boardRefusal);
    expect(await refusedWith("read_board", { undeclared: "x" })).toBe(boardRefusal);
    const strictOnes = (await client.listTools()).tools.filter((tool) => tool.name !== "keep_source");
    expect(strictOnes.map((tool) => [tool.name, tool.inputSchema.additionalProperties])).toEqual([
      ["read_board", false],
      ["read_timeline_entry", false],
      ["read_task_attachment", false],
      ["read_task_source", false],
    ]);
    const listedEntry = (await client.listTools()).tools.find((tool) => tool.name === "read_timeline_entry");
    expect(listedEntry?.description).toContain("A long entry comes in pages of up to 32,000 bytes");
    expect(listedEntry?.description).toContain("read and print one page per call");
    expect(Object.keys(listedEntry?.inputSchema.properties ?? {})).toEqual(["occurredAt", "taskKey", "offset", "entry"]);
    // Whole numbers with their floors, and nothing undeclared, as the model is told.
    expect(listedEntry?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { offset: { type: "integer", minimum: 0 }, entry: { type: "integer", minimum: 1 } },
    });
    expect(z.object({ offset: z.object({ description: z.string() }), entry: z.object({ description: z.string() }) }).parse(listedEntry?.inputSchema.properties)).toMatchObject({
      offset: { description: expect.stringContaining("the `nextOffset` a truncated read returned") },
      entry: { description: expect.stringContaining("counted from 1 in the order they were written") },
    });
    // Ruling 213: another task's entry, by the stamp read_board lists for it.
    // CANARY: bind the gateway's reader to the run's own task and this reads a miss.
    expect(z.object({ timeline: z.array(z.string()) }).parse(JSON.parse(await call("read_board", { taskKey: "VIB-2" }))).timeline).toEqual([
      "2026-09-29T10:10:00.000Z · comment · agent:estimate-judge · Review verdict",
    ]);
    const verdictEntry = z
      .object({ text: z.string() })
      .parse(JSON.parse(await call("read_timeline_entry", { taskKey: "VIB-2", occurredAt: "2026-09-29T10:10:00.000Z" })));
    expect(verdictEntry.text).toBe("## Verdict: approve, 95/100");
    // Ruling 214: another task's file, read where it is; `read_board` names it.
    const vib2 = taskAttachmentsDir(store.slug, "VIB-2", store.dataRoot);
    mkdirSync(vib2, { recursive: true });
    writeFileSync(path.join(vib2, "holdout-comparison.md"), "# Hold-outs\n\n## Exposure register\n");
    expect(z.object({ files: z.array(z.string()) }).parse(JSON.parse(await call("read_board", { taskKey: "VIB-2" }))).files).toEqual([
      "holdout-comparison.md",
    ]);
    // CANARY: route read_task_attachment nowhere and this is refused.
    expect(await call("read_task_attachment", { taskKey: "VIB-2", name: "holdout-comparison.md" })).toContain("## Exposure register");
    expect(await call("read_task_attachment", { name: "holdout-comparison.md" })).toContain("[noop] VIB-1 has no attachment");
    // Ruling 198: the file as a kept delivery held it. CANARY: drop `delivery`
    // on the way to the reader and this reads the current text.
    keepDelivery(store.slug, "VIB-2", "2026-09-29T10:00:00.000Z", ["holdout-comparison.md"], store.dataRoot);
    writeFileSync(path.join(vib2, "holdout-comparison.md"), "# Hold-outs, reworked\n");
    expect(
      await call("read_task_attachment", { taskKey: "VIB-2", name: "holdout-comparison.md", delivery: "2026-09-29T10:00:00.000Z" }),
    ).toContain("## Exposure register");
    await client.close();

    await interrupt(runId);
    await settle();
    expect(await gatewayAnswers(board.url, board.headers.Authorization)).toBe(401);
  });
});

describe("ruling 82: a Codex run keeps and reads a task's sources through the board server", () => {
  it("a Codex run that may post files keeps a source through the board server as its own agent and run, and one that may not is offered no keep_source", async () => {
    // The transport the server suites cannot reach: the mount carrying the
    // agent, tools/list per grant, the call routed with the gateway's own run
    // id. CANARY: leave `sources` off the mount in resolveBoardMcp and
    // tools/list has no keep_source for the granted run.
    const agent = { profileId: "cost-researcher", roleHint: "Cost Researcher" };
    const startCodexRun = async (taskKey: string, keepsSources: boolean) => {
      const mount = resolveBoardMcp({ backend: "codex", collaborates: true, keepsSources, webEgress: true, browser: false, agent, dataRoot: store.dataRoot });
      queueFakeRun({ lines: [{ t: "1", ev: "text", tag: "assistant", text: "pricing" }], sessionId: "s", backend: "codex", keepRunning: true }, "codex");
      const { runId } = await startRun(store.db, {
        projectSlug: store.slug,
        taskKey,
        role: "Cost Researcher",
        kind: "primary",
        backend: "codex",
        model: defaultModelFor("codex"),
        prompt: "go",
        dataRoot: store.dataRoot,
        mcpServers: { viberr_board: mount! },
        agentProfileId: "cost-researcher",
        credentialUserId: store.users.arda.id,
      });
      await settle();
      // The run is handed the URL and its token, never the agent or the store.
      const board = mountSchema.parse(lastRunSpec()?.mcpServers?.viberr_board);
      const client = new Client({ name: "codex-cli", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(board.url), { requestInit: { headers: board.headers } }));
      return { runId, client };
    };
    const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text;

    const keeper = await startCodexRun("VIB-1", true);
    expect((await keeper.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "read_board",
      "read_timeline_entry",
      "read_task_attachment",
      "read_task_source",
      "keep_source",
    ]);
    // The run staged the page with its own shell; the server keeps it.
    const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".source-aws-pricing.html"), "<html>t3.medium $0.0416 per hour</html>");
    const kept = await keeper.client.callTool({
      name: "keep_source",
      arguments: {
        file: ".source-aws-pricing.html",
        from: "https://aws.amazon.com/ec2/pricing/on-demand/",
        title: "AWS EC2 on-demand pricing",
      },
    });
    expect(textOf(kept)).toMatch(/^\[kept\] S1: aws-pricing\.html, 39 bytes, /);
    expect(readTaskSources(store.slug, "VIB-1", store.dataRoot).sources).toMatchObject([
      { id: "S1", runId: keeper.runId, by: { backend: "codex", ...agent } },
    ]);
    // And reads it back, by the list and by its id.
    expect(textOf(await keeper.client.callTool({ name: "read_task_source", arguments: {} }))).toContain(
      "S1 · aws-pricing.html · 39 bytes",
    );
    expect(textOf(await keeper.client.callTool({ name: "read_task_source", arguments: { id: "S1" } }))).toContain(
      "t3.medium $0.0416 per hour",
    );
    // Ruling 82: and searches it. The arguments are parsed strictly here
    // (ruling 216). CANARY: declare `find` on the Claude twin alone and a
    // Codex run's search is refused as an argument the tool does not take.
    const sought = await keeper.client.callTool({
      name: "read_task_source",
      arguments: { id: "S1", find: "T3.MEDIUM   $0.0416" },
    });
    expect(sought.isError).not.toBe(true);
    expect(JSON.parse(textOf(sought))).toEqual({
      id: "S1",
      title: "AWS EC2 on-demand pricing",
      from: "https://aws.amazon.com/ec2/pricing/on-demand/",
      find: "T3.MEDIUM $0.0416",
      found: 1,
      hits: [{ line: 1, offset: 0, text: "<html>t3.medium $0.0416 per hour</html>" }],
    });
    // And the tool a Codex run lists says so, in the words the Claude one uses.
    const listed = (await keeper.client.listTools()).tools.find((tool) => tool.name === "read_task_source");
    expect(listed?.description).toContain("With `id` and `find`, the places in that source that hold a word or short phrase");
    expect(Object.keys(listed?.inputSchema.properties ?? {})).toEqual(["id", "taskKey", "offset", "find"]);
    expect(z.object({ find: z.object({ description: z.string() }) }).parse(listed?.inputSchema.properties).find.description).toContain(
      "A place that shows in the excerpt before it is not listed again. `nextOffset` is where to search on from when more follow.",
    );
    // An argument the tool does not declare is refused, as on Claude.
    const undeclared = await keeper.client.callTool({
      name: "keep_source",
      arguments: { file: ".source-aws-pricing.html", from: "x", title: "y", text: "the page said so" },
    });
    expect(undeclared.isError).toBe(true);
    expect(textOf(undeclared)).toBe("keep_source takes `file`, `from` and `title` as text, and nothing else. Nothing was kept.");
    await keeper.client.close();
    await interrupt(keeper.runId);
    await settle();

    // A run whose profile may not save a file on the task reads the sources
    // and is offered no way to keep one.
    const reader = await startCodexRun("VIB-2", false);
    expect((await reader.client.listTools()).tools.map((tool) => tool.name)).not.toContain("keep_source");
    writeFileSync(path.join(dir, ".source-second.html"), "<html>db.t3.medium</html>");
    const refused = await reader.client.callTool({
      name: "keep_source",
      arguments: { file: ".source-second.html", from: "https://aws.amazon.com/rds/pricing/", title: "RDS pricing" },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('"viberr_board" has no tool "keep_source"');
    expect(textOf(await reader.client.callTool({ name: "read_task_source", arguments: { taskKey: "VIB-1" } }))).toContain(
      "S1 · aws-pricing.html",
    );
    await reader.client.close();
    await interrupt(reader.runId, "VIB-2");
    await settle();
  });
});

describe("ruling 194: the gateway's board server pictures a page for a Codex run", () => {
  it("a Codex run's board server lists capture_page and answers it with the same pictures and the saved paths", async () => {
    const fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
    const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "post.html"), "<h1>Launch</h1><p>fake-height:2600</p>");
    const mount = resolveBoardMcp({
      backend: "codex",
      collaborates: true,
      // A writer's run holds both: it looks at its page and keeps its sources.
      keepsSources: true,
      webEgress: true,
      browser: false,
      agent: { profileId: "writer", roleHint: "Writer" },
      dataRoot: store.dataRoot,
    });
    queueFakeRun({ lines: [{ t: "1", ev: "text", tag: "assistant", text: "writing" }], sessionId: "s", backend: "codex", keepRunning: true }, "codex");
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Writer",
      kind: "primary",
      backend: "codex",
      model: defaultModelFor("codex"),
      prompt: "go",
      dataRoot: store.dataRoot,
      mcpServers: { viberr_board: mount! },
      agentProfileId: "writer",
      credentialUserId: store.users.arda.id,
    });
    await settle();
    const board = mountSchema.parse(lastRunSpec()?.mcpServers?.viberr_board);
    const connect = async () => {
      const client = new Client({ name: "codex-cli", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(board.url), { requestInit: { headers: board.headers } }));
      return client;
    };
    // A server with no browser offers no tool it could not answer.
    const without = await connect();
    expect((await without.listTools()).tools.map((tool) => tool.name)).not.toContain("capture_page");
    expect((await without.callTool({ name: "capture_page", arguments: { name: "post.html" } })).isError).toBe(true);
    await without.close();

    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env() }, async () => {
      const client = await connect();
      // CANARY: leave PAGE_CAPTURE_TOOL out of openBoardSession's list and the
      // call answers that the server has no such tool; build the list from
      // the page capture or the sources alone and the other tool is gone
      // from a run that holds both.
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "read_board",
        "read_timeline_entry",
        "read_task_attachment",
        "read_task_source",
        "capture_page",
        "keep_source",
      ]);
      const result = await client.callTool({ name: "capture_page", arguments: { name: "post.html", view: "desktop" } });
      const content = z
        .array(
          z.union([
            z.object({ type: z.literal("text"), text: z.string() }),
            z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
          ]),
        )
        .parse(result.content);
      expect(result.isError).toBeFalsy();
      const [text, picture] = content;
      // The text names where the picture was saved: whether a Codex model is
      // handed an image block is not established, and the run can open the
      // file with its own viewer.
      expect(text).toMatchObject({ type: "text" });
      expect(text?.type === "text" ? text.text : "").toMatch(
        /^\[done\] `post\.html` as a reader sees it\. Desktop, 1280 px wide: 0 to 2,000 px of 2,600 \(`nextFrom`: 2000\)\. Saved for this run at `\S+\/\.captures\/run_\S+\/cap_\S+\/out\/1-desktop\.png`: scratch/,
      );
      expect(content).toHaveLength(2);
      expect(picture?.type === "image" ? imageHeader(Buffer.from(picture.data, "base64")) : null).toEqual({
        mimeType: "image/png",
        width: 1280,
        height: 2000,
      });
      // Arguments that are not the tool's are answered with what each field
      // is. CANARY: answer with the board server's own "takes ... as text"
      // and a run that sent 99 for a width is told to send text.
      const notTheTools =
        "capture_page takes `name` as text, `view` as `desktop` or `phone`, `from` as a whole number of px up to 40000, " +
        "and, for a picture of an exact size, `width` and `height` as whole numbers of px from 100 to 4000 " +
        "and `scale` as one of 0.25, 0.5, 1, 1.5 and 2. Nothing was pictured.";
      const refused = await client.callTool({ name: "capture_page", arguments: { name: "post.html", view: "tablet" } });
      expect(refused.isError).toBe(true);
      expect(z.array(z.object({ text: z.string() })).parse(refused.content)[0]!.text).toBe(notTheTools);

      // Given a size, the same one picture of exactly that size a Claude run
      // gets, and the same word on how it is kept. CANARY: leave `width`,
      // `height` and `scale` out of pageCaptureArgsSchema (zod drops a key it
      // does not declare) or out of what pageCaptureResult passes on, and the
      // run that asked for a 2,400 by 1,260 px picture is handed the page in
      // stretches.
      const sized = z
        .array(
          z.union([
            z.object({ type: z.literal("text"), text: z.string() }),
            z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
          ]),
        )
        .parse(
          (await client.callTool({ name: "capture_page", arguments: { name: "post.html", width: 800, height: 630, scale: 2 } }))
            .content,
        );
      expect(sized[0]?.type === "text" ? sized[0].text : "").toMatch(
        /^\[done\] `post\.html` as a picture of the size asked: 800 by 630 px at scale 2, saved as a PNG of 1,600 by 1,260 px\. It is laid out 2,600 px tall in a box 630 px tall, so the picture leaves out what is below the box\. Saved for this run at `\S+\/\.captures\/run_\S+\/cap_\S+\/out\/1-desktop\.png`: scratch, your next capture replaces it, and it goes when this run ends\. Copying that file into the task's attachments folder under a name ending `\.png` keeps it as a file of the task\.$/,
      );
      expect(sized[1]?.type === "image" ? imageHeader(Buffer.from(sized[1].data, "base64")) : null).toEqual({
        mimeType: "image/png",
        width: 1600,
        height: 1260,
      });
      // What the tool tells a Codex run it takes for a size, and holds it to:
      // a side of 100 to 4,000 CSS px in whole px, and one of five scales.
      // CANARY: take any scale from 0.25 to 2 and 0.7 reaches the browser,
      // which on some boxes answers one px off the size the door keeps.
      // CANARY: parse `width` as any number and a 99 px box is pictured.
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "capture_page");
      expect(listed?.inputSchema.properties).toMatchObject({
        width: { type: "integer", minimum: 100, maximum: 4000 },
        height: { type: "integer", minimum: 100, maximum: 4000 },
        scale: { type: "number", enum: [0.25, 0.5, 1, 1.5, 2] },
      });
      for (const size of [{ width: 99, height: 630 }, { width: 1200, height: 4001 }, { width: 1200.5, height: 630 }, { width: 1200, height: 630, scale: 2.5 }, { width: 1200, height: 630, scale: 0.7 }]) {
        const outside = await client.callTool({ name: "capture_page", arguments: { name: "post.html", ...size } });
        expect(outside.isError).toBe(true);
        expect(z.array(z.object({ text: z.string() })).parse(outside.content)[0]!.text).toBe(notTheTools);
      }
      await client.close();
    });

    await interrupt(runId);
    await settle();
  });
});

describe("ruling 158(b): a run that keeps sending one call and getting one answer is stopped", () => {
  it("fails the run with the call and its answer as the cause, and lets a call whose answer changes run on", async () => {
    // Live on AWSC-49 the Estimate Judge's code-mode script sent one refused
    // correction 44,725 times in twenty minutes, reading the entry between
    // tries, until a person stopped the run. CANARIES: skip the guard and the
    // hundredth answer is the tool's own; key the count on the call without
    // its answer and the changing reads below are stopped.
    const mount = resolveBoardMcp({ backend: "codex", collaborates: true, ...READS_ONLY, dataRoot: store.dataRoot });
    queueFakeRun({ lines: [{ t: "1", ev: "text", tag: "assistant", text: "correcting" }], sessionId: "s", backend: "codex", keepRunning: true }, "codex");
    const { runId } = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      role: "Estimate Judge",
      kind: "reviewer",
      backend: "codex",
      model: defaultModelFor("codex"),
      prompt: "go",
      dataRoot: store.dataRoot,
      mcpServers: { viberr_board: mount! },
      agentProfileId: "estimate-judge",
      credentialUserId: store.users.arda.id,
    });
    await settle();
    const board = mountSchema.parse(lastRunSpec()?.mcpServers?.viberr_board);
    const client = new Client({ name: "codex-cli", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(board.url), { requestInit: { headers: board.headers } }));
    const call = async (name: string, args: Record<string, string>) => {
      const result = await client.callTool({ name, arguments: args });
      return { isError: result.isError === true, text: z.array(z.object({ text: z.string() })).parse(result.content)[0]!.text };
    };

    // Read, act, read: the same call, a new answer each time, never stopped.
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    for (let i = 0; i < LOOP_REPEATS + 5; i++) {
      await appendTimelineEvent(ref, {
        occurredAt: new Date(Date.parse("2026-09-30T00:00:00.000Z") + i * 1000).toISOString(),
        type: "comment",
        actor: { kind: "operator" },
        title: null,
        text: `Step ${i}.`,
        toAgent: false,
        evidence: null,
      });
      expect((await call("read_board", { taskKey: "VIB-1" })).isError).toBe(false);
    }
    // The same refused call, again and again: the hundredth is stopped.
    const missing = { occurredAt: "2026-09-29T00:00:00.000Z" };
    for (let i = 1; i < LOOP_REPEATS; i++) expect((await call("read_timeline_entry", missing)).text).toMatch(/^\[noop\]/);
    const stopped = await call("read_timeline_entry", missing);
    expect(stopped.isError).toBe(true);
    expect(stopped.text).toMatch(
      /^\[stopped\] Viberr stopped the run: it sent `read_timeline_entry` \(viberr_board\) with the same arguments 100 times in \d+ s and got the same answer each time: "\[noop\] /,
    );
    await waitFor(() => getRun(store.db, runId)?.state === "error", "the stopped run to end failed");
    const cause = runFailureReason(store.db, runId);
    expect(cause?.kind).toBe("tool_loop");
    expect(cause?.text).toBe(stopped.text.replace(/^\[stopped\] /, ""));
    await client.close().catch(() => undefined);
  });

  it("stops a run that repeats a call to an upstream server the same way, an error answer included", async () => {
    // A proxied call answers through its own path, and an upstream can answer
    // with an error a script catches and retries. CANARIES: leave the guard
    // off the forwarded answer, or off the error, and the hundredth answer
    // comes back as it was.
    for (const { tool, thrown, taskKey } of [
      { tool: "whoami", thrown: false, taskKey: "VIB-1" },
      { tool: "fail", thrown: true, taskKey: "VIB-2" },
    ]) {
      const { runId } = await startWithMounts("codex", { keepRunning: true, taskKey });
      const cloudflare = mountSchema.parse(lastRunSpec()?.mcpServers?.cloudflare);
      const client = new Client({ name: "codex-cli", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(cloudflare.url), { requestInit: { headers: cloudflare.headers } }));
      for (let i = 1; i < LOOP_REPEATS; i++) {
        if (thrown) await expect(client.callTool({ name: tool, arguments: {} })).rejects.toThrow("no such zone");
        else expect((await client.callTool({ name: tool, arguments: {} })).isError).not.toBe(true);
      }
      const stopped = await client.callTool({ name: tool, arguments: {} });
      expect(stopped.isError).toBe(true);
      expect(z.array(z.object({ text: z.string() })).parse(stopped.content)[0]!.text).toMatch(
        new RegExp(`^\\[stopped\\] Viberr stopped the run: it sent \`${tool}\` \\(cloudflare\\) with the same arguments 100 times`),
      );
      await waitFor(() => getRun(store.db, runId)?.state === "error", `the ${tool} run to end failed`);
      expect(runFailureReason(store.db, runId)?.kind).toBe("tool_loop");
      await client.close().catch(() => undefined);
    }
  });
});
