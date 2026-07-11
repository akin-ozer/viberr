import { logger } from "~/server/logging/logger.server";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "./adapter.server";
import { projectEnvelope } from "./wire-format.server";

/**
 * Codex adapter — the OFFICIAL Codex SDK (`@openai/codex-sdk`, verified
 * v0.142.x). `new Codex()`, `codex.startThread({ workingDirectory,
 * skipGitRepoCheck, sandboxMode, model })` (or `resumeThread(threadId, …)`),
 * then `thread.runStreamed(prompt, { signal })` → `{ events }`, an async
 * generator of the ThreadEvents documented in runtime-adapters.md §2.3
 * (thread.started → thread_id; turn.started/completed with usage incl.
 * cached_input_tokens; item.started/updated/completed variants; turn.failed;
 * error). Each event is persisted as raw_json via `JSON.stringify(event)`
 * and projected through the shared normalizer. Tokens only, no dollar cost.
 *
 * Interrupt: the SDK's `TurnOptions.signal` (AbortSignal) — we pass an
 * AbortController and abort it. Resume: `codex.resumeThread(threadId)`.
 * Success gated on seeing `turn.completed` with no `turn.failed`/`error`
 * (research §2.6). The SDK spawns the codex binary internally, so on a
 * machine where that binary is broken the run errors and the service falls
 * back to simulated — exactly the briefed behavior.
 *
 * Auth: CODEX_API_KEY / OPENAI_API_KEY or an existing `codex login`. The SDK
 * factory is injectable so tests drive fakes — real Codex is NEVER invoked.
 */

export interface CodexThreadEventsResult {
  events: AsyncGenerator<unknown, void>;
}

export interface CodexThread {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal; outputSchema?: unknown },
  ): Promise<CodexThreadEventsResult>;
}

export interface CodexClient {
  startThread(options?: {
    model?: string;
    /** 'minimal'|'low'|'medium'|'high'|'xhigh'. */
    modelReasoningEffort?: string;
    sandboxMode?: string;
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
  }): CodexThread;
  resumeThread(id: string, options?: Record<string, unknown>): CodexThread;
}

export type CodexFactory = (options?: { apiKey?: string; env?: Record<string, string> }) => CodexClient;

interface CodexAdapterDeps {
  /** Injected Codex factory (default: the real SDK, imported lazily). */
  codexFactory?: CodexFactory;
  apiKey?: string;
  env?: Record<string, string>;
}

/** The idle (inactivity) timeout for a codex run in ms — the window a single
 *  turn/tool may produce no event before the run is treated as hung. Overridable
 *  via VIBERR_CODEX_IDLE_TIMEOUT_MS; defaults to 15 minutes (owner ruling A8). */
export function codexIdleTimeoutMs(): number {
  const raw = process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

let cachedFactory: CodexFactory | null = null;
async function realFactory(): Promise<CodexFactory> {
  if (cachedFactory) return cachedFactory;
  const mod = (await import("@openai/codex-sdk")) as unknown as {
    Codex: new (options?: { apiKey?: string; env?: Record<string, string> }) => CodexClient;
  };
  cachedFactory = (options) => new mod.Codex(options);
  return cachedFactory;
}

export function createCodexAdapter(deps: CodexAdapterDeps = {}): RuntimeAdapter {
  return {
    backend: "codex",
    start(spec: RunSpec, cb: RunCallbacks): RunHandle {
      let sessionId: string | null = spec.resumeSessionId ?? null;
      let sawTurnCompleted = false;
      let sawError = false;
      let interrupted = false;
      let settled = false;
      let idleTimedOut = false;
      const abort = new AbortController();

      // IDLE (inactivity) timeout, not a wall-clock cap (owner ruling A8): a
      // codex run may legitimately take much longer than the window overall,
      // but if a SINGLE turn/tool produces NO new event for this long, the run
      // is hung (codex has no maxTurns and only settles on `turn.completed`, so
      // without this it stays `running` forever, waiting=agent, invisible to
      // recovery). We abort the thread and settle `error` so the react loop /
      // stuck-loop packet fires and a human is notified.
      const idleMs = codexIdleTimeoutMs();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (settled || interrupted) return;
          idleTimedOut = true;
          logger.warn("codex run idle-timeout — no activity within the window", {
            runId: spec.runId,
            idleMs,
          });
          try {
            abort.abort();
          } catch {
            // already done
          }
        }, idleMs);
      };
      const disarmIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const settle = (outcome: "finished" | "error" | "interrupted") => {
        if (settled) return;
        settled = true;
        disarmIdle();
        cb.onExit({ outcome, effectiveBackend: "codex", simulated: false, sessionId });
      };

      const run = async () => {
        const factory = deps.codexFactory ?? (await realFactory());
        // The SDK replaces the child env wholesale, so start from the base spawn
        // env and overlay any per-run env (e.g. the specialist's
        // GIT_CEILING_DIRECTORIES workspace confinement).
        const mergedEnv =
          deps.env || spec.env
            ? { ...(deps.env ?? {}), ...(spec.env ?? {}) }
            : undefined;
        const codex = factory(
          deps.apiKey || mergedEnv
            ? {
                ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
                ...(mergedEnv ? { env: mergedEnv } : {}),
              }
            : undefined,
        );
        // Fully autonomous: no approval gating. `danger-full-access` mirrors
        // Claude's bypassPermissions so a server-spawned run never blocks on
        // an approval it can't answer; a non-autonomous run stays sandboxed.
        const sandboxMode = spec.autonomous ? "danger-full-access" : "workspace-write";
        const thread = spec.resumeSessionId
          ? codex.resumeThread(spec.resumeSessionId, {
              workingDirectory: spec.workdir,
              skipGitRepoCheck: true,
              sandboxMode,
            })
          : codex.startThread({
              model: spec.model,
              // Pass the profile's chosen reasoning effort when present.
              ...(spec.effort ? { modelReasoningEffort: spec.effort } : {}),
              sandboxMode,
              workingDirectory: spec.workdir,
              skipGitRepoCheck: true,
            });

        try {
          armIdle();
          const { events } = await thread.runStreamed(spec.prompt, {
            signal: abort.signal,
            // Structured-output operator: constrain the final message to the
            // decision-plan schema so the caller can parse + execute it.
            ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
          });
          let turnCount = 0;
          for await (const event of events) {
            armIdle(); // reset the inactivity window on every event
            const occurredAt = new Date().toISOString();
            const { display, facts } = projectEnvelope("codex", event, occurredAt);
            if (facts.sessionId) sessionId = facts.sessionId;
            const type = (event as { type?: string })?.type;
            if (type === "turn.completed") {
              sawTurnCompleted = true;
              // Running turn count so the live Turns counter climbs across a
              // multi-turn run (codex reports no cumulative num_turns).
              turnCount += 1;
              facts.turns = turnCount;
            }
            if (type === "turn.failed" || type === "error" || facts.isError) sawError = true;
            cb.onLine({ raw: JSON.stringify(event), display, facts, occurredAt });
          }
          // Thread id lands after the first turn — capture it as the session.
          if (thread.id) sessionId = thread.id;
        } catch (error) {
          disarmIdle();
          // An idle-timeout aborts the same way an interrupt does; distinguish
          // them so a hung run settles `error` (→ react/stuck-packet) while a
          // user interrupt stays `interrupted`.
          if (idleTimedOut) return settle("error");
          if (interrupted) return settle("interrupted");
          logger.error("codex thread error", {
            runId: spec.runId,
            err: error instanceof Error ? error : new Error(String(error)),
          });
          return settle("error");
        }

        if (interrupted) return settle("interrupted");
        if (sawTurnCompleted && !sawError) return settle("finished");
        return settle("error");
      };

      void run().catch((error) => {
        logger.error("codex run crashed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
        settle("error");
      });

      return {
        runId: spec.runId,
        interrupt() {
          if (interrupted || settled) return;
          interrupted = true;
          try {
            abort.abort();
          } catch {
            // Already completed.
          }
        },
      };
    },
  };
}
