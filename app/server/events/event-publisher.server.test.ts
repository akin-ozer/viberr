import { describe, expect, it } from "vitest";
import { sseEventSchema } from "~/schemas/sse-event.schema";
import { emitProjectionEvent } from "./projection-events.server";
import {
  startEventPublisher,
  translateProjectionEvent,
} from "./event-publisher.server";
import { connectSseClient } from "./sse-broker.server";

const AT = "2026-07-05T09:41:00.000Z";

/** Every published event must zod-parse against the wire schema. */
function validated(events: ReturnType<typeof translateProjectionEvent>) {
  for (const { event } of events) {
    expect(() => sseEventSchema.parse(event)).not.toThrow();
  }
  return events;
}

describe("translateProjectionEvent shapes (docs/architecture/decisions.md payload contract)", () => {
  it("task.updated carries compact facts (slug/key/stage/readiness)", () => {
    const out = validated(
      translateProjectionEvent(
        {
          type: "task.updated",
          projectSlug: "viberr-core",
          taskKey: "VIB-142",
          occurredAt: AT,
        },
        { taskFacts: { stage: "review", readiness: "input_required" } },
      ),
    );
    // ONE event per task change: the derived `task.readiness-changed` had no
    // consumer and is gone (E9); a readiness flip rides task.updated.
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toEqual({
      type: "task.updated",
      entityId: "viberr-core/VIB-142",
      occurredAt: AT,
      data: {
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        stage: "review",
        readiness: "input_required",
      },
    });
    expect(out[0]!.route).toEqual({
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
  });

  it("task.removed / project.updated / project.removed", () => {
    const removed = validated(
      translateProjectionEvent({
        type: "task.removed",
        projectSlug: "p",
        taskKey: "K-9",
        occurredAt: AT,
      }),
    );
    expect(removed[0]!.event.entityId).toBe("p/K-9");

    const project = validated(
      translateProjectionEvent({
        type: "project.updated",
        projectSlug: "p",
        occurredAt: AT,
      }),
    );
    expect(project[0]!.event).toEqual({
      type: "project.updated",
      entityId: "p",
      occurredAt: AT,
      data: { projectSlug: "p" },
    });
    expect(project[0]!.route).toEqual({ projectSlug: "p" });

    const gone = validated(
      translateProjectionEvent({
        type: "project.removed",
        projectSlug: "p",
        occurredAt: AT,
      }),
    );
    expect(gone[0]!.event.type).toBe("project.removed");
  });

  it("projection.rebuilt broadcasts with the rescan summary", () => {
    const out = validated(
      translateProjectionEvent({
        type: "projection.rebuilt",
        scope: "full",
        occurredAt: AT,
        changed: 7,
      }),
    );
    expect(out[0]!.event.data).toEqual({ scope: "full", changed: 7 });
    expect(out[0]!.route).toEqual({ broadcast: true });
  });

  it("notification.created routes to the recipient user only", () => {
    const out = validated(
      translateProjectionEvent({
        type: "notification.created",
        userId: "u_arda",
        occurredAt: AT,
      }),
    );
    expect(out[0]!.event.data).toEqual({ userId: "u_arda" });
    expect(out[0]!.route).toEqual({ userId: "u_arda" });
  });

  it("notification.read routes to the recipient user only (E12)", () => {
    const out = validated(
      translateProjectionEvent({
        type: "notification.read",
        userId: "u_arda",
        occurredAt: AT,
      }),
    );
    expect(out[0]!.event.type).toBe("notification.read");
    expect(out[0]!.event.data).toEqual({ userId: "u_arda" });
    expect(out[0]!.route).toEqual({ userId: "u_arda" });
  });

  it("violation.updated routes to project (+task when carried)", () => {
    const withTask = validated(
      translateProjectionEvent({
        type: "violation.updated",
        projectSlug: "p",
        taskKey: "K-1",
        occurredAt: AT,
      }),
    );
    expect(withTask[0]!.route).toEqual({ projectSlug: "p", taskKey: "K-1" });
    expect(withTask[0]!.event.entityId).toBe("p/K-1");

    const projectLevel = validated(
      translateProjectionEvent({
        type: "violation.updated",
        projectSlug: "p",
        taskKey: null,
        occurredAt: AT,
      }),
    );
    expect(projectLevel[0]!.route).toEqual({ projectSlug: "p" });
    expect(projectLevel[0]!.event.entityId).toBe("p");
  });
});

describe("startEventPublisher wiring", () => {
  it("bridges the projection emitter to broker connections", () => {
    startEventPublisher();
    const writes: string[] = [];
    connectSseClient({
      userId: "u_arda",
      scopes: [{ kind: "user" }],
      write: (chunk) => writes.push(chunk),
    });

    emitProjectionEvent({
      type: "notification.created",
      userId: "u_arda",
      occurredAt: AT,
    });
    emitProjectionEvent({
      type: "notification.created",
      userId: "u_elif",
      occurredAt: AT,
    });

    const joined = writes.join("");
    expect(joined).toContain("event: notification.created");
    expect(joined).toContain("u_arda");
    expect(joined).not.toContain("u_elif");
  });

  it("is idempotent — double start does not double-publish", () => {
    startEventPublisher();
    startEventPublisher();
    const writes: string[] = [];
    connectSseClient({
      userId: "u1",
      scopes: [{ kind: "user" }],
      write: (chunk) => writes.push(chunk),
    });

    emitProjectionEvent({
      type: "notification.created",
      userId: "u1",
      occurredAt: AT,
    });
    const count = writes
      .join("")
      .split("\n")
      .filter((l) => l === "event: notification.created").length;
    expect(count).toBe(1);
  });
});
