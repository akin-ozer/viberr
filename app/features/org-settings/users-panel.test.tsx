// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { DomainRecord, OrgUserView } from "~/server/org/org-users.server";
import { ToastProvider } from "~/ui/toast";
import { UsersPanel } from "./users-panel";

/**
 * P13-D-10 (UX-5): the panel's three client-side refusals ("you can't demote /
 * disable / remove yourself") are the only feedback those actions ever produce
 * — no dialog opens, nothing is posted. They pushed through `push`'s default
 * `"success"` kind, so a refusal arrived wearing the green tick.
 */

afterEach(cleanup);

const ME: OrgUserView = {
  id: "u_arda",
  name: "Arda Kaya",
  email: "arda@viberr.dev",
  initials: "AK",
  tone: "",
  role: "admin",
  status: "active",
  idp: "local",
  pwreset: false,
  disabled: false,
};
const DOMAINS: DomainRecord[] = [];

function renderPanel(
  providers: { github: boolean; google: boolean } = { github: false, google: false },
) {
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => (
        <ToastProvider>
          <UsersPanel users={[ME]} domains={DOMAINS} meId="u_arda" providers={providers} />
        </ToastProvider>
      ),
      action: async () => ({ ok: true, toast: "stub done" }),
    },
  ]);
  return render(<Stub initialEntries={["/org/settings"]} />);
}

async function kindOf(
  container: HTMLElement,
  text: string,
): Promise<string | null> {
  await waitFor(() =>
    expect(
      [...container.querySelectorAll(".toast")].some((t) =>
        t.textContent!.includes(text),
      ),
    ).toBe(true),
  );
  return [...container.querySelectorAll(".toast")]
    .find((t) => t.textContent!.includes(text))!
    .getAttribute("data-kind");
}

describe("P13-D-10: the self-guard toasts are failures", () => {
  it("marks a refused self-demotion as an error", async () => {
    const { container, getByText } = renderPanel();
    const myRow = getByText("arda@viberr.dev").closest(".member-row")!;
    fireEvent.click(myRow.querySelector(".mini-seg button:not(.on)")!);
    expect(await kindOf(container, "You can't demote yourself")).toBe("error");
  });

  it("marks a refused self-disable as an error", async () => {
    const { container, getByLabelText } = renderPanel();
    fireEvent.click(getByLabelText("Disable Arda Kaya"));
    expect(
      await kindOf(container, "You can't disable your own account"),
    ).toBe("error");
  });

  it("marks a refused self-removal as an error", async () => {
    const { container, getByLabelText } = renderPanel();
    fireEvent.click(getByLabelText("Remove Arda Kaya"));
    expect(await kindOf(container, "You can't remove your own account")).toBe(
      "error",
    );
  });
});

describe("F18-3: the Allow-access modal keys its method off configured providers", () => {
  const openModal = (container: HTMLElement, getByText: (t: string) => HTMLElement) => {
    fireEvent.click(getByText("Allow access"));
    return [...container.querySelectorAll(".be-opt")] as HTMLButtonElement[];
  };

  it("with NO OAuth provider: defaults to Local; GitHub + Google are disabled and marked off", () => {
    const { container, getByText } = renderPanel({ github: false, google: false });
    const opts = openModal(container, getByText);
    const [github, google, local] = opts;
    expect(github!.disabled).toBe(true);
    expect(google!.disabled).toBe(true);
    expect(local!.disabled).toBe(false);
    // Local is the selected default (a whitelisted OAuth account could never
    // sign in on this deployment).
    expect(local!.getAttribute("aria-pressed")).toBe("true");
    expect(github!.textContent).toContain("off");
    expect(google!.textContent).toContain("off");
  });

  it("with GitHub configured: GitHub leads and is enabled", () => {
    const { container, getByText } = renderPanel({ github: true, google: false });
    const opts = openModal(container, getByText);
    const [github, google] = opts;
    expect(github!.disabled).toBe(false);
    expect(github!.getAttribute("aria-pressed")).toBe("true");
    expect(google!.disabled).toBe(true);
  });
});

/**
 * LV-F1 — the new-account LOCKOUT (live-reproduced by the owner: "I created the
 * user but couldn't log in since it asked for a password").
 *
 * A freshly created local account always carries `pwreset: true`. The Password
 * field rendered the "Reset pending" banner INSTEAD of the "Reset password"
 * button on exactly that condition, so the one-time temp password shown at
 * creation was the account's ONLY credential — miss it, reload past it, or
 * dismiss it and the account could never sign in again. The backend could
 * always re-issue (`user-reset-password` returns a fresh tempPassword); only
 * the UI hid the door. The action must therefore survive the pending state.
 */
describe("LV-F1: a pending reset never hides the re-issue action", () => {
  const localUser = (over: Partial<OrgUserView> = {}): OrgUserView => ({
    ...ME,
    id: "u_new",
    name: "Test Contributor",
    email: "contributor@viberr.dev",
    role: "member",
    ...over,
  });

  function renderWith(user: OrgUserView) {
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME, user]}
              domains={DOMAINS}
              meId="u_arda"
              providers={{ github: false, google: false }}
            />
          </ToastProvider>
        ),
        action: async () => ({ ok: true, toast: "stub done" }),
      },
    ]);
    return render(<Stub initialEntries={["/org/settings"]} />);
  }

  const openEdit = (getByLabelText: (t: string) => HTMLElement) =>
    fireEvent.click(getByLabelText("Edit Test Contributor"));

  it("a just-created account (pwreset pending) STILL offers a way to issue a new temp password", () => {
    const { getByLabelText, getByText, container } = renderWith(
      localUser({ pwreset: true, status: "invited" }),
    );
    openEdit(getByLabelText);
    // The pending state is shown as CONTEXT…
    expect(container.textContent).toContain("Reset pending");
    // …and the recovery action is still reachable — this is the regression.
    const btn = getByText("Generate a new temp password");
    expect(btn).toBeTruthy();
    expect((btn.closest("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an established account (no pending reset) keeps the plain Reset password action", () => {
    const { getByLabelText, getByText, container } = renderWith(
      localUser({ pwreset: false, status: "active" }),
    );
    openEdit(getByLabelText);
    expect(container.textContent).not.toContain("Reset pending");
    expect(getByText("Reset password")).toBeTruthy();
  });
});
