// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { BoardPage, type BoardColumnData } from "./board-page";
import type { TaskSummary } from "~/shared/mapping/task.server";

afterEach(cleanup);

const columns: BoardColumnData[] = [
  { stage: { id: "triage", name: "Triage", color: "#aaa" }, tasks: [] },
  { stage: { id: "done", name: "Done", color: "#0a7" }, tasks: [] },
];

describe("BoardPage archived mode", () => {
  it("keeps filters and view selection while removing create, rescan, and drag affordances", async () => {
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/projects/:slug/board",
        loader: () => ({ csrf: "test-csrf" }),
        Component: () => (
          <ToastProvider>
            <BoardPage
              columns={columns}
              orphanTasks={[]}
              canCreate
              canTransition
              readOnly
              viewer={{ userId: "u_admin", projectRole: "admin" }}
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container, getByText, queryByText } = render(
      <Stub initialEntries={["/projects/viberr-core/board"]} />,
    );

    await waitFor(() => expect(getByText("Archived · read-only")).toBeTruthy());
    expect(queryByText("New task")).toBeNull();
    expect(queryByText("Re-scan")).toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();

    expect(getByText("All tasks")).toBeTruthy();
    expect(getByText("Waiting on me")).toBeTruthy();
    const list = getByText("List").closest("button")!;
    fireEvent.click(list);
    await waitFor(() => expect(list.classList.contains("on")).toBe(true));
  });
});

describe("BoardPage personalized waiting copy", () => {
  const waitingTask = {
    projectSlug: "viberr-core",
    key: "VIB-1",
    title: "Needs a project decision",
    stage: "triage",
    readiness: "blocked",
    displayReadiness: "blocked",
    waiting: "human",
    urgent: false,
    validation: "failing",
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: null,
    repo: null,
    pr: null,
    commits: [],
    changed: null,
    goal: "Decide.",
    packet: null,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-1/task.md",
  } satisfies TaskSummary;

  it("does not personalize every human wait to a nonmember org-admin override", async () => {
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/projects/:slug/board",
        loader: () => ({ csrf: "test-csrf" }),
        Component: () => (
          <ToastProvider>
            <BoardPage
              columns={[
                { ...columns[0]!, tasks: [waitingTask] },
                columns[1]!,
              ]}
              orphanTasks={[]}
              canCreate
              canTransition
              viewer={{ userId: "u_org_admin", projectRole: null }}
            />
          </ToastProvider>
        ),
      },
    ]);
    const { getByText, queryByText } = render(
      <Stub initialEntries={["/projects/viberr-core/board"]} />,
    );

    await waitFor(() => expect(getByText("waiting on a human")).toBeTruthy());
    expect(queryByText("waiting on you")).toBeNull();
  });
});
