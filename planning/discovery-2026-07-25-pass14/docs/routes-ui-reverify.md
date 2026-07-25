# Viberr — Routes & UI honesty RE-VERIFICATION (pass 14, 2026-07-25)

Base: `main` @ `fa138e1` (post PR #101 / pass-13 merge). Every verdict below was
read from source in the working tree at this commit. Re-verifies the 58 findings
of `planning/discovery-2026-07-24-pass13/docs/routes-ui-audit.md` (`UI-nn` =
that doc's `F13-nn`), then sweeps the surfaces pass 13 itself introduced.

**Headline: 46 of 58 FIXED · 9 PARTIALLY-FIXED · 2 OBSOLETE (ruled) · 1 STILL-OPEN.**
The pass-13 FINDINGS table froze the UI rows at "OPEN" (discovery-time snapshot),
but commits `3c8c117` (W4), `e528cca`, `01aa841`, `f81c3dc`, `55a5f1c`…`7777ccc`
(W1a-f) and `357249f` (W0) landed the fixes; this doc is the per-finding code
re-read that the pass-13 record never went back to write.

All five HIGHs (UI-01, UI-02, UI-28, UI-29, UI-30) are **genuinely fixed** — each
verified against the mechanism, not the commit message.

---

## 1. Route inventory (current — `app/routes.ts` unchanged since the audit)

No route was added or removed by pass 13; every change landed inside existing
surfaces. New *sub-surfaces* introduced by pass 13 are flagged ★.

| URL | Module | Renders | Pass-13 surface changes |
|---|---|---|---|
| `/` | `routes/_index.tsx` | `features/home/home-page` | honest recency (`UpdatedLabel`), "All quiet" hero branch, connection-health chips in New-project, client-side greeting, LV-07 task-key honesty |
| `/login` `/logout` | `routes/login.tsx` / `logout.tsx` | inline / — | — (still no route tests, see UI-26) |
| `/org/settings` | `routes/org.settings.tsx` | `features/org-settings/*`, `features/kb-browser/store-browser` | ★ store-browser "New document" (in-app KB authoring, LV-06); ★ real MCP handshake + tool counts + stale badge; PAT scope probes + `~assumed` chips; `clearBody`; global-agent templates start delivery-withheld |
| `/profile` | `routes/profile.tsx` | `features/profile/profile-page` | per-panel fetchers + rollback, CSRF-as-result, Escape-commits |
| `/notifications` (+`/read`) | `routes/notifications.tsx` | `features/notifications/notifications-page` | true needs-you count, row-role cleanup |
| `/prefs/theme` | `routes/prefs.theme.tsx` | — | `csrfError` result path |
| `/resources/{events,health,run-log,model-catalog,session-export}` | `routes/resources.*` | — | run-log gains backward paging (`?before=`) for the console history |
| `/api/auth/*` | `routes/api.auth.$.ts` | — | — |
| `/projects` | redirect `/` | — | — |
| `/projects/:slug` (layout) | `routes/project.tsx` | shell (`rail`,`topbar`,`top-bell`,`user-menu`) | ★ `<main>` landmark + `SkipLink`; ★ `RoutePendingBar` (mounted in `root.tsx:172`); ★ "live updates paused — retry" chip; `waitingOnMe` unioned with acceptance authority |
| `…/board` | `routes/project.board.tsx` | `features/board/board-page` | ListView gets StageMenu, seg a11y, `roleCan` gates |
| `…/review` | `routes/project.review.tsx` | `features/review/review-page` | loader-resolved stage names; operator-can-accept disclosure |
| `…/agents` | `routes/project.agents.tsx` | `features/agents/*` | ★ `LibraryPicker` ("Add from library", ruling 1); ★ `CapabilityMatrixModal` (shared with Policy) with per-capability enforcement scope; honest stage/backends disclosure; operator catalog in the editor |
| `…/policy` | `routes/project.policy.tsx` | `features/policy/policy-page` | removed-account rows, matrix reuse |
| `…/github` | `routes/project.github.tsx` | `features/github/*` | `unknown`/"not compared" sync state, role-gated Reconcile, 10 s request timeout |
| `…/activity` | `routes/project.activity.tsx` | `features/activity/activity-page` | in-panel actor filter + unfiltered-audit disclosure, "N of M events", bounded Show-older |
| `…/settings` | `routes/project.settings.tsx` | `features/project-settings/settings-page` | ghost-member pruning support |
| `…/tasks/:key` | `routes/project.task.tsx` | `features/task-detail/*`, `features/runtime/*` | member-gated raw logs (`runsVisible`/`logsWithheld`), ★ console history paging (UI-53), honest retry toast, `prStatePill`, packet roving tabindex, ★ humanised observation keys |

The pass-13 screenshot record (`NOTES.md:67-101`) lists 25 shots (`00-login` …
`24-new-project-modal`); every listed surface exists on this route set — the
claim is consistent with the current app (shots themselves are gitignored, so
the record is a list, not an artifact).

---

## 2. Section A — verdicts on UI-01..UI-58

Verdicts: **FIXED** (defect gone, mechanism verified) · **PARTIALLY-FIXED**
(some sub-items remain) · **OBSOLETE** (ruled: premise wrong or
defensive-by-design, documented in place) · **STILL-OPEN**.

| id | original headline | verdict | evidence |
|---|---|---|---|
| UI-01 | HIGH — scope ✓ painted for scopes never verified; fine-grained PATs `source:"assumed"` | **FIXED** | fine-grained tokens now get real probes (`app/server/secrets/pat-validator.server.ts:241-282`, `source:"probe"`); only unverifiable write scopes stay `assumed` (`:282-289`) and the UI renders those as a `~` chip with "marked ~assumed" copy, ✓ only when `ev.source !== "assumed"` (`app/features/org-settings/connections-panel.tsx:235-252`, modal copy `:151`) |
| UI-02 | HIGH — "updated just now" on task-less projects after rebuild | **FIXED** | `updatedAt: agg?.updated_at ?? null` — the `parsedAt` fallback is gone with a NEVER-fall-back comment (`app/features/home/home-query.server.ts:253-255`); null renders "no task activity yet" (`app/features/home/home-page.tsx:125-130`) |
| UI-03 | MED — dropped SSE never surfaced, never reconnects after session expiry | **FIXED** | `source.onerror` + `paused` + bounded-backoff re-open (`app/features/live-updates/use-live-updates.ts:103-128`); "live updates paused — retry" chip in the topbar (`app/features/shell/topbar.tsx:159-171`, wired `app/routes/project.tsx:126,167-168`); run-log stream gets `streamError` (`app/features/runtime/use-run-log-stream.ts:52-58`) |
| UI-04 | MED — GitHub client no timeout; no navigation pending UI | **FIXED** | `AbortSignal.timeout(requestOptions.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS)` (`app/server/github/github-client.server.ts:70-71,137`); `RoutePendingBar` mounted at `app/root.tsx:172` (`app/features/shell/route-pending-bar.tsx`) |
| UI-05 | MED — never-reconciled branch renders green "synced" | **FIXED** | new `unknown` sync state → neutral "not compared" pill (`app/features/github/github-pills.ts:21-34,38`); query comment records the fix (`app/features/github/github-query.server.ts:40`) |
| UI-06 | MED — pin/unpin toasts before the server answers | **FIXED** | `useFetcherResult(prefsFetcher, …)` toasts on the result, errors included (`app/features/home/home-page.tsx:1420-1431`) |
| UI-07 | MED — failed Re-scan indistinguishable from success | **FIXED** | both outcomes toast (`app/features/home/home-page.tsx:1437-1447`) |
| UI-08 | MED — store uploads: no busy state, silent all-dot-filtered no-op | **PARTIALLY-FIXED** | busy state + error toasts landed (`app/features/kb-browser/store-browser.tsx:472,477-495,531-533`); **but** an all-dot-filtered drop is still a silent no-op: `if (entries.length === 0) return;` (`store-browser.tsx:514`) and the server still returns bare `ok()` on `added === 0` (`app/routes/org.settings.tsx:342`) — no "nothing uploaded, N hidden files skipped" |
| UI-09 | MED — new-project accepts any repo string / any connection health | **FIXED** | repo probe with distinct `not_found`/`forbidden`/network warnings surfaced to the user (`app/features/home/project-create.server.ts:94-126,226-241`); `connectionHealth` shipped and rendered on the chips ("token failed"/"unvalidated" + explanatory titles) (`app/features/home/home-query.server.ts:264-303`, `home-page.tsx:405-439`) |
| UI-10 | MED — hero asserts "kept working" + pulse dot at 0 runs | **FIXED** | `totalRunning === 0` → "All quiet — no agent runs right now", dot only in the active branch (`app/features/home/home-page.tsx:970-997`) |
| UI-11 | MED — "GHE-safe" host derivation can only return github.com | **PARTIALLY-FIXED** | the false "never hardcode github.com" advertisement is replaced by an honest limitation comment designating the ONE future thread-through point (`app/features/github/github-query.server.ts:244-251`); **but** the second client-side literal fallback survives: `const host = githubHost ?? "https://github.com"` (`app/features/task-detail/task-detail-page.tsx:143`, optional prop `:78,:1200`) — still two places, not one |
| UI-12 | MED — no `main` landmark, no skip link in the workspace | **FIXED** | `<main className="main" id="main-content" tabIndex={-1}>` (`app/routes/project.tsx:148-151`) + `SkipLink` (`:18`, `app/ui/skip-link.tsx`); regression e2e `e2e/07-accessibility.spec.ts` |
| UI-13 | MED — five toggle groups convey selection with CSS only | **PARTIALLY-FIXED** | Home Grid/List (`home-page.tsx:1011-1028`) and resources Transport (`resources-panel.tsx:539,553`) now carry `aria-pressed`; **still class-only**: users-panel role toggles (`app/features/org-settings/users-panel.tsx:275,278,410,413,646,653`) and the KB Re-index seg (`app/features/org-settings/resources-panel.tsx:105-110`) |
| UI-14 | LOW — bell popover claims more unread than it shows | **FIXED** | `BELL_LIST_CAP` + "Showing the newest N" disclosure (`app/features/shell/top-bell.tsx:23-28,148-154`) |
| UI-15 | LOW — hardcoded `"done"` stage id in two UI surfaces | **PARTIALLY-FIXED** | home now keys off the terminal stage, not the literal (`home-page.tsx:103-108`); **but** the org global-agent stage picker still filters `s.id !== "done"` twice (`app/features/org-settings/resources-panel.tsx:449,475`) against the stage-roles contract (`app/shared/workflow/stage-roles.ts:5-10`) |
| UI-16 | LOW — MCP "not health-checked yet" branch unreachable | **OBSOLETE** (ruled defensive) | every save/test writes `up = 0\|1` (`app/server/org/resources.server.ts:950-986,1026,1037`); the branch is kept for rows written outside Viberr and now says so in place (`resources-panel.tsx:872-874`) |
| UI-17 | LOW — `validation:"changed"` pill has no producer | **OBSOLETE** (audit premise wrong) | `deriveValidation` returns `"changed"` as its default branch — revision exists, required verdicts incomplete (`app/schemas/task-file.schema.ts:476-493`), invoked on real write paths (`app/server/tasks/task-actions.server.ts:1703`, `app/server/github/workspace-delivery.server.ts:379`); pass-13 ruling recorded in FINDINGS §E |
| UI-18 | LOW — `data-screen-label` on ~22 components, zero consumers | **STILL-OPEN** (deferred by ruling) | 32 occurrences remain across `app/**/*.tsx`, still no reader anywhere; pass-13 deferred it to "one repo-wide sweep" (FINDINGS §E) that has not happened |
| UI-19 | LOW — greeting uses the server timezone | **FIXED** | client recomputes from the local clock post-hydration, server value kept as SSR seed (`app/features/home/home-page.tsx:922-936`; loader still seeds at `app/routes/_index.tsx:45-47`) |
| UI-20 | LOW — `formatRelative` at client render (hydration + never ages) | **PARTIALLY-FIXED** | home adopted the new `useRelativeTime` (`app/ui/use-relative-time.ts`; `home-page.tsx:126`); **still render-time**: `store-browser.tsx:342` and `resources-panel.tsx:31-32` call `formatRelative` directly |
| UI-21 | LOW — "No project matches" while a matching pinned card shows | **FIXED** | empty message now requires `pinned.length === 0` too (`home-page.tsx:1136-1138`) |
| UI-22 | LOW — `overrideWaiting` hidden whenever `waiting > 0` | **FIXED** | pill renders alongside the personal count (`home-page.tsx:169-178`) |
| UI-23 | LOW — new-folder input commits on blur | **FIXED** | blur dismisses, Enter commits, Escape stays in the modal (`store-browser.tsx:249-267`) |
| UI-24 | LOW — org tile counts disagree with the panel it links to | **FIXED** | tile counts ALL accounts + separate `disabled` figure, matching the panel (`home-query.server.ts:305-337`) |
| UI-25 | LOW — SKILL.md cannot be cleared from the editor | **FIXED** | `clearBody` wired end-to-end (`resources-panel.tsx:318-320` → `org.settings.tsx:294` → `resources.server.ts:1227`) |
| UI-26 | LOW — largest UI files + shell had no component tests | **PARTIALLY-FIXED** | `home-page.test.tsx` (+213), `board-page.test.tsx` (+343), `shell-components.test.tsx` (+273), `notifications.test.tsx`, big task-detail additions all landed; **still none** for `routes/login.tsx` / `logout.tsx` (no route test file exists) |
| UI-27 | LOW — pass-12 residual bundle | **PARTIALLY-FIXED** | review lock chip is now a real `.btn ghost sm` with honest navigation + autonomy-aware copy (`review-page.tsx:121-144` — FIXED); **still open**: `public/favicon.ico` absent (`public/` holds only `favicon.svg`), Permissions panel prose still hand-maintained under "V1 rules" (`task-detail-page.tsx:298-332`), live roster still falls back to the raw profileId (`agents-page.tsx:671`) |
| UI-28 | HIGH — editor tells an admin to delete the operator's real MCP grant | **FIXED** | loader builds the OPERATOR catalog (superset) (`app/routes/project.agents.tsx:62-71`); the specialist picker filters the reserved `viberr` name per profile (`create-profile-modal.tsx:808-812`); `RESERVED_OPERATOR_MCP` shadowing guard (`resource-catalog.server.ts:54-55`) |
| UI-29 | HIGH — org-deleted users survive as members and satisfy the last-admin guard | **FIXED** | `pruneUserFromProjects` runs BEFORE identity deletion inside `deleteOrgUser` (`app/server/org/org-users.server.ts:304-349,378-380`); last-admin guard now counts LIVE enabled accounts via `countLiveAdmins` (`app/features/policy/policy-actions.server.ts:127-136`); residual ghosts render as "removed account" (`:82`; `membership.server.ts:79`); covered by `ghost-members.server.test.ts` |
| UI-30 | HIGH — raw run logs / wire envelopes / session ids served to non-members | **FIXED** | `runsVisible = member ∨ org-admin` (`app/routes/project.task.tsx:123`); non-members get `sid:null, raw:[]`, redacted lines (`:130-137`) plus an honest `logsWithheld` flag (`:200`); member payloads are additionally a bounded window paged via `/resources/run-log?before=` (`:125-129`) |
| UI-31 | MED — Appearance optimistic with no rollback | **FIXED** | pending-ref + rollback on failure, same contract as notifications (`app/features/profile/profile-page.tsx:318-369`) |
| UI-32 | MED — CSRF failure blows the app to the root boundary | **FIXED** | `csrfError`/`csrfResult` helper maps the thrown 403 to `{ok:false,error}` (`app/features/shell/csrf-result.server.ts:25-27`); adopted by `profile.tsx:62`, `notifications.read.tsx:25`, `prefs.theme.tsx:25-26` |
| UI-33 | MED — Escape unmounts the profile overlay before blur commits | **FIXED** | keydown commits BEFORE the dialog's cancel default (`profile-page.tsx:83-93`, wired `:141-155`) |
| UI-34 | MED — toasts render under `dialog::backdrop` | **FIXED** | toast host is a manual `[popover]` in the top layer (`app/ui/toast.tsx:70-78,117`) |
| UI-35 | MED — run-log tail duplicates lines (no in-flight guard / seq dedupe) | **FIXED** | `inFlight` set (`use-run-log-stream.ts:404-408`) + `l.seq > head` filter on append (`:434-437`) |
| UI-36 | MED — rejected (closed) PR renders like an open PR | **FIXED** | task pill now uses `prStatePill(task.pr.state)` with the closed branch (`task-detail-page.tsx:155-165`) |
| UI-37 | MED — "Update status" offered to viewers + pre-submit progress toast | **FIXED** | `canReconcile = roleCan(myRole, "reconcile-github")` gates both the control and the start toast (`app/features/github/github-view.tsx:365-374`) |
| UI-38 | MED — agent-logs failure copy keyed to viewer role, not the run | **FIXED** | copy derives from `cur.failedBackendUnavailable`; only the retry BUTTON needs the handler (`app/features/runtime/runs-panels.tsx:423-452,478`) |
| UI-39 | MED — assign/engage menus hide delivery/verdict capability | **FIXED** | `capabilities.{delivery,verdict}` on the client type (`app/features/task-detail/execution-profile.tsx:25-29`), non-delivery agents annotated (`:293`), verdict-gating reviewers badged "gates acceptance" with honest titles (`:397-422`) |
| UI-40 | MED — timeline "hasn't started" empty state on a filtered view | **FIXED** | branches `events.length === 0` vs filter-empty (`app/features/task-detail/timeline.tsx:469-472`) |
| UI-41 | MED — release dialog offers members who cannot own tasks | **FIXED** | `roleCan(m.role, "own-task")` filter (`app/features/task-detail/release-confirm.tsx:53`); chips disabled while `busy` (`:147,179`) |
| UI-42 | MED — `edit_goal` offered to an owner who cannot edit the goal | **FIXED** | `canEditGoal` blocks/annotates the option, mirroring `accept_completion` (`app/features/task-detail/decision-packet.tsx:83-88,173,239-242`) |
| UI-43 | MED — "Retrying on X · streaming" toast when nothing started | **FIXED** | run-id snapshot before `resolvePacket`; toast switches to "the retry could NOT start — the reason is on the timeline" when no new run exists (`app/routes/project.task.tsx:302-331`) |
| UI-44 | MED — decision-packet radiogroup: no roving tabindex, focus never moves | **FIXED** | `tabIndex={sel === i ? 0 : -1}` + rAF focus on move (`decision-packet.tsx:103-112,184`) |
| UI-45 | MED — popovers before their trigger, fake menu roles | **FIXED** | focus into the panel on open / restore on close for both (`top-bell.tsx:55-64`, `user-menu.tsx:92-93`); menu roles DROPPED with recorded rationale rather than half-implemented (`user-menu.tsx:121-129`) |
| UI-46 | MED — Activity actor filter page-level in appearance, Stream-only in effect | **FIXED** | seg moved into the Stream panel head with a scoped label (`activity-page.tsx:289-299`); audit panel now discloses it is deliberately unfiltered (`:125`) |
| UI-47 | MED — "N events" counts the loaded slice; Show-older goes no-op at the cap | **FIXED** | "N of M events (filtered)" (`activity-page.tsx:316-320`); remaining bounded by the reachable ceiling (`:262-269`); cap state discloses "Showing the newest N" (`:363-388`) |
| UI-48 | MED — board "Waiting on me" ≠ review "Waiting on your acceptance" | **FIXED** | layout loader unions decision-packets with the queue's acceptance-authority predicate (`app/routes/project.tsx:53-71`; `app/features/review/review-acceptance-authority.server.ts:12-39`) |
| UI-49 | MED — review queue hardcodes "Review"/"Done" stage names | **FIXED** | loader resolves and ships `stageNames` (`app/routes/project.review.tsx:50`); page renders them (`review-page.tsx:87,135-144`) |
| UI-50 | MED — "Eligible stages · 5 of 4" counts stages the board lost | **FIXED** | counter intersects board ids, `spanAll` honoured, stale ids render as explicit stale chips, zero-overlap gets its own honest state (`agents-page.tsx:223-251,280,293`) |
| UI-51 | MED — "N active tasks · one operator each" counts engagements | **FIXED** | relabelled to engagement language ("engaged on N active tasks" / "Not currently engaged") with the fix note in place (`agents-page.tsx:194-196,578,918-921`) |
| UI-52 | MED — backend chip list implies runtime choice; edit silently narrows 2→1 | **PARTIALLY-FIXED** | roster now discloses "· a run uses the first" (`agents-page.tsx:503-512`); **but** the editor half is unchanged: seeds `initial.backends[0]` (`create-profile-modal.tsx:774`) and persists `backends:[form.backend]` (`agent-profile-actions.server.ts:467`) with no in-modal warning — saving an unrelated edit to a seeded 2-backend profile still silently drops the second |
| UI-53 | MED — a resumed agent's earlier runs vanish from the console | **FIXED** | console pages backward through the agent's whole task history (`use-run-log-stream.ts:24-28`, `loadOlder`/`OlderLogState` `:36-47`); projection reports the real max seq (`run-projection.server.ts:249-252`) |
| UI-54 | LOW — notifications: do-nothing button rows, post-filter needs-you count | **FIXED** | rows are no longer `role="button"` (nested-interactive fixed) (`notifications-page.tsx:137-141`); needs-you split runs over EVERY item pre-filter (`notifications-page-helpers.ts:23,36`; rendered `:38,53`) |
| UI-55 | LOW — hardcoded ⌘K; one history entry per keystroke | **FIXED** | platform-aware `useModifierHint` (`topbar.tsx:10,185`; `app/ui/use-shortcut-hint.ts`); `replace: true` navigation (`topbar.tsx:84,92`) |
| UI-56 | LOW — shared fetcher strands a pending rollback | **FIXED** | Appearance gets its OWN fetcher, documented (`profile-page.tsx:309-311`) |
| UI-57 | LOW — misc task-detail/runtime residuals (7 items) | **FIXED** (1 sub-item ruled) | queued runs disclosed (`runs-panels.tsx:436-442`); unknown event types name the raw type (`event-meta.ts:43-44`); "finished" is ISO, client-formatted (`run-projection.server.ts:108-113`); `{ } raw`/`follow` + timeline tabs get `aria-pressed` (`runs-panels.tsx:495,504`, `timeline.tsx:365`); goal draft re-seeds from the current goal (`task-detail-page.tsx:450`); GitHub card carries a freshness cue (`task-detail-page.tsx:80-81,197,1201`). The unreachable Agent-logs empty state remains dead (panel still mounts only at `runtime.length > 0`, `task-detail-page.tsx:1401`) — ruled defensive-by-design in pass-13 FINDINGS §E |
| UI-58 | LOW — misc board/agents/policy residuals (7 items) | **PARTIALLY-FIXED** | fixed: ListView gets the StageMenu (`board-page.tsx:429-432`), Board/List seg a11y (`:688-703`), drag-gate uses `roleCan("reorder-board")` (`app/routes/project.board.tsx:96-105`), `"triage"` magic literal removed (`board-page.tsx:1143`). **Still open**: `?profile=` read once, never written back (`agents-page.tsx:754-759`; clicks only `setSel`, `:948,971`); Agents Profiles/Live seg still bare buttons, no `aria-pressed` (`agents-page.tsx:868-884`); policy member seg still gated on `edit-policy` while `set-role` enforces `manage-members` (`policy-page.tsx:496`); profile-modal submit still has no `aria-busy` (none in `create-profile-modal.tsx`); delete still jumps selection pre-submit (`agents-page.tsx:849-851`) |

### Still-open ledger (what pass 14 actually inherits)

- **UI-18** — `data-screen-label` sweep (32 occurrences), deferred by ruling.
- **UI-08** residual — silent all-dot-filtered upload (`store-browser.tsx:514`, `org.settings.tsx:342`).
- **UI-11** residual — second github.com literal (`task-detail-page.tsx:143`).
- **UI-13** residual — users-panel role toggles ×3, KB Re-index seg.
- **UI-15** residual — `"done"` literal ×2 in `resources-panel.tsx:449,475`.
- **UI-20** residual — render-time `formatRelative` in store-browser/resources-panel.
- **UI-26** residual — login/logout route tests.
- **UI-27** residual — favicon.ico, Permissions-panel prose, roster raw-profileId fallback.
- **UI-52** residual — silent backend narrowing on edit.
- **UI-58** residual — 5 of 7 sub-items (see row).

---

## 3. Section B — fresh sweep of pass-13's new surfaces

Checked: the template library, in-app KB authoring, the store browser, MCP
handshake/tool-count surfacing, the capability matrix, note-vs-policy events,
humanised observation keys, the screenshot record, plus an inert-control /
optimistic-update / vocabulary-drift pass over the new code.

**Clean:** LibraryPicker deploy closes only on success and error-toasts otherwise
(`agents-page.tsx:805-827`); "Add from library" is `manage-agents`-gated on both
sides (`agents-page.tsx:757,890`; canonical server guard in
`agent-profile-actions.server.ts:105-108`); the capability matrix discloses
Claude-only enforcement honestly, tooltip included ("On Codex it is advisory
only — the Codex SDK ignores tool allow/deny lists") (`capability-matrix-modal.tsx:156-170`,
`app/shared/capabilities.ts:180-206`); MCP rows never fabricate tool counts and
carry a stale-retest badge off the shared freshness module
(`resources-panel.tsx:26,842-875`, `app/shared/freshness.ts`); toast failures
now render an alert icon, not a check (`app/ui/toast.tsx:134`); observation keys
humanise with a total fallback (`decision-packet.tsx:49-51`); the screenshot
record's 25 surfaces all exist on the current route set. No new inert control
found.

| id | sev | headline | evidence | confidence |
|---|---|---|---|---|
| UI-59 | **MED** | **"New document" silently overwrites an existing file of the same name.** `writeStoreDoc` is create-or-overwrite by design (docstring says so) — `writeFileSync(abs, body)` with no existence check — and the UI has no confirm, no "will replace" disclosure, and a neutral toast ("`facts.md` saved — N bytes") identical for create and clobber. Authoring `facts.md` in a KB that already has one destroys the old content with a success toast; there is no undo. Delete in the same module confirms; overwrite does not. | `app/server/org/store-files.server.ts:366-401` (esp. `:367-368,401`); UI `app/features/kb-browser/store-browser.tsx:771-787`; toast `app/routes/org.settings.tsx:357-368` | high (code-verified write path; not live-run) |
| UI-60 | **MED** | **The document editor closes optimistically on Save, discarding the typed body on rejection.** "Save document" submits and immediately `setDoc(null)`; server-side validation that the client never pre-checks (non-text extension — `EDITABLE_EXTENSIONS` — or an expired session/CSRF) then error-toasts AFTER the user's content is unrecoverably gone. The create-profile modal in the same pass does it right (stays open with `formError` on failure). | `store-browser.tsx:775-783` (submit + `setDoc(null)` same tick); server rejects at `store-files.server.ts:386-394`; correct pattern `agents-page.tsx:814-822` | high |
| UI-61 | LOW-MED | **In-app KB authoring is create-only and its read path is dead code.** `readStoreDoc` ("Read one store text doc for the editor") has zero product consumers — only its own test — so no existing doc can be opened or edited in-app. Fixing a typo in a doc you just authored means re-typing the whole file under the same name, which lands on the silent-overwrite path (UI-59). The LV-06 ruling ("a KB cannot be authored in the app") is half-delivered: write yes, edit no — and the shipped-but-unwired reader shows the edit half was intended. | `store-files.server.ts:350-364` (definition); consumers: only `store-files.server.test.ts:23,404+` — no route/feature caller | high |
| UI-62 | LOW | **The new `note` event type never made it into the Activity stream's vocabulary.** Pass 13 (W0, `357249f`) added `note` to `TIMELINE_EVENT_TYPES` and moved benign emitters (e.g. "Goal updated") off `policy` precisely so they stop looking alarming — but `ACT_ICON` on the Activity page has every type EXCEPT `note`, so note events take the unknown-type `dot` fallback, and the tint class the row emits (`act-note`) does not exist in `app.css` (only `act-comment/completion/github/policy/quality…`). The de-alarmed events render typeless/unstyled in the one cross-task feed members triage. | type: `app/schemas/task-file.schema.ts:47-58` (`:52`); map: `app/features/activity/activity-page.tsx:78-88` (+ fallback `:329`); CSS: `app/app.css:1808-1812` has no `.act-note`; task-timeline handles it fine (`event-meta.ts:27-28`) | high |
| UI-63 | LOW | **"Add from library" asserts an org-template stage count without intersecting the target board.** The picker pill renders `t.stages.length + " stages"` straight from the template (`stages: template.stages`, no board filter), so on a project whose stages were renamed/removed the row can promise "2 stages" that are 0 here — and immediately after deploy, the roster (UI-50's fix) correctly reports "None of this profile's eligible stages exist on this board". Two surfaces of the same flow contradict each other one click apart. | pill: `agents-page.tsx:369-375`; data: `agents-query.server.ts:206-215` (`:213`); post-deploy honest state: `agents-page.tsx:290-295` | high (mismatch requires per-project stage divergence to manifest) |

---

## 4. Method note

Every verdict was established by reading the current source at `fa138e1` —
mechanism, not commit message (the pass-13 FINDINGS table's "OPEN" rows for
UI-01..58 are a discovery-time snapshot the implementation overtook). One
repo quirk worth recording: `app/features/runtime/use-run-log-stream.ts`
contains literal NUL bytes (deliberate `\0` separators in composite-key template
strings, e.g. `` `${projectSlug}\0${taskKey}` ``), so plain `grep` treats it as
binary — use `rg -a` / `grep -a` when auditing that file.
