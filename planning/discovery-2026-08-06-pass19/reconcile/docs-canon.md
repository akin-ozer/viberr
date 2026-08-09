# Reconcile — docs-canon cluster

Session A = this worktree (branch `claude/viberr-app-inspection-4e5bf2`, partly uncommitted).
Session B = `origin/pass19/product-fixes` (PR #154, settled).
Scope: `docs/architecture/decisions.md` + every citation of B's rulings 55-58, the colliding
`planning/discovery-2026-08-06-pass19/` directory, README/.env.example, docs/operations,
`design/prd.md` + planning-artifacts, and the two divergent `copy-ban.test.ts` widenings.

**One fact that changes the whole picture:** the two sessions were NOT disjoint at the discovery
layer. `INTENT.md` (B's version == A's **committed** HEAD version, byte-identical),
`audit-workflow-result.json`, and all six `reference/*.md` files are IDENTICAL across the two
trees, and the finding ledger F19-1..F19-21 (+UX19-1..3, Q19-1/2, N19-1..7) is the SAME set of
findings with the same text on both sides. Divergence begins at **F19-22+** (different findings
per session) and in everything each session built afterwards. So the planning-dir "collision" is
far smaller than the file list suggests, and the F19-nn ambiguity has a precise boundary:
**IDs ≤21 are shared; IDs ≥22 are per-session dialects.**

---

## 1. What Session B built in this domain, file by file

### `docs/architecture/decisions.md` (B version)
Appends rulings **55-58** and makes four correction edits elsewhere:

- **55. R19-1 (B)** — "Completed — no changes" reachable WITHOUT faking a delivery: reviewer
  approves + verifiably nothing to deliver ⇒ acceptance closes to Done via a no-change completion
  event with its own confirm dialog (R15-1 applies; it merges nothing). Extends ruling 43 (R17-2).
  Closes F19-21 (shared-ID F19-21 — same finding both sessions).
  Mechanism: `app/server/tasks/no-change-completion.server.ts` (`acceptanceNoChangeCheck`, a live
  **fail-closed** remote re-check every Done writer runs), a minted **verification revision**
  pinned to the default-branch head so the reviewer's verdict has a subject, and a shared
  completion-event builder. Spec: `planning/.../spec-no-change-acceptance.md`.
- **56. R19-2 (B)** — the repository wins; a KB is context. Precedence stated in the run prompt
  (only when real KB text arrived), KB-vs-repo conflict surfaces as a typed `quality` event.
  Mechanism: precedence sentence in `specialist-run.server.ts:1623` + conflict flag in
  `operator-actions.server.ts:1489`. (Same owner answer as A's ruling 56.)
- **57. R19-3 (B)** — reviewer inheritance stays **KBs only**; the "widened to SKILLS by LV-F3"
  docstring was false and is corrected. Pinned by `skill-mount.server.test.ts:198-215`.
  (Same owner answer as A's ruling 57.)
- **58. R19-4 (B)** — operator gets a **read-only repository view at triage**. B's mechanism is an
  **API view, not a clone**: MCP tools `list_repo_files` / `read_repo_file`
  (`operator-toolkit.server.ts`), a pre-fetched top-level listing at the scoping turn
  (`operator-actions.server.ts:1126`), and a persona line forbidding describing the task workspace
  as the repository (`operator-parity.server.test.ts:56`). Spec: `spec-operator-repo-view.md`.
- Correction edits: (a) Data & naming — better-auth's four SINGULAR tables (`user`, `session`,
  `account`, `verification`) documented as the deliberate exception; the invented `sessions` table
  name retired (F19-17); (b) UI porting rules — N19-4 note: the mock's VALUES are not
  authoritative, `app.css`'s `:root` is the only token source; (c) ruling 47's citation line
  renamed to `deliveringContextGrants`/`withDeliveringGrants` (the names A's code also uses);
  (d) Route map corrected against `app/routes.ts` (+`/projects`, `/notifications/read`,
  `/prefs/theme`, `/resources/search`).

### Two MORE Session-B owner rulings that decisions.md does NOT hold
B's late "roadmap-delivery" wave (commits `8090ceb`, `d93b308`, `c27c354`) implemented two owner
rulings recorded ONLY in code comments and in `ROADMAP.md`'s "Delivered in this branch" table
(rows [24]/[25]) — the exact ruling-44 failure mode ("a ruling no canon file records"):

- **R19-A — per-run operator autonomy is CLAMPED to the project's configured autonomy** (the
  deployment's setting is a CEILING; the clamp is audited when it bites via
  `task.operator.autonomy_clamped`; the run picker and the schedule form offer only what will run;
  clamped at schedule time too). 27 citation lines across 11 files
  (`operator-actions.server.ts`, `operator-run.server.ts`, `schedule.server.ts`,
  `task-main-sections.tsx`, `execution-profile.tsx`, `project.task.tsx`, tests).
- **R19-B — a project MEMBER's GitHub approval on the review PR satisfies the R15-1 verdict
  gate**, bound to the delivered revision (approval's `commit_id` must be the delivered head),
  failing closed on an unmappable approver. New module
  `app/server/github/pr-human-approval.server.ts`; consumed by `task-actions.server.ts:5022`,
  `rebuilder.server.ts:329`, `github-reconciler.server.ts:407`, `pr-linker.server.ts`
  (`deriveApprovals`). 27 citation lines across 10 files.

Also reserved-but-never-promoted: `spec-failure-diagnostics.md:1221` instructs a future ruling
**"59"** ("git's own failure text reaches the human, scrubbed by value") — that number is TAKEN by
A's ruling 59 (R19-5, force-accept). No B code cites "ruling 59"; do NOT follow that spec line.

### `planning/discovery-2026-08-06-pass19/` (B version, 18 files, +7,983)
- `NOTES.md` (312 lines) — same F19-1..21 ledger as A's, PLUS: implementation-status table per
  commit, live rounds 2-6 (MCP end-to-end, decoy skill, contributor RBAC probes, rejection loop,
  R15-4 exhaustive secrecy), the UX-coherence pass (24 findings, `fe11c0a`), retractions (UX19-3,
  the KB-grant "bug"), and two open owner questions: **N19-7** (reviewer cannot cite the
  delivering run's log) and **B's F19-26** (org-admin `any-member` mutation audited as ordinary
  `task.comment` — **this is ANSWERED by Session A**: audited, with a 60s dedup guard).
- `USE-CASES.md` — the numbered 36-case register (+ round-6 cases 37-44), each with its evidence
  artefact (PRs #147-#153, tasks VC-1..VC-9, project "Viberr Core").
- `ROADMAP.md` — 27 verified forward gaps + 14 owner questions + the "Delivered in this branch"
  table (14 gaps shipped: canonical anchor in every fresh run, dismissal typed event, run-input
  disclosure, `update_branch_from_base`, stall/"No activity" chip, `npm run backup`/`restore`,
  maintenance timer, disk thresholds, health `?probe=readiness`, build identity, **CLI
  single-writer lock**, key rotation `npm run keys`, `store:check` + refuse-to-write-corrupt,
  R19-A/R19-B).
- `gap-analysis-result.json`, `ux-audit-result.json` — the skeptic-verified evidence for the
  above two files.
- 5 implementation specs: `spec-no-change-acceptance.md`, `spec-operator-repo-view.md`,
  `spec-skill-mount-race.md`, `spec-failure-diagnostics.md`, `spec-acceptance-confirm-parity.md`.
- `INTENT.md`, `audit-workflow-result.json`, `reference/*` — byte-identical to A's committed
  versions (see above).

### Other docs-domain files (B)
- `docs/operations/runbook.md` — store:check as first diagnostic; health field list corrected
  (`kbWatcher`, `lock`, `backends`); "rescan takes the writer lock, refuses against a live
  instance"; the seven-credential-path table with the D2 Claude CLI-auth second condition
  (config-dir verification, darwin Keychain arm); session-sweep bullet rewritten (see §5 — one
  sentence is factually wrong).
- `docs/operations/deployment.md` (commit `212b10e`) — key rotation finishable
  (`KEY_PREVIOUS` + `keys status/reseal`), seed-takes-the-lock, backup rewritten around
  `npm run backup` (`VACUUM INTO` from a read-only connection, one file, no WAL sidecars,
  MANIFEST with sha256 + read-back row counts).
- `docs/architecture/file-formats.md` — 9 packet-option kinds (+ schema pointer), `repo` is GONE
  from task frontmatter (not "vestigial and honoured" — a deeper correction than A's), `archived`
  + `noChanges` frontmatter documented, 11 timeline types incl. `continuity`.
- `README.md` — health payload (`kbWatcher`, `lock`), `app/shared` subdir list refresh.
- `.env.example` — D2 note: `VIBERR_CLAUDE_USE_CLI_AUTH=1` alone is not enough; verified against
  `CLAUDE_CONFIG_DIR`; does not work in the container.
- `planning/planning-artifacts/architecture.md` — directory-tree spot-corrections (writer.lock,
  `/resources/search`, `scripts/e2e.ts`…) + OAuth-callback route corrected to the better-auth
  splat (`app/routes/api.auth.$.ts`).
- `planning/planning-artifacts/prd.md` + `design/prd.md` — MVP + FR14 vocabulary amendments
  (retires "primary specialist plus consultants"), and the FR27 **third ending** amendment
  ("Completed — no changes") which cites "`decisions.md` rulings 43 and 55" — a citation that
  breaks under the merged numbering (see §2).
- `planning/planning-artifacts/ux-design-specification.md` — N19-4 token-drift note + N19-2
  Roobert→Manrope correction (A fixed the SAME two notes with different text — see §4).
- `app/features/copy-ban.test.ts` — original govern* gate untouched; ADDS a second describe
  (its F19-12): line-wise scan of `features/routes/server/shared` banning
  `/primary specialists?\b/i`, allowlisting only the capability id `assign-primary-specialist`.

## 2. Same concern, two designs — which wins

| Concern | Session B | Session A | Winner + why |
|---|---|---|---|
| No-change completion | Ruling 55/R19-1(B): reviewer approves ⇒ close; `acceptanceNoChangeCheck` fail-closed re-check; verification revision | Ruling 62/R19-8 (2026-08-08) + amended ruling 43: SAME ceremony + **verdict gate mandatory** ("reviewer verdict optional" clause superseded) + `defaultBranchEvidence.verified` required on BOTH doors (`no_branch`/`no_commits`) | **A's ruling text wins** (later owner ruling, stricter, supersedes 43's optional-verdict clause — B's text still leans on ruling 43 as-was). The CODE designs are compatible in spirit (both fail closed); the acceptance cluster unifies mechanisms; canon-wise, fold B's 55 (its live VC-5 narrative + the `no-change-completion.server.ts` citation) into A's 62 as a dated provenance note. Do NOT keep two numbered rulings for one decision. |
| Repo vs KB precedence | Ruling 56: `KB_PRECEDENCE_NOTE`-equivalent inline in `specialist-run.server.ts` + typed `quality` conflict event in `operator-actions.server.ts` | Ruling 56: ONE shared constant `KB_PRECEDENCE_NOTE` in `app/server/files/kb-injection.server.ts`, imported by both runtimes, emitted only when KB text is present | Same owner answer, same number — merge is textual. **A's single-shared-constant placement wins** (single-shared-implementation beats per-surface forks); **keep B's typed conflict event** — it is the "surfaced, not silently resolved" half and A's ruling text asks for repo-first *reported by name*. |
| Reviewer inheritance KBs-only | Ruling 57 + doc-drift gate in `skill-mount.server.test.ts` | Ruling 57 + absence pinned in `specialist-run.server.test.ts:1892` + note appended to ruling 47 | Identical decision, same number. Union both tests (they pin different layers: the wire filter and the docstring). In ruling 47's tail, keep **B's** corrected function names + **A's** re-affirm sentence. |
| Operator repo visibility | Ruling 58/R19-4(B): read-only **API view** (`list_repo_files`/`read_repo_file` + pre-fetched listing) + persona ban | Ruling 55/R19-1(A): **FULL read-only clone** (`ensureOperatorRepoCheckout`, reuses the specialist per-task checkout, `.claude` strip applies, `unavailable` arm carries git's redacted complaint) | **A wins by owner ruling**: A's ruling 55 records that the owner was OFFERED "a summary-only view" and a persona-only fix and **rejected both** in favour of the full clone. B's listing-tools design is the rejected shape's close cousin. Keep B's persona sentence ("never describe the task workspace as the repository") — compatible and tested. Whether the read tools survive alongside the clone is the operator cluster's call; canon says the clone is the ruled mechanism. |
| False-`sessions`-table runbook claim (shared F19-17) | Rewrote the bullet; claims a "'sign out other sessions' [button] in Profile" | Rewrote the bullet; enumerates the exact FOUR deletion paths with file:symbol anchors and states **no such button exists** | **A wins — B's sentence is factually false**: `grep -rn "sign out other" app/` is empty on BOTH trees and on main. Merged runbook: B's file as base (it carries all the new-CLI content), with A's session bullet replacing B's. |
| `file-formats.md` packet-kind count (shared N19-3) | "9 kinds" + inline schema pointer + `repo`-is-GONE + `noChanges`/`archived`/`continuity` docs | "9 kinds" + N19-3 dated note; PLUS a NEW mechanical gate `app/shared/docs/file-formats-sync.test.ts` (untracked, in-flight) parsing the "The N kinds:" enumeration | **Take B's richer file content, keep A's dated note AND A's sync test.** Verified: B's edit keeps the "The 9 kinds:" marker + `|`-separated comment enumeration, and its extra "Source of truth:" comment lines sit AFTER the non-`|` "(acceptance path marker…)" line, so A's parser still reads it correctly. |
| ux-spec N19-2/N19-4 notes | One combined amendment block (incl. "tokens the app added that no spec records": `--agent*`, `--cta-*`, `--faint`, `--hairline`, shadow tokens; "no spacing/elevation scale") | Drift TABLE (mock `:root` vs shipped `:root`) + Manrope correction + R19-10/R19-12 "ruled, not deferred" notes citing decisions 64/66 | **A's version is the base** (it carries the later rulings 64/66 which B cannot have); fold in B's app-added-tokens + no-spacing-scale bullets — genuinely additive content A lacks. |
| copy-ban.test.ts | Adds a retired-vocab scan (server+shared included); govern* gate untouched | Rewrites the govern* gate (string-literal lexer over every pure-TS root, `app/ui` + `app.css` joined, directory-coverage ASSERTION with empty `IGNORED_ENTRIES`, marker-only exemptions, rot checks, seed assets scanned with per-line allowlist) + separate `retired-vocabulary.test.tsx` asserting SHIPPED artifacts (seeded skill/KB docs, template constant, rendered HTML) | **Union, A's file as base.** A's govern* machinery is strictly stronger (throws on unclassified new dirs — the self-enforcing coverage claim). Append B's F19-12 describe INTO A's file, ported to A's helpers (B's version calls `walk`/`stripComments` from the ORIGINAL file — the helpers A renamed/rewrote; a naive textual merge will not compile). Keep A's `retired-vocabulary.test.tsx` too: it covers seeded assets + rendered HTML, which B's source-scan cannot see; B's source-scan covers `app/server`/`app/shared` literals, which A's artifact test cannot see. |
| PRD amendments | MVP/FR14 vocab + FR27 third ending (both mirrors) | FR5 amendment (F19-29) + §Performance→§Responsiveness rewrite per R19-9 (NFR1-4 numbers STRUCK, NFR5 recast) (both mirrors) | **Disjoint sections — both land.** Two obligations: (1) B's FR27 amendment's "rulings 43 and 55" must become "rulings 43 and 62" in BOTH mirrors; (2) `app/shared/docs/prd-sync.test.ts` (R18-6) pins `design/prd.md` to canon — apply the union to BOTH mirrors in the same change or the suite goes red. |

## 3. Pure Session-B additions (auto-merge) + risks

- `docs/operations/deployment.md` rewrite, `README.md`, `.env.example`,
  `planning-artifacts/architecture.md` — no A-side counterpart edits. Risk: LOW. One check: they
  document B's new CLIs (`backup`/`restore`/`keys`/`store:check`, rescan-takes-lock) — if any of
  that machinery is trimmed during the code merge, these docs must be trimmed with it.
- `ROADMAP.md`, `USE-CASES.md`, `gap-analysis-result.json`, `ux-audit-result.json`, the 5
  `spec-*.md` — new filenames, auto-merge. Risk: they speak B's ID dialect (F19-22+ ≠ A's
  F19-22+; "R19-1" ≠ A's R19-1) and `spec-failure-diagnostics.md` instructs "use ruling 59" —
  see §4 layout + the mapping header requirement.
- `docs/architecture/file-formats.md`'s `repo`-is-GONE / `noChanges` / `continuity` notes — keep;
  A's new sync test must stay green against the merged text (verified compatible, §2).
- B's decisions.md route-map + better-auth-tables + N19-4 corrections — additive; keep all.

## 4. Exact textual conflicts in this domain (both sides modified vs main)

From `git diff --name-only main...origin/pass19/product-fixes` ∩ A's `git diff --name-only main`:

| File | Nature of the collision |
|---|---|
| `docs/architecture/decisions.md` | A appends 55-66 + amends 43/47; B appends 55-58 + amends 47 + Data&naming + UI-porting + Route map. Ruling 47's tail conflicts directly; the appended-rulings block conflicts wholesale. Resolution in §6. |
| `docs/architecture/file-formats.md` | Both edited the `## Packet` 8→9 enumeration (same lines, different wording); B additionally rewrote the `repo` note + added `noChanges`/`archived`/`continuity`. Take B + A's N19-3 note; A's sync test gates the result. |
| `docs/operations/runbook.md` | Both rewrote the SAME false session-sweep bullet (shared F19-17); B additionally rewrote health/rescan/credentials sections. B as base, A's session bullet wins (B's has the false "sign out other sessions" claim). |
| `app/features/copy-ban.test.ts` | A rewrote the whole file; B appended a describe using helpers A replaced. Manual port required (§2). |
| `design/prd.md` + `planning/planning-artifacts/prd.md` | Different sections (B: MVP/FR14/FR27; A: FR5/NFRs) but the same files; merge both, then fix B's "rulings 43 and 55" citation; keep both mirrors identical (prd-sync gate). |
| `planning/planning-artifacts/ux-design-specification.md` | Both amended the SAME Typography/Design-tokens notes (shared N19-2/N19-4) with different text; A also added R19-10/R19-12 notes. A as base, fold B's additive bullets. |
| `planning/discovery-2026-08-06-pass19/NOTES.md` | Add/add, shared ledger base, divergent tails (A: 154 lines; B: 312). Do NOT interleave — see layout below. |
| `planning/discovery-2026-08-06-pass19/INTENT.md` | Add/add but B == A's committed HEAD byte-for-byte; A's UNCOMMITTED wave edits (R19-9..12 amendments) sit on top. **A's version wins trivially — but the in-flight edits must be committed before the merge or they are the casualty.** |
| `planning/discovery-2026-08-06-pass19/audit-workflow-result.json`, `reference/*` (6 files) | Add/add with IDENTICAL content — merge clean, zero action. |

**Proposed directory layout** (one rule, no interleaving):

```
planning/discovery-2026-08-06-pass19/
  INTENT.md, audit-workflow-result.json, reference/     # shared (A's INTENT with its amendments)
  FINDINGS.md, CAMPAIGN.md, DISPOSITION.md, NOTES.md,
  ledger-specs-*.md, runbooks/, screenshots/            # Session A's ledger (stays put — in-flight)
  session-b/                                            # EVERYTHING B-authored moves here:
    NOTES.md, USE-CASES.md, ROADMAP.md,
    spec-*.md (5), gap-analysis-result.json, ux-audit-result.json
    README.md  (new, ~15 lines)                         # the dialect map — see below
  reconcile/                                            # this merge's working docs
```

`session-b/README.md` must state: (1) finding IDs ≤21 are the shared ledger; IDs ≥22 in these
files are Session B's dialect (B's F19-26 = org-admin audit question ≠ A's F19-26 = capability-off
hole; B's F19-27 = no-change validation cache ≠ A's F19-27 = board finding, etc.); (2) "R19-1"
here = merged ruling 62, "R19-4" here = merged ruling 55, R19-2/R19-3 = merged 56/57 unchanged,
R19-A/R19-B = merged 67/68; (3) `spec-failure-diagnostics.md`'s "this is 59" instruction is void.
A one-paragraph pointer to `session-b/` goes at the top of A's NOTES.md. Relative links inside
B's files (`NOTES.md` ↔ `ROADMAP.md` ↔ `USE-CASES.md` ↔ json) survive the move because they move
together. B's ROADMAP.md is the only forward-looking roadmap either session produced — top-level
canon may later want it promoted, but move it with its evidence file for now.

## 5. Semantic collisions that will NOT conflict textually

1. **Two "R19-1"s and two "R19-4"s.** Post-merge the tree contains A-authored comments where
   `R19-1` = operator clone and B-authored comments where `R19-1` = no-change completion (45
   lines/11 files), and conversely for `R19-4` (9 lines/5 files). Nothing conflicts textually;
   every future reader mis-resolves half the citations. Must be retagged (§6).
2. **Runbook asserts a control that does not exist.** B's session bullet ships the phrase
   "'sign out other sessions' in Profile"; no such affordance exists on either tree. Merges clean
   if the hunks land apart; the merged doc would lie. (§2 fix.)
3. **Two retired-vocabulary gates.** B's copy-ban describe scans `app/server` + `app/shared`
   source literals; A's `retired-vocabulary.test.tsx` asserts seeded assets + rendered HTML. Both
   green requires BOTH sessions' F19-12 fix sets (A's `developer-expertise.skill.md`,
   `templates.ts`, `agent-catalog.server.ts`, `org-seed.server.ts`, `operator-recommendations.tsx`
   edits AND B's rendered-site edits) to survive the code merge. A banned string surviving in
   either half fails a gate the other session never ran.
4. **Two redacted-git-stderr channels.** A: `app/server/tasks/git-stderr-redact.server.ts`
   (F19-6, in DISPOSITION as DONE). B: `app/server/secrets/git-output-redact.server.ts` +
   `git-clone-auth.server.ts` changes (its F19-6/F19-18, spec-failure-diagnostics). Same shared
   finding, two modules — they merge clean into DOUBLE redaction with two half-subscribed call
   sites. Secrets/runtime cluster must pick one; canon must record the reversal ruling ONCE,
   under a fresh number (not "59" — taken).
5. **Two no-change-completion verifiers.** B's `acceptanceNoChangeCheck`
   (`no-change-completion.server.ts`, live remote re-check at every Done writer) vs A's
   `defaultBranchEvidence.verified` push-workspace evidence (ruling 62). Both fail closed;
   merging both unreviewed can double-verify or, worse, one writer path satisfying only the
   weaker check. Acceptance cluster's problem; the canon text (A's 62) already names the stricter
   contract — whatever mechanism survives must satisfy IT.
6. **B's R19-B vs A's ruling 62 wording.** A's 62 says a no-change close needs the required
   reviewers' verdicts; B's R19-B adds a THIRD satisfier of the R15-1 gate (a member's GitHub
   approval bound to the delivered revision). Not contradictory — R19-B binds to a delivered
   revision and a no-change task has a verification revision with no PR, so R19-B simply cannot
   fire there — but the merged canon must say both things without one reading as an exception to
   the other. Promote R19-B with a sentence noting it composes with rulings 20/62.
7. **B's F19-26 owner question is already answered in A.** B's NOTES leaves org-admin
   `any-member`-mutation auditing "for your ruling"; A holds the answer (audited, 60s dedup
   guard). The merged NOTES/session-b README must close the question or a future pass re-files it.
8. **`prd-sync` mirror gate.** Both sessions edited both PRD mirrors in different sections; the
   existing `app/shared/docs/prd-sync.test.ts` fails unless the merged `design/prd.md` and
   `planning-artifacts/prd.md` carry the SAME union. Apply amendments pairwise.
9. **DISPOSITION.md staleness.** A's close-out ledger says e.g. "F19-12 PARTIAL — three surfaces
   still say primary specialist"; the in-flight wave + B's fe11c0a both close that. After the
   merge, DISPOSITION's §2 ("Not actually done") must be re-audited or it indicts fixed code.

## 6. The renumbering plan (the exact ask), with citation-site counts

**Do not renumber B's 56/57 — they land on the same numbers with the same owner answers.** The
only sane merged canon is A's `decisions.md` 55-66 as the spine (later rulings, richer text, and
the in-flight wave cites 62-66), with B's four entries disposed as:

| B entry | Disposition in merged canon |
|---|---|
| 55 (no-change) | **Fold into A's 62** as a dated provenance paragraph (B's VC-5 live evidence + `no-change-completion.server.ts` cite). No B code cites "ruling 55" by number — zero number-edits. |
| 56 (repo>KB) | **Same number, same ruling.** Absorb B's typed-conflict-event sentence into A's 56 text. B's 3 "ruling 56" prose cites stay valid. |
| 57 (KBs only) | **Same number, same ruling.** B's 4 "ruling 57" cites stay valid. |
| 58 (operator view) | **Content belongs to A's 55** (where the owner's LATER answer was the full clone, explicitly rejecting the summary-view family). Fold B's persona-clause + API-view history into A's 55 as a note. B's 2 "ruling 58" prose cites must be re-pointed to 55. |
| R19-A (unpromoted) | **Promote as ruling 67** ("R19-A" kept as its tag — no collision with A's tags). |
| R19-B (unpromoted) | **Promote as ruling 68** (tag kept; add the composes-with-62 sentence, §5.6). |
| git-stderr reversal | Record once as ruling 69 IF the owner confirms it as a ruling (both sessions implemented it; neither promoted it). Next-free-number discipline: A's tail may still grow from the in-flight wave — assign at merge time. |

**Citation sites that must change** (counted on B's tree; A's citations all stay):

- B tag `R19-1` → retag `R19-8` (+ "ruling 62" where a number is spelled): **45 occurrences in 11
  app files** (`task-file.schema.ts` 8, `task-file.schema.test.ts` 2, `no-change-acceptance.server.test.ts` 16,
  `no-change-completion.server.ts` 1, `.test.ts` 1, `task-actions.server.ts` ~9,
  `operator-actions.server.ts` ~1, `rebuilder.server.ts` 1, `rebuilder.server.test.ts` 1,
  `acceptance-closed-pr.server.test.ts` 1, `delivery-actionable.server.test.ts` 1)
  **+ 4 doc lines**: `docs/architecture/file-formats.md:177,267`,
  `planning/planning-artifacts/prd.md` FR27 ("rulings 43 and 55" → "43 and 62"), `design/prd.md`
  mirror line. Subtotal **49 lines / 14 files**.
- B tag `R19-4` → retag `R19-1` and "ruling 58" → "ruling 55": **9 occurrences in 5 app files**
  (`operator-toolkit.server.ts` 3, `operator-toolkit.server.test.ts` 1,
  `operator-actions.server.ts` ~3 incl. the `:1126` "(ruling 58)" line,
  `operator-run.server.test.ts` 1, `operator-parity.server.test.ts` 1 — the last two lines carry
  BOTH the tag and the "(ruling 58)" number, so the 2 number-cites ride these same lines).
  Subtotal **9 lines / 5 files**.
- B tags `R19-2` (8 lines/5 files), `R19-3` (4 lines/2 files), "ruling 56"/"ruling 57" prose
  (7 lines): **zero edits** — numbers and meanings align.
- `R19-A`/`R19-B` (27+27 lines): **zero retag edits**; add "(ruling 67)"/"(ruling 68)" at the
  3 definitional docstrings (`operator-actions.server.ts:199`, `pr-human-approval.server.ts:7`,
  `github-reconciler.server.ts:407`) so the tag↔number map exists in code as well as canon.

**Total: 58 mandatory citation-line edits across 19 files, + 3 optional number annotations,
+ the decisions.md fold itself.** B's `planning/` session docs are NOT rewritten — they are
history; the `session-b/README.md` dialect map (§4) covers them.

**Sequencing warning:** A's R19-9..R19-12 canon edits (`decisions.md` 63-66, INTENT.md, both
PRDs, ux-spec) are **uncommitted** in this worktree and a coverage agent is still writing test
files. Commit the in-flight wave BEFORE starting the merge; every resolution above assumes A's
worktree state is the A side.
