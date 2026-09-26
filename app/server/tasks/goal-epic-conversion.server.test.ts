import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { EpicTimelineEntry } from "~/schemas/epic-file.schema";
import type {
  ParsedTaskFile,
  TaskFileEvent,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import type { GoalEpicConversion } from "./goal-epic-conversion.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { SeedUserIds } from "../../../test-support/demo-data";
import { flush, waitFor } from "../../../test-support/polling";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";

/**
 * Ruling 503(h): nothing is lost at the upgrade. Boot converts every chained
 * goal of ruling 99 into the epic with its number, once, and every step is
 * idempotent (`convertGoalsToEpics`; docs/domain/controller-and-epics.md §7.6;
 * the runbook's "Goal chains became epics").
 *
 * The goal writer is gone, so the legacy store is written here the way ruling
 * 99 left it on disk: `goals/goal-N.md` with the goal writer's keys in its
 * order, and task files carrying the retired `goalRef` where `epic` sits now
 * (`goalRef: null` on every task outside a chain), with `goal-N link M` waits
 * in `blockedBy` and in open decisions. The store is re-projected before the
 * conversion runs, as boot's rescan does.
 */

const SLUG = "viberr-core";
const SIGNED = { kind: "system", systemId: "epic-conversion" } as const;
/** Long enough for a cold module graph; the effects land in milliseconds warm. */
const SETTLE_MS = 10_000;

type LegacyGoalStatus = "active" | "paused" | "attention" | "completed" | "cancelled";
type LegacyLinkStatus = "pending" | "active" | "done" | "failed" | "skipped";

/** One link as the goal writer stored it. */
interface LegacyLink {
  index: number;
  title: string;
  goal: string;
  taskKey?: string;
  status?: LegacyLinkStatus;
  blockedBy?: string[];
}

/** One goal file as the goal writer stored it. */
interface LegacyGoal {
  id: string;
  title: string;
  status: LegacyGoalStatus;
  createdBy: string;
  createdByLabel: string;
  conversationId?: string;
  createdAt?: string;
  description: string;
  timeline?: EpicTimelineEntry[];
  links: LegacyLink[];
}

/** `task.md`'s retired back-reference to the chain a task was a link of. */
interface LegacyGoalRef {
  goalId: string;
  linkIndex: number;
}

/** What a task only the legacy store had carries besides its frontmatter. */
interface LegacyTaskExtras {
  goalRef?: LegacyGoalRef;
  packet?: TaskPacket;
}

async function loadModules() {
  const [
    conversion,
    frontmatter,
    atomic,
    storeRoot,
    taskWriter,
    taskFile,
    epicWriter,
    projectWriter,
    writeCache,
    rebuilder,
    epicQuery,
    notifications,
    mutation,
    demoSeed,
    testStore,
  ] = await Promise.all([
    import("./goal-epic-conversion.server"),
    import("~/server/files/frontmatter.server"),
    import("~/server/files/atomic-file.server"),
    import("~/server/files/file-store-root.server"),
    import("~/server/files/task-writer.server"),
    import("~/server/files/task-file.server"),
    import("~/server/files/epic-writer.server"),
    import("~/server/files/project-writer.server"),
    import("~/server/files/write-cache.server"),
    import("~/server/projections/rebuilder.server"),
    import("~/server/projections/epic-query.server"),
    import("~/server/projections/notifications.server"),
    import("./task-mutation.server"),
    import("../../../test-support/demo-seed"),
    import("../../../test-support/test-store"),
  ]);
  // A task the conversion releases is handed to the operator fire-and-forget.
  // With the operator's modules loaded up front, that turn ends inside the
  // test that caused it instead of after its cleanup.
  await Promise.all([
    import("~/server/runtimes/operator-run.server"),
    import("./operator-actions.server"),
    import("./agent-reply.server"),
  ]);
  return {
    conversion,
    frontmatter,
    atomic,
    storeRoot,
    taskWriter,
    taskFile,
    epicWriter,
    projectWriter,
    writeCache,
    rebuilder,
    epicQuery,
    notifications,
    mutation,
    demoSeed,
    testStore,
  };
}
type Modules = Awaited<ReturnType<typeof loadModules>>;

/** One demo store, read and written in the layouts before and after the
 *  upgrade. */
function legacyStore(m: Modules, app: AppTestContext) {
  const { dataRoot } = app;
  const goalsDir = m.storeRoot.retiredGoalsDir(SLUG, dataRoot);
  const tasksDir = path.join(m.storeRoot.projectDir(SLUG, dataRoot), "tasks");
  const read = (taskKey: string) => {
    const file = m.taskWriter.readTaskFile({ projectSlug: SLUG, taskKey, dataRoot });
    if (!file) throw new Error(`${taskKey} has no task file`);
    return file;
  };
  const rawFrontmatter = (taskKey: string) =>
    m.frontmatter.splitFrontmatterMapping(read(taskKey).content).data;

  /** The goal writer's serialization at HEAD: its known keys in order, each
   *  link's keys in order, then the two sections. */
  function goalText(goal: LegacyGoal): string {
    const history = (goal.timeline ?? [])
      .map((entry) => `- ${entry.occurredAt} · ${entry.text}`)
      .join("\n");
    return m.frontmatter.serializeFrontmatterFile(
      {
        id: goal.id,
        title: goal.title,
        status: goal.status,
        createdBy: goal.createdBy,
        createdByLabel: goal.createdByLabel,
        conversationId: goal.conversationId ?? null,
        onFailure: "pause",
        links: goal.links.map((link) => ({
          index: link.index,
          title: link.title,
          goal: link.goal,
          taskKey: link.taskKey ?? null,
          status: link.status ?? "pending",
          note: null,
          redeclared: false,
          blockedBy: link.blockedBy ?? [],
        })),
        createdAt: goal.createdAt ?? null,
        updatedAt: goal.createdAt ?? null,
      },
      {},
      `## Description\n\n${goal.description}\n\n## Timeline\n\n${history}`,
    );
  }

  /** The task writer at HEAD wrote `goalRef` where it writes `epic` now, and
   *  knew no `epic`. */
  function writeLegacyTask(parsed: ParsedTaskFile, goalRef: LegacyGoalRef | null): void {
    delete parsed.unknownFrontmatter.goalRef;
    const current = m.taskFile.serializeTaskFile(parsed);
    const legacy = current.replace(
      "\nepic: null\n",
      `\n${m.frontmatter.toYaml({ goalRef }).trimEnd()}\n`,
    );
    if (legacy === current) throw new Error(`${parsed.frontmatter.key} has no epic line to replace`);
    m.atomic.writeFileAtomic(m.storeRoot.taskFilePath(SLUG, parsed.frontmatter.key, dataRoot), legacy);
  }

  return {
    goalsDir,
    projectDir: m.storeRoot.projectDir(SLUG, dataRoot),
    goalPath: (goalId: string) => path.join(goalsDir, `${goalId}.md`),
    filedGoalPath: (goalId: string) => path.join(goalsDir, "converted", `${goalId}.md`),
    writeGoal(goal: LegacyGoal): void {
      m.atomic.writeFileAtomic(path.join(goalsDir, `${goal.id}.md`), goalText(goal));
    },
    /** Every seeded task as ruling 99 left it: in no chain. */
    legacyEveryTask(): void {
      for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        writeLegacyTask(read(entry.name).parsed, null);
      }
    },
    /** A seeded task, rewritten the way ruling 99 left it. */
    legacySeedTask(
      taskKey: string,
      goalRef: LegacyGoalRef | null,
      edit?: (parsed: ParsedTaskFile) => void,
    ): void {
      const parsed = read(taskKey).parsed;
      edit?.(parsed);
      writeLegacyTask(parsed, goalRef);
    },
    /** A task only the legacy store had. */
    legacyNewTask(taskKey: string, patch: Partial<TaskFrontmatter>, extras: LegacyTaskExtras = {}): void {
      writeLegacyTask(
        {
          frontmatter: m.testStore.baseTaskFrontmatter(taskKey, patch),
          unknownFrontmatter: {},
          goal: `The work of ${taskKey}.`,
          packet: extras.packet ?? null,
          timeline: [],
          extraSections: [],
        },
        extras.goalRef ?? null,
      );
    },
    task: (taskKey: string) => read(taskKey).parsed,
    content: (taskKey: string) => read(taskKey).content,
    frontmatterKeys: (taskKey: string) => Object.keys(rawFrontmatter(taskKey)),
    rawGoalRef: (taskKey: string) =>
      z.object({ goalId: z.string() }).nullable().parse(rawFrontmatter(taskKey).goalRef ?? null),
    rawBlockedBy: (taskKey: string) =>
      z.array(z.string()).parse(rawFrontmatter(taskKey).blockedBy ?? []),
    epic(epicId: string) {
      const file = m.epicWriter.readEpicFile({ projectSlug: SLUG, epicId, dataRoot });
      if (!file) throw new Error(`${epicId} has no readable epic file`);
      return file.parsed;
    },
    epicRaw: (epicId: string) => readFileSync(m.storeRoot.epicFilePath(SLUG, epicId, dataRoot), "utf8"),
    epicIds: () => m.epicWriter.listEpicIds(SLUG, dataRoot),
    /** Hand edits land on disk the way a person's do: the writers' memory of
     *  their own last write must not "repair" them. */
    forgetWrites: () => m.writeCache.resetWriteCacheForTests(),
    reproject: () => m.rebuilder.rebuildProject(app.db, SLUG, { dataRoot }),
    convert() {
      m.writeCache.resetWriteCacheForTests();
      return m.conversion.convertGoalsToEpics(app.db, { dataRoot });
    },
  };
}

// ------------------------------------------------------------ projections

const taskRowSchema = z.object({
  epic_id: z.string().nullable(),
  blocked_by_json: z.string(),
  waiting: z.string(),
});

function taskRow(db: DatabaseSync, taskKey: string) {
  const row = taskRowSchema.parse(
    db
      .prepare(
        `SELECT epic_id, blocked_by_json, waiting FROM task_projections
          WHERE project_slug = ? AND task_key = ?`,
      )
      .get(SLUG, taskKey),
  );
  return {
    epicId: row.epic_id,
    blockedBy: z.array(z.string()).parse(JSON.parse(row.blocked_by_json)),
    waiting: row.waiting,
  };
}

function tasksTitled(db: DatabaseSync, title: string): string[] {
  return z
    .array(z.object({ task_key: z.string() }))
    .parse(
      db
        .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ? AND title = ?`)
        .all(SLUG, title),
    )
    .map((row) => row.task_key);
}

function notificationHref(db: DatabaseSync, id: string): string | null {
  return z
    .object({ href: z.string().nullable() })
    .parse(db.prepare(`SELECT href FROM notifications WHERE id = ?`).get(id)).href;
}

function operatorRunStates(db: DatabaseSync, taskKey: string): string[] {
  return z
    .array(z.object({ state: z.string() }))
    .parse(
      db
        .prepare(
          `SELECT state FROM agent_runs WHERE project_slug = ? AND task_key = ? AND kind = 'operator'`,
        )
        .all(SLUG, taskKey),
    )
    .map((row) => row.state);
}

/** Everything a run could change: the project's files, and the rows the
 *  conversion writes or projects. */
function storeState(db: DatabaseSync, projectDir: string) {
  const files = new Map<string, string>();
  for (const entry of readdirSync(projectDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    files.set(path.relative(projectDir, abs), readFileSync(abs, "utf8"));
  }
  return {
    files,
    epics: db
      .prepare(
        `SELECT epic_id, content_hash, status, description FROM epic_projections
          WHERE project_slug = ? ORDER BY epic_id`,
      )
      .all(SLUG),
    tasks: db
      .prepare(
        `SELECT task_key, content_hash, epic_id, blocked_by_json, waiting FROM task_projections
          WHERE project_slug = ? ORDER BY task_key`,
      )
      .all(SLUG),
    audit: db.prepare(`SELECT id FROM audit_events ORDER BY id`).all(),
    notifications: db.prepare(`SELECT id, href FROM notifications ORDER BY id`).all(),
  };
}

// ---------------------------------------------------------------- timeline

const notesTitled = (parsed: ParsedTaskFile, title: string): TaskFileEvent[] =>
  parsed.timeline.filter((event) => event.type === "note" && event.title === title);
const epicNotes = (parsed: ParsedTaskFile): TaskFileEvent[] => notesTitled(parsed, "Epic");
const waitNotes = (parsed: ParsedTaskFile): TaskFileEvent[] =>
  notesTitled(parsed, "Waits on other work");
const releaseNotes = (parsed: ParsedTaskFile): TaskFileEvent[] =>
  notesTitled(parsed, "Dependencies released");
const assignEvent = (parsed: ParsedTaskFile): TaskFileEvent | undefined =>
  parsed.timeline.find((event) => event.type === "assign");

/** The Epic note the conversion writes on a task that carried the goal. */
function joinedText(epicId: string, epicTitle: string, goalId: string): string {
  return (
    `Added to **${epicId}** (${epicTitle}): goal chains became epics, and ${goalId}, ` +
    `the chain this task was part of, became ${epicId}.`
  );
}

function conversionOf(result: GoalEpicConversion, goalId: string) {
  const found = result.converted.find((c) => c.goalId === goalId);
  if (!found) throw new Error(`${goalId} was not converted`);
  return found;
}

/** The key of the nth task a run made for a goal's unstarted links. */
function madeFor(result: GoalEpicConversion, goalId: string, nth = 0): string {
  const key = conversionOf(result, goalId).started[nth];
  if (!key) throw new Error(`the run made no task number ${nth + 1} for ${goalId}`);
  return key;
}

const keyNumber = (key: string): number => Number(key.split("-")[1]);

// ===================================================================== A

describe("ruling 503(h): the upgrade turns every goal chain into an epic", () => {
  let app: AppTestContext;
  let m: Modules;
  let store: ReturnType<typeof legacyStore>;
  let ids: SeedUserIds;
  let first: GoalEpicConversion;

  /** VIB-182 is released by the conversion, and a release hands the task to
   *  the operator. With no owner to run on, the operator's turn ends with a
   *  decision for a person; nothing writes to the store after that. */
  const releaseSettled = (): boolean => {
    const parsed = store.task("VIB-182");
    const runs = operatorRunStates(app.db, "VIB-182");
    return (
      releaseNotes(parsed).length > 0 &&
      parsed.packet !== null &&
      runs.length > 0 &&
      runs.every((state) => state !== "queued" && state !== "running")
    );
  };

  beforeAll(async () => {
    app = await setupAppTest();
    m = await loadModules();
    ids = (await m.demoSeed.runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
    store = legacyStore(m, app);

    // Selin created goal-7 and has since been made a viewer, who cannot
    // create tasks.
    await m.projectWriter.updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
      const selin = p.frontmatter.members.find((member) => member.userId === ids.selin);
      if (!selin) throw new Error("Selin is not a member of the demo project");
      selin.role = "viewer";
    });
    // A person's own epic already holds the number 9.
    await m.epicWriter.createEpicFile(
      { projectSlug: SLUG, epicId: "epic-9", dataRoot: app.dataRoot },
      {
        frontmatter: {
          id: "epic-9",
          title: "Hand-made epic",
          status: "planned",
          color: "teal",
          leadUserId: null,
          startDate: null,
          targetDate: null,
          createdBy: ids.arda,
          createdByLabel: "Arda Kaya",
          conversationId: null,
          convertedFrom: null,
          createdAt: "2026-09-01T08:00:00.000Z",
          updatedAt: "2026-09-01T08:00:00.000Z",
        },
        description: "Made by a person.",
      },
    );

    store.legacyEveryTask();
    store.writeGoal({
      id: "goal-1",
      title: "Checkout redesign",
      status: "active",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      conversationId: "conv_checkout",
      createdAt: "2026-08-01T09:00:00.000Z",
      description: "Ship the new checkout flow.\n\nThe cart survives every step.",
      timeline: [
        { occurredAt: "2026-08-03T10:00:00.000Z", text: "Link 1 (Build the checkout API) started as VIB-151." },
        { occurredAt: "2026-08-01T09:00:00.000Z", text: "Goal created with 4 links by arda@viberr.dev." },
      ],
      links: [
        { index: 1, title: "Build the checkout API", goal: "Expose the checkout endpoints.", taskKey: "VIB-151", status: "active" },
        { index: 2, title: "Wire the checkout UI", goal: "Connect the UI to the API.", blockedBy: ["goal-1 link 1"] },
        { index: 3, title: "Document checkout", goal: "Write the checkout docs.", blockedBy: ["goal-1 link 2"] },
        { index: 4, title: "Legacy cart shim", goal: "Drop the old cart shim.", status: "skipped" },
      ],
    });
    store.writeGoal({
      id: "goal-2",
      title: "Search revamp",
      status: "active",
      createdBy: ids.murat,
      createdByLabel: "murat@viberr.dev",
      description: "Search that finds things.",
      // Waits on a link of goal-9, which converts after it.
      links: [{ index: 1, title: "Index the catalog", goal: "Index every product.", blockedBy: ["goal-9 link 1", "VIB-153"] }],
    });
    store.writeGoal({
      id: "goal-3",
      title: "Billing export",
      status: "paused",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      description: "Export billing for finance.",
      links: [
        { index: 1, title: "Rehydrate billing", goal: "Rehydrate.", taskKey: "VIB-160", status: "active" },
        { index: 2, title: "Export to CSV", goal: "Write the CSV export.\nInclude every invoice.", blockedBy: ["goal-3 link 1"] },
      ],
    });
    store.writeGoal({
      id: "goal-4",
      title: "Onboarding emails",
      status: "attention",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      description: "Welcome new people.",
      links: [
        { index: 1, title: "Attach the workspace", goal: "Attach.", taskKey: "VIB-142", status: "failed" },
        { index: 2, title: "Send the welcome email", goal: "Send it on sign-up." },
      ],
    });
    store.writeGoal({
      id: "goal-5",
      title: "Release 1.0",
      status: "completed",
      createdBy: ids.elif,
      createdByLabel: "elif@viberr.dev",
      description: "The first release.",
      links: [
        { index: 1, title: "Ship the core", goal: "Ship.", taskKey: "VIB-139", status: "done" },
        { index: 2, title: "Ship the docs", goal: "Ship the docs.", taskKey: "VIB-141", status: "done" },
      ],
    });
    store.writeGoal({
      id: "goal-6",
      title: "Legacy importer",
      status: "cancelled",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      description: "Import the old data.",
      links: [
        { index: 1, title: "Revalidate the board", goal: "Revalidate.", taskKey: "VIB-145", status: "active" },
        { index: 2, title: "Import the archive", goal: "Import every archived order." },
      ],
    });
    store.writeGoal({
      id: "goal-7",
      title: "Mobile layout",
      status: "active",
      createdBy: ids.selin,
      createdByLabel: "selin@viberr.dev",
      description: "Phones first.",
      links: [
        { index: 1, title: "Phone layout", goal: "Lay out phones.", taskKey: "VIB-166", status: "active" },
        { index: 2, title: "Tablet breakpoints", goal: "Add the tablet breakpoints.", blockedBy: ["goal-7 link 1"] },
      ],
    });
    store.writeGoal({
      id: "goal-8",
      title: "Observability",
      status: "active",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      description: "See what runs.",
      links: [
        { index: 1, title: "Structured logs", goal: "Log in JSON.", taskKey: "VIB-168", status: "active" },
        { index: 2, title: "Dashboards", goal: "Chart the logs.", blockedBy: ["goal-6 link 2"] },
        { index: 3, title: "Alerts", goal: "Page on errors.", blockedBy: ["goal-4 link 9"] },
        { index: 4, title: "Trace sampling", goal: "Sample traces.", blockedBy: ["goal-8 link 5"] },
        { index: 5, title: "Trace storage", goal: "Store traces.", blockedBy: ["goal-8 link 4"] },
        { index: 6, title: "Revive the spike", goal: "Build on the spike.", blockedBy: ["VIB-186"] },
      ],
    });
    store.writeGoal({
      id: "goal-9",
      title: "Search infra",
      status: "active",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      description: "Somewhere to search.",
      links: [{ index: 1, title: "Provision the index", goal: "Provision it.", blockedBy: ["VIB-153"] }],
    });

    // The tasks the chains made, carrying `goalRef`.
    store.legacySeedTask("VIB-151", { goalId: "goal-1", linkIndex: 1 });
    // Names goal-1 without carrying one of its links.
    store.legacySeedTask("VIB-148", { goalId: "goal-1", linkIndex: 4 });
    // Its open decision offers to wait on another chain's link.
    store.legacySeedTask("VIB-160", { goalId: "goal-3", linkIndex: 1 }, (parsed) => {
      if (!parsed.packet) throw new Error("VIB-160's seeded decision is missing");
      parsed.packet.options.push({
        kind: "block_on_dependencies",
        t: "Hold for the checkout API",
        d: "",
        rec: false,
        blockedBy: ["goal-1 link 1"],
      });
    });
    store.legacySeedTask("VIB-142", { goalId: "goal-4", linkIndex: 1 });
    store.legacySeedTask("VIB-139", { goalId: "goal-5", linkIndex: 1 });
    store.legacySeedTask("VIB-141", { goalId: "goal-5", linkIndex: 2 });
    store.legacySeedTask("VIB-145", { goalId: "goal-6", linkIndex: 1 });
    store.legacySeedTask("VIB-166", { goalId: "goal-7", linkIndex: 1 });
    // A link's task held on a sibling chain's link.
    store.legacySeedTask("VIB-168", { goalId: "goal-8", linkIndex: 1 }, (parsed) => {
      parsed.frontmatter.blockedBy = ["goal-1 link 1"];
      parsed.frontmatter.waiting = "none";
    });

    // Tasks in no chain that waited on chain links.
    store.legacyNewTask("VIB-180", { stage: "ready", waiting: "none", title: "Checkout analytics", blockedBy: ["goal-1 link 1"] });
    store.legacyNewTask("VIB-181", { stage: "ready", waiting: "none", title: "Checkout QA", blockedBy: ["goal-1 link 2", "VIB-153"] });
    store.legacyNewTask("VIB-182", {
      stage: "ready",
      waiting: "none",
      title: "Cart shim cleanup",
      readiness: "blocked",
      heldAtStage: "ready",
      blockedBy: ["goal-1 link 4"],
    });
    store.legacyNewTask("VIB-183", {
      stage: "ready",
      waiting: "none",
      title: "Export docs",
      readiness: "blocked",
      blockedBy: ["goal-3 link 2"],
    });
    store.legacyNewTask("VIB-184", {
      stage: "ready",
      waiting: "none",
      title: "Mixed waits",
      blockedBy: ["VIB-153", "goal-1 link 1", "goal-1 link 4", "goal-99 link 1"],
    });
    store.legacyNewTask(
      "VIB-185",
      { stage: "ready", waiting: "human", title: "Split the checkout work" },
      {
        packet: {
          type: "input",
          kind: "Decision",
          from: "operator",
          title: "Hold this, or split the follow-ups out?",
          body: "",
          observations: [],
          options: [
            {
              kind: "block_on_dependencies",
              t: "Hold for checkout",
              d: "",
              rec: true,
              blockedBy: ["goal-1 link 1", "goal-1 link 2"],
            },
            {
              kind: "create_task",
              t: "Split the analytics out",
              d: "",
              rec: false,
              newTask: {
                title: "Checkout analytics follow-up",
                goal: "Track the funnel.",
                blockedBy: ["goal-1 link 1", "goal-1 link 4"],
                blocks: ["goal-1 link 3"],
              },
            },
            {
              kind: "create_task",
              t: "Split the cart cleanup out",
              d: "",
              rec: false,
              newTask: { title: "Cart cleanup follow-up", goal: "Remove the shim.", blockedBy: ["goal-1 link 4"] },
            },
          ],
        },
      },
    );
    store.legacyNewTask("VIB-186", { stage: "ready", title: "Abandoned spike", archived: true });

    // Chain notices, and three that name no chain of this project.
    const notice = (id: string, projectSlug: string, href: string) =>
      m.notifications.createNotification(app.db, {
        id,
        userId: ids.arda,
        kind: "controller",
        title: "Chain progress",
        text: "A link started.",
        projectSlug,
        href,
        from: { kind: "agent", name: "Controller" },
        bypassPrefs: true,
      });
    notice("ntf_goal1_link", SLUG, `/projects/${SLUG}/controller#goal-1-link-2`);
    notice("ntf_goal1", SLUG, `/projects/${SLUG}/controller#goal-1`);
    notice("ntf_goal9", SLUG, `/projects/${SLUG}/controller#goal-9`);
    notice("ntf_goal12", SLUG, `/projects/${SLUG}/controller#goal-12`);
    notice("ntf_proposal", SLUG, `/projects/${SLUG}/controller#proposal-kbp_1`);
    notice("ntf_other_project", "deploy-pipeline", "/projects/deploy-pipeline/controller#goal-1");

    store.reproject();
    first = await store.convert();
  });

  afterAll(async () => {
    await waitFor(releaseSettled, "the operator turn VIB-182's release hands off to end", SETTLE_MS).catch(
      () => undefined,
    );
    await flush();
    app.cleanup();
  });

  it("ruling 503(h): each goal status maps onto the epic's", () => {
    // CANARY: `epicStatusOf` answering in_progress for every active goal (no
    // started-link check) turns epic-2 and epic-10 red.
    const expected = {
      "epic-1": "in_progress", // active, link 1 started
      "epic-2": "planned", // active, no link started
      "epic-3": "paused", // paused
      "epic-4": "paused", // attention
      "epic-5": "done", // completed
      "epic-6": "cancelled", // cancelled
      "epic-7": "in_progress",
      "epic-8": "in_progress",
      "epic-10": "planned", // goal-9: active, no link started
    };
    for (const [epicId, status] of Object.entries(expected)) {
      expect(store.epic(epicId).frontmatter.status, epicId).toBe(status);
      expect(m.epicQuery.getEpic(app.db, SLUG, epicId)?.status, epicId).toBe(status);
    }
  });

  it("ruling 503(h): goal-N becomes epic-N, or the next free number when a person's epic holds N", () => {
    // CANARY: `ensureEpic` taking `epic-${goal.number}` without checking it is
    // free: `createEpicFile` refuses epic-9, and the project's whole
    // conversion stops.
    expect(first.failed).toEqual([]);
    expect(first.converted.map((c) => `${c.goalId}>${c.epicId}`)).toEqual([
      "goal-1>epic-1",
      "goal-2>epic-2",
      "goal-3>epic-3",
      "goal-4>epic-4",
      "goal-5>epic-5",
      "goal-6>epic-6",
      "goal-7>epic-7",
      "goal-8>epic-8",
      "goal-9>epic-10",
    ]);
    expect(store.epicIds()).toEqual([
      "epic-1",
      "epic-2",
      "epic-3",
      "epic-4",
      "epic-5",
      "epic-6",
      "epic-7",
      "epic-8",
      "epic-9",
      "epic-10",
    ]);
    expect(store.epic("epic-10").frontmatter).toMatchObject({ title: "Search infra", convertedFrom: "goal-9" });
    expect(store.epic("epic-9").frontmatter).toMatchObject({ title: "Hand-made epic", convertedFrom: null });
    expect(store.epic("epic-9").description).toBe("Made by a person.");
  });

  it("ruling 503(h): the epic keeps the goal's title, description, creator, conversation and history, and says it was converted", () => {
    // CANARY: `ensureEpic` creating the file without `timeline: goal.timeline`
    // replaces the chain's history with a bare "Created by" line.
    const epic = store.epic("epic-1");
    expect(epic.frontmatter).toMatchObject({
      id: "epic-1",
      title: "Checkout redesign",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      conversationId: "conv_checkout",
      convertedFrom: "goal-1",
      createdAt: "2026-08-01T09:00:00.000Z",
      leadUserId: null,
    });
    expect(epic.description).toBe("Ship the new checkout flow.\n\nThe cart survives every step.");
    expect(epic.timeline.map((entry) => entry.text)).toEqual([
      "Converted from goal-1 (Checkout redesign) when goal chains became epics, holding 4 tasks. " +
        `${madeFor(first, "goal-1", 0)} and ${madeFor(first, "goal-1", 1)} were made for links that had not started, ` +
        "each waiting on what its link waited on.",
      "Link 1 (Build the checkout API) started as VIB-151.",
      "Goal created with 4 links by arda@viberr.dev.",
    ]);
    expect(epic.timeline.slice(1).map((entry) => entry.occurredAt)).toEqual([
      "2026-08-03T10:00:00.000Z",
      "2026-08-01T09:00:00.000Z",
    ]);
    expect(m.epicQuery.getEpic(app.db, SLUG, "epic-1")).toMatchObject({
      title: "Checkout redesign",
      status: "in_progress",
      createdBy: ids.arda,
      conversationId: "conv_checkout",
      description: "Ship the new checkout flow.\n\nThe cart survives every step.",
      progress: { total: 4 },
    });
    // A goal with no creation time takes the conversion's; one with no
    // conversation keeps none.
    expect(store.epic("epic-2").frontmatter.createdAt).not.toBeNull();
    expect(store.epic("epic-2").frontmatter).toMatchObject({ createdBy: ids.murat, conversationId: null });
  });

  it("ruling 503(h): every task that carried a link, or named the goal in goalRef, joins the epic with an Epic note and loses goalRef", () => {
    // CANARY: dropping step 2's `scan.goalId === goal.id` loop leaves VIB-148,
    // which named goal-1 without carrying a link, out of epic-1.
    const members = [
      { key: "VIB-151", epicId: "epic-1", title: "Checkout redesign", goalId: "goal-1" },
      { key: "VIB-148", epicId: "epic-1", title: "Checkout redesign", goalId: "goal-1" },
      { key: "VIB-160", epicId: "epic-3", title: "Billing export", goalId: "goal-3" },
      { key: "VIB-142", epicId: "epic-4", title: "Onboarding emails", goalId: "goal-4" },
      { key: "VIB-139", epicId: "epic-5", title: "Release 1.0", goalId: "goal-5" },
      { key: "VIB-141", epicId: "epic-5", title: "Release 1.0", goalId: "goal-5" },
      { key: "VIB-145", epicId: "epic-6", title: "Legacy importer", goalId: "goal-6" },
      { key: "VIB-166", epicId: "epic-7", title: "Mobile layout", goalId: "goal-7" },
      { key: "VIB-168", epicId: "epic-8", title: "Observability", goalId: "goal-8" },
    ];
    for (const { key, epicId, title, goalId } of members) {
      const parsed = store.task(key);
      expect(parsed.frontmatter.epic, key).toBe(epicId);
      expect(taskRow(app.db, key).epicId, key).toBe(epicId);
      expect(epicNotes(parsed), key).toEqual([
        expect.objectContaining({ actor: SIGNED, text: joinedText(epicId, title, goalId) }),
      ]);
      expect(store.frontmatterKeys(key), key).not.toContain("goalRef");
    }
    expect(m.epicQuery.epicTaskKeys(app.db, SLUG, "epic-5")).toEqual(["VIB-139", "VIB-141"]);
    expect(taskRow(app.db, "VIB-153").epicId).toBeNull();
  });

  it("ruling 503(h): an unstarted link of a running chain becomes a held task in the epic, made on the creator's authority and signed by the conversion", () => {
    // CANARY: `startLinkTask` dropping `signedBy`: the owner seat's `assign`
    // event is then Arda's own, not the conversion's.
    const link2 = madeFor(first, "goal-1", 0);
    const link3 = madeFor(first, "goal-1", 1);
    const wire = store.task(link2);
    expect(wire.frontmatter).toMatchObject({
      title: "Wire the checkout UI",
      epic: "epic-1",
      blockedBy: ["VIB-151"],
      waiting: "none",
      ownerUserId: ids.arda,
      stage: "triage",
    });
    expect(wire.goal).toBe("Connect the UI to the API.");
    expect(assignEvent(wire)?.actor).toEqual(SIGNED);
    expect(
      assignEvent(wire)?.text.startsWith(
        "Made for link 2 of goal-1 (Checkout redesign) when goal chains became epics, on Arda Kaya's authority",
      ),
    ).toBe(true);
    expect(store.content(link2)).toContain(" · assign · system:epic-conversion\n");
    expect(epicNotes(wire)).toEqual([
      expect.objectContaining({ actor: SIGNED, text: "Added to **epic-1** (Checkout redesign)." }),
    ]);
    expect(taskRow(app.db, link2)).toEqual({ epicId: "epic-1", blockedBy: ["VIB-151"], waiting: "none" });
    // The creation is the goal creator's, re-proven now.
    const created = listAuditEvents(app.db, { action: "task.created", limit: 500 });
    expect(created.find((row) => row.taskKey === link2)).toMatchObject({
      actorUserId: ids.arda,
      actorLabel: "arda@viberr.dev · epic conversion",
    });
    // Link 3 waited on link 2, so it waits on the task made for it.
    expect(store.task(link3).frontmatter).toMatchObject({ title: "Document checkout", epic: "epic-1", blockedBy: [link2] });
    expect(assignEvent(store.task(link3))?.text.startsWith("Made for link 3 of goal-1 (Checkout redesign)")).toBe(true);
    // Goal-2's creator is Murat, a maintainer.
    const index = madeFor(first, "goal-2");
    expect(store.task(index).frontmatter).toMatchObject({ ownerUserId: ids.murat, epic: "epic-2" });
    expect(assignEvent(store.task(index))).toMatchObject({
      actor: SIGNED,
      text: expect.stringContaining("on Murat Yıldız's authority"),
    });
    expect(created.find((row) => row.taskKey === index)?.actorUserId).toBe(ids.murat);
  });

  it("ruling 503(h): a link waiting on a later chain's unstarted link is made after it, waiting on its task", () => {
    // CANARY: `startUnstartedLinks` not deferring a candidate whose wait is
    // `later`: goal-2's link is made first, waiting on VIB-153 alone.
    const provision = madeFor(first, "goal-9");
    const index = madeFor(first, "goal-2");
    expect(store.task(provision).frontmatter).toMatchObject({ title: "Provision the index", epic: "epic-10", blockedBy: ["VIB-153"] });
    expect(store.task(index).frontmatter).toMatchObject({ title: "Index the catalog", blockedBy: [provision, "VIB-153"] });
    expect(keyNumber(index)).toBeGreaterThan(keyNumber(provision));
  });

  it("ruling 503(h): the unstarted links of a paused, stopped or cancelled chain are listed in the epic's description with their text", () => {
    // CANARY: dropping the `goal.status !== "active"` branch of
    // `startUnstartedLinks` makes paused goal-3's link 2 a task.
    for (const title of ["Export to CSV", "Send the welcome email", "Import the archive"]) {
      expect(tasksTitled(app.db, title), title).toEqual([]);
    }
    expect(store.epic("epic-3").description).toBe(
      [
        "Export billing for finance.",
        "**Not started when goal-3 became this epic.** Make any of these a task in this epic when the work is wanted.",
        "- **Link 2: Export to CSV.** Not made a task because goal-3 was paused.\n" +
          "  It waited on VIB-160.\n\n  Write the CSV export.\n  Include every invoice.",
      ].join("\n\n"),
    );
    expect(m.epicQuery.getEpic(app.db, SLUG, "epic-3")?.description).toBe(store.epic("epic-3").description);
    expect(store.epic("epic-4").description).toContain(
      "- **Link 2: Send the welcome email.** Not made a task because goal-4 was stopped for a decision.",
    );
    expect(store.epic("epic-6").description).toContain(
      "- **Link 2: Import the archive.** Not made a task because goal-6 was cancelled.",
    );
    expect(store.epic("epic-3").timeline[0]?.text).toBe(
      "Converted from goal-3 (Billing export) when goal chains became epics, holding 1 task. " +
        "The chain was paused, so the epic starts paused. 1 unstarted link is listed in the description.",
    );
    expect(store.epic("epic-4").timeline[0]?.text).toContain(
      "The chain was stopped for a decision, so the epic starts paused.",
    );
    for (const goalId of ["goal-3", "goal-4", "goal-6"]) {
      expect(conversionOf(first, goalId), goalId).toMatchObject({ started: [], listed: 1 });
    }
  });

  it("ruling 503(h): a creator who lost task creation has the links listed, re-proven with a silent deny", () => {
    // CANARY: dropping the `creatorMayCreateTasks` check hands the link to
    // `createTask`, whose own loud check refuses Selin: a
    // `project.authority.denied` row, and another reason on the epic.
    expect(tasksTitled(app.db, "Tablet breakpoints")).toEqual([]);
    expect(conversionOf(first, "goal-7")).toMatchObject({ started: [], listed: 1 });
    expect(store.epic("epic-7").description).toContain(
      "- **Link 2: Tablet breakpoints.** Not made a task because selin@viberr.dev no longer holds task creation in this project.\n" +
        "  It waited on VIB-166.\n\n  Add the tablet breakpoints.",
    );
    const denied = listAuditEvents(app.db, { action: "project.authority.denied", limit: 500 });
    expect(denied.filter((row) => row.actorUserId === ids.selin)).toEqual([]);
  });

  it("ruling 503(h): a link whose wait can never be satisfied is listed with why", () => {
    // CANARY: `startUnstartedLinks` making a link whose wait is `gone`
    // instead of listing it: goal-8's Dashboards becomes a task waiting on
    // nothing.
    for (const title of ["Dashboards", "Alerts", "Trace sampling", "Trace storage"]) {
      expect(tasksTitled(app.db, title), title).toEqual([]);
    }
    expect(conversionOf(first, "goal-8")).toMatchObject({ started: [], listed: 5, tasks: 1 });
    const description = store.epic("epic-8").description;
    expect(description).toContain(
      "- **Link 2: Dashboards.** Not made a task because it waited on goal-6 link 2, " +
        "which never became a task (it is listed on epic-6).\n  It waited on goal-6 link 2.",
    );
    expect(description).toContain(
      "- **Link 3: Alerts.** Not made a task because it waited on goal-4 link 9, which does not exist.",
    );
    expect(description).toContain(
      "- **Link 4: Trace sampling.** Not made a task because it waited on another unstarted link round a loop.\n" +
        "  It waited on goal-8 link 5.",
    );
    expect(description).toContain(
      "- **Link 5: Trace storage.** Not made a task because it waited on another unstarted link round a loop.",
    );
    expect(store.epic("epic-8").timeline[0]?.text).toBe(
      "Converted from goal-8 (Observability) when goal chains became epics, holding 1 task. " +
        "5 unstarted links are listed in the description.",
    );
  });

  it("ruling 503(h): a link whose task is refused is listed with the refusal", () => {
    // CANARY: `describeEpic` adding its own full stop after a reason that
    // already ends in one (the refusal's message): "abandoned work..".
    expect(tasksTitled(app.db, "Revive the spike")).toEqual([]);
    expect(store.epic("epic-8").description).toContain(
      "- **Link 6: Revive the spike.** Not made a task because making its task was refused: " +
        "VIB-186 is archived; a task cannot wait on abandoned work.\n  It waited on VIB-186.",
    );
  });

  it("ruling 503(h): a goal-N link M wait is respelled by the key of the task that carried, or now carries, the link", () => {
    // CANARY: `rewriteWaits` without `fm.blockedBy = next` keeps the list the
    // task parser read, which has already dropped every goal-link entry.
    const link2 = madeFor(first, "goal-1", 0);
    expect(store.task("VIB-180").frontmatter.blockedBy).toEqual(["VIB-151"]);
    expect(taskRow(app.db, "VIB-180").blockedBy).toEqual(["VIB-151"]);
    expect(waitNotes(store.task("VIB-180"))).toEqual([
      expect.objectContaining({
        actor: SIGNED,
        text:
          "Goal chains became epics, so what this task waits on is named by task now: " +
          "goal-1 link 1 is VIB-151. It waits on VIB-151; Viberr releases it when every entry is done.",
      }),
    ]);
    expect(store.task("VIB-181").frontmatter).toMatchObject({ blockedBy: [link2, "VIB-153"], waiting: "none" });
    expect(taskRow(app.db, "VIB-181").blockedBy).toEqual([link2, "VIB-153"]);
    expect(waitNotes(store.task("VIB-181"))[0]?.text).toContain(`goal-1 link 2 is ${link2}.`);
    for (const key of ["VIB-180", "VIB-181"]) {
      expect(store.rawBlockedBy(key).join(" "), key).not.toContain("goal-");
    }
    expect(first.rewrittenWaits).toEqual(
      expect.arrayContaining([`${SLUG}/VIB-180`, `${SLUG}/VIB-181`, `${SLUG}/VIB-184`, `${SLUG}/VIB-168`]),
    );
  });

  it("ruling 503(h): a wait on a skipped link is dropped, and a task left waiting on nothing is released", async () => {
    // CANARY: `rewriteWaits` never setting `released`: no `announceRelease`,
    // so VIB-182 gets no release note, audit row or notice.
    const cleared = store.task("VIB-182");
    expect(cleared.frontmatter).toMatchObject({ blockedBy: [], heldAtStage: null });
    expect(taskRow(app.db, "VIB-182").blockedBy).toEqual([]);
    expect(waitNotes(cleared)).toEqual([
      expect.objectContaining({
        actor: SIGNED,
        text:
          "Goal chains became epics, so what this task waits on is named by task now: " +
          "goal-1 link 4 was skipped, so it is off the list.",
      }),
    ]);
    // The engine's own release, announced off the boot path.
    await waitFor(() => releaseNotes(store.task("VIB-182")).length > 0, "VIB-182's release", SETTLE_MS);
    expect(releaseNotes(store.task("VIB-182"))).toEqual([
      expect.objectContaining({
        actor: { kind: "system", systemId: "dependency-release" },
        toAgent: true,
        text:
          "Released: everything this task waited on is done (goal-1 link 4). The task can move again; " +
          "the base branch has changed since the hold, so the work re-reads it before continuing.",
      }),
    ]);
    const audit = listAuditEvents(app.db, { action: "task.dependencies.released", limit: 500 });
    expect(audit.filter((row) => row.taskKey === "VIB-182")).toEqual([
      expect.objectContaining({ details: { entries: ["goal-1 link 4"], clearedBy: null, atBirth: false } }),
    ]);
    const notices = z
      .array(z.object({ user_id: z.string(), title: z.string().nullable() }))
      .parse(
        app.db
          .prepare(
            `SELECT user_id, title FROM notifications
              WHERE project_slug = ? AND task_key = 'VIB-182' AND kind = 'dependency'`,
          )
          .all(SLUG),
      );
    expect(notices.map((row) => row.user_id)).toContain(ids.murat);
    expect(new Set(notices.map((row) => row.title))).toEqual(new Set(["VIB-182 can move again"]));
    // And the task goes back to its operator.
    await waitFor(releaseSettled, "the operator turn VIB-182's release hands off to end", SETTLE_MS);
    expect(operatorRunStates(app.db, "VIB-182")).toHaveLength(1);
  });

  it("ruling 503(h): a wait on a link that will never have a task is dropped, and a task left with nothing waits for a person", () => {
    // CANARY: dropping `fm.waiting = "human"` from `rewriteWaits`' dead
    // branch leaves VIB-183 waiting on nobody with nothing left to wait on.
    const dead = store.task("VIB-183");
    expect(dead.frontmatter).toMatchObject({ blockedBy: [], waiting: "human", readiness: "ready" });
    expect(taskRow(app.db, "VIB-183")).toMatchObject({ blockedBy: [], waiting: "human" });
    expect(waitNotes(dead)[0]?.text).toBe(
      "Goal chains became epics, so what this task waits on is named by task now: " +
        "goal-3 link 2 never became a task (it is listed on epic-3), so it is off the list. " +
        "Nothing it waited on can happen now, so it waits for you: give it other work to wait on, or move it on.",
    );
    expect(releaseNotes(dead)).toEqual([]);
    // With work still to wait on, the task stays held and is told what left.
    const mixed = store.task("VIB-184");
    expect(mixed.frontmatter).toMatchObject({ blockedBy: ["VIB-153", "VIB-151"], waiting: "none" });
    expect(waitNotes(mixed)[0]?.text).toBe(
      "Goal chains became epics, so what this task waits on is named by task now: " +
        "goal-1 link 1 is VIB-151; goal-1 link 4 was skipped, so it is off the list; " +
        "goal-99 link 1 does not exist, so it is off the list. It waits on VIB-153, VIB-151, and Viberr " +
        "releases it when every entry is done, without the work that is off the list: edit what it waits on " +
        "if it needs that work.",
    );
  });

  it("ruling 503(h): a member's own goal-link wait is respelled although joining the epic rewrote its file first", () => {
    // CANARY: `rewriteWaits` reading the waits from the file at step 4 instead
    // of the scan taken before the joins: the join's write already dropped
    // the entry the task parser cannot read.
    expect(store.task("VIB-168").frontmatter).toMatchObject({ epic: "epic-8", blockedBy: ["VIB-151"], waiting: "none" });
    expect(taskRow(app.db, "VIB-168")).toMatchObject({ epicId: "epic-8", blockedBy: ["VIB-151"] });
    expect(waitNotes(store.task("VIB-168"))[0]?.text).toContain("goal-1 link 1 is VIB-151.");
  });

  it("ruling 503(h): an open decision's options that named goal links are respelled by task key", () => {
    // CANARY: skipping the text-level packet respell in `rewriteWaits` leaves
    // the goal-link items in the file, and the task parser drops every option
    // holding one.
    const link2 = madeFor(first, "goal-1", 0);
    const link3 = madeFor(first, "goal-1", 1);
    const options = store.task("VIB-185").packet?.options ?? [];
    expect(options[0]).toMatchObject({ kind: "block_on_dependencies", t: "Hold for checkout", blockedBy: ["VIB-151", link2] });
    expect(options[1]).toMatchObject({
      kind: "create_task",
      t: "Split the analytics out",
      newTask: { title: "Checkout analytics follow-up", blockedBy: ["VIB-151"], blocks: [link3] },
    });
    expect(store.content("VIB-185")).not.toMatch(/goal-\d+ link \d+/);
    expect(first.rewrittenWaits).toContain(`${SLUG}/VIB-185`);
  });

  it("ruling 503(h): an option whose only goal-link entry is dropped stays in the decision", () => {
    // CANARY: the packet respell deleting a list's last item but keeping its
    // key: `blockedBy:` with nothing under it reads as null, and the task
    // parser drops the whole option.
    const options = store.task("VIB-185").packet?.options ?? [];
    expect(options.map((option) => option.t)).toEqual([
      "Hold for checkout",
      "Split the analytics out",
      "Split the cart cleanup out",
    ]);
    const cleanup = options.find((option) => option.t === "Split the cart cleanup out");
    expect(cleanup?.newTask?.title).toBe("Cart cleanup follow-up");
    expect(cleanup?.newTask?.blockedBy ?? []).toEqual([]);
  });

  it("ruling 503(h): a member's open decision keeps its goal-link option, respelled", () => {
    // CANARY: step 2's join (`updateTaskFile` parses and re-serializes the
    // file) running before step 4 respells the decision as text: the parser
    // drops the option it cannot read.
    const options = store.task("VIB-160").packet?.options ?? [];
    expect(options).toHaveLength(4);
    expect(options[3]).toMatchObject({
      kind: "block_on_dependencies",
      t: "Hold for the checkout API",
      blockedBy: ["VIB-151"],
    });
    expect(first.rewrittenWaits).toContain(`${SLUG}/VIB-160`);
  });

  it("ruling 503(h): notices that opened a goal on the Controller page open its epic", () => {
    // CANARY: `finishGoal` updating only the exact `#goal-N` href, without
    // the LIKE for `#goal-N-link-M`.
    expect(notificationHref(app.db, "ntf_goal1_link")).toBe(`/projects/${SLUG}/epics/epic-1`);
    expect(notificationHref(app.db, "ntf_goal1")).toBe(`/projects/${SLUG}/epics/epic-1`);
    expect(notificationHref(app.db, "ntf_goal9")).toBe(`/projects/${SLUG}/epics/epic-10`);
    expect(notificationHref(app.db, "ntf_goal12")).toBe(`/projects/${SLUG}/controller#goal-12`);
    expect(notificationHref(app.db, "ntf_proposal")).toBe(`/projects/${SLUG}/controller#proposal-kbp_1`);
    expect(notificationHref(app.db, "ntf_other_project")).toBe("/projects/deploy-pipeline/controller#goal-1");
  });

  it("ruling 503(h): each conversion leaves an epic.converted audit row with title, from and total", () => {
    // CANARY: `finishGoal` recording the row without `total` in its details.
    const rows = listAuditEvents(app.db, { action: "epic.converted", limit: 500 });
    expect(rows).toHaveLength(9);
    for (const converted of first.converted) {
      const row = rows.find((r) => r.subjectId === converted.epicId);
      expect(row, converted.goalId).toMatchObject({
        actorUserId: null,
        actorLabel: "epic-conversion",
        subjectKind: "epic",
        projectSlug: SLUG,
      });
      expect(row?.details, converted.goalId).toEqual({
        title: store.epic(converted.epicId).frontmatter.title,
        from: converted.goalId,
        total: converted.tasks,
      });
    }
    expect(rows.find((r) => r.subjectId === "epic-1")?.details).toEqual({
      title: "Checkout redesign",
      from: "goal-1",
      total: 4,
    });
  });

  it("ruling 503(h): each goal file is filed under goals/converted, recording the tasks made for its links", () => {
    // CANARY: `recordLinkTask` not writing the new task's key into the goal
    // file: the filed goal-1 says links 2 and 3 never started.
    expect(readdirSync(store.goalsDir)).toEqual(["converted"]);
    for (let n = 1; n <= 9; n += 1) {
      expect(existsSync(store.filedGoalPath(`goal-${n}`)), `goal-${n}`).toBe(true);
    }
    const filed = m.frontmatter.splitFrontmatterMapping(readFileSync(store.filedGoalPath("goal-1"), "utf8"));
    expect(filed.data.links).toEqual([
      expect.objectContaining({ index: 1, taskKey: "VIB-151", status: "active" }),
      expect.objectContaining({ index: 2, taskKey: madeFor(first, "goal-1", 0), status: "active", blockedBy: ["goal-1 link 1"] }),
      expect.objectContaining({ index: 3, taskKey: madeFor(first, "goal-1", 1), status: "active", blockedBy: ["goal-1 link 2"] }),
      expect.objectContaining({ index: 4, taskKey: null, status: "skipped" }),
    ]);
    expect(filed.body).toContain("## Description\n\nShip the new checkout flow.");
  });

  it("ruling 503(h): a second run converts nothing and changes nothing", async () => {
    // CANARY: `finishGoal` not moving the goal file: the second run finds all
    // nine goals again and reports them converted.
    await waitFor(releaseSettled, "the operator turn VIB-182's release hands off to end", SETTLE_MS);
    await flush();
    const before = storeState(app.db, store.projectDir);
    const second = await store.convert();
    await flush();
    expect(second).toEqual({ converted: [], rewrittenWaits: [], failed: [] });
    expect(storeState(app.db, store.projectDir)).toEqual(before);
  });
});

// ===================================================================== B

describe("ruling 503(h): a conversion interrupted part-way finishes on the next boot", () => {
  let app: AppTestContext;
  let m: Modules;
  let store: ReturnType<typeof legacyStore>;
  let ids: SeedUserIds;
  let firstRun: GoalEpicConversion;
  let finishing: GoalEpicConversion;
  let afterwards: GoalEpicConversion;
  /** goal-1's files as its first run left them. */
  const goal1Files = new Map<string, string>();
  let beforeAfterwards: ReturnType<typeof storeState>;

  beforeAll(async () => {
    app = await setupAppTest();
    m = await loadModules();
    ids = (await m.demoSeed.runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
    store = legacyStore(m, app);
    store.legacyEveryTask();

    // goal-1: the first run finishes its epic and dies before filing it.
    store.writeGoal({
      id: "goal-1",
      title: "Checkout redesign",
      status: "active",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      description: "Ship the new checkout flow.",
      links: [
        { index: 1, title: "Build the checkout API", goal: "Expose it.", taskKey: "VIB-151", status: "active" },
        { index: 2, title: "Wire the checkout UI", goal: "Connect it.", blockedBy: ["goal-1 link 1"] },
        { index: 3, title: "Document checkout", goal: "Write it down.", blockedBy: ["goal-1 link 2"] },
      ],
    });
    store.legacySeedTask("VIB-151", { goalId: "goal-1", linkIndex: 1 });
    store.legacyNewTask("VIB-180", { stage: "ready", waiting: "none", title: "Checkout analytics", blockedBy: ["goal-1 link 2"] });
    store.reproject();
    firstRun = await store.convert();
    await flush();
    renameSync(store.filedGoalPath("goal-1"), store.goalPath("goal-1"));
    for (const key of ["VIB-151", "VIB-180", madeFor(firstRun, "goal-1", 0), madeFor(firstRun, "goal-1", 1)]) {
      goal1Files.set(key, store.content(key));
    }
    goal1Files.set("epic-1", store.epicRaw("epic-1"));

    // goal-2: its epic was made and one of its tasks moved when the process
    // died; its other task and its unstarted link were still to come.
    store.writeGoal({
      id: "goal-2",
      title: "Search revamp",
      status: "active",
      createdBy: ids.murat,
      createdByLabel: "murat@viberr.dev",
      description: "Search that finds things.",
      timeline: [{ occurredAt: "2026-08-05T09:00:00.000Z", text: "Goal created with 2 links by murat@viberr.dev." }],
      links: [
        { index: 1, title: "Rehydrate search", goal: "Rehydrate.", taskKey: "VIB-160", status: "active" },
        { index: 2, title: "Index the catalog", goal: "Index every product.", blockedBy: ["goal-2 link 1"] },
      ],
    });
    store.legacySeedTask("VIB-160", { goalId: "goal-2", linkIndex: 1 });
    store.legacySeedTask("VIB-148", { goalId: "goal-2", linkIndex: 3 });
    store.reproject();
    // What `ensureEpic` wrote for goal-2.
    await m.epicWriter.createEpicFile(
      { projectSlug: SLUG, epicId: "epic-2", dataRoot: app.dataRoot },
      {
        frontmatter: {
          id: "epic-2",
          title: "Search revamp",
          status: "in_progress",
          color: "blue",
          leadUserId: null,
          startDate: null,
          targetDate: null,
          createdBy: ids.murat,
          createdByLabel: "murat@viberr.dev",
          conversationId: null,
          convertedFrom: "goal-2",
          createdAt: "2026-09-26T08:00:00.000Z",
          updatedAt: "2026-09-26T08:00:00.000Z",
        },
        description: "Search that finds things.",
        timeline: [{ occurredAt: "2026-08-05T09:00:00.000Z", text: "Goal created with 2 links by murat@viberr.dev." }],
      },
    );
    m.rebuilder.rebuildEpicFile(app.db, SLUG, "epic-2", { dataRoot: app.dataRoot });
    // What `joinEpic` wrote on the task it had moved.
    store.forgetWrites();
    await m.taskWriter.updateTaskFile({ projectSlug: SLUG, taskKey: "VIB-160", dataRoot: app.dataRoot }, (parsed) => {
      delete parsed.unknownFrontmatter.goalRef;
      parsed.frontmatter.epic = "epic-2";
      parsed.timeline.unshift({
        occurredAt: "2026-09-26T08:00:01.000Z",
        type: "note",
        actor: SIGNED,
        title: "Epic",
        text: joinedText("epic-2", "Search revamp", "goal-2"),
        toAgent: false,
        evidence: null,
      });
    });
    m.mutation.reprojectTask(app.db, { dataRoot: app.dataRoot }, SLUG, "VIB-160");

    finishing = await store.convert();
    await flush();
    beforeAfterwards = storeState(app.db, store.projectDir);
    afterwards = await store.convert();
    await flush();
  });

  afterAll(async () => {
    await flush();
    app.cleanup();
  });

  it("ruling 503(h): a goal whose epic was finished but whose file was not filed gets no second epic and no second task", () => {
    // CANARY: `recordLinkTask` not writing the new tasks' keys into the goal
    // file: the finishing run makes links 2 and 3 tasks a second time.
    expect(finishing.failed).toEqual([]);
    expect(conversionOf(finishing, "goal-1")).toMatchObject({ epicId: "epic-1", tasks: 3, started: [], listed: 0 });
    expect(tasksTitled(app.db, "Wire the checkout UI")).toEqual([madeFor(firstRun, "goal-1", 0)]);
    expect(tasksTitled(app.db, "Document checkout")).toEqual([madeFor(firstRun, "goal-1", 1)]);
    expect(
      store.epic("epic-1").timeline.filter((entry) => entry.text.startsWith("Converted from goal-1 ")),
    ).toHaveLength(1);
    const audit = listAuditEvents(app.db, { action: "epic.converted", limit: 500 });
    expect(audit.filter((row) => row.subjectId === "epic-1")).toHaveLength(1);
    expect(existsSync(store.goalPath("goal-1"))).toBe(false);
    expect(existsSync(store.filedGoalPath("goal-1"))).toBe(true);
  });

  it("ruling 503(h): the tasks an interrupted run already moved are left alone", () => {
    // CANARY: `joinEpic` putting a task already in its epic, with no
    // `goalRef`, through `updateTaskFile`, which always writes: a new
    // `updatedAt`, and a projection it never refreshes.
    const now = new Map<string, string>();
    for (const key of goal1Files.keys()) {
      now.set(key, key === "epic-1" ? store.epicRaw(key) : store.content(key));
    }
    expect(now).toEqual(goal1Files);
  });

  it("ruling 503(h): an epic already made is found by convertedFrom, a task already moved keeps its one note, and the rest join", () => {
    // CANARY: `ensureEpic` without the `epicsByGoal` lookup finds epic-2 taken
    // and makes goal-2 a second epic, epic-3.
    expect(store.epicIds()).toEqual(["epic-1", "epic-2"]);
    const index = madeFor(finishing, "goal-2");
    expect(conversionOf(finishing, "goal-2")).toMatchObject({ epicId: "epic-2", tasks: 3, listed: 0 });
    expect(m.epicQuery.epicTaskKeys(app.db, SLUG, "epic-2")).toEqual(["VIB-148", "VIB-160", index]);
    expect(epicNotes(store.task("VIB-160"))).toHaveLength(1);
    expect(store.task("VIB-148").frontmatter.epic).toBe("epic-2");
    expect(epicNotes(store.task("VIB-148"))).toEqual([
      expect.objectContaining({ actor: SIGNED, text: joinedText("epic-2", "Search revamp", "goal-2") }),
    ]);
    expect(store.frontmatterKeys("VIB-148")).not.toContain("goalRef");
    // The unstarted link is made once, waiting on the task that carried link 1.
    expect(tasksTitled(app.db, "Index the catalog")).toEqual([index]);
    expect(store.task(index).frontmatter).toMatchObject({ epic: "epic-2", blockedBy: ["VIB-160"], ownerUserId: ids.murat });
    expect(store.epic("epic-2").timeline.map((entry) => entry.text)).toEqual([
      "Converted from goal-2 (Search revamp) when goal chains became epics, holding 3 tasks. " +
        `${index} was made for links that had not started, each waiting on what its link waited on.`,
      "Goal created with 2 links by murat@viberr.dev.",
    ]);
    const audit = listAuditEvents(app.db, { action: "epic.converted", limit: 500 });
    expect(audit.filter((row) => row.subjectId === "epic-2")).toEqual([
      expect.objectContaining({ details: { title: "Search revamp", from: "goal-2", total: 3 } }),
    ]);
    expect(readdirSync(store.goalsDir)).toEqual(["converted"]);
  });

  it("ruling 503(h): once finished, a further run changes nothing", () => {
    // CANARY: `finishGoal` not filing the goal file: the further run reports
    // goal-1 and goal-2 converted again.
    expect(afterwards).toEqual({ converted: [], rewrittenWaits: [], failed: [] });
    expect(storeState(app.db, store.projectDir)).toEqual(beforeAfterwards);
  });
});

// ===================================================================== C

describe("ruling 503(h): a goal file that cannot be read waits for the next boot", () => {
  let app: AppTestContext;
  let m: Modules;
  let store: ReturnType<typeof legacyStore>;
  let ids: SeedUserIds;
  let result: GoalEpicConversion;
  let again: GoalEpicConversion;
  /** Cut off inside a quoted title: the frontmatter is not YAML. */
  const BROKEN = '---\nid: goal-2\ntitle: "Half-written\nstatus: active\nlinks: []\n---\n\n## Description\n\nCut off.\n';

  beforeAll(async () => {
    app = await setupAppTest();
    m = await loadModules();
    ids = (await m.demoSeed.runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
    store = legacyStore(m, app);
    store.legacyEveryTask();
    store.writeGoal({
      id: "goal-1",
      title: "Checkout redesign",
      status: "active",
      createdBy: ids.arda,
      createdByLabel: "arda@viberr.dev",
      description: "Ship the new checkout flow.",
      links: [{ index: 1, title: "Build the checkout API", goal: "Expose it.", taskKey: "VIB-151", status: "active" }],
    });
    m.atomic.writeFileAtomic(store.goalPath("goal-2"), BROKEN);
    store.legacySeedTask("VIB-151", { goalId: "goal-1", linkIndex: 1 });
    // The task that carried goal-2's link 1, and one waiting on its link 2.
    store.legacySeedTask("VIB-148", { goalId: "goal-2", linkIndex: 1 });
    store.legacyNewTask("VIB-180", { stage: "ready", waiting: "none", title: "Search QA", blockedBy: ["goal-2 link 2"] });
    store.reproject();
    result = await store.convert();
    again = await store.convert();
    await flush();
  });

  afterAll(async () => {
    await flush();
    app.cleanup();
  });

  it("ruling 503(h): it lands in failed and stays in goals/, while the readable goals convert", () => {
    // CANARY: `readLegacyGoal` ignoring the hard-stop diagnostics converts the
    // broken file with defaults, into an epic titled goal-2.
    const failed = [{ projectSlug: SLUG, goalId: "goal-2", reason: "its frontmatter could not be read" }];
    expect(result.failed).toEqual(failed);
    expect(result.converted.map((c) => `${c.goalId}>${c.epicId}`)).toEqual(["goal-1>epic-1"]);
    expect(readFileSync(store.goalPath("goal-2"), "utf8")).toBe(BROKEN);
    expect(existsSync(store.filedGoalPath("goal-2"))).toBe(false);
    expect(store.epicIds()).toEqual(["epic-1"]);
    expect(store.task("VIB-151").frontmatter.epic).toBe("epic-1");
    // Every boot says so again until the file is fixed.
    expect(again).toEqual({ converted: [], rewrittenWaits: [], failed });
  });

  it("ruling 503(h): a task whose goalRef names it keeps the goalRef for the boot that converts it", () => {
    // CANARY: the dangling-goalRef sweep in `convertProject` taking a goal it
    // could not read for one the project no longer has.
    expect(store.rawGoalRef("VIB-148")).toEqual({ goalId: "goal-2" });
    expect(store.task("VIB-148").frontmatter.epic).toBeNull();
  });

  it("ruling 503(h): a task waiting on one of its links keeps the wait", () => {
    // CANARY: `translateWait` reading a link of a goal it could not read as
    // one that "does not exist": the wait is dropped and the task handed to a
    // person.
    expect(store.rawBlockedBy("VIB-180")).toEqual(["goal-2 link 2"]);
    expect(store.task("VIB-180").frontmatter.waiting).toBe("none");
    expect(waitNotes(store.task("VIB-180"))).toEqual([]);
  });
});
