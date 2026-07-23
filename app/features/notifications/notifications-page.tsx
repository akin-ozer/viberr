import { useState } from "react";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { formatClock, formatDayBucket } from "~/shared/dates/format";
import { ntfMeta, ntfPill } from "./notification-meta";
import {
  needsYouTime,
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
 * GLOBAL cross-project page, so the project pill / keybtn project prefix
 * render for every row with a known project — the mock hid them for its
 * hard-coded "Viberr Core" workspace, a literal the porting notes say must
 * not survive.
 */

function keybtnLabel(n: NotificationPageItem): string {
  return (n.projectName ? n.projectName + " · " : "") + (n.taskKey ?? "");
}

function NtfNeedsYou({
  items,
  onRead,
  onOpen,
}: {
  items: NotificationPageItem[];
  onRead: (id: string) => void;
  onOpen: (n: NotificationPageItem) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="hand" />
        <h2>Waiting on you</h2>
        <span
          className="right sub"
          style={{ fontSize: ".76rem", color: "var(--faint)" }}
        >
          {items.length} decision{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="rq-list">
        {items.map((n) => {
          const m = ntfMeta(n);
          const p = ntfPill(n);
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
                  {n.title}
                  {n.unread && <span className="unread-dot in" />}
                </div>
                <div className="sub">
                  <span className="mono">{n.taskKey}</span> ·{" "}
                  <RichText text={n.text} mentions={false} />
                </div>
              </span>
              <span className="rq-meta">
                {n.projectName && (
                  <Pill kind="neutral" sm>
                    {n.projectName}
                  </Pill>
                )}
                <Pill kind={p.kind} sm>
                  {p.label}
                </Pill>
                <span className="pev-t">{needsYouTime(n.occurredAt)}</span>
              </span>
            </button>
          );
        })}
        {!items.length && (
          <div className="empty">Nothing is waiting on you.</div>
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
  const now = new Date();
  const days = [...new Set(items.map((n) => formatDayBucket(n.occurredAt, now)))];
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="bell" />
        <h2>Everything else</h2>
      </div>
      {days.map((day) => (
        <div key={day}>
          <div className="act-day">{day}</div>
          {items.flatMap((n) => {
            if (formatDayBucket(n.occurredAt, now) !== day) return [];
            const m = ntfMeta(n);
            return (
              <div
                className={"pol-ev ntf-ev" + (n.unread ? " unread" : "")}
                key={n.id}
                role="button"
                tabIndex={0}
                onClick={() => onRead(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onRead(n.id);
                  }
                }}
                title={n.unread ? "Click to mark read" : undefined}
              >
                <span className={"pev-ico " + m.cls}>
                  <Icon name={m.icon} />
                </span>
                <span className="pev-main">
                  <strong className="act-actor">
                    {n.from ? n.from.name : "—"}
                  </strong>
                  <span className="act-sep">·</span>
                  <RichText text={n.text} mentions={false} />{" "}
                  <button
                    type="button"
                    className="keybtn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRead(n.id);
                      onOpen(n);
                    }}
                  >
                    {keybtnLabel(n)}
                  </button>
                </span>
                {n.unread && <span className="unread-dot" />}
                <span className="pev-t">{formatClock(n.occurredAt)}</span>
              </div>
            );
          })}
        </div>
      ))}
      {!items.length && <div className="empty">You're caught up.</div>}
    </div>
  );
}

export function NotificationsPage({
  items,
  unread,
  onRead,
  onReadAll,
  onOpen,
}: {
  items: NotificationPageItem[];
  unread: number;
  onRead: (id: string) => void;
  onReadAll: () => void;
  onOpen: (n: NotificationPageItem) => void;
}) {
  const [f, setF] = useState<NotificationFilter>("all");
  const { needs, rest } = splitNotifications(items, f);

  return (
    <div className="board-wrap" data-screen-label="Notifications">
      <div className="board-head">
        <div>
          <h1>Notifications</h1>
          <div className="sub">
            Everything routed to you, across all projects
            {unread > 0 ? " · " + unread + " unread" : " · all caught up"}
          </div>
        </div>
        <div className="board-tools">
          <div
            className="mini-seg"
            role="radiogroup"
            aria-label="Filter notifications"
          >
            {(
              [
                ["all", "All"],
                ["unread", "Unread"],
              ] as [NotificationFilter, string][]
            ).map(([id, l]) => (
              <button
                type="button"
                key={id}
                className={f === id ? "on" : ""}
                onClick={() => setF(id)}
              >
                {l}
              </button>
            ))}
          </div>
          {unread > 0 && (
            <button type="button" className="btn ghost sm" onClick={onReadAll}>
              <Icon name="check" />
              Mark all read
            </button>
          )}
        </div>
      </div>
      <div className="policy-wrap">
        <NtfNeedsYou items={needs} onRead={onRead} onOpen={onOpen} />
        <NtfStream items={rest} onRead={onRead} onOpen={onOpen} />
      </div>
    </div>
  );
}
