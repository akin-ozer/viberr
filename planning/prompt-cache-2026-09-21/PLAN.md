# Plan: cut token usage across operator, specialist and controller runs on Claude and Codex

Date 2026-09-21. Basis: the research note of the same day (`RESEARCH.md` (same folder)), the code on `main` @ 3b4a95c3, and the last 400 Claude and 200 Codex transcripts. Installed versions: `@anthropic-ai/claude-agent-sdk` 0.3.261 (CLI 2.1.261), `@openai/codex-sdk` 0.153.4. Next free ruling number is 369.

Two corrections to the research note, found while pinning versions: viberr's stored Claude transcripts already carry the TTL split (`usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` on all 18,869 calls) and, in 13 of 400 runs, `diagnostics.cache_miss_reason` (`previous_message_not_found` 18, `unavailable` 8, `messages_changed` 3). Every measured call, all three kinds, was in the **1-hour bucket**. So the measurement work below is mostly about storing and showing what the stream already says.

## 0. What the numbers say the money is

> **Implemented 2026-09-21 as rulings 369–374** (one change, not the seven PRs below; the owner asked for the whole of it end to end). Deviations from this plan, each with its reason: the resume policy (PR 3) reads the LAST call's prompt (`last_prompt_tokens`, else the provider transcript) rather than the peak — a run that compacted at 250k and finished at 20k replays 20k, and refusing it would discard the summary compaction just built; the run row also stores `last_prompt_tokens` and `credential_kind` (the TTL follows the kind the run billed, not the person's current row); a set-aside session is stamped `run·session_stale` (a meta line) rather than `session_missing`, so `latestSessionRun` does not skip a live session and no classifier reads a decision as a fault; Codex per-call figures come off the rollout at finalize because the SDK streams turn totals only; the controller's authority tiers stay beside its ceiling sentence (ruling 309) in the dynamic tail rather than moving to the static block; PR 7's owner decision is recorded as ruling 374 (automatic TTL, nothing forced). The re-measured baseline and its corrections are in `RESEARCH.md` (§1 note).

| kind | first-call cold | avg first-call write | cache reads / run | peak prompt (median · p90 · max) |
|---|---|---|---|---|
| operator (247) | 2% | 4.4k | 609k | 48k · 59k · 97k |
| specialist (147) | 73% | 14k | 10.0M | 108k · 226k · 482k |
| controller (6) | 100% | 320k (two at 911k/929k) | 3.78M | 146k · 948k · 948k |
| codex (153) | 16 runs under 10% cached | – | 96% of 4.4M input cached | – |

Three cost centres, in order of size for a seat that is billed per token (an API key, or a subscription seat in extra usage):

1. **Cache reads on long specialist runs.** Reads are cheap per token (0.1x) but the volume is enormous: 1.47 billion read tokens over 147 runs, about $735 at Opus 5 prices in four days. A 300-call run at 240k average context reads 72M tokens, about $36. The lever is smaller contexts, which means compacting earlier and bounding run scope. Cold starts are noise next to this.
2. **Whole-history re-writes on resume.** Three first calls wrote 2.14M tokens (929k, 911k, 298k), about $13. Rare, but each one is a mistake with a name: a session resumed after the cache lapsed. The lever is a resume policy plus a compaction window so no thread can reach 950k.
3. **Cold starts on specialist dispatch.** 108 runs × 14k, about 1.5M write tokens, about $9. Structural and cheap to fix, but the smallest of the three.

On a subscription seat within its plan the same three drive usage-limit burn instead of dollars; cache reads count at an undisclosed lower coefficient and writes count fully, so the ranking holds.

## 1. Shared contract for both backends

Encode these once, in one module each, and make both runtimes consume them. One home per fact is an existing invariant.

**`app/server/runtimes/context-policy.server.ts`** (new): the numbers.

| constant | value | applies to |
|---|---|---|
| `AUTO_COMPACT_WINDOW.*` | none (ruling 376, owner: "drop it, model default"; first shipped as 250k specialist / 300k controller / 180k Codex) | both backends: the CLI compacts at its model's own limit |
| `COMPACT_AT_COMPLETION_TOKENS` | 100,000 (ruling 376, owner's number) | both backends: a run that ends above it has its session compacted at once, while warm — Claude by `/compact` on the run's session, Codex through the app-server's `thread/compact/start` |
| `RESUME_FRESH_AFTER.tokens` | 150,000 peak prompt tokens | both backends |
| `RESUME_FRESH_AFTER.idle` | Claude: 60 min for a `login` credential, 5 min for `api_key`; Codex: 10 min | both backends |
| `CACHE_TTL_POLICY` | leave the CLI's automatic choice; no forced TTL, no keep-alive | Claude |

**`app/server/runtimes/prompt-prefix.server.ts`** (new): the ordering rules.

- A prompt is built as `{ static: string[], dynamic: string[] }`. Static holds nothing that varies per task, per run or per minute: definition, project persona, skill bodies, KB documents, ruling-namespace note, resource ground truth. Dynamic holds the workspace section, MCP gating and health notes, missing-resource notices, priority note.
- Every list in the static block is sorted by name before rendering: skills, KB documents, MCP servers, tool denials. Serialization is deterministic (no object-key-order dependence, no `Date`, no run id, no absolute path).
- Claude consumes it as `systemPrompt: [...static, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...dynamic]` for custom prompts; Codex consumes `developer_instructions = [...static, ...dynamic].join("")`, same text, same order.
- A unit test builds the same profile for two different tasks and asserts the static block is byte-identical and the dynamic block differs only where the task differs; a second test shuffles the input lists and asserts identical output.

## 2. Work packages

Each package is one PR: code, tests, the docs page it touches, and a numbered ruling in `docs/architecture/decisions.md`. Gates: `npm run lint && npm run typecheck && npm test`; `npm run e2e` for PR 2 to PR 6 because they change what the real CLI receives.

### PR 1 — Measure it (ruling 369)

Goal: every later decision is checkable on the live board.

- `wire-format.server.ts`: extend the usage schema with `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens` and `diagnostics.cache_miss_reason { type, cache_missed_input_tokens }`, all `.catch`-tolerant, so an older stream still parses. Codex: `cache_write_input_tokens` is already on the SDK `Usage` type; read it.
- `run-store.server.ts` + baseline schema (pre-production, no migration; document the restore recipe as before): new columns `cache_write_tokens`, `first_call_prompt_tokens`, `first_call_cache_write`, `first_call_cache_read`, `first_call_miss_reason`, `cache_ttl_bucket` (`5m` | `1h` | `mixed`), `peak_prompt_tokens`, `compactions` (count of `compact_boundary` system messages in the run).
- `run-sink.server.ts` / `run-projection.server.ts`: fold them per run; the first assistant envelope defines the first-call figures.
- Console strip (`RunView`): one chip, "warm start" or "cold start · 298k written", derived from the first-call figures; the tokens cell gains "written / read" on hover. Insights page: warm-start rate by kind, write/read ratio by kind, count of first calls writing over 100k, TTL bucket distribution by credential kind.
- Audit: a `task.agent.compaction` event when a `compact_boundary` arrives (with pre/post token counts from the message), so compactions become visible on the timeline.
- Tests: wire-format fixtures with the breakdown and with `cache_miss_reason`; projection tests; jsdom tests read `data-*` attributes, not text.
- Acceptance: the insights page reproduces the baseline table above from the stored rows.

### PR 2 — Specialists: shared prefix, pinned prompt, bounded context (ruling 370)

Claude side, `claude-runtime.server.ts`:

- `systemPrompt: { type: "preset", preset: "claude_code", append: persona, excludeDynamicSections: true, snapshot: true }` for `kind === "specialist"`. The first removes the per-task working directory, git status and memory paths from the system prompt (they move into the first user message), so dispatches of the same profile share one system-prompt cache entry. The second records the system prompt on the first request so a resume does not rebuild it; on 0.3.261 recording is off by default for appends, so it must be explicit.
- Determinism: pass `skills` sorted; build `mcpServers` from sorted keys; sort `allowedTools` / `disallowedTools`.
- Env, in `startRun`'s overlay (`run-service.server.ts`, where the credential env and the run marker are merged): `CLAUDE_CODE_AUTO_COMPACT_WINDOW=250000` when the kind is specialist. The hermeticity test pins the allowed keys; add it there.
- Hooks (`options.hooks`): a `SessionStart` matcher on `compact` whose callback returns `additionalContext` with the task anchor: task key and goal line, the task.md path, branch and PR, the KB index with the `read_knowledge_doc` hint, the ruling-namespace note, and "re-read task.md before continuing". A `PreCompact` callback that only logs (its `custom_instructions` field is input, not output).
- Persona hygiene: the append is already task-independent; the MCP health and browser-refusal sentences vary per run and belong in the dynamic tail. Move them to the user turn.

Codex side, `codex-runtime.server.ts`: `config.model_auto_compact_token_limit = 180_000`, `config.model_auto_compact_token_limit_scope = "total"`, and `config.compact_prompt = VIBERR_COMPACT_PROMPT` (one shared string, in `context-policy.server.ts`): keep the task key and goal, the task.md pointer, branch and PR, the names of attached KBs and how to re-read them, pending work, failed attempts and why they failed, decisions taken. All three keys are present in the 0.153.4 binary; `model_post_turn_compact_threshold_percent` is not, so post-turn compaction is out of reach until the next Codex upgrade.

What compaction keeps and drops, for the ruling text: Claude keeps the system prompt (persona, inlined KBs) untouched, re-injects invoked skill bodies capped at 5k per skill and 25k total, drops tool results and reasoning and the index of un-invoked skills, and re-reads up to five recent files under 5k tokens. Codex keeps `developer_instructions` by construction, keeps recent user messages within a 20k budget plus the summary, drops earlier assistant turns, tool calls, outputs and reasoning.

- Docs: `domain/agents-and-runtime.md` §2.4 and §2.5, `operations/configuration.md` §3, `architecture/data-model.md` for the new columns' meaning.
- Tests: an options test asserting the preset object for specialists and its absence for operator and controller; the env test; the hook returns the anchor for a fixture task; the Codex config builder snapshot includes the three keys; determinism tests from §1.
- Acceptance (two days of PR 1 data): specialist cold-start rate under 20% for same-profile dispatches within an hour; no specialist call above 260k prompt tokens; rework rate (request-changes per delivered revision) unchanged.

### PR 3 — Resume policy by age and size, both backends (ruling 371)

- `run-service.server.ts` `resumeRun`: after the existing continuity check, compute idle time since `prev.finished_at` and read `prev.peak_prompt_tokens` (PR 1). If idle exceeds the backend's `RESUME_FRESH_AFTER.idle` for the credential kind and the peak exceeds 150,000, take the existing fresh-turn path (`continuityResetPreamble` + `task.md` anchor + the last agent report) with a new `ContinuityLossReason` `stale_large_session`. It is not `session_missing`: the transcript exists, we are choosing not to replay it. Timeline note: "Started a fresh session: the previous one was 298k tokens and 74 minutes old."
- Controller (`controller-run.server.ts`): same rule; the fresh turn carries the last N stored conversation turns, capped by tokens, since the controller store holds them.
- Codex: the same code path; its idle threshold is 10 minutes until measurement (PR 6) shows the effective retention.
- Tests: pinned clock (`FROZEN_NOW`, never the wall clock), both branches, thresholds imported from `context-policy.server.ts`, controller path, Codex path.
- Acceptance: over a week, zero first calls writing more than 200k; `stale_large_session` rows are visible in the console and rare.

### PR 4 — Controller: bounded context and pinned prompt (ruling 371, second part)

- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000` for controller runs.
- `systemPrompt: { type: "custom", prompt: controllerPrompt, snapshot: true }` (the custom object form accepts `string | string[]`, so the boundary split from PR 5 can be added later without changing shape).
- `SessionStart` on `compact`: re-inject the conversation anchor (conversation id, scope binding, the board or project it is standing on, the `viberr_ops` availability line).
- The controller's tools stay deferred behind ToolSearch; deferred tools only append and keep the cache. No change.
- Acceptance: controller peak prompt at or below about 320k; first calls of resumes within the hour read the prefix instead of writing it.

### PR 5 — Operator: boundary split and byte stability (ruling 372)

- `buildOperatorSystemPrompt` returns `{ static, dynamic, inputs }` through `prompt-prefix.server.ts`. Static, in order: shipped definition, project persona override, skills, KBs, ruling-namespace note, resource ground truth, priority note, closing rules. Dynamic: workspace section, MCP gating notes, unhealthy and missing notices. The trigger doctrine and the task snapshot stay in the user turn.
- Claude receives the `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`; Codex receives the joined string as `developer_instructions`. The operator is never resumed, so `snapshot` does not apply.
- Byte-stability audit of the static block with the §1 tests.
- Not in this PR, measure first: a per-project gate that serializes the first call of simultaneous fresh operator sessions (a cache entry exists only once the first response has begun, so a burst of stage moves on one project pays the write several times). Count bursts with PR 1 data before building it.
- Acceptance: operator warm-start rate stays at or above 98% while two tasks in one project alternate operator turns two minutes apart; each first call reads roughly the full prefix.

### PR 6 — Codex measurement and retention (ruling 373)

- Store `cache_write_input_tokens` and the first turn's cached ratio per Codex run (PR 1 columns).
- Retention probe: for Codex runs resumed after gaps over 10 minutes, record whether the first turn was cached. The 0.153.4 binary contains the string `prompt_cache_retention` once, so the CLI may already request 24-hour retention on the ChatGPT backend; two weeks of rows settle it and, if retention proves out, PR 3's Codex idle threshold moves from 10 minutes to hours.
- Explain the 16 low-cache runs: context above 160k, or gaps over 10 minutes, or neither. Each is a different fix (window, retention, or a bug report).
- Nothing to set for `prompt_cache_key` (per thread by the CLI) and nothing available in `config.toml` for retention.

### PR 7 — TTL decision, docs only unless the owner decides otherwise (ruling 374 if adopted)

Leave the CLI's automatic choice: 1 hour for the main conversation on a subscription seat within plan, 5 minutes on an API key, on usage credits, and for every subagent and compaction request. The arithmetic per kind for a billed seat:

- Operator: forcing 1h costs 0.75 × 16M incremental write tokens (about 12M base-equivalents over 247 runs) to avoid about 79 misses × 45k × 1.25 (about 4.4M). Keep 5m when billed.
- Specialists: the TTL only matters for resumes; after PR 3 the large stale ones are never replayed and the small ones re-write cheaply. Keep the default.
- Controller: a chatting human resumes within the hour; after PR 4 its per-turn writes are small, so 1h on a billed seat is the one place the 2x write is likely worth it. Offer `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` for controller runs on `api_key` credentials as an owner decision with PR 1 data attached.

No keep-alive pings on either backend: no built-in exists, the break-even is about 46 minutes of idle on the 5m tier, and on subscriptions each ping is a real request against the quota.

## 3. Order, gates and measurement recipes

1. PR 1, then let it collect two days.
2. PR 2 and PR 3 together (specialists are most of the volume).
3. PR 4, then PR 5, then PR 6.
4. PR 7 after a week of data.

Canaries, run in the image, all readable from the console after PR 1:

- **Prefix sharing (operator):** two tasks in one project, alternate operator turns two minutes apart, expect first-call read about the full prefix on both and write under 5k.
- **Prefix sharing (specialist):** dispatch the same profile on two tasks within ten minutes, expect the second first call to write near zero after PR 2. If it still writes the whole block, diff the two `init` messages' tool and skill lists; enumeration order drift is the known residual.
- **Resume policy:** resume a specialist whose run peaked above 150k after 70 minutes, expect a `stale_large_session` fresh turn and a first call under 60k written.
- **Compaction:** drive a specialist past 250k, expect one `task.agent.compaction` event, a first post-compaction call reading the system prompt and writing only the summary, and the task anchor visible in the transcript.
- **Codex retention:** dispatch, wait 15 minutes, comment, read the first turn's cached ratio.

## 4. Expected effect on the baseline

| metric | baseline | target after PR 1–6 |
|---|---|---|
| operator warm-start rate | 98% | ≥ 98% under task alternation |
| specialist cold-start rate | 73% | < 20% |
| specialist max peak prompt | 482k | ≤ 260k |
| specialist read tokens per 300-call run | ≈ 72M | ≈ 45–55M (window 250k), ≈ 30M if the owner later chooses 150k |
| controller first-call write | 320k avg, 929k max | < 30k typical; no first call above 200k |
| Codex peak input per turn | unmeasured | ≤ 200k |
| first calls writing > 100k (4 days) | 3 | 0 |

> **Owner's revision after the live run (ruling 376):** compacting mid-run at 250k did not
> touch the writes that dominate a long run; compacting a large session at the END of its
> run, while its cache is still warm, is the cheap case 374(d) named and it keeps the
> session's memory as the summary. So: no mid-run window on either backend (the model's own
> limit), and every run that ends above 100k is compacted at once — Claude through
> `/compact` on the run's session, Codex through the CLI's app-server, which has the
> `thread/compact/start` method that `exec` and the SDK lack. Ruling 372's fresh start stays
> as the backstop.

### Measured live, 2026-09-21 13:00–14:00 UTC (rulings 369–375 deployed on this instance)

Driven on the airbnb-clone project from Arda's seat (a Playwright script against the app's
own forms), one profile per case, read back from the run logs, the task files and the
console's facts row. Every operator turn after the priming one was warm; every specialist
second start was warm; the four compactions landed between 222k and 233k with the anchor
re-injected; both stale resumes started fresh under their own reason.

| metric | baseline (§1) | target | measured live |
|---|---|---|---|
| operator warm-start rate | 98% | ≥ 98% under task alternation | 3 of 3 measured turns warm on three tasks 2 min apart (read 24.4k, wrote 2.2–2.5k) after one cold priming turn (wrote 26.7k); the 13 operator reactions of the hour all warm |
| specialist cold-start rate | 73% | < 20% | the profile's first start of the day cold (19.8k written), every later start of that profile warm: BNB-26 read 13.4k / wrote 5.7k; the two 250k runs read 20.1k and 13.4k on their first call |
| specialist max peak prompt | 482k | ≤ 260k | 216.9k (both long runs compacted at 222.0k, 222.9k, 230.9k and 233.3k → 16–22k; the window is 250k, the CLI's own reserve fires the compaction below it) |
| specialist read tokens per 300-call run | ≈ 72M | ≈ 45–55M | not reached: the two 25-call runs read 2.38M and 2.40M (≈ 95k per call, one 12-page read each) |
| controller first-call write | 320k avg, 929k max | < 30k typical; none above 200k | not exercised live (no controller turn was owed); the rule and the recorded prompt are unit-tested |
| Codex peak input per turn | unmeasured | ≤ 200k | 175,226 tokens on the read thread before the stale reset (window 180k, scope `total`); the per-call figures now come off the rollout |
| first calls writing > 100k | 3 in 4 days | 0 | 0 in the hour (largest first-call write 26.7k, the operator's priming turn) |
| stale resume (Claude) | replayed whole | fresh session | BNB-28's 226k session, 18 h 41 min idle → fresh session (`run·session_stale`, timeline event, audit); the fresh first call wrote 19.8k |
| stale resume (Codex) | replayed whole | fresh session | BNB-30's 175k thread, 11 min idle → fresh thread (`run·session_stale`, timeline event); first call 15.8k, nothing cached |
| compaction keeps the persona, KBs, skills and the anchor | untested | proven | both sessions carry `hook_additional_context` with the anchor right after `compact_boundary`; the invoked skill and the three KB indexes are present after the boundary; both agents finished the 12-page read correctly (`IDBCursorWithValue` at line 22048) |
| compaction on Codex | untested | window 180k, summarizer prompt | BNB-31's thread compacted at 177,960 → 19,509 tokens (a resumed turn that crossed 180k on its 27th file); the replacement history keeps `developer_instructions` (persona, KB indexes), the canonical task state and the task key; the console chip, the "Context compacted" note and the audit row landed once the rollout reader learned the CLI's `compacted` line — the SDK streamed no compaction item |
| a prompted manual dispatch runs once (ruling 375) | ran twice | one run | after the fix: one run, one reply, the person's comment on the record before "Started a Codex run" (BNB-31, 14:01:51 → 14:01:52) |
| compaction at completion, Claude (ruling 376) | none | above 100k, warm | BNB-28's 232k session compacted at the end of its run to 3.7k (one warm request: 246k in, 6k out, $1.53); the row reads "1 compaction", `last_prompt_tokens` 3,672, the note and the audit say "at the end of the run"; the next resume replayed 22.6k (13.4k read, 9.2k written) and the agent named its three knowledge bases, its skill and its last measurement from the summary |
| compaction at completion, Codex (ruling 376) | none | above 100k, through the app-server | BNB-31's fresh thread read 20 files to 125,535 tokens and was compacted at the end of the run through `codex app-server` (`thread/compact/start`, the `contextCompaction` item) to about 8k; the row reads "1 compaction", the note and the audit say "at the end of the run"; the next resume replayed 18.8k (10.0k cached) and the agent named its three knowledge bases, its skill and its last measurement from the summary. Two defects found on the way: the run's settle sweep reaped both epilogues by their inherited run marker (they carry their own now), and the client waited for `ContextCompaction` where v2 sends `contextCompaction` (the rollout is the truth on Codex now, whatever the client heard) |

Two Codex facts the plan did not have: its cache is a per-thread affair — within one
process every call after the first read its prefix back (92% of a 2.26M-token turn), but a
new thread and a resumed thread both started with `cached_input_tokens` 0 eleven seconds
after an identical prefix (across every stored rollout, 330 of 774 first calls were warm) —
and `codex exec` died with `SIGBUS` on "Reading prompt from stdin" once (6 of 810 stored
Codex runs). A resumed Codex thread can be warm: the 14:14 resume five minutes after its
previous turn read 43.8k back, where the 11-second resume at 13:25 read nothing — the
provider's routing decides, not Viberr's prefix. The model also defends its own context:
asked to fill it with `cat`, `gpt-5.6-terra` twice clipped its tool outputs to 100 and then 1
tokens ("truncated output, 3629 tokens truncated") and reported the files read; a fresh
thread with an unpoisoned history read them in full. And one Viberr defect the validation caught: a prompted manual dispatch ran
twice (ruling 375).

## 5. Risks and what covers them

- `excludeDynamicSections` moves the working directory into the first user message. Repo-write confinement does not depend on it (GIT_CEILING_DIRECTORIES and the deny rules enforce it); run one e2e dispatch and confirm the agent still edits the right checkout.
- `snapshot: true` means an edited persona reaches a resumed session only after its next compaction; document it beside the existing "resume prefers the current profile model" rule, and remember a model switch forfeits the cache (the `PostModelSwitch` hook input says so).
- A compaction window drops tool results mid-run; the compact-source anchor and task.md carry the state. Watch the rework rate for two weeks; if it rises, raise the window before abandoning it.
- The fresh-session policy loses in-context history by design; the preamble, task.md and the last report carry it, and the row is visible so a human sees it happened.
- Upgrading the SDK past 0.3.267 flips `snapshot` to default-on; setting it explicitly now means no surprise. The 2.1.26x CLI adds `cache_miss_reason` on more misses; PR 1 already stores it.
- Codex compaction summaries are lossy and OpenAI itself advises short threads; PR 3's fresh-thread rule is the safety net.

## 6. Deliberately not doing

Keep-alive pings; forcing 1h on operator runs; the `context-1m` beta (1M is default on current models, at standard pricing); "compact after every run" as a cache strategy (a cold compaction costs what the resume it replaces would cost); lazy-loading the operator's KBs (inlining is what keeps its prefix stable and its first calls warm).
