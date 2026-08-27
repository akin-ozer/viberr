# Pass 29 — Test plan & use cases (2026-08-27)

Surface: live container `viberr-app-1` on :5173 (docker-data, real creds, both backends real).
Test project: **VQP** = `Viberr QA Pass29` → `akin-ozer/viberr`, Balanced policy, slug `viberr-qa-pass29`.
Monitoring: read-only from host `/Users/akinozer/projects/viberr/docker-data` (task.md, run NDJSON, projection.sqlite via `sqlite3 -readonly`). NEVER run a viberr process against docker-data (dual-writer hazard).

PR discipline: test tasks produce SMALL files only (docs/tests). Accept a few via viberr + `gh`, reject a few, to verify viberr reflects merge/reject. Leave PR #232/VIB-1 alone.

Real-run budget is the bottleneck (each Claude/Codex run is minutes). Use-cases are batched so one run covers several verification goals. Non-run checks (RBAC, transitions, comments, ownership, capability, KB/MCP CRUD, operator-selection inspection) are cheap and done first.

Legend: [UI] browser, [API] curl+cookie, [FS] host file/DB read, [RUN] real agent run, [GH] gh CLI.

---

## A. Resource setup (prereqs)

- **S1** Confirm VQP deployed roster (operator + Developer + Reviewer) and repo/connection health. [UI][FS]
- **S2** Create a KB with a UNIQUE verification token in its content (e.g. `PASS29-KB-TOKEN-<rand>`), grant it to a profile. [UI] — later prove a run wrote it back verbatim.
- **S3** Stand up a REAL tiny external MCP (stdio echo server, à la pass-28 qa-echo) on the host reachable by the container; register it in the org MCP registry; grant to a profile. [UI][Bash]
- **S4** Create a **Browser specialist** profile (Claude) granting `use-browser` (+ verify egress auto-couples); deploy to VQP. [UI] — browser focus.
- **S5** Create a **Codex** variant profile (developer or browser) to exercise parity. [UI]

## B. Non-run behavioral checks (cheap, do first)

- **UC1 — Task creation & operator auto-invoke.** Create VQP-1 (small, well-scoped). Confirm it lands in Triage and the operator auto-runs at create. [UI][FS]
- **UC2 — Vague-goal triage.** Create a deliberately vague task; confirm the operator flags it (input_required / packet) rather than proceeding. [UI][RUN-operator]
- **UC3 — Stage transitions & boundaries.** Exercise auto vs approval vs human boundaries; confirm Review→Done is human-only; confirm a Maintainer/Contributor cannot cross a human gate the matrix says they can't. [UI]
- **UC4 — Task ownership take/release.** Take, release, and (as admin) release someone else's ownership; confirm audit + waiting-on updates. [UI][FS]
- **UC5 — Comments & @mentions.** Comment mentioning @operator and a human; confirm notifications fire and the timeline records a `comment` event; confirm agent reply @tags back. [UI][FS]
- **UC6 — RBAC triggering.** Add a second user as Contributor/Viewer (or simulate via role), attempt a gated action (accept completion / change policy / create task as viewer) and confirm server-side denial + audit. [UI][API]
- **UC7 — Capability matrix vs runtime honesty.** Cross-check the matrix display against the actual deployed grants for each profile (F27-L2 regression guard). Investigate F1 "Reserved for humans" label overload. [UI][FS][code]
- **UC8 — Operator selection reasoning.** For a task clearly suited to a specific profile (e.g. the Browser specialist, or a Codex profile), confirm the operator SELECTS the right delivering agent and explains why (free-form LLM reasoning over desc+capabilities). [RUN-operator][FS]
- **UC9 — KB creation & grant plumbing.** Verify S2 KB is attached to the profile in the UI and resolves by directory (not display name); confirm the run-inputs disclosure lists it. [UI][FS]

## C. Real-run use cases (batched, high value)

- **UC10 — Claude developer happy path (small PR).** VQP task: "add a tiny docs file `docs/qa/pass29-uc10.md` with one line; run typecheck/lint/test locally" → operator triage → assign Developer(Claude) → implement → open PR (small) → validation. Covers: selection, developer run, branch/commit/push, PR open, validation cache. [RUN][FS][GH]
- **UC11 — Required reviewer & verdict gating.** Engage a verdictCapable Reviewer on UC10; confirm acceptance WAITS for the verdict; reviewer approves; validation→healthy. Then accept in viberr → records "accepted (merge pending)" or merges when reachable. Confirm disclosure ceremony. [UI][RUN-reviewer][FS]
- **UC12 — Accept + real merge reflection.** Accept UC10 in viberr, then merge PR via `gh`; confirm viberr reconciles PR state to merged and task→Done, no silent merge. [UI][GH][FS]
- **UC13 — Reject flow.** A second small task VQP task → PR opened → REJECT via `gh` (close PR) or request changes → confirm viberr surfaces reject→recovery packet, branch handling. [RUN][GH][UI][FS]
- **UC14 — Browser capability end-to-end (FOCUS).** VQP task with S4 browser profile: "navigate to https://example.com, screenshot WITHOUT filename, attach as evidence, report the H1; do not touch repo files." Confirm: real PNG in attachments/, timeline thumbnail, evidence linkify of the cited filename, member-only serving (200 member / 403 non-member), supporting-engagement path (no PR). [RUN][UI][FS][API]
- **UC15 — Browser egress coupling & refusal.** (a) At grant time confirm egress auto-couples (GrantCouplingNotice). (b) Hand-edit project.md to set use-web-search-fetch:off under use-browser:direct, run, and confirm a disclosed refusal (browser not mounted), NOT a silent resolve. [UI][FS][RUN]
- **UC16 — Browser chromium pre-flight gap (FOCUS, F2).** Verify code: does resolveBrowserMcp check the chromium binary exists? Confirm the container actually has /usr/bin/chromium + playwright-mcp. Design the clean-refusal fix. [FS][code]
- **UC17 — Codex parity.** Same small task shape as UC10 but Codex-backed profile. Compare from viberr's eye: run lifecycle, PR delivery, tool-name underscores, MCP creds NOT sent, repo-write advisory-only, and that the UI honestly surfaces the differences. [RUN][FS]
- **UC18 — Skill loading fence (only relevant skills).** Grant exactly ONE skill (e.g. developer-expertise) to a profile; run; confirm ONLY that skill's folder is mounted for Claude (skill-mount) and the SDK's own bundled skills are rejected; confirm Codex injects the skill as prompt text (no native skill channel). Verify no UNRELATED skill leaks in. [RUN][FS]
- **UC19 — MCP real tool call.** With S3 MCP granted, task that must call the echo tool; confirm the tool is invoked live and the result appears; confirm Claude hyphen vs Codex underscore naming; confirm creds scrubbed from logs. [RUN][FS]
- **UC20 — Secondary/supporting engagement.** Engage a supporting (non-delivering, non-verdict) specialist alongside the deliverer; confirm single-writer invariant (only one delivers), supporting agent contributes comments/evidence but not the branch. [UI][RUN][FS]

## D. Autonomy & operator ceiling

- **UC21 — Autonomous-within-policy accept→Done.** On a separate autonomous project (or switch VQP policy), grant the operator completion-for-acceptance:direct; confirm a full-autonomy operator can accept→Done ITSELF (disclosed), but STILL cannot merge (mergeTaskPr needs human userId → "accepted, merge pending"). Verify F3: does the operator's accept_completion tool description falsely claim the merge completes? [RUN][FS][code]
- **UC22 — Autonomy is a ceiling not a pin.** Confirm a run cannot pick its own backend/autonomy; the surface shows the deployed config (rulings 92/94/97). [UI][FS]

## E. UX/coherence sweep

- **UC23 — Holistic UI/UX pass.** Walk every surface in light+dark; check empty states, error toasts (failure toast must not show success tick), a11y (focus, aria, keyboard dialogs), loading states, and copy coherence. Note inconsistencies. [UI]

---

## Findings log
(Recorded in NOTES.md as F-numbers; verified in code before any fix. Live PASS/FAIL recorded inline here as executed.)
