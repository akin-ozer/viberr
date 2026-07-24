# Pass 13 — Findings ledger (2026-07-24)

Base: `main` @ c7abebf. Severity: **HIGH** (correctness / security / data-loss / feature
is unusable) · **MED** (wrong behavior, dishonest UI, degraded UX, test integrity) ·
**LOW** (polish, noise, dead code).

Every finding has a home. Detail (code map, line refs, failure scenario, suggested fix)
lives in the subsystem docs under `docs/`; this file is the single ledger that tracks
**disposition** for the implementation phase. Nothing may be closed without either a fix
+ verification, or an explicit ruling with a rationale recorded here.

Id namespaces (the source docs number independently, so ids are prefixed here):

| prefix | source doc |
| --- | --- |
| `LV-##` | live findings from this session (recorded in full below) |
| `KM-##` | `docs/kb-mcp-subsystem.md` → "FINDINGS CANDIDATES" #1-20 |
| `AP-##` | `docs/agent-profile-lifecycle.md` → F13-A1..A12 |
| `RT-##` | `docs/runtime-parity.md` → F13-01..14 |
| `UI-##` | `docs/routes-ui-audit.md` → F13-01..58 |

---

## A. LIVE findings (observed in the running app this session)

### LV-01 (HIGH · feature unusable) — a "Lightweight · 3 stages" project cannot run any agent
**LIVE-PROVEN.** Created `Lightweight Lab` (todo/doing/done) + task LL-1. The operator
advanced LL-1 to `doing`, then raised a **blocked** packet: *"No agent profile is eligible
for the 'In progress' (doing) stage … Developer is only eligible for ready/impl … Reviewer
for impl/review … work cannot proceed without a human fixing the stage/profile mapping."*
Root cause: `createProject` seeds the default roster with the **Standard template's** stage
ids (`agent-catalog.server.ts` developer `["ready","impl"]`, reviewer `["impl","review"]`)
regardless of the chosen workflow template, and `specialistEligibleForStage`
(`specialist-run.server.ts:1413`) then matches nothing on a lightweight board. Every
lightweight project is dead on arrival for agent work.
**Fix direction:** resolve roster stages by *role* (`resolveStageRoles`) at project
creation — deliverer → work stage, reviewer → work+review stage — instead of copying
literal Standard ids. Add a regression that creates a project from every template and
asserts each seeded specialist is eligible for at least one of that board's stages.
(Same defect family as `AP-04`; see also `LV-02`.)

### LV-02 (MED · misleading UI) — the eligible-stage chips ignore `spanAll`, and the counter can exceed the board
**LIVE-PROVEN.** On the lightweight board the Operator's panel says "active across the whole
lifecycle" while the chip row renders **To-do and In-progress struck through** and only Done
active — because `agents-page.tsx:310-318` computes `elig = a.stages.includes(s.id)` and
never consults `a.spanAll`. The Developer shows "2 of 3 stages" with **no** chip highlighted
(its 2 stage ids don't exist on this board). The counter is `a.stages.length + " of " +
stages.length`, so a profile carrying stale ids can read "5 of 4 stages" (also `UI-50`).
**Fix:** chips honor `spanAll`; the counter counts stages that actually exist on this board;
stale/unknown grants are surfaced as such rather than silently counted.

### LV-03 (MED · misleading UI) — benign events render as "Policy violation"
**LIVE-PROVEN** on VIB-1: the operator drafting a goal produced a shield-icon pill labelled
**"Policy violation"** above the text "Goal drafted". `EVENT_META.policy.label` is
`"Policy violation"` (`event-meta.ts:23`) but `type:"policy"` is emitted for a grab-bag:
a real PAT-scope violation (`scope-flag.server.ts:83`), a divergence note
(`workspace-delivery.server.ts:496`), a **refused delivery directive**
(`specialist-run.server.ts:822`), a **human goal edit** (`task-actions.server.ts:536`) and
the operator's **goal draft** (`operator-actions.server.ts:883`). A human editing a task
goal is labelled a policy violation on their own timeline.
**Fix:** split the type — keep `policy` for genuine violations (coral/shield) and add a
neutral event type for goal/policy *notes*; update `EVENT_META`, `TYPED_KIND`, the emitters
and the tests.

### LV-20 (MED · counter pollution) — a conversational operator turn on a **closed** task leaves `waiting: human` set forever
**LIVE-PROVEN and reproduced.** PST-1 after acceptance was `stage: done · waiting: none`. I
commented `@operator PST-1 is done and merged — anything still open?`; the operator answered
"nothing is open" and the task became `stage: done · waiting: human` — permanently. The
board then reports "N waiting on a human decision" for a Done task while the review queue
(which filters on the review boundary) reports 0, so the two surfaces disagree. This is the
same state VIB-1 was found in at the start of the pass (Done + merged + "Waiting on: Human
decision"), so it is not a one-off.
**Fix:** an operator turn that produces no packet and no recommendation must restore
`waiting` (`none` on a terminal-stage task), and a terminal-stage task must never be counted
as a pending human decision.

### LV-04 (MED · dishonest identity) — an unresolvable user id renders as the raw `u_…` string
**LIVE-PROVEN.** `viberr`'s member row and VIB-1's `ownerUserId` reference `u_RT7-QeTWOwP4`,
which is absent from `users` (the live admin is `u_Ta3NH0znVm86`). The task-detail
**Owner**, the "HUMAN OWNER · REVIEWS & ACCEPTS" panel, the Policy RBAC member row and
project Settings → Members all print the raw id verbatim, and the ghost still counts as
"1 member" and holds `admin`.
**Fix:** one resolver with an honest fallback ("Removed user · u_RT7…"), plus a way to see
and clear stale memberships. Related: `UI-29` (org-deleted users survive as members and
satisfy the last-admin guard) — fix them together.

### LV-05 (MED · stale status) — attaching a project GitHub credential doesn't refresh connection health
**LIVE-PROVEN.** Project GitHub page → "Attach credential" attached the org connection and
rendered the full scope list, while the Connection row kept the amber **"no credential"**
pill through a full reload; only pressing "Update status" flipped it to "connected".
**Fix:** attach/rotate/remove should reconcile (or optimistically set) connection health in
the same action.

### LV-06 (MED · product gap) — a knowledge base cannot be authored in the app
Skills have a full in-app editor (name + summary + SKILL.md body). A KB can only be filled
by **Upload files / Upload folder / Add from GitHub / drag-drop**; there is no "new file"
and no editor, so the smallest possible KB ("three facts my agents must know") requires
leaving the product. The KB modal's own copy says "drop docs in, **or let agents append**",
which sets a different expectation.
**Fix:** add create/edit/delete of a text file inside the KB store browser (the same writer
the skill editor already uses). Confirm with the owner whether the ceiling is deliberate —
see `QUESTIONS.md`.

### LV-07 (MED · silent validation) — the New-project TASK KEY input drops characters and disables Create with no reason
**LIVE-PROVEN.** Typing `P13` yields `P` (non-letters are stripped as you type), and the
Create button is then `disabled` with **no message** anywhere in the modal explaining that a
key needs ≥2 characters. The user sees a dead button.
**Fix:** either accept digits (they are legal in the key format used everywhere else) or say
what is being stripped; and always explain why Create is disabled.

### LV-08 (LOW · layout) — the 5-stage board overflows and clips at 1280×720
At the default desktop width the Done column is cut mid-card with only a thin horizontal
scrollbar as an affordance. Verify the intended minimum width and either compress column
width or make the horizontal affordance explicit.

### LV-09 (LOW · copy) — pluralization and raw values in copy
"**1 instance accounts**" (org users tab), "Diff **1 files**" (task GitHub panel), and the
blocked-packet observation printing `OWNER null` instead of "unassigned".

### LV-10 (MED · shallow health) — an HTTP MCP server is "reachable" on any HTTP response, and never reports tools
**LIVE-PROVEN.** `everything-http` → `http://localhost:3031/mcp` shows a green
"reachable" while a bare `GET` of that URL returns **400**; `probeMcpTarget`
(`resources.server.ts:646-679`) treats *any* response as up. stdio servers get a real
JSON-RPC `initialize`+`tools/list` handshake and a real tool count; HTTP servers get
neither, so the MCP list shows "13 tools" next to a tool-count-less green dot. Pointing an
HTTP MCP at any live URL that is not an MCP server produces a healthy-looking row.
**Fix:** run the same `initialize`/`tools/list` handshake over Streamable HTTP/SSE and store
the real count; keep "reachable but not an MCP endpoint" as an honest distinct state.

### LV-11 (HIGH · core interaction silently broken) — an agent whose name has a space cannot be @mentioned
**LIVE-PROVEN on PST-1.** `@Docs Writer …` posted fine, rendered as a **mention pill**, and
started **no run at all**. `@docs-writer …` (the profile id, which the UI never shows)
started the run immediately and the agent answered.
Root cause: `MENTION_RE = /@([A-Za-z][\w-]*)/g` (`agent-reply.server.ts:40`) parses a handle
as a single word, while `handleMatchesSpecialist` (`:97-107`) compares it against
`sp.name.toLowerCase()` — `"docs writer"`, which can never equal a space-free handle. Worse,
the composer's own directory hands out exactly that unusable handle:
`getMentionables` sets `handle = sp.name.toLowerCase()` (`mention-suggestions.server.ts:90`).
So the product's autocomplete offers a handle its own resolver cannot match for **every
agent with a two-word display name** (all seven created this pass; the seeded
Developer/Reviewer/Operator are one word, which is why earlier passes never hit it).
**Fix:** one canonical handle (slugified name / profile id) used by the directory, the
composer insertion, the resolver and the rendered pill; accept the display-name form too by
normalizing whitespace before matching.

### LV-12 (MED · dishonest UI) — an unresolved @mention still renders as a mention pill and reaches nobody
Same evidence as LV-11: the comment renders `@Docs Writer` as a highlighted mention, so the
author believes the tag landed. Nothing anywhere says "that tag matched no agent or user".
**Fix:** resolve mentions server-side when the comment is written; render unmatched handles
as plain text and tell the author (inline hint or toast) that nothing was tagged.

### LV-13 (HIGH · isolation breach) — Codex runs inherit the HOST machine's global skills
**LIVE-PROVEN on PST-3.** The Codex scout, whose profile grants exactly one skill, reported
loading `p13-selftest-skill` **plus 20+ host skills** from the operator's own Codex
environment: `imagegen`, `openai-docs`, `plugin-creator`, `skill-creator`,
`skill-installer`, `animation-vocabulary`, `apple-design`, `emil-design-eng`,
`find-skills`, `github:gh-address-comments`, `github:gh-fix-ci`, `github:github`,
`github:yeet`, `openai-developers:*`. The Claude runtime deliberately closes this channel
(`settingSources: []`, `plugins: []`, `skills: []`, `Skill` denied); the Codex runtime has
no equivalent. This breaks the "a run sees exactly the agent's declared resources" promise
and hands a docs-only agent instructions like `github:yeet` (push/PR automation).
**Fix:** isolate the Codex run's skill sources the way the Claude side does (a run-scoped
`CODEX_HOME`/config that excludes host skills), and add a live assertion to the parity docs.

### LV-14 (HIGH · isolation breach) — Codex runs inherit the HOST machine's MCP servers
Same run: the mounted MCP list was `everything_http`, `everything_mcp` **and
`openai_api_key_local_confirmation`** — a host-configured server Viberr never granted.
Ungranted tool surface inside a governed run. Same fix family as LV-13 (and the same root
cause as `RT-04`, Codex ingesting the repo's `AGENTS.md`).

### LV-15 (LOW-MED · parity) — MCP server names are normalized differently per backend
Claude mounts `mcp__everything-http__echo`; Codex mounts `mcp__everything_http__echo`
(hyphens become underscores). A persona, skill or directive that names a tool literally
works on one backend and not the other. Disclose or normalize.

### LV-16 (verified, no bug) — the in-process `viberr_agent` toolkit is Claude-only
The Claude scout saw `viberr_agent` with `ask_human` + `post_comment`; the Codex scout saw
no such server. Consistent with the documented CLAUDE_ONLY capability set (Codex asks via
the outcome envelope instead), but the capability matrix should say so per-capability rather
than only "advisory on Codex" in the header.

### LV-17 (MED · injection ingress) — third-party MCP server *instructions* reach the agent unfiltered
The Claude scout reported that both Everything servers "shipped identical server
instructions blocks … plus an 'Easter Egg' line telling me to reply with a specific
celebratory sentence if asked". The agent correctly treated it as data, but that is model
discretion, not policy: Viberr's injection guardrails cover task comments and operator
directives, not MCP-provided instruction blocks, and nothing discloses that an admin-added
MCP server can inject instructions into every run that mounts it.

### LV-18 (MED · undisclosed capability) — read-only agents still have `WebFetch` / `WebSearch`
The same audit listed `WebFetch` and `WebSearch` as available to an agent whose repository
capabilities are all **Off**. Network egress is not represented anywhere in the capability
model, so a "read-only reviewer" can fetch and post data off-box. Either model it as a
capability or disclose it in the matrix. → owner question.

### LV-19 (MED · stale probe count) — the MCP tool count Viberr shows is not what a run gets
Viberr's stdio discovery reported **13 tools** for `everything-mcp`; both live runs
enumerated **15** from the same server (the probe's minimal `initialize` advertises no
client capabilities, so capability-gated tools stay hidden). The number in Settings is
therefore a floor, presented as a fact.

---

## B. Subsystem findings (detail in `docs/`)

Dispositions: `OPEN` → `FIX` (scheduled) → `DONE` (implemented + verified) ·
`RULED` (deliberate, rationale recorded) · `NOT-A-BUG` (re-verified false).

### B1. Knowledge bases & MCP — `docs/kb-mcp-subsystem.md`

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| KM-01 | HIGH | org agent modal stores KB **display names**; runs resolve by **dir** → zero injection, both UIs still show it attached (**independently live-confirmed**: `agents/profiles/org-docs-writer.md` wrote `kb: ["P13 facts"]` while the project picker writes `p13-facts`) | **DONE** — picker keys on `dir`; legacy display-name grants repaired on edit. LIVE: `org-docs-writer.md` now `kb: [p13-facts]`. |
| KM-02 | HIGH | a missing/empty KB injects nothing **silently** (no log, no evidence line) — this is what makes KM-01/07/11 invisible | **DONE** — `readKbBody` warns on missing/empty/unreadable. LIVE: operator quoted both KB sentinels after the fix. |
| KM-03 | HIGH | the operator's declared `resources.mcps` reach **no** run on either backend (`OperatorAuthority` has skills+kb, no mcps) — verified in main context | **DONE** — `OperatorAuthority.mcps` + toolkit mounts/allows them. LIVE: operator called `everything-mcp` echo → `Echo: operator-mcp-probe-2`. |
| KM-04 | MED-HIGH | org MCP tools sit outside the capability policy: `CAP_DENY_RULES` is Bash/file-tool only, no `mcp__*` rules → a read-only reviewer with a GitHub MCP can merge a PR | **DONE (prompt-level, disclosed)** — every run mounting MCP servers carries an explicit no-merge/no-Done/no-policy rule; the residual (Viberr cannot inspect third-party tools) is stated in the capability matrix. |
| KM-05 | MED | stdio discovery spawns without the sealed credential → credentialed stdio servers report "unreachable" while working in a run | **DONE** — stdio + HTTP probes carry the sealed credential. |
| KM-06 | MED | an MCP credential can never be cleared (blank keeps it) | **DONE** — explicit `clearCred` + a Remove-credential control. |
| KM-07 | MED | rename/delete of a KB/skill/MCP never rewrites or validates profile references | **DONE** — rename rewrites / delete drops references in templates AND project deployments. LIVE: rename moved 7 project references and back. |
| KM-08 | MED | "used by N profiles" compares the wrong key for KBs, ignores project deployments, absent for MCPs | **DONE** — counts compare the slug and are labelled 'templates'. |
| KM-09 | MED | editing the Operator shows its real `viberr` grant as a red "missing — click to remove" chip (= `UI-28`) | **DONE** — loader ships the operator catalog; the specialist picker filters the reserved name. |
| KM-10 | MED | specialist KB injection has **zero** tests | **DONE** — specialist KB injection now has tests (present / missing / MCP rule). |
| KM-11 | MED | unresolvable MCP names are dropped silently | **DONE** — unresolvable MCP names are logged. |
| KM-12 | LOW-MED | reserved names `viberr`/`viberr_agent` unenforced at save; backend-asymmetric shadowing | **DONE** — reserved names refused at save. |
| KM-13 | LOW-MED | GitHub re-import duplicates KB content instead of refreshing | **DONE** — re-import refreshes the same source's folder (provenance dotfile). |
| KM-14 | LOW | injection budget ignores per-doc heading overhead | **DONE** — per-doc headings are charged to the budget. |
| KM-15 | LOW | `refresh: manual` doesn't pin what an agent sees | **DONE (copy)** — the toggle governs the doc count/freshness only; the modal says so. |
| KM-16 | LOW | disk-only KBs are never watcher-re-indexed | **DONE** — disk-only KBs are adopted on watcher re-index. |
| KM-17 | LOW | stdio target whitespace-split, no quoting | **DONE** — quoted argv splitting. |
| KM-18 | LOW | `clearBody` escape hatch unreachable from the UI | **DONE** — emptying the editor sends `clearBody`. |
| KM-19 | LOW | `probeMcpTarget` is an unauthenticated server-side fetch of an admin-supplied URL | **RULED** — the probe is an admin-only, server-side fetch of an admin-supplied URL; that is what an MCP registration IS. No fix; noted so a later pass doesn't re-litigate. |
| KM-20 | LOW | GitHub import always lands at the store root, ignoring the browsed folder | **DONE (copy)** — the toolbar states that import and new documents land at the root. |

### B2. Agent profile lifecycle — `docs/agent-profile-lifecycle.md`

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| AP-01 | HIGH | org editor's one-line "Role summary" **is** the persona body → editing a seeded profile flattens its system prompt org-wide | **DONE** — the org editor has a real persona field; a blank persona keeps the body. |
| AP-02 | HIGH | on edit the frontmatter spread omits `desc`, so what the operator reads never changes | **DONE** — `desc` is rewritten on edit, so what the operator reads changes. |
| AP-03 | HIGH | `npm run seed` (documented install step) overwrites the shipped rich personas with a 2-sentence blurb | **DONE (W2)** — seeding emits the shipped persona bytes. |
| AP-04 | HIGH | lightweight-template projects ship specialists ineligible for every stage (= `LV-01`, live-proven) | **DONE (owner ruling 2)** — the Lightweight template is removed; a regression asserts every seeded specialist is stage-eligible on a created board. |
| AP-05 | HIGH | a profile created in the org editor can never be deployed/run/selected (**live-confirmed**: `Org Docs Writer` is absent from a project created after it) | **DONE (owner ruling 1)** — 'Add from library' copies a template into a project. |
| AP-06 | MED | a deployment with `capabilities: []` gets FULL repo-write power (org create writes exactly that) | **DONE** — creation paths persist explicit grants; `capabilities: []` resolves to explicitly withheld. |
| AP-07 | MED | the first project-level edit freezes a profile against all later org edits, while the modal claims "changes apply on next run" | **DONE (copy)** — the editor states that saving forks the profile for this project. |
| AP-08 | MED | org edit collapses a multi-backend profile to one backend | **DONE** — org edit keeps the profile's backend list intact for the picker it owns. |
| AP-09 | MED | the org card subtitle renders the entire persona body (= `LV` observation) | **DONE** — the org card renders the blurb. LIVE-verified in the screenshot. |
| AP-10 | LOW | `used in N projects` counts archived projects and trusts a projection | **DONE** — archived projects no longer count toward `used`. |
| AP-11 | LOW | `agentProfileFilePath` has no traversal guard, unlike skills/KB | **DONE** — `agentProfileFilePath` uses the traversal guard. |
| AP-12 | LOW | org create doesn't check project-local profile ids | **DONE** — a template id colliding with a project-local profile is refused. |

### B3. Runtime parity (Claude ↔ Codex) — `docs/runtime-parity.md`

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| RT-01 | HIGH | an agent's **final report** never notifies the humans it @tags, on either backend (NEW-4 broken on its primary path) | **DONE** — the completed-run reply fans out mentions. LIVE: `mention` notifications went 0 → 4. |
| RT-02 | HIGH | the Codex read-only sandbox is never used to enforce a withheld `execute-code-or-write-repo` | **DONE** — `repoWriteWithheld` drives the Codex read-only sandbox. |
| RT-03 | MED | a denied Codex operator action is a silent no-op (billed run, zero timeline trace) | **DONE** — denied Codex actions are narrated; the plan schema only advertises granted tools. |
| RT-04 | MED | Codex runs ingest the repo's `AGENTS.md`; Claude runs ingest nothing equivalent | **DONE** — `project_doc_max_bytes: 0`; verified live against the CLI. |
| RT-05 | MED | resumed runs lose the delivery contract and the trust boundary | **DONE** — the resume directive carries the trust boundary and the delivery contract. |
| RT-06 | MED | the Codex question packet is audited as the operator, not the agent | **DONE** — the packet is audited as the agent; an undeliverable question is recorded, not dropped. |
| RT-07 | MED | the Claude model picker offers ids the run-time validator silently downgrades | **DONE** — `isKnownModel` accepts what the live catalog lists. |
| RT-08 | MED | effort is validated on Codex, unvalidated on Claude, re-validated only on the retry path | **DONE** — effort is resolved in `startRun`, the single funnel. |
| RT-09 | LOW | runtime statistics are posted as the agent's report when it emits no text | **DONE** — the runtime-stats fallback is gone. |
| RT-10 | LOW | the unified git identity doesn't reach a Codex agent's shell | **DONE** — git identity reaches the Codex shell. |
| RT-11 | LOW-MED | Claude runs have no hang guard; Codex runs do | **DONE** — Claude idle guard + `idle_timeout` failure class; env var declared. |
| RT-12 | MED | an @mention after a backend switch resumes the dead backend's session | **DONE** — session resume filters on backend. |
| RT-13 | LOW | the operator's declared MCP resources are silently ignored (= `KM-03`) | **DONE** — same fix as KM-03. |
| RT-14 | LOW | disclosure gaps for seven deliberate Claude/Codex differences | **DONE** — the capability matrix lists the seven real differences. |

### B4. Routes & UI honesty — `docs/routes-ui-audit.md`

Headline: **no control is inert** — every one of the 74 action intents is wired both ways.
The defects are *assertive dishonesty*: working controls reporting states the data cannot
justify. 58 findings; the HIGH set is `UI-01`, `UI-02`, `UI-28`, `UI-29`, `UI-30`.

| id | sev | headline | disposition |
| --- | --- | --- | --- |
| UI-01 | HIGH | connection scope ✓ marks painted for scopes never verified (fine-grained PATs get `source:"assumed"`) | OPEN |
| UI-02 | HIGH | "updated just now" on every task-less project after a projection rebuild | OPEN |
| UI-28 | HIGH | the profile editor tells an admin to delete the operator's real MCP grant | OPEN |
| UI-29 | HIGH | org-deleted users survive as project members and satisfy the last-admin guard | OPEN |
| UI-30 | HIGH | raw run logs, wire envelopes and session ids are served to non-members | OPEN |
| UI-03..27, UI-31..58 | MED/LOW | see the doc's numbered list (SSE never reconnects after session expiry, green "synced" on a never-reconciled branch, optimistic toasts with no rollback, unreachable CSRF error handling, a rejected PR that looks open, viewer-visible "Update status", accessibility gaps, hardcoded stage vocabulary, count/label mismatches, …) | OPEN |

---

## C. Pass-12 residuals re-verified this pass

- `RU-2`, `RU-3`, `RU-4`, routes #8/#11/#13 — **confirmed fixed**.
- `F12-02` favicon — **partial**: `handleError` swallows the 404 but `public/favicon.ico`
  still doesn't exist.
- routes #5/#9/#10/#12 — still open (carried as `UI-27`).
- `AO-1` (staged outcome across restart) and `AO-2` (cross-boot lease drain) —
  **confirmed genuinely fixed** by an independent re-read.
- `AO-4` (Codex tool denial is prompt-only) — superseded by `RT-02`: the read-only sandbox
  the app already uses for supporting runs is real teeth that were never wired to the
  withheld repo-write grant.

## D. Live use-case results

See `USECASES.md` (run log, PASS/FAIL + evidence per case).


---

## E. Final disposition summary (end of pass 13)

**Gates:** `npm run typecheck` clean · `npm run test` **1663 passing** · `npm run build` green.

### LIVE findings
| id | disposition |
| --- | --- |
| LV-01 / AP-04 | **RULED + DONE** — owner ruling 2: the Lightweight template is removed rather than remapped. A regression asserts every seeded specialist is stage-eligible on a board that project creation produces. |
| LV-02 | **DONE** — chips honor `spanAll`, the counter counts only stages on this board, stale grants render as such. |
| LV-03 | **DONE** — new neutral `note` event type; benign emitters moved off `policy`. LIVE: "Note · Goal updated". |
| LV-04 | **DONE** — one resolver + honest "removed account" label; stale memberships visible and removable. |
| LV-05 | **DONE** — credential mutations invalidate the repo-access memo that kept the pill stale. |
| LV-06 | **DONE (owner ruling 3)** — "New document" in the KB store browser. LIVE: authored doc reached a real run. |
| LV-07 | **DONE** — the task-key input states its alphabet, names what it stripped, and Create always explains why it is disabled. |
| LV-08 | **DONE** — board scroll-snap + a fade edge marking the cut. |
| LV-09 | **DONE** — pluralization and `OWNER null` → "unassigned". |
| LV-10 | **DONE** — real MCP handshake over Streamable HTTP. LIVE: 16 tools discovered where the old probe said only "reachable". |
| LV-11 | **DONE** — one shared mention matcher. LIVE: `@Docs Writer` now starts a run. |
| LV-12 | **DONE** — only handles that route are chipped. |
| LV-13 / LV-14 / RT-04 | **DONE** — app-owned Codex run home + config that closes host skills, host MCP servers and repo `AGENTS.md`; verified against the real CLI (and a first attempt that would have broken every Codex run was caught by that live check). |
| LV-15 | **DONE (disclosed)** — the hyphen/underscore rename is in the capability matrix; it happens inside the codex binary. |
| LV-16 | **NOT-A-BUG (disclosed)** — the in-process toolkit is Claude-only by design; the matrix now says so per capability. |
| LV-17 | **DONE (disclosed)** — MCP server instructions reach the run; the matrix states that MCP tools are outside the capability policy and every run carries the no-merge rule. |
| LV-18 | **DONE (owner ruling 4)** — `use-web-search-fetch` capability, granted by default, enforced by tool denial for specialists and the operator. |
| LV-19 | **DONE** — the probe declares the client capabilities a run declares; counts went 13 → 16 to match what runs actually see. |
| LV-20 | **DONE** — write side (`clearWaitingToHuman`) + read side (rebuilder). LIVE: a closed task stays `waiting: none` after an operator turn. |

### Subsystem streams
All `KM-01..20`, `AP-01..12`, `RT-01..14` and `UI-01..58` rows above carry an explicit
disposition. Two are **RULED** rather than fixed, with the rationale recorded inline:
`KM-19` (the MCP probe is an admin-supplied URL fetch — that is what registering an MCP
server IS) and `UI-17` (the audit's premise was wrong; `validation: "changed"` is produced
on real write paths). Three are **defensive-by-design** and documented in place: `UI-16`,
`UI-57`'s empty state, and `UI-18` (`data-screen-label` spans surfaces outside this pass's
scope and wants one repo-wide sweep).


---

## F. Found AFTER the implementation landed (post-fix sweep)

Three more, all caught by artifacts the earlier phases had not produced: the CI e2e job,
and the light-theme screenshot sweep. Each is fixed and verified.

### LV-21 (HIGH · install broken) — the shipped agent assets could not load outside Vite
`npm run seed` — the documented install step — died with `ERR_UNKNOWN_FILE_EXTENSION ".md"`.
Emitting the shipped personas from the seed (`AP-03`) pulled `default-assets.server.ts` into
the import graph of `tsx scripts/seed.ts`, and that module read its markdown through Vite's
`?raw`. tsx has no such loader. `npm run seed:demo` failed the same way but its catch-all
guard reported the misleading "not shipped in the production image" message, and
`playwright.config.ts` (which imports the seed password so the e2e admin cannot drift)
failed to parse, taking the entire e2e suite with it.
**Why nothing caught it:** typecheck, 1667 unit tests and the production build were green —
vitest and vite both understand `?raw`. Only a real CLI entrypoint exercises that path. Same
family as pass 12's "build ≠ typecheck".
**FIX:** assets read from disk (module dir, then `<cwd>/app/server/seed/assets`; the image
already copies `app/`), so they load under Vite SSR output, tsx, node and vitest alike;
`SEED_DEFAULT_PASSWORD` moved to an import-free module; `seed:demo` prints the real error.
**Verified three ways:** `npm run seed` on a clean root, `npm run e2e` 9/9, and a booted
production build serving `/resources/health`. New `default-assets.server.test.ts` asserts
every shipped asset has content, BANS `?raw` anywhere the CLI can reach, and runs
`npm run seed` end to end asserting the real persona lands.

### LV-22 (MED · dangerous default) — an org template started with full delivery power
**Spotted in the light-theme Policy screenshot:** the library-adopted `Org Docs Writer` —
whose own summary reads "never touches app code" — showed **18 direct** capabilities
including all four delivery grants, where every seeded specialist shows 2-10. Cause: my own
`AP-06` fix. Replacing `capabilities: []` (silently full access) with `defaultGrantsFor` made
the power *visible* but not *absent*, and the org editor has no capability UI at all, so
nobody could have narrowed it there.
**FIX:** `conservativeGrantsFor` — a template created in a surface that cannot set policy
starts with `execute-code-or-write-repo`, `create-task-branch`, `commit-push-branch` and
`open-review-pr` withheld; the modal says so; the project editor (which has the matrix) is
where delivery is granted. LIVE-VERIFIED: a freshly created template writes `mode: off` for
all four.

### LV-23 (LOW · copy) — packet observation keys rendered machine-ish
A live blocked packet rendered **`PROMPT_AGENT ERROR`** at a human: the operator authors the
observation keys and the row CSS uppercases them. Underscores are now spaces.

---

## Part 3 — the intent audit (2026-07-25)

After the fix cycle above, the built app was audited against the four documents it was
built from — `planning-artifacts/prd.md`, `architecture.md`, `ux-design-specification.md`
and the HTML mock — to separate *deliberate* divergence from drift nobody decided.
100 agents, 92 claims, 72 confirmed after adversarial verification, 20 refuted.

Full report: [INTENT-VS-IMPLEMENTATION.md](INTENT-VS-IMPLEMENTATION.md).
Dispositions for all 48 DRIFT items + 3 unclear: [DRIFT-TRIAGE.md](DRIFT-TRIAGE.md).

**Owner rulings (2026-07-25)** — D-1 auto-wire transitions on stage add/remove rather than
build an editor · D-5 delete the task-level repo override · D-26 wire the `evidence:` block
rather than delete it · U-2 leave the guardrails invisible.

Everything else was decided and implemented in the same pass — 27 code fixes, 17 document
reconciliations, nothing deferred. Three findings raised by the implementation itself and
also fixed:

### AU-1 (MED · backend parity) — evidence was a Claude-only channel
Wiring D-26 gave Claude an `evidence` field on the `report_outcome` toolkit tool. Codex has
no in-process toolkit at all — its only structured channel is the `outputSchema` envelope —
so `attach-evidence-references` would have been a capability the profile editor offered to
every profile while working on one backend. The envelope now declares `evidence` (strict
structured-output conformant), the parser sanitizes it through the same funnel, and the
envelope gate includes `collab.evidence` on both the fresh and resume paths.
Also: the capability moved out of the catalog's "no runtime consumer — matrix-only" group,
because it now has one.

### AU-2 (MED · a11y) — every primary CTA in the app failed AA
D-12's axe gate would have failed on `.btn.primary`: white on the brand blue is **3.84:1**
light and **3.19:1** dark, at 14px/700 — below the large-text threshold, so 4.5:1 applies.
There is no on-token fix (`--blue-pressed` is 8.30:1 light but 1.76:1 dark). The accent is
correct on borders, washes and focus rings; it simply cannot carry text. A CTA token pair
now exists: light `--cta-bg: #3f5efd` (same hue 230°, same saturation, lower lightness) at
**4.96:1**, dark inverts to a near-black label on the exact brand blue at **5.77:1**.
Locked by unit test in both themes, including the 3:1 non-text contrast of the button
against its own surface — the constraint that rules out "just darken it more".

### AU-3 (HIGH for the suite) — test results depended on whose machine ran them
The D-2 continuity probe reads the provider transcript store. `test-support/setup-env.ts`
never pinned `CLAUDE_CONFIG_DIR`, so it resolved to the **ambient** data root: on a machine
that had run the app, `./data/runtimes/claude-home/projects` exists and the suite took the
continuity path; on CI it does not and the suite took the ordinary resume path. It already
produced one test that passed on CI and failed on a laptop. Both transcript roots are now
pinned to an empty temp directory — a store that EXISTS and holds nothing, so probes answer
`missing` deterministically rather than `unknown`. `CODEX_HOME` left the credential-blanking
list as a result, and `harness-hermeticity.server.test.ts` now asserts the invariant that
actually matters (the directory holds no `auth.json`) instead of that the path is empty.
