// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { ActivityPage } from "./activity-page";
import {
  actIcon,
  auditTimeLabel,
  compactAuditEntries,
  isRuntimeSessionOpen,
  matchesActorFilter,
  type ActivityStreamRowView,
  type AuditLogEntryView,
} from "./feed-helpers";
import { daySections } from "~/shared/dates/day-sections";

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
    text: "Project credential is missing `pull_request:write`. Flagged by the policy engine on",
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
  search = "",
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
      streamOptions={{ actors: [], types: [] }}
      auditActors={[]}
        />
      ),
    },
  ]);
  return render(
    <Stub initialEntries={[`/projects/viberr-core/activity${search}`]} />,
  );
}

describe("helpers", () => {
  it("daySections buckets the DESC-ordered stream without empty groups", () => {
    const groups = daySections(STREAM, (r) => r.occurredAt, true);
    expect(groups.map((g) => g.day)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual([3, 2]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual([1]);
  });

  it("the hydration first pass buckets by absolute UTC day", () => {
    // 23:50Z / 00:10Z straddle a UTC midnight: two groups with absolute
    // labels, whatever the host timezone (a UTC+3 host merges them locally).
    const rows = [
      { ...STREAM[0]!, id: 21, occurredAt: "2026-07-04T00:10:00.000Z" },
      { ...STREAM[1]!, id: 20, occurredAt: "2026-07-03T23:50:00.000Z" },
    ];
    expect(daySections(rows, (r) => r.occurredAt, false).map((g) => g.day)).toEqual([
      "Jul 4",
      "Jul 3",
    ]);
    // Never now-relative — that is exactly what a UTC server and a non-UTC
    // viewer disagree on.
    const fresh = { ...STREAM[0]!, occurredAt: new Date().toISOString() };
    expect(daySections([fresh], (r) => r.occurredAt, false)[0]!.day).not.toBe("Today");
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

  it("ruling 652(c): same-day rows from different YEARS get their own sections, in order", () => {
    // The day label carries no year, and the stream grouped on the label, so
    // two Mar 30s a year apart merged into one section with the old row inside
    // the recent block. Canary: group the stream by `g.day` again.
    const rows = [
      { ...STREAM[0]!, id: 31, text: "recent row", occurredAt: "2026-03-30T10:00:00.000Z" },
      { ...STREAM[1]!, id: 30, text: "a year older", occurredAt: "2025-03-30T10:00:00.000Z" },
    ];
    const { container } = renderActivity(rows, []);
    expect(container.querySelectorAll(".act-day")).toHaveLength(2);
    const shown = container.querySelectorAll(".panel:first-child .pol-ev");
    expect(shown[0]!.textContent).toContain("recent row");
    expect(shown[1]!.textContent).toContain("a year older");
  });

  it("ruling 148: a row with no actor names none, rather than a '−'", () => {
    // The sibling of the notifications case: a "−" in the slot every other row
    // fills with a name claimed a fact in a glyph, and sat where a remove
    // control would.
    // Canary: put `{r.actor ? r.actor.name : "−"}` back and this goes red.
    const actorless = STREAM.map((r) =>
      r.id === 2 ? { ...r, actor: null } : r,
    );
    const { container } = renderActivity(actorless);
    const rows = container.querySelectorAll(".panel:first-child .pol-ev");
    expect(rows[1]!.querySelector(".act-actor")).toBeNull();
    expect(rows[1]!.querySelector(".act-sep")).toBeNull();
    expect(rows[1]!.textContent).not.toContain("−");
    // The row still carries its message and its destination.
    expect(rows[1]!.querySelector("strong")!.textContent).toBe(
      "Completion report.",
    );
    expect(rows[1]!.querySelector(".keybtn")!.textContent).toBe("VIB-142");
    // The rows that do have one are untouched.
    expect(rows[0]!.querySelector(".act-actor")!.textContent).toBe("Arda Kaya");
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
    expect(getByText("No events match these filters.")).toBeTruthy();
    unmount();

    const empty = renderActivity([], []);
    expect(empty.getByText("No activity yet.")).toBeTruthy();
    expect(empty.getByText("No policy or access events yet.")).toBeTruthy();
  });

  // CANARY: render the link from the sentence, or for every row, and a row
  // the loader gave no `docHref` (a member's, or a delete's) offers a page its
  // reader cannot open.
  it("ruling 681: a row links the document it wrote only when the loader says where it opens", () => {
    const href = "/org/settings?tab=resources&kb=house-rules&doc=rules.md";
    const wrote = {
      ...AUDIT[1]!,
      text: "Arda Kaya edited a passage of **rules.md** in the project's rulings **house-rules**.",
    };
    const { container } = renderActivity(STREAM, [
      { ...wrote, id: "evt_admin", docHref: href },
      { ...wrote, id: "evt_member" },
    ]);
    const rows = container.querySelectorAll(".pev-list .pol-ev");
    const link = rows[0]!.querySelector("a")!;
    expect(link.textContent).toBe("Open document");
    expect(link.getAttribute("href")).toBe(href);
    expect(rows[1]!.querySelector("a")).toBeNull();
  });

  it("audit rows: kind tints, violation status pill, task chips, freeform times", () => {
    const { container } = renderActivity();
    const audit = container.querySelectorAll(".pev-list .pol-ev");
    expect(audit[0]!.querySelector(".pev-ico.violation")).toBeTruthy();
    expect(audit[0]!.querySelector(".pill.input")!.textContent).toBe("open");
    // Interface review 2026-09-24 (acce-5): the remedy was title-only.
    expect(audit[0]!.querySelector(".pill.input")!.parentElement!.textContent).toBe(
      "open: grant the missing scope to resolve",
    );
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
    // …and the same who/when reaches the accessibility tree, not only a
    // hovering mouse (interface review 2026-09-24, acce-5).
    expect(pill.parentElement!.querySelector(".vh")!.textContent).toMatch(
      /^ by Arda Kaya · /,
    );
    expect(pill.parentElement!.getAttribute("title")).toBe(
      "Resolved" + pill.parentElement!.querySelector(".vh")!.textContent,
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
 * to the unknown-type dot. The map is keyed on TIMELINE_EVENT_TYPES now, so a
 * contract type the map lacks is a compile error; what is left to run is the
 * tolerant fallback for a type from outside the contract.
 */
describe("stream vocabulary (P14-UI-62)", () => {
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
 * R19-7 (closes UX19-5) — the audit column compacts consecutive
 * runtime-session-open rows.
 *
 * Observed live on a 1440px viewport: 8 of the 9 rows the "Audit logs · policy
 * & access · all actors" column had room for were the identical "operator
 * opened the <role> runtime session — recorded per audit policy on VC-4". The
 * credential assignment, the scope re-check and the project creation the column
 * exists to surface were below the fold, buried by routine agent bookkeeping —
 * "calm over chatter / human attention is scarce" inverted.
 *
 * Audit policy requires the event, so the ruling is compaction, not removal:
 * the run folds into one "N runtime sessions opened" row that gives every row
 * back — with its own real timestamp — on one click.
 */
const RUNTIME_SESSION_TEXT =
  "operator opened the Developer runtime session. Recorded per audit policy on";

function session(id: number, h: number, m: number): AuditLogEntryView {
  return {
    id: `evt_run_${id}`,
    kind: "audit",
    text: RUNTIME_SESSION_TEXT,
    taskKey: "VC-4",
    occurredAt: iso(0, h, m),
    status: null,
    resolvedAt: null,
    resolvedBy: null,
  };
}

const CREDENTIAL: AuditLogEntryView = {
  id: "evt_cred",
  kind: "change",
  text: "Arda Kaya assigned the project GitHub credential.",
  taskKey: null,
  occurredAt: iso(0, 8, 30),
  status: null,
  resolvedAt: null,
  resolvedBy: null,
};

const ROLE_CHANGE: AuditLogEntryView = {
  id: "evt_role",
  kind: "change",
  text: "Elif Demir set Murat Yilmaz to **maintainer**.",
  taskKey: null,
  occurredAt: iso(1, 9, 15),
  status: null,
  resolvedAt: null,
  resolvedBy: null,
};

describe("audit-column compaction (R19-7)", () => {
  /**
   * The recogniser reads `entry.text`, and `entry.text` OPENS with the actor's
   * display name — which any member sets for themselves (`app/routes/
   * profile.tsx`). So the fold must not be reachable from a name. It is not,
   * because the pattern is anchored to the projection's whole trailing
   * sentence and every audit template puts fixed words AFTER `${actor}`; a
   * name can only ever be a prefix.
   *
   * Derived from the projection's own `AUDIT_ACTION_KINDS` map rather than a
   * hand-listed set: add a new "audit" action whose sentence happens to end
   * `runtime session. Recorded per audit policy on` and this fails.
   */
  it("a member cannot spoof the fold with their display name", () => {
    const src = readFileSync(
      path.resolve(process.cwd(), "app/server/projections/activity-feed.server.ts"),
      "utf8",
    );
    const map = /const AUDIT_ACTION_KINDS[\s\S]*?\n\};/.exec(src)![0];
    const auditActions = [...map.matchAll(/"([\w.]+)":\s*"(\w+)"/g)]
      .filter(([, , kind]) => kind === "audit")
      .map(([, action]) => action!);
    // The families the column exists for must be in scope, or this proves
    // nothing.
    expect(auditActions).toContain("task.acceptance.forced");
    expect(auditActions).toContain("project.org_admin.override");
    expect(auditActions).toContain("runtime.run.started");

    // The exact name a hostile member would pick: their own row, quoting the
    // sentence the fold looks for.
    const names = [
      "Mallory (opened the dev runtime session)",
      "Mallory (opened the dev runtime session. Recorded per audit policy on)",
      "opened the dev runtime session. Recorded per audit policy on",
    ];

    for (const action of auditActions) {
      const from = src.indexOf(`case "${action}":`);
      // Most governance families have a bespoke `case` template. A newly
      // registered kind may instead render through the projection's DOCUMENTED
      // default fallback: the `AUDIT_ACTION_KINDS` docstring blesses it for
      // "additions that land here before a bespoke sentence does", and RECONCILE
      // §1.2 registered R19-A's `task.operator.autonomy_clamped` as a map entry
      // only. The default is `${actor}: <action words>.` — it ALWAYS ends in
      // ".", so it can never carry the `runtime session. Recorded per audit
      // policy on` tail the fold looks for. The spoof-must-fail law (R19-7) is
      // asserted over it below all the same, so a name still cannot fold it.
      let templates: string[];
      if (from === -1) {
        expect(
          src,
          "an untemplated audit kind must fall through to the documented default",
        ).toContain('${row.action.replace(/[._]/g, " ")}');
        templates = ["${actor}: " + action.replace(/[._]/g, " ") + "."];
      } else {
        const rest = src.slice(from + action.length + 8);
        const stop = /\n    (?:case "|default:)/.exec(rest);
        const block = rest.slice(0, stop ? stop.index : rest.length);
        templates = [...block.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
        expect(templates.length, `${action} must render a sentence`)
          .toBeGreaterThan(0);
      }

      for (const template of templates) {
        for (const name of names) {
          const text = template
            .replace("${actor}", name)
            .replace(/\$\{[^}]*\}/g, "X");
          // Rows ending in " on" expect the task chip; `finishText` swaps the
          // dangler for "." when there is none. Both forms must behave.
          for (const rendered of [text, text.replace(/ on$/, ".")]) {
            expect(
              isRuntimeSessionOpen({ ...session(1, 9, 0), text: rendered }),
              `${action} + display name "${name}" → ${rendered}`,
            ).toBe(action === "runtime.run.started" && rendered === text);
          }
        }
      }
    }
  });

  it("a spoofed name does not fold the two override rows away", () => {
    // The live consequence, end to end: a force-accept and an org-admin
    // override, authored back to back by a member whose display name quotes
    // the session sentence. They are the whole point of the audit column —
    // they must render as two rows, not as "2 runtime sessions opened".
    const spoof = "Mallory (opened the dev runtime session)";
    const forced: AuditLogEntryView = {
      id: "evt_forced",
      kind: "audit",
      text: `${spoof} force-accepted the completion, overriding the acceptance gate (the required reviewer had not approved) on`,
      taskKey: "VC-4",
      occurredAt: iso(0, 9, 20),
      status: null,
      resolvedAt: null,
      resolvedBy: null,
    };
    const override: AuditLogEntryView = {
      id: "evt_override",
      kind: "audit",
      text: `${spoof} used the org-admin override to accept a completion (project role: not a member).`,
      taskKey: null,
      occurredAt: iso(0, 9, 18),
      status: null,
      resolvedAt: null,
      resolvedBy: null,
    };
    const rows = compactAuditEntries([forced, override]);
    expect(rows.map((r) => (r.compacted ? "compacted" : r.entry.id))).toEqual([
      "evt_forced",
      "evt_override",
    ]);

    const { container, queryByText } = renderActivity(STREAM, [
      forced,
      override,
    ]);
    expect(container.querySelectorAll(".pev-list .pol-ev")).toHaveLength(2);
    expect(queryByText("2 runtime sessions opened")).toBeNull();
    expect(container.textContent).toContain("force-accepted the completion");
    expect(container.textContent).toContain("used the org-admin override");
  });

  it("only folds the audit-kind session row — never a lookalike", () => {
    expect(isRuntimeSessionOpen(session(1, 9, 0))).toBe(true);
    // Same sentence filed as a policy violation is a different event class; it
    // keeps its own row and its open/resolved pill.
    expect(
      isRuntimeSessionOpen({ ...session(1, 9, 0), kind: "violation" }),
    ).toBe(false);
    expect(isRuntimeSessionOpen(CREDENTIAL)).toBe(false);
    expect(
      isRuntimeSessionOpen({
        ...session(1, 9, 0),
        text: "operator interrupted an agent run. Recorded per audit policy on",
      }),
    ).toBe(false);
    // The WHOLE trailing sentence is required, end-anchored — see the spoof
    // test above for why. A row that merely opens with the phrase, or that
    // carries anything after the audit-policy tail, is not this event.
    expect(
      isRuntimeSessionOpen({
        ...session(1, 9, 0),
        text: "operator opened the Reviewer runtime session.",
      }),
    ).toBe(false);
    expect(
      isRuntimeSessionOpen({ ...session(1, 9, 0), text: `${RUNTIME_SESSION_TEXT} VC-4` }),
    ).toBe(false);
  });

  it("folds a consecutive run into one row, keeping order and every entry", () => {
    const entries = [
      session(1, 9, 40),
      session(2, 9, 35),
      session(3, 9, 30),
      CREDENTIAL,
      ROLE_CHANGE,
    ];
    const rows = compactAuditEntries(entries);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.compacted).toBe(true);
    expect(
      rows[0]!.compacted ? rows[0]!.entries.map((e) => e.id) : [],
    ).toEqual(["evt_run_1", "evt_run_2", "evt_run_3"]);
    // Real policy/access events keep their own rows, in place.
    expect(rows[1]!.compacted ? null : rows[1]!.entry.id).toBe("evt_cred");
    expect(rows[2]!.compacted ? null : rows[2]!.entry.id).toBe("evt_role");
  });

  it("a run is CONSECUTIVE — a real event between two sessions splits it", () => {
    const rows = compactAuditEntries([
      session(1, 9, 40),
      session(2, 9, 35),
      CREDENTIAL,
      session(3, 9, 20),
      session(4, 9, 15),
    ]);
    expect(rows.map((r) => (r.compacted ? "compacted" : r.entry.id))).toEqual([
      "compacted",
      "evt_cred",
      "compacted",
    ]);
  });

  it("a lone session row stays verbatim — one row folded into one saves nothing", () => {
    const rows = compactAuditEntries([CREDENTIAL, session(1, 9, 40), ROLE_CHANGE]);
    expect(rows.every((r) => !r.compacted)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("never folds anything else, however repetitive", () => {
    const repeated = [CREDENTIAL, { ...CREDENTIAL, id: "evt_cred_2" }];
    expect(compactAuditEntries(repeated).every((r) => !r.compacted)).toBe(true);
  });

  it("renders the live case as one summary row, with the real events visible", () => {
    const flood = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => session(n, 9, 50 - n));
    const { container, getByText, queryByText } = renderActivity(STREAM, [
      ...flood,
      CREDENTIAL,
      ROLE_CHANGE,
    ]);
    const rows = container.querySelectorAll(".pev-list .pol-ev");
    // 8 + 2 entries collapse to 3 rows: the summary and the two real events.
    expect(rows).toHaveLength(3);
    expect(getByText("8 runtime sessions opened")).toBeTruthy();
    // The repeated sentence is gone from the column while folded…
    expect(queryByText(RUNTIME_SESSION_TEXT)).toBeNull();
    // …and the events the column exists for are on screen, not below the fold.
    expect(container.textContent).toContain(
      "assigned the project GitHub credential",
    );
    expect(container.textContent).toContain("Elif Demir set Murat Yilmaz to");
    // The summary is agent bookkeeping, tinted as the audit rows it stands for.
    expect(rows[0]!.querySelector(".pev-ico.audit")).toBeTruthy();
    // Anchored at the newest of the run (entries arrive newest-first).
    expect(rows[0]!.querySelector(".pev-t")!.textContent).toBe("today 09:49");
  });

  it("expanding gives every folded row back with its own real timestamp", () => {
    const { container, getByText } = renderActivity(STREAM, [
      session(1, 9, 40),
      session(2, 9, 35),
      session(3, 9, 30),
      CREDENTIAL,
    ]);
    const toggle = getByText("Show each");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    const expanded = getByText("Hide sessions");
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    const subs = container.querySelectorAll(".pev-list .pol-ev.pev-sub");
    expect(subs).toHaveLength(3);
    expect([...subs].map((r) => r.querySelector(".pev-t")!.textContent)).toEqual(
      ["today 09:40", "today 09:35", "today 09:30"],
    );
    // Real rows, not a summary: each keeps its text and its task chip.
    expect(subs[0]!.textContent).toContain("runtime session");
    expect(subs[0]!.querySelector(".keybtn")!.textContent).toBe("VC-4");

    fireEvent.click(expanded);
    expect(
      container.querySelectorAll(".pev-list .pol-ev.pev-sub"),
    ).toHaveLength(0);
    expect(getByText("Show each")).toBeTruthy();
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
    // Today's rows: their local forms would say "Today" / "today …"; the first
    // pass must not. (The fixed July rows read absolute in either form.)
    // CANARY: render the local forms on the first pass and the Today negative
    // below goes red on any host.
    const now = new Date().toISOString();
    const stream = [
      { ...STREAM[1]!, id: 30, occurredAt: now },
      { ...STREAM[0]!, occurredAt: "2026-07-04T09:41:00.000Z" },
      { ...STREAM[2]!, occurredAt: "2026-07-03T16:04:00.000Z" },
    ];
    const audit = [
      { ...AUDIT[1]!, occurredAt: now },
      { ...AUDIT[0]!, occurredAt: "2026-07-03T22:15:00.000Z" },
    ];
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
      streamOptions={{ actors: [], types: [] }}
      auditActors={[]}
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

describe("per-panel feed filters (P21)", () => {
  it("renders one filter bar per panel, with the panel's own vocabulary", () => {
    // The audit bar renders only for a log longer than one page (design pass
    // 2026-09-08), so the fixture claims more entries than it carries.
    const { getByLabelText, getAllByText } = renderActivity(undefined, undefined, {
      auditTotal: 75,
    });
    // Stream bar.
    expect(getByLabelText("Search the activity stream")).not.toBeNull();
    expect(getByLabelText("Filter the activity stream by type")).not.toBeNull();
    expect(getByLabelText("Filter the activity stream by task id")).not.toBeNull();
    // Pass 30: the date ranges use the app's shared DatePicker, not native
    // date inputs — one From/To pair per panel, each trigger keeping the
    // panel-scoped accessible name (the visible text becomes the picked DATE,
    // which cannot name the control once a page has four pickers).
    expect(getAllByText("From")).toHaveLength(2);
    expect(getAllByText("To")).toHaveLength(2);
    // acce-16: the name carries the value too, so an unset range says so.
    expect(
      getByLabelText("From date for the activity stream: not set"),
    ).not.toBeNull();
    expect(getByLabelText("To date for the audit logs: not set")).not.toBeNull();
    // Audit bar — its type filter speaks in the panel's four display kinds.
    // SAFETY: the aria-label belongs to the audit bar's kind <select>
    // (FeedFilters); the bound query cannot state the element type.
    const kindSelect = getByLabelText(
      "Filter the audit logs by kind",
    ) as HTMLSelectElement;
    const kinds = [...kindSelect.options].map((o) => o.value);
    expect(kinds).toEqual(["", "violation", "blockedact", "change", "audit"]);
  });

  it("a log that fits on one page carries no filter bar", () => {
    // Design pass 2026-09-08: five controls above one entry was the filter
    // apparatus outweighing its content. The stream bar is untouched.
    const { queryByLabelText, getByLabelText } = renderActivity();
    expect(queryByLabelText("Filter the audit logs by kind")).toBeNull();
    expect(queryByLabelText("Search the audit logs")).toBeNull();
    expect(getByLabelText("Search the activity stream")).not.toBeNull();
  });

  it("writ-7: a URL filter that matches nothing says so, not 'no activity'", () => {
    // The loader filters server-side, so both the rows and the totals arrive
    // already narrowed: an empty stream here is "no match", never "no activity".
    const { getByText, queryByText } = renderActivity([], [], {}, "?sq=zzzqqxx");
    expect(getByText("No events match these filters.")).toBeTruthy();
    expect(queryByText("No activity yet.")).toBeNull();
    expect(getByText("0 of 0 events (filtered)")).toBeTruthy();
    // The way out stays on screen.
    expect(getByText("Clear")).toBeTruthy();
  });

  it("writ-7: a filtered short audit log keeps its bar, its Clear and says so", () => {
    // The gate reads the FILTERED total, so without the filter check a
    // narrowed log unmounted the very search box that narrowed it.
    const { getByText, getByLabelText, queryByLabelText, queryByText } =
      renderActivity(STREAM, [], { auditTotal: 0 }, "?aq=zzzqqxx");
    expect(getByText("No entries match these filters.")).toBeTruthy();
    expect(queryByText("No policy or access events yet.")).toBeNull();
    expect(getByText(/0 of 0 entries \(filtered\)/)).toBeTruthy();
    // SAFETY: the aria-label belongs to the audit bar's search <input>
    // (FeedFilters); the bound query cannot state the element type.
    const search = getByLabelText("Search the audit logs") as HTMLInputElement;
    expect(search.value).toBe("zzzqqxx");
    // The stream panel is unfiltered: its count carries no mark.
    expect(getByText("3 of 3 events")).toBeTruthy();
    fireEvent.click(getByText("Clear"));
    // Unfiltered and short again: the design-pass gate hides the bar.
    expect(queryByLabelText("Search the audit logs")).toBeNull();
    expect(getByText("No policy or access events yet.")).toBeTruthy();
  });

  it("typing a search writes the panel's own URL param and Clear removes it", () => {
    const { getByLabelText, getByText, queryByText } = renderActivity();
    expect(queryByText("Clear")).toBeNull();
    fireEvent.change(getByLabelText("Search the activity stream"), {
      target: { value: "merge" },
    });
    // The param IS the state (the board's ?q= pattern): the bar re-reads it.
    // SAFETY: the aria-label belongs to the stream bar's search <input>
    // (FeedFilters); the bound query cannot state the element type.
    expect(
      (getByLabelText("Search the activity stream") as HTMLInputElement).value,
    ).toBe("merge");
    fireEvent.click(getByText("Clear"));
    // SAFETY: same search <input> as above.
    expect(
      (getByLabelText("Search the activity stream") as HTMLInputElement).value,
    ).toBe("");
  });
});

/**
 * C5 (pass 34, U34-4): the instrument goes in front of the SENTENCE, so the
 * runtime-session fold still recognises its own rows. `isRuntimeSessionOpen`
 * matches on the sentence's tail, and a parenthetical appended AFTER it would
 * silently stop every session run from folding.
 */
describe("C5: the controller instrument and the runtime-session fold", () => {
  const opened = (actor: string): AuditLogEntryView => ({
    id: `aud_${actor.length}`,
    kind: "audit",
    text: `${actor} opened the Claude runtime session. Recorded per audit policy on`,
    taskKey: null,
    occurredAt: "2026-09-04T10:00:00.000Z",
    status: null,
    resolvedAt: null,
    resolvedBy: null,
  });

  it("an instrumented actor still folds; the same words appended AFTER the sentence do not", () => {
    // Canary: append the parenthetical after the sentence instead.
    expect(isRuntimeSessionOpen(opened("Arda Kaya (via the controller)"))).toBe(true);
    expect(isRuntimeSessionOpen(opened("Arda Kaya"))).toBe(true);
    const trailing: AuditLogEntryView = {
      ...opened("Arda Kaya"),
      text: `${opened("Arda Kaya").text} (via the controller)`,
    };
    expect(isRuntimeSessionOpen(trailing)).toBe(false);
  });
});

/**
 * Ruling 477(c) (F40-29, live on akinozer.com): every task key on Activity
 * (WEB-2, WEB-3…) was a `<button class="keybtn">` calling navigate(), so a
 * key could not be opened in a new tab or copied, and a screen reader heard
 * "button" for a page link.
 */
describe("ruling 477(c): task keys are links to their tasks", () => {
  it("in the stream, on audit rows, and on rows a compacted run gives back", () => {
    // CANARY: render either key as `<button type="button" onClick={…}>` again
    // and its lookup below finds no link.
    const { container, getByText, getAllByRole } = renderActivity(STREAM, [
      ...AUDIT,
      session(1, 9, 30),
      session(2, 9, 20),
    ]);
    const stream = container.querySelectorAll(".panel:first-child .pol-ev .keybtn");
    expect([...stream].map((k) => [k.tagName, k.getAttribute("href")])).toEqual([
      ["A", "/projects/viberr-core/tasks/VIB-142"],
      ["A", "/projects/viberr-core/tasks/VIB-142"],
      ["A", "/projects/viberr-core/tasks/VIB-145"],
    ]);
    fireEvent.click(getByText("Show each"));
    const audit = container.querySelectorAll(".pev-list .keybtn:not(.act-toggle)");
    expect([...audit].map((k) => [k.tagName, k.getAttribute("href")])).toEqual([
      ["A", "/projects/viberr-core/tasks/VIB-142"],
      ["A", "/projects/viberr-core/tasks/VC-4"],
      ["A", "/projects/viberr-core/tasks/VC-4"],
    ]);
    // Announced as links, by the key they carry.
    expect(getAllByRole("link", { name: "VC-4" })).toHaveLength(2);
    expect(getAllByRole("link", { name: "VIB-145" })).toHaveLength(1);
  });
});
