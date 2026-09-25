import { useState } from "react";
import type { AuditActorOption } from "~/server/projections/activity-feed.server";
import { useNavigate, useSearchParams } from "react-router";
import { Icon, type IconName } from "~/ui/icon";
import { useHydrated } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { plainText } from "~/features/notifications/notification-meta";
import { DatePicker } from "~/ui/date-picker";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import { TIMELINE_EVENT_TYPES } from "~/schemas/task-file.schema";
import { AUDIT_MAX, AUDIT_STEP, STREAM_MAX, STREAM_STEP } from "./feed-limits";
import {
  auditTimeLabel,
  auditTimeLabelUTC,
  groupStreamByDay,
  groupStreamByDayUTC,
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
    // The collapsed line is plain text, so markdown marks must not leak into
    // it as literal ** and backticks — same stripper the notification
    // previews use.
    const preview = plainText(text)
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
const ACT_ICON = {
  comment: "message",
  completion: "check",
  github: "github",
  policy: "shield",
  note: "message",
  quality: "flag",
  continuity: "refresh",
  proposal: "edit",
  transition: "arrow",
  blocked: "alert",
  agent: "agents",
  assign: "user",
} as const satisfies Record<(typeof TIMELINE_EVENT_TYPES)[number], IconName>;

/** Whether a projected stream type is one of the contract's own. */
function isStreamEventType(
  type: string,
): type is (typeof TIMELINE_EVENT_TYPES)[number] {
  return TIMELINE_EVENT_TYPES.some((known) => known === type);
}

/** The row icon for a stream type. The projection keeps unknown strings as-is
 *  (tolerant-parsing contract), so a type outside the vocabulary still falls
 *  back to the neutral dot rather than throwing. */
export function actIcon(type: string): IconName {
  return isStreamEventType(type) ? ACT_ICON[type] : "dot";
}

/** One audit row's glyph + `pev-ico` tint class. */
interface AuditKindMeta {
  icon: IconName;
  cls: string;
}

/** Audit kind → icon + pev-ico tint class (mock PEV_META; unknown → change).
 *  Open by contract: an audit kind this map has never seen falls back below. */
interface AuditKindTable {
  [kind: string]: AuditKindMeta;
}

const PEV_META: AuditKindTable = {
  violation: { icon: "alert", cls: "violation" },
  blockedact: { icon: "lock", cls: "blockedact" },
  change: { icon: "shield", cls: "change" },
  audit: { icon: "user", cls: "audit" },
};

/* ------------------------------------------ R19-7: audit-column compaction */

/**
 * R19-7 — consecutive runtime-session-open rows compact into one expandable
 * row.
 *
 * Live on a 1440px viewport, 8 of the 9 rows this column had room for read
 * "operator opened the <role> runtime session — recorded per audit policy on
 * VC-4". One piece of routine agent bookkeeping, repeated, pushed the events
 * the column exists for — a credential assigned, scopes re-checked, a role
 * changed, the project created — below the fold. That is the "calm over
 * chatter / human attention is scarce" principles inverted: the noisiest event
 * won the most space.
 *
 * The event stays RECORDED (audit policy requires it) and stays REACHABLE (one
 * click, with its real per-row timestamp). It just stops being repeated at the
 * reader.
 *
 * Shape borrowed from the timeline's anti-noise compaction
 * (`app/server/tasks/timeline-compaction.server.ts`): a pure function over a
 * newest-first list that walks it once, collects each RUN of consecutive
 * routine events, and replaces a run with a single marker carrying the count —
 * including its "a run too short to be worth a marker stays verbatim" rule.
 * The one deliberate difference is what a marker holds: the server's rewrites
 * canonical `task.md` and keeps only a count, so the events are gone; this one
 * keeps its entries and hands them back on expand, because nothing here is
 * being deleted — only folded.
 */

/**
 * A `runtime.run.started` row, recognised by the sentence its projection
 * writes: `${actor} opened the ${role} runtime session. Recorded per audit
 * policy on` (`app/server/projections/activity-feed.server.ts`, the
 * `runtime.run.started` case). `AuditLogEntryView` carries no action name —
 * only the display kind and the rendered text — and threading one through
 * would mean editing the projection, its row type and the loader for a purely
 * visual fold. The co-located test pins this pattern against the projection's
 * OWN template text, so rewording that sentence fails the test rather than
 * silently un-compacting the column.
 *
 * The pattern matches the projection's WHOLE trailing sentence, anchored at the
 * end, and that anchoring is load-bearing rather than tidiness. `entry.text`
 * OPENS with the actor's display name, which any member sets for themselves on
 * the profile page — a member named `Mallory (opened the dev runtime session)`
 * satisfied the earlier unanchored `\bopened the .+ runtime session\b` on every
 * row they authored, which included their own `task.acceptance.forced` and
 * `project.org_admin.override` rows: the two overrides this column exists to
 * make visible would fold behind a "2 runtime sessions opened" summary. Nothing
 * was deleted — expand still gave them back — but a fold the actor picks is a
 * fold that hides the row from the reader who never expands it.
 *
 * A display name cannot reach the end of the string: every audit template puts
 * fixed words after `${actor}`, and no other one ends in `runtime session.
 * Recorded per audit policy on` (`runtime.run.interrupted` ends `agent run.
 * …`, `github.reconcile.project` `GitHub. …`, `task.ownership.admin_released`
 * `task owner. …`, `task.acceptance.forced` and the overrides elsewhere
 * entirely). The trailing ` on` is the task-chip dangler, which every run row
 * keeps: `startRun` always audits with a `taskKey`, so `finishText` never
 * rewrites it to `.`.
 */
const RUNTIME_SESSION_OPENED =
  /\bopened the .+ runtime session\. Recorded per audit policy on$/;

export function isRuntimeSessionOpen(entry: AuditLogEntryView): boolean {
  return entry.kind === "audit" && RUNTIME_SESSION_OPENED.test(entry.text);
}

/** A run shorter than this renders verbatim: one row replaced by one summary
 *  row is no saving — the timeline compaction's own `folded.length <= 1` rule,
 *  and it keeps the FIRST session of a quiet project fully legible. */
export const AUDIT_COMPACT_MIN = 2;

export type AuditFeedRow =
  | { compacted: false; entry: AuditLogEntryView }
  | { compacted: true; key: string; entries: AuditLogEntryView[] };

/**
 * The audit column's render list: every entry in order, with each run of
 * consecutive runtime-session opens replaced by one compacted row holding that
 * run. Never reorders, never drops an entry, and never folds anything else —
 * a credential assignment sitting between two sessions splits the run, exactly
 * as it splits the reader's attention.
 */
export function compactAuditEntries(
  entries: AuditLogEntryView[],
  min: number = AUDIT_COMPACT_MIN,
): AuditFeedRow[] {
  const rows: AuditFeedRow[] = [];
  let run: AuditLogEntryView[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length < min) {
      for (const entry of run) rows.push({ compacted: false, entry });
    } else {
      rows.push({ compacted: true, key: `sessions:${run[0]!.id}`, entries: run });
    }
    run = [];
  };
  for (const entry of entries) {
    if (isRuntimeSessionOpen(entry)) {
      run.push(entry);
      continue;
    }
    flush();
    rows.push({ compacted: false, entry });
  }
  flush();
  return rows;
}

function AuditRow({
  entry,
  sub,
  timeLabel,
  onOpen,
}: {
  entry: AuditLogEntryView;
  /** One of the rows a compacted summary stands for, revealed in place. */
  sub?: boolean;
  timeLabel: (iso: string) => string;
  onOpen: (key: string) => void;
}) {
  const m = PEV_META[entry.kind] ?? PEV_META.change!;
  const resolved = entry.status === "resolved";
  // What the pill's one word does not say: who resolved it and when, or how to.
  const verdictDetail = resolved
    ? (entry.resolvedBy ? ` by ${entry.resolvedBy}` : "") +
      (entry.resolvedAt ? ` · ${timeLabel(entry.resolvedAt)}` : "")
    : ": grant the missing scope to resolve";
  return (
    <div className={sub ? "pol-ev pev-sub" : "pol-ev"}>
      <span className={"pev-ico " + m.cls}>
        <Icon name={m.icon} />
      </span>
      <span className="pev-main">
        <ActivityText text={entry.text} />
        {entry.taskKey && (
          <>
            {" "}
            <button
              type="button"
              className="keybtn"
              onClick={() => onOpen(entry.taskKey!)}
            >
              {entry.taskKey}
            </button>
          </>
        )}
        {entry.kind === "violation" && (
          <>
            {" "}
            <span title={(resolved ? "Resolved" : "Open") + verdictDetail}>
              <Pill kind={resolved ? "done" : "input"} sm>
                {resolved ? "resolved" : "open"}
              </Pill>
              {/* Interface review 2026-09-24 (acce-5): the title is the
                  pointer's extra; the rest of the sentence reaches touch,
                  keyboard and screen readers as `.vh` after the pill. */}
              {verdictDetail && <span className="vh">{verdictDetail}</span>}
            </span>
          </>
        )}
      </span>
      <span className="pev-t">{timeLabel(entry.occurredAt)}</span>
    </div>
  );
}

/**
 * The compacted row. Collapsed it is one line — the count, the audit fact, and
 * the toggle that gives the rows back; expanded it keeps that line and renders
 * every folded row beneath it with its own real timestamp, so "when did the
 * reviewer session open" is still answerable without leaving the page.
 *
 * The glyph is the agent mark rather than the audit column's generic `user`:
 * naming the summary as agent bookkeeping is exactly the distinction that makes
 * the fold safe to skim past.
 */
function CompactedSessions({
  entries,
  timeLabel,
  onOpen,
}: {
  entries: AuditLogEntryView[];
  timeLabel: (iso: string) => string;
  onOpen: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <div className="pol-ev">
        <span className="pev-ico audit">
          <Icon name="agents" />
        </span>
        <span className="pev-main">
          <strong>{entries.length} runtime sessions opened</strong>, each one
          recorded per audit policy.{" "}
          <button
            type="button"
            className="keybtn act-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide sessions" : "Show each"}
          </button>
        </span>
        {/* Entries arrive newest-first, so the summary carries the newest of
            the run — the same anchor the timeline marker uses. */}
        <span className="pev-t">{timeLabel(entries[0]!.occurredAt)}</span>
      </div>
      {expanded &&
        entries.map((entry) => (
          <AuditRow
            key={entry.id}
            entry={entry}
            sub
            timeLabel={timeLabel}
            onOpen={onOpen}
          />
        ))}
    </>
  );
}

function AuditLogs({
  entries,
  total,
  filtered,
  utc,
  actorOptions,
  onOpen,
  onShowOlder,
}: {
  entries: AuditLogEntryView[];
  total: number;
  /** One of the panel's own URL filters is on, so `total` counts matches. */
  filtered: boolean;
  /** Timezone-agnostic first-pass rendering until hydration (see ActivityPage). */
  utc: boolean;
  /** Everyone who ever wrote an audit row, for the actor filter — the stored
   *  label as the value, a display name as the label (E32-8). */
  actorOptions: AuditActorOption[];
  onOpen: (key: string) => void;
  onShowOlder: () => void;
}) {
  const timeLabel = utc ? auditTimeLabelUTC : auditTimeLabel;
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
        <span className="right sub fine">
          {/* UI-46 said "all actors" while this panel had no filter of its own;
              it has one now (P21), so the honest header is the same count the
              Stream carries — of the rows MATCHING the panel's filters. */}
          policy &amp; access · {entries.length} of {total} entries
          {filtered ? " (filtered)" : ""}
        </span>
      </div>
      {/* Design pass 2026-09-08: the bar renders only for a log longer than
          one page. A one-entry log carried five controls above it — the
          filter apparatus was larger than the content it filtered — and a
          list you can read whole does not need a search.
          Interface review 2026-09-24 (writ-7): `total` is the FILTERED count,
          so a filter that narrowed a long log below one page unmounted the
          search box and its Clear. The bar stays while any filter is on. */}
      {(total > AUDIT_STEP || filtered) && (
        <FeedFilters
          legend="audit logs"
          params={AUDIT_PARAMS}
          typeLabel="kind"
          typeOptions={AUDIT_KIND_OPTIONS}
          actorOptions={actorOptions}
        />
      )}
      <div className="pev-list">
        {compactAuditEntries(entries).map((row) =>
          row.compacted ? (
            <CompactedSessions
              key={row.key}
              entries={row.entries}
              timeLabel={timeLabel}
              onOpen={onOpen}
            />
          ) : (
            <AuditRow
              key={row.entry.id}
              entry={row.entry}
              timeLabel={timeLabel}
              onOpen={onOpen}
            />
          ),
        )}
        {entries.length === 0 && (
          <div className="feed-empty">
            {filtered
              ? "No entries match these filters."
              : "No policy or access events yet."}
          </div>
        )}
        {remaining > 0 && (
          <button
            type="button"
            className="btn ghost sm more-act"
            onClick={onShowOlder}
          >
            <Icon name="chevron" />
            Show older entries · {remaining} more
          </button>
        )}
        {capped && (
          <div className="feed-capped">
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

/* --------------------------------------------- per-panel filters (P21) */

/** The audit panel's four display kinds, as its type filter's vocabulary. */
const AUDIT_KIND_OPTIONS: { value: string; label: string }[] = [
  { value: "violation", label: "violations" },
  { value: "blockedact", label: "blocked actions" },
  { value: "change", label: "changes" },
  { value: "audit", label: "audit notes" },
];

/** The URL params one panel's filter bar owns (stream and audit each get
 *  their own set, so filtering one never disturbs the other). */
interface FeedFilterParams {
  q: string;
  type: string;
  actor: string;
  task: string;
  from: string;
  to: string;
}

const STREAM_PARAMS: FeedFilterParams = {
  q: "sq",
  type: "sty",
  actor: "sac",
  task: "stk",
  from: "sfrom",
  to: "sto",
};

const AUDIT_PARAMS: FeedFilterParams = {
  q: "aq",
  type: "aky",
  actor: "aac",
  task: "atk",
  from: "afrom",
  to: "ato",
};

/** Is any of one panel's URL filters set? The loader applies them server-side,
 *  so while one is on, the panel's rows AND its total describe the matches,
 *  not the project. */
function feedFiltersActive(
  searchParams: URLSearchParams,
  params: FeedFilterParams,
): boolean {
  return Object.values(params).some(
    (name) => (searchParams.get(name) ?? "") !== "",
  );
}

/**
 * One panel's filter bar: search, a type/kind pick, an actor pick, a task id,
 * and a date range — all URL-driven (the board's own `?q=` pattern: the param
 * IS the state, so filters survive revalidation and are shareable), applied
 * server-side by the loader so "X of Y" stays the truth about the store, not
 * about the loaded slice.
 */
function FeedFilters({
  legend,
  params,
  typeLabel,
  typeOptions,
  actorOptions,
}: {
  legend: string;
  params: FeedFilterParams;
  /** "type" for the stream's event types, "kind" for the audit categories. */
  typeLabel: string;
  typeOptions: { value: string; label: string }[];
  actorOptions: { value: string; label: string }[];
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const get = (name: string) => searchParams.get(name) ?? "";
  const setParam = (name: string, value: string) =>
    setSearchParams(
      (prev) => {
        const url = new URLSearchParams(prev);
        if (value) url.set(name, value);
        else url.delete(name);
        return url;
      },
      { replace: true, preventScrollReset: true },
    );
  const names = Object.values(params);
  const active = feedFiltersActive(searchParams, params);
  return (
    <div className="feed-filters" role="group" aria-label={legend}>
      <label className="ff-search">
        <Icon name="filter" />
        <input
          type="search"
          value={get(params.q)}
          placeholder="Search…"
          aria-label={`Search the ${legend}`}
          onChange={(e) => setParam(params.q, e.target.value)}
        />
      </label>
      <select
        className="ff-sel"
        value={get(params.type)}
        aria-label={`Filter the ${legend} by ${typeLabel}`}
        onChange={(e) => setParam(params.type, e.target.value)}
      >
        <option value="">any {typeLabel}</option>
        {typeOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="ff-sel"
        value={get(params.actor)}
        aria-label={`Filter the ${legend} by actor`}
        onChange={(e) => setParam(params.actor, e.target.value)}
      >
        <option value="">any actor</option>
        {actorOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <input
        className="ff-task mono"
        type="search"
        value={get(params.task)}
        placeholder="Task id"
        aria-label={`Filter the ${legend} by task id`}
        onChange={(e) => setParam(params.task, e.target.value)}
      />
      {/* Pass 30: the app's ONE date-entry control (the task pages' custom
          DatePicker) — the feeds were the only surface still shipping native
          date inputs, a second visual idiom for the same act. */}
      <span className="ff-datepick">
        <DatePicker
          value={get(params.from) || null}
          placeholder="From"
          label={`From date for the ${legend}`}
          onChange={(iso) => setParam(params.from, iso ?? "")}
        />
      </span>
      <span className="ff-dash" aria-hidden="true">
        to
      </span>
      <span className="ff-datepick">
        <DatePicker
          value={get(params.to) || null}
          placeholder="To"
          label={`To date for the ${legend}`}
          onChange={(iso) => setParam(params.to, iso ?? "")}
        />
      </span>
      {active && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() =>
            setSearchParams(
              (prev) => {
                const url = new URLSearchParams(prev);
                for (const name of names) url.delete(name);
                return url;
              },
              { replace: true, preventScrollReset: true },
            )
          }
        >
          <Icon name="x" />
          Clear
        </button>
      )}
    </div>
  );
}

export function ActivityPage({
  projectSlug,
  projectName,
  stream,
  streamTotal,
  audit,
  auditTotal,
  streamOptions,
  auditActors,
}: {
  projectSlug: string;
  projectName: string;
  stream: ActivityStreamRowView[];
  /** Total rows MATCHING the panel's filters (drives "X of Y" + "Show older"). */
  streamTotal: number;
  audit: AuditLogEntryView[];
  auditTotal: number;
  /** The stream's filter vocabulary (actors by stable ref, event types). */
  streamOptions: { actors: { ref: string; label: string }[]; types: string[] };
  /** The audit panel's actor options (stored label → display name). */
  auditActors: AuditActorOption[];
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [f, setF] = useState<ActorFilter>("all");
  // Interface review 2026-09-24 (writ-7): the loader filters server-side, so
  // an empty `stream` under a URL filter means "no match", not "no activity".
  const streamFiltered = feedFiltersActive(searchParams, STREAM_PARAMS);
  const auditFiltered = feedFiltersActive(searchParams, AUDIT_PARAMS);
  // Every timestamp on this page is viewer-local, but the server renders in
  // ITS zone (a UTC container in production), so the local forms hydrate to
  // different text — a recoverable React #418 that regenerates the whole page
  // client-side. Until hydration flips this flag, day groups and clocks render
  // timezone-AGNOSTIC UTC forms (absolute days, UTC clocks); an effect then
  // swaps in the viewer-local forms (the app/ui/local-time.tsx pattern).
  const local = useHydrated();
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

  const filtered = stream.filter((r) => matchesActorFilter(r, f));
  const shown = local
    ? groupStreamByDay(filtered)
    : groupStreamByDayUTC(filtered);
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
              <span className="right act-filter-right">
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
                <span className="sub fine">
                  {/* UI-47: `total` counts the FILTERED, already-bounded loaded
                      slice — it never described the project. Say what it is. */}
                  {total} of {streamTotal} events
                  {f !== "all" || streamFiltered ? " (filtered)" : ""}
                </span>
              </span>
            </div>
            <FeedFilters
              legend="activity stream"
              params={STREAM_PARAMS}
              typeLabel="type"
              typeOptions={streamOptions.types.map((type) => ({
                value: type,
                label: type,
              }))}
              actorOptions={streamOptions.actors.map((a) => ({
                value: a.ref,
                label: a.label,
              }))}
            />
            {shown.map((g) => (
              <div key={g.day}>
                <div className="act-day">{g.day}</div>
                {g.rows.map((r) => (
                  <div className="pol-ev" key={r.id}>
                    <span className={"pev-ico act-" + r.type}>
                      <Icon name={actIcon(r.type)} />
                    </span>
                    <span className="pev-main">
                      {/* Ruling 148: a row with no actor says nothing about
                          one. The "−" claimed a fact in a glyph, and it sat in
                          the slot every other row fills with a name, so it read
                          as a remove control. Same treatment as the sibling
                          feed in `notifications-page.tsx`. */}
                      {r.actor && (
                        <>
                          <strong className="act-actor">{r.actor.name}</strong>
                          <span className="act-sep">·</span>
                        </>
                      )}
                      <ActivityText text={r.text} />{" "}
                      <button
                        type="button"
                        className="keybtn"
                        onClick={() => onOpen(r.taskKey)}
                      >
                        {r.taskKey}
                      </button>
                    </span>
                    <span className="pev-t">
                      {(local ? formatClock : formatClockUTC)(r.occurredAt)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {!shown.length && (
              <div className="feed-empty">
                {stream.length === 0 && !streamFiltered
                  ? "No activity yet."
                  : "No events match these filters."}
              </div>
            )}
            {streamRemaining > 0 && (
              <button
                type="button"
                className="btn ghost sm more-act"
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
              <div className="sub feed-capped">
                Showing the newest {STREAM_MAX} events. Older activity stays in
                the task timelines.
              </div>
            )}
          </div>

          <AuditLogs
            entries={audit}
            total={auditTotal}
            filtered={auditFiltered}
            utc={!local}
            actorOptions={auditActors}
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
