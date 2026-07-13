// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ToastProvider, useToast } from "./toast";

afterEach(cleanup);

function Probe() {
  const push = useToast();
  return (
    <>
      <button type="button" onClick={() => push("Saved")}>success</button>
      <button
        type="button"
        onClick={() => push({ kind: "error", text: "Save failed" })}
      >
        error
      </button>
    </>
  );
}

describe("typed toast feedback", () => {
  it("uses success semantics for legacy strings and alert semantics for errors", () => {
    const { getByRole } = render(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );

    fireEvent.click(getByRole("button", { name: "success" }));
    // The live region is the always-mounted wrapper (so it is registered before
    // content arrives); the success toast renders inside it.
    const status = getByRole("status");
    expect(status.classList.contains("toast-wrap")).toBe(true);
    expect(status.getAttribute("aria-live")).toBe("polite");
    const successToast = status.querySelector(".toast.success");
    expect(successToast).not.toBeNull();
    expect(successToast?.textContent).toContain("Saved");

    fireEvent.click(getByRole("button", { name: "error" }));
    const alert = getByRole("alert");
    expect(alert.classList.contains("error")).toBe(true);
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("Save failed");
  });
});
