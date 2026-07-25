import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Icon, type IconName } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { formatClock } from "~/shared/dates/format";
import { TIMELINE_EVENT_TYPES } from "~/schemas/task-file.schema";
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

/**
 * Stream event type → icon (mock ACT_ICON; an unknown string still → dot).
 *
 * P14-UI-62: pass 13 added the neutral `note` type and moved every benign
 * governance event onto it (a goal edit, a divergence note, a scheduled re-run)
 * so they stop rendering as "Policy violation" — and this map never learned the
 * word. `note` took the unknown-type `dot` fallback and emitted an `act-note`
 * tint class that `app.css` did not define, so the de-alarmed events rendered
 * typeless and untinted in the one cross-task feed members triage. Keying the
 * map on TIMELINE_EVENT_TYPES makes the next added type a COMPILE error here
 * instead of a silent dot.
 */
const ACT_ICON: Record<(typeof TIMELINE_EVENT_TYPES)[number], IconName> = {
  comment: "message",
  completion: "check",
  github: "github",
  policy: "shield",
  note: "message",
  quality: "flag",
  transition: "arrow",
  blocked: "alert",
  agent: "agents",
  assign: "user",
};

/** The row icon for a stream type. The projection keeps unknown strings as-is
 *  (tolerant-parsing contract), so a type outside the vocabulary still falls
 *  back to the neutral dot rather than throwing. */
export function actIcon(type: string): IconName {
  return ACT_ICON[type as (typeof TIMELINE_EVENT_TYPES)[number]] ?? "dot";
}

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
  // UI-47: bound "remaining" by the ceiling `onShowOlder` can actually reach —
  // at AUDIT_MAX the button was a no-op that still promised N more.
  const remaining = Math.max(
    0,
    Math.min(total, AUDIT_MAX) - entries.length,
  );
  const capped = entries.length >= AUDIT_MAX && total > AUDIT_MAX;
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="lock" />
        <h2>Audit logs</h2>
        <span
          className="right sub"
          style={{ fontSize: ".76rem", color: "var(--faint)" }}
        >
          {/* UI-46: this panel is deliberately UNFILTERED — say so, now that the
              actor filter sits inside the Stream panel and no longer looks
              page-level. */}
          policy &amp; access · all actors
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
        {capped && (
          <div
            style={{
              fontSize: ".78rem",
              color: "var(--faint)",
              padding: ".6rem 0 0",
            }}
          >
            Showing the newest {AUDIT_MAX} entries.
          </div>
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
  // UI-47: "Show older" submits `min(loaded + STEP, STREAM_MAX)`, so once the
  // loaded slice hits the ceiling the click is a NO-OP — while the button still
  // promised "N more". Compute what can actually still be loaded.
  const streamRemaining = Math.max(
    0,
    Math.min(streamTotal, STREAM_MAX) - stream.length,
  );
  const streamCapped = stream.length >= STREAM_MAX && streamTotal > STREAM_MAX;

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
      </div>

      <div className="policy-wrap">
        <div className="activity-cols">
          <div className="panel">
            <div className="panel-head">
              <Icon name="activity" />
              <h2>Stream</h2>
              {/* UI-46: the actor filter lived in the PAGE header, above both
                  panels and labelled "Filter activity", but only the Stream ever
                  consumed it — the audit panel kept showing agent and system
                  rows after picking "Humans", so the filter looked broken (or
                  those rows looked human). It sits inside the panel it filters
                  now, and says so.
                  UI-58: `role="radiogroup"` with plain buttons is a broken ARIA
                  contract; `aria-pressed` on each toggle is what the markup
                  actually implements. */}
              <span className="right" style={{ display: "flex", gap: ".5rem", alignItems: "center" }}>
                <span className="mini-seg" role="group" aria-label="Filter the stream by actor">
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
                </span>
                <span
                  className="sub"
                  style={{ fontSize: ".76rem", color: "var(--faint)" }}
                >
                  {/* UI-47: `total` counts the FILTERED, already-bounded loaded
                      slice — it never described the project. Say what it is. */}
                  {total} of {streamTotal} events
                  {f !== "all" ? " (filtered)" : ""}
                </span>
              </span>
            </div>
            {shown.map((g) => (
              <div key={g.day}>
                <div className="act-day">{g.day}</div>
                {g.rows.map((r) => (
                  <div className="pol-ev" key={r.id}>
                    <span className={"pev-ico act-" + r.type}>
                      <Icon name={actIcon(r.type)} />
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
            {streamCapped && (
              <div
                className="sub"
                style={{
                  fontSize: ".78rem",
                  color: "var(--faint)",
                  padding: ".6rem 0 0",
                }}
              >
                Showing the newest {STREAM_MAX} events — older activity stays in
                the task timelines.
              </div>
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
