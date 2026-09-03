import { afterEach, describe, expect, it } from "vitest";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { z } from "zod";
import {
  CREDENTIAL_ENV_RE,
  createAdapters,
  filteredSpawnEnv,
  selectAdapter,
} from "./runtime-registry.server";
import {
  repoWriteWithheldFromDenylist,
  webSearchWithheldFromDenylist,
} from "./run-service.server";
import type { RunSpec } from "./adapter.server";
import type { CodexClient, CodexFactory } from "./codex-runtime.server";
import type {
  ClaudeQuery,
  ClaudeQueryOptions,
} from "./claude-runtime.server";
import { resolveSpecialistDisallowedTools } from "../tasks/specialist-tool-policy";
import { agentGitIdentity } from "../tasks/specialist-run.server";
import { CAP_CATALOG, capabilityEnforcement } from "~/shared/capabilities";
import type { CapabilityGrant } from "~/schemas/project-file.schema";

/**
 * A Claude SDK query as the adapter consumes it: an async generator of SDK
 * messages plus `interrupt`. Yields the given messages, then completes.
 */
function fakeClaudeQuery(...messages: unknown[]): ClaudeQuery {
  const gen = (async function* (): AsyncGenerator<unknown, void> {
    for (const message of messages) yield message;
  })();
  return Object.assign(gen, { interrupt: async () => {} });
}

describe("runtime-registry", () => {
  const RESTORE: Record<string, string | undefined> = {};
  function setEnv(key: string, value: string): void {
    if (!(key in RESTORE)) RESTORE[key] = process.env[key];
    process.env[key] = value;
  }
  afterEach(() => {
    for (const [key, value] of Object.entries(RESTORE)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete RESTORE[key];
    }
  });

  /**
   * Ruling 121: this module no longer knows anything about credentials. The
   * availability probe, its CLI-auth diagnostics and the two credential-adding
   * spawn-env builders are gone — a run's credential is a fact about the ONE
   * person it bills, resolved by `backend-credentials.server` and assembled
   * into `spec.env` by the run service. What stays here is the INPUT-side
   * hygiene both adapters are built on, and it is the thing that makes
   * per-person credentials safe: the base env every child starts from must
   * carry no credential at all, or a run billed to one person could see
   * another's — or the deployment's own — key.
   */
  it("filteredSpawnEnv strips every credential-shaped variable, and keeps the rest", () => {
    setEnv("PATH", process.env.PATH || "/usr/bin:/bin");
    setEnv("VIBERR_CLAUDE_TEST_MARKER", "present");
    setEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak");
    setEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-should-not-leak");
    setEnv("CODEX_ACCESS_TOKEN", "cat-should-not-leak");
    setEnv("CODEX_API_KEY", "codex-should-not-leak");
    setEnv("OPENAI_API_KEY", "platform-should-not-leak");
    setEnv("GITHUB_TOKEN", "ghp_should_not_leak");
    setEnv("MY_DEPLOY_SECRET", "server-deploy-secret");
    setEnv("VIBERR_SESSION_SECRET", "server-session-secret");
    setEnv("DATABASE_URL", "postgres://secret");

    const env = filteredSpawnEnv();

    // Ordinary runtime settings survive — a child with no PATH/HOME cannot
    // spawn `npx` for a stdio MCP server, and neither CLI could find its own
    // machinery (adversarial-review HIGH #3).
    expect(env.PATH).toBeTruthy();
    expect(env.VIBERR_CLAUDE_TEST_MARKER).toBe("present");
    // …and nothing credential-shaped does, whoever owns it.
    for (const key of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CODEX_ACCESS_TOKEN",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "MY_DEPLOY_SECRET",
      "VIBERR_SESSION_SECRET",
      "DATABASE_URL",
    ]) {
      expect({ key, value: env[key] }).toEqual({ key, value: undefined });
    }
  });

  it("CREDENTIAL_ENV_RE matches the names the sink redacts values for", () => {
    // One regex on both sides (the module comment's contract): what the spawn
    // filter drops is exactly what the run sink treats as a secret VALUE, so
    // "what counts as a credential" cannot drift between input and output.
    for (const name of [
      "ANTHROPIC_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "SOME_PASSWORD",
      "GIT_CREDENTIALS",
    ]) {
      expect({ name, matched: CREDENTIAL_ENV_RE.test(name) }).toEqual({
        name,
        matched: true,
      });
    }
    for (const name of ["PATH", "HOME", "LANG", "GIT_CEILING_DIRECTORIES"]) {
      expect({ name, matched: CREDENTIAL_ENV_RE.test(name) }).toEqual({
        name,
        matched: false,
      });
    }
  });

  it("createAdapters builds BOTH adapters on the credential-free base env", async () => {
    // Ruling 121: no config dir, no key, no home — the factory runs once per
    // process and could only ever bake in an INSTANCE credential, which is the
    // thing the ruling removes. Whatever a run needs arrives per run on
    // `spec.env` from `runCredentialFor`.
    setEnv("ANTHROPIC_API_KEY", "sk-ant-instance-key");
    setEnv("CODEX_API_KEY", "instance-codex-key");
    setEnv("VIBERR_CLAUDE_TEST_MARKER", "present");

    let claudeEnv: Record<string, string> | undefined;
    let codexEnv: Record<string, string> | undefined;
    const adapters = createAdapters({
      claudeQueryFn: (params) => {
        claudeEnv = params.options?.env;
        return fakeClaudeQuery({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          usage: {},
        });
      },
      codexFactory: (options) => {
        codexEnv = options?.env;
        const thread: ReturnType<CodexClient["startThread"]> = {
          id: "thread-hygiene",
          async runStreamed() {
            const events = (async function* (): AsyncGenerator<ThreadEvent> {
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  cache_write_input_tokens: 0,
                  output_tokens: 1,
                  reasoning_output_tokens: 0,
                },
              };
            })();
            return { events };
          },
        };
        return { startThread: () => thread, resumeThread: () => thread };
      },
    });

    const spec: RunSpec = {
      runId: "run_hygiene",
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
      threadId: "primary",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "hello",
      workdir: "/tmp",
      autonomous: true,
    };
    const sink = { onLine: () => {}, onExit: () => {} };
    adapters.claude.start(spec, sink);
    adapters.codex.start({ ...spec, backend: "codex" }, sink);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

    for (const env of [claudeEnv, codexEnv]) {
      expect(env?.PATH).toBeTruthy();
      expect(env?.VIBERR_CLAUDE_TEST_MARKER).toBe("present");
      // Nothing the deployment happens to hold reaches a child.
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.CODEX_API_KEY).toBeUndefined();
      // …and the factory adds no home of its own: a run's home is its
      // principal's, and arrives on spec.env.
      expect(env?.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(env?.CODEX_HOME).toBeUndefined();
    }
  });

  it("selectAdapter is a plain lookup — availability is not its business", () => {
    // Ruling 121: whether a run may proceed is decided upstream, by resolving
    // its credential principal. `startRun` never reaches this function for a
    // run it refused, so an "unavailable" arm here would be a second, quieter
    // place for that decision to live.
    const adapters = createAdapters({
      claudeQueryFn: () => fakeClaudeQuery(),
    });
    expect(selectAdapter("claude", adapters)).toBe(adapters.claude);
    expect(selectAdapter("codex", adapters)).toBe(adapters.codex);
  });

  it("createAdapters accepts injected SDK fakes (no real SDK constructed)", () => {
    let queryCalled = false;
    const adapters = createAdapters({
      claudeQueryFn: () => {
        queryCalled = true;
        return fakeClaudeQuery();
      },
    });
    expect(adapters.claude.backend).toBe("claude");
    expect(queryCalled).toBe(false); // constructing the adapter must not call query
  });
});

/**
 * UC-16 — "do Codex and Claude Code work the same way from Viberr's eye?"
 *
 * A specialist is ONE uniform machinery differentiated only by its capability +
 * resource grants (generic-agents, 2026-07-19). The two backends must therefore
 * be interchangeable at every seam Viberr controls, and where they genuinely
 * differ the difference must be DISCLOSED (ruling 51 / R18-5, and the capability
 * matrix's "What differs between the two runtimes" list) rather than silent.
 *
 * These tests drive BOTH adapters — built by the production `createAdapters`
 * factory, with the provider SDKs faked so nothing bills — from ONE spec that
 * differs only in `backend`, and assert the EFFECT is the same even where the
 * mechanism is not (Claude tool denylist vs Codex sandbox mode). They replace
 * the two-legged live run in `planning/discovery-2026-08-06-pass19/runbooks/UC-16.md`,
 * which needs a real repo, real PRs and 20 minutes of provider time.
 */
describe("UC-16 backend parity (claude ↔ codex, one spec, two adapters)", () => {
  /** The Codex thread options + CLI options these tests read. `config` is the
   *  SDK's own recursive `--config` value, so a leaf is decoded where read. */
  interface CodexCapture {
    thread: {
      model?: string;
      sandboxMode?: string;
      workingDirectory?: string;
      networkAccessEnabled?: boolean;
      webSearchMode?: string;
    };
    env?: Record<string, string>;
    config?: CodexOptions["config"];
  }

  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  }

  /** Start the SAME spec on both real adapters; return what each SDK was handed. */
  async function startOnBoth(
    spec: Omit<RunSpec, "backend">,
  ): Promise<{ claude: ClaudeQueryOptions; codex: CodexCapture }> {
    let claude: ClaudeQueryOptions = {};
    const codex: CodexCapture = { thread: {} };

    const codexFactory: CodexFactory = (options) => {
      codex.env = options?.env;
      codex.config = options?.config;
      const thread: ReturnType<CodexClient["startThread"]> = {
        id: "thread-parity",
        async runStreamed() {
          const events = (async function* (): AsyncGenerator<ThreadEvent> {
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            };
          })();
          return { events };
        },
      };
      const client: CodexClient = {
        startThread: (opts) => {
          Object.assign(codex.thread, opts ?? {});
          return thread;
        },
        resumeThread: (_id, opts) => {
          Object.assign(codex.thread, opts ?? {});
          return thread;
        },
      };
      return client;
    };

    const adapters = createAdapters({
      claudeQueryFn: (params) => {
        claude = params.options ?? {};
        return fakeClaudeQuery({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          usage: {},
        });
      },
      codexFactory,
    });

    const sink = { onLine: () => {}, onExit: () => {} };
    adapters.claude.start({ ...spec, backend: "claude" }, sink);
    adapters.codex.start({ ...spec, backend: "codex" }, sink);
    await drain();
    return { claude, codex };
  }

  /** The task identity every run carries: same key, same branch checkout. */
  const PARITY_TASK = {
    runId: "run_parity",
    projectSlug: "viberr-core",
    taskKey: "VIB-16",
    threadId: "primary",
    role: "Primary specialist",
    kind: "primary",
    model: "sonnet",
    prompt: "Implement the marker file.",
    workdir: "/data/projects/viberr-core/tasks/VIB-16/workspace/viberr",
    autonomous: true,
  } satisfies Omit<RunSpec, "backend">;

  /** A fully-granted deliverer, as the profile editor would persist it. */
  const DELIVERY_GRANTS: CapabilityGrant[] = [
    { capabilityId: "execute-code-or-write-repo", mode: "direct" },
    { capabilityId: "create-task-branch", mode: "direct" },
    { capabilityId: "commit-push-branch", mode: "direct" },
    { capabilityId: "open-review-pr", mode: "direct" },
    { capabilityId: "use-web-search-fetch", mode: "direct" },
  ];

  const REPO_WRITE_TOOLS = [
    "Edit",
    "MultiEdit",
    "Write",
    "NotebookEdit",
    "Bash(git commit:*)",
  ];

  function withMode(
    grants: CapabilityGrant[],
    capabilityId: string,
    mode: CapabilityGrant["mode"],
  ): CapabilityGrant[] {
    return grants.map((g) => (g.capabilityId === capabilityId ? { ...g, mode } : g));
  }

  /**
   * Build the spec the way `startRun` builds it (run-service.server.ts) —
   * grants → `resolveSpecialistDisallowedTools` → the two derived backend flags.
   * Composing the REAL functions is what makes this a parity test rather than a
   * restatement of hand-written lists: change the policy and both legs move.
   */
  function specForGrants(grants: CapabilityGrant[]): Omit<RunSpec, "backend"> {
    const disallowedTools = resolveSpecialistDisallowedTools(grants);
    const spec: Omit<RunSpec, "backend"> = { ...PARITY_TASK };
    if (disallowedTools.length) spec.disallowedTools = disallowedTools;
    if (repoWriteWithheldFromDenylist(disallowedTools)) {
      spec.repoWriteWithheld = true;
    }
    if (webSearchWithheldFromDenylist(disallowedTools)) {
      spec.webSearchWithheld = true;
    }
    return spec;
  }

  it("ruling 101: withheld repo-write binds on BOTH backends — Claude tool deny, Codex read-only sandbox", async () => {
    const withheld = await startOnBoth(
      specForGrants(withMode(DELIVERY_GRANTS, "execute-code-or-write-repo", "off")),
    );
    // Claude: the write tools are removed from the model's context (deny binds
    // even under bypassPermissions) — the capability is ENFORCED.
    expect(withheld.claude.disallowedTools).toEqual(
      expect.arrayContaining(REPO_WRITE_TOOLS),
    );
    const granted = await startOnBoth(specForGrants(DELIVERY_GRANTS));
    for (const tool of REPO_WRITE_TOOLS) {
      expect(granted.claude.disallowedTools ?? []).not.toContain(tool);
    }
    // Codex (ruling 101, superseding R22's advisory posture): grants decide
    // the sandbox. The withheld run is READ-ONLY — physically bound, matching
    // Claude — while the granted autonomous deliverer with egress keeps
    // danger-full-access. The scoped push/PR/merge commands remain
    // server-owned either way.
    expect(withheld.codex.thread.sandboxMode).toBe("read-only");
    expect(granted.codex.thread.sandboxMode).toBe("danger-full-access");

    // Claude keeps Bash (the specialist must run its validation), so shell-level
    // writes stay reachable there too — the physical repo-write enforcement was
    // never total on either backend; the server-owned delivery gate is what
    // actually decides what ships.
    expect(withheld.claude.disallowedTools).not.toContain("Bash");
  });

  it("withheld web egress binds on BOTH backends, by different channels", async () => {
    const withheld = await startOnBoth(
      specForGrants(withMode(DELIVERY_GRANTS, "use-web-search-fetch", "off")),
    );
    expect(withheld.claude.disallowedTools).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch"]),
    );
    expect(withheld.codex.thread.webSearchMode).toBe("disabled");
    expect(withheld.codex.thread.networkAccessEnabled).toBeUndefined();
    // R22: an egress-withheld Codex run is workspace-write, NOT
    // danger-full-access — full access would turn the network on and defeat the
    // withheld egress. The workspace-write default (network off) is what gates
    // it. So egress remains an ENFORCED capability on both backends (owner
    // ruling: sandbox removed, egress kept).
    expect(withheld.codex.thread.sandboxMode).toBe("workspace-write");

    const granted = await startOnBoth(specForGrants(DELIVERY_GRANTS));
    expect(granted.claude.disallowedTools ?? []).not.toContain("WebFetch");
    expect(granted.codex.thread.webSearchMode).toBeUndefined();
  });

  it("every tool-layer capability's DECLARED enforcement scope matches what the adapters do", async () => {
    // The capability matrix renders a "Claude-enforced" badge from
    // `capabilityEnforcement`. A badge that drifts from the adapters is worse
    // than no badge: it tells an admin a withheld grant binds on a backend where
    // it does not. Derive the tool-layer capabilities from the policy itself (so
    // a NEW deny rule is covered the day it lands) and check each one against
    // the Codex thread options the same grant actually produces.
    const allGranted: CapabilityGrant[] = CAP_CATALOG.map((c) => ({
      capabilityId: c.id,
      mode: "direct",
    }));
    const baseline = new Set(resolveSpecialistDisallowedTools(allGranted));
    const grantedRun = await startOnBoth(specForGrants(allGranted));
    const codexPosture = (c: CodexCapture) =>
      JSON.stringify([
        c.thread.sandboxMode,
        c.thread.webSearchMode ?? null,
        c.thread.networkAccessEnabled ?? null,
      ]);

    const toolLayer: string[] = [];
    for (const cap of CAP_CATALOG) {
      const denied = resolveSpecialistDisallowedTools(
        withMode(allGranted, cap.id, "off"),
      );
      const claudeBinds = denied.some((t) => !baseline.has(t));
      if (!claudeBinds) continue; // not a tool-layer capability at all
      toolLayer.push(cap.id);
      const run = await startOnBoth(specForGrants(withMode(allGranted, cap.id, "off")));
      const codexBinds =
        codexPosture(run.codex) !== codexPosture(grantedRun.codex);
      expect(
        { id: cap.id, scope: capabilityEnforcement(cap.id) },
        `${cap.id}: codex ${codexBinds ? "binds" : "does not bind"} this grant`,
      ).toEqual({ id: cap.id, scope: codexBinds ? "both" : "claude-only" });
    }

    // And the tool-layer set itself is exactly these five — a new deny rule has
    // to be classified deliberately (and disclosed) rather than inheriting one.
    expect(toolLayer.sort()).toEqual([
      "commit-push-branch",
      "create-task-branch",
      "execute-code-or-write-repo",
      "open-review-pr",
      "use-web-search-fetch",
    ]);
  });

  it("ruling 101: the operator is read-only on BOTH backends — Claude deny, Codex sandbox — with Codex egress gated", async () => {
    // R19-1 made this load-bearing: the operator stands beside a full clone of
    // the project repo it must never write. Ruling 101 restored the Codex
    // read-only sandbox for coordination machinery, so "never write" binds
    // physically on both legs — and its Codex EGRESS stays gated (no network).
    const operator = await startOnBoth({
      ...PARITY_TASK,
      kind: "operator",
      threadId: "op",
      role: "Operator",
      workdir: "/data/projects/viberr-core/tasks/VIB-16",
    });
    // Claude: the repo-mutation built-ins are removed from the model's context
    // by RUN KIND — the adapter is the backstop even if a caller forgets to pass
    // `operatorDisallowedTools` (this spec passes none).
    expect(operator.claude.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit"]),
    );
    // …while the tool-loading path it needs to reach its mcp__viberr__* tools stays.
    expect(operator.claude.disallowedTools).not.toContain("ToolSearch");
    // Codex (ruling 101): read-only, egress fully gated — an operator that
    // set autonomous:true must NOT reach danger-full-access (that turns the
    // network on).
    expect(operator.codex.thread.sandboxMode).toBe("read-only");
    expect(operator.codex.thread.networkAccessEnabled).toBe(false);
    // Autonomy does NOT buy the operator write access on either backend.
    expect(operator.claude.permissionMode).toBe("bypassPermissions");
    expect(operator.codex.thread.sandboxMode).not.toBe("danger-full-access");

    // B-2 (pass 24, owner ruling): the operator now honors `use-web-search-fetch`
    // on BOTH backends, removing the old asymmetry. With the grant HELD, Claude
    // keeps WebFetch/WebSearch AND the Codex operator gets web search — its
    // OS-sandbox network stays off (`networkAccessEnabled: false`, above), which
    // is a different egress. A withheld grant disables web search on both.
    expect(operator.claude.disallowedTools ?? []).not.toContain("WebFetch");
    expect(operator.claude.disallowedTools ?? []).not.toContain("WebSearch");
    expect(operator.codex.thread.webSearchMode).not.toBe("disabled");
  });

  it("both backends carry the same task identity into the run (NFR15 traceability)", async () => {
    // F24: one delivery identity, whichever backend ran. `agentGitIdentityEnv`
    // (specialist-run) builds these from the DELIVERING profile id, and the two
    // adapters have to land them in different places: Claude's SDK replaces the
    // child env with `options.env`, while Codex splits the CLI env (which
    // carries subscription auth) from the model's OWN shell — where
    // `inherit: "core"` strips everything not named in `shell_environment_policy.set`.
    const identity = agentGitIdentity("developer-claude");
    const env = {
      GIT_CEILING_DIRECTORIES: "/data/projects/viberr-core/tasks/VIB-16",
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    const both = await startOnBoth({ ...PARITY_TASK, env });

    // Same workspace directory ⇒ same checkout, same task-key branch, same
    // commits to trace back to the task.
    expect(both.claude.cwd).toBe(PARITY_TASK.workdir);
    expect(both.codex.thread.workingDirectory).toBe(PARITY_TASK.workdir);

    for (const [key, value] of Object.entries(env)) {
      expect(both.claude.env?.[key]).toBe(value);
      expect(both.codex.env?.[key]).toBe(value);
    }
    // The overlay is a MERGE on both: the base spawn env survives, so the
    // spawned CLI keeps PATH/HOME (adversarial-review HIGH #3).
    expect(both.claude.env?.PATH).toBeTruthy();
    expect(both.codex.env?.PATH).toBeTruthy();

    // Codex only: the identity must be re-exported into the model's own shell,
    // or a `git commit` the agent runs is authored by whoever spawned the
    // process (P13-RT-10). Exactly these keys cross — nothing more, nothing less.
    const policy = z
      .object({
        inherit: z.string().optional().catch(undefined),
        set: z.record(z.string(), z.string()).optional().catch(undefined),
      })
      .catch({})
      .parse(both.codex.config?.shell_environment_policy);
    expect(policy.inherit).toBe("core");
    expect(policy.set).toEqual(env);
  });
});
