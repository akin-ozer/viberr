import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { rescanProjections } from "~/server/projections/rescan.server";
import { rebuildProjections } from "~/server/projections/rebuild.server";
import {
  openScopeViolation,
  resolveScopeViolation,
} from "~/server/projections/policy-violations.server";
import { revalidateProjectCredential } from "~/server/secrets/pat-validator.server";
import {
  appendComment,
  createTask,
  releaseOwner,
  resolvePacket,
  setOwner,
  transitionStage,
} from "~/server/tasks/task-actions.server";
import {
  configureRunServiceForTests,
  interruptRun,
  startRun,
} from "~/server/runtimes/run-service.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { AUDIT_ACTIONS, AUDIT_ACTION_NAMES } from "./audit-actions";
import { listAuditEvents } from "../../../test-support/audit-log";

/**
 * Phase 10 audit regression — two halves:
 *
 * 1. STATIC SWEEP: every `recordAudit(...)` call site in app/ + scripts/ is
 *    parsed for its `action:` literal(s); the extracted set must equal the
 *    canonical catalog in audit-actions.ts in BOTH directions. Adding a
 *    governed action without registering it (or leaving a stale catalog
 *    row) fails here — this is the "entry points vs recorded actions"
 *    enumeration, kept maintainable as data.
 *
 * 2. TABLE-DRIVEN FUNCTIONAL: one representative invocation per governed
 *    action family runs against the real server functions and asserts the
 *    audit row landed with the catalogued name + the subject fields its
 *    scope demands (task → projectSlug+taskKey, project → projectSlug).
 *    Org/auth families are exercised by their own phase-2/9 suites; the
 *    static half still guards their naming.
 */

// ------------------------------------------------------------ static sweep

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCAN_ROOTS = ["app", "scripts"].map((d) => path.join(REPO_ROOT, d));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...listSourceFiles(abs));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(abs);
  }
  return out;
}

/** Action literals from every recordAudit CALL site (`recordAudit(x, {`
 * with a plain identifier first arg — the function definition and imports
 * never match). Handles single literals and same-line ternaries
 * (`action: cond ? "a" : "b"`). Unparseable calls become `problems`. */
function extractRecordedActions(): {
  found: Map<string, string[]>; // action → call-site files
  problems: string[];
} {
  const found = new Map<string, string[]>();
  const problems: string[] = [];
  const callRe = /recordAudit\(\s*[A-Za-z_$][\w$.]*\s*,\s*\{/g;
  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(REPO_ROOT, file);
      for (const match of source.matchAll(callRe)) {
        const window = source.slice(match.index, match.index + 400);
        const actionLine = /action:\s*([^\n]+)/.exec(window);
        if (!actionLine) {
          problems.push(`${rel}@${match.index}: no action: line found`);
          continue;
        }
        const literals = [
          ...actionLine[1]!.matchAll(/"([a-z0-9_.]+)"/g),
        ].map((m) => m[1]!);
        if (literals.length === 0) {
          problems.push(
            `${rel}@${match.index}: action is not a string literal (${actionLine[1]!.trim()})`,
          );
          continue;
        }
        for (const action of literals) {
          const files = found.get(action) ?? [];
          files.push(rel);
          found.set(action, files);
        }
      }
    }
  }
  return { found, problems };
}

describe("audit action catalog (static sweep)", () => {
  const { found: recorded, problems } = extractRecordedActions();

  it("every recordAudit call site is statically parseable", () => {
    expect(problems).toEqual([]);
    // Sanity: the sweep actually found the app's recorder calls.
    expect(recorded.size).toBeGreaterThan(40);
  });

  it("every recordAudit call site uses a catalogued action name", () => {
    const unregistered = [...recorded.keys()].filter(
      (action) => !(action in AUDIT_ACTIONS),
    );
    expect(
      unregistered,
      `unregistered audit actions (add them to audit-actions.ts): ${unregistered
        .map((a) => `${a} (${recorded.get(a)!.join(", ")})`)
        .join("; ")}`,
    ).toEqual([]);
  });

  it("every catalogued action has a live recorder call site", () => {
    const stale = AUDIT_ACTION_NAMES.filter((action) => !recorded.has(action));
    expect(
      stale,
      `catalogued actions with no recordAudit call site (remove or re-wire): ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("action names follow the dot-fact naming convention", () => {
    for (const action of AUDIT_ACTION_NAMES) {
      expect(action).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });
});

// ----------------------------------------------------- functional coverage

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "triage",
      readiness: "ready",
    }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-2", {
      stage: "review",
      readiness: "ready",
      waiting: "human",
      ownerUserId: null,
    }),
    packet: {
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "Accept?",
      body: "Done.",
      observations: [],
      options: [
        {
          kind: "request_edit",
          t: "Request one edit",
          d: "",
          rec: true,
        },
      ],
    },
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  configureRunServiceForTests();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

interface CoverageRow {
  name: string;
  action: string;
  /** Runs the governed entry point; audit rows are asserted afterwards. */
  run: () => Promise<unknown> | unknown;
  /** Expected taskKey (task-scoped rows). */
  taskKey?: string;
}

describe("governed actions record audit rows (table-driven)", () => {
  it("runs the table and finds every expected audit row", async () => {
    const actorArda = () => ({
      userId: store.users.arda.id,
      label: store.users.arda.email,
    });
    const fileCtx = { dataRoot: store.dataRoot };

    const table: CoverageRow[] = [
      {
        name: "createTask",
        action: "task.created",
        run: () =>
          createTask(
            store.db,
            { projectSlug: store.slug, title: "Audit sweep task" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "appendComment",
        action: "task.comment",
        taskKey: "VIB-1",
        run: () =>
          appendComment(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", text: "hello" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner (take)",
        action: "task.ownership.taken",
        taskKey: "VIB-1",
        run: () =>
          setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.arda.id,
            },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner (hand-off)",
        action: "task.ownership.handed_off",
        taskKey: "VIB-1",
        run: () =>
          setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.murat.id,
            },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "releaseOwner (admin forced)",
        action: "task.ownership.admin_released",
        taskKey: "VIB-1",
        run: () =>
          releaseOwner(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner + releaseOwner (self)",
        action: "task.ownership.released",
        taskKey: "VIB-1",
        run: async () => {
          await setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.murat.id,
            },
            {
              userId: store.users.murat.id,
              label: store.users.murat.email,
            },
            fileCtx,
          );
          await releaseOwner(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            {
              userId: store.users.murat.id,
              label: store.users.murat.email,
            },
            fileCtx,
          );
        },
      },
      {
        name: "transitionStage (triage→ready, approval boundary)",
        action: "task.transition",
        taskKey: "VIB-1",
        run: () =>
          transitionStage(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "resolvePacket (request_edit)",
        action: "task.packet.resolved",
        taskKey: "VIB-2",
        run: () =>
          resolvePacket(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-2", optionIndex: 0 },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "startRun",
        action: "runtime.run.started",
        taskKey: "VIB-1",
        run: () =>
          startRun(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            role: "Primary specialist",
            kind: "primary",
            backend: "claude",
            model: "m",
            prompt: "go",
            actor: actorArda(),
            script: {
              lines: [{ t: "1", ev: "text", tag: "assistant", text: "hi" }],
              sessionId: "s",
              backend: "claude",
              model: "m",
              op: false,
              keepRunning: true,
              instant: true,
            },
            dataRoot: store.dataRoot,
          }),
      },
      {
        name: "interruptRun",
        action: "runtime.run.interrupted",
        taskKey: "VIB-1",
        run: async () => {
          const { runId } = await startRun(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            role: "R",
            kind: "reviewer", // distinct thread — VIB-1 already has a primary
            backend: "claude",
            model: "m",
            prompt: "go",
            script: {
              lines: [{ t: "1", ev: "text", tag: "assistant", text: "w" }],
              sessionId: "s2",
              backend: "claude",
              model: "m",
              op: false,
              keepRunning: true,
              instant: true,
            },
            dataRoot: store.dataRoot,
          });
          for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
          interruptRun(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", runId },
            actorArda(),
          );
        },
      },
      {
        name: "openScopeViolation",
        action: "github.scope_violation.opened",
        run: () =>
          openScopeViolation(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            scope: "pull_request:write",
            detail: "audit sweep",
            actor: actorArda(),
          }),
      },
      {
        name: "resolveScopeViolation",
        action: "github.scope_violation.resolved",
        run: () => {
          const { violation } = openScopeViolation(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-2",
            scope: "repo",
            actor: actorArda(),
          });
          resolveScopeViolation(store.db, violation.id, actorArda());
        },
      },
      {
        name: "revalidateProjectCredential (grant-scope attempt, no PAT)",
        action: "github.credential.revalidated",
        run: () =>
          revalidateProjectCredential(store.db, store.slug, actorArda(), {
            dataRoot: store.dataRoot,
          }),
      },
      {
        name: "rescanProjections",
        action: "projection.rescan",
        run: () =>
          rescanProjections(store.db, {
            dataRoot: store.dataRoot,
            actor: actorArda(),
          }),
      },
      {
        name: "rebuildProjections (full drop + rebuild)",
        action: "projection.rebuild",
        run: () =>
          rebuildProjections(store.db, {
            dataRoot: store.dataRoot,
            actor: actorArda(),
          }),
      },
    ];

    for (const row of table) {
      const before = listAuditEvents(store.db, { action: row.action }).length;
      await row.run();
      const rows = listAuditEvents(store.db, { action: row.action });
      expect(
        rows.length,
        `${row.name} did not record audit action ${row.action}`,
      ).toBeGreaterThan(before);

      const newest = rows[0]!;
      const scope = AUDIT_ACTIONS[row.action];
      expect(scope, `${row.action} missing from catalog`).toBeTruthy();
      if (scope === "project" || scope === "task") {
        expect(
          newest.projectSlug,
          `${row.name}: ${row.action} must carry projectSlug`,
        ).toBe(store.slug);
      }
      if (scope === "task") {
        expect(
          newest.taskKey,
          `${row.name}: ${row.action} must carry taskKey`,
        ).toBeTruthy();
        if (row.taskKey) expect(newest.taskKey).toBe(row.taskKey);
      }
      expect(newest.actorLabel.length).toBeGreaterThan(0);
    }
  });

  it("rebuildProjections drops + re-projects to identical counts", () => {
    const countsBefore = {
      projects: (
        store.db.prepare(`SELECT count(*) c FROM projects`).get() as {
          c: number;
        }
      ).c,
      tasks: (
        store.db.prepare(`SELECT count(*) c FROM task_projections`).get() as {
          c: number;
        }
      ).c,
      events: (
        store.db.prepare(`SELECT count(*) c FROM task_events`).get() as {
          c: number;
        }
      ).c,
    };
    expect(countsBefore.projects).toBeGreaterThan(0);
    expect(countsBefore.tasks).toBeGreaterThan(0);

    const summary = rebuildProjections(store.db, {
      dataRoot: store.dataRoot,
      actor: { userId: store.users.arda.id, label: store.users.arda.email },
    });
    expect(summary.projects).toBe(countsBefore.projects);
    expect(summary.tasks).toBe(countsBefore.tasks);
    expect(summary.errors).toBe(0);

    const countsAfter = {
      projects: (
        store.db.prepare(`SELECT count(*) c FROM projects`).get() as {
          c: number;
        }
      ).c,
      tasks: (
        store.db.prepare(`SELECT count(*) c FROM task_projections`).get() as {
          c: number;
        }
      ).c,
      events: (
        store.db.prepare(`SELECT count(*) c FROM task_events`).get() as {
          c: number;
        }
      ).c,
    };
    expect(countsAfter).toEqual(countsBefore);
  });
});
