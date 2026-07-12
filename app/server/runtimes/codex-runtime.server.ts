import { logger } from "~/server/logging/logger.server";
import type {
  Codex as CodexSdk,
  CodexOptions,
  ModelReasoningEffort,
  SandboxMode,
  Thread,
  ThreadErrorEvent,
  ThreadOptions,
} from "@openai/codex-sdk";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "./adapter.server";
import { projectEnvelope } from "./wire-format.server";

/**
 * Codex adapter — the OFFICIAL Codex SDK (`@openai/codex-sdk`, verified
 * v0.144.1). `new Codex()`, `codex.startThread({ workingDirectory,
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
 * Success is gated on seeing `turn.completed` with no TOP-LEVEL
 * `turn.failed`/`error` (an item whose type is `error` is explicitly non-fatal
 * in the SDK contract). The SDK spawns the codex binary internally; startup or
 * runtime failures are surfaced as sanitized failed runs.
 *
 * Auth: an existing Codex subscription login (auth.json / CODEX_ACCESS_TOKEN)
 * or API-key auth. The SDK factory is injectable so tests drive fakes — real
 * Codex is NEVER invoked.
 */

/** Narrow injectable seam, derived from the installed SDK's public types. */
export type CodexThread = Pick<Thread, "id" | "runStreamed">;
export type CodexClient = {
  startThread(...args: Parameters<CodexSdk["startThread"]>): CodexThread;
  resumeThread(...args: Parameters<CodexSdk["resumeThread"]>): CodexThread;
};
export type CodexFactory = (options?: CodexOptions) => CodexClient;

interface CodexAdapterDeps {
  /** Injected Codex factory (default: the real SDK, imported lazily). */
  codexFactory?: CodexFactory;
  apiKey?: string;
  env?: Record<string, string>;
  /** Extra supported CLI config overrides, primarily for test/deployment seams. */
  config?: CodexOptions["config"];
}

type CodexConfig = NonNullable<CodexOptions["config"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Translate only the portable external-server subset shared by both SDKs.
 * Claude's in-process `{ type: "sdk" }` server has no Codex equivalent and is
 * intentionally skipped rather than serialized into invalid CLI config. */
function codexMcpServers(servers?: Record<string, unknown>): CodexConfig {
  const translated: CodexConfig = {};
  for (const [name, value] of Object.entries(servers ?? {})) {
    if (!name || !isRecord(value) || value.type === "sdk") continue;

    if (value.type === "http" && typeof value.url === "string") {
      // The Codex CLI supports a bearer-token env setting, not Viberr's
      // explicit arbitrary header-name -> secret mapping. Routing rejects
      // these configs before start; keep the adapter fail-closed as well.
      if (isRecord(value.headers) && Object.keys(value.headers).length > 0) {
        throw new Error(
          `MCP server ${name} uses HTTP header authentication unsupported by Codex.`,
        );
      }
      translated[name] = {
        url: value.url,
        default_tools_approval_mode: "approve",
      };
      continue;
    }

    if (typeof value.command === "string") {
      const args = Array.isArray(value.args)
        ? value.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      // Reject partially malformed arg lists instead of silently changing the
      // command the profile declared.
      if (Array.isArray(value.args) && args.length !== value.args.length) {
        continue;
      }
      const env = isRecord(value.env)
        ? Object.fromEntries(
            Object.entries(value.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
      if (isRecord(value.env) && Object.keys(env).length !== Object.keys(value.env).length) {
        continue;
      }
      translated[name] = {
        command: value.command,
        default_tools_approval_mode: "approve",
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };
    }
  }
  return translated;
}

/** Do not cast arbitrary profile strings into the SDK's closed effort union. */
export function resolveCodexReasoningEffort(
  effort?: string,
): ModelReasoningEffort | undefined {
  switch (effort) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return effort;
    default:
      return undefined;
  }
}

/**
 * Config inherited by the Codex CLI is distinct from the environment exposed
 * to shell commands the model runs. Keep the former intact for subscription
 * auth, while using the CLI's supported shell policy to expose only platform
 * essentials to generated commands. The git ceiling is the sole per-run value
 * that currently needs to cross that boundary.
 */
function codexConfigForRun(
  spec: RunSpec,
  base?: CodexOptions["config"],
): CodexConfig {
  const gitCeiling = spec.env?.GIT_CEILING_DIRECTORIES;
  const baseFeatures = isRecord(base?.features) ? base.features : {};
  return {
    ...(base ?? {}),
    ...(spec.systemPrompt ? { developer_instructions: spec.systemPrompt } : {}),
    // Enforce these after base config so a host/deployment override cannot
    // re-expose CODEX_ACCESS_TOKEN or other server credentials to tools.
    allow_login_shell: false,
    features: {
      ...baseFeatures,
      // Viberr exposes only a profile's declared external MCPs; ambient
      // ChatGPT apps/connectors must not appear as extra tools.
      apps: false,
    },
    // Match Claude's per-run isolation: no cross-run memory generation,
    // injection, or memory-specific tools from the managed Codex home.
    memories: {
      generate_memories: false,
      use_memories: false,
      dedicated_tools: false,
    },
    // The SDK accepts arbitrary supported CLI config overrides. Translate the
    // portable HTTP/stdio declarations and replace any base declaration so a
    // run sees only the MCPs its profile selected.
    mcp_servers: codexMcpServers(spec.mcpServers),
    shell_environment_policy: {
      inherit: "core",
      ignore_default_excludes: false,
      ...(gitCeiling ? { set: { GIT_CEILING_DIRECTORIES: gitCeiling } } : {}),
    },
  };
}

/** The idle (inactivity) timeout for a codex run in ms — the window a single
 *  turn/tool may produce no event before the run is treated as hung. Overridable
 *  via VIBERR_CODEX_IDLE_TIMEOUT_MS; defaults to 15 minutes (owner ruling A8). */
export function codexIdleTimeoutMs(): number {
  const raw = process.env.VIBERR_CODEX_IDLE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

/** CLI failures can include stderr and command lines. Those may contain
 * credentials, so logs retain the error class but never the raw message. */
function safeCodexError(error: unknown): Error {
  const safe = new Error("Codex SDK/CLI execution failed.");
  safe.name = error instanceof Error ? error.name : "Error";
  return safe;
}

/** Classify provider failures in memory before redacting their raw text. This
 * preserves useful recovery routing without ever persisting stderr, command
 * lines, or credential-bearing messages. */
function safeCodexFailureMessage(
  error: unknown,
  phase: "start" | "execution",
): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const raw = parts.join("\n");
  if (/usage limit|quota|rate limit|too many requests|\b429\b/i.test(raw)) {
    return "Codex usage limit was reached. Retry after the subscription limit resets.";
  }
  if (
    /unauthor|forbidden|invalid.*(?:key|token|credential)|\b401\b|\b403\b|not logged in|authenticate|authentication/i.test(
      raw,
    )
  ) {
    return "Codex authentication failed. Review the configured subscription credential.";
  }
  return phase === "start"
    ? "Codex could not start. Review its authentication and runtime configuration."
    : "Codex execution failed. Review its authentication and runtime configuration.";
}

/** Map provider events to stable live phases. Tool inputs/commands are omitted:
 * the run log owns that detail, while the compact run strip only needs to say
 * which kind of work is currently happening. */
function phaseForCodexEvent(event: unknown): [string, string] | null {
  if (!event || typeof event !== "object") return null;
  const envelope = event as {
    type?: unknown;
    item?: { type?: unknown; tool?: unknown; server?: unknown };
  };
  switch (envelope.type) {
    case "thread.started":
      return ["Initializing", "Codex thread ready"];
    case "turn.started":
      return ["Working", "Codex turn started"];
    case "turn.completed":
      return ["Finalizing", "Codex turn completed"];
    case "turn.failed":
    case "error":
      return ["Finalizing", "Codex reported a failed turn"];
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const itemType = envelope.item?.type;
      if (itemType === "command_execution") {
        return ["Using tools", "Executing a command"];
      }
      if (itemType === "mcp_tool_call") {
        const server =
          typeof envelope.item?.server === "string" ? envelope.item.server : "MCP";
        const tool =
          typeof envelope.item?.tool === "string" ? ` · ${envelope.item.tool}` : "";
        return ["Using tools", `${server}${tool}`];
      }
      if (itemType === "web_search") {
        return ["Using tools", "Searching the web"];
      }
      if (itemType === "file_change") {
        return ["Using tools", "Updating workspace files"];
      }
      if (itemType === "reasoning") {
        return ["Working", "Codex is reasoning"];
      }
      if (itemType === "agent_message") {
        return ["Working", "Codex is preparing a response"];
      }
      return null;
    }
    default:
      return null;
  }
}

let cachedFactory: CodexFactory | null = null;
async function realFactory(): Promise<CodexFactory> {
  if (cachedFactory) return cachedFactory;
  const mod = await import("@openai/codex-sdk");
  cachedFactory = (options) => new mod.Codex(options);
  return cachedFactory;
}

export function createCodexAdapter(
  deps: CodexAdapterDeps = {},
): RuntimeAdapter {
  return {
    backend: "codex",
    start(spec: RunSpec, cb: RunCallbacks): RunHandle {
      let sessionId: string | null = spec.resumeSessionId ?? null;
      let sawTurnCompleted = false;
      let sawFatalError = false;
      let interrupted = false;
      let settled = false;
      let idleTimedOut = false;
      let emittedAdapterFailure = false;
      const abort = new AbortController();

      cb.onPhase?.("Initializing", "Starting Codex runtime");

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
          logger.warn(
            "codex run idle-timeout — no activity within the window",
            {
              runId: spec.runId,
              idleMs,
            },
          );
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
        cb.onExit({
          outcome,
          effectiveBackend: "codex",
          simulated: false,
          sessionId,
        });
      };

      /** Persist a canonical, deliberately detail-free fatal event. Raw
       * SDK/CLI stderr is neither logged nor added to the task transcript,
       * because it may contain command arguments or credentials. */
      const emitAdapterFailure = (message: string) => {
        if (emittedAdapterFailure) return;
        emittedAdapterFailure = true;
        sawFatalError = true;
        const event = { type: "error", message } satisfies ThreadErrorEvent;
        const occurredAt = new Date().toISOString();
        const { display, facts } = projectEnvelope("codex", event, occurredAt);
        cb.onLine({
          raw: JSON.stringify(event),
          display,
          facts,
          occurredAt,
        });
      };

      const run = async () => {
        const factory = deps.codexFactory ?? (await realFactory());
        // The Codex SDK REPLACES the child env wholesale, so any per-run env
        // (e.g. the specialist's GIT_CEILING_DIRECTORIES) must be overlaid on a
        // COMPLETE env — not `{}`. `deps.env` is the full spawn env, but it is
        // only set when CODEX_HOME is configured; with API-key auth it's
        // undefined, so we fall back to a snapshot of process.env. Overlaying
        // spec.env on `{}` would strip PATH/HOME and break the spawned `codex`
        // binary (adversarial-review HIGH #3).
        const baseEnv =
          deps.env ??
          (spec.env
            ? (Object.fromEntries(
                Object.entries(process.env).filter(
                  ([, v]) => typeof v === "string",
                ),
              ) as Record<string, string>)
            : undefined);
        const mergedEnv =
          baseEnv || spec.env
            ? { ...(baseEnv ?? {}), ...(spec.env ?? {}) }
            : undefined;
        const config = codexConfigForRun(spec, deps.config);
        const codexOptions: CodexOptions = {
          ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
          ...(mergedEnv ? { env: mergedEnv } : {}),
          config,
        };
        const codex = factory(codexOptions);
        // Fully autonomous: no approval gating. `danger-full-access` mirrors
        // Claude's bypassPermissions so a server-spawned run never blocks on
        // an approval it can't answer; a non-autonomous run stays sandboxed.
        // Operators are coordinators rather than coding agents, so enforce the
        // closest direct-SDK equivalent to Claude's denied mutation tools:
        // read-only files, no network, and no web search.
        const sandboxMode: SandboxMode =
          spec.kind === "operator"
            ? "read-only"
            : spec.autonomous
              ? "danger-full-access"
              : "workspace-write";
        const reasoningEffort = resolveCodexReasoningEffort(spec.effort);
        const threadOptions: ThreadOptions = {
          model: spec.model,
          ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
          sandboxMode,
          workingDirectory: spec.workdir,
          skipGitRepoCheck: true,
          // There is no interactive approval channel in a server run. "never"
          // returns denied operations to the model instead of hanging forever.
          approvalPolicy: "never",
          ...(spec.kind === "operator"
            ? {
                networkAccessEnabled: false,
                webSearchMode: "disabled",
              }
            : {}),
        };
        const thread = spec.resumeSessionId
          ? codex.resumeThread(spec.resumeSessionId, threadOptions)
          : codex.startThread(threadOptions);

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
            const { display, facts } = projectEnvelope(
              "codex",
              event,
              occurredAt,
            );
            const phase = phaseForCodexEvent(event);
            if (phase) cb.onPhase?.(...phase);
            if (facts.sessionId) sessionId = facts.sessionId;
            const type = event.type;
            if (type === "turn.completed") {
              sawTurnCompleted = true;
              // Running turn count so the live Turns counter climbs across a
              // multi-turn run (codex reports no cumulative num_turns).
              turnCount += 1;
              facts.turns = turnCount;
            }
            // Item-level errors are explicitly non-fatal in the SDK. Only the
            // two top-level failure events poison the terminal outcome.
            if (type === "turn.failed" || type === "error") {
              sawFatalError = true;
            }
            cb.onLine({
              raw: JSON.stringify(event),
              display,
              facts,
              occurredAt,
            });
          }
          // Thread id lands after the first turn — capture it as the session.
          if (thread.id) sessionId = thread.id;
        } catch (error) {
          disarmIdle();
          // An idle-timeout aborts the same way an interrupt does; distinguish
          // them so a hung run settles `error` (→ react/stuck-packet) while a
          // user interrupt stays `interrupted`.
          if (idleTimedOut) {
            emitAdapterFailure(
              `Codex stopped after ${idleMs} ms without producing an event.`,
            );
            return settle("error");
          }
          if (interrupted) return settle("interrupted");
          logger.error("codex thread error", {
            runId: spec.runId,
            err: safeCodexError(error),
          });
          emitAdapterFailure(safeCodexFailureMessage(error, "execution"));
          return settle("error");
        }

        if (interrupted) return settle("interrupted");
        if (sawTurnCompleted && !sawFatalError) return settle("finished");
        if (!sawFatalError) {
          emitAdapterFailure("Codex ended before reporting turn completion.");
        }
        return settle("error");
      };

      void run().catch((error) => {
        logger.error("codex run crashed", {
          runId: spec.runId,
          err: safeCodexError(error),
        });
        emitAdapterFailure(safeCodexFailureMessage(error, "start"));
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
