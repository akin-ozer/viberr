// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub, Link, Outlet, useRevalidator } from "react-router";
import { RoutePendingBar } from "./route-pending-bar";

/**
 * P13-D-36 (UX-8 / F13-04): before this the whole tree used `useNavigation` in
 * exactly two lines, both in `app/routes/login.tsx` — clicking "GitHub" in the
 * rail (the one loader that awaits the network) looked like a dead click for up
 * to the 20 s client timeout.
 */

afterEach(cleanup);

/** Resolves when the test lets the slow route's loader finish. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

function renderApp(
  gate: Promise<void>,
  opts: { delayMs?: number } = {},
) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <>
          <RoutePendingBar delayMs={opts.delayMs} />
          <Outlet />
        </>
      ),
      children: [
        {
          index: true,
          Component: () => {
            const revalidator = useRevalidator();
            return (
              <>
                <Link to="/slow">go</Link>
                <button type="button" onClick={() => void revalidator.revalidate()}>
                  refresh
                </button>
              </>
            );
          },
        },
        {
          path: "slow",
          loader: async () => {
            await gate;
            return null;
          },
          Component: () => <div>slow page</div>,
        },
      ],
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("RoutePendingBar", () => {
  it("announces a navigation that is still loading", async () => {
    const gate = deferred();
    const { container, getByText } = renderApp(gate.promise, { delayMs: 0 });
    expect(container.querySelector(".route-pending")).toBeNull();

    fireEvent.click(getByText("go"));
    await waitFor(() =>
      expect(container.querySelector(".route-pending")).not.toBeNull(),
    );
    const bar = container.querySelector(".route-pending")!;
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-label")).toBe("Loading the next page");
    // Layout stability: React Router keeps the current page painted throughout.
    expect(getByText("go")).toBeTruthy();

    await act(async () => {
      gate.release();
      await gate.promise;
    });
    await waitFor(() => expect(getByText("slow page")).toBeTruthy());
    expect(container.querySelector(".route-pending")).toBeNull();
  });

  it("does not flash on a navigation that finishes inside the delay", async () => {
    const gate = deferred();
    const { container, getByText } = renderApp(gate.promise);
    fireEvent.click(getByText("go"));
    // Still navigating (the loader is blocked), but the default 220 ms delay
    // has not elapsed — an ordinary client navigation must complete
    // unannounced rather than strobe a bar for 40 ms.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(container.querySelector(".route-pending")).toBeNull();
    expect(getByText("go")).toBeTruthy();

    await act(async () => {
      gate.release();
      await gate.promise;
    });
    await waitFor(() => expect(getByText("slow page")).toBeTruthy());
    expect(container.querySelector(".route-pending")).toBeNull();
  });

  it("ignores SSE revalidation (which is not a navigation)", async () => {
    // The live-update hook calls `useRevalidator().revalidate()` on every SSE
    // frame; a progress bar over an idle page would be constant noise.
    const gate = deferred();
    gate.release();
    const { container, getByText } = renderApp(gate.promise, { delayMs: 0 });
    fireEvent.click(getByText("refresh"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector(".route-pending")).toBeNull();
  });
});
