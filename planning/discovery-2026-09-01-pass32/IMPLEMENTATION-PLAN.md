# Pass 32 — Implementation plan (draft; finalized when discovery closes)

Rules for this phase (owner directive): implement EVERY item in IMPROVEMENTS.md / TESTPLAN.md /
NOTES.md that is a defect, coherence gap, or owner ruling; no deferrals, no migrations or
backwards-compatibility shims (pre-prod, break freely); tests may be rewritten critically; every
fix validated by code + UI screenshot + browser use; every regression lock canaried. Work happens
on a branch off main, in clusters owned by disjoint file sets so opus/max fixer agents can run
concurrently; the orchestrator runs full gates (vitest, tsc, lint 0, build, compose e2e) and CI.

## Cluster A — ops honesty (server/ops, controller/ops MCP, health)
- F32-1 disk arithmetic (df -kP / frsize) + low/critical classification + tests P32-T1.
- F32-4 credential-refusal reading (per backend) surfaced on health, instance_health, Insights.
- F32-9 instance_health carries quota exhaustion + rate-limit readings (same source as Insights).
- C05-A strip/gate host paths in health (browser.reason) — P32-T12.
- Owner ruling E32-5: `controller.ops.read` audit rows — P32-T11.
- C03-OC2 read_run_log empty-page bounds — P32-T15. C02-R12 SQL LIMIT for forward reads.
- C01-A6 env schema completeness + .env.example — P32-T9.

## Cluster B — GitHub/collision/packets (server/tasks, server/github)
- F32-7 collision resolution never strands (re-queue or synthesized next step) — P32-T6.
- C05-B/C/D remedy ordering (delete before close), honest refusal, 403 → scope violation — P32-T13.
- P07-F/C03-OC4 explicit refusal when the resolver has no userId.
- C01-A1 per-row tolerant packet observations — P32-T7; C01-A8 hoist `unownedPr` out of the
  whole-value github cache (or per-row commits).
- F32-10 same-stage transition guard order + no-op toast — P32-T21.
- Packet authoring coherence: `accept_completion` option offered at a pre-boundary stage with no
  verdict (VIB-3 packet) — refuse at authoring or route to the no-change path with a verdict, decide
  after probing.

## Cluster C — runtime parity (server/runtimes, server/agents)
- Owner ruling E32-3: Codex read-only cwd + writable attachments dir (verify SDK support; else
  honest labels) — P32-T10; C02-R3 carry attachmentsWritableDir on resume.
- C02-R4 supporting-run prompt follows grants (ruling 101b) — P32-T16.
- C02-R1 nine stale R22 comments; C02-R5 reserved-name grant → unresolved row; C02-R6/R7 thread
  `settingsWritten` into the persona; C02-R8 controller kind in sandbox mode; A00-8 duplicate Set
  entry + disjointness test.
- F32-8 operator brief names only mounted tools (persona "MCP servers available: …" + run_agent
  annotation) — P32-T19.
- C32-2 refresh mirror / fetch before support clones (reviewer base == PR base).
- C02-R11 dispatch-completion contract survives restart (persist dispatcher on the run row).
- C32-1 per-run cache HOME (decide; low).

## Cluster D — server core / files / docs drift
- F32-2 KB (and skill/MCP/profile) watcher SSE + org-settings revalidation — P32-T2.
- C01-A2 goal-writer stale-read repair; C01-A3 audit-exports in backup — P32-T8; C01-A4/A5/A13
  file-formats.md completeness + frontmatter key locks; C01-A9/A10/A11/A12 hygiene.
- C03-OC1 controller comment audit names the asker — P32-T14; C03-OC3 controller skills default
  display; C03-OC6 stale comment; P07-C provider-marker single source + drift pin; P07-G shared
  section labels; P07-E/C05-E clear-under-lock documentation.
- Docs: A00-1..A00-11 (decisions.md ruling 7 count, route map, architecture.md attachments
  retention, UX spec Safari/Firefox + mobile leftovers, rulings 106-108 into UX spec + architecture,
  FR17/FR40 amendments, ruling 17/77 letter, routes.ts comment + nav-order test); doc-06 drift list
  (README scripts table, testing.md db/ glob + e2e data-root sentence, pass-31 doc corrections);
  promote pass-32 owner rulings into decisions.md (109+).

## Cluster E — UI/UX coherence (app/features, app/ui, app.css)
- F32-5 markdown decodeURIComponent guard — P32-T4.
- D32-5 segmented control hover contrast + gate — P32-T5.
- D32-3/U2/U3 document-title grammar — P32-T17. D32-2 Insights shared formatter — P32-T18;
  P07-I UTC date honesty.
- D32-1 copy, D32-6 plural, D32-7 role field in the global profile dialog, D32-8 empty bucket,
  D32-9 mode vocabulary, D32-10 policy paragraph, D32-11 policy row layout, D32-12/13 copy,
  D32-14 actor dedupe, D32-15 403 reason — P32-T22, D04-U4/U5/U6/U7/U8/U9/U11/U12.
- A11Y-1..9 accessible names (Local method button, New/Add scoping, backend segments, KB chips,
  library rows, home tiles, packet option radios, stage menu items, collapsible headers).
- C03-OC7 guardrails UI (owner question E32-6 pending).

## Cluster F — tests & gates
- P32-T20 testTimeout; B06-T3 flaky stale-read test investigation; B06-T10/T11/T16 docblocks +
  anti-slop vendor pin; P07-H audit-list a11y lock; new locks for every P32-T item.
- CI is green again: every PR of this phase must pass CI, not only local gates.

## Delivery
Small PRs per cluster against akin-ozer/viberr (the owner reviews with gpt-5.6-sol); each PR
carries its tests; e2e run unpiped before merge; container rebuilt (`docker compose up -d --build`,
disk permitting) and the fixes re-verified live in the browser with screenshots.
