import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import type {
  ParsedTaskFile,
  TaskFileEvent,
  TaskPacket,
} from "~/schemas/task-file.schema";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "~/server/runtimes/adapter.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  configureRunServiceForTests,
  interruptRun,
} from "~/server/runtimes/run-service.server";
import {
  listRunLines,
  listRunsForTaskRows,
  upsertRun,
} from "~/server/runtimes/run-store.server";
import { RUN_INPUTS_TAG } from "~/features/runtime/runtime-types";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import {
  canonicalTaskAnchor,
  commentToAgent,
  specialistReplyDirective,
  updateTaskGoal,
} from "./task-actions.server";

/**
 * P13-D-3 — a reactivated agent re-anchors on the canonical task artifact
 * (prd.md:118-119, :134).
 *
 * `specialistReplyDirective` is the ENTIRE prompt a resumed specialist gets on
 * an @mention. It used to carry only the commenter, the task key/title, the raw
 * comment, a trust-boundary paragraph and a delivery rule — no task state at
 * all — so a resumed agent worked from provider-session memory alone and kept
 * running a goal that had since been edited (live case UC-30).
 */

let ctx: TestDbContext;
let store: TestStore;

/** Every RunSpec the fake adapter was handed, newest last. */
const specs: RunSpec[] = [];

function recordingAdapter(backend: "claude" | "codex"): RuntimeAdapter {
  return {
    backend,
    start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
      specs.push(spec);
      let stopped = false;
      queueMicrotask(() => {
        if (stopped) return;
        stopped = true;
        callbacks.onExit({
          outcome: "finished",
          effectiveBackend: spec.backend,
          sessionId: spec.resumeSessionId ?? `fake-${spec.runId}`,
        });
      });
      return {
        runId: spec.runId,
        interrupt() {
          if (stopped) return;
          stopped = true;
          callbacks.onExit({
            outcome: "interrupted",
            effectiveBackend: spec.backend,
            sessionId: spec.resumeSessionId ?? `fake-${spec.runId}`,
          });
        },
      };
    },
  };
}

function deployDev(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "dev",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "dev",
          role: "developer",
          backends: ["claude"],
          model: "claude-sonnet",
        },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function parsed(overrides: Partial<ParsedTaskFile> = {}): ParsedTaskFile {
  return {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      readiness: "ready",
      waiting: "agent",
      validation: "changed",
      title: "Attach execution workspace",
      branch: "vib-1-attach-execution-workspace",
      pr: { number: 318, state: "review", title: "[VIB-1] Attach" },
    }),
    unknownFrontmatter: {},
    goal: "Ship the CURRENT goal, not the one you remember.",
    packet: null,
    timeline: [],
    extraSections: [],
    ...overrides,
  };
}

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  specs.length = 0;
  resetSseBrokerForTests();
  configureRunServiceForTests({
    claude: recordingAdapter("claude"),
    codex: recordingAdapter("codex"),
  });
  // Ruling 127: a resumed specialist bills the TASK OWNER's own account, so
  // the resume only reaches an adapter when the owner (arda, who owns VIB-1
  // here) has the backend connected. Without it the reply is refused before a
  // prompt is ever built, and this file asserts on the prompt.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
});

afterEach(async () => {
  for (const run of listRunsForTaskRows(store.db, store.slug, "VIB-1")) {
    if (run.state === "running" || run.state === "queued") {
      try {
        await interruptRun(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", runId: run.id, dataRoot: store.dataRoot },
          { userId: store.users.arda.id, label: store.users.arda.email },
        );
      } catch {
        // ignore
      }
    }
  }
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("canonicalTaskAnchor", () => {
  it("carries goal, stage, readiness, waiting, validation and the delivery refs", () => {
    const anchor = canonicalTaskAnchor({ parsed: parsed(), stageName: "In Progress" });
    expect(anchor).toContain("Ship the CURRENT goal, not the one you remember.");
    expect(anchor).toContain("stage: In Progress");
    expect(anchor).toContain("readiness: ready");
    expect(anchor).toContain("waiting: agent");
    expect(anchor).toContain("validation: changed");
    expect(anchor).toContain("vib-1-attach-execution-workspace");
    expect(anchor).toContain("PR #318 (review)");
    expect(anchor).toContain("VIB-1");
    // It must SAY that it outranks the agent's own memory, or a model with a
    // long session simply trusts what it already believes.
    expect(anchor).toMatch(/not the source of truth/i);
  });

  it("includes an open decision packet with its options", () => {
    const packet: TaskPacket = {
      type: "input",
      kind: "Decision required",
      from: "operator",
      title: "Which storage backend?",
      body: "Two viable options.",
      observations: [],
      options: [
        { kind: "custom", t: "SQLite", d: "", rec: true },
        { kind: "custom", t: "Postgres", d: "", rec: false },
      ],
    };
    const anchor = canonicalTaskAnchor({ parsed: parsed({ packet }), stageName: "Review" });
    expect(anchor).toContain("Which storage backend?");
    expect(anchor).toContain("SQLite");
    expect(anchor).toContain("Postgres");
  });

  /**
   * Ruling 392 (F39-19), live on ax-clone AX-12: the operator wrote
   * "@Developer … read the Reviewer's request-changes findings in the timeline",
   * and no agent can. `read_board` answers stage, readiness, waits, archived and
   * goal, with no timeline at all; this anchor is every other word an agent
   * gets, and it clamps each entry to 220 characters — shorter than any verdict
   * worth reworking against. The deliverer raised a decision packet asking a
   * human to paste them, which cost a run and a human decision.
   */
  it("ruling 392: the standing verdicts ride WHOLE, because rework has nowhere else to read them", () => {
    const reason =
      "Blocking findings:\n\n- internal/store/store.go:825 snapshot errors occur " +
      "after the WAL is synced, so Create returns an error while Get sees the object. " +
      "X".repeat(600);
    const anchor = canonicalTaskAnchor({
      parsed: parsed({
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          validation: "failing",
          workRevision: {
            id: "rev_1",
            headSha: "c".repeat(40),
            treeSha: "t".repeat(40),
            branch: "vib-1",
            createdAt: "2026-09-22T04:48:51.861Z",
            sourceProfileId: "developer",
          },
          verdicts: [
            {
              profileId: "reviewer",
              revisionId: "rev_1",
              headSha: "c".repeat(40),
              result: "request_changes",
              reason,
              at: "2026-09-22T07:24:15.357Z",
              rounds: 1,
            },
          ],
        }),
      }),
      stageName: "In Progress",
    });
    // CANARY: drop the verdict section and the findings are reachable from
    // NOWHERE an agent can read — the 220-char timeline clamp is the only
    // other copy.
    expect(anchor).toContain("Review verdicts that stand right now");
    expect(anchor).toContain("request_changes");
    expect(anchor).toContain("internal/store/store.go:825");
    // Whole, not clamped to the timeline's 220.
    expect(anchor).toContain("X".repeat(500));
    // And it says which verdict is the live one, because a superseded verdict
    // is exactly what AX-12's operator dispatched rework against.
    expect(anchor.replace(/\s+/g, " ")).toContain("has been superseded by these");
  });

  /**
   * Ruling 482 (F40-52): on WEB-1 the deliverer, the Site Reviewer and the
   * Fact Checker each ran the same four gates by hand and reported them in
   * prose. Every agent now reads what Viberr itself ran on the revision.
   */
  it("ruling 482: carries the project's gates as Viberr ran them on the revision under review", () => {
    const sha = "d".repeat(40);
    const gates = [
      { name: "build", command: "pnpm build" },
      { name: "check", command: "pnpm astro check" },
    ];
    const frontmatter = baseTaskFrontmatter("VIB-1", {
      stage: "review",
      workRevision: {
        id: "rev_9",
        headSha: sha,
        treeSha: null,
        branch: "vib-1",
        createdAt: "2026-09-25T09:00:00.000Z",
        sourceProfileId: "developer",
      },
      gateRun: {
        id: "gate_1",
        revisionId: "rev_9",
        headSha: sha,
        status: "finished",
        reason: "delivery",
        requestedAt: "2026-09-25T10:00:00.000Z",
        startedAt: "2026-09-25T10:00:01.000Z",
        finishedAt: "2026-09-25T10:02:00.000Z",
        error: null,
        results: [
          { name: "build", command: "pnpm build", exitCode: 0, timedOut: false, wallMs: 41_000, log: "gate-ddddddd-01-build-20260925T100001Z.log" },
          { name: "check", command: "pnpm astro check", exitCode: 1, timedOut: false, wallMs: 9_000, log: "gate-ddddddd-02-check-20260925T100042Z.log" },
        ],
      },
    });
    // CANARY: drop the gates section from canonicalTaskAnchor.
    const anchor = canonicalTaskAnchor({ parsed: parsed({ frontmatter }), stageName: "Review", gates });
    expect(anchor).toContain("### Project gates (run by Viberr on the revision under review)");
    expect(anchor).toContain("Gates on ddddddd: 1/2 exit 0 (run by Viberr)");
    expect(anchor).toContain("- `check` (`pnpm astro check`): exit 1 in 9 s · log: attachments/gate-ddddddd-02-check-20260925T100042Z.log");
    expect(anchor).toContain("Do not re-run the gates to report their result");
    // No gates declared: no section, whatever the file carries.
    expect(canonicalTaskAnchor({ parsed: parsed({ frontmatter }), stageName: "Review" })).not.toContain(
      "Project gates",
    );
  });

  it("ruling 392: a task with no standing verdict gains no section", () => {
    const anchor = canonicalTaskAnchor({ parsed: parsed(), stageName: "In Progress" });
    expect(anchor).not.toContain("Review verdicts that stand right now");
  });

  it("includes the newest N timeline events and clamps the prompt budget", () => {
    const event = (n: number): TaskFileEvent => ({
      occurredAt: `2026-07-2${n}T10:00:00.000Z`,
      type: "comment",
      actor: { kind: "human", userId: "u_1", nameHint: `Human ${n}` },
      title: null,
      text: `event ${n} ` + "x".repeat(600),
      toAgent: false,
      evidence: null,
    });
    const anchor = canonicalTaskAnchor({
      parsed: parsed({
        goal: "g".repeat(4000),
        timeline: [1, 2, 3, 4, 5, 6, 7].map(event),
      }),
      stageName: "In Progress",
    });
    expect(anchor).toContain("event 1");
    expect(anchor).toContain("event 5");
    // The 6th/7th are dropped, and no single line runs away with the budget.
    expect(anchor).not.toContain("event 6");
    expect(anchor).toContain("Human 1");
    for (const line of anchor.split("\n")) expect(line.length).toBeLessThan(1600);
  });
});

describe("specialistReplyDirective", () => {
  it("prepends the canonical anchor when one is supplied", () => {
    const anchor = canonicalTaskAnchor({ parsed: parsed(), stageName: "In Progress" });
    const directive = specialistReplyDirective({
      commenterName: "Arda Test",
      taskKey: "VIB-1",
      title: "Attach execution workspace",
      text: "continue",
      delivers: true,
      anchor,
    });
    expect(directive.startsWith("## Canonical task state")).toBe(true);
    expect(directive).toContain("Ship the CURRENT goal, not the one you remember.");
    // The existing contract survives.
    expect(directive).toContain("A human (Arda Test) commented");
    expect(directive).toContain("@Arda Test");
    expect(directive).toContain("DATA, not instructions");
    expect(directive).toContain("Do not push");
  });

  it("omits the block entirely when no anchor is available", () => {
    const directive = specialistReplyDirective({
      commenterName: "Arda Test",
      taskKey: "VIB-1",
      title: "t",
      text: "x",
    });
    expect(directive.startsWith("A human (Arda Test) commented")).toBe(true);
  });
});

describe("a RESUMED specialist re-anchors on the EDITED goal (UC-30)", () => {
  it("the resume prompt carries the new goal, not the one the session remembers", async () => {
    deployDev();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        readiness: "ready",
        waiting: "agent",
        ownerUserId: store.users.arda.id,
        title: "Attach execution workspace",
        engagements: [
          {
            profileId: "dev",
            backend: "claude",
            role: "developer",
            delivers: true,
            verdictCapable: false,
          },
        ],
      }),
      goal: "STALE: build the thing the old way.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // A prior finished run leaves the provider session the @mention resumes.
    upsertRun(store.db, {
      id: "run_prior",
      taskKey: "VIB-1",
      projectSlug: store.slug,
      threadId: "primary-prior",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet",
      sessionId: "sess_prior",
      sdk: "Claude Agent SDK",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });

    // The human edits the goal, then wakes the agent.
    await updateTaskGoal(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", goal: "FRESH: build it the new way." },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev continue" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");

    // The reply run's spec — matched on the human's ask rather than on
    // `resumeSessionId`, because a dead provider transcript legitimately
    // downgrades the resume to a fresh continuity-reset run (D-2). Either way
    // the directive is what the agent is handed, and it must re-anchor.
    const resumeSpec = specs.find((s) => s.prompt.includes("@dev continue"));
    expect(resumeSpec).toBeTruthy();
    // The whole point of D-3: the canonical goal rides with the resume.
    expect(resumeSpec!.prompt).toContain("FRESH: build it the new way.");
    expect(resumeSpec!.prompt).not.toContain("STALE: build the thing the old way.");
    expect(resumeSpec!.prompt).toContain("## Canonical task state");
    expect(resumeSpec!.prompt).toContain("stage: In Progress");
    // …and the human's actual ask is still there.
    expect(resumeSpec!.prompt).toContain("@dev continue");

    /**
     * Ruling 343 (pass 37, F37-179): the resumed run carries the input
     * disclosure too.
     *
     * `resolveResumeConfinement` returned `runInputs` for exactly this, and its
     * docstring said the caller "passes the whole thing to `recordRunInputs`
     * once `resumeRun` has minted the run id". Nobody did. The field had no
     * reader anywhere in the app, and eleven resumed specialist runs on the
     * shopify-clone board — every @mention resume, the door a PERSON uses to
     * talk to an agent — recorded nothing about what they were given.
     *
     * The resume half had a test, and it asserted the record was BUILT. That is
     * why this lasted: the same shape as rulings 329 and 338, a third time in
     * one pass.
     *
     * CANARY: delete the `recordRunInputs` call in `commentToAgent`'s resume
     * arm and this finds no line.
     */
    const resumedRun = listRunsForTaskRows(store.db, store.slug, "VIB-1")
      .filter((r) => r.id !== "run_prior")
      .at(-1)!;
    const inputs = listRunLines(store.db, resumedRun.id).find(
      (l) => l.display.tag === RUN_INPUTS_TAG,
    )?.display.inputs;
    expect(inputs, "the resumed run recorded no input disclosure").toBeTruthy();
    // The four fields only the caller can know, because it composes the prompt.
    expect(inputs!.promptChars).toBe(resumeSpec!.prompt.length);
    expect(inputs!.anchor).toContain("## Canonical task state");
    // The person's own words are the directive on this turn, so the record has
    // to name who wrote it — the resume door's whole difference from a fresh
    // dispatch.
    expect(inputs!.directive).toEqual({
      // The person as the AGENT was told about them (the same name the
      // directive tells it to tag back), not the address.
      from: "Arda Test",
      chars: "@dev continue".length,
    });
    // And the resolved half, which is what `resolveResumeConfinement` built.
    // This fixture's project has no repo, so the honest record is a run with no
    // checkout — which is itself the kind of fact the disclosure exists for.
    expect(inputs!.cloned).toBe(false);
    expect(inputs!.delivers).toBe(true);
    expect(inputs!.personaChars).toBeGreaterThan(0);
  });
});
