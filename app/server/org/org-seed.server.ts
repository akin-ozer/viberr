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
 * Idempotent: deterministic row ids (INSERT OR REPLACE), files overwritten,
 * file mtimes back-dated so the browser shows the mock's date spread. Any
 * GitHub connection an admin already installed is left intact and survives
 * `--reset` (like the phase-7 PAT tables). `--reset` wipes kb/, skills/ and
 * the resource tables + domain rows, then reseeds them.
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
  refresh: "manual" | "on change" | "nightly";
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
          "# ADR-001 — Task files are the canonical store\n\n## Status\nAccepted.\n\n## Decision\nEvery task lives as `tasks/<KEY>/task.md` under the project folder. SQLite rows are projections, rebuilt from files — never the other way around.\n\n## Consequences\n- External edits are first-class: the watcher reprojects on change.\n- Rollback is `git checkout` of a folder, not a DB migration.\n",
      },
      {
        rel: "decisions/adr-002-operator-model.md",
        date: [4, 14],
        content:
          "# ADR-002 — One operator per active task\n\n## Status\nAccepted.\n\n## Decision\nA dedicated operator runtime is instantiated per active task. It coordinates specialists and compresses agent work into decision packets; it never writes code and never closes a task.\n\n## Consequences\nHuman acceptance stays the only path to Done.\n",
      },
      {
        rel: "decisions/adr-003-event-types.md",
        date: [5, 2],
        content:
          "# ADR-003 — Nine typed timeline events\n\n## Status\nAccepted.\n\n## Decision\n`comment · completion · github · policy · quality · transition · blocked · agent · assign` — everything else is rejected before it reaches the timeline.\n",
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
          "# Glossary\n\n- **Packet** — an operator decision request with options.\n- **Readiness** — ready · input_required · inconsistency_risk_detected · blocked.\n- **Boundary** — auto · approval · human transition gate.\n",
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
          "# Task endpoints\n\nLoaders return route-shaped data; the rare JSON endpoints use `{ data, meta? }` on success and `{ error: { code, message } }` on failure.\n\n- `GET /projects/:slug/board` — board projection.\n- `POST /projects/:slug/tasks/:key` — intents: comment, resolve-packet, owner, transition.\n",
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
          "# Task contract\n\nKey `/^[A-Za-z]+-\\d+$/`, one human owner, one primary specialist, 0..n reviewers. Timestamps are UTC ISO at every boundary.\n",
      },
      {
        rel: "schemas/event-types.md",
        date: [6, 2],
        content:
          "# Event types\n\nSSE names are lowercase dot-separated facts: `task.updated`, `projection.rebuilt`, `run.log-appended` — payloads are compact facts, never fat objects.\n",
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
    refresh: "nightly",
    indexed: [7, 3, 2],
    files: [
      {
        rel: "incidents/rollback.md",
        date: [6, 9],
        content:
          "# Rollback\n\n1. `git revert` the release merge — never force-push main.\n2. Re-run the deploy pipeline with the revert SHA.\n3. Write a `blocked` event on the affected tasks with the incident link.\n",
      },
      {
        rel: "incidents/hotfix-flow.md",
        date: [6, 9],
        content:
          "# Hotfix flow\n\nBranch from the release tag, task-key prefix as usual, review boundary stays human — hotfixes are not an excuse to skip acceptance.\n",
      },
      {
        rel: "release-checklist.md",
        date: [7, 1],
        content:
          "# Release checklist\n\n- [ ] All review-stage tasks accepted or bumped\n- [ ] Validation suite green on main\n- [ ] Changelog entries generated (changelog-writer skill)\n- [ ] Rollback point tagged\n",
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
  // is a fixed ordered stamp so the panel lists in mock order.
  let kbFiles = 0;
  for (const [i, kb] of KB_SEEDS.entries()) {
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
    const root = kbDirPath(kb.dir, options.dataRoot);
    for (const file of kb.files) {
      writeSeedFile(root, file, now);
      kbFiles += 1;
    }
  }

  // Skills — rows + SKILL.md + supporting files.
  for (const [i, skill] of SKILL_SEEDS.entries()) {
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
    const root = skillDirPath(skill.name, options.dataRoot);
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
