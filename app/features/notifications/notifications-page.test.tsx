// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  needsYouTime,
  NotificationsPage,
  splitNotifications,
  type NotificationPageItem,
} from "./notifications-page";

afterEach(cleanup);

function iso(daysAgo: number, h: number, m: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const ITEMS: NotificationPageItem[] = [
  {
    id: "n-160-packet",
    kind: "packet",
    ptype: "blocked",
    title: "Blocked decision — pick a recovery path",
    text: "Provider history unavailable. The specialist continues from `task.md` once you choose.",
    projectSlug: "viberr-core",
    projectName: "Viberr Core",
    taskKey: "VIB-160",
    occurredAt: iso(0, 10, 31),
    unread: true,
    from: { name: "Operator" },
  },
  {
    id: "n-dep-31",
    kind: "packet",
    ptype: "input",
    title: "Completion report — staging promotion ready",
    text: "Promotion to staging needs your acceptance.",
    projectSlug: "deploy-pipeline",
    projectName: "Deploy Pipeline",
    taskKey: "DEP-31",
    occurredAt: iso(0, 10, 12),
    unread: true,
    from: { name: "Operator" },
  },
  {
    id: "n-145-approval",
    kind: "approval",
    ptype: null,
    title: "Transition request — In Progress → Review",
    text: "This boundary needs a maintainer approval.",
    projectSlug: "viberr-core",
    projectName: "Viberr Core",
    taskKey: "VIB-145",
    occurredAt: iso(0, 9, 12),
    unread: false,
    from: { name: "Operator" },
  },
  {
    id: "n-148-mention",
    kind: "mention",
    ptype: null,
    title: null,
    text: 'mentioned you — "**@arda** can you take it?"',
    projectSlug: "viberr-core",
    projectName: "Viberr Core",
    taskKey: "VIB-148",
    occurredAt: iso(0, 8, 20),
    unread: true,
    from: { name: "Elif Demir" },
  },
  {
    id: "n-145-blockedact",
    kind: "policy",
    ptype: null,
    title: null,
    text: "Blocked agent action: Developer (Codex) attempted **Merge a pull request** — reserved for humans.",
    projectSlug: "viberr-core",
    projectName: "Viberr Core",
    taskKey: "VIB-145",
    occurredAt: iso(1, 16, 4),
    unread: false,
    from: { name: "Policy engine" },
  },
];

function renderPage(
  items: NotificationPageItem[] = ITEMS,
  unread = items.filter((n) => n.unread).length,
) {
  const onRead = vi.fn();
  const onReadAll = vi.fn();
  const onOpen = vi.fn();
  const utils = render(
    <NotificationsPage
      items={items}
      unread={unread}
      onRead={onRead}
      onReadAll={onReadAll}
      onOpen={onOpen}
    />,
  );
  return { ...utils, onRead, onReadAll, onOpen };
}

describe("splitNotifications", () => {
  it("routes packets+approvals to needs-you, the rest to the stream", () => {
    const { needs, rest } = splitNotifications(ITEMS, "all");
    expect(needs.map((n) => n.id)).toEqual([
      "n-160-packet",
      "n-dep-31",
      "n-145-approval",
    ]);
    expect(rest.map((n) => n.id)).toEqual([
      "n-148-mention",
      "n-145-blockedact",
    ]);
  });

  it("the Unread filter applies to both panels", () => {
    const { needs, rest } = splitNotifications(ITEMS, "unread");
    expect(needs.map((n) => n.id)).toEqual(["n-160-packet", "n-dep-31"]);
    expect(rest.map((n) => n.id)).toEqual(["n-148-mention"]);
  });
});

describe("needsYouTime", () => {
  it("today renders the bare clock, other days a lowercased day + time", () => {
    expect(needsYouTime(iso(0, 10, 31))).toBe("10:31");
    expect(needsYouTime(iso(1, 16, 4))).toBe("yesterday 16:04");
  });
});

describe("NotificationsPage", () => {
  it("renders header, unread subtitle, filter and Mark all read", () => {
    const { getByText } = renderPage();
    expect(getByText("Notifications")).toBeTruthy();
    expect(
      getByText("Everything routed to you, across all projects · 3 unread"),
    ).toBeTruthy();
    expect(getByText("Mark all read")).toBeTruthy();
  });

  it("all-caught-up subtitle hides the Mark all read button", () => {
    const read = ITEMS.map((n) => ({ ...n, unread: false }));
    const { getByText, queryByText } = renderPage(read, 0);
    expect(
      getByText("Everything routed to you, across all projects · all caught up"),
    ).toBeTruthy();
    expect(queryByText("Mark all read")).toBeNull();
  });

  it("needs-you cards: type pills, project pill, unread dot, times", () => {
    const { container, getByText } = renderPage();
    const rows = container.querySelectorAll(".rq-row");
    expect(rows).toHaveLength(3);
    expect(getByText("3 decisions")).toBeTruthy();

    // Type pills per kind/ptype.
    expect(rows[0]!.querySelector(".pill.blocked")!.textContent).toBe(
      "blocked decision",
    );
    expect(rows[1]!.querySelector(".pill.input")!.textContent).toBe(
      "completion report",
    );
    expect(rows[2]!.querySelector(".pill.info")!.textContent).toBe("approval");

    // Global page: the project pill renders for every row (open Q C).
    expect(rows[0]!.querySelector(".pill.neutral")!.textContent).toBe(
      "Viberr Core",
    );
    expect(rows[1]!.querySelector(".pill.neutral")!.textContent).toBe(
      "Deploy Pipeline",
    );

    // Unread dot on the title (inline variant), none on the read approval.
    expect(rows[0]!.querySelector(".unread-dot.in")).toBeTruthy();
    expect(rows[2]!.querySelector(".unread-dot.in")).toBeNull();

    // Mono task key in the subline; rich text rendered (backticks → code).
    expect(rows[0]!.querySelector(".sub .mono")!.textContent).toBe("VIB-160");
    expect(rows[0]!.querySelector(".sub code.mono")!.textContent).toBe(
      "task.md",
    );
  });

  it("needs-you card click marks read then navigates", () => {
    const { container, onRead, onOpen } = renderPage();
    fireEvent.click(container.querySelectorAll(".rq-row")[0]!);
    expect(onRead).toHaveBeenCalledWith("n-160-packet");
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n-160-packet" }),
    );
  });

  it("stream rows: day groups, actor line, keybtn navigation, unread treatment", () => {
    const { container, onRead, onOpen } = renderPage();
    const days = [...container.querySelectorAll(".act-day")].map(
      (d) => d.textContent,
    );
    expect(days).toEqual(["Today", "Yesterday"]);

    const rows = container.querySelectorAll(".ntf-ev");
    expect(rows).toHaveLength(2);
    const mention = rows[0]!;
    expect(mention.classList.contains("unread")).toBe(true);
    expect(mention.getAttribute("title")).toBe("Click to mark read");
    expect(mention.querySelector(".act-actor")!.textContent).toBe("Elif Demir");
    expect(mention.querySelector(".mention")).toBeNull(); // RichA mode: no mention spans
    expect(mention.querySelector(".keybtn")!.textContent).toBe(
      "Viberr Core · VIB-148",
    );

    // Row click only marks read; keybtn marks read AND navigates.
    fireEvent.click(mention);
    expect(onRead).toHaveBeenCalledWith("n-148-mention");
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(mention.querySelector(".keybtn")!);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: "n-148-mention" }),
    );

    const read = rows[1]!;
    expect(read.classList.contains("unread")).toBe(false);
    expect(read.querySelector(".unread-dot")).toBeNull();
  });

  it("Unread filter empties both panels with the exact copy", () => {
    const read = ITEMS.map((n) => ({ ...n, unread: false }));
    const { getByText } = renderPage(read, 0);
    fireEvent.click(getByText("Unread"));
    expect(getByText("Nothing is waiting on you.")).toBeTruthy();
    expect(getByText("You're caught up.")).toBeTruthy();
    expect(getByText("0 decisions")).toBeTruthy();
  });

  it("Mark all read invokes the shared read-all handler", () => {
    const { getByText, onReadAll } = renderPage();
    fireEvent.click(getByText("Mark all read"));
    expect(onReadAll).toHaveBeenCalledTimes(1);
  });
});
