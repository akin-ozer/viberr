// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, it } from "vitest";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { rebuildAll, rebuildTaskFile } from "~/server/projections/rebuilder.server";
import { listTaskEvents } from "~/server/projections/task-query.server";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { ToastProvider } from "~/ui/toast";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { Timeline } from "./timeline";

/**
 * Ruling 454 (CS-1): after a comment, the timeline re-renders with the rows
 * the server re-projected. The items keyed on those rows' ids, and every write
 * used to re-issue every id, so all of them remounted (re-parsed Markdown,
 * lost Show-more state). Measured end to end: the real rebuilder feeds the
 * real Timeline.
 */

const ctx = createTestDbContext();
afterEach(() => {
  cleanup();
  ctx.cleanup();
});

const MENTIONABLES: Mentionables = { agents: [], users: [], reserved: [] };

describe("timeline identity across a comment (ruling 454)", () => {
  it("CS-1: appending one comment rewrites one timeline item", async () => {
    const store = setupTestStore(ctx);
    const timeline: TaskFileEvent[] = [];
    for (let i = 29; i >= 0; i -= 1) {
      timeline.push({
        occurredAt: new Date(Date.UTC(2026, 6, 1, 9, 0) + i * 60_000).toISOString(),
        type: "comment",
        actor: { kind: "human", userId: store.users.arda.id, nameHint: null },
        title: null,
        text: `Comment **${i}** with a [link](https://example.test/${i}).`,
        toAgent: false,
        evidence: null,
      });
    }
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    let show: (events: TimelineEventRender[]) => void = () => {};
    const Host = () => {
      const [events, setEvents] = useState(() => listTaskEvents(store.db, store.slug, "VIB-1"));
      show = setEvents;
      return (
        <ToastProvider>
          <Timeline
            events={events}
            hasMore={false}
            remaining={0}
            nextLimit={40}
            tlDefault="all"
            ask={0}
            mentionables={MENTIONABLES}
          />
        </ToastProvider>
      );
    };
    const Stub = createRoutesStub([
      { path: "/t", Component: Host, action: async () => ({ ok: true }) },
    ]);
    const { container } = render(<Stub initialEntries={["/t"]} />);
    await act(async () => {});
    const before = new Map(
      [...container.querySelectorAll(".tl-item")].map((node) => [node, node.textContent]),
    );

    // (jsdom has no Web Locks, so the file is rewritten directly rather than
    // through updateTaskFile's mutex.)
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        {
          occurredAt: "2026-07-02T09:00:00.000Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.murat.id, nameHint: null },
          title: null,
          text: "The new comment.",
          toAgent: false,
          evidence: null,
        },
        ...timeline,
      ],
    });
    rebuildTaskFile(store.db, store.slug, "VIB-1", { dataRoot: store.dataRoot });
    await act(async () => show(listTaskEvents(store.db, store.slug, "VIB-1")));

    const after = [...container.querySelectorAll(".tl-item")];
    // An item is rewritten when its node is new, or a kept node now shows
    // another event.
    const rewritten = after.filter(
      (node) => !before.has(node) || before.get(node) !== node.textContent,
    ).length;
    expectWithinBudget("writes:timeline-append.items-rewritten", rewritten);
  });
});
