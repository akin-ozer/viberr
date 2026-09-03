// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ControllerPage } from "./controller-page";
import type { ControllerSurfaceView } from "./controller-query.server";

/**
 * Ruling 121 — the controller's unavailable state is about the PERSON reading
 * it, and says where they fix it.
 *
 * The page used to render "Claude backend unavailable" and "The Claude backend
 * is unavailable, so the controller cannot answer" — a deployment outage, told
 * to a person who could do nothing about it and who was, in fact, one sign-in
 * away from a working controller. A turn runs on the ASKER's own Claude
 * account, so the composer now says exactly what the refused turn would record
 * in the transcript (`controllerRefusalNote`), and points at Profile → Agent
 * accounts.
 */

afterEach(cleanup);

function view(patch: Partial<ControllerSurfaceView> = {}): ControllerSurfaceView {
  return {
    available: true,
    controllerName: "Controller",
    conversations: [],
    conversation: null,
    messages: [],
    turn: { working: false, runId: null },
    goals: null,
    viewerOwnsActive: false,
    showingAll: false,
    viewerIsOrgAdmin: false,
    ...patch,
  };
}

function renderPage(surface: ControllerSurfaceView) {
  const Stub = createRoutesStub([
    {
      path: "/controller",
      Component: () => (
        <ToastProvider>
          <ControllerPage
            view={surface}
            projectSlug={null}
            canRedirectGoals={false}
          />
        </ToastProvider>
      ),
    },
  ]);
  return render(<Stub initialEntries={["/controller"]} />);
}

const composer = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message to the controller"]',
  )!;

describe("controller page: the Claude-not-connected state (ruling 121)", () => {
  it("names the viewer's own account and where they connect it", () => {
    const { container } = renderPage(view({ available: false }));
    const box = composer(container);
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toContain("your own Claude account");
    expect(box.placeholder).toContain("Profile → Agent accounts");
    // The pill states the same fact in the header, and neither of them blames
    // the deployment: since ruling 121 it holds no credential to blame.
    expect(container.textContent).toContain("Claude not connected");
    expect(container.textContent).not.toContain("backend unavailable");
    expect(container.textContent).not.toContain("on this instance");
  });

  it("says nothing of the sort to a viewer who HAS connected Claude", () => {
    const { container } = renderPage(view({ available: true }));
    const box = composer(container);
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toContain("Ask the controller");
    expect(container.textContent).not.toContain("Claude not connected");
  });

  it("keeps the read-only refusal distinct from the not-connected one", () => {
    // Someone else's conversation: the composer is off for a reason that has
    // nothing to do with credentials, and must not borrow the other sentence.
    const { container } = renderPage(
      view({
        available: true,
        viewerOwnsActive: false,
        conversation: {
          id: "cv_1",
          userId: "u-other",
          userLabel: "other@viberr.test",
          projectSlug: null,
          title: "Someone else's thread",
          createdAt: "2026-09-02T09:00:00.000Z",
          updatedAt: "2026-09-02T09:00:00.000Z",
          lastMessageAt: null,
        },
      }),
    );
    const box = composer(container);
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toContain("only the conversation's owner");
    expect(box.placeholder).not.toContain("Claude");
  });
});
