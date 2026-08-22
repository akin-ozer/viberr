// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { NotificationsPage } from "./notifications-page";
import {
  needsYouTime,
  splitNotifications,
  type NotificationPageItem,
} from "./notifications-page-helpers";

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
    waitingOnYou: true,
    from: { name: "Operator" },
  },
  {
    id: "n-dep-31",
    kind: "packet",
    ptype: "input",
    // F19-24: the shape `operatorOpenPacket` actually writes — EVERY packet row
    // is titled "Decision needed: …" (operator-actions.server.ts), which is
    // why pilling them "completion report" contradicted the row's own title.
    title: "Decision needed: which scope should we take?",
    text: "Promotion to staging needs your acceptance.",
    projectSlug: "deploy-pipeline",
    projectName: "Deploy Pipeline",
    taskKey: "DEP-31",
    occurredAt: iso(0, 10, 12),
    unread: true,
    waitingOnYou: true,
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
    waitingOnYou: true,
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
    waitingOnYou: false,
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
    waitingOnYou: false,
    from: { name: "Policy engine" },
  },
];

function renderPage(
  items: NotificationPageItem[] = ITEMS,
  unread = items.filter((n) => n.unread).length,
  // D-3 (pass 24): the authoritative decision count (from the loader). Default to
  // the needs-you row count so the header states the same number these tests have
  // always asserted; a divergence between the two is exercised explicitly below.
  decisionCount = splitNotifications(items, "all").needsTotal,
) {
  const onRead = vi.fn();
  const onReadAll = vi.fn();
  const onOpen = vi.fn();
  const utils = render(
    <NotificationsPage
      items={items}
      unread={unread}
      decisionCount={decisionCount}
      onRead={onRead}
      onReadAll={onReadAll}
      onOpen={onOpen}
    />,
  );
  return { ...utils, onRead, onReadAll, onOpen };
}

describe("splitNotifications", () => {
  it("routes LIVE packets+approvals to needs-you, the rest to the stream", () => {
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

  it("resolved decisions (waitingOnYou=false) fall to the stream, not the waiting bucket (F7-NOTIF1)", () => {
    // The same rows after their decisions resolved live (packet cleared /
    // rec applied / task Done) — kind alone no longer earns "Waiting on you".
    const resolved = ITEMS.map((n) => ({ ...n, waitingOnYou: false }));
    const { needs, rest } = splitNotifications(resolved, "all");
    expect(needs).toEqual([]);
    expect(rest.map((n) => n.id)).toEqual(resolved.map((n) => n.id));
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

  it("the All/Unread filter is a role=group with aria-pressed state, not a broken radiogroup (G3/UI-58)", () => {
    const { container, getByText } = renderPage();
    const seg = container.querySelector(".mini-seg")!;
    // Not the broken contract — a plain group, and the state is on the buttons.
    expect(seg.getAttribute("role")).toBe("group");
    const all = getByText("All").closest("button")!;
    const unread = getByText("Unread").closest("button")!;
    expect(all.getAttribute("aria-pressed")).toBe("true"); // default filter
    expect(unread.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(unread);
    expect(all.getAttribute("aria-pressed")).toBe("false");
    expect(unread.getAttribute("aria-pressed")).toBe("true");
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

    // Type pills per kind/ptype. F19-24: the non-blocked packet pill used to
    // read "completion report" by FALL-THROUGH — a name that belongs to the
    // acceptance boundary — while the row's own title said "Decision needed: …"
    // and the same packet was pilled "Decision required" on the task page.
    expect(rows[0]!.querySelector(".pill.blocked")!.textContent).toBe(
      "blocked decision",
    );
    expect(rows[1]!.querySelector(".pill.input")!.textContent).toBe(
      "decision required",
    );
    expect(rows[2]!.querySelector(".pill.info")!.textContent).toBe("approval");

    // …and the icon tone agrees with the word: a question does not get the
    // completion checkmark. (The sibling fall-through in `ntfMeta`.)
    expect(
      rows[1]!.querySelector(".pev-ico")!.classList.contains("act-completion"),
    ).toBe(false);
    expect(
      rows[1]!.querySelector(".pev-ico")!.classList.contains("act-policy"),
    ).toBe(true);

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

  // UI-54: REWRITTEN — this pinned the bug. `splitNotifications` applied the
  // All/Unread filter BEFORE the needs-you split, so a set of already-READ
  // pending decisions rendered "0 decisions · Nothing is waiting on you" under
  // the Unread filter. The filter is a view of the stream, not a claim about
  // what still needs a human: the header keeps the true count and the empty
  // state says the rows are filter-hidden, not absent.
  it("Unread filter hides read decisions from the list but not from the count", () => {
    const read = ITEMS.map((n) => ({ ...n, unread: false }));
    const { getByText } = renderPage(read, 0);
    fireEvent.click(getByText("Unread"));
    expect(getByText("You're caught up.")).toBeTruthy();
    // ITEMS carries three live pending decisions (two packets + one approval,
    // each on a distinct task).
    expect(getByText("3 decisions · 3 hidden by the filter")).toBeTruthy();
    expect(
      getByText(
        '3 decisions are waiting on you. Switch to "All" to see them.',
      ),
    ).toBeTruthy();
  });

  // F19-25: `unread` is the BELL BADGE count, and F18-1 deliberately excludes
  // rows whose project no longer exists (removed out of band from the file
  // store, then re-scanned) so a wiped project cannot inflate the badge. The
  // page renders those rows anyway — unread dot, "Mark read" button — so it
  // read "all caught up" above three visible unread rows AND withdrew "Mark all
  // read", the one control that clears them in a single click.
  it("counts the ORPHANED unread rows it renders, and keeps Mark all read reachable", () => {
    const orphans = ITEMS.filter((n) => n.kind !== "packet").map((n) => ({
      ...n,
      unread: true,
      waitingOnYou: false,
      targetMissing: true,
    }));
    // The badge number the loader hands over: zero, because every unread row
    // points at a project that is gone.
    const { container, getByText, queryByText } = renderPage(orphans, 0);

    expect(container.querySelectorAll(".ntf-ev.unread")).toHaveLength(
      orphans.length,
    );
    expect(
      getByText(
        `Everything routed to you, across all projects · ${orphans.length} unread`,
      ),
    ).toBeTruthy();
    expect(queryByText("all caught up")).toBeNull();
    expect(getByText("Mark all read")).toBeTruthy();
  });

  it("orphan rows do not double-count against the badge number", () => {
    // One live unread row (already in `unread`) plus one orphan (excluded from
    // it) must read "2 unread", not 3.
    const items: NotificationPageItem[] = [
      { ...ITEMS[3]!, unread: true },
      { ...ITEMS[4]!, unread: true, targetMissing: true },
    ];
    const { getByText } = renderPage(items, 1);
    expect(
      getByText("Everything routed to you, across all projects · 2 unread"),
    ).toBeTruthy();
  });

  it("Mark all read invokes the shared read-all handler", () => {
    const { getByText, onReadAll } = renderPage();
    fireEvent.click(getByText("Mark all read"));
    expect(onReadAll).toHaveBeenCalledTimes(1);
  });
});
