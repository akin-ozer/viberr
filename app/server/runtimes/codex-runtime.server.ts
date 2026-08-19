import { getEnv } from "~/server/config/env.server";
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
import { SESSION_MISSING_RE } from "./session-export.server";
import { projectEnvelope } from "./wire-format.server";
import { redactProviderText } from "~/server/secrets/git-output-redact.server";

/**
 * Codex adapter — the OFFICIAL Codex SDK (`@openai/codex-sdk`, verified
 * v0.146.0 — {@link CODEX_SDK_VERIFIED_VERSION}, which a test pins to the
 * DECLARED dependency so this line cannot go stale again; 0.144.1 → 0.146.0 moved
 * exactly one documented thing, an additive `usage.cache_write_input_tokens` on
 * `turn.completed` that the SDK back-fills with 0 and Viberr does not project —
 * the wire normalizer reads `cached_input_tokens`, which is unchanged).
 * `new Codex()`, `codex.startThread({ workingDirectory,
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

/**
 * The `@openai/codex-sdk` release this adapter (and the effort catalog) was
 * verified against.
 *
 * D5/pass-16: the header claimed v0.144.1 while the dependency had moved to
 * 0.146.0, and nothing could tell — a version claim in prose is unfalsifiable.
 * It lives here as a constant so `codex-runtime.server.test.ts` can assert it
 * against package.json: bumping the dependency without re-reading this adapter
 * now fails a test instead of quietly rotting a docstring.
 */
export const CODEX_SDK_VERIFIED_VERSION = "0.146.0";

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
 * intentionally skipped rather than serialized into invalid CLI config.
 *
 * NAMING (P13-LV-15, vendor behavior, disclosed not normalized): the two CLIs
 * derive a different tool prefix from the SAME declared server name — Claude
 * mounts `mcp__everything-http__echo`, the Codex CLI lowercases hyphens to
 * underscores and mounts `mcp__everything_http__echo`. Viberr passes the
 * declared name through unchanged on both, so a persona/skill/directive that
 * names a tool LITERALLY works on one backend and not the other. Nothing here
 * can fix that (the transform is inside the codex binary); the honest fix is a
 * caveat on the MCP admin surface — see the pass-13 report.
 *
 * NOTE also that this config does not REMOVE servers the run home declares —
 * the CLI merges `--config` per dotted leaf key. That is why runs get an
 * app-owned CODEX_HOME (`codex-config.server.ts`) instead of the host's. */
function codexMcpServers(servers?: Record<string, unknown>): CodexConfig {
  const translated: CodexConfig = {};
  for (const [name, value] of Object.entries(servers ?? {})) {
    if (!name || !isRecord(value) || value.type === "sdk") continue;

    // F7-MCP1 credential scope: resolveSpecialistMcpServers injects the decrypted
    // token as `headers.Authorization` (HTTP) / `env.MCP_CREDENTIAL` (stdio).
    // Those are DELIBERATELY NOT carried onto Codex: the codex SDK passes this
    // config to the CLI as `--config key=value` argv, so a literal secret here
    // would be visible in `ps auxww` (the standing codex-argv exposure the owner
    // scoped out). So a credentialed org MCP authenticates on Claude runs only;
    // on Codex it connects unauthenticated. This is an honest, documented
    // limitation (same class as the S3 codex tool-confinement gap), not a silent
    // drop — the specialist-mcp docstring says so.
    if (value.type === "http" && typeof value.url === "string") {
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
      translated[name] = {
        command: value.command,
        default_tools_approval_mode: "approve",
        ...(args.length ? { args } : {}),
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
 * Per-run env that must cross into the model's OWN shell (as opposed to the
 * CLI's process env, which carries subscription auth and must not leak to
 * tools). `shell_environment_policy.inherit: "core"` strips everything else, so
 * anything Viberr promises the agent's shell has to be named here.
 *
 * P13-RT-10: `agentGitIdentityEnv` documents "these override any `git config`
 * the agent sets … so codex and claude are indistinguishable in the git
 * history". That only held on Claude (whose spec.env is merged into the whole
 * child env); on Codex the identity was stripped before any `git commit` the
 * agent ran, leaving the repo-local `git config user.*` written at clone as the
 * only mechanism — a weaker guarantee than the docstring claims, and none at
 * all when `setIdentity` failed.
 */
const SHELL_EXPORTED_ENV_KEYS = [
  "GIT_CEILING_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

function shellExportedEnv(spec: RunSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SHELL_EXPORTED_ENV_KEYS) {
    const value = spec.env?.[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Config inherited by the Codex CLI is distinct from the environment exposed
 * to shell commands the model runs. Keep the former intact for subscription
 * auth, while using the CLI's supported shell policy to expose only platform
 * essentials to generated commands.
 *
 * ISOLATION (P13-LV-13 / LV-14 / RT-04): the CLI merges `--config` overrides
 * into whatever `$CODEX_HOME/config.toml` already declares, so config alone
 * cannot close the host channels — the app-owned run home
 * (`resolveCodexHome`/`prepareCodexHome`) is what does. These keys are the
 * second half of the same fence, because the CLI RE-INSTALLS its five bundled
 * `.system` skills into *any* home on startup (verified with
 * `codex debug prompt-input` on a pristine home: `imagegen`, `openai-docs`,
 * `plugin-creator`, `skill-creator`, `skill-installer` were still advertised),
 * and because the repo's own `AGENTS.md` is read from the WORKSPACE, not the
 * home. On THIS backend Viberr injects every granted skill/KB doc as prompt
 * text, so a run needs none of the CLI's own instruction sources.
 *
 * That injection is now backend-ASYMMETRIC, deliberately. Claude gained a native
 * skills mechanism this pass (`mountGrantedSkills` + the SDK's `skills` filter),
 * so a Claude run receives each granted skill's metadata and loads the body only
 * when it invokes one. The Codex CLI has no equivalent to switch on — its whole
 * skills channel is severed right below, precisely because it cannot be governed
 * per-skill — so Codex keeps the prompt-text injection. Same grants, same craft,
 * two carriers; the alternative would be re-opening this channel to a CLI that
 * re-installs its own bundled skills into any home.
 */
function codexConfigForRun(
  spec: RunSpec,
  base?: CodexOptions["config"],
): CodexConfig {
  const baseFeatures = isRecord(base?.features) ? base.features : {};
  const exported = shellExportedEnv(spec);
  return {
    ...(base ?? {}),
    ...(spec.systemPrompt ? { developer_instructions: spec.systemPrompt } : {}),
    // Enforce these after base config so a host/deployment override cannot
    // re-expose CODEX_ACCESS_TOKEN or other server credentials to tools.
    allow_login_shell: false,
    // RT-04: the checked-out repo's `AGENTS.md` (and any fallback project doc)
    // is otherwise merged into the run's INSTRUCTIONS at a higher trust tier
    // than the repository contents the trust-boundary block calls untrusted —
    // a prompt-injection ingress with no Claude counterpart (`settingSources:
    // []` means a repo's CLAUDE.md never loads). 0 bytes = never read one.
    project_doc_max_bytes: 0,
    // LV-13: drop the CLI's whole skills channel. `include_instructions: false`
    // removes the "## Skills" block (bundled + user-installed alike);
    // `bundled.enabled: false` additionally refuses the `.system` set the CLI
    // self-installs into EVERY home on startup. Both keys were confirmed
    // effective, and near-miss keys (`skills.enabled`, `skills.disabled`,
    // `skills.roots`) confirmed inert, with `codex debug prompt-input` against
    // codex-cli 0.144.6. `bundled` is a STRUCT there — a bare
    // `skills.bundled = false` makes the CLI refuse to load its configuration
    // at all ("invalid type: boolean, expected struct BundledSkillsConfig"),
    // which would fail every run.
    skills: {
      include_instructions: false,
      bundled: { enabled: false },
    },
    features: {
      ...baseFeatures,
      // Viberr exposes only a profile's declared external MCPs; ambient
      // ChatGPT apps/connectors must not appear as extra tools.
      apps: false,
      // LV-13/LV-14 defense in depth: a plugin contributes BOTH skills and MCP
      // servers (the host leak included `github:yeet` and a plugin-supplied
      // `sites-design-picker` server). The run home carries no plugins, but a
      // deployment that points CODEX_HOME at a populated dir must not re-open
      // the channel. Hooks are host-configured shell callbacks — same class.
      plugins: false,
      hooks: false,
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
    // run sees only the MCPs its profile selected. NOTE: the CLI merges this
    // per-leaf-key into `$CODEX_HOME/config.toml`, so it removes nothing the
    // home declares — the app-owned run home is what makes this exhaustive.
    mcp_servers: codexMcpServers(spec.mcpServers),
    shell_environment_policy: {
      inherit: "core",
      ignore_default_excludes: false,
      ...(Object.keys(exported).length ? { set: exported } : {}),
    },
  };
}

/**
 * The sandbox a run gets. `spec.autonomous` deliberately does NOT decide repo
 * write access: it also drives Claude's `permissionMode`, and flipping it to
 * `"default"` would hang a server run on an approval nobody can answer.
 *
 * P13-RT-02: a delivering Codex agent whose `execute-code-or-write-repo` grant
 * is withheld used to run at `danger-full-access` — exactly as unconstrained as
 * a fully-granted one, while the capability matrix showed the withholding as
 * enforced. The read-only sandbox PHYSICALLY blocks writes (strictly stronger
 * than Claude's tool denylist), and Viberr already relies on it for supporting
 * runs, so the headline gate maps straight onto it.
 */
export function resolveCodexSandboxMode(spec: RunSpec): SandboxMode {
  // Operators coordinate and reviewers advise — neither mutates the workspace.
  if (spec.kind === "operator" || spec.kind === "reviewer") return "read-only";
  if (spec.repoWriteWithheld) return "read-only";
  return spec.autonomous ? "danger-full-access" : "workspace-write";
}

/** The idle (inactivity) timeout for a codex run in ms — the window a single
 *  turn/tool may produce no event before the run is treated as hung. Overridable
 *  via VIBERR_CODEX_IDLE_TIMEOUT_MS; defaults to 15 minutes (owner ruling A8). */
export function codexIdleTimeoutMs(): number {
  const raw = getEnv().VIBERR_CODEX_IDLE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
}

/** CLI failures can include stderr and command lines. Those may contain
 * credentials, so the raw text is never logged unscrubbed — but R20-3 settled
 * that a REDACTED provider complaint is loggable (ruling 69), so instead of
 * discarding it we keep the scrubbed sentence. Falls back to the class-only
 * message when the scrub finds nothing usable. */
function safeCodexError(error: unknown): Error {
  const safe = new Error(
    redactProviderText(error) || "Codex SDK/CLI execution failed.",
  );
  safe.name = error instanceof Error ? error.name : "Error";
  return safe;
}

/** The adapter's own failure classes, matched against the raw error while it is
 * still in memory. Persisted (as a tag suffix on the terminal err line) so the
 * escalation path can route quota/auth without ever re-reading the redacted
 * stderr. Mirrors the routing classes `runFailureReason` (agent-reply) returns;
 * "unavailable" is the fail-fast (no credential) class handled upstream, never
 * here — the codex process only reaches this classifier once it has started. */
export type CodexFailureKind =
  | "quota"
  | "auth"
  | "idle_timeout"
  /** P13-D-2: the rollout behind the resumed session id is gone from
   *  `$CODEX_HOME/sessions`. `resumeRun`'s pre-flight probe normally catches
   *  this and re-anchors before spawning; this covers the case where the SDK
   *  finds out first (a transcript swept between the probe and the spawn). */
  | "session_missing"
  | "unknown";

/** Classify a provider failure IN MEMORY before its raw text is redacted, and
 * pair the class with a redaction-safe canonical message. The raw error can
 * echo stderr, command lines, or credentials, so ONLY the class and the
 * canonical sentence ever leave this function — the raw text is never returned,
 * logged, or persisted. The class is what survives to `runFailureReason`; the
 * message is deliberately generic (and does not necessarily re-match the
 * downstream regexes), which is exactly why the class rides the tag instead. */
function classifyCodexFailure(
  error: unknown,
  phase: "start" | "execution",
): { kind: CodexFailureKind; message: string; providerText: string } {
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
  // R20-3 (F20-4): the provider's OWN words, scrubbed. The canonical `message`
  // stays generic (and the class rides the tag), but the redacted sentence is
  // now surfaced beside it so a human can act on "model is not supported when
  // using Codex with a ChatGPT account" instead of "review the configuration".
  const providerText = redactProviderText(error);
  // P13-D-2 before the auth branch: a missing rollout is not a credential
  // problem, and telling a human to "review the configured subscription
  // credential" for it sends them to the one place that is definitely fine.
  if (SESSION_MISSING_RE.test(raw)) {
    return {
      kind: "session_missing",
      message:
        "The Codex session could not be resumed — its rollout no longer exists under $CODEX_HOME/sessions. Nothing is wrong with the credential; the conversation history is gone. Re-run the agent to start a fresh session anchored on task.md.",
      providerText,
    };
  }
  if (/usage limit|quota|rate limit|too many requests|\b429\b/i.test(raw)) {
    return {
      kind: "quota",
      message:
        "Codex usage limit was reached. Retry after the subscription limit resets.",
      providerText,
    };
  }
  if (
    /unauthor|forbidden|invalid.*(?:key|token|credential)|\b401\b|\b403\b|not logged in|authenticate|authentication/i.test(
      raw,
    )
  ) {
    return {
      kind: "auth",
      message:
        "Codex authentication failed. Review the configured subscription credential.",
      providerText,
    };
  }
  return {
    kind: "unknown",
    message:
      phase === "start"
        ? "Codex could not start. Review its authentication and runtime configuration."
        : "Codex execution failed. Review its authentication and runtime configuration.",
    providerText,
  };
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
          sessionId,
        });
      };

      /** Persist a canonical, deliberately detail-free fatal event. Raw
       * SDK/CLI stderr is neither logged nor added to the task transcript,
       * because it may contain command arguments or credentials. The classified
       * `kind` (quota/auth/unknown — safe to persist) rides on the display tag
       * as a `·<kind>` suffix (e.g. `error·quota`) so `runFailureReason` routes
       * the escalation from a structured signal, not by re-regexing the generic
       * message text. The raw envelope stays faithful; only the projected
       * display tag is enriched. */
      const emitAdapterFailure = (
        message: string,
        kind: CodexFailureKind = "unknown",
        providerText = "",
      ) => {
        if (emittedAdapterFailure) return;
        emittedAdapterFailure = true;
        sawFatalError = true;
        // R20-3: append the provider's redacted sentence once, when it adds
        // something the canonical message does not already carry. The `err`
        // line's text is what `runFailureReason` reads and splits on the marker.
        const fullMessage =
          providerText && !message.includes(providerText)
            ? `${message}\n\nThe provider reported: ${providerText}`
            : message;
        const event = {
          type: "error",
          message: fullMessage,
        } satisfies ThreadErrorEvent;
        const occurredAt = new Date().toISOString();
        const { display, facts } = projectEnvelope("codex", event, occurredAt);
        cb.onLine({
          raw: JSON.stringify(event),
          display: display ? { ...display, tag: `${display.tag}·${kind}` } : display,
          facts,
          occurredAt,
        });
      };

      const run = async () => {
        const factory = deps.codexFactory ?? (await realFactory());
        // The Codex SDK REPLACES the child env wholesale, so any per-run env
        // (e.g. the specialist's GIT_CEILING_DIRECTORIES) must be overlaid on a
        // COMPLETE env — not `{}`. `deps.env` is the full spawn env; the
        // production adapter factory (createAdapters, runtime-registry) ALWAYS
        // passes it, so the process.env-snapshot fallback below is a safety net
        // for tests / direct construction that omit `deps.env`. Overlaying
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
        // an approval it can't answer. Operators are coordinators rather than
        // coding agents, so they get the closest direct-SDK equivalent to
        // Claude's denied mutation tools: read-only files, no network, no web
        // search. Supporting/reviewing runs are read-only too (F10-12 /
        // F10-04), as are delivering runs whose repo-write grant is withheld
        // (P13-RT-02). Network stays enabled so declared MCP resources still
        // work (only the operator disables egress).
        const sandboxMode: SandboxMode = resolveCodexSandboxMode(spec);
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
            : // P14-RT-06: a specialist whose `use-web-search-fetch` grant is
              // withheld loses Codex's web search too. Claude removes WebFetch/
              // WebSearch from the run; Codex has no denylist channel, so the
              // grant used to bind on one backend only — while this exact option
              // was already being set two lines up for the operator. Network
              // access stays ON: declared MCP servers and the workspace's own
              // tooling are not the egress this capability governs.
              spec.webSearchWithheld
              ? { webSearchMode: "disabled" as const }
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
            // Classified so the timeline copy can say "hung", not "failed" —
            // and so it reads the same as the Claude idle guard (P13-RT-11).
            emitAdapterFailure(
              `Codex stopped after ${idleMs} ms without producing an event.`,
              "idle_timeout",
            );
            return settle("error");
          }
          if (interrupted) return settle("interrupted");
          logger.error("codex thread error", {
            runId: spec.runId,
            err: safeCodexError(error),
          });
          const failure = classifyCodexFailure(error, "execution");
          emitAdapterFailure(failure.message, failure.kind, failure.providerText);
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
        const failure = classifyCodexFailure(error, "start");
        emitAdapterFailure(failure.message, failure.kind, failure.providerText);
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
