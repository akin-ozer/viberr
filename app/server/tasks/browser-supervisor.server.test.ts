import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BROWSER_CALL_DEADLINE_MS as DEADLINE } from "./browser-deadline.server";
import { superviseBrowserServer } from "./browser-supervisor.server";

/**
 * Ruling 554, through the real supervisor over a real child process: a stand-in
 * for Playwright MCP. It answers `initialize` after 200 ms (a handshake takes
 * time) and every call at once, saying whether the handshake's second half
 * (`notifications/initialized`) had come, except `hang`, which it never
 * answers (a page that stopped answering), `exit`, which ends with code 3 and
 * whose answer reaches the pipe after it has gone, `big`, which answers with two million
 * characters and ends with code 5, and any request that is not a tool call,
 * which it never answers either. It says when the handshake completes and when
 * a call hangs, and on SIGTERM it answers its hanging calls on the way out, as
 * a server closing its browser can.
 */
const FAKE_SERVER = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const say = (data) => out({ method: "notifications/message", params: { data } });
let initialized = false;
const hanging = [];
process.on("SIGTERM", () => {
  for (const id of hanging) out({ id, result: { content: [{ type: "text", text: "late" }] } });
  process.exit(0);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    const result = { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "fake", version: String(process.pid) } };
    setTimeout(() => out({ id: m.id, result }), 200);
  } else if (m.method === "notifications/initialized") {
    initialized = true;
    say("initialized " + process.pid);
  } else if (m.method === "tools/call" && m.params.name === "hang") {
    hanging.push(m.id);
    say("hanging " + m.id + " " + process.pid);
  } else if (m.method === "tools/call" && m.params.name === "exit") {
    // Its last words reach the pipe after it has exited, from a helper that
    // holds its stdout open, as a server's unflushed output can.
    const last = JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "bye" }] } });
    const helper = "setTimeout(() => process.stdout.write(" + JSON.stringify(last + "\\n") + "), 300)";
    spawn(process.execPath, ["-e", helper], { stdio: ["ignore", "inherit", "inherit"] });
    process.exit(3);
  } else if (m.method === "tools/call" && m.params.name === "big") {
    const text = "x".repeat(2_000_000);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } }) + "\\n", () => process.exit(5));
  } else if (m.method === "tools/call") {
    const text = m.params.name + " answered by " + process.pid + (initialized ? "" : " before initialized");
    out({ id: m.id, result: { content: [{ type: "text", text }] } });
  }
});
`;

const lineSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.object({ data: z.string().optional() }).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  result: z
    .object({
      content: z.array(z.object({ text: z.string() })).optional(),
      isError: z.boolean().optional(),
      serverInfo: z.object({ version: z.string() }).optional(),
    })
    .optional(),
});
type Line = z.infer<typeof lineSchema>;

/** What the test sends: a handshake, a call or a cancellation. */
interface Outgoing {
  id?: number;
  method: string;
  params?: {
    protocolVersion?: string;
    capabilities?: Record<string, never>;
    clientInfo?: { name: string; version: string };
    name?: string;
    arguments?: Record<string, never>;
    requestId?: number;
    reason?: string;
  };
}

let dir: string;
let fakeServer: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "viberr-bsup-"));
  fakeServer = path.join(dir, "fake-mcp.mjs");
  writeFileSync(fakeServer, FAKE_SERVER);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Only the supervisor's clocks are faked; the child's pipes run for real.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }));
afterEach(() => vi.useRealTimers());

function session() {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = superviseBrowserServer({ command: process.execPath, args: [fakeServer] }, { input, output }, DEADLINE);
  const lines: Line[] = [];
  createInterface({ input: output }).on("line", (line) => lines.push(lineSchema.parse(JSON.parse(line))));
  const send = (message: Outgoing) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const answers = (id: number) => lines.filter((line) => line.id === id && line.method === undefined);
  const answered = () => lines.flatMap((line) => (line.method === undefined && line.id !== undefined ? [line.id] : []));
  /** The one answer to request `id`, once it has come. */
  const answer = (id: number) =>
    vi.waitFor(
      () => {
        const [first] = answers(id);
        if (!first) throw new Error(`no answer to ${id} yet`);
        return first;
      },
      { timeout: 10_000 },
    );
  const said = (data: string) =>
    vi.waitFor(
      () => {
        if (!lines.some((line) => line.params?.data === data)) throw new Error(`not said yet: ${data}`);
      },
      { timeout: 10_000 },
    );
  const text = (line: Line) => line.result?.content?.map((c) => c.text).join("") ?? "";
  /** The handshake the client does once; returns the server's pid. */
  const open = async () => {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } } });
    const pid = (await answer(1)).result?.serverInfo?.version ?? "";
    send({ method: "notifications/initialized" });
    await said(`initialized ${pid}`);
    return pid;
  };
  const call = (id: number, name: string) => send({ id, method: "tools/call", params: { name, arguments: {} } });
  const close = () => {
    input.end();
    return done;
  };
  return { open, call, send, answer, answers, answered, said, text, close, done };
}

const alive = (pid: string) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

describe("ruling 554: the browser runs under a supervisor", () => {
  it("passes a call answered in time through to the client, on the one server", async () => {
    const s = session();
    const pid = await s.open();
    s.call(2, "look");
    expect(s.text(await s.answer(2))).toBe(`look answered by ${pid}`);
    // CANARY: drop `settle` for an answer and the call stays in flight on its
    // deadline, so the browser is restarted under an agent whose page was fine.
    vi.advanceTimersByTime(DEADLINE * 2);
    s.call(3, "look");
    expect(s.text(await s.answer(3))).toBe(`look answered by ${pid}`);
    expect(await s.close()).toBe(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000 });
  });

  it("answers every request waiting on a stuck browser, ends it and serves the next call from a fresh one", async () => {
    const s = session();
    const stuck = await s.open();
    s.call(2, "hang");
    // Not a tool call, so not timed, but it waits on the same server.
    s.send({ id: 5, method: "resources/list" });
    await s.said(`hanging 2 ${stuck}`);
    vi.advanceTimersByTime(DEADLINE);
    const expired = await s.answer(2);
    expect(expired.result?.isError).toBe(true);
    expect(s.text(expired)).toMatch(/^The browser did not answer hang within 90 seconds, so Viberr restarted it\./);
    expect(s.text(expired)).toContain("browser_navigate");
    // CANARY: answer only the timed calls and the client waits on request 5
    // for a server that is gone.
    expect((await s.answer(5)).error?.message).toMatch(/^The browser did not answer hang/);
    // Sent while the fresh server is still handshaking: held, then delivered.
    // CANARY: forward it at once and the fresh server answers it "before
    // initialized".
    s.call(3, "look");
    const next = await s.answer(3);
    const fresh = s.text(next).replace("look answered by ", "");
    expect(fresh).not.toBe(stuck);
    expect(fresh).toMatch(/^\d+$/);
    // CANARY: replay only `initialize` and the fresh server never hears the
    // client's `notifications/initialized`.
    await s.said(`initialized ${fresh}`);
    await vi.waitFor(() => expect(alive(stuck)).toBe(false), { timeout: 10_000 });
    expect(await s.close()).toBe(0);
    // Each request the client made is answered once, and nothing else is.
    // CANARY: pass on what an ended server still writes and call 2 is answered
    // twice (its "late"); pass on the replayed handshake's answer and the
    // client gets an answer to a request it never made.
    expect(s.answered().sort()).toEqual([1, 2, 3, 5]);
  });

  it("restarts a browser whose cancelled call it never answered, once another call waits behind it", async () => {
    const s = session();
    const stuck = await s.open();
    s.call(2, "hang");
    await s.said(`hanging 2 ${stuck}`);
    vi.advanceTimersByTime(DEADLINE / 2);
    // The client gave up on 2 and tried again; the page answers neither.
    s.send({ method: "notifications/cancelled", params: { requestId: 2, reason: "the model stopped waiting" } });
    s.call(3, "hang");
    await s.said(`hanging 3 ${stuck}`);
    // CANARY: drop a cancelled call's deadline and nothing restarts at 2's
    // deadline, so a client that cancels each call before it is due never
    // gets its browser back.
    vi.advanceTimersByTime(DEADLINE / 2);
    expect((await s.answer(3)).result?.isError).toBe(true);
    // The client wanted no answer to 2, and gets none.
    expect(s.answers(2)).toHaveLength(0);
    s.call(4, "look");
    expect(s.text(await s.answer(4))).not.toBe(`look answered by ${stuck}`);
    expect(await s.close()).toBe(0);
  });

  it("does not restart for a call sent a moment before a cancelled call's deadline", async () => {
    // The call behind has had no chance to be answered, so it proves nothing
    // about the browser yet. CANARY: count any waiter, however new, and call
    // 3 is answered with a restart one second after it was sent, and call 4
    // with a fresh browser.
    const s = session();
    const pid = await s.open();
    s.call(2, "hang");
    await s.said(`hanging 2 ${pid}`);
    s.send({ method: "notifications/cancelled", params: { requestId: 2 } });
    vi.advanceTimersByTime(DEADLINE - 1_000);
    s.call(3, "hang");
    await s.said(`hanging 3 ${pid}`);
    vi.advanceTimersByTime(1_000);
    s.call(4, "look");
    expect(s.text(await s.answer(4))).toBe(`look answered by ${pid}`);
    // Checked again once 3 has waited long enough to count: the browser has
    // answered since, so 2 is forgotten.
    vi.advanceTimersByTime(30_000);
    s.call(5, "look");
    expect(s.text(await s.answer(5))).toBe(`look answered by ${pid}`);
    expect(s.answers(3)).toHaveLength(0);
    expect(await s.close()).toBe(0);
  });

  it("forgets a cancelled call when the browser answered since, or when nothing waits behind it", async () => {
    const s = session();
    const pid = await s.open();
    // Nothing waits behind it.
    s.call(2, "hang");
    await s.said(`hanging 2 ${pid}`);
    s.send({ method: "notifications/cancelled", params: { requestId: 2 } });
    vi.advanceTimersByTime(DEADLINE * 2);
    s.call(3, "look");
    expect(s.text(await s.answer(3))).toBe(`look answered by ${pid}`);
    // The browser answered another call after it: its page is fine.
    s.call(4, "hang");
    await s.said(`hanging 4 ${pid}`);
    vi.advanceTimersByTime(DEADLINE / 2);
    s.send({ method: "notifications/cancelled", params: { requestId: 4 } });
    s.call(5, "look");
    expect(s.text(await s.answer(5))).toBe(`look answered by ${pid}`);
    s.call(6, "hang");
    await s.said(`hanging 6 ${pid}`);
    // CANARY: restart on a cancelled call without asking whether the browser
    // answered since, and this restarts under a page that just answered 5.
    vi.advanceTimersByTime(DEADLINE / 2);
    s.call(7, "look");
    expect(s.text(await s.answer(7))).toBe(`look answered by ${pid}`);
    expect(s.answers(2)).toHaveLength(0);
    expect(s.answers(4)).toHaveLength(0);
    expect(await s.close()).toBe(0);
  });

  it("ends as the server did when it ends on its own, after passing on its last words", async () => {
    const s = session();
    await s.open();
    s.call(2, "exit");
    // CANARY: restart a server that ended by itself and the client never sees
    // it go.
    expect(await s.done).toBe(3);
    // CANARY: end on the server's `exit` instead of its `close` and the answer
    // that reached the pipe after it had gone is dropped.
    expect(s.text(await s.answer(2))).toBe("bye");
  });

  it("passes on the server's last answer whole to a client that reads slowly, then ends as the server did", async () => {
    // Its own process, as the mount runs it. The client reads nothing for a
    // second while the server answers with two million characters and ends.
    // CANARY: exit as soon as the server has ended and the client reads a line
    // cut off where the pipe was full.
    vi.useRealTimers();
    const supervisor = path.join(path.dirname(fileURLToPath(import.meta.url)), "browser-supervisor.server.ts");
    const child = spawn(process.execPath, [supervisor, "--deadline-ms", String(DEADLINE), fakeServer], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    child.stdout.pause();
    const send = (message: Outgoing) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "1" } } });
    send({ id: 2, method: "tools/call", params: { name: "big", arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdout.resume();
    expect(await closed).toBe(5);
    const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter((line) => line.length > 0);
    const answer = lines.map((line) => lineSchema.parse(JSON.parse(line))).find((line) => line.id === 2);
    expect(answer?.result?.content?.[0]?.text).toHaveLength(2_000_000);
  });
});
