// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { AttachmentsPanel } from "./attachments-panel";
import { AttachmentLightboxProvider } from "./attachment-lightbox";
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

  // C8: listTaskAttachments caps at 100 with nothing telling a viewer the
  // store holds more. `total` (from the new countTaskAttachments sibling)
  // lets the panel say so; it's optional so a caller that hasn't wired it
  // through yet (unchanged behavior) renders exactly as before.
  it("C8: says nothing extra when total is unset or equals the list length", () => {
    const attachments = [entry("a.png"), entry("b.pdf")];
    const { container: noTotal } = render(
      <AttachmentsPanel base={BASE} attachments={attachments} />,
    );
    expect(noTotal.querySelector(".ntf-truncated")).toBeNull();
    const { container: sameTotal } = render(
      <AttachmentsPanel base={BASE} attachments={attachments} total={2} />,
    );
    expect(sameTotal.querySelector(".ntf-truncated")).toBeNull();
  });

  it("C8: flags a truncated list when total exceeds what's shown", () => {
    const { container } = render(
      <AttachmentsPanel base={BASE} attachments={[entry("a.png")]} total={140} />,
    );
    const note = container.querySelector(".ntf-truncated")!;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain("Showing the most recent 1 of 140 files");
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

  it("renders an image as a thumbnail and other files as chips, linking to the serving route", () => {
    // Owner ask (2026-08-20): a screenshot task's deliverable IS the picture —
    // chips alone sent the human to the side panel to see what was "posted".
    const { container } = render(
      <TimelineItem
        ev={withFiles(["home page.png", "capture.yml"])}
        attachmentsBase={BASE}
      />,
    );
    const thumbs = container.querySelectorAll<HTMLAnchorElement>(".tl-attach-thumb");
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]!.getAttribute("href")).toBe(`${BASE}/home%20page.png`);
    expect(thumbs[0]!.querySelector("img")!.getAttribute("src")).toBe(
      `${BASE}/home%20page.png`,
    );
    expect(thumbs[0]!.textContent).toContain("home page.png");
    const chips = container.querySelectorAll<HTMLAnchorElement>(".tl-attach-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.getAttribute("href")).toBe(`${BASE}/capture.yml`);
  });

  it("repairs an agent-written workspace-relative attachment link in the body", () => {
    // The live shape (VIB-1, 2026-08-20): Codex cited its capture as
    // `[….png](../../attachments/….png)` — a path from its WORKSPACE, which
    // the browser resolves against the task URL and 404s. The filename names
    // a real attachment, so the href is rewritten to the serving route; a
    // name the task does not have stays exactly as written (no guessing).
    const { container } = render(
      <TimelineItem
        ev={{
          ...withFiles(["shot.png"]),
          text:
            "Done: captured [shot.png](../../attachments/shot.png) and " +
            "see [other](../../attachments/missing.png).",
        }}
        attachmentNames={new Set(["shot.png"])}
        attachmentsBase={BASE}
      />,
    );
    const links = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".comment-card a"),
    );
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `${BASE}/shot.png`,
      "../../attachments/missing.png",
    ]);
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

/**
 * Owner request 2026-08-21: clicking image evidence opened the raw file in a
 * new tab — it now opens the in-app lightbox. The anchors stay real links:
 * a MODIFIED click (the browser's own new-tab/save intents) passes through,
 * and with no provider mounted (bare renders, other surfaces) the click
 * handler is inert and the link behaves exactly as before.
 */
describe("attachment lightbox (image evidence opens a popup, not a tab)", () => {
  const ev = (text = "Captured the page."): TimelineEventRender => ({
    id: 9,
    type: "comment",
    occurredAt: "2026-08-14T10:00:00.000Z",
    actor: { kind: "agent", backend: "claude", name: "Web Verifier", role: "verification" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
    attachments: ["shot.png", "capture.yml"],
  });
  const DIALOG = 'dialog[data-screen-label="Attachment lightbox"]';

  it("a plain click on a timeline thumbnail opens the lightbox on the image", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem ev={ev()} attachmentsBase={BASE} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".tl-attach-thumb")!);
    const dialog = baseElement.querySelector(DIALOG)!;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector("img")!.getAttribute("src")).toBe(`${BASE}/shot.png`);
    // The raw file stays one click away.
    const original = dialog.querySelector<HTMLAnchorElement>("a[target='_blank']")!;
    expect(original.getAttribute("href")).toBe(`${BASE}/shot.png`);
  });

  it("a modified click (new-tab intent) does NOT intercept", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem ev={ev()} attachmentsBase={BASE} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".tl-attach-thumb")!, { ctrlKey: true });
    expect(baseElement.querySelector(DIALOG)).toBeNull();
  });

  it("with no provider, the click is inert and the anchor stays a plain link", () => {
    const { container, baseElement } = render(
      <TimelineItem ev={ev()} attachmentsBase={BASE} />,
    );
    fireEvent.click(container.querySelector(".tl-attach-thumb")!);
    expect(baseElement.querySelector(DIALOG)).toBeNull();
  });

  it("the Close control dismisses the popup", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem ev={ev()} attachmentsBase={BASE} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".tl-attach-thumb")!);
    fireEvent.click(baseElement.querySelector(`${DIALOG} button[aria-label="Close"]`)!);
    expect(baseElement.querySelector(DIALOG)).toBeNull();
  });

  it("an inline markdown embed of a task attachment opens the same lightbox", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem
          ev={ev("Proof: ![the capture](attachments/shot.png)")}
          attachmentNames={new Set(["shot.png"])}
          attachmentsBase={BASE}
        />
      </AttachmentLightboxProvider>,
    );
    const btn = container.querySelector(".md-img-btn")!;
    expect(btn.querySelector("img")!.getAttribute("src")).toBe(`${BASE}/shot.png`);
    fireEvent.click(btn);
    expect(baseElement.querySelector(DIALOG)).toBeTruthy();
  });

  // Ruling 105: a text-typed chip opens the read-only viewer in the same
  // popup — with the content fetched from the serving route and a Download
  // button that forces the save dialog (`?download=1`).
  it("a yml chip opens the read-only text viewer with a Download button", async () => {
    const origFetch = globalThis.fetch;
    // SAFETY: the viewer calls fetch(url) with a single string argument and
    // reads only .ok/.text(); this stub covers exactly that call shape.
    globalThis.fetch = (async () =>
      new Response("aria: snapshot", { status: 200 })) as typeof fetch;
    try {
      const { container, baseElement, findByText } = render(
        <AttachmentLightboxProvider>
          <TimelineItem ev={ev()} attachmentsBase={BASE} />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-chip")!);
      const dialog = baseElement.querySelector(DIALOG)!;
      expect(dialog).toBeTruthy();
      expect(dialog.querySelector("img")).toBeNull();
      await findByText("aria: snapshot");
      const download = dialog.querySelector<HTMLAnchorElement>(
        'a[href$="?download=1"]',
      )!;
      expect(download.getAttribute("href")).toBe(
        `${BASE}/capture.yml?download=1`,
      );
      expect(download.textContent).toContain("Download");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("a fetch failure shows the could-not-load panel, never a blank dialog", async () => {
    const origFetch = globalThis.fetch;
    // SAFETY: same single-argument fetch shape as above — the viewer only
    // reads .ok, which routes this 404 to the failure branch.
    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as typeof fetch;
    try {
      const { container, findByText } = render(
        <AttachmentLightboxProvider>
          <TimelineItem ev={ev()} attachmentsBase={BASE} />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-chip")!);
      await findByText("This attachment could not be loaded.");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("a chip the popup cannot render (zip) keeps its plain-link behavior", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem
          ev={{ ...ev(), attachments: ["bundle.zip"] }}
          attachmentsBase={BASE}
        />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".tl-attach-chip")!);
    expect(baseElement.querySelector(DIALOG)).toBeNull();
  });

  it("the Attachments panel's text-file row opens the same viewer", async () => {
    const origFetch = globalThis.fetch;
    // SAFETY: same single-argument fetch shape as above; .ok/.text() only.
    globalThis.fetch = (async () =>
      new Response("console says hi", { status: 200 })) as typeof fetch;
    try {
      const { container, baseElement, findByText } = render(
        <AttachmentLightboxProvider>
          <AttachmentsPanel base={BASE} attachments={[entry("run.log")]} />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".attach-file")!);
      expect(baseElement.querySelector(DIALOG)).toBeTruthy();
      await findByText("console says hi");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("the Attachments panel's image preview opens the lightbox too", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <AttachmentsPanel base={BASE} attachments={[entry("shot.png")]} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".attach-thumb")!);
    const dialog = baseElement.querySelector(DIALOG)!;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector("img")!.getAttribute("src")).toBe(`${BASE}/shot.png`);
  });
});

/**
 * Broken-tile fix (pass 22): an attachment image can fail to load even for a
 * member — the file was rotated/removed on disk (route 404s), is over the
 * route's 50 MB inline cap (413), or is a type it refuses to render inline.
 * Before this, that painted the browser's broken-image glyph inside the tile.
 * NOTE: this is not a membership fix — the loader ships `[]` to non-members and
 * the serving route shares the task page's `any-member` gate, so no viewer sees
 * a tile it can't fetch. The failure covered here hits members too.
 */
describe("attachment images degrade gracefully when the picture cannot load", () => {
  const DIALOG = 'dialog[data-screen-label="Attachment lightbox"]';
  const withFiles = (attachments: string[]): TimelineEventRender => ({
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

  it("the side-panel thumbnail swaps a failed image for a placeholder and flags it to AT", () => {
    const { container } = render(
      <AttachmentsPanel base={BASE} attachments={[entry("gone.png")]} />,
    );
    fireEvent.error(container.querySelector<HTMLImageElement>(".attach-thumb img")!);
    // The broken <img> is gone; a visible placeholder stands in its slot.
    expect(container.querySelector(".attach-thumb img")).toBeNull();
    const anchor = container.querySelector<HTMLAnchorElement>(".attach-thumb")!;
    expect(anchor.querySelector(".attach-broken")!.textContent).toContain(
      "preview unavailable",
    );
    // The failure reaches a screen reader through the ANCHOR's accessible name
    // (the placeholder's own label is otherwise swallowed by aria-label), so a
    // broken tile no longer announces identically to a working one.
    expect(anchor.getAttribute("aria-label")).toContain("preview unavailable");
    // The tile's link is intact so a member can still retry or download.
    expect(anchor.getAttribute("href")).toBe(`${BASE}/gone.png`);
  });

  it("the timeline producing-message thumbnail does the same, keeping its caption", () => {
    const { container } = render(
      <TimelineItem ev={withFiles(["gone.png"])} attachmentsBase={BASE} />,
    );
    fireEvent.error(container.querySelector<HTMLImageElement>(".tl-attach-thumb img")!);
    const anchor = container.querySelector<HTMLAnchorElement>(".tl-attach-thumb")!;
    expect(anchor.querySelector("img")).toBeNull();
    expect(anchor.querySelector(".attach-broken")).toBeTruthy();
    expect(anchor.getAttribute("aria-label")).toContain("preview unavailable");
    expect(anchor.textContent).toContain("gone.png");
  });

  it("the lightbox shows a message (not a broken image) and keeps Open original", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <AttachmentsPanel base={BASE} attachments={[entry("gone.png")]} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".attach-thumb")!);
    const dialog = baseElement.querySelector(DIALOG)!;
    fireEvent.error(dialog.querySelector<HTMLImageElement>(".lightbox-img")!);
    expect(dialog.querySelector(".lightbox-img")).toBeNull();
    expect(dialog.querySelector(".lightbox-broken")!.textContent).toContain(
      "could not be loaded",
    );
    const original = [...dialog.querySelectorAll("a")].find(
      (a) => a.textContent === "Open original",
    )!;
    expect(original.getAttribute("href")).toBe(`${BASE}/gone.png`);
  });
});
