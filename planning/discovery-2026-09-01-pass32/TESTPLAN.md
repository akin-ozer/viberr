# Pass 32 — Test cases to build (living; finalized with the updated app knowledge)

Grounding: docs/06-testing-verification.md (harness + recipes), docs/01..05 (behavior), docs/07
(what changed since pass 31). Every test below is a REGRESSION LOCK for a defect found this pass or
a behavior proven live that had no lock; each must be canaried (revert the fix → red → restore →
green) before it ships. Delivery: small test files only, on PRs against akin-ozer/viberr.

## P32-T1 · Disk-free arithmetic is frsize-aware (F32-1)
Unit on `measureDataRootSpace`: inject a statfs whose `bsize`≠`frsize` (virtiofs shape:
bsize 1 MiB, blocks/bavail in 4 KiB units) and assert freeBytes/totalBytes match `df -kP`
(or the frsize path); a second case where the `df` fallback is unavailable returns null, never
an inflated number. Plus: `classifyFreeBytes` fires `low`/`critical` for the corrected value.

## P32-T2 · KB re-index publishes a live update (F32-2)
Unit on the kb watcher: after a re-index the event publisher receives a `resource.updated`
(or equivalent) fact; route/jsdom: the Agent resources panel revalidates on that SSE event
(doc count and "re-scanned" stamp change without reload).

## P32-T3 · Credential refusal degrades reported availability (F32-4)
Unit on the Codex/Claude classifiers + health snapshot: a REAL credential-rejected run records a
"credential refused since <run>" reading; `/resources/health` + `instance_health` report it;
a later successful run clears it. Transient 401/network errors must NOT record it.

## P32-T4 · Markdown attachment links never throw mid-render (F32-5)
jsdom: render a comment containing `[x](attachments/%zz.png)`, `![y](attachments/%zz.png)` with
attachmentNames/attachmentsBase supplied → no throw, anchor falls through; the sibling
`safeDecodeName` path is the only decoder.

## P32-T5 · Segmented control selected+hover stays legible (D32-5)
app.css gate: for every `[aria-checked=true]` / `.on` segment rule, the composite of the hover
rule over the selected rule keeps ≥4.5:1 text/bg contrast in both themes (extend the existing
contrast sweep to hover composites, the "opacity composites are gate-blind" class).

## P32-T6 · Collision resolution is never stranding (F32-7)
Integration on a SUPERVISED project: resolve_remote_collision success → either a `packet-resolved`
operator run is queued OR a Move-to-Review recommendation exists; `waiting: human` with neither
must be impossible. Canary: restore `resolve_remote_collision` to NO_REQUEUE.

## P32-T7 · Packet observations are per-row tolerant (C01-A1)
Unit: a packet with one malformed observation row (`v: 9`) parses with a `packet.invalid_observation`
diagnostic and keeps the packet + its options; a later `updateTaskFile` round-trip keeps the
`## Packet` section.

## P32-T8 · audit-exports/ is backed up (C01-A3)
Unit on backup.server: the archive contains `audit-exports/*.jsonl` when present; restore
re-creates them.

## P32-T9 · Env schema is complete (C01-A6)
Meta-test: every `process.env.VIBERR_*` read in app/server appears in `envSchema` and in
`.env.example` (allowlist only `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`).

## P32-T10 · Codex read-only + writable attachments (owner ruling E32-3)
Unit on `resolveCodexSandboxMode` + the thread-config builder: a write-withheld evidence-granted run
gets `read-only` + `additionalDirectories=[attachments]`; the seeded Reviewer on Codex can no
longer edit the workspace. `capabilityEnforcement("execute-code-or-write-repo")` stays "both".
Resume path (C02-R3): `attachmentsWritableDir` survives `ResumeRunInput`/`carryResumeOptions`.

## P32-T11 · viberr_ops reads are audited (owner ruling E32-5)
Unit: each successful `instance_health` / `read_run_log` / `read_store_doc` writes one
`controller.ops.read` audit row with tool, target, asker; denials keep `controller.authority.denied`.

## P32-T12 · instance_health never leaks a host path (C05-A)
Unit: `browser.reason` (and any `detail`) containing `VIBERR_BROWSER_EXECUTABLE=/…` is gated to
org admins / stripped on the unauthenticated body.

## P32-T13 · Collision remedy: delete before close, honest refusal (C05-B/C05-D)
Unit on `resolveRemoteBranchCollision`: when the branch delete refuses, no PR has been closed
(or the refusal sentence names the close); a 403 on the PR close opens a scope violation.

## P32-T14 · Controller comment audit row names the asker (C03-OC1)
Unit: `comment_on_task` via the controller writes an audit row with the asking user's id +
"· via controller" label.

## P32-T15 · read_run_log empty page reports real bounds (C03-OC2)
Unit: `since` past the end → `olderExist: true` with a usable `next.older` cursor.

## P32-T16 · Supporting-run prompt matches ruling 101 (C02-R4)
Unit: a write-GRANTED supporting run's persona no longer says "Do NOT edit files / git commit";
a write-WITHHELD one still does.

## P32-T17 · Document titles follow one grammar (D32-3)
Route tests: every project view's `meta` yields "<Page> · <project> · Viberr"; org settings,
login, task page follow the same grammar.

## P32-T18 · Insights dates use the shared formatter (D32-2)
jsdom: quota "resets" and "observed" render via `~/shared/dates` (no `toLocale*` in insights-page).

## P32-T19 · Operator brief names only tools the target holds (F32-8)
Unit on the dispatch brief / run_agent tool: a directive mentioning an MCP tool the target profile
does not grant is annotated ("the reviewer has no qa-echo grant") or the persona says which MCP
servers are mounted; at minimum lock the persona line "MCP servers available: …".

## P32-T20 · No-testTimeout flake class (B06-T2)
vitest.config: `testTimeout` raised for fs-heavy suites (or globally); lock that
`self-heal.server.test.ts` runs under the configured budget.

## P32-T21 · Same-stage transition is authorized and honest (F32-10)
Route test: viewer/contributor POST `intent=transition&to=<current>` → 403 with the role sentence +
`project.authority.denied` audit row; admin same-stage POST → no "Moved" toast (no-op reported as
no-op); archived project → 409 before the short-circuit. Canary: move the early return back up.

## P32-T22 · Forbidden page names the reason (D32-15)
jsdom/route: the error boundary for a 403 renders the server's reason sentence ("This area requires
the admin role."), not only "Error 403 · Forbidden".

## P32-T23 · Terminal acceptance discloses the packet it closes (F32-11)
Unit/route: force-accept (and accept) on a task with an open packet writes a packet-withdrawn timeline
event + audit row; the accept/force confirm disclosure carries a WITHDRAWS row naming the packet.

(more added as the campaign proceeds — RBAC probes, goal chains, schedules, notifications)
