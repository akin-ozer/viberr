// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub, MemoryRouter } from "react-router";
import type { ReactNode } from "react";
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

/* -------------------------------------------- ruling 314: the long list */

/**
 * Ruling 314 (owner, 2026-09-26): the panel listed every file flat, so a task
 * whose gates ran twice listed fifteen files and pushed its timeline a screen
 * down. A long list now folds the way a long comment does.
 */
describe("AttachmentsPanel folds a long list like a long comment (ruling 314)", () => {
  afterEach(() => vi.restoreAllMocks());

  const files = [
    entry("checkout.png"),
    entry("receipt.png"),
    ...Array.from({ length: 13 }, (_, i) => entry(`gate-${String(i + 1).padStart(2, "0")}.log`, 1024 + i)),
  ];

  /** jsdom lays nothing out, so the list reports `px` as its full height. */
  const listHeight = (px: number) =>
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("attach-list") ? px : 0;
    });

  /** `AttachFile` uses `useFetcher`, so the control needs a data router. */
  const renderPanel = (ui: ReactNode) => {
    const Stub = createRoutesStub([
      { path: "/t", Component: () => <>{ui}</>, action: async () => ({ ok: true }) },
    ]);
    return render(<Stub initialEntries={["/t"]} />);
  };

  it("clamps pictures and files behind Show more, with the heading, its count and the attach control above the fold", () => {
    // CANARY: render the grid and the rows straight into the section, without
    // `Collapsible`, and the list never folds.
    listHeight(660);
    const { container } = renderPanel(<AttachmentsPanel base={BASE} attachments={files} canAttach />);
    const section = container.querySelector("section.panel")!;
    const list = section.querySelector<HTMLElement>(".attach-list")!;
    expect(list.classList.contains("clamped")).toBe(true);
    expect(list.style.maxHeight).toBe("340px");
    // Only the view folds: every picture and every file is still there.
    expect(list.querySelectorAll(".attach-thumb")).toHaveLength(2);
    expect(list.querySelectorAll(".attach-file")).toHaveLength(13);
    // What the panel holds, and the control that adds to it, stay in sight.
    const fold = list.closest(".md-collapse")!;
    expect(fold.parentElement).toBe(section);
    expect(fold.contains(section.querySelector(".panel-head"))).toBe(false);
    expect(fold.contains(section.querySelector(".attach-add"))).toBe(false);
    expect(section.querySelector(".panel-head")!.textContent).toContain("15 files");

    const toggle = fold.querySelector<HTMLButtonElement>(".md-collapse-toggle")!;
    expect(toggle.textContent).toBe("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(list.classList.contains("clamped")).toBe(false);
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves a short list whole, with no toggle", () => {
    listHeight(126);
    const { container } = render(<AttachmentsPanel base={BASE} attachments={files.slice(2, 5)} />);
    expect(container.querySelector(".attach-list")!.classList.contains("clamped")).toBe(false);
    expect(container.querySelector(".md-collapse-toggle")).toBeNull();
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
    evidence: [{ label, result: "", status: "info" }],
  };
}

/**
 * F39-6 (pass 39): the human attach control.
 *
 * The attachments directory had three readers and no human writer, and this
 * panel only rendered at all when a browser-capable agent was deployed — so
 * the one surface that could have told a person they may attach a fixture was
 * the one surface that did not exist for them. Viberr's own controller planned
 * around a human attaching an authoritative file; there was no way to do it.
 */
describe("AttachmentsPanel attach control (F39-6)", () => {
  /** `AttachFile` uses `useFetcher`, so it needs a data router. */
  const renderPanel = (ui: ReactNode) => {
    const Stub = createRoutesStub([
      { path: "/t", Component: () => <>{ui}</>, action: async () => ({ ok: true }) },
    ]);
    return render(<Stub initialEntries={["/t"]} />);
  };

  it("renders the panel and the control for a viewer who may attach, with no browser agent", () => {
    // CANARY: restore `if (!browserExpected) return null` and this renders
    // nothing at all — the empty-panel rule from when agents were the only
    // writers.
    const { container } = renderPanel(
      <AttachmentsPanel base={BASE} attachments={[]} canAttach />,
    );
    expect(container.textContent).toContain("Attachments");
    expect(container.textContent).toContain("Attach a file");
    // It says what the file is FOR, which is the whole reason a human attaches
    // one — not "upload".
    expect(container.textContent).toContain("read by the agents");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    // Ruling 76: the picker offers any kind of file; what may render inline
    // is the serving route's business, not the picker's.
    expect(input!.accept).toBe("");
  });

  // Ruling 286: the upload in flight is `aria-busy` on the control that
  // started it, the loader spinning and the label naming the work.
  // Canary: drop `aria-busy` from the label in attachments-panel.tsx.
  it("ruling 286: an upload in flight reads Attaching…, busy, the loader spinning", async () => {
    const Stub = createRoutesStub([
      {
        path: "/t",
        Component: () => <AttachmentsPanel base={BASE} attachments={[]} canAttach />,
        // Never answers: the test reads the wait itself.
        action: () => new Promise(() => {}),
      },
    ]);
    const { container } = render(<Stub initialEntries={["/t"]} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(["a: 1"], "fixture.yaml", { type: "text/yaml" })] },
    });
    const label = input.closest("label")!;
    await waitFor(() => expect(label.getAttribute("aria-busy")).toBe("true"));
    expect(label.textContent).toBe("Attaching…");
    expect(input.disabled).toBe(true);
    expect(label.querySelector("svg.ico.spin")).not.toBeNull();
  });

  it("offers the control beside an existing list, and never without the grant", () => {
    const withGrant = renderPanel(
      <AttachmentsPanel base={BASE} attachments={[entry("report.pdf")]} canAttach />,
    );
    expect(withGrant.container.textContent).toContain("Attach a file");
    cleanup();
    const without = renderPanel(
      <AttachmentsPanel base={BASE} attachments={[entry("report.pdf")]} />,
    );
    expect(without.container.textContent).toContain("report.pdf");
    expect(without.container.textContent).not.toContain("Attach a file");
    expect(without.container.querySelector('input[type="file"]')).toBeNull();
  });

});

describe("U39-31: TimelineItem links the other tasks an event names", () => {
  it("links them in a comment and in a typed event", () => {
    // CANARY: drop `taskLinks` from TimelineEntryBody's CollapsibleComment and
    // TypedEventBody's Markdown (timeline-entry.tsx) and neither links.
    const links = { "AX-33": "/projects/ax-clone/tasks/AX-33" };
    const comment: TimelineEventRender = { ...evidenceEvent("x"), type: "comment", text: "Fixed by AX-33.", evidence: null };
    const note: TimelineEventRender = { ...evidenceEvent("x"), id: 8, type: "note", text: "Waits on AX-33.", evidence: null };
    for (const ev of [comment, note]) {
      const { container, unmount } = render(
        <MemoryRouter>
          <TimelineItem ev={ev} taskLinks={links} />
        </MemoryRouter>,
      );
      const link = container.querySelector<HTMLAnchorElement>("a.task-ref");
      expect(link?.getAttribute("href"), ev.type).toBe("/projects/ax-clone/tasks/AX-33");
      unmount();
    }
  });
});

describe("TimelineItem evidence linkify", () => {
  it("links a cited filename that names a REAL attachment", () => {
    const { container } = render(
      <TimelineItem
        ev={evidenceEvent("screenshot `board-after.png` shows the fix")}
        attachmentNames={new Set(["board-after.png"])}
        attachmentsBase={BASE}
      />,
    );
    const link = container.querySelector<HTMLAnchorElement>(".ev-item .ev-file")!;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe(`${BASE}/board-after.png`);
    expect(link.textContent).toBe("board-after.png");
    // The surrounding words stay plain text, and the name's backticks are its
    // code face (ruling 313), never printed. CANARY: drop the code-span split
    // in `EvidenceLabel` and the row reads "`board-after.png`".
    const row = container.querySelector(".ev-item")!;
    expect(row.textContent).toContain("shows the fix");
    expect(row.textContent).not.toContain("`");
    expect(link.querySelector("code.mono")).not.toBeNull();
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

  it("ruling 313 (F40-32): every name carries its whole self on hover, and comes before the by-line", () => {
    // WEB-3's rows both read "WEB-3…" at phone width, with no title to read
    // the rest from. CANARY: drop `title={a.name}` from the file row.
    const { container } = render(
      <AttachmentsPanel
        base={BASE}
        attachments={[entry("home-page.png"), entry("WEB-3-build-node24-d0cd55e.log", 2355)]}
        producers={{ ...producers, "WEB-3-build-node24-d0cd55e.log": producers["report.pdf"] }}
      />,
    );
    const row = container.querySelector(".attach-file")!;
    const name = row.querySelector(".attach-name")!;
    expect(name.getAttribute("title")).toBe("WEB-3-build-node24-d0cd55e.log");
    // The phone rule indents whatever follows the name (app.css): the by-line.
    expect(name.nextElementSibling?.classList.contains("attach-by")).toBe(true);
    expect(container.querySelector(".attach-thumb .attach-name")!.getAttribute("title")).toBe("home-page.png");
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

describe("TimelineItem attachments (P21 — the producing message shows its files)", () => {
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

  it("renders an image as a thumbnail and other files as file tiles, linking to the serving route", () => {
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
    const files = container.querySelectorAll<HTMLAnchorElement>(".tl-attach-file");
    expect(files).toHaveLength(1);
    expect(files[0]!.getAttribute("href")).toBe(`${BASE}/capture.yml`);
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

  it("a page capture opens at the page's width in a scroller the keyboard reaches", () => {
    // Ruling 86: Viberr's picture of a delivered page is the whole page, up
    // to six screens tall; fitted to the popup's height it cannot be read.
    // CANARY: render a capture through the plain image branch and there is no
    // region to focus, so a keyboard cannot scroll the page.
    const capture: TimelineEventRender = {
      ...ev("Viberr rendered `post.html` as a reader sees it."),
      attachments: ["post.html.capture-phone.png", "shot.png", "post.html.capture-desktop.png"],
    };
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem ev={capture} attachmentsBase={BASE} />
      </AttachmentLightboxProvider>,
    );
    const [captureTile, plainTile, desktopTile] = container.querySelectorAll(".tl-attach-thumb");
    fireEvent.click(captureTile!);
    const scroller = within(baseElement.querySelector<HTMLElement>(DIALOG)!).getByRole("region", {
      name: "Picture of post.html",
    });
    expect(scroller.className).toBe("lightbox-shot");
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.querySelector("img.lightbox-img")!.getAttribute("src")).toBe(
      `${BASE}/post.html.capture-phone.png`,
    );
    // Any other picture is fitted to the popup, as before.
    fireEvent.click(baseElement.querySelector(`${DIALOG} button[aria-label="Close"]`)!);
    fireEvent.click(plainTile!);
    const dialog = baseElement.querySelector<HTMLElement>(DIALOG)!;
    expect(dialog.querySelector("img.lightbox-img")!.getAttribute("src")).toBe(`${BASE}/shot.png`);
    expect(within(dialog).queryByRole("region")).toBeNull();
    expect(dialog.classList.contains("page")).toBe(false);
    // The desktop picture's card takes the page's width; left to its content,
    // the card is never wider than half the window.
    fireEvent.click(baseElement.querySelector(`${DIALOG} button[aria-label="Close"]`)!);
    fireEvent.click(desktopTile!);
    const wide = baseElement.querySelector<HTMLElement>(DIALOG)!;
    expect(within(wide).getByRole("region", { name: "Picture of post.html" })).toBeTruthy();
    expect(wide.classList.contains("page")).toBe(true);
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

  it("the Close control is on the shared close design (ruling 287)", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem ev={ev()} attachmentsBase={BASE} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".tl-attach-thumb")!);
    const close = baseElement.querySelector(
      `${DIALOG} .lightbox-foot button[aria-label="Close"]`,
    )!;
    // The borderless circle every modal head and the page overlay carry, not
    // the bordered `.icon-btn` square this popup used to show.
    expect(close.className).toContain("modal-close");
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

  // Ruling 317: a text-typed chip opens the read-only viewer in the same
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
      fireEvent.click(container.querySelector(".tl-attach-file")!);
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
      // The download attribute keeps a failed response (404, auth redirect)
      // from replacing the task page with an error body.
      expect(download.getAttribute("download")).toBe("capture.yml");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("a redirected response (expired session) shows the failure panel, not the login page's HTML", async () => {
    const origFetch = globalThis.fetch;
    const redirectedStub: Pick<Response, "ok" | "redirected" | "body" | "text"> = {
      ok: true,
      redirected: true,
      body: null,
      text: async () => "<html>Sign in</html>",
    };
    // SAFETY: the viewer reads only ok/redirected/body/text off the response;
    // the stub covers exactly that surface (`redirected` is read-only on a
    // constructed Response, so a real instance cannot model this case).
    globalThis.fetch = (async () => redirectedStub as Response) as typeof fetch;
    try {
      const { container, findByText } = render(
        <AttachmentLightboxProvider>
          <TimelineItem ev={ev()} attachmentsBase={BASE} />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-file")!);
      await findByText(
        "Unable to load this file. It may have been removed, or your session may have ended. Reload the page and try again.",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("a zero-byte file says it is empty instead of showing a blank dialog", async () => {
    const origFetch = globalThis.fetch;
    // SAFETY: same single-argument fetch shape as above; .ok/.text() only.
    globalThis.fetch = (async () =>
      new Response("", { status: 200 })) as typeof fetch;
    try {
      const { container, findByText } = render(
        <AttachmentLightboxProvider>
          <TimelineItem ev={ev()} attachmentsBase={BASE} />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-file")!);
      await findByText("This file is empty.");
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
      const { container, baseElement, findByText } = render(
        <AttachmentLightboxProvider>
          <TimelineItem ev={ev()} attachmentsBase={BASE} />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-file")!);
      await findByText(
        "Unable to load this file. It may have been removed, or your session may have ended. Reload the page and try again.",
      );
      // The proven failure also drops the Download button — downloading the
      // 404 would hand some browsers the error body as "capture.yml".
      expect(
        baseElement.querySelector(`${DIALOG} a[href$="?download=1"]`),
      ).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Ruling 317 addendum: a kind the popup cannot render still opens the card,
  // showing a no-preview note in place of content — the point is the uniform
  // Download button, not the preview.
  it("a chip the popup cannot render (zip) opens the no-preview card with Download", async () => {
    const origFetch = globalThis.fetch;
    // SAFETY: the no-preview card probes fetch(url) once and reads only
    // .ok/.redirected/.body; this stub covers exactly that call shape.
    globalThis.fetch = (async () =>
      new Response("PK", { status: 200 })) as typeof fetch;
    try {
      const { container, baseElement, findByText } = render(
        <AttachmentLightboxProvider>
          <TimelineItem
            ev={{ ...ev(), attachments: ["bundle.zip"] }}
            attachmentsBase={BASE}
          />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-file")!);
      const dialog = baseElement.querySelector(DIALOG)!;
      expect(dialog).toBeTruthy();
      expect(dialog.querySelector("img")).toBeNull();
      await findByText(/no in-app preview/);
      const download = dialog.querySelector<HTMLAnchorElement>(
        'a[href$="?download=1"]',
      )!;
      expect(download.getAttribute("href")).toBe(
        `${BASE}/bundle.zip?download=1`,
      );
      expect(download.getAttribute("download")).toBe("bundle.zip");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // With the factory's kind gate gone, the markdown `a` renderer is the one
  // surface that can receive an AUTHOR-WRITTEN URL — a query, fragment,
  // nested path, or malformed escape under the attachments base would derive
  // a wrong attachment name, so only a clean single-segment suffix opens the
  // card and everything else keeps the plain anchor.
  it("a route URL with a query in a markdown link keeps the plain anchor", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem
          ev={ev(`See [the raw file](${BASE}/shot.png?x=1)`)}
          attachmentNames={new Set(["shot.png"])}
          attachmentsBase={BASE}
        />
      </AttachmentLightboxProvider>,
    );
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "the raw file",
    )!;
    fireEvent.click(link);
    expect(baseElement.querySelector(DIALOG)).toBeNull();
  });

  // The no-preview card is the one body that never renders the file, so it
  // probes the URL — a proven-unservable response (404 after the ruling-78
  // prune, 413 over the cap, auth redirect) swaps the note for the failure
  // message and drops Download (some browsers save a failed download's error
  // body as a file bearing the attachment's real name).
  it("a gone file's no-preview card reports the failure and hides Download", async () => {
    const origFetch = globalThis.fetch;
    // SAFETY: same probe shape as above — .ok routes this 404 to the failure
    // branch.
    globalThis.fetch = (async () =>
      new Response("Not found", { status: 404 })) as typeof fetch;
    try {
      const { container, baseElement, findByText } = render(
        <AttachmentLightboxProvider>
          <TimelineItem
            ev={{ ...ev(), attachments: ["bundle.zip"] }}
            attachmentsBase={BASE}
          />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-file")!);
      await findByText(
        "Unable to load this file. It may have been removed, or your session may have ended. Reload the page and try again.",
      );
      const dialog = baseElement.querySelector(DIALOG)!;
      expect(dialog.querySelector('a[href$="?download=1"]')).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Ruling 317 addendum: the Download button is on EVERY kind's card — before
  // it, an image opened with only "Open original" and saving took a
  // right-click on the raw tab.
  it("the image lightbox carries the same Download button", () => {
    const { container, baseElement } = render(
      <AttachmentLightboxProvider>
        <TimelineItem ev={ev()} attachmentsBase={BASE} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(container.querySelector(".tl-attach-thumb")!);
    const dialog = baseElement.querySelector(DIALOG)!;
    const download = dialog.querySelector<HTMLAnchorElement>(
      'a[href$="?download=1"]',
    )!;
    expect(download.getAttribute("href")).toBe(`${BASE}/shot.png?download=1`);
    expect(download.getAttribute("download")).toBe("shot.png");
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
    // writ-5: onError cannot name the cause, but Download (kept for bytes the
    // browser cannot decode) and Open original are the way to the file.
    expect(dialog.querySelector(".lightbox-broken")!.textContent).toBe(
      "Unable to show this image. Use Download or Open original to get the file itself.",
    );
    expect(dialog.querySelector('a[href$="?download=1"]')).not.toBeNull();
    const original = [...dialog.querySelectorAll("a")].find(
      (a) => a.textContent === "Open original",
    )!;
    expect(original.getAttribute("href")).toBe(`${BASE}/gone.png`);
  });
});

/*
 * Ruling 317: the reader is a code reader. A file whose name is not an image
 * or a known binary kind opens in it — highlighted by the name's grammar,
 * numbered — and only the bytes (a NUL in the head) can send it to the
 * no-preview card instead. The serving route is untouched: these fetches are
 * downloads on the wire, text in the popup, never rendered.
 */
describe("attachment code reader (ruling 317)", () => {
  const DIALOG = 'dialog[data-screen-label="Attachment lightbox"]';
  const NUL = String.fromCharCode(0);
  const ev = (attachments: string[]): TimelineEventRender => ({
    id: 11,
    type: "comment",
    occurredAt: "2026-09-20T10:00:00.000Z",
    actor: { kind: "agent", backend: "claude", name: "Developer", role: "delivery" },
    title: null,
    text: "Posted the proof script.",
    toAgent: false,
    evidence: null,
    attachments,
  });
  async function withBody(body: string, run: () => Promise<void>) {
    const origFetch = globalThis.fetch;
    // SAFETY: the reader calls fetch(url) with a single string argument and
    // reads .ok/.redirected/.body; this stub covers exactly that call shape.
    globalThis.fetch = (async () =>
      new Response(body, { status: 200 })) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = origFetch;
    }
  }
  function openChip(name: string) {
    const rendered = render(
      <AttachmentLightboxProvider>
        <TimelineItem ev={ev([name])} attachmentsBase={BASE} />
      </AttachmentLightboxProvider>,
    );
    fireEvent.click(rendered.container.querySelector(".tl-attach-file")!);
    const dialog = rendered.baseElement.querySelector(DIALOG)!;
    expect(dialog).toBeTruthy();
    return { ...rendered, dialog };
  }
  const readerIn = (dialog: Element) =>
    waitFor(() => {
      const found = dialog.querySelector("pre.code-view");
      expect(found).toBeTruthy();
      return found!;
    });

  it("a .mjs chip opens the code reader: highlighted, numbered, with Download", async () => {
    await withBody("const answer = 42; // why\nexport { answer };\n", async () => {
      const { dialog } = openChip("shop-65-journey-script.mjs");
      const pre = await readerIn(dialog);
      expect(pre.getAttribute("data-language")).toBe("javascript");
      expect(pre.querySelectorAll(".line")).toHaveLength(2);
      expect(pre.querySelector(".line")!.textContent).toBe("const answer = 42; // why");
      expect(dialog.textContent).not.toMatch(/no in-app preview/);
      await waitFor(() =>
        expect(pre.querySelector(".tk-keyword")?.textContent).toBe("const"),
      );
      expect(pre.querySelector(".tk-comment")!.textContent).toBe("// why");
      const download = dialog.querySelector<HTMLAnchorElement>('a[href$="?download=1"]')!;
      expect(download.getAttribute("href")).toBe(
        `${BASE}/shop-65-journey-script.mjs?download=1`,
      );
      expect(download.getAttribute("download")).toBe("shop-65-journey-script.mjs");
    });
  });

  it("an unknown extension whose bytes carry a NUL opens the no-preview card — the bytes have the last word", async () => {
    await withBody(NUL + String.fromCharCode(1, 2) + " not text " + NUL, async () => {
      const { dialog, findByText } = openChip("blob.dat");
      await findByText(/not text, so it has no in-app preview/);
      expect(dialog.querySelector("pre")).toBeNull();
      // Servable, just unreadable: Download stays.
      const download = dialog.querySelector<HTMLAnchorElement>('a[href$="?download=1"]')!;
      expect(download.getAttribute("download")).toBe("blob.dat");
    });
  });

  it("an unknown extension that IS text opens plain in the reader, numbered", async () => {
    await withBody("first\nsecond\nthird", async () => {
      const { dialog } = openChip("notes.unknownext");
      const pre = await readerIn(dialog);
      expect(pre.getAttribute("data-language")).toBe("text");
      expect(pre.querySelectorAll(".line")).toHaveLength(3);
      expect(pre.getAttribute("data-digits")).toBe("1");
    });
  });

  it("ruling 317: a .md chip opens rendered, and Raw is the code reader", async () => {
    await withBody("# Findings\n\nAll **green**.\n", async () => {
      const { dialog, findByRole, getByRole } = openChip("report.md");
      // CANARY: send markdown straight to CodeView and nothing here renders.
      const preview = await findByRole("region", { name: "Preview of report.md" });
      expect(within(preview).getByRole("heading", { level: 3, name: "Findings" })).toBeTruthy();
      expect(within(preview).getByText("green").tagName).toBe("STRONG");
      expect(dialog.querySelector("pre.code-view")).toBeNull();

      fireEvent.click(getByRole("button", { name: "Raw" }));
      const pre = await readerIn(dialog);
      expect(pre.getAttribute("data-language")).toBe("markdown");
      expect([...pre.querySelectorAll(".line")].map((l) => l.textContent)).toEqual([
        "# Findings",
        "",
        "All **green**.",
      ]);
      // Either way the card keeps its Download.
      expect(dialog.querySelector('a[href$="?download=1"]')).toBeTruthy();
    });
  });

  it("ruling 317: a rendered picture of the task's own file loads from its serving route", async () => {
    await withBody("![the page](shot.png)\n", async () => {
      const { container, findByRole } = render(
        <AttachmentLightboxProvider attachmentNames={["report.md", "shot.png"]} attachmentsBase={BASE}>
          <TimelineItem ev={ev(["report.md"])} attachmentsBase={BASE} />
        </AttachmentLightboxProvider>,
      );
      fireEvent.click(container.querySelector(".tl-attach-file")!);
      // CANARY: drop the provider's names on the way to the reader, and the
      // picture asks the task page's own URL for `shot.png`.
      const preview = await findByRole("region", { name: "Preview of report.md" });
      expect(within(preview).getByRole("img", { name: "the page" }).getAttribute("src")).toBe(
        `${BASE}/shot.png`,
      );
    });
  });

  it("an svg opens as SOURCE in the reader — never as a rendered image", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    await withBody(source, async () => {
      const { dialog } = openChip("diagram.svg");
      const pre = await readerIn(dialog);
      expect(pre.textContent).toBe(source);
      expect(pre.getAttribute("data-language")).toBe("xml");
      expect(dialog.querySelector("img")).toBeNull();
      expect(pre.querySelector("svg, script")).toBeNull();
    });
  });
});
