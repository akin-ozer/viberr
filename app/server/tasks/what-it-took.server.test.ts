import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "../../../test-support/polling";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  approveReviewEntry,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { type InsertRunInput, upsertRun } from "~/server/runtimes/run-store.server";
import { recordAgentCompletion } from "./agent-completion.server";
import { openAgentQuestionPacket } from "./agent-toolkit.server";
import type { OperatorAuthority } from "./operator-authority.server";
import { operatorTransitionStage } from "./operator-moves.server";
import { operatorOpenPacket } from "./operator-packets.server";
import { resolvePacket } from "./packet-resolution.server";
import { acceptCompletion } from "./task-acceptance.server";
import { appendComment } from "./task-comments.server";
import { dismissRecommendation } from "./task-recommendations.server";
import { transitionStage } from "./task-transitions.server";
import { whatItTookFor } from "./what-it-took.server";

/**
 * Ruling 693: what a task took, read from its run rows and its own record.
 *
 * This suite owns the figure's arithmetic and its sentences, at the read the
 * controller's `get_task` makes (`whatItTookFor`, through the store's own run
 * reader and the task file on disk). The counts that are read from a timeline
 * entry's opening words are driven through the writers that leave those
 * entries (`resolvePacket`, `openAgentQuestionPacket`, `dismissRecommendation`,
 * `recordAgentCompletion`, `transitionStage`, `acceptCompletion`), never
 * through a hand-written entry: a rewording in a writer has to turn a count
 * here red. What each task read carries of it is the two toolkit suites', what
 * the page is sent is the route suite's, and how the card draws it is the
 * component suite's.
 *
 * The project deploys no agent, so nothing here starts a run or an operator
 * turn: the runs are rows the store's own writer puts down with their stamps.
 */

let ctx: TestDbContext;
let store: TestStore;

/** The day every fixture is filed on: `baseTaskFrontmatter`'s own `createdAt`. */
const at = (clock: string) => `2026-07-01T${clock}:00.000Z`;

beforeEach(() => {
  // Only `Date` is frozen, and each step sets it: the writers stamp their
  // entries with it, and file and database I/O keep real time.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at("09:00")));
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(async () => {
  // Each door hands the task to the operator without waiting for it. With no
  // operator deployed that hand-off reads the project and returns: let it
  // come to rest before the store it reads is removed.
  await settle();
  vi.useRealTimers();
  ctx.cleanup();
});

const door = () => ({ dataRoot: store.dataRoot });
const arda = () => actorOf(store.users.arda);
const ref = (taskKey = "VIB-1") => ({ projectSlug: store.slug, taskKey });
const took = (taskKey = "VIB-1") =>
  whatItTookFor(store.db, { ...ref(taskKey), dataRoot: store.dataRoot })!;
const timeline = () =>
  readTaskFile({ ...ref(), dataRoot: store.dataRoot })!.parsed.timeline;

function seedTask(key: string, patch: Partial<TaskFrontmatter> = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, {
      stage: "impl",
      waiting: "none",
      ownerUserId: store.users.arda.id,
      ...patch,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

let runSeq = 0;
/** One run row, as the store's own writer puts it down. */
function run(
  taskKey: string,
  patch: Partial<InsertRunInput> & Pick<InsertRunInput, "kind" | "backend" | "state">,
): string {
  runSeq += 1;
  const id = `run_took_${runSeq}`;
  upsertRun(store.db, {
    id,
    projectSlug: store.slug,
    taskKey,
    threadId: `th-took-${runSeq}`,
    role: patch.kind === "operator" ? "Operator" : "Implementation",
    model: "sonnet",
    sdk: "test",
    agentProfileId: patch.kind === "operator" ? "operator" : "developer",
    ...patch,
  });
  return id;
}

/** The operator's own authority, built by hand: this board deploys no agent. */
const OPERATOR: OperatorAuthority = {
  policy: new Map([
    ["generate-packets", "direct"],
    ["stage-transitions", "recommend"],
  ]),
  autonomy: "supervised",
  backend: "claude",
  model: "sonnet",
  effort: "",
  name: "Operator",
  skills: [],
  kb: [],
  mcps: [],
  persona: null,
  deployed: true,
  humanGatedBeforeWork: false,
};

const DEVELOPER = {
  kind: "agent",
  backend: "claude",
  profileId: "developer",
  roleHint: "Implementation",
} as const;
const REVIEWER = {
  kind: "agent",
  backend: "claude",
  profileId: "reviewer",
  roleHint: "Code review",
} as const;

describe("what a task took (ruling 693)", () => {
  it("ruling 693: counts the runs that started, sums their time and their reported cost, and names what it left out", () => {
    // CANARY: (a) in `measuredInterval`, stop returning null for a run cut by
    // a restart and agent time jumps by the five-hour outage (335 for 35);
    // (b) start `measureRuns`' `costUsd` at 0 instead of null and the
    // Codex-only task reads a zero, a price Codex never quoted; (c) drop the
    // `continue` for a row with no `started_at` and the total reads 5 for the
    // 4 that started.
    seedTask("VIB-1");
    run("VIB-1", { kind: "operator", backend: "claude", state: "finished", startedAt: at("09:00"), finishedAt: at("09:05"), totalCostUsd: 0.5 });
    run("VIB-1", { kind: "primary", backend: "claude", state: "finished", startedAt: at("09:05"), finishedAt: at("09:25"), totalCostUsd: 2 });
    run("VIB-1", { kind: "reviewer", backend: "codex", state: "finished", startedAt: at("09:25"), finishedAt: at("09:35") });
    // Boot recovery stamped this one at the boot instant, five hours later.
    run("VIB-1", { kind: "primary", backend: "claude", state: "interrupted", interruptedReason: "restart", startedAt: at("09:40"), finishedAt: at("14:40") });
    // Refused before it started.
    run("VIB-1", { kind: "reviewer", backend: "claude", state: "error" });

    const figure = took();
    expect(figure.runs).toEqual({
      total: 4,
      operator: 1,
      agentMinutes: 35,
      unmeasured: { live: 0, cutByRestart: 1 },
      neverStarted: 1,
      recordKept: true,
    });
    expect(figure.cost).toEqual({ usd: 2.5, unreported: { claude: 1, codex: 1 } });
    expect(figure.facts.slice(0, 2)).toEqual([
      "4 runs, 35m of agent time",
      "$2.50, 2 runs reported no cost",
    ]);
    expect(figure.notes).toEqual([
      "1 run was cut by a restart; its time is not counted.",
      "Codex reports no cost, so 1 Codex run is not in the dollar figure.",
      "1 Claude run ended before reporting a cost.",
    ]);

    // A task only Codex ran has no dollar figure at all: unknown, never zero.
    seedTask("VIB-2");
    run("VIB-2", { kind: "primary", backend: "codex", state: "finished", startedAt: at("09:00"), finishedAt: at("09:10") });
    const codexOnly = took("VIB-2");
    expect(codexOnly.cost).toEqual({ usd: null, unreported: { claude: 0, codex: 1 } });
    expect(codexOnly.facts).toEqual(["1 run, 10m of agent time", "cost not reported"]);
  });

  it("ruling 693: a person is asked once per decision, whoever raised it, and a declined card is not a round", async () => {
    // CANARY: (a) reword the decision entry's lead in `resolvePacket`'s
    // default arm ("**Decided:**") and rounds reads 2 for 3; (b) drop the
    // declined-title exclusion in `whatItTook` and it reads 4; (c) stop
    // adding the open packet and it reads 2 with one still unanswered; (d)
    // write the question's entry in `openAgentQuestionPacket` without
    // `QUESTION_LEAD` ("**Question:**") and `byAgents` reads 0.
    approveReviewEntry(store);
    seedTask("VIB-1");

    // An agent's own question, answered in the person's words.
    expect(
      await openAgentQuestionPacket(store.db, door(), {
        ...ref(),
        actorRef: DEVELOPER,
        title: "Which database should I migrate?",
      }),
    ).toBe(true);
    await resolvePacket(store.db, { ...ref(), optionIndex: 0, note: "Postgres only." }, arda(), door());

    // The operator's decision, answered with a typed directive.
    const decision = {
      ...ref(),
      packetType: "input" as const,
      title: "Ship the migration in one step or two?",
      options: [
        { kind: "redirect" as const, title: "One step", recommended: true },
        { kind: "request_edit" as const, title: "Two steps" },
      ],
    };
    expect((await operatorOpenPacket(store.db, door(), decision, OPERATOR)).outcome).toBe("done");
    await resolvePacket(
      store.db,
      { ...ref(), optionIndex: 0, custom: "Two steps, and keep the old column for a week." },
      arda(),
      door(),
    );

    // A recommendation card the person declines: a decision, and no question.
    await operatorTransitionStage(store.db, door(), { ...ref(), toStageId: "review" }, OPERATOR);
    const card = readTaskFile({ ...ref(), dataRoot: store.dataRoot })!.parsed.frontmatter
      .recommendations[0]!;
    await dismissRecommendation(store.db, { ...ref(), recId: card.id }, arda(), door());
    expect(timeline()[0]!.title).toBe("Recommendation declined");

    // A third decision, still waiting for its answer.
    expect(
      (await operatorOpenPacket(store.db, door(), { ...decision, title: "Drop the old column now?" }, OPERATOR))
        .outcome,
    ).toBe("done");

    const figure = took();
    expect(figure.asked).toEqual({ rounds: 3, byAgents: 1, open: true });
    expect(figure.facts).toEqual(["asked a person 3 times, 1 not answered yet"]);
  });

  it("ruling 693: sent back counts each reviewer's request for changes and each move back by a person", async () => {
    // CANARY: (a) read `verdicts[]` instead of the quality notes and the
    // approval on the same delivery erases the objection (0 for 1); (b) count
    // every stage move of a person's, not the ones to an earlier stage, and
    // the forward move makes it 2; (c) word the move's sentence in
    // `transitionStage` itself, without `stageMoveLead` ("sent VIB-1 from"),
    // and the move back is no longer found.
    seedTask("VIB-1", {
      stage: "review",
      branch: "vib-1-work",
      validation: "changed",
      engagements: [
        { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
      ],
      workRevision: {
        id: "rev_1",
        headSha: "a".repeat(40),
        treeSha: "t".repeat(40),
        branch: "vib-1-work",
        createdAt: at("09:30"),
        sourceProfileId: "developer",
      },
    });
    const review = async (verdict: "approve" | "request_changes", replyText: string) => {
      const runId = run("VIB-1", {
        kind: "reviewer",
        backend: "claude",
        state: "finished",
        agentProfileId: "reviewer",
        reviewSubject: "rev_1",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      await recordAgentCompletion(store.db, door(), store.slug, "VIB-1", {
        actorRef: REVIEWER,
        runId,
        replyText,
        verdict,
        question: null,
        delivers: false,
      });
    };
    vi.setSystemTime(new Date(at("09:40")));
    await review("request_changes", "The retry path is unhandled: a second failure loses the job.");
    vi.setSystemTime(new Date(at("09:50")));
    await review("approve", "On a second read the queue retries it. Approved.");
    // The file's own count of the objection is gone with the overwrite.
    expect(
      readTaskFile({ ...ref(), dataRoot: store.dataRoot })!.parsed.frontmatter.verdicts.map((v) => v.result),
    ).toEqual(["approve"]);

    vi.setSystemTime(new Date(at("10:00")));
    await transitionStage(
      store.db,
      { ...ref(), toStageId: "impl", manual: true, reason: "Handle the retry before this comes back." },
      arda(),
      door(),
    );
    vi.setSystemTime(new Date(at("10:30")));
    await transitionStage(
      store.db,
      { ...ref(), toStageId: "review", manual: true, reason: "Fixed by hand, ready again." },
      arda(),
      door(),
    );

    const figure = took();
    expect(figure.sentBack).toEqual({ byReviewers: 1, byPeople: 1 });
    expect(figure.facts).toContain("sent back 2 times (1 by reviewers, 1 by a person)");
  });

  it("ruling 693: wall time runs from filing to the first delivery and to acceptance, split into agent time and time waiting on a person", async () => {
    // CANARY: (a) drop the run-overlap subtraction in `spanTo` and the comment
    // made while the reviewer ran counts that run as waiting (3h for 1h 30m);
    // (b) skip the run rows in `firstDeliveryOf` and a reworked task's first
    // delivery moves to its last (2h for 30m on the files, 11:00 for 09:45 on
    // the revision); (c) drop the `noChanges` return and a task that
    // delivered nothing reads the review of the branch it discarded as its
    // first delivery; (d) skip the verdicts' `files:` stamps and a task whose
    // run rows are gone times its first delivery by its last.
    //
    // Filed 09:00. The developer ran 09:00 to 09:30 and delivered files; the
    // reviewer ran on that delivery 10:00 to 10:30; the developer reworked
    // 10:30 to 11:00 and delivered again, which is the stamp the file keeps.
    seedTask("VIB-1", { stage: "review", deliveredAt: at("11:00") });
    run("VIB-1", { kind: "primary", backend: "claude", state: "finished", startedAt: at("09:00"), finishedAt: at("09:30"), totalCostUsd: 1 });
    vi.setSystemTime(new Date(at("10:00")));
    run("VIB-1", { kind: "reviewer", backend: "claude", state: "finished", agentProfileId: "reviewer", reviewSubject: `files:${at("09:30")}`, startedAt: at("10:00"), finishedAt: at("10:30"), totalCostUsd: 1 });
    // A person comments while the reviewer is running.
    vi.setSystemTime(new Date(at("10:15")));
    await appendComment(store.db, { ...ref(), text: "Check the totals row too." }, arda(), door());
    vi.setSystemTime(new Date(at("10:30")));
    run("VIB-1", { kind: "primary", backend: "claude", state: "finished", reviewSubject: `files:${at("09:30")}`, startedAt: at("10:30"), finishedAt: at("11:00"), totalCostUsd: 1 });
    vi.setSystemTime(new Date(at("12:00")));
    expect(await acceptCompletion(store.db, ref(), arda(), door())).toBe(true);

    const figure = took();
    expect(figure.wall).toEqual({
      filedAt: at("09:00"),
      firstDelivery: { at: at("09:30"), minutes: 30, agentMinutes: 30, waitedOnPersonMinutes: 0 },
      acceptance: { at: at("12:00"), minutes: 180, agentMinutes: 90, waitedOnPersonMinutes: 90 },
    });
    expect(figure.facts.slice(-2)).toEqual([
      "first delivery 30m after filing",
      "accepted 3h 0m after filing, 1h 30m of it waiting on a person",
    ]);
    // The delivery's own stamp timed it, so nothing is said about a review.
    expect(figure.notes).toEqual([]);

    // A revision that was reworked: the file keeps the newest revision's
    // time alone, so the first one is timed by the review dispatched on it,
    // and the figure says so.
    seedTask("VIB-3", {
      stage: "review",
      branch: "vib-3-work",
      workRevision: {
        id: "rev_2",
        headSha: "c".repeat(40),
        treeSha: "t".repeat(40),
        branch: "vib-3-work",
        createdAt: at("11:00"),
        sourceProfileId: "developer",
      },
    });
    vi.setSystemTime(new Date(at("09:45")));
    run("VIB-3", { kind: "reviewer", backend: "claude", state: "finished", agentProfileId: "reviewer", reviewSubject: "rev_1", startedAt: at("09:45"), finishedAt: at("09:55"), totalCostUsd: 1 });
    const reworked = took("VIB-3");
    expect(reworked.wall.firstDelivery?.at).toBe(at("09:45"));
    expect(reworked.notes).toEqual(["The first delivery is timed by the first review dispatched on it."]);

    // The run rows are gone (a rebuilt database): the verdict the first
    // delivery got still names it, in the file.
    seedTask("VIB-4", {
      stage: "review",
      deliveredAt: at("11:00"),
      verdicts: [
        { profileId: "reviewer", revisionId: `files:${at("09:30")}`, result: "request_changes", reason: "Totals row missing.", at: at("10:30"), rounds: 1 },
      ],
    });
    expect(took("VIB-4").wall.firstDelivery?.at).toBe(at("09:30"));

    // A task closed as having nothing to deliver, after the branch it once
    // delivered was discarded: the review dispatched on that branch is no
    // first delivery.
    seedTask("VIB-2", {
      stage: "review",
      noChanges: true,
      workRevision: {
        id: "rev_verified",
        headSha: "b".repeat(40),
        treeSha: null,
        branch: null,
        createdAt: at("11:00"),
        sourceProfileId: null,
        kind: "verified",
      },
    });
    run("VIB-2", { kind: "reviewer", backend: "claude", state: "finished", agentProfileId: "reviewer", reviewSubject: "rev_discarded", startedAt: at("10:00"), finishedAt: at("10:10") });
    expect(took("VIB-2").wall.firstDelivery).toBeNull();
  });
});
