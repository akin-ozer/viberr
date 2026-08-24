# Pass 26 — findings (bugs + product questions)

Baseline main `b5b3128`. Every CONFIRMED item was traced end-to-end in code by me (not trusted from a
subagent or a comment). Candidate items await my verification. Severity: HIGH = breaks a shipped
feature / governance-or-cost protection; MEDIUM = real defect with a workaround; LOW = polish.

Legend: ✅ CONFIRMED by me · 🔬 candidate (verify) · ❓ owner question

---

## F26-1 — HIGH ✅ — Run-concurrency cap is bypassed for ALL specialist runs (delivering + reviewer)
**The just-shipped cap (PR #206, PG-12) does not gate the runs that matter most.**

Mechanism (traced end to end):
- `app/server/runtimes/run-service.server.ts:393` `reserveRun` writes a run row with `state:"running"`
  and performs **no cap check** — it just claims the row.
- `run-service.server.ts:791-797`: `if (reservation) { launch immediately } else { admitRun(...) }`.
  So a reserved run **skips `admitRun`** (the only cap gate, line 1200: `handles.size < cap`).
- `app/server/tasks/specialist-run.server.ts:1320`: `pending.reservation = reserveRun(...)` is called
  **UNCONDITIONALLY** for every specialist dispatch (delivering primary AND reviewer/supporting,
  `kind: delivers ? "primary" : "reviewer"`). No `if (cloning)` guard — unlike the operator path
  (`operator-run.server.ts:1337` `cloning ? reserveRun(...) : null`).

Result: primary + reviewer runs — the bulk of all agent runs — launch immediately regardless of the
cap. Only comment-triggered `resumeRun` and operator-no-clone runs actually gate. With `Max at once:
2`, N delivering/reviewer runs still fire at once; the admin dashboard shows `live` climbing past
`cap` with `queued:0` (honest, but proof the gate never fired). The reservation's real purpose is UI
visibility during the slow first-clone (R21-4/D1) — legitimate — but it must not also exempt the run
from the cap.

Fix direction (implementation phase): make reservation respect the cap. Cleanest: gate BEFORE the
clone — check the cap at dispatch time; if a slot is free, reserve+clone+launch; if full, queue and
let `drainRunQueue` trigger preparation when a slot frees. Reserved/preparing runs must count toward
the cap for their own admission, not just for others'. Keep the live-strip visibility. Add a test
that two delivering runs under cap=1 leave the 2nd queued.

DOUBLE-LEAK detail: `admitRun` gates on `state.handles.size` (in-memory live adapters, line 1201),
which does NOT include a reserved-but-still-cloning run (its handle is only set when the adapter
launches). So a reserved run (a) never checks the cap for itself AND (b) doesn't count against other
runs during its multi-minute clone window. Fix must make the cap count "live + preparing/reserved",
and route reserved launches through admission (or gate before reserve+clone). The reservation's live-
strip UX (R21-4/D1) must be preserved — so the run stays visible while queued/cloning.

Live-validate the fix by setting cap=1 and launching two runs on VVQX.

Pass-25 memory even noted "reserved runs bypass" but assumed reservations were rare clone-time events;
the specialist path always reserves, so the bypass is the common case, not the exception.

## F26-2 — MEDIUM ✅ — Agents-page sidebar roster shows false "working" pulse for idle engagements
The #206 hero fix (`1cd86c8`) added `d.running` (an `agent_runs` state='running' flag) so the profile
hero counts only `runningKeys` and an assigned-but-idle profile reads "idle · engaged on N tasks".
But the sidebar roster `counts` (`app/features/agents/agents-page.tsx:1322-1335`) still counts ALL
`deployments` task keys, ignoring `d.running`; `ActiveBadge` (`:157-162`) renders the pulsing
`.working` indicator + count whenever `count>0`. So on the SAME page the hero says "idle · engaged on
3" while the sidebar shows a pulsing "working · 3" for the identical profile. Fix: filter
`deployments` by `d.running` in `counts` (mirror the hero), or show a distinct engaged-not-running
state. No test covers it. (Same bug class #206 fixed in the hero — a one-click-away regression twin.)

## F26-3 — MEDIUM 🔬 — Insights "Success rate" measures process-exit, not delivery acceptance
`app/server/insights/insights-query.server.ts` sets `state:"finished"` from adapter "process exited
cleanly" signals (claude-runtime `sawResult && !resultIsError`; codex-runtime `sawTurnCompleted &&
!sawFatalError`), independent of whether a reviewer accepted/rejected the work. 100 clean runs whose
PRs were all rejected → "Success rate: 100%". The label over-claims for a supervisor's cost/outcomes
dashboard (a viberr honesty theme). Fix: rename to "Completion rate" or clarify sublabel. (subagent-
sourced; mechanism CONFIRMED by me via the runtime state setters — semantics call is the owner's.)

## F26-4 — LOW-MEDIUM 🔬 — Insights breakdown truncation hides the cost leader (latent)
`insights-query.server.ts` `group()` sorts `ORDER BY runs DESC, cost DESC LIMIT 8`. With >8
models/projects, a rare-but-expensive outlier can be dropped from byModel/byProject with no "+N more"
or "sorted by runs" hint, understating what drives spend. Latent on this instance (<8 of each). Fix:
sort by cost when the section is about cost, or show an overflow indicator. Verify the byModel/
byProject sections even render (I only saw byBackend/byRunKind live — confirm during impl).

## F26-5 — LOW 🔬 — Insights totals don't reconcile: running/queued computed but never shown
`insights-query.server.ts:209-210` computes `running`/`queued`; the page never renders them, so
"Total runs: N" can exceed the visible outcome breakdown with no explanation. Ties into F26-1 (queued
runs). Cheap: show them or reconcile the sublabel.

## F26-6 — LOW 🔬 — Insights avg run-time has no floor (finished_at < started_at → "-600s")
`insights-query.server.ts:157-166` no clamp on the julianday diff; `fmtDuration` renders a negative.
Latent (no current writer produces it). Cheap defensive `Math.max(0, …)`.

## F26-7 — HIGH ✅ — Audit S3 export: SigV4 omits the endpoint path → guaranteed 403 on path-style S3
`app/server/audit/s3-put.server.ts:105-110,158`. When `endpoint` carries a path (path-style
addressing — MinIO/Ceph default, e.g. `https://minio.internal:9000/bucket`), `host = new
URL(origin).host` drops the path and `canonicalUri = canonicalKeyPath(fullKey)` is JUST the object
key — but the request `url = origin + canonicalUri` (line 158) INCLUDES the endpoint path. Signature
is computed over `/key`; the server sees `/bucket/key` → `SignatureDoesNotMatch` 403 on every push.
The shipped test (`s3-put.server.test.ts:80-88`) uses exactly such a path-style endpoint but only
asserts the URL string, never signature validity — so it shipped green. Fix: fold the endpoint's
pathname into the canonical URI (and sign over it); consider real path-style bucket addressing. Verified
by reading the signer; default AWS virtual-hosted case is correct.

## F26-8 — MEDIUM ✅ — Audit S3 secret uses non-rotating `openSecret` (no lazy self-heal on key rotation)
`app/server/audit/s3-config.server.ts:69` opens the sealed secret with `openSecret`, unlike every
sibling SEALED_STORES consumer (`pat-store.server.ts:222-238` etc.) which use `openSecretRotating` +
lazy re-seal (the A9 fix). The dedicated `s3_audit_config.secret_box` table IS registered in
SEALED_STORES (so the reseal CLI covers it), but after a `VIBERR_SECRET_ENCRYPTION_KEY` rotation the
S3 export silently fails with a misleading "No S3 target configured" until an operator manually runs
the reseal CLI — PATs self-heal, this doesn't. Fix: use `openSecretRotating` for parity.

## F26-9 — MEDIUM ✅ — Audit export copy "every recorded fact" is false (90-day + 100k caps, undisclosed)
`org-settings-page.tsx:193-196` claims "Download the full audit log … every recorded fact," but the
export is bounded by the 90-day retention sweep (`retention.server.ts:30,76-85`, hard-deletes) AND a
100,000-row cap (`audit-export.server.ts:14,97-98`) with no UI disclosure. The code comment "The UI
states the cap" (`audit-export.server.ts:12-13`) is itself false. Honesty fix (viberr theme): disclose
the retention window + row cap, or reword. (My live export returned 1941 rows, under the cap.)

## F26-10 — MEDIUM 🔬 — Audit CSV: no formula-injection neutralization; `actorLabel` email is the vector
`audit-export.server.ts:139-144` `csvField()` does RFC-4180 quoting only, no `=+-@` neutralization.
Live scan found 0 risky values in current data, BUT `actorLabel` is the user's email and `z.email()`
(`user-admin.server.ts:39`) permits a leading `+`/`-` in the local-part — so a crafted signup email
lands an unescaped formula in a spreadsheet cell. Defense-in-depth: prefix `'` on values starting
`=+-@\t\r`. (Subagent-sourced; vector plausible, verify z.email leniency during impl.)

## F26-11 — LOW ✅/🔬 — Audit S3 push: network throw escapes friendly error; region not case-normalized
`org.settings.tsx:273-297` has no try/catch around the S3 push, so a fetch network throw (not an HTTP
error) bypasses the crafted "S3 upload failed" message and rethrows raw (`appErrorResponse` only maps
`AppError`). And `s3-config.server.ts:105` trims but doesn't lowercase `region`, so a mixed-case region
breaks the signing scope. Both minor.

## F26-12 — HIGH ✅ — Task labels are UNSEARCHABLE everywhere (set-only field)
Labels ship as a prominent, autocompleted "type and press Enter" field, but NEITHER search surface
indexes them: board free-text `matchesSearch` (`board-filters.ts:138-155`) and the ⌘K palette SQL
(`command-search.server.ts:52-161`) both build a haystack of key/title/branch/identities only. So you
can tag tasks with labels but can't find tasks by a label in either search, and there's no `label:`
board filter (PG-9). A triage taxonomy you can't query is half-built. Fix: add labels to both search
haystacks; consider a label filter/chip on the board. (Confirmed: neither file is in the 24h range;
verified the predicates.) Cross-checked live intent — labels render on the card but are dead to search.

## F26-13 — MEDIUM ✅ — Archived-task metadata editing regressed (the `!archived` guard was dropped)
Before PR #208 (`84fba42`, in-range) the metadata editor was gated `canEditMeta && !archived`. The move
to `TaskDetailsPanel` (`task-side-panels.tsx:375-503`) dropped the `archived` prop entirely; the "Edit
details" button (:500-503) is now role-only, and `setTaskMetadata` (`task-actions.server.ts:638-733`)
has NO archived guard server-side. **Confirmed live**: archived VVQX-2 still shows "Edit details" and
would accept a metadata write — an "abandoned, kept for the record" task can have priority/labels/due
silently rewritten, exactly what this feature blocked a few commits earlier. Fix: re-add the archived
guard server-side in `setTaskMetadata` (throw) AND gate the client button on `archived`.

## F26-14 — MEDIUM ✅ — Review queue omits the new priority/labels/due-date (acceptance boundary blind)
`review-page.tsx` (untouched in-range) shows PR/validation/staleness/continuity pills but not the new
triage metadata — yet its own comment says the acceptance boundary "is where a forgotten task costs the
most." A high/urgent or overdue task is visually indistinguishable in the review queue. Fix: add the
`task-meta.tsx` pills (PriorityFlag/LabelChips/DueDatePill) to the review row, as the board does.

## F26-15 — LOW-MEDIUM ✅ — Two disagreeing label-autocomplete vocabularies (archived in/out)
New-task modal suggestions come from client `allTasks` which INCLUDES archived tasks
(`board-page.tsx:1801-1806`, `getBoard` uses `includeArchived:true`, hidden only client-side); the
Details panel uses `listProjectLabels` (`board-query.server.ts:270-289`) which EXCLUDES archived. So the
two label pickers offer different vocabularies, and `project-labels.server.test.ts:12-13`'s docstring
claiming a shared source is false. Fix: point both at `listProjectLabels` (server, archived-excluded).

## F26-16 — LOW ✅ — `createTask` back-compat `urgent` param can desync from `priority` (dormant)
`task-actions.server.ts:495` `urgent: input.priority === "urgent" || (input.urgent ?? false)` — a caller
passing `priority:"low", urgent:true` yields `urgent:true` against a non-urgent priority, breaking the
lock-step invariant. No live caller passes `input.urgent` (dormant), but since back-compat is allowed to
break, drop the `input.urgent` param and derive `urgent` purely from `priority`. (Edit path is correct.)

---

## Owner questions / policy notes

### ❓ Q26-1 — Task priority/labels/due-date are invisible to the operator AND agents
`taskContext()` (operator-actions.server.ts:2070-2086) passes only `{title, goal, stageName}`; the new
metadata reaches no run prompt. Human-only board triage, or should the operator factor priority/due-
date into its recommendations and the agent be told a task is urgent? (Cheap to add to taskContext.)

### ❓ Q26-2 — Owner-seat takeover now lets a MAINTAINER evict an ADMIN's ownership (via accept-completion)
`d16f4b5` (same-day follow-up to the #206 `f8333af` HIGH fix) changed the takeover gate from
`release-any-ownership` (admin-only) to `accept-completion` (admin OR maintainer). Verified SOLID re:
contributor bypass (no hole). But it's a real behavior change: a maintainer can unilaterally take a
seat an admin holds — a lower bar than `releaseOwner`'s admin-only eviction. Test-covered + deliberate,
but worth the owner explicitly signing off. (subagent-sourced; I'll re-verify the gate during impl.)

### OWNER RULINGS (2026-08-24, asked mid-pass)
- **R26-1 (Q26-1) = "Operator only"** — surface priority/labels/due-date to the OPERATOR's task context
  (so it factors urgency/deadlines into scheduling/recommendations); the delivering AGENT stays
  goal-focused (do NOT add metadata to the specialist prompt).
- **R26-2 (F26-12) = "Searchable + board filter"** — add labels to board search AND ⌘K, AND add a board
  label filter control.
- **R26-3 (F26-3) = "Rename to 'Completion rate'"** — honest label for run-completion (not acceptance).

### 🔬 Q26-3 — New-project auto-derived task key collides with an existing project's key, silently
"Viberr QA 26" auto-generated key "VQ" — identical to the existing "Viberr QA 25" project. No warning.
Task keys are letters-only, project-scoped (slug disambiguates), and most surfaces carry a project
label, so it may be tolerated by design — but two projects sharing "VQ" means "VQ-1" is ambiguous in
cross-project surfaces (⌘K, audit export where taskKey isn't project-qualified, notifications). Verify
whether creation SHOULD block/warn on a duplicate key. (Set my test project's key to VVQX to avoid it.)
