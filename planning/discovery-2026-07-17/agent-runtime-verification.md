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

## OPEN QUESTION for the owner (skill leak)
In THIS dev environment, every Claude run's SDK init lists 16 unrelated HOST skills even though the
runtime passes `skills:[]`. They are inert (0 Skill-tool calls, and the intended docs-style still
arrives via prompt text), so there's no observed functional impact. BUT it contradicts the code's
stated intent ("`[]` = none listed → the model sees no skills") — the SDK appears to surface host
`~/.claude` skills into the run context regardless of the option. Prior notes call this a dev-nesting
artifact (the dev server is launched INSIDE a Claude Code session) that a standalone deploy avoids.
Worth confirming on a standalone deploy (server NOT nested in a Claude session, host with global
skills installed) that the init truly lists zero — because if the SDK ignores `skills:[]`, a
production host with global skills would leak them into every run's context too (wasted context /
subtle steer), which the current design assumes it doesn't. Not a security ask; a correctness/context-
hygiene one.
