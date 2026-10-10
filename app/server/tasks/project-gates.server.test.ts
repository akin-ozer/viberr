import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  REVIEWER_ENGAGEMENT,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { deployDeliveryOperator } from "../../../test-support/delivery-operator";
import { withEnv } from "../../../test-support/env";
import { writeFakeBrowser } from "../../../test-support/fake-browser";
import { flush } from "../../../test-support/polling";
import type { ProjectGate } from "~/schemas/project-file.schema";
import type { Engagement, GateRun, TaskFrontmatter } from "~/schemas/task-file.schema";
import { taskAttachmentsDir, taskDir } from "~/server/files/file-store-root.server";
import { keptBuildDir, keptBuildFiles } from "~/server/files/kept-builds.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { attachmentNamesSince } from "~/server/files/task-attachments.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskSummary, listTaskEvents } from "~/server/projections/task-query.server";
import {
  AGENT_UID_FLOOR,
  resetAgentIsolationForTests,
} from "~/server/runtimes/agent-isolation.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import {
  builtPagesSettled,
  recoverProjectGates,
  requestProjectGates,
  whenProjectGatesIdle,
} from "./project-gates.server";
import { forceAcceptCompletion, acceptanceStanding } from "./task-acceptance.server";
import { performDelivery, runProjectGatesByHand } from "./task-delivery.server";
import { transitionStage } from "./task-transitions.server";

/**
 * Ruling 104 (pass 40, F40-52): Viberr runs the project's gates itself.
 *
 * Live on akinozer-com the gate list was prose in a knowledge base, every
 * directive re-typed it, and the owner accepted two production deploys on
 * agents' reports of four exit codes. These drive the real runner — real git,
 * real `sh` — against a delivering checkout on disk: what it runs, on which
 * sha, as whom, what it records, and what the record does to acceptance.
 */

let ctx: TestDbContext;
let store: TestStore;
/** The revision under review and the commit the agent made after it. */
let revisionSha: string;
let laterSha: string;

const QUIET = ["-c", "core.hooksPath=/dev/null"];

function g(cwd: string, args: string[]): string {
  return execFileSync("git", [...QUIET, ...args], { cwd, stdio: "pipe" }).toString().trim();
}

function workspaceDir(): string {
  return path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr");
}

/** The delivering checkout: the delivered revision, then one more commit the
 *  agent made afterwards and never delivered. */
function deliveringCheckout(): void {
  const dir = workspaceDir();
  mkdirSync(dir, { recursive: true });
  g(dir, ["init", "-q", "-b", "main"]);
  g(dir, ["config", "user.email", "agent@t.dev"]);
  g(dir, ["config", "user.name", "Agent"]);
  writeFileSync(path.join(dir, "README.md"), "# viberr\n");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-q", "-m", "init"]);
  g(dir, ["checkout", "-q", "-b", "vib-1-work"]);
  writeFileSync(path.join(dir, "work.txt"), "the delivered work\n");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-q", "-m", "delivered"]);
  revisionSha = g(dir, ["rev-parse", "HEAD"]);
  writeFileSync(path.join(dir, "work.txt"), "work after the delivery\n");
  g(dir, ["commit", "-qam", "after"]);
  laterSha = g(dir, ["rev-parse", "HEAD"]);
}

function setGates(gates: ProjectGate[]): void {
  const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, { ...project.parsed.frontmatter, gates });
}

const DEV: Engagement = {
  profileId: "dev",
  backend: "codex",
  role: "developer",
  delivers: true,
  verdictCapable: false,
};

/** VIB-1 at Review, delivered on `revisionSha` with an open PR and an
 *  approving verdict: every gate but the project's gates is clear. */
function writeDeliveredTask(patch: Partial<TaskFrontmatter> = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      ownerUserId: store.users.arda.id,
      branch: "vib-1-work",
      engagements: [DEV, REVIEWER_ENGAGEMENT],
      workRevision: {
        id: "rev_1",
        headSha: revisionSha,
        treeSha: null,
        branch: "vib-1-work",
        createdAt: "2026-09-25T09:00:00.000Z",
        sourceProfileId: "dev",
      },
      verdicts: [
        {
          profileId: "reviewer",
          revisionId: "rev_1",
          headSha: revisionSha,
          result: "approve",
          reason: "Looks right.",
          at: "2026-09-25T09:30:00.000Z",
          rounds: 1,
        },
      ],
      validation: "healthy",
      pr: { number: 7, state: "review", title: "VIB-1", headSha: revisionSha },
      ...patch,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function task() {
  return readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
    .parsed;
}

function run(): GateRun {
  const record = task().frontmatter.gateRun;
  if (!record) throw new Error("no gate run recorded");
  return record;
}

async function gateOnce(): Promise<void> {
  const outcome = await requestProjectGates(
    store.db,
    { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
    { reason: "delivery" },
  );
  expect(outcome.status).toBe("queued");
  await whenProjectGatesIdle();
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deliveringCheckout();
});

afterEach(async () => {
  await whenProjectGatesIdle();
  // A failing run's operator hand-off is fire-and-forget: let it settle
  // before the store it reads is removed.
  await flush();
  resetAgentIsolationForTests();
  ctx.cleanup();
});

describe("the gate run (ruling 104)", () => {
  it("runs every gate in a fresh checkout of the revision's sha, records each exit code and saves each log as an attachment", async () => {
    setGates([
      { name: "head", command: "git rev-parse HEAD" },
      { name: "lint", command: "echo 'lint found 2 problems' >&2; exit 3" },
    ]);
    writeDeliveredTask();

    await gateOnce();

    const record = run();
    expect(record).toMatchObject({
      revisionId: "rev_1",
      headSha: revisionSha,
      status: "finished",
      reason: "delivery",
      error: null,
    });
    expect(record.results.map((r) => [r.name, r.exitCode, r.timedOut])).toEqual([
      ["head", 0, false],
      ["lint", 3, false],
    ]);
    // CANARY: drop the `checkout --detach` in prepareGateCheckout and the
    // gate reads the checkout's own HEAD, the commit nobody delivered.
    const headLog = readFileSync(
      path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), record.results[0]!.log!),
      "utf8",
    );
    expect(headLog).toContain(revisionSha);
    expect(headLog).not.toContain(laterSha);
    expect(headLog).toContain("# command: git rev-parse HEAD");
    expect(headLog).toContain("# result: exit 0");
    const lintLog = readFileSync(
      path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), record.results[1]!.log!),
      "utf8",
    );
    expect(lintLog).toContain("lint found 2 problems");
    expect(lintLog).toContain("# result: exit 3");
    // The delivering checkout is untouched, and the gate checkout is gone.
    expect(g(workspaceDir(), ["rev-parse", "HEAD"])).toBe(laterSha);
    expect(readdirSync(path.join(path.dirname(workspaceDir()), ".gates"))).toEqual([]);

    // One timeline note claims both logs, in the PR card's own words.
    const note = task().timeline[0]!;
    expect(note).toMatchObject({
      type: "note",
      actor: { kind: "system", systemId: "project-gates" },
      title: "Project gates failed",
    });
    expect(note.text).toContain(`Gates on ${revisionSha.slice(0, 7)}: 1/2 exit 0 (run by Viberr)`);
    expect(note.attachments).toEqual(record.results.map((r) => r.log));
    // Ruling 16: each row carries its gate's ending into task.md, where an
    // agent reads it, and into the review PR's evidence lines. CANARY: mark
    // every row `info` in `gateRunEvent`.
    expect(note.evidence?.map((row) => row.status)).toEqual(["pass", "fail"]);
    // Ruling 313: the timeline reads the projected note back into this run,
    // each row with its own log. CANARY: print the evidence label another way
    // in `gateRunEvent` and the note renders as prose again.
    const [shown] = listTaskEvents(store.db, store.slug, "VIB-1", { limit: 1 });
    expect(shown!.gates).toEqual({
      state: "failed",
      sha: revisionSha.slice(0, 7),
      detail: null,
      rows: [
        { name: "head", outcome: "exit 0", wall: expect.any(String), ok: true, log: record.results[0]!.log },
        { name: "lint", outcome: "exit 3", wall: expect.any(String), ok: false, log: record.results[1]!.log },
      ],
    });
    expect(shown!.attachments).toBeNull();
    const audit = listAuditEvents(store.db, { action: "task.gates.run" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({
      headSha: revisionSha,
      status: "finished",
      passed: 1,
      total: 2,
      failed: ["lint"],
      runsAs: "server",
    });
  });

  it("never hands a gate a secret: the server's credentials and settings are stripped from its environment", async () => {
    // CANARY: build `gateEnv` on `process.env` and the key is in the log.
    setGates([{ name: "env", command: "env" }]);
    writeDeliveredTask();
    await gateOnce();
    const log = readFileSync(
      path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), run().results[0]!.log!),
      "utf8",
    );
    expect(process.env.VIBERR_SECRET_ENCRYPTION_KEY).toBeTruthy();
    expect(log).not.toContain("VIBERR_SECRET_ENCRYPTION_KEY");
    expect(log).not.toContain("VIBERR_SESSION_SECRET");
    expect(log).toContain(`VIBERR_RUN_ID=${run().id}-1`);
  });

  it("stops a gate at its timeout and records it as timed out, not as an exit code", async () => {
    // CANARY: never arm the timer in runGateCommand and this waits 30 s.
    setGates([{ name: "hang", command: "sleep 30", timeoutSeconds: 1 }]);
    writeDeliveredTask();
    const started = Date.now();
    await gateOnce();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(run().results[0]).toMatchObject({ name: "hang", exitCode: null, timedOut: true });
    expect(task().timeline[0]!.text).toContain("`hang` timed out");
  });

  it("records a gate killed by a signal as 128 + the signal, not as a start failure", async () => {
    // CANARY: drop the `signalled` fallback in runGateCommand's close handler
    // and the exit code reads null, the shape of a gate that never started.
    setGates([{ name: "signalled", command: "kill -TERM $$" }]);
    writeDeliveredTask();
    await gateOnce();
    expect(run()).toMatchObject({ status: "finished", error: null });
    expect(run().results[0]).toMatchObject({ name: "signalled", exitCode: 143, timedOut: false });
  });

  it("records a run that could not execute, with the reason, instead of passing it", async () => {
    setGates([{ name: "build", command: "true" }]);
    writeDeliveredTask();
    execFileSync("rm", ["-rf", workspaceDir()]);
    await gateOnce();
    expect(run()).toMatchObject({ status: "error", results: [] });
    expect(run().error).toContain("delivering checkout");
    expect(task().timeline[0]!.title).toBe("Project gates could not run");
  });

  it("is idempotent on a revision whose gates already ran, and a person's request runs them again", async () => {
    setGates([{ name: "ok", command: "true" }]);
    writeDeliveredTask();
    await gateOnce();
    const first = run().id;
    const again = await requestProjectGates(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      { reason: "delivery" },
    );
    expect(again.status).toBe("current");
    const byHand = await runProjectGatesByHand(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(byHand.status).toBe("queued");
    await whenProjectGatesIdle();
    expect(run().id).not.toBe(first);
    expect(run().reason).toBe("person");
    expect(listAuditEvents(store.db, { action: "task.gates.requested" })).toHaveLength(1);
    // A contributor holds neither the owner's seat nor the run-agents tier.
    await expect(
      runProjectGatesByHand(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actorOf(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("owes nothing where no gate is declared or nothing is delivered", async () => {
    writeDeliveredTask();
    expect(
      (
        await requestProjectGates(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
          { reason: "delivery" },
        )
      ).status,
    ).toBe("not_owed");
    setGates([{ name: "ok", command: "true" }]);
    writeDeliveredTask({ workRevision: null, verdicts: [], validation: "none" });
    expect(
      (
        await requestProjectGates(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
          { reason: "delivery" },
        )
      ).status,
    ).toBe("not_owed");
    expect(task().frontmatter.gateRun).toBeUndefined();
  });

  it("queues a restart-orphaned run again at boot", async () => {
    setGates([{ name: "ok", command: "true" }]);
    writeDeliveredTask({
      gateRun: {
        id: "gate_orphan",
        revisionId: "rev_1",
        headSha: revisionSha,
        status: "running",
        reason: "delivery",
        requestedAt: "2026-09-25T10:00:00.000Z",
        startedAt: "2026-09-25T10:00:01.000Z",
        finishedAt: null,
        error: null,
        results: [],
      },
    });
    // CANARY: make recoverProjectGates skip `running` records and this stays
    // `running` forever, blocking acceptance with nobody working.
    expect(await recoverProjectGates(store.db, store.dataRoot)).toBe(1);
    await whenProjectGatesIdle();
    expect(run()).toMatchObject({ status: "finished", reason: "restart" });
    expect(run().id).not.toBe("gate_orphan");
  });

  it("keeps a gate log out of the files a concurrent run is credited with", async () => {
    setGates([{ name: "ok", command: "true" }]);
    writeDeliveredTask();
    const since = new Date(Date.now() - 1000).toISOString();
    await gateOnce();
    expect(existsSync(path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), run().results[0]!.log!))).toBe(true);
    // CANARY: drop the `isGateLogName` skip in attachmentNamesSince.
    expect(attachmentNamesSince(store.slug, "VIB-1", since, store.dataRoot)).toEqual([]);
  });
});

describe("what the gate record does to acceptance (ruling 104)", () => {
  it("blocks a plain acceptance until every gate exited 0, and force accept records the bypass", async () => {
    setGates([{ name: "build", command: "exit 1" }]);
    writeDeliveredTask();
    await gateOnce();

    const affordance = acceptanceStanding(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    ).affordance;
    // CANARY: remove `projectGatesRefusal` from acceptanceRefusalReasons.
    expect(affordance.blockedReason).toContain("The project's gates failed on VIB-1's revision");
    expect(affordance.canAccept).toBe(false);
    expect(affordance.gates).toMatchObject({ state: "failed", passed: 0, total: 1 });
    expect(affordance.gates?.line).toBe(`Gates on ${revisionSha.slice(0, 7)}: 0/1 exit 0 (run by Viberr)`);
    // The projection carries the same refusal (review queue, inbox, board).
    // CANARY: remove it from the rebuilder's acceptanceBlockReason.
    expect(getTaskSummary(store.db, store.slug, "VIB-1")?.blockReason).toContain(
      "The project's gates failed",
    );

    // The operator's snapshot carries the same record, with the failure named.
    // CANARY: drop `gates: operatorGatesOf(...)` from operatorSnapshot.
    const { operatorSnapshot } = await import("./operator-snapshot.server");
    const { resolveOperatorAuthority } = await import("./operator-authority.server");
    const snap = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug),
    );
    expect(snap.gates).toMatchObject({
      state: "failed",
      line: `Gates on ${revisionSha.slice(0, 7)}: 0/1 exit 0 (run by Viberr)`,
      failed: [{ name: "build", command: "exit 1", outcome: "exit 1" }],
    });
    expect(snap.notAcceptableReason).toContain("The project's gates failed");

    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done", manual: true },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(task().frontmatter.stage).toBe("review");

    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task().frontmatter.stage).toBe("done");
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(JSON.stringify(forced[0]!.details!.bypassedGates)).toContain("gates failed");
  });

  it("refuses while the gates have not run, and clears once they pass", async () => {
    setGates([{ name: "build", command: "true" }]);
    writeDeliveredTask();
    const refusal = () =>
      acceptanceStanding(
        { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
        { dataRoot: store.dataRoot },
      ).affordance.blockedReason;
    expect(refusal()).toContain("have not run on VIB-1's revision");
    await gateOnce();
    expect(refusal()).toBeNull();
    // A gate added afterwards is not evidence yet.
    setGates([
      { name: "build", command: "true" },
      { name: "test", command: "true" },
    ]);
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(refusal()).toContain("changed after they ran");
  });

  it("a failing gate hands the rework to the operator, and a passing one does not", async () => {
    // CANARY: drop the `gates-failed` hand-off at the end of runGateJob.
    const runOp = vi.fn<typeof runOperator>(async () => ({
      runId: null,
      queued: true,
      backend: "claude" as const,
      autonomy: "supervised" as const,
    }));
    deployDeliveryOperator(store, "supervised");
    setGates([{ name: "build", command: "exit 2" }]);
    writeDeliveredTask();
    const ask = async () => {
      await requestProjectGates(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          dataRoot: store.dataRoot,
          deps: { runOperator: runOp },
        },
        { reason: "delivery", force: true },
      );
      await whenProjectGatesIdle();
    };
    await ask();
    await vi.waitFor(() => expect(runOp).toHaveBeenCalledTimes(1));
    expect(runOp.mock.calls[0]![1]).toMatchObject({ taskKey: "VIB-1", trigger: "gates-failed" });
    setGates([{ name: "build", command: "true" }]);
    await ask();
    await flush();
    expect(runOp).toHaveBeenCalledTimes(1);
  });
});

describe("a promoted gate list is evidence on the tasks already in review (ruling 104)", () => {
  it("setProjectGates queues the new list on every open task with a delivered revision", async () => {
    writeDeliveredTask();
    const { setProjectGates } = await import(
      "~/features/project-settings/settings-actions.server"
    );
    const result = await setProjectGates(
      store.db,
      { projectSlug: store.slug, gates: [{ name: "build", command: "true" }] },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // CANARY: drop the `requestGatesForOpenTasks` call in setProjectGates.
    expect(result).toMatchObject({ changed: true, queued: 1 });
    expect(result.toast).toContain("queued them on 1 open task");
    await whenProjectGatesIdle();
    expect(run()).toMatchObject({ status: "finished", reason: "gates-changed" });
    expect(run().results.map((r) => r.exitCode)).toEqual([0]);
  });
});

describe("a new head on an open PR asks for the gates (ruling 104)", () => {
  it("the workspace reconcile that mints a new revision while the PR stands queues the gates on it", async () => {
    // CANARY: drop the gate request in reconcileWorkspaceDelivery.
    setGates([{ name: "head", command: "git rev-parse HEAD" }]);
    writeDeliveredTask();
    const { reconcileWorkspaceDelivery } = await import("~/server/github/workspace-delivery.server");
    await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      profileId: "dev",
      backend: "codex",
      role: "developer",
      dataRoot: store.dataRoot,
    });
    const minted = task().frontmatter.workRevision!;
    expect(minted.headSha).toBe(laterSha);
    expect(task().frontmatter.gateRun).toMatchObject({ revisionId: minted.id, reason: "revision" });
    await whenProjectGatesIdle();
    const log = readFileSync(
      path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), run().results[0]!.log!),
      "utf8",
    );
    expect(log).toContain(`${laterSha}\n`);
  });
});

describe("the delivery asks for the gates (ruling 104)", () => {
  it("a delivered outcome queues the gates on the revision it delivered", async () => {
    setGates([{ name: "ok", command: "true" }]);
    writeDeliveredTask({ pr: null, verdicts: [], validation: "changed" });
    const outcome = await performDelivery(
      store.db,
      {
        dataRoot: store.dataRoot,
        deps: {
          pushWorkspaceBranch: async () => ({
            status: "pushed",
            branch: "vib-1-work",
            commits: 1,
            headSha: revisionSha,
            remoteHeadBefore: null,
            workflowFiles: [],
          }),
          openTaskPr: async () => ({
            status: "ok",
            prNumber: 7,
            url: "https://github.com/akin-ozer/viberr/pull/7",
            created: true,
          }),
        },
      },
      store.slug,
      "VIB-1",
      actorOf(store.users.arda),
    );
    expect(outcome.status).toBe("delivered");
    // The delivery re-reconciled the checkout, whose head is the later commit,
    // and the gates bind to exactly the revision that re-reconcile recorded.
    const delivered = task().frontmatter.workRevision!;
    expect(delivered.headSha).toBe(laterSha);
    // CANARY: point the request in performDelivery's delivered arm at no
    // project (or drop it) and the delivered revision carries no gate run.
    expect(task().frontmatter.gateRun).toMatchObject({
      revisionId: delivered.id,
      headSha: laterSha,
      reason: "delivery",
    });
    await whenProjectGatesIdle();
    expect(run().status).toBe("finished");
  });
});

describe("as the task owner's agent uid (ruling 139)", () => {
  /** A stand-in `viberr-launch`: logs the uid and the binary, scrubs the
   *  `VIBERR_LAUNCH_*` names as the real one does, and execs. */
  function standInLauncher(): string {
    const dir = ctx.makeTempDir("viberr-launcher-");
    const log = path.join(dir, "launch.log");
    const launcher = path.join(dir, "viberr-launch");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        'if [ "$1" = "--prepare-home" ]; then mkdir -p "$3"; exit 0; fi',
        'if [ "$1" = "--reap" ]; then exit 0; fi',
        `printf 'uid=%s exec=%s args=%s home=%s\\n' "$VIBERR_LAUNCH_UID" "$VIBERR_LAUNCH_EXEC" "$*" "$HOME" >> '${log}'`,
        `env | grep -E '^(VIBERR_SECRET_ENCRYPTION_KEY|VIBERR_SESSION_SECRET)=' | sed 's/^/leaked /' >> '${log}'`,
        'target=$VIBERR_LAUNCH_EXEC',
        "unset VIBERR_LAUNCH_UID VIBERR_LAUNCH_EXEC VIBERR_LAUNCH_HOME",
        'exec "$target" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    resetAgentIsolationForTests({ status: "on", uidFloor: AGENT_UID_FLOOR, reason: null }, { launcher });
    return log;
  }

  it("runs every gate, the clone and the clean-up through the launcher as the owner's uid, with no secret", async () => {
    // CANARY: pass `null` for the launch in runGateJob and no gate line is
    // launched (and with isolation on that is the server running the gate).
    setGates([{ name: "build", command: "echo built" }]);
    writeDeliveredTask();
    const log = standInLauncher();
    await gateOnce();
    expect(run()).toMatchObject({ status: "finished" });
    expect(run().results[0]!.exitCode).toBe(0);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(lines.some((l) => l.startsWith("leaked "))).toBe(false);
    const uid = String(AGENT_UID_FLOOR);
    const gateLine = lines.find((l) => l.includes("args=-c echo built"));
    expect(gateLine).toMatch(new RegExp(`^uid=${uid} exec=/\\S*sh args=-c echo built home=\\S*runtimes/users/${store.users.arda.id}/home$`));
    expect(lines.some((l) => l.startsWith(`uid=${uid} exec=`) && l.includes("args=clone --no-local"))).toBe(true);
    expect(lines.some((l) => l.includes("args=-rf ") && l.startsWith(`uid=${uid} `))).toBe(true);
    expect(listAuditEvents(store.db, { action: "task.gates.run" })[0]!.details).toMatchObject({
      runsAs: AGENT_UID_FLOOR,
    });
  });

  it("refuses to run a task with no owner rather than run it as the server", async () => {
    setGates([{ name: "build", command: "true" }]);
    writeDeliveredTask({ ownerUserId: null });
    standInLauncher();
    await gateOnce();
    expect(run()).toMatchObject({ status: "error", results: [] });
    expect(run().error).toContain("no owner to run them as");
  });
});

/** The limit of a case that waits on several real renders (each a child
 *  process and the stand-in browser) on a loaded machine. */
const REAL_RENDERS_MS = 90_000;

describe("ruling 86: the pages a delivered revision builds are kept as the gates built them", () => {
  /** A build: two pages, and the revision's own work beside them. */
  const BUILD =
    "mkdir -p dist/guide && printf '<h1>home</h1>' > dist/index.html && " +
    "printf '<p>the guide</p>' > dist/guide/index.html && cp work.txt dist/work.txt";
  const buildDir = () => keptBuildDir(store.slug, "VIB-1", "rev_1", store.dataRoot)!;
  const built = () => keptBuildFiles(buildDir());
  const ask = (reason: "delivery" | "gates-changed" = "delivery") =>
    requestProjectGates(store.db, { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }, { reason });
  const captureNotes = () => task().timeline.filter((event) => event.title === "Page captures");

  it("keeps the folder a gate names, built from the delivered revision, once every gate has exited 0", async () => {
    // On the first board that shipped a site through pull requests the
    // reviewer judged a build of its own and nobody pictured the page: the
    // revision's pages existed only in a checkout that was removed.
    setGates([
      { name: "build", command: BUILD, pages: "dist" },
      { name: "check", command: "test -f dist/index.html" },
    ]);
    writeDeliveredTask();

    await gateOnce();

    expect(run().results.map((r) => r.exitCode)).toEqual([0, 0]);
    // CANARY: drop the `keepBuild` call from `runGateJob` and the checkout is
    // removed with the only copy of the revision's pages in it.
    expect(built()).toEqual(["guide/index.html", "index.html", "work.txt"]);
    // The revision's own work: not what the delivering checkout holds now.
    // CANARY: keep the folder from the delivering checkout and this reads
    // "work after the delivery".
    expect(readFileSync(path.join(buildDir(), "work.txt"), "utf8")).toBe("the delivered work\n");
    expect(run().pages).toBe("dist");
    expect(readdirSync(path.join(path.dirname(workspaceDir()), ".gates"))).toEqual([]);
    // No browser is named on this server: nothing is pictured, and the build
    // stands for a reviewer to be shown.
    expect(task().frontmatter.pageCaptures).toBeUndefined();
  });

  it("keeps nothing of a revision whose gates did not all pass", async () => {
    setGates([
      { name: "build", command: BUILD, pages: "dist" },
      { name: "lint", command: "exit 1" },
    ]);
    writeDeliveredTask();
    await gateOnce();
    // CANARY: keep the build whatever the gates' exit codes and a page that
    // failed its checks is pictured and shown as the revision's.
    expect(built()).toEqual([]);
    expect(run().pages).toBeUndefined();
  });

  it("pictures and measures the kept build onto the task, and a waiter is let go only when the pictures are there", { timeout: REAL_RENDERS_MS }, async () => {
    const fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
    setGates([{ name: "build", command: BUILD, pages: "dist" }]);
    writeDeliveredTask();
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("") }, async () => {
      // Nothing of the task's is under way: at once.
      await builtPagesSettled({ projectSlug: store.slug, taskKey: "VIB-1" });
      expect((await ask()).status).toBe("queued");
      await builtPagesSettled({ projectSlug: store.slug, taskKey: "VIB-1" });
      // CANARY: settle the task when its gate job ends, before the render
      // the job asked for, and the delivering run's completion goes on to
      // the operator with no picture on the task yet.
      const record = task().frontmatter.pageCaptures;
      expect(record).toMatchObject({ revisionId: "rev_1", deliveredAt: "2026-09-25T09:00:00.000Z" });
      // Named for the revision, so the next one's pictures never take their
      // place under a name a note or a packet already shows.
      const sha = revisionSha.slice(0, 7);
      expect(record!.pages.map((page) => [page.file, page.shots.map((shot) => shot.name), page.error])).toEqual([
        ["index.html", [`index.html.at-${sha}.capture-desktop.png`, `index.html.at-${sha}.capture-phone.png`], null],
        ["guide/index.html", [`guide--index.html.at-${sha}.capture-desktop.png`, `guide--index.html.at-${sha}.capture-phone.png`], null],
      ]);
      // Ruling 328: measured as it was pictured.
      expect(record!.pages.every((page) => "measured" in page)).toBe(true);
    });
    await whenProjectGatesIdle();
    // The record names the run it was made for, so a restart after this
    // pictures nothing again. CANARY: have the gate job name anything but
    // its own run on the record and every boot renders and notes once more.
    expect(task().frontmatter.pageCaptures).toMatchObject({ gateRunId: run().id });
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("") }, async () => {
      const launches = fake.launches().length;
      await recoverProjectGates(store.db, store.dataRoot);
      await whenProjectGatesIdle();
      expect(fake.launches()).toHaveLength(launches);
    });
    expect(captureNotes()).toHaveLength(1);
    const [note] = captureNotes();
    expect(note!.text).toContain("Viberr rendered `index.html` and `guide/index.html` as a reader sees them");
    expect(note!.text).toContain(`They are the pages of \`${revisionSha.slice(0, 7)}\` as the project's gates built it, and the pictures are attached.`);
    const sha = revisionSha.slice(0, 7);
    expect(note!.attachments).toEqual([
      `index.html.at-${sha}.capture-desktop.png`,
      `index.html.at-${sha}.capture-phone.png`,
      `guide--index.html.at-${sha}.capture-desktop.png`,
      `guide--index.html.at-${sha}.capture-phone.png`,
    ]);
    // The pictures are Viberr's own: no run in flight is credited with them.
    expect(attachmentNamesSince(store.slug, "VIB-1", "2000-01-01T00:00:00.000Z", store.dataRoot).filter((name) => name.endsWith(".png"))).toEqual(
      expect.arrayContaining(note!.attachments!),
    );
    const audit = listAuditEvents(store.db, { action: "task.pages.captured" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ revisionId: "rev_1", pages: 2, captured: 2, failed: [] });
    // The files handed to the renderer are gone again.
    expect(existsSync(path.join(taskDir(store.slug, "VIB-1", store.dataRoot), ".capture-input"))).toBe(false);
  });

  it("says on the task that the gates passed and left no page in the folder a gate names", async () => {
    // A folder misnamed on the gate looks exactly like a site with no page:
    // nothing is pictured, a review is shown nothing, and nobody is told.
    const fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
    setGates([{ name: "build", command: BUILD, pages: "public" }]);
    writeDeliveredTask();
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("") }, async () => {
      await gateOnce();
    });
    // CANARY: return from `captureRevision` without a note when the build
    // holds no page.
    expect(captureNotes().map((note) => note.text)).toEqual([
      `The project's gates passed on \`${revisionSha.slice(0, 7)}\` and left no page in \`public/\`, the folder a gate names for the pages they build. ` +
        "Nothing was pictured or measured, and a review of this revision is shown no page of it.",
    ]);
    expect(fake.launches()).toEqual([]);
    // The record says this revision's build was looked at and held no page,
    // which is what keeps the note from being written again.
    expect(task().frontmatter.pageCaptures).toMatchObject({ revisionId: "rev_1", pages: [] });
  });

  it("pictures a kept build again at boot when a restart cut the pictures off, and says nothing twice", { timeout: REAL_RENDERS_MS }, async () => {
    // The render is asked for after the gate run's finishing write, and a
    // restart drops the queue: the build was on disk, the run read finished,
    // and nothing ever pictured it.
    const fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
    // One file past what a kept build holds, which the note has to say at
    // boot as it would have when the gates ended.
    const oversize = `${BUILD} && dd if=/dev/zero of=dist/film.bin bs=1 count=0 seek=27000000 2>/dev/null`;
    setGates([{ name: "build", command: oversize, pages: "dist" }]);
    writeDeliveredTask();
    // The gates ran and kept the build on a server that pictured nothing.
    await gateOnce();
    expect(built()).toContain("index.html");
    expect(task().frontmatter.pageCaptures).toBeUndefined();
    const boot = async () => {
      expect(await recoverProjectGates(store.db, store.dataRoot)).toBe(0);
      await whenProjectGatesIdle();
    };

    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("") }, async () => {
      // CANARY: leave a finished run alone at boot, as before, and the
      // task keeps no picture and no figure until a person runs the gates.
      await boot();
      expect(task().frontmatter.pageCaptures).toMatchObject({ revisionId: "rev_1" });
      expect(captureNotes()).toHaveLength(1);
      // CANARY: ask at boot with nothing of what the run kept and the note
      // loses the file that was left out.
      expect(captureNotes()[0]!.text).toContain("1 built file was past what a kept build holds and left out.");
      // A build that is pictured is left alone at the next boot.
      const launches = fake.launches().length;
      await boot();
      expect(fake.launches()).toHaveLength(launches);
      expect(captureNotes()).toHaveLength(1);
    });
  });

  it("at boot, says once that a kept build held no page, and pictures nothing on a closed task or where no gate names the folder now", { timeout: REAL_RENDERS_MS }, async () => {
    const fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
    const withBrowser = <T>(run: () => Promise<T>) =>
      withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("") }, run);
    const boot = async () => {
      await recoverProjectGates(store.db, store.dataRoot);
      await whenProjectGatesIdle();
    };
    // The folder a gate names holds no page, and the restart came before
    // the task was told.
    setGates([{ name: "build", command: BUILD, pages: "public" }]);
    writeDeliveredTask();
    await gateOnce();
    expect(captureNotes()).toEqual([]);
    await withBrowser(async () => {
      // CANARY: ask again only for a build that holds a page and a folder
      // misnamed on the gate is never said after a restart.
      await boot();
      expect(captureNotes().map((note) => note.text)).toEqual([expect.stringContaining("left no page in `public/`")]);
      await boot();
      expect(captureNotes()).toHaveLength(1);
    });

    // The folder is corrected on the gate, the gates run again and keep the
    // build, and a restart lands before the render: the record on file is of
    // the earlier run, which found no page.
    setGates([{ name: "build", command: BUILD, pages: "dist" }]);
    expect((await ask("gates-changed")).status).toBe("queued");
    await whenProjectGatesIdle();
    expect(built()).toContain("index.html");
    expect(task().frontmatter.pageCaptures).toMatchObject({ revisionId: "rev_1", pages: [] });
    await withBrowser(async () => {
      // CANARY: take any record of the revision for this run's and the
      // corrected build is never pictured until a person runs the gates.
      await boot();
      expect(task().frontmatter.pageCaptures!.pages.map((page) => page.file)).toEqual(["index.html", "guide/index.html"]);
      expect(task().frontmatter.pageCaptures).toMatchObject({ gateRunId: run().id });
      expect(captureNotes()).toHaveLength(2);
    });

    // A record from before records named their run is of its revision, and
    // is left as it is: the first boot onto an instance that holds one
    // pictures nothing over it. CANARY: ask whenever the record names no
    // run and that boot takes the pictures down, renders again and writes a
    // second note on every task under review.
    const before = task().frontmatter.pageCaptures!;
    const { gateRunId: _made, ...unnamed } = before;
    writeDeliveredTask({ gateRun: run(), pageCaptures: unnamed });
    await withBrowser(async () => {
      const launches = fake.launches().length;
      await boot();
      expect(fake.launches()).toHaveLength(launches);
      expect(task().frontmatter.pageCaptures).toEqual(unnamed);
    });

    // Only a record of this run's revision stands for it. One that names no
    // run and is of an earlier revision hides nothing. CANARY: leave any
    // record that names no run alone and this build is never pictured.
    writeDeliveredTask({ gateRun: run(), pageCaptures: { ...unnamed, revisionId: "rev_0" } });
    await withBrowser(async () => {
      await boot();
      expect(task().frontmatter.pageCaptures).toMatchObject({ revisionId: "rev_1", gateRunId: run().id });
    });

    // A render of an earlier run's build can end after the next run has: its
    // record is newer than this run and of the same revision, and still not
    // of this run's build. CANARY: tell the two apart by the clock and the
    // build this run kept is never pictured.
    writeDeliveredTask({
      gateRun: run(),
      pageCaptures: {
        deliveredAt: "2026-09-25T09:00:00.000Z",
        at: "2099-01-01T00:00:00.000Z",
        pages: [],
        revisionId: "rev_1",
        gateRunId: "gate_of_an_earlier_run",
      },
    });
    await withBrowser(async () => {
      await boot();
      expect(task().frontmatter.pageCaptures).toMatchObject({ gateRunId: run().id });
      expect(task().frontmatter.pageCaptures!.pages).toHaveLength(2);
    });

    // A task that is closed is nobody's to picture: every other asker
    // answers that its gates are not run again.
    setGates([{ name: "build", command: BUILD, pages: "dist" }]);
    writeDeliveredTask();
    await gateOnce();
    writeDeliveredTask({ stage: "done", gateRun: run() });
    await withBrowser(async () => {
      // CANARY: drop the stage check and a restart writes pictures, a note
      // and a new `updatedAt` onto a task that was accepted.
      await boot();
      expect(task().frontmatter.pageCaptures).toBeUndefined();
      expect(captureNotes()).toEqual([]);
    });

    // And where the gate no longer names the folder, a revision is not
    // pictured (ruling 86), whatever an earlier run kept.
    writeDeliveredTask({ gateRun: run() });
    setGates([{ name: "build", command: BUILD }]);
    await withBrowser(async () => {
      // CANARY: decide by the run's own record alone.
      await boot();
      expect(task().frontmatter.pageCaptures).toBeUndefined();
    });
  });

  it("says on the task that a build could not be kept, when the gates end and when a restart cut that off", async () => {
    const fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
    const withBrowser = <T>(run: () => Promise<T>) =>
      withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env("") }, run);
    const couldNot =
      `Viberr could not keep the pages the project's gates built of \`${revisionSha.slice(0, 7)}\` in \`dist/\`. ` +
      "Nothing was pictured or measured, and a review of this revision is shown no page of it. Running the gates again builds and keeps them.";
    setGates([{ name: "build", command: BUILD, pages: "dist" }]);
    writeDeliveredTask();
    // Where the task's builds are kept there is a file: no build's folder
    // can be made.
    mkdirSync(taskDir(store.slug, "VIB-1", store.dataRoot), { recursive: true });
    writeFileSync(path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "builds"), "in the way");

    await withBrowser(() => gateOnce());
    expect(run()).toMatchObject({ status: "finished", pages: "dist" });
    expect(run().pagesKept).toBeUndefined();
    // CANARY: say of a keep that failed what is said of a folder with no
    // page, and a person looks for a misnamed folder that is named right.
    expect(captureNotes().map((note) => note.text)).toEqual([couldNot]);

    // The same on a server that pictured nothing when the gates ended.
    writeDeliveredTask();
    await gateOnce();
    expect(captureNotes()).toEqual([]);
    await withBrowser(async () => {
      await recoverProjectGates(store.db, store.dataRoot);
      await whenProjectGatesIdle();
    });
    // CANARY: ask at boot as though every build had been kept.
    expect(captureNotes().map((note) => note.text)).toEqual([couldNot]);
    expect(fake.launches()).toEqual([]);
  });

  it("runs the gates again on a revision that passed before a gate named the folder, and only once", async () => {
    setGates([{ name: "build", command: BUILD }]);
    writeDeliveredTask();
    await gateOnce();
    expect(built()).toEqual([]);
    expect((await ask("gates-changed")).status).toBe("current");

    // The same commands, and now the folder: the revision owes a build.
    setGates([{ name: "build", command: BUILD, pages: "dist" }]);
    // CANARY: drop `owesBuild` from `requestProjectGates` and a board that
    // names its folder after a delivery keeps no build of that delivery.
    expect((await ask("gates-changed")).status).toBe("queued");
    await whenProjectGatesIdle();
    expect(built()).toContain("index.html");
    expect((await ask("gates-changed")).status).toBe("current");

    // Another folder is another build. One the gates leave empty is kept as
    // nothing once, and not built for ever.
    setGates([{ name: "build", command: BUILD, pages: "public" }]);
    expect((await ask("gates-changed")).status).toBe("queued");
    await whenProjectGatesIdle();
    expect(run().pages).toBe("public");
    expect(built()).toEqual([]);
    // CANARY: decide by whether a build is on disk and this asks again each
    // time, on every open task, for as long as the folder holds nothing.
    expect((await ask("gates-changed")).status).toBe("current");
  });
});
