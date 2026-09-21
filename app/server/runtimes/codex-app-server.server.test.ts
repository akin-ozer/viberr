import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { z } from "zod";
import {
  codexBinaryPath,
  compactCodexThread,
  type AppServerProcess,
  type SpawnAppServer,
} from "./codex-app-server.server";

/**
 * Ruling 376: the Codex completion compaction speaks the app-server's JSON-RPC
 * over stdio. These cases script the server side over pipes and pin the
 * exchange the client makes, the notification that settles it, and the three
 * ways it ends without a compaction.
 */

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
type Request = z.infer<typeof requestSchema>;

/** A line the scripted server writes back: a reply or a notification. */
interface ServerLine {
  id?: number | undefined;
  method?: string;
  params?: { threadId?: string; turnId?: string; item?: { type: string; id: string } };
  result?: ServerResult;
  error?: { code: number; message: string };
}
interface ServerResult {
  codexHome?: string;
  thread?: { id: string };
}

interface ScriptedServer {
  spawn: SpawnAppServer;
  requests: Request[];
  spawned: { binary: string; args: readonly string[]; env: Record<string, string> | undefined }[];
  killed: NodeJS.Signals[];
  exit(code: number): void;
}

/** A fake app-server: answers each request through `reply`, which returns the
 *  lines (already objects) to write back, notifications included. */
function scriptedServer(
  reply: (request: Request, write: (line: ServerLine) => void) => void,
): ScriptedServer {
  const requests: Request[] = [];
  const spawned: ScriptedServer["spawned"] = [];
  const killed: NodeJS.Signals[] = [];
  let exitListener: ((code: number | null) => void) | null = null;
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const write = (line: ServerLine) => {
    stdout.write(`${JSON.stringify(line)}\n`);
  };
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const request = requestSchema.parse(JSON.parse(raw));
      requests.push(request);
      reply(request, write);
    }
  });
  const process: AppServerProcess = {
    stdin,
    stdout,
    stderr: null,
    kill(signal) {
      killed.push(signal ?? "SIGTERM");
      return true;
    },
    once(_event, listener) {
      exitListener = listener;
      return process;
    },
    on() {
      return process;
    },
  };
  return {
    spawn: (binary, args, env) => {
      spawned.push({ binary, args, env });
      return process;
    },
    requests,
    spawned,
    killed,
    exit(code) {
      exitListener?.(code);
    },
  };
}

const ok = (request: Request, result: ServerResult = {}): ServerLine => ({ id: request.id, result });

describe("compactCodexThread (ruling 376)", () => {
  it("initializes, resumes the thread with the run's cwd, model and config, starts the compaction and settles on thread/compacted", async () => {
    const server = scriptedServer((request, write) => {
      if (request.method === "initialize") write(ok(request, { codexHome: "/x" }));
      if (request.method === "thread/resume") write(ok(request, { thread: { id: "t-1" } }));
      if (request.method === "thread/compact/start") {
        write(ok(request));
        write({ method: "thread/compacted", params: { threadId: "t-1", turnId: "turn-9" } });
      }
    });
    const outcome = await compactCodexThread({
      threadId: "t-1",
      cwd: "/data/projects/p/tasks/T-1/workspace/repo",
      model: "gpt-5.6-terra",
      config: { compact_prompt: "keep the task key" },
      env: { CODEX_HOME: "/home/codex", VIBERR_RUN_ID: "run_1" },
      spawn: server.spawn,
      binary: "/opt/codex",
    });
    expect(outcome).toEqual({ compacted: true, preTokens: null, postTokens: null });
    expect(server.spawned).toEqual([
      { binary: "/opt/codex", args: ["app-server"], env: { CODEX_HOME: "/home/codex", VIBERR_RUN_ID: "run_1" } },
    ]);
    expect(server.requests.map((r) => r.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/compact/start",
    ]);
    expect(server.requests[0]).toMatchObject({ id: 1, params: { clientInfo: { name: "viberr" } } });
    expect(server.requests[1]?.id).toBeUndefined(); // a notification, per the protocol
    expect(server.requests[2]?.params).toEqual({
      threadId: "t-1",
      cwd: "/data/projects/p/tasks/T-1/workspace/repo",
      model: "gpt-5.6-terra",
      config: { compact_prompt: "keep the task key" },
    });
    expect(server.requests[3]?.params).toEqual({ threadId: "t-1" });
    // The server is not left running once the compaction is on disk.
    expect(server.killed).toEqual(["SIGTERM"]);
  });

  it("the contextCompaction item settles it too, and a compaction of another thread does not", async () => {
    const server = scriptedServer((request, write) => {
      if (request.method === "initialize") write(ok(request));
      if (request.method === "thread/resume") write(ok(request));
      if (request.method === "thread/compact/start") {
        write(ok(request));
        write({ method: "thread/compacted", params: { threadId: "someone-else", turnId: "x" } });
        // v2's spelling, the one the CLI actually sends.
        write({ method: "item/completed", params: { threadId: "t-2", item: { type: "contextCompaction", id: "c" } } });
      }
    });
    const outcome = await compactCodexThread({ threadId: "t-2", cwd: "/w", spawn: server.spawn, binary: "codex" });
    expect(outcome.compacted).toBe(true);
  });

  it("a refusal on any step is the outcome's reason, never a throw", async () => {
    const server = scriptedServer((request, write) => {
      if (request.method === "initialize") write(ok(request));
      if (request.method === "thread/resume") {
        write({ id: request.id, error: { code: -32000, message: "thread not found" } });
      }
    });
    const outcome = await compactCodexThread({ threadId: "gone", cwd: "/w", spawn: server.spawn, binary: "codex" });
    expect(outcome).toEqual({ compacted: false, reason: "thread/resume refused: thread not found" });
    expect(server.requests.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume"]);
  });

  it("the server dying before the notification is a reason", async () => {
    const server = scriptedServer((request, write) => {
      if (request.method === "initialize") write(ok(request));
      if (request.method === "thread/resume") write(ok(request));
      if (request.method === "thread/compact/start") {
        write(ok(request));
        queueMicrotask(() => server.exit(1));
      }
    });
    const outcome = await compactCodexThread({ threadId: "t-3", cwd: "/w", spawn: server.spawn, binary: "codex" });
    expect(outcome).toMatchObject({ compacted: false });
    expect(z.object({ reason: z.string() }).parse(outcome).reason).toContain("exited (1)");
  });

  it("a silent server is a reason once the timeout passes", async () => {
    const server = scriptedServer((request, write) => {
      if (request.method === "initialize") write(ok(request));
      if (request.method === "thread/resume") write(ok(request));
      if (request.method === "thread/compact/start") write(ok(request));
    });
    const outcome = await compactCodexThread({
      threadId: "t-4",
      cwd: "/w",
      spawn: server.spawn,
      binary: "codex",
      timeoutMs: 30,
    });
    expect(outcome).toMatchObject({ compacted: false });
    expect(z.object({ reason: z.string() }).parse(outcome).reason).toContain("did not report a compaction");
    expect(server.killed).toEqual(["SIGTERM"]);
  });

  it("a spawn that throws is a reason", async () => {
    const outcome = await compactCodexThread({
      threadId: "t-5",
      cwd: "/w",
      binary: "codex",
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(outcome).toEqual({ compacted: false, reason: "the app-server could not be started: ENOENT" });
  });

  it("the binary is the SDK's vendored one for this platform, or codex on PATH", () => {
    const binary = codexBinaryPath();
    expect(binary === "codex" || /vendor\/[a-z0-9_-]+\/bin\/codex$/.test(binary)).toBe(true);
  });
});
