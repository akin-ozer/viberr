// @vitest-environment jsdom
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtClock, useElapsed } from "./runs-helpers";

const fixedNow = Date.parse("2026-07-13T00:00:00.000Z");
const startedAt = new Date(fixedNow - 402_000).toISOString();

function ElapsedLabel() {
  return <time>{fmtClock(useElapsed(startedAt, true))}</time>;
}

afterEach(() => vi.restoreAllMocks());

describe("useElapsed hydration contract", () => {
  it("hydrates a stable clock sentinel before starting the client timer", async () => {
    const html = renderToString(<ElapsedLabel />);
    expect(html).toContain("00:00");

    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    container.innerHTML = html;
    let root: Root | undefined;

    await act(async () => {
      root = hydrateRoot(container, <ElapsedLabel />);
    });

    expect(container.textContent).toBe("06:42");
    expect(
      consoleError.mock.calls.some((args) =>
        args.some((arg) => String(arg).toLowerCase().includes("hydration")),
      ),
    ).toBe(false);

    await act(async () => root?.unmount());
  });
});
