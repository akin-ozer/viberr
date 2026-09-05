import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { unreachableFetch } from "../../../test-support/fake-github";
import { createTestDbContext } from "../../../test-support/test-db";
import { ENV_KEYS } from "~/server/config/env.server";
import { kbDirPath, skillDirPath } from "~/server/files/file-store-root.server";
import {
  deleteKnowledgeBase,
  deleteMcpServer,
  deleteSkill,
  discoverStdioMcpTools,
  getMcpServer,
  getKnowledgeBase,
  getSkill,
  isFirstRunInstallerCommand,
  listKnowledgeBases,
  listSkills,
  markMcpServerUnreachableFromRun,
  type McpSpawn,
  listMcpServers,
  probeMcpTarget,
  reindexKnowledgeBase,
  reindexKnowledgeBaseByDir,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
  splitMcpCommand,
  testMcpServer,
} from "./resources.server";
import { resetWarmupsForTest } from "./mcp-warmup.server";

/**
 * The JSON-RPC request envelope the fakes read back off the wire. Only
 * `method` steers a reply, and a message without one has to fall through every
 * branch — so the schema stays tolerant instead of rejecting the whole line.
 */
const jsonRpcRequest = z.object({ method: z.string().optional() }).catch({});

/**
 * The JSON-RPC replies the fakes write back: the `initialize` result, then the
 * `tools/list` result — the only two messages the probe handshake reads.
 */
type FakeMcpReply = { jsonrpc: "2.0"; id: number } & {
  result:
    | { capabilities: Record<string, never> }
    | { protocolVersion: string }
    | { tools: { name: string }[] };
};

/**
 * A fake stdio MCP server: answers the JSON-RPC `initialize` and `tools/list`
 * handshake with `tools` tools — no real process spawned.
 */
function fakeMcpSpawn(tools: number): McpSpawn {
  return () => {
    const stdout = new EventEmitter();
    const emit = (reply: FakeMcpReply) =>
      queueMicrotask(() =>
        stdout.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`)),
      );
    return {
      stdin: {
        write(data: string) {
          for (const line of data.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            const msg = jsonRpcRequest.parse(JSON.parse(t));
            if (msg.method === "initialize") {
              emit({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
            } else if (msg.method === "tools/list") {
              emit({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  tools: Array.from({ length: tools }, (_, i) => ({ name: `t${i}` })),
                },
              });
            }
          }
        },
        end() {},
      },
      stdout: { on: (event, cb) => stdout.on(event, cb) },
      stderr: { on() {} },
      on() {},
      kill() {},
    };
  };
}

/** A stdio spawn that never answers (exercises the timeout path). */
const silentSpawn: McpSpawn = () => ({
  stdin: { write() {}, end() {} },
  stdout: { on() {} },
  stderr: { on() {} },
  on() {},
  kill() {},
});

/**
 * A server that dies the way a real one does: a line of explanation on stderr,
 * then exit. The probe used to answer this with the words "exited before
 * responding" and drop the only thing that said WHY.
 */
function crashingSpawn(stderrText: string): McpSpawn {
  return () => {
    const err = new EventEmitter();
    const exit = new EventEmitter();
    queueMicrotask(() => {
      err.emit("data", Buffer.from(stderrText));
      queueMicrotask(() => exit.emit("exit"));
    });
    return {
      stdin: { write() {}, end() {} },
      stdout: { on() {} },
      stderr: { on: (event, cb) => err.on(event, cb) },
      on: (event, cb) => {
        if (event === "exit") exit.on("exit", cb);
      },
      kill() {},
    };
  };
}

/** Chatters on stderr (a package manager fetching) but never answers. */
function chattySpawn(stderrText: string): McpSpawn {
  return () => {
    const err = new EventEmitter();
    queueMicrotask(() => err.emit("data", Buffer.from(stderrText)));
    return {
      stdin: { write() {}, end() {} },
      stdout: { on() {} },
      stderr: { on: (event, cb) => err.on(event, cb) },
      on() {},
      kill() {},
    };
  };
}

/** A spawn that fails immediately (command not found). */
const failingSpawn: McpSpawn = () => {
  throw new Error("ENOENT");
};

/**
 * F20-8 (EPIPE): a child that has already exited — writing to its stdin emits
 * an ASYNC 'error' the way a real broken pipe does. Without an 'error' listener
 * on the stdin stream that emit is an uncaught fatal (a `node:events` 'error'
 * with no listener throws), so this fake is also the canary: revert the handler
 * and the emit takes the process down instead of settling the probe.
 */
const epipeSpawn: McpSpawn = () => {
  const stdinErr = new EventEmitter();
  return {
    stdin: {
      write() {
        queueMicrotask(() => stdinErr.emit("error", new Error("write EPIPE")));
      },
      end() {},
      on: (event, cb) => stdinErr.on(event, cb),
    },
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill() {},
  };
};

/** F20-22: exits with a given code/signal, printing nothing on stderr. */
function exitingSpawn(code: number | null, signal?: string): McpSpawn {
  return () => {
    const exit = new EventEmitter();
    queueMicrotask(() => exit.emit("exit", code, signal));
    return {
      stdin: { write() {}, end() {} },
      stdout: { on() {} },
      stderr: { on() {} },
      on: (event, cb) => {
        if (event === "exit") exit.on("exit", cb);
      },
      kill() {},
    };
  };
}

/**
 * Agent-resource CRUD: every KB/skill mutation is a REAL folder mutation
 * under the temp data root; scans read straight from disk (external edits
 * appear); MCP health probes are injectable + honest.
 */

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);
// R20-4: the warm-up registry is in-process; never leave one armed for the next
// test (and the terminal-condition test depends on a clean counter).
afterEach(() => resetWarmupsForTest());

const ACTOR = { userId: "u_t", label: "t@test" };

function setup() {
  const db = dbCtx.makeDb();
  const dataRoot = dbCtx.makeTempDir();
  return { db, dataRoot, ctx: { dataRoot } };
}

/** An "up" probe transport: any HTTP response counts as reachable. */
const respondingFetch: typeof fetch = async () =>
  new Response("nope", { status: 404 });

/**
 * A fake Streamable-HTTP MCP endpoint that answers the REAL handshake
 * (P13-LV-10). `sseFramed` returns the body as an SSE `data:` line, which is
 * what a real MCP server does when the client accepts text/event-stream.
 */
function mcpHttpFetch(
  toolCount: number,
  opts: { sseFramed?: boolean; requireAuth?: string } = {},
): typeof fetch {
  return async (_url, init) => {
    const headers = new Headers(init?.headers);
    if (
      opts.requireAuth &&
      headers.get("authorization") !== `Bearer ${opts.requireAuth}`
    ) {
      return new Response("no", { status: 401 });
    }
    const body = jsonRpcRequest.parse(JSON.parse(String(init?.body ?? "{}")));
    const reply = (payload: FakeMcpReply) => {
      const text = opts.sseFramed
        ? `event: message\ndata: ${JSON.stringify(payload)}\n\n`
        : JSON.stringify(payload);
      return new Response(text, {
        status: 200,
        headers: {
          "content-type": opts.sseFramed ? "text/event-stream" : "application/json",
          "mcp-session-id": "sess-1",
        },
      });
    };
    if (body.method === "initialize") {
      return reply({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    }
    if (body.method === "tools/list") {
      return reply({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `t${i}` })) },
      });
    }
    return new Response("", { status: 202 });
  };
}

describe("knowledge bases", () => {
  it("create makes the real folder; scan sees files added outside Viberr", async () => {
    const { db, dataRoot, ctx } = setup();
    const { kb, toast } = await saveKnowledgeBase(
      db,
      { name: "Architecture notes", refresh: "on change" },
      ACTOR,
      ctx,
    );
    expect(toast).toBe(
      "Architecture notes created. Folder ready at store://kb/architecture-notes/",
    );
    const dir = kbDirPath("architecture-notes", dataRoot);
    expect(existsSync(dir)).toBe(true);
    expect(kb.fileCount).toBe(0);

    // External edit → visible on the next read (the def-note promise).
    mkdirSync(path.join(dir, "decisions"), { recursive: true });
    writeFileSync(path.join(dir, "decisions", "adr-001.md"), "# ADR");
    const fresh = getKnowledgeBase(db, kb.id, ctx)!;
    expect(fresh.fileCount).toBe(1);
    expect(fresh.tree[0]).toMatchObject({ type: "dir", name: "decisions" });

    const reindexed = reindexKnowledgeBase(db, kb.id, ACTOR, ctx);
    expect(reindexed.toast).toBe(
      "Architecture notes re-scanned: 1 doc agents can read",
    );
  });

  it("rename moves the folder; collisions are refused", async () => {
    const { db, dataRoot, ctx } = setup();
    const a = await saveKnowledgeBase(db, { name: "Alpha", refresh: "manual" }, ACTOR, ctx);
    await saveKnowledgeBase(db, { name: "Beta", refresh: "manual" }, ACTOR, ctx);
    writeFileSync(path.join(kbDirPath("alpha", dataRoot), "x.md"), "x");

    const renamed = await saveKnowledgeBase(
      db,
      { id: a.kb.id, name: "Alpha Two", refresh: "manual" },
      ACTOR,
      ctx,
    );
    expect(renamed.kb.dir).toBe("alpha-two");
    expect(existsSync(kbDirPath("alpha", dataRoot))).toBe(false);
    expect(existsSync(path.join(kbDirPath("alpha-two", dataRoot), "x.md"))).toBe(true);

    await expect(
      saveKnowledgeBase(db, { id: a.kb.id, name: "Beta", refresh: "manual" }, ACTOR, ctx),
    ).rejects.toThrowError(/already exists/);
  });

  it("delete removes the folder and the row", async () => {
    const { db, dataRoot, ctx } = setup();
    const { kb } = await saveKnowledgeBase(db, { name: "Gone Soon", refresh: "manual" }, ACTOR, ctx);
    const { toast } = await deleteKnowledgeBase(db, kb.id, ACTOR, ctx);
    expect(toast).toBe("Gone Soon deleted. Agents lose it on next context load");
    expect(existsSync(kbDirPath("gone-soon", dataRoot))).toBe(false);
    expect(listKnowledgeBases(db, ctx)).toHaveLength(0);
  });

  it("F18-4: a row whose store folder was wiped reports folderExists:false", async () => {
    const { db, dataRoot, ctx } = setup();
    const { kb } = await saveKnowledgeBase(db, { name: "Wiped", refresh: "manual" }, ACTOR, ctx);
    // A healthy KB with no docs still exists on disk.
    expect(getKnowledgeBase(db, kb.id, ctx)!.folderExists).toBe(true);
    // Remove the folder out from under the row (a store reset / external delete).
    rmSync(kbDirPath("wiped", dataRoot), { recursive: true, force: true });
    const orphan = getKnowledgeBase(db, kb.id, ctx)!;
    expect(orphan.folderExists).toBe(false);
    expect(orphan.injectableCount).toBe(0); // indistinguishable from empty WITHOUT the flag
  });
});

describe("skills", () => {
  it("create writes a real SKILL.md; body round-trips from disk", async () => {
    const { db, dataRoot, ctx } = setup();
    const { skill, toast } = await saveSkill(
      db,
      {
        name: "Terraform Review",
        summary: "Module review checklist.",
        body: "## Review checklist\n- state safety",
      },
      ACTOR,
      ctx,
    );
    expect(toast).toBe("Skill terraform-review created. SKILL.md written");
    const skillMd = path.join(skillDirPath("terraform-review", dataRoot), "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(skill.body).toContain("state safety");
    expect(skill.tree.map((n) => n.name)).toContain("SKILL.md");

    const updated = await saveSkill(
      db,
      { id: skill.id, name: "terraform-review", summary: "Updated.", body: "## New body" },
      ACTOR,
      ctx,
    );
    expect(updated.toast).toBe("Skill terraform-review updated. SKILL.md rewritten");
    expect(getSkill(db, skill.id, ctx)!.body).toBe("## New body");
  });

  it("files-mode create: folder only, no SKILL.md, empty summary allowed (unified New-skill flow)", async () => {
    const { db, dataRoot, ctx } = setup();
    const { skill, toast } = await saveSkill(
      db,
      {
        name: "Conventional Commits",
        summary: "",
        body: "",
        contentMode: "files",
      },
      ACTOR,
      ctx,
    );
    expect(toast).toBe(
      "Skill conventional-commits created. Add SKILL.md and supporting files",
    );
    // The folder exists for the store browser; SKILL.md deliberately does NOT —
    // it arrives via upload/GitHub/New document, without an overwrite-confirm
    // against a stub we planted.
    expect(existsSync(skillDirPath("conventional-commits", dataRoot))).toBe(true);
    expect(
      existsSync(path.join(skillDirPath("conventional-commits", dataRoot), "SKILL.md")),
    ).toBe(false);
    // The row's empty summary falls back to the derived one: the placeholder
    // now, the uploaded SKILL.md's frontmatter `description:` once it lands.
    expect(skill.summary).toBe("On-disk skill. Add a summary to describe it");
    expect(skill.tree).toHaveLength(0);

    // files mode is a CREATE-only affordance: an edit still demands a summary…
    await expect(
      saveSkill(
        db,
        { id: skill.id, name: "conventional-commits", summary: "", body: "", contentMode: "files" },
        ACTOR,
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400 });
    // …and the classic create path still refuses an empty summary.
    await expect(
      saveSkill(db, { name: "another-skill", summary: "", body: "x" }, ACTOR, ctx),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("an EMPTY submitted body keeps the existing SKILL.md (E4 — no blanking)", async () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = await saveSkill(
      db,
      { name: "api-design", summary: "REST rules.", body: "# precious content" },
      ACTOR,
      ctx,
    );

    // Summary-only edit round-trips an empty body (e.g. the modal field was
    // cleared / never loaded) — the on-disk body must survive.
    const updated = await saveSkill(
      db,
      { id: skill.id, name: "api-design", summary: "Updated summary.", body: "" },
      ACTOR,
      ctx,
    );
    expect(updated.toast).toBe(
      "Skill api-design updated. Existing SKILL.md kept",
    );
    const onDisk = path.join(skillDirPath("api-design", dataRoot), "SKILL.md");
    expect(readFileSync(onDisk, "utf8")).toBe("# precious content");
    expect(updated.skill.summary).toBe("Updated summary.");

    // The explicit clear flag is the ONLY way to blank it.
    const cleared = await saveSkill(
      db,
      {
        id: skill.id,
        name: "api-design",
        summary: "Updated summary.",
        body: "",
        clearBody: true,
      },
      ACTOR,
      ctx,
    );
    expect(cleared.toast).toBe("Skill api-design updated. SKILL.md rewritten");
    expect(readFileSync(onDisk, "utf8")).toBe("");
  });

  it("refuses to write a body when the on-disk SKILL.md exceeds the read cap (E4)", async () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = await saveSkill(
      db,
      { name: "big-skill", summary: "Huge on disk.", body: "seed" },
      ACTOR,
      ctx,
    );
    // Grow SKILL.md past the 256 KB editor read cap — from here on, any body
    // the UI round-trips is a TRUNCATED copy of the file.
    const onDisk = path.join(skillDirPath("big-skill", dataRoot), "SKILL.md");
    writeFileSync(onDisk, "x".repeat(256 * 1024 + 10));

    await expect(
      saveSkill(
        db,
        { id: skill.id, name: "big-skill", summary: "Huge on disk.", body: "truncated round-trip" },
        ACTOR,
        ctx,
      ),
    ).rejects.toThrowError(/256 KB/);
    // Nothing was written.
    expect(readFileSync(onDisk, "utf8")).toHaveLength(256 * 1024 + 10);

    // A body-keeping save (empty body, e.g. summary edit) still works.
    const kept = await saveSkill(
      db,
      { id: skill.id, name: "big-skill", summary: "New summary here.", body: "" },
      ACTOR,
      ctx,
    );
    expect(kept.toast).toContain("Existing SKILL.md kept");
    expect(readFileSync(onDisk, "utf8")).toHaveLength(256 * 1024 + 10);
  });

  // A5-followup: the editor's reader dereferenced links while the INJECTION
  // reader refuses them, so a symlinked SKILL.md showed the link target's
  // content as if it were the skill — text no run would ever see — and the
  // editor's `writeFileSync` would then have replaced that target's content
  // with whatever was in the textarea. Deliberate answer: the editor obeys the
  // same containment rule as the injector, and says so instead of logging it.
  it("refuses to read or write a SKILL.md that links out of the store", async () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = await saveSkill(
      db,
      { name: "linked-skill", summary: "Linked.", body: "# in the store" },
      ACTOR,
      ctx,
    );
    const dir = skillDirPath("linked-skill", dataRoot);
    const outside = path.join(dataRoot, "outside-the-store.md");
    writeFileSync(outside, "# secrets from outside the store");
    rmSync(path.join(dir, "SKILL.md"));
    symlinkSync(outside, path.join(dir, "SKILL.md"));

    // READ: the editor shows nothing rather than the target's content.
    expect(getSkill(db, skill.id, ctx)!.body).toBe("");

    // WRITE: refused, and the link target is untouched.
    await expect(
      saveSkill(
        db,
        { id: skill.id, name: "linked-skill", summary: "Linked.", body: "clobbered" },
        ACTOR,
        ctx,
      ),
    ).rejects.toThrowError(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("# secrets from outside the store");

    // A summary-only save (empty body → keep on disk) still works: it writes
    // no SKILL.md at all, so there is nothing to refuse.
    const kept = await saveSkill(
      db,
      { id: skill.id, name: "linked-skill", summary: "New summary here.", body: "" },
      ACTOR,
      ctx,
    );
    expect(kept.toast).toContain("Existing SKILL.md kept");
  });

  it("rename moves the skill folder; delete removes it", async () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = await saveSkill(
      db,
      { name: "api-design", summary: "REST rules.", body: "# body" },
      ACTOR,
      ctx,
    );
    const renamed = await saveSkill(
      db,
      { id: skill.id, name: "api-guidelines", summary: "REST rules.", body: "# body" },
      ACTOR,
      ctx,
    );
    expect(renamed.skill.name).toBe("api-guidelines");
    expect(existsSync(skillDirPath("api-design", dataRoot))).toBe(false);

    const { toast } = await deleteSkill(db, skill.id, ACTOR, ctx);
    expect(toast).toBe("Skill api-guidelines deleted");
    expect(existsSync(skillDirPath("api-guidelines", dataRoot))).toBe(false);
  });
});

describe("mcp servers", () => {
  it("refuses every name Viberr's own in-process servers own", async () => {
    const { db } = setup();
    // P13-KM-12 / ruling 107: a row under one of these names is unusable (every
    // resolver skips it) AND shadows the mount key of a server the product
    // attaches itself, so it is refused at save rather than accepted dead. The
    // hyphen spellings are what a Codex run would see.
    for (const name of [
      "viberr",
      "viberr_agent",
      "viberr-agent",
      "viberr_browser",
      "viberr-browser",
      "viberr_controller",
      "viberr-controller",
      "viberr_ops",
      "viberr-ops",
    ]) {
      await expect(
        saveMcpServer(
          db,
          { name, transport: "HTTP", target: "https://x.dev/mcp", cred: "" },
          ACTOR,
          { fetchImpl: mcpHttpFetch(9) },
        ),
        `"${name}" must be refused`,
      ).rejects.toThrow(/reserved for Viberr/);
    }
    // The refusal is the whole story: nothing was written on the way out.
    expect(listMcpServers(db)).toEqual([]);
  });

  it("probe is honest: any HTTP response = up, network error = down, stdio = skipped", async () => {
    expect(
      await probeMcpTarget("HTTP", "https://mcp.internal:1/sse", {
        fetchImpl: respondingFetch,
      }),
    ).toMatchObject({ kind: "up" });
    expect(
      await probeMcpTarget("HTTP", "https://mcp.internal:1/sse", {
        fetchImpl: unreachableFetch(),
      }),
    ).toMatchObject({ kind: "down" });
    expect(await probeMcpTarget("stdio", "npx -y whatever")).toEqual({
      kind: "skipped",
    });
    expect(
      await probeMcpTarget("HTTP", "not a url", { fetchImpl: respondingFetch }),
    ).toMatchObject({ kind: "down" });
  });

  it("save runs a REAL MCP handshake on HTTP targets and never fabricates counts", async () => {
    const { db } = setup();
    // P13-LV-10: an HTTP target used to be "reachable" on ANY response — a 404
    // (or any live website) painted a green dot — and no tool count was ever
    // discovered. Now the handshake decides, and it stores the real count.
    const up = await saveMcpServer(
      db,
      { name: "GitHub MCP", transport: "HTTP", target: "https://x.dev/mcp", cred: "" },
      ACTOR,
      { fetchImpl: mcpHttpFetch(9) },
    );
    expect(up.mcp).toMatchObject({ name: "github-mcp", up: true, tools: 9 });
    expect(up.toast).toContain("9 tools discovered");

    const notMcp = await saveMcpServer(
      db,
      { name: "just-a-website", transport: "HTTP", target: "https://x.dev/", cred: "" },
      ACTOR,
      { fetchImpl: respondingFetch },
    );
    expect(notMcp.mcp).toMatchObject({ up: false, tools: null });
    expect(notMcp.toast).toContain("didn't answer as an MCP server");

    const down = await saveMcpServer(
      db,
      { name: "browserbase", transport: "HTTP", target: "https://y.dev/sse", cred: "secret://mcp/bb" },
      ACTOR,
      { fetchImpl: unreachableFetch() },
    );
    expect(down.mcp.up).toBe(false);
    expect(down.toast).toContain("didn't answer as an MCP server");

    // stdio save runs a REAL best-effort tool-count discovery (fake spawn).
    const stdio = await saveMcpServer(
      db,
      { name: "postgres-readonly", transport: "stdio", target: "npx -y @mcp/pg", cred: "" },
      ACTOR,
      { spawnImpl: fakeMcpSpawn(7) },
    );
    expect(stdio.mcp).toMatchObject({ up: true, tools: 7 });
    expect(stdio.toast).toBe(
      "postgres-readonly saved: 7 tools discovered · spawned per run",
    );

    // A command that never answers → honest unreachable, count stays null.
    const dead = await saveMcpServer(
      db,
      // A NON-installer command (not npx/uvx), so a silent timeout is an honest
      // failure, not a first-run install. R20-4's heuristic warm-up is exercised
      // by its own terminal-condition test; here the point is a dead command.
      { name: "broken-stdio", transport: "stdio", target: "mcp-server-nope --serve", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 20 },
    );
    expect(dead.mcp).toMatchObject({ up: false, tools: null });
    expect(dead.toast).toContain("did not answer");

    /* R19-17: a stdio server that CRASHES explains itself on stderr, and the
       probe used to answer with three fixed words. This is the live case: a
       `uvx` MCP server whose upstream package broke against the current Python
       SDK exited instantly, and the ImportError naming the exact symbol was
       unreachable from the app. */
    const crashed = await saveMcpServer(
      db,
      { name: "crashing-stdio", transport: "stdio", target: "uvx mcp-server-time", cred: "" },
      ACTOR,
      {
        spawnImpl: crashingSpawn(
          "Traceback (most recent call last):\n" +
            "ImportError: cannot import name 'McpError' from 'mcp.shared.exceptions'\n",
        ),
        timeoutMs: 200,
      },
    );
    expect(crashed.mcp).toMatchObject({ up: false, tools: null });
    expect(crashed.toast).toContain("ImportError: cannot import name 'McpError'");

    /* …and the credential the child was spawned WITH never rides along, even
       when the dying server prints its own environment. */
    const leaky = await saveMcpServer(
      db,
      {
        name: "leaky-stdio",
        transport: "stdio",
        target: "uvx mcp-server-leak",
        cred: "sk-live-abcdefghijklmnop",
      },
      ACTOR,
      {
        spawnImpl: crashingSpawn(
          "env dump: MCP_CREDENTIAL=sk-live-abcdefghijklmnop\nfatal: giving up\n",
        ),
        timeoutMs: 200,
      },
    );
    expect(leaky.toast).toContain("fatal: giving up");
    expect(leaky.toast).not.toContain("sk-live-abcdefghijklmnop");

    /* R19-17c: a command that is still FETCHING on first use is not a broken
       one, and the two need different next steps. `npx`/`uvx` install on first
       run — live, a server pulling a CUDA-sized dependency tree could never
       finish inside any probe window, and each killed probe discarded the
       partial download, so retesting never converged. */
    const installing = await saveMcpServer(
      db,
      { name: "cold-stdio", transport: "stdio", target: "uvx big-server", cred: "" },
      ACTOR,
      {
        spawnImpl: chattySpawn("Downloading nvidia-curand (59.1MiB)\n"),
        timeoutMs: 60,
      },
    );
    // R19-18: Viberr now finishes the install itself rather than telling the
    // admin to go warm it from a shell, so the row goes to "installing" and the
    // save says so instead of reporting a failure.
    expect(installing.toast).toContain("installing in the background");
    expect(installing.mcp.warmingSince).not.toBeNull();

    /* …and a command that says NOTHING is still a plain timeout — the hint is
       earned by evidence, never assumed. */
    const silent = await saveMcpServer(
      db,
      { name: "silent-stdio", transport: "stdio", target: "node /tmp/hang.mjs", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 60 },
    );
    expect(silent.toast).toContain("timed out after");
    expect(silent.toast).not.toContain("still installing");

    /* R19-17: the reason PERSISTS on the row, so it is still there after the
       toast is gone — and a passing retest clears it, because a stale
       explanation under a green dot is worse than none. */
    expect(
      listMcpServers(db).find((m) => m.name === "crashing-stdio")!.lastError,
    ).toContain("ImportError: cannot import name 'McpError'");
    const crashedId = listMcpServers(db).find(
      (m) => m.name === "crashing-stdio",
    )!.id;
    const recovered = await testMcpServer(db, crashedId, {
      spawnImpl: fakeMcpSpawn(3),
    });
    expect(recovered.mcp).toMatchObject({ up: true, tools: 3, lastError: null });

    // Duplicate name guard.
    await expect(
      saveMcpServer(
        db,
        { name: "github-mcp", transport: "HTTP", target: "https://z.dev", cred: "" },
        ACTOR,
        { fetchImpl: respondingFetch },
      ),
    ).rejects.toThrowError(/already exists/);
  });

  it("test re-runs the handshake and reports the count the server actually offers", async () => {
    const { db } = setup();
    const { mcp } = await saveMcpServer(
      db,
      { name: "github-mcp", transport: "HTTP", target: "https://x.dev/mcp", cred: "" },
      ACTOR,
      { fetchImpl: mcpHttpFetch(14) },
    );
    expect(mcp.tools).toBe(14);

    // P13-LV-19: the count is whatever the live handshake enumerates, not a
    // stale column — Settings said "13 tools" for a server both live runs saw
    // as 15 because the old probe advertised no client capabilities.
    const healthy = await testMcpServer(db, mcp.id, { fetchImpl: mcpHttpFetch(15) });
    expect(healthy.toast).toMatch(/^github-mcp healthy: 15 tools · \d+ms$/);
    expect(getMcpServer(db, mcp.id)!.tools).toBe(15);

    const dead = await testMcpServer(db, mcp.id, { fetchImpl: unreachableFetch() });
    expect(dead.mcp.up).toBe(false);
    expect(dead.toast).toContain("github-mcp unreachable");

    const { toast } = await deleteMcpServer(db, mcp.id, ACTOR);
    expect(toast).toBe("github-mcp removed");
  });

  it("stdio test discovers a real tool count; a dead command is unreachable", async () => {
    const { db } = setup();
    const { mcp } = await saveMcpServer(
      db,
      { name: "postgres-readonly", transport: "stdio", target: "npx -y @mcp/pg", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 20 }, // saved unreachable first
    );
    expect(mcp.up).toBe(false);

    const healthy = await testMcpServer(db, mcp.id, {
      spawnImpl: fakeMcpSpawn(3),
    });
    expect(healthy.mcp).toMatchObject({ up: true, tools: 3 });
    expect(healthy.toast).toMatch(/^postgres-readonly healthy: 3 tools · \d+ms$/);

    const dead = await testMcpServer(db, mcp.id, {
      spawnImpl: failingSpawn,
    });
    expect(dead.mcp).toMatchObject({ up: false, tools: null });
    // R19-17: the reason carries the spawn's own words ("ENOENT"), which is
    // what tells a reader the binary is missing rather than the server broken.
    expect(dead.toast).toBe(
      "postgres-readonly unreachable: command not found (ENOENT)",
    );
  });

  it("discoverStdioMcpTools: handshake success, timeout, spawn failure", async () => {
    expect(
      await discoverStdioMcpTools("mcp-server", { spawnImpl: fakeMcpSpawn(5) }),
    ).toMatchObject({ kind: "up", tools: 5 });
    expect(
      await discoverStdioMcpTools("mcp-server", {
        spawnImpl: silentSpawn,
        timeoutMs: 20,
      }),
    ).toMatchObject({ kind: "down", reason: "timed out after 0s" });
    expect(
      await discoverStdioMcpTools("mcp-server", { spawnImpl: failingSpawn }),
    ).toMatchObject({ kind: "down", reason: "command not found (ENOENT)" });
  });
});

describe("MCP probe crash-safety, honesty, and teardown (pass 20)", () => {
  it("F20-7: refuses a sub-8-char credential; a longer one never lands in last_error", async () => {
    const { db } = setup();
    // A credential under 8 chars is refused outright — it never reaches the row.
    // Canary: drop the `< 8` guard in saveMcpServer → this no longer throws.
    await expect(
      saveMcpServer(
        db,
        { name: "shorty", transport: "stdio", target: "uvx svc", cred: "xy7Qk" },
        ACTOR,
        { spawnImpl: crashingSpawn("boom\n"), timeoutMs: 50 },
      ),
    ).rejects.toThrowError(/at least 8 characters/);
    expect(listMcpServers(db).find((m) => m.name === "shorty")).toBeUndefined();

    // A longer credential IS allowed; if the dying command echoes it, the
    // persisted `last_error` carries [redacted], never the value.
    await saveMcpServer(
      db,
      { name: "leaky", transport: "stdio", target: "uvx svc", cred: "sk-live-abcdefghijk" },
      ACTOR,
      {
        spawnImpl: crashingSpawn("env: MCP_CREDENTIAL=sk-live-abcdefghijk\nfatal: boom\n"),
        timeoutMs: 60,
      },
    );
    const row = listMcpServers(db).find((m) => m.name === "leaky")!;
    expect(row.lastError).toContain("fatal: boom");
    expect(row.lastError).not.toContain("sk-live-abcdefghijk");
  });

  it("F20-10: markMcpServerUnreachableFromRun flips a healthy row to unreachable by name", async () => {
    const { db } = setup();
    const { mcp } = await saveMcpServer(
      db,
      { name: "everything", transport: "stdio", target: "npx -y @mcp/everything", cred: "" },
      ACTOR,
      { spawnImpl: fakeMcpSpawn(16) },
    );
    expect(mcp).toMatchObject({ up: true, tools: 16 });

    markMcpServerUnreachableFromRun(
      db,
      "everything",
      "it failed to start for this run — Cannot find module 'ajv'",
    );
    const row = listMcpServers(db).find((m) => m.name === "everything")!;
    expect(row.up).toBe(false);
    expect(row.tools).toBeNull();
    expect(row.lastError).toContain("Cannot find module 'ajv'");
    // An unknown name is a no-op, not a throw.
    expect(() => markMcpServerUnreachableFromRun(db, "nope", "x")).not.toThrow();
  });

  it("F20-10 sibling: the run-mount writer announces the change like every other MCP writer", async () => {
    // It writes the SAME shared health row `saveMcpServer` and `testMcpServer`
    // publish `resource.updated` on, but stayed silent — and it is the writer
    // most likely to fire while somebody is looking, because it runs from a
    // background agent run rather than from their own click. An open Settings
    // tab kept rendering the server as up until a manual reload.
    // Canary: drop the publishResourceUpdated call and no event arrives.
    const { db } = setup();
    const { connectSseClient, resetSseBrokerForTests } = await import(
      "~/server/events/sse-broker.server"
    );
    const { mcp } = await saveMcpServer(
      db,
      { name: "everything", transport: "stdio", target: "npx -y @mcp/everything", cred: "" },
      ACTOR,
      { spawnImpl: fakeMcpSpawn(16) },
    );

    resetSseBrokerForTests();
    const writes: string[] = [];
    connectSseClient({
      userId: "u_watcher",
      scopes: [{ kind: "user" }],
      lastEventId: null,
      write: (chunk) => writes.push(chunk),
    });
    try {
      markMcpServerUnreachableFromRun(db, "everything", "it failed to start");
      const events = writes
        .flatMap((chunk) => chunk.split("\n"))
        .filter((line) => line.startsWith("event: "))
        .map((line) => line.slice("event: ".length));
      expect(events).toContain("resource.updated");
      // …naming the row that actually changed.
      expect(writes.join("")).toContain(mcp.id);
    } finally {
      resetSseBrokerForTests();
    }
  });

  it("F20-8: a broken-pipe write to a fast-exiting child settles `down`, never crashes", async () => {
    // Without the stdin 'error' handler the async EPIPE is an uncaught fatal
    // that took the whole server down. Canary: remove the handler and the
    // `emit('error')` with no listener throws, failing this test.
    const disc = await discoverStdioMcpTools("mcp-server", {
      spawnImpl: epipeSpawn,
      timeoutMs: 500,
    });
    expect(disc.kind).toBe("down");
    if (disc.kind === "down") expect(disc.reason).toContain("exited before responding");
  });

  it("F20-22: a silent exit folds its exit code / signal into the reason", async () => {
    expect(
      await discoverStdioMcpTools("svc", { spawnImpl: exitingSpawn(3) }),
    ).toMatchObject({ kind: "down", reason: "exited before responding (exit code 3)" });
    expect(
      await discoverStdioMcpTools("svc", { spawnImpl: exitingSpawn(null, "SIGSEGV") }),
    ).toMatchObject({ kind: "down", reason: "killed by SIGSEGV" });
    // A clean 0-exit before answering stays the bare sentence (nothing to add).
    expect(
      await discoverStdioMcpTools("svc", { spawnImpl: exitingSpawn(0) }),
    ).toMatchObject({ kind: "down", reason: "exited before responding" });
  });

  it("F20-2: teardown signals the process GROUP when a pid is present, else the child", async () => {
    // The fakes model NO grandchildren, so this proves only the SIGNAL choice —
    // the real zombie-reap proof is compose `init: true`, not a unit test.
    const groups: number[] = [];
    let directKills = 0;
    const realKill = process.kill.bind(process);
    process.kill = (pid, sig) => {
      if (pid < 0) {
        groups.push(pid);
        return true;
      }
      return realKill(pid, sig);
    };
    try {
      const withPid: McpSpawn = () => ({
        stdin: { write() {}, end() {} },
        stdout: { on() {} },
        stderr: { on() {} },
        on() {},
        kill() {
          directKills++;
        },
        pid: 4242,
      });
      await discoverStdioMcpTools("svc", { spawnImpl: withPid, timeoutMs: 10 });
      expect(groups).toContain(-4242);
      expect(directKills).toBe(0);

      const noPid: McpSpawn = () => ({
        stdin: { write() {}, end() {} },
        stdout: { on() {} },
        stderr: { on() {} },
        on() {},
        kill() {
          directKills++;
        },
      });
      await discoverStdioMcpTools("svc", { spawnImpl: noPid, timeoutMs: 10 });
      expect(directKills).toBe(1);
    } finally {
      process.kill = realKill;
    }
  });

  it("R20-4: isFirstRunInstallerCommand matches package-runner argv only", () => {
    for (const cmd of [
      "npx -y @mcp/x",
      "bunx thing",
      "uvx svc",
      "pipx run svc",
      "pnpm dlx svc",
      "yarn dlx svc",
      "bun x svc",
      "uv tool run svc",
      "/usr/local/bin/npx svc",
    ]) {
      expect(isFirstRunInstallerCommand(splitMcpCommand(cmd))).toBe(true);
    }
    for (const cmd of [
      "node server.js",
      "my-npx-tool --go",
      "/usr/local/bin/mcp-server",
      "pnpm start",
      "python -m svc",
    ]) {
      expect(isFirstRunInstallerCommand(splitMcpCommand(cmd))).toBe(false);
    }
  });

  it("R20-4: a silent npx probe reports firstRunInstaller; a silent node probe is a plain timeout", async () => {
    const npx = await discoverStdioMcpTools("npx -y @mcp/never", {
      spawnImpl: silentSpawn,
      timeoutMs: 20,
    });
    expect(npx).toMatchObject({ kind: "down", firstRunInstaller: true });
    if (npx.kind === "down") expect(npx.reason).toContain("fetches its package on first use");

    const node = await discoverStdioMcpTools("node server.js", {
      spawnImpl: silentSpawn,
      timeoutMs: 20,
    });
    expect(node).toMatchObject({ kind: "down", reason: "timed out after 0s" });
    if (node.kind === "down") expect(node.firstRunInstaller).toBeUndefined();
  });

  it("R20-4 (N20-2): an always-timing-out npx arms ONE heuristic warm-up, then settles unreachable", async () => {
    const { db } = setup();
    // First save: a SILENT npx command → the heuristic first-run warm-up arms.
    const saved = await saveMcpServer(
      db,
      { name: "cold-npx", transport: "stdio", target: "npx -y @mcp/never", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 10, capMs: 20 },
    );
    expect(saved.mcp.warmingSince).not.toBeNull();
    expect(saved.mcp.heuristicWarmups).toBe(1);
    expect(saved.toast).toContain("installing in the background");

    // Let the (also silent) warm-up time out and settle the row down.
    await new Promise((r) => setTimeout(r, 120));
    const afterWarmup = listMcpServers(db).find((m) => m.name === "cold-npx")!;
    expect(afterWarmup.warmingSince).toBeNull();
    expect(afterWarmup.up).toBe(false);
    expect(afterWarmup.firstSuccessAt ?? null).toBeNull();
    expect(afterWarmup.heuristicWarmups).toBe(1);

    // The cap is spent: a retest does NOT arm a second warm-up and reads plainly
    // unreachable — the terminal condition R19-17c requires. Canary: drop the
    // `heuristicWarmups < 1` clause and the retest re-arms (warmingSince set,
    // toast says "installing"), failing the two assertions below.
    const retest = await testMcpServer(db, afterWarmup.id, {
      spawnImpl: silentSpawn,
      timeoutMs: 10,
      capMs: 20,
    });
    expect(retest.mcp.warmingSince).toBeNull();
    expect(retest.mcp.up).toBe(false);
    expect(retest.mcp.heuristicWarmups).toBe(1);
    expect(retest.toast).toContain("unreachable");
  });
});

describe("disk is truth (finding #7)", () => {
  it("lists an on-disk skill folder that has no metadata row, with defaults", () => {
    const { db, dataRoot, ctx } = setup();
    // A skill folder that appeared on disk outside org settings (like the
    // shipped *-expertise skills), with frontmatter description.
    const dir = skillDirPath("developer-expertise", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: developer-expertise\ndescription: Implement a task's stage work.\n---\n# body",
    );

    const skills = listSkills(db, ctx);
    const disk = skills.find((s) => s.name === "developer-expertise")!;
    expect(disk).toBeTruthy();
    expect(disk.id).toBe("disk:developer-expertise");
    expect(disk.summary).toBe("Implement a task's stage work.");
    expect(disk.updatedAt).toBeNull();
    // getSkill resolves the synthetic id (StoreBrowser / edit rely on this).
    expect(getSkill(db, disk.id, ctx)!.body).toContain("# body");
  });

  it("derives the summary from a BLOCK-SCALAR description (imported skills) — not a literal '|'", () => {
    const { db, dataRoot, ctx } = setup();
    const dir = skillDirPath("humanizer", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: humanizer\ndescription: |\n  Remove signs of AI-generated writing from text.\n  Longer tail ignored.\n---\n# body",
    );
    const disk = listSkills(db, ctx).find((s) => s.name === "humanizer")!;
    expect(disk.summary).toBe("Remove signs of AI-generated writing from text.");
  });

  it("editing a disk-only skill adopts it into a real metadata row", async () => {
    const { db, dataRoot, ctx } = setup();
    const dir = skillDirPath("reviewer-expertise", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# original");

    const before = getSkill(db, "disk:reviewer-expertise", ctx)!;
    const { skill, toast } = await saveSkill(
      db,
      { id: before.id, name: "reviewer-expertise", summary: "Review verdicts.", body: "# edited" },
      ACTOR,
      ctx,
    );
    expect(toast).toBe("Skill reviewer-expertise updated. SKILL.md rewritten");
    expect(skill.id).toMatch(/^sk_/); // now a real row, not synthetic
    expect(skill.summary).toBe("Review verdicts.");
    // Only ONE entry — no duplicate between disk + row.
    expect(listSkills(db, ctx).filter((s) => s.name === "reviewer-expertise")).toHaveLength(1);
  });

  it("delete removes a disk-only skill folder even with no row", async () => {
    const { db, dataRoot, ctx } = setup();
    const dir = skillDirPath("orphan-expertise", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# body");

    const { toast } = await deleteSkill(db, "disk:orphan-expertise", ACTOR, ctx);
    expect(toast).toBe("Skill orphan-expertise deleted");
    expect(existsSync(dir)).toBe(false);
    expect(listSkills(db, ctx)).toHaveLength(0);
  });

  it("re-indexing a disk-only KB adopts it so the timestamp sticks", () => {
    const { db, dataRoot, ctx } = setup();
    const dir = kbDirPath("runbooks", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "deploy.md"), "# runbook");

    const before = listKnowledgeBases(db, ctx).find((k) => k.dir === "runbooks")!;
    expect(before.id).toBe("disk:runbooks");
    expect(before.lastIndexedAt).toBeNull();

    reindexKnowledgeBase(db, before.id, ACTOR, ctx);
    const after = listKnowledgeBases(db, ctx).find((k) => k.dir === "runbooks")!;
    expect(after.id).toMatch(/^kb_/);
    expect(after.lastIndexedAt).not.toBeNull();
  });

  it("a fresh create refuses to clobber an existing on-disk skill folder", async () => {
    const { db, dataRoot, ctx } = setup();
    const dir = skillDirPath("api-design", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# keep me");

    await expect(
      saveSkill(
        db,
        { name: "api-design", summary: "New skill.", body: "" },
        ACTOR,
        ctx,
      ),
    ).rejects.toThrowError(/already exists/);
    // Original content untouched.
    expect(getSkill(db, "disk:api-design", ctx)!.body).toContain("# keep me");
  });

  it("rejects a path-traversal disk id instead of escaping the store root", async () => {
    const { db, ctx } = setup();
    // A crafted synthetic id must NOT resolve to a path outside the store.
    for (const evil of [
      "disk:../../etc/passwd",
      "disk:..",
      "disk:a/b",
      "disk:a\\b",
    ]) {
      await expect(deleteSkill(db, evil, ACTOR, ctx)).rejects.toThrowError(
        /No such skill/,
      );
      await expect(
        deleteKnowledgeBase(db, evil, ACTOR, ctx),
      ).rejects.toThrowError(/No such knowledge base/);
    }
  });
});

/* --------------------------------- resource reference integrity (P13-KM-07) */

describe("resource reference integrity", () => {
  function writeProfileTemplate(
    dataRoot: string,
    id: string,
    resources: { skills?: string[]; mcps?: string[]; kb?: string[] },
  ) {
    const list = (key: "skills" | "mcps" | "kb") => {
      const entries = resources[key] ?? [];
      return entries.length === 0
        ? [`  ${key}: []`]
        : [`  ${key}:`, ...entries.map((e) => `    - ${e}`)];
    };
    mkdirSync(path.join(dataRoot, "agents", "profiles"), { recursive: true });
    writeFileSync(
      path.join(dataRoot, "agents", "profiles", `${id}.md`),
      [
        "---",
        `id: ${id}`,
        "kind: specialist",
        `name: ${id}`,
        `role: ${id}`,
        'desc: "t"',
        "icon: cpu",
        "backends:",
        "  - claude",
        'model: ""',
        "scope: Global base",
        "stages:",
        "  - impl",
        "spanAll: false",
        "capabilities: []",
        "extras: []",
        "resources:",
        ...list("skills"),
        ...list("mcps"),
        ...list("kb"),
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
  }

  function grantsOf(dataRoot: string, id: string): string {
    return readFileSync(path.join(dataRoot, "agents", "profiles", `${id}.md`), "utf8");
  }

  it("renaming a KB rewrites every profile grant instead of orphaning it", async () => {
    const { db, dataRoot, ctx } = setup();
    const { kb } = await saveKnowledgeBase(
      db,
      { name: "P13 facts", refresh: "on change" },
      ACTOR,
      ctx,
    );
    expect(kb.dir).toBe("p13-facts");
    writeProfileTemplate(dataRoot, "scout", { kb: ["p13-facts"] });

    await saveKnowledgeBase(
      db,
      { id: kb.id, name: "P13 facts v2", refresh: "on change" },
      ACTOR,
      ctx,
    );

    // Live-proven failure before this fix: the folder moved, the row moved, and
    // seven profiles kept pointing at `p13-facts` with no warning anywhere — a
    // fresh run then reported "there is no p13-facts knowledge base reaching
    // this run" while the UI still showed the grant attached.
    expect(existsSync(kbDirPath("p13-facts-v2", dataRoot))).toBe(true);
    expect(grantsOf(dataRoot, "scout")).toContain("p13-facts-v2");
    expect(grantsOf(dataRoot, "scout")).not.toMatch(/- p13-facts$/m);
  });

  /**
   * C4/pass-16 — rename ↔ KB-watcher race.
   *
   * The old order was `renameSync` → `await updateResourceReferences(…)` →
   * `UPDATE … SET dir`. The await walks every agent template AND every
   * project.md, so it scales with the installation, while the KB watcher
   * debounces for only 250 ms. When the walk ran long the watcher saw the new
   * folder, found no row for it, and ADOPTED it as a brand-new KB — after which
   * the pending UPDATE hit the `dir` UNIQUE constraint and the rename blew up
   * on a folder that had already moved.
   *
   * This drives the race deterministically instead of racing a real timer:
   * `saveKnowledgeBase` runs synchronously up to its FIRST await, so firing the
   * watcher's re-index right there reproduces the exact interleaving. With the
   * row write moved ahead of the await, the watcher can only ever observe a
   * state where disk and row already agree.
   */
  it("a watcher re-index landing mid-rename cannot fork a duplicate row (C4)", async () => {
    const { db, dataRoot, ctx } = setup();
    const { kb } = await saveKnowledgeBase(
      db,
      { name: "Race facts", refresh: "on change" },
      ACTOR,
      ctx,
    );
    expect(kb.dir).toBe("race-facts");
    // A profile grant + a real project.md give `updateResourceReferences`
    // something to walk, so it genuinely suspends.
    writeProfileTemplate(dataRoot, "scout", { kb: ["race-facts"] });

    const pending = saveKnowledgeBase(
      db,
      { id: kb.id, name: "Race facts v2", refresh: "on change" },
      ACTOR,
      ctx,
    );
    // …the watcher's debounce fires HERE, at the first suspension point.
    reindexKnowledgeBaseByDir(db, "race-facts-v2", ctx);
    await expect(pending).resolves.toMatchObject({
      kb: { id: kb.id, dir: "race-facts-v2" },
    });

    const rows = z
      .object({ id: z.string(), dir: z.string() })
      .array()
      .parse(
        db.prepare(`SELECT id, dir FROM org_knowledge_bases ORDER BY dir`).all(),
      );
    expect(rows).toEqual([{ id: kb.id, dir: "race-facts-v2" }]);
    // The rename still completed on both legs.
    expect(existsSync(kbDirPath("race-facts-v2", dataRoot))).toBe(true);
    expect(grantsOf(dataRoot, "scout")).toContain("race-facts-v2");
  });

  it("deleting a KB drops the grant rather than leaving it dangling", async () => {
    const { db, dataRoot, ctx } = setup();
    const { kb } = await saveKnowledgeBase(
      db,
      { name: "Throwaway", refresh: "manual" },
      ACTOR,
      ctx,
    );
    writeProfileTemplate(dataRoot, "scout", { kb: [kb.dir, "keep-me"] });

    await deleteKnowledgeBase(db, kb.id, ACTOR, ctx);

    const raw = grantsOf(dataRoot, "scout");
    expect(raw).not.toContain("throwaway");
    expect(raw).toContain("keep-me");
  });

  it("renaming a skill rewrites its grants too", async () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = await saveSkill(
      db,
      { name: "old-craft", summary: "Old craft.", body: "# old" },
      ACTOR,
      ctx,
    );
    writeProfileTemplate(dataRoot, "scout", { skills: ["old-craft"] });

    await saveSkill(
      db,
      { id: skill.id, name: "new-craft", summary: "New craft.", body: "" },
      ACTOR,
      ctx,
    );

    expect(grantsOf(dataRoot, "scout")).toContain("new-craft");
    expect(grantsOf(dataRoot, "scout")).not.toContain("old-craft");
  });

  it("P14-KM-01: renaming an MCP server rewrites its grants instead of orphaning them", async () => {
    const { db, dataRoot, ctx } = setup();
    const saved = await saveMcpServer(
      db,
      { name: "vm-memory", transport: "stdio", target: "node /tmp/mem.mjs", cred: "" },
      ACTOR,
      { spawnImpl: fakeMcpSpawn(3) },
      ctx,
    );
    writeProfileTemplate(dataRoot, "scout", { mcps: ["vm-memory", "billing-api"] });

    await saveMcpServer(
      db,
      {
        id: saved.mcp.id,
        name: "vm-graph-memory",
        transport: "stdio",
        target: "node /tmp/mem.mjs",
        cred: "",
      },
      ACTOR,
      { spawnImpl: fakeMcpSpawn(3) },
      ctx,
    );

    // Live-proven before this fix: the row renamed, both scout profiles kept
    // pointing at `vm-memory`, and the next run advertised the server in its
    // prompt while exposing zero tools (LV-09).
    const raw = grantsOf(dataRoot, "scout");
    expect(raw).toContain("vm-graph-memory");
    expect(raw).not.toMatch(/- vm-memory$/m);
    expect(raw).toContain("billing-api");
  });

  it("deleting an MCP server drops its grants (unchanged), a plain re-save keeps them", async () => {
    const { db, dataRoot, ctx } = setup();
    const saved = await saveMcpServer(
      db,
      { name: "billing-api", transport: "HTTP", target: "https://x.dev/mcp", cred: "" },
      ACTOR,
      { fetchImpl: mcpHttpFetch(2) },
      ctx,
    );
    writeProfileTemplate(dataRoot, "scout", { mcps: ["billing-api"] });

    // Editing WITHOUT a rename must not touch the grant.
    await saveMcpServer(
      db,
      {
        id: saved.mcp.id,
        name: "billing-api",
        transport: "HTTP",
        target: "https://y.dev/mcp",
        cred: "",
      },
      ACTOR,
      { fetchImpl: mcpHttpFetch(2) },
      ctx,
    );
    expect(grantsOf(dataRoot, "scout")).toContain("billing-api");

    await deleteMcpServer(db, saved.mcp.id, ACTOR, ctx);
    expect(grantsOf(dataRoot, "scout")).not.toContain("billing-api");
  });
});

/* ---------------------- MCP credentials + SSE framing (P13-KM-05/KM-06/LV-10) */

describe("MCP credentials and transports", () => {
  it("discovers over an SSE-framed body, not just raw JSON", async () => {
    const { db } = setup();
    const saved = await saveMcpServer(
      db,
      { name: "sse-server", transport: "HTTP", target: "https://x.dev/mcp", cred: "" },
      ACTOR,
      { fetchImpl: mcpHttpFetch(4, { sseFramed: true }) },
    );
    expect(saved.mcp).toMatchObject({ up: true, tools: 4 });
  });

  it("probes a credentialed HTTP server WITH its credential", async () => {
    const { db } = setup();
    // P13-KM-05: the probe used to run unauthenticated, so a server that works
    // inside a run reported "unreachable" in Settings.
    const saved = await saveMcpServer(
      db,
      {
        name: "secured",
        transport: "HTTP",
        target: "https://x.dev/mcp",
        cred: "s3cret-token",
      },
      ACTOR,
      { fetchImpl: mcpHttpFetch(2, { requireAuth: "s3cret-token" }) },
    );
    expect(saved.mcp).toMatchObject({ up: true, tools: 2, hasCred: true });

    const retest = await testMcpServer(db, saved.mcp.id, {
      fetchImpl: mcpHttpFetch(2, { requireAuth: "s3cret-token" }),
    });
    expect(retest.mcp.up).toBe(true);
  });

  it("passes the credential to a stdio server's environment", async () => {
    const { db } = setup();
    let sawToken: string | null | undefined;
    const spawnImpl = (cmd: string, args: string[], token?: string | null) => {
      sawToken = token;
      return fakeMcpSpawn(3)(cmd, args);
    };
    await saveMcpServer(
      db,
      { name: "stdio-secured", transport: "stdio", target: "npx -y @mcp/x", cred: "tok-12345" },
      ACTOR,
      { spawnImpl },
    );
    expect(sawToken).toBe("tok-12345");
  });

  it("a blank credential KEEPS the stored one; clearCred REMOVES it", async () => {
    const { db } = setup();
    const saved = await saveMcpServer(
      db,
      { name: "keeper", transport: "HTTP", target: "https://x.dev/mcp", cred: "tok-first" },
      ACTOR,
      { fetchImpl: mcpHttpFetch(1) },
    );
    expect(saved.mcp.hasCred).toBe(true);

    const kept = await saveMcpServer(
      db,
      { id: saved.mcp.id, name: "keeper", transport: "HTTP", target: "https://x.dev/mcp", cred: "" },
      ACTOR,
      { fetchImpl: mcpHttpFetch(1) },
    );
    expect(kept.mcp.hasCred).toBe(true);

    // P13-KM-06: without an explicit intent there was NO way to remove a
    // credential — a repointed server kept sending the old token forever.
    const cleared = await saveMcpServer(
      db,
      {
        id: saved.mcp.id,
        name: "keeper",
        transport: "HTTP",
        target: "https://other.dev/mcp",
        cred: "",
        clearCred: true,
      },
      ACTOR,
      { fetchImpl: mcpHttpFetch(1) },
    );
    expect(cleared.mcp.hasCred).toBe(false);
  });

  it("P14-KM-04: the stdio probe parses quoted commands the way runs do", async () => {
    const { db } = setup();
    let sawCommand: string | null = null;
    let sawArgs: string[] = [];
    const spawnImpl: McpSpawn = (cmd, args) => {
      sawCommand = cmd;
      sawArgs = args;
      return fakeMcpSpawn(5)(cmd, args);
    };

    const saved = await saveMcpServer(
      db,
      {
        name: "quoted",
        transport: "stdio",
        // The run resolver has been quote-aware since P13-KM-17; the probe split
        // on whitespace, so a path with a space reported "exited before
        // responding" in Settings while working perfectly inside a run.
        target: `"/opt/my tools/mcp" --config '{"a": 1}'`,
        cred: "",
      },
      ACTOR,
      { spawnImpl },
    );

    expect(sawCommand).toBe("/opt/my tools/mcp");
    expect(sawArgs).toEqual(["--config", '{"a": 1}']);
    expect(saved.mcp).toMatchObject({ up: true, tools: 5 });
  });
});

/* ------------------------------ injectable doc counts (P14-KM-13) */

describe("knowledge-base doc counts", () => {
  it("counts only the docs a run can read, and keeps the raw file count", async () => {
    const { db, dataRoot, ctx } = setup();
    const { kb } = await saveKnowledgeBase(
      db,
      { name: "Specs", refresh: "manual" },
      ACTOR,
      ctx,
    );
    const dir = kbDirPath(kb.dir, dataRoot);
    writeFileSync(path.join(dir, "overview.md"), "# text");
    writeFileSync(path.join(dir, "notes.txt"), "text");
    // A KB of PDFs used to advertise a healthy "N docs" and inject nothing —
    // the count and `readKbBody` now answer the same question.
    writeFileSync(path.join(dir, "contract.pdf"), "%PDF-1.7");
    writeFileSync(path.join(dir, "diagram.png"), "png");

    const fresh = getKnowledgeBase(db, kb.id, ctx)!;
    expect(fresh.fileCount).toBe(4);
    expect(fresh.injectableCount).toBe(2);

    const reindexed = reindexKnowledgeBase(db, kb.id, ACTOR, ctx);
    expect(reindexed.docCount).toBe(2);
    expect(reindexed.toast).toContain("2 docs agents can read");
    expect(reindexed.toast).toContain("2 non-text files skipped");
  });
});

/**
 * A registered stdio MCP command is third-party code an admin named, and it is
 * spawned by the app itself. Without an explicit `env` Node hands the child
 * this process's WHOLE environment — including the key that decrypts every
 * stored PAT and MCP credential, the session-signing secret and the provider
 * keys — while the agent runtimes filter exactly those (F10-02). The child's
 * stderr is then persisted into `org_mcp_servers.last_error`, so a server that
 * prints its environment while crashing parks those values in the database.
 */
describe("mcpSpawnEnv (third-party command isolation)", () => {
  const SECRETS = {
    VIBERR_SECRET_ENCRYPTION_KEY: "the-key-that-opens-every-credential",
    BETTER_AUTH_SECRET: "session-signing-secret",
    ANTHROPIC_API_KEY: "sk-provider-key",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DATABASE_URL: "postgres://user:pw@host/db",
  };

  it("withholds credential-shaped variables and passes ordinary ones through", async () => {
    const { mcpSpawnEnv } = await import("./resources.server");
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const savedPath = process.env.PATH;
    process.env.PATH ??= "/usr/bin";
    try {
      const env = mcpSpawnEnv(null);
      for (const key of Object.keys(SECRETS)) {
        expect(env[key], `${key} must not reach a third-party command`).toBeUndefined();
      }
      // Not a lockout: an MCP command still needs an ordinary environment.
      expect(env.PATH).toBeTruthy();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it("passes the ONE secret the child is meant to hold, and nothing else", async () => {
    const { mcpSpawnEnv } = await import("./resources.server");
    const saved = process.env.VIBERR_SECRET_ENCRYPTION_KEY;
    process.env.VIBERR_SECRET_ENCRYPTION_KEY = "must-not-travel";
    try {
      const env = mcpSpawnEnv("mcp-token-value");
      expect(env.MCP_CREDENTIAL).toBe("mcp-token-value");
      expect(env.VIBERR_SECRET_ENCRYPTION_KEY).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.VIBERR_SECRET_ENCRYPTION_KEY;
      else process.env.VIBERR_SECRET_ENCRYPTION_KEY = saved;
    }
  });

  it("ruling 142: withholds Viberr's own configuration, which a third-party command has no business reading", async () => {
    // U34-7 (pass 34): the container's NODE_ENV=production and PORT rode
    // into every stdio MCP child through this same base (and into every
    // agent shell, where they broke the project's own tooling). A registered
    // command is somebody else's program; this server's declared
    // configuration is not its environment. None of these names is
    // credential-shaped, so the regex above let every one of them through.
    const { mcpSpawnEnv } = await import("./resources.server");
    const APP_CONFIG = {
      NODE_ENV: "production",
      PORT: "5173",
      VIBERR_DATA_ROOT: "/data",
      BETTER_AUTH_URL: "https://viberr.example.com",
      GITHUB_OAUTH_CLIENT_ID: "iv1.example-client-id",
      VIBERR_UNLOCK_CONTROLLER_MCPS: "enabled",
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(APP_CONFIG)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const savedPath = process.env.PATH;
    process.env.PATH ??= "/usr/bin";
    try {
      const env = mcpSpawnEnv("mcp-token-value");
      for (const key of Object.keys(APP_CONFIG)) {
        expect(env[key], `${key} must not reach a third-party command`).toBeUndefined();
      }
      // The whole declared list, whatever it holds today.
      expect(ENV_KEYS.filter((key) => key in env)).toEqual([]);
      // The child still gets its one secret and an ordinary environment.
      expect(env.MCP_CREDENTIAL).toBe("mcp-token-value");
      expect(env.PATH).toBeTruthy();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});
