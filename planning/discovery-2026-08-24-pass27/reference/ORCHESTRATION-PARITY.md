# Run orchestration + Codex/Claude backend parity + context-resource mounting

Reference doc for implementers. Every claim below was checked against the code, not the
comments — though the comments in this codebase are unusually reliable and are quoted
where they state a ruling or a known gap.

Scope: `app/server/runtimes/{run-service,adapter,runtime-registry,claude-runtime,
claude-config,codex-runtime,codex-config,skill-mount,wire-format,model-availability,
model-catalog}.server.ts`, `app/server/tasks/{specialist-run,specialist-mcp,
specialist-browser-mcp,specialist-tool-policy}.{server.,}ts`, `app/shared/capabilities.ts`,
`app/server/files/kb-injection.server.ts`, `app/server/settings/instance-settings.server.ts`,
`db/migrations/0001_baseline.sql`.

---

## 1. The adapter abstraction

`RuntimeAdapter` (`app/server/runtimes/adapter.server.ts:234-238`) is two members:

```ts
interface RuntimeAdapter {
  readonly backend: RunBackend;           // "claude" | "codex"
  start(spec: RunSpec, cb: RunCallbacks): RunHandle;
}
```

That's the whole surface `run-service.server.ts` depends on. Persistence, concurrency,
audit, model substitution, session continuity, and completion callbacks all live in
`run-service.server.ts` — "the only module routes call for runtime work"
(`run-service.server.ts:72-85`). Adapters never touch the DB, files, or the broker directly
(`adapter.server.ts:12-17`): they call back through `RunCallbacks`, and
`run-service.launch()` wires those callbacks to persistence (`run-service.server.ts:1320-1450`).

`RunSpec` (`adapter.server.ts:50-133`) is the one input shape both backends receive, built
once per run by `startRun`. Which backend acts on which field:

| Field | Claude | Codex |
|---|---|---|
| `runId, projectSlug, taskKey, threadId, role, kind, model, prompt, workdir, resumeSessionId, autonomous, env` | used | used |
| `systemPrompt` | `options.systemPrompt` (append-preset for specialists, raw replace for operator) | `config.developer_instructions` |
| `mcpServers` | passed through as-is, incl. in-process `{type:"sdk"}` servers | translated to `--config mcp_servers.*`; `sdk` entries dropped |
| `allowedTools` | auto-approval allowlist | **ignored** — no field reads it |
| `disallowedTools` | real deny list, binds under bypassPermissions | **ignored** — no field reads it |
| `skills` | SDK native skills filter | **ignored** — Codex has no skills channel |
| `repoWriteWithheld` | not read directly (denylist already encodes it) | **ignored** — advisory, no consumer |
| `webSearchWithheld` | not read directly (denylist already encodes it) | `threadOptions.webSearchMode = "disabled"` |
| `outputSchema` | not read (in-process toolkit instead) | `turnOptions.outputSchema` |
| `attachmentsWritableDir` | irrelevant (bypassPermissions can already write) | `threadOptions.additionalDirectories` under `workspace-write` |

`RunMcpServerDeclaration` (`adapter.server.ts:29-47`) is deliberately *wider* than what a
governed caller can produce (`RunMcpServers`, lines 24-27): the extra
`Record<string, JsonValue>` arm exists only so each adapter's tolerance tests can hand it a
malformed config and prove the backend degrades safely (Codex zod-drops it; Claude forwards
it untouched). No production caller uses that arm.

**Wire-format normalization.** `projectEnvelope(backend, raw, occurredAtIso)`
(`wire-format.server.ts:237-250`) turns a Claude `SDKMessage` or a Codex `ThreadEvent` into
one shape: `{display: LogLine | null, facts: EnvelopeFacts}`. `EnvelopeFacts`
(`wire-format.server.ts:16-33`) is the fold target — `sessionId`, `model`,
`usage{input,cached,output}`, `costUsd` (**Claude only** — Codex's `turn.completed`
projector never sets it, lines 384-397 vs. 301-334), `turns`, `isError`, `isResult`
(Claude-only). Every decode schema `.catch()`s per-field (lines 52-117), citing "runtime-
adapters.md gotcha 9" (both vendors add envelope fields between minor versions); an
unrecognized `type` renders as a dim `meta` line with the raw JSON rather than throwing or
dropping (`unknownEnvelope`, lines 252-255).

Both adapters derive one shared **phase** vocabulary from the *projected* line, not the wire
format: `phaseStepForLine()` (`adapter.server.ts:209-224`) reads `display.ev === "tool"` and
formats `"<name> · <text>"`, so a Claude `tool_use` block and a Codex `command_execution`/
`mcp_tool_call`/`web_search` item render identically on the live strip (`RUN_PHASE`:
`preparing/starting/working/finishing`, lines 185-190; throttled to 1 write/sec except on an
actual change, `run-service.server.ts:1368-1399`). `EmittedLine` (`adapter.server.ts:136-145`)
— `{raw, display, facts, occurredAt}` — is what each adapter hands `cb.onLine`; the sink
persists `raw` verbatim and `display` as `display_json`. Nothing downstream ever re-parses
the vendor envelope.

---

## 2. Claude backend

Files: `claude-runtime.server.ts` (adapter), `claude-config.server.ts` (paths).

**SDK.** `@anthropic-ai/claude-agent-sdk`'s `query()` returns an async generator of
`SDKMessage` (lines 17-35). The prompt is a one-message async iterable (`singlePrompt`, line
337) specifically so `Query.interrupt()` is available (streaming-input mode only, per SDK
docs). Resume: `options.resume = <sessionId>`.

**Auth.** `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`), or
`VIBERR_CLAUDE_USE_CLI_AUTH=1` for a machine-logged-in CLI (`runtime-registry.server.ts:280-286`).
The CLI-auth path is disclosed but not fully verifiable on macOS: on darwin the CLI keeps its
OAuth credential in the Keychain rather than a file, so `claudeCliAuthDiagnostics()`
(`runtime-registry.server.ts:234-273`) reports a config-dir-exists-no-file state as
`verification: "presence"` — weaker than `"file"`, and said so.

**Config dir / transcripts.** `resolveClaudeConfigDir()` (`claude-config.server.ts:25-32`):
explicit `CLAUDE_CONFIG_DIR` wins; CLI-auth mode uses real `~/.claude`; else app-owned
`<dataRoot>/runtimes/claude-home`. Transcripts land at `<dir>/projects/<cwd-encoded>/
<sid>.jsonl` — the same resolver the adapter and `session-export.server.ts` both call, so
"download session" can't 404 against a directory the runtime never wrote to.

**Spawn env.** `claudeSpawnEnv()` (`runtime-registry.server.ts:509-519`) strips every
credential-shaped var (`CREDENTIAL_ENV_RE`, lines 453-454) out of `process.env`, keeps
PATH/HOME/locale/proxy, re-adds only the selected credential + `CLAUDE_CONFIG_DIR`. This
matters because the SDK **replaces** the child env wholesale when `options.env` is set
(lines 495-508) — unfiltered, this used to leak the server's session-signing secret, the
GitHub PAT, and every provider key to the spawned agent (F10-02).

**Model & effort.** `resolveClaudeModel()` (lines 119-128): family aliases (sonnet/opus/
haiku) and dated ids (`claude-*`+digit) pass through; else `undefined` → SDK default.
`resolveClaudeEffort()` (lines 142-153) narrows to `low|medium|high|xhigh|max`; unknown →
`undefined`. Catalog (`model-catalog.server.ts`) is curated by default (`CLAUDE_MODELS`,
lines 73-95), enhanced live via `supportedModels()` when available, 10-min TTL cache
(`getModelCatalog`, lines 545-581) — never blocking, falls back to curated on any failure.

**Isolation posture**, set on every run (`claude-runtime.server.ts:668-716`):
- `permissionMode`: `bypassPermissions` (autonomous) or `default`.
- `maxTurns`: `resolveMaxTurns()`, default 2000 (`VIBERR_CLAUDE_MAX_TURNS`) — a **runaway
  guard**, not a work budget; the old hard-50 cut off a real delivery mid-flight.
- `settingSources`: `[]` with no granted skill mounted (no filesystem settings tier at all —
  never `'user'`/`'local'`); `['project']` (scoped to the checkout root) once a skill mounts.
- `skills`: `[]` or the mounted names — a **context filter, not a sandbox**: `[]` still lists
  the SDK's ~16 bundled skills (docker-verified live, lines 688-694), which is why `Skill`
  stays denied whenever nothing mounted (line 775-777).
- `plugins: []` always (closes the plugin-marketplace leak, F13).
- `strictMcpConfig: true` always — ignores repo `.mcp.json` and user/plugin MCP (R18-3).
- `managedSettings.claudeMdExcludes` only when a skill mounted — **flagged unverified in the
  code itself**, see §7.8.

**Tool allow/deny.** `allowedTools` is approval-only — doesn't remove anything from context,
just skips the permission prompt (lines 60-64). `withMcpAutoApproval()`
(`run-service.server.ts:589-601`) auto-adds `mcp__<name>` for every mounted server the caller
didn't name, since every run is bypass/autonomous and a missing entry used to stall a
headless run on an unanswerable prompt (D4).

`disallowedTools` is the real fence — binds even under bypass. Assembled at
`claude-runtime.server.ts:769-782` from, in order: (1) `BASE_DENIED_BUILTINS` (lines 264-298,
every run — the `Task*` subagent family, `Workflow`, `Cron*`/`RemoteTrigger`/`Monitor`,
`PushNotification`/`SendMessage`, `DesignSync`, `EnterWorktree`/`ExitWorktree`, `Skill` unless
mounted); (2) `OPERATOR_READ_ONLY_DENIED_TOOLS` (lines 200-208, `kind==="operator"`:
Bash/Edit/MultiEdit/Write/NotebookEdit — one shared source with `operator-run.server.ts`,
F21-3); (3) `SUPPORTING_DENIED_BUILTINS` (lines 223-236, `kind==="reviewer"`: file-write +
`git commit/push/checkout-b/switch-c` + `gh pr create/merge`); (4) `spec.disallowedTools`,
the capability-derived rules from `specialist-tool-policy.ts` (§4).

**MCP.** `options.mcpServers = spec.mcpServers` passed through unmodified (line 755) — Claude
is the only backend that accepts in-process SDK server *instances*
(`createSdkMcpServer(...)`), which is how the operator's `viberr` toolkit
(`operator-toolkit.server.ts:697`) and specialist/reviewer `viberr_agent` toolkit
(`agent-toolkit.server.ts:503`) mount (§5).

**Skills.** Native mount (§5.1) plus `settingSources:['project']` + `skills:[names]` —
progressive disclosure: the model sees each mounted skill's normalized name+description up
front, full body loads only on invocation.

**cwd.** `options.cwd = spec.workdir` — always the per-task (or per-supporting-engagement
isolated) checkout; never the bare task dir for a real backend (`specialist-run.server.ts:1355-1358`).

**Failures.** `classifyClaudeError()` (lines 478-541): `session_missing | quota | auth |
unknown`, always through `redactProviderText()` before logging/persisting.

---

## 3. Codex backend

Files: `codex-runtime.server.ts` (adapter), `codex-config.server.ts` (home/paths).

**SDK.** `@openai/codex-sdk`, pinned-verified `CODEX_SDK_VERIFIED_VERSION = "0.146.0"`
(line 64, a test asserts it against `package.json`). `new Codex()` → `startThread`/
`resumeThread` → `thread.runStreamed(prompt, {signal, outputSchema?})` → async `events`.
Interrupt: `AbortController.abort()`.

**Auth.** `CODEX_ACCESS_TOKEN` (ChatGPT subscription), `CODEX_API_KEY`/`OPENAI_API_KEY`
(platform), or `VIBERR_CODEX_USE_CLI_AUTH=1` for a cached `codex login`. Fully
file-verifiable (`codexCliAuthDiagnostics()`, `runtime-registry.server.ts:137-168`, checks
`existsSync` on the literal `auth.json`) — unlike the Claude Keychain case above.

**CODEX_HOME — the actual isolation boundary.** `resolveCodexHome()`
(`codex-config.server.ts:67-73`) always resolves to an app-owned
`<dataRoot>/runtimes/codex-home`, never the operator's personal `~/.codex`. Why a directory
swap and not a config override (docstring, lines 13-45): the CLI merges `--config`
overrides into whatever `config.toml` the home declares, per dotted leaf key, not by
replacing a table — live-verified against codex-cli 0.144.6 (a probe MCP server declared via
`--config` showed up *alongside* the host's own MCP servers, not instead of them).
`prepareCodexHome()` (`codex-config.server.ts:129-176`) mirrors `auth.json` into the run home
(symlink preferred) **per run** via `selectAdapter` (`runtime-registry.server.ts:598-606`),
not once per process, so a login dropped in mid-process reaches the next run with no restart
(P14-RT-05).

**config.toml overrides** (`codexConfigForRun()`, lines 268-340), applied after any base
config so a deployment can't re-widen them: `allow_login_shell: false`;
`project_doc_max_bytes: 0` (the repo's own `AGENTS.md` never merges into instructions above
the untrusted-content boundary — RT-04, Claude's analog is `settingSources:[]`);
`skills.include_instructions/bundled.enabled: false` (LV-13 — severs the CLI's whole skills
channel, including the 5 `.system` skills it self-installs into any home; verified with
`codex debug prompt-input`); `features.apps/plugins/hooks: false`; `memories.*: false`;
`mcp_servers` (translated, below); `shell_environment_policy: {inherit:"core", set:{...}}` —
a narrow allowlist (`GIT_CEILING_DIRECTORIES`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, lines
218-224) exposed to the *model's shell commands*, separate from the CLI process's own full
env; `developer_instructions = spec.systemPrompt` (line 338).

**Sandbox stance post-R22** (`resolveCodexSandboxMode()`, lines 342-383). Owner ruling
2026-08-21, "viberr itself is the sandbox": the OS-level `read-only` mode is **gone** — it
used to physically block writes for operators/reviewers/write-withheld agents (P13-RT-02);
removed because the container + server-owned delivery gate (push/PR/merge/Done are all
server actions no tool can reach) is the real boundary, and read-only crippled legitimate
local work. What survives is egress (below). The replacement rule:

```
isDeliverer = kind !== "operator" && kind !== "reviewer"
autonomous && isDeliverer && !webSearchWithheld  →  "danger-full-access"
everything else                                  →  "workspace-write"
```

No run is `read-only` anymore. `spec.autonomous` alone doesn't decide this — it also drives
Claude's `permissionMode`, and flipping it for a supervised run would hang the process on an
approval nobody can answer.

**Egress — the one thing that still binds on Codex.**
`threadOptions.networkAccessEnabled = false` unconditionally for `kind==="operator"` (lines
718-720); `threadOptions.webSearchMode = "disabled"` when `spec.webSearchWithheld` (lines
721-728, P14-RT-06) — **the only capability-withholding flag on `RunSpec` Codex actually
enforces**. `additionalDirectories = [attachmentsWritableDir]` only under `workspace-write`
(lines 706-708; `danger-full-access` can already write anywhere).

**`disallowedTools`/`repoWriteWithheld` are not enforced here** — grep-confirmed, nothing in
this file reads either field. The type comments say so: `disallowedTools` is "Claude only"
(`adapter.server.ts:87-92`); `repoWriteWithheld` is "ADVISORY since R22 ... no runtime
consumes this flag for enforcement anymore" (`adapter.server.ts:109-117`). This is what
"Codex ignores disallowedTools" means precisely — the field never reaches Codex's config at
all, not that Codex tries and fails. Formalized in `app/shared/capabilities.ts:270-283` as
`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (create-task-branch, commit-push-branch,
open-review-pr, execute-code-or-write-repo, comment-on-task, read-github-api).

**MCP.** `codexMcpServers()` (lines 153-186) translates the portable `{transport, ...}` shape
into `--config mcp_servers.<name>=...`, always `default_tools_approval_mode:"approve"` (no
interactive approval channel exists server-side). In-process `{type:"sdk"}` entries decode to
`null` and drop (`codexMcpServerSchema`, lines 116-135) — Codex has no in-process tool
channel at all, which is *why* the `viberr`/`viberr_agent` toolkits never reach it.
Credentials are **deliberately dropped**: the decrypted org-MCP token is never copied onto
the translated config (lines 160-168), because the SDK serializes config into literal
`--config key=value` argv, `ps auxww`-visible on the host. **A credentialed org MCP
authenticates on Claude and connects unauthenticated on Codex, for the same profile** — see
§7.2 for how invisible that is. Tool-name casing also diverges: Claude mounts
`mcp__everything-http__echo`; the Codex CLI lowercases hyphens to underscores,
`mcp__everything_http__echo` (P13-LV-15, lines 141-148) — nothing normalizes this.

**Skills.** None — zero native channel. Every granted skill rides the persona as injected
prompt text (§5.1).

**`outputSchema` — Codex's substitute channel.** `turnOptions.outputSchema = spec.outputSchema`
(line 738) constrains the final message to a JSON envelope, used for both the structured-
output operator (a decision plan the caller parses/executes) and, for any specialist/reviewer
holding a verdict/ask/evidence grant, the `report_outcome` equivalent
(`AGENT_OUTCOME_JSON_SCHEMA`, gated by `useEnvelopeSchema`, `specialist-run.server.ts:1672-1675`)
— Codex can't mount the in-process tool Claude uses for the same purpose.

**Failures.** `classifyCodexFailure()` (lines 439-507) — same four classes plus
`idle_timeout`; prefers the **streamed** `turn.failed`/`error` event's message over the
thrown exit-banner (F22-08 — the thrown error is often just `"exited with code 1: Reading
prompt from stdin..."`, with the real reason only in the stream).

**Idle timeout.** Same 15-min default/override pattern as Claude
(`VIBERR_CODEX_IDLE_TIMEOUT_MS`) — but Codex has no `maxTurns` equivalent, so idle-timeout is
its *only* runaway guard.

---

## 4. Parity table

`capabilityEnforcement(id)` (`app/shared/capabilities.ts:285-296`) already computes
`"both" | "claude-only" | "advisory"` as a single source of truth. This table adds the
orchestration mechanics behind each row.

| Capability / feature | Claude realization | Codex realization | Enforcement |
|---|---|---|---|
| `execute-code-or-write-repo` | Edit/Write/NotebookEdit + `git commit` denied (`specialist-tool-policy.ts:76-78`) | advisory — sandbox is workspace-write/danger-full-access, never read-only | **claude-only** |
| `create-task-branch` | `git checkout -b/-B`, `switch -c/-C` denied (`specialist-tool-policy.ts:58-63`) | advisory | **claude-only** |
| `commit-push-branch` | `git push/commit` denied (line 65) | advisory (moot — push is server-side, footnote below) | **claude-only** |
| `open-review-pr` | `gh pr create` denied (line 66) | advisory (moot — PR-open is server-side) | **claude-only** |
| `merge-pull-request` | always-human, never actionable in a grant | same | **both** (structural) |
| `use-web-search-fetch` | WebFetch/WebSearch denied (line 86) | `webSearchMode:"disabled"` (codex-runtime.server.ts:721-728) | **both** |
| `use-browser` | server not mounted | same — mount decision is backend-agnostic | **both** (mount-level) |
| Skills | native `.claude/skills/<name>` mount + SDK filter | prompt-text injection only | **asymmetric by design** |
| Knowledge bases | prompt-text injection, shared budget | identical injection | **symmetric** — the one channel that doesn't diverge |
| Org MCP (uncredentialed) | mounted, `strictMcpConfig:true` fences ambient config | mounted via `--config`, fenced by dedicated `CODEX_HOME` | both, different mechanism |
| Org MCP (credentialed) | `Authorization`/`MCP_CREDENTIAL` attached | **credential dropped**, connects unauthenticated (codex-runtime.server.ts:160-168) | **claude-only** for auth |
| Browser MCP | mounted, screenshot image returns to model | mounted, `--image-responses omit` (specialist-browser-mcp.server.ts:140) | image feedback **claude-only** |
| In-process toolkit (post_comment/ask_human/report_outcome) | real MCP tools (`viberr_agent`) | replaced by `outputSchema` envelope | asymmetric channel, same intent |
| `comment-on-task` | real tool call, any time mid-run | no mid-run channel — final envelope only | **claude-only** |
| `read-github-api` | in-process tool, PAT never leaves the server | never mounted (would leak PAT into `--config` argv) | **claude-only** |
| `attach-evidence-references` | gated in the completion pipeline | same pipeline | **both** |
| Model catalog | curated + live `supportedModels()`, 10-min cache | curated only — no list endpoint | asymmetric, cosmetic |
| Model substitution net | `foreignModelBackend()` swap + disclosure (run-service.server.ts:660-684) | same function | **both**, shared code |
| Session continuity | `$CLAUDE_CONFIG_DIR/projects/<cwd>/<sid>.jsonl` | `<codexHome>/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl` | both, different storage, one probe abstraction |
| Usage/cost reporting | tokens **and** `total_cost_usd` | tokens only — `costUsd` never set | asymmetric — see §7.9 |
| Turn cap | hard `maxTurns` (default 2000) | none — idle-timeout only | asymmetric |
| Idle timeout | 15 min default | 15 min default | both, same shape |
| Sandbox / autonomy | bypassPermissions vs default | danger-full-access vs workspace-write (never read-only) | both enforce something, different granularity |
| Delivery (push/PR/merge) | server-side, agent never holds the credential | same | **both**, by construction |
| Git author identity | `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env overlay | same keys via `shell_environment_policy.set` | **both** (F24) |
| Ambient host-config leak | closed via `strictMcpConfig` + `settingSources` + dedicated config dir | closed via dedicated `CODEX_HOME` | both, same guarantee |

**Footnote — why commit-push/open-PR are "moot" on Codex:** delivery is server-side for both
backends regardless of grant; no agent process ever holds a push credential
(`specialist-run.server.ts:2768-2772`; the credential lives only in `push-workspace.server.ts`,
invoked from the Review transition). The capability still gates the agent's *own local*
commit/push inside its sandbox — real on Claude, advisory on Codex (nothing stops the local
command; it just can't reach the remote). Small blast radius, not zero: a Codex run can still
locally commit into its isolated checkout when its grant says it shouldn't.

---

## 5. Context-resource mounting

Skills, MCP servers, and knowledge bases are each resolved from the deployed profile's
grants exactly once per run, in `dispatchAgentRun()` (fresh) and `resolveResumeConfinement()`
(resume) — both built to resolve identically, closing a class of prior bugs (XS-1) where
"resume kept silently dropping half of a run's policy" (`specialist-run.server.ts:2515-2524`).

### 5.1 Skills

`mountGrantedSkills()` (`skill-mount.server.ts:256-302`, Claude-only), called from
`specialist-run.server.ts:1399-1407` (fresh) / `:2590-2599` (resume):

1. Refuses anything that isn't a plain git checkout (`isPlainGitCheckout`, lines 306-312) —
   no checkout keeps prompt-text injection. Deliberate: `settingSources:['project']` walks
   parents to the repo root, so mounting elsewhere risks reaching the data root or a host
   `.claude` (F13).
2. `stripUngovernedRepoCatalog()` (lines 121-167) runs **every** call, deleting the entire
   `.claude` the repo shipped — except a skill folder carrying this process's `MOUNT_MARK`
   (a random per-process UUID, line 96). This is F19-15: the task workspace is shared across
   every engagement on the task, so a naive strip-then-remount destroyed a *concurrently
   running* engagement's skills mid-run. The mark can't be forged from a clone (per-process,
   random) or reused across processes (whose runs are dead anyway).
3. Only the exact granted names are copied (`mountOneSkill`, lines 368-452), checked against
   `SDK_SKILL_NAME_RE` (line 215) before ever reaching the SDK, containment-checked via
   `resolveContainedSkillFile`. Frontmatter is **normalized, not copied through** — only
   `name`/`description` survive (lines 405-433), so a store `SKILL.md` can't smuggle
   `allowed-tools`/`model` overrides that would widen the run's tool policy.
4. `.claude/` joins `.git/info/exclude` so the mounted catalog never rides `git add -A` into
   a delivered PR (lines 314-365) — **best-effort**, see §7.6.
5. The mount **returns** the names that landed; that list is exactly what the adapter passes
   as `options.skills` — enforcement is the SDK allowlist, not the directory contents. A
   folder present but unlisted is inert (module docstring, lines 79-82).

Skills that don't mount (no checkout, Codex backend, bad name, copy error) fall back to
`readSkillBodies()` → injected as prompt text in `buildSpecialistPersona()`
(`specialist-run.server.ts:1970-1996`) — `nativeSkills`/`injectable` are a strict partition
(lines 1970-1973), so nothing is fed twice or dropped.

### 5.2 Knowledge bases

`readKbBodies()` (`kb-injection.server.ts:304-321`) is the **one** reader both the operator
(`operator-run.server.ts:2826`) and every specialist/reviewer
(`specialist-run.server.ts:2009`) call — backend-symmetric, always prompt text. A recursive
walk (`collectKbDocs`, lines 75-130) matches every text-doc extension, refuses symlinked
roots/entries, cycle-guards. All declared KBs for one run share **one** 24,000-char budget
(`KB_INJECTION_BUDGET`, line 64), charged per doc including its heading (lines 222-225). A KB
that doesn't fit still emits an explicit `"omitted entirely"` marker (P14-KM-05, lines
236-254) and joins the same `unresolved` list the MCP/skill legs use, surfaced in both the
persona and the run-input disclosure (§5.5) — never a silent drop.

Reviewers additionally **inherit** the delivering engagement's KB grants (deduped union,
reviewer's own first, `withDeliveringGrants`, lines 381-391) so a reviewer judges against the
same conventions the deliverer used — **KB-only** (ruling 57/R19-3); skills are never
inherited this way.

### 5.3 MCP servers

`resolveSpecialistMcpServersDetailed()` (`specialist-mcp.server.ts:120-220`) resolves
declared names against the org registry. `RESERVED_MCP_NAMES` (`viberr`, `viberr_agent`,
`viberr_browser` + hyphen variants, lines 85-91) are **never** resolved from the registry —
even a hand-edited colliding row is ignored, because those names are built in-process and a
shadowing row would make the two backends disagree about what the agent can do (P14-KM-15).
A credential that's configured but unopenable (retired key, legacy plaintext) refuses the
mount outright rather than connecting anonymously (A9, lines 186-196). A registered-but-known
-down server (`row.up===false`, a *past* check) still mounts but is flagged `unresolved` +
`mounted:true` (P14-LV-09b) — "definitely absent" vs. "may be stale" are distinguished.

`verifyStdioMcpMountsForRun()` (lines 248-333) **pre-flights stdio mounts only** with a real
handshake right before launch (F20-10) — drops a mount that fails, discloses it by name,
corrects the registry row. It re-probes without the credential Codex would actually receive,
so a credential-required failure is disclosed as Codex-specific rather than corrupting the
shared health row Claude runs also read (lines 291-314, the P9/pass-25 fix). **HTTP mounts
are never pre-flighted** — see §7.1.

### 5.4 Browser MCP

`resolveBrowserMcp()` (`specialist-browser-mcp.server.ts:101-149`) mounts Playwright MCP as a
per-run stdio server, capability-gated rather than an org-registry row (so it isn't subject to
the "governed by instruction only" gap every other MCP has): `use-browser` must be `direct`
**and** effective `use-web-search-fetch` must be `direct` too — a browser is egress, and a
mismatched pair surfaces as `UnresolvedMcpGrant` rather than silently resolving either way.
Containment: `--isolated` (no persisted state across runs/tasks), no unrestricted file access,
`--output-dir` pointed at the task's `attachments/`. `--image-responses omit` on Codex only
(screenshots never return to the model as an image — unproven on that CLI); the persona tells
a Codex agent explicitly not to claim it "saw" a screenshot it can't (lines 181-219).

### 5.5 The "only granted, nothing unrelated" guarantee — where it lives

- **Skills**: the SDK `skills:[]` allowlist (Claude); Codex has no channel to leak an
  unrelated one through at all.
- **KBs**: enforced by construction — `readKbBodies` is only ever called with the declared
  list; no enumeration path exists.
- **MCP**: declared-name list, plus `strictMcpConfig:true` (Claude) / dedicated `CODEX_HOME`
  (Codex) fencing whatever ambient config would otherwise also be present.
- **Disclosure**: `recordRunInputs()` (`specialist-run.server.ts:589-654`) writes a
  `run_inputs` line at the *head* of every run's log — resolved skill/KB/MCP sets, native vs.
  injected, denied tools, what didn't resolve — so a human can check the product's own claims
  instead of trusting the Agents-page matrix. Before P19-G8/G11 none of this reached any
  human-visible surface (module comment, lines 558-588).

---

## 6. Concurrency gate

`run-service.server.ts`, process-global state under `Symbol.for("viberr.runService")`
(line 138, survives HMR).

**Cap.** `getMaxConcurrentRuns(db)` (`instance-settings.server.ts:68-70`) — `0` = unlimited
(default), else `1..64` (`MAX_CONCURRENT_RUNS_CEILING`, line 59).

**Count.** `liveCount = state.handles.size + state.reserved.size`
(`run-service.server.ts:1236-1238`) — the F26-1 fix. `handles` alone only counts runs with a
live adapter, but every specialist dispatch calls `reserveRun()` *before* the (multi-minute)
clone, and that reserved row already occupies a slot conceptually. Before the fix, every
simultaneous dispatch cleared the cap check during its clone window and only collided once it
reached `handles` — the cap was bypassed on every single dispatch.

**State machine:**
1. `reserveRun()` (lines 406-507) — declines (`null`) if `liveCount >= cap`; else writes a
   `running` DB row immediately (so the UI shows "Preparing workspace" during the clone) and
   adds the id to `state.reserved`.
2. `startRun()` (lines 639-842) — for a reserved run, moves the id `reserved → handles`
   synchronously in the launch call (lines 835-837), so the live count never dips. A
   non-reserved caller (operator, resume) goes through `admitRun()` instead.
3. `admitRun()` (lines 1252-1266) — launches now if `liveCount < cap`, else pushes onto
   `state.pending` (FIFO), row stays `queued`.
4. `drainRunQueue()` (lines 1276-1295) — called from every run's `onExit` and from
   `reserveRun().abandon()`. Re-reads the cap each pass, drops a pending entry whose row is no
   longer `queued`, else launches the oldest. Reentrancy-guarded (`state.draining`) since a
   synchronously-exiting promoted run's `onExit` re-enters this during the outer loop.

**Rules for not breaking it:** never call an adapter's `.start()` directly or invent a second
"holds a slot" signal — `handles`/`reserved`/`pending` on the one `ServiceState` are the only
truth. Any future step that claims a slot before a live adapter exists must register in
`state.reserved` or it silently reproduces F26-1. The instance cap is **not** the only gate:
one live/queued delivering (`kind==="primary"`) run per task (`specialist-run.server.ts:1112-1128`,
hard 409) and one live/queued run per same supporting engagement (`:1139-1155`, different
engagements still run concurrently) are separate, unconditional constraints that don't consult
`getMaxConcurrentRuns` — a refused second run is usually one of these, not the cap.
`finalizeOrphanedRuns()` (`run-recovery.server.ts:61`) force-finalizes every non-terminal row
at boot unconditionally — the crash backstop, not part of the live gate.

---

## 7. Bug-hunt targets

### 7.1 HTTP MCP mounts are never pre-flighted per-run
`specialist-mcp.server.ts:267` — `if (!row || row.transport !== "stdio") continue; // HTTP is
not spawned here`. A stale-healthy HTTP row mounts optimistically and only fails inside the
live transcript on first call. Matches this session's own live state: org MCP `test-mcp`
(`http://localhost:9999/sse`) is registered and connection-refused right now — a ready-made
live probe.

### 7.2 Codex credential-drop on org MCPs is disclosed in exactly one narrow branch
`codex-runtime.server.ts:160-168` drops the decrypted token by design. The *only* runtime
disclosure of this is `specialist-mcp.server.ts:303-313`, when a stdio server fails
credential-less but succeeds with the credential. Any server that *tolerates* an
unauthenticated connection gives a Codex run silent anonymous access with zero disclosure —
not in the persona (`specialist-run.server.ts:2067-2077` just lists names), not in
`recordRunInputs`, not in the capability matrix (MCP sits outside capability policy entirely).

### 7.3 MCP tool-name casing diverges with no normalization
Claude: `mcp__everything-http__echo`; Codex CLI lowercases hyphens to
`mcp__everything_http__echo` (`codex-runtime.server.ts:141-148`, P13-LV-15). Nothing surfaces
this to the agent. A skill/KB/persona that names a tool literally matches on one backend and
silently not the other.

### 7.4 Codex operator's read-only posture is a workdir trick, not an enforcement
Claude denies `Bash/Edit/Write/NotebookEdit` outright for `kind==="operator"` — real, binds
under bypass, cwd-independent. Codex has no such channel (§3); its confinement is entirely
that `workdir` points at an empty scratch dir (`ensureOperatorScratchDir`,
`operator-run.server.ts:1742-1746`) that doesn't contain `task.md` or the checkout, while its
`workspace-write` sandbox can write anywhere it's rooted. A future change that ever pointed
the Codex operator's `workdir` elsewhere would silently drop the write-block — nothing else
enforces it. Worth a regression test pinning the Codex operator's `workdir` to the scratch
dir, not just a live-behavior check.

### 7.5 `repoWriteWithheld` computed identically for both backends, consumed by one
`run-service.server.ts:540-546` derives the flag backend-agnostically, then states Codex has
no consumer for it (R22). The matrix UI carries the "advisory on Codex" caveat correctly
(`capabilities.ts:598-601`), but this session's own goal — "run the same task on each backend,
compare surfaces" — should specifically confirm live that a repo-write-withheld profile on
Codex can, in fact, still touch the repo inside its isolated checkout.

### 7.6 Mounted-skill git-exclude write is best-effort
`skill-mount.server.ts:324-365` — if the `.git/info/exclude` write fails, the mounted
`.claude/skills` catalog is not git-ignored and can ride `git add -A` into a delivered PR.
Logged at `WARN` only; no hard-stop, no `unresolved`-style disclosure like the KB/MCP legs
get. The docstring calls the real fix "out of scope here."

### 7.7 Skill-mount preservation means workspace contents ≠ what a run can do
By design (`skill-mount.server.ts:84-95`, F19-15), a finished run's mounted skill folder is
never cleaned up — no run-liveness signal reaches this module. A task workspace can
accumulate skill folders from agents that finished hours ago (harmless — the SDK allowlist,
not the directory, is the fence — but `<workspace>/.claude/skills/` is not a reliable signal
of what any given run was granted; only `RunSpec.skills`/the `run_inputs` line is).

### 7.8 CLAUDE.md ingress on a skill-mounted run is unverified by the code's own admission
`claude-runtime.server.ts:319-334`: "HONEST NOTE — an ACCEPTED, UNVERIFIED mitigation ...
has NOT been verified live against a real run, and it cannot be verified from a unit test."
Any Claude run with ≥1 granted skill opens `settingSources:['project']`, which also loads a
repo's own `CLAUDE.md` at system-prompt tier. Live-container-only check: mount a skill, drop a
detectable `CLAUDE.md` in the target repo, run it, and read the actual system prompt sent.

### 7.9 `agent_runs.total_cost_usd` is a Claude-shaped column
`db/migrations/0001_baseline.sql:412` declares it `REAL` (nullable); only the Claude
projector ever sets `costUsd` (`wire-format.server.ts:301-334` vs. `:384-397` — Codex's
`turn.completed` has no such key). Any cost surface (Insights, exports) that `SUM`/`AVG`s
this across backends without accounting for structurally-`NULL` Codex rows understates
mixed-backend cost — worth confirming `app/server/insights/insights-query.server.ts` states
this rather than presenting a Claude-only partial total as the whole.
