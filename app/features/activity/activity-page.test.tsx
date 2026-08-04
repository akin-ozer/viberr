// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { ActivityPage, actIcon } from "./activity-page";
import {
  auditTimeLabel,
  auditTimeLabelUTC,
  groupStreamByDay,
  groupStreamByDayUTC,
  matchesActorFilter,
  type ActivityStreamRowView,
  type AuditLogEntryView,
} from "./feed-helpers";

afterEach(cleanup);

function iso(daysAgo: number, h: number, m: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

const STREAM: ActivityStreamRowView[] = [
  {
    id: 3,
    taskKey: "VIB-142",
    type: "comment",
    actor: { kind: "human", name: "Arda Kaya" },
    occurredAt: iso(0, 9, 58),
    text: "@operator widen the PAT scope.",
  },
  {
    id: 2,
    taskKey: "VIB-142",
    type: "completion",
    actor: { kind: "agent", name: "Codex" },
    occurredAt: iso(0, 9, 41),
    text: "**Completion report.** Implemented `attach` flow.",
  },
  {
    id: 1,
    taskKey: "VIB-145",
    type: "policy",
    actor: { kind: "system", name: "Policy engine" },
    occurredAt: iso(1, 16, 4),
    text: "**Policy violation:** PAT missing scope.",
  },
];

const AUDIT: AuditLogEntryView[] = [
  {
    id: "sv_1",
    kind: "violation",
    text: "Project credential is missing `pull_request:write` — flagged by the policy engine on",
    taskKey: "VIB-142",
    occurredAt: iso(0, 9, 38),
    status: "open",
    resolvedAt: null,
    resolvedBy: null,
  },
  {
    id: "evt_1",
    kind: "change",
    text: "Elif Demir set **review → done** to human only.",
    taskKey: null,
    occurredAt: iso(1, 11, 20),
    status: null,
    resolvedAt: null,
    resolvedBy: null,
  },
];

function renderActivity(
  stream: ActivityStreamRowView[] = STREAM,
  audit: AuditLogEntryView[] = AUDIT,
  totals: { streamTotal?: number; auditTotal?: number } = {},
) {
  const Stub = createRoutesStub([
    {
      path: "/projects/:slug/activity",
      Component: () => (
        <ActivityPage
          projectSlug="viberr-core"
          projectName="Viberr Core"
          stream={stream}
          streamTotal={totals.streamTotal ?? stream.length}
          audit={audit}
          auditTotal={totals.auditTotal ?? audit.length}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/projects/viberr-core/activity"]} />);
}

describe("helpers", () => {
  it("groupStreamByDay buckets DESC-ordered rows without empty groups", () => {
    const groups = groupStreamByDay(STREAM);
    expect(groups.map((g) => g.day)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual([1]);
  });

  it("matchesActorFilter matches on actor.kind; missing actors only under All", () => {
    const noActor = { ...STREAM[0]!, actor: null };
    expect(matchesActorFilter(noActor, "all")).toBe(true);
    expect(matchesActorFilter(noActor, "human")).toBe(false);
    expect(matchesActorFilter(STREAM[1]!, "agent")).toBe(true);
    expect(matchesActorFilter(STREAM[1]!, "system")).toBe(false);
  });

  it("auditTimeLabel reproduces the mock's freeform audit times", () => {
    expect(auditTimeLabel(iso(0, 9, 38))).toBe("today 09:38");
    expect(auditTimeLabel(iso(1, 16, 4))).toBe("yesterday 16:04");
    expect(auditTimeLabel("2026-03-30T14:00:00.000Z")).toMatch(/^Mar \d+$/);
  });

  it("UTC variants bucket by absolute UTC day — the hydration first pass", () => {
    // 23:50Z / 00:10Z straddle a UTC midnight: two groups with absolute
    // labels, whatever the host timezone (a UTC+3 host merges them locally).
    const rows = [
      { ...STREAM[0]!, id: 21, occurredAt: "2026-07-04T00:10:00.000Z" },
      { ...STREAM[1]!, id: 20, occurredAt: "2026-07-03T23:50:00.000Z" },
    ];
    expect(groupStreamByDayUTC(rows).map((g) => g.day)).toEqual([
      "Jul 4",
      "Jul 3",
    ]);
    // Never now-relative — that is exactly what a UTC server and a non-UTC
    // viewer disagree on.
    const fresh = { ...STREAM[0]!, occurredAt: new Date().toISOString() };
    expect(groupStreamByDayUTC([fresh])[0]!.day).not.toBe("Today");
    expect(auditTimeLabelUTC("2026-07-03T23:50:00.000Z")).toBe("Jul 3");
  });
});

describe("ActivityPage", () => {
  it("renders the day-grouped stream with actors, rich text and task chips", () => {
    const { container, getByText } = renderActivity();
    expect(
      getByText(
        "Human decisions, agent events, and policy changes across Viberr Core",
      ),
    ).toBeTruthy();
    // UI-47: the count says what it IS — the loaded (and possibly filtered)
    // slice against the project total, not a bare "N events" that read as a
    // project-wide tally.
    expect(getByText("3 of 3 events")).toBeTruthy();
    expect(container.querySelectorAll(".act-day")).toHaveLength(2);

    const rows = container.querySelectorAll(".panel:first-child .pol-ev");
    expect(rows).toHaveLength(3);
    // Bold actor + separator + rendered rich text (** never leaks).
    expect(rows[1]!.querySelector(".act-actor")!.textContent).toBe("Codex");
    expect(rows[1]!.querySelector("strong:not(.act-actor)")!.textContent).toBe(
      "Completion report.",
    );
    expect(rows[1]!.querySelector("code.mono")!.textContent).toBe("attach");
    expect(rows[1]!.textContent).not.toContain("**");
    // Per-type icon tint + task keybtn.
    expect(rows[1]!.querySelector(".pev-ico.act-completion")).toBeTruthy();
    expect(rows[1]!.querySelector(".keybtn")!.textContent).toBe("VIB-142");
  });

  it("actor filter narrows the stream, drops empty day groups, leaves audit alone", () => {
    const { container, getByText } = renderActivity();
    fireEvent.click(getByText("System"));
    expect(getByText("1 of 3 events (filtered)")).toBeTruthy();
    // Today's group vanished (no system events today).
    expect(container.querySelectorAll(".act-day")).toHaveLength(1);
    expect(container.querySelectorAll(".panel:first-child .pol-ev")).toHaveLength(1);
    // Audit panel untouched by the filter.
    expect(container.querySelectorAll(".pev-list .pol-ev")).toHaveLength(2);

    fireEvent.click(getByText("Humans"));
    expect(getByText("1 of 3 events (filtered)")).toBeTruthy();
  });

  it("shows the exact filter-empty and no-activity copy", () => {
    const noSystemToday = STREAM.filter((r) => r.actor?.kind !== "system");
    const { getByText, unmount } = renderActivity(noSystemToday, []);
    fireEvent.click(getByText("System"));
    expect(getByText("No events match this filter.")).toBeTruthy();
    unmount();

    const empty = renderActivity([], []);
    expect(empty.getByText("No activity yet.")).toBeTruthy();
    expect(empty.getByText("No policy or access events yet.")).toBeTruthy();
  });

  it("audit rows: kind tints, violation status pill, task chips, freeform times", () => {
    const { container } = renderActivity();
    const audit = container.querySelectorAll(".pev-list .pol-ev");
    expect(audit[0]!.querySelector(".pev-ico.violation")).toBeTruthy();
    expect(audit[0]!.querySelector(".pill.input")!.textContent).toBe("open");
    expect(audit[0]!.querySelector(".keybtn")!.textContent).toBe("VIB-142");
    expect(audit[0]!.querySelector(".pev-t")!.textContent).toBe("today 09:38");
    expect(audit[1]!.querySelector(".pev-ico.change")).toBeTruthy();
    expect(audit[1]!.querySelector(".pill")).toBeNull();

    // Resolved violations flip the pill and carry resolve context (Phase 10).
    cleanup();
    const resolved = renderActivity(STREAM, [
      {
        ...AUDIT[0]!,
        status: "resolved",
        resolvedAt: iso(0, 10, 2),
        resolvedBy: "Arda Kaya",
      },
    ]);
    const pill = resolved.container.querySelector(".pev-list .pill.done")!;
    expect(pill.textContent).toBe("resolved");
    expect(pill.parentElement!.getAttribute("title")).toContain(
      "Resolved by Arda Kaya",
    );
  });

  it("shows 'Show older' buttons only when the store holds more rows (Phase 10)", () => {
    const paged = renderActivity(STREAM, AUDIT, {
      streamTotal: 250,
      auditTotal: 75,
    });
    expect(
      paged.getByText(`Show older events · ${250 - STREAM.length} more`),
    ).toBeTruthy();
    expect(
      paged.getByText(`Show older entries · ${75 - AUDIT.length} more`),
    ).toBeTruthy();
    cleanup();

    // Fully loaded → no buttons.
    const full = renderActivity();
    expect(full.queryByText(/Show older/)).toBeNull();
  });
  // F10-19: long agent reports used to dump hundreds of lines into the feed,
  // burying every other event. They collapse to a preview with a Show more /
  // Show less toggle; short text is never wrapped in a toggle at all.
  it("F10-19: collapses long activity text behind Show more and expands in place", () => {
    const long = "x".repeat(400);
    const view = renderActivity([
      { ...STREAM[0]!, text: long },
    ]);

    // Collapsed: a truncated preview plus an unexpanded toggle — never the full text.
    const toggle = view.getByText("Show more");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText(long)).toBeNull();
    const preview = view.container.querySelector(".act-preview")!.textContent!;
    expect(preview.length).toBeLessThan(long.length);

    // Expanded: full text, and the toggle flips to Show less.
    fireEvent.click(toggle);
    expect(view.getByText("Show less").getAttribute("aria-expanded")).toBe("true");
    expect(view.container.textContent).toContain(long);
    expect(view.queryByText("Show more")).toBeNull();

    // Collapsing again restores the preview.
    fireEvent.click(view.getByText("Show less"));
    expect(view.getByText("Show more")).toBeTruthy();
  });

  it("F10-19: short activity text is rendered plainly, with no toggle", () => {
    const view = renderActivity([{ ...STREAM[0]!, text: "short enough" }]);
    expect(view.queryByText(/Show more|Show less/)).toBeNull();
    expect(view.container.querySelector(".act-collapsible")).toBeNull();
  });
});

/**
 * P14-UI-62: pass 13 added the neutral `note` type and moved every benign
 * governance event onto it — a goal edit, a divergence note, an archive
 * disposition — precisely so they stop rendering as "Policy violation". The
 * Activity page's icon map never learned the word, so those rows fell through
 * to the unknown-type dot and emitted an `act-note` tint class `app.css` did
 * not define: de-alarmed events rendered typeless in the one cross-task feed.
 */
describe("stream vocabulary (P14-UI-62)", () => {
  it("gives `note` a real icon and tint class, not the unknown-type dot", () => {
    const { container } = renderActivity([
      {
        id: 9,
        taskKey: "VIB-151",
        type: "note",
        actor: { kind: "human", name: "Arda Kaya" },
        occurredAt: iso(0, 10, 12),
        text: "**Archived:** VIB-151 was archived — its record is kept.",
      },
    ]);
    const ico = container.querySelector(".pev-ico")!;
    expect(ico.className).toContain("act-note");
    // `dot` is the tolerant fallback for a type outside the vocabulary — the
    // exact glyph a `note` row used to get.
    expect(actIcon("note")).toBe("message");
    expect(ico.querySelector("svg")!.innerHTML).not.toContain("circle");
  });

  it("an unknown type still falls back to the dot rather than throwing", () => {
    const { container } = renderActivity([
      {
        id: 10,
        taskKey: "VIB-151",
        type: "from-a-future-version",
        actor: { kind: "system", name: "Projection" },
        occurredAt: iso(0, 10, 13),
        text: "something new",
      },
    ]);
    expect(actIcon("from-a-future-version")).toBe("dot");
    expect(
      container.querySelector(".pev-ico svg")!.innerHTML,
    ).toContain("circle");
  });
});

/**
 * The hydration contract (modernization follow-up): the pre-hydration render
 * must be byte-identical on server and client, so it uses timezone-AGNOSTIC
 * forms — absolute UTC day groups, UTC clocks, absolute audit days; the local
 * forms only swap in after hydration (useHydrated flips inside an effect, so
 * the testing-library renders above assert the LOCAL forms). On a UTC host
 * the local and UTC clock forms coincide and this test loses its edge — the
 * e2e spec (e2e/06-activity-hydration.spec.ts) forces a 13-hour split against
 * the production image regardless of the host.
 */
describe("hydration first pass (SSR)", () => {
  it("renderToString emits absolute UTC days and UTC clocks, never Today/Yesterday", () => {
    const stream = [
      { ...STREAM[0]!, occurredAt: "2026-07-04T09:41:00.000Z" },
      { ...STREAM[2]!, occurredAt: "2026-07-03T16:04:00.000Z" },
    ];
    const audit = [{ ...AUDIT[0]!, occurredAt: "2026-07-03T22:15:00.000Z" }];
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/activity",
        Component: () => (
          <ActivityPage
            projectSlug="viberr-core"
            projectName="Viberr Core"
            stream={stream}
            streamTotal={stream.length}
            audit={audit}
            auditTotal={audit.length}
          />
        ),
      },
    ]);
    const html = renderToString(
      <Stub initialEntries={["/projects/viberr-core/activity"]} />,
    );
    expect(html).toContain(">Jul 4<");
    expect(html).toContain(">Jul 3<");
    expect(html).toContain(">09:41<");
    expect(html).toContain(">16:04<");
    expect(html).not.toMatch(/Today|Yesterday|today |yesterday /);
  });
});
