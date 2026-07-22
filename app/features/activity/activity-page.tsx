import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Icon, type IconName } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { formatClock } from "~/shared/dates/format";
import { AUDIT_MAX, AUDIT_STEP, STREAM_MAX, STREAM_STEP } from "./feed-limits";
import {
  auditTimeLabel,
  groupStreamByDay,
  matchesActorFilter,
  type ActivityStreamRowView,
  type ActorFilter,
  type AuditLogEntryView,
} from "./feed-helpers";

/**
 * F10-19: agent reports render into the activity stream at full length, so a
 * few long completion reports drown the scannable transitions/decisions. Short
 * events render inline as before; a long one shows a one-line preview with a
 * deliberate "Show more" toggle (the full markdown renders on expand), keeping
 * the stream scannable while preserving access to the whole report. The
 * per-row task-key deep link (kept by the callers) is the stable pointer to the
 * run/task itself.
 */
const ACTIVITY_TEXT_PREVIEW_LIMIT = 240;
function ActivityText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= ACTIVITY_TEXT_PREVIEW_LIMIT) {
    return <RichText text={text} mentions={false} />;
  }
  if (!expanded) {
    const preview = text
      .slice(0, ACTIVITY_TEXT_PREVIEW_LIMIT)
      .replace(/\s+\S*$/, "")
      .trim();
    return (
      <span className="act-collapsible">
        <span className="act-preview">{preview}… </span>
        <button
          type="button"
          className="keybtn act-toggle"
          aria-expanded={false}
          onClick={() => setExpanded(true)}
        >
          Show more
        </button>
      </span>
    );
  }
  return (
    <span className="act-collapsible">
      <RichText text={text} mentions={false} />{" "}
      <button
        type="button"
        className="keybtn act-toggle"
        aria-expanded={true}
        onClick={() => setExpanded(false)}
      >
        Show less
      </button>
    </span>
  );
}

/**
 * Project-wide cross-task activity stream and audit log.
 *
 * Read-only. The stream is a flattened projection over task_events
 * (loader), day-grouped here with the shared date formatter (ruling 4);
 * the mock's string-time hacks (`evMins`, `"now"`, DAY_ORDER) are gone.
 * Rich text renders through THE shared renderer with mentions off — the
 * mock's `RichA` variant (ruling 14; never fork app/ui/rich-text.tsx).
 * The actor filter does NOT touch the audit panel (mock behavior, kept).
 */

/** Stream event type → icon (mock ACT_ICON; unknown → dot). */
const ACT_ICON: Record<string, IconName> = {
  comment: "message",
  completion: "check",
  github: "github",
  policy: "shield",
  quality: "flag",
  transition: "arrow",
  blocked: "alert",
  agent: "agents",
  assign: "user",
};

/** Audit kind → icon + pev-ico tint class (mock PEV_META; unknown → change). */
const PEV_META: Record<string, { icon: IconName; cls: string }> = {
  violation: { icon: "alert", cls: "violation" },
  blockedact: { icon: "lock", cls: "blockedact" },
  change: { icon: "shield", cls: "change" },
  audit: { icon: "user", cls: "audit" },
};

function AuditLogs({
  entries,
  total,
  onOpen,
  onShowOlder,
}: {
  entries: AuditLogEntryView[];
  total: number;
  onOpen: (key: string) => void;
  onShowOlder: () => void;
}) {
  const remaining = Math.max(0, total - entries.length);
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="lock" />
        <h2>Audit logs</h2>
        <span
          className="right sub"
          style={{ fontSize: ".76rem", color: "var(--faint)" }}
        >
          policy &amp; access
        </span>
      </div>
      <div className="pev-list">
        {entries.map((e) => {
          const m = PEV_META[e.kind] ?? PEV_META.change!;
          const resolved = e.status === "resolved";
          return (
            <div className="pol-ev" key={e.id}>
              <span className={"pev-ico " + m.cls}>
                <Icon name={m.icon} />
              </span>
              <span className="pev-main">
                <ActivityText text={e.text} />
                {e.taskKey && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="keybtn"
                      onClick={() => onOpen(e.taskKey!)}
                    >
                      {e.taskKey}
                    </button>
                  </>
                )}
                {e.kind === "violation" && (
                  <>
                    {" "}
                    <span
                      title={
                        resolved
                          ? "Resolved" +
                            (e.resolvedBy ? ` by ${e.resolvedBy}` : "") +
                            (e.resolvedAt
                              ? ` · ${auditTimeLabel(e.resolvedAt)}`
                              : "")
                          : "Open — grant the missing scope to resolve"
                      }
                    >
                      <Pill kind={resolved ? "done" : "input"} sm>
                        {resolved ? "resolved" : "open"}
                      </Pill>
                    </span>
                  </>
                )}
              </span>
              <span className="pev-t">{auditTimeLabel(e.occurredAt)}</span>
            </div>
          );
        })}
        {entries.length === 0 && (
          <div
            style={{
              fontSize: ".85rem",
              color: "var(--faint)",
              padding: ".6rem 0",
            }}
          >
            No policy or access events yet.
          </div>
        )}
        {remaining > 0 && (
          <button
            type="button"
            className="btn ghost sm"
            style={{ width: "100%", marginTop: ".6rem" }}
            onClick={onShowOlder}
          >
            <Icon name="chevron" />
            Show older entries · {remaining} more
          </button>
        )}
      </div>
    </div>
  );
}

const FILTERS: [ActorFilter, string][] = [
  ["all", "All"],
  ["human", "Humans"],
  ["agent", "Agents"],
  ["system", "System"],
];

export function ActivityPage({
  projectSlug,
  projectName,
  stream,
  streamTotal,
  audit,
  auditTotal,
}: {
  projectSlug: string;
  projectName: string;
  stream: ActivityStreamRowView[];
  /** Total rows in the store (drives the "Show older" affordances). */
  streamTotal: number;
  audit: AuditLogEntryView[];
  auditTotal: number;
}) {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const [f, setF] = useState<ActorFilter>("all");
  const onOpen = (key: string) =>
    navigate(`/projects/${projectSlug}/tasks/${key}`);

  // "Show older" raises the loader limit via URL state (task-detail
  // `?events=` pattern; survives revalidation, no client accumulation).
  const showOlder = (param: "stream" | "audit", next: number) =>
    setSearchParams(
      (prev) => {
        const url = new URLSearchParams(prev);
        url.set(param, String(next));
        return url;
      },
      { replace: true, preventScrollReset: true },
    );

  const shown = groupStreamByDay(
    stream.filter((r) => matchesActorFilter(r, f)),
  );
  const total = shown.reduce((n, g) => n + g.rows.length, 0);
  const streamRemaining = Math.max(0, streamTotal - stream.length);

  return (
    <div className="board-wrap" data-screen-label="Activity">
      <div className="board-head">
        <div>
          <h1>Activity</h1>
          <div className="sub">
            Human decisions, agent events, and policy changes across{" "}
            {projectName}
          </div>
        </div>
        <div className="board-tools">
          <div className="mini-seg" role="radiogroup" aria-label="Filter activity">
            {FILTERS.map(([id, l]) => (
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
        </div>
      </div>

      <div className="policy-wrap">
        <div className="activity-cols">
          <div className="panel">
            <div className="panel-head">
              <Icon name="activity" />
              <h2>Stream</h2>
              <span
                className="right sub"
                style={{ fontSize: ".76rem", color: "var(--faint)" }}
              >
                {total} events
              </span>
            </div>
            {shown.map((g) => (
              <div key={g.day}>
                <div className="act-day">{g.day}</div>
                {g.rows.map((r) => (
                  <div className="pol-ev" key={r.id}>
                    <span className={"pev-ico act-" + r.type}>
                      <Icon name={ACT_ICON[r.type] ?? "dot"} />
                    </span>
                    <span className="pev-main">
                      <strong className="act-actor">
                        {r.actor ? r.actor.name : "—"}
                      </strong>
                      <span className="act-sep">·</span>
                      <ActivityText text={r.text} />{" "}
                      <button
                        type="button"
                        className="keybtn"
                        onClick={() => onOpen(r.taskKey)}
                      >
                        {r.taskKey}
                      </button>
                    </span>
                    <span className="pev-t">{formatClock(r.occurredAt)}</span>
                  </div>
                ))}
              </div>
            ))}
            {!shown.length && (
              <div
                style={{
                  fontSize: ".85rem",
                  color: "var(--faint)",
                  padding: ".6rem 0",
                }}
              >
                {stream.length === 0
                  ? "No activity yet."
                  : "No events match this filter."}
              </div>
            )}
            {streamRemaining > 0 && (
              <button
                type="button"
                className="btn ghost sm"
                style={{ width: "100%", marginTop: ".6rem" }}
                onClick={() =>
                  showOlder(
                    "stream",
                    Math.min(stream.length + STREAM_STEP, STREAM_MAX),
                  )
                }
              >
                <Icon name="chevron" />
                Show older events · {streamRemaining} more
              </button>
            )}
          </div>

          <AuditLogs
            entries={audit}
            total={auditTotal}
            onOpen={onOpen}
            onShowOlder={() =>
              showOlder("audit", Math.min(audit.length + AUDIT_STEP, AUDIT_MAX))
            }
          />
        </div>
      </div>
    </div>
  );
}
