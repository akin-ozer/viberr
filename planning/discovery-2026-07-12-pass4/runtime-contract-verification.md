# Pass-4 runtime-contract verification (spec-construction level)

**Date:** 2026-07-12 · **Branch:** `full-pass-2026-07-12` · **Node:** 26.5.0

Real Claude/Codex SDK subprocesses cannot spawn in this sandbox (`spawn EBADF`),
so the RunSpec/options the app WOULD hand the SDK were verified deterministically:
a focused vitest probe called the REAL builders (`buildSpecialistPersona`,
`resolveSpecialistDisallowedTools`, `resolveSpecialistMcpServers`) and started the
REAL Claude adapter (`createClaudeAdapter`) with an injected fake `query` to
capture the exact `options` object. 13/13 assertions green — the contract and the
gaps are exactly as described below. (The probe file has been deleted; it was
`app/server/tasks/pass4-runtime-contract.probe.test.ts`.)

---

## 1. Skill isolation (T20) — **PASS**

**Asserted:** a specialist persona built for a profile declaring ONLY skill
`conventional-commits` contains that skill's body and NOT an undeclared host
skill (`host-secret-skill`) sitting in the same store; a profile with no skills
yields `""`; and the Claude SDK options set `settingSources:[]`, `skills:[]`,
`plugins:[]`.

**Real code:**
- `buildSpecialistPersona` — `app/server/tasks/specialist-run.server.ts:956-983`.
  Skill bodies are read one-by-one from the DECLARED list via `readSkillBody`
  (`:932-943` → `skillDirPath(name)/SKILL.md`); nothing enumerates the skills
  root, so an undeclared on-disk skill can never leak into the persona.
- SDK isolation levers are hard constants in the options object —
  `app/server/runtimes/claude-runtime.server.ts:217-219`
  (`settingSources: [], skills: [], plugins: []`), set unconditionally for every
  run regardless of profile.

**Verdict:** PASS. Skill wiring is declared-only; the three empty levers are
always present. (Honest caveat already documented in the adapter at
`:206-216`: running the server from INSIDE an active Claude Code session leaks
the parent process's toolset above the SDK — a dev-only condition, uncloseable
from here.)

---

## 2. Capability → disallowedTools mapping (T12/XS-4) — **GAP-CONFIRMED**

**Asserted:** withholding `create-task-branch` (mode `human`/`off`) adds
`Bash(git checkout -b:*)` and `Bash(git switch -c:*)` to the denylist; but the
uppercase force variants `-B`/`-C` are NOT covered; AND the app's own
delivery-contract prompt instructs the agent to run `git checkout -B`.

**Real code:**
- Deny rule — `app/server/tasks/specialist-tool-policy.ts:35-37`:
  `deny: ["Bash(git checkout -b:*)", "Bash(git switch -c:*)"]`. No `-B`/`-C`
  specifier exists anywhere in `CAP_DENY_RULES`.
- Delivery contract — `app/server/tasks/specialist-run.server.ts:1047`:
  `` ...: `git checkout -B ${input.branch}`. `` (buildAnalyzePrompt).

**What's wrong:** Claude Agent SDK Bash deny specifiers are prefix-matched on the
exact command token, so `Bash(git checkout -b:*)` does not match `git checkout
-B …`. A specialist whose `create-task-branch` is withheld can still create/reset
its branch with `git checkout -B` / `git switch -C` — and the app literally tells
it to do exactly that in the workspace-&-delivery contract. The withheld
capability is bypassable by following the contract verbatim.

**Verdict:** GAP-CONFIRMED. Add `Bash(git checkout -B:*)` and
`Bash(git switch -C:*)` to the `create-task-branch` deny rule (and reconcile the
`git checkout -B` guidance in the prompt).

---

## 3. execute-code-or-write-repo deny set (XS-8/XS-13) — **GAP-CONFIRMED**

**Asserted:** withholding `execute-code-or-write-repo` denies `Edit`, `Write`,
`NotebookEdit`, `Bash(git commit:*)` — but NOT `MultiEdit`; and the OPERATOR
denylist DOES include `MultiEdit` (backend asymmetry).

**Real code:**
- Specialist deny rule — `app/server/tasks/specialist-tool-policy.ts:44-47`:
  `deny: ["Edit", "Write", "NotebookEdit", "Bash(git commit:*)"]` — `MultiEdit`
  absent.
- Operator denylist — `app/server/runtimes/claude-runtime.server.ts:112-119`
  (`OPERATOR_DENIED_BUILTINS = ["Bash","Edit","MultiEdit","Write",
  "NotebookEdit","Task"]`), applied at `:261-265`.

**What's wrong:** A specialist forbidden to write the repo still has `MultiEdit`
in context and can edit files with it — the deny set removes the single-edit
tools but leaves the batch-edit tool open. The operator run closes this
(`MultiEdit` is denied there), so the omission is a specialist-side oversight,
not an SDK limitation. Probe proved the asymmetry live: the same run kind that
denies `Edit`/`Write` leaves `MultiEdit` reachable for the specialist while the
operator run denies it.

**Verdict:** GAP-CONFIRMED. Add `MultiEdit` to the `execute-code-or-write-repo`
deny rule.

---

## 4. MCP config + secret injection (T22 / P3-baseline) — **GAP-CONFIRMED**

**Asserted:** for a specialist declaring an org MCP server whose row carries a
`secret://…` `cred_ref`, `resolveSpecialistMcpServers` still produces a
connectable config for Claude (`{type:"http",url}` / `{command,args}`), but the
secret is NOT resolved or injected — no `headers`, no `env`, no `authorization`,
and the token string appears nowhere in the delivered config.

**Real code:**
- `resolveSpecialistMcpServers` — `app/server/tasks/specialist-mcp.server.ts:23-51`.
  The build loop (`:37-49`) reads only `name` / `transport` / `target`; it never
  touches `cred_ref`. The honest-scope note at `:16-22` states credentials are
  not injected.

**What's wrong (by design today, owner now wants it fixed):** the declared MCP
becomes a real, connectable server config, but any auth the server needs is
dropped on the floor. Against a real credentialed MCP the connection would be
unauthenticated. This is the documented baseline gap the owner wants closed —
resolve `secret://` refs from the secret store into the transport's auth channel
(HTTP `headers.Authorization` / stdio `env`).

**Verdict:** GAP-CONFIRMED (documented, intended-to-fix).

---

## 5. Resume confinement gap (XS-1) — **GAP-CONFIRMED**

**Asserted (by reading the type + impl, with a deterministic source assertion):**
`resumeRun`'s input type does NOT accept, and its `startRun` call does NOT thread,
`disallowedTools`, `env`, `mcpServers`, or `systemPrompt` — so a resumed
specialist loses every confinement lever. Proven-not-an-API-limit by asserting
`StartRunInput` DOES carry all four.

**Real code:**
- `resumeRun` input type + body — `app/server/runtimes/run-service.server.ts:300-360`.
  The input interface (`:301-321`) lists only `runId, prompt, script, workdir,
  model, effort, agentName, agentProfileId, autonomous, dataRoot, actor`. The
  `startRun` call it makes (`:335-359`) forwards none of the four confinement
  fields.
- `StartRunInput` (the target that DOES accept them) —
  `app/server/runtimes/run-service.server.ts:177` (`systemPrompt`), `:180`
  (`mcpServers`), `:183` (`disallowedTools`), `:190` (`env`).

**What's wrong:** confinement is applied only on the INITIAL `startSpecialistRun`
/ `startReviewerRun` (which compute `disallowedTools` from grants, `env` for the
`GIT_CEILING` workspace confinement, `mcpServers`, and the persona `systemPrompt`).
A resume — the path used when the operator or a human re-prompts an agent via a
comment — creates a fresh run row that shares only the provider session id and
inherits NONE of these. The resumed turn runs with the SDK's default toolset (no
denylist), no git ceiling, no MCP servers, and no persona. Since `StartRunInput`
already accepts all four, the fix is purely to thread them through `resumeRun`
(carry the prior run's confinement, or recompute from the deployment).

**Verdict:** GAP-CONFIRMED.

---

## Summary table

| # | Item | Result |
|---|------|--------|
| 1 | Skill isolation (T20) | **PASS** |
| 2 | create-task-branch `-b/-c` deny; `-B/-C` uncovered + prompt uses `-B` | **GAP-CONFIRMED** |
| 3 | execute-code-or-write-repo omits `MultiEdit` (operator denies it) | **GAP-CONFIRMED** |
| 4 | Declared MCP config delivered but `secret://` never injected | **GAP-CONFIRMED** |
| 5 | `resumeRun` drops disallowedTools/env/mcpServers/systemPrompt | **GAP-CONFIRMED** |
