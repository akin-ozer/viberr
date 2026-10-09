import { useState } from "react";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { useHydrated } from "~/ui/local-time";
import { daySections } from "~/shared/dates/day-sections";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import { ntfMeta, ntfPill, plainText } from "./notification-meta";
import {
  needsYouCountTail,
  needsYouEmptyText,
  needsYouTime,
  needsYouTimeUTC,
  splitNotifications,
  type NotificationFilter,
  type NotificationPageItem,
} from "./notifications-page-helpers";

/**
 * Notifications page: "Waiting on you" packet/approval
 * cards + "Everything else" day-grouped stream, All/Unread filter,
 * mark-all-read. Rendered inside the phase-4 PageOverlay route; read
 * mutations go through the ONE existing /notifications/read action.
 *
 * Deviation from the mock (spec §8 open question C, resolved): this is a
 * GLOBAL cross-project page, so every row with a known project names it
 * ("Project · KEY", `whereLabel`) — the mock hid it for its
 * hard-coded "Viberr Core" workspace, a literal the porting notes say must
 * not survive.
 */

/**
 * Where a notification points, in the ONE idiom all three of its drawings use
 * (ruling 280): "Project · KEY" in the meta voice, as the bell's meta line
 * reads. The page drew the project as a grey pill in one list and a mono
 * keycap in the other.
 */
function whereLabel(n: NotificationPageItem): string {
  // F18-1: an orphan has nowhere to open — say so instead of a live-looking link.
  if (n.targetMissing) return "project no longer exists";
  // Named after where it GOES. Concatenating an absent task key produced
  // "Viberr Core · " — a trailing separator on a control whose destination is
  // the project board, not a task.
  return [n.projectName, n.taskKey].filter(Boolean).join(" · ");
}

function NtfNeedsYou({
  items,
  total,
  decisionCount,
  onRead,
  onOpen,
}: {
  items: NotificationPageItem[];
  /** UI-54: pending-decision NOTIFICATION ROWS regardless of the All/Unread
   *  filter — drives the filter-hidden math and the "switch to All" hint. */
  total: number;
  /** D-3 (pass 24): the AUTHORITATIVE count of decisions this viewer must act on
   *  (same source as the home hero). The header states THIS; it is >= `total`
   *  when a decision has no notification row for the viewer. */
  decisionCount: number;
  onRead: (id: string) => void;
  onOpen: (n: NotificationPageItem) => void;
}) {
  // Same *UTC-first-pass gate the stream panel below uses (UXA-5): render the
  // absolute stamp on the server and the first client pass, swap to the
  // viewer's own zone once hydrated.
  const local = useHydrated();
  const hiddenByFilter = total - items.length;
  const onTaskPages = Math.max(0, decisionCount - total);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="hand" />
        <h2>Waiting on you</h2>
        <span className="right sub fine">
          {/* D-3: the count is the authoritative number of pending decisions for
              this viewer — the same source home uses — not the notification-row
              tally, which misses decisions whose watcher set predates a later
              promotion or fall past the row window. */}
          {decisionCount} decision{decisionCount === 1 ? "" : "s"}
          {needsYouCountTail(hiddenByFilter, onTaskPages)}
        </span>
      </div>
      <div className="rq-list ntf-wait">
        {items.map((n) => {
          const m = ntfMeta(n);
          const p = ntfPill(n);
          const where = whereLabel(n);
          return (
            <button
              type="button"
              className="rq-row"
              key={n.id}
              onClick={() => {
                onRead(n.id);
                onOpen(n);
              }}
            >
              <span className={"pev-ico " + m.cls}>
                <Icon name={m.icon} />
              </span>
              <span className="rq-main">
                <div className="ttl">
                  {/* The dot is colour alone (WCAG 1.4.1); the bell's row
                      leads its name the same way. */}
                  {n.unread && <span className="vh">Unread: </span>}
                  {n.title}
                </div>
                <div className="sub">
                  {where && (
                    <>
                      <span className="ntf-where">{where}</span> ·{" "}
                    </>
                  )}
                  <RichText text={n.text} />
                </div>
              </span>
              {/* Ruling 280: the unread dot sits in the trailing cluster beside
                  the time, as in the stream below and at the bell row's end;
                  it hung off the title's last word here. */}
              <span className="rq-meta">
                <Pill kind={p.kind} sm>
                  {p.label}
                </Pill>
                {n.unread && <span className="unread-dot" />}
                <span className="pev-t">
                  {local ? needsYouTime(n.occurredAt) : needsYouTimeUTC(n.occurredAt)}
                </span>
              </span>
            </button>
          );
        })}
        {!items.length && (
          <div className="empty">
            {needsYouEmptyText(decisionCount, hiddenByFilter)}
          </div>
        )}
      </div>
    </div>
  );
}

function NtfStream({
  items,
  onRead,
  onOpen,
}: {
  items: NotificationPageItem[];
  onRead: (id: string) => void;
  onOpen: (n: NotificationPageItem) => void;
}) {
  // UXA-5: this page is SSR'd and rendered viewer-LOCAL day buckets on the
  // first pass — and used that value as the GROUPING key, the precise case
  // `formatDayBucketUTC`'s docstring exists for ("an SSR/hydration render
  // straddling UTC midnight would mismatch every header at once"). Activity,
  // task detail and the run console all adopted the useHydrated + *UTC first
  // pass; the notifications stream was never brought along.
  const local = useHydrated();
  const sections = daySections(items, (item) => item.occurredAt, local);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="bell" />
        <h2>Everything else</h2>
      </div>
      {sections.map((section) => (
        <div key={section.key}>
          <div className="act-day">{section.day}</div>
          {section.rows.flatMap((n) => {
            const m = ntfMeta(n);
            return (
              // UI-54: every stream row used to be `role="button" tabIndex={0}`
              // whose ONLY effect was `onRead` — and the route early-returns for
              // rows already read, so a read row was a focusable control that
              // did nothing. It also nested a real `<button>` (the navigate
              // keybtn) inside a `role="button"`, which is invalid. The row is a
              // plain element now; clicking it still marks read (mouse
              // convenience), and unread rows carry an explicit focusable
              // "Mark read" control.
              <div
                className={"pol-ev ntf-ev" + (n.unread ? " unread" : "")}
                key={n.id}
                onClick={n.unread ? () => onRead(n.id) : undefined}
                title={n.unread ? "Click to mark read" : undefined}
              >
                <span className={"pev-ico " + m.cls}>
                  <Icon name={m.icon} />
                </span>
                <span className="pev-main">
                  {/* Ruling 291: a row with no sender says nothing about one.
                      The "−" claimed a fact in a glyph, and the bell popover
                      row for the same notification names no sender at all. */}
                  {n.from && (
                    <>
                      <strong className="act-actor">{n.from.name}</strong>
                      <span className="act-sep">·</span>
                    </>
                  )}
                  {/* U39-14: a titled notice (a decision packet, an approval)
                      carries the whole packet body as its text, and the stream
                      printed all of it: a deadlock notice was a fourteen-line
                      wall. It reads as the bell does now: the title, then the
                      body clamped to two lines; the task holds the rest. */}
                  {n.title ? (
                    <strong className="ntf-ev-title">{n.title}</strong>
                  ) : (
                    <RichText text={n.text} />
                  )}
                  {n.title && (
                    <span className="ntf-ev-text" data-clamped>
                      <RichText text={n.text} />
                    </span>
                  )}
                  {/* B-FD6: the link NAVIGATES, so it renders only when the row
                      has a destination. An org-wide row has none (nothing shown).
                      F18-1: an ORPHAN (its project was deleted) also has no
                      destination but MUST still say so — otherwise the row is
                      indistinguishable from a live one and the bell popover, which
                      still shows "project no longer exists", disagrees with it.
                      Ruling 280: it is the row's meta line, the bell row's
                      anatomy (title, body, where), not a mono keycap mid-
                      sentence. */}
                  {n.href !== null ? (
                    <span className="ntf-where">
                      <button
                        type="button"
                        className="linkish"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRead(n.id);
                          onOpen(n);
                        }}
                      >
                        {whereLabel(n)}
                      </button>
                    </span>
                  ) : n.targetMissing ? (
                    <span
                      className="ntf-where"
                      title="The project this refers to no longer exists"
                    >
                      {whereLabel(n)}
                    </span>
                  ) : null}
                </span>
                {/* Ruling 280: a button in the header's "Mark all read" idiom;
                    it was a mono keycap, the look of a task key. */}
                {n.unread && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    // `title` is NULL for every kind but the decision kinds, so
                    // concatenating it announced `Mark “null” read` — the row
                    // body's own fallback is the notification's identity.
                    aria-label={"Mark “" + (n.title || plainText(n.text)) + "” read"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRead(n.id);
                    }}
                  >
                    Mark read
                  </button>
                )}
                {n.unread && <span className="unread-dot" />}
                <span className="pev-t">
                  {(local ? formatClock : formatClockUTC)(n.occurredAt)}
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {!items.length && <div className="empty">You're caught up.</div>}
    </div>
  );
}

/** The inbox's two toggles, in render order — mirrors the activity page's
 *  `FILTERS`, which the mini-seg markup below is a copy of. */
const FILTERS: [NotificationFilter, string][] = [
  ["all", "All"],
  ["unread", "Unread"],
];

export function NotificationsPage({
  items,
  unread,
  decisionCount,
  truncated = false,
  limit,
  onRead,
  onReadAll,
  onOpen,
}: {
  items: NotificationPageItem[];
  unread: number;
  /** D-3 (pass 24): authoritative count of decisions this viewer must act on,
   *  from the loader (same source as home). Drives the "Waiting on you" header. */
  decisionCount: number;
  /** The loader capped the list — true once the most-recent window is full,
   *  so the page says so instead of silently dropping older rows (RU-4). */
  truncated?: boolean;
  /** The cap that was applied (only meaningful when `truncated`). */
  limit?: number;
  onRead: (id: string) => void;
  onReadAll: () => void;
  onOpen: (n: NotificationPageItem) => void;
}) {
  const [f, setF] = useState<NotificationFilter>("all");
  const { needs, rest, needsTotal } = splitNotifications(items, f);
  // F19-25: `unread` is the BELL BADGE number, and F18-1 deliberately drops
  // rows whose project no longer exists from it so a removed project cannot
  // inflate the badge. This page still RENDERS those rows — unread dot,
  // explicit "Mark read" — so counting the badge number here made the header
  // say "all caught up" above visible unread rows and, worse, withdrew the
  // "Mark all read" button, the one control that clears them in a single click
  // (`markAllNotificationsRead` has no project filter — only its trigger was
  // hidden). The header counts what the page shows. The two sets are disjoint:
  // the badge counts unread rows that are org-wide or whose project exists,
  // `targetMissing` is exactly the rows it excluded.
  const orphanUnread = items.filter((n) => n.unread && n.targetMissing).length;
  const shownUnread = unread + orphanUnread;

  return (
    <div className="board-wrap" data-screen-label="Notifications">
      <div className="board-head">
        <div>
          <h1>Notifications</h1>
          <div className="sub">
            Everything routed to you, across all projects
            {shownUnread > 0
              ? " · " + shownUnread + " unread"
              : " · all caught up"}
          </div>
        </div>
        <div className="board-tools">
          {/* UI-58/G3: `role="radiogroup"` with plain buttons is a broken ARIA
              contract (it promises radio-arrow navigation the markup never wires
              and conveys the active filter by CSS class alone). Mirror the
              activity page: `role="group"` + `aria-pressed` on each toggle —
              which is what this markup actually implements. */}
          <div
            className="mini-seg"
            role="group"
            aria-label="Filter notifications"
          >
            {FILTERS.map(([id, l]) => (
              <button
                type="button"
                key={id}
                className={f === id ? "on" : ""}
                aria-pressed={f === id}
                onClick={() => setF(id)}
              >
                {l}
              </button>
            ))}
          </div>
          {shownUnread > 0 && (
            <button type="button" className="btn ghost sm" onClick={onReadAll}>
              <Icon name="check" />
              Mark all read
            </button>
          )}
        </div>
      </div>
      <div className="policy-wrap">
        <NtfNeedsYou
          items={needs}
          total={needsTotal}
          decisionCount={decisionCount}
          onRead={onRead}
          onOpen={onOpen}
        />
        <NtfStream items={rest} onRead={onRead} onOpen={onOpen} />
        {truncated && (
          <p className="ntf-truncated sub">
            Showing the most recent {limit} notifications. Older ones aren't
            listed here.
          </p>
        )}
      </div>
    </div>
  );
}
