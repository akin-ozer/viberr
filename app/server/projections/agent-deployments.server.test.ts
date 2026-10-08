import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "./rebuilder.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import { listAgentDeployments } from "./agent-deployments.server";
import type { TaskPacket } from "~/schemas/task-file.schema";

/**
 * Live-deployment projection (agents spec §3.3 + ruling 7): derivation from
 * task assignment records by PROFILE ID, done-stage exclusion, and the
 * agent_runs join — which since F34-5 is what the status vocabulary is
 * derived FROM: a running row reads "working" (operator: "coordinating"), a
 * queued row "queued", and only an engagement with no live row reads the
 * task's waiting state ("packet open" / "waiting on human" / "on call"). The
 * same rule for every engagement kind; no hard-coded reviewer literal.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** An open decision packet — what "packet open" is allowed to mean. */
const PACKET: TaskPacket = {
  type: "input",
  kind: "Decision required",
  from: "operator",
  title: "Pick one",
  body: "",
  observations: [],
  options: [{ kind: "request_edit", t: "Send back", d: "", rec: true }],
};

function seedTasks(dataRoot: string, slug: string) {
  // review + waiting human + an OPEN PACKET, no runs → operator "packet open",
  // primary AND reviewer "waiting on human" (F34-5: one rule for every kind).
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      waiting: "human",
      operator: { assignedAtStageId: "triage" },
      engagements: [
        { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "claude", role: "Reviewer", delivers: false, verdictCapable: false },
      ],
    }),
    packet: PACKET,
  });
  // impl + waiting agent, NO run rows → every engagement "on call". The flag
  // says the task is on the agents' side, not that any thread is executing
  // (F34-5): "working" and "coordinating" are run-derived now.
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-2", {
      stage: "impl",
      waiting: "agent",
      operator: { assignedAtStageId: "ready" },
      engagements: [
        { profileId: "developer", backend: "claude", role: "Developer", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "codex", role: "Reviewer", delivers: false, verdictCapable: false },
      ],
    }),
  });
  // ready + waiting none, no runs → operator and primary "on call".
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-3", {
      stage: "ready",
      waiting: "none",
      operator: { assignedAtStageId: "ready" },
      engagements: [
        { profileId: "reviewer", backend: "codex", role: "Reviewer", delivers: true, verdictCapable: false },
      ],
    }),
  });
  // done → contributes NOTHING even with a full crew.
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", {
      stage: "done",
      waiting: "none",
      operator: { assignedAtStageId: "triage" },
      engagements: [
        { profileId: "developer", backend: "codex", role: "Developer", delivers: true, verdictCapable: false },
      ],
    }),
  });
  // triage, no operator/engagements → contributes nothing.
  writeTask(dataRoot, slug, {
    frontmatter: baseTaskFrontmatter("VIB-5", { stage: "triage" }),
  });
}

describe("listAgentDeployments", () => {
  it("derives engagement instances by profile id; with no runs the status is the task's idle wording", () => {
    const store = setupTestStore(ctx);
    seedTasks(store.dataRoot, store.slug);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Pass this store's dataRoot so the live-backend overlay reads THIS project's
    // deployed profiles, not the global env root — otherwise a "developer"
    // deployment another test leaked into the shared root flips this project's
    // developer backend (claude → codex) depending on test order.
    const deployments = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot });
    // VIB-1: 3 · VIB-2: 3 · VIB-3: 2 · VIB-4 (done): 0 · VIB-5: 0.
    expect(deployments).toHaveLength(8);
    expect(deployments.some((d) => d.taskKey === "VIB-4")).toBe(false);
    expect(deployments.some((d) => d.taskKey === "VIB-5")).toBe(false);

    const byKey = (key: string) => deployments.filter((d) => d.taskKey === key);
    expect(byKey("VIB-1").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "packet open"],
      ["developer", "primary", "waiting on human"],
      ["reviewer", "reviewer", "waiting on human"],
    ]);
    // F34-5: agent-waiting with no run in flight is "on call" for every kind —
    // the live tab called this exact deliverer "working" for twenty minutes
    // after its run had finished.
    expect(byKey("VIB-2").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "on call"],
      ["developer", "primary", "on call"],
      ["reviewer", "reviewer", "on call"],
    ]);
    expect(byKey("VIB-3").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "on call"],
      ["reviewer", "primary", "on call"],
    ]);
    // Every row carries the TASK's waiting flag for the page's task-level
    // "waiting on a human" stat (F34-5 correction d).
    expect(byKey("VIB-1").map((d) => d.taskWaiting)).toEqual(["human", "human", "human"]);
    expect(byKey("VIB-2").map((d) => d.taskWaiting)).toEqual(["agent", "agent", "agent"]);

    // Join key is the ASSIGNMENT's profileId — the display role string is
    // carried separately (never .toLowerCase() matching).
    const primary = byKey("VIB-2").find((d) => d.engagement === "primary")!;
    expect(primary.profileId).toBe("developer");
    expect(primary.role).toBe("Developer");
    expect(primary.backend).toBe("claude");
    // Operator engagements carry no backend (rendered "orchestration").
    expect(byKey("VIB-2")[0]!.backend).toBeNull();
  });

  it("shows the STUCK retry pin, not the live deployment backend, on the chip (F28-P2)", () => {
    const store = setupTestStore(ctx);
    // The `developer` profile still deploys on Claude (the other tests pin its
    // live backend to claude), but a "Retry on the other backend" resolution
    // PINNED this engagement to Codex (F27-B1). The per-task chip here must
    // follow the pin — exactly as the task page's `withLiveAgentIdentities` does —
    // not the live Claude deployment the retry moved away from. Before F28-P2
    // this private copy of the live-overlay ignored the pin and contradicted
    // the task page.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        waiting: "agent",
        operator: { assignedAtStageId: "triage" },
        engagements: [
          {
            profileId: "developer",
            backend: "claude",
            role: "Developer",
            delivers: true,
            verdictCapable: false,
            pinnedBackend: "codex",
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const deployments = listAgentDeployments(store.db, store.slug, {
      dataRoot: store.dataRoot,
    });
    const primary = deployments.find(
      (d) => d.taskKey === "VIB-1" && d.engagement === "primary",
    )!;
    expect(primary.profileId).toBe("developer");
    expect(primary.backend).toBe("codex"); // the pin, not the live "claude"
  });

  it("joins agent_runs: engagements with a running run are marked running, and say so", () => {
    const store = setupTestStore(ctx);
    seedTasks(store.dataRoot, store.slug);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const base = {
      projectSlug: store.slug,
      role: "Primary specialist",
      model: "m",
      sdk: "sdk",
    } as const;
    upsertRun(store.db, {
      ...base,
      id: "run_p",
      taskKey: "VIB-2",
      threadId: "primary",
      kind: "primary",
      agentProfileId: "developer",
      backend: "claude",
      state: "running",
    });
    upsertRun(store.db, {
      ...base,
      id: "run_c",
      taskKey: "VIB-2",
      threadId: "r0",
      kind: "reviewer",
      agentProfileId: "reviewer",
      backend: "codex",
      state: "running",
    });
    upsertRun(store.db, {
      ...base,
      id: "run_done",
      taskKey: "VIB-1",
      threadId: "primary",
      kind: "primary",
      agentProfileId: "developer",
      backend: "codex",
      state: "finished",
    });

    const deployments = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot });
    const vib2 = deployments.filter((d) => d.taskKey === "VIB-2");
    expect(vib2.find((d) => d.engagement === "primary")!.running).toBe(true);
    expect(vib2.find((d) => d.engagement === "reviewer")!.running).toBe(true);
    expect(vib2.find((d) => d.engagement === "operator")!.running).toBe(false);
    // F34-5: the join is what the status is derived from — the two live
    // threads say "working", the operator with no row stays idle ("on call").
    expect(vib2.map((d) => [d.engagement, d.status])).toEqual([
      ["operator", "on call"],
      ["primary", "working"],
      ["reviewer", "working"],
    ]);
    // A finished run does NOT mark its engagement running …
    const vib1Primary = deployments.find(
      (d) => d.taskKey === "VIB-1" && d.engagement === "primary",
    )!;
    expect(vib1Primary.running).toBe(false);
    // … and a finished run is not live, so the row reads the task's state.
    expect(vib1Primary.status).toBe("waiting on human");
  });
});

/**
 * F34-5 — the Live tab derived "working" from the task's `waiting` flag and
 * hard-coded every reviewer "anchored · on call", so a deliverer whose run had
 * finished read "working" as long as the operator's turns kept the task
 * agent-waiting, while the reviewer that WAS running read idle. Both are
 * run-derived now. Each case names the canary that turns it red.
 */
describe("F34-5: an engagement's status is read from its own run row", () => {
  const base = {
    role: "Primary specialist",
    model: "m",
    sdk: "sdk",
  } as const;

  it("a delivering engagement with no run is 'on call', whatever the flag says", () => {
    // Canary: restore the waiting-derived "working" (`waiting === "agent"` →
    // "working" for the primary) and this reads "working" with no run at all.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-20", {
        stage: "impl",
        waiting: "agent",
        operator: { assignedAtStageId: "ready" },
        engagements: [
          { profileId: "developer", backend: "claude", role: "Developer", delivers: true, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const primary = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot }).find(
      (d) => d.taskKey === "VIB-20" && d.engagement === "primary",
    )!;
    expect(primary.status).toBe("on call");
    expect(primary.running).toBe(false);
  });

  it("a supporting engagement with a LIVE run says 'working'", () => {
    // Canary: restore the hard-coded reviewer literal and the running reviewer
    // reads idle again — the live JC-4 row of the finding.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-21", {
        stage: "review",
        waiting: "human",
        operator: { assignedAtStageId: "ready" },
        engagements: [
          { profileId: "developer", backend: "claude", role: "Developer", delivers: true, verdictCapable: false },
          { profileId: "reviewer", backend: "codex", role: "Reviewer", delivers: false, verdictCapable: true },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    upsertRun(store.db, {
      ...base,
      id: "run_r0",
      projectSlug: store.slug,
      taskKey: "VIB-21",
      threadId: "r0-abcd1234",
      kind: "reviewer",
      agentProfileId: "reviewer",
      backend: "codex",
      state: "running",
    });
    const rows = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot }).filter(
      (d) => d.taskKey === "VIB-21",
    );
    const reviewer = rows.find((d) => d.engagement === "reviewer")!;
    expect(reviewer.status).toBe("working");
    expect(reviewer.running).toBe(true);
    // The idle deliverer beside it reads the task's state, not the reviewer's.
    expect(rows.find((d) => d.engagement === "primary")!.status).toBe("waiting on human");
  });

  it("a supporting run's r<n> thread id picks the n-th supporting engagement (ruling 458(a))", () => {
    // Canary: read index 0 for every reviewer thread and the live run lands on
    // the first supporting engagement instead of the second.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-23", {
        stage: "review",
        waiting: "human",
        operator: { assignedAtStageId: "ready" },
        engagements: [
          { profileId: "developer", backend: "claude", role: "Developer", delivers: true, verdictCapable: false },
          { profileId: "reviewer", backend: "codex", role: "Reviewer", delivers: false, verdictCapable: true },
          { profileId: "critic", backend: "claude", role: "Critic", delivers: false, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    upsertRun(store.db, {
      ...base,
      id: "run_r1",
      projectSlug: store.slug,
      taskKey: "VIB-23",
      threadId: "r1-abcd1234",
      kind: "reviewer",
      agentProfileId: "critic",
      backend: "claude",
      state: "running",
    });
    const supporting = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot })
      .filter((d) => d.taskKey === "VIB-23" && d.engagement === "reviewer")
      .map((d) => [d.profileId, d.status]);
    expect(supporting).toEqual([
      ["reviewer", "waiting on human"],
      ["critic", "working"],
    ]);
  });

  it("a queued run reads 'queued' with running: false", () => {
    // Canary: drop the queued map and this falls through to the idle wording
    // ("on call") for a run that is admitted and waiting for a slot.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-22", {
        stage: "impl",
        waiting: "agent",
        operator: { assignedAtStageId: "ready" },
        engagements: [
          { profileId: "developer", backend: "claude", role: "Developer", delivers: true, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    upsertRun(store.db, {
      ...base,
      id: "run_q",
      projectSlug: store.slug,
      taskKey: "VIB-22",
      threadId: "primary-abcd1234",
      kind: "primary",
      agentProfileId: "developer",
      backend: "claude",
      state: "queued",
    });
    const primary = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot }).find(
      (d) => d.taskKey === "VIB-22" && d.engagement === "primary",
    )!;
    expect(primary.status).toBe("queued");
    // Queued is not running: the pulse and the "run in flight" stat read
    // `running`, and a queued run has not started.
    expect(primary.running).toBe(false);
  });

  it("an operator coordinates only while its own run is live", () => {
    // Canary: restore the waiting-derived "coordinating" (`waiting !== "human"`
    // → "coordinating" for the operator) and the no-run operator below reads
    // "coordinating" before any run exists.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-23", {
        stage: "impl",
        waiting: "agent",
        operator: { assignedAtStageId: "triage" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const operatorRow = () =>
      listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot }).find(
        (d) => d.taskKey === "VIB-23" && d.engagement === "operator",
      )!;
    // Idle: the task is on the agents' side, nothing of the operator's is
    // executing — "on call", not "coordinating".
    expect(operatorRow().status).toBe("on call");
    expect(operatorRow().running).toBe(false);

    upsertRun(store.db, {
      ...base,
      role: "Operator",
      id: "run_op",
      projectSlug: store.slug,
      taskKey: "VIB-23",
      threadId: "op-abcd1234",
      kind: "operator",
      agentProfileId: "operator",
      backend: "claude",
      state: "running",
    });
    expect(operatorRow().status).toBe("coordinating");
    expect(operatorRow().running).toBe(true);
  });
});

/**
 * UXV19-7 — the roster was the only surface naming an ARTIFACT instead of the
 * state, and the only one of the four that could be false. `operatorStatus`
 * read `waiting` alone, so the documented no-packet acceptance-ready class
 * (review-queue.server.ts's R8-3 note, decisions.server.ts's B-FD5) showed an
 * amber "packet open" pill whose click lands on a task page that renders no
 * Decision packet section at all.
 *
 * Canary: restore the artifact-named idle branch (`engagement === "operator"
 * ? "packet open" : "waiting on human"`, dropping the `hasPacket` test) and the
 * no-packet case below fails ("packet open" for a task with no packet) while
 * the with-packet case stays green.
 */
describe("an operator is only 'packet open' when a packet is actually open", () => {
  /** The acceptance-ready class: waiting on a human, carrying no packet. */
  function seedNoPacket(store: ReturnType<typeof setupTestStore>, key: string, stage: string) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, {
        stage,
        waiting: "human",
        operator: { assignedAtStageId: "triage" },
      }),
    });
  }

  it("names the STATE for a human-waiting task with no packet, on any stage", () => {
    const store = setupTestStore(ctx);
    seedNoPacket(store, "VIB-9", "review");
    // The trigger is not Review-specific: any non-terminal stage whose
    // operator turn ends without opening a packet reads the same.
    seedNoPacket(store, "VIB-10", "impl");
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const statuses = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot })
      .filter((d) => d.engagement === "operator")
      .map((d) => [d.taskKey, d.status]);
    expect(statuses).toEqual([
      ["VIB-9", "waiting on human"],
      ["VIB-10", "waiting on human"],
    ]);
    // …and the wording is the one the board, the queue and the task page use,
    // so the page-level "waiting on a human" stat (which counts both labels)
    // is unchanged by the fix.
    expect(statuses.some(([, s]) => s === "packet open")).toBe(false);
  });

  it("still says 'packet open' when the task really carries one", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", {
        stage: "review",
        waiting: "human",
        operator: { assignedAtStageId: "triage" },
      }),
      packet: PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const operator = listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot }).find(
      (d) => d.engagement === "operator",
    )!;
    expect(operator.status).toBe("packet open");
  });

  it("names no artifact for the non-human-waiting operator either", () => {
    // Re-premised by F34-5: this used to pin "coordinating" here, a word that
    // now means a RUNNING operator row (see the F34-5 describe above). What
    // this case still guards is the UXV19-7 half — no "packet open" and no
    // "waiting on human" on a task that is not waiting on a human.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-12", {
        stage: "impl",
        waiting: "agent",
        operator: { assignedAtStageId: "triage" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      listAgentDeployments(store.db, store.slug, { dataRoot: store.dataRoot }).find((d) => d.engagement === "operator")!.status,
    ).toBe("on call");
  });
});
