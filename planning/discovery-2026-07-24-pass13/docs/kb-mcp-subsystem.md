# Pass 13 — Knowledge-base & MCP subsystems, end to end

Verified against `main` @ `c7abebf` on 2026-07-24. Every claim below was read out
of the current source; nothing is carried over from pass-12 prose without
re-reading the file. Where a claim needs a **live** run to confirm, it is marked
`[LIVE]`.

---

## (a) Architecture summary

### Knowledge bases

- **Disk is truth.** A KB is a real folder `${DATA_ROOT}/kb/<dir>/`. SQLite
  (`org_knowledge_bases`) carries only metadata: `name`, `dir`, `refresh`,
  `last_indexed_at`. Listings union the metadata rows with the on-disk folder
  names, so a folder with no row renders under a synthetic `disk:<dir>` id
  (`app/server/org/resources.server.ts:69-133`, `:191-204`).
- **There is no index.** "Re-index" re-scans the tree and moves a *timestamp*;
  the doc count is computed from disk on every read
  (`resources.server.ts:166-186`, `:336-371`). Runs read the folder **live** at
  spawn time — nothing is cached between a re-scan and a run.
- **One canonical reader.** `readKbBody` (`app/server/files/kb-injection.server.ts:125-169`)
  walks the whole tree, matches six text extensions, sorts by relative path,
  bounds the total at `KB_INJECTION_BUDGET = 24_000` chars, and appends an
  honest truncation marker. Symlinks are skipped, cycles guarded, depth capped,
  containment re-checked per directory (`:57-115`).
- **Injection point.** Both runtimes append `\n\n---\n# <dir> (knowledge base)\n\n<body>`
  to the run's *system prompt* — operator at `operator-run.server.ts:1009-1022`,
  specialist at `specialist-run.server.ts:915-927`. The specialist path wraps the
  whole resource block in a trusted-provenance banner (`:928-944`).
- **Live watcher.** `startKbWatcher` (`app/server/files/kb-watch.service.server.ts:44-140`)
  recursive-watches `${DATA_ROOT}/kb`, 250 ms trailing debounce per top-level
  dir, HMR-safe singleton behind `Symbol.for("viberr.kbWatcher")`, clears its
  handle on error and re-arms on transient FS errors. Started from
  `boot.server.ts:146`, surfaced at `/resources/health` as `kbWatcher`
  (`app/routes/resources.health.ts:40`).

### MCP servers

- **Registry.** `org_mcp_servers` rows: `name` (slugified), `transport`
  (`HTTP`|`stdio`), `target`, `cred_ref` (sealed), `tools_count`, `up`,
  `last_checked_at` (`resources.server.ts:402-440`).
- **Honest health.** HTTP → a real GET reachability probe, *any* HTTP response
  counts as up, tool counts are never fabricated (`:646-679`). stdio → a real
  JSON-RPC `initialize` → `notifications/initialized` → `tools/list` handshake
  over the spawned command's stdio with a hard timeout (`:543-639`). HTTP rows
  keep `tools_count = NULL` forever, by design (`:769-776`).
- **Sealed credentials.** AES-256-GCM secret-box (`app/server/secrets/secret-box.server.ts:47-106`).
  Only `hasCred: boolean` reaches a client (`resources.server.ts:410-415`);
  the plaintext is opened exactly once, at run-spawn, by `getMcpCredential`
  (`:450-478`), which degrades to no-auth **with a warning** on a legacy or
  undecryptable value.
- **Two in-process governance MCPs**, both Claude-Agent-SDK `createSdkMcpServer`
  instances with handlers closing over the DB + task context:
  - `viberr` — the **operator's** toolkit (`app/server/tasks/operator-toolkit.server.ts:71-360`).
  - `viberr_agent` — the **specialist's** collaboration toolkit
    (`app/server/tasks/agent-toolkit.server.ts:200-327`).
- **Backend split.** Claude mounts both external and in-process servers
  (`claude-runtime.server.ts:432`). Codex translates only the portable
  HTTP/stdio subset into `--config mcp_servers` and deliberately drops
  credentials to avoid `ps`-visible argv (`codex-runtime.server.ts:69-108`,
  `:161`); `{ type: "sdk" }` servers are skipped, so Codex never gets the
  in-process toolkits.

---

## (b) Verified code map

### 1. KB lifecycle

| Operation | Code | Verified behavior |
|---|---|---|
| create | `resources.server.ts:220-310` | `dir = slugify(name)`; `mkdir -p`; row insert; toast quotes `store://kb/<dir>/` |
| adopt disk-only | `:286-309` | editing a `disk:<dir>` id inserts a row for the same folder, audit `org.kb.updated` + `adopted: true` |
| rename | `:252-266` | recomputes the slug and **moves the folder** (`renameSync`); refuses on row clash *or* an existing target folder |
| delete | `:312-332` | `rmSync` the folder **and** delete by `dir` (so a synthetic id also clears a row) |
| re-index (manual) | `:336-371` | re-scan + timestamp; adopts a disk-only folder so the timestamp sticks |
| re-index (watcher) | `:380-398` | keyed by `dir`, **requires a metadata row**, skips `refresh = "manual"`, never throws |
| traversal guard | `:75-93`, `file-store-root.server.ts:100-119` | `disk:../../x` rejected; `kbDirPath` throws on separators/dot-segments/absolute/NUL |

**Store browser + uploads** (`app/server/org/store-files.server.ts`):
`scanStoreTree` (dirs first, dotfiles skipped, `:56-85`); segment sanitizing and
`assertInsideRoot` on every resolved path (`:91-131`); pre-flight collision
check so a failed upload writes nothing (`:226-244`); `touchResource` adopts a
disk-only resource before bumping freshness (`:142-190`); `mkdir -p`
(`:289-328`); recursive delete with a real count (`:339-366`).

**"Add from GitHub"** (`:403-552`): requires the org's **default** connection
with a validated token (no unauthenticated fallback, `:419-426`), resolves the
default branch, lists the recursive git tree, filters blobs (dot-segments out,
>1 MB out), caps at 100 files, writes under a **collision-suffixed root folder**
(`:487-493`), reports per-blob failures honestly (`:517-542`).

**UI** (`app/features/kb-browser/store-browser.tsx`, `app/features/org-settings/resources-panel.tsx:611-705`):
toolbar wires `store-upload` / `store-mkdir` / `store-delete` /
`store-import-github` intents; all four are admin-gated + CSRF-checked in
`app/routes/org.settings.tsx:99-109`, `:321-382`.

### 2. KB → run wiring

**Operator.** `resolveOperatorAuthority` reads the deployed operator's
`view.resources.kb` into `OperatorAuthority.kb`
(`app/server/tasks/operator-actions.server.ts:69-88`, `:199-200`).
`buildOperatorSystemPrompt` (`operator-run.server.ts:980-1038`) assembles:
shipped/baked definition → optional project persona → each declared skill →
each declared KB → live authority block → non-negotiable rules. KB loop at
`:1014-1022`, `kbBudget` starts at 24 000 and is **shared across all declared
KBs**. Used by **both** backends: Claude at `:835`, Codex at `:568`
(Codex receives it as `developer_instructions`, `codex-runtime.server.ts:141`).

**Specialist.** `toResolved` reads `view.resources.kb` (`specialist-run.server.ts:140`);
`buildSpecialistPersona` (`:888-946`) does the same skill-then-KB assembly with
the same shared 24 k budget (`:919-927`) and adds the trusted-provenance banner
only when at least one resource actually resolved (`:928-944`). Fresh run at
`:616-622`; **resume** re-derives the identical persona at `:1132-1138`.

**Parity: Claude vs Codex — identical for KB.** Both get the same string; the
only difference is the channel (Claude `systemPrompt` appended to the
`claude_code` preset for specialists / replacing it for the operator,
`claude-runtime.server.ts:421-431`; Codex `developer_instructions`).

**Missing / empty KB.** `readKbBody` returns `""` when the folder is absent
(`kb-injection.server.ts:130`) or when it contains no text docs — the heading is
then never emitted and **nothing is logged**. Contrast `readSkillBody`, which
warns twice (`app/server/files/skill-body.server.ts:16-28`). See finding 2.

### 3. MCP lifecycle

- `saveMcpServer` (`:681-802`): slugified name, uniqueness check, blank cred on
  edit keeps the sealed value, stdio → discovery (stores the real count or
  `up=0`/`NULL`), HTTP → probe (always clears `tools_count`), audit
  `org.mcp.added|updated`.
- `testMcpServer` (`:804-852`): same split; stdio re-discovers, HTTP re-probes.
- `deleteMcpServer` (`:854-870`): row only — no reference cleanup.
- `discoverStdioMcpTools` (`:543-639`): spawn is injectable for tests, never
  throws, never hangs, kills the child on settle, tolerates partial lines.
- `probeMcpTarget` (`:646-679`): rejects non-http(s), 2.5 s `AbortSignal.timeout`,
  cancels the SSE body, classifies timeout vs refused.
- Staleness is a **UI-side** notion only: `MCP_HEALTH_STALE_MS = 1 h`
  (`resources-panel.tsx:37-40`) turns an old green dot amber with
  "stale, retest" (`:737-771`). Nothing re-probes in the background.

### 4. MCP → run wiring

**`viberr` (operator, in-process)** — `operator-toolkit.server.ts:71-360`.
Tools, each gated by `gate(authority, <capabilityId>)`:

| Tool | Gate |
|---|---|
| `get_task` | always (read-only) |
| `post_comment`, `set_goal` | `append-typed-events` |
| `open_decision_packet`, `resolve_decision_packet` | `generate-packets` |
| `engage_agent`, `run_agent`, `prompt_agent` | `assign-primary-specialist` **or** `summon-reviewers` |
| `transition_stage` | `stage-transitions` |
| `accept_completion` | `completion-for-acceptance` (never promoted by full autonomy — `operator-actions.server.ts:214-220`) |

A denied capability's tool is **not built**, and `allowedTools` is the exact
`mcp__viberr__*` list (`:79-82`, `:359`), applied at `operator-run.server.ts:865`.

**`viberr_agent` (specialist, in-process)** — `agent-toolkit.server.ts:200-327`.
`post_comment` ← `comment-on-task`, `ask_human` ← `ask-human`,
`report_outcome` ← `report-validation-verdict`, all resolved by
`resolveAgentCollab` (`agent-outcome.server.ts:280-289`). Returns **null** when
no grant applies, so no server is mounted at all (`:317`).

**External org MCPs** — `specialist-mcp.server.ts:32-69`. Name → registry row →
`{ type:"http", url, headers.Authorization }` or `{ command, args, env.MCP_CREDENTIAL }`.
`viberr` is skipped; unknown names are skipped. Merged with the toolkit at
`specialist-run.server.ts:741-757` (toolkit spread **last**) and passed at `:781-783`.

**Backend matrix (verified):**

| | Claude | Codex |
|---|---|---|
| Operator governance | `viberr` in-process MCP + `allowedTools` confinement (`operator-run.server.ts:836-865`) | **no MCP at all**; structured `OPERATOR_PLAN_SCHEMA` output parsed and executed server-side through the same gates (`:559-628`, `:644-700`) |
| Specialist collaboration | `viberr_agent` in-process MCP | outcome envelope via `outputSchema` (`specialist-run.server.ts:758-759`, `:1164-1168`) |
| Declared org MCPs | mounted verbatim, credentials attached | translated to `mcp_servers` with `default_tools_approval_mode:"approve"`, **credentials dropped by design** (`codex-runtime.server.ts:74-82`) |
| Ambient tooling | `settingSources/skills/plugins: []` + `BASE_DENIED_BUILTINS` (`claude-runtime.server.ts:177-205`, `:402-404`) | `features.apps:false`, `memories.*:false`, `allow_login_shell:false` (`codex-runtime.server.ts:144-157`) |

### 5. Referential integrity

References live as **slugs** in agent-profile frontmatter `resources.{kb,skills,mcps}`
(`app/schemas/…` via `agent-profile-file.server.ts`; read at
`agents-query.server.ts:78-80`, `:240-243`; written at
`gagents.server.ts:159-163`, `:177` and `agent-profile-actions.server.ts:262`, `:356`).

Verified: **nothing rewrites and nothing validates them.**

- KB rename moves the folder only (`resources.server.ts:252-266`).
- Skill rename moves the folder only (`:1046-1056`).
- MCP rename updates the row only (`:762-776`).
- Delete removes folder/row only (`:312-332`, `:854-870`, `:1106-1129`).
- The profile-save zod schema accepts any `string[]`
  (`agent-profile-actions.server.ts:81-88`).

Dangling references surface in exactly **one** place: the create/edit profile
modal renders ids the live catalog no longer offers as red, removable `missing`
chips (`create-profile-modal.tsx:604-651`), covered by
`agents-page.test.tsx:398-436`. They do **not** surface on the agents detail
panel (`agents-page.tsx:125-155`, `:347-349` — plain chips, no missing state),
in org settings, in the run panel, or on the timeline.

Resolution behaviour when dangling: KB → silent `""`; skill → `logger.warn`;
MCP → silent `continue`.

### 6. Test coverage reality

**Covered by real tests**

| Area | File |
|---|---|
| KB create/rename/delete, skill CRUD + E4 body rules, MCP probe/save/test/stdio discovery, disk-is-truth, traversal-id rejection | `app/server/org/resources.server.test.ts` (21 cases) |
| Uploads, traversal/clobber refusal, mkdir/delete, scan order, GitHub import incl. no-connection + partial-failure (E5), disk-only adoption (E6) | `app/server/org/store-files.server.test.ts` (15 cases) |
| `readKbBody`: nested, multi-extension, binary skip, dotfiles, absent folder, budget + truncation marker | `app/server/files/kb-injection.server.test.ts` (9 cases) |
| `kbDirOfChange`, `reindexKnowledgeBaseByDir` (on-change/manual/unknown), live watcher debounce, HMR singleton, `isKbWatcherAlive` | `app/server/files/kb-watch.service.server.test.ts` (8 cases) |
| **Operator** KB injection + missing-KB no-throw | `app/server/runtimes/operator-kb-injection.server.test.ts:28-51` |
| `resolveSpecialistMcpServers` incl. sealed HTTP/stdio credential injection and legacy-cred refusal | `app/server/tasks/specialist-mcp.server.test.ts` (8 cases) |
| Codex `mcp_servers` translation: sdk skipped, malformed args rejected, token never in config | `app/server/runtimes/codex-runtime.server.test.ts:220-290` |
| Resource catalog incl. E7 row-without-folder and F7-RES3 `viberr` exclusion | `app/server/org/resource-catalog.server.test.ts` (5 cases) |
| `viberr_agent` audit attribution | `app/server/tasks/agent-toolkit.server.test.ts` (2 cases) |
| org.settings intents: kb-reindex, store-mkdir/upload, github import failure | `app/features/org-settings/org-settings-route.server.test.ts:234-300` |
| Dangling grant chips in the profile modal | `app/features/agents/agents-page.test.tsx:398-436` |

**Untested (verified by grep — no test file references these paths)**

- **Specialist** KB injection. `buildSpecialistPersona` is exercised only for
  *skills* (`app/server/seed/base-agents.server.test.ts:121-156`);
  `specialist-run.server.test.ts` contains no `kb` reference at all.
- The shared cross-KB budget in either runtime (only the single-KB budget inside
  `readKbBody` is tested).
- KB injection on the **resume** path (`specialist-run.server.ts:1132-1138`).
- The org-settings agent-profile modal's resource selection
  (`resources-panel.tsx:355-588`) — no test asserts *which token* is persisted.
- Operator `resources.mcps` (nothing to test — see finding 3).
- MCP credential *lifecycle* beyond injection (no clear path exists).
- `mcp__*` interaction with capability grants (see finding 4).
- Any assertion that a *renamed* KB/skill/MCP leaves references consistent.

---

## (c) FINDINGS CANDIDATES

### 1. HIGH — Org-settings agent modal persists KB **display names**; runs resolve KB by **dir**

**Where:** `app/features/org-settings/resources-panel.tsx:372`, `:397-399`,
`:441`, `:565-575` — the chips are keyed and toggled on `k.name`.
Runs resolve at `app/server/files/kb-injection.server.ts:131` →
`kbDirPath(name)` → `${DATA_ROOT}/kb/<name>`. The catalog on the other surface
correctly offers `dir` (`app/server/org/resource-catalog.server.ts:42-47`, `:77`).

**Why it is wrong:** `dir = slugify(name)` (`resources.server.ts:222`), so for
any KB whose display name is not already slug-shaped the two differ. The
frontmatter then holds a string that resolves to a non-existent folder. (This is
masked for *disk-only* KBs, where `buildKb` sets `name = dir`,
`resources.server.ts:174` — which is exactly why nobody has caught it.)

**Failure scenario:** Admin creates KB "Architecture notes" (`dir:
architecture-notes`), uploads 40 ADRs, opens Settings → Agent resources → edits
the "Developer" base profile, ticks the "Architecture notes" chip, saves. The
row says "40 docs", the profile shows the KB granted, the delete-confirm says
"agents lose it on next context load". **Every run gets zero bytes of it**, with
no log line, no timeline entry and no UI flag. Meanwhile the *project* Agents
editor shows the same grant as a red "No longer in the store" chip, because that
picker is keyed on `dir`.

**Fix:** In `AgentModal`, key the KB chips on `k.dir` and render `k.name` as the
label: `const kbNames = kbs.map(k => k.dir)`, `selKbSet.has(k.dir)`,
`toggle(selKbs, setSelKbs, k.dir)`. Add a route-level test asserting the
persisted `resources.kb` equals the dir. Consider a one-shot migration that
rewrites any `resources.kb` entry matching a known KB `name` to its `dir`.

---

### 2. HIGH — An unresolvable or empty KB injects nothing, **silently**

**Where:** `app/server/files/kb-injection.server.ts:130` (`if (!existsSync(dir))
return ""`), `:145-149` (unreadable doc skipped), `:166-168` (bare `catch {
return ""; }`). Callers skip the heading entirely when the body is empty
(`operator-run.server.ts:1018`, `specialist-run.server.ts:923`).

**Why it is wrong:** The equivalent skill path warns twice —
`app/server/files/skill-body.server.ts:19-28` — precisely because a silently
dropped resource means "the agent ran without craft it was configured to have
and nobody noticed". KB has strictly higher blast radius (it can be the entire
domain context) and is the *only* one of the three resource kinds with no
diagnostic at all. `file-store-root.server.ts:96-99` even documents that "the
injection readers catch it and degrade to 'inject nothing' **while logging the
denial**" — the KB reader does not log.

**Failure scenario:** Any of findings 1, 7 or a plain typo. The task looks
normal, the agent produces generically-correct but context-blind work, and the
only evidence is absence.

**Fix:** Mirror `readSkillBody`: `logger.warn("declared knowledge base not
found on disk — run proceeds WITHOUT it", { kb: name })` for the missing-folder
branch, a second warn for the empty-result branch, and a third in the `catch`
(which is also the traversal-denial path). Ideally surface a run-evidence line
too, so it is visible without shell access to the logs.

---

### 3. HIGH — The operator's declared `resources.mcps` reach **no** run, on either backend

**Where:** `OperatorAuthority` carries `skills` and `kb` but **no `mcps` field**
(`app/server/tasks/operator-actions.server.ts:69-88`; unset in both the
no-deployment default `:157-168` and the resolved path `:196-205`). The Claude
operator passes only `toolkit.mcpServers` (`operator-run.server.ts:864`); the
Codex operator passes no `mcpServers` at all (`:577-594`). Meanwhile
`buildResourceCatalog` offers **every** org MCP row to an operator-scoped
catalog (`app/server/org/resource-catalog.server.ts:49-58`), and the operator
template ships `mcps: [viberr]` (`app/server/seed/assets/operator.profile.md:19-27`).

**Why it is wrong:** This is the same class of defect the codebase already fixed
for specialists (`specialist-mcp.server.ts:6-7`: *"The MCP leg was decorative —
a profile's `resources.mcps` reached no run"*). It was fixed for specialists and
left unfixed for the operator, while the UI continues to offer the grant.

**Failure scenario:** Admin adds a Jira MCP, attaches it to the Operator profile
expecting the coordinator to read ticket context before drafting a goal. The
grant persists, renders as a chip, and does nothing. The operator either says it
has no such tool or invents the content. On Claude it is doubly dead —
`allowedTools` is the exact `mcp__viberr__*` list (`operator-run.server.ts:865`),
so even a mounted server's tools would be outside the allowlist.

**Fix (decide, then make it honest either way):** (a) thread `mcps` through
`OperatorAuthority`, resolve with `resolveSpecialistMcpServers` (dropping the
`viberr` skip for this caller), merge into `mcpServers`, and extend
`allowedTools` with `mcp__<name>__*` for each declared server — noting Codex
operators would still get them only if `mcpServers` is passed at `:577-594`; or
(b) if operators are deliberately toolkit-only, remove MCPs from the
operator-scoped catalog and say so in the UI.

---

### 4. MED-HIGH — Org MCP tools are entirely outside the capability policy

**Where:** `app/server/tasks/specialist-tool-policy.ts:30-60` — every deny rule
is a `Bash(...)`/`Edit`/`Write` specifier; there is no `mcp__*` rule.
`SUPPORTING_DENIED_BUILTINS` (`claude-runtime.server.ts:136-149`) is likewise
Bash/file-tool only. Declared MCPs are merged in unconditionally
(`specialist-run.server.ts:754-757`) and Codex marks every one
`default_tools_approval_mode: "approve"` (`codex-runtime.server.ts:86`, `:102`).

**Why it is wrong:** The product's central promise is that "a specialist whose
capability is withheld genuinely cannot invoke the withheld command — real
enforcement, not guidance" (`specialist-tool-policy.ts:12-15`), and that a
supporting engagement "is NOT the delivering agent and must be physically unable
to mutate the shared workspace or reach the remote"
(`claude-runtime.server.ts:126-129`). An MCP is a first-class alternate channel
to exactly those actions, and it bypasses both lists.

**Failure scenario:** Admin attaches a GitHub MCP to the Reviewer profile so it
can read PR comments. The reviewer is engaged as a supporting agent
(`kind: "reviewer"` → `SUPPORTING_DENIED_BUILTINS`, `merge-pull-request` is
`ALWAYS_HUMAN`). Nothing stops it from calling `mcp__github__merge_pull_request`.
The VIB-30 class this deny-list was written to close reopens through a channel
the policy never sees.

**Fix:** Derive per-server MCP denies from grants — at minimum, for
`kind: "reviewer"` runs deny every `mcp__*` except `mcp__viberr_agent__*`; and
for withheld `merge-pull-request` / `open-review-pr` / `commit-push-branch`,
add `mcp__<server>__*` denies for each declared server (blunt but honest) or an
explicit per-server tool allowlist captured at save time from
`discoverStdioMcpTools`. Whichever is chosen, the org-settings MCP row should
state that its tools are outside the capability matrix.

---

### 5. MED — stdio tool discovery never passes the configured credential, so credentialed stdio servers report "unreachable"

**Where:** `defaultSpawn` (`resources.server.ts:526-529`) calls
`spawn(command, args, { stdio })` with **no `env`**; `discoverStdioMcpTools`
(`:543-639`) is invoked from `saveMcpServer` (`:732-743`) and `testMcpServer`
(`:814-834`) *after* the credential has been sealed (`:697-711`) but never
receives it. At run time `resolveSpecialistMcpServers` **does** pass it
(`specialist-mcp.server.ts:55-59`). The HTTP probe likewise sends no
`Authorization` header (`resources.server.ts:664-668`), though "any response =
up" mostly absorbs that.

**Why it is wrong:** Health status and run behaviour disagree for the exact
configuration the credential feature exists to support.

**Failure scenario:** Admin adds `npx -y @acme/mcp-server` with an API key. Save
returns *"acme saved — command didn't respond (exited before responding); check
it"* and the row shows a red dot with `0` tools and `auth: configured`. The
admin removes the server or churns on the command line; had they granted it, it
would have worked perfectly in a Claude run.

**Fix:** Thread the opened credential into discovery:
`spawnImpl(cmd, args, { env: { ...process.env, MCP_CREDENTIAL: cred } })`
(widen `McpSpawn`), and send `Authorization: Bearer …` on the HTTP probe.
Extend `specialist-mcp.server.test.ts`-style coverage to the discovery path.

---

### 6. MED — An MCP credential can never be removed

**Where:** `resources.server.ts:697-711` — a blank field on edit *keeps* the
existing sealed value; there is no `clearCred` input. The modal offers only a
password field with "leave blank to keep it" (`resources-panel.tsx:222-247`) and
the route has no clearing intent (`app/routes/org.settings.tsx:264-281`).
`deleteMcpServer` (`:854-870`) is the only way to drop a cred_ref.

**Why it is wrong:** Once set, the token is attached to *every* Claude run using
that server, forever, including after the target is repointed.

**Failure scenario:** Admin configures an authenticated internal MCP, later
repoints the same row at a public/self-hosted endpoint. The stale internal
bearer token is now sent to the new host on every specialist run, with no UI
affordance to stop it short of deleting the server (which silently dangles every
profile referencing it — finding 7).

**Fix:** Add a "Remove credential" control that submits `clearCred=1`; in
`saveMcpServer`, `cred = null` when the flag is present. Consider auto-clearing
when `target`'s origin changes.

---

### 7. MED — Renaming or deleting a KB / skill / MCP never rewrites or validates the slug references

**Where:** KB rename `resources.server.ts:252-266`; skill rename `:1046-1056`;
MCP rename `:762-776`; deletes `:312-332`, `:854-870`, `:1106-1129`. References
live in `agents/profiles/<id>.md` frontmatter and in each project's
`agent_policy_json` deployment `definition.resources`. No code path reads either
during a resource mutation. The profile-save schema accepts arbitrary strings
(`agent-profile-actions.server.ts:81-88`); `gagents.server.ts:177` merges
whatever the form sent.

**Why it is wrong:** A rename is presented as a safe operation (it even *moves
the folder* to keep content intact), yet it silently severs every grant. The
delete-confirm copy at `resources-panel.tsx:1120-1125` ("Profiles referencing it
simply stop loading it — nothing else breaks") is accurate but reaches the admin
with **no count** of what is affected (finding 8).

**Failure scenario:** Admin renames "api-contracts" → "api-specs" for tidiness.
Two base profiles and four project deployments keep `api-contracts`. Every
subsequent run loses the KB. Nothing logs it (finding 2), the agents detail
panel still renders the chip (`agents-page.tsx:347-349`), and the only signal is
a red chip inside a modal nobody reopens.

**Fix:** On rename, either (a) rewrite `resources.{kb,skills,mcps}` across
`agents/profiles/*.md` and every project deployment inside the same mutation and
report `"renamed — updated N profile references"`, or (b) refuse the rename while
referenced and tell the admin where. At minimum, show the reference count in the
rename/delete confirm.

---

### 8. MED — "used by N profiles" is computed against the wrong key for KBs, ignores project deployments, and does not exist for MCPs

**Where:** `resources-panel.tsx:993-994`
(`gagents.filter(a => a[key].includes(id) || a[key].includes(name))`) — for KBs
the stored reference is the **dir**, and neither `kb.id` (`kb_…`/`disk:…`) nor
`kb.name` is passed (`:656-657` calls `usedBy(kb.id, kb.name)`; `kb.dir` is
available and unused). `gagents` is *global templates only*
(`gagents.server.ts:117-133`) — project deployments carry their own
`definition.resources` override (`agents-query.server.ts:240-243`) and are never
counted. `McpPanel` receives no `usedBy` prop at all (`:1027-1037`).

**Why it is wrong:** The one guardrail an admin has before deleting a shared
resource is wrong in three independent ways.

**Failure scenario:** KB "Architecture notes" is granted to three profiles; the
row shows no "3 profiles" suffix (name ≠ dir), so it reads as unused and gets
deleted. Same for any MCP, which has no indicator whatsoever.

**Fix:** Pass `kb.dir`; count over global templates **plus** every project
deployment's effective resources; add a `usedBy` indicator to `McpPanel`; and
render the count in the delete confirm, not just the row.

---

### 9. MED — Editing the operator profile shows its real `viberr` toolkit grant as a red "missing — click to remove" chip

**Where:** `app/routes/project.agents.tsx:55-57` builds the catalog with
`profileKind: "specialist"` **unconditionally**, and
`app/features/agents/agents-page.tsx:809-832` hands that same catalog to the
create *and* the edit modal, including for the operator. The specialist catalog
deliberately excludes `viberr` (`resource-catalog.server.ts:50-56`), while the
shipped operator template declares `mcps: [viberr]`
(`app/server/seed/assets/operator.profile.md:19-27`). The modal therefore renders
it as `missing` with the tooltip "No longer in the store — click to remove this
grant" (`create-profile-modal.tsx:604-651`).

**Why it is wrong:** Two-way dishonesty. The chip claims the governance toolkit
is gone when it is always mounted, and removing it changes nothing — the toolkit
is built unconditionally at `operator-run.server.ts:836-842`, so the grant is
decorative in the first place.

**Failure scenario:** Admin opens the Operator in project → Agents to widen its
stages, sees a red "viberr / no longer in the store" chip, concludes the
governance server is broken, and either removes the grant (no effect, but now
the frontmatter disagrees with the shipped template) or files it as a bug.

**Fix:** Pass `profileKind` derived from the profile being edited, and either
make the `viberr` grant load-bearing (see finding 3) or drop it from the template
and the catalog so nothing decorative is offered.

---

### 10. MED — Specialist KB injection has zero test coverage

**Where:** `buildSpecialistPersona` is exercised only for skills
(`app/server/seed/base-agents.server.test.ts:121-156`);
`app/server/tasks/specialist-run.server.test.ts` never mentions `kb`; the
resume path (`specialist-run.server.ts:1132-1138`) and the cross-KB budget
(`:919-927`) are untested. The **operator** side is covered
(`operator-kb-injection.server.test.ts:28-51`).

**Why it is wrong:** The specialist path is the one that ships domain context to
the agents that actually do the work, and it is the half of the F6/FR9 fix with
no regression guard. Given findings 1 and 2, a break here is invisible in
production *and* in CI.

**Fix:** Add specialist-side mirrors of the operator KB tests: injects declared
KB content under the right heading; injects nothing (no throw) for an unresolved
KB; the trusted-provenance banner appears only when something resolved; the
budget is shared across two KBs; the resume path produces the same persona.

---

### 11. MED — Unresolvable MCP names are dropped silently

**Where:** `app/server/tasks/specialist-mcp.server.ts:48-49`
(`if (!row || !row.target) continue;`) — no log. Same for the `viberr` skip at
`:47`. Contrast the credential path, which *does* warn on both failure modes
(`resources.server.ts:463-477`).

**Why it is wrong:** The MCP twin of finding 2. After a rename or delete
(finding 7) an agent runs without the tools it was configured with, and there is
no way to tell from the run panel, timeline, or logs.

**Failure scenario:** Agent is asked to "check the incident in Sentry", has no
`mcp__sentry__*` tools, improvises from the repo, and reports confidently.

**Fix:** `logger.warn("declared MCP server not found in the registry — run
proceeds WITHOUT it", { mcp: name })`, plus a run-evidence line so it is visible
in the UI.

---

### 12. LOW-MED — Reserved in-process server names are not reserved at save time, and collide backend-asymmetrically

**Where:** `saveMcpServer` validates only uniqueness (`resources.server.ts:719-722`);
`resolveSpecialistMcpServers` skips `viberr` but **not** `viberr_agent`
(`specialist-mcp.server.ts:47`); the merge spreads the toolkit last
(`specialist-run.server.ts:754-757`).

**Why it is wrong:** An org MCP named `viberr_agent` is silently shadowed on
Claude (toolkit wins) but **does** mount on Codex (no toolkit is built there,
`:742-753`), so the same profile behaves differently per backend. An org MCP
named `viberr` saves and probes green, is offered in the operator catalog
(dedup makes it indistinguishable from the reserved toolkit), and resolves to
nothing anywhere.

**Failure scenario:** Admin names their internal server `viberr`; it shows a
green dot and 12 discovered tools in org settings; no agent can ever use it.

**Fix:** Refuse `viberr` and `viberr_agent` (and any `viberr_*` prefix) in
`saveMcpServer` with a typed validation error; add `viberr_agent` to the skip
list defensively.

---

### 13. LOW-MED — Re-importing the same GitHub source duplicates KB content instead of refreshing it

**Where:** `app/server/org/store-files.server.ts:487-493` — the destination
folder is collision-suffixed (`docs`, `docs-2`, `docs-3`…). `readKbBody` walks
the whole tree (`kb-injection.server.ts:57-115`), so every copy is injected.

**Why it is wrong:** "Add from GitHub" is the natural way to refresh a snapshot
(the toast even says "snapshot, not a live sync",
`store-files.server.ts:550`), but re-running it doubles the KB rather than
updating it, and there is no in-product way to notice.

**Failure scenario:** Admin re-imports `owner/repo/tree/main/docs` monthly. After
three months the KB holds three near-identical copies; the 24 k budget is
consumed by the alphabetically-first copies (`docs/…` sorts before `docs-2/…`),
so the agent may be reading the *oldest* snapshot while the truncation marker
says docs were omitted.

**Fix:** Offer replace-in-place when the base folder already exists (delete +
rewrite inside one operation), or at minimum name the new folder in a
confirm-style toast: *"imported into docs-3/ — the previous snapshot in docs/ is
still attached"*.

---

### 14. LOW — The 24 k KB budget bounds document text only; per-doc headings are unbounded overhead

**Where:** `kb-injection.server.ts:150-153` decrements the budget by
`slice.length` but pushes `` `### ${doc.rel}\n\n${slice}` ``. Callers then
subtract the *returned* length (`operator-run.server.ts:1020`,
`specialist-run.server.ts:925`), which self-corrects for KBs 2..N — but the
first KB alone can exceed the cap.

**Why it is wrong:** The comment at `:45` calls it a "per-run character budget
across ALL of a KB's docs"; it is really a budget across doc *bodies*.

**Failure scenario:** A KB of 800 small `.md` files with deep paths adds roughly
25-40 chars of heading each — 20-30 k of pure headings on top of 24 k of
content, ~2× the intended prompt cost, with no truncation marker (nothing was
omitted).

**Fix:** Charge the heading against the budget:
`const chunk = \`### ${doc.rel}\n\n\`; budget -= chunk.length + slice.length`.

---

### 15. LOW — `refresh: "on change" | "manual"` does not control what an agent sees

**Where:** Runs always read the folder live at spawn
(`kb-injection.server.ts:125-169`); `refresh` gates only whether the watcher
moves `last_indexed_at` (`resources.server.ts:388-389`,
`kb-watch.service.server.ts:62-78`). The re-index itself computes a count that is
returned to a log line and thrown away (`resources.server.ts:396-397`).

**Why it is wrong:** The modal presents the toggle as a freshness control
("**On change** re-scans … automatically whenever a file in the folder changes;
**manual** only re-scans when you click re-scan",
`resources-panel.tsx:113-119`). The adjacent def-note *does* say "Agents always
read the live folder at run time", so this is disclosed rather than false — but
a reader can easily conclude "manual" pins the content an agent receives.

**Failure scenario:** Admin sets a KB to "manual" while mid-edit, expecting runs
to keep seeing the last-scanned state. Half-written docs go straight into the
next run's system prompt.

**Fix:** Rename the control to what it is (e.g. "Doc-count refresh") or make
"manual" actually pin a snapshot. The former is a one-line copy change.

---

### 16. LOW — Disk-only KBs are never watcher-re-indexed

**Where:** `reindexKnowledgeBaseByDir` returns `null` when no metadata row exists
(`resources.server.ts:386-388`), and `buildKb` reports `lastIndexedAt: null` for
a rowless folder (`:181`).

**Why it is wrong:** A KB folder created outside Viberr (the flagship
disk-is-truth story) shows "re-scanned **never**" indefinitely, even as files
change, until someone clicks re-scan — which adopts it. Purely cosmetic given
finding 15, but it undercuts the disk-is-truth claim in the one place it is
displayed.

**Fix:** Have the watcher adopt-on-first-change the way `touchResource` does
(`store-files.server.ts:155-170`), or render "not tracked" rather than "never".

---

### 17. LOW — stdio `target` is whitespace-split with no quoting support

**Where:** `resources.server.ts:547` (discovery) and
`specialist-mcp.server.ts:52-53` (run). Both use `.trim().split(/\s+/)`.

**Why it is wrong:** Consistent between the two paths (so health matches
runtime), but any argument containing a space — a path, a JSON blob, a quoted
flag value — is silently split into several argv entries.

**Failure scenario:** `node /Users/My Documents/mcp/server.js` becomes four
arguments; the server never starts; the error surfaces as "exited before
responding" with no hint about quoting.

**Fix:** Use a small POSIX-ish tokenizer honouring single/double quotes, or add
an explicit `args` field to the MCP row.

---

### 18. LOW — The E4 `clearBody` escape hatch is unreachable from the UI

**Where:** `saveSkill` accepts `clearBody` (`resources.server.ts:992-996`,
`:1034`) but the route never sends it (`app/routes/org.settings.tsx:282-293`)
and the modal has no control for it.

**Why it is wrong:** An admin can never empty a `SKILL.md` from the editor —
submitting an empty body always keeps the on-disk content. The guard is correct
(it prevents truncated round-trips destroying a file); it just has no companion
"yes, really clear it" affordance.

**Fix:** Add a "Clear SKILL.md" action in the skill modal that submits
`clearBody=1`, or document that clearing is disk-only.

---

### 19. LOW / informational — `probeMcpTarget` is an unauthenticated server-side fetch of an admin-supplied URL

**Where:** `resources.server.ts:646-679` — protocol is restricted to http(s) and
the timeout is short, but there is no host allowlist and no private-range
rejection. Similarly, `discoverStdioMcpTools` spawns an admin-supplied command
(`:526-529`) — inherent to stdio MCP, and `spawn` without a shell avoids shell
injection.

**Why it is noted, not raised:** the owner has scoped security deep-dives out of
this project. Recording it only so it is not mistaken for an oversight.

---

### 20. LOW — GitHub import always lands at the store root, ignoring the browsed folder

**Where:** `store-files.server.ts:510` writes to
`path.join(target.rootAbs, folder, ...parts)`; the import form carries no `path`
field (`store-browser.tsx:553-562`), unlike uploads/mkdir which are per-folder
drop targets.

**Failure scenario:** Admin navigates into `vendor/` and imports; the snapshot
appears at the KB root instead. Cosmetic, but inconsistent with every other
mutation in the same toolbar.

**Fix:** Pass the current `path` and resolve the collision-suffixed folder
beneath it.

---

## Verified-correct (no finding — recorded so a later pass does not re-litigate)

- Traversal containment is genuinely layered: `diskNameFromId`
  (`resources.server.ts:75-93`), `resolveStoreSegment`
  (`file-store-root.server.ts:100-119`), `sanitizeDirPath`/`cleanRelPath`/
  `assertInsideRoot` (`store-files.server.ts:91-131`), plus symlink-skip, cycle
  guard, depth cap and per-directory re-containment in `collectKbDocs`
  (`kb-injection.server.ts:62-100`).
- Sealed MCP credentials never reach a client: only `hasCred` is projected
  (`resources.server.ts:410-415`), the plaintext is opened at spawn only
  (`:450-478`), and the Codex adapter's deliberate credential drop is both
  documented and test-asserted (`codex-runtime.server.ts:74-82`,
  `codex-runtime.server.test.ts:245-247`).
- MCP tool counts are never fabricated: HTTP rows always clear `tools_count`
  (`resources.server.ts:769-776`), stdio counts come from a real `tools/list`.
- The KB watcher's zombie handling is real: an error clears the cached handle so
  `isKbWatcherAlive()` / `/resources/health` cannot lie, and transient FS errors
  re-arm once (`kb-watch.service.server.ts:104-135`).
- KB injection reaches **both** backends identically (Claude `systemPrompt`,
  Codex `developer_instructions`) on fresh *and* resumed specialist runs.

## Needs a live test `[LIVE]`

- Finding 1 end-to-end: create a KB with a spaced name, grant it via **org
  settings**, run a specialist, and confirm the system prompt contains no
  `(knowledge base)` heading.
- Finding 4: attach a filesystem/GitHub MCP to a supporting reviewer and attempt
  a write/merge through it.
- Finding 5: save a credentialed stdio MCP and compare the org-settings dot with
  an actual Claude run using the same server.
- Recursive `fs.watch` reliability for **newly created** KB subfolders inside
  the Linux/docker container (the unit test covers a pre-existing dir on the
  host).
