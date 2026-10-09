import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

/**
 * Ruling 193: a page that stops answering must not take the agent's browser
 * with it.
 *
 * Playwright MCP builds every answer from the page: an action's answer carries
 * a snapshot of the current tab, and the tab list reads each tab's title. So a
 * page whose script never yields holds every later call, and none of the
 * agent's ways out works: a navigation to another route of the same
 * single-page app stays in the same document, a new tab on the same site
 * shares the page's renderer, and `browser_close` reads the page before it
 * closes anything. Measured on calculator.aws (AWSC-9, 2026-09-28): an S3 form
 * spun its renderer at 90% CPU and 2.4 GB after a checkbox was set, and the
 * Calculator Builder spent its last twelve minutes on calls that timed out or
 * never came back, then reported the estimate it had built as lost.
 *
 * So `viberr_browser` runs under this supervisor, a pass-through on the
 * server's stdio that gives every tool call a deadline. A call still
 * unanswered at the deadline is answered here, saying what happened and what
 * to do, and the browser is restarted: every request still waiting is
 * answered, the server is told to end (it closes the browser it launched; a
 * browser whose server is killed outright ends with its pipe), a fresh server
 * starts, and the client's own `initialize` is replayed to it. The agent's
 * next call gets a new, empty browser. Nothing else changes in either
 * direction.
 *
 * A call the client cancels gets no answer from the server, however well its
 * page is doing, so it cannot prove the page stuck by itself. Its deadline
 * stays as a check on the browser: if the server has answered no tool call
 * since it was sent and another call has itself waited {@link WAITER_PROOF_MS}
 * behind it, the browser is stuck and is restarted; a call sent a moment
 * before the check proves nothing yet, so the check waits for it; with nothing
 * waiting, the cancelled call is forgotten.
 *
 * Run as `node browser-supervisor.server.ts --deadline-ms <ms> <server script>
 * [args...]`; the server is started with the same node. The mount passes the
 * deadline (`BROWSER_CALL_DEADLINE_MS`).
 */

/** How long an ending server gets to close its browser before it is killed. */
const END_GRACE_MS = 3_000;

/** How long a call must itself have waited before it counts against a
 *  cancelled call's browser: the longest `browser_wait_for` the server allows. */
const WAITER_PROOF_MS = 30_000;

const requestIdSchema = z.union([z.string(), z.number()]);
type RequestId = z.infer<typeof requestIdSchema>;

/** The little of a JSON-RPC message the supervisor reads. The rest is kept, so
 *  the client's `initialize` can be replayed whole. */
const messageSchema = z.looseObject({
  id: requestIdSchema.optional(),
  method: z.string().optional(),
  params: z
    .looseObject({ name: z.string().optional(), requestId: requestIdSchema.optional() })
    .optional()
    .catch(undefined),
});
type Message = z.infer<typeof messageSchema>;

function peek(line: string): Message | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = messageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What the agent reads when the browser is restarted under its call. */
function deadlineMessage(tool: string, deadlineMs: number): string {
  return (
    `The browser did not answer ${tool} within ${Math.round(deadlineMs / 1000)} seconds, ` +
    "so Viberr restarted it. A page that stops answering (a script on it that never " +
    "yields) holds every later browser call, a new tab, a navigation and browser_close " +
    "included, so only a restart recovers it. Every tab is gone, and so is whatever a " +
    "page held that was not saved. Open the page again with browser_navigate and carry " +
    "on; on a long form, save or export as you go."
  );
}

export interface SupervisedServer {
  command: string;
  args: readonly string[];
}

interface Io {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** A request the client is waiting on. */
interface InFlight {
  /** The tool a `tools/call` runs; null for any other request, which is not
   *  timed but is still answered when the server it waits on is ended. */
  tool: string | null;
  timer: NodeJS.Timeout | null;
  /** The client cancelled it: the server will not answer it, and the client
   *  wants no answer to it. */
  cancelled: boolean;
  /** How many tool calls the server had answered when this one was sent. */
  answeredBefore: number;
  /** When it was sent (`Date.now()`). */
  sentAt: number;
}

/** Ask `target` to end, and kill it if it has not within the grace. Resolves
 *  once it has exited. */
function stop(target: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (target.exitCode !== null || target.signalCode !== null) {
      done();
      return;
    }
    target.once("exit", () => done());
    target.kill("SIGTERM");
    setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) target.kill("SIGKILL");
    }, END_GRACE_MS).unref();
  });
}

/**
 * Run `server` behind `io` until the client closes its input or the server
 * ends by itself. Resolves with the exit code to end with: 0 when the client
 * closed, the server's own code when it ended on its own (the same ending the
 * client saw before there was a supervisor), 1 when a server could not be
 * started or a restarted one never finished its handshake.
 */
export function superviseBrowserServer(
  server: SupervisedServer,
  io: Io,
  deadlineMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    /** Counts servers started; a line or ending from an earlier one is ignored. */
    let generation = 0;
    let ended = false;
    /** The client's handshake, replayed to every restarted server. */
    let initialize: Message | null = null;
    let initialized: string | null = null;
    /** A replayed `initialize` still waiting for its answer. */
    let replaying: { id: string; timer: NodeJS.Timeout } | null = null;
    /** What the client sent while a restarted server was handshaking. */
    let held: { line: string; message: Message | null }[] = [];
    const inFlight = new Map<RequestId, InFlight>();
    /** Tool calls the current server has answered: a stuck page answers none. */
    let toolAnswers = 0;

    const toClient = (line: string) => io.output.write(`${line}\n`);
    const toServer = (line: string) => child.stdin?.write(`${line}\n`);

    function start(): void {
      generation += 1;
      const mine = generation;
      toolAnswers = 0;
      child = spawn(server.command, [...server.args], { stdio: ["pipe", "pipe", "inherit"] });
      // A server that died mid-write must not take the supervisor with it.
      child.stdin?.on("error", () => {});
      // Nor one that could not be started at all.
      child.on("error", () => {
        if (mine === generation) end(1);
      });
      if (child.stdout) {
        createInterface({ input: child.stdout }).on("line", (line) => {
          if (mine === generation) fromServer(line);
        });
      }
      // `close`, not `exit`: the server's last lines are read before it ends.
      child.on("close", (code, signal) => {
        if (mine === generation) end(code ?? (signal ? 1 : 0));
      });
    }

    function end(code: number): void {
      if (ended) return;
      ended = true;
      for (const call of inFlight.values()) if (call.timer) clearTimeout(call.timer);
      inFlight.clear();
      if (replaying !== null) clearTimeout(replaying.timer);
      generation += 1;
      void stop(child).then(() => resolve(code));
    }

    function fromServer(line: string): void {
      const message = peek(line);
      if (replaying !== null && message?.id === replaying.id && message.method === undefined) {
        // The restarted server's answer to the replayed handshake is the
        // supervisor's own; the client had its answer from the first server.
        clearTimeout(replaying.timer);
        replaying = null;
        if (initialized !== null) toServer(initialized);
        const waiting = held;
        held = [];
        for (const { line: heldLine, message: heldMessage } of waiting) dispatch(heldLine, heldMessage);
        return;
      }
      if (message?.id !== undefined && message.method === undefined) settle(message.id);
      toClient(line);
    }

    function fromClient(line: string): void {
      const message = peek(line);
      if (message?.method === "initialize") initialize = message;
      if (message?.method === "notifications/initialized") initialized = line;
      if (replaying !== null) {
        held.push({ line, message });
        return;
      }
      dispatch(line, message);
    }

    function dispatch(line: string, message: Message | null): void {
      if (message?.id !== undefined && message.method !== undefined) {
        const id = message.id;
        const tool = message.method === "tools/call" ? (message.params?.name ?? "the call") : null;
        inFlight.set(id, {
          tool,
          timer: tool === null ? null : setTimeout(() => expire(id), deadlineMs),
          cancelled: false,
          answeredBefore: toolAnswers,
          sentAt: Date.now(),
        });
      }
      if (message?.method === "notifications/cancelled") {
        const requestId = message.params?.requestId;
        const call = requestId === undefined ? undefined : inFlight.get(requestId);
        if (call) call.cancelled = true;
      }
      toServer(line);
    }

    function settle(id: RequestId): void {
      const call = inFlight.get(id);
      if (!call) return;
      if (call.timer) clearTimeout(call.timer);
      if (call.tool !== null) toolAnswers += 1;
      inFlight.delete(id);
    }

    function expire(id: RequestId): void {
      const call = inFlight.get(id);
      if (!call) return;
      if (call.cancelled) {
        const waiting = [...inFlight.values()].filter((c) => c.tool !== null && !c.cancelled);
        if (toolAnswers !== call.answeredBefore || waiting.length === 0) {
          inFlight.delete(id);
          return;
        }
        // A call sent a moment ago has had no chance to be answered: check
        // again once the oldest one waiting has waited long enough to count.
        const waited = Date.now() - Math.min(...waiting.map((c) => c.sentAt));
        if (waited < WAITER_PROOF_MS) {
          call.timer = setTimeout(() => expire(id), WAITER_PROOF_MS - waited);
          return;
        }
      }
      restart(call.tool ?? "the call");
    }

    /** The browser is stuck: answer every request still waiting on it, then
     *  start a fresh one. */
    function restart(tool: string): void {
      const text = deadlineMessage(tool, deadlineMs);
      for (const [id, call] of inFlight) {
        if (call.timer) clearTimeout(call.timer);
        if (call.cancelled) continue;
        toClient(
          JSON.stringify(
            call.tool === null
              ? { jsonrpc: "2.0", id, error: { code: -32000, message: text } }
              : { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } },
          ),
        );
      }
      inFlight.clear();
      const old = child;
      start();
      void stop(old);
      if (initialize !== null) {
        const id = `viberr-browser-restart-${generation}`;
        // A server that cannot finish its handshake cannot serve the calls
        // held for it: end, and the client sees the server gone.
        replaying = { id, timer: setTimeout(() => end(1), deadlineMs) };
        toServer(JSON.stringify({ ...initialize, id }));
      }
    }

    start();
    createInterface({ input: io.input })
      .on("line", (line) => {
        if (!ended) fromClient(line);
      })
      .on("close", () => end(0));
  });
}

if (import.meta.main) {
  const [flag, value, script, ...args] = process.argv.slice(2);
  const deadlineMs = Number(value);
  if (flag !== "--deadline-ms" || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || !script) {
    process.stderr.write(
      "usage: browser-supervisor.server.ts --deadline-ms <ms> <server script> [args...]\n",
    );
    process.exit(2);
  }
  const code = await superviseBrowserServer(
    { command: process.execPath, args: [script, ...args] },
    { input: process.stdin, output: process.stdout },
    deadlineMs,
  );
  // The server's last answer may still be queued on a pipe the client reads
  // slowly: exit once it is written, never with it cut off mid-line.
  process.stdout.write("", () => process.exit(code));
}
