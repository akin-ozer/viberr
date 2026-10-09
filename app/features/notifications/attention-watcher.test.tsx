// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { MemoryStorage } from "../../../test-support/memory-storage";
import { AttentionWatcher } from "./attention-watcher";
import type { AttentionItem, AttentionSnapshot } from "./desktop-alerts";

/**
 * Ruling 74 (F40-51): a decision only the owner can take reached him only
 * if a Viberr tab was in front of him. The watcher puts the count of unread
 * decisions in the tab's title, and (opted in) shows a desktop notification
 * for a new one while no Viberr tab has the person's attention.
 *
 * Driven through a real data router (the click marks the row read through
 * `/notifications/read` and navigates), with `/resources/attention` answered
 * by a stubbed `fetch`, a fake `Notification`, and the tab's visibility and
 * focus set per test.
 */

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  static async requestPermission(): Promise<NotificationPermission> {
    return FakeNotification.permission;
  }
  readonly title: string;
  readonly options: NotificationOptions | undefined;
  onclick: (() => void) | null = null;
  closed = false;
  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

let snapshot: AttentionSnapshot = { waiting: 0, items: [] };
let reads = 0;
let marked: string[] = [];
let storage = new MemoryStorage();
let visibility: DocumentVisibilityState = "visible";
let focused = true;

function item(id: string, key: string): AttentionItem {
  return {
    id,
    title: `Platform Engineer asks: question ${id}`,
    body: `${key} · akinozer.com\nOnly the owner can answer.`,
    href: `/projects/akinozer-com/tasks/${key}`,
  };
}

function renderWatcher() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <>
            <AttentionWatcher />
            <Outlet />
          </>
        ),
        children: [
          { index: true, element: <p>Board</p> },
          { path: "projects/:slug/tasks/:key", element: <p>Task page</p> },
          {
            path: "notifications/read",
            action: async ({ request }) => {
              const form = await request.formData();
              marked.push(...form.getAll("id").map(String));
              return { ok: true };
            },
          },
        ],
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Ruling 74: a tab without the person's attention reads every 60 s.
 *  CANARY: read on any other interval and a hidden tab below reads twice in
 *  one poll, or not at all. */
const POLL_MS = 60_000;

/** One poll: the watcher's timer fires and its read lands. */
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
}

beforeEach(() => {
  // Advancing with real time too, so testing-library's `waitFor` keeps polling.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  snapshot = { waiting: 0, items: [] };
  reads = 0;
  marked = [];
  storage = new MemoryStorage();
  storage.setItem("viberr.desktop-notifications", "on");
  FakeNotification.permission = "granted";
  FakeNotification.instances = [];
  visibility = "visible";
  focused = true;
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("fetch", async (url: string) => {
    expect(url).toBe("/resources/attention");
    reads += 1;
    return Response.json(snapshot);
  });
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  // jsdom does not implement it; a notification click calls it.
  vi.spyOn(window, "focus").mockImplementation(() => {});
  document.title = "Board · akinozer.com · Viberr";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AttentionWatcher (ruling 74)", () => {
  /**
   * Canary: return early from `useCountedTitle` (or drop the observer) and
   * the title never carries the count, or loses it when the page retitles.
   */
  it("counts the unread decisions in the tab's title, through the page's own retitling", async () => {
    snapshot = { waiting: 2, items: [item("a", "WEB-3"), item("b", "WEB-2")] };
    renderWatcher();
    await waitFor(() => expect(document.title).toBe("(2) Board · akinozer.com · Viberr"));

    // The page retitles itself (React Router's <Meta> on a navigation).
    document.querySelector("title")!.textContent = "WEB-3 · Connect Workers Builds · Viberr";
    await waitFor(() =>
      expect(document.title).toBe("(2) WEB-3 · Connect Workers Builds · Viberr"),
    );

    // The person answers both: the count leaves the title.
    snapshot = { waiting: 0, items: [] };
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(document.title).toBe("WEB-3 · Connect Workers Builds · Viberr"));
  });

  /**
   * Canary: announce without the `attended()` check, or without
   * `takeUnhandled`, and a row is announced twice or while the person is
   * looking.
   */
  it("a hidden tab polls, announces a NEW decision once, and a click marks it read and opens it", async () => {
    snapshot = { waiting: 1, items: [item("a", "WEB-4")] };
    visibility = "hidden";
    focused = false;
    const router = renderWatcher();
    // The first reading only primes: WEB-4 was waiting when the tab opened.
    await waitFor(() => expect(reads).toBe(1));
    expect(FakeNotification.instances).toEqual([]);

    snapshot = { waiting: 2, items: [item("b", "WEB-3"), item("a", "WEB-4")] };
    await poll();
    expect(reads).toBe(2);
    expect(FakeNotification.instances.map((n) => n.title)).toEqual([
      "Platform Engineer asks: question b",
    ]);
    const shown = FakeNotification.instances[0]!;
    expect(shown.options).toMatchObject({
      body: "WEB-3 · akinozer.com\nOnly the owner can answer.",
      tag: "b",
    });
    expect(document.title).toBe("(2) Board · akinozer.com · Viberr");

    // The next poll finds nothing new: nothing is announced twice.
    await poll();
    expect(reads).toBe(3);
    expect(FakeNotification.instances).toHaveLength(1);

    // The click does what the bell's row does: mark it read, then open it.
    await act(async () => {
      shown.onclick?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/akinozer-com/tasks/WEB-3"));
    await waitFor(() => expect(marked).toEqual(["b"]));
    expect(shown.closed).toBe(true);
  });

  it("an attended tab counts but announces nothing, and no other tab announces what it saw", async () => {
    renderWatcher();
    await waitFor(() => expect(reads).toBe(1));
    // Visible and focused: no poll is scheduled at all.
    await poll();
    expect(reads).toBe(1);

    // A decision arrives while the person is looking (the focus read).
    snapshot = { waiting: 1, items: [item("c", "WEB-5")] };
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(reads).toBe(2));
    expect(FakeNotification.instances).toEqual([]);

    // They leave; the hidden tab's poll does not announce what they saw.
    visibility = "hidden";
    focused = false;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await poll();
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(FakeNotification.instances).toEqual([]);
    expect(JSON.parse(storage.getItem("viberr.attention.handled") ?? "[]")).toContain("c");
  });

  it("without the opt-in the title still counts, and nothing is announced", async () => {
    storage.removeItem("viberr.desktop-notifications");
    visibility = "hidden";
    focused = false;
    renderWatcher();
    await waitFor(() => expect(reads).toBe(1));
    snapshot = { waiting: 1, items: [item("d", "WEB-6")] };
    await poll();
    expect(document.title).toBe("(1) Board · akinozer.com · Viberr");
    expect(FakeNotification.instances).toEqual([]);
  });
});
