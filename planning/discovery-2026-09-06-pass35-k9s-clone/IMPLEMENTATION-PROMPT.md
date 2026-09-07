# Pass 35 — implementation brief for fresh-context agents

You are fixing what the pass-35 observation found. Everything you need is in this directory;
read in this order, then the code the plan names.

1. `FINDINGS.md` — the ledger (F35 defects, G35 gaps, U35 coherence). Each row carries the
   evidence (task key, run id, audit action, timestamp, screenshot name). Only these are in
   scope; nothing cosmetic.
2. `QUESTIONS.md` — the owner's decisions. Q35-1 is a ruling: a declared `approval` boundary
   always routes to a human recommendation, `human` refuses, `direct` covers `auto` only.
   Q35-5: coordination cost is a product gap to solve, not to document.
3. `PLAN.md` — the code-anchored fix plan: root cause with file:line, fix design with the
   rendered sentences, the test that goes red when the source is broken, live validation,
   blast radius, slices that can run in parallel, gates. Follow it; where the code has moved,
   re-anchor and say so in your report.
4. `reference/` — the code-verified map of every surface (INDEX.md first). Use it instead of
   re-reading the whole repo: tool names and parameters, packet kinds and writers, capability
   ids and modes, delivery states, record layout, in-container DB read recipes, UI labels.
5. `NOTES.md` — the chronology with every verified record; `COVERAGE.md` — what was
   exercised and the evidence; `SCREENSHOTS.md` + `screenshots/` — what the surfaces looked
   like; `controller-reply-*.md` — the controller's own reports; `RBAC-PROBE.md` — the
   four-role matrix results.

## Environment facts that bite

- The live instance is the compose container `viberr-app-1` on `docker-data` (bind-mounted at
  `/data`). Never open its SQLite from the host; read it in-process:
  `docker exec -i viberr-app-1 node - < script.js` with
  `new DatabaseSync("/data/state/projection.sqlite", {readOnly: true})` and SINGLE-quoted SQL
  string literals (double quotes are identifiers). Scripts used this pass live in the session
  scratchpad (`q-tasks.js`, `q-packets.js`, `q-audit.js`, `q-runlog.js`, `q-ctl.js`,
  `q-hash.js`); their shapes are in `reference/record-verification.md`.
- Files are truth: `docker-data/projects/k9c-k9s-clone/{project.md,tasks/*/task.md,goals/*.md}`
  and `docker-data/agents/profiles/*.md`; the `## Packet` section of a task file is fenced
  YAML. `task_events.id` is reassigned on re-projection; key on `occurred_at`.
- Run transcripts: `docker-data/runtimes/claude/<runId>.jsonl`; the `run_inputs` line names
  what mounted (skills, KBs, `mcp.mounted`).
- The Browser pane was hidden most of the pass: drive the app with headless Playwright
  persistent profiles (`drive.mjs` + per-script modules in the scratchpad; profiles for arda,
  maya, omar, lena, noah). Two Chromium processes cannot share one profile; clone it.
- Container clock is UTC; provider reset times in vendor text are printed in that zone.
- Gates: `npm run lint && npm run typecheck && npm test && npm run build`; `npm run e2e`
  needs Docker and boots the production image. Local oxlint may differ from CI: judge by the
  delta against main. No `vi.mock`, no inline hex, no `console.log` under `app/server`, no
  suppression lists; every `as` cast needs a `SAFETY:` comment; rendered copy bans em/en
  dashes and "govern*"; `app.css` has structural gates (`app/app.css.test.ts`).
- Pre-production: no migrations, no backwards compatibility; schema changes go into
  `db/migrations/0001_baseline.sql` and `BASELINE_COLUMNS`; docs pages under `docs/` are
  updated in the same change and owner decisions become the next numbered ruling in
  `docs/architecture/decisions.md` (150 is the last used).
- Never push to `akin-ozer/k9s-clone` by hand except the two observer fixtures already made;
  viberr fixes go on a branch of `akin-ozer/viberr` and a PR there.
