import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import type {
  Engagement,
  FileActorRef,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import type {
  AgentDeployment,
  CapabilityMode,
} from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { NO_REVIEW_SUBJECT, upsertRun } from "~/server/runtimes/run-store.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { forceAcceptCompletion, acceptanceStanding } from "./task-acceptance.server";
import { recordAgentCompletion } from "./agent-completion.server";
import { resolvePacket } from "./packet-resolution.server";
import { transitionStage } from "./task-transitions.server";
import { operatorAcceptCompletion } from "./operator-moves.server";
import { operatorSnapshot } from "./operator-snapshot.server";
import { resolveOperatorAuthority } from "./operator-authority.server";

/**
 * R19-8 (ruling 62) — "Completed — no changes", end to end.
 *
 * The live dead end (F19-21): VC-5 was a verification-only task. The operator
 * correctly engaged the reviewer alone with NO deliverer; the reviewer approved;
 * the verdict had nothing to bind to, so the quality event read "there is no
 * delivered revision to bind the verdict to yet", `accept_completion` returned
 * "[noop] No reviewed revision yet — nothing for the required reviewers to
 * approve", and the operator opened a packet asking a human how to close the
 * task out — recommending "Manually mark Done", which bypasses the entire
 * acceptance ceremony.
 *
 * Every test below fails against pre-R19-8 main.
 */

// The GitHub surface rides `TaskActionContext`'s test seams instead of module
// mocks: the probe and every accept-time gate run a REAL
// `getProjectGithubContext` — a real credential on the project's repo — over
// the canned transport `remote()` installs (`fetchImpl` on the call ctx), and
// the acceptance merge is the real `mergeTaskPr`, which answers `no_pr` for these
// PR-less tasks before any request.
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";

let ctx: TestDbContext;
let store: TestStore;

const BASE_SHA = "b".repeat(40);

/** `GET /repos/{repo}/compare/{base}...{head}` as the probe consumes it —
 *  mirrors the schema `ghCompareSchema` parses in
 *  app/server/github/branch-sync.server.ts (private there, so the fixture
 *  restates it rather than guessing at it). */
interface CompareBody {
  ahead_by: number;
  behind_by: number;
  status: string;
  commits: { sha: string; commit: { message: string } }[];
}

/** `GET /repos/{repo}/git/ref/heads/{ref}` — the head sha of a ref. */
interface RefBody {
  object: { sha: string };
}

function jsonResponse(
  body: CompareBody | RefBody | { message: string },
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchImpl: typeof fetch;

/** The remote as the probe will see it. `aheadBy: null` means the task branch
 *  does not exist at all (the VC-5 shape); a number means it does. */
function remote(options: { aheadBy?: number | null; network?: boolean } = {}): void {
  const aheadBy = options.aheadBy ?? null;
  fetchImpl = async (input) => {
    if (options.network) throw new TypeError("fetch failed");
    const path = new URL(
      input instanceof Request ? input.url : String(input),
    ).pathname;
    if (path.includes("/compare/")) {
      return jsonResponse({
        ahead_by: aheadBy ?? 0,
        behind_by: 0,
        status: aheadBy ? "ahead" : "identical",
        commits: [],
      });
    }
    if (path.endsWith("/heads/main")) {
      return jsonResponse({ object: { sha: BASE_SHA } });
    }
    // The task branch ref: 404 when the branch was never created.
    return aheadBy === null
      ? jsonResponse({ message: "Not Found" }, 404)
      : jsonResponse({ object: { sha: "c".repeat(40) } });
  };
}

const OPERATOR_POLICY: { capabilityId: string; mode: CapabilityMode }[] = [
  { capabilityId: "append-typed-events", mode: "direct" },
  { capabilityId: "stage-transitions", mode: "direct" },
  { capabilityId: "completion-for-acceptance", mode: "direct" },
];

/** A verdict-capable reviewer profile (+ optionally the operator). Keeps the
 *  project's repo, so the LIVE probe path is what runs. */
function deployAgents(withOperator = false): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    agents: [
      {
        profileId: "reviewer",
        capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
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
      ...(withOperator
        ? [
            {
              profileId: "operator",
              capabilities: OPERATOR_POLICY,
              extras: [],
              definition: {
                kind: "operator",
                name: "Operator",
                backends: ["claude"],
                model: "sonnet",
                // R19-A: a per-run `autonomy: "full"` is CLAMPED to the
                // project's configured ceiling, so a fixture that exercises
                // full-autonomy behaviour must configure full autonomy.
                autonomy: "full",
              },
            } satisfies AgentDeployment,
          ]
        : []),
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const REVIEWER: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};
const DEVELOPER: Engagement = {
  profileId: "developer",
  backend: "claude",
  role: "Implementation",
  delivers: true,
  verdictCapable: false,
};

const REVIEWER_ACTOR: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "reviewer",
  roleHint: "Review & validation",
};

/** The operator's acceptance packet, for the `resolvePacket` path. */
const ACCEPT_PACKET: TaskPacket = {
  id: "pkt_accept",
  type: "input",
  kind: "Decision required",
  from: "operator",
  title: "Accept completion?",
  body: "The review is clean and there is nothing to deliver.",
  observations: [],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "Close it out.", rec: true },
  ],
};

/** The live VC-5 shape: at the review boundary, a verdict-capable reviewer
 *  engaged ALONE, and nothing ever delivered — no branch, no PR, no revision. */
function seedVerificationTask(
  patch: Partial<TaskFrontmatter> = {},
  packet: TaskPacket | null = null,
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      readiness: "ready",
      waiting: "agent",
      ownerUserId: store.users.arda.id,
      title: "Confirm the smoke file exists on main",
      engagements: [REVIEWER],
      ...patch,
    }),
    goal: "Confirm qa/smoke/pass19.md exists on main; NO changes are expected.",
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function task() {
  return readTaskFile({
    projectSlug: store.slug,
    taskKey: "VIB-1",
    dataRoot: store.dataRoot,
  })!.parsed;
}

function completionEvent() {
  return task().timeline.find((e) => e.type === "completion");
}

function arda() {
  return { userId: store.users.arda.id, label: store.users.arda.email };
}

function dataCtx() {
  return {
    dataRoot: store.dataRoot,
    fetchImpl,
  };
}

/** Drive the reviewer's approving verdict exactly as the run pipeline does. */
async function reviewerApproves(): Promise<void> {
  await recordAgentCompletion(store.db, dataCtx(), store.slug, "VIB-1", {
    actorRef: REVIEWER_ACTOR,
    runId: "run_review_1",
    delivers: false,
    replyText: "Checked main: the file is present and correct. Nothing to change.",
    verdict: "approve",
    question: null,
  });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  // The probe runs against a real credential on the project's repo — seeded
  // here so the LIVE `getProjectGithubContext` path is what every test runs.
  const patActor = { userId: store.users.arda.id, label: store.users.arda.email };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_nochange0001" },
    patActor,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
  remote();
  installFakeRuntime();
});

afterEach(() => {
  ctx.cleanup();
});

describe("the verdict binds — a verification revision is minted at review time", () => {
  it("R19-8: a reviewer approving a task with nothing to deliver mints a verification revision and binds the verdict", async () => {
    // CANARY: remove the mint block in recordAgentCompletion — the event reverts
    // to "Approval noted", validation stays "none", and the task is VC-5 again.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();

    const fm = task().frontmatter;
    expect(fm.workRevision).not.toBeNull();
    expect(fm.workRevision?.kind).toBe("verified");
    expect(fm.workRevision?.headSha).toBe(BASE_SHA);
    expect(fm.workRevision?.branch).toBeNull();
    expect(fm.noChanges).toBe(true);
    // The verdict now HAS a subject, so it binds and derives a pass.
    expect(fm.verdicts).toHaveLength(1);
    expect(fm.verdicts[0]?.revisionId).toBe(fm.workRevision?.id);
    expect(fm.validation).toBe("healthy");

    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.title).toBe("Review passed");
    expect(quality?.text).toContain("nothing to deliver");
    expect(quality?.text).toContain("`main`");
    expect(quality?.text).toContain(BASE_SHA.slice(0, 12));
    // The live sentence this replaces.
    expect(quality?.text).not.toContain("no delivered revision to bind");

    // …and the acceptance affordance is now OPEN for the human.
    const affordance = acceptanceStanding(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      dataCtx(),
    ).affordance;
    expect(affordance.blockedReason).toBeNull();
    expect(affordance.canAccept).toBe(true);
  });

  it("R19-8: a reviewer approving while a deliverer is engaged mints NOTHING", async () => {
    // The mid-run hazard: the branch does not exist YET, which is not the same
    // as never. CANARY: drop the `deliveringEngagement(pre) === null`
    // precondition and an in-flight delivery gets marked "no changes".
    deployAgents();
    seedVerificationTask({ engagements: [DEVELOPER, REVIEWER] });
    await reviewerApproves();

    const fm = task().frontmatter;
    expect(fm.workRevision).toBeNull();
    expect(fm.noChanges).toBeFalsy();
    expect(fm.validation).toBe("none");
    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.title).toBe("Approval noted");
  });

  it("ruling 543: files another agent saved are not \"nothing to deliver\": no mint, and the note says to hand delivery", async () => {
    // Live on AWSC-2 the Workflow Researcher saved the result as a supporting
    // agent (before ruling 535 let it deliver), and the Estimate Judge's
    // approval would have been recorded against `main` as "no changes".
    // CANARY: drop the `filesSavedByOtherAgents` precondition and this mints.
    deployAgents();
    seedVerificationTask();
    await updateTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot }, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        type: "comment",
        actor: { kind: "agent", backend: "codex", profileId: "researcher", roleHint: "Workflow Researcher" },
        title: null,
        text: "Delivered mapping-review.md.",
        toAgent: false,
        evidence: null,
        attachments: ["mapping-review.md"],
      });
    });
    await reviewerApproves();

    const fm = task().frontmatter;
    expect(fm.workRevision).toBeNull();
    expect(fm.noChanges).toBeFalsy();
    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.title).toBe("Approval noted");
    expect(quality?.text).toContain(
      "Workflow Researcher saved `mapping-review.md` without being handed delivery. Hand delivery to the agent that made the result (`run_agent` with `delivers: true`)",
    );
  });

  it("ruling 583: an objection with nothing delivered says it binds to nothing", async () => {
    // Live on AWSC-19 the event read "Validation: none. Estimate Judge
    // requested changes." over a record that held no verdict at all.
    // CANARY: word the unbound objection like a bound one again.
    deployAgents();
    seedVerificationTask();
    await recordAgentCompletion(store.db, dataCtx(), store.slug, "VIB-1", {
      actorRef: REVIEWER_ACTOR,
      runId: "run_review_1",
      delivers: false,
      replyText: "The smoke file is missing from main.",
      verdict: "request_changes",
      question: null,
    });
    expect(task().frontmatter.verdicts).toEqual([]);
    const quality = task().timeline.find((e) => e.type === "quality");
    // Ruling 693: its title says so too, which keeps it out of the count of
    // times the work was sent back.
    expect(quality?.title).toBe("Changes requested, not counted");
    expect(quality?.text).toContain(
      "requested changes, but nothing on this task has been delivered for the verdict to bind to, so it does not count.",
    );
    // The timeline still draws it as the reviewer's verdict (ruling 526): the
    // card with the cross, and why it does not count under its head.
    // CANARY: read the bare title alone as a request for changes in
    // `verdictNoteView` and this note is drawn as a line of text, with no
    // card and no mark.
    const card = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.find((e) => e.type === "quality")!.verdict;
    expect(card).toMatchObject({ result: "request_changes", sha: null });
    expect(card?.detail).toContain("so it does not count.");
  });

  it("ruling 543: an approval of the files a result was delivered in says it bound to them", async () => {
    // Ruling 388 bound it all along; the note read "there is no delivered
    // revision to bind the verdict to yet" beside a healthy validation.
    // CANARY: branch the note on `rev` again instead of the review subject.
    deployAgents();
    seedVerificationTask({ engagements: [DEVELOPER, REVIEWER], deliveredAt: "2026-09-28T08:00:00.000Z" });
    await reviewerApproves();

    const fm = task().frontmatter;
    expect(fm.verdicts.map((v) => v.revisionId)).toEqual(["files:2026-09-28T08:00:00.000Z"]);
    expect(fm.validation).toBe("healthy");
    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.title).toBe("Review passed");
    expect(quality?.text).toContain("approved the work on the files delivered on this task");
  });

  it("ruling 544: a sibling reviewer's approval binds to the verification a first approval minted", async () => {
    // Both reviewers were sent to judge a task with nothing delivered. The
    // first approval minted a verification revision of the base; the second
    // judged that same base, and its approval is not about a delivery it
    // never read. CANARY: drop `mintedSince` and the second approval binds to
    // nothing, its note saying it started before the base sha was delivered.
    deployAgents();
    const verifier: Engagement = { ...REVIEWER, profileId: "verifier", role: "Verification" };
    seedVerificationTask({ engagements: [REVIEWER, verifier] });
    await reviewerApproves();
    upsertRun(store.db, {
      id: "run_verifier",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t-verifier",
      role: "Verification",
      kind: "reviewer",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      agentProfileId: "verifier",
      state: "finished",
      reviewSubject: NO_REVIEW_SUBJECT,
    });
    await recordAgentCompletion(store.db, dataCtx(), store.slug, "VIB-1", {
      actorRef: { ...REVIEWER_ACTOR, profileId: "verifier", roleHint: "Verification" },
      runId: "run_verifier",
      delivers: false,
      replyText: "Checked main as well: nothing to change.",
      verdict: "approve",
      question: null,
    });
    const fm = task().frontmatter;
    const minted = fm.workRevision?.id;
    expect(fm.workRevision?.kind).toBe("verified");
    expect(fm.verdicts.map((v) => [v.profileId, v.revisionId])).toEqual([
      ["reviewer", minted],
      ["verifier", minted],
    ]);
  });

  it("R19-8: a reviewer approving a task that already has a branch mints nothing", async () => {
    deployAgents();
    seedVerificationTask({ branch: "vib-1" });
    await reviewerApproves();
    expect(task().frontmatter.workRevision).toBeNull();
    expect(task().frontmatter.noChanges).toBeFalsy();
  });

  it("R19-8: a verification revision alone clears the verdict gate", async () => {
    // `verdictGateReason` refuses "delivered work with no PR". A verification
    // revision is not delivered work, and that must hold on the revision KIND
    // alone — the `noChanges` flag is a separate fact, and pinning only the
    // flag would let the kind arm be deleted with every test still green.
    // CANARY: remove `|| fm.workRevision.kind === "verified"` from
    // verdictGateReason — this reads "deliver the branch & open the PR".
    deployAgents();
    seedVerificationTask({
      engagements: [],
      validation: "healthy",
      workRevision: {
        id: "rev_v9",
        headSha: BASE_SHA,
        treeSha: null,
        branch: null,
        createdAt: "2026-08-06T09:00:00.000Z",
        sourceProfileId: null,
        kind: "verified",
      },
    });
    const affordance = acceptanceStanding(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      dataCtx(),
    ).affordance;
    expect(affordance.blockedReason).toBeNull();
  });

  it("R19-8: an unverifiable remote mints nothing — the mint fails closed too", async () => {
    deployAgents();
    seedVerificationTask();
    remote({ network: true });
    await reviewerApproves();
    expect(task().frontmatter.workRevision).toBeNull();
    expect(task().frontmatter.noChanges).toBeFalsy();
  });
});

describe("acceptance closes it — with its OWN completion event, and no merge", () => {
  it("R19-8: acceptance closes it to Done with the no-change completion event and merges nothing", async () => {
    // CANARY: delete the `noChange.applies` arm from acceptCompletion's event
    // builder — the title falls back to "Completion accepted" and the record
    // stops naming what was verified.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );

    expect(task().frontmatter.stage).toBe("done");
    expect(task().frontmatter.pr).toBeNull();
    const completion = completionEvent();
    expect(completion?.title).toBe("Completed with no changes");
    expect(completion?.text).toContain("completed with no changes");
    expect(completion?.text).toContain(BASE_SHA.slice(0, 12));
    expect(completion?.text).not.toMatch(/merged/i);
  });

  it("ruling 550: a task delivered as files is accepted as delivered, never as \"completed with no changes\"", async () => {
    // Live on AWSC-2 the acceptance of a research task whose delivery is two
    // files would have probed GitHub, found no branch (a files task never has
    // one) and recorded the delivered result as having no changes.
    // CANARY: drop `deliveredAsFiles(fm)` from acceptanceNoChangeCheck and the
    // task closes as "Completed with no changes" with `noChanges: true`.
    deployAgents();
    seedVerificationTask({ engagements: [DEVELOPER, REVIEWER], deliveredAt: "2026-09-28T08:44:13.751Z" });
    await reviewerApproves();
    remote();
    const probed: string[] = [];
    const answer = fetchImpl;
    fetchImpl = async (input, init) => {
      probed.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      return answer(input, init);
    };

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );

    expect(task().frontmatter.stage).toBe("done");
    expect(task().frontmatter.noChanges).toBeFalsy();
    const completion = completionEvent();
    expect(completion?.title).toBe("Completion accepted");
    expect(completion?.text).not.toMatch(/no changes/i);
    expect(probed.filter((p) => p.includes("/git/ref"))).toEqual([]);
  });

  it("F28-L1: an UNCLAIMED delivered task the probe proves empty is accepted (auto-detect)", async () => {
    // A delivered task with a branch + a work revision, but the deliverer never
    // set `noChanges`, no PR was opened, and the branch is 0 commits ahead of
    // main (e.g. a shallow-clone speculative mint, or an out-of-band branch
    // reset). No required reviewer, so the only bar is the R15-1 verdict gate.
    seedVerificationTask({
      engagements: [],
      branch: "vib-1-work",
      workRevision: {
        id: "rev_unclaimed",
        headSha: BASE_SHA,
        treeSha: "t".repeat(40),
        branch: "vib-1-work",
        createdAt: "2026-08-26T09:00:00.000Z",
        sourceProfileId: "developer",
        kind: "delivered",
      },
    });
    // Branch exists and is verified EMPTY (0 ahead) — the R20-2 auto-detect case.
    remote({ aheadBy: 0 });

    // Before F28-L1 the SYNC verdict gate threw "has delivered work but no review
    // pull request" here — before the async probe (the auto-detect built to
    // accept exactly this) ever ran. Now the probe runs first and clears the gate.
    // CANARY: drop `|| noChangeVerified` from verdictGateReason and this refuses.
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );

    const fm = task().frontmatter;
    expect(fm.stage).toBe("done");
    // The server repaired the durable flag to match the proven outcome (R20-2).
    expect(fm.noChanges).toBe(true);
    // No PR existed, so nothing merged — it closed as a no-change completion.
    expect(fm.pr).toBeNull();
    expect(completionEvent()?.text).toContain("completed with no changes");
  });

  it("R19-8 fails CLOSED: a branch that gained commits refuses the acceptance", async () => {
    // The whole reason the stored flag is not the evidence. CANARY: remove the
    // check from BOTH acceptCompletion and applyAcceptanceWrite — either layer
    // alone still refuses, which is the point of the two-layer guard.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();
    // …and THEN a delivery lands on the branch, out of band.
    remote({ aheadBy: 2 });

    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        arda(),
        dataCtx(),
      ),
    ).rejects.toThrow(/carries 2 commit\(s\) ahead of `main`/);

    expect(task().frontmatter.stage).toBe("review");
    expect(completionEvent()).toBeUndefined();
  });

  it("R19-8: an unverifiable remote refuses, and force-accept says the check did not pass", async () => {
    // CANARY: pass a non-null `verification` when forced — the event would then
    // claim a verification that never happened.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();
    remote({ network: true });

    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        arda(),
        dataCtx(),
      ),
    ).rejects.toThrow(/could not be reached/i);
    expect(task().frontmatter.stage).toBe("review");

    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      arda(),
      dataCtx(),
    );
    expect(task().frontmatter.stage).toBe("done");
    const completion = completionEvent();
    expect(completion?.title).toBe("Completed with no changes");
    expect(completion?.text).toContain("WITHOUT a passing remote re-check");
    expect(completion?.text).not.toContain("completed with no changes");
    expect(listAuditEvents(store.db, { action: "task.acceptance.forced" })).toHaveLength(1);
  });

  it("R19-8: the packet path runs the same check", async () => {
    // CANARY: remove the check from resolvePacket's inlined accept.
    deployAgents();
    seedVerificationTask({}, ACCEPT_PACKET);
    await reviewerApproves();
    remote({ aheadBy: 2 });

    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        arda(),
        dataCtx(),
      ),
    ).rejects.toThrow(/carries 2 commit\(s\) ahead of `main`/);
    expect(task().frontmatter.stage).toBe("review");
  });

  it("R19-8: the packet path closes a verified task with the shared event", async () => {
    deployAgents();
    seedVerificationTask({}, ACCEPT_PACKET);
    await reviewerApproves();

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      arda(),
      dataCtx(),
    );
    expect(task().frontmatter.stage).toBe("done");
    expect(completionEvent()?.title).toBe("Completed with no changes");
    expect(completionEvent()?.text).not.toMatch(/merged/i);
  });
});

/**
 * Ruling 576: live on AWSC-11 the Estimate Judge, the board's required
 * reviewer, ran as a supporting agent (ruling 556), corrected its golden-set
 * entry three times and approved. Nothing went to the repository, so the task
 * read as R19-8's shape: the approval said "there is nothing to deliver", the
 * operator's card offered "Complete AWSC-11 with no changes" and the record
 * says "completed with no changes", of a task whose whole outcome was the
 * three corrections.
 */
describe("ruling 576: a task that corrected a knowledge base did not complete with no changes", () => {
  /** A correction written on VIB-1 by `actorRef`, the way the agent tool writes it. */
  async function correctOnTask(actorRef: FileActorRef, filedBy: string): Promise<{ id: string; dir: string }> {
    const { saveKnowledgeBase, resolveStoreTarget } = await import("~/server/org/resources.server");
    const { writeStoreDoc } = await import("~/server/org/store-files.server");
    const { correctKnowledgeDoc } = await import("./kb-correction-actions.server");
    const { kb } = await saveKnowledgeBase(store.db, { name: "judge-keys", refresh: "on change" }, arda(), {
      dataRoot: store.dataRoot,
    });
    const target = resolveStoreTarget(store.db, "kb", kb.id, { dataRoot: store.dataRoot })!;
    writeStoreDoc(store.db, target, [], "sample-01.md", "# Keys\n\n- SAN: as written.\n", arda());
    const result = await correctKnowledgeDoc(store.db, { dataRoot: store.dataRoot }, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kb: kb.dir,
      doc: "sample-01.md",
      replaces: "- SAN: as written.",
      text: "- SAN: priceable as the calculator prices it today.",
      evidence: "the calculator's form for the service",
      actorRef,
      filedBy,
      auditActor: { userId: null, label: "agent" },
      allowedKbs: [kb.dir],
    });
    expect(result.outcome).toBe("done");
    return { id: /kc-[0-9a-f]{10}/.exec(result.message)![0], dir: kb.dir };
  }

  it("the approval, the operator's card and the completion record name the correction, and say its reviewer made it", async () => {
    // CANARIES: drop the corrections from the verdict note, from the card, or
    // from any writer's completion event, and its assertion goes red; drop the
    // `every` check on who made them and the second test goes red.
    deployAgents(true);
    seedVerificationTask();
    const { id, dir } = await correctOnTask(REVIEWER_ACTOR, "Review & validation");
    await reviewerApproves();
    const named = `\`${id}\` in \`${dir}/sample-01.md\`, by Review & validation`;

    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.text).toContain("Review & validation approved: nothing goes to the repository.");
    expect(quality?.text).toContain(
      `This task's outcome is the knowledge-base corrections made on it, which stand: ${named}, so this approval is not a review of them. ` +
        "Accepting completes this task with no repository changes.",
    );
    expect(quality?.text).not.toContain("there is nothing to deliver");

    const offered = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "supervised" }),
    );
    expect(offered.outcome).toBe("recommended");
    const card = task().frontmatter.recommendations[0];
    expect(card?.label).toBe("Complete VIB-1 with no repository changes and move it to Done");
    expect(card?.detail).toContain(`Its outcome is the knowledge-base corrections made on it, which stand: ${named}.`);

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );
    const completion = completionEvent();
    expect(completion?.title).toBe("Completed with no repository changes");
    expect(completion?.text).toContain(
      `**VIB-1 completed with no repository changes**. Its outcome is the knowledge-base corrections made on it, which stand: ${named}. Nothing was delivered`,
    );
  });

  it.each([
    {
      door: "the packet path",
      packet: ACCEPT_PACKET,
      close: () =>
        resolvePacket(store.db, { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 }, arda(), dataCtx()),
    },
    {
      door: "the operator under full autonomy",
      packet: null,
      close: () =>
        operatorAcceptCompletion(
          store.db,
          dataCtx(),
          { projectSlug: store.slug, taskKey: "VIB-1" },
          resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "full" }),
        ),
    },
  ])("$door names the correction on the completion record too", async ({ packet, close }) => {
    deployAgents(true);
    seedVerificationTask({}, packet);
    const { id } = await correctOnTask(REVIEWER_ACTOR, "Review & validation");
    await reviewerApproves();
    await close();
    expect(task().frontmatter.stage).toBe("done");
    expect(completionEvent()?.title).toBe("Completed with no repository changes");
    expect(completionEvent()?.text).toContain(`Its outcome is the knowledge-base corrections made on it, which stand: \`${id}\``);
  });

  it("names another agent's correction without claiming the approval skipped it, and forgets one a person undid", async () => {
    deployAgents(true);
    seedVerificationTask();
    const developer: FileActorRef = { kind: "agent", backend: "claude", profileId: "developer", roleHint: "Implementation" };
    const { id } = await correctOnTask(developer, "Implementation");
    await reviewerApproves();
    const quality = task().timeline.find((e) => e.type === "quality");
    expect(quality?.text).toContain(`\`${id}\``);
    expect(quality?.text).toContain("by Implementation. Accepting completes this task with no repository changes.");
    expect(quality?.text).not.toContain("not a review of them");

    const { undoKbCorrectionOnTask } = await import("./kb-correction-actions.server");
    const undone = await undoKbCorrectionOnTask(
      store.db,
      { dataRoot: store.dataRoot },
      { id, projectSlug: store.slug, reason: null, person: { userId: store.users.arda.id, label: "arda", name: "Arda" } },
    );
    expect(undone.outcome).toBe("done");
    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );
    const completion = completionEvent();
    expect(completion?.title).toBe("Completed with no changes");
    expect(completion?.text).toContain("**VIB-1 completed with no changes**.");
    expect(completion?.text).not.toContain(id);
  });
});

describe("the operator reaches the outcome without deliver_for_review", () => {
  it("R19-8: supervised recommends completing with no changes, and does not promise a merge", async () => {
    // CANARY: restore the old single `detail` string — the card tells a human
    // that applying it merges a PR the task does not have.
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "supervised" }),
    );
    expect(result.outcome).toBe("recommended");
    const rec = task().frontmatter.recommendations[0];
    expect(rec?.label).toMatch(/no changes/i);
    // Read off the card itself: the timeline also carries the reviewer's
    // "nothing to deliver" verdict, which never mentions a merge either.
    expect(rec?.detail).toContain("nothing is merged");
    expect(rec?.detail).not.toContain("merges the review PR");
  });

  it("R19-8: full autonomy closes it with the no-change event", async () => {
    // CANARY: delete the operator's `noChange.applies` arm.
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "full" }),
    );
    expect(result.outcome).toBe("done");
    expect(task().frontmatter.stage).toBe("done");
    expect(completionEvent()?.title).toBe("Completed with no changes");
    expect(completionEvent()?.text).toContain("full-autonomy");
    expect(completionEvent()?.text).not.toMatch(/merged/i);
  });

  it("R19-8: full autonomy is REFUSED when the branch carries work", async () => {
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();
    remote({ aheadBy: 4 });

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "full" }),
    );
    expect(result.outcome).toBe("noop");
    expect(result.message).toMatch(/carries 4 commit\(s\)/);
    expect(task().frontmatter.stage).toBe("review");
  });

  it("R19-8: the operator can SEE the shape — get_task carries `noChanges`", async () => {
    // CANARY: drop the snapshot field — the operator is blind again and opens a
    // "how do we close this out?" packet instead of accepting.
    deployAgents(true);
    seedVerificationTask();
    expect(
      operatorSnapshot(store.db, dataCtx(), store.slug, "VIB-1", resolveOperatorAuthority(dataCtx(), store.slug, {})).noChanges,
    ).toBe(false);
    await reviewerApproves();
    expect(
      operatorSnapshot(store.db, dataCtx(), store.slug, "VIB-1", resolveOperatorAuthority(dataCtx(), store.slug, {})).noChanges,
    ).toBe(true);
  });

  it("F19-21 regression: the old dead end is gone", async () => {
    // The verbatim live noop. CANARY: revert the mint — this sentence returns.
    deployAgents(true);
    seedVerificationTask();
    await reviewerApproves();

    const result = await operatorAcceptCompletion(
      store.db,
      dataCtx(),
      { projectSlug: store.slug, taskKey: "VIB-1" },
      resolveOperatorAuthority(dataCtx(), store.slug, { autonomy: "full" }),
    );
    expect(result.outcome).not.toBe("noop");
    expect(result.message).not.toContain("No reviewed revision yet");
  });
});

/**
 * OBS-11 + OBS-13 (pass 21) — what the no-change acceptance does with the
 * branch it just proved empty.
 *
 * OBS-11, live on vib-3: the acceptance verified "carries no commits ahead of
 * main" and then left the branch on GitHub forever — merged branches are
 * cleaned up by R15-6's policy, the one outcome that GUARANTEES an empty branch
 * was not.
 *
 * OBS-13, live on vib-5: the same re-check read a branch the task never
 * created. VIB-5's agent held no repo capability, so nothing branched — but a
 * `vib-5` left over from a previous data root existed, the probe falls back to
 * the DERIVED name, and the acceptance record claimed "Branch vib-5 carries no
 * commits ahead of main" about a stranger. Harmless there (it was behind main);
 * with anything else on it, the copy is a lie and a deletion would be worse.
 */
describe("OBS-11 / OBS-13 — the empty branch a no-change acceptance leaves behind", () => {
  /** Wraps the standing transport so DELETEs are recorded (and answered)
   *  instead of falling through to the ref/compare responder. */
  function captureDeletes() {
    const inner = fetchImpl;
    const paths: string[] = [];
    fetchImpl = async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const path = new URL(
        input instanceof Request ? input.url : String(input),
      ).pathname;
      if (method === "DELETE") {
        paths.push(path);
        return new Response(null, { status: 204 });
      }
      return inner(input, init);
    };
    return { paths };
  }

  /**
   * The OTHER no-change shape (R17-2 / F17-L9): a task that DID branch, whose
   * delivery then found the branch empty (`noChanges`) — so the branch on the
   * remote is the task's own, which is the only branch a cleanup may remove.
   * Seeded with its delivered revision and the reviewer's approval on it, since
   * the verdict-time mint deliberately skips a task that already has a branch.
   */
  function seedEmptyBranchTask(packet: TaskPacket | null = null): void {
    const headSha = "d".repeat(40);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        readiness: "ready",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        engagements: [REVIEWER],
        branch: "vib-1",
        noChanges: true,
        workRevision: {
          id: "rev_empty",
          headSha,
          treeSha: "t".repeat(40),
          branch: "vib-1",
          createdAt: "2026-08-19T09:00:00.000Z",
          sourceProfileId: "developer",
          kind: "delivered",
        },
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_empty",
            headSha,
            result: "approve",
            reason: "Nothing to change.",
            at: "2026-08-19T09:30:00.000Z",
            rounds: 1,
          },
        ],
        validation: "healthy",
      }),
      goal: "Fix the flake; it turned out to already be fixed.",
      packet,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  /** Flip R15-6's post-merge branch cleanup off for this project. */
  function branchCleanupOff(): void {
    const file = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      guardrails: [
        {
          id: "delete-branch-after-merge",
          desc: "Delete the task's branch on GitHub once its review PR is merged.",
          on: false,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("OBS-11: deletes the task's OWN empty branch once the completion is accepted", async () => {
    // CANARY: drop the `branchDisposition.kind === "delete"` block from
    // acceptCompletion — no DELETE is sent and vib-3's branch lives on.
    deployAgents();
    seedEmptyBranchTask();
    remote({ aheadBy: 0 }); // the branch EXISTS and is 0 commits ahead
    const deletes = captureDeletes();

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );

    expect(task().frontmatter.stage).toBe("done");
    expect(deletes.paths).toEqual([
      "/repos/akin-ozer/viberr/git/refs/heads/vib-1",
    ]);
    // `deleteTaskRemoteBranch` writes its own honest record of the deletion.
    expect(
      task().timeline.some((e) => e.text.includes("Deleted branch `vib-1` from GitHub.")),
    ).toBe(true);
  });

  it("OBS-11: the packet path deletes the same empty branch the Accept button does", async () => {
    // CANARY: drop the `cleanUpEmptyTaskBranch` call from resolvePacket — no
    // DELETE is sent and the branch this acceptance closed over lives on.
    //
    // A no-change task can be closed through the Accept button OR through an
    // operator decision packet. Only the first ran the cleanup, so the same
    // branch's fate depended on which door the human used.
    deployAgents();
    seedEmptyBranchTask(ACCEPT_PACKET);
    remote({ aheadBy: 0 });
    const deletes = captureDeletes();

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      arda(),
      dataCtx(),
    );

    expect(task().frontmatter.stage).toBe("done");
    expect(deletes.paths).toEqual([
      "/repos/akin-ozer/viberr/git/refs/heads/vib-1",
    ]);
    expect(
      task().timeline.some((e) => e.text.includes("Deleted branch `vib-1` from GitHub.")),
    ).toBe(true);
  });

  it("OBS-11: leaves the branch when the project switched cleanup off — and says so", async () => {
    // CANARY: ignore `branchCleanupOnMerge` — the branch is deleted against the
    // project's own policy, and the completion record says nothing either way.
    deployAgents();
    branchCleanupOff();
    seedEmptyBranchTask();
    remote({ aheadBy: 0 });
    const deletes = captureDeletes();

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );

    expect(task().frontmatter.stage).toBe("done");
    expect(deletes.paths).toEqual([]);
    expect(completionEvent()?.text).toContain(
      "The empty branch `vib-1` was left on GitHub",
    );
  });

  it("OBS-13: a branch that only matches by NAME is flagged as a collision, never deleted", async () => {
    // The live vib-5 shape: the task recorded no branch of its own, and a
    // leftover of the same name sits on the remote. CANARY: drop the
    // `fm.branch !== branch` arm — the record claims the stranger as this
    // task's branch and the cleanup deletes it.
    deployAgents();
    seedVerificationTask(); // no `branch` on the task
    await reviewerApproves();
    remote({ aheadBy: 0 }); // a `vib-1` exists on the remote anyway
    const deletes = captureDeletes();

    await transitionStage(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
      arda(),
      dataCtx(),
    );

    expect(task().frontmatter.stage).toBe("done");
    expect(deletes.paths).toEqual([]);
    const text = completionEvent()?.text ?? "";
    expect(text).toContain("VIB-1 never recorded a branch of its own");
    expect(text).toContain("It was left untouched");
  });

  it("OBS-13: a same-name branch carrying commits refuses the acceptance and is not touched", async () => {
    // The dangerous half of the collision: a leftover that has DIVERGED. The
    // has-work refusal already stops the close; what must also hold is that
    // nothing deletes it on the way past.
    deployAgents();
    seedVerificationTask();
    await reviewerApproves();
    remote({ aheadBy: 3 });
    const deletes = captureDeletes();

    await expect(
      transitionStage(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "done" },
        arda(),
        dataCtx(),
      ),
    ).rejects.toThrow(/carries 3 commit\(s\) ahead of `main`/);

    expect(task().frontmatter.stage).toBe("review");
    expect(deletes.paths).toEqual([]);
  });
});
