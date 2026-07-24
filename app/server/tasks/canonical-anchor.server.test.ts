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
  TaskFrontmatter,
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
import { listRunsForTaskRows, upsertRun } from "~/server/runtimes/run-store.server";
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
      } as never,
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

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  specs.length = 0;
  resetSseBrokerForTests();
  configureRunServiceForTests({
    claude: recordingAdapter("claude"),
    codex: recordingAdapter("codex"),
  });
});

afterEach(() => {
  for (const run of listRunsForTaskRows(store.db, store.slug, "VIB-1")) {
    if (run.state === "running" || run.state === "queued") {
      try {
        interruptRun(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", runId: run.id },
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
      }) as TaskFrontmatter,
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
  }, 20_000);
});
