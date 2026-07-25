# Pass 14 — Knowledge bases, MCP servers, skills: code map + findings

Verified against `main` @ `fa138e1` on 2026-07-25. Every pass-13 claim was re-read
against current source (the pass-13 doc predates the W1a–W1f fix commits); nothing
below is carried prose. `docker-data/` was read (not modified) to confirm real
store layouts: `kb/{p13-facts,release-checklist}`, `skills/{developer,reviewer,
viberr-app-expertise,p13-selftest-skill}-…`, `agents/profiles/*.md` grants keyed
by slug (`docker-data/agents/profiles/developer.md`, `operator.md`).

---

## 1. Knowledge-base model

### Stores on disk

- A KB is a real folder `${DATA_ROOT}/kb/<dir>/`; SQLite `org_knowledge_bases`
  carries metadata only (`name`, `dir`, `refresh`, `last_indexed_at`). Listings
  union metadata rows with on-disk folder names; a rowless folder renders under a
  synthetic `disk:<dir>` id and is adopted on edit/re-scan/watcher-touch
  (`app/server/org/resources.server.ts:70-134`, `:198-211`, `:407-417`).
- Path containment is layered: `diskNameFromId` rejects separators/dot-segments
  (`resources.server.ts:76-94`); `resolveStoreSegment` throws on any unsafe
  segment and re-checks containment (`app/server/files/file-store-root.server.ts:108-127`);
  `kbDirPath`/`skillDirPath` route through it (`:135-137`, `:145-147`);
  `sanitizeDirPath`/`assertInsideRoot` guard every store file op
  (`app/server/org/store-files.server.ts:100-131`).

### CRUD incl. the new in-app authoring

| Operation | Code | Behavior |
|---|---|---|
| create/adopt | `resources.server.ts:227-321` | `dir = slugify(name)`; `mkdir -p`; collision refused |
| rename | `:259-277` | folder move **plus** reference rewrite `updateResourceReferences("kb", oldDir, dir)` (`:274`) |
| delete | `:323-346` | `rmSync` + grant **drop** (`:334`) + row delete by dir |
| re-scan (manual) | `:350-385` | timestamp + real doc count; adopts disk-only |
| re-scan (watcher) | `:394-428` | keyed by dir; **adopts disk-only folders now** (P13-KM-16, `:407-417`); `manual` skipped |
| doc write (NEW) | `store-files.server.ts:377-411` | `writeStoreDoc` — in-app "New document" (P13-LV-06); extension-gated, traversal-checked, audit `org.store.doc_written`; route intent `store-write-doc` (`app/routes/org.settings.tsx:357-369`) |
| doc read | `store-files.server.ts:352-365` | `readStoreDoc` exists but has **no production caller** — the UI cannot open/edit an existing doc (finding KM-08) |
| uploads/mkdir/delete/import | `store-files.server.ts:214-449`, `:510-673` | unchanged from pass 13, plus refresh-in-place import (below) |

GitHub import (`store-files.server.ts:510-673`): default-connection token
required, ≤100 files, ≤1 MB/blob, per-blob failures counted honestly
(`:644-663`). P13-KM-13 fixed: a `.viberr-import.json` provenance dotfile
(`:463-485`) lets a re-import of the same `owner/repo/subpath` **replace the
folder in place**; only a different source gets a `-2` suffix (`:594-613`). The
marker is a dotfile, so both the scanner (`:57-61`) and the injector
(`kb-injection.server.ts:91`) skip it.

### Live watcher

`startKbWatcher` (`app/server/files/kb-watch.service.server.ts:44-140`) — **node
`fs.watch(recursive)`**, not chokidar (`:82`). 250 ms trailing debounce per
top-level dir (`:23`, `:86-94`), HMR-singleton behind
`Symbol.for("viberr.kbWatcher")` (`:25`, `:47-56`), error clears the handle so
`/resources/health`'s `kbWatcher` flag is truthful, transient FS errors re-arm
once (`:104-135`). Started at `app/server/boot.server.ts:147`; surfaced at
`app/routes/resources.health.ts:40`. Only `last_indexed_at`/doc-count move —
runs always read the live folder (disclosed in the KB modal copy,
`resources-panel.tsx:112-121`).

### Injection into runs (both backends)

- One canonical reader `readKbBody` (`app/server/files/kb-injection.server.ts:126-201`):
  recursive walk, 6 text extensions (`:37-44`), symlink-skip/cycle-guard/depth-cap/
  containment (`:58-116`), deterministic sort. **P13-KM-02 fixed:** missing folder
  warns (`:140-144`), empty KB warns (`:148-150`), unreadable warns (`:195-199`).
  **P13-KM-14 fixed:** per-doc headings are charged against the budget
  (`:170-181`); truncation appends an explicit marker (`:183-192`).
- Budget `KB_INJECTION_BUDGET = 24_000` chars, **shared across all declared KBs**
  in one run: specialist `specialist-run.server.ts:964-972`; operator
  `operator-run.server.ts:1168-1176`.
- Specialist: `buildSpecialistPersona` (`specialist-run.server.ts:931-1010`) =
  definition → trusted-provenance banner (only when something resolved,
  `:973-989`) → skills → KBs → MCP-governance rule (`:998-1008`). Delivered as
  Claude `systemPrompt` appended to the `claude_code` preset
  (`claude-runtime.server.ts:551-561`) and as Codex `developer_instructions`
  (`codex-runtime.server.ts:197`). Resume re-derives the identical persona
  (`specialist-run.server.ts:1196-1203`).
- Operator: `buildOperatorSystemPrompt` (`operator-run.server.ts:1134-1192`) =
  shipped manual → additive project persona → skills (default
  `viberr-app-expertise`) → KBs → live policy block → non-negotiable rules; used
  verbatim by both operator backends (Claude `:975`/`:1003`; Codex `:618`/`:639`).

### Grant model + resolution path

- References are **slugs** in two places: org templates
  `${DATA_ROOT}/agents/profiles/<id>.md` frontmatter `resources.{skills,mcps,kb}`
  (`app/server/org/gagents.server.ts:132-134`, `:213-215`) and per-project
  deployment snapshots `project.md` `agents[].definition.resources`
  (`resource-references.server.ts:16-35`). KB references are the **store dir**.
- **P13-KM-01 fixed:** the org AgentModal keys KB chips on `k.dir`
  (`resources-panel.tsx:668-678`) and `kbDirsOf` repairs legacy display-name
  grants on open (`:388-409`, commit 2c907cc). The project-side picker was always
  dir-keyed via `buildResourceCatalog` (`resource-catalog.server.ts:42-47`, `:74-78`).
- Operator: `OperatorAuthority.kb` from the deployment
  (`operator-actions.server.ts:83`, `:211`).

## 2. MCP registry

### Registration + probe/handshake

- Rows `org_mcp_servers`: slugified `name`, `transport` HTTP|stdio, `target`,
  sealed `cred_ref`, `tools_count`, `up`, `last_checked_at`
  (`resources.server.ts:432-470`). Reserved names `viberr`/`viberr_agent`/
  `viberr-agent` refused at save (**P13-KM-12 fixed**, `:922-926`; slugify makes
  underscores unreachable anyway, `app/shared/ids/slugify.ts:8-14`).
- **Both transports now run the real MCP handshake** (P13-LV-10):
  - stdio: spawn → JSON-RPC `initialize` → `notifications/initialized` →
    `tools/list`, hard timeout, child killed on settle
    (`resources.server.ts:590-690`).
  - HTTP: `discoverHttpMcpTools` (`:766-864`) — same handshake over Streamable
    HTTP, carrying `mcp-session-id` (`:834`, `:790`), accepting JSON or
    SSE-framed bodies (`:801-812`), classifying 401/403 as "authentication
    rejected" and non-MCP endpoints honestly (`:825-837`). The old
    any-response-is-up GET survives only as `probeMcpTarget` (`:717-750`),
    no longer used by save/test.
  - Client capabilities declared = the SDK set (`roots.listChanged`, `sampling`,
    `elicitation`, protocol `2025-06-18`; P13-LV-19, `:702-710`) so probe counts
    match run counts.
  - **P13-KM-05 fixed:** probes carry the sealed credential — stdio spawn env
    `MCP_CREDENTIAL` (`:570-576`, `:607`), HTTP `Authorization: Bearer` (`:791`);
    both `saveMcpServer` (`:944-948`) and `testMcpServer` (`:1011-1021`).
- Tool counts are never fabricated: `up=1 + real count` or `up=0 + NULL`
  (`:949-951`, `:1023-1041`). Staleness is the shared 1-h rule
  (`app/shared/freshness.ts:22`, consumed at `resources-panel.tsx:40`, `:841-877`);
  nothing re-probes in the background (disclosed as "stale, retest").

### Credentials

AES-256-GCM secret-box; only `hasCred` reaches clients (`resources.server.ts:441`,
`:465`); opened once at spawn by `getMcpCredential` (`:480-508`) with warns on
legacy/undecryptable values. **P13-KM-06 fixed:** explicit `clearCred` intent
(`:885-907`) with a real "Remove the stored credential" toggle
(`resources-panel.tsx:143-265`; route `org.settings.tsx:276`).

### Grants → runs

- **Specialists** (`specialist-mcp.server.ts:33-83`): name → registry row →
  `{type:"http",url,headers.Authorization}` | `{command,args,env.MCP_CREDENTIAL}`.
  `viberr` skipped (`:48`); **P13-KM-11 fixed:** unresolvable names warn
  (`:54-57`, `:64-67`). **P13-KM-17 half-fixed:** run-side `splitCommand` is
  quote-aware (`:90-98`) — but the probe still splits naively (finding KM-04).
  Merged with the `viberr_agent` collaboration toolkit (toolkit wins) on fresh
  runs (`specialist-run.server.ts:777-793`, `:822-826`) and resumes (`:1204`,
  `:1239-1247`).
- **Operator, Claude** — **P13-KM-03 fixed:** `OperatorAuthority.mcps`
  (`operator-actions.server.ts:84-91`, `:212`) resolves through
  `resolveSpecialistMcpServers` and mounts next to the in-process `viberr`
  toolkit, with `mcp__<name>` pushed to `allowedTools`
  (`operator-toolkit.server.ts:360-375`; run wiring
  `operator-run.server.ts:1004-1005`). Test-covered
  (`operator-toolkit.server.test.ts:41-89`).
- **Operator, Codex** — **still nothing**: `startCodexOperatorRun` passes no
  `mcpServers` (`operator-run.server.ts:627-645`), and the Codex operator thread
  runs `networkAccessEnabled:false, webSearchMode:"disabled"`
  (`codex-runtime.server.ts:513-518`), so even a mounted HTTP MCP couldn't
  connect (finding KM-02).
- **Codex translation** (`codex-runtime.server.ts:83-122`): portable HTTP/stdio
  only, `{type:"sdk"}` skipped, credentials deliberately dropped (argv exposure,
  `:88-96`) — now **disclosed in the capability-matrix modal**
  (`capability-matrix-modal.tsx:211-213`), as is the Codex hyphen→underscore
  tool-name rename (`:215-219`; adapter note `codex-runtime.server.ts:70-78`).

### In-process governance servers

- `viberr` (operator): capability-gated tool set — `get_task` always;
  `post_comment`/`set_goal` ← `append-typed-events`; packets ←
  `generate-packets`; `engage/run/prompt_agent` ← assignment caps;
  `transition_stage`; `accept_completion` ← `completion-for-acceptance`
  (`operator-toolkit.server.ts:85-350`). Codex operator gets the equivalent via a
  policy-filtered plan `outputSchema` executed server-side through the same gates
  (`operator-run.server.ts:640-641`, `:694-720`).
- `viberr_agent` (specialist): `post_comment`/`ask_human`/`report_outcome`,
  collab-gated; server named at `agent-toolkit.server.ts:366-373`.

## 3. Skills

- Product skills live at `${DATA_ROOT}/skills/<name>/SKILL.md`; disk-is-truth
  listing/adoption identical to KBs (`resources.server.ts:1147-1176`). Editor
  CRUD with the E4 protections: 256 KB read cap (`:1067`, `:1088-1097`),
  truncated-round-trip refusal (`:1221-1237`), empty-body-keeps-disk plus the
  now-wired `clearBody` escape (**P13-KM-18 fixed** — the modal sends
  `clearBody=1` when the editor is emptied, `resources-panel.tsx:316-320`;
  route `org.settings.tsx:294`). Rename moves the folder **and rewrites
  references** (`resources.server.ts:1239-1251`); delete drops them (`:1314`).
- **`skills-lock.json` (repo root) is not product code.** It is the lockfile for
  the skills vendored into `.agents/skills/` for agents working *on* the viberr
  repo (emilkowalski/vercel-labs sets); zero consumers in `app/`, `scripts/`, or
  `package.json` (grep-verified; only FILES.md lists it). The product's skill
  subsystem never reads it.
- **Materialization: skills are never installed into run homes.** Both backends
  receive skill bodies as prompt text — `readSkillBody` strips frontmatter and
  returns the body (`app/server/files/skill-body.server.ts:10-30`), injected by
  the persona/system-prompt builders (`specialist-run.server.ts:956-959`;
  `operator-run.server.ts:1157-1162`). Missing/unreadable skills warn.
- **Isolation (host skills must not leak):**
  - Claude: `settingSources: []`, `skills: []`, `plugins: []`
    (`claude-runtime.server.ts:516-534`) plus the `Skill` tool in
    `BASE_DENIED_BUILTINS` (`:227-255`) because ~16 SDK-bundled skills survive
    `skills: []` (docker-verified honest-limit comment `:523-531`). Spawn env is
    rebuilt and credential-filtered with a forced `CLAUDE_CONFIG_DIR`
    (`runtime-registry.server.ts:255-265`, `:295-299`).
  - Codex (**P13-LV-13/14 fixed**): app-owned `CODEX_HOME`
    (`${DATA_ROOT}/runtimes/codex-home`) with only `auth.json` mirrored in
    (`codex-config.server.ts:62-68`, `:109-159`); config fence
    `skills.include_instructions:false` + `skills.bundled.enabled:false`,
    `features.{apps,plugins,hooks}:false`, `memories.*:false`,
    `project_doc_max_bytes:0` (workspace `AGENTS.md` never read — RT-04),
    `mcp_servers` replaced per run (`codex-runtime.server.ts:189-253`).

## 4. Rename/delete lifecycle (all three kinds)

`updateResourceReferences` (`app/server/org/resource-references.server.ts:45-64`)
rewrites (rename) or drops (delete) a slug across **both** reference stores:
org templates (`:84-124`) and project-deployment snapshots via `updateProjectFile`
(`:133-187`); best-effort per file, logged.

Call sites (`resources.server.ts` grep, exhaustive): KB rename `:274`, KB delete
`:334`, MCP delete `:1054`, skill rename `:1250`, skill delete `:1314`.
**MCP rename is missing** — `saveMcpServer`'s edit path updates the row only
(`:961-978`), so renaming a server orphans every grant (finding KM-01), despite
pass-13's FINDINGS.md marking KM-07 "DONE" for all three kinds.

Dangling-reference surfacing today:

- Project profile modal: red removable `missing` chips
  (`create-profile-modal.tsx:628-633`, `:663-668`). **P13-KM-09 fixed:** the
  loader now ships the operator-superset catalog and the client filters `viberr`
  out for specialists (`project.agents.tsx:69-71`,
  `create-profile-modal.tsx:808-818`) — editing the operator no longer paints its
  real toolkit grant as broken.
- Org AgentModal: legacy/unmatched grants are **silently preserved and rendered
  nowhere** (`resources-panel.tsx:466-472`, `:510-512`) — finding KM-10.
- Agents detail panel: plain chips, no missing state
  (`agents-page.tsx:126-157`, `:493-498`) — finding KM-11.
- Run time: every kind now logs a warn (`kb-injection.server.ts:140-150`;
  `skill-body.server.ts:20-27`; `specialist-mcp.server.ts:54-57`). No timeline/
  run-evidence surfacing.

"Used by" counts (**P13-KM-08 partially fixed**): KB/skill rows count global
templates by slug (`resources-panel.tsx:1102-1113`, `:758-763`, `:958-962`) and
say "templates" honestly; MCP rows still have **no** count and delete confirms
still show none (finding KM-09).

## 5. Capability catalog and the MCP boundary

- Catalog: `app/shared/capabilities.ts:33-94` — operator coordination caps,
  agent delivery caps, collaboration caps, always-human trio; enforcement scopes
  at `:156-206` (`both` / `claude-only` / `advisory`).
- **`use-web-search-fetch`** (P13-LV-18, owner-ruled): granted by default,
  `kinds: [agent, operator]` (`:68`). Enforcement:
  - Claude specialist: deny `WebFetch`/`WebSearch` when withheld
    (`specialist-tool-policy.ts:60-68`).
  - Claude operator: same denial (`operator-run.server.ts:1009-1011`,
    `operatorWebWithheld :1102-1105`).
  - Codex operator: web/network always off regardless of grant
    (`codex-runtime.server.ts:513-518`); disclosed
    (`capability-matrix-modal.tsx:226-230`).
  - Codex specialist: **nothing** — no sandbox flag, no prompt line, despite two
    in-code claims otherwise (finding KM-06). The matrix labels it claude-only
    (`capabilities.ts:181-193`), which is the honest part.
- **MCP tools sit outside the tool policy** (pass-13 ruling upheld): no `mcp__*`
  deny rule exists; the rule lives (a) in every MCP-carrying specialist persona
  (`specialist-run.server.ts:998-1008`) and (b) in the capability-matrix
  disclosure ("MCP tools are not gated by this matrix",
  `capability-matrix-modal.tsx:220-225`). Real confinement for Claude runs is the
  deny lists (`claude-runtime.server.ts:163-255`, applied `:576-583`); Codex
  supporting/operator runs get read-only sandboxes
  (`codex-runtime.server.ts:267-272`).

## 6. UI surfaces vs backend truth

| Surface | State |
|---|---|
| Org settings → KB panel/modal | Honest: real counts, dir shown, refresh copy states it's metadata-only (`resources-panel.tsx:112-121`), watcher freshness real. |
| Org settings → MCP panel/modal | Honest handshake copy ("a real MCP handshake runs on save & test"), stale-dot rule shared, cred add/keep/remove all real. Missing: used-by count (KM-09), rename-orphan hazard invisible (KM-01). |
| Org settings → Skill panel/modal | Honest; clearBody wired; truncated-file write refusal server-side. |
| Org settings → Agent template modal | KB chips dir-keyed + legacy repair (KM-01(p13) fixed); legacy grants invisible though preserved (KM-10). |
| Store browser | Real tree, uploads, mkdir, delete, import-with-refresh; **New document** creates at root only, no edit-existing (KM-08); import ignores browsed folder (KM-08). |
| Project agents editor | Dir-keyed catalog, red missing chips, operator superset + client `viberr` filter (KM-09(p13) fixed). |
| Capability matrix modal | New runtime-parity disclosure block covers cred-drop, tool-name rename, MCP-outside-matrix, operator web asymmetry (`capability-matrix-modal.tsx:192-231`). Does not mention operator-MCPs-are-Claude-only (KM-02). |
| Agents detail panel | Plain resource chips, no dangling indicator (KM-11). |
| `/resources/health` | `kbWatcher` flag is real (handle cleared on error). |

## Test coverage delta (grep-verified)

Covered: KB CRUD/rename/delete + **template**-side reference integrity
(`resources.server.test.ts` — 29 cases, integrity at `:583-720`); kb-injection
(8); kb-watch (8); operator KB injection (`operator-kb-injection.server.test.ts`);
**specialist persona resources incl. KB + unresolved-KB** (P13-KM-10 fixed:
`specialist-run.server.test.ts:815-864`); operator org-MCP mount
(`operator-toolkit.server.test.ts:41-89`); specialist-mcp (8); codex-config (8);
codex-runtime mcp translation; store-files incl. `writeStoreDoc`/`readStoreDoc`
(`store-files.server.test.ts:404-432`).

Untested: `rewriteProjects` (the deployment leg of reference rewriting — no
`resource-references.server.test.ts`, no `project.md` case in the integrity
describe); `resolveResumeConfinement` (resume-path persona/MCP re-derivation,
`specialist-run.server.ts:1160-1255`); `discoverHttpMcpTools` SSE/session-id
branches (only save/test flows via fetch fakes in `resources.server.test.ts`);
any MCP-rename reference assertion (would have caught KM-01).

---

## Findings table

| id | sev | headline | evidence | conf |
|---|---|---|---|---|
| KM-01 | HIGH | **MCP rename orphans every grant** — KB/skill renames rewrite references, MCP delete drops them, but `saveMcpServer`'s edit path never calls `updateResourceReferences`; a renamed server's grants silently resolve to nothing (run-side log warn only). Pass-13 FINDINGS.md marks KM-07 "DONE" for all three kinds. | `resources.server.ts:961-978` vs `:274`,`:1054`,`:1250`; `planning/discovery-2026-07-24-pass13/FINDINGS.md:219` | high |
| KM-02 | MED | Operator's declared org MCPs reach **Claude-backed operators only**; a Codex-backed operator gets none (no `mcpServers` in the run, network+web hard-disabled), the grant UI shows them attached either way, and the new parity-disclosure list omits this asymmetry. | `operator-run.server.ts:627-645`; `codex-runtime.server.ts:513-518`; `capability-matrix-modal.tsx:195-231` | high |
| KM-03 | MED | Skill injection is **unbounded** — `readSkillBody` reads the whole SKILL.md with no cap while KBs get a 24k budget; a large SKILL.md (uploads/imports/disk can exceed the editor's 256 KB read cap) lands verbatim in every run's system prompt for operator and specialists alike. | `skill-body.server.ts:10-30`; contrast `kb-injection.server.ts:47`; upload path `store-files.server.ts:214-288` | high |
| KM-04 | MED | stdio command parsing disagrees between probe and run: discovery splits on whitespace, run resolution is quote-aware — a quoted target (path with spaces, JSON arg) works in Claude runs but reports "unreachable/exited before responding" in Settings. Same health-vs-runtime divergence class P13-KM-05 fixed for credentials. | `resources.server.ts:594` vs `specialist-mcp.server.ts:90-98` | high |
| KM-05 | MED | Under the shared 24k budget, a later declared KB can be dropped **with zero signal**: the caller `break`s at budget ≤ 0 without logging, and `readKbBody` suppresses both the warn (docs exist) and the truncation marker (`parts.length > 0` guard) when nothing fit. | `specialist-run.server.ts:964-972`; `operator-run.server.ts:1168-1176`; `kb-injection.server.ts:157-192` | high |
| KM-06 | LOW-MED | `use-web-search-fetch` withheld on a **Codex specialist** enforces nothing and the promised fallback doesn't exist: `capabilities.ts` claims "prompt-level on Codex" and the deny-rule comment claims MCP fetch helpers are removed — no prompt line mentions web egress anywhere in specialist prompts, and the deny list is only `WebFetch`/`WebSearch`. Matrix's claude-only label is the honest part. | `capabilities.ts:62-68`,`:190-192`; `specialist-tool-policy.ts:60-68`; grep: no "web" in `specialist-run.server.ts` | high |
| KM-07 | LOW-MED | The project-deployment leg of reference rewriting (`rewriteProjects`) has **zero test coverage** — the pass-13 integrity tests exercise templates only, so a regression in the nested `agents[].definition.resources` edit (the harder path) would land silently. | no `resource-references.server.test.ts`; `resources.server.test.ts:583-720` templates-only | high |
| KM-08 | LOW-MED | In-app KB authoring is half-shipped: "New document" always writes to the KB **root** (`path: []` hardcoded), existing docs cannot be opened or edited (`readStoreDoc` has no production caller), and GitHub import still ignores the browsed folder (P13-KM-20 unfixed) — the only in-app edit of an existing doc is blind overwrite by retyping its name. | `store-browser.tsx:746`,`:775-783`; `store-files.server.ts:352-365` (dead); import intent carries no path `org.settings.tsx:395-401` | high |
| KM-09 | LOW | MCP rows still show no used-by count and no delete/rename confirm shows reference counts (KB/skill rows count templates only, labeled honestly) — the admin's last guardrail before KM-01's rename trap or a delete is still blind for MCPs. | `resources-panel.tsx:811-914` (no `usedBy` prop), `:1235-1250` | high |
| KM-10 | LOW | Org AgentModal silently preserves **invisible** legacy grants: unmatched skills/mcps/kbs are re-submitted on every save but rendered nowhere in the modal, so an orphaned grant (e.g. post-KM-01) can't be seen or removed from org settings — only the project modal shows red chips. | `resources-panel.tsx:466-472`,`:510-512` | high |
| KM-11 | LOW | Agents detail panel renders dangling resource references as normal healthy chips (no missing state) — residual from pass 13, lower blast radius now that rename/delete rewrite, but disk-side deletions and KM-01 still produce lying chips. | `agents-page.tsx:126-157`,`:493-498` | high |
| KM-12 | LOW | `buildOperatorToolkit`'s comment claims `allowedTools` "confines an operator run to exactly the listed names"; the adapter documents `allowedTools` as auto-approve-only ("does NOT remove tools from context") and operator runs use `bypassPermissions`, so the list is inert — real confinement is the deny lists. Misleads maintainers about what protects the run. | `operator-toolkit.server.ts:36-38`,`:366-371` vs `claude-runtime.server.ts:52-55`,`:510` | med-high |
| KM-13 | LOW | KB "N docs" counts every non-dot file (binaries included) while injection reads only 6 text extensions — a KB of PDFs shows a healthy count, injects nothing, and only a server log warns. Delete-confirm and row copy repeat the count. | `resources.server.ts:190` + `tree.ts:18-23` vs `kb-injection.server.ts:37-44` | high |
| KM-14 | LOW | Operator template ships `mcps: [viberr]` but the grant is decorative in both directions: the toolkit mounts unconditionally and `resolveSpecialistMcpServers` skips the name, so adding/removing the chip changes nothing — offered as a real-looking toggle in both pickers. | `seed/assets/operator.profile.md:22-23`; `operator-toolkit.server.ts:352-374`; `specialist-mcp.server.ts:48`; `resource-catalog.server.ts:49-57` | high |
| KM-15 | LOW | `viberr_agent` still not defensively skipped in `resolveSpecialistMcpServers` (only `viberr`); unreachable via the UI now (save guard + slugify) but a hand-edited DB row would shadow the Claude toolkit merge order asymmetrically vs Codex. | `specialist-mcp.server.ts:48`; guard `resources.server.ts:922-926` | high (impact minimal) |
| KM-16 | INFO | `skills-lock.json` (repo root) is a dev-repo artifact for `.agents/skills/` — no product consumer; the product skill store is `${DATA_ROOT}/skills/`. Recorded so a later pass doesn't hunt for a phantom subsystem. | grep: only `FILES.md:22` references it | high |
| KM-17 | INFO | Per-KB wrapper heading (`\n\n---\n# <dir> (knowledge base)\n\n`, ~35 chars) is still uncharged against the shared budget — P13-KM-14 charged only the per-doc headings inside `readKbBody`. Negligible; recorded to prevent re-litigation. | `specialist-run.server.ts:969`; `operator-run.server.ts:1173` | high |

## Verified-fixed since pass 13 (do not re-raise)

P13-KM-01 (dir-keyed KB grants + legacy repair, 2c907cc) · KM-02 (KB reader
warns on missing/empty/unreadable) · KM-03 for **Claude** operators (org MCPs
mount + test) · KM-04 (persona MCP-governance rule + matrix disclosure) · KM-05
(credentialed probes, both transports) · KM-06 (clearCred) · KM-07 for KB/skill
rename + all deletes (**not MCP rename** → KM-01 above) · KM-08 for KB/skill
template counts (**not MCP** → KM-09 above) · KM-09/UI-28 (operator catalog
superset + client filter) · KM-10 (specialist persona KB tests) · KM-11 (MCP
resolution warns) · KM-12 (reserved names refused) · KM-13 (import
refresh-in-place + provenance dotfile) · KM-14 (doc headings charged) · KM-15
(honest refresh copy) · KM-16 (watcher adopts disk-only KBs) · KM-17 run-side
(quote-aware split — probe side → KM-04 above) · KM-18 (clearBody wired) ·
LV-10 (real HTTP handshake) · LV-13/14 (app-owned CODEX_HOME + skills/plugins/
memories/AGENTS.md fence) · LV-15 (naming caveat disclosed) · LV-18 (web egress
capability, Claude both kinds + Codex operator hard-off) · LV-19 (probe client
capabilities) · LV-06 partially (doc creation exists → KM-08 for the rest).
