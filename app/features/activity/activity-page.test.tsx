// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ActivityPage } from "./activity-page";
import {
  auditTimeLabel,
  groupStreamByDay,
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
    expect(auditTimeLabel(iso(0, 9, 38))).toBe("today 9:38");
    expect(auditTimeLabel(iso(1, 16, 4))).toBe("yesterday 16:04");
    expect(auditTimeLabel("2026-03-30T14:00:00.000Z")).toMatch(/^Mar \d+$/);
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
    expect(getByText("3 events")).toBeTruthy();
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
    expect(getByText("1 events")).toBeTruthy();
    // Today's group vanished (no system events today).
    expect(container.querySelectorAll(".act-day")).toHaveLength(1);
    expect(container.querySelectorAll(".panel:first-child .pol-ev")).toHaveLength(1);
    // Audit panel untouched by the filter.
    expect(container.querySelectorAll(".pev-list .pol-ev")).toHaveLength(2);

    fireEvent.click(getByText("Humans"));
    expect(getByText("1 events")).toBeTruthy();
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
    expect(audit[0]!.querySelector(".pev-t")!.textContent).toBe("today 9:38");
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
});
