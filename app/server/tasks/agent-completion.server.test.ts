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
import { insertRunLine, upsertRun } from "~/server/runtimes/run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { emptyRunFailureFacts } from "~/shared/run-failure";
import {
  applyAgentCompletionEffects,
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
  it("ruling 204: a second request_changes on the SAME revision is a second round, not a replacement", async () => {
    writeReviewTask();
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

    // Nothing changed in between: no new revision, no new head. The reviewer
    // simply looked again and said the same thing.
    // CANARY: write `rounds: 1` unconditionally (the pre-204 upsert) and this
    // reads 1 — the deadlock signal ruling 193 escalates on stays flat forever.
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
    const review = async (
      reply: string,
      profileId = "reviewer",
      extra: { dispatchedByName?: string } = {},
    ) => {
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
          `SELECT agent_profile_id AS pid FROM agent_runs
           WHERE project_slug = ? AND kind <> 'operator'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(store.slug) as { pid: string };
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
      expect(taskFile().parsed.packet).toBeNull();
      expect(taskFile().parsed.frontmatter.waiting).toBe("agent");
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
