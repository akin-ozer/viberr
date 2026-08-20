// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { NewProjectModal } from "./new-project-modal";

/**
 * Pass-19 UX coherence audit — two findings on this one dialog.
 *
 * #14 (empty & error states): creating a project is deliberately self-serve for
 * ANY org member, but it needs a repository, so a connectionless instance sends
 * every member through this note. It was a live link into /org/settings, which
 * is `requireRole(…, "admin")` — a member clicked the instruction they were
 * given and got a bare 403 splash. OrgTile and the user menu had already been
 * fixed for exactly this (B-FD4); this dialog was the surface left over.
 *
 * #20 (a11y): success on the Create button toasts (the app's one announcer) and
 * the pre-submit blocker hint carries `role="status"`, but the SERVER's refusal
 * rendered in a roleless `.form-err` — the one branch nobody was told about.
 */

afterEach(cleanup);

/** The create-project action's reply, as NewProjectModal's own fetcher declares it. */
interface CreateProjectReply {
  ok: boolean;
  key?: string;
  slug?: string;
  storePath?: string;
  repoWarning?: string | null;
  error?: string;
}

function renderModal(
  props: Partial<Parameters<typeof NewProjectModal>[0]> = {},
  action: () => Promise<CreateProjectReply> = async () => ({ ok: true }),
) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <NewProjectModal
            connections={[]}
            connectionHealth={{}}
            storeRoot={null}
            onClose={() => {}}
            {...props}
          />
        </ToastProvider>
      ),
      action,
    },
    { path: "/projects/:slug/board", Component: () => <div>board</div> },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("#14: the zero-connections note never hands a member a 403", () => {
  const orgSettingsLink = (container: HTMLElement) =>
    container.querySelector('a[href^="/org/settings"]');

  it("an org ADMIN keeps the link — they are the one who can add the PAT", () => {
    const { container } = renderModal({ isAdmin: true });
    expect(container.textContent).toContain("No GitHub connections yet");
    expect(orgSettingsLink(container)).not.toBeNull();
  });

  it("a MEMBER is told who adds it instead of being handed the admin-only door", () => {
    const { container } = renderModal({ isAdmin: false });
    const text = container.textContent ?? "";
    expect(text).toContain("No GitHub connections yet");
    expect(orgSettingsLink(container)).toBeNull();
    // Not merely link-less: the member is left with a next step they can take.
    expect(text).toContain("an org admin adds the PAT");
    expect(text).toContain("Ask an admin");
  });

  it("falls back to the loader's own admin fact when `isAdmin` is not passed", () => {
    // `storeRoot` is `user.role === "admin" ? VIBERR_DATA_ROOT : null`
    // (routes/_index.tsx), so a null store root IS a non-admin reader. The gate
    // must never default to "admin" for someone who is not one.
    expect(orgSettingsLink(renderModal({ storeRoot: null }).container)).toBeNull();
    cleanup();
    expect(
      orgSettingsLink(renderModal({ storeRoot: "/data" }).container),
    ).not.toBeNull();
  });
});

describe("N20-11: the repo field says the owner is fixed by the connection", () => {
  it("names the connection owner and tells the typist to enter just the repo name", () => {
    const { container } = renderModal({
      connections: ["akin-ozer"],
      connectionHealth: { "akin-ozer": "valid" },
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Owner is fixed by the");
    expect(text).toContain("Enter just the");
    // The fixed owner is named, so a `owner/name` entry is visibly redundant.
    expect(text).toContain("akin-ozer");
  });
});

describe("#20: the server's refusal is announced, not just drawn", () => {
  it("renders the create failure in a live region", async () => {
    const { container, getByPlaceholderText, getByText } = renderModal(
      { connections: ["akin-ozer"], connectionHealth: { "akin-ozer": "valid" } },
      async () => ({ ok: false, error: "projects/payments already exists." }),
    );
    fireEvent.change(getByPlaceholderText("e.g. Payments Gateway"), {
      target: { value: "Payments" },
    });
    fireEvent.click(getByText("Create project"));

    const err = await waitFor(() => {
      const node = container.querySelector(".form-err");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(err.textContent).toContain("projects/payments already exists.");
    expect(err.getAttribute("role")).toBe("alert");
  });
});
