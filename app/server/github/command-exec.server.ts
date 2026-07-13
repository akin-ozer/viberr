import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type CommandFailureReason = "unavailable" | "failed" | "terminated";

export type CommandExecResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      reason?: CommandFailureReason;
      stdout?: string;
      stderr?: string;
      code?: number | null;
    };

export interface CommandExecOptions {
  cwd?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type CommandExec = (
  file: string,
  args: string[],
  options: CommandExecOptions,
) => Promise<CommandExecResult>;

const execFileAsync = promisify(execFile);

/** Shared injectable process adapter for GitHub workspace/delivery flows. */
export const defaultCommandExec: CommandExec = async (file, args, options) => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      env: options.env,
      signal: options.signal,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (error) {
    const value =
      error && typeof error === "object"
        ? (error as {
            code?: unknown;
            signal?: unknown;
            killed?: unknown;
            stdout?: unknown;
            stderr?: unknown;
          })
        : {};
    return {
      ok: false,
      reason:
        value.code === "ENOENT"
          ? "unavailable"
          : value.killed || typeof value.signal === "string"
            ? "terminated"
            : "failed",
      stdout: typeof value.stdout === "string" ? value.stdout : "",
      stderr:
        typeof value.stderr === "string"
          ? value.stderr
          : error instanceof Error
            ? error.message
            : String(error),
      code: typeof value.code === "number" ? value.code : null,
    };
  }
};
