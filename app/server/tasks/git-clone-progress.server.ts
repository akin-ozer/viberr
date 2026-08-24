import { spawn } from "node:child_process";

/**
 * Stream a `git clone` so its transfer percentage can drive a live step label
 * (F27-U1), WITHOUT weakening the completion/failure contract the mirror path
 * relied on when it used `execFile`.
 *
 * Background. The first agent run in a project pays a full network clone of the
 * repository — minutes on a large one (akin-ozer/viberr is ~113 MB). The run
 * strip already says, honestly, "first task in this project, this can take a few
 * minutes" with an elapsed timer, but showed no PROGRESS, so the first-run
 * experience read as a hang. git writes transfer progress to stderr when handed
 * `--progress`; `execFile` buffers stderr and hands it over only at the end, so
 * a percentage needs a streamed child. This module is that streamed child, kept
 * deliberately small and side-effect-free apart from the one subprocess.
 *
 * The contract `runGitCloneWithProgress` preserves, field for field with the
 * `execFileAsync` call it replaces (so `gitErrorText` / `redactGitOutput` and
 * the callers' failure classification are unchanged):
 *   - resolves on exit code 0;
 *   - on any non-zero exit REJECTS with an `Error` carrying `.stderr` (git's own
 *     words, the field `gitErrorText` reads first) and `.code`;
 *   - honours `timeout` by killing the child and rejecting with `.killed = true`,
 *     the same shape `execFile`'s timeout produces;
 *   - a spawn `error` (git missing / not executable) rejects with that error,
 *     whose `.message` quotes argv — credential-free by construction.
 */

export type CloneProgress = (fraction: number) => void;

export interface GitCloneProgressOptions {
  /** Wall-clock ceiling; on expiry the child is killed and the promise rejects. */
  timeout: number;
  /** The exact environment the clone runs with — the askpass leg lives here, so
   *  it must be passed through verbatim (never merged with a host `process.env`
   *  that the mirror env deliberately stripped). */
  env: NodeJS.ProcessEnv;
}

/** git rewrites the "Receiving objects" / "Resolving deltas" counters in place
 *  with a bare `\r`, so a single physical line carries many updates. */
const RECEIVING_RE = /Receiving objects:\s+(\d+)%/;
const RESOLVING_RE = /Resolving deltas:\s+(\d+)%/;

/**
 * Map one git-clone stderr segment to an overall 0..1 progress fraction, or null
 * when the segment is not a phase this indicator tracks.
 *
 * The two phases a user waits on are the network download ("Receiving objects")
 * and the local delta resolution ("Resolving deltas"). Receiving is the long
 * pole, so it maps to the first 90%; resolving maps to the last 10%. The result
 * is monotonic and never sticks at 100% while deltas resolve. The remote-side
 * "Counting/Compressing objects" phases are deliberately NOT tracked: they are
 * the server preparing the pack, and folding them in would make the bar jump
 * backward the moment Receiving restarts the count from 0%.
 */
export function parseCloneProgressFraction(segment: string): number | null {
  const receiving = RECEIVING_RE.exec(segment);
  if (receiving) {
    const n = Math.max(0, Math.min(100, Number(receiving[1])));
    return (n / 100) * 0.9;
  }
  const resolving = RESOLVING_RE.exec(segment);
  if (resolving) {
    const m = Math.max(0, Math.min(100, Number(resolving[1])));
    return 0.9 + (m / 100) * 0.1;
  }
  return null;
}

/** Cap the retained stderr: the redactor keeps only the last 8 lines / 600
 *  chars, so a pathological progress stream never needs to be held whole. */
const STDERR_TAIL_CAP = 16_384;
/** How long to wait for a SIGTERM'd git to exit before escalating to SIGKILL. */
const KILL_ESCALATION_MS = 2_000;

export function runGitCloneWithProgress(
  args: string[],
  opts: GitCloneProgressOptions,
  onProgress?: CloneProgress,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env: opts.env });
    let stderr = "";
    let carry = "";
    let lastPct = -1;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
      hard.unref?.();
    }, opts.timeout);
    timer.unref?.();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    child.on("error", (err) => settle(() => reject(err)));

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CAP);
      // git rewrites progress with '\r'; split on every terminator. The trailing
      // (unterminated) segment is the LIVE counter — parse it too, then keep it
      // as the next chunk's prefix so a percentage split across chunks resolves.
      const segments = (carry + chunk).split(/\r\n|\r|\n/);
      carry = segments.pop() ?? "";
      for (const seg of [...segments, carry]) {
        const fraction = parseCloneProgressFraction(seg);
        if (fraction === null) continue;
        const pct = Math.round(fraction * 100);
        if (pct === lastPct) continue;
        lastPct = pct;
        // A strip write must never take the clone down with it.
        try {
          onProgress?.(fraction);
        } catch {
          /* ignore */
        }
      }
    });

    child.on("close", (code) => {
      settle(() => {
        if (code === 0 && !timedOut) {
          resolve();
          return;
        }
        // SAFETY: `err` is a freshly-constructed Error; the assertion only
        // WIDENS its type to the execFile-shaped rejection (`.stderr`/`.code`/
        // `.killed`) that `gitErrorText` and the callers' classifiers read, and
        // the three fields are assigned on the very next lines.
        const err = new Error(
          timedOut
            ? `git ${args[0] ?? "clone"} timed out after ${opts.timeout}ms`
            : `git ${args.join(" ")} exited with code ${code ?? "null"}`,
        ) as Error & { stderr: string; code: number | null; killed?: boolean };
        err.stderr = stderr;
        err.code = code;
        if (timedOut) err.killed = true;
        reject(err);
      });
    });
  });
}
