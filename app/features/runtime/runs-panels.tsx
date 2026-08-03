import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentGlyph } from "~/ui/identity";
import { Icon } from "~/ui/icon";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import { useHydrated } from "~/ui/local-time";

/** P13-UI-57: the projection ships the ISO so the CLIENT renders the clock in
 *  the viewer's zone. During SSR + hydration the UTC form is rendered instead
 *  (`hydrated: false`) — the server's zone and the viewer's differ, and a
 *  zone-dependent first paint is a hydration text mismatch (React #418). A
 *  seeded/mock label that isn't an ISO is shown verbatim. */
function finishedClock(value: string, hydrated: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  return hydrated ? formatClock(value) : formatClockUTC(value);
}
import { Pill } from "~/ui/pill";
import {
  fmtClock,
  fmtTok,
  roleShort,
  RUN_STATE,
  runLabel,
  runStatePill,
  useElapsed,
} from "./runs-helpers";
import { localLogClock } from "./log-clock";
import { collapseTelemetry, telemetryLabel } from "./log-noise";
import { isRunBoundary, type RunView } from "./runtime-types";
import type { OlderLogState, StreamedLine } from "./use-run-log-stream";

/**
 * Port of runs.jsx: LiveRunPanel (run strip) + AgentLogsPanel (dark console)
 * + AgentPicker (shared dropdown) + RunGlyph. Structure, class names and copy
 * are 1:1 with the mock (runs.md §4). Prototype bits replaced: fake token
 * growth removed (real usage on the RunView), elapsed from startedAt, live
 * lines from the dedicated SSE consumer, interrupt is a real governed action.
 */

// --------------------------------------------------------------- RunGlyph

function RunGlyph({ run }: { run: RunView }) {
  if (run.op) return <AgentGlyph op />;
  return <AgentGlyph backend={run.backend} />;
}

// ------------------------------------------------------------ AgentPicker

/**
 * Shared listbox dropdown. Adds Escape-close + arrow-key navigation over the
 * mock (which only had outside-mousedown close); keeps the exact ARIA.
 */
function AgentPicker({
  items,
  value,
  onChange,
  label,
}: {
  items: RunView[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = items.find((r) => r.id === value) || items[0]!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const move = (dir: 1 | -1) => {
    const idx = items.findIndex((r) => r.id === cur.id);
    const next = items[(idx + dir + items.length) % items.length]!;
    onChange(next.id);
  };

  return (
    <div className="rsel" ref={ref}>
      <button
        type="button"
        className={"rsel-btn" + (open ? " open" : "")}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (open) move(1);
            else setOpen(true);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (open) move(-1);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        <RunGlyph run={cur} />
        <span className="rsel-nm">
          {cur.who.name}
          <span className="rsel-role"> · {roleShort(cur)}</span>
        </span>
        <span className={"rdot " + cur.state} />
        <Icon name="chevron" className="caret" />
      </button>
      {open && (
        <div className="rsel-menu" role="listbox" aria-label={label}>
          {items.map((r) => (
            <button
              type="button"
              key={r.id}
              role="option"
              aria-selected={r.id === cur.id}
              className={"rsel-item" + (r.id === cur.id ? " on" : "")}
              onClick={() => {
                onChange(r.id);
                setOpen(false);
              }}
            >
              <RunGlyph run={r} />
              <span className="ri-txt">
                <span className="ri-nm">{runLabel(r)}</span>
                <span className="ri-sub">
                  {r.role} · {r.sdk}
                </span>
              </span>
              <span className={"ri-state " + r.state}>
                <span className={"rdot " + r.state} />
                {RUN_STATE[r.state].label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------- LiveRunPanel

/**
 * The "Live run" strip — shown only while at least one run is `running`.
 * Elapsed derives from startedAt (client clock); the token counter is real
 * cumulative usage (NO fabricated growth). Interrupt is a real governed
 * action (RBAC-gated in the action); the button hides when the viewer can't
 * interrupt.
 */
export function LiveRunPanel({
  runtime,
  onViewLogs,
  onInterrupt,
  canInterrupt,
  interrupting,
}: {
  runtime: RunView[];
  onViewLogs: (id: string) => void;
  onInterrupt: (runId: string) => void;
  canInterrupt: boolean;
  interrupting: boolean;
}) {
  const running = runtime.filter((r) => r.state === "running");
  const [selId, setSelId] = useState<string | null>(running.length ? running[0]!.id : null);
  const run = running.find((r) => r.id === selId) || running[0];
  const elapsed = useElapsed(run?.startedAt ?? null, !!run);
  if (!run) return null;

  return (
    <div className="runbar" data-comment-anchor="live-run">
      <div className="runbar-head">
        <span className="live-dot" />
        <h2>Live run</h2>
        <Pill kind="agent" sm>
          {running.length === 1 ? "1 agent running" : running.length + " agents running"}
        </Pill>
        <span className="right">
          {running.length > 1 ? (
            <AgentPicker items={running} value={run.id} onChange={setSelId} label="Select running agent" />
          ) : (
            <span className="who-chip">
              <RunGlyph run={run} />
              <span className="nm">{runLabel(run)}</span>
            </span>
          )}
        </span>
      </div>
      <div className="runbar-body">
        <div className="run-phase">
          <span className="run-spin" aria-hidden="true" />
          <span>
            <div className="ph">{run.phase}</div>
            <div className="step mono">{run.step}</div>
          </span>
        </div>
        <div className="run-stats">
          <div className="run-cell">
            <div className="lbl">Elapsed</div>
            <div className="val mono">{fmtClock(elapsed)}</div>
          </div>
          <div className="run-cell">
            <div className="lbl">Turns</div>
            <div className="val mono">{run.turns}</div>
          </div>
          <div className="run-cell">
            <div className="lbl">Tokens</div>
            <div className="val mono">{fmtTok(run.tokens)}</div>
          </div>
          <div className="run-cell">
            <div className="lbl">Runtime</div>
            <div className="val mono">{run.model}</div>
          </div>
        </div>
        <div className="run-actions">
          <button type="button" className="btn ghost sm" onClick={() => onViewLogs(run.id)}>
            <Icon name="term" />
            View logs
          </button>
          {canInterrupt && (
            <button
              type="button"
              className="btn ghost sm"
              disabled={interrupting}
              onClick={() => onInterrupt(run.id)}
            >
              <Icon name="hand" />
              Interrupt
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- AgentLogsPanel

const CODEX_META = "@openai/codex-sdk · runStreamed() · thread ";
const CLAUDE_META = "@anthropic-ai/claude-agent-sdk · stream-json · session ";

/**
 * The provider session/thread id. Trimmed by default (long uuids), but
 * click-to-expand shows it in full and click again (or the copy affordance)
 * copies the whole id — so it can actually be pasted into `--resume`.
 */
function SessionIdChip({
  sid,
  runId,
  exportable,
}: {
  sid: string | null;
  /** Server run id — the export download key. */
  runId?: string;
  /** True when this run has a resumable on-disk session. */
  exportable?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!sid) return <span className="mono faint">—</span>;
  const short = sid.length > 10 ? sid.slice(0, 8) + "…" : sid;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sid);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setExpanded(true);
    }
  };
  // The id identifies the provider session (claude session_id / codex thread),
  // stored inside the app's runtime (in Docker, under CLAUDE_CONFIG_DIR /
  // CODEX_HOME on the data volume). It IS resumable on your own machine with
  // your own subscription — use Export to download an installer that places the
  // transcript where the local CLI expects it and prints `claude --resume` /
  // `codex resume`. (Or continue in-app by @mentioning the agent.)
  const scopeNote =
    "Runtime session, stored inside the app. It can be resumed on your own " +
    "machine with your own subscription — use Export to download an installer " +
    "that sets up `claude --resume` / `codex resume`. (Or @mention the agent to " +
    "continue here.)";
  return (
    <span className="session-id" title={scopeNote}>
      <button
        type="button"
        className="session-id-val mono"
        title={expanded ? "Click to trim" : sid + "\n\n" + scopeNote}
        aria-label={
          "Session id " + sid + ", stored in the app runtime — click to " +
          (expanded ? "trim" : "expand")
        }
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? sid : short}
      </button>
      <button
        type="button"
        className="session-id-copy"
        onClick={copy}
        title="Copy full session id"
        aria-label={copied ? "Copied session id" : "Copy full session id"}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
      {exportable && runId && (
        <a
          className="session-id-export"
          href={`/resources/session-export?run=${encodeURIComponent(runId)}`}
          download
          title={
            "Export this session to resume on your own machine (same " +
            "subscription). Downloads a bash installer; run it from your local " +
            "checkout, then use the printed resume command."
          }
          aria-label="Export session to resume locally"
        >
          <Icon name="ext" />
          Export
        </a>
      )}
    </span>
  );
}

/**
 * The "Agent logs" dark console. Live streaming is fed by the dedicated SSE
 * consumer (`linesByThread`) — NOT loader revalidation. The raw toggle
 * renders the stored wire envelope verbatim (runs.md §5.4).
 */
export function AgentLogsPanel({
  runtime,
  sel,
  onSel,
  linesByThread,
  onRetryBackend,
  retrying,
  streamError = null,
  olderByThread,
  onLoadOlder,
}: {
  runtime: RunView[];
  sel: string | null;
  onSel: (id: string | null) => void;
  linesByThread: Record<string, StreamedLine[]>;
  /** Retry the failed run's agent (primary specialist or reviewer) on the
   *  other backend (D4). Receives the failed run so the caller can route the
   *  right intent (run-specialist vs run-reviewer + profileId). */
  onRetryBackend?: (backend: "claude" | "codex", run: RunView) => void;
  retrying?: boolean;
  /** UI-03/UI-30: the live tail stopped (403 / dropped stream). Rendered in the
   *  footer so a frozen console never looks like a quiet one. */
  streamError?: string | null;
  /** P13-D-11: per-thread backward-paging state (how much history the loader's
   *  bounded window withheld, and whether a page is in flight). */
  olderByThread?: Record<string, OlderLogState>;
  /** P13-D-11: load one page of OLDER lines for a thread. Omitted → the "load
   *  older" affordance is not rendered at all. */
  onLoadOlder?: (threadId: string) => void;
}) {
  const [follow, setFollow] = useState(true);
  const [raw, setRaw] = useState(false);
  const hydrated = useHydrated();
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * P13-D-11: the console's scroll geometry captured at the moment "load older"
   * was pressed. Prepending content pushes everything the reader was looking at
   * DOWN by exactly the height of the new block, so the scroll offset is
   * re-anchored by that delta before paint — the jump-to-somewhere-else is the
   * classic failure of upward paging.
   */
  const anchorRef = useRef<{ threadId: string; height: number; top: number } | null>(null);

  const cur =
    runtime.find((r) => r.id === sel) ||
    runtime.find((r) => r.state === "running") ||
    runtime[0];

  // Prefer the live-streamed lines for the selected thread; fall back to the
  // loader's initial lines (paired with their raw) for other threads.
  const streamed = cur ? linesByThread[cur.id] : undefined;
  const shown: StreamedLine[] = cur
    ? (streamed ?? cur.lines.map((display, i) => ({ display, raw: cur.raw[i] ?? "" })))
    : [];
  const older = cur ? olderByThread?.[cur.id] : undefined;
  // P14-WL-02: what the console actually draws — telemetry runs folded into one
  // row each, unless the raw toggle is on. `shown` stays the counting basis, so
  // the footer's event total is unaffected by the folding.
  const entries = collapseTelemetry(shown, raw);

  useLayoutEffect(() => {
    const el = boxRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor || anchor.threadId !== cur?.id) return;
    if (el.scrollHeight === anchor.height) return; // nothing prepended yet
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    anchorRef.current = null;
  }, [shown.length, cur?.id]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown.length, raw, cur?.id, follow]);

  if (!runtime.length) {
    return (
      <div className="panel" data-comment-anchor="agent-logs">
        <div className="panel-head">
          <Icon name="term" />
          <h2>Agent logs</h2>
        </div>
        <div className="empty">
          No agent runs yet — runtime streams appear here once the operator engages a specialist.
        </div>
      </div>
    );
  }

  const st = runStatePill(cur!);
  // P13-D-11: the footer counts EVENTS — stored console lines. Two traps now
  // that the loader ships a window:
  //   • `shown` also carries UI-53's synthetic `── resumed ──` boundaries,
  //     which are not stored lines and are not in `lineCount` — counting the
  //     array double-counts them into the total;
  //   • `lineCount` means "lines that EXIST", a loader snapshot, so a live tail
  //     can already be ahead of it.
  // Take the larger of the two honest numbers, so the count keeps its
  // pre-window meaning instead of shrinking to "lines currently loaded".
  const storedShown = shown.reduce((n, l) => (isRunBoundary(l.display) ? n : n + 1), 0);
  const eventCount = Math.max(cur!.lineCount, storedShown);
  // UI-38: the FAILURE EXPLANATION describes the RUN, not the viewer.
  // `backendUnavailable` is a property of the run (the projection carries it);
  // `canRetryBackend` additionally requires an `onRetryBackend` handler, which
  // the page withholds from anyone without `run-agents` AND while any run is
  // streaming — so a contributor (and everyone during a concurrent run) was told
  // a quota failure was a "continuity error — see the blocked packet", pointing
  // at a packet that need not exist. Only the BUTTON is grant-gated now.
  const backendUnavailable =
    (cur!.kind === "primary" || cur!.kind === "reviewer") &&
    cur!.state === "error" &&
    !!cur!.failedBackendUnavailable &&
    !!cur!.altBackend;
  const canRetryBackend = backendUnavailable && !!onRetryBackend;
  const altLabel = cur!.altBackend === "codex" ? "Codex" : "Claude Code";
  const footer =
    cur!.state === "running"
      ? "streaming — raw output stays here as evidence, never in the task record"
      : cur!.lifecycle === "queued"
        ? // UI-57: a QUEUED run is not an idle thread. The strip renders only for
          // `running`, so a queued run used to show a "queued" pill next to the
          // footer "thread alive — no run executing", which contradicted it.
          "queued — waiting for a runtime slot; output appears once it starts"
        : cur!.lifecycle === "interrupted"
          ? `interrupted${cur!.interruptedBy ? " by " + cur!.interruptedBy.label.split(" ")[0] : ""} — the thread stays resumable`
          : cur!.state === "done"
            ? "run finished at " +
              (cur!.finished ? finishedClock(cur!.finished, hydrated) : "—") +
              " — thread can be re-engaged"
            : cur!.state === "error"
              ? backendUnavailable
                ? `${cur!.backend === "codex" ? "Codex" : "Claude Code"} was unavailable (quota / rate limit)${canRetryBackend ? ` — retry on ${altLabel}` : " — a maintainer can retry it on the other backend"}`
                : "stream ended on a continuity error — see the blocked packet"
              : "thread alive — no run executing";

  return (
    <div className="panel" data-comment-anchor="agent-logs">
      <div className="panel-head">
        <Icon name="term" />
        <h2>Agent logs</h2>
        <span className="right">
          <AgentPicker items={runtime} value={cur!.id} onChange={onSel} label="Select agent log stream" />
        </span>
      </div>

      <div className="logs-bar">
        <Pill kind={st.kind} sm dot={cur!.state === "running"}>
          {st.label}
        </Pill>
        <span className="logs-meta mono">
          {cur!.backend === "codex" ? CODEX_META : CLAUDE_META}
          <SessionIdChip
            sid={cur!.sid}
            runId={cur!.serverRunId}
            exportable={cur!.exportable}
          />
        </span>
        <span className="spacer" />
        {canRetryBackend && (
          <button
            type="button"
            className="btn primary sm"
            disabled={retrying}
            onClick={() => onRetryBackend!(cur!.altBackend!, cur!)}
            title={`Re-run the ${cur!.kind === "reviewer" ? "reviewer" : "specialist"} on ${altLabel} — the current backend was unavailable`}
          >
            <Icon name="refresh" />
            Retry on {altLabel}
          </button>
        )}
        {/* UI-57: both toggles carry their state for assistive tech, not just
            via the `on` class. */}
        <button
          type="button"
          className={"fchip" + (raw ? " on" : "")}
          aria-pressed={raw}
          onClick={() => setRaw(!raw)}
          title="Show raw stream events"
        >
          {"{ } raw"}
        </button>
        <button
          type="button"
          className={"fchip" + (follow ? " on" : "")}
          aria-pressed={follow}
          onClick={() => {
            const n = !follow;
            setFollow(n);
            if (n && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
          }}
        >
          <Icon name="arrow" />
          follow
        </button>
      </div>

      <div
        className="console"
        ref={boxRef}
        role="log"
        aria-live="off"
        aria-label={"Log stream for " + runLabel(cur!)}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
        }}
      >
        {/* P13-D-11: the loader ships a bounded window (NFR5), so the console
            starts mid-history on a long-lived task. This is how the reader
            reaches the oldest line — deliberately a BUTTON, not scroll-linked:
            an agent log is scanned, and auto-loading upward fights the live
            tail at the bottom. */}
        {older?.hasMore && onLoadOlder && cur ? (
          <div className="log-line meta">
            <span className="lt" />
            <span className="ltag">history</span>
            <span className="lx">
              <button
                type="button"
                className="log-more"
                disabled={older.loading}
                onClick={() => {
                  const el = boxRef.current;
                  if (el) {
                    anchorRef.current = {
                      threadId: cur.id,
                      height: el.scrollHeight,
                      top: el.scrollTop,
                    };
                  }
                  // Going backwards means the tail must stop yanking the view
                  // to the bottom; the reader re-arms `follow` when done.
                  setFollow(false);
                  onLoadOlder(cur.id);
                }}
              >
                {older.loading ? "loading older lines…" : "load older lines"}
              </button>
              <span className="log-more-note">
                {older.error
                  ? " · " + older.error
                  : ` · ${older.withheld} earlier line${older.withheld === 1 ? "" : "s"} not loaded`}
              </span>
            </span>
          </div>
        ) : null}
        {/* P14-WL-02: telemetry blocks fold into one dim row; `raw` renders the
            stored stream untouched (`collapseTelemetry` is a no-op there). */}
        {entries.map((entry, i) =>
          entry.kind === "telemetry" ? (
            <div className="log-line meta" key={i}>
              <span className="lt" />
              <span className="ltag">telemetry</span>
              <span className="lx">{telemetryLabel(entry)}</span>
            </div>
          ) : (
            <div className={"log-line " + entry.line.display.ev} key={i}>
              {/* F15-08: the stored `t` is a UTC wall clock; the timeline on
                  the same page is local. One story per page. Until hydration
                  the raw UTC clock renders — reprojecting into the viewer's
                  zone during SSR is a hydration text mismatch (React #418). */}
              <span className="lt">
                {hydrated
                  ? localLogClock(entry.line.display.t, cur!.startedAt)
                  : entry.line.display.t}
              </span>
              <span className="ltag">{entry.line.display.tag}</span>
              <span className="lx">
                {raw ? (
                  entry.line.raw
                ) : (
                  <>
                    {entry.line.display.name ? (
                      <b className="ln">{entry.line.display.name} </b>
                    ) : null}
                    {entry.line.display.text}
                  </>
                )}
              </span>
            </div>
          ),
        )}
        {cur!.state === "running" && (
          <div className="log-line cursor">
            <span className="lt"></span>
            <span className="ltag"></span>
            <span className="lx">
              <span className="lcaret">▌</span>
            </span>
          </div>
        )}
      </div>

      <div className="logs-foot">
        {/* UI-03/UI-30: a stopped tail is stated, never left to look like
            silence from the agent. */}
        <span>{streamError ?? footer}</span>
        <span className="mono">
          {eventCount} event{eventCount === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
