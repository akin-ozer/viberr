// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ToastProvider } from "~/ui/toast";
import { AttachmentLightboxProvider, useAttachmentLightbox } from "./attachment-lightbox";

/**
 * Ruling 80: a project admin takes a file off a task's record from the card
 * it opens in; anyone else is not offered it. The writer and its refusals are
 * `record-removal.server.test.ts`'s.
 */

afterEach(cleanup);

/** What the task route was sent, keyed by the path that took it. */
function renderOn(page: () => React.JSX.Element) {
  const posted: { path: string; body: Record<string, string> }[] = [];
  const action = async ({ request }: { request: Request }) => {
    // No file is ever posted here, so every field reads as its text.
    const body = Object.fromEntries([...(await request.formData())].map(([key, value]) => [key, String(value)]));
    posted.push({ path: new URL(request.url).pathname, body });
    return { ok: true, toast: "removed" };
  };
  const Stub = createRoutesStub([
    { path: "/projects/p/tasks/K", Component: () => <ToastProvider>{page()}</ToastProvider>, action },
  ]);
  render(<Stub initialEntries={["/projects/p/tasks/K"]} />);
  return posted;
}

function OpenFile() {
  const lightbox = useAttachmentLightbox();
  const url = "/projects/p/tasks/K/attachments/golden-files.md";
  return (
    <a href={url} onClick={lightbox({ name: "golden-files.md", url })}>
      golden-files.md
    </a>
  );
}

describe("ruling 80: removing from a task's record", () => {
  it("offers an admin Remove on a file's card, posted to the task that serves it", async () => {
    // CANARY: drop `removable` from the provider's card and the file has no
    // way off the record but a shell.
    const posted = renderOn(() => (
      <AttachmentLightboxProvider removable>
        <OpenFile />
      </AttachmentLightboxProvider>
    ));
    fireEvent.click(await screen.findByRole("link", { name: "golden-files.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove file" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      path: "/projects/p/tasks/K",
      body: { intent: "remove-attachment", name: "golden-files.md" },
    });
  });

  it("offers no Remove on a file's card to a viewer without the grant", async () => {
    renderOn(() => (
      <AttachmentLightboxProvider>
        <OpenFile />
      </AttachmentLightboxProvider>
    ));
    fireEvent.click(await screen.findByRole("link", { name: "golden-files.md" }));
    await screen.findByRole("dialog", { name: "Attachment golden-files.md" });
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
