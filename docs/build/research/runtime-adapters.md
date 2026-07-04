# Runtime adapters: Claude Code CLI & OpenAI Codex CLI (headless subprocess reference)

Research date: 2026-07-04. Verified against live docs at code.claude.com/docs and developers.openai.com/codex, plus local CLI checks on this machine (Claude Code v2.1.201 installed; Codex npm wrapper present but broken — see gotchas). Anything not confirmed by a current primary source is marked **UNVERIFIED**.

---

## 1. Claude Code CLI (headless / `-p` mode)

### 1.1 Detection & auth

- Detect install: `claude --version` → prints e.g. `2.1.201 (Claude Code)` and exits 0. (Verified locally; flag documented at <https://code.claude.com/docs/en/cli-reference>.) Parse with `/^(\d+\.\d+\.\d+)/`.
- API key env var: `ANTHROPIC_API_KEY` — "In non-interactive mode (`-p`), the key is always used when present" and overrides a logged-in subscription (<https://code.claude.com/docs/en/env-vars>). In `--bare` mode, OAuth/keychain reads are skipped entirely, so auth **must** come from `ANTHROPIC_API_KEY` or an `apiKeyHelper` passed via `--settings` (<https://code.claude.com/docs/en/headless>).
- CI hygiene: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` disables autoupdater, telemetry, error reporting, feedback in one shot (<https://code.claude.com/docs/en/env-vars>).

### 1.2 Canonical invocation

```bash
claude -p "Fix the failing test in src/auth.ts" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --permission-mode acceptEdits \
  --allowedTools "Bash,Read,Edit" \
  --model sonnet \
  --max-turns 50
```

Facts (all from <https://code.claude.com/docs/en/headless> and <https://code.claude.com/docs/en/cli-reference>):

- `-p` / `--print` = non-interactive mode. Prompt can be the positional arg, or piped on stdin (`cat log.txt | claude -p "explain this"` — stdin becomes context; or the whole prompt if no arg given). **Piped stdin is capped at 10 MB as of v2.1.128**; exceeding it exits non-zero with an error.
- `--output-format`: `text` (default) | `json` (single envelope at end) | `stream-json` (NDJSON, one JSON object per line, emitted live).
- **`--verbose` is required with `--output-format stream-json` in `-p` mode** — without it the CLI does not emit the turn-by-turn NDJSON stream. The official docs always show them together; third-party write-up confirms "`--verbose` is required to unlock detailed event emission" (<https://backgroundclaude.com/blog/stream-json>).
- `--include-partial-messages`: adds `stream_event` envelopes (token-level deltas). Requires `-p` + `stream-json`.
- `--bare`: skips hooks/skills/plugins/MCP/CLAUDE.md auto-discovery. Docs: "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." For a product that *wants* the user's project config (CLAUDE.md, MCP), do **not** pass `--bare`; for deterministic CI-style runs, do.
- Working directory: no dedicated flag — set `cwd` on the spawned process. `--add-dir <path>...` grants access to extra directories.
- Model: `--model sonnet|opus|haiku|fable` or full name (e.g. `claude-sonnet-5`); `--fallback-model sonnet,haiku`; `--effort low|medium|high|xhigh|max`.
- Limits: `--max-turns N` (print mode only), `--max-budget-usd 5.00` (print mode only).
- `--no-session-persistence` (print mode only) disables writing the session to disk if you don't need resume.
- `--session-id <uuid>` forces a specific session id; `--fork-session` mints a new id when resuming.

### 1.3 NDJSON envelope types (stream-json)

Every line has at least `type`, and (except some system events) `session_id` + `uuid`. Field shapes below are the documented Agent-SDK message types, which are the same objects the CLI emits as NDJSON (<https://code.claude.com/docs/en/agent-sdk/typescript>, <https://code.claude.com/docs/en/headless>).

**`system` / `init`** — first line of the stream. Documented fields: `type:"system"`, `subtype:"init"`, `apiKeySource`, `cwd`, `session_id`, `tools` (string[]), `mcp_servers`, `model`, `permissionMode`, `slash_commands`, `output_style`, `uuid`, `agents`, plus `plugins` / `plugin_errors` arrays:

```json
{"type":"system","subtype":"init","cwd":"/work/repo","session_id":"a7b8c9d0-1234-5678-9abc-def012345678","tools":["Task","Bash","Read","Edit","Write","Grep","Glob","WebFetch"],"mcp_servers":[],"model":"claude-sonnet-5","permissionMode":"acceptEdits","apiKeySource":"ANTHROPIC_API_KEY","slash_commands":[],"output_style":"default","agents":[],"uuid":"..."}
```

(Example line assembled from the documented field list; exact ordering/extra fields vary by version.)

**`system` / `api_retry`** — emitted before retrying a failed API request. Fields: `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (int|null), `error` (category string: `authentication_failed`, `rate_limit`, `overloaded`, `server_error`, …), `uuid`, `session_id` (<https://code.claude.com/docs/en/headless>). Surface these as "retrying" status, don't treat as fatal.

**`assistant`** — one complete API assistant message per line: `{type:"assistant", message:<API Message>, parent_tool_use_id, session_id, uuid}`. `message.content` is the standard Claude API content-block array (`text`, `tool_use {id,name,input}`, `thinking`), and `message.usage` carries **per-message token usage** (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`):

```json
{"type":"assistant","message":{"id":"msg_01ABC","role":"assistant","model":"claude-sonnet-5","content":[{"type":"text","text":"I'll run the tests."},{"type":"tool_use","id":"toolu_01XYZ","name":"Bash","input":{"command":"npm test"}}],"stop_reason":"tool_use","usage":{"input_tokens":4212,"output_tokens":89,"cache_read_input_tokens":11020,"cache_creation_input_tokens":640}},"parent_tool_use_id":null,"session_id":"a7b8c9d0-...","uuid":"..."}
```

`parent_tool_use_id` is non-null when the message comes from a subagent (Task tool) — use it to attribute output.

**`user`** — tool results echoed back as user-role messages: content blocks of `{"type":"tool_result","tool_use_id":"toolu_01XYZ","content":[...],"is_error":false}`:

```json
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01XYZ","content":"290 passing, 0 failing","is_error":false}]},"parent_tool_use_id":null,"session_id":"a7b8c9d0-...","uuid":"..."}
```

**`stream_event`** (only with `--include-partial-messages`) — wraps a raw Claude API streaming event: `{type:"stream_event", event:<raw API event>, parent_tool_use_id:null, uuid, session_id, ttft_ms?}`. `event.type` ∈ `message_start | content_block_start | content_block_delta | content_block_stop | message_delta | message_stop`; text tokens are `event.delta.type == "text_delta"` (`.text`), streamed tool args are `input_json_delta` (`.partial_json`). `ttft_ms` present only on `message_start` (<https://code.claude.com/docs/en/agent-sdk/streaming-output>). jq filter from official docs:

```bash
jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

**`result`** — final line. Documented type (<https://code.claude.com/docs/en/agent-sdk/typescript>):

```ts
type SDKResultMessage = {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: unknown;          // final text on success
  total_cost_usd: number;
  usage: unknown;           // aggregate token usage
  modelUsage: unknown;      // per-model breakdown incl. cost
  permission_denials: unknown;
  structured_output?: unknown; // only with --json-schema
  session_id: string;
  uuid: string;
};
```

```json
{"type":"result","subtype":"success","is_error":false,"duration_ms":45231,"duration_api_ms":38112,"num_turns":12,"result":"Fixed the failing test by ...","total_cost_usd":0.2814,"usage":{"input_tokens":52340,"output_tokens":4102,"cache_read_input_tokens":301200,"cache_creation_input_tokens":18220},"modelUsage":{"claude-sonnet-5":{"inputTokens":52340,"outputTokens":4102,"costUSD":0.2814}},"permission_denials":[],"session_id":"a7b8c9d0-...","uuid":"..."}
```

Cost reporting rule: assistant envelopes carry per-message `usage` (tokens only, no dollars); **`total_cost_usd` appears only in the final `result` envelope** (and in the single `json`-format envelope). If the run aborts before `result`, sum per-message usage yourself.

Also possible mid-stream: `system`/`compact_boundary` (context compaction marker), `system`/`plugin_install` (only when `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` is set), hook events with `--include-hook-events`.

### 1.4 Resume / continue

- `--continue` (`-c`): resume the most recent conversation **for the current working directory**.
- `--resume <session_id|name>` (`-r`): resume a specific session. Session lookup is scoped to the current project directory and its git worktrees — run from the same `cwd` (<https://code.claude.com/docs/en/headless>).
- Grab the id from the `system/init` line (`session_id`) or from `--output-format json`'s `.session_id`. Official pattern:

```bash
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

- Resumed runs emit a fresh full stream (new `init`, then messages). Add `--fork-session` to branch instead of appending.
- On-disk state: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (path-encoded cwd, e.g. `-Users-you-code-my-app`); plus `~/.claude/history.jsonl` (<https://code.claude.com/docs/en/claude-directory>). Transcripts are plaintext JSONL — treat as sensitive.

### 1.5 Permissions for autonomous runs

- `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions|manual` (<https://code.claude.com/docs/en/cli-reference>). For unattended runs: `acceptEdits` (file writes + mkdir/mv/cp auto-approved; other shell/network still need allow rules) or `dontAsk` (deny anything not explicitly allowed — locked-down CI) (<https://code.claude.com/docs/en/headless>).
- `--allowedTools` / `--allowed-tools` uses permission-rule syntax: `"Bash(git diff *),Read,Edit"` — note the **space before `*`** (`Bash(git diff*)` would also match `git diff-index`). `--disallowedTools` for deny rules.
- `--dangerously-skip-permissions`: skip all prompts (= `bypassPermissions`). Only sane inside a container/sandbox.
- In `-p` mode, a tool call that would need an interactive prompt is **denied and the run continues/aborts** rather than blocking — denials are listed in `result.permission_denials`. So a correctly flagged headless run never hangs on a permission prompt.
- `--permission-prompt-tool <mcp_tool>`: delegate permission decisions to an MCP tool if you want programmatic approval.

### 1.6 Interrupting & exit codes

- **Interrupt: send `SIGINT` to the child process.** This is the documented/community-standard kill switch for `-p` runs (stream-consumers deciding to cancel based on events: <https://backgroundclaude.com/blog/stream-json>). Escalate SIGINT → SIGTERM → SIGKILL with timeouts; the CLI itself uses that ladder for its own MCP children (github.com/anthropics/claude-code/issues/7718). On interrupt you will not get a `result` line — treat absence of `result` as "aborted".
- Interrupt-via-stdin (`control_request` protocol used by the Agent SDK over `--input-format stream-json`) is **UNVERIFIED for direct CLI use** — an open feature request asks for a documented stdin interrupt message (github.com/anthropics/claude-code/issues/41665). Rely on signals.
- The session file is written incrementally, so `--resume <session_id>` works after an interrupt.
- Exit codes: `0` success, non-zero (typically `1`) on failure (<https://code.claude.com/docs/en/cli-reference>). Distinguish *agent-level* failure via `result.is_error` / `subtype` (`error_max_turns`, `error_during_execution`) — the process can exit 0 in some error-subtype cases, so gate on the JSON, not just the exit code. **UNVERIFIED**: exact exit code per error subtype is not documented; treat any missing/`is_error:true` result as failure.
- **Close stdin after writing the prompt.** `claude -p` ties post-result cleanup to stdin close (background Bash tasks are killed "~5 seconds after Claude has returned its final result **and stdin has closed**" — <https://code.claude.com/docs/en/headless>). A never-closed stdin pipe is the classic cause of the process lingering after `result` (see hang report github.com/anthropics/claude-code/issues/25629). In Node: `child.stdin.end(prompt)` or spawn with `stdio: ['ignore', 'pipe', 'pipe']` and pass the prompt as argv.

---

## 2. OpenAI Codex CLI (`codex exec`)

### 2.1 Detection & auth

- Detect: `codex --version` (or `-V`) → single line `codex-cli x.y.z`, exits 0, no login required (<https://developers.openai.com/codex/cli/reference>). **Handle spawn failures**: the npm wrapper (`@openai/codex`) can be present but broken — observed locally: `spawn .../codex-darwin-arm64/vendor/.../codex ENOENT`, exit 1. Detection = spawn succeeded AND exit 0 AND stdout matches `/^codex-cli \d+\.\d+\.\d+/`.
- Auth options (<https://developers.openai.com/codex/cli/reference>):
  - `codex login` (browser OAuth, ChatGPT plan) / `codex login --device-auth` / `codex login --with-api-key` (reads key from stdin). `codex login status` exits 0 if logged in — use it as a preflight check.
  - `CODEX_API_KEY=<key> codex exec ...` — inline API key, **honored by `exec` only** (<https://developers.openai.com/codex/noninteractive>). `OPENAI_API_KEY` is used when piped into `codex login --with-api-key`. Docs warn against setting either as job-level env vars in workflows that check out untrusted code.
  - Credentials/config live in `~/.codex/` (`auth.json`, `config.toml`).

### 2.2 Canonical invocation

```bash
codex exec --json \
  --cd /work/repo \
  --sandbox workspace-write \
  --skip-git-repo-check \
  --model gpt-5-codex \
  "Fix the failing test in src/auth.ts"
```

Facts (<https://developers.openai.com/codex/noninteractive>, <https://developers.openai.com/codex/cli/reference>):

- `codex exec "<prompt>"` (alias `codex e`). Without `--json`: progress → **stderr**, final agent message → **stdout**.
- `--json`: one JSON object per line (JSONL) on stdout. (Older releases spelled it `--experimental-json`; current reference lists both.)
- Prompt via stdin: `codex exec -` reads the **entire prompt** from stdin (`cat prompt.txt | codex exec -`). Prompt-as-arg **plus** piped stdin = stdin becomes extra context (`npm test 2>&1 | codex exec "summarize failures"`).
- `--cd <path>` / `-C`: working directory (also just set subprocess cwd). `--skip-git-repo-check`: required to run outside a git repo (otherwise exec refuses).
- `--model <name>` / `-m` overrides the configured model (docs examples use `gpt-5-codex`, `gpt-5.4`). `-c key=value` overrides any `config.toml` setting; `--profile <name>` layers a profile.
- Output helpers: `--output-last-message <path>` / `-o` writes only the final agent message to a file; `--output-schema <schema.json>` forces the final message to conform to a JSON Schema.
- `--ephemeral`: don't persist the session to disk. `--ignore-user-config`, `--ignore-rules` for reproducible CI runs.

### 2.3 JSONL event stream (`--json`)

Official example lines from <https://developers.openai.com/codex/noninteractive>:

```json
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","aggregated_output":"docs\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

Top-level event types: `thread.started {thread_id}`, `turn.started`, `turn.completed {usage}`, `turn.failed {error:{message}}`, `item.started` / `item.updated` / `item.completed` (payload under `item`), and stream-level `error {message}`. Usage fields: `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`. **No dollar cost is reported** — compute cost from tokens yourself.

Item types (all items carry `id`, `type`; field details corroborated by the community cheatsheet <https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/> — official docs list the types but not every field):

| `item.type` | Fields | Lifecycle |
|---|---|---|
| `agent_message` | `text` | completed only |
| `reasoning` | `text` (summary) | completed only |
| `command_execution` | `command`, `aggregated_output`, `exit_code` (null while running), `status` (`in_progress`/`completed`/`failed`) | started + completed |
| `file_change` | `changes: [{path, kind: add\|delete\|update}]`, `status` | completed (started **UNVERIFIED**) |
| `mcp_tool_call` | `server`, `tool`, `arguments`(**UNVERIFIED**), `status` | started + completed |
| `web_search` | `query` | completed only |
| `todo_list` | `items: [{text, completed}]` | started + updated + completed |
| `error` | `message` | completed |

Example failure/error lines (community-documented, shape **UNVERIFIED against official docs**):

```json
{"type":"turn.failed","error":{"message":"model response stream ended unexpectedly"}}
{"type":"error","message":"stream error: broken pipe"}
```

### 2.4 Resume

```bash
codex exec resume --last "next instruction"        # most recent session
codex exec resume 0199a213-81c0-7800-8aa1-... "do X"  # specific session id
```

(<https://developers.openai.com/codex/noninteractive>) The id to store is `thread_id` from `thread.started`. Interactive counterpart: `codex resume [--last|--all|<id>]`, plus `codex fork <id>`.

On-disk state: JSONL "rollout" files under `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl` (github.com/openai/codex/discussions/3827). Newer builds reportedly compress to `.jsonl.zst` (**UNVERIFIED**, community report). Don't parse these directly; use `resume`.

### 2.5 Sandbox / approvals for autonomous runs

- `--sandbox` / `-s`: `read-only` | `workspace-write` | `danger-full-access` (<https://developers.openai.com/codex/cli/reference>). `codex exec` defaults to a non-interactive-safe policy; for an agent that edits code use `--sandbox workspace-write`.
- `--full-auto` is **deprecated** — docs now say "use `--sandbox workspace-write` instead" (<https://developers.openai.com/codex/noninteractive>).
- `--ask-for-approval` / `-a`: `untrusted` | `on-request` | `never` per current reference page (`on-failure` existed in earlier releases — **UNVERIFIED whether still accepted**). In exec mode there is no human to approve, so pair `--sandbox workspace-write` with approval policy `never` (or rely on exec's non-interactive default, which never prompts).
- Nuclear option: `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) — no sandbox, no approvals; container-only.

### 2.6 Exit codes & interrupts

- `codex exec` exits `0` on success and **non-zero on failure**; docs/community guidance is to gate CI on the exit code (<https://developertoolkit.ai/en/codex/advanced-techniques/non-interactive/>, corroborating official positioning). Also watch for `turn.failed`/`error` events.
- `codex login status` exits 0 iff authenticated.
- Interrupt: send SIGINT/SIGTERM. Caveat: historically `codex exec` exited **0** after Ctrl-C/SIGINT (github.com/openai/codex/issues/4721) — do not infer success from exit code alone after you signaled the process; infer from whether you saw `turn.completed`.
- Sessions persist incrementally, so `codex exec resume <thread_id>` recovers an interrupted run.

### 2.7 TypeScript SDK alternative — `@openai/codex-sdk`

(<https://developers.openai.com/codex/sdk>, <https://github.com/openai/codex> `sdk/typescript`) The SDK wraps the same `codex` binary/`codex exec --json` machinery, so events match §2.3.

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();                    // options: env, config, apiKey/baseUrl overrides
const thread = codex.startThread({
  workingDirectory: "/work/repo",
  skipGitRepoCheck: true,
  // model, sandboxMode also accepted
});

// Buffered: waits for the turn to finish
const result = await thread.run("Fix the failing test");
// result.finalResponse, result.items, result.usage

// Streaming: async generator of the same events (item.completed, turn.completed, ...)
const { events } = await thread.runStreamed("Now run the tests");
for await (const event of events) { /* switch on event.type */ }

// Later / other process:
const resumed = codex.resumeThread(threadId); // threads persisted in ~/.codex/sessions
```

`thread.id` is populated from the `thread.started` event (null before the first run — **UNVERIFIED** exact nullability semantics). Auth: same as CLI (`codex login` or `OPENAI_API_KEY`/`CODEX_API_KEY`). If you already spawn subprocesses generically for Claude Code, driving `codex exec --json` directly keeps both adapters symmetrical; the SDK mainly buys you typed events and schema/`outputSchema` support.

---

## 3. Cross-cutting subprocess guidance

**Stdin.** Never spawn either CLI with inherited/interactive stdin.
- Claude: pass prompt as argv or write it to stdin **and then `stdin.end()`**. An open stdin pipe delays/blocks clean exit after `result` (§1.6).
- Codex: pass prompt as argv and set stdin to `'ignore'`, or use `codex exec -` and close stdin after writing. Known bugs when stdio is a non-TTY pipe with no writer: hang (github.com/openai/codex/issues/20919) and silent crash on detached stdio in 0.124.0+ (github.com/openai/codex/issues/19945). `stdio: ['ignore','pipe','pipe']` is the safe default.

**Parsing.** Both streams are line-delimited JSON on stdout. Buffer chunks and split on `\n` — events straddle chunk boundaries (the #1 naive-parser bug, <https://backgroundclaude.com/blog/stream-json>). Tolerate unknown `type`s (both vendors add event types between minor versions). Codex without `--json` logs progress to stderr; with `--json`, keep reading stderr anyway for panics/diagnostics.

**Never-block checklist.**
- Claude: `-p` + explicit `--permission-mode`/`--allowedTools` (denied tools are recorded in `permission_denials`, not prompted). Interactive-only slash commands like `/login` are unavailable in `-p` — fail fast if unauthenticated instead.
- Codex: `exec` never prompts; ensure `--skip-git-repo-check` when cwd may not be a repo, and stdin `'ignore'`.

**State on disk.** Claude: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (+ `~/.claude/history.jsonl`). Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, config in `~/.codex/config.toml`, creds in `~/.codex/auth.json`. Both are per-user, plaintext, and safe for concurrent sessions in different cwds.

---

## 4. Gotchas

1. **`--verbose` is mandatory** with `claude -p --output-format stream-json`; forgetting it silently degrades output (§1.2).
2. **Claude cost only at the end**: `total_cost_usd` exists solely on the final `result`/`json` envelope; mid-stream you only get token `usage` per assistant message. Codex never reports dollars at all.
3. **Stdin close semantics differ**: Claude uses stdin-close as part of its exit protocol; Codex crashes/hangs on pathological non-TTY stdio. Use argv prompts + `'ignore'`/immediately-closed stdin.
4. **Renamed/deprecated flags**: Codex `--full-auto` → deprecated (use `--sandbox workspace-write`); `--experimental-json` → `--json`; Codex approval value set shifted (`on-failure` may be gone). Claude's docs now push `--bare` for scripted runs and say it will become the `-p` default — pin behavior explicitly rather than relying on defaults.
5. **Exit codes lie at the edges**: Claude can exit 0 with `result.subtype: "error_max_turns"`; Codex historically exited 0 after SIGINT (#4721). Gate on stream contents (`result` / `turn.completed`) first, exit code second.
6. **Session resume is cwd-scoped for Claude** — `--resume`/`--continue` lookups only match sessions started from the same project directory (or its worktrees). Always resume with the same `cwd` you spawned with.
7. **Broken installs pass naive detection**: the Codex npm wrapper can exist on PATH yet fail to spawn its native binary (observed locally, ENOENT). Version-check by running the binary and validating output, not by `which`.
8. **Claude 10 MB stdin cap** (v2.1.128+): pipe-overflow exits non-zero; put big context in a file and reference the path.
9. **Unknown event tolerance**: Claude adds `system` subtypes (`api_retry`, `plugin_install`, `compact_boundary`) and Codex adds item types over time — parsers must skip-and-log, not throw.
10. **Windows/portability**: escaped double quotes in npm scripts are the documented portable pattern for Claude prompts (<https://code.claude.com/docs/en/headless>).

### Primary sources

- Claude Code headless: <https://code.claude.com/docs/en/headless>
- Claude Code CLI reference: <https://code.claude.com/docs/en/cli-reference>
- Claude Code env vars: <https://code.claude.com/docs/en/env-vars>
- Agent SDK message types: <https://code.claude.com/docs/en/agent-sdk/typescript>
- Agent SDK streaming: <https://code.claude.com/docs/en/agent-sdk/streaming-output>
- `.claude` directory layout: <https://code.claude.com/docs/en/claude-directory>
- Codex non-interactive: <https://developers.openai.com/codex/noninteractive>
- Codex CLI reference: <https://developers.openai.com/codex/cli/reference>
- Codex SDK: <https://developers.openai.com/codex/sdk>
- Codex sessions on disk: <https://github.com/openai/codex/discussions/3827>
- Codex exec JSONL cheatsheet (3rd-party field corroboration): <https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/>
- Claude stream-json practice notes (3rd-party): <https://backgroundclaude.com/blog/stream-json>
