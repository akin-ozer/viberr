# Product intent & history (pass 15 map, 2026-07-28)

Read this before "fixing" anything back toward an old document. Canon precedence is declared
in `planning/README.md:3-17`: the three living docs under `planning/planning-artifacts/`
(prd.md, architecture.md, ux-design-specification.md) win over everything, including the
`design/` build inputs; when app and doc disagree and the app is right, the DOC is amended
with a dated note (`planning/README.md:9-11`). Binding numbered rulings that code comments
cite live in `docs/architecture/decisions.md` (recovered from a deleted CONVENTIONS.md —
provenance at `docs/architecture/decisions.md:8-14`; superseded rulings are kept and marked,
never deleted, per `:16-20`).

## 1. Original vision and the FR list

**Vision** (`planning/planning-artifacts/prd.md:38-46`): a multi-user web app for governed
AI software delivery where the task file is the canonical operating contract between humans,
agents, and GitHub. Agents are the native workers; humans govern flow, review, and
acceptance. One dedicated operator agent per task, persistent specialist threads, PR-backed
review tied to task progression. Four personas drive the journeys (`prd.md:79-98`): Arda
(supervision), Arda-intervening (drifted task → decision packet), Elif (project/policy
config), Murat (continuity-failure troubleshooting).

**MVP feature set** is enumerated at `prd.md:171-188`; Phase 2 (analytics, deeper
validation, task-graph/subtasks, audit exports) at `prd.md:190`; Phase 3 at `prd.md:192`.

**Numbered requirements** (all in `prd.md`):

- Workspace & collaboration: FR1-FR4 (`:204-207`), FR37 owner-per-task (`:208`), FR38
  self-service ownership (`:209`). FR4 was amended 2026-07-04: commenting is app-wide,
  non-member comments labeled.
- Governance & policy: FR5-FR9 (`:213-217`). FR7 amended 2026-07-25: one repo per project,
  task-level override deleted (`:215`).
- Task records & lifecycle: FR10-FR17 (`:221-228`). FR11 amended 2026-07-25: only humans
  create tasks (`:222`).
- Orchestration & continuity: FR18-FR23 (`:232-237`), FR39 scheduled operator re-runs,
  added 2026-07-25 to record shipped behavior (`:238`).
- Oversight: FR24-FR28 (`:242-246`). FR27 carries the one exception to human-only Done
  (`:245`).
- GitHub: FR29-FR32 (`:250-253`).
- Integrity/audit/recovery: FR33-FR36 (`:257-260`); FR33 bounded 2026-07-25 to 90-day audit
  retention, no export in V1 (`:257`).
- NFR1-NFR18 (`:266-295`): performance targets (200-card board ≤2s, task detail ≤2s, action
  reflect ≤3s, propagation ≤5s), secret isolation, dual permission systems, idempotent
  external actions, continuity-failure grace, 10s GitHub-failure surfacing, audit
  durability (bounded per FR33).

## 2. What changed deliberately, and which ruling changed it

Chronological. Every item below is an owner decision or a recorded reconciliation, not drift.

| change | ruling / pass | where recorded |
| --- | --- | --- |
| Scope simplified 2026-06-08; reviewer & commenting amendments (FR4/FR14/FR37/FR38) 2026-07-04 | pre-build + design iteration | `prd.md:36`, `design/CONVERSATION-SUMMARY.md` (whole file = mock build history) |
| UI copy bans "govern/governor/governance"; use Maintainer / Permissions / "managed" | design iteration 2026-07-04 | `design/CONVERSATION-SUMMARY.md:23` |
| PAT-only GitHub auth (no GitHub App); whitelist OAuth model; popups over pages | design iteration | `design/CONVERSATION-SUMMARY.md:184-190` |
| Simulation removed entirely from product + seed (no "degraded engine") | R7-2, pass 7 (2026-07-16) | referenced at `planning/discovery-2026-07-24-pass13/DRIFT-TRIAGE.md:76` (D-42) |
| "Engagements" replace slots (`specialist:`/`consultants:` → `engagements` in task files); uniform generic-agent machinery | generic-agents branch, 2026-07-19 | D-25 doc reconciliation `DRIFT-TRIAGE.md:59`; pass dirs before 13 are emptied per `planning/README.md:19-21` |
| Project role `reviewer` renamed `contributor`; 4-tier project roles; single grant table in `app/shared/rbac.ts` | RBAC rework (pass 12 era) | `docs/architecture/decisions.md:130-133` (ruling 2 amendment) |
| Operator completion-for-acceptance: full-autonomy operator with explicit `direct` grant may close a task itself — the ONE exception to human-only Done | owner ruling Q1, recorded 2026-07-25 | `prd.md:114`, FR27 `:245`, `decisions.md:91-95` |
| Global profiles → template library with explicit "Add from library" copy-into-project | pass-13 owner ruling 1 | `planning/discovery-2026-07-24-pass13/PLAN.md:10-13` |
| "Lightweight · 3 stages" creation template DELETED (not remapped); Standard 5-stage is the only preset | pass-13 owner ruling 2 | `PLAN.md:14-18`, `decisions.md:184-188` (ruling 15 narrowed) |
| In-app KB authoring (New document) | pass-13 owner ruling 3 | `PLAN.md:19-20`; widened to full editor cluster by R14-4 |
| Network egress modeled as capability `use-web-search-fetch`, granted by default, revocable | pass-13 owner ruling 4 | `PLAN.md:21-23` |
| Workflow transitions auto-wire on stage add/remove; no transitions editor | D-1 ruling 2026-07-25 | `DRIFT-TRIAGE.md:14,25` |
| Task-level repo override deleted end-to-end (writer, toggle, audit kind, `task.repo` reads, FR clauses) | D-5 + D-27 ruling | `DRIFT-TRIAGE.md:15,34`; FR7/FR30 amended |
| `evidence:` block WIRED (completion emits evidence rows; Codex envelope declares `evidence` for parity) | D-26 ruling + AU-1 | `DRIFT-TRIAGE.md:16,60`; `discovery-2026-07-24-pass13/FINDINGS.md:406-413` |
| Anti-noise guardrails stay invisible (enforced, no settings surface) | U-2 ruling | `DRIFT-TRIAGE.md:17,89` |
| FR11 "authorized agents can create tasks" struck — never implemented, task-graph is post-MVP | D-24 doc ruling | `DRIFT-TRIAGE.md:58`, `prd.md:222` |
| Review-first mobile mode retired; narrow viewports get the same surface reflowed | D-29, 2026-07-25 | `DRIFT-TRIAGE.md:63`, `prd.md:161`, `ux-design-specification.md:870` |
| No linter/formatter, deliberately, forever-ish | D-31 | `DRIFT-TRIAGE.md:65`, `architecture.md:408` |
| Email+password is the shipped first-class default; OAuth optional/off; better-auth is the sole auth system | ARCH-10 reconciliation | `architecture.md:299-303`, `design/better-auth-migration.md` |
| 90-day audit retention, hard delete, no export (export = Phase 2) | PRD-11/F10-29 | `prd.md:257`, `discovery-2026-07-24-pass13/INTENT-VS-IMPLEMENTATION.md:1239` |
| Scheduled operator re-runs are a real governed feature (O-3), promoted into the PRD as FR39 | PRD-12 reconciliation | `prd.md:238`, `INTENT-VS-IMPLEMENTATION.md:1238` |
| Profile eligibility auto-maps by STAGE ROLE, not raw stage id | R14-1 | `discovery-2026-07-25-pass14/FINDINGS.md:5-9` |
| Task owner may resolve ANY packet/decision on their own task (wider than FR37 as written) | R14-2 | `FINDINGS.md:10-14`, folded into FR37 `prd.md:208` |
| Real task-level archive (terminal disposition, restorable, maintainer+) | R14-3 | `FINDINGS.md:15-17` |
| Full KB editor cluster (view/edit/overwrite-confirm/folder targeting) | R14-4 | `FINDINGS.md:18-20` |
| Clean-sheet product seed; demo data only via `npm run seed:demo` | pass-12 era ruling | `decisions.md:156-159` (ruling 9 superseded-in-part) |
| Board "Waiting on me" is member-scoped; review queue stays project-wide | R8-3 | `decisions.md:161-165` (ruling 10 superseded for the board) |
| No mailer in V1; email pref shapes removed | ruling 13 narrowed | `decisions.md:174-178` |

Post-pass-14, three more owner rulings landed straight on main (commits `953bf51`,
`fa90fd5`, `ec8aa...`/`1dc26bb` etc., 2026-07-25..28): pr-diverged operator trigger with an
`archive_task(+deleteBranch)` recovery packet option; PAT minimum scopes narrowed to
`repo + pull_request:write`; credential scope chips render proven-only (dry-run write
probes). These have NO planning-doc record — only commit messages and code. See Suspect
areas.

## 3. Where docs disagree today — and which side is intended

1. **`design/prd.md` vs canon PRD.** `planning/README.md:14-17` claims the two copies
   "agree again" after 2026-07-25. They do not: the design copy lacks every 2026-07-25
   amendment (FR7 override struck, FR11, FR27 exception, FR33 retention, FR37 widening,
   FR39, the responsive rewrite) — a 12-hunk diff. Intended behavior: canon
   (`planning-artifacts/prd.md`) wins, per the same README's own precedence rule. The
   README sentence is stale, not the rule.
2. **UX spec vs itself on mobile.** `ux-design-specification.md:870` (amended 2026-07-25)
   says one surface reflowed, nothing gated on viewport. `:940` still instructs "treat
   mobile as a review-first surface". Intended: `:870` — it carries the dated amendment.
3. **architecture.md vs itself on auth.** The Authentication section was revised 2026-07-25
   to email+password-first (`architecture.md:299-303`), but "Critical Decisions" still
   implies the session/OAuth shape and the Implementation Sequence still says "Build
   cookie-session OAuth login with Google and GitHub" (`architecture.md:431`). Intended:
   the revised section; the sequence list is historical.
4. **Mock vs product on deleted features.** `design/CONVERSATION-SUMMARY.md:88` records the
   mock's "task-level override toggle, repos-per-task limit" in Settings; the product
   deleted the feature (D-5). The mock and its summary are build history, not instructions
   (`planning/README.md:14-17`).
5. **decisions.md superseded rulings** (9, 10 partial, 13, 15) are correct by construction —
   each carries its supersession inline. Never restore a superseded rule
   (`decisions.md:16-20`).
6. **UX spec palette/typography/spacing** (`:348`, `:373`, `:381`) are marked superseded by
   `design/design-system.html`; `app/app.css` tokens are the real source. The one binding
   residue: color never operates alone, mono used intentionally.
7. **PRD "human-only Done" phrasing elsewhere.** FR27/`prd.md:114` now state the
   full-autonomy exception; any surface or doc still claiming unconditional human-only Done
   (the failure mode PRD-3 catalogued at `INTENT-VS-IMPLEMENTATION.md:1234`) is wrong and
   was supposed to be fully reconciled in pass 13/14 — worth a spot-check each pass.

## 4. PRD/spec promises possibly still unimplemented or unverified

- **Continuity Recovery Panel** (UX spec `:655-664`, Phase 3 roadmap `:707-711`).
  Deliberately out of V1 per D-2 (`DRIFT-TRIAGE.md:26`): the failure is named in the UI
  (`session_missing` class, retry-as-fresh), but the designed panel (what is known / what
  is missing / recovery path) does not exist. Journey 4 (`prd.md:87`) leans on it.
- **Global search / command palette.** The mock topbar promises "Search tasks, branches,
  agents… ⌘K"; the shipped control is an inline filter over the current board only, absent
  elsewhere (`discovery-2026-07-25-pass14/NOTES.md:83-86` flagged "check against mock
  intent" — never resolved into a finding or ruling).
- **Performance NFRs never measured.** NFR1 (200 cards ≤2s), NFR2/NFR3/NFR4 (`prd.md:266-
  269`): no pass has ever load-tested; all live instances were ≤10 tasks. Same for
  NFR14's "within 10 seconds of detection" (`prd.md:288`) against a 5-minute reconcile
  poller — detection cadence vs surfacing latency was never argued anywhere.
- **Audit export** — explicitly Phase 2 (`prd.md:257`), so org/auth events genuinely vanish
  at 90 days unless the operator snapshots the data root.
- **Output-side secret scrub** (NFR7, `prd.md:275`). U-1 was settled by building narrow
  redaction of app-injected credential values at the sink (`DRIFT-TRIAGE.md:88`), but no
  general scrubber exists for the bare logger; source-side isolation + membership scoping
  is the accepted stance. If NFR7 is read strictly, this is a standing gap-by-ruling.
- **Timeline virtualization.** `architecture.md:389` prescribes virtualize/progressively
  disclose long timelines; D-11 paginated RUN LOGS (`DRIFT-TRIAGE.md:40`), but nothing
  records the timeline itself being virtualized or capped. NFR5 (`prd.md:270`) unverified
  on genuinely long tasks.
- **Board keyboard navigation across lanes** (UX spec `:620` Task Status Card interaction).
  The axe/AA e2e sweep exists (D-12), but lane-traversal keyboard support was never
  claimed, tested, or ruled on in any pass doc.
- **FR35's second producer.** The `quality` event has exactly one producer (reviewer
  verdicts); `post-quality-flags`/`flag-underspecified-tasks` are advisory-only by ruling 7
  (`INTENT-VS-IMPLEMENTATION.md:1242`). Compliant as ruled, but the catalog rows still read
  like enforcement.
- **UX spec journeys "explicitly tested across breakpoints and with assistive
  technologies"** (`ux-design-specification.md:930`): the e2e AA sweep covers 5 routes in
  2 themes; breakpoint testing of the three journeys has no recorded evidence.

## 5. Known-open items out of pass 14

Pass 14 closed every ledger row (`FINDINGS.md:27-30`), but these survive it:

- **UI-18** — repo-wide `data-screen-label` sweep, deferred by ruling in pass 13 and still
  the one STILL-OPEN in pass 14's re-verification (`FINDINGS.md:93-97`).
- **Never-run live use cases.** Pass 14's own table planned UC-13 (consultant engagement),
  UC-17 (boundary transition + force-accept), UC-18 (underspecified → blocked packet →
  redirect cycle), UC-19 (FR39 schedule fires live), UC-21 (full-autonomy
  completion-for-acceptance disclosure/audit) — none has a result row in
  `discovery-2026-07-25-pass14/USECASES.md` (planned `:35-43`; the live coverage summary
  `:300-315` omits them). UC-12 is marked "partial". These are the least-live-proven
  governance paths, including the two most sensitive (force-accept, agent-closes-task).
- **INFO rows left as facts:** KM-16 `skills-lock.json` is a dev artifact with zero product
  consumers; KM-17 per-KB wrapper heading uncharged against the 24k budget; GV-08 any
  member can curl a governed transition across a declared `auto` boundary the UI never
  offers (documented in-code as deliberate) (`FINDINGS.md:72-73,86`).
- **LV-03** cross-backend MCP tool-name casing (dash vs underscore) was disclosed, not
  normalized (`USECASES.md:118-121`) — a persona naming a tool literally is still wrong on
  one backend.
- **RV-03 residue:** of the `task_projections` readers audited for archive-awareness, the
  reconcile-poller and `profile-query.task_count` were deliberately left as-is
  (`FINDINGS.md:304-309`).
- **The pass-14 self-review pattern itself:** RV-01 (a pass-14 fix regressed explicit-off
  grants), the four false-DONE ledger rows (`FINDINGS.md:157-208`), and the CI flake (§H)
  were all caught only by re-auditing; the ledger's bulk OPEN→DONE rewrite is a known
  failure mode for future passes.

## Suspect areas

- **`planning/README.md:14-17` states a falsehood**: "the two agree again" about
  design/prd.md vs canon. The design copy is 12 amendments stale (verified by diff
  2026-07-28). Either re-sync the copy or change the sentence to "the design copy is
  frozen history"; as written it invites someone to trust `design/prd.md`.
- **`ux-design-specification.md:940`** still instructs "treat mobile as a review-first
  surface", directly contradicting the same document's dated amendment at `:870`. A doc-fix
  pass that amended one section and missed the implementation-guidelines bullet.
- **`architecture.md:431`** ("Build cookie-session OAuth login with Google and GitHub") in
  the Implementation Sequence was not touched by the 2026-07-25 auth revision at `:299-303`.
  Harmless as history, misleading as instruction.
- **Post-pass-14 rulings live only in commit messages** (main commits 2026-07-25..28:
  pr-diverged recovery packet with `archive_task(+deleteBranch)`, minimum PAT scope set
  `repo + pull_request:write`, proven-only scope chips via dry-run probes). This is exactly
  the D-17 failure mode ("a ruling nobody can read is a ruling that gets reversed",
  `DRIFT-TRIAGE.md:46`) that decisions.md was created to prevent — none of the three is in
  `docs/architecture/decisions.md` or the PRD.
- **`planning/brainstorming/` and the pre-pass-13 discovery dirs are empty** (only `shots/`
  stubs remain). `planning/README.md:19-21` says completed passes are not retained — fine —
  but the PRD frontmatter (`prd.md:16-19`) still cites `_bmad-output/...` input documents
  that no longer exist anywhere in the tree, so the vision's paper trail starts at the PRD
  itself.
- **Pass 14's five unreached use cases** (UC-13/17/18/19/21) cover force-accept, the
  full-autonomy close, and live schedule firing — the highest-stakes governance paths have
  code-level tests but no recorded live proof after the pass-14 rewrite of acceptance
  (`LV-02` touched exactly this area).
- **FR37's amended text is now the widest requirement in the PRD** (`prd.md:208`, owner
  governs "any open decision" on their task). Each decision's inner action keeps its own
  capability gate — any new decision writer must re-implement that nuance; nothing but the
  prose enforces it repo-wide.

## Open questions

1. Should the three post-pass-14 rulings (recovery packet, minimum scopes, proven-only
   chips) be promoted into `docs/architecture/decisions.md` and/or the PRD, the way O-3
   became FR39? If not, what is the threshold for a ruling deserving a numbered record?
2. Journey 4 (Murat, continuity failure, `prd.md:87`) — is the current
   `session_missing`-named failure + retry-as-fresh the intended V1 ceiling, or does the
   UX-spec Continuity Recovery Panel (Phase 3) have a V1.x slot?
3. Is a global search/⌘K palette (mock topbar promise) wanted, or should the mock copy be
   amended to "board filter" so the intent stops dangling?
4. NFR14's "10 seconds of detection" vs the 5-minute poller: amend the NFR to match the
   polling model, or is push-based GitHub webhook detection on any roadmap?
5. Performance NFRs (200-card board, ≤2s): should a pass actually generate a 200-task
   project and measure, or amend the NFRs to observed small-team envelope?
6. Audit export is "Phase 2" (`prd.md:257`) while 90-day hard-delete is live — is a
   data-root snapshot cron documented anywhere user-facing enough, or should export move up?
7. `design/prd.md`: re-sync, delete, or explicitly freeze-label it? Same for the empty
   `planning/brainstorming/` dir.
8. UC-21 (full-autonomy operator closes a task): the disclosure requirement in FR27/Q1 says
   the UI discloses "wherever the human-only claim would otherwise be made" — who owns
   verifying that live, given pass 14 never ran it?
