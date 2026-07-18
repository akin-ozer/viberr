# Agent-runtime verification — operator / skills / MCP / parity (2026-07-18)

Verified the core agent-runtime behaviors the goal names, by inspecting the REAL completed run
artifacts on disk (`data/runtimes/{claude,codex}/*.jsonl` + `agent_runs`) rather than launching new
(expensive, largely duplicative) runs. Sample: the viberr project's 48 primary/reviewer/operator runs.

## 1. Operator agent selection — CORRECT
The operator routes by task nature (from `agent_runs` primary-run backend per task):
- **Docs tasks → Claude "Docs Writer"**: VIB-3,4,5,6,9,10,13,14,15,16,17,19,20.
- **Code tasks → Codex "developer"**: VIB-1 (list files), VIB-7 (QA marker *constant, code*).
- **Explicit overrides honored**: VIB-18 ("Codex-forced docs task") → codex; VIB-2 (codex probe).
- VIB-21 (interrupt test) has both a claude and a codex run — matches the interrupt-mid-run case.

## 2. Skill loading — CORRECT + isolated (definitive, controlled)
The `docs-style` skill (`data/skills/docs-style/SKILL.md`) is a fixture carrying a marker
`DOCS-STYLE-MARKER-P7` the agent must echo IF the skill loaded. Viberr injects a declared skill as
SYSTEM-PROMPT TEXT (not an SDK skill) — `specialist-run.server.ts:1075-1077` reads each declared
skill's body into the persona; `claude-runtime.server.ts:316-318` sets `skills:[]/settingSources:[]/
plugins:[]` so the SDK contributes none.
- ✅ **Declared skill loaded**: 36 Claude Docs-Writer/Style-Reviewer runs emitted the marker.
- ✅ **Isolation (negative control)**: 0 Codex/`developer` runs (which don't declare docs-style)
  emitted it.
- ✅ **Leaked SDK skills inert**: every claude run's init lists 16 UNRELATED host skills
  (deep-research, dataviz, debug, code-review, doctor, loop, …) despite `skills:[]`, but the Skill
  tool was invoked **0 times** across ALL runs — they never affected behavior (context-filter intent
  holds). See the OPEN QUESTION below.

## 3. MCP (notes-fixture) — WORKS (corrects a stale note)
The Docs Writer declares `mcps:[notes-fixture]`. Init lists the server (`status: pending` at init).
Agents invoked its tools 21× (`get_note` ×5, `get_viberr_release_notes` ×16) and the tool_results
returned real data (8 ok / 0 err — e.g. VIB-14's own goal). So the notes MCP is functional end-to-end
in these runs — the earlier "MCP fixture was dead / points at old scratchpad" note is OUTDATED for the
current dataset.

## 4. Codex/Claude parity — HOLDS
Both backends ran as primary specialists and delivered (codex: VIB-1,2,7,18; claude: the rest). Both
route through the one canonical completion pipeline; codex reports `turns=1` (single SDK turn) vs
claude incremental — cosmetic (F-PARITY1), already known.

## RESOLVED (docker-verified 2026-07-18, commit 51f29f5) — skill leak is REAL in production
The open skill-leak question was chased via `docker compose` at the owner's request, and the answer
overturns the prior assumption:
- Built + ran the STANDALONE container (compose.yml): production node process, pristine
  `CLAUDE_CONFIG_DIR=/data/runtimes/claude-home`, NO host `~/.claude`, non-root `node` user — i.e.
  NOT nested in any Claude Code session.
- A Claude run's init there STILL listed all **16** skills AND exposed the **`Skill` tool** (38 tools).
- Source confirmed: the 16 are COMPILED INTO `@anthropic-ai/claude-agent-sdk-*/claude` (the SDK
  binary). `skills:[]` cannot strip them. So this is NOT the "dev-nested in a Claude session" artifact
  the code claimed — it is present in production, and an agent COULD invoke `deep-research`/
  `code-review`/`dataviz`/`doctor`/`run-skill-generator`/… (0 invocations observed, but not prevented).
- **Fix**: `BASE_DENIED_BUILTINS = ["Skill"]` denies the Skill tool on EVERY run (viberr injects its
  own skills as prompt text and never uses the SDK Skill tool), making the bundled skills uninvokable.
  Corrected the false "standalone is clean / dev-only" comment. **Verified live**: after the fix a
  standalone container run no longer exposes `Skill` (37 tools, was 38); the 16 stay listed in the init
  (SDK discovery, cosmetic) but can no longer be invoked. Unit test updated; full suite 1317 green.
- Residual (noted, not fixed): the init also leaks other SDK-bundled tools (CronCreate, Monitor,
  RemoteTrigger, ScheduleWakeup…) and subagents (Explore, Plan, general-purpose) via the same
  SDK-binary channel. Inert in observed runs; a broader denylist could close them, but that risks the
  coding toolset — out of scope for the skill question.
