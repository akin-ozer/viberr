import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { toolIdentity, type ToolIdentity } from "~/shared/mcp-tools";
import { AgentGlyph } from "~/ui/identity";
import { Icon } from "~/ui/icon";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import { useHydrated } from "~/ui/local-time";
import { useDismiss } from "~/ui/use-dismiss";

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
  agentMessageProse,
  consoleCodeBlock,
  diffLineKind,
  fileChangeChips,
  fmtClock,
  fmtTok,
  foldWaits,
  groupThoughts,
  hoistRunInputs,
  roleShort,
  runInputRows,
  runLabel,
  runStatePill,
  thoughtLabel,
  toolChip,
  useElapsed,
  waitText,
  waitTitle,
  type ConsoleCodeBlock,
} from "./runs-helpers";
import { localLogClock } from "./log-clock";
import { collapseTelemetry, telemetryLabel } from "./log-noise";
import { isRunBoundary, isRunInputsLine, type RunView } from "./runtime-types";
import type { OlderLogState, StreamedLine } from "./use-run-log-stream";

/**
 * Port of runs.jsx: LiveRunPanel (run strip) + AgentLogsPanel (dark console)
 * + AgentPicker (shared dropdown) + RunGlyph. Structure, class names and copy
 * are 1:1 with the mock (runs.md §4). Prototype bits replaced: fake token
 * growth removed (real usage on the RunView), elapsed from startedAt, live
 * lines from the dedicated SSE consumer, interrupt is a real governed action.
 */

// --------------------------------------------------------------- RunGlyph

function RunGlyph({ run, decorative }: { run: RunView; decorative?: boolean }) {
  if (run.op) return <AgentGlyph op decorative={decorative} />;
  return <AgentGlyph backend={run.backend} decorative={decorative} />;
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
  const cur = items.find((r) => r.id === value) || items[0]!;

  // P16-UI-12: one shared dismiss hook (`app/ui/use-dismiss.ts`). This picker
  // had outside-press close but NOT document-level Escape — Escape only worked
  // while focus was still on the trigger, so an Escape from inside the open
  // listbox did nothing. It gains that here; the defaults are exactly what it
  // wants (the trigger is inside the returned ref, so no `also`).
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));

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
              {/* The row prints the SDK name and "Operator" itself. */}
              <RunGlyph run={r} decorative />
              <span className="ri-txt">
                <span className="ri-nm">{runLabel(r)}</span>
                <span className="ri-sub">
                  {r.role} · {r.sdk}
                </span>
              </span>
              {/* UXV19-5: the option used to print `RUN_STATE[r.state].label`,
                  the four-value RENDER projection, in which `renderStateOf`
                  collapses both `interrupted` and `queued` to "idle". So the
                  list a user reads FIRST to choose a stream called a run
                  "idle" while the pill and footer four lines below — which do
                  apply ruling 11's lifecycle mapping — read "interrupted · by
                  Arda" / "queued". One panel, one vocabulary: the label comes
                  from `runStatePill`, the module written for that ruling. The
                  DOT keeps the render-state class: it is a CSS state name, and
                  every lifecycle `runStatePill` re-labels is idle-shaped
                  (neutral) anyway, so tone never disagrees with the word. */}
              <span className={"ri-state " + r.state}>
                <span className={"rdot " + r.state} />
                {runStatePill(r).label}
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
              {/* The glyph is decorative exactly when the printed name already
                  says what it shows: an operator deployment still named
                  "Operator", or an agent whose name fell back to the backend
                  label. Otherwise it is the chip's one carrier of that fact. */}
              <RunGlyph
                run={run}
                decorative={
                  run.who.name === (run.op ? "Operator" : run.backend === "claude" ? "Claude" : "Codex")
                }
              />
              <span className="nm">{runLabel(run)}</span>
            </span>
          )}
        </span>
      </div>
      <div className="runbar-body">
        <div className="run-phase">
          <span className="run-spin" aria-hidden="true" />
          <span>
            {/* R21-4 / FR28: the phase and step are real now (both adapters
                emit them, and the run pipeline emits "Preparing workspace"
                before the provider starts). A run can still be between
                updates — a resumed row before its first message, a legacy row
                — so the heading falls back to the one thing that IS known from
                the row's state rather than rendering an empty bold line, and
                the step row is omitted entirely when there is no step. */}
            <div className="ph">{run.phase ?? "Working"}</div>
            {run.step ? <div className="step mono">{run.step}</div> : null}
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
            {/* F35-1: an estimate is marked as one, for as long as it is one.
                The live figure used to be the SDK's placeholder output (a few
                tokens per API message) and read "49" for twelve minutes of
                writing; now it is a text estimate the provider's total
                replaces at the result. A stopped run has no result, so its
                estimate keeps the tilde after it ends. */}
            {run.tokens === null ? (
              <div className="val mono">pending</div>
            ) : run.tokensEstimated ? (
              <div
                className="val mono"
                title="Estimated from the streamed text. The provider's own total replaces it when one lands; a run that was stopped never gets one"
              >
                ~{fmtTok(run.tokens)}
              </div>
            ) : (
              <div className="val mono">{fmtTok(run.tokens)}</div>
            )}
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
            /* Ruling 150: a stop discards the work in flight, so the trigger
               wears ruling 149's danger label like the confirm it opens
               (`btn danger`) — the neutral/red pair inside `.run-actions` is
               what separates it from the sibling `View logs`. `disabled` here
               is the request in flight (ruling 147(a)), not a validity gate. */
            <button
              type="button"
              className="btn ghost sm danger"
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
 *
 * Ruling 148: when there is no id the slot says so in words. A "−" sat exactly
 * where every other run shows a click-to-expand control, so it read as a
 * collapsed or emptied one rather than as the fact.
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
  if (!sid) return <span className="mono faint">none</span>;
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
  // stored inside the app's runtime — since ruling 127 in the runtime home of
  // the person the run billed (`runtimes/users/<id>/{claude,codex}-home` on the
  // data volume). It IS resumable on your own machine with
  // your own subscription — use Export to download an installer that places the
  // transcript where the local CLI expects it and prints `claude --resume` /
  // `codex resume`. (Or continue in-app by @mentioning the agent.)
  const scopeNote =
    "Runtime session, stored inside the app. It can be resumed on your own " +
    "machine with your own subscription. Use Export to download an installer " +
    "that sets up `claude --resume` / `codex resume`. (Or @mention the agent to " +
    "continue here.)";
  return (
    <span className="session-id" title={scopeNote}>
      <button
        type="button"
        className="session-id-val mono"
        title={expanded ? "Click to trim" : sid + "\n\n" + scopeNote}
        aria-label={
          "Session id " + sid + ", stored in the app runtime. Click to " +
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
 * P19-RC1: the mark on a file-change chip. A glyph AND a class, never colour
 * alone — WCAG 1.4.1: a reader who cannot separate the green from the red must
 * still be able to tell an added file from a deleted one. The `title` carries
 * the word itself for anyone who needs it spelled out.
 *
 * Ruling 148: that promise went unkept for a pass — the chip set no `title` and
 * no text, so the mark was the whole signal: a leading "−" read as a remove
 * control and a reader heard "minus app/b.ts". The glyph is now aria-hidden and
 * the word beside it is what gets announced.
 */
const FILE_KIND_MARK = {
  add: "+",
  update: "~",
  delete: "−",
} satisfies Record<"add" | "update" | "delete", string>;

const FILE_KIND_WORD = {
  add: "added",
  update: "updated",
  delete: "deleted",
} satisfies Record<"add" | "update" | "delete", string>;

/**
 * Ruling 366: a tool chip's name, marked by whose tool it is. Viberr's own
 * tools carry the agent tint and the V mark; the word is read to assistive
 * tech (`.vh`) so the mark is never the only carrier, and the title spells the
 * provider's full name for anyone who greps a transcript by it.
 */
function ToolName({ who }: { who: ToolIdentity }) {
  const title =
    who.kind === "viberr"
      ? `Viberr's own tool · ${who.name}`
      : who.kind === "mcp"
        ? `MCP server ${who.server} · ${who.name}`
        : undefined;
  return (
    <span className="lc-name" title={title}>
      {who.kind === "viberr" ? (
        <>
          <span className="lc-mark" aria-hidden="true">
            <Icon name="viberr" />
          </span>
          <span className="vh">viberr </span>
        </>
      ) : null}
      {who.label}
    </span>
  );
}

/**
 * P19-RC1 — multi-line command output and diffs, lifted out of the grid row
 * into their own bounded block.
 *
 * Bounded by CSS and SCROLLABLE rather than truncated: the console's promise is
 * that what the agent produced is readable, so silently dropping the tail of a
 * 300-line build log would be the exact dishonesty the `{ } raw` toggle exists
 * to rule out. Copy hands the reader the whole thing regardless of scroll.
 */
function ConsoleCode({ block }: { block: ConsoleCodeBlock }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard denied (permissions, insecure origin): the text is on screen
      // and selectable, which is the fallback that always works.
    }
  };
  const lines = block.code.split("\n");
  return (
    <span className="log-code">
      <span className="lk-head">
        <span className="lk-meta">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className="log-more"
          onClick={copy}
          aria-label="Copy this output"
        >
          {copied ? "copied" : "copy"}
        </button>
      </span>
      <span className="lk-body">
        {lines.map((line, n) => {
          const kind = block.diff ? diffLineKind(line) : null;
          return (
            <span className={"lk-line" + (kind ? " lk-" + kind : "")} key={n}>
              {line === "" ? " " : line}
            </span>
          );
        })}
      </span>
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
  retryBackends,
  retrying,
  streamError = null,
  olderByThread,
  onLoadOlder,
}: {
  runtime: RunView[];
  sel: string | null;
  onSel: (id: string | null) => void;
  linesByThread: Record<string, StreamedLine[]>;
  /** Retry the failed run's agent on the other backend (D4). Receives the
   *  failed run so the caller can dispatch it (run-agent + the run's own
   *  profileId + the backend override). */
  onRetryBackend?: (backend: "claude" | "codex", run: RunView) => void;
  /** Ruling 127: which backends a retry on this task could actually RUN on —
   *  the task owner's connected accounts, because every run bills them. A
   *  backend absent from this list gets no button and no "a maintainer can
   *  retry it" advice: dispatching it would produce a second, identically
   *  refused run, and the footer says so instead of staying silent about a
   *  control that is not there. Omitted entirely means the caller did not ask
   *  the question: then nothing is offered AND nothing is claimed about the
   *  owner, which is not the same as an empty list ("asked, nobody to bill"). */
  retryBackends?: readonly ("claude" | "codex")[] | undefined;
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
  /**
   * P19-G11: which run-input disclosures are expanded, keyed by the stored
   * envelope (it carries the run id, so the key survives streaming, folding and
   * backward paging — an array index does not).
   */
  const [openInputs, setOpenInputs] = useState<string[]>([]);
  /**
   * P19-RC1: which folded reasoning blocks are expanded, keyed the same way the
   * input disclosures are — by the first line's stored envelope, so the key
   * survives streaming, folding and backward paging.
   */
  const [openThoughts, setOpenThoughts] = useState<string[]>([]);
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
  // P19-G11: each run's `run·inputs` disclosure is restored to the head of its
  // own block first (see `hoistRunInputs`) — what the run was GIVEN reads before
  // what it produced.
  // P19-RC1: …and consecutive reasoning lines fold into one block on top of
  // that. Both foldings are no-ops under `raw`, which keeps the stored stream
  // the authoritative view of what the provider sent.
  // Ruling 366: …and a call's heartbeats fold into one wait row last, on the
  // thought fold's blocks (a heartbeat is a `meta` line the thought fold never
  // touches). Still a no-op under `raw`.
  const entries = foldWaits(
    groupThoughts(collapseTelemetry(hoistRunInputs(shown), raw), raw),
    raw,
  );

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
          No agent runs yet. Runtime streams appear here once the operator engages a specialist.
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
  // Ruling 350: the CLASS describes the run whatever its kind. The kind gate
  // that used to sit here was for the retry clause, which keeps its own gate
  // below (`retryOffered`); on the class it sent an operator drive or a
  // controller turn refused for `unavailable` to the unclassified sentence —
  // "continuity error; see the blocked packet" — and a controller turn has no
  // packet at all.
  const backendUnavailable = cur!.state === "error" && !!cur!.failedBackendUnavailable;
  // Ruling 127: the retry OFFER needs somebody to bill, which is a different
  // question from why this run failed. The projection withholds `altBackend`
  // when the run had no principal at all (an unowned task), and `retryBackends`
  // is the task owner's live connection set — the same question the blocked
  // packet asks before offering `retry_other_backend` (task-actions.server.ts),
  // so the button and the packet cannot tell two stories about one task.
  const altBackend = cur!.altBackend ?? null;
  const retryPossible =
    backendUnavailable &&
    altBackend !== null &&
    (retryBackends?.includes(altBackend) ?? false);
  const canRetryBackend = retryPossible && !!onRetryBackend;
  const altLabel = altBackend === "codex" ? "Codex" : "Claude";
  // Ruling 127: the offer, and when there is none, WHY there is none. A run
  // that failed on quota with an owner who never connected the other backend
  // gets no button on any surface (the blocked packet withholds
  // `retry_other_backend` for the same reason), so the console names the
  // owner's missing connection rather than leaving the absent control
  // unexplained. `retryBackends === undefined` is "not asked", and claims
  // nothing about the owner.
  // Pass 34 review: the "isn't connected" clause is about a retry this panel
  // can offer, and only an AGENT run has one — an operator or controller run
  // has no other backend to move to, so appending it there stated a
  // credential fact that was often false and always irrelevant.
  const retryOffered = cur!.kind === "primary" || cur!.kind === "reviewer";
  const retryClause = canRetryBackend
    ? `. Retry on ${altLabel}`
    : retryPossible
      ? ". A maintainer can retry it on the other backend"
      : retryOffered && altBackend !== null && retryBackends !== undefined
        ? `. ${altLabel} isn't connected for the task owner, so there is no other backend to retry on`
        : "";
  const footer =
    cur!.state === "running"
      ? // A controller turn's record is its transcript (ruling 99), not a task.
        cur!.kind === "controller"
        ? "streaming: raw output stays here as evidence, never in the transcript"
        : "streaming: raw output stays here as evidence, never in the task record"
      : cur!.lifecycle === "queued"
        ? // UI-57: a QUEUED run is not an idle thread. The strip renders only for
          // `running`, so a queued run used to show a "queued" pill next to the
          // footer "thread alive — no run executing", which contradicted it.
          "queued: waiting for a runtime slot; output appears once it starts"
        : cur!.lifecycle === "interrupted"
          ? // Pass 35 U35-7: a restart is a reason, not a person. Boot
            // recovery re-invokes the operator for a task run it interrupted
            // (a controller turn gets a note on its conversation instead), so
            // the footer says what already happened rather than "resumable".
            cur!.interruptedBy
            ? // Ruling 350: the row knows WHO stopped it and whether a session
              // existed — not whether the task still takes a run. Both live
              // person-interrupts on this instance were closure interrupts
              // (ruling 177 refuses every re-run on a closed task) and the
              // footer promised "resumable" on each; ruling 207(g)'s note
              // already says "there is no thread to resume" when no session
              // was reported, and the footer said the opposite beside it.
              cur!.sid
              ? `interrupted by ${cur!.interruptedBy.label.split(" ")[0]}; the thread can be resumed where the task still takes a run`
              : `interrupted by ${cur!.interruptedBy.label.split(" ")[0]} before a session existed, so there is no thread to resume`
            : cur!.interruptedReason === "restart"
              ? cur!.kind === "controller"
                ? "interrupted by a restart; the conversation carries a note"
                : // Ruling 338: this said "the operator was re-invoked", and the
                  // panel holds no fact about whether one was. Recovery stamps
                  // the identical row state on a re-invoked orphan and on one
                  // its crash-loop guard REFUSED to re-invoke
                  // (`RECOVERY_REINVOKE_CAP`, 3 in 30 minutes), and records the
                  // refusal only as an audit row and a note on the task.
                  //
                  // Live: 250 restart renderings on this board, 6 of them on
                  // capped runs — SHOP-27, SHOP-34 (twice, two boots), SHOP-35,
                  // SHOP-36, SHOP-38 — and on every one the task's own timeline
                  // says the opposite, one panel away: "Viberr did NOT re-invoke
                  // the operator for it… Run the operator from this page when
                  // you are ready." A person who believes the footer does not
                  // do the one thing the note asks. At the 13:01:50Z boot,
                  // SHOP-34/35/38 sat two and a half hours until a human
                  // commented by hand.
                  //
                  // This is ruling 198's defect surviving in the second surface
                  // a person opens when a run stops. The panel knows the run was
                  // cut by a restart and nothing more, so that is all it says —
                  // and it points at the record that does know. A stronger
                  // sentence would need a real `recoveryReinvoked` field
                  // written on both branches, which is more than the lie is
                  // worth.
                  "interrupted by a restart; the task record says what recovery did"
              : "interrupted; the thread stays resumable"
          : cur!.state === "done"
            ? // Ruling 148: a missing timestamp is said by leaving the clause
              // out, not by a "−" mid-sentence — "run finished at −;" read as a
              // broken template rather than as the fact. Same treatment as
              // `SessionIdChip` above, and worse here because the glyph landed
              // inside a sentence instead of in a value slot.
              cur!.finished
              ? "run finished at " +
                finishedClock(cur!.finished, hydrated) +
                "; thread can be re-engaged"
              : "run finished; thread can be re-engaged"
            : cur!.state === "error"
              ? // Ruling 130(a): the SENTENCE follows the classified failure
                // for every run kind; the retry clause follows the OFFER.
                cur!.failureKind === "quota"
                ? `${cur!.backend === "codex" ? "Codex" : "Claude"} refused this run: the account's usage window is spent (the error line names the reset and the account remedy)${retryClause}`
                : cur!.failureKind === "auth"
                  ? `${cur!.backend === "codex" ? "Codex" : "Claude"} refused this run: the account was rejected by the provider (an organization restriction or a rejected credential; the error line names the remedy)${retryClause}`
                  : cur!.failureKind === "overloaded"
                  ? // The provider's side, not the account's: the sentence
                    // must not send the reader to a quota or account remedy.
                    // U35-11: unless the request never reached the provider,
                    // which is this deployment's network path, not its side.
                    cur!.failureOrigin === "local"
                    ? `${cur!.backend === "codex" ? "Codex" : "Claude"} could not be reached from this deployment: the connection failed before the provider answered; nothing about the account is wrong, check the network path and retry in a few minutes${retryClause}`
                    : `${cur!.backend === "codex" ? "Codex" : "Claude"} could not serve this run: the provider was overloaded or failed on its side; nothing about the account is wrong, retry in a few minutes${retryClause}`
                  : cur!.failureKind === "max_budget"
                    ? // Ruling 175 / ruling 350: the pill above already says "cut off ·
                      // spending cap"; the footer said "continuity error" beneath it.
                      "cut off by the instance's spending cap (Org settings → Max spend per Claude run): not a task failure; continue the run or raise the cap"
                    : cur!.failureKind === "max_turns"
                      ? "cut off at the run's turn cap: not a task failure; continue the run"
                      : cur!.failureKind === "idle_timeout"
                        ? "stopped after producing nothing for the whole idle window: the run hung, it did not fail; re-run it"
                        : cur!.failureKind === "session_missing"
                          ? "the provider session this run tried to resume no longer exists; a fresh run re-anchored on the task record is the recovery"
                          : backendUnavailable
                ? // Ruling 127: the same `run·unavailable` classification now
                  // also covers "the account this run bills has not connected
                  // the backend", so the footer states the CLASS and lets the
                  // run's own error line (which names the person and the
                  // remedy) carry the specifics, instead of asserting a quota
                  // failure that may not have happened.
                  // The retry clause follows the OFFER, not the viewer's
                  // grant: with nobody to bill on the other backend there is
                  // no retry to advertise, and the run's own error line
                  // carries the real remedy (own the task, connect the
                  // account).
                  `${cur!.backend === "codex" ? "Codex" : "Claude"} could not run this (quota, rate limit, or an account that cannot run it)${retryClause}`
                : // Ruling 350: only a specialist's failure raises the packet the
                  // old sentence pointed at; an operator drive or a controller
                  // turn is sent to the record it does have.
                  cur!.kind === "primary" || cur!.kind === "reviewer"
                  ? "stream ended on a continuity error; see the blocked packet"
                  : "stream ended on a continuity error; the error line above carries what the provider said"
              : "thread alive, no run executing";

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
          // D04-U6 (pass 32): a run-start is a secondary control here, like
          // every sibling run-start demoted in pass 30 (execution-profile.tsx);
          // the page keeps ONE primary.
          <button
            type="button"
            className="btn sm"
            disabled={retrying}
            onClick={() => onRetryBackend!(altBackend!, cur!)}
            title={`Re-run the ${cur!.kind === "reviewer" ? "reviewer" : "specialist"} on ${altLabel}. The current backend was unavailable`}
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
        {entries.map((entry, i) => {
          if (entry.kind === "telemetry") {
            return (
              <div className="log-line meta" key={i}>
                <span className="lt" />
                <span className="ltag">telemetry</span>
                <span className="lx">{telemetryLabel(entry)}</span>
              </div>
            );
          }
          // P19-RC1: a run of reasoning lines, folded into one disclosure. The
          // model narrating itself is the bulkiest thing in most consoles and
          // the least often the thing a reader came for — so it is summarised
          // (measured duration + step count) and opened on demand, exactly like
          // the telemetry fold above it. `raw` never reaches here: groupThoughts
          // returns the entries untouched under it.
          if (entry.kind === "thought") {
            const key = entry.lines[0]!.raw;
            const open = openThoughts.includes(key);
            const head = entry.lines[0]!.display;
            return (
              <Fragment key={i}>
                <div className="log-line think">
                  <span className="lt">
                    {hydrated ? localLogClock(head.t, cur!.startedAt) : head.t}
                  </span>
                  <span className="ltag">thinking</span>
                  <span className="lx">
                    <button
                      type="button"
                      className="log-more"
                      aria-expanded={open}
                      onClick={() =>
                        setOpenThoughts((prev) =>
                          prev.includes(key)
                            ? prev.filter((k) => k !== key)
                            : [...prev, key],
                        )
                      }
                    >
                      {thoughtLabel(entry.lines)}
                    </button>
                  </span>
                </div>
                {open &&
                  entry.lines.map((line, n) => (
                    <div className="log-line think tstep" key={n}>
                      <span className="lt">
                        {hydrated
                          ? localLogClock(line.display.t, cur!.startedAt)
                          : line.display.t}
                      </span>
                      <span className="ltag">{line.display.tag}</span>
                      <span className="lx">{line.display.text}</span>
                    </div>
                  ))}
              </Fragment>
            );
          }
          // Ruling 366: one call's heartbeats, folded into one wait row. LIVE
          // while the run is going and nothing has landed after the last
          // heartbeat — the orb turns; once anything follows, the call was
          // still running AT the figure, and the row claims exactly that.
          if (entry.kind === "wait") {
            const last = entry.lines[entry.lines.length - 1]!.display;
            const live = cur!.state === "running" && i === entries.length - 1;
            const who = toolIdentity(last.name ?? "");
            return (
              <div className={"log-line meta wait" + (live ? " lw-live" : "")} key={i}>
                <span className="lt">
                  {hydrated ? localLogClock(last.t, cur!.startedAt) : last.t}
                </span>
                <span className="ltag">{last.tag}</span>
                <span className="lx">
                  <span className="log-wait" title={waitTitle(entry.lines)}>
                    {live ? (
                      // Pinned to its dark ink: the console paints its own
                      // near-black fill in BOTH app themes, and `auto` would
                      // read the light theme's `data-theme` off `:root` and
                      // draw dark dots on it. Decorative — the words beside it
                      // carry the state, so it is hidden from assistive tech.
                      <ThinkingOrb
                        state={who.kind === "viberr" ? "connecting" : "working"}
                        size={20}
                        theme="dark"
                        className="log-orb"
                        aria-hidden="true"
                      />
                    ) : (
                      <Icon name="clock" />
                    )}
                    <span className={"log-chip" + (who.kind === "viberr" ? " vb" : "")}>
                      <ToolName who={who} />
                    </span>
                    {waitText(entry.lines, live)}
                  </span>
                </span>
              </div>
            );
          }
          const display = entry.line.display;
          // F15-08: the stored `t` is a UTC wall clock; the timeline on the
          // same page is local. One story per page. Until hydration the raw UTC
          // clock renders — reprojecting into the viewer's zone during SSR is a
          // hydration text mismatch (React #418).
          const clock = hydrated
            ? localLogClock(display.t, cur!.startedAt)
            : display.t;
          // P19-G11: the run's own disclosure of what it was GIVEN — the one
          // line the console did not receive from a provider. Expandable rather
          // than always-open: it is reference material a reader goes looking
          // for, not part of the run's narrative. `raw` still wins, as it does
          // for every other line: that toggle's contract is the stored envelope.
          if (!raw && isRunInputsLine(display)) {
            const key = entry.line.raw;
            const open = openInputs.includes(key);
            return (
              <Fragment key={i}>
                <div className="log-line meta">
                  <span className="lt">{clock}</span>
                  <span className="ltag">{display.tag}</span>
                  <span className="lx">
                    {display.text}
                    <span className="log-more-note"> · </span>
                    <button
                      type="button"
                      className="log-more"
                      aria-expanded={open}
                      onClick={() =>
                        setOpenInputs((prev) =>
                          prev.includes(key)
                            ? prev.filter((k) => k !== key)
                            : [...prev, key],
                        )
                      }
                    >
                      {open ? "hide what this run was given" : "show what this run was given"}
                    </button>
                  </span>
                </div>
                {open &&
                  runInputRows(display.inputs!, cur!.backend, cur!.kind).map((row) => (
                    <div className="log-line meta" key={row.tag}>
                      <span className="lt" />
                      <span className="ltag">{row.tag}</span>
                      <span
                        className="lx"
                        {...(row.pre ? { style: { whiteSpace: "pre-wrap" as const } } : {})}
                      >
                        {row.text}
                      </span>
                    </div>
                  ))}
              </Fragment>
            );
          }
          // P19-RC1: the three shapes the projection already distinguishes and
          // the console used to flatten. All three are computed only when `raw`
          // is off — under it the stored envelope prints verbatim, unchanged.
          const chip = raw ? null : toolChip(display);
          const files = raw ? null : fileChangeChips(display);
          const code = raw ? null : consoleCodeBlock(display);
          // N20-18: a Codex final message is the raw outcome-envelope JSON;
          // fold it to the prose it wraps so it reads like Claude's `assistant`.
          const prose = raw ? null : agentMessageProse(display);
          return (
            <div className={"log-line " + display.ev} key={i}>
              <span className="lt">{clock}</span>
              <span className="ltag">{display.tag}</span>
              <span className="lx">
                {raw ? (
                  entry.line.raw
                ) : (
                  <>
                    {chip ? (
                      <span className={"log-chip" + (chip.who.kind === "viberr" ? " vb" : "")}>
                        <ToolName who={chip.who} />
                        {chip.detail ? (
                          <span className="lc-detail">{chip.detail}</span>
                        ) : null}
                      </span>
                    ) : (
                      <>
                        {display.name ? (
                          <b className="ln">{display.name} </b>
                        ) : null}
                        {/* When the text IS the block below, printing it here
                            too would render the whole dump twice. */}
                        {code ? null : (prose ?? display.text)}
                      </>
                    )}
                    {files ? (
                      <span className="log-files">
                        {files.map((f, n) => (
                          <span
                            className={"log-file lf-" + f.kind}
                            key={n}
                            title={FILE_KIND_WORD[f.kind]}
                          >
                            <span className="lf-kind" aria-hidden="true">
                              {FILE_KIND_MARK[f.kind]}
                            </span>
                            <span className="vh">{FILE_KIND_WORD[f.kind]} </span>
                            {f.path}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {code ? <ConsoleCode block={code} /> : null}
                  </>
                )}
              </span>
            </div>
          );
        })}
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
