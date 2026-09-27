// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Profiler, useState } from "react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { rebuildAll, rebuildTaskFile } from "~/server/projections/rebuilder.server";
import { listTaskEvents } from "~/server/projections/task-query.server";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { ToastProvider } from "~/ui/toast";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { createRenderCounter } from "../../../test-support/render-counter";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { Timeline } from "./timeline";

/**
 * Ruling 457 (CS-1): after a comment, the timeline re-renders with the rows
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

describe("timeline identity across a comment (ruling 457)", () => {
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

/**
 * Ruling 457 (CS-3 / TASK-4): what the timeline's rows cost while nothing in
 * them changes. A send moves the comment fetcher through submitting and
 * loading, and every live event on the task revalidates the page, which hands
 * the timeline brand-new event objects (and a new mentionables directory,
 * task-link map and attachment list) with the same content.
 *
 * Fixture: 30 events (comments, typed events with evidence, an attachment
 * chip), a mentionables directory, task links and attachment names; a
 * revalidation is `structuredClone` of all of it, the shape single-fetch
 * hands the page; a send types into the composer and clicks Comment against a
 * stub action that answers `{ ok: true }`.
 */
function timelineEvent(i: number): TimelineEventRender {
  const typed = i % 3 === 1;
  return {
    id: 1000 + i,
    type: typed ? "completion" : "comment",
    occurredAt: new Date(Date.UTC(2026, 6, 1, 9, 0) + i * 60_000).toISOString(),
    actor:
      i % 2 === 0
        ? { kind: "human", userId: "u-arda", name: "Arda Kaya", initials: "AK", tone: "" }
        : { kind: "agent", backend: "claude", name: "Developer", role: "Implementation" },
    title: typed ? `Delivered part ${i}` : null,
    text: typed
      ? `Ran the **suite** for VIB-2 and @dev reported \`ok\` (${i}).`
      : `Comment **${i}** with a [link](https://example.test/${i}) for @dev.`,
    toAgent: i % 5 === 0,
    evidence: typed ? [{ label: `shot-${i}.png`, result: "+3 −1", status: "info" }] : null,
    attachments: i === 4 ? ["shot-4.png", "notes.txt"] : null,
  };
}

interface TimelineData {
  events: TimelineEventRender[];
  mentionables: Mentionables;
  taskLinks: Record<string, string>;
  attachmentNames: string[];
}

function timelineData(): TimelineData {
  return {
    events: Array.from({ length: 30 }, (_, i) => timelineEvent(29 - i)),
    mentionables: {
      agents: [{ handle: "dev", name: "Developer", role: "Implementation", backend: "claude" }],
      users: [{ handle: "arda", name: "Arda Kaya", email: "arda@viberr.dev" }],
      reserved: [{ handle: "operator", label: "Operator" }],
    },
    taskLinks: { "VIB-2": "/projects/viberr-core/tasks/VIB-2" },
    attachmentNames: ["shot-4.png", "notes.txt"],
  };
}

function mountTimeline() {
  const counter = createRenderCounter();
  let revalidate: (change?: (data: TimelineData) => void) => void = () => {};
  const Host = () => {
    const [data, setData] = useState(timelineData);
    revalidate = (change) =>
      setData((d) => {
        const next = structuredClone(d);
        change?.(next);
        return next;
      });
    return (
      <ToastProvider>
        <Timeline
          events={data.events}
          hasMore={false}
          remaining={0}
          nextLimit={40}
          tlDefault="all"
          ask={0}
          mentionables={data.mentionables}
          taskLinks={data.taskLinks}
          attachmentNames={data.attachmentNames}
          attachmentsBase="/projects/viberr-core/tasks/VIB-1/attachments"
        />
      </ToastProvider>
    );
  };
  const Stub = createRoutesStub([
    { path: "/t", Component: Host, action: async () => ({ ok: true }) },
  ]);
  const view = render(
    <Profiler id="timeline" onRender={counter.onRender}>
      <Stub initialEntries={["/t"]} />
    </Profiler>,
  );
  return {
    ...view,
    counter,
    revalidate: (change?: (data: TimelineData) => void) => revalidate(change),
  };
}

describe("timeline rows while nothing in them changes (ruling 457)", () => {
  it("CS-3: a send re-renders no timeline item", async () => {
    const view = mountTimeline();
    await act(async () => {});
    expect(view.container.querySelectorAll(".tl-item")).toHaveLength(30);
    view.counter.attach(view.container);
    const standIn = view.container.querySelector<HTMLElement>(".composer-ce")!;
    standIn.textContent = "Looks good to me.";
    fireEvent.input(standIn);
    const button = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Comment",
    )!;
    await act(async () => {
      fireEvent.click(button);
    });
    await act(async () => {});
    // The send went through: the draft cleared on the server's answer.
    expect(standIn.textContent).toBe("");
    expect(button.getAttribute("aria-busy")).toBe("false");
    expectWithinBudget("render:timeline.item-renders-per-send", view.counter.renders("TimelineItem"));
  });

  it("TASK-4: a revalidation with the same rows re-renders no timeline item", async () => {
    const view = mountTimeline();
    await act(async () => {});
    view.counter.attach(view.container);
    await act(async () => view.revalidate());
    // Still the same thirty rows, links and files.
    expect(view.container.querySelectorAll(".tl-item")).toHaveLength(30);
    expect(view.container.querySelector(".tl-attach-file")?.textContent).toContain("notes.txt");
    expectWithinBudget(
      "render:timeline.item-renders-per-noop-revalidation",
      view.counter.renders("TimelineItem"),
    );
  });

  it("a revalidation that changes one row re-renders that row alone", async () => {
    const view = mountTimeline();
    await act(async () => {});
    view.counter.attach(view.container);
    await act(async () =>
      view.revalidate((data) => {
        data.events[2]!.text = "An edited comment.";
      }),
    );
    expect(view.container.querySelectorAll(".tl-item")[2]!.textContent).toContain(
      "An edited comment.",
    );
    expect(view.counter.renders("TimelineItem")).toBe(1);
  });
});
