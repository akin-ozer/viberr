// @vitest-environment jsdom
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDayTime } from "./format";
import { useViewerTimeZone } from "./use-viewer-time-zone";

const instant = "2026-07-12T22:30:00.000Z";
const now = new Date("2026-07-13T00:00:00.000Z");

function TimeLabel() {
  const timeZone = useViewerTimeZone();
  return <time>{formatDayTime(instant, now, timeZone)}</time>;
}

afterEach(() => vi.restoreAllMocks());

describe("useViewerTimeZone", () => {
  it("hydrates the UTC server snapshot before switching to Istanbul", async () => {
    const html = renderToString(<TimeLabel />);
    expect(html).toContain("Yesterday 22:30");

    const originalResolvedOptions =
      Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(
      function (this: Intl.DateTimeFormat) {
        return {
          ...originalResolvedOptions.call(this),
          timeZone: "Europe/Istanbul",
        };
      },
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    container.innerHTML = html;
    let root: Root | undefined;

    await act(async () => {
      root = hydrateRoot(container, <TimeLabel />);
    });

    expect(container.textContent).toBe("1:30");
    expect(
      consoleError.mock.calls.some((args) =>
        args.some((arg) => String(arg).toLowerCase().includes("hydration")),
      ),
    ).toBe(false);

    await act(async () => root?.unmount());
  });
});
