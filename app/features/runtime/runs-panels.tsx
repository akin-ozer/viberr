import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import NumberFlow, { NumberFlowGroup } from "@number-flow/react";
import { ThinkingOrb } from "thinking-orbs";
import { toolIdentity, type ToolIdentity } from "~/shared/mcp-tools";
import { AgentGlyph } from "~/ui/identity";
import { CopyGlyph } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { NumberTicker } from "~/ui/number-ticker";
import { formatClock, formatClockUTC } from "~/shared/dates/format";
import { useHydrated } from "~/ui/local-time";
import { useDismiss } from "~/ui/use-dismiss";
import { useLiveStreamFailed } from "~/features/live-updates/use-live-updates";
// Ruling 457: backend labels and count plurals are spelled inline here, not
// through `BACKEND_LABEL` / `countLabel` (why: shared/text/backend-label.ts,
// shared/text/plural.ts).

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
  argumentRows,
  commandNote,
  consoleCodeBlock,
  diffLineKind,
  fileChangeChips,
  fmtClock,
  fmtTok,
  HEARTBEAT_NOTE,
  heartbeatLabel,
  hiddenArguments,
  roleShort,
  runInputRows,
  runLabel,
  runStatePill,
  thoughtLabel,
  toolChip,
  useElapsed,
  waitCountTitle,
  waitText,
  type ConsoleCodeBlock,
} from "./runs-helpers";
import { localLogClock } from "./log-clock";
import { telemetryLabel } from "./log-noise";
import { createConsoleFolder, type ConsoleRow } from "./console-fold";
import {
  isRunInputsLine,
  type LogLine,
  type RunCacheView,
  type RunKind,
  type RunView,
} from "./runtime-types";
import type { RunLogStore, StreamedLine } from "./run-log-store";
import { useConsoleStatus, useConsoleThread, useRunFacts } from "./use-run-log-stream";
import { readableStep } from "./readable-step";

/**
 * Ruling 366(e): the counts that climb while a run waits roll their digits
 * (`@number-flow/react`: Intl-formatted, accessible as one labelled number,
 * static under reduced motion, plain markup on the server). Every wrapper
 * carries the figure in plain text on a `data-` attribute, so the DOM can be
 * read without the animation's markup.
 */
const TWO_DIGITS = { minimumIntegerDigits: 2 } as const;
/** The tens digit of a base-60 field never passes 5. */
const BASE_60 = { 1: { max: 5 } } as const;

/**
 * One rolling field of a clock, memoised on its props (all primitives or
 * module constants): a tick re-renders the seconds and leaves the minutes and
 * hours alone until they move (ruling 457, LIVE-11; the digits still roll,
 * ruling 366(e) and 451(e)).
 */
const Roll = memo(NumberFlow);

/** The strip's Elapsed cell: `fmtClock`'s `mm:ss` / `h:mm:ss`, rolling. */
function RunClock({ seconds }: { seconds: number }) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  return (
    <span className="lw-clock" data-clock={fmtClock(s)}>
      <NumberFlowGroup>
        {h ? <Roll value={h} suffix=":" trend={1} willChange /> : null}
        <Roll
          value={Math.floor((s % 3600) / 60)}
          format={TWO_DIGITS}
          digits={h ? BASE_60 : undefined}
          suffix=":"
          trend={1}
          willChange
        />
        <Roll value={s % 60} format={TWO_DIGITS} digits={BASE_60} trend={1} willChange />
      </NumberFlowGroup>
    </span>
  );
}

/** A wait's elapsed figure in `waitClock`'s shape, rolling: seconds alone under
 *  a minute, minutes + two-digit seconds under an hour, hours + two-digit
 *  minutes past it (the static form drops the seconds there too). */
function WaitClock({ seconds, title }: { seconds: number; title: string }) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (
    <span className="lw-clock" data-elapsed={s} title={title}>
      <NumberFlowGroup>
        {h > 0 ? (
          <>
            <Roll value={h} suffix="h " trend={1} willChange />
            <Roll value={m} format={TWO_DIGITS} digits={BASE_60} suffix="m" trend={1} willChange />
          </>
        ) : m > 0 ? (
          <>
            <Roll value={m} suffix="m " trend={1} willChange />
            <Roll value={s % 60} format={TWO_DIGITS} digits={BASE_60} suffix="s" trend={1} willChange />
          </>
        ) : (
          <Roll value={s} suffix="s" trend={1} willChange />
        )}
      </NumberFlowGroup>
    </span>
  );
}

/** Ruling 451(e): the strip's Turns cell rolls as Elapsed and Tokens beside
 *  it do; it used to be the one figure in the row that jumped. Memoised on
 *  its figure (ruling 457, LIVE-11): the number-flow element resets its
 *  markup on every render. */
const TurnCount = memo(function TurnCount({ n }: { n: number }) {
  return (
    <span className="lw-clock" data-turns={n}>
      <NumberFlow value={n} trend={1} />
    </span>
  );
});

/** `TokenCount`'s two digit formats, made once: a new format object per render
 *  reset the number-flow element's markup (ruling 457, LIVE-11). */
const ONE_FRACTION_DIGIT = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;
const NO_FRACTION_DIGITS = { minimumFractionDigits: 0, maximumFractionDigits: 0 } as const;

/** F35-1's token figure with rolling digits, in `fmtTok`'s units. */
const TokenCount = memo(function TokenCount({ n, estimated }: { n: number; estimated: boolean }) {
  const scaled =
    n >= 1_000_000
      ? { value: n / 1_000_000, format: ONE_FRACTION_DIGIT, unit: "M" }
      : n >= 100_000
        ? { value: Math.round(n / 1000), format: NO_FRACTION_DIGITS, unit: "k" }
        : n >= 1000
          ? { value: n / 1000, format: ONE_FRACTION_DIGIT, unit: "k" }
          : { value: n, format: NO_FRACTION_DIGITS, unit: "" };
  return (
    <span className="lw-clock" data-tokens={(estimated ? "~" : "") + fmtTok(n)}>
      <NumberFlow
        value={scaled.value}
        format={scaled.format}
        prefix={estimated ? "~" : ""}
        suffix={scaled.unit}
        trend={1}
        willChange={estimated}
      />
    </span>
  );
});

/** Ruling 457 (LIVE-11): the strip's Elapsed cell owns its one-second clock,
 *  so a tick re-renders the clock and nothing else of the Live run card. */
function LiveElapsed({ startedAt }: { startedAt: string | null }) {
  return <RunClock seconds={useElapsed(startedAt, true)} />;
}

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
          {roleShort(cur) && <span className="rsel-role"> · {roleShort(cur)}</span>}
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
export const LiveRunPanel = memo(function LiveRunPanel({
  runtime,
  onViewLogs,
  onInterrupt,
  canInterrupt,
  interrupting,
  interruptingRunId = null,
  console: consoleSlot = null,
  consoleOpen = false,
  store = null,
}: {
  runtime: RunView[];
  onViewLogs: (id: string) => void;
  onInterrupt: (runId: string) => void;
  canInterrupt: boolean;
  /** A request that Interrupt waits on is in flight. */
  interrupting: boolean;
  /** Ruling 368: the server run id whose interrupt is in flight, so THAT run's
   *  Interrupt shows the work (busy, the loader, "Interrupting…"). */
  interruptingRunId?: string | null;
  /** F39 (owner decision): the streaming console for THIS run, rendered inside
   *  the card. A live run's output belongs with the strip that describes it —
   *  measured on the controller page, the panel it used to live in sat 886px
   *  (a full viewport) below, with the conversation in between, so the control
   *  that reached it read as navigation, jumped out of the conversation and
   *  offered no way back. A caller that passes nothing keeps the old layout. */
  console?: ReactNode;
  /** Whether {@link console} is showing, so the trigger can name what it does. */
  consoleOpen?: boolean;
  /** Ruling 457 (LIVE-1): the console's store, whose tail reads carry the
   *  run's phase, step, turns and tokens as each line lands. Without one the
   *  strip shows what the page loaded. */
  store?: RunLogStore | null;
}) {
  const running = runtime.filter((r) => r.state === "running");
  const [selId, setSelId] = useState<string | null>(running.length ? running[0]!.id : null);
  const run = running.find((r) => r.id === selId) || running[0];
  if (!run) return null;
  const stoppingThis = interruptingRunId !== null && interruptingRunId === run.serverRunId;

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
        <RunStripFacts run={run} store={store} />
        <div className="run-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onViewLogs(run.id)}
            aria-expanded={consoleSlot !== null ? consoleOpen : undefined}
          >
            <Icon name="term" />
            {consoleSlot === null
              ? // No inline slot: the caller still keeps its console elsewhere,
                // and the old jump-to-anchor wording is the honest one there.
                "View logs"
              : consoleOpen
                ? "Hide console"
                : "Show console"}
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
              aria-busy={stoppingThis || undefined}
              onClick={() => onInterrupt(run.id)}
            >
              <Icon name={stoppingThis ? "loader" : "hand"} className={stoppingThis ? "spin" : ""} />
              {stoppingThis ? "Interrupting…" : "Interrupt"}
            </button>
          )}
        </div>
        {consoleOpen && consoleSlot !== null && (
          <div className="runbar-console">{consoleSlot}</div>
        )}
      </div>
    </div>
  );
});

/**
 * The strip's phase, step and figures. Ruling 457 (LIVE-1): read from the
 * console's store, whose every tail read carries the run's current facts, over
 * what the page loaded; the page used to revalidate root, layout and task
 * every 2 s during a run only to move these. The clock is its own leaf
 * (LIVE-11), so a second ticks without re-rendering the rest.
 */
const RunStripFacts = memo(function RunStripFacts({
  run,
  store,
}: {
  run: RunView;
  store: RunLogStore | null;
}) {
  const f = useRunFacts(store, run.serverRunId) ?? run;
  return (
    <>
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
          {/* Ruling 451(a): phase and step are keyed on their text, so a
              new one is a new line that rises in (the sheet's `swap-in`)
              rather than words changing under the reader. */}
          <div key={"ph:" + (f.phase ?? "Working")} className="ph">
            {f.phase ?? "Working"}
          </div>
          {/* U39-26: read as words, as the conversation's working row
              reads it; the stored step stays on hover. */}
          {f.step ? (
            <div key={"step:" + f.step} className="step mono" title={f.step}>
              {readableStep(f.step)}
            </div>
          ) : null}
        </span>
      </div>
      <div className="run-stats">
        <div className="run-cell">
          <div className="lbl">Elapsed</div>
          <div className="val mono">
            <LiveElapsed startedAt={run.startedAt} />
          </div>
        </div>
        <div className="run-cell">
          <div className="lbl">Turns</div>
          <div className="val mono">
            <TurnCount n={f.turns} />
          </div>
        </div>
        <div className="run-cell">
          <div className="lbl">Tokens</div>
          {/* F35-1: an estimate is marked as one, for as long as it is one.
              The live figure used to be the SDK's placeholder output (a few
              tokens per API message) and read "49" for twelve minutes of
              writing; now it is a text estimate the provider's total
              replaces at the result. A stopped run has no result, so its
              estimate keeps the tilde after it ends. */}
          {f.tokens === null ? (
            <div className="val mono">pending</div>
          ) : f.tokensEstimated ? (
            <div
              className="val mono"
              title={withCacheTitle(
                "Estimated from the streamed text. The provider's own total replaces it when one lands; a run that was stopped never gets one",
                f.cache,
              )}
            >
              <TokenCount n={f.tokens} estimated />
            </div>
          ) : (
            <div className="val mono" title={withCacheTitle(null, f.cache)}>
              <TokenCount n={f.tokens} estimated={false} />
            </div>
          )}
        </div>
        <div className="run-cell">
          <div className="lbl">Runtime</div>
          <div className="val mono">{run.model}</div>
        </div>
      </div>
    </>
  );
});

/**
 * Ruling 369: the strip's Tokens cell says on hover how much of the prompt
 * the cache wrote and read, beside the estimate sentence when there is one.
 * Nothing is claimed for a run that has reported no cache figure yet.
 */
function withCacheTitle(base: string | null, cache: RunCacheView): string | undefined {
  const line =
    cache.writeTokens > 0 || cache.readTokens > 0
      ? `Prompt cache: wrote ${fmtTok(cache.writeTokens)} · read ${fmtTok(cache.readTokens)}`
      : null;
  if (base && line) return `${base}\n${line}`;
  return base ?? line ?? undefined;
}

/** The provider's miss reason, as the chip prints it. */
function missLabel(reason: string): string {
  return reason.replace(/_/g, " ");
}

/**
 * Ruling 369: the console's record of what the prompt cache did for the run —
 * the first call's temperature and figures (with the provider's miss reason
 * when it sent one), the TTL bucket, the run's writes and reads, the peak
 * prompt and the compactions. Every chip carries its figure on a `data-`
 * attribute, so the DOM reads without the words. A run that has reported
 * nothing says so instead of printing zeros as facts. Ruling 457 (LIVE-1): the
 * figures follow the console's tail reads, over what the page loaded.
 */
const RunFactsRow = memo(function RunFactsRow({
  run,
  store,
}: {
  run: RunView;
  store: RunLogStore | null;
}) {
  const c = (useRunFacts(store, run.serverRunId) ?? run).cache;
  const first = c.firstCall;
  const reported = first !== null || c.writeTokens > 0 || c.readTokens > 0 || c.peakPromptTokens > 0;
  return (
    <div className="run-facts" data-comment-anchor="run-facts">
      {first ? (
        <Pill kind={first.warm ? "done" : "input"} sm quiet dot>
          <span
            data-start={first.warm ? "warm" : "cold"}
            data-first-write={first.write}
            data-first-read={first.read}
            title={`First model call: prompt ${fmtTok(first.promptTokens)} · wrote ${fmtTok(first.write)} into the cache · read ${fmtTok(first.read)} from it. Warm means it read more than it wrote.`}
          >
            {first.warm ? "warm start" : "cold start"} ·{" "}
            {first.warm ? `read ${fmtTok(first.read)}` : `wrote ${fmtTok(first.write)}`}
          </span>
        </Pill>
      ) : (
        <Pill kind="neutral" sm quiet>
          <span data-start="none" title="No model call has reported its prompt figures yet">
            {reported ? "first call not recorded" : "no first call yet"}
          </span>
        </Pill>
      )}
      {first?.missReason ? (
        <Pill kind="neutral" sm quiet>
          <span data-miss={first.missReason} title="The provider's own reason the first call missed the cache">
            miss: {missLabel(first.missReason)}
          </span>
        </Pill>
      ) : null}
      {c.ttlBucket ? (
        <Pill kind="neutral" sm quiet>
          <span
            data-ttl={c.ttlBucket}
            title={
              c.ttlBucket === "mixed"
                ? "Cache writes were billed under both the 5-minute and the 1-hour lifetime"
                : `Cache writes were billed under the ${c.ttlBucket === "1h" ? "1-hour" : "5-minute"} lifetime`
            }
          >
            cache {c.ttlBucket}
          </span>
        </Pill>
      ) : null}
      {reported ? (
        <Pill kind="neutral" sm quiet>
          <span
            data-write={c.writeTokens}
            data-read={c.readTokens}
            title="Over the whole run: tokens written into the prompt cache, and tokens read back from it"
          >
            wrote {fmtTok(c.writeTokens)} · read {fmtTok(c.readTokens)}
          </span>
        </Pill>
      ) : null}
      {c.peakPromptTokens > 0 ? (
        <Pill kind="neutral" sm quiet>
          <span
            data-peak={c.peakPromptTokens}
            data-last={c.lastPromptTokens}
            title={`The largest prompt one call carried. The last call's prompt, ${fmtTok(c.lastPromptTokens)}, is what a resume would replay`}
          >
            peak prompt {fmtTok(c.peakPromptTokens)}
          </span>
        </Pill>
      ) : null}
      <Pill kind={c.compactions > 0 ? "info" : "neutral"} sm quiet>
        <span
          data-compactions={c.compactions}
          title="Times the provider replaced the conversation with a summary. The persona and knowledge-base indexes survive; tool output before the boundary does not"
        >
          {c.compactions} compaction{c.compactions === 1 ? "" : "s"}
        </span>
      </Pill>
    </div>
  );
});

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
        <CopyGlyph copied={copied} />
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

/** The disclosures a console row opens, each remembered by the row's key. */
type Disclosure = "inputs" | "thoughts" | "waits" | "args";

/** What a folded row (a reasoning run, a call's heartbeats) is drawn from. */
interface FoldRowProps {
  /** The row's key, handed back to `onToggle`. */
  rowKey: string;
  lines: readonly StreamedLine[];
  /** Wait rows only: the call is still open. */
  live?: boolean;
  startedAt: string | null;
  hydrated: boolean;
  open: boolean;
  onToggle: (kind: Disclosure, key: string) => void;
}

/**
 * Ruling 366: one call's heartbeats, folded into one wait row. LIVE while the
 * run is going and nothing has landed after the last heartbeat — the orb
 * turns and the count runs on from the provider's last figure (366(e)); once
 * anything follows, the call was still running AT that figure, and the row
 * claims exactly that. The row says what it folded — "5 heartbeats, no
 * output" — and opens to list them (366(d)), so a fold never reads as a hole
 * in the record.
 */
function WaitRow({
  rowKey,
  lines,
  live = false,
  startedAt,
  hydrated,
  open,
  onToggle,
}: FoldRowProps) {
  const last = lines[lines.length - 1]!.display;
  const who = toolIdentity(last.name ?? "");
  const reported = last.progress?.elapsed ?? null;
  const at = last.progress?.at ?? null;
  // The count runs on from the heartbeat's own instant, so a page opened
  // mid-wait starts at the right figure and the next heartbeat resyncs it
  // rather than jumping. With no instant or no figure there is nothing honest
  // to count from, and the row prints the static words.
  const since = useElapsed(live ? at : null, live);
  const ticking = live && reported !== null && at !== null;
  const clock = (t: string) => (hydrated ? localLogClock(t, startedAt) : t);
  const n = lines.length;
  return (
    <>
      <div className={"log-line meta wait" + (live ? " lw-live" : "")}>
        <span className="lt">{clock(last.t)}</span>
        <span className="ltag">{last.tag}</span>
        <span className="lx">
          <span className="log-wait">
            {live ? (
              // Pinned to its dark ink: the console paints its own near-black
              // fill in BOTH app themes, and `auto` would read the light
              // theme's `data-theme` off `:root` and draw dark dots on it.
              // Decorative — the words beside it carry the state, so it is
              // hidden from assistive tech.
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
            {ticking ? (
              <span>
                still running ·{" "}
                <WaitClock seconds={reported + since} title={waitCountTitle(lines, clock(last.t))} />
              </span>
            ) : (
              waitText(lines, live)
            )}
            <span className="log-more-note">
              {" · "}
              <button
                type="button"
                className="log-more"
                aria-expanded={open}
                onClick={() => onToggle("waits", rowKey)}
              >
                {n} heartbeat{n === 1 ? "" : "s"}
              </button>
              , no output
            </span>
          </span>
        </span>
      </div>
      {open && (
        <>
          <div className="log-line meta tstep">
            <span className="lt" />
            <span className="ltag">heartbeat</span>
            <span className="lx">{HEARTBEAT_NOTE}</span>
          </div>
          {lines.map((line, i) => (
            <div className="log-line meta tstep" key={line.key}>
              <span className="lt">{clock(line.display.t)}</span>
              <span className="ltag">{line.display.tag}</span>
              <span className="lx">{heartbeatLabel(line.display, i + 1)}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

/**
 * Ruling 366(d): the arguments a tool row's summary cut, in full, under the
 * row — only those, in the order the link named them — in the same shape the
 * run-inputs disclosure uses, so a reader never has to leave the row for
 * `{ } raw`.
 */
function ArgumentRows({ input, keys }: { input: NonNullable<LogLine["input"]>; keys: readonly string[] }) {
  return (
    <>
      {argumentRows(input, keys).map((row) => (
        <div className="log-line meta tstep" key={row.key}>
          <span className="lt" />
          <span className="ltag">{row.key}</span>
          <span className="lx">{row.text}</span>
        </div>
      ))}
    </>
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
          {/* Ruling 451(c): the confirmation rises in; "copy" returns at once. */}
          {copied ? <span className="copy-done">copied</span> : "copy"}
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

/** A folded row's lines as a thought fold draws them (P19-RC1). */
function ThoughtRow({ rowKey, lines, startedAt, hydrated, open, onToggle }: FoldRowProps) {
  const head = lines[0]!.display;
  const clock = (t: string) => (hydrated ? localLogClock(t, startedAt) : t);
  return (
    <>
      <div className="log-line think">
        <span className="lt">{clock(head.t)}</span>
        <span className="ltag">thinking</span>
        <span className="lx">
          <button
            type="button"
            className="log-more"
            aria-expanded={open}
            onClick={() => onToggle("thoughts", rowKey)}
          >
            {thoughtLabel(lines)}
          </button>
        </span>
      </div>
      {open &&
        lines.map((line) => (
          <div className="log-line think tstep" key={line.key}>
            <span className="lt">{clock(line.display.t)}</span>
            <span className="ltag">{line.display.tag}</span>
            <span className="lx">{line.display.text}</span>
          </div>
        ))}
    </>
  );
}

/** What the raw view prints for a line whose stored envelope has not arrived
 *  yet (ruling 457: the envelopes load when the raw view opens). */
const RAW_PENDING = "loading the stored envelope…";

/** One console line as the console draws it: the raw envelope, or the shapes
 *  the projection distinguishes (P19-RC1, P19-G11, ruling 366(d)). */
function LineRow({
  line,
  raw,
  startedAt,
  hydrated,
  backend,
  kind,
  open,
  onToggle,
}: {
  line: StreamedLine;
  raw: boolean;
  startedAt: string | null;
  hydrated: boolean;
  backend: RunView["backend"];
  kind: RunKind;
  open: boolean;
  onToggle: (kind: Disclosure, key: string) => void;
}) {
  const display = line.display;
  // F15-08: the stored `t` is a UTC wall clock; the timeline on the same page
  // is local. One story per page. Until hydration the raw UTC clock renders —
  // reprojecting into the viewer's zone during SSR is a hydration text
  // mismatch (React #418).
  const clock = hydrated ? localLogClock(display.t, startedAt) : display.t;
  // P19-G11: the run's own disclosure of what it was GIVEN — the one line the
  // console did not receive from a provider. Expandable rather than
  // always-open: it is reference material a reader goes looking for, not part
  // of the run's narrative. `raw` still wins, as it does for every other line:
  // that toggle's contract is the stored envelope.
  if (!raw && isRunInputsLine(display)) {
    return (
      <>
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
              onClick={() => onToggle("inputs", line.key)}
            >
              {open ? "hide what this run was given" : "show what this run was given"}
            </button>
          </span>
        </div>
        {open &&
          runInputRows(display.inputs!, backend, kind).map((row) => (
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
      </>
    );
  }
  // P19-RC1: the three shapes the projection already distinguishes and the
  // console used to flatten. All three are computed only when `raw` is off —
  // under it the stored envelope prints verbatim, unchanged.
  const chip = raw ? null : toolChip(display);
  // Ruling 366(d): what the one-line summary cut, if anything worth a click,
  // and Bash's description for the row itself.
  const hidden = raw ? null : hiddenArguments(display);
  const argsOpen = hidden !== null && open;
  const note = raw ? null : commandNote(display);
  const files = raw ? null : fileChangeChips(display);
  const code = raw ? null : consoleCodeBlock(display);
  // N20-18: a Codex final message is the raw outcome-envelope JSON; fold it to
  // the prose it wraps so it reads like Claude's `assistant`.
  const prose = raw ? null : agentMessageProse(display);
  return (
    <>
      <div className={"log-line " + display.ev}>
        <span className="lt">{clock}</span>
        <span className="ltag">{display.tag}</span>
        <span className="lx">
          {raw ? (
            (line.raw ?? RAW_PENDING)
          ) : (
            <>
              {chip ? (
                <span className={"log-chip" + (chip.who.kind === "viberr" ? " vb" : "")}>
                  <ToolName who={chip.who} />
                  {chip.detail || note || hidden ? (
                    // The note and the link live INSIDE the detail's own text
                    // flow: as flex items of the chip they were squeezed to a
                    // letter a line, and after the chip they dangled on a line
                    // of their own once the detail wrapped.
                    <span className="lc-detail">
                      {chip.detail}
                      {note ? <span className="log-more-note"> # {note}</span> : null}
                      {hidden ? (
                        <span className="log-more-note">
                          {" · "}
                          <button
                            type="button"
                            className="log-more"
                            aria-expanded={argsOpen}
                            title="Show it in full under this row"
                            onClick={() => onToggle("args", line.key)}
                          >
                            {hidden.label}
                          </button>
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              ) : (
                <>
                  {display.name ? <b className="ln">{display.name} </b> : null}
                  {/* When the text IS the block below, printing it here too
                      would render the whole dump twice. */}
                  {code ? null : (prose ?? display.text)}
                </>
              )}
              {files ? (
                <span className="log-files">
                  {files.map((f, n) => (
                    <span className={"log-file lf-" + f.kind} key={n} title={FILE_KIND_WORD[f.kind]}>
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
      {argsOpen && hidden && display.input ? (
        <ArgumentRows input={display.input} keys={hidden.keys} />
      ) : null}
    </>
  );
}

/** The disclosure a row opens, if it opens one (a row opens at most one). */
function disclosureOf(row: ConsoleRow<StreamedLine>, raw: boolean): Disclosure | null {
  switch (row.kind) {
    case "thought":
      return "thoughts";
    case "wait":
      return "waits";
    case "telemetry":
      return null;
    default:
      if (raw) return null;
      return isRunInputsLine(row.line.display) ? "inputs" : "args";
  }
}

/**
 * Ruling 457 (LIVE-4): one drawn row of the console, memoised. The fold keeps a
 * row's object for as long as its content is unchanged and every other prop is
 * a primitive or stable, so an appended line renders the row it adds (or the
 * one fold it grows) and no other.
 */
const ConsoleEntry = memo(function ConsoleEntry({
  row,
  raw,
  live,
  startedAt,
  hydrated,
  backend,
  kind,
  open,
  onToggle,
}: {
  row: ConsoleRow<StreamedLine>;
  raw: boolean;
  /** A wait row only: the run is going and nothing has landed after it. */
  live: boolean;
  startedAt: string | null;
  hydrated: boolean;
  backend: RunView["backend"];
  kind: RunKind;
  open: boolean;
  onToggle: (kind: Disclosure, key: string) => void;
}) {
  // P14-WL-02: telemetry blocks fold into one dim row; `raw` renders the stored
  // stream untouched (the fold passes every line through there).
  if (row.kind === "telemetry") {
    return (
      <div className="log-line meta">
        <span className="lt" />
        <span className="ltag">telemetry</span>
        <span className="lx">{telemetryLabel(row)}</span>
      </div>
    );
  }
  // P19-RC1: a run of reasoning lines, folded into one disclosure. The model
  // narrating itself is the bulkiest thing in most consoles and the least often
  // the thing a reader came for — so it is summarised (measured duration + step
  // count) and opened on demand, exactly like the telemetry fold above it.
  if (row.kind === "thought") {
    return (
      <ThoughtRow
        rowKey={row.key}
        lines={row.lines}
        startedAt={startedAt}
        hydrated={hydrated}
        open={open}
        onToggle={onToggle}
      />
    );
  }
  // Ruling 366: one call's heartbeats, folded into one wait row. LIVE while
  // the run is going and nothing has landed after the last heartbeat — the orb
  // turns; once anything follows, the call was still running AT the figure,
  // and the row claims exactly that.
  if (row.kind === "wait") {
    return (
      <WaitRow
        rowKey={row.key}
        lines={row.lines}
        live={live}
        startedAt={startedAt}
        hydrated={hydrated}
        open={open}
        onToggle={onToggle}
      />
    );
  }
  return (
    <LineRow
      line={row.line}
      raw={raw}
      startedAt={startedAt}
      hydrated={hydrated}
      backend={backend}
      kind={kind}
      open={open}
      onToggle={onToggle}
    />
  );
});

const NO_LINES: readonly StreamedLine[] = [];
const NONE_OPEN: ReadonlySet<string> = new Set();

/**
 * UI-03 for the tab's one live stream (ruling 457): it FAILED and is
 * reconnecting on its backoff, so the console is not following. The reconnect
 * revalidates the page, and the console fetches whatever it missed.
 */
const LIVE_TAIL_DOWN =
  "Live tail disconnected: reconnecting, and the console catches up once it is back.";

/**
 * Ruling 457 (LIVE-2 / LIVE-4): the console box and its footer, for one thread
 * of the store. It reads the thread itself (`useSyncExternalStore`), so a line
 * re-renders this and the row it adds, and nothing of the page around it; its
 * other props are primitives, so a revalidation that changed nothing it draws
 * does not render it at all.
 */
const ConsoleView = memo(function ConsoleView({
  store,
  threadId,
  raw,
  follow,
  onFollow,
  boxRef,
  running,
  startedAt,
  backend,
  kind,
  label,
  lineCount,
  footer,
  stopped,
  hydrated,
}: {
  store: RunLogStore;
  threadId: string;
  raw: boolean;
  follow: boolean;
  onFollow: (follow: boolean) => void;
  boxRef: RefObject<HTMLDivElement | null>;
  running: boolean;
  startedAt: string | null;
  backend: RunView["backend"];
  kind: RunKind;
  /** The log region's accessible name. */
  label: string;
  /** `RunView.lineCount`: the lines that EXIST, a loader snapshot. */
  lineCount: number;
  footer: string;
  /** UI-03/UI-30: why the live tail stopped, or null while it follows. */
  stopped: string | null;
  hydrated: boolean;
}) {
  const thread = useConsoleThread(store, threadId);
  const lines = thread?.lines ?? NO_LINES;
  // LIVE-4: an appended line folds onto the rows already drawn; a new window,
  // a backward page or the raw toggle folds everything again.
  const folder = useMemo(() => createConsoleFolder<StreamedLine>(), [threadId]);
  const rows = folder.fold(lines, raw, thread?.epoch ?? 0);
  /**
   * The disclosures the reader opened (P19-G11 run inputs, P19-RC1 thoughts,
   * ruling 366(d) heartbeat folds and argument lists), keyed
   * `thread|kind|row key`. A row's key is its first line's `consoleLineKey`,
   * which survives streaming, folding and backward paging; it used to be the
   * stored envelope, which a console now holds only while its raw view is
   * open. Ruling 457 (CON-6): every thread's first line is `0:0`, and this
   * view outlives an agent switch, so the thread is part of the key; a
   * disclosure the reader opened stays with its own agent.
   */
  const [open, setOpen] = useState(NONE_OPEN);
  const onToggle = useCallback(
    (what: Disclosure, key: string) => {
      setOpen((prev) => {
        const next = new Set(prev);
        const id = `${threadId}|${what}|${key}`;
        if (!next.delete(id)) next.add(id);
        return next;
      });
    },
    [threadId],
  );
  /**
   * P13-D-11: the console's scroll geometry captured at the moment "load older"
   * was pressed. Prepending content pushes everything the reader was looking at
   * DOWN by exactly the height of the new block, so the scroll offset is
   * re-anchored by that delta before paint — the jump-to-somewhere-else is the
   * classic failure of upward paging.
   */
  const anchorRef = useRef<{ threadId: string; height: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor || anchor.threadId !== threadId) return;
    if (el.scrollHeight === anchor.height) return; // nothing prepended yet
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
    anchorRef.current = null;
  }, [lines.length, threadId, boxRef]);

  /** The scroll offset this view last saw or set, so `onScroll` can tell a
   *  reader scrolling up from the view being pushed down. */
  const topRef = useRef(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !follow) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight;
      topRef.current = el.scrollTop;
    };
    pin();
    // Ruling 457 (CON-4): the rows skip layout until they are near the view
    // (`content-visibility: auto`, CSS-6), so the rows this jump brings into
    // view still count at their 21px placeholder here and reach their real
    // height in the frames after it; a row's first relevance check runs after
    // the frame's animation callbacks, so the first frame still reads the
    // estimate. Pin again each frame, at least twice, until the height stops
    // moving (bounded, in case something below keeps growing).
    let frames = 0;
    let height = el.scrollHeight;
    let id = requestAnimationFrame(function again() {
      frames += 1;
      const now = el.scrollHeight;
      pin();
      if ((frames < 2 || now !== height) && frames < 12) {
        height = now;
        id = requestAnimationFrame(again);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [lines.length, raw, threadId, follow, boxRef]);

  const older = thread?.older;
  // P13-D-11: the footer counts EVENTS — stored console lines that EXIST, not
  // the rows on screen: the window withholds older lines, and UI-53's
  // `── resumed ──` rows are not stored lines. `lineCount` is the loader's
  // snapshot and `total` the store's own count, which the live tail moves
  // (ruling 457: the page no longer revalidates per line to move it). Take the
  // larger, so the count never goes backwards.
  const eventCount = Math.max(lineCount, thread?.total ?? 0);
  return (
    <>
      <div
        className="console"
        ref={boxRef}
        role="log"
        aria-live="off"
        aria-label={label}
        onScroll={(e) => {
          const el = e.currentTarget;
          const top = el.scrollTop;
          // Ruling 457 (CON-4): only a scroll UP stops following. Rows growing
          // as they come into view (and scroll anchoring making room for
          // rows that grew above it) send scroll events too, with the view
          // short of the end until the next pin; those used to turn `follow`
          // off by themselves.
          if (el.scrollHeight - top - el.clientHeight < 48) onFollow(true);
          else if (top < topRef.current) onFollow(false);
          topRef.current = top;
        }}
      >
        {/* Ruling 457 (owner decision 2): a thread the page did not carry
            lines for fills itself with one request when it is shown. */}
        {thread === null || thread.status === "unloaded" || thread.status === "loading" ? (
          <div className="log-line meta">
            <span className="lt" />
            <span className="ltag">history</span>
            <span className="lx">loading this console…</span>
          </div>
        ) : thread.status === "failed" ? (
          <div className="log-line err">
            <span className="lt" />
            <span className="ltag">history</span>
            <span className="lx">{thread.loadError}</span>
          </div>
        ) : null}
        {/* P13-D-11: the loader ships a bounded window (NFR5), so the console
            starts mid-history on a long-lived task. This is how the reader
            reaches the oldest line — deliberately a BUTTON, not scroll-linked:
            an agent log is scanned, and auto-loading upward fights the live
            tail at the bottom. */}
        {older?.hasMore ? (
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
                  if (el) anchorRef.current = { threadId, height: el.scrollHeight, top: el.scrollTop };
                  // Going backwards means the tail must stop yanking the view
                  // to the bottom; the reader re-arms `follow` when done.
                  onFollow(false);
                  store.loadOlder(threadId);
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
        {rows.map((row, i) => {
          const what = disclosureOf(row, raw);
          return (
            <ConsoleEntry
              key={row.key}
              row={row}
              raw={raw}
              live={row.kind === "wait" && running && i === rows.length - 1}
              startedAt={startedAt}
              hydrated={hydrated}
              backend={backend}
              kind={kind}
              open={what !== null && open.has(`${threadId}|${what}|${row.key}`)}
              onToggle={onToggle}
            />
          );
        })}
        {running && (
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
        <span>{stopped ?? footer}</span>
        {/* Ruling 366(f): the total counts up to its figure; the figure itself
            is on `data-count` for anyone reading the DOM, and the noun follows
            the figure drawn, so the count never passes through "1 events". */}
        <span className="mono">
          <NumberTicker end={eventCount}>
            {(n, text) => `${text} event${n === 1 ? "" : "s"}`}
          </NumberTicker>
        </span>
      </div>
    </>
  );
});

/**
 * The "Agent logs" dark console. Its lines come from the run-log store
 * (`useRunLogStream`): the live tail, the backward pages and the window a
 * thread loads when the page did not carry it — NOT loader revalidation. The
 * raw toggle renders the stored wire envelope verbatim (runs.md §5.4), loaded
 * when the toggle opens (ruling 457).
 */
export const AgentLogsPanel = memo(function AgentLogsPanel({
  runtime,
  sel,
  onSel,
  store,
  onRetryBackend,
  retryBackends,
  retrying,
  retryingProfileId = null,
}: {
  runtime: RunView[];
  sel: string | null;
  onSel: (id: string | null) => void;
  /** Ruling 457: the lines, their backward pages and the live tail's state
   *  (`useRunLogStream`, or `staticRunLogStore` for a console fed by hand). */
  store: RunLogStore;
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
  /** A request the retry waits on is in flight. */
  retrying?: boolean;
  /** Ruling 368: the profile whose retry is in flight, so the shown run's
   *  Retry says so when it is that agent's. */
  retryingProfileId?: string | null;
}) {
  const [follow, setFollow] = useState(true);
  const { streamError, rawView: raw } = useConsoleStatus(store);
  // UI-03: the tab's live stream (the layout's, ruling 457) is down.
  const liveDown = useLiveStreamFailed();
  const hydrated = useHydrated();
  const boxRef = useRef<HTMLDivElement>(null);

  const cur =
    runtime.find((r) => r.id === sel) ||
    runtime.find((r) => r.state === "running") ||
    runtime[0];
  const curId = cur?.id ?? null;

  // Ruling 457 (owner decision 2): the thread on screen is the one whose lines
  // the console asks for, when the page did not carry them.
  useEffect(() => {
    if (curId !== null) store.show(curId);
  }, [store, curId]);

  if (!cur) {
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

  const st = runStatePill(cur);
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
  const backendUnavailable = cur.state === "error" && !!cur.failedBackendUnavailable;
  // Ruling 127: the retry OFFER needs somebody to bill, which is a different
  // question from why this run failed. The projection withholds `altBackend`
  // when the run had no principal at all (an unowned task), and `retryBackends`
  // is the task owner's live connection set — the same question the blocked
  // packet asks before offering `retry_other_backend` (task-actions.server.ts),
  // so the button and the packet cannot tell two stories about one task.
  const altBackend = cur.altBackend ?? null;
  const retryPossible =
    backendUnavailable &&
    altBackend !== null &&
    (retryBackends?.includes(altBackend) ?? false);
  const canRetryBackend = retryPossible && !!onRetryBackend;
  const altLabel = altBackend === "codex" ? "Codex" : "Claude";
  const retryingThis = retryingProfileId !== null && retryingProfileId === cur.profileId;
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
  const retryOffered = cur.kind === "primary" || cur.kind === "reviewer";
  const retryClause = canRetryBackend
    ? `. Retry on ${altLabel}`
    : retryPossible
      ? ". A maintainer can retry it on the other backend"
      : retryOffered && altBackend !== null && retryBackends !== undefined
        ? `. ${altLabel} isn't connected for the task owner, so there is no other backend to retry on`
        : "";
  const footer =
    cur.state === "running"
      ? // A controller turn's record is its transcript (ruling 99), not a task.
        cur.kind === "controller"
        ? "streaming: raw output stays here as evidence, never in the transcript"
        : "streaming: raw output stays here as evidence, never in the task record"
      : cur.lifecycle === "queued"
        ? // UI-57: a QUEUED run is not an idle thread. The strip renders only for
          // `running`, so a queued run used to show a "queued" pill next to the
          // footer "thread alive — no run executing", which contradicted it.
          "queued: waiting for a runtime slot; output appears once it starts"
        : cur.lifecycle === "interrupted"
          ? // Pass 35 U35-7: a restart is a reason, not a person. Boot
            // recovery re-invokes the operator for a task run it interrupted
            // (a controller turn gets a note on its conversation instead), so
            // the footer says what already happened rather than "resumable".
            cur.interruptedBy
            ? // Ruling 350: the row knows WHO stopped it and whether a session
              // existed — not whether the task still takes a run. Both live
              // person-interrupts on this instance were closure interrupts
              // (ruling 177 refuses every re-run on a closed task) and the
              // footer promised "resumable" on each; ruling 207(g)'s note
              // already says "there is no thread to resume" when no session
              // was reported, and the footer said the opposite beside it.
              cur.sid
              ? `interrupted by ${cur.interruptedBy.label.split(" ")[0]}; the thread can be resumed where the task still takes a run`
              : `interrupted by ${cur.interruptedBy.label.split(" ")[0]} before a session existed, so there is no thread to resume`
            : cur.interruptedReason === "restart"
              ? cur.kind === "controller"
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
          : cur.state === "done"
            ? // Ruling 148: a missing timestamp is said by leaving the clause
              // out, not by a "−" mid-sentence — "run finished at −;" read as a
              // broken template rather than as the fact. Same treatment as
              // `SessionIdChip` above, and worse here because the glyph landed
              // inside a sentence instead of in a value slot.
              // Ruling 419(d): a controller conversation is not re-engaged,
              // it is continued, and the way to do that is the composer.
              cur.kind === "controller"
              ? (cur.finished
                  ? "turn finished at " + finishedClock(cur.finished, hydrated)
                  : "turn finished") + "; send a message to continue the conversation"
              : cur.finished
                ? "run finished at " +
                  finishedClock(cur.finished, hydrated) +
                  "; thread can be re-engaged"
                : "run finished; thread can be re-engaged"
            : cur.state === "error"
              ? // Ruling 130(a): the SENTENCE follows the classified failure
                // for every run kind; the retry clause follows the OFFER.
                cur.failureKind === "quota"
                ? `${cur.backend === "codex" ? "Codex" : "Claude"} refused this run: the account's usage window is spent (the error line names the reset and the account remedy)${retryClause}`
                : cur.failureKind === "auth"
                  ? `${cur.backend === "codex" ? "Codex" : "Claude"} refused this run: the account was rejected by the provider (an organization restriction or a rejected credential; the error line names the remedy)${retryClause}`
                  : cur.failureKind === "overloaded"
                  ? // The provider's side, not the account's: the sentence
                    // must not send the reader to a quota or account remedy.
                    // U35-11: unless the request never reached the provider,
                    // which is this deployment's network path, not its side.
                    cur.failureOrigin === "local"
                    ? `${cur.backend === "codex" ? "Codex" : "Claude"} could not be reached from this deployment: the connection failed before the provider answered; nothing about the account is wrong, check the network path and retry in a few minutes${retryClause}`
                    : `${cur.backend === "codex" ? "Codex" : "Claude"} could not serve this run: the provider was overloaded or failed on its side; nothing about the account is wrong, retry in a few minutes${retryClause}`
                  : cur.failureKind === "max_budget"
                    ? // Ruling 175 / ruling 350: the pill above already says "cut off ·
                      // spending cap"; the footer said "continuity error" beneath it.
                      "cut off by the instance's spending cap (Instance settings → Max spend per Claude run): not a task failure; continue the run or raise the cap"
                    : cur.failureKind === "max_turns"
                      ? "cut off at the run's turn cap: not a task failure; continue the run"
                      : cur.failureKind === "idle_timeout"
                        ? "stopped after producing nothing for the whole idle window: the run hung, it did not fail; re-run it"
                        : cur.failureKind === "session_missing"
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
                  `${cur.backend === "codex" ? "Codex" : "Claude"} could not run this (quota, rate limit, or an account that cannot run it)${retryClause}`
                : // Ruling 350: only a specialist's failure raises the packet the
                  // old sentence pointed at; an operator drive or a controller
                  // turn is sent to the record it does have.
                  cur.kind === "primary" || cur.kind === "reviewer"
                  ? "stream ended on a continuity error; see the blocked packet"
                  : "stream ended on a continuity error; the error line above carries what the provider said"
              : "thread alive, no run executing";

  return (
    <div className="panel" data-comment-anchor="agent-logs">
      <div className="panel-head">
        <Icon name="term" />
        <h2>Agent logs</h2>
        <span className="right">
          <AgentPicker items={runtime} value={cur.id} onChange={onSel} label="Select agent log stream" />
        </span>
      </div>

      <div className="logs-bar">
        <Pill kind={st.kind} sm dot={cur.state === "running"}>
          {st.label}
        </Pill>
        <span className="logs-meta mono">
          {cur.backend === "codex" ? CODEX_META : CLAUDE_META}
          <SessionIdChip sid={cur.sid} runId={cur.serverRunId} exportable={cur.exportable} />
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
            aria-busy={retryingThis || undefined}
            onClick={() => onRetryBackend!(altBackend!, cur)}
            title={`Re-run the ${cur.kind === "reviewer" ? "reviewer" : "specialist"} on ${altLabel}. The current backend was unavailable`}
          >
            <Icon name={retryingThis ? "loader" : "refresh"} className={retryingThis ? "spin" : ""} />
            {retryingThis ? `Retrying on ${altLabel}…` : `Retry on ${altLabel}`}
          </button>
        )}
        {/* UI-57: both toggles carry their state for assistive tech, not just
            via the `on` class. Ruling 457: opening the raw view loads the
            shown thread's stored envelopes, which no page payload carries. */}
        <button
          type="button"
          className={"fchip" + (raw ? " on" : "")}
          aria-pressed={raw}
          onClick={() => store.setRawView(!raw)}
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

      {/* Ruling 369: what the prompt cache did for this run, above the stream. */}
      <RunFactsRow run={cur} store={store} />

      <ConsoleView
        store={store}
        threadId={cur.id}
        raw={raw}
        follow={follow}
        onFollow={setFollow}
        boxRef={boxRef}
        running={cur.state === "running"}
        startedAt={cur.startedAt}
        backend={cur.backend}
        kind={cur.kind}
        label={"Log stream for " + runLabel(cur)}
        lineCount={cur.lineCount}
        footer={footer}
        stopped={streamError ?? (liveDown ? LIVE_TAIL_DOWN : null)}
        hydrated={hydrated}
      />
    </div>
  );
});
