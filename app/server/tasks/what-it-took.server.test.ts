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
import { keepDelivery } from "~/server/files/kept-deliveries.server";
import { writeTaskAttachment } from "~/server/files/task-attachments.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { startRun } from "~/server/runtimes/run-service.server";
import { type InsertRunInput, upsertRun } from "~/server/runtimes/run-store.server";
import { recordAgentCompletion } from "./agent-completion.server";
import { openAgentQuestionPacket } from "./agent-toolkit.server";
import { operatorTransitionStage, operatorWriteCompletionPacket } from "./operator-moves.server";
import { operatorOpenPacket } from "./operator-packets.server";
import { resolvePacket } from "./packet-resolution.server";
import { acceptCompletion } from "./task-acceptance.server";
import { appendComment } from "./task-comments.server";
import { dismissRecommendation } from "./task-recommendations.server";
import { relayToTask } from "./task-relay.server";
import { transitionStage } from "./task-transitions.server";
import { whatItTookFor } from "./what-it-took.server";
import { operatorAuthority } from "../../../test-support/operator-snapshot";

/**
 * Ruling 83: what a task took, read from its run rows and its own record.
 *
 * This suite owns the figure's arithmetic and its sentences, at the read the
 * controller's `get_task` makes (`whatItTookFor`, through the store's own run
 * reader and the task file on disk). The counts that are read from a timeline
 * entry's opening words or its title are driven through the writers that
 * leave those entries (`resolvePacket`, `openAgentQuestionPacket`,
 * `dismissRecommendation`, `recordAgentCompletion`, `transitionStage`,
 * `acceptCompletion`, `appendComment`, `relayToTask`), never through a
 * hand-written entry: a rewording in a writer has to turn a count here red.
 * What each task read carries of it is the two toolkit suites', what the page
 * is sent is the route suite's, and how the card draws it is the component
 * suite's.
 *
 * The project deploys no agent, so nothing here starts an agent or an operator
 * turn: the runs are rows the store's own writer puts down with their stamps,
 * and the one run the run service is asked for is refused before it launches.
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
const timeline = (taskKey = "VIB-1") =>
  readTaskFile({ ...ref(taskKey), dataRoot: store.dataRoot })!.parsed.timeline;

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
const OPERATOR = operatorAuthority({
  "generate-packets": "direct",
  "stage-transitions": "recommend",
  "completion-for-acceptance": "recommend",
});

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

describe("what a task took (ruling 83)", () => {
  it("ruling 83: counts the runs that started, sums their time and their reported cost, and names what it left out", async () => {
    // CANARY: (a) in `measuredInterval`, stop returning null for a run cut by
    // a restart and agent time jumps by the five-hour outage (335 for 35);
    // (b) start `measureRuns`' `costUsd` at 0 instead of null and the
    // Codex-only task reads a zero, a price Codex never quoted; (c) drop the
    // `continue` for a row with no `started_at` and the total reads 7 for the
    // 5 that started; (d) count every row with no `started_at` as never
    // started and the run waiting behind the cap reads as one that never ran.
    seedTask("VIB-1");
    run("VIB-1", { kind: "operator", backend: "claude", state: "finished", startedAt: at("09:00"), finishedAt: at("09:05"), totalCostUsd: 0.5 });
    run("VIB-1", { kind: "primary", backend: "claude", state: "finished", startedAt: at("09:05"), finishedAt: at("09:25"), totalCostUsd: 2 });
    run("VIB-1", { kind: "reviewer", backend: "codex", state: "finished", startedAt: at("09:25"), finishedAt: at("09:35") });
    // Boot recovery stamped this one at the boot instant, five hours later.
    run("VIB-1", { kind: "primary", backend: "claude", state: "interrupted", interruptedReason: "restart", startedAt: at("09:40"), finishedAt: at("14:40") });
    // Refused before its agent launched, by the run service itself: nobody's
    // account to bill. The store stamps such a run as started and ends it in
    // error, so it is a run that started, with no time and no cost.
    const refused = await startRun(store.db, {
      ...ref(),
      dataRoot: store.dataRoot,
      role: "Code review",
      kind: "reviewer",
      backend: "claude",
      model: "sonnet",
      prompt: "Review the delivery.",
      agentProfileId: "reviewer",
      credentialUserId: null,
      principalRefusal: { kind: "unowned", taskKey: "VIB-1" },
    });
    expect(refused.outcome).toBe("refused");
    // Parked behind the run cap, and one dropped from there before it started.
    run("VIB-1", { kind: "reviewer", backend: "claude", state: "queued" });
    run("VIB-1", { kind: "primary", backend: "claude", state: "interrupted", finishedAt: at("09:50") });

    const figure = took();
    expect(figure.runs).toEqual({
      total: 5,
      operator: 1,
      agentMinutes: 35,
      unmeasured: { live: 0, cutByRestart: 1 },
      queued: 1,
      neverStarted: 1,
      recordKept: true,
    });
    expect(figure.cost).toEqual({ usd: 2.5, unreported: { claude: 2, codex: 1 } });
    expect(figure.facts.slice(0, 2)).toEqual([
      "5 runs, 35m of agent time",
      "$2.50, 3 runs reported no cost",
    ]);
    expect(figure.notes).toEqual([
      "1 run was cut by a restart; its time is not counted.",
      "Codex reports no cost, so 1 Codex run is not in the dollar figure.",
      "2 Claude runs ended without reporting a cost, so they are not in the dollar figure.",
    ]);

    // A task only Codex ran has no dollar figure at all: unknown, never zero.
    seedTask("VIB-2");
    run("VIB-2", { kind: "primary", backend: "codex", state: "finished", startedAt: at("09:00"), finishedAt: at("09:10") });
    const codexOnly = took("VIB-2");
    expect(codexOnly.cost).toEqual({ usd: null, unreported: { claude: 0, codex: 1 } });
    expect(codexOnly.facts).toEqual(["1 run, 10m of agent time", "cost not reported"]);
  });

  it("ruling 83: a run still going is a run that started, and its time and cost are said to be missing, not unreported", () => {
    // CANARY: drop the `continue` for a live run in `measureRuns` and it is
    // counted as a run that ended without reporting a cost: VIB-1 reads
    // "$1.00, 1 run reported no cost" and VIB-2 "cost not reported", for a
    // cost that has not been asked for yet.
    seedTask("VIB-1");
    run("VIB-1", { kind: "primary", backend: "claude", state: "finished", startedAt: at("09:00"), finishedAt: at("09:10"), totalCostUsd: 1 });
    run("VIB-1", { kind: "reviewer", backend: "claude", state: "running", agentProfileId: "reviewer", startedAt: at("09:10") });
    const figure = took();
    expect(figure.runs).toMatchObject({ total: 2, agentMinutes: 10, unmeasured: { live: 1, cutByRestart: 0 } });
    expect(figure.cost).toEqual({ usd: 1, unreported: { claude: 0, codex: 0 } });
    expect(figure.facts).toEqual(["2 runs, 10m of agent time", "$1.00"]);
    expect(figure.notes).toEqual(["1 run is still going; its time and cost are not counted yet."]);

    // A task whose only run is still going says nothing about cost at all.
    seedTask("VIB-2");
    run("VIB-2", { kind: "primary", backend: "claude", state: "running", startedAt: at("09:00") });
    const onlyLive = took("VIB-2");
    expect(onlyLive.facts).toEqual(["1 run"]);
    expect(onlyLive.notes).toEqual(["1 run is still going; its time and cost are not counted yet."]);
  });

  it("ruling 83: says the run record is gone when agents ran here and no run row is left, and not for a task that was only relayed to", async () => {
    // CANARY: (a) set `recordKept` to true whatever the timeline holds and a
    // rebuilt database reads as a task nobody ran, with no word that the
    // runs are unknown; (b) take any agent's entry as the trace of a run
    // (drop `!isRelayComment(entry)`) and a task another task relayed its
    // numbers to reads as having lost a run record before anyone ran it.
    //
    // VIB-1: the developer ran and reported. Then the projection database
    // was rebuilt, which is where the run rows live and nowhere else.
    seedTask("VIB-1");
    const runId = run("VIB-1", { kind: "primary", backend: "claude", state: "finished", startedAt: at("09:00"), finishedAt: at("09:20"), totalCostUsd: 1 });
    vi.setSystemTime(new Date(at("09:20")));
    await recordAgentCompletion(store.db, door(), store.slug, "VIB-1", {
      actorRef: DEVELOPER,
      runId,
      replyText: "The migration is written and its tests pass.",
      verdict: null,
      question: null,
      delivers: true,
    });
    expect(took().runs.recordKept).toBe(true);
    expect(took().notes).toEqual([]);
    // What re-baselining the projection database does to this table.
    store.db.exec("DELETE FROM agent_runs");
    const lost = took();
    expect(lost.runs).toMatchObject({ total: 0, recordKept: false });
    expect(lost.notes).toEqual([
      "No run record is kept for this task, so its runs, agent time and cost are not known.",
    ]);

    // VIB-2 waits on VIB-1's numbers, and VIB-1's developer relays them
    // before anything has run on VIB-2 (ruling 71).
    seedTask("VIB-2");
    expect(
      (
        await relayToTask(store.db, door(), {
          projectSlug: store.slug,
          fromTaskKey: "VIB-1",
          toTaskKey: "VIB-2",
          text: "The migration takes 40 seconds on the production snapshot.",
          author: {
            actorRef: DEVELOPER,
            name: "Developer",
            auditActor: { userId: null, label: "agent:claude:developer" },
            notifyFrom: { kind: "agent", backend: "claude", name: "Developer", role: "Implementation" },
          },
        })
      ).outcome,
    ).toBe("done");
    expect(timeline("VIB-2")[0]!.actor).toMatchObject({ kind: "agent", profileId: "developer" });
    const relayedTo = took("VIB-2");
    expect(relayedTo.runs).toMatchObject({ total: 0, recordKept: true });
    expect(relayedTo.notes).toEqual([]);
  });

  it("ruling 83: who spent it is the first eight agents by agent time, with the count of the rest", () => {
    // CANARY: drop the `slice(0, BY_AGENT_MAX)` in `tookByAgent` and a task
    // ten agents ran on lists all ten, so the figure grows with the roster
    // (and `moreAgents` still says two more exist than are shown).
    seedTask("VIB-1");
    for (let n = 1; n <= 10; n += 1) {
      run("VIB-1", {
        kind: "reviewer",
        backend: "claude",
        state: "finished",
        agentProfileId: `reviewer-${n}`,
        agentName: `Reviewer ${n}`,
        startedAt: at("09:00"),
        // Reviewer 10 ran longest, Reviewer 1 least.
        finishedAt: at(`09:${String(n * 5).padStart(2, "0")}`),
        totalCostUsd: n,
      });
    }
    const figure = took();
    expect(figure.byAgent.map((a) => [a.agent, a.agentMinutes])).toEqual([
      ["Reviewer 10", 50],
      ["Reviewer 9", 45],
      ["Reviewer 8", 40],
      ["Reviewer 7", 35],
      ["Reviewer 6", 30],
      ["Reviewer 5", 25],
      ["Reviewer 4", 20],
      ["Reviewer 3", 15],
    ]);
    expect(figure.moreAgents).toBe(2);
    // The two left off the list are still in the task's own total.
    expect(figure.runs.total).toBe(10);
  });

  it("ruling 83: a person is asked once per decision, whoever raised it, and a declined card is not a round", async () => {
    // CANARY: (a) reword the decision entry's lead in `resolvePacket`'s
    // default arm ("**Decided:**") and rounds reads 2 for 4; (b) drop the
    // declined-title exclusion in `whatItTook` and it reads 5; (c) stop
    // adding the open packet and it reads 3 with one still unanswered; (d)
    // write the question's entry in `openAgentQuestionPacket` without
    // `QUESTION_LEAD` ("**Question:**") and `byAgents` reads 1 for 2; (e)
    // write the Codex envelope's question entry in `recordAgentCompletion`
    // without it and `byAgents` reads 1 for 2, on every Codex board; (f)
    // count a person's comment as a decision (drop `entry.type !== "comment"`)
    // and it reads 5.
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

    // A Codex agent asks in the outcome its run ends with, which is the only
    // place it can: the same entry, written by the completion pipeline.
    const codexRun = run("VIB-1", { kind: "primary", backend: "codex", state: "finished", startedAt: at("09:00"), finishedAt: at("09:00") });
    await recordAgentCompletion(store.db, door(), store.slug, "VIB-1", {
      actorRef: { ...DEVELOPER, backend: "codex" },
      runId: codexRun,
      replyText: "I stopped before the destructive step.",
      verdict: null,
      question: { title: "May I drop the legacy table?" },
      delivers: false,
    });
    await resolvePacket(store.db, { ...ref(), optionIndex: 0, note: "Yes, after the backup." }, arda(), door());

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

    // A comment in a person's own words that opens the way a decision's
    // record does: nobody was asked anything.
    await appendComment(
      store.db,
      { ...ref(), text: "**Decision:** we ship the smaller scope. Noting it here for the record." },
      arda(),
      door(),
    );

    // One more decision, still waiting for its answer.
    expect(
      (await operatorOpenPacket(store.db, door(), { ...decision, title: "Drop the old column now?" }, OPERATOR))
        .outcome,
    ).toBe("done");

    const figure = took();
    expect(figure.asked).toEqual({ rounds: 4, byAgents: 2, open: true });
    expect(figure.facts.filter((fact) => fact.startsWith("asked"))).toEqual([
      "asked a person 4 times, 1 not answered yet",
    ]);
  });

  it("ruling 83: a decision waiting for the goal edit it chose is one round, and one that offers acceptance is a round only when answered another way", async () => {
    // CANARY: (a) count every open packet (`file.packet !== null` alone) and
    // the decision kept open for its goal edit reads 2 rounds for 1; (b)
    // count an open packet that offers acceptance and the figure reads "asked
    // a person 1 time, not answered yet" on the card drawn inside that very
    // decision, then drops to 0 the moment the person accepts.
    approveReviewEntry(store);

    // Answered with "I will edit the goal": the packet stays, decided, until
    // the edited goal is saved. Its decision is on the record already.
    seedTask("VIB-1");
    const refine = {
      ...ref(),
      packetType: "input" as const,
      title: "The goal names two databases. Which one?",
      options: [
        { kind: "edit_goal" as const, title: "I will edit the goal", recommended: true },
        { kind: "redirect" as const, title: "Do both" },
      ],
    };
    expect((await operatorOpenPacket(store.db, door(), refine, OPERATOR)).outcome).toBe("done");
    await resolvePacket(store.db, { ...ref(), optionIndex: 0 }, arda(), door());
    expect(readTaskFile({ ...ref(), dataRoot: store.dataRoot })!.parsed.packet?.awaiting).toBe("goal_edit");
    expect(took().asked).toEqual({ rounds: 1, byAgents: 0, open: false });

    // The acceptance decision, on two delivered tasks: one the person
    // accepts, one they send back through the same card.
    const offer = async (taskKey: string) => {
      // Delivered as a file, kept as it was delivered (ruling 86).
      seedTask(taskKey, { stage: "review", validation: "healthy", deliveredAt: at("09:30") });
      writeTaskAttachment(store.slug, taskKey, "plan.md", new TextEncoder().encode("# Plan\n"), store.dataRoot);
      keepDelivery(store.slug, taskKey, at("09:30"), ["plan.md"], store.dataRoot);
      expect(
        (
          await operatorWriteCompletionPacket(
            store.db,
            door(),
            {
              ...ref(taskKey),
              summary: "The migration plan covers both databases.",
              files: [{ name: "plan.md", caption: "The plan" }],
            },
            OPERATOR,
          )
        ).outcome,
      ).toBe("done");
      expect(
        (
          await operatorOpenPacket(
            store.db,
            door(),
            {
              ...ref(taskKey),
              packetType: "input",
              title: "Accept the migration?",
              options: [
                { kind: "accept_completion", title: "Accept and move to Done", recommended: true },
                { kind: "request_edit", title: "Ask for one more fix" },
              ],
            },
            OPERATOR,
          )
        ).outcome,
      ).toBe("done");
    };
    await offer("VIB-2");
    expect(took("VIB-2").asked).toEqual({ rounds: 0, byAgents: 0, open: false });
    await resolvePacket(store.db, { ...ref("VIB-2"), optionIndex: 0 }, arda(), door());
    expect(timeline("VIB-2")[0]!.type).toBe("completion");
    // Accepting is the acceptance, not an answer to a question: no round
    // before it and none after.
    expect(took("VIB-2").asked).toEqual({ rounds: 0, byAgents: 0, open: false });

    await offer("VIB-3");
    await resolvePacket(store.db, { ...ref("VIB-3"), optionIndex: 1, note: "The rollback is missing." }, arda(), door());
    expect(took("VIB-3").asked).toEqual({ rounds: 1, byAgents: 0, open: false });
  });

  it("ruling 83: sent back counts each reviewer's request for changes and each move back by a person", async () => {
    // CANARY: (a) read `verdicts[]` instead of the quality notes and the
    // approval on the same delivery erases the objection (0 for 1); (b) count
    // every stage move of a person's, not the ones to an earlier stage, and
    // the forward move makes it 2; (c) word the move's sentence in
    // `transitionStage` itself, without `stageMoveLead` ("sent VIB-1 from"),
    // and the move back is no longer found; (d) count every note whose title
    // starts with "Changes requested" (as the timeline's card reads one) and
    // VIB-1 reads 2 for the one delivery it was sent back on, and VIB-2,
    // VIB-3 and VIB-4 each read 1 for an objection that bound to nothing;
    // (e) title every request for changes alike in `recordAgentCompletion`'s
    // own arm (the bare title, bound or not, fought or not) and VIB-1's
    // repeat and VIB-2's objection to nothing are counted again.
    const revision = (id: string, sourceProfileId: string) => ({
      id,
      headSha: "a".repeat(40),
      treeSha: "t".repeat(40),
      branch: "vib-work",
      createdAt: at("09:30"),
      sourceProfileId,
    });
    const delivered = (sourceProfileId: string): Partial<TaskFrontmatter> => ({
      stage: "review",
      branch: "vib-work",
      validation: "changed",
      engagements: [
        { profileId: "developer", backend: "claude", role: "Implementation", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
      ],
      workRevision: revision("rev_1", sourceProfileId),
    });
    const review = async (
      taskKey: string,
      verdict: "approve" | "request_changes",
      replyText: string,
      reviewSubject = "rev_1",
    ) => {
      const runId = run(taskKey, {
        kind: "reviewer",
        backend: "claude",
        state: "finished",
        agentProfileId: "reviewer",
        reviewSubject,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      await recordAgentCompletion(store.db, door(), store.slug, taskKey, {
        actorRef: REVIEWER,
        runId,
        replyText,
        verdict,
        question: null,
        delivers: false,
      });
    };

    seedTask("VIB-1", delivered("developer"));
    vi.setSystemTime(new Date(at("09:40")));
    await review("VIB-1", "request_changes", "The retry path is unhandled: a second failure loses the job.");
    // Asked again before the developer has run: the same objection on the
    // same untouched delivery sends nothing back a second time (ruling 92).
    vi.setSystemTime(new Date(at("09:45")));
    await review("VIB-1", "request_changes", "Still unhandled, and the timeout is not configurable either.");
    expect(timeline()[0]).toMatchObject({ type: "quality", title: "Changes requested, on unchanged work" });
    vi.setSystemTime(new Date(at("09:50")));
    await review("VIB-1", "approve", "On a second read the queue retries it. Approved.");
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

    // Three objections that bound to no delivery, each recorded in words
    // under a title that says so. Nothing was sent back by any of them.
    // Nothing delivered yet (ruling 245).
    seedTask("VIB-2");
    await review("VIB-2", "request_changes", "There is nothing here to review yet.", "none");
    // The reviewer made the delivery it is judging (ruling 245).
    seedTask("VIB-3", delivered("reviewer"));
    await review("VIB-3", "request_changes", "My own patch misses the retry path.");
    // A newer delivery landed while it was reading the one before (ruling 84).
    seedTask("VIB-4", delivered("developer"));
    await review("VIB-4", "request_changes", "The retry path is unhandled.", "rev_0");
    for (const [taskKey, why] of [
      ["VIB-2", "nothing on this task has been delivered"],
      ["VIB-3", "it made what is delivered"],
      ["VIB-4", "does not bind to what is delivered now"],
    ] as const) {
      const note = timeline(taskKey)[0]!;
      expect(note).toMatchObject({ type: "quality", title: "Changes requested, not counted" });
      expect(note.text).toContain(why);
      expect(took(taskKey).sentBack).toEqual({ byReviewers: 0, byPeople: 0 });
      expect(took(taskKey).facts.filter((fact) => fact.startsWith("sent back"))).toEqual([]);
    }
  });

  it("ruling 83: wall time runs from filing to the first delivery and to acceptance, split into agent time and time waiting on a person", async () => {
    // CANARY: (a) drop the run-overlap subtraction in `spanTo` and the comment
    // made while the reviewer ran counts that run as waiting (3h for 1h 30m);
    // (b) skip the run rows in `firstDeliveryOf` and a reworked task's first
    // delivery moves to its last (2h for 30m on the files, 11:00 for 09:45 on
    // the revision); (c) drop the `noChanges` return and a task that
    // delivered nothing reads the review of the branch it discarded as its
    // first delivery; (d) skip the verdicts' `files:` stamps and a task whose
    // run rows are gone times its first delivery by its last; (e) time a
    // first delivery by any run dispatched on a subject (drop the `delivered
    // || subject !== revision?.id` condition) and a branch somebody pushed
    // from outside reads as delivered when its review was dispatched.
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
    expect(reworked.notes).toEqual(["The first delivery is timed by the first run dispatched on it."]);

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

    // A head somebody pushed from outside is a subject to review, not a
    // delivery of this task's: the review dispatched on it times nothing.
    seedTask("VIB-5", {
      stage: "review",
      branch: "vib-5-work",
      workRevision: {
        id: "rev_outside",
        headSha: "d".repeat(40),
        treeSha: "t".repeat(40),
        branch: "vib-5-work",
        createdAt: at("11:00"),
        sourceProfileId: null,
        kind: "external",
      },
    });
    run("VIB-5", { kind: "reviewer", backend: "claude", state: "finished", agentProfileId: "reviewer", reviewSubject: "rev_outside", startedAt: at("11:05"), finishedAt: at("11:15") });
    const outside = took("VIB-5");
    expect(outside.wall.firstDelivery).toBeNull();
    expect(outside.facts.filter((fact) => fact.startsWith("first delivery"))).toEqual([]);
  });

  it("ruling 83: the stretch a run cut by a restart or still going may have been running is waiting on nobody, and no agent time either", async () => {
    // CANARY: subtract the measured runs alone from a person's wait (pass
    // `busy` for `occupied` in `whatItTook`) and the hour the developer ran
    // before the restart cut it reads as waiting on the person who commented
    // in it (2h 0m for 30m on VIB-1), and the time the developer has been
    // running reads as waiting on the person who commented beside it (20m for
    // none on VIB-2).
    //
    // VIB-1, filed 09:00. The developer started at once. A person commented
    // at 10:00, while it ran. A restart cut the run, and boot recovery ended
    // it at 10:30, the boot. It ran again 10:30 to 10:45 and delivered. The
    // person accepted at 11:15.
    seedTask("VIB-1", { stage: "review", deliveredAt: at("10:45") });
    run("VIB-1", { kind: "primary", backend: "claude", state: "interrupted", interruptedReason: "restart", startedAt: at("09:00"), finishedAt: at("10:30") });
    vi.setSystemTime(new Date(at("10:00")));
    await appendComment(store.db, { ...ref(), text: "Use the staging snapshot." }, arda(), door());
    run("VIB-1", { kind: "primary", backend: "claude", state: "finished", startedAt: at("10:30"), finishedAt: at("10:45"), totalCostUsd: 1 });
    vi.setSystemTime(new Date(at("11:15")));
    expect(await acceptCompletion(store.db, ref(), arda(), door())).toBe(true);

    const cut = took();
    // The hour and a half to the boot is neither part: 15m an agent is known
    // to have run, 30m from the delivery to the acceptance waiting on a person.
    expect(cut.wall.firstDelivery).toEqual({ at: at("10:45"), minutes: 105, agentMinutes: 15, waitedOnPersonMinutes: 0 });
    expect(cut.wall.acceptance).toEqual({ at: at("11:15"), minutes: 135, agentMinutes: 15, waitedOnPersonMinutes: 30 });
    expect(cut.facts.slice(-1)).toEqual(["accepted 2h 15m after filing, 30m of it waiting on a person"]);
    expect(cut.notes).toContain("1 run was cut by a restart; its time is not counted.");

    // VIB-2, filed 09:00. The developer started at once and is still going.
    // A person commented at 09:20, and its first file was delivered at 09:30.
    vi.setSystemTime(new Date(at("09:00")));
    seedTask("VIB-2", { deliveredAt: at("09:30") });
    run("VIB-2", { kind: "primary", backend: "claude", state: "running", startedAt: at("09:00") });
    vi.setSystemTime(new Date(at("09:20")));
    await appendComment(store.db, { ...ref("VIB-2"), text: "The second sheet matters most." }, arda(), door());
    expect(took("VIB-2").wall.firstDelivery).toEqual({
      at: at("09:30"),
      minutes: 30,
      agentMinutes: 0,
      waitedOnPersonMinutes: 0,
    });
  });
});
