# MCP + Knowledge Bases + Skills — subsystem discovery (pass 29)

Scope: how a viberr **agent profile** gets granted knowledge bases (KBs),
external MCP servers, and Claude/Codex skills, and how those grants are
threaded into an actual run's system prompt / workspace. All citations are
`file:line` against the working tree at
`/Users/akinozer/projects/viberr/.claude/worktrees/viberr-app-inspection-e1b87f`.

**Terminology note up front**: the repo-root `skills-lock.json` and
`.claude/skills/` / `.agents/skills/` are **not** part of the viberr
application at all — they are this coding assistant's own dev-tooling
skills (emilkowalski/skills, ponytail, vercel-labs/agent-skills — see
`skills-lock.json:1-49`) used when *working on* the viberr codebase. They
have no runtime relationship to the in-app agent skill system described
below (verified: nothing under `app/` references `skills-lock.json`; the
only hits are prior `planning/` docs). Do not confuse the two when testing.

---

## 1. Knowledge bases (KBs)

### 1.1 Data model

Metadata lives in SQLite table `org_knowledge_bases` (id, name, dir,
refresh, last_indexed_at); **content is file-native**, real files under
`${DATA_ROOT}/kb/<dir>/`. "Disk is truth": every list/get call scans the
real folder tree and layers the DB row on top when one exists
(`app/server/org/resources.server.ts:44-65`, `:241-272`). A folder that
exists on disk with no row gets a synthetic `disk:<name>` id
(`resources.server.ts:76-100`) and is adopted into a real row the moment
it's touched (edited, re-indexed, or the watcher fires).

```ts
// app/server/org/resources.server.ts:164-188
export interface KbView {
  id: string; name: string; dir: string;
  refresh: KbRefreshMode; lastIndexedAt: string | null;
  tree: StoreNode[]; fileCount: number; injectableCount: number;
  folderExists: boolean; uri: string; // "store://kb/<dir>"
}
```

Refresh has exactly two modes, `"on change"` (default, watcher-driven
re-index) and `"manual"` (`resources.server.ts:160-162`) — but this mode
**only controls the freshness-metadata timestamp**, never what a run
actually reads: a run always walks the live folder
(`resources.server.ts:157-159`, `kb-injection.server.ts:16-35`).

### 1.2 Authoring UI + route

- Route: `/org/settings` (`app/routes.ts:23`), Resources tab, action
  intents `kb-save` / `kb-delete` / `kb-reindex`
  (`app/routes/org.settings.tsx:418-433`).
- File content (add/edit/delete individual docs, upload, GitHub import) is
  handled by the same route's `store-upload` / `store-write-doc` /
  `store-read-doc` / `store-mkdir` / `store-delete` / `store-import-github`
  intents (`org.settings.tsx:567-671`), backed by
  `app/features/kb-browser/store-browser.tsx` and
  `app/server/org/store-files.server.ts`.
- Mutation logic: `saveKnowledgeBase` / `deleteKnowledgeBase` /
  `reindexKnowledgeBase` in `resources.server.ts:282-483`. A rename
  slugifies the new name to a new `dir`, **moves the real folder**
  synchronously with the DB row write (documented "C4" ordering fix,
  `resources.server.ts:311-343`), and refuses on a folder collision.

### 1.3 Granting a KB to a profile

A profile's frontmatter carries `resources.kb: string[]`
(`app/server/files/agent-profile-file.server.ts:61-68`). **Grants are keyed
by the store `dir` (slug), not the display name** — this was itself a fixed
bug (P13-KM-01): the create/edit-agent picker used to key on display name,
so granting "P13 facts" wrote `kb: ["P13 facts"]` and every run silently
read zero bytes. The picker now writes `dir`, and self-heals an old
display-name grant on open (`app/features/org-settings/agent-template-modal.tsx:26-47`,
same repair logic in the per-project profile modal).

Two grant sites exist and must stay in sync:
- **Global agent templates**: `${DATA_ROOT}/agents/profiles/<id>.md`
  frontmatter (`app/server/org/gagents.server.ts:1-35`; seeded defaults in
  `app/server/seed/agent-catalog.server.ts:90-141`, e.g. operator →
  `kb: ["architecture-notes"]`, developer →
  `kb: ["architecture-notes","api-contracts"]`).
- **Per-project deployments**: `project.md` → `agents[].definition.resources.kb`,
  a full snapshot copy (`app/server/org/resource-references.server.ts:134-140`).

**Rename/delete propagation** (P13-KM-07): `updateResourceReferences("kb", …)`
rewrites every template file and every project.md that references the old
dir (or drops the entry on delete) — `resources.server.ts:345-352` (rename)
and `:413-415` (delete), implemented in
`app/server/org/resource-references.server.ts:48-90` (templates) and
`:141-185` (projects). It is **best-effort per file**: a single malformed
profile/project.md is skipped with a `logger.warn`
(`resource-references.server.ts:122-129`, `:175-182`) and does not block
the rename — so a corrupt file can still be left holding a stale grant.
Grant lists are de-duped as sets during rewrite (`nextList`,
`resource-references.server.ts:78-90`).

The org-settings resource-delete confirmation only counted *template*
grants until pass 23; `countProjectDeploymentGrants`
(`resource-references.server.ts:195-217`) now also surfaces *project*
grants so a delete-confirm dialog can't claim "nothing uses this" while a
deployed project still does.

### 1.4 Injection into a run

One canonical reader, `app/server/files/kb-injection.server.ts`, used by
**both** the operator and specialist runtimes (comment block
`kb-injection.server.ts:13-35`):

- `readKbBodyDetailed(name, dataRoot, budgetChars)` — walks the *whole*
  tree (not just top level), matches every `STORE_TEXT_EXTENSIONS`
  extension, refuses symlinked KB folders/files/ancestors
  (`kb-injection.server.ts:78-130`, `:190-198`), and returns `{ body,
  unresolved? }`. A KB with no folder, an empty folder, or unreadable docs
  all resolve to `body: ""` plus a structured `unresolved: {name, reason}`
  (`:170-278`) — **never silent**, contra the pre-fix behavior.
- `readKbBodies(names, dataRoot, budgetChars)` — one **shared** budget
  (`KB_INJECTION_BUDGET = 24_000` chars, `kb-injection.server.ts:64`)
  across every declared KB for the run, so N KBs cannot each independently
  contribute 24k. A KB squeezed out entirely by earlier ones still emits an
  explicit `_(knowledge base omitted entirely — …)_` marker
  (`:236-255`, P14-KM-05) instead of vanishing.
- `KB_PRECEDENCE_NOTE` (`kb-injection.server.ts:343-353`) — the fixed
  "repo wins over KB when they conflict" rule, pushed once, before the KB
  bodies, and only when real KB text is present. Imported identically by
  both runtimes so the rule can't drift (ruling R19-2).

Consumers: `buildSpecialistPersona`
(`app/server/tasks/specialist-run.server.ts:1966-2036`) and
`buildOperatorSystemPrompt` (`app/server/runtimes/operator-run.server.ts:2855-2874`).
There is **no separate "file mount" path for KBs** — content is always
prompt-text injected (unlike skills, see §3), for both backends and both
agent kinds.

### 1.5 How a run "proves" it loaded a KB

Two independent signals:

1. **Structural disclosure** — the run's "Inputs" panel renders a
   `knowledge` row listing every KB name whose body actually landed
   (`app/features/runtime/runs-helpers.ts:190-193`), and a separate
   `missing` row when a granted KB's content did **not** reach the run
   (`runs-helpers.ts:212-218`, backed by `unresolvedResources` on
   `RunInputsView`, `app/features/runtime/runtime-types.ts:144`). This is
   populated end-to-end from `buildSpecialistPersona`'s `unresolvedOut`
   out-param (`specialist-run.server.ts:1956-1962`, `:2168-2176`).
2. **Content proof** — because the KB text is literally concatenated into
   the system prompt under a `### <doc path>` heading
   (`kb-injection.server.ts:225-234`), a unique marker string seeded into a
   KB doc will appear verbatim in the run's own transcript/output if the
   agent reads and echoes it back. (Prior passes used exactly this: pass 28
   seeded a token and had an agent write it back verbatim — see
   `MEMORY.md` note "wrote seeded token `ZEBRA-42-QUOKKA` verbatim".)

---

## 2. MCP servers

### 2.1 Data model

Table `org_mcp_servers`: id, name, transport (`HTTP`|`stdio`), target
(URL or shell command), `cred_ref` (sealed secret box or null),
`tools_count`, `up`, `last_checked_at`, `last_error`, `warming_since`,
`first_success_at`, `heuristic_warmups`
(`app/server/org/resources.server.ts:592-627`). No file-native content —
this is a pure registry row.

### 2.2 Credential storage + scrubbing

- **At rest**: sealed with AES-256-GCM via
  `app/server/secrets/secret-box.server.ts` — format
  `v1$<iv>$<ciphertext>$<tag>` (`secret-box.server.ts:15-21`), keyed by
  `VIBERR_SECRET_ENCRYPTION_KEY`. Plaintext is **never** stored or
  returned to the UI; only a `hasCred` boolean is exposed
  (`resources.server.ts:539-543`).
- **Key rotation** is a real, lazy mechanism: `openSecretRotating` tries
  the current key then each key in `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`
  (`secret-box.server.ts:88-107`); a box opened under a retired key is
  re-sealed under the current one on the spot
  (`resources.server.ts:688-707`, "A9" in the comments).
- **Unopenable credential ≠ silent anonymous connect** (A9 fix): if a
  configured credential can't be decrypted, the server is refused for
  mounting and the reason surfaces to the run and the Settings row
  (`resources.server.ts:642-724`; `getMcpCredentialState`,
  `openMcpCredential`). The old behavior downgraded silently to
  unauthenticated.
- **Scrubbing from logs/errors**: `redactGitOutput`
  (`app/server/secrets/git-output-redact.server.ts:76-113`) removes the
  known token BY VALUE first (any length — F20-7 closed a 5-char leak
  window), then URL-userinfo, then known token patterns
  (`git-output-redact.server.ts:39-56`), then strips ANSI/control bytes
  and clamps to the tail. Applied to stdio probe stderr
  (`resources.server.ts:1019-1026`) so a crashing MCP server that dumps
  its env cannot leak `MCP_CREDENTIAL` into a toast or `last_error`.
- Save-time guard: `input.cred` shorter than 8 chars is rejected outright
  unless it's already a sealed box (`resources.server.ts:1446-1457`, F20-7).

### 2.3 Attaching to a profile

Same shape as KBs: `resources.mcps: string[]`, grants by server **name**
(the registry's unique slug, `agent-profile-file.server.ts:64`). Renaming
a server rewrites references the same way (`resources.server.ts:1576-1584`,
`updateResourceReferences("mcps", …)`); deleting drops them
(`resources.server.ts:1726-1727`).

**Reserved names**: `viberr`, `viberr_agent`/`viberr-agent`,
`viberr_browser`/`viberr-browser` are refused at save
(`resources.server.ts:1474-1478`, `isReservedMcpName` at
`:1289-1297`) and are never shown in the grant picker
(`app/server/org/resource-catalog.server.ts:56-67`) — these are viberr's
own in-process governance/toolkit/browser servers, mounted unconditionally
and never resolved from the registry, so a row under one of these names
would be a dead grant (the exact "silent-resource" class this pass is
watching for).

### 2.4 Launching for a run

`app/server/tasks/specialist-mcp.server.ts`:
`resolveSpecialistMcpServersDetailed(db, mcpNames)`
(`specialist-mcp.server.ts:120-220`) turns each declared name into a
portable config:
- stdio → `{ command, args, env?: { MCP_CREDENTIAL } }`
- HTTP → `{ type: "http", url, headers?: { Authorization: "Bearer …" } }`

The credential is decrypted **only here, at spawn time**
(`specialist-mcp.server.ts:29-34`). **Backend asymmetry (documented, not a
bug)**: on Codex the credential is dropped entirely before serialization
(`codex-runtime.server.ts:160-168`) because Codex's SDK passes MCP config
via `--config key=value` CLI argv, which is `ps`-visible — so a
credentialed org MCP authenticates Claude runs only and connects
unauthenticated on Codex. The agent's own system prompt is told this
(`specialist-run.server.ts:2096-2099`).

**Pre-flight verification** (F20-10): `verifyStdioMcpMountsForRun`
(`specialist-mcp.server.ts:248-333`) re-runs the real JSON-RPC discovery
handshake for every mounted stdio server right before the run starts,
dropping and disclosing any that die at spawn instead of trusting a
health probe that might be hours stale. It carefully avoids corrupting the
shared `org_mcp_servers.up` row when a Codex run's *credential-less*
pre-flight fails but the server is actually healthy for Claude
(`specialist-mcp.server.ts:291-317`, "P9 pass 25").

### 2.5 Claude-hyphen vs Codex-underscore tool names

Directly documented at `app/server/runtimes/codex-runtime.server.ts:137-152`:

> "the two CLIs derive a different tool prefix from the SAME declared
> server name — Claude mounts `mcp__everything-http__echo`, the Codex CLI
> lowercases hyphens to underscores and mounts
> `mcp__everything_http__echo`. Viberr passes the declared name through
> unchanged on both, so a persona/skill/directive that names a tool
> LITERALLY works on one backend and not the other. Nothing here can fix
> that (the transform is inside the codex binary)."

This is an **accepted, disclosed limitation** (referenced back to a
pass-13 report), not something viberr normalizes — a KB/skill that tells
an agent to call a hyphenated tool name will silently fail to match on
Codex.

### 2.6 The in-process browser MCP (R19-19)

A special case, not an org-registry row at all: `viberr_browser`
(`app/server/tasks/specialist-browser-mcp.server.ts:51`) is mounted
per-run only when the profile holds `use-browser: direct` **and**
effective `use-web-search-fetch` is also `direct`
(`specialist-browser-mcp.server.ts:19-33`) — a contradictory pair (browser
granted, web egress revoked) is surfaced as an `UnresolvedMcpGrant`, never
silently resolved either way. Runs Playwright MCP `--isolated`, confined
to the task's `attachments/` output dir.

---

## 3. Skills

### 3.1 Where skills come from

Two sources, unioned in the resource catalog
(`app/server/org/resource-catalog.server.ts:40-67`):
- **Shipped built-ins**: `viberr-app-expertise`, `developer-expertise`,
  `reviewer-expertise` — static assets under
  `app/server/seed/assets/*.skill.md`, copied into
  `${DATA_ROOT}/skills/<name>/SKILL.md` on boot by
  `app/server/seed/default-assets.server.ts:92-105`. A SHA-256
  "shipped-manifest" (`default-assets.server.ts:107-150`,
  `PRIOR_SHIPPED_HASHES`) means an app upgrade only refreshes a store copy
  that's still byte-identical to some hash Viberr has ever shipped — a
  human edit is never clobbered.
- **Org-authored skills**: `org_skills` table + real folders under
  `${DATA_ROOT}/skills/<name>/`, same disk-is-truth pattern as KBs
  (`resources.server.ts:1764-2122`; authored via `/org/settings`
  `skill-save`/`skill-delete` intents, `org.settings.tsx:525-541`, plus the
  store-browser file actions for supporting files).
- Demo seed content (`conventional-commits`, `terraform-review`,
  `api-design`, `changelog-writer`) is written non-destructively by
  `app/server/org/org-seed.server.ts:179-257`, `:342-365`.

**Not** a source: `skills-lock.json` at the repo root — see the
terminology note at the top of this doc.

### 3.2 How the set for an agent/run is decided — no semantic matching

This is a **pure admin-curated allow-list**, not AI-decided relatedness.
A profile's frontmatter carries `resources.skills: string[]`
(exact names) — same grant/rename/delete-propagation machinery as KBs and
MCPs (§1.3, `resource-references.server.ts`). There is no ranking,
embedding, or "pick the top-N relevant skills" step anywhere in the
codebase. Relatedness is enforced purely as **presence in the grant list**.

One documented exception/design-tension: if the **operator's** own
`skills` grant list is empty, it falls back to the shipped
`viberr-app-expertise` skill rather than running with none —
`app/server/runtimes/operator-run.server.ts:2846-2850` ("Design tension
#25: an EMPTY declared list falls back to the shipped expertise skill, so
removing it has no effect"). Specialists have no such fallback
(`buildSpecialistPersona` just gets an empty `skills` array).

### 3.3 The mechanism that keeps UNRELATED skills out (Claude backend)

Two independent layers, both required:

**Layer 1 — workspace mount is grant-scoped, and the repo's own `.claude`
is nuked first.** `app/server/runtimes/skill-mount.server.ts`:
- `stripUngovernedRepoCatalog(repoDir)` (`skill-mount.server.ts:121-167`)
  deletes whatever `.claude` the cloned repo ships (slash-commands,
  settings.json hooks, sub-agents, skills) on *every* run, via
  `git update-index --skip-worktree` first so the deletion never lands in
  the delivered PR diff.
- `mountGrantedSkills({ workspaceDir, skills, dataRoot })`
  (`skill-mount.server.ts:256-302`) strips, then copies **only** the
  profile's granted skill folders into
  `<workspace>/.claude/skills/<name>/`, rewriting each `SKILL.md`'s
  frontmatter down to just `name` + `description`
  (`skill-mount.server.ts:405-433`) — a store skill cannot smuggle
  `allowed-tools`/`model` overrides through its own frontmatter.
  `isSdkSkillName` (`:215-219`) allow-lists the folder-name characters the
  SDK accepts as an exact skill name; anything else is skipped (falls back
  to prompt-text injection) rather than crashing the run.
- Symlinks are refused at every step (`resolveContainedSkillFile`,
  `app/server/files/skill-body.server.ts:82-124`) — a linked skill folder
  or `SKILL.md` cannot smuggle content from outside the store.
- A per-process random `MOUNT_MARK` (`skill-mount.server.ts:96-99`)
  distinguishes a *live concurrent run's* own mounted skills from
  everything else in `.claude`, so a second run's strip cannot delete a
  first run's still-in-use skill folder (F19-15) — but stated as an
  **accepted residual**: a *finished* run's mount is never proactively
  collected, so a stale skill folder can outlive its run inside a shared
  task workspace (`skill-mount.server.ts:84-95`).

**Layer 2 — the SDK query options only ever list exactly the mounted
names.** `app/server/runtimes/claude-runtime.server.ts:264-334`,
`:665-711`:
- `nativeSkillNames(spec.skills)` dedupes and re-validates names
  (`claude-runtime.server.ts:311-314`).
- A run with granted skills passes `settingSources: ['project']` +
  `skills: [<exact mounted names>]` — the SDK's own filter **rejects every
  unlisted skill name**, including its own ~16 first-party bundled skills
  compiled into the SDK binary (empirically verified against a pristine
  Docker deployment, `claude-runtime.server.ts:242-246`).
- A run with **no** granted skills gets `settingSources: []` and
  `skills: []`, but since `skills: []` does **not** actually hide the
  SDK's compiled-in bundled skills, the `Skill` tool itself is added to
  `BASE_DENIED_BUILTINS` (`claude-runtime.server.ts:264-271`) as the fence
  of last resort for that case.
- `claudeMdExcludes` (`claude-runtime.server.ts:332-334`) is applied
  alongside, but explicitly flagged as an **unverified** mitigation for the
  fact that `settingSources: ['project']` also opens the door to the
  checked-out repo's own `CLAUDE.md` loading as system-prompt-tier
  instruction — "treat the ingress as OPEN until someone reads a run's
  system prompt and confirms otherwise."

Because a mounted ("native") skill is not double-fed, `buildSpecialistPersona`
partitions `input.skills` into `native` (SDK-mounted, metadata only + a
short "Attached skills (trusted)" banner naming them,
`specialist-run.server.ts:1989-2009`) vs `injectable` (everything else,
still fed as literal prompt text via `readSkillBodies`,
`specialist-run.server.ts:2010-2018`). *Which* mounted skill the model
actually invokes on a given turn is then the SDK/model's own
description-based judgment (progressive disclosure) — viberr's
contribution to "relatedness" stops at the allow-list; there is no further
in-app ranking of mounted skills against the task.

### 3.4 Codex: no native skill channel at all

`app/server/runtimes/codex-config.server.ts:241-306` deliberately severs
the entire Codex skills channel: `skills: { include_instructions: false,
bundled: { enabled: false } }` — verified with `codex debug prompt-input`
against codex-cli 0.144.6 that near-miss keys (`skills.enabled` etc.) are
inert and that the CLI otherwise **re-installs its own 5 bundled `.system`
skills into any home on every startup** (`imagegen`, `openai-docs`,
`plugin-creator`, `skill-creator`, `skill-installer`,
`codex-config.server.ts:251-255`). Because there is no way to govern which
Codex skill gets used per-grant, viberr doesn't try: every granted skill on
Codex is injected as prompt text via the same shared-budget
`readSkillBodies` (`skill-body.server.ts`) the Claude "injectable" leg
uses, with **no** native mount step at all
(`specialist-run.server.ts:1980-1988`, "BACKEND ASYMMETRY, stated
plainly").

### 3.5 Shared budget + honesty

`app/server/files/skill-body.server.ts`: `SKILL_INJECTION_BUDGET = 24_000`
chars (`:36`) shared across every declared skill in one call
(`readSkillBodies`, `:224-241`) — mirrors the KB budget so N skills cannot
each independently spend 24k. A skill that resolves to nothing (missing
folder, symlink, empty file, budget exhausted) always reports a structured
`{name, reason}` in `unresolved`, never a silent drop
(`skill-body.server.ts:132-199`).

---

## 4. Template library

The only "template" concept found in scope is the **global agent profile
template** layer — there is no separate project-template or
task-template system:

- **Storage**: `${DATA_ROOT}/agents/profiles/<id>.md` (frontmatter: kind,
  backend, capability policy, `resources.{skills,mcps,kb}`, stages, etc. —
  schema in `app/server/files/agent-profile-file.server.ts:19-91`).
- **Authoring UI**: `/org/settings` → Agent templates panel,
  `app/features/org-settings/agent-template-modal.tsx` (the modal that
  also does the KB display-name→dir repair, §1.3), actions `agent-save` /
  `agent-delete` (`org.settings.tsx:542-566`), backed by
  `app/server/org/gagents.server.ts`.
- **Seeded defaults**: `app/server/seed/agent-catalog.server.ts:90-168` —
  three built-in templates (Operator, Developer, Reviewer) each with a
  default `resources` grant (operator: skill `viberr-app-expertise` + KB
  `architecture-notes`; developer: skill `developer-expertise` + KBs
  `architecture-notes`/`api-contracts`; reviewer: skill
  `reviewer-expertise` + KB `api-contracts`).
- **Deployment**: a project deploys a template into
  `project.md → agents[]`, which snapshots the template's
  `definition.resources` into the project file (see §1.3/§2.3) — from then
  on the project's copy is independently editable via the per-project
  agents UI (`app/routes/project.agents.tsx`) without touching the global
  template.
- **KB/skill *content* seed** (distinct from the template layer):
  `app/server/org/org-seed.server.ts` ships demo KB folders
  (`architecture-notes`, `api-contracts`, `deploy-runbooks`) and demo skill
  folders (`conventional-commits`, `terraform-review`, `api-design`,
  `changelog-writer`) as real files with back-dated mtimes, non-destructively
  (an existing folder of the same name is left untouched on re-seed).

No task-level or project-level "template" library (e.g. a task
description boilerplate picker) was found under this scope; if one exists
it lives outside `resources.server.ts`/agent-profile territory and wasn't
surfaced by this search.

---

## 5. TEST PLAN HINTS

**KB load-proof (live, in-app):**
1. `/org/settings` → Resources → Knowledge bases → New. Name it, e.g.
   "QA marker kb" (dir will slugify to `qa-marker-kb`).
2. Use the store browser (New document) to add a doc containing a unique
   token, e.g. `KB-PROOF-<random>`.
3. Attach the KB to a profile's `resources.kb` (agent template modal or the
   per-project agent modal) — the picker stores the `dir`, not the display
   name (§1.3), so this also exercises the P13-KM-01 fix.
4. Start a run on a task assigned to that profile; ask (in the task/goal)
   for the agent to state what's in its knowledge base, or just let it
   report during a normal task. Expect the token verbatim in the run's
   transcript, and the run's Inputs panel to show
   `knowledge: qa-marker-kb` (`runs-helpers.ts:190-193`).
5. Regression check: rename the KB in Settings, confirm the profile's grant
   chip is *not* orphaned (still resolves), then delete the KB and confirm
   the chip turns into the red "missing" chip
   (`agent-template-modal.tsx:59-84`) rather than silently vanishing.

**MCP attach + real tool call:**
1. Register an external MCP server (a simple stdio echo server, or an
   HTTP one) in `/org/settings` → MCP servers → Add. Watch the save toast
   report a real discovered tool count (`resources.server.ts:1543-1555`) —
   not a fabricated number.
2. Grant it to a profile's `resources.mcps`.
3. Start a run; check the Inputs panel's `mcp` row for `mounted: <name>`
   (`runs-helpers.ts:196-210`) and have the agent actually invoke one of
   the server's tools (visible in the run log as an `mcp__<name>__<tool>`
   call for Claude, `mcp__<name>__<tool>` with underscores substituted for
   Codex per §2.5).
4. Credential check: add a bearer/token credential to the server, confirm
   it is never echoed anywhere in the UI (`hasCred` boolean only) and that
   a deliberately-wrong `VIBERR_SECRET_ENCRYPTION_KEY` swap makes the row
   report `credUnreadable`/refuses to mount rather than connecting
   anonymously (§2.2).
5. Rename the server and confirm existing profile grants follow the rename
   (`resources.server.ts:1576-1584`) instead of orphaning (this was
   literally live-caught once, per code comments: `vm-memory` →
   `vm-graph-memory` orphaned two profiles pre-fix).

**Skill relatedness confirmation:**
1. Create two skills in Settings with very different SKILL.md content
   (e.g. `skill-a` about a fictitious internal tool, `skill-b` unrelated).
   Grant **only** `skill-a` to a profile.
2. Start a Claude-backed run on that profile with a real git checkout.
   Inspect the workspace's `.claude/skills/` directory (or the run's
   Inputs panel `skills` row, `runs-helpers.ts:173-188`) — expect only
   `skill-a` to appear under "mounted into the workspace", never
   `skill-b`, and never any of the SDK's own bundled skill names.
3. Confirm `skill-b`'s content never appears anywhere in the run's
   transcript or persona (it isn't prompt-injected either, since it's not
   in the grant list at all — distinguish this from a *granted-but-Codex*
   skill, which legitimately does ride as prompt text).
4. Repeat with a Codex-backed profile carrying the same single grant:
   confirm the Inputs panel shows it under "carried as prompt text
   instead" (`runs-helpers.ts:181-183`) since Codex has no native mount
   (§3.4), and that the CLI's own bundled skills (`imagegen`,
   `skill-creator`, etc.) are not advertised (verifiable only via a raw
   `codex debug prompt-input` against the run's CODEX_HOME, if accessible).
5. Delete a granted skill's folder from disk directly (bypassing the app)
   and re-run — expect a graceful "unresolved" disclosure
   (`skill-body.server.ts:151-157`) naming it, never a crashed run.

---

## 6. SUSPECTED ISSUES

These are read from the code as currently written; none were live-verified
this pass (pure discovery/read-only), so treat as leads, not confirmed bugs.

1. **Best-effort reference rewrite can strand a grant.** `rewriteTemplates`
   / `rewriteProjects` (`resource-references.server.ts:92-185`) skip a
   file it cannot parse and only `logger.warn`. A single malformed
   `agents/profiles/<id>.md` or `project.md` at the moment of a KB/skill/
   MCP rename means that *one* profile silently keeps the old name forever
   — with no UI surfacing this beyond a server log line. Worth a live test:
   hand-corrupt one profile's frontmatter, rename a KB it grants, confirm
   whether anything visible to an admin flags the miss.

2. **Skill-mount residual: finished-run leftovers share the task
   workspace.** `skill-mount.server.ts:84-95` explicitly accepts that a
   *finished* run's mounted skill folder is never collected — only a
   concurrent *live* run's mount is protected from deletion. Since "ONE
   workspace, MANY runs" per task (line 45), a profile that once held a
   skill grant which was later revoked could still have that skill's files
   sitting in `.claude/skills/` for a *different* co-engaged agent's `cwd`
   to read, if that agent isn't itself skill-mount-gated the same run.
   Comment calls this "not nothing" — worth checking whether a
   reviewer/co-engaged agent on the same task can see a departed
   specialist's stale mounted skill content.

3. **`claudeMdExcludes` is an unverified mitigation, stated as such.**
   `claude-runtime.server.ts:317-334` opens `settingSources: ['project']`
   for any run with mounted skills, which is also the source that loads a
   repo's `CLAUDE.md`/`CLAUDE.local.md` as system-prompt-tier instruction.
   The code says outright: "treat the ingress as OPEN until someone reads
   a run's system prompt and confirms otherwise." This is a real,
   acknowledged, open trust-boundary question for any repo whose
   `CLAUDE.md` an attacker (or a careless contributor) controls, on any
   run that has at least one skill grant.

4. **Codex hyphen/underscore MCP tool-name mismatch is disclosed, not
   fixed.** (`codex-runtime.server.ts:141-148`.) A KB or skill instructing
   an agent to call an MCP tool by its literal Claude-style hyphenated name
   will silently fail to match on Codex (and vice versa) — no runtime
   translation exists. This is a real cross-backend authoring trap: any
   org-authored KB/skill content that names a specific `mcp__foo-bar__baz`
   tool is backend-fragile by construction.

5. **Codex credential-less MCP mounting is a silent capability
   downgrade, disclosed only in the system prompt.** A credentialed MCP
   server is deliberately unauthenticated on Codex (`specialist-mcp.server.ts:160-168`)
   — the agent is told this in its persona text
   (`specialist-run.server.ts:2096-2099`), but nothing prevents an admin
   from granting a credential-requiring server to a Codex-backend profile
   and getting a permanently-degraded (or outright broken, if the server
   requires auth to answer *any* request) tool for that backend. The admin
   UI (`McpView`) does not appear to warn "this credential will never be
   used on Codex profiles" at grant time — worth confirming in the
   Settings UI directly.

6. **Operator's empty-skills fallback is a quiet default, not a grant.**
   (`operator-run.server.ts:2846-2850`, "Design tension #25".) An org admin
   who removes every skill from the operator's profile *believes* they
   revoked all skill content, but the operator always re-adds
   `viberr-app-expertise` when the list is empty. This is disclosed in a
   code comment but not obviously in the UI — worth checking whether the
   Agent templates modal tells the admin this before they save an
   empty-skills operator profile.

7. **`isReservedMcpName`/reserved-skill-name classes rely on exact string
   match.** (`resources.server.ts:1289-1297`.) The comment at
   `resources.server.ts:1278-1287` itself flags that a row created
   *before* the save-time guard existed, or written directly into the DB,
   would still be silently skipped by every resolver while remaining
   visible in a hand-crafted query — worth a boot-time integrity check (or
   at least a migration) that actively deletes/flags any legacy
   `org_mcp_servers`/`org_skills` row matching a reserved name, rather than
   relying on every future write path to keep re-checking it.

---

## Key files (index)

| Area | File |
|---|---|
| KB/MCP/skill CRUD + disk-is-truth | `app/server/org/resources.server.ts` |
| Resource picker catalog (grant UI source) | `app/server/org/resource-catalog.server.ts` |
| Rename/delete reference rewrite | `app/server/org/resource-references.server.ts` |
| KB injection (shared reader) | `app/server/files/kb-injection.server.ts` |
| Skill injection (prompt-text path) | `app/server/files/skill-body.server.ts` |
| Skill native mount (Claude workspace) | `app/server/runtimes/skill-mount.server.ts` |
| MCP resolve + credential handling | `app/server/tasks/specialist-mcp.server.ts` |
| Browser MCP (capability-gated) | `app/server/tasks/specialist-browser-mcp.server.ts` |
| Secret sealing/rotation | `app/server/secrets/secret-box.server.ts` |
| Log/credential scrubbing | `app/server/secrets/git-output-redact.server.ts` |
| Claude adapter (skills/mcp wiring) | `app/server/runtimes/claude-runtime.server.ts` |
| Codex adapter (MCP translation) | `app/server/runtimes/codex-runtime.server.ts` |
| Codex home isolation (skills severed) | `app/server/runtimes/codex-config.server.ts` |
| Specialist persona assembly | `app/server/tasks/specialist-run.server.ts` (`buildSpecialistPersona`) |
| Operator persona assembly | `app/server/runtimes/operator-run.server.ts` |
| Agent profile frontmatter schema | `app/server/files/agent-profile-file.server.ts` |
| Global agent templates CRUD | `app/server/org/gagents.server.ts` |
| Seeded template defaults | `app/server/seed/agent-catalog.server.ts` |
| Shipped skill/persona assets | `app/server/seed/default-assets.server.ts` |
| Demo KB/skill content seed | `app/server/org/org-seed.server.ts` |
| Agent-template grant UI (KB dir repair) | `app/features/org-settings/agent-template-modal.tsx` |
| Run Inputs disclosure (proof UI) | `app/features/runtime/runs-helpers.ts`, `runtime-types.ts` |
| org-settings route + action intents | `app/routes/org.settings.tsx` |
