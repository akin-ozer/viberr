# Documentation validation ledger — 2026-09-01

> What every pre-existing document claimed, what the code on `main` @ `68b5480` actually
> does, and what was done about it. Method: each subsystem was read from source
> (routes, env schema, migrations, schemas, `app/server/*`, scripts, configs, CI) by
> parallel code-truth passes, then each existing document was checked claim by claim.
> Existing documents were never used as evidence for each other. The result is the new
> `docs/` set indexed by [../README.md](../README.md) plus dated corrections in the four
> documents that code comments cite by path.

Limits of this pass: the sandbox had Node 22 and no `node_modules`, so `npm run lint`,
`npm run typecheck` and `npm test` were **not** executed. The one test that pins a
document edited here (`app/shared/docs/file-formats-sync.test.ts`) was replayed by hand
against the edited `## Packet` section (kinds match `PACKET_OPTION_KINDS` in order; every
stated count is 11). `design/prd.md` was not touched, so `prd-sync.test.ts` is unaffected.
Shallow clone: commit hashes cited by older notes (`c1acf2c`, `cbcfe77`, `461d34ab`) could
not be verified.

## 1. Outcome by document

| Document | Verdict | Action |
|---|---|---|
| `README.md` | 14 stale claims (§2) | rewritten in place; points to `docs/README.md` and `AGENTS.md` |
| `CONTRIBUTING.md` | 2 stale claims, links to a removed page | corrected in place |
| `docs/testing.md`, `docs/testing-quickstart.md`, `docs/contributing-quickstart.md` | 4 stale claims, duplicated content | merged into `docs/development/testing.md` and `contributing.md`; old files removed; rulings 41 and 44 annotated |
| `docs/recent-merges.md` | agent live-test artifact listing three PRs from 2026-08-21 | removed |
| `docs/qa/pass29-*.md` | one-line agent live-test artifacts | moved to `qa/` beside the other pass canaries |
| `docs/architecture/decisions.md` | rulings all still describe a live mechanism; 4 preamble claims wrong; 5 enumerations wrong; 8 unmarked partial supersessions; 6 wrong identifiers or paths; route map missing 2 routes; 13 unrecorded owner decisions | dated correction notes added inline (numbers unchanged); new section listing the unrecorded decisions; route map completed |
| `docs/architecture/file-formats.md` | 9 drifts (§6) | corrected in place; the pinned Packet enumeration untouched |
| `docs/operations/deployment.md` | 9 stale claims (§7) | corrected in place |
| `docs/operations/runbook.md` | 12 stale or missing items (§8) | rewritten in place |
| `design/prd.md` | byte-identical to canon | untouched (pinned by test) |
| `design/better-auth-migration.md`, `design/CONVERSATION-SUMMARY.md` | describe a plan not followed as written | left as history; flagged in `docs/README.md` |
| `planning/README.md` | accurate history; no pointer to current docs | pointer paragraph added |
| `planning/planning-artifacts/prd.md` | 39 of 41 FR and 16 of 18 NFR implemented; 11 unrecorded drifts | left as canon; status and drift recorded in [../product/requirements-status.md](../product/requirements-status.md) |
| `planning/planning-artifacts/architecture.md` | 12 of 27 sections accurate, 11 drifted, 4 fossils; 29 claim-level discrepancies | left as design history; replaced as the current description by `docs/architecture/*` |
| `planning/planning-artifacts/ux-design-specification.md` | not validated claim by claim | left; the UI facts that tests enforce are in `docs/ui/surfaces.md` |
| `planning/discovery-*/` | pass ledgers and prior generated docs | left as history |

## 2. README.md

| Claim | Reality | Fixed |
|---|---|---|
| `--reset` wipes "projects, agent deployments, runtime transcripts and all derived state … users/auth and the runtime credential homes survive" | also wipes `kb/`, `skills/`, `org_knowledge_bases`, `org_mcp_servers`, `org_skills`, `google_domain_allowlist`, `user_prefs`, `scope_violations`; GitHub connections and PATs survive | yes |
| scripts table lists 9 scripts | `store:check`, `backup`, `restore`, `keys` missing | yes |
| `npm test` covers `app/` + `db/` | `app/**/*.test.{ts,tsx}` only | yes |
| `docker compose exec app npm run seed` | refused: `seed` takes the writer lock against the running app | yes |
| "that directory is the complete backup surface, database file included" | a raw copy of a live WAL database misses committed rows; `npm run backup` is the sanctioned path; the encryption key lives outside the volume | yes |
| health body has six fields; 503 body `{ ok: false }` | 12 keys; readiness probe `?probe=readiness`; 503 body `{ ok: false, status: "down" }` | yes |
| `scripts/` = seed / seed-demo / rescan | plus backup, restore, e2e, secret-keys, store-check, docker-entrypoint.sh, measure-routes.mjs | yes |
| `server/` list | missing `actions`, `agents`, `insights`, `ops`, `provenance`, `settings` | yes |
| `features/` list | missing `insights` | yes |
| data root "nothing writes a `logs/`, `cache/` or `auth/` directory" | retention writes `audit-exports/`; the image writes `runtimes/uv-cache` and `uv-python` | yes |
| "Org-level audit console" is a gap | org audit browse (150 rows) plus export exist; the gap is filters and paging | yes |
| "Audit rows expire at 90 days, with no export … export is Phase 2" | export-before-purge JSONL, CSV/JSON download, S3 push; pass runs boot + 6 h + disk pressure | yes |
| "`provenance` is the one table with no retention" | six other tables also have none | yes |
| rotating `VIBERR_SECRET_ENCRYPTION_KEY` "orphans stored tokens" | rotation supported via `_PREVIOUS` + `npm run keys` | yes |
| OAuth "disabled until the env vars exist" | providers are configured in-app (ruling 72); env is a bootstrap default | yes |
| fine-grained PAT step names optional `workflow`, classic `repo` + `workflow`, `read:org` | required set is exactly `repo` + `pull_request:write`; validation never writes to the repo | yes |

Confirmed correct and kept: default admin credentials and the empty-users rule; seed is a
clean sheet; presence-only backend detection; the three Codex credential routes; 5-minute
reconcile poller; plain HTTP behind a TLS proxy; no mailer; notifications cap 200; PAT
validation partly assumed.

## 3. CONTRIBUTING.md and the quickstarts

| Claim | Reality | Fixed |
|---|---|---|
| "CI must pass (typecheck, tests, build, e2e)" | lint is the first `verify` step and fails the job | yes |
| "1663 unit tests" | historical count; 295 test files today | number dropped |
| `contributing-quickstart.md`: `npm ci` → `npm test` → `npm run typecheck` → `npm run dev` | `npm run dev` without a `.env` carrying the two secrets dies at boot with `Invalid environment configuration` | page removed; setup order in `development/contributing.md` |
| `testing-quickstart.md`: e2e "is the only gate that runs a real CLI entrypoint" | true only for `npm run seed:demo` via the compose `seed` one-shot | stated precisely in `development/testing.md` |

## 4. docs/testing.md

| Claim | Reality |
|---|---|
| "Runs Vitest over `app/` and `db/` only"; "the dead glob that was removed was a scripts glob" | include is `app/**/*.test.{ts,tsx}`; the removed glob was `db/**/*.test.ts` |
| "The e2e config already sets `VIBERR_DATA_ROOT` to a scratch directory" | e2e runs in Docker on the named volume `e2e-data`; `/e2e/.tmp-data/` in `.gitignore` is a leftover |
| `VIBERR_DATA_ROOT=$(mktemp -d) npm test` needed for isolation | every harness uses its own `mkdtemp` root; only a harness-less `getEnv()` caller would see `./data` |
| "Warnings are printed but do not fail the gate" | every anti-slop rule is `error`; the sentence only applies to oxlint's own warn-level rules |

Kept: production-image e2e, chromium-only, the two sanctioned ways to build state, the
demo-fixture drift guards, verbatim operator narration, the `node_modules` warning.

## 5. docs/architecture/decisions.md

### 5.1 Preamble

| Claim | Reality | Fixed |
|---|---|---|
| schemas = task-file, project-file, sse-event, github-pat | also `goal-file`, `file-diagnostics` | yes |
| SSE names include `task.readiness-changed`, `auth.session-expired` | the first was removed (E9), the second never existed; 11 live names were unlisted | yes, points at `SSE_EVENT_NAMES` |
| errors distinguish user-correctable / inconsistency-diagnostic / infrastructure | never modelled on `AppError` | yes |
| acceptance exception "under the `auto` preset" | `autonomy === "full"` and a literal `completion-for-acceptance: direct`; `auto` is a boundary value | yes |
| "never import server modules into client components" | true for values; type-only imports exist and server→`features/*.server.ts` imports exist | clarified |
| live inventory in `architecture.md` | not regenerated; drifted | pointer to `codebase-map.md` |

### 5.2 Rulings 1–60

33 hold, 18 hold with drift, 2 are process rulings. Corrections added to: 2 (org-role
schema; four modes; ruling 81), 7 (eleven kinds), 10 (queue split), 17 (three callers of
remote deletion), 18 (write probe opt-in), 27 (README wording), 34 (→ 35), 36 (→ 91), 41
(quickstarts folded), 42 (surfacing shipped), 44 (testing.md moved), 49 (path), 54 (line
refs), 55 (identifier), 56 (no typed event; three runtimes), 58 (`recordDeliveredNextStep`).
Citation-namespace collisions recorded for readers of `grep "ruling N"`: "owner ruling 2"
in `templates.ts` and friends is P13-AP-04 (delete the Lightweight preset), "owner ruling
3" in `store-browser.tsx` is P13-LV-06, "ruling 8" in `specialist-mcp.server.ts` is F7-MCP1,
"ruling 19" is cited far beyond scope chips as the general no-synthetic-probe principle.
`CONVENTIONS` has zero live citations; 20 files cite `decisions.md`.

### 5.3 Rulings 61–108

47 of 48 hold in substance. Corrections added to: 77 (F31-6, F28-L1), 83 (Developer seeds
on Claude), 92 (→ 98), 93 (→ 101, with the open modal-copy drift), 108 (blank-post
mechanism). Stale line-number anchors in 81, 82, 93–97 were left (files exist; the doc
cites files by name too). Ruling 89 quotes board placeholder copy that has changed; left.

### 5.4 Route map

`/insights` and `/org/settings/audit-export` added. Per-route guards and intents now live
in [../ui/surfaces.md](../ui/surfaces.md).

### 5.5 Unrecorded owner decisions

Thirteen decisions from 2026-08-21 → 2026-08-31 lived only in code comments or
`planning/discovery-*` ledgers (egress on by default, Codex operator scratch dir,
`read-github-api`, Developer on Claude, model unavailability at the run control, P8/B2,
pass 26–29 items including `pinnedBackend` and the seeded browser grant, R7-4 rework
routing, pass 31 items, the Codex idle-timeout ruling A8). They are now listed in a
dedicated section of `decisions.md`; promoting them to numbers is the owner's call.

## 6. docs/architecture/file-formats.md

| Claim | Reality | Fixed |
|---|---|---|
| data-root layout is the "complete set" of nine dirs | `attachments/`, `.repo-mirror/`, `audit-exports/`, `runtimes/<backend>/*.jsonl`, `agents/definitions/`, `state/writer.lock`, `shipped-assets.json` exist | yes |
| workspace "reclaimed at boot" | at boot and on every maintenance pass, only when no run is live | yes |
| capability `mode: direct \| recommend \| human` | four modes incl. `off`; specialist `recommend` reads as `off` | yes |
| deployment sample lacks `autonomy` | `supervised \| full` on the operator deployment | yes |
| guardrails sample shows one row | four defaults plus `delete-branch-after-merge` (absence = on) | yes |
| task sample omits `priority`, `labels`, `dueDate`, `acceptance`, `goalRef`, `pinnedBackend`, `pr.checks/review/mergeable/revisionDrift`, schedule row fields | all in `taskFrontmatterSchema` | listed in a note |
| body-escape set is `## ### title: to: evidence:` | also `attachments:` (ruling 96) | yes |
| agent actor ref `agent:<backend>/<role-slug>`, label "Claude Code" | `agent:<backend>/<profileId>` with optional role snapshot; label "Claude" (ruling 92) | yes |
| profile sample `model: codex-large · claude-sonnet` | one catalog id; optional `effort` | yes |
| goal parser tolerance unstated | strict: any schema failure is a hard stop | noted |
| unknown profile keys | dropped by the serializer (unlike task/project files) | noted |

## 7. docs/operations/deployment.md

| Claim | Reality | Fixed |
|---|---|---|
| health body six fields; "use it as the readiness probe" | 12 keys; bare URL is liveness; `?probe=readiness` → 503 when degraded | yes |
| data-root layout "is the whole set" | `audit-exports/`, task `workspace/` and `attachments/`, `goals/`, `.repo-mirror/`, `uv-*` | yes |
| second "Restore = drop the directory back — sidecars included" bullet | leftover of the pre-CLI procedure contradicting the bullet above it | removed |
| "Forward `X-Forwarded-For`" suffices | ignored unless `VIBERR_TRUST_PROXY=N` | yes |
| guard "fails closed (loud `logger.error` + exit)" | `writeFatalSync` synchronous stderr line + `lock.abandon()` + exit | yes |
| image ships SDK binaries + git + CA bundle | also chromium, fonts-liberation, uv/uvx | yes |
| integrity log = dirs, migrations, counts | also users, build, disk, and a schema-drift WARN | yes |
| roll back by redeploying the previous image | `build.revision` is `null` in the image; no build ARG exists | noted with the env-var remedy |
| (missing) lock verdict rules, force takeover, CLI refusals | | added |

Confirmed and kept: the two secrets and their formats, key rotation, TLS proxy and the
login-loop failure mode, subscription credentials for both backends, migrations at boot,
bootstrap admin, seed-before-start, backup/restore CLI semantics, re-baselining, the
single-writer rules.

## 8. docs/operations/runbook.md

Rewritten. Stale items replaced: health body and probes; "the DB is a cache" heading;
"or the boot reconcile" (boot rescans, never rebuilds); backend detection "at process
start" (re-probed per call); `applyRetention` "runs once per boot … touches nothing else"
(boot + 6 h + disk pressure; exports audit first; `reapStaleWarmups` also writes at boot);
retention table missing transcripts, session homes and workspaces; "there is no export
path in V1" (three paths exist); "`provenance` is the one table with no retention" (six
others); workspace reclaim "on every boot" (skipped while runs are live; also periodic);
backup by directory copy (superseded by the CLI). Added: `store:check` vs `rescan`, the
lock and CLI refusal table, self-heal and disk pressure, key rotation, quota and
concurrency, boot recovery, F28-A1, `VIBERR_TRUST_PROXY`.

## 9. design/

- `design/prd.md` is byte-identical to `planning/planning-artifacts/prd.md`
  (`md5 24dd8a00b3f9eded6b83a704aecb4b17`), as the test requires.
- `design/better-auth-migration.md` describes an auth migration plan built around
  better-auth organization/member/invitation tables and plugins. The shipped baseline has
  no such tables, `app/lib/auth.server.ts` loads no plugins, org membership is
  `users.role` (`admin | member`) and project membership lives in `project.md`. Read it as
  a discarded plan.
- `design/CONVERSATION-SUMMARY.md` is a conversation digest from the same period; history.
- `design/html-app/` remains the structural source for the UI (decisions.md, UI porting
  rules); `app/app.css` `:root` is the only token source.

## 10. planning/

### 10.1 PRD

Two partial FRs (FR6 transitions are a linear chain; FR8 role definitions are one shared
constant), two partial NFRs (NFR6 TLS delegated; NFR9 no per-task credential narrowing),
eleven drifts without an amendment note, and rulings 100, 101, 105–108 not yet reflected.
Full table: [../product/requirements-status.md](../product/requirements-status.md).

### 10.2 architecture.md

Accurate sections: project context, data architecture, API patterns, frontend, CI and
infrastructure, structure patterns, communication patterns (post pass-31 correction),
process patterns, enforcement, requirements mapping, development workflow. Drifted or
stale, with the claim-level facts now carried by the new docs:

| # | Claim | Reality |
|---|---|---|
| B-1 | "SQLite 3.52.0" | no pinned engine; whatever `node:sqlite` in `node:26-slim` bundles |
| B-2 | OAuth disabled unless env vars present | in-app `oauth_providers` rows override env (ruling 72) |
| B-3 | expired sessions swept at boot and daily | no sweep exists |
| B-4 | authorization from a membership table | membership is read from `project.md`; `project_members` is a projection |
| B-5/B-6/B-26 | table examples `tasks`, `projection_runs`, `uq_` prefix, `:taskId` param | none exist; unique indexes use `idx_`; params are `:slug`, `:key`, `:file` |
| B-7 | error envelope codes are stable machine codes | `run-log.ts` emits `"validation"`, `events.ts` `"unauthorized"`, neither in `ERROR_CODES` |
| B-8 | `task-projection-service.ts` / `rebuildTaskProjection` | invented; the rebuilder is `projections/rebuilder.server.ts` |
| B-9…B-12 | tree lists `skills-lock.json`, omits ≥45 modules, 4 scripts, root dirs | see `codebase-map.md` |
| B-14 | raw NDJSON under `runtimes/claude-home/` | `runtimes/<backend>/<runId>.jsonl`; `audit-exports/`, `uv-*`, `workspace/support/` omitted |
| B-15 | JSON endpoints for comment append / task actions | none; all mutations are form actions |
| B-16 | controller section at ruling 99 | rulings 106–108 missing |
| B-17 | `oauth-google.server.ts` / `oauth-github.server.ts` | do not exist; better-auth `socialProviders` |
| B-18/B-19 | `test-support/helpers/`, `public/assets/` | do not exist |
| B-20 | env parsed only in `env.server.ts` | several ops knobs read `process.env` (now in `configuration.md`) |
| B-21…B-23 | gap analysis and handoff say "not fixed yet", "initialize the scaffold" | all shipped; version 0.19.0 |
| B-27 | schedule when-picker "now / 5m / 1h / 6h / 24h" | option list not found in code; unverified |
| B-28 | surfaces list | omits controller, insights, kb-browser, home |

### 10.3 Discovery ledgers

`planning/discovery-2026-08-31-pass31/docs/00…06` were a prior generated reference set.
They were not reused as evidence; the new `docs/` set supersedes them and is dated.

## 11. Code-side drift found (not changed by this documentation pass)

1. `app/features/agents/capability-matrix-modal.tsx` still says Codex file/command limits
   are "advisory (its runs are not process-sandboxed)"; ruling 101 made them enforced via
   the sandbox mode.
2. Comments in `specialist-run.server.ts` describe Codex repo-write as "advisory since
   R22"; the sandbox enforces it.
3. `shell/top-bell.tsx` and `routes/notifications.tsx` comments say "ruling 9 seeds the
   stub projects" without the demo-only caveat; `user-prefs.server.ts` mentions a retired
   "nudge" pref.
4. `resources.run-log.ts` emits error code `"validation"` and `resources.events.ts`
   `"unauthorized"`; neither is in `ERROR_CODES`.
5. `MANAGED_SETTINGS.claudeMdExcludes` is passed to the SDK though documented inert.
6. `DEFAULT_COMPACTION.threshold` (60) differs from the project guardrail default (40);
   the configured value wins, so the constant is a fallback only.
7. `tools/oxlint/anti-slop/effect/rules/no-service-constructor-imports.ts` exists but is
   not registered.
8. `.claude/launch.json` `viberr-dev` hard-codes a machine-specific data root.
9. The Dockerfile declares no `VIBERR_BUILD_*` ARG though `build-info.server.ts` describes
   one; `build.revision` is `null` in the image.
10. `ops/build-info.server.ts`, `maintenance.server.ts` and `disk-space.server.ts` read
    `VIBERR_BUILD_*`, `VIBERR_MAINTENANCE_INTERVAL_MS`, `VIBERR_DISK_CHECK_INTERVAL_MS`,
    `VIBERR_DISK_LOW_FREE_MB`, `VIBERR_DISK_CRITICAL_FREE_MB` outside the env schema and
    `.env.example`; documented now in `configuration.md`.

## 12. Facts every new page was checked against

Node ≥ 26 · React Router 8 · Vite 8 · Vitest 4 · Playwright 1.62 · oxlint 1.79 · TS 7 ·
better-auth 1.6.25 · Codex SDK 0.146.0 · `@playwright/mcp` 0.0.79 · one migration file ·
timers: lock guard 20 s, watcher debounce 250 ms, schedule and goal runners 60 s, GitHub
reconcile 5 min, disk check 5 min, maintenance 6 h, disk-pressure floor 30 min, SSE
heartbeat 25 s, run idle 15 min, action watchdog 30 s · thresholds: disk low 2 GiB /
critical 512 MiB, run logs 30 d, audit 90 d, notifications 500/user, transcripts 30 d,
session homes 30 d, audit export cap 100 000 rows, audit browse 150 rows, run-log window
400 lines / 384 KiB, SSE ring buffer 256, backpressure 1024 chunks · counts: 32 route
modules, 18 feature surfaces, 25 `app/server` directories, 12 operator tools, 37
controller tools + 3 ops tools, 11 packet option kinds, 4 recommendation kinds, 11
timeline event types, 14 SSE wire events, 108 rulings.

## 13. Superseded by ruling 127 (appended 2026-09-02)

*This ledger is a dated record of what was true on `main` @ `68b5480` and is NOT rewritten.
Ruling 127 (branch `claude/per-user-codex-auth-difdnn`) then made three of its lines false.
They are listed here rather than edited above.*

| Line above | Why it is no longer true |
|---|---|
| §1, `scripts/` = "plus backup, restore, e2e, secret-keys, store-check, docker-entrypoint.sh, measure-routes.mjs" | `scripts/docker-entrypoint.sh` is deleted. It seeded a Codex `auth.json` from a read-only `/host-codex` mount into a shared `$CODEX_HOME`; both the mount and the shared home are gone, and the image declares no `ENTRYPOINT` at all. |
| §1, `--reset` "users/auth and the runtime credential homes survive" | Still true in substance, but the homes are no longer deployment-wide: what survives is `runtimes/users/<userId>/{claude-home,codex-home}`, one set per person, plus the `user_backend_credentials` rows. |
| B-14, "raw NDJSON under `runtimes/claude-home/`" | The correction column is unchanged (`runtimes/<backend>/<runId>.jsonl` is still the raw run log), but `runtimes/claude-home/` no longer exists as a path at all, so the claimed location is now doubly wrong. |

§12's count "108 rulings" was a count of the numbered rulings as of 2026-09-01 and is
likewise a dated statement; `decisions.md` runs 1 to 127 today, with 117
recorded as a number that was never used (126 actual rulings).
