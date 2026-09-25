import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import type { CompactOutcome } from "./adapter.server";
import { launchEnv, type AgentLaunch } from "./agent-isolation.server";
import { errorMessage } from "../../shared/errors";

/**
 * Ruling 376: compact a Codex thread on demand through the CLI's app-server.
 *
 * `codex exec` and the SDK have no compaction command (verified against
 * 0.153.4: `exec --help`, the SDK's types and the config reference), but the
 * app-server protocol the desktop app speaks has one — `thread/compact/start`
 * — and the same binary serves it over stdio as newline-delimited JSON-RPC.
 * The flow is `initialize` → `initialized` → `thread/resume` (by id, with the
 * run's cwd, model and the shared summarizer prompt as config) →
 * `thread/compact/start`, then the `thread/compacted` notification (or the
 * `ContextCompaction` item) says the CLI wrote the `compacted` line into the
 * rollout, which `codexRolloutRunStats` then reads for the sizes.
 *
 * The binary is the SDK's own vendored one (the platform package the SDK
 * resolves), so the compaction runs the exact CLI the run ran on.
 */

/** The process shape the client drives; `node:child_process` satisfies it and
 *  a test supplies pipes of its own. */
export interface AppServerProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/** The config overrides a resumed thread takes: the summarizer prompt is the
 *  one Viberr sets; the CLI accepts any of its config keys here. */
export interface ThreadResumeConfig {
  compact_prompt?: string;
}

/** The parameters the exchange sends, by method (all optional: each method
 *  takes its own subset). */
interface RpcParams {
  clientInfo?: { name: string; version: string };
  threadId?: string;
  cwd?: string;
  model?: string;
  config?: ThreadResumeConfig;
}

export type SpawnAppServer = (
  binary: string,
  args: readonly string[],
  env: Record<string, string> | undefined,
) => AppServerProcess;

export interface CompactThreadInput {
  threadId: string;
  /** The run's working directory: `thread/resume` re-anchors the thread there. */
  cwd: string;
  /** The model the thread ran on (the CLI otherwise falls back to its default). */
  model?: string;
  /** Config overrides for the resumed thread: the summarizer prompt, chiefly. */
  config?: ThreadResumeConfig;
  env?: Record<string, string>;
  /** Injected for tests; the real one spawns the vendored binary. */
  spawn?: SpawnAppServer;
  binary?: string;
  /** Ruling 460: run the app-server as the person's own OS user, through the
   *  launcher — the compaction writes into their home like the run did. */
  launch?: AgentLaunch | null;
  /** How long the whole exchange may take before it is a failure (a 175k
   *  thread compacted in about a minute live). */
  timeoutMs?: number;
}

/** A 175k thread compacted in about a minute live; five is a wide margin. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** The platform package and target triple the SDK's own lookup uses. */
interface PlatformPackage {
  pkg: string;
  triple: string;
}

const PLATFORM_PACKAGES = new Map<string, PlatformPackage>([
  ["darwin-arm64", { pkg: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" }],
  ["darwin-x64", { pkg: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" }],
  ["linux-arm64", { pkg: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" }],
  ["linux-x64", { pkg: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" }],
]);

/** The vendored `codex` binary and the helper directories the SDK puts on the
 *  child's PATH when it resolves the binary itself (`codex-path/`, which holds
 *  `rg`). A caller that overrides the binary (`codexPathOverride`, ruling 460)
 *  must prepend them itself: the SDK adds none for an override. */
export interface CodexVendor {
  binary: string;
  pathDirs: string[];
}

/** The ONE resolver of the vendored Codex CLI (the run's launch through
 *  `viberr-launch` and the completion compaction both read it), mirroring the
 *  SDK's own lookup: `codex` on PATH when the platform package is not
 *  installed (the SDK would fail the same way). */
export function codexVendor(): CodexVendor {
  const entry = PLATFORM_PACKAGES.get(`${process.platform}-${process.arch}`);
  if (!entry) return { binary: "codex", pathDirs: [] };
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${entry.pkg}/package.json`);
    const root = path.join(path.dirname(manifest), "vendor", entry.triple);
    const helpers = path.join(root, "codex-path");
    return {
      binary: path.join(root, "bin", "codex"),
      pathDirs: existsSync(helpers) ? [helpers] : [],
    };
  } catch {
    return { binary: "codex", pathDirs: [] };
  }
}

/** The vendored `codex` binary for this platform. */
export function codexBinaryPath(): string {
  return codexVendor().binary;
}

/** `env` with `dirs` first on its PATH, as the SDK does for its own lookup. */
export function withPathDirs(env: Record<string, string>, dirs: readonly string[]) {
  if (dirs.length === 0) return env;
  const rest = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir && !dirs.includes(dir));
  return { ...env, PATH: [...dirs, ...rest].join(path.delimiter) };
}

const rpcLineSchema = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  method: z.string().nullish(),
  params: z.record(z.string(), z.unknown()).nullish(),
  result: z.unknown().nullish(),
  error: z.object({ message: z.string().catch("") }).nullish(),
});

/** The item types that mean "the thread was compacted", across spellings. */
const COMPACTION_ITEM_TYPES: ReadonlySet<string> = new Set([
  "contextCompaction",
  "ContextCompaction",
  "context_compaction",
]);

const compactedItemSchema = z.object({
  item: z.object({ type: z.string().catch("") }).nullish(),
  threadId: z.string().nullish(),
});

const realSpawn: SpawnAppServer = (binary, args, env) =>
  spawnProcess(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });

/**
 * Drive one compaction over the app-server. Resolves with the outcome; a
 * provider refusal, a protocol error or the process dying is a reason, never
 * a thrown error (the run service records the reason and finalizes the run).
 */
export function compactCodexThread(input: CompactThreadInput): Promise<CompactOutcome> {
  const spawn = input.spawn ?? realSpawn;
  const realBinary = input.binary ?? codexBinaryPath();
  const binary = input.launch ? input.launch.launcher : realBinary;
  // A launched run always carries its env (the credential's home rides it).
  const env = input.launch ? launchEnv(input.launch, realBinary, input.env ?? {}) : input.env;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<CompactOutcome>((resolve) => {
    let settled = false;
    let child: AppServerProcess;
    const finish = (outcome: CompactOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ compacted: false, reason: `the app-server did not report a compaction within ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
    timer.unref?.();
    try {
      child = spawn(binary, ["app-server"], env);
    } catch (error) {
      clearTimeout(timer);
      resolve({
        compacted: false,
        reason: `the app-server could not be started: ${errorMessage(error)}`,
      });
      return;
    }
    child.on("error", (error) => finish({ compacted: false, reason: `the app-server failed: ${error.message}` }));
    child.once("exit", (code) =>
      finish({ compacted: false, reason: `the app-server exited (${code ?? "signal"}) before reporting a compaction` }),
    );
    let nextId = 1;
    const pending = new Map<number, (line: z.infer<typeof rpcLineSchema>) => void>();
    // The resolver is registered BEFORE the write: a server that answers on
    // the same tick (pipes in a test do) would otherwise answer nobody.
    const request = (method: string, params?: RpcParams) =>
      new Promise<z.infer<typeof rpcLineSchema>>((resolveReply) => {
        const id = nextId++;
        pending.set(id, resolveReply);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const notify = (method: string) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    };
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!raw) continue;
        let parsed: z.infer<typeof rpcLineSchema>;
        try {
          parsed = rpcLineSchema.parse(JSON.parse(raw));
        } catch {
          continue;
        }
        const replyId = z.number().safeParse(parsed.id);
        if (replyId.success && pending.has(replyId.data)) {
          const reply = pending.get(replyId.data)!;
          pending.delete(replyId.data);
          reply(parsed);
          continue;
        }
        if (parsed.method === "thread/compacted") {
          const params = compactedItemSchema.safeParse(parsed.params ?? {});
          if (!params.success || !params.data.threadId || params.data.threadId === input.threadId) {
            finish({ compacted: true, preTokens: null, postTokens: null });
          }
          continue;
        }
        if (parsed.method === "item/completed") {
          // v2 spells the item `contextCompaction`; the CLI's own rollout and
          // older builds spell it `ContextCompaction` (live, 2026-09-21: the
          // first spelling alone let a real compaction go unreported for ten
          // minutes). Both count.
          const params = compactedItemSchema.safeParse(parsed.params ?? {});
          if (params.success && COMPACTION_ITEM_TYPES.has(params.data.item?.type ?? "")) {
            finish({ compacted: true, preTokens: null, postTokens: null });
          }
        }
      }
    });
    void (async () => {
      const init = await request("initialize", {
        clientInfo: { name: "viberr", version: "0.19.0" },
      });
      if (init.error) return finish({ compacted: false, reason: `initialize refused: ${init.error.message}` });
      notify("initialized");
      const resumeParams: RpcParams = { threadId: input.threadId, cwd: input.cwd };
      if (input.model) resumeParams.model = input.model;
      if (input.config) resumeParams.config = input.config;
      const resume = await request("thread/resume", resumeParams);
      if (resume.error) return finish({ compacted: false, reason: `thread/resume refused: ${resume.error.message}` });
      const started = await request("thread/compact/start", { threadId: input.threadId });
      if (started.error) return finish({ compacted: false, reason: `thread/compact/start refused: ${started.error.message}` });
      // The notification says when the CLI has written the compaction.
    })().catch((error) =>
      finish({ compacted: false, reason: errorMessage(error) }),
    );
  });
}
