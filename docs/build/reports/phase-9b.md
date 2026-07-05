# Phase 9B report — Org admin (org-settings + kb-browser)

Status: complete. Gates at close: `npm run typecheck` clean,
`npm test` **651/651** green (581 prior + 70 new), `npm run build` clean
(only the pre-existing RR future-flag warnings). Live-verified end to end
(see "Live verification"); store re-seeded pristine after
(`npm run seed -- --reset` → identical counts, clean-tree rescan
0 changed / 13 unchanged).

No new deps. Migration **0008_org_resources.sql** (five net-new tables —
connections reuse the phase-7 `github_pats` for the encrypted token, so no
token storage was reimplemented). routes.ts untouched (the registered
`/org/settings` placeholder route CONTENTS were replaced; `/org/users` now
redirects).

## File inventory

```
db/migrations/0008_org_resources.sql   # github_connections (pat_id FK→github_pats),
                                       # google_domain_allowlist, org_knowledge_bases,
                                       # org_mcp_servers, org_skills
app/
  shared/ids/slugify.ts                # THE mock slugify (client+server share ids)
  server/org/
    connections.server.ts   [test]     # owner connections over the phase-7 pat-store:
                                       #   create/replace (validate FIRST — nothing saved
                                       #   on failure), set-default (transactional),
                                       #   remove (default refused), default-token reader
    org-users.server.ts     [test]     # Users & access over the PHASE-2 user-admin API:
                                       #   whitelist github/google/local, status derivation,
                                       #   edit (+email), reset (temp pw surfaced once),
                                       #   deleteOrgUser (9B addition), domain CRUD,
                                       #   findDomainAllowlistRole (callback hook)
    resources.server.ts     [test]     # KB/skill CRUD = REAL folder mutations under
                                       #   ${DATA_ROOT}/kb + /skills (rename = move);
                                       #   MCP CRUD + honest reachability probe;
                                       #   resolveStoreTarget for the browser actions
    store-files.server.ts   [test]     # StoreBrowser fs layer: scan (dirs-first, dotfiles
                                       #   skipped), structure-preserving uploads, mkdir -p,
                                       #   recursive delete, path-traversal rejection,
                                       #   SKILL.md capture flag, REAL GitHub snapshot
                                       #   import via the default connection
    gagents.server.ts       [test]     # global agent profile TEMPLATES (agents/profiles/
                                       #   *.md) CRUD; `used` projection over
                                       #   projects.agent_policy_json gates deletion
    org-view.server.ts                 # getOrgSettingsView — the loader payload
    org-seed.server.ts      [test]     # seedOrgResources (see "Seed additions")
  features/kb-browser/
    tree.ts                 [test]     # StoreNode + countKbFiles/countKbDirs/prettySize/
                                       #   flatten (exported for org-settings rows)
    icons.tsx                          # FolderIco (exported) + UploadIco + FolderUpIco
    local-files.ts                     # picker/DnD → {file, relPath}[] (dotfiles skipped,
                                       #   webkitGetAsEntry walk + flat fallback)
    store-browser.tsx       [jsdom]    # THE StoreBrowser modal (mock 1:1; loader tree +
                                       #   fetcher actions; layered Escape + inert card
                                       #   under the nested delete confirm)
  features/org-settings/
    mini-modal.tsx                     # MiniModal (useDialog, REAL disabled save w/ mock
                                       #   visuals) + ConfirmDelete + EditIco
    use-org-action.ts                  # CSRF-injecting fetcher wrapper w/ server-toast
                                       #   default + onResult override for modals
    connections-panel.tsx              # §4.1 panel + ConnectionModal (cred-warn gating)
    users-panel.tsx                    # §4.2 panel + IdpChip + InviteModal + EditUserModal
    resources-panel.tsx                # §4.3/4.4 four panels + KB/Mcp/Skill/Agent modals +
                                       #   StoreBrowser wiring + shared ConfirmDelete
    org-settings-page.tsx              # §4.0 shell; tab in ?tab= (Home tiles' shape)
    org-settings-page.test.tsx [jsdom] # smokes: 3 tabs, guard toasts, confirms, modals
    org-settings-route.server.test.ts  # RBAC (admin 200 / member 403 / anon→login),
                                       #   user+domain+resource+store intents via real
                                       #   Requests, multipart upload → file on disk
  routes/
    org.settings.tsx                   # REPLACED placeholder: admin-only loader + the
                                       #   ~25-intent action dispatcher (CSRF, multipart)
    org.users.tsx                      # REPLACED temp page: redirect → /org/settings?tab=users
scripts/seed.ts                        # + seedOrgResources call + summary lines (existing
                                       #   output lines unchanged)
```

Touched additively (allowed "ADD exports" list): `app/server/files/
file-store-root.server.ts` (+`kb`/`skills` in DATA_ROOT_SUBDIRS, +kbRootDir/
kbDirPath/skillsRootDir/skillDirPath), `app/server/secrets/pat-store.server.ts`
(+`replacePatToken`). `credential-card.tsx` was NOT touched; it is also not
imported here — the mock's connection UI is `.conn-row`/`.scope-chips`
markup, not the cred-card (the contracts' "org-settings modals" sharing note
turned out to be the chip/warn/ok CLASS family, which was reused verbatim).
No CSS additions were needed — phase 4 had already ported every `set-*`,
`conn-*`, `rsrc-*`, `be-*`, `fm-*`, `dom-ic`, `idp-chip` rule into app.css.

## Data model

- **Connections** (`github_connections`): owner + `pat_id` FK into the
  phase-7 `github_pats` (AES-256-GCM at rest, masked `····suffix`,
  validation cache). Org facts on the row: `is_default` (exactly one,
  transactional), `repos_count` + `expires_at` captured at validation time
  from GitHub (`GET /users/{owner}`, token expiration header). The whole
  surface honors §7.2: `createConnection`/`replaceConnectionToken` run
  `validatePatToken` (scopes `repo · workflow · pull_request:write`) and
  the owner-existence probe FIRST — any failure returns a typed message
  and the DB is untouched (replace keeps the old token active).
- **Users** = the phase-2 `users` table, REUSED: local accounts via
  `createUser`/`resetPassword` (temp password), google accounts via
  passwordless `createUser` (the row IS the whitelist), github handles as
  placeholder identity rows (`@handle` / `github.com/handle`, insertUser —
  deliberately not an email). Status is derived, never stored:
  `whitelisted` (idp row, never signed in), `invited` (local +
  pwreset_required + never signed in), else `active`; the pwreset pill is
  `pwreset_required` outside the invited state. `deleteOrgUser` is the one
  9B addition to the phase-2 API surface (remove-from-whitelist = row
  delete; sessions/prefs/PATs cascade, audit + event actor snapshots
  survive by design).
- **Domains** (`google_domain_allowlist`): normalized `@domain` rows with
  a join role. Managed + audited here; `findDomainAllowlistRole(db, email)`
  is the one-line hook for the Google OAuth callback (see deviations).
- **KBs / skills are file-native**: real folders `${DATA_ROOT}/kb/<dir>/`
  and `/skills/<name>/` (UI renders them as `store://kb/…`,
  `store://skills/…` verbatim). Trees are scanned from disk on every load
  — files added outside Viberr appear on the next load, exactly as the
  def-note promises. SQLite carries metadata only (refresh cadence /
  summary / freshness timestamps). Rename = slug recompute + real folder
  move (spec §7.3), collisions refused. Skill `body` is ALWAYS the live
  `SKILL.md` content read from disk (editor round-trip + upload capture
  need no separate sync).
- **MCP servers** (`org_mcp_servers`): pure config + honest health:
  `up` is 1/0/NULL (NULL = never probed / stdio not probeable),
  `tools_count` is never fabricated (NULL until a real MCP handshake
  exists; seeded rows carry the mock's demo counts).
- **Global agent profiles = the phase-3 template files** under
  `agents/profiles/*.md` — no table. The panel lists SPECIALISTS only
  (mock gagents; the operator is a system profile, undeletable, managed
  nowhere). `used` = distinct-project count over
  `projects.agent_policy_json` deployments; it gates deletion with the
  "Detach {name} from its N projects first" copy. Edits preserve every
  field the modal doesn't own (capability policy, extras, icon, model,
  scope, loose unknowns) via read→merge→serialize; template resource
  strings that don't match an org resource are preserved verbatim on save.

## Seed additions (`seedOrgResources`, called from scripts/seed.ts)

- 3 KBs (`architecture-notes`, `api-contracts`, `deploy-runbooks`) with
  **15 real markdown files** (authored content, mock file names/structure),
  mtimes back-dated via `utimesSync` to the mock's date spread;
  `last_indexed_at` back-dated (Jul 1 / Jun 28 / Jul 3 02:00).
- 4 skills (`conventional-commits`, `terraform-review`, `api-design`,
  `changelog-writer`) with real `SKILL.md` (mock bodies verbatim) +
  supporting files (examples/checklists/templates).
- 3 MCP rows (github-mcp 14 tools up · postgres-readonly 6 tools up ·
  browserbase down) with back-dated check times.
- `@viberr.dev` domain allowlist row (member).
- **Placeholder akin-ozer connection** with NO real token: a `github_pats`
  row sealing an obviously-fake value, no validation cached → the UI
  renders the honest "not validated" pill, plain scope chips, `expires —`.
  INSERT-IF-MISSING and NOT wiped on `--reset` (phase-7 pattern: an admin
  who installed a real token keeps it across re-seeds).
- Idempotent (deterministic ids, INSERT OR REPLACE for demo rows); on
  `--reset` the kb/skills folders + the three resource tables + domains
  are rebuilt. **Existing seed output intact** (test-asserted): 5 users /
  3 projects / 10 tasks / 32 events / 10 notifications / 18 runs / 96 log
  lines, and the summary print only gained lines.

## What Phase 10 (audit UX) gets from this phase's mutations

All org-scoped (no projectSlug, no task timeline events — spec §5), all
secret-free:

| action | subject | details |
|---|---|---|
| `org.connection.created / .token_replaced / .default_changed / .removed` | github_connection / id | owner (+suffix/default on create) |
| `github.pat.created / .token_replaced / .deleted` | github_pat / id | label, suffix (phase-7 + new replace) |
| `org.user.whitelisted` | user / id | idp, handle/email, role |
| `org.user.created / .updated / auth.password.reset` | user / id | phase-2 recorder (reused) |
| `org.user.removed` | user / id | email, name |
| `org.domain.whitelisted / .removed` | google_domain / id | domain (+role) |
| `org.kb.created / .updated / .deleted / .reindexed` | org_kb / id | name, dir, refresh / docCount |
| `org.mcp.added / .updated / .removed` | org_mcp / id | name, transport |
| `org.skill.created / .updated / .deleted` | org_skill / id | name (+renamed) |
| `org.agent_profile.created / .updated / .deleted` | agent_profile / id | name, backend |
| `org.store.files_added / .folder_created / .file_deleted / .folder_deleted / .github_import` | org_kb·org_skill / id | path, count / source, branch, folder, fileCount |
| `seed.org_resources` | — | counts, reset flag |

## Decisions / deviations (from the mock / specs)

1. **Tab shape `?tab=`** (spec §8.3 recommended path segments): kept the
   query-param shape because the phase-4 Home tiles already link
   `?tab=connections|users|resources`. Default `connections`; old
   `/org/users` 302s to `?tab=users`.
2. **Honest connection states replace the prototype fakes** (spec §7.1):
   scope-chip check icons render only after a PASSING validation; a
   "not validated" (input) / "validation failed" (risk) pill marks
   placeholder/broken tokens; the masked token rides the sub line
   (`PAT ····0000 · expires —`); repos segment omitted when unknown.
   Failure copy is the mock's shape parameterized with the REAL missing
   scopes / validator detail ("… Nothing was saved."). Fine-grained-token
   honesty is inherited from phase 7 (write scopes `assumed` until a 403).
3. **Local accounts: the temp password IS the setup link** (spec §8.8
   resolved): create/reset surface the generated temp password ONCE — an
   inline cred-ok notice in the panel (create) or in the open Edit dialog
   (reset, mock's live-record re-render kept). Copy adjusted accordingly
   ("No email is sent — a temp password is generated for you to hand
   over…"); phase-2's forced-reset gate does the rest at first sign-in.
4. **Domain allowlist + github-handle claim are NOT wired into the OAuth
   callbacks** — the callback modules are phase-2 files outside 9B
   ownership. Rows are stored/managed/audited; `findDomainAllowlistRole`
   and the `github.com/<handle>` placeholder-row convention are the
   documented one-line hooks for a later phase. (Google *account* and
   local whitelisting are fully functional via the account-existence
   model.) Flagged as THE known functional gap of this surface.
5. **User remove = real row delete** (phase-2 only had disable). Guards:
   self (client toast + server 409), last active admin (server). The
   dialog's "task assignments return to the operator" stays copy-only
   (spec §8.7 open) — owner snapshots on events survive by design.
6. **MCP honesty** (spec §3.5's fakes dropped): save/test run a real
   HTTP reachability probe (any HTTP response = up; SSE bodies cancelled;
   2.5 s timeout); stdio is never probed (`up` NULL → neutral dot,
   "not health-checked yet" / "spawned per run" toast). Tool counts are
   only ever displayed, never invented — the mock's "8 tools discovered"
   toast became "endpoint reachable (Nms)" / "unreachable — {reason}".
   The 60 s health loop is out of scope (dot can go stale — spec §8.10
   answered as "on save & test only", and the modal foot hint says so).
7. **Dates render relative** from ISO via the shared `formatRelative`
   ("indexed 3d ago", "updated just now", file `added` column) instead of
   the mock's frozen display strings; seed back-dates file mtimes +
   row timestamps so the spread matches the mock's feel.
8. **StoreBrowser** is loader-tree + fetcher-action driven (no client
   tree math): expansion is optimistic (target path expands at submit),
   the GH-import expands the ACTUAL created folder name from the action
   response (mock's collision-rename collapse bug fixed), toasts are
   server-computed from real counts, `size`/`added` format at render time.
   Escape closes the TOPMOST layer only (confirm → new-folder input →
   modal) and the wide card goes `inert` under the nested confirm
   (kb-browser §7 layering). SKILL.md capture is server-side (§5): the
   upload response carries the capture toast; the body is simply re-read
   from disk. Delete addresses by full path, not name (mock bug fixed).
   Sort contract: dirs-first + alphabetical (spec §8.3 decided).
9. **GitHub import is real** (spec §8.5/§8.7 resolved): git-trees API
   snapshot through the DEFAULT connection when its token last validated
   clean; otherwise the `.cred-warn` "No GitHub connection with a
   validated token — add one under GitHub connections first." Caps:
   100 files / 1 MB per blob, dotfile paths skipped, "(truncated)"
   suffix on the toast when clipped. No unauthenticated public fallback.
10. **Skill-delete confirm copy fixed to the folder form**
    (`store://skills/{name}/ is deleted.` — spec §8.6 recommendation).
11. **Empty states added** where the mock had none (spec §7.5):
    connections ("No connections yet — add one to create projects.") and
    global agent profiles ("No global agent profiles yet.").
12. **Profile id is stable across renames** (template files are referenced
    by id from project.md deployments); new profiles mint `slugify(name)`
    with a conflict refusal. Editing collapses `backends` to the single
    selected backend (mock + 9A parity).
13. **Legacy template resource strings** ("repo-write", "Viberr Core
    architecture"…) don't match the new org resources by design — the
    seeded templates were deliberately left untouched (existing /agents
    fidelity + tests). The AgentModal shows org-resource chips, preserves
    unmatched legacy strings invisibly on save, and `usedBy` matches by
    id OR name, so freshly-linked profiles count ("· N profiles") while
    seeded ones don't. Fully formalizing the seeded templates onto org
    resource ids is a coordinated follow-up (it changes /agents display).
14. **`viewer` org role stays schema-only** (ruling 2): every surfaced
    toggle is admin|member; the domain table CHECKs the same pair.
15. **Home org tiles** still show "0 knowledge bases · 0 MCP · 0 skills"
    (the phase-4 Home loader predates the org tables and is outside 9B
    ownership) — one-line follow-up for the orchestrator: count from
    `org_knowledge_bases`/`org_mcp_servers`/`org_skills`.
16. Deliberate quirk kept: the 400-char SKILL.md size floor of the mock
    was dropped — sizes are real bytes from disk.

## Live verification (dev :5173, preview browser)

`npm run seed -- --reset`, `npm run dev`, signed in as arda@viberr.dev.
Console: zero warnings/errors for the whole pass; server log error-free.

- **Tabs render populated** (counts 1 / 6 / 14): connections row
  `akin-ozer · PAT ····0000 · expires —` with "not validated" + "default"
  pills and check-less scope chips; users tab with @viberr.dev domain row,
  you-tag, idp chips; resources tab with 3 KBs (6/6/3 real docs), 3 MCPs
  (health dots + "checked 6m ago"), 4 skills, 4 specialist profiles.
- **Create + reset a user**: Allow access → Local → "Test Local" created;
  cred-ok notice with the one-time temp password; row appears with
  "setup pending"; Edit dialog shows the live "Reset pending —…" state.
  Self-demote and self-remove guard toasts verbatim; remove-user confirm
  copy verbatim → row deleted.
- **Whitelist a domain**: "@hepapi.com" → verbatim foot hint + toast +
  row; removed via confirm ("removed from the allowlist" toast).
- **StoreBrowser (Architecture notes)**: New folder "uploads/live-check"
  → toast "Folder uploads/live-check/ ready"; drag&drop of a File onto
  the uploads row → "1 file added to store://kb/architecture-notes/uploads/",
  footer flips to "indexed just now" — **verified on disk** under
  `data/kb/architecture-notes/uploads/`; nested delete confirm ("…and its
  contents?", card inert, Escape closes only the confirm) → folder gone
  from disk; GH import with no validated connection → honest cred-warn.
- **Connection gating live**: junk token → "Verifying scopes…" busy label
  → real GitHub 401 → cred-warn "Validation failed — GitHub rejected the
  token (bad credentials)… Nothing was saved.", modal open, still exactly
  1 connection. Removing the default → mock guard toast, no dialog.
- **KB re-index** toast "Architecture notes re-indexed — 6 docs"; MCP
  test → "browserbase unreachable — connection refused", dot stays down.
- **Old /org/users** → 302 `/org/settings?tab=users` (curl-verified);
  anonymous /org/settings → login redirect; member 403 covered by the
  route test.
- Audit rows observed for every action above. Server stopped; re-seed
  pristine (counts identical, rescan 0 changed / 13 unchanged).

## Known gaps (intentional)

- OAuth-callback consumption of domain allowlist rows + github-handle
  placeholder claiming (deviation 4) — hooks documented above.
- MCP tool discovery (real MCP handshake) and the 60 s health loop.
- KB "refresh cadence" is stored policy only — no scheduler acts on
  `nightly`/`on change` yet (re-index is manual + implicit on mutations).
- No file preview in the StoreBrowser (kb-browser §8.1 — mock has none).
- Org mutations don't publish SSE (spec §8.4): post-action revalidation
  covers the acting admin; concurrent admin sessions refresh on their own
  next action/navigation.
