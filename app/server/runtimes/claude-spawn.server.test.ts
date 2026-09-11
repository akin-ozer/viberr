import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { spawnClaudeCli, type ClaudeCli } from "./claude-spawn.server";

/**
 * Ruling 174: Viberr spawns the Claude CLI itself, detached, through the SDK's
 * `spawnClaudeCodeProcess`. A real `node` stands in for the CLI — the claims
 * are about the process tree and the pipes, which only the kernel can answer.
 */

const clis: ClaudeCli[] = [];
const loosePids: number[] = [];

afterEach(() => {
  for (const cli of clis.splice(0)) cli.signalGroup("SIGKILL");
  for (const pid of loosePids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

function start(script: string, env: NodeJS.ProcessEnv = process.env): ClaudeCli {
  const cli = spawnClaudeCli({
    command: process.execPath,
    args: ["-e", script],
    env,
  });
  clis.push(cli);
  return cli;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

describe.skipIf(process.platform === "win32")("spawnClaudeCli (real process)", () => {
  it("leads its own process group, and the SDK's kill reaches every member", async () => {
    // The CLI stand-in forks a child of its own, the way the real CLI starts a
    // stdio MCP server: same group, and nothing but a GROUP signal reaches it
    // once the leader is gone.
    const cli = start(
      [
        "const { spawn } = require('node:child_process');",
        "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(c.pid) + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join(" "),
    );
    const [chunk] = await once(cli.process.stdout, "data");
    const childPid = Number(String(chunk).trim());
    loosePids.push(childPid);
    expect(cli.pid).toBeGreaterThan(1);
    // A group whose id is the CLI's pid exists: the spawn was detached.
    expect(() => process.kill(-(cli.pid ?? 0), 0)).not.toThrow();

    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      cli.process.once("exit", (_code, signal) => resolve(signal)),
    );
    // What the SDK calls on its close ladder and its kill-all at exit.
    expect(cli.process.kill("SIGTERM")).toBe(true);

    expect(await exited).toBe("SIGTERM");
    expect(await gone(childPid)).toBe(true);
  });

  it("keeps the last 2 KB of stderr and delivers `exit` only once it has drained", async () => {
    // The SDK appends this tail to its exit error when IT spawns the CLI; a
    // custom spawn gets nothing from it, so the adapter reads it from here.
    const cli = start(
      "process.stderr.write('x'.repeat(6000) + 'No conversation found with session ID: s-1', () => process.exit(3))",
    );
    const code = await new Promise<number | null>((resolve) =>
      cli.process.once("exit", (exitCode) => resolve(exitCode)),
    );

    expect(code).toBe(3);
    const tail = cli.stderrTail();
    expect(tail.endsWith("No conversation found with session ID: s-1")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(2048);
    expect(await cli.exited(1000)).toBe(true);
  });

  it("reports a CLI still running as not exited when the wait runs out", async () => {
    const cli = start("setInterval(() => {}, 1000)");
    expect(await cli.exited(50)).toBe(false);
  });

  it("passes the run's environment to the CLI, marker included", async () => {
    const cli = start("process.stdout.write(process.env.VIBERR_RUN_ID ?? 'none')", {
      ...process.env,
      VIBERR_RUN_ID: "run_spawn-env",
    });
    const [chunk] = await once(cli.process.stdout, "data");
    expect(String(chunk)).toBe("run_spawn-env");
  });
});
