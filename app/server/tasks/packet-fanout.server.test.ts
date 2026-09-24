import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import type { PacketOption, TaskPacket } from "~/schemas/task-file.schema";
import { resolvePacket } from "./task-actions.server";
import {
  causeFanOutDisclosure,
  fanOutOutcomeText,
  siblingOptionIndex,
  siblingPacketsSharingCause,
  FANNED_OUT_OPTION_KINDS,
} from "./packet-fanout.server";

/**
 * Ruling 319 — one account failure, one decision.
 *
 * Ruling 315 stamped `packet.cause` and its own field comment went on promising
 * that "packets that share a cause resolve together". Nothing read the field.
 * These tests are the difference between the sentence and the product.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const CAUSE = "backend:claude:quota:u_arda1";

/** The option set `describeRunFailure` writes for a quota failure, in its order. */
function quotaOptions(): PacketOption[] {
  return [
    {
      kind: "wait_for_window",
      t: "Wait for the window to reopen",
      d: "",
      rec: true,
      dueAt: "2026-09-17T20:00:00.000Z",
    },
    {
      kind: "retry_other_backend",
      t: "Retry on Codex",
      d: "",
      rec: false,
      backend: "codex",
    },
    { kind: "hold_runtime_debug", t: "Hold for runtime debugging", d: "", rec: false },
  ];
}

/** `cause: null` = a packet raised by the task itself, which is almost all of
 *  them. Spelled `null` rather than an omitted argument because a default
 *  parameter fires on an explicit `undefined`, which is exactly how the first
 *  draft of this file gave every "no cause" fixture the shared cause. */
function packet(options: PacketOption[], cause: string | null = CAUSE): TaskPacket {
  const p: TaskPacket = {
    type: "blocked",
    kind: "Blocked decision",
    from: "operator",
    title: "Work stalled: pick a recovery path",
    body: "The run failed: the account is out of quota.",
    observations: [],
    options,
  };
  if (cause !== null) p.cause = cause;
  return p;
}

function seed(
  store: TestStore,
  key: string,
  options: PacketOption[],
  cause: string | null = CAUSE,
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, {
      stage: "impl",
      readiness: "ready",
      waiting: "human",
      ownerUserId: store.users.arda.id,
    }),
    packet: packet(options, cause),
  });
}

function prepared(
  keys: readonly { key: string; options: PacketOption[]; cause?: string | null }[],
) {
  const store = setupTestStore(ctx);
  for (const k of keys) seed(store, k.key, k.options, k.cause === undefined ? CAUSE : k.cause);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

function file(store: TestStore, key: string) {
  const read = readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot });
  if (!read) throw new Error(`no task ${key}`);
  return read.parsed;
}

function timelineText(store: TestStore, key: string): string {
  return file(store, key)
    .timeline.map((e) => e.text ?? "")
    .join("\n");
}

describe("siblingPacketsSharingCause", () => {
  it("finds every OTHER open packet with the same cause, and nothing else", () => {
    const store = prepared([
      { key: "VIB-1", options: quotaOptions() },
      { key: "VIB-2", options: quotaOptions() },
      // A different account's quota is a different decision.
      { key: "VIB-3", options: quotaOptions(), cause: "backend:claude:quota:u_murat2" },
      // A packet raised by the task itself carries no cause at all — the
      // overwhelming majority, and the reason this search is keyed rather than
      // shaped (two `blocked` packets are not the same question).
      { key: "VIB-4", options: quotaOptions(), cause: null },
    ]);

    const found = siblingPacketsSharingCause(store.db, CAUSE, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
    });
    expect(found.map((s) => s.taskKey)).toEqual(["VIB-2"]);
  });

  it("skips a packet that is archived, already decided, or awaiting", () => {
    const store = setupTestStore(ctx);
    seed(store, "VIB-1", quotaOptions());
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { archived: true }),
      packet: packet(quotaOptions()),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", {}),
      packet: {
        ...packet(quotaOptions()),
        decided: { optionIndex: 0, at: "2026-09-17T10:00:00.000Z", byUserId: "u_x" },
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    expect(
      siblingPacketsSharingCause(store.db, CAUSE, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
      }),
    ).toHaveLength(0);
  });
});

describe("siblingOptionIndex", () => {
  it("matches by KIND, not by the index the option sat at on the other packet", () => {
    // The whole reason the fan-out is not a loop over `optionIndex`.
    // `describeRunFailure` composes the option set from the failure AND from
    // what each task's own owner has connected, so "retry on the other backend"
    // is present on one task and absent on the next — and every index behind it
    // shifts. CANARY: make `siblingOptionIndex` return the origin's index.
    const chosen = quotaOptions()[1]!; // retry_other_backend, at index 1 here
    const sibling = packet([
      { kind: "redirect", t: "Redirect", d: "", rec: false },
      { kind: "wait_for_window", t: "Wait", d: "", rec: true, dueAt: "2026-09-17T20:00:00.000Z" },
      { kind: "retry_other_backend", t: "Retry on Codex", d: "", rec: false, backend: "codex" },
    ]);
    expect(siblingOptionIndex(sibling, chosen)).toBe(2);
    expect(sibling.options[siblingOptionIndex(sibling, chosen)!]!.kind).toBe(
      "retry_other_backend",
    );
  });

  it("will not match two retries that name different backends", () => {
    const chosen: PacketOption = {
      kind: "retry_other_backend",
      t: "Retry on Codex",
      d: "",
      rec: false,
      backend: "codex",
    };
    const sibling = packet([
      { kind: "retry_other_backend", t: "Retry on Claude", d: "", rec: false, backend: "claude" },
    ]);
    expect(siblingOptionIndex(sibling, chosen)).toBeNull();
  });

  it("ignores profileId, which names each task's OWN agent", () => {
    const chosen: PacketOption = {
      kind: "request_edit",
      t: "Send back",
      d: "",
      rec: false,
      profileId: "developer",
    };
    const sibling = packet([
      { kind: "request_edit", t: "Send back", d: "", rec: false, profileId: "infra-engineer" },
    ]);
    expect(siblingOptionIndex(sibling, chosen)).toBe(0);
  });

  it("refuses every kind that is not a coordination answer about an account", () => {
    // The allow-list is the safety property: a one-way write must never reach a
    // task whose human never saw it. CANARY: add "accept_completion" to
    // FANNED_OUT_OPTION_KINDS and this goes red.
    for (const kind of ["accept_completion", "archive_task", "discard_branch", "custom"] as const) {
      expect(FANNED_OUT_OPTION_KINDS.has(kind)).toBe(false);
      const chosen: PacketOption = { kind, t: "x", d: "", rec: false };
      expect(siblingOptionIndex(packet([chosen]), chosen)).toBeNull();
    }
  });
});

describe("resolvePacket fans a shared cause out (ruling 319)", () => {
  it("answers every sibling the same way, and says so on both timelines", async () => {
    // CANARY: delete the `await fanOutByCause(...)` call in resolvePacket.
    const store = prepared([
      { key: "VIB-1", options: quotaOptions() },
      { key: "VIB-2", options: quotaOptions() },
    ]);

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 }, // hold_runtime_debug
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    // The sibling's packet is gone — genuinely resolved, not merely marked.
    expect(file(store, "VIB-2").packet).toBeNull();
    // ...and it says where its answer came from, naming the person and the
    // option. A decision that arrives from off-screen with no provenance is
    // worse than one that never arrives.
    expect(timelineText(store, "VIB-2")).toContain("Answered from VIB-1");
    expect(timelineText(store, "VIB-2")).toContain("Hold for runtime debugging");
    expect(timelineText(store, "VIB-2")).toContain(store.users.arda.email);
    // The deciding task records the reach.
    expect(timelineText(store, "VIB-1")).toContain("The same answer was applied to VIB-2");
  });

  it("resolves the sibling by the option's KIND even when its packet orders them differently", async () => {
    /**
     * The defect this whole module exists to prevent, end to end.
     *
     * `describeRunFailure` composes the option set from the failure AND from
     * what each task's own OWNER has connected (ruling 127), so two tasks
     * knocked out by one quota outage do not get the same list: the one whose
     * owner has Codex connected is offered a retry, the one whose owner does
     * not is offered "send the agent back" instead — and every index behind
     * that shifts. Resolving a sibling at the origin's index is how "hold for
     * runtime debugging" silently becomes "send the agent back to continue" on
     * the task nobody was looking at.
     *
     * The origin picks index 2; the same kind sits at index 0 on the sibling.
     * CANARY: in `fanOutByCause`, resolve the sibling at a fixed index.
     */
    const store = prepared([
      { key: "VIB-1", options: quotaOptions() }, // hold is index 2
      {
        key: "VIB-2",
        options: [
          { kind: "hold_runtime_debug", t: "Hold for runtime debugging", d: "", rec: false },
          { kind: "request_edit", t: "Send the agent back to continue", d: "", rec: true },
        ],
      },
    ]);

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(file(store, "VIB-2").packet).toBeNull();
    const sibling = timelineText(store, "VIB-2");
    expect(sibling).toContain("Hold for runtime debugging");
    // The wrong answer, sitting where the origin's index points.
    expect(sibling).not.toContain("Send the agent back to continue");
  });

  it("does NOT reach a sibling whose packet lacks the option, and names it as a miss", async () => {
    // The misses are the point: the person who just cleared three packets with
    // one click is the one who has to learn that the fourth is still open.
    // CANARY: drop the `outcomes.push({applied: false …})` arm.
    const store = prepared([
      { key: "VIB-1", options: quotaOptions() },
      {
        key: "VIB-2",
        options: [{ kind: "redirect", t: "Redirect with sharper guidance", d: "", rec: true }],
      },
    ]);

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 1 }, // retry_other_backend
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(file(store, "VIB-2").packet).not.toBeNull();
    const note = timelineText(store, "VIB-1");
    expect(note).toContain("VIB-2 was **not** answered");
    expect(note).toContain("Its packet is still open.");
  });

  it("a directive the person wrote for THIS task is not re-aimed at another", async () => {
    // `custom` is offered on every packet and is the one answer that is about
    // the task in front of the person, not about the account.
    // CANARY: add "custom" to FANNED_OUT_OPTION_KINDS.
    const store = prepared([
      { key: "VIB-1", options: quotaOptions() },
      { key: "VIB-2", options: quotaOptions() },
    ]);

    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 0,
        custom: "Skip the catalog fixture and re-run only the gateway suite.",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(file(store, "VIB-2").packet).not.toBeNull();
    expect(timelineText(store, "VIB-1")).toContain("answers only the task it was chosen on");
    // And the directive itself did not travel.
    expect(timelineText(store, "VIB-2")).not.toContain("catalog fixture");
  });

  it("does not recurse: the sibling's own resolution fans out to nobody", async () => {
    // Three tasks on one cause. Without the `fanOutOrigin` guard, VIB-1 answers
    // VIB-2, whose resolution answers VIB-3 *and* re-enters VIB-1 — and the
    // record on each task would name a decider that never touched it.
    // CANARY: delete the `input.fanOutOrigin !== undefined` guard.
    const store = prepared([
      { key: "VIB-1", options: quotaOptions() },
      { key: "VIB-2", options: quotaOptions() },
      { key: "VIB-3", options: quotaOptions() },
    ]);

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    for (const key of ["VIB-2", "VIB-3"]) {
      expect(file(store, key).packet).toBeNull();
      // Each names the ONE task a human actually decided on.
      expect(timelineText(store, key)).toContain("Answered from VIB-1");
      expect(timelineText(store, key)).not.toContain("Answered from VIB-2");
      expect(timelineText(store, key)).not.toContain("Answered from VIB-3");
    }
    // The origin reports both, once.
    const origin = timelineText(store, "VIB-1");
    expect(origin.match(/The same answer was applied to/g) ?? []).toHaveLength(1);
    expect(origin).toContain("VIB-2 and VIB-3");
  });

  it("a packet with no cause reaches nothing, and leaves no note claiming it did", async () => {
    const store = prepared([
      { key: "VIB-1", options: quotaOptions(), cause: null },
      { key: "VIB-2", options: quotaOptions(), cause: null },
    ]);

    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 2 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(file(store, "VIB-2").packet).not.toBeNull();
    expect(timelineText(store, "VIB-1")).not.toContain("The same answer was applied");
    expect(timelineText(store, "VIB-1")).not.toContain("was **not** answered");
  });
});

describe("the sentences", () => {
  it("the disclosure counts and names the siblings without promising the un-picked option", () => {
    const text = causeFanOutDisclosure([
      { projectSlug: "p", taskKey: "VIB-2", title: "a", packet: packet(quotaOptions()) },
      { projectSlug: "p", taskKey: "VIB-3", title: "b", packet: packet(quotaOptions()) },
    ]);
    expect(text).toContain("2 other tasks: VIB-2 and VIB-3");
    // "wherever that task's packet offers the option you pick" — the honest
    // hedge. A flat "answers all of them" would be the same overstatement this
    // ruling is fixing, in a smaller font.
    expect(text).toContain("wherever that task's packet offers");
    expect(causeFanOutDisclosure([])).toBeNull();
  });

  it("the outcome note leads with what happened and still names every miss", () => {
    expect(
      fanOutOutcomeText([
        { taskKey: "VIB-2", applied: true },
        { taskKey: "VIB-3", applied: false, why: "you can't resolve packets there." },
      ]),
    ).toBe(
      "The same answer was applied to VIB-2, stopped by the same failure. " +
        "VIB-3 was **not** answered: you can't resolve packets there. Its packet is still open.",
    );
    expect(fanOutOutcomeText([])).toBeNull();
  });
});
