# Pass 24 — live log (2026-08-22)

Baseline: container rebuilt from main `60eade3` (pass 23 merged, PRs #194/#195/#197).
Testing target: running container at http://localhost:5173 (real GitHub auth, docker-data).
Focus: FRESH bug hunt on the post-pass-23 product + 20+ live use cases + real PRs on
`akin-ozer/viberr`.

Method: exercise each surface hands-on, screenshot, probe adversarially, log bugs in
BUG-LOG.md, open owner questions in QUESTIONS.md.

## Session state
- Container: viberr-app-1 healthy on 5173, image built after PR #197 merge.
- Existing data-root project: `viberr` (VIB, akin-ozer/viberr, 4 tasks, 3 decisions waiting).
- Plan: create a NEW project for akin-ozer/viberr for PR-opening tests; use existing/other
  projects for non-PR probing.

## Timeline

### T1 — RETRACTED (was a misread, not a bug)
- I thought the sidebar "Review queue" badge read **8** while the page said 0. Verified against the DOM:
  the `.count` spans read `["0","0"]` (JS `textContent`). The "8" was a MISREAD of a ~8px "0" in an
  800px-downscaled screenshot. LESSON: verify any small on-screen number against the DOM before logging.
- Nav count badges ARE in the accessible name (rail.tsx:72 `<span class="count">0`), concatenated as
  "Review queue0" — cosmetically un-spaced for screen readers but the value is present. Not a bug.

### Live UCs run (pass 24)
- New project creation (Viberr QA Lab, VQL) — clean; repo auto-fill from name (nice default).
- Seeded agents (Operator/Developer/Reviewer) deployed correctly; skills scoped (dev→developer-expertise,
  rev→reviewer-expertise, op→viberr-app-expertise); operator loads only viberr-app-expertise.
- Capability matrix A1 fix confirmed LIVE (web-egress now green for all 3, was "Not granted").
- D1 first-clone hint confirmed LIVE ("Cloning akin-ozer/viberr · first task").
- VQL-1 FULL LIFECYCLE: create→operator triage(auto Triage→Ready→Impl)→deploy Developer(Claude)+refined
  directive→implement(1 file, byte-check evidence)→server opens PR #198→apply "move to Review"→operator
  summons Reviewer→reviewer APPROVE (pinned revision b45be14, evidence separated)→accept ceremony
  (honest disclosure: merges #198→main, revision, verdict, one-way)→**PR #198 MERGED**→branch vql-1
  deleted→Done. End-to-end correct.
- VIB-5 out-of-band close→recovery packet: correct honest coherence (observed).
- BUG-2/A7 honest-toast fix (pass-23) verified in CODE — correctly wired (operatorRefused surfaced;
  route toasts "resolve the open decision"/"reopen the task").
- D2 naming fix confirmed (nav "Instance settings") — except 3 toasts (E-2).
- Skills allowlist fence verified — leftover skill folder in shared cwd is non-invokable (documented residual).
- VQL-2 reject flow: created→delivered PR #199 (in progress; moving to Review to exercise in-app reject).

### Owner questions raised (see QUESTIONS.md) — B-1 (Codex operator sandbox re task.md), B-2 (Codex
operator web egress inert). Everything else: clear fixes, no input needed.
