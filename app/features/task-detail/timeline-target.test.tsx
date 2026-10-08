// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub, Link, useLoaderData, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { timelineEventAnchor } from "~/shared/page-anchors";
import { ToastProvider } from "~/ui/toast";
import { Timeline, type TimelineFilterId } from "./timeline";
import { timelineSlice } from "./timeline-slice";

/**
 * Ruling 497: a notification about an event opens it on the task page. The
 * link names the event by its time (`#event-<occurredAt>`); the timeline
 * marks it, brings it into view and focuses it, opens the filter tab that hid
 * it, and loads older events until it is among them. Ruling 523: the person's
 * next press or key ends the mark and takes the hash out of the URL.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MENTIONABLES: Mentionables = { agents: [], users: [], reserved: [] };

/** Newest first, one a minute: event 0 is the newest. */
function events(count: number): TimelineEventRender[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    type: i % 2 === 0 ? "comment" : "quality",
    occurredAt: new Date(Date.UTC(2026, 8, 26, 9, 0) - i * 60_000).toISOString(),
    actor: { kind: "agent", backend: "claude", name: "Reviewer", role: "Reviewer" },
    title: null,
    text: `Event ${i}`,
    toAgent: false,
    evidence: null,
    attachments: null,
  }));
}

const ALL = events(12);
const anchorOf = (i: number) => timelineEventAnchor(ALL[i]!.occurredAt);

/** The task page's timeline over a loader that serves `?events`, as the route
 *  does, with a link to where the page already is. */
function renderAt(entry: string, tlDefault: TimelineFilterId = "all", initial = 4) {
  function Page() {
    const slice = useLoaderData<typeof loader>();
    const location = useLocation();
    return (
      <ToastProvider>
        <span data-testid="url">{location.search + location.hash}</span>
        <Link to={`/t#${anchorOf(1)}`}>again</Link>
        <Timeline
          events={slice.events}
          hasMore={slice.hasMore}
          remaining={slice.remaining}
          nextLimit={slice.nextLimit}
          tlDefault={tlDefault}
          ask={0}
          mentionables={MENTIONABLES}
        />
      </ToastProvider>
    );
  }
  function loader({ request }: { request: Request }) {
    const raw = Number(new URL(request.url).searchParams.get("events"));
    return timelineSlice(ALL, ALL.length, Number.isInteger(raw) && raw > 0 ? raw : initial);
  }
  const Stub = createRoutesStub([{ path: "/t", Component: Page, loader }]);
  return render(<Stub initialEntries={[entry]} />);
}

const targeted = (container: HTMLElement) =>
  [...container.querySelectorAll(".tl-item[data-targeted]")].map((el) => el.id);

describe("a link to a timeline event (ruling 497)", () => {
  it("marks the event, focuses it, and anchors only the first of a shared time", async () => {
    const { container } = renderAt(`/t#${anchorOf(1)}`);
    await waitFor(() => expect(targeted(container)).toEqual([anchorOf(1)]));
    // The mark is drawn by the render, the focus by the effect after it.
    await waitFor(() => expect(document.activeElement?.id).toBe(anchorOf(1)));
    // Every rendered event carries its anchor; nothing else is marked.
    expect([...container.querySelectorAll(".tl-item")].map((el) => el.id)).toEqual(
      [0, 1, 2, 3].map(anchorOf),
    );
  });

  it.each(["typed", "all"] as const)(
    "opens All when the default tab hides the event, once, and then leaves the tabs to the person (default %s)",
    async (tlDefault) => {
      // Event 2 is a comment; "Important events" shows typed events only.
      const { container, getByRole } = renderAt(`/t#${anchorOf(2)}`, tlDefault);
      await waitFor(() => expect(targeted(container)).toEqual([anchorOf(2)]));
      expect(getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
      // A click with no press before it (a screen reader's, voice control's)
      // leaves the hash in the URL. CANARY: key the step on the target alone,
      // or spend it only when it changes the tab, and this click is undone.
      fireEvent.click(getByRole("button", { name: "Important events" }));
      expect(getByRole("button", { name: "Important events" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(targeted(container)).toEqual([]);
    },
  );

  it("loads older events until the named one is among them, keeping the link", async () => {
    // Event 9 is past the first window (4) and the next (4 + 30 covers it).
    const { container, getByTestId } = renderAt(`/t#${anchorOf(9)}`);
    await waitFor(() => expect(targeted(container)).toEqual([anchorOf(9)]));
    // CANARY: step with `setSearchParams` and the hash is dropped on the way.
    expect(getByTestId("url").textContent).toBe(`?events=12#${anchorOf(9)}`);
  });

  it("stops when the loaded events reach past the named time without it", async () => {
    // A time between event 1 and event 2 that no event carries: the window
    // already holds older events, so it loads nothing more.
    const between = new Date(Date.parse(ALL[1]!.occurredAt) - 30_000).toISOString();
    const { container, getByTestId } = renderAt(`/t#${timelineEventAnchor(between)}`);
    await waitFor(() => expect(container.querySelectorAll(".tl-item")).toHaveLength(4));
    expect(targeted(container)).toEqual([]);
    expect(getByTestId("url").textContent).toBe(`#${timelineEventAnchor(between)}`);
  });

  it("brings it back into view when the same link is followed again from the page", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const { container, getByText } = renderAt(`/t#${anchorOf(1)}`);
    await waitFor(() => expect(targeted(container)).toEqual([anchorOf(1)]));
    const reveals = () =>
      focus.mock.contexts.filter((el) => el instanceof HTMLElement && el.id === anchorOf(1)).length;
    await waitFor(() => expect(reveals()).toBe(1));
    // The bell's row names the place already on screen: a new location, the
    // same hash. CANARY: key the reveal on the id alone and nothing moves.
    await act(async () => {
      fireEvent.click(getByText("again"));
    });
    await waitFor(() => expect(reveals()).toBe(2));
  });
});

describe("the next press ends the mark (ruling 523)", () => {
  it("a press anywhere drops the hash and the mark, keeps the loaded events and the focus, and a new link marks again", async () => {
    const { container, getByTestId, getByText } = renderAt(`/t#${anchorOf(9)}`);
    await waitFor(() => expect(targeted(container)).toEqual([anchorOf(9)]));
    await waitFor(() => expect(document.activeElement?.id).toBe(anchorOf(9)));
    const event = document.activeElement!;

    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    // CANARY: listen on the marked entry alone and a press beside it keeps
    // the mark (and a reload would bring it back).
    await waitFor(() => expect(getByTestId("url").textContent).toBe("?events=12"));
    expect(targeted(container)).toEqual([]);
    // CANARY: drop `focusable` and the tabindex leaves with the mark; a browser
    // then drops the focus to the body and the keys stop scrolling `.detail`.
    expect(event.getAttribute("tabindex")).toBe("-1");

    // The bell's row again: the press on it ends nothing (the mark is gone),
    // and the link it follows marks the event once more.
    await act(async () => {
      fireEvent.pointerDown(getByText("again"));
      fireEvent.click(getByText("again"));
    });
    await waitFor(() => expect(targeted(container)).toEqual([anchorOf(1)]));
    expect(getByTestId("url").textContent).toBe(`#${anchorOf(1)}`);
  });

  it("a key ends it too, but not a lone modifier or a key held down from before", async () => {
    const { container, getByTestId } = renderAt(`/t#${anchorOf(1)}`);
    await waitFor(() => expect(targeted(container)).toEqual([anchorOf(1)]));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Meta", metaKey: true });
      fireEvent.keyDown(document.activeElement!, { key: "Enter", repeat: true });
    });
    expect(targeted(container)).toEqual([anchorOf(1)]);
    expect(getByTestId("url").textContent).toBe(`#${anchorOf(1)}`);

    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    });
    // CANARY: listen for pointers alone and the keyboard cannot end it.
    await waitFor(() => expect(getByTestId("url").textContent).toBe(""));
    expect(targeted(container)).toEqual([]);
  });
});
