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
  writeProject,
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
import { startHttpUpstream, type UpstreamHandle } from "../../../test-support/mcp-upstream";
import { appendTimelineEvent, readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import { keepDelivery } from "~/server/files/kept-deliveries.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { interruptRun, startRun } from "~/server/runtimes/run-service.server";
import { getRun } from "~/server/runtimes/run-store.server";
import { sealSecret } from "~/server/secrets/secret-box.server";
import { setMaxConcurrentRuns } from "~/server/settings/instance-settings.server";
import { resolveBoardMcp, resolveKnowledgeMcp, resolveSpecialistMcpServersDetailed } from "~/server/tasks/specialist-mcp.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { errorMessage } from "~/shared/errors";
import { runFailureReason } from "~/server/tasks/agent-reply.server";
import { LOOP_REPEATS, mcpGatewayStatus, startMcpGateway, stopMcpGateway } from "./gateway.server";

/**
 * Ruling 461 through the run service: `startRun` is the one funnel that puts a
 * run's token on its gateway mounts (both backends), and every path that ends
 * a run — the settle after success or failure, an interrupt, and an interrupt
 * of a run that never had a live handle — revokes it.
 */

const SECRET = "cf-api-token-sentinel-runs";
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

describe("startRun puts the run's token on its gateway mounts (ruling 461)", () => {
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

describe("every path that ends a run revokes its token (ruling 461)", () => {
  it("success: the settle revokes it", async () => {
    await startWithMounts("claude");
    const cloudflare = mountSchema.parse(lastRunSpec()?.mcpServers?.cloudflare);
    expect(getRun(store.db, lastRunSpec()!.runId)?.state).toBe("finished");
    // CANARY: drop the settle's revoke (before the finalize) and a token outlives its run.
    expect(mcpGatewayStatus().liveTokens).toBe(0);
    expect(await gatewayAnswers(cloudflare.url, cloudflare.headers.Authorization)).toBe(401);
  });

  it("failure: a run that errors revokes it too", async () => {
    await startWithMounts("codex", { outcome: "error" });
    const cloudflare = mountSchema.parse(lastRunSpec()?.mcpServers?.cloudflare);
    expect(getRun(store.db, lastRunSpec()!.runId)?.state).toBe("error");
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
    // Ruling 376: the compaction replays the session with the run's own MCP
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
    setMaxConcurrentRuns(store.db, 1);
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

describe("ruling 585: the gateway answers a Codex run's knowledge server itself", () => {
  it("reads and corrects the knowledge bases the run holds, a private one included, and nothing else, while the run lives", async () => {
    // An agent on the project is not given `answer-keys`, as AWSC-97's
    // Inventory Analyst is not given the calculator research.
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        ...project.parsed.frontmatter.agents,
        {
          profileId: "inventory-analyst",
          capabilities: [],
          extras: [],
          definition: { kind: "specialist", name: "Inventory Analyst", role: "Intake", backends: ["codex"], model: defaultModelFor("codex") },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
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
    const boardMount = resolveBoardMcp({ backend: "codex", collaborates: true, dataRoot: store.dataRoot });
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
        // Ruling 588: the document is `path`, as read_knowledge_doc names it.
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

    // Ruling 648: the run is given `answer-keys`, so its board server reads
    // the correction whole, though the entry quotes none of it for the agents
    // that are not (ruling 568). Live on AWSC-97 the Estimate Judge, given the
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

describe("ruling 589: the gateway answers a Codex run's board server itself", () => {
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
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", ownerUserId: store.users.arda.id }),
      timeline: [
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
    expect(resolveBoardMcp({ backend: "claude", collaborates: true, dataRoot: store.dataRoot })).toBeNull();
    expect(resolveBoardMcp({ backend: "codex", collaborates: false, dataRoot: store.dataRoot })).toBeNull();
    const mount = resolveBoardMcp({ backend: "codex", collaborates: true, dataRoot: store.dataRoot });
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
    // Ruling 596: another task's entry, by the stamp read_board lists for it.
    // CANARY: bind the gateway's reader to the run's own task and this reads a miss.
    expect(z.object({ timeline: z.array(z.string()) }).parse(JSON.parse(await call("read_board", { taskKey: "VIB-2" }))).timeline).toEqual([
      "2026-09-29T10:10:00.000Z · comment · agent:estimate-judge · Review verdict",
    ]);
    const verdictEntry = z
      .object({ text: z.string() })
      .parse(JSON.parse(await call("read_timeline_entry", { taskKey: "VIB-2", occurredAt: "2026-09-29T10:10:00.000Z" })));
    expect(verdictEntry.text).toBe("## Verdict: approve, 95/100");
    // Ruling 594: another task's file, read where it is; `read_board` names it.
    const vib2 = taskAttachmentsDir(store.slug, "VIB-2", store.dataRoot);
    mkdirSync(vib2, { recursive: true });
    writeFileSync(path.join(vib2, "holdout-comparison.md"), "# Hold-outs\n\n## Exposure register\n");
    expect(z.object({ files: z.array(z.string()) }).parse(JSON.parse(await call("read_board", { taskKey: "VIB-2" }))).files).toEqual([
      "holdout-comparison.md",
    ]);
    // CANARY: route read_task_attachment nowhere and this is refused.
    expect(await call("read_task_attachment", { taskKey: "VIB-2", name: "holdout-comparison.md" })).toContain("## Exposure register");
    expect(await call("read_task_attachment", { name: "holdout-comparison.md" })).toContain("[noop] VIB-1 has no attachment");
    // Ruling 597: the file as a kept delivery held it. CANARY: drop `delivery`
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

describe("ruling 598: a run that keeps sending one call and getting one answer is stopped", () => {
  it("fails the run with the call and its answer as the cause, and lets a call whose answer changes run on", async () => {
    // Live on AWSC-49 the Estimate Judge's code-mode script sent one refused
    // correction 44,725 times in twenty minutes, reading the entry between
    // tries, until a person stopped the run. CANARIES: skip the guard and the
    // hundredth answer is the tool's own; key the count on the call without
    // its answer and the changing reads below are stopped.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", ownerUserId: store.users.arda.id }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const mount = resolveBoardMcp({ backend: "codex", collaborates: true, dataRoot: store.dataRoot });
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
