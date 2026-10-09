// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { TaskSourceRow } from "~/server/tasks/task-sources.server";
import { AttachmentLightboxProvider } from "./attachment-lightbox";
import { SourcesPanel } from "./sources-panel";

afterEach(cleanup);

/* Ruling 317: the task page's Sources panel. What the loader ships is the
   route suite's and what a source is served as is the route's own; this suite
   owns what a row says and where it leads. */

const BASE = "/projects/p1/tasks/VIB-1/sources";

const PAGE: TaskSourceRow = {
  id: "S1",
  name: "aws-pricing.html",
  title: "AWS EC2 on-demand pricing, eu-central-1",
  from: "https://aws.amazon.com/ec2/pricing/on-demand/",
  keptAt: "2026-10-07T12:03:11.482Z",
  by: "Cost Researcher",
  bytes: 48_213,
};
const SHOT: TaskSourceRow = {
  id: "S2",
  name: "calculator-total.png",
  title: "The calculator's total as it showed",
  from: "browser_take_screenshot on https://calculator.aws/#/estimate",
  keptAt: "2026-10-07T12:10:00.000Z",
  by: "Cost Researcher",
  bytes: 2048,
};

describe("SourcesPanel (ruling 317)", () => {
  it("lists each source by id with its title, where it came from, who kept it and its size, and its link is the source's own route", () => {
    // CANARY: build the href from the file name instead of the id and the
    // link points at a route that answers 404.
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <SourcesPanel base={BASE} sources={[SHOT, PAGE]} total={2} />
      </AttachmentLightboxProvider>,
    );
    expect(container.querySelector(".panel-head h2")!.textContent).toBe("Sources");
    expect(container.querySelector(".panel-head .right")!.textContent).toBe("2 sources");

    const rows = [...container.querySelectorAll<HTMLAnchorElement>("a.attach-file")];
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([`${BASE}/S2`, `${BASE}/S1`]);
    expect(
      rows.map((row) =>
        [".cmp-file-ext", ".cmp-file-name", ".cmp-file-what"].map((part) => row.querySelector(part)!.textContent),
      ),
    ).toEqual([
      ["S2", "The calculator's total as it showed", "browser_take_screenshot on https://calculator.aws/#/estimate"],
      ["S1", "AWS EC2 on-demand pricing, eu-central-1", "https://aws.amazon.com/ec2/pricing/on-demand/"],
    ]);
    // Where it came from is the agent's statement, shown as text: the kept
    // copy is the thing to open, and nothing here links out.
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(rows[1]!.querySelector(".cmp-by")!.textContent).toMatch(/^kept by Cost Researcher · .+ · 47\.1 KB$/);

    // A row opens the kept copy in the reader card, read by the name the
    // agent saved it under: a kept screenshot shows as the picture.
    fireEvent.click(rows[0]!);
    const dialog = baseElement.querySelector('dialog[data-screen-label="Attachment lightbox"]')!;
    expect(dialog.querySelector("img")!.getAttribute("src")).toBe(`${BASE}/S2`);
  });

  it("says how many the task keeps when it lists only the newest, and draws nothing for a task that keeps none", () => {
    // CANARY: count the rows instead of the total and a task that keeps 140
    // sources reads as keeping the two listed.
    const { container, rerender } = render(<SourcesPanel base={BASE} sources={[SHOT, PAGE]} total={140} />);
    expect(container.querySelector(".panel-head .right")!.textContent).toBe("140 sources");
    expect(container.querySelector(".ntf-truncated")!.textContent).toBe("Showing the newest 2 of 140 sources.");

    rerender(<SourcesPanel base={BASE} sources={[PAGE]} total={1} />);
    expect(container.querySelector(".panel-head .right")!.textContent).toBe("1 source");
    expect(container.querySelector(".ntf-truncated")).toBeNull();

    rerender(<SourcesPanel base={BASE} sources={[]} total={0} />);
    expect(container.innerHTML).toBe("");
  });
});
