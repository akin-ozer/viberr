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

function renderPanel() {
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => (
        <ToastProvider>
          <UsersPanel users={[ME]} domains={DOMAINS} meId="u_arda" />
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
