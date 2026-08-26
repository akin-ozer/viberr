# Pass 28 — extended coverage (2026-08-26)

After the main pass (12 findings → PR #230), a second review of the transcript flagged four
listed inspection areas as under-covered. This document records the live end-to-end validation
of each. All work was done on the running owner container (`viberr-app-1`, :5173, pass-27 main)
against the live QA project **Viberr QA 28 (VQT → akin-ozer/viberr)**, driving real Claude runs.

**Result: all four areas validated live; no new bugs found.** This is a positive confirmation
that the knowledge-base, agent-profile, browser-capability, and resource-scoping subsystems work
as designed — it fills the coverage gaps, it does not add to the PR.

---

## 1. Knowledge bases — created + proven loaded by an agent

- Authored an org KB **qa-conventions** (`docker-data/kb/qa-conventions/conventions.md`) whose
  single load-bearing fact is a seeded magic token: `ZEBRA-42-QUOKKA`.
- Granted it to a new profile (see §2). Created task **VQT-4** whose goal forces a KB lookup
  *without naming the value*: "create `planning/qa/kb-check.md` with the pass-28 QA magic token,
  copied verbatim from the qa-conventions KB — do not write it from memory."
- The delivering agent reported: *"the pass-28 QA magic token `ZEBRA-42-QUOKKA` — copied verbatim
  from the qa-conventions knowledge base attached to my profile (not from memory)."*
- Verified on the branch: `git show vqt-4:planning/qa/kb-check.md` → `ZEBRA-42-QUOKKA` (exact).
- **Proves the KB was actually loaded and read.** A profile without the grant could only have
  guessed or refused. Delivered as PR **#231** (workRevision recorded, mergeable clean).

## 2. New agent profile — created + correctly selected by the operator

- Created profile **Docs Specialist** (Claude / Sonnet / effort High; eligible Ready + In Progress;
  delivery-capable; description steers the operator to "documentation and QA-note tasks";
  granted the qa-conventions KB, no skills, no MCP).
- On VQT-4 the operator **discriminated correctly**: it deployed the *Docs Specialist* as the
  delivering agent — not the generic *Developer* — and moved Triage → Ready → In Progress.
  Timeline: *"Deployed Docs Specialist (Documentation, Claude) as the delivering agent."*
- The new profile also threaded correctly into every consumer surface with no manual step:
  Policy page agent-capability matrix (8 direct / 0 recommend / 3 human), the capability matrix
  modal (all actions), and the profile detail (KB chip shown).

## 3. Browser capability — granted + driven live, screenshot attached and served

- Environment check first: the container has `/usr/bin/chromium` and `playwright-mcp` installed,
  and outbound egress works (`fetch(https://example.com)` → 200). (The "chromium layer pending"
  caveat from the R19-19 pass has since been resolved by the owner's rebuild.)
- Granted **Drive a live web browser** (default-off, R19-19) to the **Developer** profile.
- Created task **VQT-5**: "navigate to https://example.com, screenshot it, attach as evidence,
  report the H1 — do not touch any repository files."
- Operator judgment (subtle, correct): because the task explicitly forbids repo changes, the
  operator engaged Developer as a **supporting agent**, not a *delivering* agent — no branch/PR
  is expected, only evidence. (Contrast VQT-4, a delivery task, where it deployed a *delivering*
  agent.)
- The agent drove chromium to example.com and produced:
  - `page-…-842Z.png` — a real **PNG, 1280×720, 8-bit RGB, 17.7 KB**
  - `page-…-873Z.yml` — an accessibility snapshot holding the real DOM
    (`heading "Example Domain" [level=1]`, the "for use in documentation examples" paragraph,
    the iana.org "Learn more" link).
  - Reported H1 = **"Example Domain"** (correct).
- Full path verified: files land in `tasks/VQT-5/attachments/`; the member-only route serves the
  PNG (`GET …/attachments/…png` → 200, `image/png`, 17781 bytes, magic `89 50 4e 47`); the
  task-detail Attachments panel renders the screenshot inline as a decoded `<img>` (1280×720)
  with size + attribution.

## 4. UI/UX holistic coherence review

Reviewed Home, Board, List, Agents, Policy, Settings, GitHub, Activity, Review queue, and
Task detail. The product is internally consistent — **no incoherence found**:

- **Terminology is stable across surfaces**: delivering vs supporting agent (a meaningful
  distinction the operator uses correctly), operator, verdict, completion, review boundary; the
  capability vocabulary (Acts directly / Recommends / Reserved for humans / Human-only / Off /
  Not granted) reads identically on the Policy page, the capability-matrix modal, the profile
  detail, and the profile edit form.
- **State vocabulary is coherent**: stages Triage/Ready/In Progress/Review/Done everywhere in the
  UI (the internal `impl` id is never surfaced); the third-person "N waiting on a human in this
  project" (board header) vs first-person "waiting on you" (a card that needs *your* action) is a
  correct, deliberate split, not a slip.
- **Empty states are written, not blank** (Review queue, board columns, Active deployments).
- **Traceability is consistent**: task key flows task → branch → commit → PR on the GitHub page
  and the cards; timestamps are local in the UI and UTC in the store throughout.
- **Resource scoping is correct** (directly answers "are the right skills loaded?"): the Docs
  Specialist loaded only its granted KB (no skills, no MCP); the Developer carried only
  developer-expertise + qa-echo + (now) the browser MCP. No agent pulled an unrelated resource.

---

## Left on the container (additions to the pass-28 continuity list)
- KB **qa-conventions** (org) + profile **Docs Specialist** (QA 28).
- Profile **Developer** (QA 28) now has *Drive a live web browser* granted (forked copy).
- Tasks **VQT-4** (PR #231 open, unmerged — a throwaway token file; left for the owner to merge
  or reject) and **VQT-5** (evidence-only, no PR; screenshot + a11y snapshot attached).
- PR #231 was deliberately **not merged** — merging a throwaway QA file would bloat the repo,
  against the owner's "small files only" instruction. main stays clean.
