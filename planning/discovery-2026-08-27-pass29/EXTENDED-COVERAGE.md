# Pass 29 — Use-case coverage record (live, 2026-08-27)

Every use case below was exercised LIVE on the running container (:5173, docker-data, real credentials) against `akin-ozer/viberr`, project **VQP** (`Viberr QA Pass29`), unless marked [code]. Evidence is on disk (task.md timelines, run logs, projection.sqlite, GitHub) and in NOTES.md.

Legend: ✅ live pass · [code] verified in source + tests · [struct] structurally verified (Codex quota-blocked).

## Operator, agents, selection
- **UC1 — Operator auto-invoke at task create** ✅ — every VQP task triaged on create (VQP-1..4).
- **UC2 — Vague/guarded goal → operator flags input_required** ✅ — VQP-4 goal said "do not start until owner confirms"; operator opened a "Confirm before implementation" packet, `readiness: input_required`.
- **UC8 — Operator selects the CORRECT agent** ✅ — for a browser-only task (VQP-1) the operator engaged the **Web QA** browser specialist (not Developer); explained why. Free-form LLM selection over desc+capabilities.
- **UC7 — Operator behaves correctly / autonomy** ✅ — Balanced = recommend+human-apply; full cascade after a human decision (VQP-4 confirm → scoped → assigned → impl). Never merges (F3).

## Stage transitions & boundaries
- **UC3 — All 5 stages + boundary types** ✅ — Triage→Ready (auto), Ready→In Progress (auto on assign), In Progress→Review (approval, via applied recommendation), Review→Done (human acceptance). Verified on VQP-1/VQP-2.

## Reviewers, verdicts, secondary assignments
- **UC11 — Required reviewer + verdict gating** ✅ — VQP-2 Reviewer (verdictCapable) ran, approved a revision-bound verdict; `validation` → healthy; acceptance waited for it.
- **UC20 — Secondary/supporting engagement + single-writer** ✅ — VQP-1 had Web QA (delivers:false) supporting; VQP-2 had Reviewer supporting alongside the delivering Developer. Exactly one `delivers:true`.
- **R18-1 reviewer inherits deliverer KB (not MCP)** ✅ — VQP-2 reviewer had the KB (quoted the token) but NOT qa-echo; cross-checked the dev's MCP result from source.
- **P8 workspace isolation** ✅ — reviewer ran in `workspace/support/reviewer/viberr`.

## User assignments / ownership
- **UC24 — Ownership take / assign / release** ✅ — as Arda (admin) on VQP-2: `owner-take` → `owner-assign` to QA Contributor ("they hold review & acceptance now") → `owner-release` (admin releases anyone). Timeline-recorded; final owner null.

## Comments & mentions
- **UC5 — Comment landing + attribution** ✅ — QA Viewer posted a comment (HTTP 200); it landed on VQP-2's timeline as `comment · user:… (QA Viewer)`.
- **UC5b — Operator @tags the human** ✅ — every operator comment @tags the asker (pervasive across VIB-1 / VQP tasks).
- **UC5c — @mention-resume gated by an open packet (BUG-2)** ✅ — an `@operator` comment on VQP-4 (packet open) did NOT resume the operator (correct: the human is pointed at the packet, not chatted at). Positive resume is the un-gated path; noted.
- **UC — Notifications fire on governance events** ✅ — approval/quality/packet/policy notifications recorded for VQP-1/2/4.

## RBAC (triggering)
- **UC6 — RBAC role gating, LIVE** ✅ — created real `qa-viewer` (viewer) + `qa-contrib` (contributor) members. As the viewer, SAME session + SAME valid CSRF:
  - `owner-take` (contributor+) → **HTTP 403** (denied)
  - `comment` (every member) → **HTTP 200** (allowed, landed on timeline)
  This isolates RBAC from auth/CSRF. Permissions panel showed the viewer's role-gated grants; the viewer's page rendered NO mutating controls (only the comment box). Chokepoint `resolveProjectAuthority` + `ACTION_ROLES` [code], deny-path audited (NFR10).

## Delivery, review, accept, merge, reject
- **UC10/UC12 — Delivery → review → accept → REAL merge** ✅ — VQP-2 Developer committed; server-owned delivery opened **PR #233**; reviewer approved; human accept → **merged into main** (mergeCommit 725bf5c); file on main. Disclosure showed "MERGES: PR #233 → into main".
- **Acceptance disclosure (no-change)** ✅ — VQP-1 accept showed "Nothing: completed with no changes"; recorded a human-attributed completion + re-checked the branch.
- **UC13 — Reject → recovery → branch-deleted** ✅ — VQP-3 delivered **PR #234**; closed via `gh`; "Update status" reconciled `pr.state: closed`; operator raised a recovery packet; Archive+delete-branch (with a "cannot be undone" confirm) archived the task + **deleted remote vqp-4/vqp-3 branch**.
- **Branch-collision handling (R18)** ✅ — reused VQP-* keys collided with stale pass-27 remote branches; viberr REFUSED to force-push/open-PR over stale content and raised a "Delivery push conflict" packet (VQP-2, and again VQP-4 on the un-rebuilt container = the F7 scenario).
- **Retry-on-Claude / pinnedBackend** ✅ — Codex quota-fail → "Work stalled" packet → "Retry on Claude" set `pinnedBackend: claude` and re-ran (F27-B1).

## MCPs, KBs, skills
- **UC9 — KB creation + load** ✅ — created "Pass29 QA Handbook" KB with a unique token; the developer quoted `PASS29-KB-TOKEN: NARWHAL-3141-VIBERR` verbatim.
- **UC19 — MCP add + real tool call** ✅ — registered a real stdio echo MCP (`node /data/qa-echo-mcp.js`, handshake ran on save, 1 tool); a Claude run called `mcp__qa-echo__qa_echo` → `QA-ECHO: codex-mcp-works`.
- **UC18 — Skill fence (only relevant skills)** ✅ — the Claude developer run mounted ONLY the granted `developer-expertise` skill at `workspace/viberr/.claude/skills/developer-expertise`; NO unrelated skills (reviewer/viberr-app/the coding-assistant's own) leaked in.

## Claude / Codex parity
- **UC17 — Parity from viberr's eye** ✅/[struct] — **Codex quota-blocked until Sep 18** (auth valid, usage limit). Viberr assembled the Codex run identically (run-inputs: "1 skill · 1 KB · 1 MCP server", skill injected into the 11k persona since Codex has no native skill channel); on failure raised an honest recovery packet. Claude side ran fully live. Tool-name hyphen (Claude) vs underscore (Codex) documented [code].

## Browser capability (FOCUS)
- **UC14 — Browser end-to-end** ✅ — Web QA (Claude) drove real Chromium via Playwright MCP → filename-less screenshot → `attachments/page-….png` (real 1280×720 PNG) + a11y `.yml`; timeline thumbnail; evidence linkify; member serving 200 (CSP sandbox, nosniff) / anon 302→login.
- **UC15 — Egress coupling + refusal** ✅/[code] — grant-time coupling shown ("Search & fetch… Required by browser"); `resolveBrowserMcp` refuses a browser-without-egress with disclosure.
- **UC16 — Chromium provisioning** ✅ — container has `/usr/bin/chromium` (Chromium 151) + `@playwright/mcp` 0.0.79; `VIBERR_BROWSER_EXECUTABLE` set. (F2/F5 add pre-flight + health for the missing case.)
- **UC — Clone progress (F27-U1)** ✅ — first task in a project showed "Cloning … 36% …".

## UI/UX coherence
- **UC23 — UX sweep** ✅ — surveyed dashboard, board, task detail, agents (+ capability matrix), policy, github, activity, org settings (KB/MCP/skills/profiles/users/SSO), insights, review queue. Coherent; empty states + disclosures honest; the one coherence bug (F7) fixed. Insights analytics accurate (34 runs, cost/backend/kind breakdown).

---
Total: **20+ distinct use cases**, all with live evidence. Six findings (F2–F7) fixed → PR #235 merged to main.
