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
import type { ClaudeQueryOptions } from "./claude-runtime.server";
import { fakeClaudeQuery } from "../../../test-support/fake-claude-query";
import { resolveSpecialistDisallowedTools } from "../tasks/specialist-tool-policy";
import { agentGitIdentity } from "../tasks/specialist-workspace.server";
import { CAP_CATALOG, capabilityEnforcement } from "~/shared/capabilities";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import { ENV_KEYS, resetEnvCacheForTests } from "~/server/config/env.server";

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
    // The ruling-142 cases below set DECLARED knobs (NODE_ENV, PORT, the data
    // root) and `start()` reads the validated env, which caches per process:
    // drop the cache so a later test never sees the values this one set.
    resetEnvCacheForTests();
  });

  /**
   * Ruling 127: this module no longer knows anything about credentials. The
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
    // Ruling 127: no config dir, no key, no home — the factory runs once per
    // process and could only ever bake in an INSTANCE credential, which is the
    // thing the ruling removes. Whatever a run needs arrives per run on
    // `spec.env` from `runCredentialFor`.
    setEnv("ANTHROPIC_API_KEY", "sk-ant-instance-key");
    setEnv("CODEX_API_KEY", "instance-codex-key");
    // Ruling 181: the CLI's state-db location is the person's too. An ambient
    // one (a host's own ~/.codex state) must not ride into a child.
    setEnv("CODEX_SQLITE_HOME", "/ambient/codex-state");
    setEnv("VIBERR_CLAUDE_TEST_MARKER", "present");

    const { claude, codex } = await startOnBoth({
      runId: "run_hygiene",
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
      threadId: "primary",
      kind: "primary",
      model: "sonnet",
      prompt: "hello",
      workdir: "/tmp",
      autonomous: true,
    });

    for (const env of [claude.env, codex.env]) {
      expect(env?.PATH).toBeTruthy();
      expect(env?.VIBERR_CLAUDE_TEST_MARKER).toBe("present");
      // Nothing the deployment happens to hold reaches a child.
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.CODEX_API_KEY).toBeUndefined();
      // …and the factory adds no home of its own: a run's home is its
      // principal's, and arrives on spec.env.
      expect(env?.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(env?.CODEX_HOME).toBeUndefined();
      // Ruling 181: the adapter sets CODEX_SQLITE_HOME per run, to the
      // principal's shared home; the base must not carry a host's own.
      expect(env?.CODEX_SQLITE_HOME).toBeUndefined();
    }
  });

  it("ruling 142: filteredSpawnEnv strips every name the env schema declares, and keeps the undeclared rest", () => {
    // U34-7 (pass 34): the JC-6 Developer's shell inherited the container's
    // NODE_ENV=production and PORT, and the project's own `vitest` and
    // `next start` broke on them until the agent unset them by hand. An
    // agent works in the PROJECT's repository, not in Viberr's process, so
    // the app's own configuration — every name the env schema declares —
    // stays out of the child. The rule is keyed on the schema, not a list,
    // so a knob declared tomorrow is stripped tomorrow.
    for (const key of ENV_KEYS) setEnv(key, process.env[key] || `declared-${key}`);
    setEnv("NODE_ENV", "production");
    setEnv("PORT", "5173");
    setEnv("VIBERR_DATA_ROOT", "/data");
    // Undeclared names are not Viberr's configuration and pass through: the
    // child needs PATH/HOME, the image's UV caches are agent-facing on
    // purpose, and the test marker is the suite's own.
    setEnv("PATH", process.env.PATH || "/usr/bin:/bin");
    setEnv("HOME", process.env.HOME || "/home/viberr");
    setEnv("UV_CACHE_DIR", "/data/runtimes/uv-cache");
    setEnv("VIBERR_CLAUDE_TEST_MARKER", "present");

    const env = filteredSpawnEnv();

    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
    expect(env.UV_CACHE_DIR).toBe("/data/runtimes/uv-cache");
    expect(env.VIBERR_CLAUDE_TEST_MARKER).toBe("present");
    // The two the finding saw, by name…
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.PORT).toBeUndefined();
    expect(env.VIBERR_DATA_ROOT).toBeUndefined();
    // …and the whole declared list, whatever it holds today.
    expect(ENV_KEYS.filter((key) => key in env)).toEqual([]);
    // The list is the real schema, not an empty fixture: the names an
    // operator would recognise are all on it.
    expect(ENV_KEYS).toEqual(
      expect.arrayContaining([
        "NODE_ENV",
        "PORT",
        "VIBERR_DATA_ROOT",
        "BETTER_AUTH_URL",
        "GITHUB_OAUTH_CLIENT_ID",
        "VIBERR_TRUST_PROXY",
        "VIBERR_UNLOCK_CONTROLLER_SKILLS",
        "VIBERR_BROWSER_EXECUTABLE",
      ]),
    );
  });

  it("ruling 506: filteredSpawnEnv strips the CLI's prompt-cache and compaction switches, and no other cache setting", () => {
    // Rulings 374(a) and 376(d): the cache lifetime and the compaction point
    // are the CLI's own choice, and Viberr sets none of these. None is
    // credential-shaped or declared, so one on the HOST rode into every Claude
    // child, where a developer's `DISABLE_PROMPT_CACHING=1` would turn caching
    // off for every run the instance makes. The names are the 2.1.280
    // bundle's, per-model and Bedrock variants included.
    const switches = [
      "DISABLE_PROMPT_CACHING",
      "DISABLE_PROMPT_CACHING_FABLE",
      "DISABLE_PROMPT_CACHING_HAIKU",
      "DISABLE_PROMPT_CACHING_MYTHOS",
      "DISABLE_PROMPT_CACHING_OPUS",
      "DISABLE_PROMPT_CACHING_SONNET",
      "ENABLE_PROMPT_CACHING_1H",
      "ENABLE_PROMPT_CACHING_1H_BEDROCK",
      "FORCE_PROMPT_CACHING_5M",
      "CLAUDE_CODE_PROMPT_CACHE_TTL",
      "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
      // A server started inside a Claude Code session carries the first two.
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
      "DISABLE_AUTO_COMPACT",
      "DISABLE_COMPACT",
    ];
    for (const key of switches) setEnv(key, key.endsWith("_TTL") ? "1h" : "1");
    // The CLI's other caches are not the prompt cache, and pass like any
    // undeclared name.
    setEnv("CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS", "60000");
    setEnv("MCP_DISCOVERY_CACHE_TTL_S", "30");
    setEnv("PATH", process.env.PATH || "/usr/bin:/bin");

    const env = filteredSpawnEnv();

    expect(switches.filter((key) => key in env)).toEqual([]);
    expect(env.CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS).toBe("60000");
    expect(env.MCP_DISCOVERY_CACHE_TTL_S).toBe("30");
    expect(env.PATH).toBeTruthy();
  });

  it("ruling 142: createAdapters builds BOTH adapters on a base that carries none of the app's own configuration", async () => {
    // The same invariant where it bites: what each SDK is actually handed.
    // `VIBERR_BROWSER_EXECUTABLE` is the one declared knob a child's tool
    // depends on, and it reaches the browser MCP as argv from the parent, so
    // stripping it here loses nothing.
    setEnv("NODE_ENV", "production");
    setEnv("PORT", "5173");
    setEnv("VIBERR_DATA_ROOT", "/data");
    setEnv("VIBERR_BROWSER_EXECUTABLE", "/usr/bin/chromium");
    setEnv("VIBERR_CLAUDE_TEST_MARKER", "present");

    const { claude, codex } = await startOnBoth({
      runId: "run_app_config",
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
      threadId: "primary",
      kind: "primary",
      model: "sonnet",
      prompt: "hello",
      workdir: "/tmp",
      autonomous: true,
    });

    for (const env of [claude.env, codex.env]) {
      expect(env).toBeTruthy();
      expect(env?.PATH).toBeTruthy();
      expect(env?.VIBERR_CLAUDE_TEST_MARKER).toBe("present");
      expect(env?.NODE_ENV).toBeUndefined();
      expect(env?.PORT).toBeUndefined();
      expect(env?.VIBERR_DATA_ROOT).toBeUndefined();
      expect(env?.VIBERR_BROWSER_EXECUTABLE).toBeUndefined();
      expect(ENV_KEYS.filter((key) => key in (env ?? {}))).toEqual([]);
    }
  });

  it("selectAdapter is a plain lookup — availability is not its business", () => {
    // Ruling 127: whether a run may proceed is decided upstream, by resolving
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
 * mechanism is not (Claude tool denylist vs Codex's own switches). They replace
 * the two-legged live run in `planning/discovery-2026-08-06-pass19/runbooks/UC-16.md`,
 * which needs a real repo, real PRs and 20 minutes of provider time.
 */
describe("UC-16 backend parity (claude ↔ codex, one spec, two adapters)", () => {
  /** The task identity every run carries: same key, same branch checkout. */
  const PARITY_TASK = {
    runId: "run_parity",
    projectSlug: "viberr-core",
    taskKey: "VIB-16",
    threadId: "primary",
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

  it("ruling 185: withheld repo-write binds on Claude (tool deny) and is ADVISORY on Codex — which is not OS-confined", async () => {
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
    // Codex (ruling 185): no OS confinement at all, withheld or granted. The
    // withholding still reaches the run — it shapes the prompt and the
    // server-owned delivery gate — but it is advisory at the OS layer, and
    // every surface that renders the enforcement says so.
    expect(withheld.codex.thread.sandboxMode).toBe("danger-full-access");
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
    // Ruling 185: the run is not confined either way, so `webSearchMode` — the
    // CLI's own tool switch, not the OS sandbox — is the whole of what binds
    // egress on Codex. It still binds, so the capability stays ENFORCED on
    // both backends.
    expect(withheld.codex.thread.sandboxMode).toBe("danger-full-access");

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

  it("ruling 185: the operator's write denial binds on Claude by kind; on Codex its contract is what withholds the shell", async () => {
    // R19-1 made this load-bearing: the operator stands beside a full clone of
    // the project repo it must never write. On Claude the adapter removes the
    // repo-mutation built-ins by RUN KIND. On Codex there is no OS confinement
    // any more (ruling 185) — the operator is told, in its own contract, that
    // the file-writing and shell tools are withheld from it, and its plan
    // executes server-side through gated tools.
    const operator = await startOnBoth({
      ...PARITY_TASK,
      kind: "operator",
      threadId: "op",
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
    // Codex (ruling 185): not confined, and its OS network is no longer forced
    // off. The operator still has the CLI's shell, so since the sandbox went
    // its contract (ruling 207(b)) is what keeps it off the tree.
    expect(operator.codex.thread.sandboxMode).toBe("danger-full-access");
    expect(operator.codex.thread.networkAccessEnabled).toBeUndefined();
    expect(operator.claude.permissionMode).toBe("bypassPermissions");

    // B-2 (pass 24, owner ruling): the operator honors `use-web-search-fetch`
    // on BOTH backends. With the grant HELD, Claude keeps WebFetch/WebSearch and
    // the Codex operator gets web search; a withheld grant disables it on both.
    expect(operator.claude.disallowedTools ?? []).not.toContain("WebFetch");
    expect(operator.claude.disallowedTools ?? []).not.toContain("WebSearch");
    expect(operator.codex.thread.webSearchMode).not.toBe("disabled");
  });

  it("both backends carry the same task identity into the run (NFR15 traceability)", async () => {
    // F24: one delivery identity, whichever backend ran. `agentGitIdentityEnv`
    // (specialist-workspace) builds these from the DELIVERING profile id, and the two
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
