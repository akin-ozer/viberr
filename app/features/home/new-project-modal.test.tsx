// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

describe("Q26-3: a task key already used by another project is flagged (not blocked)", () => {
  it("notes the collision when the resolved key matches an existing project's", () => {
    const { getByLabelText, getByText } = renderModal({
      existingKeys: ["VIB", "PAY"],
    });
    fireEvent.change(getByLabelText("Task key"), { target: { value: "vib" } });
    expect(getByText(/Another project already uses VIB/)).toBeTruthy();
  });

  it("shows the normal hint for a unique key", () => {
    const { getByLabelText, getByText, queryByText } = renderModal({
      existingKeys: ["VIB"],
    });
    fireEvent.change(getByLabelText("Task key"), { target: { value: "QAX" } });
    expect(queryByText(/already uses/)).toBeNull();
    expect(getByText(/ids look like QAX-1/)).toBeTruthy();
  });

  it("does not flag a 1-letter partial key as a collision", () => {
    const { getByLabelText, queryByText } = renderModal({ existingKeys: ["V"] });
    fireEvent.change(getByLabelText("Task key"), { target: { value: "v" } });
    // Too short to be a real key yet — the "at least 2 letters" hint owns it.
    expect(queryByText(/already uses/)).toBeNull();
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

/**
 * Interface review 2026-09-06: the primary used to be hard-disabled (with an
 * inline `pointer-events: none`) until the form was valid, so a click on Create
 * gave no feedback and the button was missing from the tab order. It stays
 * enabled now; a refused submit turns the blocker into an alert, marks the
 * field it names and moves focus there.
 */
describe("Create project stays enabled and refuses with the field named", () => {
  const withConnection = {
    connections: ["akin-ozer"],
    connectionHealth: { "akin-ozer": "valid" as const },
  };
  const createButton = (container: HTMLElement) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent!.trim() === "Create project",
    )!;

  it("opens with an enabled primary and no field accused", () => {
    const { container } = renderModal(withConnection);
    const create = createButton(container);
    expect(create.disabled).toBe(false);
    expect(create.getAttribute("style")).toBeNull();
    expect(create.getAttribute("title")).toBeNull();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
    // The blocker explains itself before any attempt, as a status line.
    const blocker = container.querySelector("#np-block-reason")!;
    expect(blocker.getAttribute("role")).toBe("status");
    expect(blocker.className).not.toContain("err");
  });

  it("refuses an empty form: the name is marked, described and focused", async () => {
    let posted = 0;
    const { container } = renderModal(withConnection, async () => {
      posted += 1;
      return { ok: true };
    });
    fireEvent.click(createButton(container));
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("np-block-reason");
    expect(document.activeElement).toBe(name);
    const blocker = container.querySelector("#np-block-reason")!;
    expect(blocker.textContent).toBe("Enter a project name (2+ characters).");
    expect(blocker.getAttribute("role")).toBe("alert");
    expect(blocker.className).toContain("err");
    await act(async () => {});
    expect(posted).toBe(0);
  });

  it("re-inserts the blocker as a fresh alert on every refusal", () => {
    const { container } = renderModal(withConnection);
    const before = container.querySelector("#np-block-reason")!;
    fireEvent.click(createButton(container));
    const first = container.querySelector("#np-block-reason")!;
    // Readers announce an alert's insertion, not a role flip on the same
    // node with the same text, so the refusal has to mount a new element.
    expect(first).not.toBe(before);
    expect(first.getAttribute("role")).toBe("alert");
    fireEvent.click(createButton(container));
    expect(container.querySelector("#np-block-reason")).not.toBe(first);
  });

  it("moves the flag to the key when the name yields no letters, keeping the strip note described", () => {
    const { container } = renderModal(withConnection);
    fireEvent.change(container.querySelector("#np-name")!, {
      target: { value: "1234" },
    });
    fireEvent.click(createButton(container));
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    const key = container.querySelector<HTMLInputElement>("#np-key")!;
    expect(name.getAttribute("aria-invalid")).toBeNull();
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(key.getAttribute("aria-describedby")).toBe("np-key-note np-block-reason");
    expect(document.activeElement).toBe(key);
  });

  it("submits a valid form from the same click path", async () => {
    let posted = 0;
    const { container } = renderModal(withConnection, async () => {
      posted += 1;
      return { ok: false, error: "refused for the test" };
    });
    fireEvent.change(container.querySelector("#np-name")!, {
      target: { value: "Payments" },
    });
    expect(container.querySelector("#np-block-reason")).toBeNull();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
    fireEvent.click(createButton(container));
    await waitFor(() => expect(posted).toBe(1));
  });
});

describe("the Workflow field states the starting board, it does not pretend to pick it", () => {
  it("renders a statement, not a selected option nobody can change", () => {
    const { container, getByText } = renderModal();
    // `.pick-chip` is the option BUTTON class in every other field of this
    // dialog and `.on` is its selected fill, so a one-option picker read as a
    // control you cannot use, and `aria-disabled` on a role-less span told
    // assistive tech nothing.
    expect(getByText("Workflow")).toBeTruthy();
    expect(
      container.textContent,
    ).toContain("Starts on the Standard · 5 stages board");
    expect(container.querySelector(".pick-chip:not(button)")).toBeNull();
    expect(container.querySelector("span[aria-disabled]")).toBeNull();
  });
});
