import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import {
  kbDirPath,
  kbRootDir,
  skillDirPath,
  skillsRootDir,
} from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import { ensureOrgStoreDirs } from "./resources.server";

/**
 * Org-resource seed (Phase 9B) — ADDITIVE to the phase-3/8 demo seed:
 * knowledge bases with REAL files under ${DATA_ROOT}/kb/, skills with real
 * SKILL.md folders under /skills/, and the @viberr.dev Google domain
 * allowlist row. Honest empty slate (owner ruling): NO MCP servers and NO
 * GitHub connection are seeded — an admin installs real ones; nothing
 * fabricated is presented as configured (see the note by the seed body).
 *
 * Non-destructive re-seed (seed #5): a KB or skill whose folder already exists
 * is left untouched — its files, row name and UI-set refresh cadence survive a
 * plain `npm run seed`; only MISSING resources are (re)created. First-run and
 * post-`--reset` stores seed fresh, with deterministic row ids and back-dated
 * file mtimes so the browser shows the mock's date spread. Any GitHub
 * connection an admin already installed is left intact and survives `--reset`
 * (like the phase-7 PAT tables). `--reset` wipes kb/, skills/ and the resource
 * tables + domain rows, then reseeds them.
 */

export interface OrgSeedSummary {
  kbs: number;
  kbFiles: number;
  skills: number;
  mcps: number;
  domains: number;
  connections: number;
}

interface SeedFile {
  /** Path relative to the resource folder (may contain "/"). */
  rel: string;
  content: string;
  /** Back-dated mtime: [month(1-12), day, hour?]. */
  date: [number, number, number?];
}

const KB_SEEDS: {
  id: string;
  name: string;
  dir: string;
  refresh: "manual" | "on change";
  indexed: [number, number, number?];
  files: SeedFile[];
}[] = [
  {
    id: "kb_seed_arch",
    name: "Architecture notes",
    dir: "architecture-notes",
    refresh: "on change",
    indexed: [7, 1, 9],
    files: [
      {
        rel: "decisions/adr-001-task-store.md",
        date: [3, 30],
        content:
          "# ADR-001: Task files are the canonical store\n\n## Status\nAccepted.\n\n## Decision\nEvery task lives as `tasks/<KEY>/task.md` under the project folder. SQLite rows are projections, rebuilt from files, never the other way around.\n\n## Consequences\n- External edits are first-class: the watcher reprojects on change.\n- Rollback is `git checkout` of a folder, not a DB migration.\n",
      },
      {
        rel: "decisions/adr-002-operator-model.md",
        date: [4, 14],
        content:
          "# ADR-002: One operator per active task\n\n## Status\nAccepted.\n\n## Decision\nA dedicated operator runtime is instantiated per active task. It coordinates specialists and compresses agent work into decision packets; it never writes code and never closes a task.\n\n## Consequences\nHuman acceptance stays the only path to Done.\n",
      },
      {
        rel: "decisions/adr-003-event-types.md",
        date: [5, 2],
        content:
          "# ADR-003: Nine typed timeline events\n\n## Status\nAccepted.\n\n## Decision\nThe nine types are `comment · completion · github · policy · quality · transition · blocked · agent · assign`. Everything else is rejected before it reaches the timeline.\n",
      },
      {
        rel: "diagrams/context-map.md",
        date: [6, 11],
        content:
          "# Context map\n\n```\nfiles (truth) → parser → projections (sqlite) → loaders → UI\n            ↘ diagnostics → readiness floor\n```\n\nGitHub state is a cached projection, reconciled on demand.\n",
      },
      {
        rel: "overview.md",
        date: [7, 1],
        content:
          "# Architecture overview\n\nViberr is a file-native delivery workspace: agents do stage work, humans govern flow, review and acceptance.\n\n- Canonical truth: markdown files under the data root.\n- Projections: SQLite, rebuilt by rescan or the watcher.\n- Live updates: SSE, compact facts only.\n",
      },
      {
        rel: "glossary.md",
        date: [6, 20],
        content:
          "# Glossary\n\n- **Packet**: an operator decision request with options.\n- **Readiness**: ready · input_required · inconsistency_risk_detected · blocked.\n- **Boundary**: auto · approval · human transition gate.\n",
      },
    ],
  },
  {
    id: "kb_seed_api",
    name: "API contracts",
    dir: "api-contracts",
    refresh: "on change",
    indexed: [6, 28],
    files: [
      {
        rel: "endpoints/tasks.md",
        date: [6, 28],
        content:
          "# Task endpoints\n\nLoaders return route-shaped data; the rare JSON endpoints use `{ data, meta? }` on success and `{ error: { code, message } }` on failure.\n\n- `GET /projects/:slug/board` returns the board projection.\n- `POST /projects/:slug/tasks/:key` accepts the intents comment, resolve-packet, owner, and transition.\n",
      },
      {
        rel: "endpoints/projects.md",
        date: [6, 15],
        content:
          "# Project endpoints\n\nProject state lives in `project.md`; mutations go through the writers and reproject before responding.\n",
      },
      {
        rel: "endpoints/agents.md",
        date: [6, 21],
        content:
          "# Agent endpoints\n\nRun lifecycle: queued · running · finished · error · interrupted. Raw NDJSON is truth; LogLine display is a projection.\n",
      },
      {
        rel: "schemas/task-contract.md",
        date: [5, 30],
        content:
          "# Task contract\n\nKey `/^[A-Za-z]+-\\d+$/`, one human owner, one delivering agent, 0..n reviewers. Timestamps are UTC ISO at every boundary.\n",
      },
      {
        rel: "schemas/event-types.md",
        date: [6, 2],
        content:
          "# Event types\n\nSSE names are lowercase dot-separated facts: `task.updated`, `projection.rebuilt`, `run.log-appended`. Payloads are compact facts, never fat objects.\n",
      },
      {
        rel: "versioning.md",
        date: [5, 8],
        content:
          "# Versioning\n\nBreaking file-format changes require a migration note in docs/architecture and a tolerant-parse window of one release.\n",
      },
    ],
  },
  {
    id: "kb_seed_runbooks",
    name: "Deploy runbooks",
    dir: "deploy-runbooks",
    refresh: "on change",
    indexed: [7, 3, 2],
    files: [
      {
        rel: "incidents/rollback.md",
        date: [6, 9],
        content:
          "# Rollback\n\n1. `git revert` the release merge; never force-push main.\n2. Re-run the deploy pipeline with the revert SHA.\n3. Write a `blocked` event on the affected tasks with the incident link.\n",
      },
      {
        rel: "incidents/hotfix-flow.md",
        date: [6, 9],
        content:
          "# Hotfix flow\n\nBranch from the release tag, task-key prefix as usual, review boundary stays human. Hotfixes are not an excuse to skip acceptance.\n",
      },
      {
        rel: "release-checklist.md",
        date: [7, 1],
        content:
          "# Release checklist\n\n- [ ] All review-stage tasks accepted or bumped\n- [ ] Validation suite green on main\n- [ ] Changelog entries generated (changelog-writer skill)\n- [ ] Rollback point tagged\n",
      },
    ],
  },
  {
    id: "kb_seed_repo_conventions",
    name: "Repo conventions",
    dir: "repo-conventions",
    refresh: "on change",
    indexed: [8, 21, 10],
    files: [
      {
        rel: "architecture/decisions-conventions.md",
        date: [8, 21],
        content: "<!-- Excerpt from docs/architecture/decisions.md (this repo, akin-ozer/viberr): the Layout, Data & naming, Behavior rules and UI porting sections. The file also carries a long numbered \"ORCHESTRATOR RULINGS\" log (append-only decision history); that log is intentionally NOT mirrored here — read docs/architecture/decisions.md in the repo for the full ruling history and citations like \"ruling N\". -->\n\n# Binding decisions & conventions\n\nThis is the normative contract that code comments across the tree cite as **CONVENTIONS**\nand as **\"orchestrator ruling N\"**. It condenses\n[`planning/planning-artifacts/architecture.md`](../../planning/planning-artifacts/architecture.md),\nwhich wins on conflict.\n\n**Provenance.** The content below was recovered from `docs/build/CONVENTIONS.md`, which was\ndeleted in commit c1acf2c (\"Remove obsolete code and simplify project structure\") along\nwith the rest of `docs/build/`. Sixteen comments in fifteen files still cited it by name\nand another ten cited its numbered rulings, so the deletion left binding decisions\nreadable nowhere — the exact failure mode that produced the six regressions commit cbcfe77\nhad to repair. The ruling **numbers are preserved verbatim** so every existing `ruling N`\ncitation resolves here.\n\n**How to read a superseded ruling.** Several rulings have been narrowed or reversed by a\nlater owner decision. Those are marked **SUPERSEDED** inline, with what replaced them and\nwhen. A superseded ruling is kept, not deleted: its number is still cited in code, and\nknowing what the old rule *was* is how you avoid re-implementing it. Never restore a\nsuperseded rule because you found the ruling text.\n\n---\n\n## Layout\n\n```\napp/\n  root.tsx, routes.ts, app.css, entry.client.tsx, entry.server.tsx\n  routes/          # thin route modules only; delegate to features/server\n  ui/              # reusable primitives — MUST NOT import from features/\n  lib/             # better-auth instance + its Viberr bridge\n  features/        # per-surface UI + loaders/actions glue\n  schemas/         # shared Zod schemas (task-file, project-file, sse-event, github-pat)\n  server/          # server-only modules\n  shared/          # narrow cross-surface helpers\ndb/migrations/*.sql   scripts/*.ts   e2e/   test-support/\n```\n\nThe live folder inventory is in\n[`architecture.md`'s directory structure](../../planning/planning-artifacts/architecture.md#complete-project-directory-structure);\nit is regenerated from the filesystem rather than restated here.\n\n- Server-only files: `*.server.ts` suffix. Never import server modules into client\n  components.\n- Tests co-located: `foo.server.test.ts`. No `utils.ts` / `helpers.ts` dumping grounds.\n- Files/dirs kebab-case; components/types PascalCase; vars/functions camelCase; constants\n  UPPER_SNAKE_CASE.\n\n## Data & naming\n\n- **SQLite:** plural snake_case tables (`users`, `task_projections`, `audit_events`,\n  `notifications`), snake_case columns, `<entity>_id` FKs, `idx_<table>__<cols>` indexes. DB\n  rows map to camelCase through the centralized mapping modules in `app/shared/mapping/` —\n  never ad hoc at a call site.\n  **Exception, and it is not ours to rename:** better-auth owns four tables and names them\n  in the SINGULAR with camelCase columns — `user`, `session`, `account`, `verification`\n  (`db/migrations/0001_baseline.sql`). Its adapter generates the SQL, so the convention\n  above applies to Viberr's own tables only. *(Corrected 2026-08-06, pass 19 — the example\n  list here said `sessions`, a table that does not exist. That invented name had already\n  propagated into `docs/operations/runbook.md`, which described a sweep of it; F19-17.)*\n- **TS/JSON:** camelCase. Timestamps are UTC ISO 8601 strings at all boundaries and in\n  files. Booleans stay booleans; null stays null.\n- **Readiness values** are exactly `ready` | `input_required` |\n  `inconsistency_risk_detected` | `blocked`. Derivation lives ONLY in\n  `app/server/interpretation/readiness-policy.server.ts`.\n- **JSON endpoints** (rare, only for automation): success `{ data, meta? }`, error\n  `{ error: { code, message, details? } }`, real HTTP status codes. Loaders return\n  route-shaped data directly; route *actions* are exempt and return their own result\n  shapes.\n- **SSE:** event names are lowercase dot-separated facts (`task.updated`,\n  `task.readiness-changed`, `projection.rebuilt`, `run.log-appended`,\n  `auth.session-expired`); payload is `{ type, entityId, occurredAt, data }` — compact\n  facts and references, never fat objects. The wire shape is parsed before publish because\n  it is a contract.\n- **Errors:** typed `AppError` with stable machine codes (`app/server/errors/`). Never leak\n  stack traces or secrets to users. Distinguish user-correctable / inconsistency-diagnostic\n  / infrastructure.\n\n## Behavior rules\n\n- Files are the only canonical business truth. The app writes files through dedicated\n  writer modules (frontmatter-preserving), then re-parses → re-projects → publishes SSE.\n  Never write projections without file backing for task/project state.\n- Tolerant parsing: malformed input produces diagnostics plus a readiness downgrade\n  (`input_required` / `inconsistency_risk_detected` / `blocked`), never a crash, never a\n  silent drop.\n- No optimistic UI for governed state. Revalidate after the action and on SSE.\n- Mutating actions must be idempotent-safe (idempotency keys or existence checks) — a\n  retry must not duplicate transitions, branches, PRs or events.\n- Every governed action (approval, transition, ownership change, policy change, PAT change,\n  run start/interrupt) writes an audit event and, where user-visible, a typed timeline\n  event in `task.md`.\n- Secrets come only from env; PATs are AES-256-GCM encrypted in SQLite; secrets never\n  appear in files under `projects/`, in logs, in SSE payloads, or in error messages.\n- RBAC applies to actions, not to file existence. Agents get a per-project capability\n  policy, enforced server-side on agent-triggered actions.\n- Human-only, enforced server-side: transition to Done, and completion acceptance.\n  **Narrowed** — see ruling 2 and the note under FR27 in the PRD: under the `auto` preset,\n  a full-autonomy operator holding an explicit `completion-for-acceptance: direct` grant\n  may accept and move a task to Done itself. That is the one deliberate exception, and it\n  is disclosed in the UI. Every other path to Done stays human.\n\n## UI porting rules\n\n- The mock (`design/html-app/app/*.jsx`) is the design source of truth: reproduce\n  structure, class names and behavior 1:1, unless the mock is prototype-only (localStorage\n  session, `location.href` page hops, `window.VIBERR` globals) — replace those with real\n  routes/loaders/actions/SSE. Record deliberate departures from the mock in a comment at\n  the departure site.\n- Keep `viberr.css` classes and CSS variables exactly; add new CSS only in clearly-marked\n  appended sections of `app/app.css`. No Tailwind, no inline hex colors — use the existing\n  tokens. A `var(--x)` that is not defined in `:root` is a bug, not a style choice.\n  *(Clarified 2026-08-06, pass 19 — N19-4.)* \"Exactly\" bound the class names and the naming\n  convention (flat, unprefixed), and those held. It does **not** make the mock's VALUES\n  authoritative, and several have deliberately diverged: shipped `--radius-card` is 16px and\n  `--radius-panel` 22px against the mock's 18/28, there is no canvas/large radius token, the\n  display face is Manrope not Roobert PRO, and `--pink` / `--dark-red` / `--radius-large`\n  exist in `design/*.html` and nowhere in the app. `app/app.css`'s `:root` is the ONLY token\n  source; read a value there, never out of the mock.\n- Icons: one ported `Icon` component in `app/ui/icon.tsx`, reused everywhere.\n- Theme: light/dark/system, persisted per user (profile) plus a cookie for SSR-safe first\n  paint.\n- Toasts for action feedback; packet-styled confirm dialogs. A failure toast must not\n  render the success tick — pass the toast kind explicitly.\n- Loading states: React Router pending state. No spinners-forever; long operations report\n  server-derived progress.\n- Accessibility: keep the mock's `aria-*` usage, visible focus, keyboard menus and dialogs\n  (Escape closes, scrim click closes). The WCAG 2.2 AA baseline in\n  [the PRD](../../planning/planning-artifacts/prd.md) applies to core workflows in both\n  themes.\n",
      },
      {
        rel: "architecture/decisions-route-map.md",
        date: [8, 6],
        content: "<!-- Excerpt from docs/architecture/decisions.md (this repo, akin-ozer/viberr): the route map. -->\n\n## Route map\n\n```\n/login  /logout  /api/auth/*            (better-auth, incl. OAuth callbacks)\n/                                       → home (project list)\n/projects                               → home (bare /projects is not a 404 — N5)\n/projects/:slug                         → redirect to board\n/projects/:slug/board  /review  /agents  /policy  /github  /activity  /settings\n/projects/:slug/tasks/:key\n/projects/:slug/tasks/:key/attachments/:file   (R19-19 — member-only, raw bytes)\n/org/settings                           (org admin, tabbed)\n/profile   /notifications   /notifications/read   /prefs/theme\n/resources/events  (SSE)   /resources/health   /resources/run-log\n/resources/search   /resources/session-export   /resources/model-catalog\n```\n\n*(Corrected 2026-08-06, pass 19, against `app/routes.ts`: `/projects`, `/notifications/read`,\n`/prefs/theme` and `/resources/search` — the ⌘K palette query from ruling 23 / R15-5 — ship but\nwere never added here.)*\n",
      },
      {
        rel: "architecture/file-formats.md",
        date: [7, 20],
        content: "# Canonical file formats (file-native store)\n\nDecided and owned by Phase 3. Files under `${VIBERR_DATA_ROOT}` are the ONLY\ncanonical business truth for projects and tasks; SQLite holds projections.\nHumans and agents may edit these files directly — the watcher (250 ms\ndebounce) and the manual rescan reconcile them into projections. The UI\nalways renders the REAL store-relative path (`projects/<slug>/tasks/<KEY>/task.md`),\nnever the mock's `.viberr/…` (orchestrator ruling 3).\n\nData-root layout (created at boot by `app/server/files/file-store-root.server.ts`):\n\n```\n${VIBERR_DATA_ROOT}/\n  projects/<slug>/project.md              ← project truth\n  projects/<slug>/tasks/<KEY>/task.md     ← task truth (+ attachments/ later)\n  projects/<slug>/tasks/<KEY>/workspace/  ← the agent's git clone; NOT canonical,\n                                             not watched, not projected. 11-16 MB per\n                                             task; reclaimed at boot once the task\n                                             reaches its terminal stage\n  agents/profiles/<id>.md                 ← org-level agent profile templates\n  runtimes/claude-home/ runtimes/codex-home/\n                                          ← NDJSON run logs + SDK session homes\n  kb/<dir>/  skills/<slug>/               ← knowledge-base and skill folders\n  state/projection.sqlite                 ← SQLite (never canonical for tasks)\n```\n\nThat is the complete set `DATA_ROOT_SUBDIRS` creates. There is no `cache/`, `auth/` or\n`logs/` directory — they were removed on purpose (P11-56); application logs are structured\nJSON on stdout, and secrets live encrypted in SQLite. Note that `state/projection.sqlite`\nis *never canonical for tasks*, but it **is** primary storage for users, sessions, PATs,\naudit and notifications; see\n[`docs/operations/deployment.md`](../operations/deployment.md#persistence-backup--restore).\n\nGeneral rules for both file kinds:\n\n- **Frontmatter** is YAML between `---` fences; UTF-8; timestamps are UTC\n  ISO 8601 strings. Unknown frontmatter fields are ALWAYS preserved by the\n  writers (round-trip safe for future/foreign fields).\n- **Tolerant parsing** (`app/schemas/*.schema.ts`): missing/invalid fields\n  produce structured diagnostics + safe fallbacks. Parsing never throws and\n  never drops an entity. Diagnostics floor readiness (warning →\n  `input_required`, error → `inconsistency_risk_detected`, hard stop →\n  `blocked`) — see `app/server/interpretation/`.\n- **Atomic writes**: writers stage to `<file>.<rand>.tmp` and rename; the\n  watcher ignores dotfiles and `*.tmp`. All writer mutations run under a\n  per-file in-process mutex.\n\n---\n\n## 1. `projects/<slug>/project.md`\n\nFrontmatter (all governed project state) + markdown body (description).\n\n```markdown\n---\nname: Viberr Core\nslug: viberr-core\nrepo: akin-ozer/viberr            # THE project's GitHub repo (one per project)\ndefaultBranch: main\ntaskPrefix: VIB                   # task keys: VIB-142\nnextTaskNumber: 169               # atomic per-project key counter\nstages:                           # per-project, ordered (ruling 15)\n  - id: triage\n    name: Triage\n    color: \"#a5a8b5\"              # hex or var(--*) both accepted\n  # … ready / impl / review / done\nworkflow:                         # governed boundaries: auto|approval|human\n  - from: triage\n    to: ready\n    boundary: approval\n    by: Human, after the quality gate — agents may flag underspecified tasks\n    locked: false\n  - from: review\n    to: done\n    boundary: human               # locked human in V1, server-enforced\n    locked: true\nmembers:                          # project roles (4-role system, contracts §3.2)\n  - userId: u_abc123\n    role: admin                   # admin | maintainer | contributor | viewer\n                                  # (strict tier; `reviewer` was renamed `contributor` —\n                                  # ruling 2 amendment. Source of truth: app/shared/rbac.ts)\nagents:                           # per-project DEPLOYMENT of profile templates\n  - profileId: developer\n    capabilities:                 # id-based against CAP_CATALOG (ruling 2)\n      - capabilityId: create-task-branch\n        mode: direct              # direct | recommend | human\n    extras:                       # display-only bespoke labels (near-misses)\n      - label: Push commits to the branch\n        mode: human\ncredentialPolicy:                 # NON-secret policy; the PAT itself lives\n  credentialLabel: viberr-bot · fine-grained PAT     # AES-encrypted in SQLite (Phase 7)\n  masked: github_pat_••••42af\n  requiredScopes: [repo, pull_request:write]   # the exact minimum (ruling 18);\n                                  # `workflow` and `read:org` were dropped 2026-07-25\nguardrails:\n  - id: compression-threshold\n    desc: Long timelines compress once routine events pass the threshold; typed events are always kept.\n    on: true\n    value: 40\n    unit: events\n---\n\nProject description prose (markdown body).\n```\n\nNotes:\n\n- `nextTaskNumber` backs `allocateTaskKey` (project-writer): the counter is\n  read+bumped under the project.md mutex; a max-scan of existing\n  `tasks/<PREFIX>-<n>` directories rescues a stale/missing counter. Concurrent\n  creates can never mint the same key.\n- Membership is authoritative here (files are truth); `project_members` in\n  SQLite is its projection. Guest detection (the \"app user · not in project\"\n  pill) derives from this list at projection time.\n- **Two-layer agent model**: `agents/profiles/<id>.md` are ORG templates\n  (backends, eligible stages, base capability policy, resources, description\n  body). A project's `agents:` list *deploys* templates by `profileId` and\n  carries the project-effective capability policy (may override the\n  template). Task assignments store `profileId` — never joined by role text.\n- The three always-human capabilities (`merge-pull-request`,\n  `transition-to-done`, `change-project-policy`) are a server invariant list\n  (`ALWAYS_HUMAN_CAPABILITY_IDS` in `app/shared/capabilities.ts`) — stored\n  modes can never grant them to agents.\n\n## 2. `projects/<slug>/tasks/<KEY>/task.md`\n\nFrontmatter (scalar task state) + three body sections: `## Goal`,\n`## Packet` (only while a decision packet is open), `## Timeline`.\nUnknown `## Sections` are preserved verbatim.\n\n````markdown\n---\nkey: VIB-142\ntitle: Attach execution workspace to task runtime\nstage: review                     # id into the project's stage list\nreadiness: input_required         # canonical 4-value enum ONLY (ruling 1):\n                                  # ready | input_required |\n                                  # inconsistency_risk_detected | blocked\nwaiting: human                    # human | agent | none (secondary signal)\nownerUserId: u_abc123             # ONE human owner; null when unowned\nengagements:                      # ONE uniform list of engaged agents (G1).\n  - profileId: developer          # At most one entry has delivers: true — that\n    backend: codex                # is the workspace/branch/PR owner.\n    role: Developer               # display snapshot, taken at engage time\n    delivers: true\n    verdictCapable: false\n  - profileId: reviewer           # a supporting engagement; verdictCapable is\n    backend: claude               # snapshotted from an EXPLICIT\n    role: Review & validation     # report-validation-verdict:direct grant, and\n    delivers: false               # makes this a REQUIRED reviewer\n    verdictCapable: true\noperator:                         # null in triage (ruling 16: store stage id;\n  assignedAtStageId: triage       # UI renders \"stage <1-based index>\")\nrecommendations: []               # pending operator recommendation cards\nschedules: []                     # pending/fired scheduled operator re-runs (O-3)\nurgent: true                      # optional; absent ≡ false\nvalidation: changed               # healthy | changed | failing | none | bypassed\n                                  # (`bypassed` = a human force-accepted past the\n                                  # verdict gate, N20-14) — DERIVED cache,\n                                  # recomputed on every write. This list IS\n                                  # VALIDATION_VALUES (task-file.schema.ts), and\n                                  # task_projections' CHECK mirrors it (F21-1)\nworkRevision:                     # the immutable revision under review, or null\n  id: rev_9f2c\n  headSha: a91f7c2e…              # full SHA\n  treeSha: 4d81b0a…               # null when git could not resolve it\n  branch: vib-142-attach-workspace\n  createdAt: 2026-07-04T06:41:00.000Z\n  sourceProfileId: developer\nverdicts:                         # per-engagement, each bound to a revision\n  - profileId: reviewer\n    revisionId: rev_9f2c\n    headSha: a91f7c2e…\n    result: approve               # approve | request_changes\n    reason: Scope matches the goal.\n    at: 2026-07-04T06:52:00.000Z\nbranch: vib-142-attach-workspace  # task-key branch; null before creation\narchived: false                   # R14-3: abandoned work, kept for the record —\n                                  # leaves the board's default view and the review\n                                  # queue, keeps its timeline, restorable\nnoChanges: true                   # optional; R17-2/R19-1 — this task completes\n                                  # with NOTHING to deliver (see the note below)\npr:                               # GitHub projection mirrored into the file\n  number: 318                     # (Phase 7 reconciler owns sync)\n  state: review\n  title: Attach execution workspace\ngithub:                           # more GitHub cache: commits + change stats\n  commits: [{ sha: a91f7c2, msg: \"[VIB-142] …\" }]\n  changed: { files: 9, add: 412, del: 87 }\ncreatedAt: 2026-07-03T06:00:00.000Z\nupdatedAt: 2026-07-04T06:58:00.000Z\nboardRank: 300                    # sparse rank for drag-to-reorder; null falls\n                                  # back to the task-key number\n---\n\n## Goal\n\nOne-paragraph goal statement (prose).\n\n## Packet\n\n`PACKET_OPTION_KINDS` in `app/schemas/task-file.schema.ts` is the source of truth for the\noption kinds; the list below mirrors it. *(Corrected 2026-08-06, pass 19 — N19-3. This block\nsaid \"The 8 kinds\" and omitted `archive_task`, which arrived with R14-3 (the task archive).\nUpdated 2026-08-15, pass 20 — F20-6/R20-2 added `discard_branch` (decisions.md ruling 7), so\nthe block that said \"The 9 kinds\" was itself the straggler. Ten is the count today —\nre-derive it from the schema rather than from here.)*\n\n```yaml\ntype: input                       # input | blocked (card tint)\nkind: Completion report           # pill label\nfrom: operator                    # actor ref (see §3)\ntitle: Accept completion, or send back for one fix?\nbody: Plain paragraph.\nobservations:\n  - k: Changed                    # Observed|Changed|Validation|Branch|Flag (open set)\n    v: 9 files · +412 / −87\n    code: true                    # true → render v as <code>\noptions:\n  - kind: accept_completion       # STABLE kind (ruling 7). The 10 kinds:\n    t: Accept completion          #   accept_completion | request_edit |\n    d: Mark task done …           #   block_on_policy | hold_runtime_debug |\n    rec: true                     #   redirect | retry_other_backend |\n    accept: true                  #   edit_goal | archive_task | discard_branch | custom\n                                  # (acceptance path marker — human-only)\n                                  # Source of truth: PACKET_OPTION_KINDS in\n                                  # app/schemas/task-file.schema.ts.\n  - kind: request_edit\n    t: Request one edit\n    d: …\n    rec: false\n    ev: \"**Decision:** request one edit. …\"   # pre-authored timeline copy\n```\n\n## Timeline\n\n### 2026-07-04T06:58:00.000Z · comment · user:u_abc123 (Arda Kaya)\nto: agent\n\n@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task.\n\n### 2026-07-04T06:41:00.000Z · completion · agent:codex/developer\ntitle: Completion report\n\nImplemented repo attach, branch creation, and PR-sync projection.\n\nevidence:\n- unit/policy_gate_test · +14 · 0\n- integration/pr_sync_test · +38 · −4\n````\n\nNotes:\n\n- **`engagements` replaced `specialist:` / `reviewers:` / `consultants:`** in the\n  generic-agents pass (2026-07-19). There is now one uniform list; the delivering\n  engagement is the entry with `delivers: true`, not a separate slot. The parser still\n  absorbs the legacy keys — a file carrying `specialist:` + `consultants:` migrates on the\n  next write, and the legacy keys are dropped rather than preserved as unknown fields. An\n  explicit `engagements:` always wins over them.\n  **Watch the migration cost:** a legacy entry migrates with `verdictCapable: false`,\n  because verdict capability is a snapshot of an explicit\n  `report-validation-verdict: direct` grant, and the legacy shape never carried one. A\n  hand-written `consultants:` reviewer therefore comes across as a supporting engagement\n  that is *not* a required reviewer — acceptance will not wait for it, silently. Write\n  `engagements` directly if you mean a required reviewer.\n- `validation`, `workRevision` and `verdicts` are a set. `validation` is a derived cache\n  recomputed from the other two plus the required-reviewer set on every write; do not\n  hand-edit it as a source of truth. A verdict names the `revisionId` it judged, so a new\n  revision automatically staleness-expires every prior verdict.\n- **`repo` is GONE from the task frontmatter.** The task-level repository override was\n  struck by owner ruling on 2026-07-25 (P13-D-5): one project, one repository. *(Corrected\n  2026-08-06, pass 19 — this note used to say the field was \"vestigial and always null\" and\n  that \"the read path still honours a non-null value\". Neither is true: `repo` is not in\n  `taskFrontmatterSchema` at all, and every `frontmatter.repo` read in the tree is on\n  `project.md`.)* A `repo:` line in an existing `task.md` is now simply an UNKNOWN key —\n  preserved verbatim on round-trip, ignored by every resolver. Do not hand-set it expecting\n  an effect; there is none.\n- **`noChanges` is the no-change completion flag** (R17-2, made reachable by R19-1). It marks\n  a task that completes with nothing to deliver, turning acceptance's normal \"deliver the\n  branch & open the PR\" refusal into the first-class \"Completed — no changes\" close. Two\n  producers: a delivery attempt that found the branch empty, and a reviewer approving a task\n  that never needed a branch at all. It is a claim about a moment that has passed, so it is\n  re-verified against the live remote before any writer closes the task to Done — a branch\n  that has since gained commits cannot ride a stale flag into Done. Cleared the moment a\n  delivery opens a PR. Do not hand-set it.\n- Unknown top-level frontmatter keys are preserved verbatim on write (the legacy\n  engagement keys above are the deliberate exception).\n\n### Timeline entry grammar (append contract for agents)\n\n- Entries are NEWEST FIRST. To append an event, prepend a block directly\n  under `## Timeline` (writers do this; external appenders that append at\n  the bottom are tolerated — display sorts by timestamp and an\n  `timeline.out_of_order` info diagnostic is recorded).\n- Heading line: `### <UTC ISO> · <type> · <actor-ref>` — separator is\n  `<space>·<space>` (U+00B7). `type` is one of the 11 contract types\n  (`comment completion github policy note quality transition blocked agent\n  assign continuity`); unknown types are kept and render as plain comments.\n  `continuity` (added pass 18, G8; count corrected here 2026-08-06, pass 19,\n  against `TIMELINE_EVENT_TYPES`) marks a runtime-continuity RESET — a resumed\n  session whose provider transcript was gone, so the agent re-anchored on\n  `task.md` in a fresh one. It is warning-toned on purpose: nothing was violated\n  (not `policy`) and nothing is stuck (not `blocked`), but a supervisor scanning\n  the board must get a cue that context was lost and recovered.\n  `note` was split out of `policy` in pass 13 (P13-LV-03): `policy` is now\n  reserved for genuine governance violations and refusals, which render with a\n  coral shield, and every neutral system remark — a goal edit, a divergence\n  note, a scheduled re-run — is a `note`. Do not emit `policy` for anything a\n  human would not read as a violation.\n- Optional metadata lines immediately after the heading (before the first\n  blank line): `title: <text>` (completion events) and `to: agent`\n  (comments routed to the operator — `comment-card toagent` tint).\n- Then a blank line and the event text (RichText micro-format: `**bold**`,\n  `` `code` ``, `@mention`). Multi-line text is allowed.\n- **Body-line escaping** (structure-like text): an event-body line whose raw\n  form would read as file structure — starting with `## `, `### `,\n  `title:<ws>`, `to:<ws>`, or a line that is only (whitespace and)\n  `evidence:` — is written with ONE leading backslash: `\\## Notes`,\n  `\\### 2026-01-01T00:00:00Z · completion · operator`, `\\title: x`,\n  `\\evidence:`. Lines that already start with backslashes in front of such a\n  pattern gain one more on write. Readers strip exactly one backslash from\n  any line matching `^\\\\+(## |### |title:\\s|to:\\s|\\s*evidence:\\s*$)` when\n  reconstructing the text; all other lines (including `\\` before\n  non-structural text) pass through verbatim. The mapping is bijective, so\n  round-trips stay byte-stable, and free text (including fenced code blocks\n  quoting headings) can never split sections, forge timeline events, or\n  override the real `## Packet`. External appenders MUST apply the same\n  escape to body lines they write.\n- **Duplicate known sections**: if `## Goal`, `## Packet` or `## Timeline`\n  appears more than once, the FIRST occurrence wins (never last-wins); each\n  duplicate is preserved verbatim as an unrecognized extra section and\n  flagged with a `body.duplicate_section` warning diagnostic (floors\n  readiness at `input_required`).\n- Optional evidence block (completion events): a line containing exactly\n  `evidence:` followed by `- <label> · <add> · <del>` rows; add/del are the\n  signed display strings (`+14`, `0`, `−4` with U+2212).\n- Malformed entries are skipped with a warning diagnostic (readiness floors\n  at `input_required`) — the task itself is never dropped.\n\n## 3. Actor references (contracts §3.1)\n\n| Actor | File encoding | Render shape |\n|---|---|---|\n| Human | `user:<userId>` or `user:<userId> (Display Name)` | `{ kind:\"human\", userId, name, initials, tone, guest? }` — resolved from the users table at projection time; the parenthetical is a snapshot fallback for deleted users; `guest` derives from project membership |\n| Agent | `agent:<backend>/<role-slug>` e.g. `agent:codex/developer` | `{ kind:\"agent\", backend, name:\"Codex\"\\|\"Claude Code\", role }` |\n| Operator | `operator` | `{ kind:\"agent\", name:\"Operator\" }` (NO backend, NO role) |\n| System | `system:<id>` e.g. `system:policy-engine` | `{ kind:\"system\", name:\"Policy engine\" }` |\n\n## 4. `agents/profiles/<id>.md` (org templates)\n\n```markdown\n---\nid: developer\nkind: specialist                  # operator | specialist\nname: Developer\nrole: Implementation\ndesc: Implements the change on the task branch and reports what it did.\n                                  # one scannable paragraph — what the OPERATOR\n                                  # reads when picking a profile. Distinct from\n                                  # the markdown body (the long persona).\nicon: branch                      # ui.jsx Icon name\nbackends: [codex, claude]\nmodel: codex-large · claude-sonnet\nscope: Global base · customized for Viberr Core\nstages: [ready, impl]             # eligible stages\nspanAll: false                    # operator only\ncapabilities:                     # same id-based shape as project deployments\n  - { capabilityId: create-task-branch, mode: direct }\nextras: []\nresources:\n  skills: [repo-write, test-runner, lint-autofix]\n  mcps: [github, filesystem]\n  kb: [viberr-core-architecture, coding-standards]\n---\n\nProfile description (markdown body).\n```\n\nEvery value in `resources:` is a **store folder name, never a display name**. For\n`skills:` and `mcps:` the slug *is* the folder, so the two coincide. For `kb:` they do\nnot: a knowledge base has a display name and a directory as separate columns, and the\ngrant resolves against `${VIBERR_DATA_ROOT}/kb/<dir>`. A `kb:` entry written as the\ndisplay name resolves to nothing — `readKbBody` returns an empty string with only a\n`logger.warn`, so the run proceeds *without* the knowledge base while every UI still shows\nit attached. Use the directory. (Renaming a KB's directory orphans existing grants for the\nsame reason; re-attach them.)\n\n## 5. What is deliberately NOT in files\n\n- Secrets (PATs, session data) — SQLite/env only, never under `projects/`.\n- Notification rows, read state, sessions, users, audit — app-owned SQLite.\n- Derived readiness — files store the canonical stored readiness; the\n  effective value (after diagnostic floors) lives only in the projection.\n  The \"accepted\" pill is a display state of done-stage tasks, never stored.\n",
      },
      {
        rel: "contributing.md",
        date: [7, 5],
        content: "# Contributing to Viberr\n\nThanks for helping build Viberr. This guide covers environment setup, the branch/PR\nworkflow, running the test suite, and how changes get reviewed and accepted.\n\n## Dev environment setup\n\nRequirements: Node >= 26, npm.\n\n```sh\ngit clone <this-repo> viberr && cd viberr\n\n# 1. Environment — copy the template and fill in the two required secrets\ncp .env.example .env\n#    VIBERR_SESSION_SECRET       — generate: openssl rand -base64 48\n#    VIBERR_SECRET_ENCRYPTION_KEY — generate: openssl rand -base64 32\n#    (every other variable is optional; see .env.example for docs)\n\n# 2. Install\nnpm ci\n\n# 3. Baseline data (migrations auto-apply at boot)\nnpm run seed\n\n# 4. Run\nnpm run dev        # http://localhost:5173\n```\n\n`npm run seed` is a clean sheet: the built-in agent catalog, knowledge bases and skills,\nplus a bootstrap admin when the users table is empty. It ships no demo board data. If you\nwant the mock dataset the route-level and e2e specs are written against, run\n`npm run seed:demo` instead.\n\nSee the [README](README.md) for the full quickstart, the bootstrap-admin credentials,\nDocker setup, and the architecture overview.\n\n## Branch / PR workflow\n\n- Branch off `main`, using a short descriptive branch name (e.g. `fix-board-filter`,\n  `generic-agents`).\n- Keep commits focused and use clear, descriptive commit messages.\n- Open a pull request against `main`. CI (`.github/workflows/ci.yml`) must pass before\n  merge. It runs two jobs: `verify` (lint → typecheck → unit/integration tests → build) and\n  `e2e` (Playwright against the production Docker image in an isolated Compose stack —\n  `scripts/e2e.ts` builds it, seeds the demo fixture, and tears it down; never a dev\n  server).\n- Merge via GitHub once CI is green and the PR has been reviewed and accepted (see\n  below).\n\n## Running the test suite\n\nRun these from the repository root after `npm ci`:\n\n```sh\nnpm run lint        # oxlint + the vendored anti-slop plugin — a required gate (ruling 86)\nnpm run typecheck   # route typegen + tsc\nnpm test            # vitest unit + integration suite\nnpm run build       # production build, the `verify` job's final gate\nnpm run e2e         # Playwright vs the production Docker image — CI's second job\n```\n\n`npm run lint` must exit 0: findings are fixed, never left standing as \"accepted\" —\nthere is no suppression list, so anything it reports is new (ruling 86 / R21-3).\n\nDon't skip `npm run e2e` because the other four are green. It is the only gate that\nboots the shipped production image end to end (Docker required): the pass-13 install\nregression passed typecheck, 1663 unit tests and the build, and was caught here.\n\nSee [docs/testing-quickstart.md](docs/testing-quickstart.md) for the short test guide.\n\n## Code review & acceptance\n\n- Every change lands through a pull request — no direct pushes to `main`.\n- CI must pass (typecheck, tests, build, e2e) before a PR is considered mergeable.\n- Keep route modules thin, put domain behavior in feature/server modules, and use the\n  existing file writers so canonical markdown and SQLite projections stay in sync.\n- Preserve authorization, audit, and typed error paths when changing governed actions.\n- Follow the canonical file formats in\n  [docs/architecture/file-formats.md](docs/architecture/file-formats.md) and the binding\n  conventions in [docs/architecture/decisions.md](docs/architecture/decisions.md) where\n  relevant — reviewers will check against these. If a change contradicts a numbered\n  ruling, say so in the PR and get it re-ruled; do not reverse one silently.\n- Reviewers look for: correctness, test coverage for the change, adherence to existing\n  patterns, and no regressions to documented behavior (see the README's \"Known gaps\"\n  section for deliberate scope boundaries — don't silently expand scope in an unrelated\n  PR).\n- A PR is accepted once it has passing CI and reviewer approval; the author or reviewer\n  merges it into `main`.\n\n## Where to look next\n\n- [README.md](README.md) — product overview, stack, quickstart, project layout.\n- [docs/architecture/file-formats.md](docs/architecture/file-formats.md) — canonical\n  task/project file formats.\n- [docs/architecture/decisions.md](docs/architecture/decisions.md) — binding conventions\n  and the numbered orchestrator rulings the code comments cite.\n- [docs/operations/](docs/operations/) — deployment and day-2 operations runbooks.\n",
      },
    ],
  },
];

const SKILL_SEEDS: {
  id: string;
  name: string;
  summary: string;
  updated: [number, number, number?];
  body: string;
  extraFiles: SeedFile[];
}[] = [
  {
    id: "sk_seed_commits",
    name: "conventional-commits",
    summary: "Commit style and task-key prefixes for traceable history.",
    updated: [3, 30],
    body:
      "## Commit format\n- `[VIB-<n>] <imperative summary>`\n- one logical change per commit\n- reference changed files in the body when >3 files\n\n## Why\nTask-key prefixes keep branch → commit → PR traceability intact.",
    extraFiles: [
      {
        rel: "examples.md",
        date: [3, 30],
        content:
          "# Examples\n\n- `[VIB-142] add repo attach policy gate`\n- `[VIB-151] debounce projection rebuilds`\n\nBad: `fix stuff`, `wip`, `final final`.\n",
      },
    ],
  },
  {
    id: "sk_seed_terraform",
    name: "terraform-review",
    summary: "Module review checklist: state safety, drift, plan hygiene.",
    updated: [6, 12],
    body:
      "## Review checklist\n- state safety: no destructive ops without a migration note\n- drift: plan output matches module inputs\n- plan hygiene: no orphaned resources\n\n## Escalate\nFlag anything touching IAM or networking for human review.",
    extraFiles: [
      {
        rel: "checklists/state-safety.md",
        date: [6, 12],
        content:
          "# State safety\n\n- `terraform state mv` over delete/recreate\n- protect prod workspaces with `prevent_destroy`\n",
      },
      {
        rel: "checklists/drift.md",
        date: [6, 12],
        content:
          "# Drift\n\nRun `terraform plan -detailed-exitcode` in CI; exit code 2 with no open change task is a quality flag.\n",
      },
    ],
  },
  {
    id: "sk_seed_api_design",
    name: "api-design",
    summary: "REST conventions and versioning rules for public endpoints.",
    updated: [5, 8],
    body:
      "## Conventions\n- resources are plural nouns; actions are sub-resources\n- version in the path (`/v1/`), never in headers\n- breaking changes require a deprecation window\n\n## Errors\nRFC 7807 problem+json with a stable `type` slug.",
    extraFiles: [
      {
        rel: "conventions.md",
        date: [5, 8],
        content:
          "# REST conventions\n\n- kebab-case paths, camelCase JSON\n- cursor pagination (`?after=`), never offsets on hot tables\n- 409 for idempotency-key replays with a diverging body\n",
      },
    ],
  },
  {
    id: "sk_seed_changelog",
    name: "changelog-writer",
    summary: "Turns change summaries into human-readable release notes.",
    updated: [6, 30],
    body:
      "## Style\n- lead with the user-visible change, not the implementation\n- group by area; link task keys\n- keep entries under 2 lines",
    extraFiles: [
      {
        rel: "templates/release-notes.md",
        date: [6, 30],
        content:
          "# Release notes template\n\n## Highlights\n- <user-visible change> (<task key>)\n\n## Fixes\n- …\n\n## Internal\n- …\n",
      },
    ],
  },
];

// Honest empty slate (owner ruling): a fresh instance ships NO MCP servers and
// NO GitHub connection. The old seed inserted fabricated MCP health (github-mcp
// → the non-resolvable mcp.internal with up=1/tools=14, a non-existent
// @mcp/server-postgres) and a placeholder default-connection PAT that 401s on
// every call — all rendering green until an admin probed them. An admin now
// adds real MCP servers and a real GitHub token; nothing fabricated is
// presented as configured.

function backdate(spec: [number, number, number?], now: Date): Date {
  const [month, day, hour] = spec;
  const d = new Date(
    now.getFullYear(),
    month - 1,
    day,
    hour ?? 12,
    hour !== undefined ? 0 : 15,
    0,
    0,
  );
  if (d.getTime() > now.getTime()) d.setFullYear(d.getFullYear() - 1);
  return d;
}

function writeSeedFile(absRoot: string, file: SeedFile, now: Date): void {
  const abs = path.join(absRoot, ...file.rel.split("/"));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, file.content);
  const when = backdate(file.date, now);
  utimesSync(abs, when, when);
}

export function seedOrgResources(
  db: DatabaseSync,
  options: { dataRoot: string; reset?: boolean },
): OrgSeedSummary {
  const now = new Date();
  const nowIso = now.toISOString();
  const ctx = { dataRoot: options.dataRoot };

  if (options.reset) {
    for (const dir of [kbRootDir(options.dataRoot), skillsRootDir(options.dataRoot)]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    for (const table of [
      "org_knowledge_bases",
      "org_mcp_servers",
      "org_skills",
      "google_domain_allowlist",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  }
  ensureOrgStoreDirs(ctx);

  // Knowledge bases — rows + REAL files with back-dated mtimes. created_at
  // is a fixed ordered stamp so the panel lists in mock order. A KB whose
  // folder already exists is skipped entirely (row + files) so human edits and
  // UI-set refresh cadence survive a plain re-seed (seed #5); --reset wiped kb/
  // above, so this only skips on a plain re-run.
  let kbFiles = 0;
  for (const [i, kb] of KB_SEEDS.entries()) {
    const root = kbDirPath(kb.dir, options.dataRoot);
    if (existsSync(root)) continue;
    const indexedAt = backdate(kb.indexed, now).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO org_knowledge_bases
         (id, name, dir, refresh, last_indexed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      kb.id,
      kb.name,
      kb.dir,
      kb.refresh,
      indexedAt,
      `2000-01-01T00:00:0${i}.000Z`,
      indexedAt,
    );
    for (const file of kb.files) {
      writeSeedFile(root, file, now);
      kbFiles += 1;
    }
  }

  // Skills — rows + SKILL.md + supporting files. Same non-destructive rule: an
  // existing skill folder is left untouched on a plain re-seed (seed #5).
  for (const [i, skill] of SKILL_SEEDS.entries()) {
    const root = skillDirPath(skill.name, options.dataRoot);
    if (existsSync(root)) continue;
    const updatedAt = backdate(skill.updated, now).toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO org_skills
         (id, name, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      skill.id,
      skill.name,
      skill.summary,
      `2000-01-01T00:00:0${i}.000Z`,
      updatedAt,
    );
    writeSeedFile(
      root,
      { rel: "SKILL.md", content: `${skill.body}\n`, date: skill.updated },
      now,
    );
    for (const file of skill.extraFiles) writeSeedFile(root, file, now);
  }

  // No MCP servers and no GitHub connection are seeded — see the honest-empty-
  // slate note above. Any connection an admin already installed is left intact.

  // Google domain allowlist — @viberr.dev joins as member.
  db.prepare(
    `INSERT OR REPLACE INTO google_domain_allowlist
       (id, domain, role, created_at)
     VALUES ('dom_seed_viberr', '@viberr.dev', 'member', ?)`,
  ).run(nowIso);

  const summary: OrgSeedSummary = {
    kbs: KB_SEEDS.length,
    kbFiles,
    skills: SKILL_SEEDS.length,
    mcps: 0,
    domains: 1,
    // SAFETY: `count(*)` always returns exactly one row holding one integer.
    connections: (
      db.prepare(`SELECT count(*) AS c FROM github_connections`).get() as {
        c: number;
      }
    ).c,
  };
  recordAudit(db, {
    action: "seed.org_resources",
    actor: SYSTEM_ACTOR,
    details: { ...summary, reset: options.reset ?? false },
  });
  logger.info("org resource seed complete", { ...summary });
  return summary;
}
