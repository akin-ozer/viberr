// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ControllerPage, surfaceLabel } from "./controller-page";
import type { ControllerSurfaceView } from "./controller-query.server";

/**
 * Ruling 121 on the full controller page: the project is named, task-anchored
 * threads wear a task chip, and a user message says where it was sent from.
 */

// jsdom's Element carries no `scrollIntoView`; the transcript calls it on mount.
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

function view(over: Partial<ControllerSurfaceView> = {}): ControllerSurfaceView {
  return {
    available: true,
    controllerName: "Controller",
    projectName: "Viberr Core",
    conversations: [
      { id: "cnv_b", title: "Board thread", ownerLabel: "arda@viberr.dev", own: true, lastMessageAt: "2026-09-01T10:00:00.000Z", projectSlug: "viberr-core", taskKey: null },
      { id: "cnv_t", title: "Task thread", ownerLabel: "arda@viberr.dev", own: true, lastMessageAt: "2026-09-01T11:00:00.000Z", projectSlug: "viberr-core", taskKey: "VIB-142" },
    ],
    conversation: null,
    messages: [],
    turn: { working: false, runId: null },
    goals: [],
    viewerOwnsActive: false,
    showingAll: false,
    viewerIsOrgAdmin: true,
    ...over,
  };
}

function renderPage(v: ControllerSurfaceView, search = "") {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ csrf: "tok", theme: "system", motion: "full" }),
      children: [
        {
          path: "projects/:slug/controller",
          Component: () => (
            <ToastProvider>
              <ControllerPage view={v} projectSlug="viberr-core" canRedirectGoals={false} />
            </ToastProvider>
          ),
        },
      ],
    },
  ]);
  return render(<Stub initialEntries={[`/projects/viberr-core/controller${search}`]} />);
}

describe("the project controller page (ruling 121)", () => {
  it("names the project, not the slug, and chips task-anchored threads", async () => {
    renderPage(view());
    await screen.findByText("Managing the Viberr Core board with your own permissions.");
    const chip = screen.getByText("VIB-142", { selector: ".ctl-conv-task" });
    expect(chip.closest("a")?.textContent).toContain("Task thread");
    expect(screen.getByText("Board thread").closest("a")?.querySelector(".ctl-conv-task")).toBeNull();
  });

  it("says which task an open thread is anchored to, and where a message came from", async () => {
    renderPage(
      view({
        conversation: {
          id: "cnv_t",
          userId: "u1",
          userLabel: "arda@viberr.dev",
          projectSlug: "viberr-core",
          taskKey: "VIB-142",
          title: "Task thread",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
          lastMessageAt: "2026-09-01T10:00:00.000Z",
        },
        messages: [
          { id: "m1", conversationId: "cnv_t", seq: 1, author: "user", userId: "u1", text: "Status?", runId: null, surface: "/projects/viberr-core/board?filter=waiting", createdAt: "2026-09-01T10:00:00.000Z" },
          { id: "m2", conversationId: "cnv_t", seq: 2, author: "controller", userId: null, text: "In review.", runId: "run_1", surface: null, createdAt: "2026-09-01T10:00:05.000Z" },
        ],
        viewerOwnsActive: true,
      }),
      "?c=cnv_t",
    );
    await screen.findByText("Anchored to VIB-142 on the Viberr Core board, with your own permissions.");
    const from = screen.getByText("from Board");
    expect(from.getAttribute("title")).toBe("/projects/viberr-core/board?filter=waiting");
    // The controller's reply carries no surface chip.
    expect(screen.getAllByText(/^from /)).toHaveLength(1);
  });
});

/**
 * U33-8: the page's conversation rail follows the dock's continuity rule. A
 * bare URL means "the newest thread of this scope", which the loader resolves
 * — so the rail marks what is OPEN rather than what the URL asked for, and
 * "New" has to name the blank composer (`?c=new`) instead of dropping `c`.
 */
describe("the conversation rail (U33-8)", () => {
  it("asks for a blank composer by name, so a bare URL can mean the newest thread", async () => {
    renderPage(view());
    const link = await screen.findByRole("link", { name: "New" });
    expect(link.getAttribute("href")).toBe(
      "/projects/viberr-core/controller?c=new",
    );
  });

  it("marks the thread the transcript is showing, even with no ?c= in the URL", async () => {
    const { container } = renderPage(
      view({
        conversation: {
          id: "cnv_b",
          userId: "u1",
          userLabel: "arda@viberr.dev",
          projectSlug: "viberr-core",
          taskKey: null,
          title: "Board thread",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
          lastMessageAt: "2026-09-01T10:00:00.000Z",
        },
        viewerOwnsActive: true,
      }),
    );
    await screen.findByText("Board thread");
    const marked = [...container.querySelectorAll("a.ctl-conv.on")];
    expect(marked.map((a) => a.textContent)).toEqual([
      expect.stringContaining("Board thread"),
    ]);
  });
});

describe("surfaceLabel", () => {
  it("reduces a surface to the view, the task key, or the top-level page", () => {
    expect(surfaceLabel("/projects/viberr/board?filter=waiting")).toBe("Board");
    expect(surfaceLabel("/projects/viberr")).toBe("Board");
    expect(surfaceLabel("/projects/viberr/review")).toBe("Review");
    expect(surfaceLabel("/projects/viberr/tasks/VIB-7")).toBe("VIB-7");
    expect(surfaceLabel("/")).toBe("Home");
    expect(surfaceLabel("/notifications")).toBe("Notifications");
    expect(surfaceLabel("/org/settings?tab=controller")).toBe("Org");
  });
});
