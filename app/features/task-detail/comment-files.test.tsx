// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { ToastProvider } from "~/ui/toast";
import { Timeline } from "./timeline";

/**
 * Ruling 76: a task comment carries files for whoever may attach one. The
 * composer offers the paperclip and takes a pasted screenshot into its tray
 * before the editor sees the paste; a viewer who may not attach is offered
 * neither.
 */

afterEach(cleanup);

const MENTIONABLES: Mentionables = { agents: [], users: [], reserved: [] };

function renderTimeline(canAttach: boolean) {
  const Stub = createRoutesStub([
    {
      path: "/t",
      Component: () => (
        <ToastProvider>
          <Timeline
            events={[]}
            hasMore={false}
            remaining={0}
            nextLimit={40}
            tlDefault="all"
            ask={0}
            mentionables={MENTIONABLES}
            canAttach={canAttach}
          />
        </ToastProvider>
      ),
    },
  ]);
  return render(<Stub initialEntries={["/t"]} />);
}

describe("ruling 76: files with a task comment", () => {
  it("takes a pasted screenshot into the comment's tray", async () => {
    // CANARY: drop the composer's `onPasteCapture` and the screenshot never
    // joins the comment.
    const { container } = renderTimeline(true);
    await screen.findByRole("button", { name: "Attach files" });
    const input = container.querySelector(".composer-input")!;
    const shot = new File(["png"], "image.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: { files: [shot], types: ["Files"] } });
    expect(screen.getByRole("list", { name: "1 of 10 files attached" }).textContent).toContain("screenshot.png");
  });

  it("offers no paperclip, and files no paste, to a viewer who may not attach", async () => {
    const { container } = renderTimeline(false);
    await screen.findByRole("button", { name: "Comment" });
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    const shot = new File(["png"], "image.png", { type: "image/png" });
    fireEvent.paste(container.querySelector(".composer-input")!, { clipboardData: { files: [shot], types: ["Files"] } });
    expect(screen.queryByRole("list", { name: /files attached/ })).toBeNull();
  });
});
