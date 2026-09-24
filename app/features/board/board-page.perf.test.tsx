// @vitest-environment jsdom
import { Profiler, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DragDropProvider } from "@dnd-kit/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { BoardPage, StageBoard, type BoardColumnData, type BoardTask } from "./board-page";
import { expectWithinBudget } from "../../../test-support/perf-ratchet";
import { createRenderCounter, observeMutations } from "../../../test-support/render-counter";

/**
 * Ruling 457, board-live journey: what a revalidation of the board costs in the
 * browser when little or nothing changed. Every SSE event on the project
 * re-runs the layout loader, and single-fetch decodes a brand-new object for
 * every task, so the board is handed fresh columns many times a minute.
 *
 * Fixture: 40 cards over five lanes (eight each), drawn with the variety a live
 * board has — agent working (the pulsing chip), a PR, a branch, an owner, an
 * agent seat, a problem chip — for a viewer who can move tasks. A revalidation
 * is `structuredClone` of the board, the shape single-fetch hands the page.
 */

afterEach(cleanup);

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "ready", name: "Ready", color: "blue" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "review", name: "Review", color: "amber" },
  { id: "done", name: "Done", color: "green" },
];

function boardTask(i: number): BoardTask {
  const stage = STAGES[i % STAGES.length]!.id;
  const key = `VIB-${100 + i}`;
  return {
    projectSlug: "viberr-core",
    key,
    title: `Task number ${i} with a title long enough to wrap once`,
    stage,
    readiness: "ready",
    displayReadiness: i % 7 === 3 ? "input_required" : "ready",
    waiting: i % 5 === 2 ? "agent" : i % 6 === 1 ? "human" : "none",
    waitingOnMe: i % 12 === 1,
    urgent: false,
    labels: i % 4 === 0 ? ["api"] : [],
    archived: false,
    validation: i % 9 === 4 ? "failing" : "none",
    blockReason: null,
    atAcceptanceBoundary: stage === "review",
    owner:
      i % 3 === 0
        ? { kind: "human", userId: "u-arda", name: "Arda Kaya", initials: "AK", tone: "" }
        : null,
    specialist:
      i % 2 === 0
        ? {
            kind: "agent",
            backend: i % 4 === 0 ? "codex" : "claude",
            name: i % 4 === 0 ? "Codex" : "Claude",
            role: "Implementation",
            profileId: "dev",
            profileName: "Developer",
          }
        : null,
    reviewers: [],
    operator: null,
    branch: i % 3 === 1 ? `vib-${100 + i}` : null,
    pr: i % 3 === 2 ? { number: 200 + i, state: "review", title: "A change" } : null,
    prChecks: null,
    prReview: null,
    packet: null,
    quiet: false,
    continuity: null,
  };
}

interface Board {
  columns: BoardColumnData[];
  orphanTasks: BoardTask[];
}

function board(): Board {
  const tasks = Array.from({ length: 40 }, (_, i) => boardTask(i));
  return {
    columns: STAGES.map((stage) => ({
      stage,
      tasks: tasks.filter((t) => t.stage === stage.id),
    })),
    orphanTasks: [],
  };
}

/** The same board with one card's title changed, as a fresh decode. */
function withOneChange(b: Board): Board {
  const next = structuredClone(b);
  next.columns[2]!.tasks[3]!.title = "A title the server just changed";
  return next;
}

function renderBoard(view?: "list") {
  const counter = createRenderCounter();
  let revalidate: (next: Board) => void = () => {};
  function Harness() {
    const [data, setData] = useState(board);
    revalidate = setData;
    return (
      <ToastProvider>
        <BoardPage
          columns={data.columns}
          orphanTasks={data.orphanTasks}
          canCreate
          canTransition
          canRescan
        />
      </ToastProvider>
    );
  }
  const Stub = createRoutesStub([{ path: "/projects/:slug/board", Component: Harness }]);
  const utils = render(
    <Profiler id="board" onRender={counter.onRender}>
      <Stub initialEntries={[`/projects/viberr-core/board${view ? "?view=list" : ""}`]} />
    </Profiler>,
  );
  counter.attach(utils.container);
  const dom = observeMutations(utils.container);
  let current = board();
  return {
    counter,
    dom,
    utils,
    /** Hands the board a fresh decode of `next` (a revalidation). */
    revalidate: (next: Board) => {
      current = next;
      act(() => revalidate(next));
    },
    current: () => current,
  };
}

describe("board revalidation cost (ruling 457)", () => {
  it("a revalidation that changes nothing renders no card and writes nothing", () => {
    const b = renderBoard();
    expect(b.utils.container.querySelectorAll(".card-wrap")).toHaveLength(40);
    b.dom.take();
    b.revalidate(structuredClone(b.current()));
    // BOARD-2: every card re-rendered, 15 of its 16 effects dnd-kit's.
    expectWithinBudget("render:board.card-renders-per-noop-revalidation", b.counter.renders("TaskCard"));
    expectWithinBudget("render:board.component-renders-per-noop-revalidation", b.counter.total());
    // BOARD-4 / TASK-8: the Icon innerHTML resets and the roving tabindex writes.
    expectWithinBudget("render:board.dom-writes-per-noop-revalidation", b.dom.take().length);
  });

  it("a revalidation that changes one card renders that card", () => {
    const b = renderBoard();
    b.dom.take();
    b.revalidate(withOneChange(b.current()));
    expect(b.utils.getByText("A title the server just changed")).toBeTruthy();
    // BOARD-2
    expectWithinBudget("render:board.card-renders-per-single-card-change", b.counter.renders("TaskCard"));
    // BOARD-4: the card that did render rewrites its title, not its Move
    // button's unchanged tabindex.
    expectWithinBudget("render:board.dom-writes-per-single-card-change", b.dom.take().length);
  });

  it("the list view renders the one row that changed", () => {
    const b = renderBoard("list");
    expect(b.utils.container.querySelectorAll(".list-row")).toHaveLength(40);
    b.revalidate(withOneChange(b.current()));
    expect(b.utils.getByText("A title the server just changed")).toBeTruthy();
    // BOARD-2
    expectWithinBudget("render:board.list-row-renders-per-single-card-change", b.counter.renders("ListRow"));
  });

  it("a drag moving its landing slot renders no card", () => {
    const counter = createRenderCounter();
    const { columns } = board();
    const dragged = columns[0]!.tasks[0]!;
    const stable = {
      visible: (ts: BoardTask[]) => ts,
      emptyCopyFor: () => "No tasks in this stage.",
      onNew: () => {},
      onMoveTask: () => {},
      onNudgeTask: () => {},
      onCardKeyDown: () => {},
    };
    let moveSlot: (key: string) => void = () => {};
    function Harness() {
      const [beforeKey, setBeforeKey] = useState(columns[3]!.tasks[1]!.key);
      moveSlot = setBeforeKey;
      return (
        <DragDropProvider>
          <StageBoard
            columns={columns}
            visible={stable.visible}
            emptyCopyFor={stable.emptyCopyFor}
            doneStageId="done"
            canCreate
            createCta={false}
            canTransition
            onNew={stable.onNew}
            drag={{ key: dragged.key, fromStage: dragged.stage }}
            overStage="review"
            beforeKey={beforeKey}
            arrivedKey={null}
            draggedTask={dragged}
            inFlight={null}
            inFlightTask={null}
            onMoveTask={stable.onMoveTask}
            onNudgeTask={stable.onNudgeTask}
            rovingKey={columns[0]!.tasks[0]!.key}
            onCardKeyDown={stable.onCardKeyDown}
          />
        </DragDropProvider>
      );
    }
    const Stub = createRoutesStub([{ path: "/projects/:slug/board", Component: Harness }]);
    const utils = render(
      <Profiler id="drag" onRender={counter.onRender}>
        <Stub initialEntries={["/projects/viberr-core/board"]} />
      </Profiler>,
    );
    counter.attach(utils.container);
    act(() => moveSlot(columns[3]!.tasks[4]!.key));
    // The preview moved: it now stands before the review lane's fifth card.
    const lane = utils.container.querySelectorAll(".column")[3]!;
    const preview = lane.querySelector(".drop-preview")!;
    expect(preview.nextElementSibling?.getAttribute("data-card-key")).toBe(
      columns[3]!.tasks[4]!.key,
    );
    // BOARD-2
    expectWithinBudget("render:board.card-renders-per-drag-slot-change", counter.renders("TaskCard"));
  });
});
