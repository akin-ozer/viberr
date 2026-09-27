import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  createNotification,
  listNotifications,
} from "~/server/projections/notifications.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { NOTIFS_PREF_KEY } from "~/features/profile/profile-query.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  projectFilePath,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { setPref } from "~/server/prefs/user-prefs.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { openAgentQuestionPacket } from "./agent-toolkit.server";
import {
  loadProjectContext,
  notifyOwnerSeatChange,
  notifyTaskWatchers,
  OPERATOR_NOTIFY_FROM,
  recordRecommendationWithdrawal,
  reprojectTask,
  stageDisplayName,
  summaryOrThrow,
  terminalStageIdFor,
  withdrawAcceptanceOffers,
} from "./task-mutation.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import type {
  FileActorRef,
  ParsedTaskFile,
  Recommendation,
} from "~/schemas/task-file.schema";

/** Ruling 361: every notice names its actor; the tests here are about routing. */
const TEST_FROM = { kind: "system" as const, name: "Test" };

/**
 * The task-mutation SUBSTRATE (`task-mutation.server.ts`) — the three helpers
 * every governed write path threads. It was carved out of
 * `task-actions.server.ts` to break a real import cycle, and
 * `task-actions.server.ts` re-exports all of it, so until this file existed
 * NOTHING imported the module by name: its guards could be deleted and every
 * gate would stay green (ruling 65 — "an owner ruling whose guard cannot go red
 * is a ruling that gets reverted in silence").
 *
 * The two things worth guarding here:
 *
 *  1. `notifyTaskWatchers`' RECIPIENT ALGEBRA. Who a governed event reaches is
 *     a governance answer, not a detail: owner + admins + maintainers, minus
 *     the person who caused it, minus anyone an earlier notice about the same
 *     event already reached, minus anyone who silenced that category. Widening
 *     it leaks a project's work to contributors and viewers who were
 *     deliberately left out of the supervisor tier; narrowing it silently
 *     strands the one person who has to act.
 *
 *  2. The FAIL-OPEN catch (C10.1). It is documented as deliberate — the write
 *     has already committed when the fan-out runs, so throwing would surface a
 *     confusing secondary error for an unrelated write AND still leave the
 *     mutation applied. A "cleanup" that turns the catch into a rethrow (or
 *     drops the log line that is the only trail for "watchers got nothing")
 *     would have passed every existing gate.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);
afterEach(() => {
  // A leaked logger spy silences the NEXT test's diagnostics (a spy accumulates
  // across tests in this runner) — restore whatever a test installed.
  vi.restoreAllMocks();
});

const notificationRowSchema = z.object({
  user_id: z.string(),
  kind: z.string(),
  ptype: z.string().nullable(),
  title: z.string().nullable(),
  text: z.string(),
  actor_json: z.string().nullable(),
  project_slug: z.string().nullable(),
  task_key: z.string().nullable(),
  occurred_at: z.string(),
});

function notificationRows(store: TestStore) {
  return z
    .array(notificationRowSchema)
    .parse(
      store.db
        .prepare(
          `SELECT user_id, kind, ptype, title, text, actor_json, project_slug,
                  task_key, occurred_at
             FROM notifications ORDER BY user_id`,
        )
        .all(),
    );
}

/** The fixture's project + one task, owned by `ownerUserId`, projected the way
 *  a running instance is (boot rebuild + reproject on every write). */
function withTask(store: TestStore, ownerUserId: string | null): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", ownerUserId }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/**
 * WHO a governed event reaches. The fixture's roles are the whole point:
 * arda = project admin, murat = maintainer, selin = contributor, elif = viewer,
 * deniz = a registered NON-member.
 */
describe("notifyTaskWatchers — who counts as a watcher", () => {
  it("an unowned task reaches the admins and maintainers, and nobody below", () => {
    // The supervisor tier is the standing audience for a task nobody owns yet.
    // A contributor or a viewer is NOT one: they can see the board, but a
    // governance event is not addressed to them, and fanning out to every
    // member would turn the inbox into a firehose that people silence — which
    // is how the one notification that mattered gets missed.
    const store = setupTestStore(ctx);
    withTask(store, null);

    const notified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "approval",
        from: TEST_FROM,
        text: "the operator asks to move this to done",
      },
      { dataRoot: store.dataRoot },
    );

    expect(notified.sort()).toEqual(
      [store.users.arda.id, store.users.murat.id].sort(),
    );
    const reached = notificationRows(store).map((r) => r.user_id);
    expect(reached).not.toContain(store.users.selin.id);
    expect(reached).not.toContain(store.users.elif.id);
    expect(reached).not.toContain(store.users.deniz.id);
  });

  it("the owner is a watcher whatever their project role — a viewer who owns the task is notified", () => {
    // Ownership, not rank, is what makes an event yours. Deriving the audience
    // from role alone would silence exactly the person the event is about: elif
    // is a VIEWER here, so a role-gated fan-out reaches the two supervisors and
    // leaves the owner to discover their own task changed by looking at it.
    const store = setupTestStore(ctx);
    withTask(store, store.users.elif.id);

    const notified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "packet",
        from: TEST_FROM,
        ptype: "blocked",
        text: "an agent needs a decision",
      },
      { dataRoot: store.dataRoot },
    );

    expect(notified.sort()).toEqual(
      [store.users.arda.id, store.users.murat.id, store.users.elif.id].sort(),
    );
  });

  it("an owner who is also a supervisor is notified exactly once", () => {
    // Two membership reasons, one person, one inbox row. A list-append instead
    // of a set would double-ping every admin who owns their own task — the
    // common case for the person who created it.
    const store = setupTestStore(ctx);
    withTask(store, store.users.arda.id);

    const notified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "quality",
        from: TEST_FROM,
        text: "the reviewer requested changes",
      },
      { dataRoot: store.dataRoot },
    );

    expect(notified.sort()).toEqual(
      [store.users.arda.id, store.users.murat.id].sort(),
    );
    expect(
      notificationRows(store).filter((r) => r.user_id === store.users.arda.id),
    ).toHaveLength(1);
  });

  it("the acting user is never notified of their own action", () => {
    // `exceptUserId` is how a write path says "this is the human who just did
    // it". Telling someone what they themselves just did is the noise that
    // teaches people to ignore the inbox.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);

    const notified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "approval",
        from: TEST_FROM,
        text: "arda approved the transition",
        exceptUserId: store.users.arda.id,
      },
      { dataRoot: store.dataRoot },
    );

    expect(notified.sort()).toEqual(
      [store.users.murat.id, store.users.selin.id].sort(),
    );
    expect(notificationRows(store).map((r) => r.user_id)).not.toContain(
      store.users.arda.id,
    );
  });

  it("exceptUserIds drops the watchers an earlier notice about the SAME event already reached (T13)", () => {
    // T13's per-recipient dedupe: two notices can describe one event (the
    // packet row and the quality fallback). Whoever the first one reached must
    // not get the second, or one event lands twice in one queue.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);

    const notified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "quality",
        from: TEST_FROM,
        text: "review verdict: changes requested",
        exceptUserIds: [store.users.arda.id, store.users.murat.id],
      },
      { dataRoot: store.dataRoot },
    );

    expect(notified).toEqual([store.users.selin.id]);
  });

  it("the return value is the DELIVERY list, not the recipient list — a silenced watcher still needs the fallback (T13)", () => {
    // Two guards in one, and they are the pair T13's rationale rests on:
    //
    //   · a watcher who silenced the category (FR26 routing) gets NO row, and
    //   · they are absent from the RETURNED array, so the caller that feeds
    //     that array into the next notice's `exceptUserIds` does not treat
    //     them as already-reached.
    //
    // Return the recipient set instead of the delivered set and the module's
    // own documented case breaks silently: "a watcher whose prefs dropped the
    // packet row still needs the fallback" — murat would be excluded from the
    // fallback he was never sent the packet for, and hears about the event
    // from neither notice.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);
    setPref(store.db, store.users.murat.id, NOTIFS_PREF_KEY, {
      packets: { app: false },
    });

    const packetNotified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "packet",
        from: TEST_FROM,
        ptype: "blocked",
        text: "a decision is waiting",
      },
      { dataRoot: store.dataRoot },
    );
    expect(packetNotified).not.toContain(store.users.murat.id);
    expect(
      notificationRows(store).map((r) => r.user_id),
    ).not.toContain(store.users.murat.id);

    const fallbackNotified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "quality",
        from: TEST_FROM,
        text: "a decision is waiting (quality fallback)",
        exceptUserIds: packetNotified,
      },
      { dataRoot: store.dataRoot },
    );
    expect(fallbackNotified).toEqual([store.users.murat.id]);
  });

  it("a task file that is not there yet still reaches the supervisors", () => {
    // The ABSENT task file is the benign case and must stay distinct from the
    // UNREADABLE one below: `readTaskFile` returns null, there is simply no
    // owner to add, and the supervisors are still notified. Folding "absent"
    // into the fail-open branch would silence every notice about a task whose
    // file has not landed yet (creation, a restore, a mid-flight rename).
    const store = setupTestStore(ctx);

    const notified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-404",
        kind: "policy",
        from: TEST_FROM,
        text: "the project policy changed",
      },
      { dataRoot: store.dataRoot },
    );

    expect(notified.sort()).toEqual(
      [store.users.arda.id, store.users.murat.id].sort(),
    );
  });

  it("the notice's fields reach the row, and the author is the one the notice names", () => {
    // What the inbox renders. A row that loses its project/task refs is
    // unclickable (B-FD6). `occurredAt` is passed through when the caller has
    // the real event time and stamped by the writer when it does not — never
    // left blank. Ruling 361 (pass 38, F38-15): this test used to require the
    // writer to stamp "Operator" on a notice that named nobody — 816 rows on
    // the live instance (every reviewer verdict, every dependency release)
    // named the Operator for things it never did. The notice now MUST name
    // its actor, and the row carries exactly that.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);

    notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "packet",
        from: TEST_FROM,
        ptype: "input",
        title: "Dev asks: which schema?",
        text: "An engaged agent needs a human decision.",
        occurredAt: "2026-07-02T10:11:12.000Z",
        exceptUserId: store.users.arda.id,
        exceptUserIds: [store.users.murat.id],
      },
      { dataRoot: store.dataRoot },
    );

    const rows = notificationRows(store);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.user_id).toBe(store.users.selin.id);
    expect(row.kind).toBe("packet");
    expect(row.ptype).toBe("input");
    expect(row.title).toBe("Dev asks: which schema?");
    expect(row.text).toBe("An engaged agent needs a human decision.");
    expect(row.project_slug).toBe(store.slug);
    expect(row.task_key).toBe("VIB-1");
    expect(row.occurred_at).toBe("2026-07-02T10:11:12.000Z");
    // CANARY: restore `notice.from ?? OPERATOR_NOTIFY_FROM` in the writer AND
    // make `from` optional again — the row then reads Operator for this notice.
    expect(JSON.parse(row.actor_json ?? "null")).toEqual(TEST_FROM);
    expect(JSON.parse(row.actor_json ?? "null")).not.toEqual(OPERATOR_NOTIFY_FROM);
  });

  it("the author the notice names reaches the row, and an omitted timestamp is stamped", () => {
    // The agent-authored half: a completion notice says WHO reported, not
    // "Operator". And with no caller timestamp the writer stamps `now` — the
    // inbox sorts on this column, so an empty one buries the row forever.
    const store = setupTestStore(ctx);
    withTask(store, null);
    const before = new Date().toISOString();

    notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "quality",
        text: "the developer finished",
        from: {
          kind: "agent",
          backend: "claude",
          name: "Dev",
          role: "Implementation",
        },
        exceptUserId: store.users.murat.id,
      },
      { dataRoot: store.dataRoot },
    );

    const rows = notificationRows(store);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.actor_json ?? "null")).toEqual({
      kind: "agent",
      backend: "claude",
      name: "Dev",
      role: "Implementation",
    });
    expect(rows[0]!.occurred_at >= before).toBe(true);
  });
});

/**
 * The FAIL-OPEN branch (C10.1). Deliberate, documented, and — until this file —
 * untested, which is the exact shape of a guard that gets "simplified" into a
 * rethrow by someone who reads the catch as sloppy error handling.
 */
describe("notifyTaskWatchers — fail-open when recipients cannot be resolved (C10.1)", () => {
  /** Silence the expected diagnostic so a passing run stays readable, and hand
   *  the test the spy to assert on. */
  function captureErrorLog() {
    return vi.spyOn(logger, "error").mockImplementation(() => {});
  }

  it("a missing project.md returns [] instead of throwing, and writes nothing", () => {
    // `loadProjectContext` throws a 404 for a project it cannot read. That
    // throw must die here: the mutation that produced this notice committed
    // BEFORE the fan-out ran, so letting it escape reports a not-found error
    // for a write that actually succeeded — and still leaves the write applied.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);
    captureErrorLog();
    rmSync(projectFilePath(store.slug, store.dataRoot));

    let notified: string[] = [];
    expect(() => {
      notified = notifyTaskWatchers(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          kind: "approval",
          from: TEST_FROM,
          text: "the operator asks to move this to done",
        },
        { dataRoot: store.dataRoot },
      );
    }).not.toThrow();
    expect(notified).toEqual([]);
    expect(notificationRows(store)).toEqual([]);
  });

  it("an unreadable task.md returns [] instead of throwing, and drops the supervisors it had already resolved", () => {
    // A directory where task.md belongs: `existsSync` says yes, the read throws
    // EISDIR. The supervisors were already in the recipient set when it threw —
    // and they are still dropped, because the fan-out is all-or-nothing on
    // purpose. Half a fan-out is the worse outcome: the owner (the person who
    // has to act) is exactly the recipient the failing read was resolving, so a
    // partial send looks like a delivered notice while the one addressee it
    // exists for hears nothing. The log line below is the trail instead.
    const store = setupTestStore(ctx);
    captureErrorLog();
    mkdirSync(taskFilePath(store.slug, "VIB-1", store.dataRoot), {
      recursive: true,
    });

    let notified: string[] = [];
    expect(() => {
      notified = notifyTaskWatchers(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          kind: "packet",
          from: TEST_FROM,
          ptype: "blocked",
          text: "a decision is waiting",
        },
        { dataRoot: store.dataRoot },
      );
    }).not.toThrow();
    expect(notified).toEqual([]);
    expect(notificationRows(store)).toEqual([]);
  });

  it("the failure is logged with the project, task and kind — the only trail for 'watchers got nothing'", () => {
    // C10.1 spells this out: there is no human-facing surface at this layer, and
    // most callers never inspect the returned array, so this log line is the
    // ONLY evidence that a real event reached nobody. A bare `catch { return
    // []; }` is indistinguishable from "nobody was subscribed" and turns a
    // governance blind spot into an unfalsifiable one.
    const store = setupTestStore(ctx);
    const errorLog = captureErrorLog();
    rmSync(projectFilePath(store.slug, store.dataRoot));

    notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "approval",
        from: TEST_FROM,
        text: "the operator asks to move this to done",
      },
      { dataRoot: store.dataRoot },
    );

    expect(errorLog).toHaveBeenCalledTimes(1);
    const [message, fields] = errorLog.mock.calls[0]!;
    expect(message).toContain("notifyTaskWatchers");
    expect(fields?.projectSlug).toBe(store.slug);
    expect(fields?.taskKey).toBe("VIB-1");
    expect(fields?.kind).toBe("approval");
    // The real cause travels too — "recipient resolution failed" with no `err`
    // names the symptom and hides the reason.
    expect(fields?.err).toBeInstanceOf(Error);
  });

  it("the governed write the fan-out rides on still lands", async () => {
    // The reason the catch exists, at a real seam: `openAgentQuestionPacket`
    // writes the packet into task.md, reprojects, records the audit event and
    // THEN notifies. With the project unreadable, the notification cannot
    // resolve anyone — and the packet must still be open, because an agent that
    // asked a human a question has already stopped working on the assumption
    // that it did. A rethrow here would surface a 404 to the agent's tool call
    // for a write that succeeded, and the agent would ask again.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);
    captureErrorLog();
    rmSync(projectFilePath(store.slug, store.dataRoot));
    const agent: FileActorRef = {
      kind: "agent",
      backend: "claude",
      profileId: "developer",
      roleHint: "Implementation",
    };

    const opened = await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        actorRef: agent,
        title: "Which schema should the migration target?",
      },
    );

    expect(opened).toBe(true);
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.packet?.title).toBe(
      "Which schema should the migration target?",
    );
    // …and the fan-out really did reach nobody, so this is the failure mode the
    // write survived, not a run where the notification quietly succeeded.
    expect(notificationRows(store)).toEqual([]);
  });

  it("a project.md whose frontmatter is garbage is NOT the fail-open path — the owner is still reached", () => {
    // Where the line actually falls. The project parser is TOLERANT: unreadable
    // frontmatter yields defaults and diagnostics, not a throw. So a corrupt
    // project file loses the supervisor tier (no members parsed) while the task
    // owner — read from a different file — is still notified. Pinning this
    // keeps the two failure modes apart: "corrupt project" degrades, "cannot
    // read the file at all" fails open.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);
    writeFileSync(
      projectFilePath(store.slug, store.dataRoot),
      "this is not a project file at all\n",
    );

    const notified = notifyTaskWatchers(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        kind: "approval",
        from: TEST_FROM,
        text: "the operator asks to move this to done",
      },
      { dataRoot: store.dataRoot },
    );

    expect(notified).toEqual([store.users.selin.id]);
  });
});

describe("loadProjectContext", () => {
  it("refuses an unknown project with a 404 rather than a stub context", () => {
    // Every governed write threads this context. Returning an empty-membered
    // stub for a project that is not there would let the write proceed against
    // nothing: no member roles to check a role against, no workflow to check a
    // boundary against — an authority check that passes because it has no data.
    const store = setupTestStore(ctx);

    let thrown: unknown;
    try {
      loadProjectContext({ dataRoot: store.dataRoot }, "no-such-project");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    // The status/code are what a route turns into a 404 page instead of a 500
    // "something went wrong" — a plain Error here would be reported as a bug.
    expect(thrown).toMatchObject({
      status: 404,
      code: ERROR_CODES.NOT_FOUND,
    });
  });

  it("carries the archived read-only flag (R6-3), the member roles and the workflow boundaries", () => {
    // R6-3: an archived project is read-only and every governed mutation is
    // refused until it is restored. That refusal is derived from THIS flag, so
    // a load that dropped it (or read the key as anything but `=== true`) would
    // re-open writes on an archived project with no other gate behind it.
    // The boundaries travel for the same reason — they are what makes a
    // transition auto/approval/human rather than always allowed.
    const store = setupTestStore(ctx);
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;

    const active = loadProjectContext({ dataRoot: store.dataRoot }, store.slug);
    expect(active.archived).toBe(false);
    expect(active.slug).toBe(store.slug);
    expect(active.memberRoles.get(store.users.arda.id)).toBe("admin");
    expect(active.memberRoles.get(store.users.murat.id)).toBe("maintainer");
    expect(active.memberRoles.get(store.users.selin.id)).toBe("contributor");
    expect(active.memberRoles.get(store.users.elif.id)).toBe("viewer");
    expect(active.memberRoles.has(store.users.deniz.id)).toBe(false);
    expect(
      active.workflow.find((w) => w.from === "review" && w.to === "done")
        ?.boundary,
    ).toBe("human");
    expect(active.stages.map((s) => s.id)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      "done",
    ]);

    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      archived: true,
    });
    expect(
      loadProjectContext({ dataRoot: store.dataRoot }, store.slug).archived,
    ).toBe(true);
  });
});

describe("reprojectTask", () => {
  const projectionSchema = z.object({ stage: z.string(), title: z.string() });

  function projectionOf(store: TestStore) {
    return projectionSchema.parse(
      store.db
        .prepare(
          `SELECT stage, title FROM task_projections
            WHERE project_slug = ? AND task_key = ?`,
        )
        .get(store.slug, "VIB-1"),
    );
  }

  it("makes the board see the write that just happened", () => {
    // Every write path in `task-actions.server.ts` writes task.md and then
    // calls this. SQLite is a projection of the files, never a second source of
    // truth — so a reproject that no-ops leaves the board, the queues and the
    // inbox serving the PRE-write row while the file says otherwise, and
    // nothing anywhere reports a problem.
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);
    expect(projectionOf(store).stage).toBe("review");

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "done",
        title: "Moved to done",
        ownerUserId: store.users.selin.id,
      }),
    });
    // Deliberately BEFORE the reproject: the file is ahead of the projection,
    // which is precisely the window this helper closes.
    expect(projectionOf(store).stage).toBe("review");

    reprojectTask(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");

    expect(projectionOf(store)).toEqual({
      stage: "done",
      title: "Moved to done",
    });
  });

  it("reads the file under the CONTEXT's data root, not the ambient one", () => {
    // `dataRoot` is how tests, and any deployment with a non-default store,
    // stay pointed at their own files. Drop it anywhere along
    // ctx → taskRef → resolveTaskFilePath and the reproject silently reads a
    // DIFFERENT store: here that means projecting the other root's stage over
    // this one — the docker-data dual-writer hazard in miniature, with no error
    // at any layer.
    const store = setupTestStore(ctx);
    withTask(store, null);

    const otherRoot = ctx.makeTempDir();
    writeProject(otherRoot, {
      ...readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter,
    });
    writeTask(otherRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "triage",
        title: "The other store's copy",
      }),
    });

    reprojectTask(store.db, { dataRoot: otherRoot }, store.slug, "VIB-1");

    expect(projectionOf(store)).toEqual({
      stage: "triage",
      title: "The other store's copy",
    });
  });
});

describe("summaryOrThrow", () => {
  it("answers the projected row the write just re-projected", () => {
    const store = setupTestStore(ctx);
    withTask(store, store.users.selin.id);

    expect(summaryOrThrow(store.db, store.slug, "VIB-1")).toMatchObject({
      projectSlug: store.slug,
      key: "VIB-1",
      stage: "review",
    });
  });

  it("reports a row missing after the write as a server fault, not a 404", () => {
    // The write path already re-projected the file it wrote, so a missing row
    // is a broken projection. A 500 with this exact sentence is what the
    // route's error page and the log line carry.
    const store = setupTestStore(ctx);

    let thrown: unknown;
    try {
      summaryOrThrow(store.db, store.slug, "VIB-404");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown).toMatchObject({
      status: 500,
      code: ERROR_CODES.INTERNAL,
      message: `Task ${store.slug}/VIB-404 vanished after write.`,
    });
  });
});

describe("stageDisplayName", () => {
  it("names the stage the way the project file does, falling back to the raw id", () => {
    // The sentences that name a stage (a recommendation label, the canonical
    // re-anchor block) must read "In Progress", not the id `impl`; an id the
    // file does not declare, or a project file that cannot be read, still
    // yields a usable word rather than an empty one.
    const store = setupTestStore(ctx);
    const context = { dataRoot: store.dataRoot };

    expect(stageDisplayName(context, store.slug, "impl")).toBe("In Progress");
    expect(stageDisplayName(context, store.slug, "qa")).toBe("qa");
    expect(stageDisplayName(context, "no-such-project", "impl")).toBe("impl");
  });
});

describe("terminalStageIdFor", () => {
  it("reads the terminal stage id from the project file, and answers null for a project it cannot read", () => {
    // Ruling 137: the packet writers withdraw a `transition` card into THIS
    // stage along with the accept card, and the operator's transition routing
    // keys off it. A stage id that did not come from the file (a hard-coded
    // "done") would miss a board whose last stage is named otherwise; a throw
    // on an unreadable project would turn the withdrawal's accept-only
    // fallback into a failed write.
    const store = setupTestStore(ctx);
    const context = { dataRoot: store.dataRoot };
    expect(terminalStageIdFor(context, store.slug)).toBe("done");

    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    writeProject(store.dataRoot, {
      ...project,
      stages: [...project.stages, { id: "shipped", name: "Shipped", color: "green" }],
      workflow: [
        ...project.workflow,
        { from: "done", to: "shipped", boundary: "auto", by: "", locked: false },
      ],
    });
    expect(terminalStageIdFor(context, store.slug)).toBe("shipped");

    expect(terminalStageIdFor(context, "no-such-project")).toBeNull();
  });
});

const accept: Recommendation = {
  id: "r-accept",
  kind: "accept_completion",
  label: "Accept completion and move JC-3 to Done",
  detail: "The review is clean.",
  forHeadSha: "6548677".padEnd(40, "0"),
};
const toDone: Recommendation = { id: "r-done", kind: "transition", toStageId: "done", label: "Move to Done", detail: "" };
const toQa: Recommendation = { id: "r-qa", kind: "transition", toStageId: "qa", label: "Move to QA", detail: "" };
const runAgent: Recommendation = { id: "r-run", kind: "run_agent", profileId: "dev", label: "Run Developer", detail: "" };
const delivery: Recommendation = { id: "r-deliver", kind: "delivery", label: "Deliver", detail: "" };
const OPERATOR = { kind: "operator" as const };

function file(recommendations: Recommendation[]): ParsedTaskFile {
  return {
    frontmatter: baseTaskFrontmatter("JC-3", { recommendations }),
    unknownFrontmatter: {},
    goal: "g",
    packet: null,
    timeline: [],
    extraSections: [],
  };
}

describe("withdrawAcceptanceOffers", () => {
  it("a new revision withdraws the accept card only, and writes the note naming the cause", () => {
    // Canary: make the `revision` cause also drop `transition` cards (or drop
    // nothing) and the survivors/removed assertions fail.
    const parsed = file([accept, toDone, toQa, runAgent, delivery]);
    const result = withdrawAcceptanceOffers(parsed, "done", { kind: "revision", headSha: "1215ab44".padEnd(40, "0") }, OPERATOR);
    expect(result.removed.map((r) => r.id)).toEqual(["r-accept"]);
    expect(result.surviving).toBe(4);
    expect(parsed.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-done", "r-qa", "r-run", "r-deliver"]);
    expect(parsed.timeline[0]).toMatchObject({ type: "note", title: "Recommendation withdrawn", actor: OPERATOR });
    expect(parsed.timeline[0]!.text).toContain('"Accept completion and move JC-3 to Done"');
    expect(parsed.timeline[0]!.text).toContain("a new revision `1215ab4` was delivered");
    expect(parsed.timeline[0]!.text).toContain("4 recommendations still stand");
  });

  it("a packet and a move off the boundary withdraw the accept card AND the terminal transition card; other cards survive", () => {
    const packet = file([accept, toDone, toQa, runAgent]);
    const p = withdrawAcceptanceOffers(packet, "done", { kind: "packet", title: "Branch conflicts with main" }, OPERATOR);
    expect(p.removed.map((r) => r.id)).toEqual(["r-accept", "r-done"]);
    expect(packet.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-qa", "r-run"]);
    expect(packet.timeline[0]!.text).toContain('a decision packet opened ("Branch conflicts with main")');

    const moved = file([accept, toDone]);
    const m = withdrawAcceptanceOffers(moved, "done", { kind: "stage_move", toStageId: "impl", toStageName: "Implementation" }, OPERATOR);
    expect(m.removed.map((r) => r.id)).toEqual(["r-accept", "r-done"]);
    expect(m.surviving).toBe(0);
    expect(moved.timeline[0]!.text).toContain("moved to **Implementation**");
    expect(moved.timeline[0]!.text).not.toContain("still stand");
  });

  it("nothing to withdraw writes nothing", () => {
    const parsed = file([runAgent, toQa]);
    const result = withdrawAcceptanceOffers(parsed, "done", { kind: "packet", title: "t" }, OPERATOR);
    expect(result).toEqual({ removed: [], surviving: 2, note: null });
    expect(parsed.timeline).toEqual([]);
  });
});

describe("recordRecommendationWithdrawal", () => {
  it("audits one row per withdrawal and marks the approval bell read ONLY when nothing survives", () => {
    // Canary: call `markTaskPacketApprovalRead` unconditionally and the
    // surviving-card case finds its approval row read.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("JC-3") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    // SAFETY: a `count(*) AS c` aggregate answers exactly one row with the integer `c`.
    const unread = () =>
      (store.db
        .prepare(`SELECT count(*) AS c FROM notifications WHERE task_key = 'JC-3' AND kind = 'approval' AND read_at IS NULL`)
        .get() as { c: number }).c;
    const seedBell = () =>
      createNotification(store.db, {
        userId: store.users.murat.id,
        kind: "approval",
        text: "Run Developer",
        projectSlug: store.slug,
        taskKey: "JC-3",
        bypassPrefs: true,
      });

    seedBell();
    const survivor = file([accept, runAgent]);
    const w1 = withdrawAcceptanceOffers(survivor, "done", { kind: "revision", headSha: "b".repeat(40) }, OPERATOR);
    recordRecommendationWithdrawal(store.db, { projectSlug: store.slug, taskKey: "JC-3", withdrawal: w1, cause: { kind: "revision", headSha: "b".repeat(40) }, actor });
    expect(unread()).toBe(1); // the run_agent card's bell stays unread
    const rows = listAuditEvents(store.db).filter((e) => e.action === "task.recommendation.withdrawn");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ cause: "revision", surviving: 1, removed: [{ id: "r-accept", kind: "accept_completion" }] });

    const alone = file([accept]);
    const w2 = withdrawAcceptanceOffers(alone, "done", { kind: "packet", title: "t" }, OPERATOR);
    recordRecommendationWithdrawal(store.db, { projectSlug: store.slug, taskKey: "JC-3", withdrawal: w2, cause: { kind: "packet", title: "t" }, actor });
    expect(unread()).toBe(0);

    // Nothing removed: no row, no bell change.
    seedBell();
    const none = file([runAgent]);
    const w3 = withdrawAcceptanceOffers(none, "done", { kind: "packet", title: "t" }, OPERATOR);
    recordRecommendationWithdrawal(store.db, { projectSlug: store.slug, taskKey: "JC-3", withdrawal: w3, cause: { kind: "packet", title: "t" }, actor });
    expect(unread()).toBe(1);
    expect(listAuditEvents(store.db).filter((e) => e.action === "task.recommendation.withdrawn")).toHaveLength(2);
  });
});

/**
 * Ruling 140(b) (pass 34, U34-11): the seat-change notifier never writes a row
 * to the person who performed the act, and fails OPEN when the store refuses.
 */
describe("notifyOwnerSeatChange", () => {
  it("writes the row for someone else, and NOTHING for the actor themselves", () => {
    // Canary: drop the `recipientUserId === actor.userId` guard — the actor
    // gets a row telling them about their own act.
    const store = setupTestStore(ctx);
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    const told = notifyOwnerSeatChange(store.db, {
      projectSlug: store.slug,
      recipientUserId: store.users.murat.id,
      actor,
      actorName: "Arda",
      change: { kind: "handed_off", taskKey: "JC-3" },
      eventAt: "2026-09-26T08:00:00.000Z",
    });
    expect(told).toEqual({ userId: store.users.murat.id });
    const row = listNotifications(store.db, store.users.murat.id).find((n) => n.kind === "ownership")!;
    expect(row.title).toBe("Arda handed you JC-3");
    expect(row.taskKey).toBe("JC-3");
    // Ruling 497: the row opens the `assign` event that recorded the change.
    // Canary: drop `href` from the notifier — the row opens the task's top.
    expect(
      store.db.prepare(`SELECT href FROM notifications WHERE id = ?`).get(row.id),
    ).toEqual({ href: `/projects/${store.slug}/tasks/JC-3#event-2026-09-26T08:00:00.000Z` });

    const self = notifyOwnerSeatChange(store.db, {
      projectSlug: store.slug,
      recipientUserId: store.users.arda.id,
      actor,
      actorName: "Arda",
      change: { kind: "taken_over", taskKey: "JC-3" },
      eventAt: "2026-09-26T08:00:00.000Z",
    });
    expect(self).toBeNull();
    expect(
      listNotifications(store.db, store.users.arda.id).filter((n) => n.kind === "ownership"),
    ).toHaveLength(0);
  });

  it("fails OPEN when the store refuses the row, and says the write failed", () => {
    // Canary: let the throw escape — a mutation that already landed would fail
    // on its notification.
    const store = setupTestStore(ctx);
    store.db.exec(`DROP TABLE notifications`);
    const answer = notifyOwnerSeatChange(store.db, {
      projectSlug: store.slug,
      recipientUserId: store.users.murat.id,
      actor: { userId: store.users.arda.id, label: store.users.arda.email },
      actorName: "Arda",
      change: { kind: "admin_released", taskKey: "JC-3" },
      eventAt: "2026-09-26T08:00:00.000Z",
    });
    expect(answer).toEqual({ skipped: "failed" });
  });
});

/**
 * Pass 34 review: the survivor count in the note must describe the array the
 * write LEAVES, including the cards the caller drops in the same write.
 */
describe("withdrawAcceptanceOffers counts what the write really leaves", () => {
  it("cards the caller also drops are removed and NOT counted as survivors", () => {
    // Canary: drop the `alsoStale` parameter (count before the caller's own
    // filter) — the note claims survivors the same write removes.
    const parsed = file([accept, toDone, toQa, runAgent]);
    const result = withdrawAcceptanceOffers(
      parsed,
      "done",
      { kind: "stage_move", toStageId: "impl", toStageName: "Implementation" },
      OPERATOR,
      (r) => r.kind === "transition",
    );
    // Named: the acceptance offers the ruling covers.
    expect(result.removed.map((r) => r.id)).toEqual(["r-accept", "r-done"]);
    expect(parsed.timeline[0]!.text).toContain('"Move to Done"');
    // The other transition card is gone too, and is not counted as standing.
    expect(parsed.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-run"]);
    expect(result.surviving).toBe(1);
    expect(parsed.timeline[0]!.text).toContain("1 recommendation still stands");
  });
});
