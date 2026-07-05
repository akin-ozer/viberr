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
  runStreamed(input: string, turnOptions?: { signal?: AbortSignal }): Promise<CodexThreadEventsResult>;
}

export interface CodexClient {
  startThread(options?: {
    model?: string;
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
      const abort = new AbortController();

      const settle = (outcome: "finished" | "error" | "interrupted") => {
        if (settled) return;
        settled = true;
        cb.onExit({ outcome, effectiveBackend: "codex", simulated: false, sessionId });
      };

      const run = async () => {
        const factory = deps.codexFactory ?? (await realFactory());
        const codex = factory(
          deps.apiKey || deps.env ? { ...(deps.apiKey ? { apiKey: deps.apiKey } : {}), ...(deps.env ? { env: deps.env } : {}) } : undefined,
        );
        const thread = spec.resumeSessionId
          ? codex.resumeThread(spec.resumeSessionId, {
              workingDirectory: spec.workdir,
              skipGitRepoCheck: true,
              sandboxMode: "workspace-write",
            })
          : codex.startThread({
              model: spec.model,
              sandboxMode: "workspace-write",
              workingDirectory: spec.workdir,
              skipGitRepoCheck: true,
            });

        try {
          const { events } = await thread.runStreamed(spec.prompt, { signal: abort.signal });
          for await (const event of events) {
            const occurredAt = new Date().toISOString();
            const { display, facts } = projectEnvelope("codex", event, occurredAt);
            if (facts.sessionId) sessionId = facts.sessionId;
            const type = (event as { type?: string })?.type;
            if (type === "turn.completed") sawTurnCompleted = true;
            if (type === "turn.failed" || type === "error" || facts.isError) sawError = true;
            cb.onLine({ raw: JSON.stringify(event), display, facts, occurredAt });
          }
          // Thread id lands after the first turn — capture it as the session.
          if (thread.id) sessionId = thread.id;
        } catch (error) {
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
