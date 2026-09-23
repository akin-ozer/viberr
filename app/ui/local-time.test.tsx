// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { formatDayDotTime, formatDayDotTimeUTC } from "~/shared/dates/format";
import { LocalDayDotTime } from "./local-time";

/**
 * The hydration contract (pass 34, C6) under ruling 454's `useHydrated`: the
 * server and the hydration pass render the timezone-free UTC form, so the two
 * agree whatever the viewer's zone; the local form follows once hydration has
 * committed; and a stamp that mounts after that renders local from its first
 * commit. The zone is pinned to Pacific/Auckland so the two forms differ.
 */

const ISO = "2026-07-03T20:15:00.000Z";
const LATER = "2026-07-09T06:40:00.000Z";

const originalTz = process.env.TZ;
const roots: Root[] = [];
beforeEach(() => {
  process.env.TZ = "Pacific/Auckland";
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

let addStamp: () => void = () => {};
function Stamps() {
  const [isos, setIsos] = useState([ISO]);
  addStamp = () => setIsos((list) => [...list, LATER]);
  return (
    <ul>
      {isos.map((iso) => (
        <li key={iso}>
          <LocalDayDotTime iso={iso} />
        </li>
      ))}
    </ul>
  );
}

describe("useHydrated (ruling 454)", () => {
  it("serves the UTC form, hydrates without a mismatch, then shows the local form", async () => {
    expect(formatDayDotTime(ISO)).not.toBe(formatDayDotTimeUTC(ISO));
    const html = renderToString(<Stamps />);
    expect(html).toContain(formatDayDotTimeUTC(ISO));
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML = html;
    const errors: string[] = [];
    await act(async () => {
      roots.push(
        hydrateRoot(container, <Stamps />, {
          onRecoverableError: (error) => errors.push(String(error)),
        }),
      );
    });
    expect(errors).toEqual([]);
    expect(container.querySelector("li")!.textContent).toBe(formatDayDotTime(ISO));
  });

  it("renders a stamp mounted after hydration in local time from its first commit", async () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML = renderToString(<Stamps />);
    await act(async () => {
      roots.push(hydrateRoot(container, <Stamps />));
    });
    const records: MutationRecord[] = [];
    const watch = new MutationObserver((batch) => records.push(...batch));
    watch.observe(container, { subtree: true, childList: true, characterData: true });
    await act(async () => addStamp());
    records.push(...watch.takeRecords());
    const seen: string[] = [];
    for (const record of records) {
      for (const node of record.addedNodes) seen.push(node.textContent ?? "");
      if (record.type === "characterData") seen.push(record.target.textContent ?? "");
    }
    // The new row arrived holding its local text; no UTC form was ever drawn.
    expect(seen).toEqual([formatDayDotTime(LATER)]);
    expect(container.querySelectorAll("li")[1]!.textContent).toBe(formatDayDotTime(LATER));
  });
});
