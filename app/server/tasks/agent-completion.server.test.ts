import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  approveReviewEntry,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  currentVerdicts,
  type Engagement,
  type PacketOption,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { withFileLock } from "~/server/files/file-mutex.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import { listKeptDeliveries } from "~/server/files/kept-deliveries.server";
import { readTaskAttachment } from "~/server/files/task-attachments.server";
import { insertUser } from "~/server/auth/user-store.server";
import { logger } from "~/server/logging/logger.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { startRun } from "~/server/runtimes/run-service.server";
import { getRun, insertRunLine, patchRun, upsertRun } from "~/server/runtimes/run-store.server";
import {
  drainRunCompletions,
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { pollUntil } from "../../../test-support/polling";
import { emptyRunFailureFacts } from "~/shared/run-failure";
import { stageOutcome } from "./agent-outcome.server";
import { OPERATOR_NOTIFY_FROM } from "./task-mutation.server";
import { relayToTask, takeFromTask, type RelayAuthor } from "./task-relay.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import type { openTaskPr } from "~/server/github/pr-open.server";
import { acceptanceRefusalFor } from "./task-acceptance.server";
import {
  applyAgentCompletionEffects,
  classifyReviewerVerdict,
  markWaitingAgent,
} from "./agent-completion.server";
import { resolvePacket } from "./packet-resolution.server";
import { attachTaskFile } from "./task-edits.server";
import { OPERATOR_REACT_HOP_CEILING } from "./task-action-core.server";
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
  installFakeRuntime();
  // Ruling 127: an agent run bills the TASK OWNER's own accounts, so a run
  // only reaches an adapter when the owner has that backend connected. Arda
  // owns the tasks in this file; connecting both backends for him is the
  // ordinary state of somebody using the product.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
  await connectFakeBackend(store.db, store.users.arda.id, "codex");
});

afterEach(() => {
  ctx.cleanup();
});

/** Start a fake provider run whose final assistant text is `text`, wait for
 *  it to finish, and return its run id. `autonomous` — no default
 *  completion hook is registered by startRun itself. Session/thread ids are
 *  unique per call so a test can drive more than one run without colliding on
 *  the (project, task, thread) uniqueness. */
let runSeq = 0;
async function finishedRunWith(text: string, reviewSubject?: string | null): Promise<string> {
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
  const input: Parameters<typeof startRun>[1] = {
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
    actor: actorOf(store.users.arda),
    threadId: `th-${runSeq}`,
  };
  // Ruling 544: what the run was dispatched on, when the case says.
  if (reviewSubject !== undefined) input.reviewSubject = reviewSubject;
  const started = await startRun(store.db, input);
  await pollUntil(() => {
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

describe("waiting-state bookkeeping (A2)", () => {
  it("startSpecialistRun marks waiting=agent while the run is in flight", async () => {
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile().parsed.frontmatter.waiting).not.toBe("agent");
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
  });
});

describe("applyAgentCompletionEffects (the shared effects)", () => {
  /**
   * Save `names` into VIB-1's attachments store inside run `runId`'s window,
   * and return the directory. Completion finds a run's files by mtime: those
   * modified at or after its `started_at` (`attachmentNamesSince`).
   *
   * Each file is stamped with the run's own `finished_at` rather than keeping
   * the mtime its write got. A fake run finishes within milliseconds of
   * starting, and Linux stamps a new file from a coarse clock (the last timer
   * tick) that trails the `new Date()` behind `started_at`: by up to 7 ms,
   * median 5, measured on a CONFIG_HZ=250 kernel. A file written straight
   * after the run could therefore read OLDER than the run, and the window held
   * none of the files, or only the later ones when a tick fell between two
   * writes. The prune test failed most runs, and the ERRORED and SIBLING tests
   * passed without their files ever being candidates. A real run's files land
   * seconds after it starts, so only the fixture needs this.
   */
  function saveInRunWindow(runId: string, names: readonly string[]): string {
    const finishedAt = getRun(store.db, runId)?.finished_at;
    if (!finishedAt) throw new Error(`run ${runId} has not finished`);
    const savedAt = new Date(finishedAt);
    const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    for (const name of names) {
      const file = path.join(dir, name);
      writeFileSync(file, `content of ${name}`);
      utimesSync(file, savedAt, savedAt);
    }
    return dir;
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
    // The live deployment the owner just set: the operator on Claude.
    deployOperator();
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
    deployOperator();
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
    const dir = saveInRunWindow(runId, [cited, uncitedSnap, uncitedLog, screenshot]);
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

  it("ruling 549: a snapshot cited only in a file the run saved is kept", async () => {
    // Live on AWSC-1 the Workflow Researcher's findings file named eleven
    // browser snapshots and its report named none: the prune deleted all
    // eleven, and the Estimate Judge rejected the findings for citing files
    // that were not there. CANARY: drop `savedFilesText` from the citation
    // corpus and the snapshot the findings cite is deleted.
    writeReviewTask({ stage: "impl", workRevision: null, validation: "none" });
    const citedInFile = "page-2026-09-28T08-36-09-671Z.yml";
    const uncited = "page-2026-09-28T08-36-38-297Z.yml";
    const runId = await finishedRunWith("Saved the findings on the task.");
    const dir = saveInRunWindow(runId, [citedInFile, uncited, "calculator-findings.md"]);
    const findings = path.join(dir, "calculator-findings.md");
    writeFileSync(findings, `Bulk import offers three templates. Evidence: ${citedInFile}.\n`);
    const finishedAt = new Date(getRun(store.db, runId)!.finished_at!);
    utimesSync(findings, finishedAt, finishedAt);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "dev",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "finished" },
    );
    expect(existsSync(path.join(dir, citedInFile))).toBe(true);
    expect(existsSync(path.join(dir, uncited))).toBe(false);
    expect(existsSync(findings)).toBe(true);
  });

  it("ruling 533: a file a person attaches while a deliverer runs stays theirs, and delivers nothing", async () => {
    // A run's files are found by mtime, so a person's upload during the run
    // is in its window too. Claimed, it named the deliverer as its author and
    // stamped `deliveredAt` from the person's own input: a files-only task
    // then read as delivered by a run that saved nothing.
    // CANARY: drop the `personFiled` filter in applyAgentCompletionEffects and
    // the run claims `inventory.csv` and `deliveredAt` is stamped.
    writeReviewTask({ stage: "impl", workRevision: null, validation: "none" });
    const runId = await finishedRunWith("Read the inventory; nothing to save yet.");
    await attachTaskFile(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", name: "inventory.csv", data: new TextEncoder().encode("vm,cpu\nweb01,4\n") },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Inside the run's window, which is the case at issue (stamped like
    // `saveInRunWindow` stamps a run's own files, for the same clock reason).
    const upload = path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), "inventory.csv");
    const finishedAt = new Date(getRun(store.db, runId)!.finished_at!);
    utimesSync(upload, finishedAt, finishedAt);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "dev",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.deliveredAt).toBeNull();
    const claimants = parsed.timeline.filter((e) => (e.attachments ?? []).includes("inventory.csv"));
    expect(claimants.map((e) => e.actor.kind)).toEqual(["human"]);
    expect(existsSync(upload)).toBe(true);
  });

  it("ruling 558: a file still being put down for someone else when the run completes is never the run's", async () => {
    // A person's upload, a relay and a take put the file down and then claim
    // it. A completion between the two read a timeline with no claim and took
    // the file: for a deliverer, as its delivery. The writers hold the name
    // meanwhile; here the completion lands inside that hold.
    // CANARY: drop the held names from the completion's exclusion and the run
    // claims `sample-01-input.csv` and stamps `deliveredAt`.
    writeReviewTask({ stage: "impl", workRevision: null, validation: "none" });
    const runId = await finishedRunWith("Waiting for the benchmark input.");
    const { withAttachmentClaims } = await import("~/server/files/task-attachments.server");
    await withAttachmentClaims(store.slug, "VIB-1", ["sample-01-input.csv"], async () => {
      saveInRunWindow(runId, ["sample-01-input.csv"]);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "claude",
          profileId: "dev",
          role: "Developer",
          delivers: true,
          workdir: null,
          agentHandle: "dev",
        },
        { id: runId, state: "finished" },
      );
    });
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.deliveredAt).toBeNull();
    expect(parsed.timeline.some((e) => (e.attachments ?? []).includes("sample-01-input.csv"))).toBe(false);
  });

  /** Ruling 558's writers: each puts `SAMPLE` on VIB-1 for someone other
   *  than a run. The relay and the take bring it from VIB-2, which is Done. */
  const WRITERS = ["a person's upload", "a relay", "a take"] as const;
  const SAMPLE = "sample-01-input.csv";
  const SAMPLE_BODY = "vm,cpu\nweb01,4\n";
  async function putSampleOnVib1(writer: (typeof WRITERS)[number]): Promise<void> {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "done", ownerUserId: store.users.arda.id }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const source = taskAttachmentsDir(store.slug, "VIB-2", store.dataRoot);
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, SAMPLE), SAMPLE_BODY);
    const author: RelayAuthor = {
      actorRef: { kind: "operator" },
      name: "operator",
      auditActor: { userId: null, label: "operator" },
      notifyFrom: OPERATOR_NOTIFY_FROM,
    };
    if (writer === "a person's upload") {
      await attachTaskFile(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", name: SAMPLE, data: new TextEncoder().encode(SAMPLE_BODY) },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      return;
    }
    if (writer === "a relay") {
      await relayToTask(store.db, { dataRoot: store.dataRoot }, {
        projectSlug: store.slug,
        fromTaskKey: "VIB-2",
        toTaskKey: "VIB-1",
        text: "The benchmark input.",
        files: [SAMPLE],
        author,
      });
      return;
    }
    await takeFromTask(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      fromTaskKey: "VIB-2",
      files: [SAMPLE],
      author,
    });
  }
  const vib1Sample = () => path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), SAMPLE);

  it.each(WRITERS)(
    "ruling 558: a completion that lands while %s is claiming its file leaves the file to it",
    async (writer) => {
      // The writers' side of the hold. Each puts its file down, then waits for
      // VIB-1's file lock to write the entry that claims it. The test holds
      // that lock, so the completion lists the file, reads a timeline with no
      // claim on it, and queues behind the writer.
      // CANARY: hold no name while the file is put down (`[]` for the names in
      // attachTaskFile, or in task-relay's landCarriedFiles) and the run claims
      // `sample-01-input.csv` and stamps `deliveredAt`.
      writeReviewTask({ stage: "impl", workRevision: null, validation: "none" });
      const runId = await finishedRunWith("Waiting for the benchmark input.");
      const lock = resolveTaskFilePath({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot });
      let unlock: (() => void) | null = null;
      const locked = withFileLock(lock, () => new Promise<void>((resolve) => (unlock = resolve)));
      await vi.waitFor(() => expect(unlock).not.toBeNull());
      const writing = putSampleOnVib1(writer);
      // The file is down and its claim waits on the lock. Inside the run's
      // window, as `saveInRunWindow` stamps a run's own files.
      const finishedAt = new Date(getRun(store.db, runId)!.finished_at!);
      utimesSync(vib1Sample(), finishedAt, finishedAt);
      const completing = applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "claude",
          profileId: "dev",
          role: "Developer",
          delivers: true,
          workdir: null,
          agentHandle: "dev",
        },
        { id: runId, state: "finished" },
      );
      // Both wait on the lock: the writer's claim first, then the completion.
      await vi.waitFor(async () => {
        const { pending = [] } = await navigator.locks.query();
        expect(pending.filter((l) => l.name === lock)).toHaveLength(2);
      });
      unlock!();
      await Promise.all([locked, writing, completing]);
      const parsed = taskFile().parsed;
      expect(parsed.frontmatter.deliveredAt).toBeNull();
      const claimants = parsed.timeline.filter((e) => (e.attachments ?? []).includes(SAMPLE));
      expect(claimants).toHaveLength(1);
      expect(claimants[0]!.actor.kind).not.toBe("agent");
    },
  );

  it.each(WRITERS)("ruling 558: %s whose claim cannot be written leaves no file behind", async (writer) => {
    // A file on the task that nothing claims is the next completion's to
    // credit to its run. CANARY: write the file with `writeTaskAttachment`
    // instead of the hold's `put` (in attachTaskFile, or in task-relay's
    // landCarriedFiles) and the sample stays on VIB-1 with no claim.
    writeFileSync(
      resolveTaskFilePath({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }),
      "---\nkey: VIB-1\ntitle: Truncated by an editor\nstage: impl\n",
    );
    await expect(putSampleOnVib1(writer)).rejects.toMatchObject({ code: "file_not_trusted" });
    expect(existsSync(vib1Sample())).toBe(false);
  });

  it("ruling 555: a deliverer's reply is its delivery, whatever verdict it states", async () => {
    // Live on AWSC-3 the Estimate Judge designed the benchmark (it delivers
    // there) and ended its report "**Approved.**". Completion took that as a
    // review verdict, filed the samples as its evidence and never stamped the
    // delivery, so the task reached Review with nothing delivered and a
    // verdict bound to nothing, and each re-run did the same.
    // CANARY: authorize the delivering engagement's verdict and `deliveredAt`
    // stays null while the files ride an "Approval noted" verdict event.
    writeReviewTask({
      stage: "impl",
      workRevision: null,
      validation: "none",
      engagements: [{ ...REVIEWER_ENGAGEMENT, delivers: true }],
    });
    const runId = await finishedRunWith(
      "Verdict: approve. Every sample carries at least three traps; the files are saved on this task.",
    );
    saveInRunWindow(runId, ["sample-01-input.csv", "golden-files.md"]);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: true,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.deliveredAt).not.toBeNull();
    const reply = parsed.timeline.find((e) => e.type === "comment" && e.actor.kind === "agent");
    expect(reply?.attachments).toEqual(expect.arrayContaining(["sample-01-input.csv", "golden-files.md"]));
    expect(parsed.timeline.some((e) => e.type === "quality")).toBe(false);
    // Nor does it approve its own delivery once that is stamped.
    expect(parsed.frontmatter.verdicts).toEqual([]);
  });

  it("ruling 609: a deliverer that ends by asking a person has not delivered", async () => {
    // Live on AWSC-52 the Calculator Builder stopped at its headline ask
    // (rulings §4 C3) with drafts saved, and the ask stamped `deliveredAt` on an
    // estimate-link.md that said the delivered link was still pending.
    // CANARY: stamp the delivery whatever the run ends with, and the drafts
    // become the delivery.
    writeReviewTask({
      stage: "impl",
      workRevision: null,
      validation: "none",
      engagements: [{ ...REVIEWER_ENGAGEMENT, delivers: true }],
    });
    const runId = await finishedRunWith(
      JSON.stringify({
        summary: "Rebuilt the estimate. The delivered link and the final exports wait on the headline ask.",
        question: { title: "Headline calculator total or Price List total? (C3)", body: "Calculator $2,092.70, Price List $2,094.55." },
      }),
    );
    saveInRunWindow(runId, ["estimate-link.md", "assumptions.md"]);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "reviewer",
        role: "Calculator Builder",
        delivers: true,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.packet?.title).toBe("Headline calculator total or Price List total? (C3)");
    expect(parsed.frontmatter.deliveredAt).toBeNull();
    // The drafts are still posted under its name, where its next run reads them.
    const reply = parsed.timeline.find((e) => e.type === "comment" && e.actor.kind === "agent");
    expect(reply?.attachments).toEqual(expect.arrayContaining(["estimate-link.md", "assumptions.md"]));
  });

  /** Ruling 555's hand-off: the `reviewer` profile was handed delivery while
   *  its review run worked, over files `dev` delivered at `savedAt`. */
  function writeHandedOffReviewTask(savedAt: string): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        engagements: [{ ...REVIEWER_ENGAGEMENT, delivers: true }],
        workRevision: null,
        deliveredAt: savedAt,
        validation: "changed",
      }),
      goal: "Price the estate.",
      timeline: [
        {
          occurredAt: savedAt,
          type: "comment",
          actor: { kind: "agent", backend: "claude", profileId: "dev", roleHint: "Reviewer" },
          title: null,
          text: "The estimate is saved on the task.",
          toAgent: false,
          evidence: null,
          attachments: ["estimate-link.md"],
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }
  const completeReviewRun = (runId: string) =>
    applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );

  it("ruling 555: a review run whose profile was handed delivery while it worked keeps its verdict", async () => {
    // The channel was offered at dispatch, as a reviewer; the roster at
    // completion does not take it back. CANARY: key `verdictAuthorized` on the
    // engagement at completion instead of the run's dispatch and the verdict
    // is discarded.
    const savedAt = "2026-09-28T12:27:12.883Z";
    writeHandedOffReviewTask(savedAt);
    const runId = await finishedRunWith("Verdict: approve. The totals match the mapping.", `files:${savedAt}`);
    await completeReviewRun(runId);
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.verdicts.map((v) => [v.profileId, v.result])).toEqual([["reviewer", "approve"]]);
    expect(parsed.frontmatter.deliveredAt).toBe(savedAt);
  });

  it("ruling 555: that review run's captures never become the delivery, with no verdict to carry them", async () => {
    // With no verdict the run's files ride its reply, which the delivery stamp
    // reads. They were saved for a review, and the roster at completion does
    // not make them the delivery. CANARY: drop the dispatch check from
    // `stampNonCommitDelivery` and `deliveredAt` moves onto the capture.
    const savedAt = "2026-09-28T12:27:12.883Z";
    writeHandedOffReviewTask(savedAt);
    const capture = "page-2026-09-28T12-40-00-000Z.png";
    const runId = await finishedRunWith(
      "The estimate link would not open, so I have no finding on the totals yet; the capture shows the error.",
      `files:${savedAt}`,
    );
    saveInRunWindow(runId, [capture]);
    await completeReviewRun(runId);
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.deliveredAt).toBe(savedAt);
    // Still the reviewer's, on its own report.
    const carrier = parsed.timeline.find((e) => (e.attachments ?? []).includes(capture));
    expect(carrier?.actor).toMatchObject({ kind: "agent", profileId: "reviewer" });
  });

  it("ruling 556: a reviewer's verdict never binds to files it saved itself", async () => {
    // AWSC-3's way out, taken naively: the Estimate Judge delivered, delivery
    // was handed to another agent that saved nothing, and the Judge was run as
    // the reviewer. The subject is still the Judge's own files.
    // CANARY: drop `!ownWork` from the binding and the approval binds to them.
    const savedAt = "2026-09-28T12:37:42.597Z";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_DELIVERS_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: null,
        deliveredAt: savedAt,
        validation: "changed",
      }),
      goal: "Design the samples.",
      timeline: [
        {
          occurredAt: savedAt,
          type: "comment",
          actor: { kind: "agent", backend: "claude", profileId: "reviewer", roleHint: "Review & validation" },
          title: null,
          text: "The samples are saved on the task.",
          toAgent: false,
          evidence: null,
          attachments: ["sample-01-input.csv"],
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runId = await finishedRunWith("Verdict: approve. Every sample carries its traps.", `files:${savedAt}`);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.verdicts).toEqual([]);
    const note = parsed.timeline.find((e) => e.type === "quality");
    expect(note?.text).toContain("but it made what is delivered, so its verdict does not count");
  });

  /** Ruling 587: `dev` delivered two files at `savedAt`, and `reviewer` asked
   *  for a change to one of them. */
  function writeDeliveredAndObjectedTask(savedAt: string): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "mapping",
        ownerUserId: store.users.arda.id,
        engagements: [DEV_DELIVERS_ENGAGEMENT, REVIEWER_ENGAGEMENT],
        workRevision: null,
        deliveredAt: savedAt,
        validation: "failing",
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: `files:${savedAt}`,
            result: "request_changes",
            reason: "assumptions.md omits the cost of the 20%-free size.",
            at: savedAt,
            rounds: 1,
            reviews: 1,
          },
        ],
      }),
      goal: "Price the estate.",
      timeline: [
        {
          occurredAt: savedAt,
          type: "comment",
          actor: { kind: "agent", backend: "claude", profileId: "dev", roleHint: "Calculator Builder" },
          title: null,
          text: "The estimate is saved on the task.",
          toAgent: false,
          evidence: null,
          attachments: ["assumptions.md", "estimate-link.md"],
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }
  const completeSupportingRun = (runId: string) =>
    applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );

  it("ruling 587: a supporting run that rewrites a delivered file moves the delivery, and the verdict on it goes stale", async () => {
    // Live on AWSC-28 the Architect rewrote the delivered assumptions.md at
    // Mapping and the subject stayed put, so the Judge's re-review landed on
    // the revision it had already objected to. CANARY: return early for every
    // run not dispatched to deliver, as before, and `deliveredAt` stays put.
    const savedAt = "2026-09-29T09:47:34.900Z";
    writeDeliveredAndObjectedTask(savedAt);
    const runId = await finishedRunWith("Added the missing 20%-free line to assumptions.md.");
    saveInRunWindow(runId, ["assumptions.md"]);
    await completeSupportingRun(runId);
    const fm = taskFile().parsed.frontmatter;
    expect(fm.deliveredAt).not.toBe(savedAt);
    expect(currentVerdicts(fm)).toEqual([]);
  });

  it("ruling 597: each files delivery is kept as delivered, and a rework leaves the first one readable", async () => {
    // Live in round 4 the Estimate Judge re-reviewing AWSC-43 scored the first
    // delivery as "a reconstruction from the surviving first-delivery exports":
    // the rework had saved mapping.md and assumptions.md again. CANARY: drop the
    // keep after the completion's write and nothing is kept.
    writeDeliveredAndObjectedTask("2026-09-29T09:47:34.900Z");
    const first = await finishedRunWith("Added the missing 20%-free line to assumptions.md.");
    const dir = saveInRunWindow(first, ["assumptions.md"]);
    await completeSupportingRun(first);
    const firstStamp = taskFile().parsed.frontmatter.deliveredAt!;
    const second = await finishedRunWith("Rewrote assumptions.md for the rework.");
    saveInRunWindow(second, ["assumptions.md"]);
    const finishedAt = new Date(getRun(store.db, second)!.finished_at!);
    writeFileSync(path.join(dir, "assumptions.md"), "the rework's assumptions");
    utimesSync(path.join(dir, "assumptions.md"), finishedAt, finishedAt);
    await completeSupportingRun(second);
    const secondStamp = taskFile().parsed.frontmatter.deliveredAt!;

    expect(listKeptDeliveries(store.slug, "VIB-1", store.dataRoot)).toEqual([
      { deliveredAt: secondStamp, files: ["assumptions.md"] },
      { deliveredAt: firstStamp, files: ["assumptions.md"] },
    ]);
    const read = (delivery?: string) =>
      readTaskAttachment(store.slug, "VIB-1", "assumptions.md", store.dataRoot, 0, delivery);
    expect(read(firstStamp)).toMatchObject({ kind: "text", text: "content of assumptions.md" });
    expect(read(secondStamp)).toMatchObject({ kind: "text", text: "the rework's assumptions" });
    expect(read()).toMatchObject({ kind: "text", text: "the rework's assumptions" });
    expect(read("2026-09-29T09:47:34.900Z")).toBeNull();
  });

  it("ruling 610: a kept delivery holds every file on the task, a supporting agent's included", async () => {
    // Live on AWSC-52 the Estimate Judge's J4 audit read the first delivery
    // without the Architect's mapping.md and called its Deliverable score
    // unsupported. CANARY: keep only the deliverer's files and mapping.md is
    // missing from the kept delivery.
    writeReviewTask({
      stage: "impl",
      workRevision: null,
      validation: "none",
      engagements: [{ ...REVIEWER_ENGAGEMENT, delivers: true }],
    });
    // Saved before this run by another stage's agent, and a browser snapshot.
    const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    const earlier = new Date(Date.now() - 60 * 60_000);
    for (const [name, body] of [["mapping.md", "the Architect's mapping"], ["page-2026-09-30T12-00-00-000Z.yml", "- snapshot"]]) {
      writeFileSync(path.join(dir, name!), body!);
      utimesSync(path.join(dir, name!), earlier, earlier);
    }
    const runId = await finishedRunWith("Built the estimate; the link and exports are on this task.");
    saveInRunWindow(runId, ["assumptions.md"]);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "codex",
        profileId: "reviewer",
        role: "Calculator Builder",
        delivers: true,
        workdir: null,
        agentHandle: "reviewer",
      },
      { id: runId, state: "finished" },
    );
    const stamp = taskFile().parsed.frontmatter.deliveredAt!;
    expect(listKeptDeliveries(store.slug, "VIB-1", store.dataRoot)).toEqual([
      { deliveredAt: stamp, files: ["assumptions.md", "mapping.md"] },
    ]);
    expect(readTaskAttachment(store.slug, "VIB-1", "mapping.md", store.dataRoot, 0, stamp)).toMatchObject({
      kind: "text",
      text: "the Architect's mapping",
    });
  });

  it("ruling 587: a file the delivery does not hold moves nothing", async () => {
    // A supporting agent's own notes are not the delivery (ruling 555).
    // CANARY: stamp on any saved file and the objection is dropped with no
    // change to what it objected to.
    const savedAt = "2026-09-29T09:47:34.900Z";
    writeDeliveredAndObjectedTask(savedAt);
    const runId = await finishedRunWith("Wrote my mapping notes to architect-notes.md.");
    saveInRunWindow(runId, ["architect-notes.md"]);
    await completeSupportingRun(runId);
    const fm = taskFile().parsed.frontmatter;
    expect(fm.deliveredAt).toBe(savedAt);
    expect(currentVerdicts(fm).map((v) => v.result)).toEqual(["request_changes"]);
  });

  it("ruling 627: beside another specialist run, a delivered file it names is not its, and the delivery stays", async () => {
    // A reviewer names the file it reviewed; the deliverer, live beside it,
    // is the one that saved it again. Claiming it would move the delivery
    // onto the reviewer's entry (ruling 587) and make the subject its own
    // work (ruling 556). CANARY: drop the delivered-file check and
    // `deliveredAt` moves.
    const savedAt = "2026-09-29T09:47:34.900Z";
    writeDeliveredAndObjectedTask(savedAt);
    const runId = await finishedRunWith("Re-read assumptions.md: the 20%-free line is still missing.");
    insertSiblingRun("primary", null);
    saveInRunWindow(runId, ["assumptions.md"]);
    await completeSupportingRun(runId);
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.deliveredAt).toBe(savedAt);
    expect(parsed.timeline.filter((e) => e.actor.kind === "agent" && e.actor.profileId === "reviewer").flatMap((e) => e.attachments ?? [])).toEqual([]);
  });

  it("ruling 538: a file a relay carries here while a deliverer runs is the relay's, and delivers nothing", async () => {
    // CANARY: leave relay comments out of the completion's `carriedHere` and
    // the run claims `sample-01-input.csv` and stamps `deliveredAt`.
    writeReviewTask({ stage: "impl", workRevision: null, validation: "none" });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl", ownerUserId: store.users.arda.id }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runId = await finishedRunWith("Waiting for the benchmark input.");
    const source = taskAttachmentsDir(store.slug, "VIB-2", store.dataRoot);
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "sample-01-input.csv"), "vm,cpu\nweb01,4\n");
    const { relayToTask } = await import("./task-relay.server");
    const relayed = await relayToTask(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        fromTaskKey: "VIB-2",
        toTaskKey: "VIB-1",
        text: "The benchmark input.",
        files: ["sample-01-input.csv"],
        author: {
          actorRef: { kind: "operator" },
          name: "operator",
          auditActor: { userId: null, label: "operator" },
          notifyFrom: OPERATOR_NOTIFY_FROM,
        },
      },
    );
    expect(relayed.outcome).toBe("done");
    // Inside the run's window, stamped as `saveInRunWindow` stamps a run's files.
    const landed = path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), "sample-01-input.csv");
    const finishedAt = new Date(getRun(store.db, runId)!.finished_at!);
    utimesSync(landed, finishedAt, finishedAt);
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "dev",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.deliveredAt).toBeNull();
    const claimants = parsed.timeline.filter((e) => (e.attachments ?? []).includes("sample-01-input.csv"));
    expect(claimants.map((e) => e.actor.kind)).toEqual(["operator"]);
  });

  /**
   * Ruling 544 (live, AWSC-2): a verdict binds to the subject its run was
   * dispatched on. The Estimate Judge started on the research as it stood;
   * the researcher delivered the final files five seconds before the Judge
   * finished, and the Judge's verdict bound to that delivery, which it never
   * read. An approval there would have released acceptance on content no
   * reviewer read.
   */
  it("ruling 544: a reviewer's run records the subject it was dispatched on", async () => {
    // CANARY: drop `runInput.reviewSubject` in dispatchAgentRun and both rows
    // say nothing, so each verdict binds to whatever is delivered at the end.
    writeReviewTask();
    const onRevision = await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(getRun(store.db, onRevision.runId)?.review_subject).toBe("rev_1");
    await drainRunCompletions();
    writeReviewTask({ workRevision: null, branch: null, validation: "none" });
    const beforeDelivery = await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "reviewer" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(getRun(store.db, beforeDelivery.runId)?.review_subject).toBe("none");
    // Both runs' completions finish before the store is torn down.
    await drainRunCompletions();
  });

  it.each([
    {
      moved: "files were delivered while it reviewed",
      dispatchedOn: null,
      task: { workRevision: null, branch: null, deliveredAt: "2026-09-28T08:37:02.629Z" },
      verdict: "approve" as const,
      says: "Review & validation approved, but it started before the files on this task were delivered",
    },
    {
      moved: "the files were delivered again",
      dispatchedOn: "files:2026-09-28T08:26:00.000Z",
      task: { workRevision: null, branch: null, deliveredAt: "2026-09-28T08:37:02.629Z" },
      verdict: "request_changes" as const,
      says: "Review & validation requested changes, but the files on this task were delivered again while it was reviewing them",
    },
    {
      moved: "a new revision was delivered",
      dispatchedOn: "rev_0",
      task: {},
      verdict: "approve" as const,
      says: `Review & validation approved, but \`${"a".repeat(12)}\` was delivered while it was reviewing the revision before it`,
    },
  ])("ruling 544: a verdict does not bind when $moved during its run", async ({ dispatchedOn, task, verdict, says }) => {
    // CANARY: drop `!moved` from the binding in recordAgentCompletion and the
    // verdict binds to the delivery the reviewer never read.
    writeReviewTask(task);
    const summary = "Checked every line item against the pricing pages.";
    const runId = await finishedRunWith(summary, dispatchedOn);
    stageOutcome(store.db, `oc-${runId}`, { summary, verdict });
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        outcomeKey: `oc-${runId}`,
      },
      { id: runId, state: "finished" },
    );
    const parsed = taskFile().parsed;
    expect(parsed.frontmatter.verdicts).toEqual([]);
    expect(parsed.frontmatter.validation).toBe("changed");
    expect(parsed.timeline.find((e) => e.type === "quality")?.text).toBe(
      `**Validation:** changed. ${says}, so the verdict does not bind to what is delivered now. Run the review again.`,
    );
    expect(
      acceptanceRefusalFor({ projectSlug: store.slug, taskKey: "VIB-1" }, { dataRoot: store.dataRoot }),
    ).not.toBeNull();
  });

  it("ruling 544: a verdict binds when the subject it was dispatched on is still delivered", async () => {
    writeReviewTask();
    const summary = "Approved at the pinned head.";
    const runId = await finishedRunWith(summary, "rev_1");
    stageOutcome(store.db, `oc-${runId}`, { summary, verdict: "approve" });
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "reviewer",
        role: "Review & validation",
        delivers: false,
        workdir: null,
        agentHandle: "reviewer",
        outcomeKey: `oc-${runId}`,
      },
      { id: runId, state: "finished" },
    );
    expect(
      taskFile().parsed.frontmatter.verdicts.map((v) => [v.revisionId, v.result]),
    ).toEqual([["rev_1", "approve"]]);
  });

  it("ruling 105 review: an ERRORED run keeps its working artifacts (its only diagnostics)", async () => {
    // A crashed browsing run never got to cite anything — the citation escape
    // hatch is structurally unreachable on the failure path, so pruning there
    // deletes the console dump a human needs to diagnose the crash.
    writeReviewTask();
    const dump = "console-2026-08-31T16-00-00-000Z.log";
    const runId = await finishedRunWith("partial output before the crash");
    const dir = saveInRunWindow(runId, [dump]);
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
    const dir = saveInRunWindow(runId, [siblingFile]);
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

  it("ruling 593: beside a live sibling a run deletes nothing and claims only the working files it cited", async () => {
    // Live on AWSC-32 the Estimate Judge finished while the Workflow Researcher
    // was still running, and its verdict claimed twenty browser snapshots it
    // never cited; the researcher's completion would then have deleted them
    // from under that entry. CANARY: claim every file in the window again.
    writeReviewTask();
    const cited = "page-2026-09-29T15-57-08-711Z.yml";
    const uncited = "page-2026-09-29T16-02-40-517Z.yml";
    const screenshot = "page-2026-09-29T16-03-02-723Z.png";
    const runId = await finishedRunWith(
      `Checked the live form; the field list is in \`${cited}\`.\nVerdict: approve — the rows match.`,
    );
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO agent_runs (id, task_key, project_slug, thread_id, role, kind,
           backend, model, state, started_at, created_at, updated_at, agent_profile_id)
         VALUES ('run_sibling', 'VIB-1', ?, 'th_sibling', 'Developer', 'primary',
           'claude', 'sonnet', 'running', ?, ?, ?, 'developer')`,
      )
      .run(store.slug, now, now, now);
    const dir = saveInRunWindow(runId, [cited, uncited, screenshot]);
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
    for (const name of [cited, uncited, screenshot]) expect(existsSync(path.join(dir, name))).toBe(true);
    const claimed = taskFile().parsed.timeline.flatMap((e) => e.attachments ?? []);
    expect(claimed).toContain(cited);
    expect(claimed).not.toContain(uncited);
    // Ruling 627: nor a file of any kind it does not name.
    expect(claimed).not.toContain(screenshot);
  });

  /** A sibling run row on VIB-1, of `kind`, live or finished at `finishedAt`. */
  function insertSiblingRun(kind: "primary" | "operator", finishedAt: string | null): void {
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO agent_runs (id, task_key, project_slug, thread_id, role, kind,
           backend, model, state, started_at, created_at, updated_at, agent_profile_id, finished_at)
         VALUES ('run_sibling', 'VIB-1', ?, 'th_sibling', 'Workflow Researcher', ?,
           'codex', 'gpt-6-luna', ?, ?, ?, ?, 'developer', ?)`,
      )
      .run(store.slug, kind, finishedAt ? "finished" : "running", now, now, now, finishedAt);
  }

  it.each([
    { sibling: "a live specialist run", kind: "primary", live: true, claims: "only the files it names" },
    { sibling: "a specialist run that finished inside its window", kind: "primary", live: false, claims: "only the files it names" },
    { sibling: "a live operator run", kind: "operator", live: true, claims: "its whole window" },
  ] as const)(
    "ruling 627: beside $sibling, a run that does not deliver claims $claims",
    async ({ kind, live, claims }) => {
      // Live on AWSC-80 the Estimate Judge, told to save no file, finished nine
      // seconds after the Workflow Researcher saved round-6-comparison.md, and
      // its comment claimed the deliverable. A sibling that finished first
      // leaves the same file in the window. The operator saves no file of its
      // own. CANARY: claim every kept file of the window again.
      writeReviewTask();
      const runId = await finishedRunWith("Redid the R6-10 score; my working is in `rescore-note.md`.");
      insertSiblingRun(kind, live ? null : getRun(store.db, runId)!.finished_at!);
      const names = ["round-6-comparison.md", "rescore-note.md", "page-2026-10-01T22-01-20-000Z.png"];
      const dir = saveInRunWindow(runId, names);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "codex",
          profileId: "reviewer",
          role: "Estimate Judge",
          delivers: false,
          workdir: null,
          agentHandle: "reviewer",
        },
        { id: runId, state: "finished" },
      );
      for (const name of names) expect(existsSync(path.join(dir, name))).toBe(true);
      const claimed = taskFile().parsed.timeline.flatMap((e) => e.attachments ?? []);
      expect(claimed.sort()).toEqual(claims === "its whole window" ? [...names].sort() : ["rescore-note.md"]);
    },
  );

  it("ruling 593: the prune keeps a working file another entry of its window cites in evidence or claims", async () => {
    // The Judge's verdict cited its snapshots in evidence rows, not in its
    // text, and claimed them on its entry. CANARY: read only each entry's text
    // into the citation corpus again.
    writeReviewTask();
    const inEvidence = "page-2026-09-29T15-57-08-711Z.yml";
    const claimedByOther = "page-2026-09-29T16-01-03-523Z.yml";
    const nobodys = "page-2026-09-29T16-02-40-517Z.yml";
    const runId = await finishedRunWith("Reworked the report.");
    const dir = saveInRunWindow(runId, [inEvidence, claimedByOther, nobodys]);
    const { appendTimelineEvent } = await import("~/server/files/task-writer.server");
    await appendTimelineEvent(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      {
        occurredAt: new Date().toISOString(),
        type: "quality",
        actor: { kind: "agent", backend: "codex", profileId: "estimate-judge", roleHint: "Estimate Judge" },
        title: "Changes requested",
        text: "**Validation:** failing.",
        toAgent: false,
        evidence: [{ label: `Live EFS form, ${inEvidence}`, result: "four fields missing", status: "fail" }],
        attachments: [claimedByOther],
      },
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
    expect(existsSync(path.join(dir, inEvidence))).toBe(true);
    expect(existsSync(path.join(dir, claimedByOther))).toBe(true);
    expect(existsSync(path.join(dir, nobodys))).toBe(false);
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
  it("ruling 326: a refused option set falls back to the stock one — a stalled task always gets a packet", async () => {
    /**
     * `operatorOpenPacket`'s authoring guards exist to COACH the operator: it
     * reads the refusal, revises its options and tries again, and the messages
     * are written that way — "Offer the OTHER backend, or offer wait_for_window
     * with dueAt set to the reopen instant". `openStuckLoopPacket` has no such
     * loop. It composed the options itself, so a refusal there ended with a
     * stalled task and NO packet at all, which is strictly worse than a packet
     * with one fewer option.
     *
     * Live: eleven times in four days on the shopify-clone board, in three
     * bursts, every one inside the window where Codex was out of quota.
     *
     * CANARY: delete the fallback retry in `openStuckLoopPacket`.
     */
    deployOperator();
    // The owner has BOTH backends, and the other one is out of quota — the
    // exact live shape. `describeRunFailure` no longer composes the retry
    // (ruling 326's first half), so force the refusal directly: an option set
    // whose `resolve_remote_collision` has no collision to clear is refused by
    // an authoring guard the same way.
    writeReviewTask({ validation: "changed" });
    const runId = await finishedRunWith("The credential was rejected again.");
    const { openStuckLoopPacket } = await import("./task-escalations.server");
    await openStuckLoopPacket(
      store.db,
      { dataRoot: store.dataRoot, operatorAuthorized: true },
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        agentHandle: "reviewer",
        reason: "Claude refused the agent run: the provider rejected the credential.",
        options: [
          {
            kind: "resolve_remote_collision",
            title: "Clear the branch collision",
            detail: "There is no collision on this task, so authoring refuses this whole packet.",
            recommended: true,
          },
        ],
      },
    );
    void runId;

    const packet = taskFile().parsed.packet;
    expect(packet, "a stalled task got no packet at all").not.toBeNull();
    // The stock set, which carries no conditional kinds.
    expect(packet!.options.map((o) => o.kind)).toEqual([
      "redirect",
      "request_edit",
      "hold_runtime_debug",
    ]);
    // ...and it says what it could not offer, and why, rather than presenting
    // the general options as if they were the considered ones.
    const withheld = packet!.observations.find((o) => o.k === "Tailored options withheld");
    expect(withheld, "the packet hides that a better option set was refused").toBeTruthy();
    expect(withheld!.v).toContain("refused its own packet");
    // Ruling 432: the fallback is still a stall, so a later clean run may
    // still withdraw it.
    expect(packet!.stalled).toBe(true);
  });

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
    await pollUntil(() =>
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
    deployOperator();
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
    // Ruling 362 reaches the boundary first: the approve resets the depth and
    // the chain continues (the operator files the recommendation itself rather
    // than the 15-minute sweep). The skip arm below it remains for a chain that
    // reaches the cap on an acceptable task with a reply that is NOT an approve.
    expect(
      skipLog.mock.calls.some(([msg]) => String(msg).includes("react depth reset")),
    ).toBe(true);
    // And acceptance is still open, which is the whole point.
    expect(
      acceptanceRefusalFor(
        { projectSlug: store.slug, taskKey: "VIB-1" },
        { dataRoot: store.dataRoot },
      ),
    ).toBeNull();
  });

  /**
   * Ruling 362 (pass 38, F38-16): an approve is a boundary for the depth count.
   *
   * Live on BNB-16: the code reviewer approved the rework at Review, the
   * verifier's stage still ahead — so the task was NOT acceptable and ruling
   * 258's arm did not apply — and 0.1 s later the depth cap opened "Work
   * stalled: pick a recovery path" with redirect / send back / hold, each of
   * them re-running work that had just passed. Five of five such packets on
   * the instance followed an approve; every person answered "nothing is
   * stalled" and the approved work waited hours for it.
   */
  it("ruling 362: an approve at the depth cap on a task that is NOT yet acceptable opens no stuck packet — the chain continues from a fresh depth", async () => {
    deployOperator();
    // Two verdict-capable reviewers engaged; only `reviewer` judges here, so
    // the task stays un-acceptable after its approve (the verifier's verdict is
    // owed) — BNB-16's shape.
    writeReviewTask({
      validation: "changed",
      engagements: [
        DEV_DELIVERS_ENGAGEMENT,
        REVIEWER_ENGAGEMENT,
        { ...REVIEWER_ENGAGEMENT, profileId: "verifier", role: "Integration verifier" },
      ],
    });
    const summary = "Approved at the pinned head; every check in the done signal is proven.";
    const runId = await finishedRunWith(summary);
    stageOutcome(store.db, `oc-${runId}`, { summary, verdict: "approve" });
    const operatorRuns = () =>
      // SAFETY: COUNT(*) over this store's own table is always an integer.
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM agent_runs WHERE project_slug = ? AND kind = 'operator'`,
          )
          .get(store.slug) as { n: number }
      ).n;
    const before = operatorRuns();
    const log = vi.spyOn(logger, "info");
    log.mockClear();
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
        // At the cap, which is what fired on BNB-16.
        operatorRun: { backend: "claude", autonomy: "full", reactDepth: 99 },
      },
      { id: runId, state: "finished" },
    );
    await new Promise((r) => setTimeout(r, 80));

    // Premises: the approve was recorded, and the task is still not acceptable.
    expect(
      taskFile().parsed.frontmatter.verdicts.map((v) => [v.profileId, v.result]),
    ).toEqual([["reviewer", "approve"]]);
    expect(
      acceptanceRefusalFor(
        { projectSlug: store.slug, taskKey: "VIB-1" },
        { dataRoot: store.dataRoot },
      ),
    ).not.toBeNull();
    // CANARY: drop the ruling-362 reset and "Work stalled: pick a recovery
    // path" opens here — three options, every one of them re-running work that
    // passed — and no operator turn follows the approve.
    expect(taskFile().parsed.packet).toBeNull();
    expect(
      log.mock.calls.some(([msg]) => String(msg).includes("react depth reset")),
    ).toBe(true);
    // The operator was re-invoked (a react at a fresh depth), not parked.
    await pollUntil(() => operatorRuns() > before);
    expect(operatorRuns()).toBe(before + 1);
  });

  /**
   * Ruling 489 (pass 40, F40-68): a reply that MOVED the task's head is a
   * boundary for the depth count, like an approve (ruling 362).
   *
   * Live on WEB-8 the Site Engineer reported its rework done: the new head
   * 178dc22 merged main in and fixed every reviewer finding, and Viberr's gates
   * passed 6/6 on it a second later. The chain had spent its four hops, so the
   * completion opened "Work stalled: pick a recovery path" — three options,
   * each re-dispatching the work that had just finished, and nothing on the
   * packet about the report or the head it left undelivered.
   */
  describe("ruling 489: progress resets the react depth, and the capped packet says where the work stands", () => {
    const operatorRuns = () =>
      // SAFETY: COUNT(*) over this store's own table is always an integer.
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM agent_runs WHERE project_slug = ? AND kind = 'operator'`,
          )
          .get(store.slug) as { n: number }
      ).n;
    const OLD_HEAD = "a".repeat(40);
    const NEW_HEAD = "b".repeat(40);
    const PR_7 = {
      number: 7,
      state: "review" as const,
      title: "[VIB-1] Task VIB-1",
      headSha: OLD_HEAD,
    };
    /** The delivering developer's completion, at the depth cap. */
    async function completeDeveloperAtCap(runId: string): Promise<void> {
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "claude",
          profileId: "dev",
          role: "Implementation",
          delivers: true,
          workdir: null,
          agentHandle: "dev",
          // OPERATOR_REACT_DEPTH_CAP: the chain has spent its four hops.
          operatorRun: { backend: "claude", autonomy: "supervised", reactDepth: 4 },
        },
        { id: runId, state: "finished" },
      );
      await new Promise((r) => setTimeout(r, 80));
    }

    it("a reply at the cap that committed a new head opens no stuck packet — the operator reacts from a fresh depth", async () => {
      // A person approves the move out of In Progress here, so the react turn
      // that stops there is not stranded and the settle adds no nudge to count.
      approveReviewEntry(store);
      deployOperator();
      writeReviewTask({ stage: "impl", validation: "changed", pr: PR_7 });
      const runId = await finishedRunWith(
        "Rework done: merged main in and fixed all four findings.",
      );
      // What the workspace reconcile writes when a delivering run leaves a new
      // tree behind: a fresh revision from the checkout's head, stamped when it
      // is minted. The reconcile needs a git checkout this fixture does not
      // have (`repo: null`), so its write is made here, after the run's row
      // was created, exactly as the reconcile's lands.
      await updateTaskFile(
        { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
        (f) => {
          f.frontmatter.workRevision = {
            id: "rev_2",
            headSha: NEW_HEAD,
            treeSha: "u".repeat(40),
            branch: "vib-1-work",
            createdAt: new Date().toISOString(),
            sourceProfileId: "dev",
            kind: "delivered",
          };
        },
      );
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      const before = operatorRuns();
      const log = vi.spyOn(logger, "info");
      log.mockClear();

      await completeDeveloperAtCap(runId);

      // CANARY: drop the ruling-489 reset and "Work stalled: pick a recovery
      // path" opens here over the rework that just landed, and no operator
      // turn follows it.
      expect(taskFile().parsed.packet).toBeNull();
      expect(
        log.mock.calls.some(([msg]) => String(msg).includes("moved the task's head")),
      ).toBe(true);
      await pollUntil(() => operatorRuns() > before);
      expect(operatorRuns()).toBe(before + 1);
    });

    it("a reply at the cap that left the head where it was still opens the stuck packet, as before", async () => {
      deployOperator();
      // The revision under review was minted long before this hop, and PR #7
      // carries it: nothing moved and nothing is owed a delivery.
      writeReviewTask({ stage: "impl", validation: "changed", pr: PR_7 });
      const runId = await finishedRunWith("Still chasing the flaky test; nothing committed yet.");
      const before = operatorRuns();

      await completeDeveloperAtCap(runId);

      // CANARY: count any revision on record as this hop's (drop the `since`
      // comparison in `headMovedSince`) and the chain runs on with no packet —
      // a loop that gets nowhere is no longer capped.
      const packet = taskFile().parsed.packet;
      expect(packet?.title).toBe("Work stalled: pick a recovery path");
      expect(packet!.body).toContain("4-cycle depth cap without reaching a boundary");
      // CANARY: drop `stalled: true` from `openStuckLoopPacket`'s packet.
      expect(packet!.stalled, "ruling 432: the server's own stall escalation carries the marker").toBe(true);
      expect(operatorRuns()).toBe(before);
      // The head is named, and it is delivered, so the general options stand.
      // CANARY: read every head as undelivered in `taskHeadState` and a
      // delivery is recommended over a head PR #7 already carries.
      expect(packet!.body).toContain("The task's head is `aaaaaaa`, delivered: PR #7 carries it.");
      expect(packet!.options.map((o) => [o.kind, o.rec])).toEqual([
        ["redirect", true],
        ["request_edit", false],
        ["hold_runtime_debug", false],
      ]);
    });

    /**
     * Ruling 613: a task whose deliverable is files is delivered by moving
     * `deliveredAt`, never by a work revision. Live on AWSC-71 the Calculator
     * Builder delivered the Judge's two fixes and the fourth hop opened "Work
     * stalled" over the rework it had just delivered.
     */
    async function completeFilesDelivererAtCap(runId: string): Promise<void> {
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "codex",
          profileId: "reviewer",
          role: "Calculator Builder",
          delivers: true,
          workdir: null,
          agentHandle: "reviewer",
          operatorRun: { backend: "claude", autonomy: "supervised", reactDepth: 4 },
        },
        { id: runId, state: "finished" },
      );
      await new Promise((r) => setTimeout(r, 80));
    }
    const FILES_TASK: Parameters<typeof baseTaskFrontmatter>[1] = {
      stage: "impl",
      workRevision: null,
      validation: "none",
      engagements: [{ ...REVIEWER_ENGAGEMENT, delivers: true }],
    };

    it("ruling 613: a reply at the cap that delivered the task's files opens no stuck packet; the operator reacts from a fresh depth", async () => {
      approveReviewEntry(store);
      deployOperator();
      writeReviewTask({ ...FILES_TASK, deliveredAt: "2026-09-30T12:00:00.000Z" });
      const runId = await finishedRunWith("Added the requested comparison to assumptions.md.");
      saveInRunWindow(runId, ["assumptions.md"]);
      const before = operatorRuns();
      const log = vi.spyOn(logger, "info");
      log.mockClear();

      await completeFilesDelivererAtCap(runId);

      // The delivery the run made is this hop's: the stamp moved past the run's start.
      expect(taskFile().parsed.frontmatter.deliveredAt).not.toBe("2026-09-30T12:00:00.000Z");
      // CANARY: read only the work revision for progress and "Work stalled:
      // pick a recovery path" opens over the files just delivered.
      expect(taskFile().parsed.packet).toBeNull();
      expect(
        log.mock.calls.some(([msg]) => String(msg).includes("delivered the task's files")),
      ).toBe(true);
      await pollUntil(() => operatorRuns() > before);
      expect(operatorRuns()).toBe(before + 1);
    });

    it("ruling 613: a delivery from before the hop is not its progress, and the capped packet names it", async () => {
      deployOperator();
      writeReviewTask({ ...FILES_TASK, deliveredAt: "2026-09-30T12:00:00.000Z" });
      // The reply saves nothing, so the delivery stays where an earlier hop put it.
      const runId = await finishedRunWith("Still checking the FSx rates; nothing saved yet.");
      const before = operatorRuns();

      await completeFilesDelivererAtCap(runId);

      // CANARY: drop the `since` comparison in `filesDeliveredSince` and any
      // delivery on record resets the depth, so a loop that gets nowhere on a
      // files task is no longer capped.
      const packet = taskFile().parsed.packet;
      expect(packet?.title).toBe("Work stalled: pick a recovery path");
      expect(operatorRuns()).toBe(before);
      // CANARY: keep "No committed head is on record" for a files delivery.
      expect(packet!.body).toContain("The task's files were last delivered at 2026-09-30T12:00:00.000Z.");
      expect(packet!.body).not.toContain("No committed head");
    });

    it("the capped packet quotes the report, names the head and the gates, recommends delivering an undelivered head, and confirming it delivers", async () => {
      deployOperator();
      const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
      writeProject(store.dataRoot, {
        ...pf.parsed.frontmatter,
        gates: [{ name: "test", command: "npm test" }],
      });
      // An earlier hop's rework committed NEW_HEAD, the gates passed on it,
      // and nothing delivered it: PR #7 still carries the old head.
      writeReviewTask({
        stage: "impl",
        validation: "changed",
        workRevision: {
          ...workRev("rev_2"),
          headSha: NEW_HEAD,
          treeSha: "u".repeat(40),
          createdAt: "2026-07-05T00:00:00.000Z",
        },
        pr: PR_7,
        gateRun: {
          id: "gate_1",
          revisionId: "rev_2",
          headSha: NEW_HEAD,
          status: "finished",
          reason: "revision",
          requestedAt: "2026-07-05T00:00:01.000Z",
          startedAt: "2026-07-05T00:00:01.000Z",
          finishedAt: "2026-07-05T00:00:03.000Z",
          error: null,
          results: [
            { name: "test", command: "npm test", exitCode: 0, timedOut: false, wallMs: 1200, log: null },
          ],
        },
      });
      const runId = await finishedRunWith(
        "## Rework committed as bbbbbbb: merged main in and fixed the four findings.\n\n" +
          "The details follow, finding by finding.",
      );

      await completeDeveloperAtCap(runId);

      const packet = taskFile().parsed.packet;
      expect(packet?.title).toBe("Work stalled: pick a recovery path");
      // CANARY: stop passing the standings to the packet and none of these
      // three sentences is on it — the WEB-8 body, which said nothing of the
      // report and nothing of the head.
      expect(packet!.body).toContain(
        "The last report, from @dev: “Rework committed as bbbbbbb: merged main in and fixed the four findings.”",
      );
      expect(packet!.body).not.toContain("finding by finding");
      expect(packet!.body).toContain(
        "The task's head is `bbbbbbb`, committed and NOT delivered: PR #7 still carries `aaaaaaa`.",
      );
      expect(packet!.body).toContain("Gates on bbbbbbb: 1/1 exit 0 (run by Viberr).");
      // CANARY: drop the delivery option and the general three come back
      // alone, redirect recommended — every one of them redoing finished work.
      expect(packet!.options.map((o) => [o.kind, o.rec])).toEqual([
        ["deliver_for_review", true],
        ["redirect", false],
        ["request_edit", false],
        ["hold_runtime_debug", false],
      ]);
      expect(packet!.options[0]!.t).toBe("Deliver bbbbbbb for review");

      // Confirming it performs the delivery, through the delivery's own seams.
      const push = vi.fn<typeof pushWorkspaceBranch>(async () => ({
        status: "pushed",
        branch: "vib-1-work",
        commits: 1,
        headSha: NEW_HEAD,
        remoteHeadBefore: OLD_HEAD,
        workflowFiles: [],
      }));
      const openPr = vi.fn<typeof openTaskPr>(async () => ({
        status: "ok",
        prNumber: 7,
        created: false,
        url: "http://x/pull/7",
      }));
      const runOp = vi.fn<typeof runOperator>(async () => ({
        runId: null,
        queued: true,
        backend: "claude" as const,
        autonomy: "supervised" as const,
      }));
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actorOf(store.users.arda),
        {
          dataRoot: store.dataRoot,
          deps: { pushWorkspaceBranch: push, openTaskPr: openPr, runOperator: runOp },
        },
      );

      // CANARY: drop the resolution's delivery arm and the packet clears with
      // nothing pushed.
      expect(push).toHaveBeenCalledTimes(1);
      expect(openPr).toHaveBeenCalledTimes(1);
      const after = taskFile();
      expect(after.parsed.packet).toBeNull();
      expect(after.parsed.frontmatter.workRevision?.pushedAt).toBeTruthy();
      expect(after.parsed.frontmatter.pr?.headSha).toBe(NEW_HEAD);
      expect(
        listAuditEvents(store.db, { action: "github.delivery.manual" }).map(
          (e) => e.details?.status,
        ),
      ).toEqual(["delivered"]);
      // One hand-off, carrying Viberr's own record of what the option did.
      await pollUntil(() => runOp.mock.calls.length > 0);
      expect(runOp).toHaveBeenCalledTimes(1);
      expect(runOp.mock.calls[0]![1]).toMatchObject({
        trigger: "packet-resolved",
        resolvedOption: {
          kind: "deliver_for_review",
          serverOutcome: {
            kind: "deliver_for_review",
            outcome: "delivered",
            prNumber: 7,
            headSha: NEW_HEAD,
          },
        },
      });
    });

    /**
     * Ruling 489(d): the ceiling progress does not reset. With the depth reset
     * above, a chain whose every hop commits a new head (the operator
     * re-dispatching a developer, no reviewer to object) had no bound at all.
     */
    it("a chain that commits a new head on every hop stops at the hop ceiling with the packet", async () => {
      deployOperator();
      writeReviewTask({ stage: "impl", validation: "changed", pr: PR_7 });
      const runOp = vi.fn<typeof runOperator>(async () => ({
        runId: null,
        queued: true,
        backend: "claude" as const,
        autonomy: "supervised" as const,
      }));
      // The drive a person started: no hops yet. Every later hop's chain state
      // is exactly what the previous react handed the operator.
      let chain = { reactDepth: 0, reactHops: 0 };
      for (let hop = 0; hop <= OPERATOR_REACT_HOP_CEILING; hop += 1) {
        const runId = await finishedRunWith(`Pass ${hop}: committed the next slice.`);
        // Each hop leaves a new tree behind, so the reconcile mints a revision.
        await updateTaskFile(
          { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
          (f) => {
            f.frontmatter.workRevision = {
              id: `rev_hop_${hop}`,
              headSha: hop.toString(16).padStart(40, "c"),
              treeSha: hop.toString(16).padStart(40, "d"),
              branch: "vib-1-work",
              createdAt: new Date().toISOString(),
              sourceProfileId: "dev",
              kind: "delivered",
            };
          },
        );
        rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
        const reactsBefore = runOp.mock.calls.length;
        await applyAgentCompletionEffects(
          store.db,
          { dataRoot: store.dataRoot, deps: { runOperator: runOp } },
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            backend: "claude",
            profileId: "dev",
            role: "Implementation",
            delivers: true,
            workdir: null,
            agentHandle: "dev",
            operatorRun: { backend: "claude", autonomy: "supervised", ...chain },
          },
          { id: runId, state: "finished" },
        );
        if (hop < OPERATOR_REACT_HOP_CEILING) {
          // Progress keeps the depth at 1, far under its cap: only the ceiling
          // can stop this chain. CANARY: let progress reset the hop count too
          // (or stop adding one per hop) and it never reaches the ceiling.
          expect(runOp.mock.calls.length, `hop ${hop} reacted`).toBe(reactsBefore + 1);
          const next = runOp.mock.calls.at(-1)![1];
          expect(next.reactDepth).toBe(1);
          expect(next.reactHops).toBe(hop + 1);
          chain = { reactDepth: next.reactDepth ?? 0, reactHops: next.reactHops ?? 0 };
          expect(taskFile().parsed.packet).toBeNull();
        }
      }

      // CANARY: drop the ceiling check and hop 12 reacts like the eleven before
      // it, with no packet and no bound.
      expect(runOp).toHaveBeenCalledTimes(OPERATOR_REACT_HOP_CEILING);
      const packet = taskFile().parsed.packet;
      expect(packet?.title).toBe("Work stalled: pick a recovery path");
      expect(packet!.body).toContain(
        "The chain made progress but ran 12 hops without a person or a boundary.",
      );
      // The same state lines as the depth-capped packet.
      expect(packet!.body).toContain("The last report, from @dev: “Pass 12: committed the next slice.”");
      expect(packet!.body).toContain("committed and NOT delivered: PR #7 still carries `aaaaaaa`.");
      expect(packet!.options[0]).toMatchObject({ kind: "deliver_for_review", rec: true });
    });

    it("at the ceiling an approve still continues the chain, from zero", async () => {
      deployOperator();
      const runOp = vi.fn<typeof runOperator>(async () => ({
        runId: null,
        queued: true,
        backend: "claude" as const,
        autonomy: "supervised" as const,
      }));
      const atCeiling = {
        backend: "claude" as const,
        autonomy: "supervised" as const,
        reactDepth: 1,
        reactHops: OPERATOR_REACT_HOP_CEILING,
      };
      // Ruling 362's shape: an approve with a second verdict still owed.
      writeReviewTask({
        validation: "changed",
        engagements: [
          DEV_DELIVERS_ENGAGEMENT,
          REVIEWER_ENGAGEMENT,
          { ...REVIEWER_ENGAGEMENT, profileId: "verifier", role: "Integration verifier" },
        ],
      });
      const summary = "Approved at the pinned head.";
      const approveRun = await finishedRunWith(summary);
      stageOutcome(store.db, `oc-${approveRun}`, { summary, verdict: "approve" });
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot, deps: { runOperator: runOp } },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "claude",
          profileId: "reviewer",
          role: "Reviewer",
          delivers: false,
          workdir: null,
          agentHandle: "reviewer",
          outcomeKey: `oc-${approveRun}`,
          operatorRun: atCeiling,
        },
        { id: approveRun, state: "finished" },
      );
      // CANARY: stop an approve restarting the hop count and the ceiling opens
      // "Work stalled" over an approve — BNB-16 again.
      expect(taskFile().parsed.packet).toBeNull();
      expect(runOp).toHaveBeenCalledTimes(1);
      expect(runOp.mock.calls[0]![1]).toMatchObject({ reactDepth: 1, reactHops: 1 });
    });

    it("at the ceiling an acceptable task still gets no packet", async () => {
      deployOperator();
      const runOp = vi.fn<typeof runOperator>(async () => ({
        runId: null,
        queued: true,
        backend: "claude" as const,
        autonomy: "supervised" as const,
      }));
      const atCeiling = {
        backend: "claude" as const,
        autonomy: "supervised" as const,
        reactDepth: 1,
        reactHops: OPERATOR_REACT_HOP_CEILING,
      };
      // Ruling 258's shape: the task is acceptable, and the reply at the
      // ceiling is not an approve.
      writeReviewTask({
        validation: "healthy",
        pr: { number: 7, state: "review", title: "[VIB-1] Task VIB-1" },
      });
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
      expect(
        acceptanceRefusalFor({ projectSlug: store.slug, taskKey: "VIB-1" }, { dataRoot: store.dataRoot }),
      ).toBeNull();
      const notesRun = await finishedRunWith("Release notes tidied; nothing else to do.");
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot, deps: { runOperator: runOp } },
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          backend: "claude",
          profileId: "dev",
          role: "Implementation",
          delivers: true,
          workdir: null,
          agentHandle: "dev",
          operatorRun: atCeiling,
        },
        { id: notesRun, state: "finished" },
      );
      // CANARY: leave the ceiling out of ruling 258's check and the packet
      // opens and blocks the acceptance it should wait for.
      expect(taskFile().parsed.packet).toBeNull();
      // The chain still ends at the ceiling: no operator turn follows.
      expect(runOp).not.toHaveBeenCalled();
    });
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
    /** Ruling 242: the deliverer took a turn. A run row is the whole signal,
     *  whatever its state, because a rework that was dispatched and crashed
     *  still means a round was fought. Ruling 416 carves out one state: a run
     *  the PROVIDER refused fought nothing (see the deadlock block below). */
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
        // Ruling 481(a): the Codex door files the question as `question` too.
        `SELECT title, actor_json FROM notifications WHERE kind = 'question' AND task_key = 'VIB-1'`,
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
  describe("ruling 237 as amended by 410: the THIRD consecutive objection escalates to a person", () => {
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

    /**
     * Ruling 416: a deliverer run that ENDED in error, classified as `kind`.
     * `quota` is the provider refusing it; `idle_timeout` is the run hanging
     * mid-work, which is the crash ruling 242 still counts.
     */
    const erroredRework = (kind: "quota" | "idle_timeout"): void => {
      delivererRuns += 1;
      const id = `run_rework_${delivererRuns}`;
      upsertRun(store.db, {
        id,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId: `rework-${delivererRuns}`,
        role: "Developer",
        kind: "primary",
        backend: "codex",
        model: "gpt-5.6-luna",
        sdk: "codex",
        agentName: "dev",
        agentProfileId: "dev",
        state: "error",
      });
      insertRunLine(store.db, {
        runId: id,
        seq: 0,
        occurredAt: new Date().toISOString(),
        raw: "",
        display: {
          t: "00:00:01",
          ev: "err",
          tag: `run·error·${kind}`,
          text:
            kind === "quota"
              ? "Codex refused the agent run: the account is over its usage limit."
              : "The run produced nothing for the whole idle window.",
          failure: emptyRunFailureFacts(kind),
        },
      });
    };
    /** A verdict with NO rework dispatched before it (`review` always reworks). */
    const reviewOnly = async (reply: string) => {
      const runId = await finishedRunWith(reply);
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        reviewerInput("reviewer"),
        { id: runId, state: "finished" },
      );
    };
    const roundsOnTheRevision = () => taskFile().parsed.frontmatter.verdicts[0]?.rounds;

    it("ruling 416: a rework the PROVIDER refused fought no round, a crash still did, and a repeat keeps the rounds fought", async () => {
      // Live on ax-clone AX-19: the rework was refused for quota three minutes
      // in, with nothing committed, and the reviewer's next verdict on the
      // untouched revision counted as a sixth round.
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      expect(roundsOnTheRevision()).toBe(2);

      // CANARY (a): count every errored run again and this reads 3.
      // CANARY (b): let a repeat with no round behind it fall back to 1, as it
      // did, and this reads 1: an answer took a fought round OFF the count.
      erroredRework("quota");
      await reviewOnly(blocks(3));
      expect(roundsOnTheRevision()).toBe(2);
      expect(taskFile().parsed.packet, "two rounds, however many verdicts, is not a deadlock").toBeNull();

      // A rework that hung mid-work is still a round fought (ruling 242 stands).
      erroredRework("idle_timeout");
      await reviewOnly(blocks(4));
      expect(roundsOnTheRevision()).toBe(3);
      expect(taskFile().parsed.packet?.title).toContain("requested changes 3 times running");
    });

    it("ruling 416: the packet on an objection with no rework behind it recommends one rework against it, never asking again", async () => {
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      await review(blocks(3));
      const first = taskFile().parsed.packet!;
      // A fought third round: the question is still the recommended move.
      expect(first.options.find((o) => o.rec)?.kind).toBe("question_reviewer");

      // A person answers it (cleared here), the rework is refused for quota,
      // and the reviewer reads the untouched revision again: its answer.
      const { updateTaskFile } = await import("~/server/files/task-writer.server");
      await updateTaskFile(
        { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
        (f) => {
          f.packet = null;
        },
      );
      erroredRework("quota");
      await reviewOnly(blocks(4));

      const raised = taskFile().parsed.packet!;
      // CANARY: pass `noReworkBehind: false` from the verdict writer and the
      // recommended option is the question the reviewer has just answered.
      const recommended = raised.options.filter((o) => o.rec);
      expect(recommended.map((o) => o.t)).toEqual(["Rework once against this verdict"]);
      expect(recommended[0]!.kind).toBe("custom");
      const question = raised.options.find((o) => o.kind === "question_reviewer")!;
      expect(question.rec).toBe(false);
      expect(question.d).toContain("asking again repeats that");
      expect(raised.body).toContain("no rework behind it");
      expect(raised.body).not.toContain("So either it did");
    });

    it("ruling 416(b): an answer given EARLIER in the streak is not recommended again either", async () => {
      // Live on ax-clone AX-24: round two at 20:35, the operator put the
      // completeness question, the reviewer answered on the untouched revision
      // at 20:45, one rework followed, and the round-three packet at 21:08
      // recommended "Ask Reviewer what else it would block on".
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      await reviewOnly(blocks(3)); // the answer: nothing reworked behind it
      expect(taskFile().parsed.frontmatter.verdicts[0]).toMatchObject({ rounds: 2, reviews: 3 });
      await review(blocks(4)); // one rework against it, still objecting

      const raised = taskFile().parsed.packet!;
      expect(raised.title).toContain("requested changes 3 times running");
      // CANARY: drop `answeredOn` from `reviewDeadlockOf` (or stop recording
      // `reviews`) and the question is recommended on top of its own answer.
      expect(raised.options.filter((o) => o.rec).map((o) => o.t)).toEqual(["Let the rework continue"]);
      const question = raised.options.find((o) => o.kind === "question_reviewer")!;
      expect(question.rec).toBe(false);
      expect(question.d).toContain("in this streak; asking again repeats that");
      expect(raised.body).toContain("has been answered in this streak");
      expect(raised.body).not.toContain("So either it did");
    });

    /**
     * Ruling 421 (F39-43). The shape measured three times on ax-clone in 25
     * minutes: after a rework, the operator dispatched the review WITH ruling
     * 410's question folded in ("provide one complete verdict with every
     * remaining blocker"), the reviewer answered, and the packet that answer
     * raised recommended asking the question again, because nothing on record
     * said it had been asked.
     */
    const reviewAsked = async (reply: string, stampRun: "this" | "another" = "this") => {
      rework();
      const runId = await finishedRunWith(reply);
      const { updateTaskFile } = await import("~/server/files/task-writer.server");
      await updateTaskFile(
        { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
        (f) => {
          const own = f.frontmatter.engagements.find((e) => e.profileId === "reviewer");
          own!.question = {
            kind: "completeness",
            runId: stampRun === "this" ? runId : "run_some_other_dispatch",
            at: new Date().toISOString(),
          };
        },
      );
      await applyAgentCompletionEffects(
        store.db,
        { dataRoot: store.dataRoot },
        reviewerInput("reviewer"),
        { id: runId, state: "finished" },
      );
    };

    it("ruling 421: the verdict of a run that put the question IS the answer, and the packet it raises recommends one rework", async () => {
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      await reviewAsked(blocks(3));

      const verdict = taskFile().parsed.frontmatter.verdicts[0]!;
      // CANARY: drop the `answersQuestion` stamp in the verdict writer.
      expect(verdict.answers).toBe("completeness");
      // Consumed: the stamp answers exactly one verdict.
      expect(
        taskFile().parsed.frontmatter.engagements.find((e) => e.profileId === "reviewer")?.question ?? null,
      ).toBeNull();

      const raised = taskFile().parsed.packet!;
      expect(raised.title).toContain("requested changes 3 times running");
      // CANARY: stop passing `askedWithThisReview` to the packet builder and
      // the question is recommended on top of the answer it just received.
      expect(raised.options.filter((o) => o.rec).map((o) => o.t)).toEqual(["Rework once against this verdict"]);
      const question = raised.options.find((o) => o.kind === "question_reviewer")!;
      expect(question.rec).toBe(false);
      expect(question.d).toContain("It was asked this with its review of");
      expect(raised.body).toContain("answer to the completeness question");
      expect(raised.body).not.toContain("So either it did");
    });

    it("ruling 421: a stamp from another run never makes this verdict an answer", async () => {
      writeReviewTask();
      await review(blocks(1));
      await review(blocks(2));
      await reviewAsked(blocks(3), "another");
      // CANARY: match the stamp by kind alone, not by run id, and this verdict
      // is taken for an answer nobody asked for.
      expect(taskFile().parsed.frontmatter.verdicts[0]!.answers).toBeUndefined();
      const raised = taskFile().parsed.packet!;
      expect(raised.options.find((o) => o.rec)?.kind).toBe("question_reviewer");
    });

    it("ruling 421: an answer given with an EARLIER review in the streak is not asked for again either", async () => {
      writeReviewTask();
      await review(blocks(1));
      await reviewAsked(blocks(2)); // round two, the question folded in: answered
      await review(blocks(3)); // one rework against it, still objecting
      const raised = taskFile().parsed.packet!;
      expect(raised.options.filter((o) => o.rec).map((o) => o.t)).toEqual(["Let the rework continue"]);
      expect(raised.body).toContain("was asked for everything it would block on with its review of");
      expect(raised.body).not.toContain("read `");
    });

    it("ruling 328: an escalation skipped because another packet was open is raised when that one clears", async () => {
      /**
       * Ruling 237 raises the "N times running" packet from inside the locked
       * write that records the verdict, and skips it when a packet is already
       * open — which it must, since a task holds one packet. Nothing came back.
       *
       * So the escalation was attempted EXACTLY ONCE, and any unrelated packet
       * standing at that instant killed it for good. Ruling 326 established
       * what those packets usually are: a quota or credential failure, raised
       * in bursts across several tasks at once and nothing to do with the
       * review.
       *
       * Measured: five tasks on the shopify-clone board reached a second
       * consecutive request_changes and TWO never got the packet. SHOP-18's
       * second objection landed at 03:44:44 with a backend-failure packet open
       * (answered at 04:38:38); the task then ran another eight hours and ended
       * in a force-accept over a wedged Verify gate. SHOP-10 reached three
       * rounds the same way.
       *
       * CANARY: delete the `retryReviewDeadlockEscalation` call in resolvePacket.
       */
      writeReviewTask();
      await review(blocks(1));
      // Ruling 410: round two is the operator's and raises nothing, so the
      // round that ESCALATES is the third -- which is the one the unrelated
      // packet has to be standing in front of.
      await review(blocks(2));

      // An unrelated decision — a backend failure, the live shape — is open
      // when the escalating objection lands.
      const { updateTaskFile } = await import("~/server/files/task-writer.server");
      await updateTaskFile(
        { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
        (f) => {
          f.packet = {
            type: "blocked",
            kind: "Blocked decision",
            from: "operator",
            title: "Work stalled: pick a recovery path",
            body: "Claude refused the agent run: the usage window is spent.",
            observations: [],
            options: [
              { kind: "request_edit", t: "Send the agent back to continue", d: "", rec: true },
            ],
            // Ruling 432: what `openStuckLoopPacket` writes on every stall,
            // and what lets the run's success withdraw it below.
            stalled: true,
          };
        },
      );

      await review(blocks(3));

      // The automatic clear site: no person is involved at all. The verdict was
      // written while the stalled packet stood, so ruling 237 skipped the
      // escalation — and seconds later the SAME run's success auto-withdrew
      // that packet (withdrawSupersededStuckPacket), taking the escalation with
      // it. This path has fired ZERO times on the live board; the two real
      // misses came through the human resolution the sibling test drives. It is
      // covered because it is the same defect, not because it has bitten.
      const raised = taskFile().parsed.packet;
      expect(raised, "the escalation was dropped for good").not.toBeNull();
      expect(raised!.title).toContain("requested changes 3 times running");
      // ...and it says why it is arriving late, rather than appearing from
      // nowhere on a task whose last visible event was a packet withdrawal.
      const note = taskFile().parsed.timeline.find((e) =>
        e.text.includes("could not be raised then"),
      );
      expect(note, "a packet that arrives late says why").toBeTruthy();
      expect(note!.text).toContain("another decision was already open");
    });

    it("ruling 328: the same retry runs when a PERSON clears the packet that blocked it", async () => {
      // THE PATH THE TWO LIVE MISSES TOOK. An `input` packet is never
      // auto-withdrawn (`withdrawSupersededStuckPacket` returns on anything but
      // a stall, ruling 432), so it survives the run and a person answers it — which is
      // what happened on SHOP-18 at 04:38:38 and on SHOP-10 — and the
      // escalation ruling 237 skipped is owed just the same.
      // CANARY: delete the `retryReviewDeadlockEscalation` call in resolvePacket.
      writeReviewTask();
      await review(blocks(1));
      const { updateTaskFile } = await import("~/server/files/task-writer.server");
      await updateTaskFile(
        { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
        (f) => {
          f.packet = {
            type: "input",
            kind: "Decision required",
            from: "operator",
            title: "Which of the two contracts wins?",
            body: "They disagree on the availability field.",
            observations: [],
            options: [{ kind: "custom", t: "Answer in your own words", d: "", rec: true }],
          };
        },
      );
      await review(blocks(2));
      await review(blocks(3));
      expect(taskFile().parsed.packet?.title).toBe("Which of the two contracts wins?");

      const { resolvePacket } = await import("./packet-resolution.server");
      await resolvePacket(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          optionIndex: 0,
          custom: "The published read wins; narrow the producer.",
        },
        { userId: store.users.arda.id, label: store.users.arda.email },
        { dataRoot: store.dataRoot },
      );

      const raised = taskFile().parsed.packet;
      expect(raised, "the escalation was dropped when the person answered").not.toBeNull();
      expect(raised!.title).toContain("requested changes 3 times running");

      // A packet that arrives with nobody told is not an escalation. The first
      // draft of this retry wrote the packet and stopped there — no inbox row,
      // no audit — which is a quieter version of the defect it exists to fix.
      // CANARY: drop the notifyTaskWatchers / recordAudit calls from
      // retryReviewDeadlockEscalation.
      const { listNotifications } = await import("~/server/projections/notifications.server");
      const inbox = listNotifications(store.db, store.users.arda.id, { limit: 50 });
      const told = inbox.find((n) => (n.title ?? "").includes("requested changes 3 times running"));
      expect(told, "the escalation reached nobody's inbox").toBeTruthy();
      // Ruling 237's own rule: the policy engine raised this, not the operator.
      expect(told!.from?.name ?? "").toBe("Policy engine");
      const audited = listAuditEvents(store.db, { action: "task.review.deadlock" });
      expect(audited.length).toBeGreaterThan(0);
      expect(audited.at(-1)!.details).toMatchObject({ retried: true });
    });

    it("opens the packet on the third, not the second: round two is the operator's (ruling 410)", async () => {
      writeReviewTask();

      await review(blocks(1));
      // CANARY: drop `rounds < REVIEW_DEADLOCK_ROUNDS` from `reviewDeadlockOf`
      // and this is a packet on ordinary first-round review feedback, which
      // would pause coordination on every task that ever got a note.
      expect(taskFile().parsed.packet).toBeNull();

      await review(blocks(2));
      await review(blocks(3));
      const packet = taskFile().parsed.packet;
      // CANARY: delete the `openReviewDeadlockPacket` call in
      // `recordAgentCompletion` and this is null — the exact state SHOP-5 sat
      // in for four rounds.
      expect(packet).not.toBeNull();
      expect(packet?.title).toContain("requested changes 3 times running");
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
      await review(blocks(3));
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
      const { resolvePacket } = await import("./packet-resolution.server");
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actorOf(store.users.arda),
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
      const { classifyReviewerVerdict } = await import("./agent-completion.server");
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
      await review(blocks(3));
      const { resolvePacket } = await import("./packet-resolution.server");
      // Longer than the old silent cap, shorter than the refusal — the exact
      // band SHOP-76's decision fell into.
      const long = `HEAD ${"x".repeat(2600)} TAIL`;
      expect(long.length).toBeGreaterThan(2000);
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1, note: long },
        actorOf(store.users.arda),
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
      await review(blocks(3));
      const { resolvePacket } = await import("./packet-resolution.server");
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
          actorOf(store.users.arda),
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
      await review(blocks(3));
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
      const { resolvePacket } = await import("./packet-resolution.server");
      await resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actorOf(store.users.arda),
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
      // Ruling 410: round two goes BACK to the operator on purpose -- that is
      // the round it now owns. The claim under test is about the round that
      // ESCALATES, so the baseline is taken after it.
      await review(blocks(2), "reviewer", { dispatchedByName: "operator" });
      const before = operatorRuns();

      await review(blocks(3), "reviewer", { dispatchedByName: "operator" });
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
      await review(blocks(3));

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
      await review(blocks(3));
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

      // 2. `custom` is NOT in PROCESS_ONLY_OPTION_KINDS, so this option's own
      // `t — d` is appended to the task's GOAL as binding contract.
      // CANARY: restore "with nothing changed".
      expect(opt("custom").d).not.toMatch(/nothing changed/);
      /**
       * Ruling 329: and therefore `d` must contain only what BINDS.
       *
       * This assertion used to require the opposite — that `d` contain
       * "recorded on the task's contract" — and the comment above it named the
       * wrong mechanism, conflating the `note` box with the synthetic `custom`
       * CHOICE. `note` posts to the timeline and the operator's summon note and
       * has never reached a goal. So the sentence this test defended was false
       * when it was written, and it is the sentence that landed in three tasks'
       * permanent contracts, twice on SHOP-76: an instruction to type in a
       * textarea, addressed to every later run, which has no textarea.
       *
       * The ask now lives in the packet BODY, which is read on the card and
       * appended to nothing.
       */
      expect(opt("custom").d).not.toMatch(/recorded on the task's contract/);
      expect(opt("custom").d).not.toMatch(/type below|ruling 189/i);
      expect(packet.body).toContain("say why in the note box");
      // The whole of what this option writes into the goal, and every word of
      // it is about the decision.
      expect(`${opt("custom").t} — ${opt("custom").d}`).toBe(
        "Let the rework continue — Each round has found something real and the work is " +
          "converging on it. Hands the task back to the operator to carry on.",
      );

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
      await review(blocks(3));
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
      await review(blocks(3));
      expect(taskFile().parsed.packet).toBeNull();
      // The verdict itself still lands: closing the task does not erase what a
      // reviewer found.
      expect(taskFile().parsed.frontmatter.verdicts[0]?.rounds).toBe(3);
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
      await review(blocks(3));
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

  it("ruling 586: the question's entry carries the card, which leaves the task when it is answered", async () => {
    // CANARY: write the title alone again and the numbered questions are on
    // no record once Arda answers.
    writeReviewTask();
    const runId = await finishedRunWith(
      JSON.stringify({
        summary: "Intake is ready for Arda.",
        question: {
          title: "Intake batch: accept the proposed defaults?",
          body: "1. Region: us-east-1 (default).\n2. Hours: 730 a month (default).",
          options: [{ title: "Keep the defaults (Recommended)" }, { title: "Change some items", reply: true }],
        },
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
    const asked = taskFile().parsed.timeline.find((e) => e.type === "blocked");
    expect(asked?.text).toBe(
      "**Question for a human:** Intake batch: accept the proposed defaults?\n\n" +
        "1. Region: us-east-1 (default).\n2. Hours: 730 a month (default).\n\n" +
        "Options: Keep the defaults (recommended) · Change some items",
    );
  });

  it("R15-7: an UNRESOLVABLE profile's finished run opens no question packet and asserts no evidence", async () => {
    const runId = await finishedRunWith(
      JSON.stringify({
        summary: "Reviewed the change; one thing is unclear.",
        question: {
          title: "Which API surface should this use?",
          body: "Two candidates.",
        },
        evidence: [{ label: "unit suite", result: "12 passed", status: "pass" }],
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
    deployOperator();
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

    deployOperator();
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

  it("ruling 333: a refusal on a run that HAD been working does not tell the next agent the tree is clean", async () => {
    /**
     * The same shape as the quota test below, on a run that had taken 48 turns
     * — SHOP-28's live case, where the provider rejected the credential one
     * third of a second after the run created a file that is still on disk and
     * uncommitted.
     *
     * The clause was a literal. `max_turns` and `max_budget` were exempted from
     * it precisely because a cut run leaves work in the tree; a provider refusal
     * on turn 48 is the same cut-off and was not exempt. It matters because the
     * sentence is fed forward — `canonicalTaskAnchor` puts recent timeline
     * events into the NEXT run's prompt — so eighteen minutes later the owner
     * had to hand-write "it ran 48 turns … Do not regenerate work that is
     * already in the tree."
     *
     * CANARY: make the clause unconditional in `applyAgentCompletionEffects`.
     */
    writeReviewTask({ validation: "changed" });
    const runId = "run_333_cut";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-333",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "claude",
      model: "opus",
      sdk: "claude",
      state: "error",
      // The one fact the sentence contradicted, already on the row.
      turns: 48,
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-09-07T10:00:00.000Z",
      raw: JSON.stringify({ ev: "err", tag: "run·error·auth" }),
      display: {
        t: "10:00:00",
        ev: "err",
        tag: "run·error·auth",
        text: "Claude refused the run: the provider rejected the credential.",
        failure: { ...emptyRunFailureFacts("auth"), apiErrorStatus: 401 },
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
    expect(event, "the failure was not recorded at all").toBeTruthy();
    expect(event.text).not.toContain("No changes were delivered");
    expect(event.text).toContain("48 turns");
    expect(event.text).toContain("read the workspace before starting anything over");
  });

  it("ruling 130(b): a specialist quota failure names the reset instant and the owner's remedy; the options come from the remedy leaf; never `..`", async () => {
    // Canaries: restore the fixed "Retry on the other backend, or fix the
    // credential and re-run." sentence in the error arm (the event text
    // fails), or drop the `stuck.options` override so the stock set with
    // `redirect` recommended returns (the option assertions fail).
    deployOperator();
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
      `${owner} can wait until the window reopens (Sep 7, 2026 · 11:50 UTC), or switch to or connect a different Claude account (or an API key) on Profile → Agent accounts.`,
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
    deployOperator();
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
    expect(event.text).toContain("raise the cap in Instance settings (Max spend per Claude run)");
    expect(event.text).not.toContain("No changes were delivered.");
    expect(event.text).not.toMatch(/\.\./);
  });

  it("ruling 595: a specialist run the idle guard stopped opens a stall packet that recommends running it again, in the leaf's words", async () => {
    deployOperator();
    const runId = "run_595_hung";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-595",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "codex",
      model: "gpt-6-luna",
      sdk: "codex",
      state: "error",
    });
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-09-29T19:40:56.000Z",
      raw: JSON.stringify({ ev: "err", tag: "error·idle_timeout" }),
      display: {
        t: "19:40:56",
        ev: "err",
        tag: "error·idle_timeout",
        text: "Codex stopped after 900000 ms without producing an event or writing to its session.",
        failure: emptyRunFailureFacts("idle_timeout"),
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
    const packet = parsed.packet!;
    expect(packet.title).toBe("Work stalled: pick a recovery path");
    // CANARY: keep the stock set for a hung run and "Redirect with sharper
    // guidance" is the recommendation again.
    expect(packet.options.map((o) => [o.kind, o.rec])).toEqual([
      ["request_edit", true],
      ["redirect", false],
      ["hold_runtime_debug", false],
    ]);
    expect(packet.options[0]!.t).toBe("Run @dev again on Codex: the run hung, nothing was changed");
    const event = parsed.timeline.find((e) => e.type === "blocked" && /did not complete/.test(e.text))!;
    expect(event.text).toContain("The agent run was stopped as hung: Codex produced nothing for the whole idle window.");
    expect(event.text).toContain("Run it again");
    expect(event.text).not.toMatch(/\.\./);
  });

  it("ruling 598: a specialist run the gateway stopped for repeating one call opens a stall packet that names the call and recommends a redirect", async () => {
    // Live on AWSC-49 the Estimate Judge's script repeated a refused
    // correction 44,725 times. A plain re-run repeats the loop, so the
    // recommendation is guidance. CANARIES: leave tool_loop out of the leaf's
    // kinds and the packet says only that the run failed; recommend the
    // re-run and the loop comes back.
    deployOperator();
    const runId = "run_598_loop";
    upsertRun(store.db, {
      id: runId,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-598",
      role: "Developer",
      kind: "primary",
      agentProfileId: "developer",
      backend: "codex",
      model: "gpt-6-luna",
      sdk: "codex",
      state: "error",
    });
    const sentence =
      'Viberr stopped the run: it sent `correct_knowledge_doc` (viberr_knowledge) with the same arguments 100 times in 2 s and got the same answer each time: "[noop] The passage you sent as `replaces` stands 3 times in golden/sample-03.md. Nothing was written. Send more of it, so it stands once." Sending it again cannot change the answer; the call has to change.';
    insertRunLine(store.db, {
      runId,
      seq: 0,
      occurredAt: "2026-09-30T04:16:40.000Z",
      raw: JSON.stringify({ type: "error", source: "viberr", reason: "tool_loop", message: sentence }),
      display: { t: "04:16:40", ev: "err", tag: "run·error·tool_loop", text: sentence, failure: emptyRunFailureFacts("tool_loop") },
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
    expect(parsed.packet!.options.find((o) => o.rec)?.t).toBe("Redirect with sharper guidance");
    const event = parsed.timeline.find((e) => e.type === "blocked" && /did not complete/.test(e.text))!;
    expect(event.text).toContain("it sent `correct_knowledge_doc` (viberr_knowledge) with the same arguments 100 times");
    expect(event.text).toContain("Redirect the agent: tell it what the tool answered");
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
    // Ruling 497: each row opens the failure's own event, which says why.
    // CANARY: drop `about` from `failureNotice` and the rows open the top.
    const failure = taskFile().parsed.timeline.find((e) => e.type === "blocked")!;
    expect(
      new Set(
        store.db
          .prepare(`SELECT href FROM notifications WHERE task_key = 'VIB-1'`)
          .all()
          .map((row) => row.href),
      ),
    ).toEqual(new Set([`/projects/${store.slug}/tasks/VIB-1#event-${failure.occurredAt}`]));
    expect(taskFile().parsed.frontmatter.waiting).toBe("human");
  });
});

describe("unavailable backend through the specialist start path", () => {
  it("startSpecialistRun on an unavailable backend errors fast → blocked event with 'unavailable' copy + recovery packet", async () => {
    // Deploy an operator with generate-packets (opens the recovery packet).
    deployOperator();
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actorOf(store.users.arda),
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
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // SAFETY: same single-column SELECT, and `startAgentRun` returned the id of
    // the row it had just written, so the lookup always finds it.
    const row = store.db
      .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
      .get(result.runId) as { state: string };
    expect(row.state).toBe("error");

    const blockedByRefusal = (text: string) => /isn't connected for/.test(text);
    const surfaced = await pollUntil(() => {
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
    deployOperator();
    await assignSpecialist(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actorOf(store.users.arda),
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
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const offered = await pollUntil(() => {
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
        // Delivered by another agent: a verdict on one's own revision binds to
        // nothing (ruling 556).
        workRevision: { ...workRev(), sourceProfileId: "builder" },
      }),
      goal: "Exercise the canonical completion handler.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await assignReviewer(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
      actorOf(store.users.arda),
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
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const changed = await pollUntil(() => {
      const fm = taskFile().parsed.frontmatter;
      return fm.validation === "healthy";
    }, 25_000);
    expect(changed).toBe(true);
    expect(result.runId).toBeTruthy();
  }, 30_000);
});

describe("superseded stuck-packet withdrawal (owner ruling 2026-07-18)", () => {
  /** Write a `type: "blocked"` work-stalled packet straight into the task file
   *  (the schema shape operatorOpenPacket produces). `stalled` is the ruling 432
   *  marker `openStuckLoopPacket` writes; `false` writes the same blocked shape
   *  without it, which is what every other blocked packet looks like. */
  async function openBlockedPacket(
    options: PacketOption[],
    { stalled = true }: { stalled?: boolean } = {},
  ): Promise<void> {
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        const packet: NonNullable<typeof parsed.packet> = {
          type: "blocked",
          kind: "Blocked decision",
          from: "operator",
          title: "Work stalled — pick a recovery path",
          body: "The run failed. Coordination is paused until a human chooses how to proceed.",
          observations: [],
          options,
        };
        if (stalled) packet.stalled = true;
        parsed.packet = packet;
        parsed.frontmatter.readiness = "blocked";
      },
    );
  }

  /**
   * Ruling 432: open a packet through the REAL writer rather than a hand-built
   * fixture of what it is believed to write. The operator is deployed only for
   * the write, since the writer opens packets on its authority, and is removed
   * again so the completion's react stays out of the way, exactly as in the
   * tests that write the packet directly.
   */
  async function withOperatorDeployed(write: () => Promise<void>): Promise<void> {
    const before = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    deployOperator();
    await write();
    writeProject(store.dataRoot, before);
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
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
    // Ruling 432: no acceptance packet is a stall, so none carries the marker.
    await openBlockedPacket(
      [{ kind: "accept_completion", t: "Accept & move to Done", d: "", rec: true }, redirect],
      { stalled: false },
    );
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

  it("an agent-agnostic stall packet (no retry option) withdraws on any successful run", async () => {
    await openBlockedPacket([redirect]);
    const runId = await finishedRunWith("Unblocked and finished.");
    await runEffects(runId, { delivers: true });
    expect(taskFile().parsed.packet).toBeNull();
  });

  it("ruling 432: a branch-conflict packet outlives a clean run that changed nothing (AX-21)", async () => {
    /**
     * Live on AX-21 at 01:24. `update_branch_from_base` met a conflict and
     * opened "`ax-21` conflicts with `main`". The same plan dispatched the
     * Surface Developer, which found the conflict, changed nothing and ended
     * cleanly: "Blocked on the unresolved AX-21/main conflict; no lasting
     * changes were made". Its success then withdrew the conflict as "moot",
     * and the question it asked about the conflict was held behind a decision
     * that no longer existed. A run finishing disproves a stall and nothing
     * else.
     *
     * CANARY: in `withdrawSupersededStuckPacket`, take any blocked packet again
     * instead of `packet.stalled`.
     */
    const { operatorOpenPacket, resolveOperatorAuthority } = await import(
      "./operator-actions.server"
    );
    await withOperatorDeployed(async () => {
      const authorized = { dataRoot: store.dataRoot, operatorAuthorized: true };
      const opened = await operatorOpenPacket(
        store.db,
        authorized,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          packetType: "blocked",
          title: "`vib-1-work` conflicts with `main`",
          body:
            "The task branch cannot be brought up to date automatically. The merge was " +
            "aborted and the branch is exactly as it was. A person decides how this is resolved.",
          observations: [{ k: "Conflicting files", v: "internal/cli/cli.go", code: true }],
          options: [
            {
              kind: "redirect",
              title: "Have Developer resolve the conflict",
              detail: "Its workspace already has `origin/main` fetched: it merges and resolves the conflicting files.",
              recommended: true,
            },
            {
              kind: "custom",
              title: "Resolve `vib-1-work` yourself",
              detail: "Merge `main` into the branch by hand and push it.",
            },
            {
              kind: "archive_task",
              title: "Archive the task: the work is superseded",
              detail: "Keeps the record and the branch; the task leaves the board.",
            },
          ],
        },
        resolveOperatorAuthority(authorized, store.slug, {}),
      );
      expect(opened.outcome, opened.message).toBe("done");
    });
    const conflict = taskFile().parsed.packet;
    expect(conflict?.title).toBe("`vib-1-work` conflicts with `main`");
    expect(conflict?.stalled, "only a stall escalation carries the marker").toBeUndefined();

    const runId = await finishedRunWith(
      "Blocked on the unresolved VIB-1/main conflict; no lasting changes were made.",
    );
    await runEffects(runId, { delivers: true });

    const parsed = taskFile().parsed;
    expect(parsed.packet?.id, "a clean run withdrew a standing conflict").toBe(conflict!.id);
    expect(parsed.frontmatter.readiness).toBe("blocked");
    expect(
      parsed.timeline.some((e) => (e.text ?? "").includes("**Packet withdrawn:**")),
      "the timeline called the conflict moot",
    ).toBe(false);
    expect(
      listAuditEvents(store.db).some((e) => e.action === "task.packet.withdrawn_superseded"),
    ).toBe(false);
  });
});

/**
 * Ruling 602: a refusal in a window the owner already decided. Live on AWSC-52
 * at 13:20 a Judge run in flight when the Codex window closed was refused two
 * minutes after Arda had chosen to wait on AWSC-51, and its packet asked the
 * same question again: ruling 319 answers only the siblings open at the time.
 */
describe("a refusal in a window the owner already decided (ruling 602)", () => {
  const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  let seq = 0;
  /** A Codex run billed to Arda, refused for her usage window. */
  function refusedRun(taskKey: string): string {
    seq += 1;
    const id = `run_refused_${seq}`;
    upsertRun(store.db, {
      id,
      projectSlug: store.slug,
      taskKey,
      threadId: `refused-${seq}`,
      role: "Developer",
      kind: "primary",
      backend: "codex",
      model: "gpt-5.6-luna",
      sdk: "codex",
      agentName: "dev",
      agentProfileId: "dev",
      state: "error",
      credentialUserId: store.users.arda.id,
    });
    insertRunLine(store.db, {
      runId: id,
      seq: 0,
      occurredAt: new Date().toISOString(),
      raw: "",
      display: {
        t: "00:00:01",
        ev: "err",
        tag: "run·error·quota",
        text: "Codex refused the agent run: the account is over its usage limit.",
        failure: { ...emptyRunFailureFacts("quota"), resetsAt },
      },
    });
    return id;
  }
  async function complete(taskKey: string, runId: string): Promise<void> {
    await applyAgentCompletionEffects(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey,
        backend: "codex",
        profileId: "dev",
        role: "Developer",
        delivers: true,
        workdir: null,
        agentHandle: "dev",
      },
      { id: runId, state: "error" },
    );
  }
  function parsedOf(taskKey: string) {
    return readTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot })!.parsed;
  }

  it("answers the later packet with the wait the owner chose on another task", async () => {
    // CANARY: drop the `answerFromStandingDecision` call and VIB-2's packet
    // stays open, asking again.
    deployOperator();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl", ownerUserId: store.users.arda.id }),
      goal: "A second task on the same account.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await complete("VIB-1", refusedRun("VIB-1"));
    const first = parsedOf("VIB-1").packet!;
    const wait = first.options.findIndex((o) => o.kind === "wait_for_window");
    expect(wait, "the first refusal offers the wait").toBeGreaterThanOrEqual(0);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: wait },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    await complete("VIB-2", refusedRun("VIB-2"));
    const second = parsedOf("VIB-2");
    expect(second.packet, "the later packet was answered from the standing decision").toBeNull();
    expect(second.frontmatter.schedules.map((s) => s.action)).toEqual(["run-operator"]);
    expect(second.timeline.some((e) => e.text.startsWith("Answered from VIB-1: "))).toBe(true);
  });
});
