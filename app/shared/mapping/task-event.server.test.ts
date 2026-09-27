import { describe, expect, it } from "vitest";
import { mapTaskEventRow, type TaskEventRow } from "./task-event.server";

/**
 * Ruling 493: the timeline receives a gate run's note as its rows, and draws
 * each log once, in the row that ran it.
 */
const LOG_1 = "gate-a95c337-01-install-20260925T100001Z.log";
const LOG_2 = "gate-a95c337-02-build-20260925T100003Z.log";

function row(over: Partial<TaskEventRow> = {}): TaskEventRow {
  return {
    id: 7,
    project_slug: "web",
    task_key: "WEB-4",
    position: 0,
    occurred_at: "2026-09-25T10:03:00.000Z",
    type: "note",
    actor_kind: "system",
    actor_ref: "project-gates",
    actor_json: JSON.stringify({ kind: "system", name: "Project gates" }),
    title: "Project gates failed",
    text: "**Gates on a95c337: 1/2 exit 0 (run by Viberr).** `build` exit 1. Each gate's log is attached.",
    to_agent: 0,
    evidence_json: JSON.stringify([
      { label: `install: exit 0 in 2 s · ${LOG_1}`, result: "", status: "pass" },
      { label: `build: exit 1 in 4 s · ${LOG_2}`, result: "", status: "fail" },
    ]),
    attachments_json: JSON.stringify([LOG_1, LOG_2]),
    ...over,
  };
}

describe("mapTaskEventRow — a gate run's note (ruling 493)", () => {
  it("carries the run as rows, and neither its evidence nor its logs a second time", () => {
    // CANARY: return the mapped event before reading the gates.
    const event = mapTaskEventRow(row());
    expect(event.gates).toEqual({
      state: "failed",
      sha: "a95c337",
      detail: null,
      rows: [
        { name: "install", outcome: "exit 0", wall: "2 s", ok: true, log: LOG_1 },
        { name: "build", outcome: "exit 1", wall: "4 s", ok: false, log: LOG_2 },
      ],
    });
    expect(event.evidence).toBeNull();
    expect(event.attachments).toBeNull();
    // The record's words stay on the event.
    expect(event.text).toContain("Gates on a95c337");
  });

  it("keeps a file the note claims that no row links", () => {
    const event = mapTaskEventRow(row({ attachments_json: JSON.stringify([LOG_1, LOG_2, "screen.png"]) }));
    expect(event.attachments).toEqual(["screen.png"]);
  });

  it("leaves every other writer's note as it is", () => {
    // CANARY: drop the actor check and a note carrying the same rows reads as a run.
    const other = mapTaskEventRow(row({ actor_ref: "policy-engine" }));
    expect(other.gates).toBeUndefined();
    expect(other.evidence).toHaveLength(2);
    expect(other.attachments).toEqual([LOG_1, LOG_2]);
    const agent = mapTaskEventRow(row({ actor_kind: "agent", actor_ref: "project-gates" }));
    expect(agent.gates).toBeUndefined();
  });
});
