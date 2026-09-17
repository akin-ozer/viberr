import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type {
  Engagement,
  PacketOption,
  TaskFileEvent,
  WorkRevision,
} from "~/schemas/task-file.schema";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { insertUser } from "~/server/auth/user-store.server";
import { logger } from "~/server/logging/logger.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { startRun } from "~/server/runtimes/run-service.server";
import { insertRunLine, patchRun, upsertRun } from "~/server/runtimes/run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { emptyRunFailureFacts } from "~/shared/run-failure";
import { stageOutcome } from "./agent-outcome.server";
import {
  acceptanceRefusalFor,
  applyAgentCompletionEffects,
  classifyReviewerVerdict,
  markWaitingAgent,
} from "./task-actions.server";
import {
  assignReviewer,
  startAgentRun,
  assignSpecialist,
} from "./specialist-run.server";

/**
 * The UNIFIED agent-run completion pipeline (fixes A1/A2/A11/X6/X9 from the
 * 2026-07-11 discovery pass): every start path installs ONE handler that posts
 * the reply, reconciles delivery, records a reviewer verdict from the FULL
 * (untruncated) reply, keeps `waiting` honest, and re-invokes the operator.
 */

let ctx: TestDbContext;
let store: TestStore;

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

/** A verdict-capable specialist deployment: an EXPLICIT
 *  `report-validation-verdict: direct` grant is what makes a supporting
 *  engagement a required reviewer whose verdict is recorded + gates acceptance
 *  (F10-14: verdict authority is explicit-only now, no implicit default). Both
 *  `dev` (run as a reviewer on the UI-Run path) and the dedicated `reviewer`
 *  profile (the direct-effects path) carry it. */
const VERDICT_GRANT: CapabilityGrant[] = [
  { capabilityId: "report-validation-verdict", mode: "direct" },
];

function deployDevSpecialist(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  const fm = file.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
      {
        profileId: "dev",
        capabilities: VERDICT_GRANT,
        extras: [],
        definition: {
          kind: "specialist",
          name: "dev",
          role: "Reviewer",
          backends: ["claude"],
          model: "sonnet",
          effort: "xhigh",
        },
      },
      {
        profileId: "reviewer",
        capabilities: VERDICT_GRANT,
        extras: [],
        definition: {
          kind: "specialist",
          name: "reviewer",
          role: "Review & validation",
          backends: ["claude"],
          model: "sonnet",
          effort: "xhigh",
        },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** The delivering developer engagement (workspace owner; never a required
 *  reviewer). */
const DEV_DELIVERS_ENGAGEMENT: Engagement = {
  profileId: "dev",
  backend: "claude",
  role: "Reviewer",
  delivers: true,
  verdictCapable: false,
};
/** The verdict-capable reviewer engagement whose profileId matches the effects'
 *  `profileId: "reviewer"` — so the resolved verdict binds + derives validation. */
const REVIEWER_ENGAGEMENT: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};
/** An immutable delivered revision under review. */
function workRev(id = "rev_1"): WorkRevision {
  return {
    id,
    headSha: "a".repeat(40),
    treeSha: "t".repeat(40),
    branch: "vib-1-work",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "dev",
  };
}

/** Write VIB-1 as a review-state task: a delivered revision under review + a
 *  verdict-capable `reviewer` engagement, so a reviewer completion's verdict
 *  binds to the current revision and gates/derives validation (F10-15). */
function writeReviewTask(
  patch: Parameters<typeof baseTaskFrontmatter>[1] = {},
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      ownerUserId: store.users.arda.id,
      title: "Unified completion pipeline probe",
      branch: "vib-1-work",
      engagements: [DEV_DELIVERS_ENGAGEMENT, REVIEWER_ENGAGEMENT],
      workRevision: workRev(),
      validation: "changed",
      ...patch,
    }),
    goal: "Exercise the reviewer reply + verdict.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** Add an operator deployment to the fixture project, so the completion react
 *  actually reaches `runOperator` — with none deployed it returns early and any
 *  assertion about the react is vacuous. */
function deployOperator(): void {
  const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...pf.parsed.frontmatter,
    agents: [
      ...pf.parsed.frontmatter.agents,
      {
        profileId: "operator",
        capabilities: [
          { capabilityId: "generate-packets", mode: "direct" },
          { capabilityId: "append-typed-events", mode: "direct" },
        ],
        extras: [],
        definition: {
          kind: "operator",
          name: "Operator",
          role: "Task coordinator",
          backends: ["claude"],
          model: "sonnet",
          autonomy: "supervised",
        },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function taskFile() {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deployDevSpecialist();
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Unified completion pipeline probe",
    }),
    goal: "Exercise the canonical completion handler.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  installFakeRuntime();
  // Ruling 127: an agent run bills the TASK OWNER's own accounts, so a run
  // only reaches an adapter when the owner has that backend connected. Arda
  // owns the tasks in this file; connecting both backends for him is the
  // ordinary state of somebody using the product.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
  await connectFakeBackend(store.db, store.users.arda.id, "codex");
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("waiting-state bookkeeping (A2)", () => {
  it("startSpecialistRun marks waiting=agent while the run is in flight", async () => {
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile().parsed.frontmatter.waiting).not.toBe("agent");
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
  });

  it("markWaitingAgent is idempotent and reprojects", async () => {
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
  });
});

describe("applyAgentCompletionEffects (the shared effects)", () => {
  /** Start a fake provider run whose final assistant text is `text`, wait for
   *  it to finish, and return its run id. `autonomous` — no default
   *  completion hook is registered by startRun itself. Session/thread ids are
   *  unique per call so a test can drive more than one run without colliding on
   *  the (project, task, thread) uniqueness. */
  let runSeq = 0;
  async function finishedRunWith(text: string): Promise<string> {
    runSeq += 1;
    queueFakeRun({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
      sessionId: `t-${runSeq}`,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "reviewer",
      role: "Reviewer",
      agentProfileId: "reviewer",
      credentialUserId: store.users.arda.id,
      backend: "claude",
      model: "sonnet",
      prompt: "review",
      workdir: store.dataRoot,
      autonomous: true,
      dataRoot: store.dataRoot,
      actor: actor(store.users.arda),
      threadId: `th-${runSeq}`,
    });
    await waitFor(() => {
      // SAFETY: the SELECT list is the single column `state`, which
      // `agent_runs` declares TEXT NOT NULL in 0001_baseline; `undefined` is
      // sqlite's own answer when the id matches no row.
      const row = store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get(started.runId) as { state: string } | undefined;
      return row?.state === "finished";
    });
    return started.runId;
  }

  /**
   * Ruling 231 (F37-51, live on pass 37). The react re-invocation used to pin
   * `ctx.operatorRun.backend` — the backend of the drive that prompted the
   * agent — and pass it as an OVERRIDE, which beats the live deployment. R22
   * removed exactly that pin from schedules, on exactly this reasoning:
   * following the profile that is ACTUALLY deployed matters more than freezing
   * whatever was configured earlier.
   *
   * Measured: the owner moved the operator from Codex to `opus[1m]` at
   * 04:19:56 UTC, and a react chain started a CODEX operator run at 04:31:44
   * against a deployment that read `claude`.
   *
   * Canary: restore `reactBackend = input.operatorRun.backend`.
   */
  it("ruling 231: a react uses the DEPLOYED backend, not the one its chain started on", async () => {
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            // The live deployment the owner just set.
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    writeReviewTask({ stage: "impl", waiting: "agent" });
    const runId = await finishedRunWith("Done with the slice. @operator");

    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "developer",
        role: "Implementation",
        delivers: true,
        workdir: null,
        agentHandle: "developer",
        // The chain that prompted this agent ran on the OLD backend. This is
        // the field the react block reads — putting it on `ctx` instead made
        // the first version of this canary pass with the bug restored.
        operatorRun: { backend: "codex", autonomy: "supervised", reactDepth: 0 },
      },
      { id: runId, state: "finished" },
    );
    await new Promise((r) => setTimeout(r, 80));

    // SAFETY: `backend` is a TEXT NOT NULL column on `agent_runs`
    // (0001_baseline.sql); only operator rows are selected and this test
    // creates exactly one.
    const operatorRows = store.db
      .prepare(`SELECT backend FROM agent_runs WHERE kind = 'operator'`)
      .all() as { backend: string }[];
    expect(operatorRows.length).toBeGreaterThan(0);
    expect(operatorRows.map((r) => r.backend)).not.toContain("codex");
    expect(operatorRows[0]!.backend).toBe("claude");
  });

  /**
   * Ruling 177 (pass 36, F36-5): a run that outlives its task's closure —
   * HLC-9 was force-accepted while its developer was still building; the run
   * finished three minutes later, the dispatch-completion contract re-invoked
   * the operator on the SHIPPED task and the operator opened a decision packet
   * there. The completion is recorded (the report is evidence), a note says the
   * task had closed, and NO operator wake follows — however the run was
   * dispatched. Canary: delete the `taskClosure` branch in
   * `applyAgentCompletionEffects` (the operator run row appears again).
   */
  it("ruling 177: a run finishing after the task closed leaves a note and wakes no operator", async () => {
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    // Shipped (terminal) while the run was live — the F36-5 shape.
    writeReviewTask({ stage: "done", waiting: "agent" });
    const runId = await finishedRunWith("Implemented the harness; branch hlc-9, HEAD 16c6e2e. @operator");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "developer",
        role: "Implementation",
        delivers: true,
        workdir: null,
        agentHandle: "developer",
        // The dispatch-completion contract's forced react hop — the very hop
        // that woke the operator on the shipped task live.
        dispatchedByName: "Arda",
        dispatchedByUserId: store.users.arda.id,
      },
      { id: runId, state: "finished" },
    );
    await new Promise((r) => setTimeout(r, 50));
    const operatorRows = store.db
      .prepare(`SELECT id FROM agent_runs WHERE kind = 'operator'`)
      .all();
    expect(operatorRows).toHaveLength(0);
    const fm = taskFile().parsed.frontmatter;
    expect(fm.stage).toBe("done");
    expect(fm.waiting).toBe("none");
    expect(taskFile().parsed.packet).toBeFalsy();
    const note = taskFile().parsed.timeline.find(
      (e) => e.type === "note" && e.title === "Completed after the task closed",
    )!;
    expect(note).toBeDefined();
    expect(note.text).toMatch(/VIB-1 is closed \(Done is the terminal stage\)/);
    expect(note.text).toMatch(/no coordination follows/);
    // The report itself stays on the record.
    expect(taskFile().parsed.timeline.some((e) => e.type === "comment")).toBe(true);
  });

  it("F36-6 (pass 36): a request-changes verdict voids a pending 'move to <stage>' card", async () => {
    // Live (HLC-14 17:43Z): Viberr's delivery card "Move the task to Merge
    // Approval" stayed on the page with Apply next to `validation failing`.
    // Canary: drop the `validation === "failing" && r.kind === "transition"`
    // clause from the verdict block's recommendation filter.
    writeReviewTask({
      recommendations: [
        {
          id: "rec_move",
          kind: "transition",
          toStageId: "done",
          label: "Move the task to Done",
          detail: "Recorded by Viberr when the delivery landed.",
        },
        {
          id: "rec_run",
          kind: "run_agent",
          profileId: "developer",
          label: "Run Developer",
          detail: "Keep going.",
        },
      ],
    });
    const runId = await finishedRunWith("Verdict: request changes — the tests are missing.");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const fm = taskFile().parsed.frontmatter;
    expect(fm.validation).toBe("failing");
    expect(fm.recommendations.map((r) => r.id)).toEqual(["rec_run"]);
  });

  /**
   * Ruling 248 (pass 37, F37-77): a run that could not read the work judges
   * nothing.
   *
   * LIVE, on SHOP-5. The Code Reviewer's checkout failed to provision, so
   * viberr told it in the prompt: "The workspace has NO checkout, and this is a
   * server-side FAILURE, not something you can fix … quote the reason above
   * verbatim". It did exactly that, returned envelope `verdict: null` and wrote
   * "No content verdict recorded" in its summary — and viberr recorded
   * `request_changes` against the revision, because the prose fallback matched
   * the word "failure" inside viberr's OWN sentence. That fabricated objection
   * was the second in a row from that reviewer, so the policy engine raised a
   * review-deadlock packet asking a person to choose between interrogating a
   * reviewer that never judged and forcing acceptance past a verdict that did
   * not exist.
   *
   * The text below is the sentence viberr itself composes, verbatim.
   */
  const VIBERR_OWN_NO_CHECKOUT_REPORT =
    "The checkout could not be provisioned, so I cannot review revision `81ae03e` or run its suite. " +
    "Per the workspace contract: \u201cThe workspace has NO checkout, and this is a server-side failure, " +
    "not something you can fix.\u201d No content verdict recorded.";

  it("ruling 248: a reviewer run with NO checkout records no verdict, however its prose reads", async () => {
    writeReviewTask();
    const runId = await finishedRunWith(VIBERR_OWN_NO_CHECKOUT_REPORT);
    // The durable fact the clone path stamps on the row.
    patchRun(store.db, runId, { noCheckout: 1 });

    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );

    const fm = taskFile().parsed.frontmatter;
    // CANARY: drop `&& !readNothing` from the verdict line and this is
    // `failing` with a `request_changes` row bound to the revision — the live
    // shape, fabricated out of viberr's own word.
    expect(fm.verdicts).toEqual([]);
    expect(fm.validation).toBe("changed");
    // And the record says what happened, rather than leaving a completed review
    // run on the page with nothing to explain the silence.
    const note = taskFile().parsed.timeline.find(
      (e) => e.type === "note" && e.text.includes("no checkout of the repository"),
    );
    expect(note).toBeTruthy();
    expect(note!.text).toContain("recorded no verdict");
    // "Re-run the review" is bad advice for a condition a re-run reproduces.
    expect(note!.text).not.toContain("Re-run the review or record a verdict manually");
  });

  it("ruling 248: the trap is real — that same prose classifies as request_changes", () => {
    // Not a hypothetical. The ONE word carrying the verdict is "failure", and
    // it is in the sentence VIBERR wrote and ordered the agent to quote.
    // CANARY: this is the pre-fix behaviour, pinned so nobody removes the gate
    // above believing the classifier is harmless here.
    expect(classifyReviewerVerdict(VIBERR_OWN_NO_CHECKOUT_REPORT)).toBe("request_changes");
    expect(
      classifyReviewerVerdict(
        VIBERR_OWN_NO_CHECKOUT_REPORT.replace("server-side failure", "server-side condition"),
      ),
    ).toBeNull();
  });

  it("ruling 248: an envelope that ASKED instead of judging is not re-read as a verdict", async () => {
    writeReviewTask();
    const runId = await finishedRunWith(
      "I need the pinned revision before I can judge this. The suite currently fails to run at all.",
    );
    // The agent filled the envelope, left `verdict` empty and asked a question:
    // it said which of the two it was doing.
    stageOutcome(store.db, `oc-${runId}`, {
      summary: "I need the pinned revision before I can judge this.",
      question: {
        title: "Provision checkout",
        body: "Provision a usable checkout for the pinned revision, then I can review.",
      },
    });

    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        outcomeKey: `oc-${runId}`,
      },
      { id: runId, state: "finished" },
    );

    const fm = taskFile().parsed.frontmatter;
    // CANARY: drop `&& !outcome?.question` and the word "fails" in the prose
    // becomes a blocking review verdict on a revision nobody judged. The
    // no-verdict NOTE already treats a question as a legitimate no-verdict
    // outcome (pass 24, C-4); the classifier is its sibling.
    expect(fm.verdicts).toEqual([]);
    expect(fm.validation).toBe("changed");
  });

  it("records a reviewer verdict from the FULL reply even when the verdict sits past the 1200-char comment cut (X9)", async () => {
    // A delivered revision under review + a verdict-capable reviewer, so the
    // reviewer's verdict binds to the current revision and derives validation.
    writeReviewTask();
    // 1500 chars of filler BEFORE the verdict line: the truncated comment
    // (1200 chars) never contains it — the old classifier missed it.
    const filler = "Detailed review notes follow. ".repeat(50);
    const reply = `${filler}\nVerdict: request changes — the diff violates the spec.`;
    const runId = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const fm = taskFile().parsed.frontmatter;
    expect(fm.validation).toBe("failing");
    const quality = taskFile().parsed.timeline.find((e) => e.type === "quality");
    expect(quality).toBeTruthy();
  });

  /**
   * Ruling 159 (pass 35, F35-10): an agent under an older prompt created
   * `projects/<slug>/tasks/<key>/attachments` INSIDE its repository checkout,
   * so the file never reached the task page and the person never learned why.
   * Completion scans the run's workspace for that folder and posts a warning
   * line naming it, the files it holds and the real folder. Canary: delete
   * the `warnStrayAttachmentsFolder` call (no line is posted).
   */
  it("ruling 159: a stray store-layout attachments folder inside the checkout is named on the timeline", async () => {
    writeReviewTask();
    const workdir = path.join(store.dataRoot, "projects", store.slug, "tasks", "VIB-1", "workspace", "viberr");
    const strayDir = path.join(workdir, "projects", store.slug, "tasks", "VIB-1", "attachments");
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(path.join(strayDir, "knc-9-licence-verification.txt"), "MIT, verified");
    const runId = await finishedRunWith("Attached the licence verification note.");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const warning = taskFile().parsed.timeline.find(
      (e) => e.type === "policy" && e.text.includes("store layout"),
    );
    expect(warning).toBeTruthy();
    expect(warning?.text).toContain(`\`projects/${store.slug}/tasks/VIB-1/attachments\``);
    expect(warning?.text).toContain(`\`${strayDir}\``);
    expect(warning?.text).toContain("`knc-9-licence-verification.txt`");
    expect(warning?.text).toContain("NOT posted on this task");
    // The real folder is named so the person knows where files belong.
    expect(warning?.text).toContain(
      `\`${path.join(store.dataRoot, "projects", store.slug, "tasks", "VIB-1", "attachments")}\``,
    );
    // The reply itself claims no attachment: nothing reached the real folder.
    const reply = taskFile().parsed.timeline.find((e) => e.type === "comment");
    expect(reply?.attachments).toBeUndefined();
  });

  it("ruling 159: no warning line when the workspace holds no stray folder", async () => {
    writeReviewTask();
    const runId = await finishedRunWith("Nothing stray here.");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: store.dataRoot,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    expect(taskFile().parsed.timeline.some((e) => e.text.includes("store layout"))).toBe(false);
  });

  it("ruling 105: prunes uncited browser working artifacts at completion; cited + visual stay", async () => {
    // The browser MCP's --output-dir IS the attachments store, so its aria
    // snapshots and console dumps land next to the screenshots. Completion
    // must delete the machine-stamped non-visual ones the run left UNCITED,
    // and the reply event must claim only what survives.
    writeReviewTask();
    const cited = "page-2026-08-31T15-05-03-204Z.yml";
    const uncitedSnap = "page-2026-08-31T15-05-40-487Z.yml";
    const uncitedLog = "console-2026-08-31T15-05-03-056Z.log";
    const screenshot = "page-2026-08-31T15-05-18-081Z.png";
    const runId = await finishedRunWith(
      `Verified the page in the browser; the full aria tree is in \`${cited}\`.\n` +
        "Verdict: approve — the rendering matches the spec.",
    );
    // Saved during the run window (after started_at, before completion lands).
    const dir = path.join(
      store.dataRoot,
      "projects",
      store.slug,
      "tasks",
      "VIB-1",
      "attachments",
    );
    mkdirSync(dir, { recursive: true });
    for (const name of [cited, uncitedSnap, uncitedLog, screenshot]) {
      writeFileSync(path.join(dir, name), `content of ${name}`);
    }
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    // The uncited working artifacts are gone from the canonical store…
    expect(existsSync(path.join(dir, uncitedSnap))).toBe(false);
    expect(existsSync(path.join(dir, uncitedLog))).toBe(false);
    // …the cited one and the screenshot survive…
    expect(existsSync(path.join(dir, cited))).toBe(true);
    expect(existsSync(path.join(dir, screenshot))).toBe(true);
    // …and the producing event (the verdict carries the files on a review run)
    // claims exactly the survivors — no event names a pruned file.
    const claimed = taskFile().parsed.timeline.flatMap((e) => e.attachments ?? []);
    expect(claimed).toContain(cited);
    expect(claimed).toContain(screenshot);
    expect(claimed).not.toContain(uncitedSnap);
    expect(claimed).not.toContain(uncitedLog);
  });

  it("ruling 105 review: an ERRORED run keeps its working artifacts (its only diagnostics)", async () => {
    // A crashed browsing run never got to cite anything — the citation escape
    // hatch is structurally unreachable on the failure path, so pruning there
    // deletes the console dump a human needs to diagnose the crash.
    writeReviewTask();
    const dump = "console-2026-08-31T16-00-00-000Z.log";
    const runId = await finishedRunWith("partial output before the crash");
    const dir = path.join(
      store.dataRoot,
      "projects",
      store.slug,
      "tasks",
      "VIB-1",
      "attachments",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, dump), "console output");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "error" },
    );
    expect(existsSync(path.join(dir, dump))).toBe(true);
  });

  it("ruling 105 review: no prune while a SIBLING run is live on the same task", async () => {
    // The mtime window is task-wide: a finishing run would delete a
    // still-working sibling's files before that sibling's citations exist.
    writeReviewTask();
    const siblingFile = "console-2026-08-31T16-10-00-000Z.log";
    const runId = await finishedRunWith(
      "Done reviewing.\nVerdict: approve — matches the spec.",
    );
    // A live sibling run on the same task (the shape the dedup test inserts).
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO agent_runs (id, task_key, project_slug, thread_id, role, kind,
           backend, model, state, started_at, created_at, updated_at, agent_profile_id)
         VALUES ('run_sibling', 'VIB-1', ?, 'th_sibling', 'Developer', 'primary',
           'claude', 'sonnet', 'running', ?, ?, ?, 'developer')`,
      )
      .run(store.slug, now, now, now);
    const dir = path.join(
      store.dataRoot,
      "projects",
      store.slug,
      "tasks",
      "VIB-1",
      "attachments",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, siblingFile), "the sibling's console dump");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    expect(existsSync(path.join(dir, siblingFile))).toBe(true);
  });

  it("still detects a verbatim repeat when the report tags an AMBIGUOUS name (G-A-1)", async () => {
    // The stored comment carries `withAmbiguityDisclosure`, but the no-progress
    // check compared that stored form against the RAW reply — so any repeating
    // agent whose report tagged an ambiguous handle never tripped the guard and
    // kept buying an operator run + an agent run per cycle until the depth cap.
    // Two enabled users share the first name, which is what makes "@arda"
    // ambiguous.
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.other@viberr.test",
      name: "Arda Other",
      role: "member",
    });
    writeReviewTask();
    const reply = "@arda the diff is unchanged since my last pass.";
    const effects = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude" as const,
      profileId: "reviewer",
      role: "Reviewer",
      delivers: false,
      workdir: null,
      agentHandle: "reviewer",
    };
    const first = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      effects,
      { id: first, state: "finished" },
    );
    const noProgressLog = vi.spyOn(logger, "info");
    const second = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      effects,
      { id: second, state: "finished" },
    );
    // The branch itself is the observable: with the comparison forms out of
    // sync the repeat reads as NEW work and this never logs.
    expect(
      noProgressLog.mock.calls.some(([msg]) =>
        String(msg).includes("agent made no progress"),
      ),
    ).toBe(true);
  });

  it("dispatch-completion contract: the stored report gains the missing @tags (ruling 98)", async () => {
    // A manually-dispatched run whose model forgot both tags: the pipeline
    // appends them BEFORE the reply is stored, so the timeline comment (and
    // the mention fan-out reading it) always reaches the dispatching human
    // and the operator — R20-9's guarantee-over-guidance shape.
    writeReviewTask();
    const runId = await finishedRunWith("Verdict: approve — the diff is fine.");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        dispatchedByName: "Arda Kaya",
      },
      { id: runId, state: "finished" },
    );
    const reply = taskFile().parsed.timeline.find((e) => e.type === "comment");
    expect(reply?.text).toContain("cc @Arda Kaya @operator");
  });

  it("dispatch-completion contract: a tag of a DIFFERENT person sharing the first name does NOT satisfy the contract (hunt 2026-08-29)", async () => {
    // The old check was a raw substring on "@<firstWord>": a report tagging
    // "@Arda Other" (someone else) satisfied it for dispatcher "Arda Test",
    // while the fan-out ladder delivered that tag to the OTHER person — the
    // one guaranteed ping vanished exactly when names collided. The check now
    // asks the SAME ladder "would this text notify the dispatcher's userId?".
    insertUser(store.db, {
      id: "u_arda_other",
      email: "arda.other@viberr.test",
      name: "Arda Other",
      role: "member",
    });
    writeReviewTask();
    const runId = await finishedRunWith(
      "@Arda Other done — @operator over to you. Verdict: approve.",
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        dispatchedByName: store.users.arda.name,
        dispatchedByUserId: store.users.arda.id,
      },
      { id: runId, state: "finished" },
    );
    const reply = taskFile().parsed.timeline.find((e) => e.type === "comment");
    // The dispatcher's own full-name tag is appended; @operator already stood.
    expect(reply?.text).toContain(`cc @${store.users.arda.name}`);
    expect(reply?.text).not.toContain("cc @operator");
  });

  it("dispatch-completion contract: a report that already tags both gets NO cc line", async () => {
    writeReviewTask();
    const runId = await finishedRunWith(
      "@Arda Kaya done — @operator over to you. Verdict: approve.",
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        dispatchedByName: "Arda Kaya",
      },
      { id: runId, state: "finished" },
    );
    const reply = taskFile().parsed.timeline.find((e) => e.type === "comment");
    expect(reply?.text).not.toContain("cc @");
  });

  it("dispatch-completion contract: a verbatim repeat still hands back to the operator — no no-progress skip, no stuck packet (ruling 98)", async () => {
    // The owner's "to let the operator run again" half: a dispatched run's
    // completion bypasses the new-progress heuristic. Observable as the
    // ABSENCE of both skip artifacts (the no-progress log and the stuck-loop
    // packet); with no operator deployed the react then settles harmlessly.
    writeReviewTask();
    const effects = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude" as const,
      profileId: "reviewer",
      role: "Reviewer",
      delivers: false,
      workdir: null,
      agentHandle: "reviewer",
      dispatchedByName: "Arda Kaya",
    };
    const reply = "The diff is unchanged since my last pass.";
    const first = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      effects,
      { id: first, state: "finished" },
    );
    // spyOn an already-spied method returns the SAME mock with the previous
    // test's calls still recorded — clear it so only THIS apply is judged.
    const noProgressLog = vi.spyOn(logger, "info");
    noProgressLog.mockClear();
    const second = await finishedRunWith(reply);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      effects,
      { id: second, state: "finished" },
    );
    expect(
      noProgressLog.mock.calls.some(([msg]) =>
        String(msg).includes("agent made no progress"),
      ),
    ).toBe(false);
    expect(taskFile().parsed.packet).toBeNull();
  });

  /**
   * Ruling 258 (pass 37, F37-89): a chain that stopped because the work is
   * FINISHED did not get stuck.
   *
   * Live on SHOP-32: the Integration Verifier approved `f5470f05`, both
   * required verdicts sat on the current head and validation read `healthy` —
   * and two seconds later the depth cap opened "Work stalled: pick a recovery
   * path", offering redirect, send-back and hold-for-debugging. Every option
   * re-dispatches work that had passed, and the packet then blocked the
   * acceptance it should have been waiting for: "This task has an open blocked
   * decision. Resolve the operator's packet before accepting it." The only
   * remaining doors were to redo finished work, or to force-accept past a
   * review gate that had PASSED and record a bypass that never happened.
   */
  it("ruling 325: an escalation that was REFUSED says what refused it, and that there is nothing to resolve", async () => {
    /**
     * C10.4 added this card so a task that stopped making progress never sits
     * waiting on a human with nothing explaining why. It said: "This task's
     * operator turns stopped making progress, but the recovery packet could not
     * be opened. It is waiting on a human: run the operator manually or
     * intervene, then resolve it."
     *
     * Both callers hold the reason — one has `operatorOpenPacket`'s own refusal
     * message, the other a thrown Error — and both LOG it. Neither passed it.
     * So the card that exists to explain a stuck task gave the reader back the
     * observation they had already made, and then sent them to "resolve it":
     * there is no packet, which is the entire subject of the note.
     *
     * CANARY: stop threading `why` and print the old fixed sentence.
     */
    // No operator agent is deployed on this project at all (the store's
    // default), so the packet the depth cap wants is refused for a REAL reason
    // the server can state — which is the whole point.
    writeReviewTask({ validation: "changed" });
    const runId = await finishedRunWith("Still not right; the same three files.");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        operatorRun: { backend: "claude", autonomy: "full", reactDepth: 99 },
      },
      { id: runId, state: "finished" },
    );
    await waitFor(() =>
      taskFile().parsed.timeline.some((e) => e.text.includes("stopped making progress")),
    );

    const note = taskFile().parsed.timeline.find((e) =>
      e.text.includes("stopped making progress"),
    );
    expect(note, "no card explains the stuck task").toBeTruthy();
    // No packet was opened — that is what the note is about.
    expect(taskFile().parsed.packet).toBeNull();
    // It says so, instead of sending the reader to resolve a card that is not there.
    expect(note!.text).toContain("There is no packet on this task to resolve");
    expect(note!.text).not.toContain("then resolve it");
    // And it carries the server's own reason rather than restating the symptom.
    expect(note!.text).toContain("Viberr refused it:");
    expect(note!.text.length).toBeGreaterThan(200);
    // The refusal arm's remedy is the refusal's own, not "run it again".
    expect(note!.text).toContain("Clear what the refusal names");
  });

  it("ruling 258: no stuck-loop packet when the task is acceptable — the boundary IS the boundary", async () => {
    // An operator that CAN open packets, so the absence below is a decision
    // rather than a missing grant.
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    // A task at the review boundary with its required verdict already in.
    writeReviewTask({
      validation: "healthy",
      pr: { number: 7, state: "review", title: "[VIB-1] Task VIB-1" },
    });
    const runId = await finishedRunWith("Approved. Everything in the done signal is proven.");
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (f) => {
        f.frontmatter.verdicts = [
          {
            profileId: "reviewer",
            revisionId: f.frontmatter.workRevision!.id,
            headSha: f.frontmatter.workRevision!.headSha,
            result: "approve",
            reason: "Approved.",
            at: new Date().toISOString(),
            rounds: 1,
          },
        ];
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const acceptable =
      acceptanceRefusalFor(
        { projectSlug: store.slug, taskKey: "VIB-1" },
        { dataRoot: store.dataRoot },
      ) === null;

    const skipLog = vi.spyOn(logger, "info");
    skipLog.mockClear();
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        // At the cap, which is what fired on SHOP-32.
        operatorRun: { backend: "claude", autonomy: "full", reactDepth: 99 },
      },
      { id: runId, state: "finished" },
    );
    await new Promise((r) => setTimeout(r, 80));

    // The premise of the test: this task really is acceptable, so the chain
    // reached a boundary rather than running out of road.
    expect(acceptable).toBe(true);
    // CANARY: drop the `!acceptableNow` guard and a "Work stalled: pick a
    // recovery path" packet opens here, and then BLOCKS the acceptance —
    // three options, every one of them re-running work that passed.
    expect(taskFile().parsed.packet).toBeNull();
    expect(
      skipLog.mock.calls.some(([msg]) =>
        String(msg).includes("stuck-loop packet skipped"),
      ),
    ).toBe(true);
    // And acceptance is still open, which is the whole point.
    expect(
      acceptanceRefusalFor(
        { projectSlug: store.slug, taskKey: "VIB-1" },
        { dataRoot: store.dataRoot },
      ),
    ).toBeNull();
  });

  it("records a required reviewer's verdict from the ENGAGEMENT snapshot even if its LIVE grant was removed (adversarial-review: no stuck task)", async () => {
    // The required-reviewer set (acceptanceBlockedReason) uses the engage-time
    // `verdictCapable` snapshot. If verdict RECORDING used the live grant
    // instead, a reviewer whose grant was removed/undeployed after engagement
    // could approve but never record — leaving the task un-acceptable forever
    // (no force path). Recording must use the SAME snapshot the required set
    // does, so the two never diverge.
    writeReviewTask(); // reviewer engaged with verdictCapable: true (snapshot)
    // Re-deploy `reviewer` WITHOUT the verdict grant — the live grant now says
    // OFF while the engagement snapshot still says verdict-capable.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: file.parsed.frontmatter.agents.map((a) =>
        a.profileId === "reviewer" ? { ...a, capabilities: [] } : a,
      ),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const runId = await finishedRunWith(
      "Verdict: approve\n\n@operator the change meets the spec.",
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    // The verdict was recorded (snapshot is authoritative) → the only required
    // reviewer approved the current revision → validation derives healthy →
    // acceptance is unblocked.
    const fm = taskFile().parsed.frontmatter;
    expect(fm.verdicts).toHaveLength(1);
    expect(fm.verdicts[0]).toMatchObject({ profileId: "reviewer", result: "approve" });
    expect(fm.validation).toBe("healthy");
  });

  /**
   * Ruling 204 (F37-24, live on SHOP-9). The verdict row is last-write-wins per
   * (profileId, revisionId) — F10-15's model, and right: a verdict judges a
   * revision, and the latest judgement is the one that binds. What the overwrite
   * destroyed was the COUNT of times this reviewer had blocked, which is the
   * only evidence that the deliverer could not move. Live, the Integration
   * Verifier blocked a revision, the deliverer reported it had nothing in scope
   * to change and committed nothing, and the verifier blocked the same revision
   * again: two objections, one row, and ruling 193's escalation counter read 1.
   */
  it("rulings 204 + 242: a second request_changes on the SAME revision counts a round only when the DELIVERER ran", async () => {
    writeReviewTask();
    /** Ruling 242: the deliverer took a turn. A run row is the whole signal —
     *  its state is irrelevant, because a rework that was dispatched and
     *  crashed still means a round was fought. */
    let delivererRuns = 0;
    const delivererRan = (): void => {
      delivererRuns += 1;
      upsertRun(store.db, {
        id: `run_dev_${delivererRuns}`,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId: `dev-${delivererRuns}`,
        role: "Developer",
        kind: "primary",
        backend: "claude",
        model: "sonnet",
        sdk: "claude",
        agentName: "dev",
        agentProfileId: "dev",
        state: "finished",
      });
    };
    const reviewerInput = {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude" as const,
      profileId: "reviewer",
      role: "Reviewer",
      delivers: false,
      workdir: null,
      agentHandle: "reviewer",
    };
    const review = async (reply: string) => {
      const runId = await finishedRunWith(reply);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        reviewerInput,
        { id: runId, state: "finished" },
      );
    };

    await review("Verdict: request_changes\n\n@operator the stack cannot start.");
    expect(taskFile().parsed.frontmatter.verdicts).toHaveLength(1);
    expect(taskFile().parsed.frontmatter.verdicts[0]?.rounds).toBe(1);

    // Ruling 242 (F37-69): a repeat objection with NOBODY having reworked is not
    // a second round. Live on SHOP-25 the reviewer was asked ruling 237's
    // escalation question, answered it completely, and attached a
    // `request_changes` to the same untouched revision 8 milliseconds later —
    // which took the deadlock count from 2 to 3 and re-raised the packet on top
    // of the answer a person had just paid for.
    // CANARY: drop the `reworked` term and this reads 2.
    await review("Verdict: request_changes\n\n@operator here is the complete list.");
    expect(taskFile().parsed.frontmatter.verdicts[0]?.rounds).toBe(1);

    // Ruling 204's own case, which still counts: no new revision is minted,
    // because the DELIVERER ran and reported it had nothing in scope it was
    // allowed to change. That is a round fought, and the signal is the run.
    // CANARY: read `finished` runs only, or key on the revision again, and the
    // deadlock ruling 237 escalates on goes back to sitting flat forever.
    delivererRan();
    await review("Verdict: request_changes\n\n@operator the stack still cannot start.");
    const blocked = taskFile().parsed.frontmatter.verdicts;
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.rounds).toBe(2);
    expect(blocked[0]?.result).toBe("request_changes");

    // A DIFFERENT result is a fresh position, not another round of the same one.
    await review("Verdict: approve\n\n@operator the blocker is gone.");
    const approved = taskFile().parsed.frontmatter.verdicts;
    expect(approved).toHaveLength(1);
    expect(approved[0]?.result).toBe("approve");
    expect(approved[0]?.rounds).toBe(1);
  });

  it("F37-64: a Codex-envelope question reaches the inbox under the AGENT's name, not the Operator's", async () => {
    // Ruling 222 fixed the CLAUDE `ask_human` door in agent-toolkit.server.ts
    // and left this one, the Codex outcome envelope, which copies its title
    // format and never set `from` — so `notifyTaskWatchers` stamped
    // OPERATOR_NOTIFY_FROM over it. Live on SHOP-5: title "Infrastructure
    // Engineer asks: Gateway route proof", sender Operator, on a packet whose
    // own `from` named the engineer.
    // CANARY: drop the `askNotice.from` block.
    writeReviewTask();
    // The Codex door reads a JSON outcome envelope out of the reply text, so
    // the question has to arrive that way rather than as prose.
    const runId = await finishedRunWith(
      JSON.stringify({
        summary: "Blocked on a decision.",
        question: {
          title: "Gateway route proof",
          body: "Should the scoped trace be accepted, or should validation wait for the route?",
        },
      }),
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        // The envelope door is Codex-only: `parseAgentOutcomeJson` runs behind
        // `input.backend === "codex"`.
        backend: "codex",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    expect(taskFile().parsed.packet?.kind).toBe("Agent question");
    // SAFETY: `actor_json` is TEXT on `notifications`, written by
    // `createNotification` from an `ActorRender`.
    // SAFETY: `title` is nullable TEXT and `actor_json` TEXT NOT NULL on
    // `notifications`; the rows were written by `createNotification` above.
    const rows = store.db
      .prepare(
        `SELECT title, actor_json FROM notifications WHERE kind = 'approval' AND task_key = 'VIB-1'`,
      )
      .all() as { title: string | null; actor_json: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // SAFETY: `createNotification` serialises an `ActorRender`, and every
      // variant of that union carries `kind` and `name`.
      const from = JSON.parse(r.actor_json) as { kind: string; name: string };
      expect(from.name).not.toBe("Operator");
      expect(from).toMatchObject({
        kind: "agent",
        backend: "codex",
        name: "Review & validation",
      });
    }
  });

  /**
   * Ruling 237 (F37-57, live on SHOP-5). Ruling 210 held that a second
   * consecutive objection from one reviewer is the point to stop reworking and
   * ask, ruling 204 gave it a counter that reads the deadlock correctly, and
   * both were spent on a paragraph in the operator's prompt. Live, the operator
   * read the paragraph, took the third `request_changes`, and had the deliverer
   * running again 62 seconds later with no question put to anyone.
   *
   * The owner's remedy was to escalate rather than gate: the operator keeps
   * every move, and the second objection reaches a person by itself.
   */
  describe("ruling 237: the second consecutive objection escalates to a person", () => {
    const reviewerInput = (profileId: string) => ({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      backend: "claude" as const,
      profileId,
      role: "Review & validation",
      delivers: false,
      workdir: null,
      agentHandle: profileId,
    });
    /**
     * Ruling 242: a round is a round only if the DELIVERER RAN. A real deadlock
     * has the deliverer going back in between objections and coming out with
     * nothing it is allowed to change — SHOP-5, SHOP-6 and SHOP-10 all did — so
     * each review here is preceded by the rework it is objecting to. Without
     * this the fixture models the one case ruling 242 says is NOT a deadlock: a
     * reviewer repeating itself with nobody having touched the work.
     */
    let delivererRuns = 0;
    const rework = (): void => {
      delivererRuns += 1;
      upsertRun(store.db, {
        id: `run_rework_${delivererRuns}`,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId: `rework-${delivererRuns}`,
        role: "Developer",
        kind: "primary",
        backend: "claude",
        model: "sonnet",
        sdk: "claude",
        agentName: "dev",
        agentProfileId: "dev",
        state: "finished",
      });
    };
    const review = async (
      reply: string,
      profileId = "reviewer",
      extra: { dispatchedByName?: string } = {},
    ) => {
      rework();
      const runId = await finishedRunWith(reply);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        { ...reviewerInput(profileId), ...extra },
        { id: runId, state: "finished" },
      );
    };
    const blocks = (n: number) =>
      `Verdict: request_changes\n\n@operator objection number ${n}.`;

    it("opens the packet on the second, not the first", async () => {
      writeReviewTask();

      await review(blocks(1));
      // CANARY: drop `rounds < REVIEW_DEADLOCK_ROUNDS` from `reviewDeadlockOf`
      // and this is a packet on ordinary first-round review feedback, which
      // would pause coordination on every task that ever got a note.
      expect(taskFile().parsed.packet).toBeNull();

      await review(blocks(2));
      const packet = taskFile().parsed.packet;
      // CANARY: delete the `openReviewDeadlockPacket` call in
      // `recordAgentCompletion` and this is null — the exact state SHOP-5 sat
      // in for four rounds.
      expect(packet).not.toBeNull();
      expect(packet?.title).toContain("requested changes 2 times running");
      expect(packet?.body).toContain("@reviewer");
      // The deliverer is named, so the person reading the card knows who has
      // been reworking against it.
      expect(packet?.body).toContain("@dev");
      expect(packet?.options.map((o) => o.kind)).toEqual([
        "question_reviewer",
        "custom",
        "force_accept",
      ]);
      // The recommended option is the one that puts the question, and it names
      // the reviewer it will actually start.
      const recommended = packet?.options.find((o) => o.rec);
      expect(recommended?.kind).toBe("question_reviewer");
      expect(recommended?.profileId).toBe("reviewer");
      // `input`, not `blocked`: nothing failed, so readiness must not read
      // blocked over a review that is working and disagreeing.
      expect(packet?.type).toBe("input");
      expect(taskFile().parsed.frontmatter.readiness).not.toBe("blocked");
      expect(taskFile().parsed.frontmatter.waiting).toBe("human");
    });

    it("counts per reviewer: one objection each from two reviewers is not a deadlock", async () => {
      writeReviewTask({
        engagements: [
          DEV_DELIVERS_ENGAGEMENT,
          REVIEWER_ENGAGEMENT,
          {
            profileId: "second",
            backend: "claude",
            role: "Review & validation",
            delivers: false,
            verdictCapable: true,
          },
        ],
      });

      await review(blocks(1), "reviewer");
      await review(blocks(1), "second");

      // Two objections on the task, one each. Nobody has outlived a rework, and
      // the owner's threshold is explicitly per reviewer.
      // CANARY: count `fm.verdicts` instead of this reviewer's own rows and
      // this opens a packet the moment any two reviewers disagree once.
      expect(taskFile().parsed.frontmatter.verdicts).toHaveLength(2);
      expect(taskFile().parsed.packet).toBeNull();
    });

    it("resets on that reviewer's own approve", async () => {
      writeReviewTask();

      await review(blocks(1));
      await review("Verdict: approve\n\n@operator the blocker is gone.");
      expect(taskFile().parsed.packet).toBeNull();

      // A fresh objection after an approve is a FIRST objection again.
      // CANARY: count every `request_changes` in the reviewer's history rather
      // than stopping at its first approve, and this reads 2.
      await review(blocks(2));
      expect(taskFile().parsed.packet).toBeNull();
    });

    it("its recommended option starts the REVIEWER with the question, and nobody else", async () => {
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      const packet = taskFile().parsed.packet!;
      expect(packet.options[0]?.kind).toBe("question_reviewer");

      queueFakeRun({
        lines: [
          { t: "", ev: "init", tag: "system·init", text: "test session" },
          { t: "", ev: "text", tag: "assistant", text: "Here is the full list." },
          { t: "", ev: "result", tag: "result", text: "done" },
        ],
        occurredAt: [
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
        sessionId: "t-question",
      });
      // SAFETY: COUNT(*) over a table this store owns is always an integer.
      const runCount = () =>
        (
          store.db
            .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE project_slug = ?`)
            .get(store.slug) as { n: number }
        ).n;
      const before = runCount();
      const { resolvePacket } = await import("./task-actions.server");
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );

      // SAFETY: `agent_profile_id` is TEXT on `agent_runs`, and the row exists
      // because the resolution above started it.
      const started = store.db
        .prepare(
          `SELECT agent_profile_id AS pid, verdict_withheld AS withheld FROM agent_runs
           WHERE project_slug = ? AND kind <> 'operator'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(store.slug) as { pid: string; withheld: number };
      // CANARY: remove the dispatch block and this stays flat — the packet
      // would close having promised a run nobody started.
      expect(runCount()).toBe(before + 1);
      // What the dispatch actually SENT the runtime, not what the timeline
      // narrates about it.
      const { lastRunSpec } = await import("../../../test-support/fake-runtime");
      const directive = lastRunSpec()?.prompt ?? "";
      // CANARY: drop `profileId: option.profileId` from the question_reviewer
      // dispatch and this starts the DELIVERER — with a prompt telling it not
      // to review, on a task whose card promised the reviewer would answer.
      expect(started.pid).toBe("reviewer");
      expect(directive).toContain("name EVERYTHING you would still block on");
      expect(directive).toContain("do NOT return a verdict");

      /**
       * Ruling 313. That sentence used to be the ONLY thing standing between
       * this run and another verdict, and the same prompt contradicted it:
       * `collab.verdict` comes from the PROFILE's grant, so the collaboration
       * notes also told the reviewer "`report_outcome` — REQUIRED at the end of
       * your review: report `approve` or `request_changes`". One prompt, both
       * instructions, and only one of them backed by a tool.
       *
       * Live on SHOP-76 the reviewer did exactly what the tool-backed half said.
       * The verdict bound to the same revision, counted as the next consecutive
       * objection, and the deadlock packet re-raised at the SAME round count —
       * so the person answered the identical question twice, having taken the
       * option the card recommended both times. `review-deadlock.server.ts`
       * predicted it in its own words ("a verdict here would bind to the same
       * revision and count as another objection, which is the loop") and its
       * header names the construction as the one ruling 186 refused: a request
       * in a prompt, with nothing that notices when the model does something
       * else.
       *
       * CANARY: drop `withholdVerdict: true` from the question_reviewer
       * dispatch and the REQUIRED line comes back, in the same prompt as the
       * sentence forbidding it.
       */
      expect(directive).not.toContain("REQUIRED at the end of your review");
      expect(directive).not.toContain("report `approve` or `request_changes`");

      // The ENGAGEMENT is untouched: withholding is per-run, so the reviewer is
      // still verdict-capable and acceptance still waits for its approve. A fix
      // that quietly demoted the reviewer would unblock the task by removing the
      // gate, which is not what the person asked for.
      const engaged = taskFile().parsed.frontmatter.engagements.find(
        (e) => e.profileId === "reviewer",
      );
      expect(engaged?.verdictCapable).toBe(true);

      // Ruling 316: and the RUN remembers it, because the prompt is not the
      // only thing that has to honour the withholding — the completion path
      // reads this row to tell an answer from a silence, long after the
      // dispatch is gone. CANARY: stop persisting `verdictWithheld` at run
      // creation and the fallback manufactures the verdict anyway.
      expect(started.withheld).toBe(1);

      expect(taskFile().parsed.packet).toBeNull();
      expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
    });

    /**
     * Ruling 316. Ruling 313 withheld the verdict TOOL on the deadlock question
     * and closed nothing, because the prose fallback manufactures a verdict
     * from the reply regardless: `verdictAuthorized` reads the ENGAGEMENT
     * snapshot, which 313 deliberately left intact.
     *
     * Live on SHOP-68 the reviewer said so in words and viberr wrote the
     * verdict under its name 70ms later: "No verdict recorded — the directive
     * said not to... I deliberately skipped `report_outcome` rather than
     * omitting it. (Note: last turn the system appears to have derived a
     * `request_changes` entry from my comment anyway; I can't control that, but
     * nothing new was authored by me.)" The packet re-raised each time and the
     * person answered the same question three times.
     *
     * The classifier's rule 3 is why: any un-negated "fail"/"blocker" is a
     * request_changes, so on SHOP-76 it fired on "the five prettier-failing
     * markdown files fail identically on the base commit" — a sentence whose
     * whole point is that the failure is NOT a finding.
     */
    /**
     * Ruling 317. The stored `verdicts[].reason` is a 2,000-character clip whose
     * own marker says "Its full report is on this task's timeline, whole"
     * (ruling 292) — and compaction folded that comment away, because the two
     * fields protecting a comment (`evidence`, `attachments`) are moved OFF the
     * reply precisely when it carries a verdict. The title is what compaction
     * reads instead.
     */
    it("ruling 317: the verdict's reply comment is TITLED, so compaction can spare it", async () => {
      writeReviewTask();
      await review(blocks(1));
      const { VERDICT_REPORT_TITLE } = await import("~/schemas/task-file.schema");
      const reply = taskFile()
        .parsed.timeline.find((e) => e.type === "comment" && e.actor.kind === "agent");
      // CANARY: stop setting the title on the verdict path and the comment the
      // stored record points at becomes indistinguishable from chatter.
      expect(reply?.title).toBe(VERDICT_REPORT_TITLE);
      // The inversion this replaces: evidence was moved off it, so the clauses
      // that protect every other agent comment do not apply here.
      expect(reply?.evidence ?? null).toBeNull();
    });

    it("ruling 316: a run whose verdict channel was withheld gets no prose verdict", async () => {
      writeReviewTask();
      await review(blocks(1));
      const genuine = taskFile().parsed.frontmatter.verdicts.at(-1);
      expect(genuine?.result).toBe("request_changes");
      // The reviewer's REAL findings for this revision. A fabricated verdict
      // does not add a row — it REPLACES this one (last write wins per
      // profileId + revisionId), so the count never moves and the reviewer's
      // actual reasons are what disappears.
      expect(genuine?.reason).toContain("objection number 1");

      // Exactly the shape that trips the classifier's rule 3 while saying the
      // OPPOSITE — an un-negated "fail"/"blocker" inside a sentence whose point
      // is that the failure is pre-existing and therefore not a finding. This
      // is the SHOP-76 sentence.
      const answer =
        "No verdict recorded - the directive said not to return one. " +
        "The five prettier-failing markdown files fail identically on the base commit, " +
        "so that is not a blocker I would raise.";
      const { classifyReviewerVerdict } = await import("./task-actions.server");
      // The classifier really does read this as an objection; the guard is what
      // stops it, not a kinder regex.
      expect(classifyReviewerVerdict(answer)).toBe("request_changes");

      rework();
      const quiet = await finishedRunWith(answer);
      // The deadlock question's run: dispatched with its verdict channel taken
      // away (ruling 313), which ruling 316 makes the completion path honour.
      const { patchRun } = await import("~/server/runtimes/run-store.server");
      patchRun(store.db, quiet, { verdictWithheld: true });
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        reviewerInput("reviewer"),
        { id: quiet, state: "finished" },
      );

      /**
       * CANARY: drop `verdictSilenced` from the fallback guard and the
       * reviewer's real findings are replaced by a verdict it did not author.
       */
      expect(taskFile().parsed.frontmatter.verdicts.at(-1)?.reason).toContain(
        "objection number 1",
      );

      // And the rest of the path WOULD have done it: the identical completion
      // on a run whose channel was NOT withheld overwrites the genuine record.
      rework();
      const loud = await finishedRunWith(answer);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        reviewerInput("reviewer"),
        { id: loud, state: "finished" },
      );
      const overwritten = taskFile().parsed.frontmatter.verdicts.at(-1);
      expect(overwritten?.result).toBe("request_changes");
      expect(overwritten?.reason).not.toContain("objection number 1");
    });

    /**
     * Ruling 315. The note on a decision packet was sliced to 2,000 characters
     * in `project.task.tsx` before the request reached the server — no
     * `maxLength` on the box, no counter, no marker on the record, no error,
     * and nothing anywhere holding the tail.
     *
     * Live on SHOP-76 a 4,454-character decision was stored at exactly 2,000,
     * ending mid-word at "`docs/adr/README.md` is this branch's own rule and it
     * says the record t", and a rework round ran on the operator's
     * reconstruction of the deleted sentence. The card had promised the
     * opposite: "anything you type below is recorded on the task's contract and
     * every later run reads it".
     *
     * Ruling 292 permitted a cut on a VERDICT because "the full text is never
     * lost — the agent's own report is on the same timeline, untruncated". A
     * person's typed note has no second copy, so the identical cut is loss.
     */
    it("ruling 315: a long note is recorded WHOLE, not cut at 2,000", async () => {
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      const { resolvePacket } = await import("./task-actions.server");
      // Longer than the old silent cap, shorter than the refusal — the exact
      // band SHOP-76's decision fell into.
      const long = `HEAD ${"x".repeat(2600)} TAIL`;
      expect(long.length).toBeGreaterThan(2000);
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1, note: long },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      const recorded = taskFile()
        .parsed.timeline.map((e) => e.text)
        .join("\n");
      // CANARY: restore the route's `.slice(0, 2000)` and TAIL is gone while
      // HEAD stays — the shape that makes this invisible to the person who
      // wrote it.
      expect(recorded).toContain("TAIL");
      expect(recorded).toContain("HEAD");
    });

    it("ruling 315: a note past the shared cap is REFUSED, and nothing is written", async () => {
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      const { resolvePacket } = await import("./task-actions.server");
      const { PACKET_NOTE_MAX } = await import("~/schemas/task-file.schema");
      const before = taskFile().parsed.timeline.length;
      await expect(
        resolvePacket(
          store.db,
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            optionIndex: 1,
            note: "y".repeat(PACKET_NOTE_MAX + 1),
          },
          actor(store.users.arda),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toThrow(/too long/);
      // Refusing and then writing half of it would be the same defect wearing a
      // message. The packet is still open and the timeline did not move.
      expect(taskFile().parsed.packet).not.toBeNull();
      expect(taskFile().parsed.timeline.length).toBe(before);
    });

    /**
     * Ruling 241 (F37-68). Live on SHOP-5 this exact resolution ran on a HELD
     * task: ruling 186 refuses every agent dispatch while a task waits, and
     * this arm found that out only after writing the decision onto the task
     * contract and clearing the packet. The person's chosen option did nothing,
     * and there was no packet left to choose again from.
     *
     * The owner's call was to queue rather than refuse.
     */
    it("ruling 241: on a HELD task the question is queued, not lost and not dispatched", async () => {
      writeReviewTask({ blockedBy: ["VIB-9"] });
      await review(blocks(1));
      await review(blocks(2));
      const packet = taskFile().parsed.packet!;
      expect(packet.options[0]?.kind).toBe("question_reviewer");
      // Said BEFORE the choice. CANARY: drop `heldBy` from the packet build and
      // the card promises a question it cannot put.
      expect(packet.options[0]?.d).toContain("VIB-1 waits on VIB-9");
      expect(packet.options[0]?.d).toContain("put the moment the wait clears");

      // SAFETY: COUNT(*) over a table this store owns is always an integer.
      const runCount = () =>
        (
          store.db
            .prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE project_slug = ?`)
            .get(store.slug) as { n: number }
        ).n;
      const before = runCount();
      const { resolvePacket } = await import("./task-actions.server");
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );

      const fm = taskFile().parsed.frontmatter;
      // CANARY: delete the queue write and the person's decision buys nothing —
      // which is the state this shipped in.
      expect(fm.queuedQuestions).toHaveLength(1);
      expect(fm.queuedQuestions[0]).toMatchObject({
        profileId: "reviewer",
        decidedByLabel: store.users.arda.email,
        heldBy: ["VIB-9"],
      });
      expect(fm.queuedQuestions[0]!.directive).toContain(
        "name EVERYTHING you would still block on",
      );
      // Nothing was dispatched: ruling 186 would have refused it, and a run
      // that never started must not be claimed. CANARY: drop the queued check
      // from the dispatch guard and this fires the refused run.
      expect(runCount()).toBe(before);
      expect(fm.waiting).toBe("human");
      expect(taskFile().parsed.packet).toBeNull();
      const decision = taskFile().parsed.timeline.find((e) => e.type === "transition")!;
      expect(decision.text).toContain("queued with the task");
      expect(decision.text).toContain("VIB-9");
    });

    it("does NOT hand the task back to the operator on the completion that raised it", async () => {
      // The packet says "Coordination is paused until you say which", and the
      // react at the end of this very completion is an `agent-reply` trigger —
      // which ruling 195 records as deliberately NOT refused by an open packet.
      // Left alone, the operator gets a turn seconds after the packet opens and
      // can do the exact re-dispatch the packet exists to interrupt, while the
      // card tells a person nothing is moving.
      // CANARY: delete the `raisedDeadlockPacket` arm and the operator runs.
      deployOperator();
      const operatorRuns = () =>
        // SAFETY: COUNT(*) over this store's own table is always an integer.
        (
          store.db
            .prepare(
              `SELECT COUNT(*) AS n FROM agent_runs WHERE project_slug = ? AND kind = 'operator'`,
            )
            .get(store.slug) as { n: number }
        ).n;
      writeReviewTask();
      await review(blocks(1));
      const before = operatorRuns();

      await review(blocks(2), "reviewer", { dispatchedByName: "operator" });
      expect(taskFile().parsed.packet).not.toBeNull();
      expect(operatorRuns()).toBe(before);
      // The task is on a person, which is what the card claims.
      expect(taskFile().parsed.frontmatter.waiting).toBe("human");
    });

    it("the note sits ABOVE the verdict that caused it, newest-first", async () => {
      // The timeline is newest-first in the file, and viberr runs a
      // `timeline.out_of_order` diagnostic over it. The reply comment carries
      // the timestamp it was PREPARED with, which predates anything stamped
      // during this write — so unshifting the escalation note inside the
      // verdict block put a note 5ms newer than the reviewer's comment BELOW
      // it. Live on SHOP-24 within the hour of shipping, and the diagnostic
      // found it, not me.
      // CANARY: move the unshift back into the verdict block.
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));

      const timeline = taskFile().parsed.timeline;
      const noteAt = timeline.findIndex((e) => e.text.startsWith("**Decision packet:**"));
      const verdictAt = timeline.findIndex((e) => e.type === "quality");
      expect(noteAt).toBeGreaterThanOrEqual(0);
      expect(verdictAt).toBeGreaterThan(noteAt);
      // And the file is strictly newest-first, which is what the diagnostic reads.
      const inversions = timeline.filter(
        (e, i) => i > 0 && e.occurredAt > timeline[i - 1]!.occurredAt,
      );
      expect(inversions).toEqual([]);
    });

    it("the card's copy matches the mechanisms it names: authority, the goal, and the real door", async () => {
      // Four claims in this packet were wrong when it shipped, all of the same
      // kind: copy that named a mechanism without checking it. An adversarial
      // sweep found them hours later.
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      const packet = taskFile().parsed.packet!;
      const opt = (kind: string) => packet.options.find((o) => o.kind === kind)!;

      // 1. force-accept-completion is roles: [A] in app/shared/rbac.ts. The RBAC
      // probe this pass measured it live: maintainer gets 403 "Your project role
      // (maintainer) cannot force-accept past the review gate".
      // CANARY: put "maintainer" back into the force_accept detail.
      // Read from the RBAC table itself, so the copy cannot drift from the
      // grant it describes without this failing.
      const { rolesForAction } = await import("~/shared/rbac");
      const forceRoles = rolesForAction("force-accept-completion");
      expect(forceRoles).toEqual(["admin"]);
      expect(opt("force_accept").d).toContain("Admin only");
      expect(opt("force_accept").d).not.toMatch(/Admin or maintainer/);

      // 2. `custom` is NOT in PROCESS_ONLY_OPTION_KINDS, so a typed note is
      // appended to the task's goal as binding contract (ruling 189). The
      // option used to promise "nothing changed".
      // CANARY: restore "with nothing changed".
      expect(opt("custom").d).not.toMatch(/nothing changed/);
      expect(opt("custom").d).toContain("recorded on the task's contract");

      // 3. `deriveValidation` derives from the task's verdict-capable
      // ENGAGEMENTS, not from the project's required-reviewer rules — so the
      // body used to send a stuck human to a settings page that cannot unblock
      // the task it is on. CANARY: restore "in project settings".
      expect(packet.body).toContain("not in project settings");
      expect(packet.body).toContain("Remove the engagement here");
    });

    it("the inbox says the POLICY ENGINE raised it, not the Operator", async () => {
      // `notifyTaskWatchers` stamps OPERATOR_NOTIFY_FROM on any notice that
      // names nobody, so shipping without a `from` told every watcher the
      // Operator raised this — while the card beside it reads
      // `from: policy-engine` and the whole ruling rests on it not being the
      // operator's judgement.
      // CANARY: drop the `from` from the notifyTaskWatchers call.
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      // SAFETY: `actor_json` is TEXT on `notifications`; the packet rows were
      // just written by the escalation above.
      const rows = store.db
        .prepare(
          `SELECT actor_json FROM notifications WHERE kind = 'packet' AND task_key = 'VIB-1'`,
        )
        .all() as { actor_json: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        // SAFETY: `actor_json` is written by `createNotification` from an
        // `ActorRender`, every variant of which carries `kind` and `name`.
        const from = JSON.parse(r.actor_json) as { kind: string; name: string };
        expect(from).toEqual({ kind: "system", name: "Policy engine" });
      }
    });

    it("ruling 177: no packet on a task that CLOSED while the reviewer was running", async () => {
      // A reviewer run that finishes after its task was accepted still records
      // its verdict — evidence is evidence, and ruling 177 says so — but no
      // coordination follows it. An escalation asking a person to decide
      // something about a shipped task is exactly the packet ruling 177
      // refused, and `operatorOpenPacket` would have refused it by name.
      // CANARY: drop the `taskClosure(...).closed` clause from the escalation
      // guard and this opens a decision packet on a Done task.
      writeReviewTask();
      await review(blocks(1));
      expect(taskFile().parsed.packet).toBeNull();
      await updateTaskFile(
        { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
        (parsed) => {
          parsed.frontmatter.stage = "done";
        },
      );

      await review(blocks(2));
      expect(taskFile().parsed.packet).toBeNull();
      // The verdict itself still lands: closing the task does not erase what a
      // reviewer found.
      expect(taskFile().parsed.frontmatter.verdicts[0]?.rounds).toBe(2);
    });

    it("ruling 137: no acceptance offer survives beside the packet", async () => {
      // A packet pauses coordination, so an offer to accept must not stand
      // beside it — least of all one the verdict in the same write just made
      // impossible. This packet needs no withdrawal code of its own: a
      // `request_changes` always derives `validation: "failing"`, and the
      // verdict block's own filter drops every `accept_completion` card. The
      // test is here because that is a COUPLING, not an obvious property, and
      // the day it changes this packet starts shipping beside a live Accept
      // button. CANARY: drop `r.kind !== "accept_completion"` from the
      // recommendation filter.
      writeReviewTask({
        recommendations: [
          {
            id: "rec_accept",
            kind: "accept_completion",
            label: "Accept the completion",
            detail: "Recorded by Viberr when the delivery landed.",
          },
        ],
      });

      await review(blocks(1));
      await review(blocks(2));
      expect(taskFile().parsed.packet).not.toBeNull();
      expect(
        taskFile().parsed.frontmatter.recommendations.map((r) => r.id),
      ).not.toContain("rec_accept");
    });

    it("never clobbers a packet that is already open", async () => {
      writeReviewTask();
      await review(blocks(1));
      await updateTaskFile(
        { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
        (parsed) => {
          parsed.packet = {
            id: "pkt_existing",
            type: "input",
            kind: "Decision required",
            from: "operator",
            title: "Something else entirely",
            body: "",
            observations: [],
            options: [{ kind: "custom", t: "Carry on", d: "", rec: true }],
          };
        },
      );

      await review(blocks(2));
      // One packet slot per task. The verdict itself still records — it is the
      // record, and the escalation is only the thing on top of it.
      expect(taskFile().parsed.packet?.title).toBe("Something else entirely");
      expect(taskFile().parsed.frontmatter.verdicts[0]?.rounds).toBe(2);
    });
  });

  /**
   * R15-7 (owner ruling): a run whose profile cannot be resolved is fully
   * conservative. The RUN layer withholds its toolkit, but completion re-derived
   * the gates from `[]`, which the catalog defaults read as comment/ask/evidence
   * GRANTED — so the same ghost profile's envelope could still open a question
   * packet and assert evidence rows in a vanished profile's name, one layer
   * later and out of sight.
   */
  it("ruling 137: the envelope's question packet withdraws the standing acceptance offer on the record", async () => {
    // Canary: drop the withdrawal at the envelope-question site in
    // recordAgentCompletion and the accept card outlives the question.
    writeReviewTask({
      recommendations: [
        { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-1 to Done", detail: "", forHeadSha: "a".repeat(40) },
        { id: "r-run", kind: "run_agent", profileId: "dev", label: "Run dev", detail: "" },
      ],
    });
    const runId = await finishedRunWith(
      JSON.stringify({
        summary: "Reviewed the change; one thing is unclear.",
        question: { title: "Which API surface should this use?", body: "Two candidates." },
      }),
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "dev",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.packet?.title).toBe("Which API surface should this use?");
    expect(parsed.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-run"]);
    const note = parsed.timeline.find((e) => e.type === "note" && e.title === "Recommendation withdrawn");
    expect(note?.actor).toMatchObject({ kind: "agent", profileId: "dev" });
    expect(note?.text).toContain('a decision packet opened ("Which API surface should this use?")');
    const rows = listAuditEvents(store.db, { action: "task.recommendation.withdrawn" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorLabel).toContain("agent:codex/dev");
    expect(rows[0]!.details).toMatchObject({ cause: "packet", surviving: 1 });
  });

  it("R15-7: an UNRESOLVABLE profile's finished run opens no question packet and asserts no evidence", async () => {
    const runId = await finishedRunWith(
      JSON.stringify({
        summary: "Reviewed the change; one thing is unclear.",
        question: {
          title: "Which API surface should this use?",
          body: "Two candidates.",
        },
        evidence: [{ label: "unit suite", add: 12, del: 0 }],
      }),
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        // The Codex transport: the envelope rides the final reply text.
        backend: "codex",
        // Never deployed here — `resolveDeployedSpecialist` throws for it.
        profileId: "ghost-profile",
        role: "Reviewer",
        delivers: false,
        workdir: null,
        agentHandle: "ghost-profile",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.packet, "a ghost profile must not open a decision").toBeNull();
    expect(
      parsed.timeline.some((e) => e.text.includes("Question for a human")),
    ).toBe(false);
    const reply = parsed.timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "agent",
    )!;
    // Its report still lands (the run happened); the ASSERTIONS it carries do not.
    expect(reply.text).toContain("one thing is unclear");
    expect(reply.evidence ?? []).toHaveLength(0);
  });

  it("posts the reviewer's OWN reply comment atomically with the verdict — pass AND fail", async () => {
    // Regression (VIB-1…4, docker): the reviewer's reply comment used to be a
    // separate earlier write that the verdict's read-modify-write erased on the
    // VirtioFS mount, so only the operator's derived verdict event survived and
    // the reviewer never "spoke" on the timeline. Now they're ONE write.
    for (const [reply, wantValidation] of [
      ["Verdict: approve\n\n@operator the inventory is complete and accurate.", "healthy"],
      ["Verdict: request changes\n\n@operator six symlinks are missing.", "failing"],
    ] as const) {
      // fresh review-state task each iteration (delivered revision + reviewer)
      writeReviewTask();
      const runId = await finishedRunWith(reply);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "VIB-1", backend: "claude", profileId: "reviewer", role: "Reviewer", delivers: false, workdir: null, agentHandle: "reviewer" },
        { id: runId, state: "finished" },
      );
      const tl = taskFile().parsed.timeline;
      const reviewerComment = tl.find(
        (e) => e.type === "comment" && e.actor.kind === "agent" && e.actor.roleHint === "Reviewer",
      );
      const quality = tl.find((e) => e.type === "quality");
      expect(reviewerComment, `reviewer reply must be posted (${wantValidation})`).toBeTruthy();
      expect(reviewerComment!.text).toContain("@operator");
      expect(quality).toBeTruthy();
      expect(taskFile().parsed.frontmatter.validation).toBe(wantValidation);
    }
  });

  it("the reviewer's reply survives a following stale-read write (VirtioFS read-after-write loss)", async () => {
    // The VIB-1 incident, end to end: the reviewer completion posts its reply
    // comment + verdict, then an operator-style read-modify-write reacts
    // seconds later while the bind mount still serves the PRE-completion file
    // content. Before the canonical cache, that second write's stale base
    // erased the reviewer's comment permanently.
    writeReviewTask({ title: "Reviewer completion then a stale-read write" });
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    const absPath = resolveTaskFilePath(ref);
    const preCompletion = readFileSync(absPath, "utf8");

    const runId = await finishedRunWith(
      "Verdict: approve\n\n@operator the inventory is verified — ship it.",
    );
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", backend: "claude", profileId: "reviewer", role: "Reviewer", delivers: false, workdir: null, agentHandle: "reviewer" },
      { id: runId, state: "finished" },
    );

    // VirtioFS serves the PRE-completion content to the next reader: revert
    // the on-disk file (the completion's write "hasn't landed" for readers).
    // B06-T3 (pass 32): a stale cache serves the OLD mtime too, so set it —
    // without this the simulation was "old content, NEW mtime", which the
    // write-cache repair correctly reads as an external edit (disk wins)
    // whenever the completion's bookkeeping took longer than the 100 ms mtime
    // slack. That is the intermittent CI red this test had: not a data-loss
    // race, an unfaithful simulation. task-writer.server.test.ts does the same.
    writeFileSync(absPath, preCompletion);
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(absPath, past, past);

    // The operator reacts — a locked read-modify-write appending its comment.
    const operatorComment: TaskFileEvent = {
      occurredAt: new Date().toISOString(),
      type: "comment",
      actor: { kind: "operator" },
      title: "Recommendation",
      text: "Recommendation: accept — reviewer approved.",
      toAgent: false,
      evidence: null,
    };
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(operatorComment);
    });

    const tl = taskFile().parsed.timeline;
    const reviewerComment = tl.find(
      (e) => e.type === "comment" && e.actor.kind === "agent" && e.actor.roleHint === "Reviewer",
    );
    expect(reviewerComment, "reviewer reply must survive the stale-read write").toBeTruthy();
    expect(reviewerComment!.text).toContain("@operator the inventory is verified");
    expect(tl.some((e) => e.type === "quality")).toBe(true);
    expect(tl.some((e) => e.text?.includes("Recommendation: accept"))).toBe(true);

    // And the canonical FILE was repaired by the operator's write — the
    // reviewer's comment persists on disk, not just in memory.
    const disk = readFileSync(absPath, "utf8");
    expect(disk).toContain("@operator the inventory is verified");
    expect(disk).toContain("Recommendation: accept");
  });

  it("posts the reply comment and flips waiting agent→human when no operator is deployed", async () => {
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    const runId = await finishedRunWith("All done — summary of the work.");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "developer",
        role: "developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(
      parsed.timeline.some(
        (e) => e.type === "comment" && e.actor.kind === "agent",
      ),
    ).toBe(true);
    // No operator deployed in this project → the chain ends and the task must
    // NOT read "agent working" forever.
    expect(parsed.frontmatter.waiting).toBe("human");
  });

  it("surfaces a FAILED run as a typed blocked event + recovery packet, not silence (F8)", async () => {
    // A run that ends in `error` (e.g. a Codex quota exhaustion) used to leave no
    // trace on the timeline and revert waiting=human silently. Now it must post a
    // blocked event naming the reason and open a recovery packet.
    // Deploy an operator (with generate-packets) alongside the dev — every active
    // task has one, and it's what opens the recovery packet on a failed run.
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // Build the errored run synchronously so the
    // test is deterministic — a real async run's lifecycle raced CI's slower
    // SQLite (the "database connection is not open" flood) and intermittently
    // dropped the watcher notification. Here the run row + its error log line
    // exist before applyAgentCompletionEffects reads them.
    const runId = "run_f8_probe";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-f8",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "codex",
      model: "gpt-5.5",
      sdk: "codex",
      state: "error",
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-07-12T10:00:00.000Z",
      raw: JSON.stringify({ ev: "err", tag: "turn.failed" }),
      display: {
        t: "10:00:00",
        ev: "err",
        tag: "turn.failed",
        text: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
      },
    });
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "developer",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "error" },
    );
    const parsed = taskFile().parsed;
    // The typed failure event naming the reason (distinct from the operator's
    // packet event that also lands).
    const failureEvent = parsed.timeline.find(
      (e) => e.type === "blocked" && /did not complete/.test(e.text),
    );
    expect(failureEvent, "a typed failure event must be posted").toBeTruthy();
    // Ruling 130(b) (pass 34): the classified cause in the remedy leaf's
    // words and the owner's OWN move; never the generic advice, never `..`.
    const lower = failureEvent!.text.toLowerCase();
    expect(lower).toContain("codex refused the agent run");
    expect(lower).toContain("over its usage limit");
    expect(lower).toContain("profile → agent accounts");
    expect(failureEvent!.text).not.toMatch(/retry on the other backend|fix the credential|\.\./i);
    // A recovery packet reaches the human's queue (not just a timeline note):
    // it must open and mark the task blocked so it surfaces as "waiting on you".
    expect(parsed.packet, "a recovery packet must open on a failed run").toBeTruthy();
    expect(parsed.packet!.type).toBe("blocked");
    // T13 (pass 31): the task owner + supervisors are notified — ONCE.
    //
    // BEFORE: one failed run put TWO rows in every supervisor's queue, a short
    // `quality` "Developer run failed: Codex is over its usage quota." and the
    // packet's own "Blocked, decision needed: Work stalled: pick a recovery
    // path" whose body is that same sentence plus "Coordination is paused…".
    // Same event, same recipients, two wordings — and the shorter one is the
    // one nothing can be done with. The packet notification is the survivor
    // because it is the actionable one.
    //
    // SAFETY: every selected column is declared on `notifications` (0001), and
    // `kind`/`text` are NOT NULL.
    const notifs = store.db
      .prepare(
        `SELECT user_id, kind, ptype, title, text FROM notifications WHERE task_key = 'VIB-1'`,
      )
      .all() as {
      user_id: string;
      kind: string;
      ptype: string | null;
      title: string | null;
      text: string;
    }[];
    expect(
      notifs.length,
      "watchers are notified of the run failure",
    ).toBeGreaterThan(0);
    // Exactly one row per recipient — no near-duplicate pair anywhere.
    const perUser = new Map<string, number>();
    for (const n of notifs) perUser.set(n.user_id, (perUser.get(n.user_id) ?? 0) + 1);
    expect([...perUser.values()].every((n) => n === 1), "one row per watcher").toBe(
      true,
    );
    // …and the one that survived is the ACTIONABLE one: the recovery packet,
    // carrying the same reason the short row used to duplicate.
    for (const n of notifs) {
      expect(n.kind).toBe("packet");
      expect(n.ptype).toBe("blocked");
      expect(n.title).toContain("Work stalled");
      expect(n.text.toLowerCase()).toContain("over its usage limit");
    }
    // waiting must be flipped off `agent` (no phantom "agent working").
    expect(parsed.frontmatter.waiting).toBe("human");
  });

  it("V2 (pass-31 review): a watcher who silenced packet notifications still gets the quality row", async () => {
    // T13's dedupe is PER RECIPIENT, not global. `packet` and `quality` are
    // independent routing categories, so a supervisor who turned off decision
    // packets (they don't resolve them) but kept quality flags on never saw
    // the packet row — a global "skip quality when the packet opened" left
    // them with NOTHING about the failed run, violating the invariant the
    // dedupe's own comment states.
    const { setNotifRoutingPref } = await import(
      "~/features/profile/profile-actions.server"
    );
    setNotifRoutingPref(store.db, store.users.murat.id, "packets", false);

    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runId = "run_v2_prefsplit";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-v2",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "codex",
      model: "gpt-5.5",
      sdk: "codex",
      state: "error",
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-07-12T10:00:00.000Z",
      raw: JSON.stringify({ ev: "err", tag: "turn.failed" }),
      display: {
        t: "10:00:00",
        ev: "err",
        tag: "turn.failed",
        text: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
      },
    });
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "developer",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "error" },
    );
    expect(taskFile().parsed.packet, "the recovery packet still opens").toBeTruthy();

    // SAFETY: every selected column is declared on `notifications` (0001), and
    // `kind`/`text` are NOT NULL.
    const notifs = store.db
      .prepare(
        `SELECT user_id, kind, text FROM notifications WHERE task_key = 'VIB-1'`,
      )
      .all() as { user_id: string; kind: string; text: string }[];
    const murats = notifs.filter((n) => n.user_id === store.users.murat.id);
    const ardas = notifs.filter((n) => n.user_id === store.users.arda.id);
    // The packet-silenced watcher hears about the failure through the quality
    // fallback — exactly once.
    expect(murats).toHaveLength(1);
    expect(murats[0]!.kind).toBe("quality");
    expect(murats[0]!.text).toContain("run failed");
    // A watcher the packet row REACHED is excluded from the fallback — still
    // exactly one row, the actionable one.
    expect(ardas).toHaveLength(1);
    expect(ardas[0]!.kind).toBe("packet");
  });

  it("ruling 130(b): a specialist quota failure names the reset instant and the owner's remedy; the options come from the remedy leaf; never `..`", async () => {
    // Canaries: restore the fixed "Retry on the other backend, or fix the
    // credential and re-run." sentence in the error arm (the event text
    // fails), or drop the `stuck.options` override so the stock set with
    // `redirect` recommended returns (the option assertions fail).
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runId = "run_130b_quota";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-130b",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "claude",
      model: "opus",
      sdk: "claude",
      state: "error",
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-09-07T10:00:00.000Z",
      raw: JSON.stringify({ ev: "err", tag: "run·error·quota" }),
      display: {
        t: "10:00:00",
        ev: "err",
        tag: "run·error·quota",
        text: "Claude refused the run: the five-hour usage window is spent.",
        failure: {
          ...emptyRunFailureFacts("quota"),
          windowRejected: true,
          window: "five_hour",
          resetsAt: "2026-09-07T11:50:00.000Z",
          apiErrorStatus: 429,
        },
      },
    });
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "developer",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "error" },
    );
    const parsed = taskFile().parsed;
    const event = parsed.timeline.find(
      (e) => e.type === "blocked" && /did not complete/.test(e.text),
    )!;
    const owner = store.users.arda.name;
    expect(event.text).toContain(
      `Claude refused the agent run: ${owner}'s five-hour usage window is spent and reopens at Sep 7, 2026 · 11:50 UTC.`,
    );
    expect(event.text).toContain("No changes were delivered.");
    expect(event.text).toContain(
      `${owner} can wait until the window reopens (Sep 7, 2026 · 11:50 UTC), or connect a different Claude account or an API key on Profile → Agent accounts.`,
    );
    expect(event.text).not.toMatch(/retry on the other backend|fix the credential|\.\./i);

    const packet = parsed.packet!;
    expect(packet.type).toBe("blocked");
    expect(packet.body).toContain("five-hour usage window is spent");
    expect(packet.body).toContain("Profile → Agent accounts");
    expect(packet.body).toContain("Coordination is paused until a human chooses how to proceed.");
    expect(packet.body).not.toMatch(/\.\./);
    // arda has Codex connected (the store's beforeEach), so the other-backend
    // retry leads and STICKS to the same profile; "send @dev back" is next;
    // redirect is present and NOT recommended (the agent did nothing wrong);
    // the hold option closes the set.
    expect(packet.options.map((o) => [o.kind, o.rec])).toEqual([
      ["retry_other_backend", true],
      ["request_edit", false],
      ["redirect", false],
      ["hold_runtime_debug", false],
    ]);
    expect(packet.options[0]!.t).toBe("Retry @dev on Codex now");
    expect(packet.options[0]!.profileId).toBe("developer");
    expect(packet.options[1]!.t).toBe(
      "The window has reset (Sep 7, 2026 · 11:50 UTC), or the Claude account changed: send @dev back to continue",
    );
    expect(packet.options[1]!.ev).toContain("No project policy was changed");
    for (const o of packet.options) expect(o.t).not.toMatch(/[–—]/);
  });

  it("ruling 175: a specialist the spending cap cut off names the cap and the spend, is not a task failure, and names who raises the cap", async () => {
    // Canary: drop the `max_budget` arm and the event reads "Claude run failed:
    // …" followed by "No changes were delivered." — a cap reads as a failure.
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runId = "run_175_budget";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-175",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "claude",
      model: "opus",
      sdk: "claude",
      state: "error",
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-09-11T10:00:00.000Z",
      raw: JSON.stringify({ ev: "err", tag: "run·error·max_budget" }),
      display: {
        t: "10:00:00",
        ev: "err",
        tag: "run·error·max_budget",
        text: "The run reached its $0.50 spending cap after spending $0.52 and was cut off.",
        failure: { ...emptyRunFailureFacts("max_budget"), spendCapUsd: 0.5, spentUsd: 0.52 },
      },
    });
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "developer",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "error" },
    );
    const event = taskFile().parsed.timeline.find(
      (e) => e.type === "blocked" && /did not complete/.test(e.text),
    )!;
    expect(event.text).toContain(
      "the Claude run reached the instance's spending cap of $0.50 after spending $0.52 and was CUT OFF mid-work, which is not a task failure",
    );
    expect(event.text).toContain("raise the cap in Org settings (Max spend per Claude run)");
    expect(event.text).not.toContain("No changes were delivered.");
    expect(event.text).not.toMatch(/\.\./);
  });

  /**
   * T13's other half: the dedupe must not become silence. When no packet
   * notification goes out — here because no operator is deployed, so the
   * escalation is refused — the short `quality` row is still the only thing
   * standing between a failed run and nobody finding out.
   */
  it("still notifies watchers when the recovery packet could NOT be opened", async () => {
    // NO operator deployed on this project (unlike the test above), so
    // `operatorOpenPacket` refuses and no packet notification is written.
    const runId = "run_t13_nopacket";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-t13",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "codex",
      model: "gpt-5.5",
      sdk: "codex",
      state: "error",
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-07-12T10:00:00.000Z",
      raw: JSON.stringify({ ev: "err", tag: "turn.failed" }),
      display: {
        t: "10:00:00",
        ev: "err",
        tag: "turn.failed",
        text: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
      },
    });
    await markWaitingAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1");
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "developer",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "error" },
    );
    // No packet opened…
    expect(taskFile().parsed.packet).toBeFalsy();
    // …so the plain failure notification is the one that reaches the queue.
    // SAFETY: `kind` and `text` are NOT NULL TEXT on `notifications` (0001).
    const notifs = store.db
      .prepare(`SELECT kind, text FROM notifications WHERE task_key = 'VIB-1'`)
      .all() as { kind: string; text: string }[];
    expect(notifs.length).toBeGreaterThan(0);
    expect(notifs.every((n) => n.kind === "quality")).toBe(true);
    expect(notifs.every((n) => /run failed/.test(n.text))).toBe(true);
    expect(taskFile().parsed.frontmatter.waiting).toBe("human");
  });
});

describe("unavailable backend through the specialist start path", () => {
  it("startSpecialistRun on an unavailable backend errors fast → blocked event with 'unavailable' copy + recovery packet", async () => {
    // Deploy an operator with generate-packets (opens the recovery packet).
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Ruling 127: the refusal is about the TASK OWNER's account — arda owns
    // VIB-1 here, and taking his accounts away is what makes the dispatch
    // refuse. BOTH go, so the packet has no real "retry on the other backend"
    // to offer either (asserted below).
    const { disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    await disconnectFakeBackend(store.db, store.users.arda.id, "claude");
    await disconnectFakeBackend(store.db, store.users.arda.id, "codex");
    const result = await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // SAFETY: same single-column SELECT, and `startAgentRun` returned the id of
    // the row it had just written, so the lookup always finds it.
    const row = store.db
      .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
      .get(result.runId) as { state: string };
    expect(row.state).toBe("error");

    const blockedByRefusal = (text: string) => /isn't connected for/.test(text);
    const surfaced = await waitFor(() => {
      const parsed = taskFile().parsed;
      return (
        parsed.timeline.some(
          (e) => e.type === "blocked" && blockedByRefusal(e.text),
        ) && parsed.packet?.type === "blocked"
      );
    });
    expect(surfaced, "blocked event + recovery packet must land").toBe(true);
    const parsed = taskFile().parsed;
    const failureEvent = parsed.timeline.find(
      (e) => e.type === "blocked" && blockedByRefusal(e.text),
    )!;
    // Ruling 127: the packet body carries the resolver's OWN sentence — the one
    // the run's error line carries — naming the owner and where THEY connect
    // the backend. It never names an environment variable, and it never tells
    // the reader to "configure a credential" on an instance that has none.
    expect(failureEvent.text).toContain(store.users.arda.name);
    expect(failureEvent.text).toContain("the task owner");
    // F34-12 (pass 34): the refusal sentence already carries its period; the
    // event and the packet body used to append another (`..`).
    expect(failureEvent.text).not.toMatch(/\.\./);
    expect(taskFile().parsed.packet?.body).not.toMatch(/\.\./);
    expect(taskFile().parsed.packet?.observations.find((o) => o.k === "Signal")?.v).not.toMatch(/\.\./);
    expect(failureEvent.text).toContain("Profile → Agent accounts");
    expect(failureEvent.text).not.toContain("Configure a credential");
    expect(failureEvent.text).not.toContain("ANTHROPIC_API_KEY");
    // …and "retry on the other backend" is NOT offered: the owner has not
    // connected Codex either, so that one-click recovery would fail the same
    // way the moment it was clicked.
    expect(
      (parsed.packet?.options ?? []).some(
        (o) => o.kind === "retry_other_backend",
      ),
    ).toBe(false);
    expect(parsed.frontmatter.waiting).toBe("human");
  });

  it("offers 'retry on the other backend' only when the OWNER has that one connected", async () => {
    // Ruling 127: the retry run would bill the same owner. Offering it when
    // they cannot run it promises a one-click fix that fails identically —
    // the worst kind of packet option, because it looks like the way out.
    const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...pf.parsed.frontmatter,
      agents: [
        ...pf.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [
            { capabilityId: "generate-packets", mode: "direct" },
            { capabilityId: "append-typed-events", mode: "direct" },
          ],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            role: "Task coordinator",
            backends: ["claude"],
            model: "sonnet",
            autonomy: "supervised",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Claude gone, Codex still connected (the beforeEach connected both).
    const { disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    await disconnectFakeBackend(store.db, store.users.arda.id, "claude");
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const offered = await waitFor(() => {
      const packet = taskFile().parsed.packet;
      return (packet?.options ?? []).some(
        (o) => o.kind === "retry_other_backend",
      );
    });
    expect(offered, "the owner CAN run Codex, so the retry is real").toBe(true);
  });
});

describe("reviewer verdict on the UI Run-button path (H2/A1 regression)", () => {
  it("startReviewerRun's own hook records the verdict when the run finishes", async () => {
    // A delivered revision under review, but NO pre-set reviewer engagement:
    // assignReviewer below makes `dev` the SOLE required reviewer (it carries an
    // explicit verdict grant), so its approve derives validation → healthy.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Unified completion pipeline probe",
        branch: "vib-1-work",
        workRevision: workRev(),
      }),
      goal: "Exercise the canonical completion handler.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    queueFakeRun({
      lines: [
        {
          t: "",
          ev: "text",
          tag: "assistant",
          text: "Review complete. Verdict: **approve**.",
        },
      ],
    });
    const result = await startAgentRun(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
        directive: "@reviewer verify the change end to end",
      },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const changed = await waitFor(() => {
      const fm = taskFile().parsed.frontmatter;
      return fm.validation === "healthy";
    }, 25_000);
    expect(changed).toBe(true);
    expect(result.runId).toBeTruthy();
  }, 30_000);
});

describe("superseded stuck-packet withdrawal (owner ruling 2026-07-18)", () => {
  /** A finished fake run whose final assistant text is `text` (local copy
   *  of the shared-effects describe's helper — that one is block-scoped).
   *  Session ids are unique so two runs in ONE test don't collide on the
   *  (project, task, thread) uniqueness. */
  let runSeq = 0;
  async function finishedRunWith(text: string): Promise<string> {
    runSeq += 1;
    queueFakeRun({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
      sessionId: `t-${runSeq}`,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "reviewer",
      role: "Reviewer",
      agentProfileId: "reviewer",
      credentialUserId: store.users.arda.id,
      backend: "claude",
      model: "sonnet",
      prompt: "review",
      workdir: store.dataRoot,
      autonomous: true,
      dataRoot: store.dataRoot,
      actor: actor(store.users.arda),
      // Distinct thread per helper call — two runs in one test otherwise
      // collide on the (project, task, thread) uniqueness.
      threadId: `th-${runSeq}`,
    });
    await waitFor(() => {
      // SAFETY: the SELECT list is the single column `state`, which
      // `agent_runs` declares TEXT NOT NULL in 0001_baseline; `undefined` is
      // sqlite's own answer when the id matches no row.
      const row = store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get(started.runId) as { state: string } | undefined;
      return row?.state === "finished";
    });
    return started.runId;
  }

  /** Write a `type: "blocked"` work-stalled packet straight into the task file
   *  (the schema shape operatorOpenPacket produces). */
  async function openBlockedPacket(options: PacketOption[]): Promise<void> {
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.packet = {
          type: "blocked",
          kind: "Blocked decision",
          from: "operator",
          title: "Work stalled — pick a recovery path",
          body: "The run failed. Coordination is paused until a human chooses how to proceed.",
          observations: [],
          options,
        };
        parsed.frontmatter.readiness = "blocked";
      },
    );
  }

  const redirect: PacketOption = {
    kind: "redirect",
    t: "Redirect with sharper guidance",
    d: "",
    rec: false,
  };
  // Deliberately UNSTAMPED — the operator's open_decision_packet option shape
  // has no profileId field, so a primary-subject retry never names one. Adding
  // a profileId here silently drops the unstamped case out of coverage.
  const retryPrimary: PacketOption = {
    kind: "retry_other_backend",
    t: "Retry on Claude Code",
    d: "",
    rec: true,
    backend: "claude",
  };
  const retryReviewer: PacketOption = { ...retryPrimary, profileId: "style" };

  async function runEffects(
    runId: string,
    engagement: { delivers: boolean; profileId?: string },
    state = "finished",
  ): Promise<void> {
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: engagement.profileId ?? "developer",
        role: "developer",
        delivers: engagement.delivers,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state },
    );
  }

  it("a successful PRIMARY run withdraws a primary-subject packet, lifts readiness, and audits", async () => {
    await openBlockedPacket([retryPrimary, redirect]);
    const runId = await finishedRunWith("Recovered — the work is delivered.");
    await runEffects(runId, { delivers: true });
    const parsed = taskFile().parsed;
    expect(parsed.packet).toBeNull();
    expect(parsed.frontmatter.readiness).toBe("ready");
    const note = parsed.timeline.find((e) =>
      (e.text ?? "").includes("**Packet withdrawn:**"),
    );
    expect(note).toBeTruthy();
    expect(note!.text).toContain("Work stalled — pick a recovery path");
    const { listAuditEvents } = await import("../../../test-support/audit-log");
    expect(
      listAuditEvents(store.db).some(
        (e) => e.action === "task.packet.withdrawn_superseded",
      ),
    ).toBe(true);
  });

  it("a FAILED run does not withdraw — the packet stays for the human", async () => {
    await openBlockedPacket([retryPrimary, redirect]);
    const runId = await finishedRunWith("It broke again.");
    await runEffects(runId, { delivers: true }, "error");
    expect(taskFile().parsed.packet).not.toBeNull();
  });

  it("an accept_completion packet is never auto-withdrawn (completion stays human)", async () => {
    await openBlockedPacket([
      { kind: "accept_completion", t: "Accept & move to Done", d: "", rec: true },
      redirect,
    ]);
    const runId = await finishedRunWith("More work landed.");
    await runEffects(runId, { delivers: true });
    expect(taskFile().parsed.packet).not.toBeNull();
  });

  it("a reviewer-subject packet ignores a primary success but withdraws when THAT reviewer profile succeeds", async () => {
    await openBlockedPacket([retryReviewer, redirect]);
    // Primary success — different subject, packet must stay.
    const primaryRun = await finishedRunWith("Primary delivered.");
    await runEffects(primaryRun, { delivers: true });
    expect(taskFile().parsed.packet).not.toBeNull();
    // The named reviewer profile succeeds — withdrawn (profileId is the join
    // key against the retry option's stamped profileId, never the role).
    const reviewerRun = await finishedRunWith("Review passed cleanly.");
    store.db
      .prepare(`UPDATE agent_runs SET agent_profile_id = ? WHERE id = ?`)
      .run("style", reviewerRun);
    await runEffects(reviewerRun, { delivers: false, profileId: "style" });
    expect(taskFile().parsed.packet).toBeNull();
  });

  it("an unstamped retry option is primary-subject — a reviewer success leaves it, the delivering run withdraws it", async () => {
    await openBlockedPacket([retryPrimary, redirect]);
    // No profileId on the option → the subject is the delivering specialist, so
    // a non-delivering reviewer's success must NOT withdraw it.
    const reviewerRun = await finishedRunWith("Read through the diff.");
    await runEffects(reviewerRun, { delivers: false, profileId: "style" });
    expect(taskFile().parsed.packet).not.toBeNull();
    // The delivering specialist then succeeds — that falsifies "work stalled".
    const primaryRun = await finishedRunWith("Primary delivered.");
    await runEffects(primaryRun, { delivers: true });
    expect(taskFile().parsed.packet).toBeNull();
  });

  it("an agent-agnostic packet (no retry option) withdraws on any successful run", async () => {
    await openBlockedPacket([redirect]);
    const runId = await finishedRunWith("Unblocked and finished.");
    await runEffects(runId, { delivers: true });
    expect(taskFile().parsed.packet).toBeNull();
  });
});
