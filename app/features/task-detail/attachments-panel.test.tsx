// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { AttachmentsPanel } from "./attachments-panel";
import { TimelineItem } from "./timeline";

afterEach(cleanup);

/* R19-19 — the attachments surface: the task-page panel and the evidence
   linkify that turns a cited filename into a link to the serving route. */

const BASE = "/projects/p1/tasks/VIB-1/attachments";

const entry = (name: string, size = 2048) => ({
  name,
  size,
  modifiedAt: "2026-08-14T10:00:00.000Z",
});

describe("AttachmentsPanel", () => {
  it("renders NOTHING for a task with no attachments and no browser-capable agent", () => {
    // The no-noise default: most tasks never touch the browser feature, so an
    // empty "Attachments (0)" panel would just be clutter.
    const { container } = render(<AttachmentsPanel base={BASE} attachments={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("D8: renders an orienting empty state when a browser-capable agent is deployed", () => {
    // The finding: a user promised browser evidence had NO surface telling them
    // none arrived. Now it says what's absent, why, and what happens next.
    const { container } = render(
      <AttachmentsPanel base={BASE} attachments={[]} browserExpected />,
    );
    expect(container.textContent).toContain("Attachments");
    expect(container.textContent).toContain("No attachments yet");
    expect(container.textContent).toContain("browser-capable agent");
    // Still no thumbnails/rows on an empty panel.
    expect(container.querySelector(".attach-thumb")).toBeNull();
    expect(container.querySelector(".attach-file")).toBeNull();
  });

  it("renders image thumbnails from the member-only route and plain rows for other files", () => {
    const { container } = render(
      <AttachmentsPanel
        base={BASE}
        attachments={[entry("home-page.png"), entry("report.pdf", 10240)]}
      />,
    );
    expect(container.textContent).toContain("Attachments");
    expect(container.textContent).toContain("2 files");
    const img = container.querySelector<HTMLImageElement>(".attach-thumb img")!;
    expect(img.getAttribute("src")).toBe(`${BASE}/home-page.png`);
    expect(img.getAttribute("loading")).toBe("lazy");
    const file = container.querySelector<HTMLAnchorElement>(".attach-file")!;
    expect(file.getAttribute("href")).toBe(`${BASE}/report.pdf`);
    expect(file.textContent).toContain("report.pdf");
    expect(file.textContent).toContain("10.0 KB");
  });

  it("URL-encodes filenames so an odd-but-legal name still resolves", () => {
    const { container } = render(
      <AttachmentsPanel base={BASE} attachments={[entry("after fix #2.png")]} />,
    );
    const img = container.querySelector<HTMLImageElement>(".attach-thumb img")!;
    expect(img.getAttribute("src")).toBe(`${BASE}/after%20fix%20%232.png`);
  });
});

/* ------------------------------------------- evidence filename linkify */

function evidenceEvent(label: string): TimelineEventRender {
  return {
    id: 7,
    type: "outcome",
    occurredAt: "2026-08-14T10:00:00.000Z",
    actor: { kind: "agent", backend: "claude", name: "Developer", role: "developer" },
    title: null,
    text: "Reported completion",
    toAgent: false,
    attachments: null,
    evidence: [{ label, add: "+2", del: "−0" }],
  };
}

describe("TimelineItem evidence linkify", () => {
  it("links a cited filename that names a REAL attachment", () => {
    const { container } = render(
      <TimelineItem
        ev={evidenceEvent("screenshot `board-after.png` shows the fix")}
        attachmentNames={new Set(["board-after.png"])}
        attachmentsBase={BASE}
      />,
    );
    const link = container.querySelector<HTMLAnchorElement>(".ev-row .ev-file")!;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(`${BASE}/board-after.png`);
    expect(link.textContent).toBe("board-after.png");
    // The surrounding words stay plain text.
    expect(container.querySelector(".ev-row")!.textContent).toContain(
      "shows the fix",
    );
  });

  it("leaves labels alone when nothing matches — no guessed links", () => {
    const { container } = render(
      <TimelineItem
        ev={evidenceEvent("app/server/tasks/task-actions.server.ts")}
        attachmentNames={new Set(["board-after.png"])}
        attachmentsBase={BASE}
      />,
    );
    expect(container.querySelector(".ev-file")).toBeNull();
  });

  it("renders plain text without the attachment props (bare renders, non-members)", () => {
    const { container } = render(
      <TimelineItem ev={evidenceEvent("see board-after.png")} />,
    );
    expect(container.querySelector(".ev-file")).toBeNull();
    expect(container.textContent).toContain("see board-after.png");
  });
});

/* ---------------------------------------- P21: producer attribution + chips */

describe("AttachmentsPanel producer attribution (P21)", () => {
  const producers = {
    "home-page.png": { actor: "Web Verifier", occurredAt: "2026-08-14T10:00:00.000Z" },
    "report.pdf": { actor: "Reviewer", occurredAt: "2026-08-14T11:00:00.000Z" },
  };

  it("names who added each file, thumbnails and rows alike", () => {
    const { container } = render(
      <AttachmentsPanel
        base={BASE}
        attachments={[entry("home-page.png"), entry("report.pdf", 10240)]}
        producers={producers}
      />,
    );
    const thumbBy = container.querySelector(".attach-thumb .attach-by")!;
    expect(thumbBy.textContent).toContain("added by Web Verifier");
    const fileBy = container.querySelector(".attach-file .attach-by")!;
    expect(fileBy.textContent).toContain("by Reviewer");
  });

  it("omits the producer line for a name no event claims — never a guess", () => {
    const { container } = render(
      <AttachmentsPanel
        base={BASE}
        attachments={[entry("pre-attribution.png")]}
        producers={producers}
      />,
    );
    expect(container.querySelector(".attach-by")).toBeNull();
  });
});

describe("TimelineItem attachment chips (P21 — the producing message shows its files)", () => {
  const withFiles = (attachments: string[] | null): TimelineEventRender => ({
    id: 9,
    type: "comment",
    occurredAt: "2026-08-14T10:00:00.000Z",
    actor: { kind: "agent", backend: "claude", name: "Web Verifier", role: "verification" },
    title: null,
    text: "Captured the page.",
    toAgent: false,
    evidence: null,
    attachments,
  });

  it("renders one chip per saved file, linking to the serving route", () => {
    const { container } = render(
      <TimelineItem
        ev={withFiles(["home page.png", "capture.yml"])}
        attachmentsBase={BASE}
      />,
    );
    const chips = container.querySelectorAll<HTMLAnchorElement>(".tl-attach-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.getAttribute("href")).toBe(`${BASE}/home%20page.png`);
    expect(chips[0]!.textContent).toContain("home page.png");
    expect(chips[1]!.getAttribute("href")).toBe(`${BASE}/capture.yml`);
  });

  it("renders no chips without the serving base (withheld lists, bare renders)", () => {
    const { container } = render(<TimelineItem ev={withFiles(["a.png"])} />);
    expect(container.querySelector(".tl-attach")).toBeNull();
    // The message text itself still renders.
    expect(container.textContent).toContain("Captured the page.");
  });

  it("renders no chip row at all for an event with no files", () => {
    const { container } = render(
      <TimelineItem ev={withFiles(null)} attachmentsBase={BASE} />,
    );
    expect(container.querySelector(".tl-attach")).toBeNull();
  });
});
