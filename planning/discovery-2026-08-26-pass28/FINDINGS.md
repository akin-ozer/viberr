# Pass 28 — findings ledger (2026-08-26)

Status: 🔴 to-verify · 🟡 verified-real · 🟢 fixed · ⚪ won't-fix/by-design
Sev: HIGH / MED / LOW / UX / Q(question)

Every finding must be VERIFIED against code before fixing. Live-found findings ("using the app") are prioritized.

---

## LIVE (found by using the app)

### F28-U1 🟡 UX(LOW) — Clone-progress % (pass-27 F27-U1) is truncated off-screen; the built feature isn't visible
The pass-27 first-run clone-progress indicator writes the run step label
`Cloning {repo} · first task in this project · NN%` (git-clone-progress + repo-mirror `cloneProgressStep`).
LIVE on VQT-1's first run I confirmed the DOM text updates ("… · 14%" → "… · 15%"), BUT the run-strip step
element `.step.mono` is `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` at a FIXED clientWidth
≈313px (identical at 800px AND 1280px viewport), while the full label needs ≈412px. So the appended `· NN%`
— the entire point of the feature (first-run reassurance during a ~4-min silent clone) — is ALWAYS clipped by
the ellipsis. The user sees only "Cloning akin-ozer/viberr · first task" and never the percentage.
- Repro: create a project on a repo whose mirror doesn't exist yet → open the first task → watch the run strip.
  Visible: "Cloning akin-ozer/viberr · first task…". DOM: "… · first task in this project · 15%".
- Impact: the owner-commissioned F27-U1 progress readout does not reach the user in the primary surface.
- Fix direction (verify in code): put the % where it survives truncation — lead with it
  ("Cloning akin-ozer/viberr · 15%") or shorten/relocate the "first task in this project" note; OR render a real
  progress bar element (the fraction is already computed) instead of trailing text. Cite: repo-mirror.server.ts
  `cloneProgressStep`, and the run-strip step component (`.step.mono` / run-phase) CSS in app.css / runbar render.
- Sev UX/LOW but it nullifies a deliberately-built feature → worth fixing right (probably a progress bar).

---

## CODE-INSPECTION (from background bug-hunt subagents — I verify each before trusting)

### THEME A — pass-27 `pinnedBackend` (retry-on-other-backend) is under-threaded through consumers
The pass-27 feature added a per-engagement `pinnedBackend` so a "retry on the other backend" STICKS. Fresh-run
resolution honors it (`specialist-run.server.ts:~1180` `pinnedBackend ?? live ?? snapshot`), but other consumers
that resolve an engagement's backend were NOT updated.

### F28-P1 🟡 HIGH — `@agent` mention RESUME ignores `pinnedBackend` → resumes on the escaped backend
`resolveMentionedAgent` (agent-reply.server.ts:341-342) resolves `backend = sp?.backend ?? primaryRef.backend`
— NEVER reads `primaryRef.pinnedBackend` (the field is right there on the ref). VERIFIED at code. So after a
"Retry on Codex" pins codex, a human `@agent keep going` comment resumes the newest **Claude** session (the
backend the pin exists to escape), while every surface shows Codex. `latestSessionRun` (agent-reply:251-273)
also filters by the wrong backend. FIX: `primaryRef.pinnedBackend ?? sp?.backend ?? primaryRef.backend`
(match the fresh-run order). Add a test pinning the resumed backend after a retry-then-@mention.

### F28-P2 🔴 LOW/MED — Agents-page per-task engagement chip shows live-deployment backend, not the pin
`agent-deployments.server.ts:~104` (a 3rd private copy of "prefer live deployment") was missed by F27-B1's
two-site fix (board-query/task-query route through a pin-aware helper). Display-only. TO-VERIFY + fix (route
through the same helper). Related: `execution-profile.tsx` "model unavailable" warning sources the live model.

### THEME B — pass-27 F27-U2 `markWriteScopeProven` is under-wired (doc promises more than code does)
Doc (pat-store.server.ts:256-257) says a PR "actually opened **or merged**" proves `pull_request:write`.
VERIFIED live: opening PR #227 DID flip the chip to proven (the open path works). But:

### F28-U2a 🟡 MED-HIGH — a successful MERGE never proves the scope (only PR-open does)
`markWriteScopeProven` has exactly ONE caller: `pr-open.server.ts:521`. `mergeTaskPr`
(github-reconciler.server.ts, a real solicited `PUT /merge` with viberr's bound PAT) never calls it. VERIFIED
(grep: single call site; doc says "or merged"). Scenario: a Codex/agent-opened PR (bypasses viberr's PAT) is
merged via viberr's PAT → the FIRST real write with that PAT, yet the chip stays "assumed"/"unproven" forever.
FIX: call `markWriteScopeProven` on `mergeTaskPr` success too.

### F28-U2b 🟡 MED — proves the scope on the WRONG credential (re-resolves by slug, not the PAT that wrote)
`markWriteScopeProven(db, projectSlug)` re-resolves `getProjectCredential(db, projectSlug)` (pat-store:269)
instead of the `gh.patId` that actually made the call. VERIFIED (signature takes slug; client captures token
by closure at construction). TOCTOU: admin rotates the project credential mid-`openTaskPr` → the OLD PAT's
create succeeds, but the NEW PAT gets marked proven though it made zero calls. FIX: thread the actual patId
(`gh.patId`) into `markWriteScopeProven` and mark THAT credential.

### THEME C — auth
### F28-A1 🟡 HIGH (owner-Q) — OAuth account-linking has NO email-verification gate (existing-account takeover)
`buildAuthOptions` (auth.server.ts:308) sets `accountLinking.trustedProviders: ["github","google","credential"]`,
and `provisionIdentity` (identity.server.ts:79) hardcodes `emailVerified = 1` for EVERY locally/whitelist/seed
-created user. VERIFIED against installed better-auth 1.6.25 (`oauth2/link-account.mjs:23`): the link-refusal
guard `(!isTrustedProvider && !userInfo.emailVerified) || (requireLocalEmailVerified && !dbUser.user.emailVerified)
|| enabled===false || disableImplicitLinking===true` — with github/google trusted (clause1 false) AND local
emailVerified always 1 (clause2 false) AND enabled true + implicit-linking on → ALL clauses false → better-auth
implicitly LINKS a social sign-in to an existing user by email with NO verification of the provider's email claim.
When an admin enables GitHub/Google OAuth (a shipped self-service feature, R19-16), any existing account (incl.
pure-password locals) becomes linkable by anyone who gets the provider to report the victim's email. Aligns with
CVE-2026-53516 / GHSA-g38m-r43w-p2q7 (the fix better-auth shipped, defeated here by emailVerified=1). Off by
default (OAuth disabled). FIX (tiny, safe, doesn't break whitelist flow): drop github/google from
trustedProviders (verified provider emails still link via clause1) or set `disableImplicitLinking: true`, and stop
hardcoding emailVerified=1 for unproven accounts. → OWNER-Q given "side project, skip security deep-dives" memo,
but it's a concrete CVE-aligned hole with a 1-line fix — recommend fixing.

### THEME D/E — run lifecycle (TO-VERIFY the two below)
### F28-O1 🔴 MED — Codex-operator plan mid-abort narration can be swallowed by the very gate it bypasses
operator-run.server.ts:2205-2227: a plan-step throw narrates via GATED `operatorPostComment(...).catch(()=>{})`
then breaks WITHOUT adding to `refused` → `narrateRefusedActions` (which writes directly, bypassing the gate)
no-ops on the empty list. With `append-typed-events: off`, the abort notice returns denied/noop (no throw) and is
discarded → engaged-but-never-run agent, board "waiting on you", zero timeline explanation. Same class the code
fixed one branch earlier ("G6") but not here. TO-VERIFY + fix (add the aborted step to `refused` / narrate directly).

### F28-R1 🔴 MED — interrupting a still-CLONING reservation doesn't free its concurrency-cap slot
`interruptRun` (run-service.server.ts:1466-1540) marks a still-reserved run `interrupted` but never touches
`state.reserved` nor cancels the in-flight clone → the slot stays counted in `liveCount` (and the clone keeps
running) until CLONE_TIMEOUT (~15min). Only bites when a positive concurrency cap is set (default unlimited).
TO-VERIFY + fix (release the reserved slot + dispose the clone on interrupt).

### THEME F — event-sourcing / projection / file-parse robustness (subagent LIVE-verified via test harness; I re-verify at fix time)
### F28-D2 🔴 HIGH — CRLF task.md/project.md loses ALL frontmatter on parse (whole file mis-projects)
`splitFrontmatter` (frontmatter.server.ts:36) gates on `text.startsWith("---\n")`; a CRLF file (`---\r\n`) fails →
returns `{data:{}, body:wholeFile}` → every field defaults (title→key, stage→"", readiness→ready/blocked,
engagements/verdicts/PR/github-cache gone; task.md Goal/Timeline folded into body). BOM IS normalized 2 lines
above; CRLF is not (and the CLOSING-fence search `indexOf("\n---")` is already CRLF-tolerant — asymmetry ⇒ not a
deliberate LF-only contract). The write-guard's hardStop correctly refuses follow-up WRITES, but `rebuilder`
(rebuildTaskFile/rebuildProjectFile) never checks hardStop → projects the broken state into SQLite. project.md →
whole project looks reset. Data root is OUTSIDE git (no .gitattributes), hand-editable canonical truth, so a
Windows editor / git autocrlf touching /data triggers it. FIX (trivial): normalize CRLF→LF in splitFrontmatter (or
make the opening-fence check CRLF-tolerant). Add a CRLF round-trip test. [subagent live-verified]

### F28-D3 🔴 HIGH — torn incremental reprojection strands task_events (crash-consistency)
`rebuildTaskFile` (rebuilder.server.ts) writes `task_projections` upsert (stores content_hash) THEN a separate
`DELETE FROM task_events` + reinsert — NOT wrapped in `withTransaction` (only the rare full-rebuild path is). A
crash between the two (this app's history has crash/WAL-loss hazards) leaves content_hash matching the file but
task_events stale → every future NORMAL trigger short-circuits "unchanged" (rebuilder:400-402) → the timeline is
permanently stale (a human's own comment invisible) until the file changes again or a forced rebuild. Same shape
for rebuildProjectFile (project_members). FIX: wrap the per-file incremental reprojection in `withTransaction`
so the projections-row + events rewrite commit atomically. [subagent live-verified]

### F28-D1 🔴 MED-HIGH — same-`occurred_at` events sort OPPOSITE on task page vs Activity stream
`task_events.position` is authoritative (0=newest); rebuilt via DELETE+reinsert so position 0 gets the smallest
autoincrement id. Task-detail `listTaskEvents` orders `position ASC` (correct file order); Activity stream
`listActivityStream` (activity-feed.server.ts:174) orders `occurred_at DESC, id DESC` → on a timestamp tie, id DESC
= largest id = file's OLDER position = REVERSED vs the task page. github-reconciler fires up to 4 events in one
pass (can collide timestamps). FIX: tie-break the activity stream by `position`/insertion consistent with the task
page (e.g. order by occurred_at DESC then id ASC for task_events, or carry position). [subagent live-verified]
Note: NOT systemic — notifications/audit are genuinely append-only so their `id DESC` tie-break is safe; only
task_events is wholesale-replaced. Verify the fix doesn't regress those.

### THEME G — acceptance
### F28-L1 🟡 MED-HIGH — R20-2 no-change AUTO-DETECT permit path is DEAD; unclaimed-empty delivered task can't be accepted
`acceptanceNoChangeCheck` (no-change-completion.server.ts:297-305) returns `{applies:true, autoDetected:true,
refusal:null}` for an UNCLAIMED task (noChanges:false) the server proves empty (R20-2) — a PERMISSIVE result meant
to let it complete. The write branches consume it (`if (noChange.applies && noChange.autoDetected) fm.noChanges=true`
at task-actions:5802 + 7276). BUT in `acceptCompletion` the SYNC gate `acceptanceRefusalReason` (7395) →
`verdictGateReason` (pr-human-approval:318-325: `if(!fm.pr){ if(fm.noChanges||kind==="verified")return null;
return "…has delivered work but no review pull request…" }`) THROWS at 7405 for an unclaimed task — BEFORE the async
probe at 7439 and before any write. So autoDetected=true never reaches 7276; the permit path is dead. Same ordering
in packet-resolution accept_completion (5665 gate vs 5802 write) and the operator full-autonomy path
(operator-actions:2849 vs 2931). VERIFIED at code (all consumers grep'd; sync gate throws first; verdictGateReason
has no noChange param) + subagent empirically reproduced (real fns: unclaimed+empty → "no review pull request"
throw; control noChanges:true → done). rebuilder.server.ts:296-307 doc comment ("the empty case no longer reaches
here at all (auto-detect routes it)") is FALSE. Trigger state (workRevision + pr:null + noChanges:false + branch
0-ahead) is narrow (normal openTaskPr "nothing_to_review" self-heals noChanges), reachable via shallow-clone
speculative-mint / out-of-band branch reset. Escapes: hand-edit file, or admin force-accept (which mis-records the
"no review pull request" reason as bypassed). FIX: thread the auto-detect result into the accept decision so an
autoDetected-verified-empty task passes the verdict gate (run the probe before/with the sync gate for the pr:null
noChangeCandidate case, or defer that specific verdictGateReason refusal to the async probe) — keep the projection
(acceptanceBlockReason) consistent + add the missing end-to-end test.

## Pass-27 fixes VERIFIED WORKING live (positive regression checks)
- F27-U1 clone progress %: DOM updates (14%→15%) on VQT-1 first run. (But truncated → F28-U1.)
- F27-U2 pull_request:write proven-on-open: flipped to "All required scopes proven" after PR #227 opened. ✓
  (But merge path + wrong-credential gaps → F28-U2a/b.)
- Full clean Claude lifecycle VQT-1 → real merge #227 (Triage→Ready→Impl→deliver→PR→Review→verdict→accept→merge).
