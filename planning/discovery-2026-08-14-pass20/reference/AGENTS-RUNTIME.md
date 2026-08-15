# AGENTS-RUNTIME — Viberr current state (pass 20)

> Verified against `main @b97ad02` on 2026-08-14 (pass 20). Supersedes the
> pass-19 doc (`planning/discovery-2026-08-06-pass19/reference/AGENTS-RUNTIME.md`,
> verified @65063b8 — BEFORE the pass-19 merge `4184e95`, so every line anchor in
> it is stale and two of its claims were wrong; see §14).

How AI runs are spawned, confined, and delivered. Two run kinds share one uniform
machinery (generic-agents G1): the **operator** (coordination) and **specialists**
(every non-operator engaged agent — deliverer and reviewers). All line anchors
re-verified against `main @b97ad02`.

Key files: `app/server/tasks/specialist-run.server.ts` (specialist runs, 2738 lines),
`app/server/runtimes/operator-run.server.ts` (operator turn engine),
`app/server/runtimes/{claude,codex}-runtime.server.ts` (adapters),
`app/server/runtimes/skill-mount.server.ts` (workspace `.claude` owner —
strip + native skill mount, R18-3 + R18-5 + F19-15),
**`app/server/tasks/specialist-browser-mcp.server.ts`** (R19-19 browser mount),
`app/server/tasks/specialist-mcp.server.ts` (org MCP grants → run config),
`app/server/tasks/{agent,operator}-toolkit.server.ts` (in-process tool servers),
`app/server/tasks/operator-actions.server.ts` (operator gates),
`app/server/tasks/specialist-tool-policy.ts` (capability→tool confinement),
**`app/server/org/{resources,mcp-warmup}.server.ts`** (MCP registry probe +
background first-run install, R19-17/R19-18),
**`app/server/files/task-attachments.server.ts`** + `app/routes/task-attachment.ts`
(R19-19 attachments store + member-only serving route).

---

## 1. Spawning a specialist run — `startAgentRun` (`specialist-run.server.ts:934`)

One path for deliverer AND reviewer (the list an agent sits in no longer changes
behavior — capability grants do). Flow:

1. Read the task file (`existing`), find this `engagement` and whether
   `delivers` (:965-977). A second *delivering* run is refused 409 while one is
   `running|queued` (single-flight, :985-1002); supporting runs are concurrent.
2. Resolve the deployed profile: `resolveDeployedSpecialist(ctx, slug, profileId)`
   (:252) → `ResolvedSpecialist` with `name`, `skills`, `kb`, `mcps`,
   `capabilities`. Its resources come from `effectiveProfileView` (the deployment
   override else the org template). Backend picking: `backendOverride` (D4 retry)
   → live deployment → engagement snapshot (:1020-1023).
3. Set the run's `kb`/`skills`/`mcpNames`/`disallowedTools` from that resolved
   profile (:1044-1062). `disallowedTools = resolveSpecialistDisallowedTools(capabilities)`;
   an UNRESOLVABLE profile falls back to `resolveUndeployedDisallowedTools()`
   (P14-RT-01 — withheld, never `[]`).
4. **Stage-eligibility assert** at the run boundary (:1068-1074).
5. **R18-1 reviewer-KB inheritance** (:1088-1097, §3.1).
6. Resolve the MCP grants BEFORE the persona (`mcpServersFor`, :1104) so the
   persona announces only what actually mounted (P14-LV-09).
7. Collaboration gates from the same grants (`resolveAgentCollab`, :1116) —
   an unresolvable profile gets `withheldAgentGrants()` (R15-7).
8. Clone the repo (`cloneRepo`, :2408) if the project has a repo and the backend
   is real — the clone calls **R18-3 catalog strip** on both its return paths
   (:2456 reuse, :2475 fresh).
9. **R18-5 native skill mount** (`mountGrantedSkills`, :1171-1178) — Claude +
   real-backend only; returns `{mounted, skipped}`.
10. **R19-19 browser mount** (`resolveBrowserMcp`, :1184-1195) — real backend,
    BOTH backends, from the same grants (§3.4). `attachmentsDir` comes from
    `taskAttachmentsDir` (`file-store-root.server.ts:87`).
11. Build the persona: `buildSpecialistPersona({profileId, skills, nativeSkills,
    kb, mcps, unresolvedMcps, unhealthyMcps, browser, unresolvedOut, …})`
    (:1205-1224, definition at :1581). Skills that MOUNTED are announced but
    **not** injected; the rest still ride the prompt as text (§3). A granted but
    REFUSED browser is pushed into the same unresolved list (:1227).
12. **P19-G0 fresh-run anchor** (`freshRunAnchor`, :392; called :1252) — every
    fresh run re-anchors on the canonical task artifact, which
    `buildAnalyzePrompt` never carried.
13. Merge MCP servers in a fixed order (:1392-1399): org grants → the browser →
    the in-process toolkit. A registry row can therefore never shadow the browser
    or the governance tools (the names are refused at save anyway, §3.4).
14. Start the run via `run-service.server.ts` → the backend adapter, passing
    `skills: skillMount.mounted` (:1432) and `mcpServers: mergedMcpServers`
    (:1434); Codex additionally gets `outputSchema: AGENT_OUTCOME_JSON_SCHEMA`
    when `collab.verdict || collab.ask || collab.evidence` (:1405-1437). The fake
    runtime substitutes here in tests (`installFakeRuntime`).
15. **P19-G8/G11 run-input disclosure**: `recordRunInputs` (:533) writes ONE
    console line naming everything the run was given, before the first provider
    line (§10).

Resume path (`@mention` / resumed review): `resolveResumeConfinement` (:2107,
**async**) rebuilds the persona, applies the SAME R18-1 union (:2160-2170),
re-mounts the granted skills into the surviving clone (:2179-2186), **re-resolves
the browser from the same grants** (:2189-2199, R19-19 — a resume must not
silently gain or lose it), and returns `skills`/`mcpServers`/`outputSchema`/
`runInputs` alongside `disallowedTools`. Its one production caller is
`task-actions.server.ts:1127` (dynamic import) — it must `await`.

---

## 2. Capability policy → tool confinement (`specialist-tool-policy.ts`)

`resolveSpecialistDisallowedTools(capabilities)` (:151) maps withheld grants to a
Claude tool denylist via `CAP_DENY_RULES` (:47-95). `resolveDeliveryPermissions`
(:194) resolves the delivery headline + scoped grants. `resolveUndeployedDisallowedTools`
(:176) is the fallback for an undeployed profile (withheld confinement — P14-RT-01).
`GRANT_REQUIRED_CAPABILITY_IDS` (:102) is the P14-LV-01 polarity list: absence is
withholding for everything that can push code or record a binding verdict.

**`use-browser` has NO deny rule and deliberately so** — the enforcement is the
MOUNT (§3.4). It sits in `BOTH_BACKENDS_ENFORCED_CAPABILITY_IDS`
(`app/shared/capabilities.ts:240`) because a withheld browser means the tool
surface does not exist on either backend, which is a stronger shape than a
denylist entry.

**Claude adapter** (`claude-runtime.server.ts`): `BASE_DENIED_BUILTINS` (:242-276)
denies `Skill` (conditionally — see below), the whole subagent family (`Task`,
`TaskCreate/Get/List/Output/Stop/Update`), `Workflow`, the Cron family,
`ScheduleWakeup`, `RemoteTrigger`, `Monitor`, `PushNotification`, `SendMessage`,
`DesignSync`, `EnterWorktree`/`ExitWorktree`. Deliberately NOT denied:
`ToolSearch` (the operator loads its deferred `mcp__viberr__*` tools through it),
the coding toolset, web tools, and the `mcp__*` channel.

The `query()` options block (:556-616) has **two shapes**, decided by
`nativeSkills = nativeSkillNames(spec.skills)` (:555; helper at :289-292 —
re-filters through `isSdkSkillName` so a bad store folder name can never make
`query()` throw before start):

| Option | No mounted skill | ≥1 mounted skill |
| --- | --- | --- |
| `settingSources` (:607) | `[]` | `["project"]` (the run's own checkout only — never `user`/`local`) |
| `skills` (:608) | `[]` | `[<exact mounted names>]` |
| `managedSettings` (:609) | absent | `MANAGED_SETTINGS` (:310-312) = `claudeMdExcludes: ["**/CLAUDE.md","**/CLAUDE.local.md","**/.claude/**"]` |
| `Skill` in the denylist (:663-665) | denied | **un-denied** (the `skills` filter is the fence instead) |
| `plugins` (:610) | `[]` | `[]` |
| `strictMcpConfig` (:615) | `true` | `true` |

- **HONEST LIMIT (unchanged)**: `skills: []` does NOT give an empty skill SET —
  the SDK compiles ~16 first-party skills into its binary (docker-verified
  2026-07-18). Denying the `Skill` tool is what makes them uninvokable. A run
  that mounts granted skills relies on the `skills` allow-list instead, which
  rejects every unlisted skill (bundled ones included) at the tool boundary.
- **HONEST NOTE (still unverified, `claude-runtime.server.ts:294-312`)**:
  `settingSources: ['project']` is also the source that loads `CLAUDE.md` memory
  files, so it re-opens a repo-`CLAUDE.md`→system-prompt ingress that
  `settingSources: []` closed for free. `claudeMdExcludes` is the documented
  switch and is passed, but the module still says **NOT live-verified** — treat
  the ingress as OPEN. The deterministic guarantees are the stripped/rewritten
  `.claude` catalog and the `skills` filter, not this.
- `permissionMode: "bypassPermissions"` for autonomous server-spawned runs (:573).
- `strictMcpConfig: true` — **R18-3**: only Viberr-passed `mcpServers` reach the
  run; a repo `.mcp.json`, user MCP config, and plugin MCP are ignored.

**Codex adapter** (`codex-runtime.server.ts`): the parallel governance —
`project_doc_max_bytes: 0` (:232, drops repo `AGENTS.md`),
`skills.include_instructions: false` + `skills.bundled.enabled: false` (:243-245),
`apps/plugins/hooks: false` (:251-258), `webSearchMode: "disabled"` when web
egress is off (:542, :552), `mcp_servers: codexMcpServers(spec.mcpServers)`
(:272, translator at :100), and host isolation via `CODEX_HOME`
(`codex-config.server.ts` — the pass-13 fix). Codex has no `.claude` concept, so
R18-3's strip is a no-op for it, and **no native skills channel** — its whole
skills channel stays severed (documented at `codex-runtime.server.ts:198-215`,
LV-13), so a Codex run's granted skills keep riding the system prompt as text.
This backend asymmetry is deliberate and is the reason `nativeSkills` is a SUBSET
of grants, never a switch.

**MCP tool-name dialect (P13-LV-15, `codex-runtime.server.ts:88-95`) — unchanged
and still unfixable**: the two CLIs derive a DIFFERENT tool prefix from the same
declared server name. Claude mounts `mcp__everything-http__echo`; the Codex CLI
lowercases and turns hyphens into underscores → `mcp__everything_http__echo`.
Viberr passes the declared name through unchanged on both, so a persona, skill or
directive that names a tool LITERALLY works on one backend and not the other. The
transform lives inside the codex binary; the honest fix is the caveat on the MCP
admin surface. (This is also why `RESERVED_MCP_NAMES` carries BOTH spellings of
viberr's own servers — §3.4.)

**Plumbing**: `RunSpec.skills` (`adapter.server.ts:50-58`, Claude-only),
`StartRunInput.skills` (`run-service.server.ts:229-231`, applied :443), and the
resume input's `skills` (:683-689, re-applied at :752 and :787 — the XS-1
fresh-vs-resume parity class).

---

## 3. Skill / KB / MCP / browser context — the hybrid carrier model

`buildSpecialistPersona` (`specialist-run.server.ts:1581`) assembles the persona:

- **Skills — two carriers since R18-5**. `native = skills ∩ nativeSkills` are
  announced in an "Attached skills (trusted — installed in your workspace)" block
  and their bodies are deliberately NOT injected (the SDK loads them on `Skill`
  invocation — progressive disclosure). `injectable = skills \ native` still goes
  through `readSkillBodies(injectable, dataRoot)`
  (`app/server/files/skill-body.server.ts`) as prompt TEXT under ONE shared
  budget (C2). The intersection is taken against the DECLARED grants, so a stale
  mount can never enable craft the profile no longer grants. Ungranted skills
  never appear either way.
- **KB**: `readKbBodies(input.kb, dataRoot, KB_INJECTION_BUDGET)` — reads each
  granted KB folder (`app/server/files/kb-injection.server.ts`), tolerant of a
  missing/renamed/empty folder (injects nothing + a "did NOT reach this run"
  marker). One shared byte budget across all KBs. KB has **no** native carrier —
  it is always prompt text.
- **MCP**: the run mounts only the granted external MCP servers
  (`mcpServersFor(db, mcpNames)`, :231) plus the in-process `viberr_agent`
  toolkit; the persona announces what actually mounted (P14-LV-09), names
  `unresolvedMcps` under "# Unavailable MCP servers" and, separately,
  `unhealthyMcps` under "# MCP servers that may be unavailable" (P14-LV-09b:
  mounted, but the last probe failed).
- **Browser** (R19-19, :1777-1786): when the server mounted, `browserPersonaSection`
  is appended verbatim; when it was granted but REFUSED, a "# Browser not
  mounted" block names the reason instead.
- **P19-G11 unresolved-out**: every skill/KB grant whose CONTENT never reached
  the run is pushed onto the caller's `unresolvedOut` array so a HUMAN sees it in
  the run-input disclosure (§10), not just the agent in its prompt.

### 3.1 R18-1 — reviewer inherits the delivering engagement's KBs (KBs ONLY)

A reviewer with `kb: []` used to judge against different conventions than the
deliverer and returned a false `request_changes` (F18-11, live-caught). Now, for
a non-delivering run only (`specialist-run.server.ts:1088-1097`, resume parity at
:2160-2170):

```
if (!delivers) {
  kb = withDeliveringGrants(kb, () =>
    deliveringContextGrants(existing.parsed.frontmatter, engagement.profileId,
      (profileId) => resolveDeployedSpecialist(ctx, slug, profileId).kb));
}
```

- `deliveringContextGrants(frontmatter, reviewerProfileId, resolve)` (:302) —
  returns the delivering engagement's grants via `deliveringEngagement(fm)`, or
  `[]` when there is no deliverer / the deliverer IS this profile / the deliverer
  is undeployed (resolve throws → caught).
- `withDeliveringGrants(own, resolveExtras)` (:325) — reviewer's own list first,
  the deliverer's extras appended, **deduped** so a shared resource is injected
  (and charges the shared budget) once.

**CORRECTED vs pass 19.** The pass-19 doc carried an "accuracy note" saying the
helpers had been renamed for a prospective widening to SKILLS. That widening
never existed: **ruling 57 / R19-3** (`docs/architecture/decisions.md:539`)
settled it as KNOWLEDGE BASES ONLY, and the stale docstring citing a nonexistent
ticket was removed. `specialist-run.server.ts:286-301` now states the contract
explicitly ("SKILLS ARE DELIBERATELY NOT INHERITED: a reviewer's craft is its own
profile's grant"), and `skill-mount.server.test.ts` pins the ABSENCE of any
skills-widening claim. Do not restore one.

The delivering run and the operator run (separate `buildOperatorSystemPrompt`
path) are untouched.

### 3.2 R18-3 — strip the ungoverned repo `.claude` catalog (+ F19-15 surgery)

`stripUngovernedRepoCatalog(repoDir)` lives at `skill-mount.server.ts:120` (now
**async**; a stub comment marks its old home at `specialist-run.server.ts:2402`).
It is called from THREE places: both `cloneRepo` return points (reuse :2456,
fresh clone :2475) and — always, fresh or resumed — from `mountGrantedSkills`
itself (`skill-mount.server.ts:276`), so the "only Viberr content is
discoverable" guarantee does not depend on caller ordering.

Because `.claude` is git-TRACKED and delivery auto-commits with `git add -A`, a
plain `rm -rf` would ship a `.claude` DELETION into the review PR — so the helper
first marks every tracked `.claude` path `git update-index --skip-worktree`
(:124-136), then removes the directory. A skip-worktree failure is non-fatal
(logged; the catalog is still stripped). Documented limitation: a task to edit
the repo's own `.claude` can't deliver those edits — the intended governance
posture.

**F19-15 (NEW since pass 19): the strip is now surgical.** Two engaged agents
share ONE per-task workspace clone, so a second run starting while the first was
still executing re-ran the strip over a live run's `.claude` and deleted the
skills it had just mounted — silent capability loss, no error, no event
(`skill-mount.server.ts:50-93`). The fix is a **per-process random mark**,
`MOUNT_MARK = "viberr-skill-mount <uuid>"` (:95) written to `.viberr-mount` (:96)
inside each mounted skill folder, read back at most 256 bytes (:98). When any of
our own mounts is present, the strip removes everything else **by name** instead
of deleting and re-creating (:146-166): every non-`skills` catalog entry
(`settings.json` and its hooks, `commands/`, `agents/`) goes, and inside
`skills/` only folders this process mounted survive. A fixed filename was
rejected deliberately — `.claude` arrives from an untrusted clone, and a repo
shipping a guessable marker would re-open the R18-3 leak.

Preservation weakens nothing: a preserved folder is not usable by a run that did
not mount it, because the adapter passes `skills: [<exactly this run's mounted
names>]` and a run that mounted nothing gets `settingSources: []` with `Skill`
denied. The **accepted residual**, stated rather than hidden: the module cannot
tell a FINISHED run's mount from a live one, so mounts are never collected — a
profile's skill folders stay readable (not invokable) in a co-engaged agent's cwd
for the life of the workspace. The design for fixing it is in
`planning/discovery-2026-08-06-pass19/spec-skill-mount-race.md`.

Claude's user-level catalog is separately governed by `CLAUDE_CONFIG_DIR`
isolation in production (`claude-config.server.ts`); `strictMcpConfig` closes the
MCP channel (§2).

### 3.3 R18-5 — granted skills reach a Claude run through the SDK

`app/server/runtimes/skill-mount.server.ts` (460 lines) owns the workspace
`.claude` end to end. `mountGrantedSkills({workspaceDir, skills, dataRoot})`
(:255) → `{mounted: string[], skipped: {name, reason}[]}`:

1. Dedupe; return early with everything `skipped` when there is no workspace or
   it is not a **plain git checkout** (`isPlainGitCheckout`, :305 — `.git` must be
   a real DIRECTORY, so a worktree/submodule pointer refuses). Reason:
   `settingSources:['project']` walks from cwd up to the repo root, so mounting
   anywhere that is not a repo root could walk into a host `.claude` (the F13
   leak — `docker-data/` lives inside the viberr checkout on a dev machine).
2. `stripUngovernedRepoCatalog(dir)` FIRST (:276) — every run, including resumes,
   so a previous run's `settings.json` (hooks!) never survives, while F19-15
   keeps a live run's own mounts.
3. `excludeCatalogFromDelivery(dir)` (:323) — appends `.claude/` to
   `.git/info/exclude` (repo-local, never committed, binds both `git add -A`
   delivery and the agent's own commits). Idempotent.
4. Per skill, `mountOneSkill` (:352): refuse a name outside
   `SDK_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` (:214, exported as
   `isSdkSkillName` :216); resolve through `resolveContainedSkillFile` (the same
   containment question the injector asks — no symlinked folder/SKILL.md, nothing
   outside the store); `cpSync` the WHOLE folder with `dereference:false` and a
   `copyableEntry` filter that refuses symlinks and nested `.git` (:432); write
   the `MOUNT_MARK_FILE`; then **rewrite `SKILL.md`'s frontmatter** to exactly
   `{name, description}`. Normalization is load-bearing twice over: store
   SKILL.md files carry no frontmatter (native discovery would silently drop
   them), and skill frontmatter could otherwise carry
   `allowed-tools`/`model`/`disable-model-invocation` — run policy Viberr owns
   through capability grants.
5. If NOTHING mounted, the catalog is stripped again (:292) so the workspace is
   byte-identical to a skill-less run.

`skipped` entries are **diagnostic, not capability loss**: they fall back to
prompt-text injection via `buildSpecialistPersona` (§3). The hybrid is by design —
Codex, a run with no checkout, an SDK-unsafe folder name, or a symlinked store
entry all keep the text carrier.

**Not yet covered**: skills mounted from a store folder are re-copied on every
run (no caching), and `description` falls back to the first non-heading line of
the body when the store file declares none (`skillDescription`, :442).

### 3.4 R19-19 — agents get a REAL browser (NEW, `308cbc3`, ruling 75)

`app/server/tasks/specialist-browser-mcp.server.ts` (173 lines) mounts
**Playwright MCP** (`@playwright/mcp`, pinned `0.0.79` as a PRODUCTION dependency
in `package.json:34` — never a first-run download) as a per-run stdio server, on
**both** backends.

**Why a capability and not an org-registry row** (module docstring :9-47):
registry MCPs sit outside the capability policy (P13-KM-04, governance by
instruction only), and a browser is exactly the tool that must not ride that gap
— it IS network egress, it executes page JavaScript, and it feeds page content
back to an agent that may hold repo-write.

`resolveBrowserMcp({grants, attachmentsDir, backend})` (:93) → `{server, refused}`:

- **Gate 1** (:99): `effectiveCollabMode(grants, "use-browser")` must be exactly
  `direct`. The catalog default is **off** (`app/shared/capabilities.ts:111`,
  `cap("use-browser", "Drive a live web browser", ["agent"], "Collaboration", "off")`)
  — absence is withholding (P14-LV-01 polarity). `kinds: ["agent"]` means the
  **operator never gets a browser**.
- **Gate 2 — the egress interlock** (:108-114): effective `use-web-search-fetch`
  must ALSO be `direct`. A profile whose web egress was revoked cannot re-acquire
  it one row down. The contradictory pair is not resolved silently in either
  direction: it returns `refused` with a reason, which rides the existing
  P14-LV-09 disclosure pipe into both the persona (§3) and the run-input record
  (§10).
- **Gate 3** (:116-121): `@playwright/mcp` must resolve in `node_modules`
  (`playwrightMcpCliPath`, :69 — the package's exports map hides `./cli.js`, so
  it resolves `package.json` and joins).
- On success it `mkdirSync`s the attachments dir (:123) and returns
  `{ command: process.execPath, args: [cli, "--headless", "--isolated",
  "--output-dir", <attachmentsDir>, …] }` (:126-141). No credential, no env — so
  the config survives the codex `--config` argv serialization with full parity
  (the F7-MCP1 secret-drop concern is moot here).

Backend and containment specifics:

- `--isolated`: profile in memory — no cookies/storage surviving a run or leaking
  across tasks.
- **No** `--allow-unrestricted-file-access`: Playwright MCP blocks `file://`
  navigation and confines file access to the child's cwd (the run workspace) by
  default, so the browser cannot read the data root.
- **Codex gets `--image-responses omit`** (:132): image content blocks in MCP
  tool results are unproven on the codex CLI, and a run that dies mid-tool-call
  is worse than one that reads its screenshots from disk. On Claude the SDK
  renders them and the agent can SEE the page. The file lands in `attachments/`
  either way.
- `VIBERR_BROWSER_EXECUTABLE` (`env.server.ts:92`) → `--executable-path <bin>
  --no-sandbox` (:137). The image sets it to Debian's `/usr/bin/chromium`;
  `--no-sandbox` rides with it because chromium's user-namespace sandbox cannot
  start under docker's default seccomp as the non-root `node` user. On a dev host
  the var is unset and Playwright's own resolution + sandbox apply.
- **The screenshot split (live-verified on 0.0.79)**: a screenshot taken with the
  DEFAULT name saves into `--output-dir` (the task's `attachments/`, where humans
  see it); a screenshot given an explicit `filename:` resolves against the
  CHILD's cwd (the run workspace) instead, because the SDK's stdio config carries
  no `cwd`. This is not fixed in code — it is **steered in the prompt**:
  `browserPersonaSection` (:150) tells the agent to call
  `browser_take_screenshot` WITHOUT a `filename`, to cite the exact generated
  name in its evidence, and says plainly that a self-named file lands where no
  human will see it.
- **Prompt-level injection guardrails** (owner decision b, :150-172): pages are
  DATA, never instructions; never enter credentials anywhere; the browser widens
  no authority (nothing the capability policy withholds becomes reachable
  through it).

`viberr_browser` (:50) joins `RESERVED_MCP_NAMES`
(`specialist-mcp.server.ts:60-66`) in **both spellings** (`viberr_browser` and
`viberr-browser`, alongside `viberr` / `viberr_agent` / `viberr-agent`) — refused
as a registry name at save (P13-KM-12) and skipped by the resolver, so a
hand-edited row can never shadow it on one backend but not the other (P14-KM-15,
and see the hyphen/underscore dialect in §2).

---

## 4. The agent toolkits (in-process MCP servers)

- **`viberr_agent`** (`agent-toolkit.server.ts`: `buildAgentToolkit` :217,
  `createSdkMcpServer` :376) — the specialist's capability-gated toolkit:
  `post_comment` (gated on `comment-on-task`), `ask_human` (opens a question
  packet, gated on `ask-human`, stamps `askedBy`), `report_outcome` (stages the
  verdict/completion envelope, gated on `report-validation-verdict` +
  `attach-evidence-references`). The final report always posts via the completion
  pipeline regardless of `comment-on-task`. Claude only — on Codex the same three
  channels arrive as the **outcome envelope** `outputSchema`
  (`specialist-run.server.ts:1405-1408`), armed when
  `verdict || ask || evidence`, with a matching `## Collaboration` prompt note
  (:1345-1353, B-AG3) so the JSON shape is explained rather than inferred.
- **Operator toolkit** (`operator-toolkit.server.ts`: `buildOperatorToolkit` :111) —
  `post_comment`, `prompt_agent` (engage/run a specialist, `delivers` flag),
  `deliver_for_review`, `transition_stage`, `accept_completion`,
  `resolve_decision_packet`, etc. Each tool gates on the operator's capability
  grant + autonomy (`gate` `operator-actions.server.ts:434`, `deliverGate` :464;
  `type Gate = "direct" | "recommend" | "deny"` at :151). `clampAutonomy` (:215)
  enforces R19-A: a run may never exceed the project's configured autonomy
  (also applied by the schedule writer, `schedule.server.ts:150`).

---

## 5. Delivery pipeline (server-owned push + PR)

Agents never push; the SERVER performs delivery. `operatorDeliverForReview`
(`operator-actions.server.ts:2236`) gates on `deliver-review-pr` via `deliverGate`
(:2242) — under supervised autonomy it returns `recommend` and posts a
recommendation card instead of pushing; under full/direct it calls
`performDelivery` with `operatorAuthorized: true` (:2285). Human paths:
`manualDeliverForReview` (`task-actions.server.ts:3878`, the button) and
`applyRecommendation`'s delivery branch (:5913).

`performDelivery` (`task-actions.server.ts:3429`) → `pushWorkspaceBranch`
(`github/push-workspace.server.ts`, the `git add -A` commit) → `openTaskPr`
(`github/pr-open.server.ts:3702`, opens the review PR, writes the "Opened PR"
github timeline event, mints the `workRevision`). It no-ops on a live PR
(idempotent). On success it clears a stale `noChanges` flag (R17-2, :3713-3721);
the `nothing_to_review` result SETS it (:3639, :3822).

### 5.1 R18-2 + R19-4 — exactly ONE mechanism runs after a successful delivery

Opening a review PR is delivery, NOT a stage transition, so the per-transition
operator re-trigger and the stranded-operator backstop never fire here. The
`result.status === "ok"` branch (`task-actions.server.ts:3752-3776`) resolves the
effective autonomy and then takes exactly one of three paths:

```
const autonomy = ctx.operatorRun?.autonomy
  ?? resolveOperatorAuthority(ctx, projectSlug).autonomy;
if (autonomy === "full") {
  if (result.created) {                      // NEWLY opened PR only (no loop on reuse)
    void autoInvokeOperator(db, ctx, projectSlug, taskKey, "delivered",
      nextTransitionChainDepth(ctx));
  }
} else if (ctx.operatorAuthorized === true) {
  await recordDeliveredNextStep(db, ctx, projectSlug, taskKey, result.prNumber);
}
```

- **Full autonomy + newly created PR → R18-2 re-queue.** Fire-and-forget
  (`void`), mirroring the transition re-trigger. `autoInvokeOperator` (:597,
  trigger union widened to include `"delivered"`) no-ops when no operator is
  deployed and threads `nextTransitionChainDepth(ctx)` (:147) so the
  operator-authored chain shares `OPERATOR_TRANSITION_CHAIN_CAP` (=8) — no
  runaway. Idempotent: `operatorDeliverForReview` no-ops on the live PR, and the
  queued trigger is mutually exclusive with the stranded-resume backstop.
- **Supervised + operator-authorized → R19-4 next-step card (NEW since pass 19,
  ruling 58).** The pass-19 doc described the supervised arm as deliberately
  empty; live (VC-1) a supervised operator delivered, narrated "the task will
  move to Review; no further action needed", and recorded nothing — leaving the
  task `waiting:human` with no recommendation, packet or chip.
  `recordDeliveredNextStep` (:4009) makes it structural: a system-attributed,
  notified "Move to \<review\>" card, and it is the **one** writer of that card
  (a competing `ensureDeliveredNextStep` was deleted — two order-dependent
  writers after a delivery was the hazard). Its workflow-edge check ("never
  propose a transition the workflow doesn't declare") is folded in. Best-effort
  internally, so an open PR is never turned into an error by a failure to record
  the card.
- **A HUMAN manual delivery gets neither** — it reaches here without
  `operatorAuthorized`, and the human who just clicked Deliver is present.

---

## 6. Operator triggers (`operator-run.server.ts`)

`RunOperatorInput.trigger` union — **8 values** (:119-127): `create`,
`transition`, `agent-reply`, `goal-updated`, `pr-diverged`, `delivered`,
`scheduled`, `manual`. `OperatorTrigger = NonNullable<...>` (:2488).
Single-flight lease per task; concurrent triggers are queued newest-wins
(`queueOperatorTrigger` :315) and fire on lease release.
`operatorTurnInstruction` (:2541) computes the one-next-step instruction; the
`delivered` branch (:2618) tells the operator delivery is DONE — engage a
verdict-capable reviewer / accept / transition, and stop if a reviewer run is
already in flight. The **triage quality gate** `triageQualityGate(snapshot)`
(:2524) blocks Triage→Ready until a vague goal survives scoping (F15-14;
placeholder `DEFAULT_GOAL`, `task-actions.server.ts:323`).

**R19-1 — the operator gets a real read-only clone** (:718-760, wired at :1069,
prompt block at :2225+). F19-4, live: at triage the operator's cwd (the task
folder) held only `task.md`, and the model wrote a decision packet claiming the
repository contained "only task.md" for a repo that has docs and a README — it
was describing its own empty workspace and inventing scoping options from it. The
owner ruled for a full read-only clone (the SAME `<taskDir>/workspace/<name>`
checkout a specialist later reuses, so it is not a second clone).
`OperatorWorkspaceView` (:737) has three arms — `checkout` / `unavailable` /
`none` — and `unavailable` is first-class, not an error: a clone failure must
never strand the drive, but the run has to KNOW it is blind. The write/shell
tools stay denied on both backends (:2038, :1443).

---

## 7. Guardrails (`comment-guardrails.server.ts`)

Real write-time enforcement on the CANONICAL record (owner ruling Q3):
`isMeaninglessComment` (:28), `enforceOperatorBrevity`
(`OPERATOR_BREVITY_MAX_CHARS = 1000`, :36-51), `separateEvidence` (trims raw
fenced dumps to `EVIDENCE_MAX_FENCE_LINES = 12`, pointing at run logs, :63-77).
`applyCommentGuardrails` (:113) runs them and REPORTS what it did (`CommentTrim`);
its live consumer is the operator's `post_comment`
(`operator-actions.server.ts:555`, the G1 honesty wiring — a dropped comment
becomes a noop + audit row, `COMMENT_DROPPED_AUDIT_ACTION` :179, never a silent
success). Injection guardrails are exercised live (a Codex run refused a
credential-exfiltration injection in pass 19); R19-19 adds the browser's own
prompt-level stance (§3.4). The evidence-separation guardrail complements the
`evidence:` timeline rows (DOMAIN-MODEL.md §2.7): the rows carry the citation the
guardrail leaves behind — and since R19-19 an evidence label naming a real
attachment filename renders as a LINK (§9).

---

## 8. Org MCP registry — probe, reasons, and background installs (NEW)

Registering a stdio MCP server used to answer in three fixed words and throw the
command's own explanation away. Four commits fixed the whole loop.

**Capture stderr (R19-17, `8a5f782`).** `defaultSpawn`
(`resources.server.ts:764-772`) now uses `stdio: ["pipe","pipe","pipe"]` — it was
`"ignore"`, so the OS discarded the one channel that explains a failure. In
`discoverStdioMcpTools` (:811) stderr accumulates up to `STDERR_CAP = 8000`
(:867-888) and `withDetail` (:869) appends it to every failure reason. The
scrubber is **`redactGitOutput`** (imported :23) — deliberately, not incidentally:
the child is spawned WITH `MCP_CREDENTIAL` in its env (P13-KM-05), so a server
that dumps its environment while dying would otherwise print the credential into
a toast. It removes the token BY VALUE, strips ANSI, and clamps to the TAIL,
which is where a traceback's real error sits. The spawn error itself is surfaced
too (:922) — `spawn uvx-not-installed ENOENT` names the missing binary. It keeps
its git-flavoured name rather than being renamed across ten call sites.

**Keep the reason on the row (R19-17b, `101f72f`).** `org_mcp_servers.last_error`
(baseline schema; `McpView.lastError` at :539) is written by EVERY probe path —
`saveMcpServer` (:1278) and `testMcpServer` (:1402) — and **CLEARED by a passing
probe** (:1390), because a stale explanation under a green dot is worse than
none. The row renders it under the "unreachable" line in monospace
(`resource-rows.tsx:257-258`), clamped to 8 lines to match `redactGitOutput`'s
own bound (a tighter clamp re-clipped the last line, which in a traceback is the
one that names the error).

**Tell a first-run install apart from a hung command (R19-17c, `0cc9b55`).** The
stdio probe window went **5s → 20s** (`resources.server.ts:826`): `npx` and `uvx`
FETCH on first use and were being killed before printing a word, which is why
R19-17's captured stderr was empty for exactly the cases people hit. On timeout,
`INSTALLING_RE = /\b(downloading|building|installing|resolving|fetching|added \d+
packages)\b/i` (:896-897) is tested against the captured stderr; a match yields
`{kind:"down", installing:true, reason:"still installing after 20s — …"}` (:898-909),
a silent command still gets a plain "timed out". The hint is **earned by evidence
only** — canaried by asserting the silent case never claims to be installing.

**Finish the install in the background (R19-18, `88a17cc`, ruling 74).**
`app/server/org/mcp-warmup.server.ts` (145 lines). When a probe gives up on a
visibly-installing command, `startMcpWarmup` (:62) re-runs the SAME
`discoverStdioMcpTools` handshake with `WARMUP_CAP_MS = 15 min` (:35, owner
ruling), detached from the request (dynamic import breaks the
`resources.server` ↔ warmup cycle, :75). Registration returns immediately.

- Wired from `saveMcpServer` (:1347, AFTER the row is written so the save cannot
  overwrite the warm-up's own `warming_since`) and from `testMcpServer`
  (:1409-1424) — retesting used to restart the same download and kill it at the
  same point, forever.
- The row reads **INSTALLING** — its own state, neither green nor red, because
  nothing has answered and nothing is broken (`resource-rows.tsx:183-220`;
  `last_error` is suppressed while `warmingSince !== null`, :257).
- One in-process registry keyed by server id (`inFlight`, :38) makes a second
  registration a no-op rather than a second gigabyte of downloads.
  `reapStaleWarmups(db)` (:129, called from `boot.server.ts:127`) clears the flag
  at boot: it means "running HERE", so a survivor after a restart would be a row
  claiming to install with no installer behind it.
- The settings page **polls every 20s while anything is warming**
  (`resources-panel.tsx:113-122`). A poll rather than SSE, deliberately: the
  event vocabulary is a closed typed union routed by user/project/task scope and
  an org-settings row fits none of them. The effect only arms while `warming` is
  true.
- The old advice to "run the command once on the server" was dropped — the app
  does that itself now.

**Registry → run resolution** is unchanged (`specialist-mcp.server.ts:95`):
unknown name → `unresolved` (:141), unopenable credential → refused mount with
the reason (A9, :151-155), stdio gets `env.MCP_CREDENTIAL` / HTTP gets
`Authorization: Bearer` (:157-175, Claude only — §2), and a REGISTERED but
known-down row still mounts but is flagged `{mounted: true}` (:180) so the
persona says "may be unavailable" rather than promising tools.

---

## 9. Task attachments store (R19-19, NEW)

The long-standing `attachments/` placeholder is now real.
`taskAttachmentsDir(slug, key, dataRoot)` (`file-store-root.server.ts:87`) =
`projects/<slug>/tasks/<KEY>/attachments/` — inside the task dir, so archive and
delete flows move attachments with the task, with no retention machinery.

- **One writer today**: the browser MCP server's `--output-dir` (§3.4).
- **Read side** (`task-attachments.server.ts`, 100 lines) is deliberately dumb —
  the DIRECTORY is the truth: no projection table, no upload path.
  `listTaskAttachments` (:35) returns newest-first, dotfiles skipped,
  `LIST_CAP = 100` (:33). `resolveTaskAttachment` (:67) goes through
  `resolveStoreSegment`, which THROWS on traversal.
  `attachmentContentType` (:91) whitelists inline types (`INLINE_TYPES`, :78 —
  png/jpg/jpeg/webp/gif/pdf/txt/log/md/json); everything else, **HTML and SVG
  included**, is `application/octet-stream` as a download.
- **Serving route**: `GET /projects/:slug/tasks/:key/attachments/:file`
  (`app/routes.ts:38-42` → `app/routes/task-attachment.ts:31`). Authorization is
  **project membership** (`requireProjectMember`, the same bar as
  `/resources/run-log`) — a screenshot of the running app is run-artifact
  material. Any traversal or missing file is a plain 404 (no oracle);
  >50MB is a 413 (:29); every response carries
  `x-content-type-options: nosniff` and
  `content-security-policy: sandbox; default-src 'none'` (:63-67), so even the
  inline types render inert.
- **UI**: newest-first panel on the task page
  (`task-detail/attachments-panel.tsx`, mounted at `task-detail-page.tsx:630`),
  fed by `project.task.tsx:245-251` and gated on `runsVisible`. **Evidence
  linkify**: a timeline `evidence:` label whose tokens name a REAL attachment
  filename becomes a link to that route (`timeline.tsx:105-130`, props threaded
  :150-160 / :238-239 / :483-484). Labels naming anything else stay plain text —
  the set of real filenames is the allow-list.

---

## 10. Run console — inputs, thought traces, tool chips (NEW)

**P19-G8/G11 — the run's INPUTS, on the run.** `recordRunInputs`
(`specialist-run.server.ts:533`) writes ONE `ev:"meta"` console line at run start
naming what the run was given: delivering vs supporting, anchor size, persona and
prompt sizes, granted vs mounted skills (and by which carrier), knowledge bases,
mounted/unresolved/unhealthy MCP servers, toolkit tools, and every grant that did
NOT reach the run (`runInputsSummary`, :482). It is a **LINE, not a column** —
raw envelope in the canonical `.jsonl` plus a `run_log_lines` projection row, the
same migration-free mechanism `run·session_missing` uses — so the `{ } raw`
toggle prints it verbatim. It carries names, counts and canonical task text,
never a server CONFIG or an env value, and is additionally passed through the run
sink's redactor. Best-effort: a run never fails because its disclosure could not
be written. The resume path builds the same record
(`resolveResumeConfinement` returns `runInputs`, :2133-2138).

**P19-RC1 (`45ddb70`) — the console renders structure it already stored.** Three
foldings, all pure functions in `app/features/runtime/runs-helpers.ts` so what a
reader is shown is testable against the stored lines:

- **Thought traces**: `isThoughtLine` (:266) / `groupThoughts` (:280) fold
  CONSECUTIVE `ev:"think"` lines into one disclosure labelled by `thoughtLabel`
  (:323, e.g. "Thought for 4s · 3 steps"). Consecutive only — thought → acted →
  thought is the real shape of a turn. A lone reasoning line stays an ordinary row.
- **Tool chips**: `toolChip` (:351) promotes a named tool call out of the prose; a
  line whose provider sent no name keeps the plain row (a chip labelled with a
  guess is worse than no chip). `fileChangeChips` (:369) renders one chip per
  file, marked with a GLYPH as well as a colour (WCAG 1.4.1), with no line counts
  — the envelope records a path and a kind and nothing else.
- **Code blocks**: `consoleCodeBlock` (:393) moves multi-line `out`/`diff` into a
  bounded, scrollable block with a copy affordance; `diffLineKind` (:400) colours
  +/− on top of the stored glyph. Bounded by CSS, **never truncated**.

**The raw toggle stays authoritative**: every folding is a no-op under `raw`
(`runs-panels.tsx:488-490`, toggle at :606-608), the same contract
`collapseTelemetry` holds, pinned by unit tests and a panel test that flips the
toggle and asserts the stored envelopes verbatim.

---

## 11. Scheduled re-runs (`schedule.server.ts`)

`scheduleTaskAction` (:123) writes a `schedules[]` entry into the task file
(canonical, survives rebuild) and clamps the requested autonomy to the project's
(`clampAutonomy`, :150, R19-A); `startScheduleRunner(db)` (:574, started at
`boot.server.ts:367`) polls `task_projections.schedules_json` for due entries and
fires `fireDueSchedules` (:286) → an operator run (backend-agnostic, works for
Claude AND Codex). Lifecycle `pending → claimed → fired|failed|cancelled`
(DOMAIN-MODEL.md §2.5). `cancelScheduledAction` (:186) is the human withdrawal;
archiving a task cancels its schedule (R14-3, `firedAt` null).

---

## 12. Run recovery + projection

`run-recovery.server.ts` (`finalizeOrphanedRuns` :51, `recoverUnreactedAgentRuns`
:194, `recoverStrandedOperatorPlans` :350) reconciles runs interrupted by a
restart; `run-projection.server.ts` projects `agent_runs` + `run_log_lines`;
`session-export.server.ts` builds the downloadable transcript installer
(`/resources/session-export`). Run cost/turns/duration surface on the task
timeline.

---

## 13. Runtime image prerequisites (Dockerfile)

`specialist-mcp.server.ts` spawns a registered stdio server's command **verbatim
— there is no allow-list**, so whatever the command names has to exist in the
runtime image. Three image facts are now load-bearing for the agent runtime:

- **uv / uvx** (`876aff0`, `Dockerfile:85`): copied as two static binaries from
  `ghcr.io/astral-sh/uv:0.12.3`. Node servers (`npx -y @modelcontextprotocol/…`)
  always worked because npx ships with the base image; every `uvx mcp-server-…`
  — the entire Python half of the MCP ecosystem — failed at registration with a
  bare ENOENT. No system `python3`: uv downloads and manages its own CPython.
  Its cache and that interpreter live on the /data volume
  (`UV_CACHE_DIR=/data/runtimes/uv-cache`, `UV_PYTHON_INSTALL_DIR=/data/runtimes/uv-python`,
  :101-102) for the same reason `CLAUDE_CONFIG_DIR`/`CODEX_HOME` do — both
  default under `$HOME`, which is container-local, so every recreate would
  re-download a 29MB interpreter. Image 1.18GB → 1.22GB.
- **chromium** (`308cbc3`, `Dockerfile:60-73`): Debian's `chromium` +
  `fonts-liberation`, with `ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium`. A
  pinned binary in the image rather than `npx playwright install` at run time,
  same reasoning as uv. **Status note from the commit**: the browser was proven
  live against the real CLI on the HOST chrome; the container chromium layer
  PENDS user network to ghcr.io / deb.debian.org — `docker compose up -d --build`
  completes it, nothing else changes.
- **npm install serialization** (`b97ad02`, `Dockerfile:29,40`): both `npm ci`
  lines carry `--foreground-scripts`. A from-scratch install (changed lockfile +
  refreshed `node:26-slim`, so no layer cache) failed live with **ETXTBSY** —
  esbuild's postinstall spawns its just-written binary for `--version` while
  overlayfs still counts a writer on it. Cost is paid only when the
  lockfile-keyed layers actually rebuild. (Two earlier build fixes in the same
  window: `a1ceb78` `npm prune --omit=dev` needs `--no-audit --no-fund` or it
  stalls on npm 11.19.0's registry round-trip; `fa773e0` stopped pruning
  node_modules on every source change.)

---

## 14. Delta summary — what changed since pass 19

| Change | Commit | Files |
| --- | --- | --- |
| **R19-19 agents get a real browser** (ruling 75) | `308cbc3` | **NEW** `specialist-browser-mcp.server.ts` (173); `capabilities.ts:111,240`; `specialist-run.server.ts:1184-1227, 1392-1399, 1777-1786, 2187-2226`; `specialist-mcp.server.ts:60-66`; **NEW** `files/task-attachments.server.ts` + `routes/task-attachment.ts`; `file-store-root.server.ts:87`; `routes.ts:38-42`; `timeline.tsx:105-130`; `env.server.ts:92`; `Dockerfile:60-73` |
| **R19-18 first-run MCP installs finish in the background** (ruling 74) | `88a17cc` | **NEW** `org/mcp-warmup.server.ts` (145); `resources.server.ts:1282,1347,1409-1424`; `boot.server.ts:127`; `resource-rows.tsx:183-220`; `resources-panel.tsx:113-122`; baseline `warming_since` |
| **R19-17c install-vs-hang detection** | `0cc9b55` | `resources.server.ts:826, 896-909` |
| **R19-17b unreachable reason kept on the row** | `101f72f` | `resources.server.ts:539,1278,1390,1402`; `resource-rows.tsx:257-258`; baseline `last_error` |
| **R19-17 surface what the failed MCP command said** (ruling 73) | `8a5f782` | `resources.server.ts:764-772, 867-932` |
| **uv/uvx in the image** (Python MCP servers) | `876aff0` | `Dockerfile:79-102` |
| **P19-RC1 run console: thoughts / chips / code blocks** | `45ddb70` | `runs-helpers.ts:242-416`; `runs-panels.tsx:488-490,606-608`; `app.css` |
| npm install/prune build fixes (ETXTBSY, prune hang, prune churn) | `b97ad02`, `a1ceb78`, `fa773e0` | `Dockerfile` |
| (adjacent, not runtime) in-app OAuth config; public-repo import without a connection | `affdaed`, `881a4e1` | `auth/oauth-providers.server.ts`; `github-client.server.ts` |

Landed in the **pass-19 merge (`4184e95`)**, i.e. after the old doc's `65063b8`
baseline and therefore missing from it entirely:

| Change | Where |
| --- | --- |
| **R19-3 (ruling 57)**: reviewer inheritance is KBs ONLY; the "widened to skills" docstring was a fiction and is gone | `specialist-run.server.ts:286-301`; pinned in `skill-mount.server.test.ts` |
| **F19-15**: the `.claude` strip became SURGICAL (`MOUNT_MARK`) — a concurrent run no longer unmounts a live run's skills | `skill-mount.server.ts:50-98, 146-166` |
| **R19-4 (ruling 58)**: a supervised, operator-authorized delivery records a "Move to \<review\>" next-step card | `task-actions.server.ts:3768-3776, 4009` |
| **R19-1 (ruling 55)**: the operator gets a full read-only clone (`OperatorWorkspaceView`) | `operator-run.server.ts:718-760, 1069` |
| **R19-A (ruling 67)**: a run may never exceed the project's configured autonomy | `operator-actions.server.ts:215`; `schedule.server.ts:150` |
| **P19-G0 / G8 / G11**: fresh-run canonical anchor + the run-input disclosure line | `specialist-run.server.ts:392, 482-580, 1252` |

### Corrections to the pass-19 doc

1. **Every line anchor was stale.** The pass-19 doc was verified at `65063b8`,
   before the merge; `specialist-run.server.ts` went 1900 → 2738 lines. Examples:
   `startAgentRun` 633 → **934**; `buildSpecialistPersona` 1188 → **1581**;
   `resolveResumeConfinement` 1627 → **2107**; `cloneRepo` 1828 → **2408**;
   `operatorDeliverForReview` 1813 → **2236**; `performDelivery` 3359 → **3429**;
   `manualDeliverForReview` 3675 → **3878**; `applyRecommendation` 5411 → **5913**.
   Claude-adapter anchors (242-276, 555, 573, 607-615, 663-665) are the one block
   that survived unchanged.
2. **§3.1's "accuracy note" is obsolete and its conclusion inverted.** It framed
   the KB-only union as an unfinished rename ("treat the rename as prospective").
   Ruling 57 (R19-3) settled the opposite way: KBs only, permanently, and the
   docstring that claimed a skills widening was DELETED as a fiction. A reader
   acting on the old note would try to "finish" a widening the owner refused.
3. **§5's claim that supervised delivery is deliberately left to the human is no
   longer true** — R19-4 added the server-recorded next-step card for
   operator-authorized supervised deliveries (§5.1).
4. **§3.2's description of the strip as an unconditional `rm -rf`** predates
   F19-15; the strip now preserves this process's own mounts and there is an
   explicitly accepted residual (mounts are never collected).
5. **§1's step list omitted the browser mount, the fresh-run anchor and the
   run-input disclosure**, all of which now sit inside `startAgentRun`.

### Verification notes (pass 20)

- `use-browser` is `kinds: ["agent"]` — **the operator never gets a browser.**
- The browser mount is the ONLY capability in the catalog whose enforcement is
  the absence of a tool surface rather than a denylist entry; there is
  intentionally no `CAP_DENY_RULES` row for it.
- `resolveBrowserMcp` returns `{server: null, refused: null}` for an UNGRANTED
  capability and `{server: null, refused: {...}}` only when granted-but-blocked —
  an ungranted capability is not a "miss" and must not appear in the disclosure.
- The screenshot default-name→output-dir vs `filename:`→child-cwd split is a
  Playwright-MCP behaviour (0.0.79), **not** something Viberr fixes; the persona
  text is the mitigation and it says so out loud.
- The container chromium layer was still pending network at the time of `308cbc3`
  — verify `VIBERR_BROWSER_EXECUTABLE` actually resolves in the running container
  before trusting a container browser run.
- The MCP hyphen/underscore dialect (Claude hyphenates, Codex underscores) is
  unchanged and unfixable from here — it is why reserved names are registered in
  both spellings.
