# Prompt caching for viberr's operator, specialist, controller and Codex runs

Research note, 2026-09-21 (`planning/prompt-cache-2026-09-21/RESEARCH.md`; the implementation plan is `PLAN.md` beside it). Written by hand from the stopped research workflow's journal: 27 fetched sources (S1–S27, listed at the end), 110 extracted claims, and 24 adversarial votes on 8 of those claims (7 confirmed 3–0, 1 refuted 3–0). Claims that carry a `[confirmed]` tag survived the 3-vote verification; everything else is an extraction from the cited page that was not independently re-verified. The viberr measurements come from the last 400 Claude and 200 Codex run transcripts under `docker-data/runtimes/` (2026-09-17 to 2026-09-20) and from the code on `main` @ 3b4a95c3. No code was changed.

## 1. What viberr's own numbers say

> **Re-measured 2026-09-21 while implementing (rulings 369–374).** Four corrections to this note, from the same 400 Claude and 200 Codex transcripts and the projection rows behind them:
> 1. The 911k and 929k controller writes are the TTL-expiry shape after all: 39 hours and 71 minutes idle since the previous turn on the same 945k conversation. The 298k specialist write was NOT — 16 minutes idle, `diagnostics.cache_miss_reason.type = "messages_changed"` with 240k tokens missed, a reconstruction miss inside the TTL (the S8 family). Ruling 372's age-and-size rule removes the first two; the third is now recorded on every run (`first_call_miss_reason`) so the data can decide whether a size-only rule is needed.
> 2. The "16 low-cache Codex runs" (§3 Codex 4) are 16 single-call operator turns of about 26k input tokens with nothing cached — cold Codex OPERATOR starts, not context past 160k. Codex reports `cache_write_input_tokens = 0` on every stored run; the SDK defaults the field.
> 3. A resumed Codex thread does NOT report a cumulative total: `turn.completed.usage` is the turn's total over its calls (a thread's first run stored 3.46M input tokens, its resumed run 67k). The per-call prompt sizes are in the rollout's `token_count` lines (`last_token_usage`), which the run service now reads at finalize.
> 4. The sample: 199 operator runs in the last 400 Claude transcripts (3 cold, 1 of 141 within 5 min, 0 of 55 between 5 and 60 min, 1 of 2 past 60 min), 147 specialists (108 cold), 3 identifiable controller turns; the §1 table's 247 operator runs came from a wider window. The conclusions stand.
> 5. Measured live after the change (2026-09-21, PLAN.md §4): Codex's prompt cache does not cross threads — a second thread of the same profile and a resumed thread both started with `cached_input_tokens` 0 (330 of 774 stored first calls warm), while calls inside one process read 92% back; so on Codex the stable prefix pays within a run and only sometimes across processes (a resume 5 minutes later read 43.8k back, one 11 seconds later read nothing), and ruling 372's Codex arm stays the right price. The one Codex compaction measured (177,960 → 19,509 under the 180k limit) is recorded by the CLI as a top-level `compacted` rollout line plus a `ContextCompaction` item, not as a streamed SDK item — the reader now counts those (ruling 369(c)). Claude behaved as §3 predicted: shared specialist prefix across tasks, compactions at 222–233k under the 250k window, anchor back after each.

| kind | runs | model calls / run | first-call cache write | first call cold | cache write / run | cache read / run | peak prompt median · p90 · max |
|---|---|---|---|---|---|---|---|
| operator | 247 | 15.7 | 4.4k | 5 of 247 | 65k | 609k | 48k · 59k · 97k |
| specialist | 147 | 101 | 14.1k | 108 of 147 | 227k | 10.0M | 108k · 226k · 482k |
| controller | 6 | 24 | 320k | 6 of 6 | 1.41M | 3.78M | 146k · 948k · 948k |

- **The operator is already warm.** Cold first calls by gap since the previous operator run (any task): under 5 min 2 of 167, 5 to 60 min 1 of 75, over 60 min 3 of 4. That is the signature of a one-hour TTL, which is what Claude Code gives the "main conversation" bucket on a subscription seat within its included usage (S2 `[confirmed]`, S10). Confirmed directly: every one of the 18,869 stored calls carries `usage.cache_creation.ephemeral_1h_input_tokens` and zero `ephemeral_5m_input_tokens`, for all three kinds. Thirteen of the 400 runs also carry `diagnostics.cache_miss_reason` (`previous_message_not_found` 18 times, `unavailable` 8, `messages_changed` 3), so the miss-attribution data already exists in the transcripts; viberr's sink just does not store it.
- **Specialists are cold on almost every dispatch, but cheaply.** 108 of 147 first calls wrote about 14k tokens. Cause: the `claude_code` preset places the working directory, git status and memory paths in the system prompt *before* the appended persona, so every task workspace is a different prefix (S23 `[confirmed via S2 cache-scope]`). Over the four days that is roughly 1.5M write tokens, about $9 at Opus 5-minute write pricing. The real specialist cost is elsewhere: 10M cache reads per run (about $5 per run on Opus, $2.50 on Fable) and the occasional resume after expiry (one first call wrote 298k).
- **The 911k and 929k controller writes are plain resumes, not compactions.** A verifier read those two transcripts: no `compact_boundary` in either; across 1,832 stored runs exactly one ever compacted, and it did so at 972k tokens, after a 968k cold resume. Resuming replays the entire transcript; once the cache has lapsed the whole history is one cache write (S21, S25, verifier v1 on claim 2.4).
- **There is no 200k pricing cliff to compact under.** Claude 4.6 and later and the Fable models bill the full 1M window at standard rates; 1M is the default with no beta header (S3, S6, S26). The `context-1m` beta flag in viberr's typings is unnecessary on current models. Compaction thresholds should be set for quality, cache-write size and rate limits, not price.
- **Subscription accounting is the unknown.** Cache reads still draw down plan usage at an undisclosed lower coefficient; cache writes count at full rate (S4, S10). On API keys, cache reads do not count toward input-tokens-per-minute limits but cache writes do (S5).

## 2. Mechanics that decide the options

- **Prices** `[confirmed 3–0]`: 5-minute cache write 1.25x base input, 1-hour write 2x, cache read 0.1x (0.025x on Fable 5.1). A 5m write pays for itself after one read, a 1h write after two (S1, S3). Per MTok: Opus 5 = $5 base / $6.25 5m write / $10 1h write / $0.50 read; Fable 5.1 = $10 / $12.50 / $20 / $0.25; Sonnet 5 = $2 / $2.50 / $4 / $0.20 (S3).
- **Refresh on read at no cost; lifetime measured from the start of the request** `[confirmed 3–0]` (S1). The operator's 16 calls per run therefore extend the window from its last call.
- **Prefix hierarchy tools → system → messages** `[confirmed 3–0]`: any change to a tool definition invalidates everything; up to 4 breakpoints; a 1h breakpoint must precede any 5m one (S1). Deferred tools (tool search) only append and keep the cache; `alwaysLoad` servers, a stdio server restart or a tool-list push invalidate it `[confirmed 3–0]` (S2).
- **Claude Code picks the TTL per request** `[confirmed 3–0]`: main conversation gets 1h on a subscription within included usage; 5m on an API key, on usage credits (extra usage), Bedrock, Vertex and Foundry; subagents, forks and the compaction request itself always get 5m. `CLAUDE_CODE_PROMPT_CACHE_TTL` and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` (`5m` or `1h`, CLI 2.1.242+, viberr bundles 2.1.261) override, with `FORCE_PROMPT_CACHING_5M=1` above them (S2, S10, S15).
- **Cache scope in Claude Code is one machine plus one directory** `[confirmed 3–0]`; `excludeDynamicSections` exists to share one cache across directories (S2, S7, S23).
- **Compaction** keeps the system prompt and output style unchanged, re-injects project-root CLAUDE.md and auto memory from disk, re-injects the bodies of skills that were *invoked* (capped 5k tokens per skill, 25k total, oldest dropped first), and does **not** re-inject the startup skill listing. It replaces the conversation with a structured summary: full tool outputs and intermediate reasoning are gone; up to five recently touched files under 5k tokens are re-read. A SessionStart hook matching the `compact` source can add pinned context after compaction (S20, S24). The summarization request carries the same system prompt, tools and history plus an instruction: cheap while the cache is warm, a full uncached pass after it has lapsed (S2; the original claim was refuted 3–0 only for its add-ons, the mechanics above are what the verifiers upheld).
- **`snapshot`**: Claude Code records the system prompt on a session's first request and reuses it until compaction, so a changed append on resume does not invalidate the prefix. SDK 0.3.261 does **not** record custom prompts or appends by default; 0.3.267 flipped that default. On 0.3.261 set `snapshot: true` explicitly on any session that will be resumed; where recording is not yet enabled for an account it is accepted and ignored (S22, S23).
- **`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`**: a `string[]` system prompt splits at the marker into a static block and a dynamic block, each with its own breakpoint; first-party API only, TypeScript only (S7, S22, S23). One reporter traced that everything after the boundary becomes a single org-scoped unit (S9); harmless for viberr because the task-specific tail is small.
- **Resume and fork** replay the whole transcript; Anthropic's own SDK guidance for ephemeral hosts is "don't rely on session resume", carry results as application state into a fresh session (S21, S25). Transcripts live under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/`, same machine only, cross-directory lookup from CLI 2.1.223 (S25).
- **Known resume misses inside the TTL**: dropped thinking blocks on a resumed background agent produced 243k and 399k writes 50 minutes into a 1h TTL (S8, open issue); `--resume` full miss regression fixed in 2.1.90 (S10); nondeterministic Agent-tool listing order on an older SDK (S14, closed stale). Attribute a cold first call via `diagnostics.cache_miss_reason` before blaming expiry; the field is present in 13 of viberr's last 400 transcripts, and `previous_message_not_found` (18 occurrences) is the resume-reconstruction shape rather than TTL expiry.
- **Keep-alive pings**: no built-in; break-even against one re-write is about 46 minutes of idle on the 5m tier and about 17 hours on the 1h tier; on subscriptions each ping is a real request against the quota (S15). Not worth building.
- **Codex / OpenAI**: automatic prefix caching from 1,024 tokens; `prompt_cache_key` is set per thread by Codex; retention on pre-GPT-5.6 models is `in_memory` (5 to 10 min idle, at most 1h) or `24h`, with 24h the default for organizations without zero-data-retention per OpenAI's docs (S16). Whether the Codex CLI sends `prompt_cache_retention` is disputed: not as of 0.135 (S17), while a cross-referenced issue implies 0.148+ sends it. `config.toml` has no cache knob at all (S18, S27). Compaction knobs: `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope`, `compact_prompt` / `experimental_compact_prompt_file` (S18, S27). Codex compaction rebuilds history as recent user messages within a 20k budget plus the summary; earlier assistant turns, tool calls, outputs and reasoning are dropped; `developer_instructions` are re-rendered by construction; Codex itself warns to start a new thread rather than compact repeatedly (S19). The opt-in post-turn compaction landed 2026-09-19, after 0.153.4. One Azure report saw the cache collapse past ~160k of context under server memory pressure with 5 to 27 s between calls (S17).

## 3. Ranked options, per surface

### Operator (fresh session per turn, already warm)

1. **Keep the fresh-session design.** It is what Anthropic recommends for ephemeral hosts (S25), and the measurements show no cross-run miss problem to fix. Expected effect: none needed.
2. **Do not force the 1h TTL for API-key people.** Arithmetic on the sample: a 1h TTL charges every incremental write at 2x instead of 1.25x, and the operator writes about 65k per run (16M over 247 runs), so 1h costs an extra 0.75 × 16M ≈ 12M base-token-equivalents. The misses it would prevent are the 79 runs with gaps over 5 minutes, each re-writing a ~45k prefix: 79 × 45k × 1.25 ≈ 4.4M. The 5m default is cheaper for the operator on API billing; subscription seats already get 1h for free. Risk: a subscription seat that spills into extra usage silently drops to 5m (S2, S10). If that matters, set `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` only for `login`-kind credentials, in the run env overlay in `run-service.server.ts`.
3. **Split the system prompt at the dynamic boundary** as insurance, not as a measured win: static block = shipped definition, project persona, skill bodies, KB documents, ruling note, resource ground truth; boundary; dynamic block = workspace section, MCP gating notes, unavailable and missing notices, closing rules (S7, S22, S23). Keep the trigger doctrine and the task snapshot in the user turn, as today. Apply the byte-stability rules: sorted KB and skill order, deterministic serialization, no timestamps or run ids in the static block (S11, S9). Verify by diffing two first-call request bodies rather than assuming (S14, S22).
4. **Keep the KBs inlined for the operator.** Inlining is cache-friendly and stable; a 45k prefix read 16 times costs about 72k base-token-equivalents per run. Lazy loading (index plus `read_knowledge_doc`) trades that for attention budget (S12) and should be reconsidered only if KBs grow well past the current size.
5. **Serialize simultaneous fresh sessions on a shared prefix.** A cache entry exists only once the first response has begun; a burst of stage moves that launches several operator runs at once all pay the write (S1 claim 1.4). The single-flight-per-task lease covers one task, not a board-wide burst.

### Specialists (developer and reviewer)

1. **`excludeDynamicSections: true` on the preset** (SDK 0.2.98+): moves the per-task working directory, git status and memory paths into the first user message so every dispatch of the same profile shares one system-prompt entry (S7, S23). Expected: most of the 108 cold first calls stop paying the 14k write. Caveat: one measurement recovered only 38% of the block because skill and slash-command enumeration order drifted between sessions (S14); viberr passes plugin skill names itself, so sort them, and check the `init` tool list is byte-stable.
2. **Set an auto-compact window** with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (plain token count, 100k to 1M, overrides everything else) at roughly 250k. Today a native-1M model compacts only near 967k (S26), which is how runs reach 482k per call and the controller reached 948k. What compaction costs a specialist: tool results (including `read_knowledge_doc` output and diffs) and reasoning; what it keeps: the persona and inlined KBs (system prompt), invoked skill bodies up to the caps, five recent files (S20, S24). Pair it with a **SessionStart hook on the `compact` matcher** that re-injects the task anchor: task.md path, branch, PR, the KB index, the ruling namespace note (S24). Anthropic's own harness team found compaction alone insufficient for multi-hour builds and moved to resets over a progress file and git history (S13); task.md and the PR are viberr's equivalent, which argues for a window that keeps runs bounded rather than for compaction as the main continuity mechanism.
3. **`snapshot: true`** on specialist runs, since they are resumed on comments and mentions (S22, S23). Consequence to document: an edited persona reaches a resumed session only after its next compaction.
4. **Resume policy by age and size.** A resume after the TTL re-writes the entire history (298k measured, about $1.90 on Opus at 5m write pricing, $3 at 1h). When the prior session is both older than the TTL and larger than about 150k tokens, start a fresh session anchored on task.md and the last report instead of resuming, which is the path viberr already takes when the transcript is gone (S21, S25). Below that size, resume as today.
5. **Leave the subagent TTL alone.** Subagents get 5m even on a subscription (S2, S15); their inter-turn gaps are seconds.

### Controller

1. **Auto-compact window around 300k** so a thread never reaches 950k; the 911k and 929k writes were the price of resuming un-compacted threads (verifier v1). Expected: a resume after expiry re-writes at most the window, roughly a third of today's worst case, and a warm compaction is cheap.
2. **Fresh session over a stale large thread.** The controller stores its conversations; when the provider session is older than the TTL and large, rebuild the model context from the stored recent turns in a fresh session instead of replaying 900k of tool traffic (S25). Keep resume for short or recent threads.
3. **`snapshot: true`** (S22, S23). The controller's tools stay deferred, which is cache-safe (S2).

### Codex

1. **Nothing to set for retention.** No config knob exists (S18, S27); `prompt_cache_key` is already per thread (S17). Measure whether the ChatGPT-backed CLI benefits from 24h retention by checking `cached_input_tokens` on the first turn after gaps over 10 minutes.
2. **`model_auto_compact_token_limit` around 150k to 200k** plus a `compact_prompt` override that tells the summarizer to preserve the task.md pointer, KB references and pending work (S18, S27). Rationale: cache collapse past ~160k under memory pressure (S17), Codex's own advice to keep threads small (S19), and the fact that `developer_instructions` survive compaction by construction while tool output does not (S19).
3. **Same resume policy as specialists**: prefer a fresh thread anchored on task.md over resuming a long one (S19).
4. **Look at the 16 low-cache runs** for context above 160k and for gaps over 10 minutes before changing anything else; the fleet is 96% cached already.

## 4. What not to do

- Keep-alive pings, on either TTL (S15).
- Forcing 1h for API-key operator runs (arithmetic above).
- Adding the `context-1m` beta or reasoning about a 200k price step (S3, S6, S26).
- "Compact after every run" as a cache strategy. The compaction request is itself a full-history call: cheap when warm, as expensive as the resume it was meant to avoid when cold (S2). It only helps a run that will be resumed later with a history large enough to matter, which is what the age-and-size resume policy above targets directly. The fear that compaction "loses skills and KBs" is only partly right: inlined KBs and the persona survive untouched, invoked skills come back capped, and what is really lost is tool results, reasoning and the un-invoked skill index (S20, S24).

## 5. Disagreements and things that could not be verified

- How cache reads count against Pro and Max usage limits: the coefficient is undisclosed (S4, S10); the keep-alive plugin's claim that subscription quota is metered by request count is unsourced (S15).
- Whether the post-compaction turn rebuilds only the summary (docs, S2) or about 97.5k of re-attached stable content every time (measured in an open issue cited by verifier v2).
- Whether resumed sessions inside the 1h TTL miss because the harness drops thinking blocks (S8, open, no vendor reply).
- Whether system-prompt recording is enabled for the owner's accounts ("rolling out", S22).
- Whether the Codex CLI sends `prompt_cache_retention` on the ChatGPT backend (S17 versus its cross-reference). *(Settled for 0.156.0 by ruling 506: the name occurs once in the binary, in bundled docs prose, so no request field carries it; the backend's own default is what applies.)*
- The single-org-unit behaviour after the dynamic boundary (S9, one reporter, no maintainer confirmation).

## 6. Suggested order of work

1. Instrument first: store the per-call `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` split and `diagnostics.cache_miss_reason` (both already in the stored transcripts; the sink keeps only the four totals) and surface write versus read per run kind. Every decision above becomes checkable.
2. Specialists: `excludeDynamicSections`, `snapshot: true`, sorted skill names, auto-compact window ~250k, compact-source SessionStart hook with the task anchor.
3. Controller: window ~300k, fresh-session-over-threshold policy, `snapshot: true`.
4. Operator: boundary split and byte-stable ordering; leave the TTL default.
5. Codex: `model_auto_compact_token_limit` and `compact_prompt`; measure retention.

## Sources

- S1 https://platform.claude.com/docs/en/build-with-claude/prompt-caching (primary)
- S2 https://code.claude.com/docs/en/prompt-caching (primary, current to CLI 2.1.265)
- S3 https://platform.claude.com/docs/en/about-claude/pricing (primary)
- S4 https://code.claude.com/docs/en/costs (primary)
- S5 https://platform.claude.com/docs/en/api/rate-limits (primary)
- S6 https://platform.claude.com/docs/en/build-with-claude/context-windows (primary)
- S7, S23 https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts (primary)
- S8 https://github.com/anthropics/claude-code/issues/94728 (issue, 2026-09-16, open)
- S9 https://github.com/anthropics/claude-code/issues/94815 (issue, 2026-09-16, open)
- S10 https://github.com/anthropics/claude-code/issues/46829 (issue, 2026-04, staff replies)
- S11 https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus (blog, 2025-07)
- S12 https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (2025-09)
- S13 https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11, follow-up 2026-03)
- S14 https://github.com/anthropics/claude-code/issues/49038 (issue, 2026-04, closed stale)
- S15 https://github.com/anthropics/claude-code/issues/95728 (feature request, 2026-09-20)
- S16 https://developers.openai.com/api/docs/guides/prompt-caching (primary)
- S17 https://github.com/openai/codex/issues/25604 (issue, 2026-06, open)
- S18, S27 https://learn.chatgpt.com/docs/config-file/config-reference (primary)
- S19 https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs (source, last commit 2026-09-19)
- S20, S24 https://code.claude.com/docs/en/context-window (primary)
- S21, S25 https://code.claude.com/docs/en/agent-sdk/sessions (primary)
- S22 https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md (primary, to 0.3.278)
- S26 https://code.claude.com/docs/en/model-config (primary)
