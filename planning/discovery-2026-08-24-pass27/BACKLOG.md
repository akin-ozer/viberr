# Pass 27 — forward-looking product backlog ("what to build / what's missing")

Grounded in the pass-27 discovery + 21 live use cases (see NOTES.md / FINDINGS.md).
This is the product surface BEYOND the bug-hunt+fix pass (which is complete and shipped to
mergeable PR #226). It separates: **owner-ruled** (decided, don't build), **already built**
(verified live), and **genuinely open** (a real product-design choice, needs an owner call
because it expands surface — against the standing "don't bloat the software" preference).

Method honesty: the app is very mature (27 passes). Discovery was correctly bug/coherence
focused because that is what a mature app of this quality surfaces. There is NOT a large vein
of unbuilt features here — inventing speculative ones would be bloat, which the owner asked me
to avoid. The one genuine, documented, unbuilt FEATURE is F27-U1 (clone progress).

---

## A. Owner-ruled this pass — decided, do NOT build (recorded for continuity)
- **Task keys alphanumeric (JIRA-style "V27")** — owner ruled KEEP letters-only (2-4). Closed (F27-Q1).
- **Task metadata (priority/labels/due) NUDGES the operator (re-triage)** — owner ruled KEEP advisory-only.
  `setTaskMetadata` intentionally does not re-invoke the operator (R26-1 stands). Closed (F27-L3/Q26-1).
- **Backend retry-on-other-backend stickiness** — owner ruled MAKE IT STICK → **built this pass**
  (per-engagement `pinnedBackend`, resolution + display + tests). Shipped in PR #226.

## B. Already built + verified live this pass — no gap (recorded so it is not re-proposed)
- **Insights per-project breakdown** — `insights-page.tsx:113` renders `<BreakdownCard title="By project">`;
  the query already computes `byProject`. Complete.
- **First-run clone honest LABEL** — `cloneStepLabel` already says "Cloning {repo} · first task in this
  project, this can take a few minutes" for a cold clone, with an elapsed timer. Honest, just not a %.
- **PAT pull_request:write proven-on-real-write** — built this pass (F27-U2 `markWriteScopeProven`).
- **Capability matrix repo-write honesty** — built this pass (F27-L2). Live-validated.
- **Operator snapshot carries explicit validation + reviewer verdicts** — built this pass (F27-O5).
- **Codex MCP-credential-drop disclosed in the agent's own prompt** — built this pass (F27-P2).

## C. GENUINELY OPEN — a product-design choice (needs an owner call; expands surface)

### C1 — First-run clone PROGRESS indicator (F27-U1)  [the one real build candidate]
**What / why.** The first agent run in a project pays a full bare-mirror clone of the repo
(akin-ozer/viberr ≈ 113-161 MB, ~4 min). Today the run strip shows an honest label
("Cloning … first task … this can take a few minutes") + an elapsed timer, but **no progress %** —
so a first-time user can feel the run is stuck. Later runs reuse the mirror and are fast, so this is
strictly a once-per-project first-impression cost.

**Feasibility (scoped this pass).** The live-update channel ALREADY exists:
`RunReservation.phase(phase, step)` → `patchRun(db, runId, {phase, step})`, and the strip renders the
latest step. So a progress % is tractable WITHOUT new infra.

**Cost / risk (why it's an owner call, not a free win).** It is invasive on a *hardened* critical path:
- `app/server/tasks/repo-mirror.server.ts:315` clones via buffered `execFileAsync`. Progress needs
  `git clone --bare --progress` + a switch to streamed `spawn`, parsing `Receiving objects: NN%` /
  `Resolving deltas: NN%` from stderr — while PRESERVING the existing auth-env/`redactGitOutput`/timeout/
  `dispose` semantics (R21-4 / R21-4b hardening) and the failure-path error text used for redaction.
- Thread an `onProgress` callback through `ensureProjectMirror` → the mirror entry point → the two
  reservation call sites (`specialist-run.server.ts:1337`, `operator-run.server.ts:1353`), throttled to
  ~1/sec so a chatty clone doesn't hammer `patchRun`.
- New tests: stderr-progress parser (unit), and the label composes to "Cloning … · NN%".

**Recommendation.** Buildable and genuinely nice, but it touches a deliberately-hardened path for a
once-per-project cosmetic gain. Worth doing IF the owner wants the polish; otherwise the honest label
is already a reasonable floor. **Owner's call** (this is the item to decide).

### C2 — (No other genuine net-new feature surfaced.)
Everything else discovery raised was either a bug (fixed in PR #226), a test-coverage gap (closed this
pass), by-design (refuted by adversarial verification, with citations in FINDINGS.md), or owner-ruled
above. Proposing more would be inventing surface the app doesn't need — i.e. the bloat the owner asked
me to avoid.

---

## Disposition
- **Bug-hunt + fix pass:** COMPLETE, shipped to mergeable PR #226. Nothing deferred.
- **Forward features:** exactly ONE genuine candidate (C1). Routed to the owner for an informed
  build/skip decision, per the standing "ask about product design choices … so I'm informed" directive
  and the "don't bloat the software" constraint. Will build immediately on a "yes".
