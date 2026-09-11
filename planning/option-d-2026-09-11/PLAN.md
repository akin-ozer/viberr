# Option D: port the Cognipeer-verified gains onto Viberr's current SDKs

Written 2026-09-11. Follows the decision recorded in
[`cognipeer-docs/27-viberr-adoption-assessment.md`](../../cognipeer-docs/27-viberr-adoption-assessment.md)
(sections 8.1 "Option D" and 8.3): do not adopt `@cognipeer/agent-sdk`; keep `@anthropic-ai/claude-agent-sdk`
^0.3.261 and `@openai/codex-sdk` ^0.153.4, and land the gains the assessment verified through SDK options Viberr
pins but never sets, plus a few Viberr-side changes. Every SDK fact below was read from the installed
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (cited as `sdk.d.ts:line`) or `sdk.mjs`; every Viberr fact is
`path:line` in this tree. Rulings run to 172; new ones take the next numbers at merge time.

*(Noted 2026-09-11, P0: the assessment and the `cognipeer-docs/` folder this plan cites were
working material and are not committed (owner: "we won't need them after the implementation is
done"). Ruling 173 records the verdict and its deciding facts; the `cognipeer-docs/` links below
resolve only in the working copy they were written in.)*

**Owner decisions taken 2026-09-11** (section 2): D1 wrapper via `codexPathOverride`; D2/D3 close P13-KM-04 now, discovery proposes and the admin decides; D4 the cost cap is an **instance ceiling only** (no profile field); D5 the wall-clock cap is deferred.

## 1. Summary

Seven work items, each an independent PR that lands on `main` with the five gates green and its docs in the same
change (contributing §7). Total: 10 to 17 engineer-days for one engineer fluent in Viberr, tests and docs included.

| # | Item | Goal | Days | Depends on | Risk | Waits on owner decision |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | Decision record | Ruling: Cognipeer evaluated, not adopted, reopen triggers | 0.5 | none | none | decided |
| PR 1 | Permissions flag + process-group kill | Pass `allowDangerouslySkipPermissions`; Stop reliably kills the whole tree on both backends | 2 to 3 | none | low | D1 decided: wrapper |
| PR 2 | Org MCP tools grant-gated by name | Close P13-KM-04 with SDK-enforced per-tool denies instead of a prompt paragraph | 3 to 5 | none | medium | D2/D3 decided: yes, discovery proposes, admin decides |
| PR 3 | Per-run cost cap + exact usage | `maxBudgetUsd` from an instance ceiling with a new `max_budget` failure kind; tokens and cost from `modelUsage` | 2 to 3 | none | low | D4 decided: instance ceiling only |
| PR 4 | `alwaysLoad`, once-only `report_outcome`, wall-clock cap | Fewer ToolSearch round trips; duplicate outcomes refused; optional total-time guard | 1 to 2 | none | low | D5 decided: wall-clock cap deferred |
| PR 5 | Spike-gated `PreToolUse` deny-with-reason | Argument-level denies with a model-visible reason for the commands the prefix denylist misses | 1 to 3 | none | medium (spike decides) | none |
| PR 6 | Hygiene | Stale docstrings and drift notes corrected | 0.5 | PR 1 (one docstring describes its change) | none | none |

What is deliberately not ported is in section 12.

## 2. Decision queue for the owner

Asked and answered on 2026-09-11; the answers are folded into the sections below.

**D1. Codex leg: how should Stop escalate to SIGKILL?** Background: the Codex SDK spawns the CLI itself with a plain
`spawn()` and `child.kill()` (SIGTERM only), exposes no pid, and Viberr's `INTERRUPT_SETTLE_GRACE_MS` (20 s) only
force-settles the row; a grandchild holding the pipe survives (`app/server/runtimes/codex-runtime.server.ts:483-503,
1038-1056`; `node_modules/@openai/codex-sdk/dist/index.js:263-276, 309-315`). Options: (a) ship a tiny wrapper
script in the image and point `codexPathOverride` (`node_modules/@openai/codex-sdk/dist/index.d.ts:219`) at it; the
wrapper runs the real binary as its own process group and, on SIGTERM, signals the group and escalates to SIGKILL
after a grace; (b) discover the child with `pgrep -P <app pid>` and `killpg`, which cannot tell two concurrent Codex
runs apart; (c) accept the direct-child SIGTERM and document the residual. **Recommendation: (a).** Viberr already
owns the image and the child env; the wrapper is 20 lines of shell and is the only option that reaches the tree.
**Decided: (a).** *(Superseded 2026-09-11 before it shipped, owner: the PR 1 spike showed
the Claude CLI starts every Bash command in a session of its own, so no group kill reaches
it. The owner chose a per-run environment marker and a settle sweep on both backends
instead, which also makes the Codex wrapper unnecessary. See ruling 174 and the note on §5.)*

**D2. Org MCP tool gating: where does the per-tool policy come from?** Background: ruling 39 says Viberr does not
pretend to bound a third-party tool, which is why P13-KM-04 is closed by a prompt paragraph today
(`app/server/runtimes/operator-run.server.ts:3449-3463`; `app/server/tasks/specialist-run.server.ts:2712-2728`).
The SDK can now enforce per-tool denies on HTTP and SSE servers (`McpServerToolPolicy`, `sdk.d.ts:1165-1168`) and
every backend honours a `disallowedTools` name (`mcp__<server>__<tool>`). Options: (a) an admin-authored per-server
list of "write" tool names in the org MCP registry, edited in the MCP server editor, denied on runs whose
`execute-code-or-write-repo` grant is withheld; (b) a discovery-assisted default from the stdio probe's tool list
(`discoverStdioMcpTools`, `app/server/org/resources.server.ts`) with a name heuristic (`create|delete|merge|push|
update|write`) that the admin can edit; (c) both: (b) proposes, (a) decides. **Recommendation: (c).** The admin
stays the authority (ruling 39 intact), discovery removes the typing, and the heuristic is never enforced unseen.
**Decided: (c).**

**D3. Is closing P13-KM-04 wanted now?** Background: the gap is disclosed in the capability matrix and has never
been exploited; closing it adds a registry column, an editor field and a ruling amendment. **Recommendation: yes,
as PR 2**, because the enforcement is now free on the pinned SDK and the paragraph is the only thing between a
read-only reviewer holding a GitHub MCP and the always-human merge invariant.
**Decided: yes, now.**

**D4. Where does the cost cap live, and what is the default?** Background: `options.maxBudgetUsd` stops a Claude
query with an `error_max_budget_usd` result (`sdk.d.ts:1773-1777, 4959`). Codex has no equivalent. Options: (a) per
profile only (`agents/profiles/<id>.md` frontmatter beside `model` and `effort`, template default plus deployment
override, the ruling 153 pattern); (b) per instance only (`instance_settings`, the `maxConcurrentRuns` pattern);
(c) both, tightest wins. Default: none (off) or a generous ceiling. **Recommendation: (c) with default none.** A
side project does not want a surprise cut-off, but an org admin should be able to set a ceiling once.
**Decided: (b), instance ceiling only, default none.** No profile field, no file-format change; one org-settings number applies to every Claude run.

**D5. Wall-clock cap beside the idle timer?** Background: both adapters have a 15-minute inactivity timer (owner
ruling A8, `docs/architecture/decisions.md:1971-1973`) and Claude has `maxTurns`; nothing caps total duration, and
PR 3 caps spend on Claude only. Options: (a) add `VIBERR_RUN_MAX_WALLCLOCK_MS` (default off) as a third guard on
both backends with a new failure kind; (b) defer. **Recommendation: (b), defer.** The idle timer already catches
hung runs and the cost cap catches runaway spend; a long healthy build is not a failure.
**Decided: defer.** PR 4(c) is out of scope; the design stays in section 8 for the record.

## 3. Sequencing

No PR depends on another for code. Suggested order, by value per day: P0 (an afternoon), PR 1, PR 3, PR 4, PR 2,
PR 5, PR 6. PR 1, PR 3 and PR 4 can proceed in parallel branches; PR 2 waits for D2 and D3 only if the owner
disagrees with the recommendation; PR 5 begins with its spike and is dropped without a PR if the spike fails; PR 6
is last because one of its docstring fixes describes what PR 1 changed. Each PR: `npm run lint && npm run typecheck
&& npm test && npm run build`, docs in the same change, and a live canary on a throwaway task before merge where the
section says so.

## 4. P0: the decision record

**Why.** Contributing §7 point 5: an owner decision is the next numbered ruling. Without it the evaluation can be
repeated by accident, and the corrections the assessment surfaced (a live enforcement seam that ruling R22's wording
hides, two SDK levers already present) stay in a report nobody cites.

**Changes.** `docs/architecture/decisions.md`: append ruling 173 (confirm the number at merge). Draft:

> 173. **The Cognipeer Agent SDK was evaluated and not adopted (owner, 2026-09-11).** `@cognipeer/agent-sdk` 0.10.2
> was assessed against every run subsystem (`cognipeer-docs/27-viberr-adoption-assessment.md`). It is not adopted:
> it authenticates with API keys only, so the per-person vendor sign-in of ruling 127 has no equivalent; its Anthropic
> reasoning mapping is rejected by current models; a Zod 4 schema reaches the provider as a bare object (verified);
> it ships no coding harness or sandbox and runs in the server process. The gains it demonstrated are ported onto the
> pinned SDKs by rulings 174 to 176. Reopen only when all of the following hold: an upstream reasoning route on
> current Anthropic models, a Zod 4 native schema path, and a 1.x release with a published plugin API and versioned
> snapshots; or when a paying org asks for Bedrock, Vertex or Azure, in which case the fallback is a third backend for
> non-coding runs, never a replacement. Corrections recorded with this ruling: (a) the Codex read-only sandbox remains
> a live enforcement seam under ruling 101 despite R22's wording (the drift note under ruling 93 is stale and is
> replaced by PR 6); (b) `McpServerToolPolicy` and per-server `alwaysLoad` exist on the pinned Claude SDK and were
> never used.

`docs/domain/agents-and-runtime.md` header: a dated line "Updated 2026-09-11: ruling 173 (Cognipeer evaluation);
rulings 174 to 176 (PR 1 to PR 3 below) as they land." `docs/README.md`: same dated line.

**Tests.** None (docs only). **Exit.** Ruling merged; the `cognipeer-docs/` folder is referenced from it.
**Effort.** 0.5 day.

## 5. PR 1: `allowDangerouslySkipPermissions` and process-group kill

*(Implemented 2026-09-11 as ruling 174, with a changed mechanism the owner chose after a
spike of seven live Haiku runs on the pinned CLI. Claude Code runs each Bash command
`detached` (its own session), so a `&` child survives a normal finish, and a SIGKILLed CLI
leaves its running command and its stdio MCP servers alive. The group kill below reaches
only the MCP servers and would have failed this section's canary. Shipped instead: the
detached spawn and group kill as written, plus a `VIBERR_RUN_ID` marker on every run's
child env (Codex: `shell_environment_policy.set` and each stdio server's `env`), a sweep
by that marker when every run settles and at boot, and no Codex wrapper (no
`VIBERR_CODEX_WRAPPER`, no image change). The test for the option assertion lives in
`claude-runtime.server.test.ts` beside the `permissionPrompts` test, not in
`harness-hermeticity.server.test.ts`, which has no option assertion. The sketch's
`killProcessGroup` cleared its SIGKILL timer on the leader's exit, which would have spared
exactly the children the escalation exists for; the sweep re-scans instead.)*

**Why.** Two defects the assessment found on the way, independent of Cognipeer. First, the typings say
`allowDangerouslySkipPermissions` "must be set to `true` when using `permissionMode: 'bypassPermissions'`"
(`sdk.d.ts:1841-1845`), and Viberr never sets it (`app/server/runtimes/claude-runtime.server.ts:1118`). The SDK
defaults it to `false` and forwards it to the CLI (`sdk.mjs`, the `Ine=!1` default in the option destructuring);
live runs work today, so the pinned CLI does not enforce it yet, which makes this a forward-compatibility fix: the
day the CLI enforces the flag, every Viberr run would silently drop to `default` mode plus `permissionPrompts:
'none'` and deny every tool. Second, neither adapter kills a process group: the SDK's local spawn is not detached
(the only `detached: true` in `sdk.mjs` is the CLI's own bash-tool shell), so the abort ladder at
`claude-runtime.server.ts:988-1012` SIGTERMs the CLI and orphans its children, and the Codex leg only force-settles
the row (`codex-runtime.server.ts:1038-1056`). Viberr already solved the same problem for stdio MCP children with a
detached spawn and `process.kill(-pid)` (`app/server/org/resources.server.ts:930-958`, F20-2). The Cognipeer gain this
ports: cancellation that reaches every child, which the assessment rated as a Cognipeer weakness and found Viberr
does not fully have either.

**SDK facts.** `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess` (`sdk.d.ts:2278`) receives
`{ command, args, cwd, env, signal }`; the `signal` aborts only after the SDK's stdin-EOF plus roughly two-second grace
(`sdk.d.ts:2268-2276`), so passing it to `spawn()` is safe. When set, the SDK calls it instead of `spawnLocalProcess`
(`sdk.mjs`, the `Spawning Claude Code (custom)` branch) and reads `stdin`/`stdout`/`stderr` off the returned process.

**Changes.**

- `claude-runtime.server.ts:1118`: add `allowDangerouslySkipPermissions: spec.autonomous` beside `permissionMode`,
  with a comment citing `sdk.d.ts:1841-1845` and this PR's ruling.
- `claude-runtime.server.ts`, option assembly: add `spawnClaudeCodeProcess` from a new module
  `app/server/runtimes/claude-spawn.server.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";

/** Ruling 174: the CLI leads its own process group so an abort reaches every
 *  child it forked (a `npm test` still running when Stop was pressed). */
export function spawnClaudeCodeDetached(options: {
  command: string; args: string[]; cwd?: string; env?: Record<string, string>; signal?: AbortSignal;
}): ChildProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    signal: options.signal,
    killSignal: "SIGTERM",
  });
  return child;
}

/** SIGTERM the group, then SIGKILL it after `graceMs` if still alive. */
export function killProcessGroup(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (!pid) { child.kill("SIGTERM"); return; }
  try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  const t = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, graceMs);
  t.unref?.();
  child.once("exit", () => clearTimeout(t));
}
```

  The `ChildProcess` satisfies the SDK's `SpawnedProcess` shape (stdin, stdout, stderr, `kill`, `on('exit')`,
  `killed`, `exitCode`); confirm the exact interface at `sdk.d.ts` (grep `SpawnedProcess`) when writing it.
- `claude-runtime.server.ts:988-1012` (`armForcedStop`): after `abortController.abort()`, call
  `killProcessGroup(child, INTERRUPT_ABORT_GRACE_MS)` on the process the spawn function captured for this run (keep
  it on the run's closure, never on module state, so concurrent runs cannot cross). The SDK's own SIGTERM through the
  forwarded signal still happens; the group kill is the addition.
- `codex-runtime.server.ts` (D1, recommended (a)): pass `codexPathOverride` pointing at a wrapper shipped in the
  image (`Dockerfile`: copy `scripts/viberr-codex-wrapper.sh` to `/usr/local/bin/viberr-codex`). The wrapper:
  `setsid` the real binary with the same argv, forward SIGTERM to the group, sleep the grace, SIGKILL the group.
  The adapter's `INTERRUPT_SETTLE_GRACE_MS` path stays as the row-level backstop. In development (no image) the
  override is unset and behaviour is unchanged; the wrapper path is read from the validated env
  (`VIBERR_CODEX_WRAPPER`, declared in `app/server/config/env.server.ts` and `.env.example`, gated by
  `env.server.test.ts`).

**Schema and config.** One new optional env key (`VIBERR_CODEX_WRAPPER`); no DB change.

**Tests (no `vi.mock`).** `harness-hermeticity.server.test.ts`: the option assertion gains
`allowDangerouslySkipPermissions: true` for an autonomous spec and absent for a non-autonomous one, through the
existing `claudeQueryFn` seam that records options. `claude-runtime.server.test.ts`: a fake spawn function returning
an `EventEmitter`-backed stub with a `pid`, asserting that the forced-stop ladder calls `process.kill` with the
negative pid (spy the module function through the injected deps, not a module mock) and clears the SIGKILL timer on
`exit`. `codex-runtime.server.test.ts`: `codexPathOverride` appears in the `Codex` constructor options when the env
key is set, absent otherwise (the `codexFactory` seam already records constructor options). A shell test for the
wrapper is optional; a canary covers it.

**Docs.** `docs/domain/agents-and-runtime.md` §2.4 (Claude timers: "abort tears down the process group") and §2.5
(Codex: the wrapper and what it guarantees); `docs/operations/deployment.md` (the wrapper is in the image);
`docs/operations/configuration.md` (`VIBERR_CODEX_WRAPPER`).

**Ruling (new, 174).** "Run adapters own the child's process group. A Claude run is spawned detached through
`spawnClaudeCodeProcess` and an abort signals the whole group (SIGTERM, then SIGKILL after the abort grace); a Codex
run is started through the image's wrapper, which does the same for the CLI's children. A settled run leaves no
live process in the workspace. `allowDangerouslySkipPermissions` accompanies `bypassPermissions` on every autonomous
Claude run because the SDK declares it required."

**Exit criteria.** Option assertion green; timer tests prove the group kill and the timer clean-up; a canary run
whose Bash tool started `sleep 600 &` is stopped from the UI and `ps` shows no survivor within the abort grace.

**Canary.** A throwaway task on a Claude Developer profile with a prompt that runs a background sleep; press Stop.
Same on a Codex profile in the compose image.

**Effort.** 2 to 3 days.

## 6. PR 2: org MCP tools grant-gated by name (close P13-KM-04)

**Why.** Today an org MCP server is granted whole (ruling 39) and its tools sit outside the capability matrix; the
only guard against a read-only reviewer merging a PR through a GitHub MCP is a system-prompt paragraph
(`operator-run.server.ts:3449-3463`; `specialist-run.server.ts:2712-2728`; `app/shared/capabilities.ts:109`). The
Cognipeer gain this ports is "confinement by absence" for tools the run must not have; the pinned Claude SDK already
offers the mechanism: `McpServerToolPolicy { name, permission_policy: 'always_deny' }` on HTTP and SSE server configs
(`sdk.d.ts:1077, 1165-1168, 1196-1200`) and, for every transport, `disallowedTools` entries of the form
`mcp__<server>__<tool>` (the convention the Codex naming transform already documents,
`codex-runtime.server.ts:173-174`).

**SDK facts.** `McpHttpServerConfig.tools?: McpServerToolPolicy[]` and the same on SSE and SDK configs
(`sdk.d.ts:1077, 1196`); `McpStdioServerConfig` has no `tools` field (`sdk.d.ts:1208-1224`), so stdio denies go
through `disallowedTools`. A deny rule binds under `bypassPermissions` ("auto-approves every tool call (except
explicit deny rules)", `sdk.mjs`). `withMcpAutoApproval` (`app/server/runtimes/run-service.server.ts:743`) must keep
its allow markers so the D4 stall class cannot return.

**Changes (D2 recommended: discovery proposes, admin decides).**

- `db/migrations/0001_baseline.sql`, table `org_mcp_servers`: add `tool_policy_json TEXT NOT NULL DEFAULT '[]'`,
  a JSON array of `{ name: string, gate: "repo-write" }` (one gate kind for now; the key is the capability id it
  rides on, `execute-code-or-write-repo`). Recreate the local projection per contributing §4; update
  `docs/architecture/data-model.md`.
- `app/server/org/resources.server.ts`: read and validate the column (Zod) in `listMcpServers` / `getMcpServer`;
  `saveMcpServer` accepts the list; after a successful stdio probe, `discoverStdioMcpTools` results are offered to the
  editor as suggestions with the heuristic pre-ticked (`create|delete|merge|push|update|write|remove` in the tool
  name), never persisted without a save.
- MCP server editor (`app/features/org-settings/`, the existing MCP form): a "Write tools" section listing discovered
  tools with checkboxes, plus a free-text add for HTTP servers the probe cannot enumerate.
- `app/server/tasks/specialist-mcp.server.ts` (`resolveSpecialistMcpServersDetailed`): accept the run's grant modes
  and, when `execute-code-or-write-repo` is withheld (`isWithheld`, `specialist-tool-policy.ts:135`), attach
  `tools: [{ name, permission_policy: "always_deny" }]` to HTTP configs and return the stdio names as
  `deniedToolNames: ["mcp__<server>__<tool>"]` for the caller to fold into `spec.disallowedTools`. The operator path
  (`operator-run.server.ts`, its MCP mount) does the same with the operator's own posture (always withheld: the
  operator never writes).
- `run-service.server.ts:890-970`: fold `deniedToolNames` into the denylist after `withMcpAutoApproval`.
- Codex: verify in the pinned CLI's config schema whether `mcp_servers.<name>.enabled_tools` /
  `disabled_tools` exist (recent Codex releases added per-server tool filters; confirm against
  `node_modules/@openai/codex-sdk` and the bundled CLI). If yes, translate the same list in `codexMcpServers`
  (`codex-runtime.server.ts:183-216`); if not, keep the prompt paragraph on Codex and say so in the capability
  matrix (ruling 101 parity disclosure).
- Retire the two prompt paragraphs on Claude only where an enforced list exists; keep them when the server has no
  policy (the disclosure stays honest).
- `app/shared/capabilities.ts`: the capability-matrix copy for `execute-code-or-write-repo` gains "also denies the
  org MCP tools the admin marked as write tools".

**Audit and events.** `org.mcp.tool_policy.changed` audit row on save (actor, server, before/after names);
the run-inputs disclosure (`RUN_INPUTS_TAG`) lists denied MCP tool names so the console shows what was withheld.

**Tests.** Route harness for the editor save (round trip of the JSON column, validation of names); a
`specialist-mcp.server.test.ts` case that a withheld grant yields the HTTP `tools` policy and the stdio name list;
`run-service` test that the names reach `spec.disallowedTools` (fake runtime records the spec); `claude-runtime`
option test that `mcpServers.<name>.tools` survives to the SDK options unchanged.

**Docs.** `docs/domain/agents-and-runtime.md` §4.3 (capability enforcement table gains the MCP row per transport);
`docs/domain/auth-and-rbac.md` or the org-settings page for the editor field; `docs/architecture/decisions.md`
ruling 39 amendment.

**Ruling (amend 39, new 176** — renumbered from 175 on 2026-09-11: PR 3 landed first and took 175, owner: next free
number). "MCP grants stay outside the capability matrix, but an admin may mark a server's
write tools; those names are denied on runs whose repo-write grant is withheld, through the SDK's per-tool policy on
HTTP servers and by name on stdio servers. Viberr still makes no claim about tools the admin has not marked."

**Exit criteria.** A withheld org tool is absent from a live run's `system.init` tool list (the console's init line
lists tools); the prompt paragraph is gone on that run; a run with the grant sees the tool.

**Canary.** A reviewer profile with a GitHub-style stdio MCP whose `create_pull_request` is marked; the run's init
line omits it.

**Effort.** 3 to 5 days (the editor is most of it).

## 7. PR 3: per-run cost cap and exact usage

**Why.** Cognipeer's `maxCostUsd` budget and its per-call `TokenUsage` were two of its clearest advantages; the
pinned Claude SDK has both under other names and Viberr uses neither: `maxBudgetUsd` ends a query with an
`error_max_budget_usd` result (`sdk.d.ts:1773-1777, 4959`), and `result.modelUsage` is "the correct field for
token/cost accounting", covering subagents, sidechains and compaction, while `result.usage` is "MAIN AGENT LOOP
ONLY" (`sdk.d.ts:4970-4976`). Viberr folds `usage` and `total_cost_usd` (`app/server/runtimes/wire-format.server.ts`,
result fold; `docs/domain/agents-and-runtime.md` §3.1). No cost cap exists anywhere in `app/server`.

**SDK facts.** `ModelUsage { inputTokens, outputTokens, thinkingTokens?, cacheReadInputTokens,
cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens }` per model id
(`sdk.d.ts:1307-1319`); cumulative across turns in a query, resumed sessions start fresh, crash results may be
zeroed (`sdk.d.ts:4966-4976`). `SDKResultError.subtype` includes `error_max_budget_usd` (`sdk.d.ts:4959`).

**Changes (D4 decided: instance ceiling only, default none).**

- Instance ceiling: `app/server/settings/instance-settings.server.ts` gains `maxRunSpendUsd` next to
  `maxConcurrentRuns` (`:76-109`, same get/set/validate pattern: a positive number with two decimals, or unset),
  edited on Org settings beside the concurrency field with the copy "Max spend per Claude run, USD" and an inline
  note "Codex has no budget option; the idle timer and max turns still apply". No profile field and no file-format
  change.
- `RunSpec` (`app/server/runtimes/adapter.server.ts`): new `maxSpendUsd?: number`, set by every run builder
  (operator, specialist, controller, resume, scheduled, recovery) from the instance setting when it is set. `claude-runtime.server.ts` option assembly: `if (spec.maxSpendUsd)
  options.maxBudgetUsd = spec.maxSpendUsd;`. The Codex adapter ignores it and the run-inputs disclosure says so.
- Failure kind: `app/shared/run-failure.ts:15` gains `"max_budget"`; the Claude classifier
  (`claude-runtime.server.ts:716-932`) maps result subtype `error_max_budget_usd` to tag `run·error·max_budget` with
  a typed `failure` record; `app/server/tasks/run-failure-remedy.server.ts` and `agent-reply.server.ts:584-645` get
  the packet copy ("The run was cut off by its spending cap of $X after $Y. Raise the cap on the profile or the
  instance and re-run."); the run strip and Insights render the kind like `max_turns`.
- Usage fold: `wire-format.server.ts` result fold reads `modelUsage` when present: `input_tokens = Σ(inputTokens +
  cacheReadInputTokens + cacheCreationInputTokens)`, `cached_input_tokens = Σ cacheReadInputTokens`,
  `output_tokens = Σ outputTokens`, `total_cost_usd = Σ costUSD`; falls back to `usage` and `total_cost_usd` when
  `modelUsage` is absent or empty (crash results). Column semantics in §3.1 are unchanged (input includes cache
  reads and writes); `usage_final` semantics unchanged; the F35-1 live estimate stays. No new column: the per-model
  breakdown goes into the result line's display facts only.

**Schema and config.** `instance_settings` is a key-value table: no DDL, no file-format change, no env key.

**Tests.** `claude-runtime.server.test.ts`: a fake result envelope with `subtype: "error_max_budget_usd"` classifies
to `max_budget`; a result carrying `modelUsage` for two models folds to the summed columns and cost; a result without
`modelUsage` falls back. Route harness: org settings saves the
ceiling and refuses zero, negatives and more than two decimals. Fake-runtime spec assertion: `maxSpendUsd` reaches
the spec on every run builder when the setting is set and is absent when it is not.

**Docs.** `docs/domain/agents-and-runtime.md` §2.4 (option and failure kind), §3.1 (token columns now from
`modelUsage`; a dated correction note that earlier rows folded `usage`), §3.5 (failure kinds);
`docs/domain/auth-and-rbac.md` (the org-settings field); `docs/domain/task-lifecycle.md` packet copy;
`docs/product/glossary.md` (failure kinds).

**Ruling (new, 175, extending 130(a)** — renumbered from 176 on 2026-09-11: this PR landed before PR 2). "A Claude run carries the instance's spending cap when one is set; the SDK's `error_max_budget_usd` result is the `max_budget` failure kind and its packet names
the cap and the spend. Token and cost columns are folded from `modelUsage`, which covers subagent and compaction
calls, with `usage` as the fallback for results that lack it."

**Exit criteria.** A canary run with a one-cent cap ends as `max_budget` with the packet; a normal run's strip
figure matches `Σ modelUsage`; Insights sums are unchanged for old rows.

**Canary.** Set the instance ceiling to 0.01, run a throwaway task on a Claude Developer profile, then clear it.

**Effort.** 2 to 3 days.

## 8. PR 4: `alwaysLoad`, once-only `report_outcome`, optional wall-clock cap

Three commits, each revertible alone.

**(a) `alwaysLoad` on the four in-process servers.** Why: the SDK defers MCP tools behind ToolSearch by default
("tools are deferred when tool search is enabled", `sdk.d.ts:1082-1086`), so the operator's first useful call is a
ToolSearch round trip to find `mcp__viberr__*`; Cognipeer's in-process tools have no such hop. The SDK offers
per-server `alwaysLoad` on SDK-server configs (`sdk.d.ts:1201-1205`) and per tool on `tool()` (`sdk.d.ts:527-531`);
the runtime sets `_meta["anthropic/alwaysLoad"]` on each registered tool (`sdk.mjs`). Side effect: startup blocks
until the server is connected, capped at five seconds; in-process servers connect instantly. Change: pass
`alwaysLoad: true` in the four `createSdkMcpServer` configs (`app/server/tasks/operator-toolkit.server.ts:705-710`;
`app/server/tasks/agent-toolkit.server.ts:538-545`; `app/server/controller/controller-toolkit.server.ts:2350-2355`;
`app/server/controller/controller-ops-mcp.server.ts:444-449`), not on org MCP servers (they may be slow and large).
Measure first: on one operator turn and one controller turn, count `tool_use` envelopes whose name is `ToolSearch` in
`run_log_lines` before and after; keep the change only if the count drops and turn-1 prompt size does not grow past
what the run strip shows as acceptable. Test: option assertion that the SDK server config carries `alwaysLoad`.
Docs: `agents-and-runtime.md` §2.4.

**(b) Once-only `report_outcome`.** Why: `stageOutcome` stores the envelope verbatim and a second call silently
replaces the first (`app/server/tasks/agent-outcome.server.ts:286`; `agent-toolkit.server.ts`, the `[staged]`
reply); `takeStagedOutcome` consumes once (`:316-322`). Cognipeer's control-plane tools are single-shot by design.
Change: in the toolkit, if an outcome is already staged for `outcomeKey`, answer `[already staged] Your outcome was
recorded once; this call was ignored. Finish with your full findings.` and do not overwrite; write an audit fact
`task.agent.outcome_duplicate` (run id, count). Test through the toolkit builder with a test DB: two calls, one
staged row, the second reply text. Docs: `agents-and-runtime.md` §4 (outcome transport).

**(c) Wall-clock cap (D5 decided: deferred, kept here for the record).** If ever wanted: `VIBERR_RUN_MAX_WALLCLOCK_MS` (one key, both
backends, default off) declared in the env schema and `.env.example`; a timer armed at start beside the idle timer
that runs the same forced-stop ladder and settles `error` with a new `wall_clock` failure kind and packet copy;
A8 amended to say the idle timer is one of two guards. Test: the existing timer harness with a short cap.

**Effort.** 1 to 2 days for (a) and (b); add 1 day for (c).

## 9. PR 5: spike-gated `PreToolUse` deny-with-reason

**Why.** Viberr's argument-level confinement is the `Bash(<prefix>:*)` denylist
(`app/server/tasks/specialist-tool-policy.ts:61-79`; `claude-runtime.server.ts:299-301`): exact prefixes such as
`git push`, `git commit`, `gh pr create`. A command that reaches the same effect through a different shape
(`cd repo && git push`, `git -C repo push`, a script that pushes) slips past, which is the VIB-30 class the
denylist was added for. Cognipeer's `needsApproval` predicate decides per call from the parsed arguments; the
pinned Claude SDK has the equivalent: a `PreToolUse` hook that sees `tool_input` and returns `permissionDecision:
'deny'` with a `permissionDecisionReason` (`sdk.d.ts:1595, 866-870, 2570-2583`). The SDK's own guidance under
`bypassPermissions` is "To gate every tool call, use a PreToolUse hook instead" (`sdk.mjs`), which is the strongest
available evidence that the hook binds in Viberr's mode; the spike confirms it.

**What the spike must answer.** (1) In Viberr's configuration (`bypassPermissions`, `permissionPrompts: 'none'`,
`disallowedTools` set), does a `PreToolUse` deny stop the tool and put the reason in the tool result the model sees?
(2) Ordering: for a command an exact specifier already denies, does the deny rule fire before the hook ("deny-rule
overrides of hook allow/ask decisions", `sdk.d.ts:4853`)? Expected: yes, so the hook only matters for the shapes the
specifier misses. (3) Console: hook denies are not covered by `system/permission_denied` frames (`sdk.d.ts:4853`),
so which envelope carries the deny, and can `wire-format.server.ts:373-383` project it? Plan: the hook callback
itself emits a synthetic `err` line tagged `hook_denied` through the run's `onLine` (the Codex adapter already
fabricates envelopes, `codex-runtime.server.ts:815-833`), so visibility does not depend on the SDK's frames.

**Spike harness.** A scripted live canary on a throwaway task (a Developer with `commit-push-branch` withheld,
prompt "run `cd . && git push`"), with the hook installed behind a temporary env flag; success is a denied tool
result with the reason and no push. Half a day.

**PR if the spike passes.** `claude-runtime.server.ts` option assembly: `options.hooks = { PreToolUse: [{ matcher:
"Bash", hooks: [denyByPolicy] }] }` where `denyByPolicy` parses `tool_input.command`, normalises `cd … &&`,
`git -C`, `sh -c` wrappers, and matches the same prefixes `resolveSpecialistDisallowedTools` produced for this run
(`specialist-tool-policy.ts:149-160`), returning `{ hookSpecificOutput: { hookEventName: "PreToolUse",
permissionDecision: "deny", permissionDecisionReason: "Withheld by capability policy: commit-push-branch is not
granted on this run." } }`. `disallowedTools` stays the binding fence; the hook is the reason and the coverage for
missed shapes. Tests: unit tests for the command normaliser; an option assertion that the hook is present only when
the run has argv denies; a `claudeQueryFn` fake that invokes the hook and asserts the deny output.

**Docs and ruling.** `agents-and-runtime.md` §2.4 and §4.3; ruling 101(e) amendment: "argument-level denies carry
a model-visible reason and cover wrapped command shapes; the denylist remains the fence." No new ruling if the spike
fails; record the failure as a dated note under ruling 101 instead.

**Exit criteria.** The canary shows the reason in the console and no push; the option assertion is green; the
normaliser has cases for `cd`, `git -C`, `sh -c`, `&&` and `;` chains.

**Effort.** 0.5 day spike; 1 to 2.5 days PR.

## 10. PR 6: hygiene

Exact replacements:

- `app/server/runtimes/adapter.server.ts:93-99` (`attachmentsWritableDir` docstring says "R22: no run is read-only
  anymore"): replace with "ruling 101 keeps Codex read-only for a run whose repo-write grant is withheld; the
  attachments dir is the one carve-out (ruling 109) and rides `workspace-write`".
- `adapter.server.ts:228` (`interrupt(): "Send SIGINT"`): replace with "cooperative interrupt, then the adapter's
  abort ladder tears the process group down (ruling 174)".
- `app/server/controller/controller-run.server.ts:110` ("FRESH provider session"): replace with the actual
  behaviour read at `:583-624` (the prior session is resumed regardless of that run's state).
- `docs/architecture/decisions.md:1327-1330` (drift note under ruling 93): replace with "R22 removed the OS sandbox
  as the confinement model; ruling 101 later restored `read-only` for write-withheld Codex runs as a live seam
  (`codex-runtime.server.ts:436-464`). Both stand."
- Ruling 109: append the watch item "the Codex CLI's `permissions.rs` per-path profile would express read-only plus
  a writable attachments dir; revisit when the SDK surfaces it".
- `docs/domain/agents-and-runtime.md` §2.5: the same sandbox sentence, corrected.

Docs tests: `app/shared/docs/runbook-db-read.test.ts` pins runbook passages, not these; `file-formats-sync` and
`prd-sync` are untouched. **Effort.** 0.5 day.

## 11. Cross-cutting rules for every PR

- Five gates green; `npm run e2e` when a PR touches the image (PR 1) or the org-settings UI (PR 2, PR 3).
- No `vi.mock`; use the seams named above (`claudeQueryFn`, `codexFactory`, `configureRunServiceForTests`, the route
  harness, real file writers).
- Every raw env read declared in `app/server/config/env.server.ts` and `.env.example`.
- Secrets never in logs: none of these PRs adds a secret path; PR 2's tool names are not secrets.
- Docs in the same PR with a dated update line; owner decisions as numbered rulings.

## 12. Not ported, and why

- `state.plan` / durable planning: the operator is one-shot by design (ruling 152(a)); the task file is the plan.
- `needsApproval` pauses and `ask_user_question`: rulings 100 and 151 keep recommendation cards and packets
  server-side without pausing the model; `ask_human` already ends the run with a report (ruling 33).
- Two-axis tool retention: the vendor CLI owns compaction, and Viberr's tool results are already capped by hand.
- Scripted-mock testing: `test-support/fake-runtime.ts` and the injected `claudeQueryFn` / `codexFactory` seams
  already give hermetic tests without a subprocess.
- Provider breadth (Bedrock, Vertex, Azure, Ollama): no recorded demand; the reopen trigger in P0 covers it.

## 13. Watch-list and reopen triggers

Recorded in ruling 173 (section 4). Review on demand, or when a Cognipeer minor ships, whichever comes first.

## 14. Evidence index

Claude SDK typings (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`): 527-531, 854-880, 866-870,
1068-1092, 1160-1225, 1307-1319, 1595, 1768-1780, 1822-1860, 2250-2290, 2570-2583, 4850-4870, 4940-5045.
Claude SDK runtime (`sdk.mjs`): the option destructuring with `allowDangerouslySkipPermissions:Ine=!1`; the
`bypassPermissions` guidance string naming `PreToolUse`; the `Spawning Claude Code (custom)` branch; the
`anthropic/alwaysLoad` meta registration; the single `detached:!0` (the bash-tool shell).
Codex SDK: `dist/index.js:263-276, 309-315`; `dist/index.d.ts:219`.
Viberr: `app/server/runtimes/claude-runtime.server.ts:200-240, 299-301, 716-932, 985-1035, 1106-1260`;
`app/server/runtimes/codex-runtime.server.ts:173-174, 183-216, 436-464, 483-503, 815-833, 1038-1056`;
`app/server/runtimes/adapter.server.ts:93-99, 228`; `app/server/runtimes/run-service.server.ts:743, 890-970`;
`app/server/runtimes/wire-format.server.ts:166-190, 355-400`; `app/server/org/resources.server.ts:930-958`;
`app/server/tasks/specialist-tool-policy.ts:61-79, 121-160`; `app/server/tasks/specialist-mcp.server.ts`;
`app/server/tasks/agent-outcome.server.ts:286-322`; `app/server/tasks/agent-toolkit.server.ts:538-545`;
`app/server/tasks/operator-toolkit.server.ts:705-710`; `app/server/controller/controller-toolkit.server.ts:2350-2355`;
`app/server/controller/controller-ops-mcp.server.ts:444-449`; `app/server/controller/controller-run.server.ts:110,
583-624`; `app/server/runtimes/operator-run.server.ts:3449-3463`; `app/server/tasks/specialist-run.server.ts:2712-2728`;
`app/server/files/agent-profile-file.server.ts:42-53, 97-99`; `app/server/settings/instance-settings.server.ts:76-109`;
`app/shared/run-failure.ts:15`; `app/shared/capabilities.ts:109`; `app/server/config/env.server.ts:142-144`;
`docs/architecture/decisions.md:1292-1330, 1786-1819, 1971-1973`; `docs/development/contributing.md` §4, §5, §7.
