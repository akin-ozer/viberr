# Pass 24 — bug log

Fresh bugs found this pass on the post-pass-23 product. Each: severity, where (file:line),
symptom, root cause, repro, fix direction. HIGH = user misled or data/work lost; MEDIUM =
confusing/wasteful/real gap w/ workaround; LOW = polish.

## Candidates from Codex/Claude parity audit (fable subagent) — EACH NEEDS MY VERIFICATION

> Status legend: CANDIDATE (unverified) → CONFIRMED (I verified in code + failure scenario holds) →
> FALSE (verified not a bug) → FIXED.

### P1 [CANDIDATE, HIGH] Codex operator's writable sandbox rooted at the task GOVERNANCE dir → task.md is writable
- Claim: Codex operator run gets `workspace-write` (R22) but no `workdir` is passed
  (operator-run.server.ts ~1668-1690), so `run-service.server.ts:594` defaults cwd to
  `taskDir(slug,key)` = `projects/<slug>/tasks/<KEY>` — the folder holding `task.md`. So a Codex
  operator can `sed -i ./task.md` (flip validation, delete packet, rewrite verdict) or `git commit`
  in `./workspace/<repo>`. Claude operator has Bash/Edit/Write/... denied → physically cannot.
- Impact if true: canonical governance file mutable by an agent on one backend only; server gates
  don't mediate direct task.md writes. Verify: is workdir really taskDir for the Codex operator?

### P2 [CANDIDATE, MEDIUM] `use-web-search-fetch` granted to a Codex operator is inert
- Claim: codex-runtime.server.ts ~709-711 unconditionally sets `networkAccessEnabled=false;
  webSearchMode="disabled"` for `spec.kind==="operator"`, ignoring `spec.webSearchWithheld`. Claude
  operator honors the grant (operator-run.server.ts ~1041). Cap is in ENFORCED "both" set, editor
  shows no advisory tag → admin thinks granting web to a Codex operator works; it doesn't.

### P3 [CANDIDATE, MEDIUM] `read_default_branch_file` (F21-21/VIB-7 fix) is Claude-only; shared prompt tells Codex operator to call it
- Claim: operator-toolkit.server.ts ~292 adds the tool for Claude only; OPERATOR_PLAN_TOOLS has no
  equivalent; shared system prompt (operator-run.server.ts ~2556) instructs every operator to call
  `read_default_branch_file`, but Codex turn prompt says "You cannot call tools." → Codex operator
  can recreate the VIB-7 false out-of-band-merge blocking packet.

### P4 [CANDIDATE, MEDIUM] Stdio MCP pre-flight verifies WITH a credential the Codex run never gets
- Claim: verifyStdioMcpMountsForRun passes the token to discoverStdioMcpTools (specialist-mcp ~267),
  but codex-runtime drops env.MCP_CREDENTIAL (~160-183). A credential-requiring stdio server passes
  pre-flight, is announced in persona, then dies at Codex CLI spawn → no unresolved/unhealthy entry,
  agent reports absence as its own failure. Claude run works.

### P5 [CANDIDATE, LOW] Codex outcome envelope always advertises `verdict`; an un-granted verdict is discarded silently
- Claim: AGENT_OUTCOME_JSON_SCHEMA always includes `verdict`; task-actions.server.ts:2749 nulls it
  when `!verdictAuthorized` with no log/note. Claude's report_outcome omits the field unless granted.
  A verdict-off Codex Developer emitting `verdict:"approve"` → summary claims approval, verdict
  silently dropped, no timeline note.

### P6 [CANDIDATE, LOW] executeCodexPlan silently skips malformed plan steps the schema permits
- Claim: guarded arms (operator-run.server.ts ~1935 post_comment `if(a.text)`, ~2003
  transition_stage `if(a.toStageId)`, ~2046 set_goal `if(a.text)`) fall through without calling
  `record()`, so narrateRefusedActions never reports them. OpenAI-strict schema makes fields
  present-but-nullable, so `{tool:"transition_stage", toStageId:null}` is valid → skipped silently.
  Claude toolkit returns a zod error the model can correct.
