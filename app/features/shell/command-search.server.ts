import type { DatabaseSync } from "node:sqlite";
import { listHomeProjectsForUser } from "~/features/home/home-query.server";
import { EPIC_STATUS_LABEL, isEpicOpen, type EpicStatus } from "~/schemas/epic-file.schema";
import { listDeployedSpecialists } from "~/server/tasks/specialist-roster.server";
import { epicHref } from "~/shared/epic-href";

/**
 * R15-5 — the ⌘K palette's ONE query.
 *
 * The topbar used to promise "Search tasks, branches, agents…" while only
 * filtering the board that happened to be open. This resolves those things,
 * with projects and (ruling 503) epics, GLOBALLY, over exactly the projects
 * the viewer may open: it reuses
 * `listHomeProjectsForUser`, the same membership scoping the home grid and the
 * R15-4 workspace gate apply, so the palette can never surface a task, branch
 * or agent belonging to a project whose existence the viewer must not learn.
 *
 * Read-only over existing projections (`task_projections`, `epic_projections`
 * and project.md agent deployments) — no new read model, no new table.
 */

export type CommandHitKind = "project" | "epic" | "task" | "branch" | "agent";

export interface CommandHit {
  kind: CommandHitKind;
  /** Stable list key — also the palette's DOM id suffix. */
  id: string;
  /** Primary line. */
  label: string;
  /** A task hit's key, drawn quietly ahead of its title (ruling 625): baked
   *  into the label it was as loud as the title. */
  key?: string;
  /** Secondary line (project name, stage, role…). */
  sub: string;
  /** Where Enter goes. */
  href: string;
}

/** Hits per KIND. The palette is a jump list, not a result page. */
const COMMAND_GROUP_LIMIT = 6;

/** SQL LIKE is the coarse filter; these are the rows we are willing to rank. */
const TASK_SCAN_LIMIT = 60;

/** `%` and `_` are LIKE wildcards — a user typing them means the literal. */
function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (c) => "\\" + c);
}
/** LIKE pattern matching the term ANYWHERE — the coarse WHERE filter. */
function likeTerm(query: string): string {
  return "%" + escapeLike(query) + "%";
}
/** LIKE pattern matching the term as a PREFIX — the F20-28 key-prefix rank. */
function likePrefix(query: string): string {
  return escapeLike(query) + "%";
}

type TaskRow = {
  project_slug: string;
  task_key: string;
  title: string;
  stage: string;
  branch: string | null;
  /** F26-12: the task's labels as the stored JSON array string — searched via a
   *  substring LIKE so typing a label finds the task. */
  labels_json: string;
  /** 0/1 — see `archivedSub` below. */
  archived: number;
};

type EpicRow = {
  project_slug: string;
  epic_id: string;
  title: string;
  status: EpicStatus;
};

/**
 * F19-8/R14-3: an archived task is a terminal disposition that "leaves every
 * default view" — the board card and list row swap their live state for a
 * neutral `archived` pill, home/decisions/review drop it via `listProjectTasks`
 * (board-query.server.ts), and db/migrations/0001_baseline.sql states the
 * contract outright ("each of them has to hide archived tasks"). This is the
 * one reader that goes straight to `task_projections`, so it inherited none of
 * it and ranked a just-archived task FIRST (updated_at DESC), indistinguishable
 * from live work. It is not excluded — the palette is a legitimate way back to
 * archived work, the same reason the board keeps its Archived filter
 * (`FILTERS` in board-page-derive.ts) — it is LABELLED, with the board's own word.
 */
function archivedSub(sub: string, row: TaskRow): string {
  return withArchived(sub, row.archived !== 0);
}

/**
 * F20-29: the board's own word for a terminal disposition, appended so an
 * archived hit is never byte-identical to a live one. Tasks got this in F19-8
 * (via `archivedSub`); a PROJECT hit dropped the `archived` flag it already
 * carries on `HomeProjectCard`, so an archived project came back through the
 * palette unmarked and the Home grid's "Archived" filing was the only surface
 * that said so. Same word, same reason — one helper for both.
 */
function withArchived(sub: string, archived: boolean): string {
  return archived ? `${sub} · archived` : sub;
}

export function searchWorkspace(
  db: DatabaseSync,
  viewer: { id: string; role: "admin" | "member" },
  rawQuery: string,
  options: { dataRoot?: string; groupLimit?: number } = {},
): CommandHit[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [];
  const limit = options.groupLimit ?? COMMAND_GROUP_LIMIT;

  const projects = listHomeProjectsForUser(db, viewer);
  if (projects.length === 0) return [];
  const nameOf = new Map(projects.map((p) => [p.slug, p.name]));

  const projectHits: CommandHit[] = projects
    .filter((p) =>
      [p.name, p.slug, p.key, p.repo ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      ),
    )
    .slice(0, limit)
    .map((p) => ({
      kind: "project" as const,
      id: `project:${p.slug}`,
      label: p.name,
      // F20-29: carry the archived flag the card already has, the same way a
      // task hit does — an archived project's board opens to an honest banner,
      // so the row must not read as live.
      sub: withArchived(p.repo ?? p.slug, p.archived),
      href: `/projects/${p.slug}/board`,
    }));

  // One scan for tasks AND branches — a branch only exists as a task's branch,
  // so a second query would read the same rows twice.

  const placeholders = projects.map(() => "?").join(", ");
  const term = likeTerm(q);
  const prefix = likePrefix(q);
  // SAFETY: TaskRow names exactly the seven columns this SELECT lists, in the
  // types 0001_baseline declares for `task_projections` — `branch` is the one
  // nullable column, `archived` its 0/1 INTEGER, and `labels_json` a NOT NULL
  // JSON-array string.
  const rows = db
    .prepare(
      `SELECT project_slug, task_key, title, stage, branch, labels_json, archived
         FROM task_projections
        WHERE project_slug IN (${placeholders})
          AND ( LOWER(task_key)    LIKE ? ESCAPE '\\'
             OR LOWER(title)       LIKE ? ESCAPE '\\'
             OR LOWER(branch)      LIKE ? ESCAPE '\\'
             -- F26-12: match a triage label (the value is a JSON array string, so
             -- a substring LIKE finds the label inside it).
             OR LOWER(labels_json) LIKE ? ESCAPE '\\' )
        -- F20-28: a viewer who types a FULL task key almost always wants THAT
        -- task, not a newer one whose title merely mentions the key (e.g.
        -- "VIB-1" also matches VIB-2's title "…verify the merged VIB-1 marker").
        -- Rank an exact key match first, then a key-prefix match, and only then
        -- fall back to recency, so title/branch ("fuzzy") matches are still
        -- returned, just never ahead of the key the query names.
        ORDER BY
          CASE
            WHEN LOWER(task_key) = ?                 THEN 0
            WHEN LOWER(task_key) LIKE ? ESCAPE '\\'  THEN 1
            ELSE 2
          END,
          updated_at DESC
        LIMIT ${TASK_SCAN_LIMIT}`,
    )
    .all(
      ...projects.map((p) => p.slug),
      term, // task_key
      term, // title
      term, // branch
      term, // labels_json (F26-12)
      q,
      prefix,
    ) as TaskRow[];

  // Ruling 503: an epic, by its name or its id, the way Linear's palette finds
  // a project. Open ones first; a done or cancelled one says so, as an
  // archived task does.
  // SAFETY: EpicRow names exactly the four columns this SELECT lists, in the
  // types 0001_baseline declares for `epic_projections`, whose CHECK holds
  // `status` to EPIC_STATUS_VALUES.
  const epicRows = db
    .prepare(
      `SELECT project_slug, epic_id, title, status
         FROM epic_projections
        WHERE project_slug IN (${placeholders})
          AND ( LOWER(epic_id) LIKE ? ESCAPE '\\'
             OR LOWER(title)   LIKE ? ESCAPE '\\' )
        ORDER BY
          CASE WHEN LOWER(epic_id) = ? THEN 0 ELSE 1 END,
          CASE WHEN status IN ('done', 'cancelled') THEN 1 ELSE 0 END,
          updated_at DESC
        LIMIT ?`,
    )
    .all(...projects.map((p) => p.slug), term, term, q, limit) as EpicRow[];
  const epicHits: CommandHit[] = epicRows.map((row) => {
    let sub = `${row.epic_id} · ${nameOf.get(row.project_slug) ?? row.project_slug}`;
    if (!isEpicOpen(row.status)) sub += ` · ${EPIC_STATUS_LABEL[row.status].toLowerCase()}`;
    return {
      kind: "epic",
      id: `epic:${row.project_slug}/${row.epic_id}`,
      label: row.title,
      sub,
      href: epicHref(row.project_slug, row.epic_id),
    };
  });

  const taskHits: CommandHit[] = [];
  const branchHits: CommandHit[] = [];
  for (const row of rows) {
    const href = `/projects/${row.project_slug}/tasks/${row.task_key}`;
    const project = nameOf.get(row.project_slug) ?? row.project_slug;
    const onKeyOrTitle =
      row.task_key.toLowerCase().includes(q) ||
      row.title.toLowerCase().includes(q);
    if (onKeyOrTitle && taskHits.length < limit) {
      taskHits.push({
        kind: "task",
        id: `task:${row.project_slug}/${row.task_key}`,
        label: row.title,
        key: row.task_key,
        sub: archivedSub(project, row),
        href,
      });
      continue;
    }
    // A row that matched ONLY on its branch is filed as a branch hit, so the
    // group headings stay honest about why a row is here.
    if (
      !onKeyOrTitle &&
      row.branch &&
      row.branch.toLowerCase().includes(q) &&
      branchHits.length < limit
    ) {
      branchHits.push({
        kind: "branch",
        id: `branch:${row.project_slug}/${row.task_key}`,
        label: row.branch,
        sub: archivedSub(`${row.task_key} · ${project}`, row),
        href,
      });
    }
  }

  // Agent profiles are DEPLOYMENTS (project.md), so they are already scoped by
  // the visible-project set; the org template library stays behind org settings.
  const agentHits: CommandHit[] = [];
  for (const project of projects) {
    if (agentHits.length >= limit) break;
    for (const agent of listDeployedSpecialists(project.slug, {
      dataRoot: options.dataRoot,
    })) {
      if (agentHits.length >= limit) break;
      const haystack = `${agent.name} ${agent.role} ${agent.backend}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      agentHits.push({
        kind: "agent",
        id: `agent:${project.slug}/${agent.id}`,
        label: agent.name,
        sub: `${agent.role} · ${project.name}`,
        // F19-16: this used to link to the bare roster, so picking "Reviewer
        // Bot" landed on the Agents page with the OPERATOR's detail pane open
        // (`searchParams.get("profile") ?? "operator"`, agents-page-selection.ts)
        // and nothing naming what was searched for — deterministically the
        // wrong agent, on every agent hit. `agent.id` is `resolved.profileId`
        // (`listDeployedSpecialists`, specialist-roster.server.ts), the same key
        // the roster resolves against and the same deep link "open this
        // profile" already uses from the Policy page (`PolicyPage`'s
        // `onOpenProfile`, policy-page.tsx). The agent hit was the only hit
        // kind that threw away identity its destination can consume.
        href: `/projects/${project.slug}/agents?profile=${encodeURIComponent(agent.id)}`,
      });
    }
  }

  return [...projectHits, ...epicHits, ...taskHits, ...branchHits, ...agentHits];
}
