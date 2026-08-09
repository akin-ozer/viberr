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
 * task assignment records by PROFILE ID, mock status vocabulary from
 * waiting state, done-stage exclusion, and the agent_runs join marking
 * engagements with live runs.
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
  // review + waiting human + an OPEN PACKET → operator "packet open", primary
  // "waiting on human", reviewer "anchored · on call".
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
  // impl + waiting agent → operator "coordinating", primary "working".
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
  // ready + waiting none → primary "on call".
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
  it("derives engagement instances by profile id with the mock status vocabulary", () => {
    const store = setupTestStore(ctx);
    seedTasks(store.dataRoot, store.slug);
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const deployments = listAgentDeployments(store.db, store.slug);
    // VIB-1: 3 · VIB-2: 3 · VIB-3: 2 · VIB-4 (done): 0 · VIB-5: 0.
    expect(deployments).toHaveLength(8);
    expect(deployments.some((d) => d.taskKey === "VIB-4")).toBe(false);
    expect(deployments.some((d) => d.taskKey === "VIB-5")).toBe(false);

    const byKey = (key: string) => deployments.filter((d) => d.taskKey === key);
    expect(byKey("VIB-1").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "packet open"],
      ["developer", "primary", "waiting on human"],
      ["reviewer", "reviewer", "anchored · on call"],
    ]);
    expect(byKey("VIB-2").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "coordinating"],
      ["developer", "primary", "working"],
      ["reviewer", "reviewer", "anchored · on call"],
    ]);
    expect(byKey("VIB-3").map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "coordinating"],
      ["reviewer", "primary", "on call"],
    ]);

    // Join key is the ASSIGNMENT's profileId — the display role string is
    // carried separately (never .toLowerCase() matching).
    const primary = byKey("VIB-2").find((d) => d.engagement === "primary")!;
    expect(primary.profileId).toBe("developer");
    expect(primary.role).toBe("Developer");
    expect(primary.backend).toBe("claude");
    // Operator engagements carry no backend (rendered "orchestration").
    expect(byKey("VIB-2")[0]!.backend).toBeNull();
  });

  it("joins agent_runs: engagements with a running run are marked running", () => {
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
      threadId: "c0",
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

    const deployments = listAgentDeployments(store.db, store.slug);
    const vib2 = deployments.filter((d) => d.taskKey === "VIB-2");
    expect(vib2.find((d) => d.engagement === "primary")!.running).toBe(true);
    expect(vib2.find((d) => d.engagement === "reviewer")!.running).toBe(true);
    expect(vib2.find((d) => d.engagement === "operator")!.running).toBe(false);
    // A finished run does NOT mark its engagement running.
    const vib1Primary = deployments.find(
      (d) => d.taskKey === "VIB-1" && d.engagement === "primary",
    )!;
    expect(vib1Primary.running).toBe(false);
    // Status vocabulary is untouched by the join.
    expect(vib1Primary.status).toBe("waiting on human");
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
 * Canary: restore `waiting === "human" ? "packet open" : "coordinating"` and
 * the no-packet case below fails ("packet open" for a task with no packet)
 * while the with-packet case stays green.
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

    const statuses = listAgentDeployments(store.db, store.slug)
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

    const operator = listAgentDeployments(store.db, store.slug).find(
      (d) => d.engagement === "operator",
    )!;
    expect(operator.status).toBe("packet open");
  });

  it("leaves the non-human-waiting operator alone — 'coordinating' names activity, not an artifact", () => {
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
      listAgentDeployments(store.db, store.slug).find((d) => d.engagement === "operator")!.status,
    ).toBe("coordinating");
  });
});
