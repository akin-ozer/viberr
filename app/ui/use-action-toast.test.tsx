// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub, useFetcher } from "react-router";
import { ToastProvider } from "./toast";
import { useActionToast } from "./use-action-toast";

/**
 * P13-D-10 (UX-5): `ToastKind` exists so "a failure toast must not render a
 * success tick" (toast.tsx:24), but this shared helper — the toast path for 11
 * fetchers across project settings, GitHub and Policy — pushed EVERY message
 * with `push`'s default `"success"` kind. Colour is not the differentiator
 * (both kinds paint `background: var(--fg)`), so the glyph is the entire signal.
 *
 * Those three surfaces have no inline error text at all, which makes the toast
 * the whole failure record: getting its kind wrong is the difference between
 * "saved" and "refused".
 */

afterEach(cleanup);

const ALERT_PATH = "M12 4l9 16H3z";
const CHECK_PATH = "M5 12.5l4.5 4.5L19 7";

function Harness() {
  const fetcher = useFetcher<
    { ok: true; toast?: string } | { ok: false; error?: string }
  >();
  useActionToast(fetcher);
  return (
    <fetcher.Form method="post">
      <button type="submit" name="outcome" value="ok">
        succeed
      </button>
      <button type="submit" name="outcome" value="fail">
        fail
      </button>
    </fetcher.Form>
  );
}

function renderHarness() {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <Harness />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const form = await request.formData();
        return form.get("outcome") === "ok"
          ? { ok: true as const, toast: "Saved" }
          : { ok: false as const, error: "Only an admin can do that." };
      },
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("useActionToast", () => {
  it("renders a server error with the failure glyph, not the success tick", async () => {
    const { container, getByText } = renderHarness();
    fireEvent.click(getByText("fail"));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = container.querySelector(".toast")!;
    expect(toast.textContent).toContain("Only an admin can do that.");
    expect(toast.getAttribute("data-kind")).toBe("error");
    expect(toast.querySelector("path")!.getAttribute("d")).toBe(ALERT_PATH);
  });

  it("still renders the success tick for an ok result", async () => {
    const { container, getByText } = renderHarness();
    fireEvent.click(getByText("succeed"));
    await waitFor(() =>
      expect(container.querySelector(".toast")).not.toBeNull(),
    );
    const toast = container.querySelector(".toast")!;
    expect(toast.textContent).toContain("Saved");
    expect(toast.getAttribute("data-kind")).toBe("success");
    expect(toast.querySelector("path")!.getAttribute("d")).toBe(CHECK_PATH);
  });
});
