# Implementation prompt for a fresh-context agent (pass 36 fixes)

You are implementing one cluster of PLAN.md in `/Users/akinozer/projects/viberr` on the
branch `pass36/headlamp-clone-fixes` (create it from `main` if it does not exist; never commit
to `main`). Read, in this order, before touching code:

1. `CLAUDE.md`, `AGENTS.md`, `docs/README.md`, `docs/development/contributing.md` (the writer
   rule: canonical files are written only through `updateTaskFile` / `appendTimelineEvent` /
   `patchTaskFrontmatter`; tests never use `vi.mock`; no Tailwind, no hex colours; rulings are
   numbered and live in `docs/architecture/decisions.md`, last used 176 before this pass).
2. `planning/discovery-2026-09-11-pass36-headlamp-clone/PLAN.md` — your cluster's items, the
   ruling text to add, the test homes and the live checks.
3. `planning/discovery-2026-09-11-pass36-headlamp-clone/CODE-CHECKS.md` — file:line paths for
   every item (read the section letter the plan names; every line there was read, not inferred,
   against `main` at `e0953f7f`; re-verify the lines still match before editing).
4. `planning/discovery-2026-09-11-pass36-headlamp-clone/FINDINGS.md` — what was observed live
   and why it matters (the row id is in your item's title).
5. `planning/discovery-2026-09-11-pass36-headlamp-clone/QUESTIONS.md` — owner decisions
   (Q36-1..11); the plan already encodes them; if your item depends on an unanswered one, stop
   and say so.

Rules for the work:

- Preprod: no migrations, no backwards compatibility shims, break freely; delete what the fix
  retires (copy, dead branches, the old predicate) instead of leaving both.
- Every fix needs a test that goes RED against the unfixed source. Write the test first, run it,
  paste the failure line into your report; then fix; then run it green. If the test cannot fail
  without the fix (it passes before the fix), it is not the test — rewrite it.
- Keep each item's change inside the files the plan names unless the code forces otherwise;
  say so in the report when it does.
- Run `npm run lint && npm run typecheck && npm test` before reporting. `npm run e2e` needs the
  compose container stopped (`docker compose stop app`) because only one process may hold the
  data root (ruling 158); start it again afterwards (`docker compose up -d`).
- The live data root at `docker-data/` belongs to the running pass. Do not edit its files by
  hand; do not open `docker-data/projection.sqlite` from a second process (copy the db + wal
  first if you must read it).
- Docs are part of the change: the ruling text goes into `decisions.md` under its number; the
  domain doc the plan names gets the behaviour; tool descriptions match the code.
- No `Co-Authored-By: Claude` trailer on commits; no "Generated with Claude Code" line in PR
  bodies. Commit messages in the repo's style (a sentence that names the behaviour, then why).

Report format (one message): per item — the test name + its red failure line + the source
hunk you reverted to prove it; what changed (files); anything the plan got wrong and how you
resolved it; gate results verbatim (lint/typecheck/test counts); what remains for the live
re-validation the plan lists.
