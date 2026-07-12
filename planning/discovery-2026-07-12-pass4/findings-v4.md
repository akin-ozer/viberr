# Findings v4 — master tracking doc (pass 4, 2026-07-12)

Sources: `code-gaps.md` (56 verified code findings, ids MU-*/WI-*/XS-*/DC-*/TD-*/ED-*),
my UI walkthrough notes (`notes.md` N1–N11), owner rulings R-2026-07-12-5..8
(`owner-rulings.md`). Status values: OPEN → CONFIRMED-LIVE (seen in the live sweep) →
FIXED (implementation ledger has the entry) → VALIDATED (post-fix re-check done).

## Work items (implementation phase scope) — EVERY item must reach VALIDATED

### NEW live findings from the real Docker run (highest priority)
- **P0 · F-MIG1 (CRITICAL) — `archived` column migration drift breaks every pre-existing DB.**
  `archived` was added to the already-shipped `0003_projections.sql` (commit 1daaf9f) with no
  `ALTER TABLE`; any DB migrated before that never gets the column → projection rebuild throws
  for every project → app shows 0 projects, all routes 404. Fix (aligned with "projections are
  rebuildable, no migrations needed" charter): a projections-schema-version guard that drops +
  rebuilds the projection DB from canonical files when the schema signature changes — so schema
  edits self-heal on boot. (Alternatively an additive ALTER migration, but the version-guard
  matches the file-native architecture and covers future drift too.)
- **P0b · F-OP1 (HIGH) — failed real Claude operator run is silent.** The Claude operator's
  only completion hook releases the lease; a run error (crash/quota/auth/idle) produces no
  timeline entry, packet, or notification. Give the real Claude (and scripted) operator the
  same failure escalation the Codex operator and specialists have (typed blocked event +
  recovery packet + waiting→human). operator-run.server.ts:674 area.
- **P0c · F-ISO1 (MED) — account-managed skills/subagents leak into real runs.** Even in a
  clean container, `skills:[]` doesn't suppress Anthropic account-tier skills (deep-research,
  dataviz, doctor, …) or subagents (Explore, Plan, …). Investigate an SDK/env way to close
  them; if none exists, document honestly (S3-style) and stop claiming "only declared skills."
  claude-runtime.server.ts:206-219.

### Ruling-driven (largest first)
- **P1 · Better-auth org-role cutover + strict single-source RBAC** (R-5; subsumes XS-9,
  XS-10, DC-2): better-auth `member` table becomes the org-role source, `users.role`
  derived; every hardcoded guard consults ACTION_ROLES (github route intents, setMemberRole
  as manage-members, interruptRun + run-operator via run-agents/roleCan). Breaking allowed.
- **P2 · Capability catalog prune of fake toggles** (R-7; subsumes XS-5, XS-11 partially):
  remove never-consulted toggleable ids (approve-review, request-changes,
  report-validation-verdict + other never-consulted advisory toggles) from modal catalogs +
  matrix; keep enforced + structural ids; migrate seed/profile files; advisory remainder
  gets distinct rendering ONLY if any advisory ids remain toggleable.
- **P3 · MCP secret:// credential injection** (R-8): resolve refs from the encrypted store
  at spawn; inject HTTP headers/stdio env (Claude runs); org-settings health probe should
  use the same resolution; never log secrets.
- **P4 · Honest boundary/acceptance copy** (R-6; = XS-2 + XS-3-as-copy + XS-14 + policy
  footnote): Policy page + task-detail permissions rail disclose (a) operator-with-direct
  crosses approval/human boundaries by design, (b) the Q1 full-autonomy acceptance
  exception. No enforcement change.

### HIGH fixes
- **P5 · XS-1 resume confinement** (also WI-4): thread disallowedTools/env(git-ceiling)/
  mcpServers/systemPrompt through resumeRun for specialist @mention resumes; Codex resume
  gets model/effort override. THE top runtime hole.
- **P6 · WI-1 review queue stage-roles**: filter by resolveStageRoles(...).reviewId, not
  literal "review".
- **P7 · WI-2/WI-3 org-user better-auth sync**: email edit + delete flow through the
  identity bridge (update better-auth user email; delete identity + revoke sessions);
  partially subsumed by P1 (do together).
- **P8 · XS-4 branch-deny bypass**: cover `git checkout -B`/`git switch -C` in the deny
  specifiers AND make the delivery-contract prompt consistent with withheld caps (don't
  instruct what's denied).
- **P9 · XS-6 merge-PR "both" mislabel**: classify merge-pull-request honestly (claude-only
  at tool layer) OR keep "both" and document the app-mediated-path argument — resolve
  with copy + classification consistency (owner S3 spirit: honest labeling).
- **P10 · MU-1 profile GitHub connect 404**: POST /api/auth/sign-in/social pattern like
  login.tsx.

### MED fixes
- P11 · MU-2 onPhase: emit real phase/step from adapters (claude: init/tool-burst/awaiting;
  codex: from thread events) or drop the strip for real runs — decide during impl (prefer
  emitting; UI already built).
- P12 · MU-3/MU-4 rescan buttons: gate by role in UI + surface {ok:false} errors as toasts.
- P13 · MU-5 login flash: write the flash on OAuth whitelist rejection (better-auth error
  redirect → /login?flash) or delete the dead reader; restore the rejected-OAuth UX.
- P14 · MU-6 accept_completion tool description: tell the model the truth (records
  accepted; merge pending unless PAT merge succeeds).
- P15 · WI-5 run-log tail: in-flight guard + seq dedupe on append.
- P16 · WI-6 lease release token: pass the token through chainRunCompletion release.
- P17 · WI-7 interruptRun: group-aware lookup, single projection, or return void.
- P18 · WI-8/WI-9/WI-10 loader perf: shared actor resolver per query; home GROUP BY
  aggregation + single membership pass; github per-branch provenance batch + cached/
  deferred repo-access check.
- P19 · WI-11 goal editor: useActionFeedback like siblings.
- P20 · XS-7 Codex operator confinement: give codex operator runs an isolated empty workdir
  (never server cwd) — cheap, real improvement within S3 limits.
- P21 · XS-8 execute-code-or-write-repo: make it expressible in the profile modal
  (specialist catalog) since it IS enforced (aligns UI with teeth).
- P22 · XS-12 viewer owner buttons: gate execution-profile owner controls on canOwn
  (+ fix stale "any member" copy) — Q5 tiering in UI.
- P23 · TD-1 operator glyph dark mode; TD-2 star token: tokenize + dark overrides.
- P24 · ED-1/ED-2 env docs: add BETTER_AUTH_URL/SECRET, CLAUDE_CONFIG_DIR, LOG_LEVEL,
  VIBERR_CODEX_IDLE_TIMEOUT_MS to .env.example (+ validator coverage where sane).

### LOW batch (single cleanup sweep)
- P25 · Dead code: DC-1 line-buffer (delete), DC-3 Identity, DC-4 imports, DC-5 invited
  status remnants, DC-6 root prop, DC-7 StageMenu variants, DC-8 no-op branch, DC-9
  selftest markers (delete from repo), DC-10 duplicated type, DC-11 unused exports.
- P26 · Doc drift: ED-3/ED-4/ED-5/ED-6 + WI-16 comment fix (or move file), MU-6 overlaps.
- P27 · WI-12 double auth; WI-13 guard order; WI-14 profile error mapping; WI-15 interrupt
  pre-query loss; WI-17 GHE host; XS-13 MultiEdit deny completeness.
- P28 · N5 /projects redirect → /; N11 agents tab URL state (?view=) — small UX wins.

### From my walkthrough (owner-visible, not in code-gaps)
- P29 · N1 seeded eternal running runs: OPEN QUESTION — leaving as-is unless owner objects
  (deliberate demo staging). Will fold into final report.
- P30 · Post-test-suite stray async error (simulated run finishing after DB close in
  vitest teardown) — track down the leaked timer in the affected test file.

## Live-sweep confirmations wanted (phase 3)
XS-1 (resume envelope), WI-1 (lightweight project), XS-4 (checkout -B under denied cap),
F1 stage eligibility (regression check), F8 failure path via Codex quota, operator
recommend-vs-direct per preset, guardrails, notification routing, SSE membership, skill/KB
isolation envelopes, MCP config delivery (pre-P3 baseline), PR merged/closed/review states.

## Deliberately NOT in scope
- Codex tool-confinement enforcement (S3 stands; P9/P20 are labeling/cheap-containment only).
- Boundary enforcement against direct operators (R-6: current behavior intended).
- Security hardening beyond what rulings name (owner: no security focus this pass).
- Seed demo-data restaging (N1 pending owner reaction).
