import {
  ReadBuffer,
  serializeMessage,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  killMcpProcessTree,
  spawnMcpProcess,
  splitMcpCommand,
  type McpChild,
  type McpSpawn,
} from "~/server/org/resources.server";
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";
import { toError } from "~/shared/errors";
import {
  connectWithin,
  newUpstreamClient,
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UpstreamConnectError,
  upstreamFailureReason,
  type UpstreamConnection,
} from "./upstream.server";

/** The longest single JSON-RPC line a stdio server may print (10 MiB). */
const MCP_STDIO_MAX_LINE_BYTES = STDIO_DEFAULT_MAX_BUFFER_SIZE;

/**
 * Ruling 191: a credentialed STDIO org server is started by the SERVER, never
 * by the agent's CLI.
 *
 * The CLI used to spawn it with `MCP_CREDENTIAL` in its environment, which the
 * agent's own shell (the same uid) could read at `/proc/<pid>/environ`. Here the
 * command runs under the server's own uid, spawned by the same function the
 * discovery probe uses (`spawnMcpProcess`: the secret-filtered environment plus
 * `MCP_CREDENTIAL`, a process group of its own) and torn down the same way
 * (`killMcpProcessTree`), so what a probe measures is what a run gets.
 *
 * The SDK ships a stdio client transport, but it spawns through `cross-spawn`
 * with its own environment and signals only the direct child, which orphans an
 * `npx` → node tree. This is the same newline-delimited JSON-RPC framing over
 * the spawn Viberr already owns.
 *
 * Every byte the child prints is handled inside a stream listener of the
 * server process, where a throw is an uncaughtException that exits the whole
 * instance (R-gateway-1, 2026-09-25). So nothing a child prints may throw out
 * of the listener: a line over the stdio limit stops that process, as the
 * SDK's own transport does, and fails its calls with the reason.
 */
class McpChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private child: McpChild | null = null;
  /** The SDK's limit, the one the CLI's own stdio transport applied before
   *  ruling 191 moved the process here: a larger single line stops the child. */
  private readonly buffer = new ReadBuffer({ maxBufferSize: MCP_STDIO_MAX_LINE_BYTES });
  private closed = false;
  /** The tail of what the command printed on stderr, for a failure's reason. */
  private stderr = "";
  /** How the child ended, when it did. */
  private ended: string | null = null;
  /** Why Viberr stopped the child itself: it outranks the signal that did it. */
  private stopped: string | null = null;

  private readonly command: string;
  private readonly args: readonly string[];
  private readonly token: string | null;
  private readonly spawnImpl: McpSpawn;

  constructor(
    command: string,
    args: readonly string[],
    token: string | null,
    spawnImpl: McpSpawn = spawnMcpProcess,
  ) {
    this.command = command;
    this.args = args;
    this.token = token;
    this.spawnImpl = spawnImpl;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("McpChildTransport already started");
    const child = this.spawnImpl(this.command, [...this.args], this.token);
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      if (this.closed) return;
      try {
        this.buffer.append(Buffer.from(chunk));
      } catch (error) {
        // `ReadBuffer` throws once one unfinished line passes its limit.
        this.stopped ??= `stopped: it sent one message over the ${MCP_STDIO_MAX_LINE_BYTES / (1024 * 1024)} MiB stdio limit`;
        this.onerror?.(toError(error));
        void this.close();
        return;
      }
      this.drain();
    });
    child.stderr?.on("data", (chunk) => {
      if (this.stderr.length < 8_000) this.stderr += String(chunk);
    });
    // F20-8: a write to a child that already exited arrives as an async EPIPE
    // on stdin; unhandled, it is a fatal uncaughtException.
    child.stdin?.on?.("error", (error) => this.onerror?.(error));
    child.on("error", (codeOrError) => {
      const error = toError(codeOrError);
      this.ended = `failed to start (${error.message})`;
      this.onerror?.(error);
      this.finish();
    });
    child.on("exit", (code, signal) => {
      const codeNum = code instanceof Error ? null : (code ?? null);
      this.ended = signal
        ? `killed by ${signal}`
        : codeNum !== null && codeNum !== 0
          ? `exited (exit code ${codeNum})`
          : "exited";
      this.finish();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child?.stdin || this.closed) throw new Error("the MCP server process is not running");
    this.child.stdin.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    if (this.child && !this.closed) killMcpProcessTree(this.child);
    this.finish();
  }

  /** Why the process is gone, with its own words (credential scrubbed). */
  describeExit(): string | null {
    if (this.stopped) return this.stopped;
    if (!this.ended) return null;
    const detail = redactGitOutput(this.stderr, { token: this.token });
    return detail ? `${this.ended}: ${detail}` : this.ended;
  }

  private drain(): void {
    while (!this.closed) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (error) {
        // A line that is not JSON-RPC (a server logging to stdout): report it
        // and keep reading, as the SDK's own stdio transport does.
        this.onerror?.(toError(error));
        continue;
      }
      if (message === null) return;
      try {
        this.onmessage?.(message);
      } catch (error) {
        // Still inside the stdout listener: a throw here would end the server.
        this.onerror?.(toError(error));
      }
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}

/**
 * Start a registered stdio command and hold an MCP client on it. The
 * credential goes into the child's environment as `MCP_CREDENTIAL`, the
 * variable a stdio server has always read it from (P13-KM-05).
 */
export async function connectStdioUpstream(
  commandLine: string,
  options: { token?: string | null; spawnImpl?: McpSpawn; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<UpstreamConnection> {
  const [command, ...args] = splitMcpCommand(commandLine);
  if (!command) throw new UpstreamConnectError("the registered stdio command is empty");
  const transport = new McpChildTransport(command, args, options.token ?? null, options.spawnImpl);
  const client = newUpstreamClient();
  try {
    await connectWithin(client, transport, options.timeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS, options.signal);
  } catch (error) {
    // The process's own account of itself beats "Connection closed".
    throw new UpstreamConnectError(transport.describeExit() ?? upstreamFailureReason(error), {
      cause: error,
    });
  }
  return { client, transport: "stdio", closedReason: () => transport.describeExit() };
}
