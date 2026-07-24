// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ORG_SETTINGS_ACTION, useOrgAction } from "./use-org-action";

/**
 * P13-D-10 (UX-5): the second shared toast helper. Every org-settings row
 * action that does not pass `onResult` toasts through here, and the failure
 * branch pushed `d.error` with `push`'s default `"success"` kind — a refusal
 * wearing the success tick.
 */

afterEach(cleanup);

const ALERT_PATH = "M12 4l9 16H3z";

function Harness() {
  const { submit } = useOrgAction();
  return (
    <>
      <button type="button" onClick={() => submit({ intent: "ok" })}>
        succeed
      </button>
      <button type="button" onClick={() => submit({ intent: "fail" })}>
        fail
      </button>
    </>
  );
}

function renderHarness() {
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => (
        <ToastProvider>
          <Harness />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const form = await request.formData();
        return form.get("intent") === "ok"
          ? { ok: true as const, toast: "Role updated" }
          : { ok: false as const, error: "Only an org admin can do that." };
      },
    },
  ]);
  return render(<Stub initialEntries={[ORG_SETTINGS_ACTION]} />);
}

describe("useOrgAction", () => {
  it("renders a refused org action with the failure glyph", async () => {
    const { container, getByText } = renderHarness();
    fireEvent.click(getByText("fail"));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = container.querySelector(".toast")!;
    expect(toast.textContent).toContain("Only an org admin can do that.");
    expect(toast.getAttribute("data-kind")).toBe("error");
    expect(toast.querySelector("path")!.getAttribute("d")).toBe(ALERT_PATH);
  });

  it("leaves a successful org action on the success tick", async () => {
    const { container, getByText } = renderHarness();
    fireEvent.click(getByText("succeed"));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    expect(container.querySelector(".toast")!.getAttribute("data-kind")).toBe(
      "success",
    );
  });
});
