// @vitest-environment jsdom
import { useMemo, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { z } from "zod";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { AgentLogsPanel, LiveRunPanel } from "./runs-panels";
import {
  runBoundaryLine,
  RUN_INPUTS_TAG,
  type LogLine,
  type RunInputs,
  type RunView,
} from "./runtime-types";
import { NO_RUN_CACHE } from "./runtime-types";
import { createLiveRunLogStore, staticRunLogStore, type OlderLogState } from "./run-log-store";

/** A console line as a test hands it over; the key defaults to its position. */
type StreamedLine = { display: LogLine; raw: string | null; key?: string };

/**
 * The console fed by hand (ruling 457): the lines, backward-paging state and
 * stream error a live store would hold, in a `staticRunLogStore`.
 */
function Logs({
  linesByThread,
  olderByThread,
  onLoadOlder,
  streamError = null,
  ...props
}: Omit<ComponentProps<typeof AgentLogsPanel>, "store"> & {
  linesByThread: Record<string, readonly StreamedLine[]>;
  olderByThread?: Record<string, OlderLogState>;
  onLoadOlder?: (threadId: string) => void;
  streamError?: string | null;
}) {
  const store = useMemo(() => {
    const input: Parameters<typeof staticRunLogStore>[0] = { linesByThread, streamError };
    if (olderByThread) input.olderByThread = olderByThread;
    if (onLoadOlder) input.onLoadOlder = onLoadOlder;
    return staticRunLogStore(input);
  }, [linesByThread, olderByThread, onLoadOlder, streamError]);
  return <AgentLogsPanel {...props} store={store} />;
}

/** Ruling 366(f): the footer's total counts up to its figure, so a test reads
 *  the figure itself off the ticker's `data-count`, not the moving text. */
function footerCount(container: HTMLElement): string | null {
  return container.querySelector(".logs-foot [data-count]")?.getAttribute("data-count") ?? null;
}

afterEach(cleanup);

/** The timings a number-flow element carries as properties, in milliseconds. */
const rollTimings = z.object({
  transformTiming: z.object({ duration: z.number() }),
  spinTiming: z.object({ duration: z.number() }).optional(),
});

function mkRun(patch: Partial<RunView>): RunView {
  return {
    id: "primary", serverRunId: "run_1", role: "Primary specialist", kind: "primary",
    who: { kind: "agent", backend: "claude", name: "Claude Code", role: "Developer" },
    backend: "claude", sdk: "Claude Agent SDK", model: "claude-sonnet-4-5",
    exportable: false, sid: "51d8f0e2-3a7b", state: "running", lifecycle: "running", interruptedBy: null,
    phase: "Running validation sweep", step: "Bash · npm test", startedAt: new Date(Date.now() - 402_000).toISOString(),
    finished: null, turns: 0, tokens: 0, tokensEstimated: false, cache: NO_RUN_CACHE,
    lines: [{ t: "1", ev: "init", tag: "system·init", text: "session x" }],
    raw: ['{"type":"system","subtype":"init","session_id":"51d8f0e2"}'], lineCount: 1,
    logWindow: { totalLines: 1, hasMore: false, runIds: ["run_1"], oldest: null, headSeq: 0 },
    ...patch,
    profileId: patch.profileId ?? "developer",
  };
}

describe("LiveRunPanel", () => {
  it("renders nothing when no run is running", () => {
    const { container } = render(
      <LiveRunPanel runtime={[mkRun({ state: "idle", lifecycle: "finished" })]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />,
    );
    expect(container.querySelector(".runbar")).toBeNull();
  });

  it("shows the running run + a who-chip (single) with elapsed from startedAt", () => {
    const { container, getByText } = render(
      <LiveRunPanel runtime={[mkRun({})]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />,
    );
    expect(container.querySelector(".runbar")).not.toBeNull();
    expect(getByText("1 agent running")).toBeTruthy();
    expect(container.querySelector(".who-chip")).not.toBeNull();
    // Elapsed derives from startedAt (~402s → 06:42), never a fabricated count.
    // Ruling 366(e): the digits roll (`@number-flow/react`), and the plain
    // figure rides the wrapper's `data-clock` for anyone reading the DOM.
    expect(container.querySelector(".run-cell .lw-clock")!.getAttribute("data-clock")).toBe("06:42");
    // The Runtime cell names the model the run is on, for the task page's
    // strip and the controller's alike.
    const runtime = [...container.querySelectorAll(".run-cell")].find(
      (c) => c.querySelector(".lbl")?.textContent === "Runtime",
    );
    expect(runtime?.querySelector(".val")?.textContent).toBe("claude-sonnet-4-5");
  });

  it("ruling 524(b): the Elapsed clock's digits land well inside its one-second tick", () => {
    // number-flow's own roll is a 900 ms spring, so the seconds were mid-roll
    // nine tenths of every second: two glyphs half in view, read as "03:1"
    // (owner's screenshot, 2026-09-27). A roll that ends inside half a tick
    // leaves the digit standing for most of it. CANARY: drop
    // `transformTiming` from the clock's fields and the 900 ms comes back.
    const { container } = render(
      <LiveRunPanel runtime={[mkRun({})]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />,
    );
    const fields = [...container.querySelectorAll(".run-cell .lw-clock[data-clock] number-flow-react")];
    expect(fields.length).toBeGreaterThan(1);
    for (const field of fields) {
      // The element rolls its digits with `spinTiming`, falling back to
      // `transformTiming`, and moves them with `transformTiming`; both are
      // properties number-flow sets on it.
      const { transformTiming, spinTiming } = rollTimings.parse(field);
      expect(transformTiming.duration).toBeLessThanOrEqual(500);
      expect((spinTiming ?? transformTiming).duration).toBeLessThanOrEqual(500);
    }
  });

  it("ruling 524(c): a controller turn's card names it once", () => {
    // The turn is "Controller" in the role "Controller", and the card's head
    // read "Controller · Controller". A renamed controller keeps its role.
    // CANARY: append `who.role` after the name unconditionally again.
    const turn = (name: string) =>
      mkRun({ id: "controller", kind: "controller", role: "Controller", who: { kind: "agent", backend: "claude", name, role: "Controller" } });
    const chip = (run: RunView) => {
      const { container, unmount } = render(
        <LiveRunPanel runtime={[run]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />,
      );
      const text = container.querySelector(".who-chip .nm")!.textContent;
      unmount();
      return text;
    };
    expect(chip(turn("Controller"))).toBe("Controller");
    expect(chip(turn("Atlas"))).toBe("Atlas · Controller");
  });

  /**
   * F35-1: the Tokens cell tells an estimate from a total. While the row holds
   * the Claude adapter's live estimate it prints `~n` with the tooltip; a
   * Codex run before its turn ends prints "pending"; a provider total prints
   * plain. Canary: print `fmtTok(run.tokens)` unconditionally and both the
   * tilde and the tooltip are gone.
   */
  it("prints an estimated token figure as ~n with a tooltip, null as pending, a total plain", () => {
    const cell = (run: RunView) => {
      const { container, unmount } = render(
        <LiveRunPanel runtime={[run]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />,
      );
      const vals = [...container.querySelectorAll(".run-cell")].find((c) => c.querySelector(".lbl")?.textContent === "Tokens")!.querySelector<HTMLElement>(".val")!;
      // 366(e): a rolling figure carries its plain text on `data-tokens`.
      const out = {
        text: vals.querySelector(".lw-clock")?.getAttribute("data-tokens") ?? vals.textContent,
        title: vals.getAttribute("title"),
      };
      unmount();
      return out;
    };
    expect(cell(mkRun({ tokens: 1500, tokensEstimated: true }))).toEqual({
      text: "~1.5k",
      title: "Estimated from the streamed text. The provider's own total replaces it when one lands; a run that was stopped never gets one",
    });
    expect(cell(mkRun({ tokens: null, tokensEstimated: true }))).toEqual({ text: "pending", title: null });
    expect(cell(mkRun({ tokens: 1500, tokensEstimated: false }))).toEqual({ text: "1.5k", title: null });
  });

  it("shows the AgentPicker when 2+ runs are running (concurrent case)", () => {
    const runs = [mkRun({ id: "primary" }), mkRun({ id: "c0", who: { kind: "agent", backend: "codex", name: "Codex", role: "Reviewer" }, backend: "codex" })];
    const { container, getByText } = render(
      <LiveRunPanel runtime={runs} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />,
    );
    expect(getByText("2 agents running")).toBeTruthy();
    expect(container.querySelector(".rsel")).not.toBeNull();
    expect(container.querySelector(".who-chip")).toBeNull();
  });

  /**
   * R21-4a / G5 (FR28): the phase rows are the strip's only answer to "what is
   * it doing right now". `onPhase` was wired end-to-end but no adapter ever
   * called it, so `phase`/`step` were null for every real run and this rendered
   * a spinner beside two empty lines.
   */
  it("renders the phase and step the run reports", () => {
    const { container } = render(
      <LiveRunPanel
        runtime={[mkRun({ phase: "Preparing workspace", step: "Cloning acme/app" })]}
        onViewLogs={() => {}}
        onInterrupt={() => {}}
        canInterrupt
        interrupting={false}
      />,
    );
    expect(container.querySelector(".run-phase .ph")?.textContent).toBe(
      "Preparing workspace",
    );
    expect(container.querySelector(".run-phase .step")?.textContent).toBe(
      "Cloning acme/app",
    );
    // Ruling 478(c) (F40-33): phase and step sit in the text column the sheet
    // lets shrink (`.run-phase-text { min-width: 0 }`, app.css.test.ts), so a
    // long step cuts at the strip's edge. CANARY: drop the class.
    const column = container.querySelector(".run-phase > .run-phase-text")!;
    expect(column.querySelector(":scope > .ph")).not.toBeNull();
    expect(column.querySelector(":scope > .step")).not.toBeNull();
  });

  it("U39-26: reads a tool step as words, keeping the stored step on hover", () => {
    // Live on the controller page, above the conversation: "composing ·
    // mcp__viberr_controller__read_knowledge_base_doc · id: kb_HZpcYS3sovrJ ·
    // path: architecture.md answered". CANARY: render `run.step` raw again.
    const stored =
      "composing · mcp__viberr_controller__read_knowledge_base_doc · path: architecture.md answered";
    const { container } = render(
      <LiveRunPanel
        runtime={[mkRun({ phase: "Working", step: stored })]}
        onViewLogs={() => {}}
        onInterrupt={() => {}}
        canInterrupt
        interrupting={false}
      />,
    );
    const step = container.querySelector(".run-phase .step")!;
    expect(step.textContent).toBe("composing · read knowledge base doc · path: architecture.md answered");
    expect(step.getAttribute("title")).toBe(stored);
  });

  it("never renders an empty heading — a phase-less running row still says something", () => {
    const { container } = render(
      <LiveRunPanel
        runtime={[mkRun({ phase: null, step: null })]}
        onViewLogs={() => {}}
        onInterrupt={() => {}}
        canInterrupt
        interrupting={false}
      />,
    );
    expect(container.querySelector(".run-phase .ph")?.textContent).toBe("Working");
    // …and the step row is omitted rather than rendered blank.
    expect(container.querySelector(".run-phase .step")).toBeNull();
  });

  it("hides Interrupt when the viewer cannot interrupt; fires onInterrupt otherwise", () => {
    const onInterrupt = vi.fn();
    const { container, queryByText, rerender, getByText } = render(
      <LiveRunPanel runtime={[mkRun({})]} onViewLogs={() => {}} onInterrupt={onInterrupt} canInterrupt={false} interrupting={false} />,
    );
    expect(queryByText("Interrupt")).toBeNull();
    rerender(<LiveRunPanel runtime={[mkRun({})]} onViewLogs={() => {}} onInterrupt={onInterrupt} canInterrupt interrupting={false} />);
    // Ruling 150: a stop discards the work in flight, so this trigger wears
    // ruling 149's red label like the confirm it opens — and its sibling
    // "View logs", which takes nothing away, stays neutral. Canary: drop
    // `danger` from the class and the row holds no danger control at all.
    const reds = container.querySelectorAll(".run-actions .btn.danger");
    expect(reds).toHaveLength(1);
    expect(reds[0]!.textContent).toContain("Interrupt");
    fireEvent.click(getByText("Interrupt"));
    expect(onInterrupt).toHaveBeenCalledWith("primary");
  });
});

describe("AgentLogsPanel", () => {
  it("renders the exact empty state when the task has no runtime", () => {
    const { getByText } = render(<Logs runtime={[]} sel={null} onSel={() => {}} linesByThread={{}} />);
    expect(getByText("No agent runs yet. Runtime streams appear here once the operator engages a specialist.")).toBeTruthy();
  });

  it("running thread: streaming footer + cursor line + running pill", () => {
    const { container, getByText } = render(
      <Logs runtime={[mkRun({})]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "init", tag: "system·init", text: "x" }, raw: "{}" }] }} />,
    );
    expect(getByText("streaming: raw output stays here as evidence, never in the task record")).toBeTruthy();
    expect(container.querySelector(".log-line.cursor")).not.toBeNull();
    expect(container.querySelector(".logs-bar .pill.agent")).not.toBeNull();
  });

  it("a controller turn's streaming footer names the transcript, not a task record", () => {
    // Ruling 99: the console now renders on the controller page too, where
    // "the task record" names a thing the run does not have.
    const run = mkRun({ id: "controller", kind: "controller", role: "Controller",
      who: { kind: "agent", backend: "claude", name: "Controller", role: "Controller" } });
    const { getByText } = render(
      <Logs runtime={[run]} sel="controller" onSel={() => {}} linesByThread={{}} />,
    );
    expect(getByText("streaming: raw output stays here as evidence, never in the transcript")).toBeTruthy();
  });

  it("ruling 419(d): a finished controller turn is continued from the composer, and wears no role", () => {
    // Live on the ax-clone controller page: "Controller · supporting" and "run
    // finished at 00:56; thread can be re-engaged", two pieces of a task
    // engagement's vocabulary on a surface with no task and no engagement.
    // CANARY: drop the `kind === "controller"` footer branch, or the
    // `roleShort` null, and one half fails.
    const run = mkRun({ id: "controller", kind: "controller", role: "Controller", state: "done", lifecycle: "finished", finished: "0:56",
      who: { kind: "agent", backend: "claude", name: "Controller", role: "Controller" } });
    const { container, getByText } = render(
      <Logs runtime={[run]} sel="controller" onSel={() => {}} linesByThread={{}} />,
    );
    expect(getByText("turn finished at 0:56; send a message to continue the conversation")).toBeTruthy();
    expect(container.textContent).not.toContain("re-engaged");
    expect(container.querySelector(".rsel-role")).toBeNull();
  });

  it("done thread: 'run finished at …' footer, no cursor", () => {
    const run = mkRun({ state: "done", lifecycle: "finished", finished: "9:41" });
    const { container, getByText } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: run.lines.map((d, i) => ({ display: d, raw: run.raw[i]! })) }} />,
    );
    expect(getByText("run finished at 9:41; thread can be re-engaged")).toBeTruthy();
    expect(container.querySelector(".log-line.cursor")).toBeNull();
  });

  it("error thread: continuity-error footer + blocked pill", () => {
    const run = mkRun({ state: "error", lifecycle: "error" });
    const { container, getByText } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "err", tag: "tool_result", text: "boom" }, raw: "{}" }] }} />,
    );
    expect(getByText("stream ended on a continuity error; see the blocked packet")).toBeTruthy();
    expect(container.querySelector(".logs-bar .pill.blocked")).not.toBeNull();
  });

  /**
   * Ruling 127: a run refused because the task has no owner is not a continuity
   * error, and no backend switch fixes it. The projection marks the run
   * `failedBackendUnavailable` (that is what happened) and withholds
   * `altBackend` (there is nobody to bill), so the footer must state the
   * failure and advertise no retry at all.
   */
  it("refused-with-no-principal: states the failure, offers no retry", () => {
    const run = mkRun({
      state: "error",
      lifecycle: "error",
      failedBackendUnavailable: true,
    });
    const { container, getByText } = render(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        onRetryBackend={() => {}}
        retryBackends={["claude", "codex"]}
        linesByThread={{ primary: [] }}
      />,
    );
    expect(
      getByText(
        "Claude could not run this (quota, rate limit, or an account that cannot run it)",
      ),
    ).toBeTruthy();
    expect(container.querySelector(".logs-bar .btn.sm")).toBeNull();
  });

  it("withholds the retry button when the owner has not connected the other backend", () => {
    // The blocked packet on the same task withholds `retry_other_backend` for
    // exactly this reason; the button used to offer it anyway and produce a
    // second identically refused run.
    const run = mkRun({
      state: "error",
      lifecycle: "error",
      failedBackendUnavailable: true,
      altBackend: "codex",
    });
    const onRetryBackend = vi.fn();
    const { container, getByText, queryByText, rerender } = render(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        onRetryBackend={onRetryBackend}
        retryBackends={["claude"]}
        linesByThread={{ primary: [] }}
      />,
    );
    expect(queryByText("Retry on Codex")).toBeNull();
    // …and the absent control is EXPLAINED, not merely missing: the same
    // sentence the blocked packet's withheld `retry_other_backend` implies.
    expect(
      getByText(
        "Claude could not run this (quota, rate limit, or an account that cannot run it). Codex isn't connected for the task owner, so there is no other backend to retry on",
      ),
    ).toBeTruthy();

    // Pass 34 review: an OPERATOR run has no retry to offer here, so the
    // credential clause (about a retry that does not exist) must not appear.
    // Canary: drop the `retryOffered` gate — the operator footer claims the
    // task owner has not connected Codex, whether or not they have.
    rerender(
      <Logs
        runtime={[
          mkRun({
            id: "operator",
            kind: "operator",
            role: "Operator",
            backend: "claude",
            state: "error",
            lifecycle: "error",
            // The classified quota footer — the sentence ruling 130(a) added,
            // which is where the clause was being appended.
            failureKind: "quota",
            failedBackendUnavailable: true,
            altBackend: "codex",
          }),
        ]}
        sel="operator"
        onSel={() => {}}
        onRetryBackend={onRetryBackend}
        retryBackends={["claude"]}
        linesByThread={{ operator: [] }}
      />,
    );
    // Non-vacuity: the classified quota sentence IS on screen…
    expect(container.querySelector(".logs-foot")!.textContent).toContain(
      "refused this run: the account's usage window is spent",
    );
    // …and it does not carry the retry clause, which this run kind has no
    // retry for.
    expect(queryByText(/isn't connected for the task owner/)).toBeNull();

    // Owner connects Codex: the same run now carries a real offer.
    rerender(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        onRetryBackend={onRetryBackend}
        retryBackends={["claude", "codex"]}
        linesByThread={{ primary: [] }}
      />,
    );
    fireEvent.click(getByText("Retry on Codex"));
    expect(onRetryBackend).toHaveBeenCalledWith("codex", run);
    expect(container.querySelector(".logs-bar .btn.sm")).not.toBeNull();
  });

  it("tells a viewer without the grant that a maintainer can retry — only when one could", () => {
    // UI-38: the failure explanation describes the RUN, so it renders for
    // everyone; only the BUTTON is grant-gated. The retry CLAUSE follows the
    // offer, so it appears only where a retry would actually run.
    const run = mkRun({
      state: "error",
      lifecycle: "error",
      failedBackendUnavailable: true,
      altBackend: "codex",
    });
    const { getByText } = render(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        retryBackends={["codex"]}
        linesByThread={{ primary: [] }}
      />,
    );
    expect(
      getByText(
        "Claude could not run this (quota, rate limit, or an account that cannot run it). A maintainer can retry it on the other backend",
      ),
    ).toBeTruthy();
  });

  it("claims nothing about the owner when the caller never asked (no retryBackends)", () => {
    // Absent prop = this surface did not resolve a principal, which is not the
    // same as "asked, and nobody can be billed". It offers nothing (a button
    // would dispatch a run it cannot vouch for) and asserts nothing either.
    const run = mkRun({
      state: "error",
      lifecycle: "error",
      failedBackendUnavailable: true,
      altBackend: "codex",
    });
    const { container, getByText } = render(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        onRetryBackend={() => {}}
        linesByThread={{ primary: [] }}
      />,
    );
    expect(
      getByText(
        "Claude could not run this (quota, rate limit, or an account that cannot run it)",
      ),
    ).toBeTruthy();
    expect(container.querySelector(".logs-bar .btn.sm")).toBeNull();
  });

  // F15-08: the stored `t` is a UTC wall clock and the timeline on the same
  // page is local. The zone is pinned (CI is UTC) so a console that rendered
  // `t` verbatim — the bug — cannot satisfy this.
  it("renders each line's clock in the VIEWER's zone, anchored to the run", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
    try {
      const run = mkRun({
        state: "idle",
        lifecycle: "finished",
        startedAt: "2026-07-28T17:40:00.000Z",
      });
      const { container } = render(
        <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "17:46:46", ev: "text", tag: "agent_message", text: "done" }, raw: "{}" }] }} />,
      );
      const stamps = [...container.querySelectorAll(".log-line .lt")].map(
        (n) => n.textContent,
      );
      expect(stamps).toContain("19:46:46");
      expect(stamps).not.toContain("17:46:46");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("raw toggle renders the stored wire envelope verbatim", () => {
    const raw = '{"type":"system","subtype":"init","session_id":"51d8f0e2"}';
    const { container, getByText, queryByText } = render(
      <Logs runtime={[mkRun({ state: "idle", lifecycle: "finished" })]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "init", tag: "system·init", text: "friendly text" }, raw }] }} />,
    );
    expect(getByText("friendly text")).toBeTruthy();
    fireEvent.click(getByText("{ } raw"));
    expect(container.textContent).toContain(raw);
    expect(queryByText("friendly text")).toBeNull();
  });

  /* ---------------------------------------------------------- P19-RC1 */

  it("folds a reasoning RUN behind a measured summary, and the raw toggle still shows every line", () => {
    const rawA = '{"type":"reasoning","text":"weighing the options"}';
    const rawB = '{"type":"reasoning","text":"picking the branch"}';
    const { container, getByText, queryByText, getByRole, queryByRole } = render(
      <Logs
        runtime={[mkRun({ state: "idle", lifecycle: "finished", lineCount: 2 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [
            { display: { t: "10:00:01", ev: "think", tag: "reasoning", text: "weighing the options" }, raw: rawA },
            { display: { t: "10:00:05", ev: "think", tag: "reasoning", text: "picking the branch" }, raw: rawB },
          ],
        }}
      />,
    );
    // Folded: the summary is measured from the stored clocks, and the steps are
    // behind it rather than gone. Ruling 499: the verb stands above the figure
    // and a chevron opens the steps (AICSS's thinking block); a finished run's
    // fold never shimmers.
    const summary = getByRole("button", { name: "Thought for 4s · 2 steps" });
    expect(summary.querySelector(".lk-verb")!.textContent).toBe("Thought");
    expect(summary.querySelector(".log-shimmer")).toBeNull();
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("weighing the options")).toBeNull();
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("weighing the options")).toBeTruthy();
    expect(getByText("picking the branch")).toBeTruthy();

    // …and `raw` is authoritative: no fold, both stored envelopes verbatim.
    fireEvent.click(getByText("{ } raw"));
    expect(container.textContent).toContain(rawA);
    expect(container.textContent).toContain(rawB);
    expect(queryByRole("button", { name: /Thought for/ })).toBeNull();
  });

  it("renders a tool call as a chip and file changes as per-file chips", () => {
    const { container, getByText, queryByText } = render(
      <Logs
        runtime={[mkRun({ state: "idle", lifecycle: "finished", lineCount: 2 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [
            { display: { t: "10:00:01", ev: "tool", tag: "tool_use", name: "Bash", text: "npm run build" }, raw: '{"type":"tool_use","name":"Bash"}' },
            {
              display: {
                t: "10:00:02", ev: "diff", tag: "file_change", text: "2 files",
                changes: [
                  { path: "app/a.ts", kind: "add" },
                  { path: "app/b.ts", kind: "delete" },
                ],
              },
              raw: '{"type":"file_change"}',
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".log-chip .lc-name")!.textContent).toBe("Bash");
    expect(getByText("npm run build")).toBeTruthy();
    const files = [...container.querySelectorAll(".log-file")];
    expect(files.map((f) => f.textContent)).toEqual([
      "+added app/a.ts",
      "−deleted app/b.ts",
    ]);
    // WCAG 1.4.1: the kind is a glyph as well as a colour class.
    expect(files[0]!.className).toContain("lf-add");
    expect(files[1]!.className).toContain("lf-delete");
    // ...and the glyph is not the only carrier: the word is what a reader
    // hears, the mark is hidden from them, and the title is finally set.
    expect(files.map((f) => f.getAttribute("title"))).toEqual([
      "added",
      "deleted",
    ]);
    expect(
      files[1]!.querySelector(".lf-kind")!.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(files[1]!.querySelector(".vh")!.textContent).toBe("deleted ");

    fireEvent.click(getByText("{ } raw"));
    expect(container.querySelector(".log-chip")).toBeNull();
    expect(container.querySelector(".log-file")).toBeNull();
    expect(queryByText("npm run build")).toBeNull();
  });

  /**
   * Ruling 366: a call's heartbeats are one wait row — the orb while the call
   * is still open, the clock once anything landed after it — and a Viberr
   * tool's chip is marked as the product's own. Canary: drop the wait branch
   * from `createConsoleFolder` and two `.log-line.wait` rows never appear (the
   * heartbeats render as plain meta rows).
   */
  it("folds heartbeats into a wait row: orb while live, clock once ended, the chip marked as Viberr's", () => {
    const beat = (n: number, elapsed: number): StreamedLine => ({
      display: {
        t: `10:0${n}:00`, ev: "meta", tag: "tool_progress", name: "mcp__viberr__run_agent",
        text: `mcp__viberr__run_agent still running · ${elapsed}s`,
        // No instant: the live row prints the static words, no count runs.
        progress: { call: "toolu_1", elapsed, heartbeat: true, at: null },
      },
      raw: `{"type":"tool_progress","elapsed_time_seconds":${elapsed}}`,
    });
    const call: StreamedLine = {
      display: { t: "10:00:00", ev: "tool", tag: "tool_use", name: "mcp__viberr__run_agent", text: "profileId: developer" },
      raw: '{"type":"assistant"}',
    };
    const live = render(
      <Logs
        runtime={[mkRun({ lineCount: 3 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: [call, beat(1, 30), beat(2, 60)] }}
      />,
    );
    const rows = live.container.querySelectorAll(".log-line.wait");
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.className).toContain("lw-live");
    // Ruling 499: AICSS's lattice orb, nine CSS dots; a Viberr tool's runs its
    // ring rather than radiating.
    const orb = row.querySelector(".log-orb")!;
    expect(orb).not.toBeNull();
    expect(orb.getAttribute("aria-hidden")).toBe("true");
    expect(orb.getAttribute("data-orb")).toBe("ring");
    expect(orb.querySelectorAll(":scope > i")).toHaveLength(9);
    expect(row.textContent).toContain("still running · 1m");
    // 366(d): the fold says what it hid, and opens to list every heartbeat
    // under a note that says what one is.
    const fold = row.querySelector<HTMLButtonElement>("button.log-more")!;
    expect(fold.textContent).toBe("2 heartbeats");
    expect(row.textContent).toContain("2 heartbeats, no output");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    // Tag and text only: the clock column is reprojected into the viewer's
    // zone after hydration, so it is not something a test should pin.
    const steps = [...live.container.querySelectorAll(".log-line.tstep")].map((r) => [
      r.querySelector(".ltag")!.textContent,
      r.querySelector(".lx")!.textContent,
    ]);
    expect(steps).toEqual([
      ["heartbeat", "A heartbeat is the runtime saying the call is still open: about one every 30 s, carrying no output. Nothing here changed the run."],
      ["tool_progress", "heartbeat 1 · 30s in"],
      ["tool_progress", "heartbeat 2 · 1m in"],
    ]);
    fireEvent.click(fold);
    expect(live.container.querySelector(".log-line.tstep")).toBeNull();
    // The chip is Viberr's: tinted, marked, the prefix gone, and the word read
    // to assistive tech so the mark is never the only carrier.
    const chip = row.querySelector(".log-chip.vb .lc-name")!;
    expect(chip.querySelector(".lc-mark")).not.toBeNull();
    expect(chip.textContent).toBe("viberr run_agent");
    expect(chip.getAttribute("title")).toBe("Viberr's own tool · mcp__viberr__run_agent");
    // …and the call's own chip carries the same mark; a built-in never does.
    expect(live.container.querySelectorAll(".log-chip.vb").length).toBe(2);
    live.unmount();

    const done: StreamedLine = {
      display: { t: "10:03:00", ev: "out", tag: "tool_result", text: "ok" },
      raw: '{"type":"user"}',
    };
    const ended = render(
      <Logs
        runtime={[mkRun({ lineCount: 4 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: [call, beat(1, 30), beat(2, 60), done] }}
      />,
    );
    const past = ended.container.querySelector(".log-line.wait")!;
    expect(past.className).not.toContain("lw-live");
    expect(past.querySelector("canvas")).toBeNull();
    expect(past.querySelector(".ico")).not.toBeNull();
    // Ruling 459: the sheet sizes and greys the ended row's clock as
    // `.lw-glyph > .ico`, so the clock must stay a direct child of the row's
    // glyph cell. That the rule never reaches the Viberr chip's V mark is the
    // sheet's side, pinned in app.css.test.ts by "(F47) the wait row's rule
    // reaches its own clock, never the Viberr chip's mark".
    // Canary: wrap the clock in a span and this line goes red.
    expect(past.querySelectorAll(".lw-glyph > .ico")).toHaveLength(1);
    expect(past.textContent).toContain("ran past 1m");

    // `raw` is authoritative: every heartbeat verbatim, no fold, no chip.
    fireEvent.click(ended.getByText("{ } raw"));
    expect(ended.container.querySelector(".log-line.wait")).toBeNull();
    expect(ended.container.querySelector("canvas")).toBeNull();
    expect(ended.container.textContent).toContain('"elapsed_time_seconds":30');
    expect(ended.container.textContent).toContain('"elapsed_time_seconds":60');
  });

  it("lifts multi-line output into a bounded block, whole and copyable", () => {
    const out = ["> npm test", "", "34 passed", "done in 1.2s"].join("\n");
    const { container, getByRole } = render(
      <Logs
        runtime={[mkRun({ state: "idle", lifecycle: "finished", lineCount: 1 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [{ display: { t: "10:00:01", ev: "out", tag: "tool_result", text: out }, raw: '{"type":"tool_result"}' }],
        }}
      />,
    );
    const block = container.querySelector(".log-code")!;
    expect(block).toBeTruthy();
    // Every line is present — the block is bounded by CSS and scrolls, it never
    // drops the tail of what the agent produced.
    expect(container.querySelectorAll(".log-code .lk-line")).toHaveLength(4);
    expect(block.textContent).toContain("34 passed");
    expect(block.textContent).toContain("done in 1.2s");
    // Ruling 499: AICSS's code block. The head names what it holds and its
    // size, and carries Copy with the copy mark; the lines are numbered in a
    // gutter assistive tech and the selection skip.
    expect(block.querySelector(".lk-meta")!.textContent).toBe("Output · 4 lines");
    const copy = getByRole("button", { name: "Copy this output" });
    expect(copy.textContent).toBe("Copy");
    expect(copy.querySelector(".copy-glyph")).not.toBeNull();
    const nums = [...block.querySelectorAll(".lk-num")];
    expect(nums.map((n) => n.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(nums.every((n) => n.getAttribute("aria-hidden") === "true")).toBe(true);
    expect([...block.querySelectorAll(".lk-text")].map((t) => t.textContent)).toEqual([
      "> npm test",
      " ",
      "34 passed",
      "done in 1.2s",
    ]);
    // The text is not ALSO printed inline above the block.
    expect(container.querySelectorAll(".log-line.out .lx")[0]!.textContent).toBe(
      block.textContent,
    );
  });

  it("colours diff polarity on top of the glyph the stored line already carries", () => {
    const { container } = render(
      <Logs
        runtime={[mkRun({ state: "idle", lifecycle: "finished", lineCount: 1 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [
            {
              display: {
                t: "10:00:01", ev: "diff", tag: "patch",
                text: ["--- a/app/a.ts", "+++ b/app/a.ts", "+const next = 1;", "-const prev = 0;", " unchanged"].join("\n"),
              },
              raw: '{"type":"patch"}',
            },
          ],
        }}
      />,
    );
    const lines = [...container.querySelectorAll(".log-code .lk-line")];
    expect(lines.map((l) => l.className)).toEqual([
      "lk-line", // --- header, not a removal
      "lk-line", // +++ header, not an addition
      "lk-line lk-add",
      "lk-line lk-del",
      "lk-line",
    ]);
  });

  // P14-WL-02: the console rendered `rate_limit_event` JSON blobs and dozens of
  // `system·thinking_tokens` rows as ordinary timeline lines, burying the run.
  it("folds wire telemetry into one row, and the raw toggle still shows it", () => {
    const rawTelemetry = '{"type":"rate_limit_event","rate_limits":{"primary":{"used_percent":12}}}';
    const { container, getByText, queryByText } = render(
      <Logs
        runtime={[mkRun({ state: "idle", lifecycle: "finished", lineCount: 4 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [
            { display: { t: "1", ev: "tool", tag: "tool_use", text: "npm test", name: "Bash" }, raw: "{}" },
            { display: { t: "2", ev: "meta", tag: "system·thinking_tokens", text: "thinking_tokens" }, raw: "{}" },
            { display: { t: "3", ev: "meta", tag: "system·thinking_tokens", text: "thinking_tokens" }, raw: "{}" },
            { display: { t: "4", ev: "meta", tag: "rate_limit_event", text: rawTelemetry }, raw: rawTelemetry },
          ],
        }}
      />,
    );
    expect(getByText("npm test")).toBeTruthy();
    // Three telemetry rows became one that says so — and the blob is not drawn.
    expect(container.querySelectorAll(".log-line")).toHaveLength(2);
    expect(getByText(/3 telemetry events/)).toBeTruthy();
    expect(queryByText(rawTelemetry)).toBeNull();
    // The stored stream stays reachable, unfolded, behind the existing toggle.
    fireEvent.click(getByText("{ } raw"));
    expect(container.querySelectorAll(".log-line")).toHaveLength(4);
    expect(container.textContent).toContain(rawTelemetry);
    // The footer counts stored lines, so folding never changes the total.
    // Ruling 366(f): the total counts up, so the figure is read off `data-count`.
    expect(footerCount(container)).toBe("4");
  });

  it("codex meta line vs claude meta line", () => {
    const codex = mkRun({ backend: "codex", sid: "0199a2c4-7b31-7802", state: "idle", lifecycle: "finished" });
    const { getByText } = render(
      <Logs runtime={[codex]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(getByText(/@openai\/codex-sdk · runStreamed\(\) · thread/)).toBeTruthy();
  });

  it("the picker labels each agent by its who.name (grouped, one per agent)", () => {
    // Two grouped entries: the operator + a "dev" specialist (BUG 2).
    const op = mkRun({ id: "op", op: true, who: { kind: "agent", name: "Operator" }, state: "idle", lifecycle: "finished" });
    const dev = mkRun({ id: "primary", who: { kind: "agent", backend: "claude", name: "dev", role: "developer" }, state: "idle", lifecycle: "finished" });
    const { container } = render(
      <Logs runtime={[op, dev]} sel="primary" onSel={() => {}} linesByThread={{ op: [], primary: [] }} />,
    );
    // The picker button shows the selected agent's name (not "Claude Code").
    expect(container.querySelector(".rsel-nm")!.textContent).toContain("dev");
    // Open the dropdown → both grouped entries appear as options, by name.
    fireEvent.click(container.querySelector(".rsel-btn")!);
    const optionText = [...container.querySelectorAll('[role="option"] .ri-nm')].map((n) => n.textContent);
    expect(optionText.some((t) => t?.includes("Operator"))).toBe(true);
    expect(optionText.some((t) => t?.includes("dev"))).toBe(true);
  });

  it("selecting an agent in the picker shows that agent's lines (BUG 3 auto-select)", () => {
    const dev = mkRun({ id: "primary", who: { kind: "agent", backend: "claude", name: "dev", role: "developer" }, state: "running", lifecycle: "running" });
    const other = mkRun({ id: "op", op: true, who: { kind: "agent", name: "Operator" }, state: "idle", lifecycle: "finished" });
    const onSel = vi.fn();
    // Select "dev": its streamed lines render in the console.
    const { container, getByText, rerender } = render(
      <Logs
        runtime={[other, dev]}
        sel="op"
        onSel={onSel}
        linesByThread={{
          op: [{ display: { t: "1", ev: "text", tag: "assistant", text: "operator line" }, raw: "{}" }],
          primary: [{ display: { t: "1", ev: "text", tag: "assistant", text: "dev is streaming" }, raw: "{}" }],
        }}
      />,
    );
    // Initially the operator's line shows.
    expect(container.textContent).toContain("operator line");
    // Simulate the auto-select landing on "dev" (parent set sel=primary).
    rerender(
      <Logs
        runtime={[other, dev]}
        sel="primary"
        onSel={onSel}
        linesByThread={{
          op: [{ display: { t: "1", ev: "text", tag: "assistant", text: "operator line" }, raw: "{}" }],
          primary: [{ display: { t: "1", ev: "text", tag: "assistant", text: "dev is streaming" }, raw: "{}" }],
        }}
      />,
    );
    expect(getByText("dev is streaming")).toBeTruthy();
    // Streaming footer confirms the live (running) dev thread is selected.
    expect(getByText("streaming: raw output stays here as evidence, never in the task record")).toBeTruthy();
  });

  it("session id is trimmed but expandable and copyable in full", () => {
    const run = mkRun({ backend: "claude", sid: "51d8f0e2-3a7b-4c1b-9e0a-6f4d2b8c7151", state: "idle", lifecycle: "finished" });
    const { getByRole } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    // Trimmed by default.
    const idBtn = getByRole("button", { name: /Session id 51d8f0e2-3a7b-4c1b-9e0a-6f4d2b8c7151/ });
    expect(idBtn.textContent).toBe("51d8f0e2…");
    // Click expands to the full id.
    fireEvent.click(idBtn);
    expect(idBtn.textContent).toBe("51d8f0e2-3a7b-4c1b-9e0a-6f4d2b8c7151");
    // A copy control is present.
    expect(getByRole("button", { name: /Copy full session id/ })).toBeTruthy();
  });

  it("ruling 148: a run with no session id says so in words", () => {
    const run = mkRun({ backend: "claude", sid: null, state: "idle", lifecycle: "finished" });
    const { container, queryByRole } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    const meta = container.querySelector(".logs-meta")!;
    // The label word precedes it, so the line reads "session none" — a "−" sat
    // where every other run shows a click-to-expand control.
    expect(meta.textContent).toContain("session none");
    expect(meta.textContent).not.toContain("−");
    // And nothing in that slot pretends to be a control.
    expect(queryByRole("button", { name: /Copy full session id/ })).toBeNull();
  });

  it("ruling 148: a finished run with no timestamp drops the clause", () => {
    // The same class inside a SENTENCE: "run finished at −; thread can be
    // re-engaged" read as a broken template.
    // Canary: put the `: "−"` fallback back and this goes red.
    const run = mkRun({ state: "done", lifecycle: "finished", finished: null });
    const { getByText, container } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(getByText("run finished; thread can be re-engaged")).toBeTruthy();
    expect(container.querySelector(".logs-foot")!.textContent).not.toContain("−");
  });

  it("P11-43: the Export link renders only when the run is exportable", () => {
    const notExportable = mkRun({
      backend: "claude",
      sid: "aaaa-1111",
      state: "idle",
      lifecycle: "finished",
      exportable: false,
    });
    const { queryByTitle, rerender } = render(
      <Logs runtime={[notExportable]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(queryByTitle(/Export this session/)).toBeNull();

    const exportable = mkRun({
      backend: "claude",
      sid: "aaaa-1111",
      state: "idle",
      lifecycle: "finished",
      exportable: true,
    });
    rerender(
      <Logs runtime={[exportable]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(queryByTitle(/Export this session/)).toBeTruthy();
  });
});

/**
 * P13-D-11 / NFR5: the loader ships a BOUNDED window of the agent group's
 * console, so the console starts mid-history on a long-lived task. It must stay
 * a paginated view of UI-53's whole history, not a truncation of it.
 */
describe("P13-D-11: the console pages backwards", () => {
  const withheldRun = () =>
    mkRun({
      state: "idle",
      lifecycle: "finished",
      finished: "2026-07-24T09:41:00.000Z",
      lineCount: 928,
      logWindow: {
        totalLines: 928,
        hasMore: true,
        runIds: ["run_0", "run_1"],
        oldest: { runId: "run_1", seq: 528 },
        headSeq: 927,
      },
    });
  const older = (patch: Partial<OlderLogState> = {}) =>
    ({
      primary: { hasMore: true, withheld: 528, loading: false, error: null, ...patch },
    }) satisfies Record<string, OlderLogState>;
  const rows = (n: number, prefix: string): StreamedLine[] =>
    Array.from({ length: n }, (_, i) => ({
      display: { t: "1", ev: "text" as const, tag: "assistant", text: `${prefix}${i}` },
      raw: "{}",
    }));

  it("offers a load-older affordance naming how many lines are withheld", () => {
    const onLoadOlder = vi.fn();
    const { getByText } = render(
      <Logs
        runtime={[withheldRun()]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: rows(3, "b") }}
        olderByThread={older()}
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(getByText("· 528 earlier lines not loaded")).toBeTruthy();
    fireEvent.click(getByText("load older lines"));
    expect(onLoadOlder).toHaveBeenCalledWith("primary");
  });

  it("hides the affordance once nothing older remains, and states a failed page", () => {
    const { queryByText, getByText, rerender } = render(
      <Logs
        runtime={[withheldRun()]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: rows(3, "b") }}
        olderByThread={older({ hasMore: false, withheld: 0 })}
        onLoadOlder={() => {}}
      />,
    );
    expect(queryByText("load older lines")).toBeNull();

    rerender(
      <Logs
        runtime={[withheldRun()]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: rows(3, "b") }}
        olderByThread={older({ error: "Older lines are project-member only." })}
        onLoadOlder={() => {}}
      />,
    );
    expect(getByText("· Older lines are project-member only.")).toBeTruthy();
  });

  it("keeps the reader's place when older lines are prepended", () => {
    // jsdom reports 0 for every layout box, so the console's geometry is
    // stubbed — the assertion is on the ARITHMETIC the panel does with it.
    const { container, getByText, rerender } = render(
      <Logs
        runtime={[withheldRun()]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: rows(20, "b") }}
        olderByThread={older()}
        onLoadOlder={() => {}}
      />,
    );
    const box = container.querySelector<HTMLElement>(".console")!;
    let height = 1000;
    Object.defineProperty(box, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(box, "clientHeight", { get: () => 320, configurable: true });
    box.scrollTop = 400;
    fireEvent.scroll(box); // 1000 - 400 - 320 = 280 from the bottom → not following

    fireEvent.click(getByText("load older lines"));
    height = 1600; // 30 older rows land ABOVE everything the reader was reading
    rerender(
      <Logs
        runtime={[withheldRun()]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: [...rows(30, "a"), ...rows(20, "b")] }}
        olderByThread={older({ withheld: 498 })}
        onLoadOlder={() => {}}
      />,
    );
    // Same lines under the cursor: offset moved by exactly the prepended height
    // (600), instead of the classic jump to the top or the bottom.
    expect(box.scrollTop).toBe(1000);
  });

  it("counts EVENTS as stored lines — never the synthetic run boundaries", () => {
    // UI-53's `── resumed ──` rows are not stored log lines and are not in
    // `lineCount`, so counting the rendered array double-counts them.
    const run = mkRun({
      state: "idle",
      lifecycle: "finished",
      lineCount: 6,
      logWindow: {
        totalLines: 6,
        hasMore: false,
        runIds: ["run_0", "run_1"],
        oldest: null,
        headSeq: 2,
      },
    });
    const { container, rerender } = render(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [
            ...rows(3, "a"),
            { display: runBoundaryLine(2, 2), raw: "" },
            ...rows(3, "b"),
          ],
        }}
      />,
    );
    expect(footerCount(container)).toBe("6");
    expect(container.querySelector(".logs-foot .mono")?.textContent).toMatch(/ events$/);

    // A live tail can run ahead of the loader's snapshot — the count follows
    // the lines that exist, so it never goes backwards.
    rerender(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [
            ...rows(3, "a"),
            { display: runBoundaryLine(2, 2), raw: "" },
            ...rows(5, "b"),
          ],
        }}
      />,
    );
    expect(footerCount(container)).toBe("8");
  });
});

/**
 * P16-UI-12 — the AgentPicker's hand-rolled outside-mousedown effect was
 * replaced by the shared `useDismiss` hook. It had NO document-level Escape:
 * the only Escape handler was a React `onKeyDown` on the trigger, so once focus
 * moved into the open listbox — which is the whole point of a listbox — Escape
 * did nothing and the only way out was a click elsewhere. The hook gives it the
 * same Escape every other popover in the app has.
 */
/**
 * UXV19-3 + UXV19-5: the run picker is the surface a user reads FIRST to choose
 * which stream to inspect, and it was the one place in the panel that spoke
 * neither the product's engagement vocabulary nor ruling 11's run lifecycle.
 */
describe("the run picker speaks the same vocabulary as the panel around it", () => {
  const interruptedDev = () =>
    mkRun({
      id: "primary",
      kind: "primary",
      who: { kind: "agent", backend: "claude", name: "dev", role: "Developer" },
      state: "idle",
      lifecycle: "interrupted",
      interruptedBy: { userId: "u1", label: "Arda Kaya" },
    });
  const queuedReviewer = () =>
    mkRun({
      id: "c0",
      kind: "reviewer",
      who: { kind: "agent", backend: "codex", name: "rev", role: "Reviewer" },
      backend: "codex",
      state: "idle",
      lifecycle: "queued",
    });

  it("UXV19-3: the trigger names the engagement (delivering/supporting), never the RunKind literal", () => {
    // Canary: restore `kind === "primary" ? "primary" : "reviewer"` in
    // roleShort and both assertions below fail.
    const runs = [interruptedDev(), queuedReviewer()];
    const { container, rerender } = render(
      <Logs runtime={runs} sel="primary" onSel={() => {}} linesByThread={{ primary: [], c0: [] }} />,
    );
    const role = () => container.querySelector(".rsel-role")!.textContent!;
    expect(role()).toContain("delivering");
    // "primary" is the internal kind literal — a THIRD name for the agent the
    // Execution profile on this same page calls "Delivering agent".
    expect(role()).not.toContain("primary");
    rerender(
      <Logs runtime={runs} sel="c0" onSel={() => {}} linesByThread={{ primary: [], c0: [] }} />,
    );
    expect(role()).toContain("supporting");
  });

  it("UXV19-5: an option carries its run's LIFECYCLE, so the list, the pill and the footer agree", () => {
    // Canary: put `RUN_STATE[r.state].label` back in the option and the
    // interrupted/queued expectations below fail on "idle".
    const { container } = render(
      <Logs
        runtime={[interruptedDev(), queuedReviewer()]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: [], c0: [] }}
      />,
    );
    fireEvent.click(container.querySelector(".rsel-btn")!);
    const states = [...container.querySelectorAll('[role="option"] .ri-state')].map(
      (n) => n.textContent,
    );
    expect(states).toEqual(["interrupted · by Arda", "queued"]);
    expect(states.some((s) => s?.includes("idle"))).toBe(false);
    // …and four lines of markup below, the pill and the footer for the SAME
    // run say exactly that.
    expect(container.querySelector(".logs-bar .pill")!.textContent).toBe(
      "interrupted · by Arda",
    );
    expect(container.textContent).toContain(
      "interrupted by Arda; the thread can be resumed where the task still takes a run",
    );
  });
});

describe("AgentPicker dismissal (shared useDismiss)", () => {
  function openPicker() {
    const op = mkRun({ id: "op", op: true, who: { kind: "agent", name: "Operator" }, state: "idle", lifecycle: "finished" });
    const dev = mkRun({ id: "primary", who: { kind: "agent", backend: "claude", name: "dev", role: "developer" }, state: "idle", lifecycle: "finished" });
    const view = render(
      <Logs runtime={[op, dev]} sel="primary" onSel={() => {}} linesByThread={{ op: [], primary: [] }} />,
    );
    fireEvent.click(view.container.querySelector(".rsel-btn")!);
    expect(view.container.querySelector('[role="listbox"]')).not.toBeNull();
    return view;
  }

  it("Escape closes it from anywhere, not just from the trigger", () => {
    const { container } = openPicker();
    // Fired on the document, i.e. exactly the case the old trigger-scoped
    // React handler could not reach.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector(".rsel-btn")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("an outside press still closes it", () => {
    const { container } = openPicker();
    fireEvent.mouseDown(document.body);
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("a press inside the picker leaves it open", () => {
    const { container } = openPicker();
    fireEvent.mouseDown(container.querySelector('[role="listbox"]')!);
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  });
});

/**
 * Ruling 478(d) (F40-34): the stream picker says whose console is shown, and
 * only a deliberate choice switches it.
 */
describe("ruling 478(d): the agent log stream picker", () => {
  const op = mkRun({ id: "op", op: true, who: { kind: "agent", name: "Operator" }, state: "idle", lifecycle: "finished" });
  const dev = mkRun({ id: "primary", who: { kind: "agent", backend: "claude", name: "Platform Engineer", role: "developer" }, state: "idle", lifecycle: "finished" });
  const rev = mkRun({ id: "c0", kind: "reviewer", who: { kind: "agent", backend: "claude", name: "Site Reviewer", role: "reviewer" }, state: "idle", lifecycle: "finished" });
  const renderPicker = (onSel: (id: string | null) => void) =>
    render(
      <Logs runtime={[op, dev, rev]} sel="primary" onSel={onSel} linesByThread={{ op: [], primary: [], c0: [] }} />,
    );

  it("names the trigger with the stream it shows, so the visible name is in the accessible name", () => {
    // WEB-2: the button announced "Select agent log stream" and never which
    // agent. CANARY: put `aria-label={label}` back on the trigger.
    const { getByRole, container } = renderPicker(() => {});
    const trigger = container.querySelector<HTMLButtonElement>(".rsel-btn")!;
    const visible = trigger.querySelector(".rsel-nm")!.textContent!;
    expect(visible).toContain("Platform Engineer");
    // Label in name (WCAG 2.5.3): the name carries what a voice-control user
    // reads on screen, word for word.
    expect(getByRole("button", { name: `Agent log stream: ${visible}` })).toBe(trigger);
  });

  it("ruling 524(c): the operator's stream is named once", () => {
    // The trigger read "Operator · operator": the name, then a role that is
    // the same word. A renamed operator keeps it. CANARY: print `roleShort`
    // after every name again.
    const { container, rerender } = render(
      <Logs runtime={[op, dev, rev]} sel="op" onSel={() => {}} linesByThread={{ op: [], primary: [], c0: [] }} />,
    );
    const shown = () => container.querySelector(".rsel-btn .rsel-nm")!.textContent;
    expect(shown()).toBe("Operator");
    const atlas = { ...op, who: { kind: "agent" as const, name: "Atlas" } };
    rerender(<Logs runtime={[atlas, dev, rev]} sel="op" onSel={() => {}} linesByThread={{ op: [], primary: [], c0: [] }} />);
    expect(shown()).toBe("Atlas · operator");
  });

  it("arrows move focus through the streams without switching the console; Enter switches it", () => {
    // CANARY: make ArrowDown on the open list call `onChange` again (the old
    // `move()`), and the console swaps with nothing announced.
    const onSel = vi.fn();
    const { container } = renderPicker(onSel);
    const trigger = container.querySelector<HTMLButtonElement>(".rsel-btn")!;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = container.querySelector('[role="listbox"]')!;
    expect(trigger.getAttribute("aria-controls")).toBe(list.id);
    const options = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    // Focus lands on the stream shown, inside the list.
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[2]);
    fireEvent.keyDown(options[2]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0]!, { key: "End" });
    expect(document.activeElement).toBe(options[2]);
    expect(onSel).not.toHaveBeenCalled();
    // Enter on a native button is its click: the one way to switch.
    fireEvent.click(options[2]!);
    expect(onSel).toHaveBeenCalledWith("c0");
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape inside the list closes it and hands focus back to the trigger, unchanged", () => {
    const onSel = vi.fn();
    const { container } = renderPicker(onSel);
    const trigger = container.querySelector<HTMLButtonElement>(".rsel-btn")!;
    fireEvent.click(trigger);
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1]!, { key: "Escape" });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onSel).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------- P19-G11

/**
 * P19-G11 — the console shows what a run was GIVEN, not only what it produced.
 *
 * Every other line here comes from a provider. This one is written by viberr at
 * run start and is the only in-app answer to "which knowledge bases, skills and
 * MCP servers actually resolved for this run, and what canonical task state was
 * it re-anchored on" — questions a human previously could only answer by
 * exporting the session and resuming it on their own machine.
 */
describe("AgentLogsPanel — run inputs (P19-G11)", () => {
  const inputs: RunInputs = {
    cwd: "/data/projects/p/tasks/VIB-1/workspace/widgets",
    repo: "acme/widgets",
    cloned: true,
    delivers: true,
    personaChars: 4210,
    promptChars: 5684,
    anchor: "## Canonical task state\nSENTINEL-ANCHOR-TEXT",
    skills: { granted: ["commits"], native: ["commits"], injected: [] },
    knowledge: [],
    mcp: { mounted: ["github"], unresolved: ["vm-memory"], unhealthy: [] },
    unresolvedResources: [{ name: "house-style", reason: "no such knowledge base" }],
    tools: { denied: ["Edit", "Write"], toolkit: ["post_comment"] },
    directive: { from: "Deniz", chars: 88 },
  };
  const rawEnvelope = '{"type":"run_inputs","source":"viberr","run_id":"run_1"}';
  const line: StreamedLine = {
    display: {
      t: "10:00:00",
      ev: "meta",
      tag: RUN_INPUTS_TAG,
      text: "Run inputs — delivering engagement · canonical anchor 42 chars",
      inputs,
    },
    raw: rawEnvelope,
  };

  function renderConsole(lines: StreamedLine[]) {
    const run = mkRun({ state: "idle", lifecycle: "finished" });
    return render(
      <Logs
        runtime={[run]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: lines }}
      />,
    );
  }

  it("summarises the inputs on one row and reveals the anchor + resolved resources on demand", () => {
    // Canary: drop the `isRunInputsLine` branch from the console map and the
    // row renders as a bare meta line — the toggle and every detail row vanish.
    const { getByText, queryByText, container } = renderConsole([line]);
    expect(getByText(line.display.text)).toBeTruthy();
    // Collapsed by default: reference material, not part of the run's story.
    expect(queryByText(/SENTINEL-ANCHOR-TEXT/)).toBeNull();

    const toggle = getByText("show what this run was given");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(container.textContent).toContain("SENTINEL-ANCHOR-TEXT");
    // The two facts nothing in the app carried before: a granted MCP that
    // mounted nowhere, and a granted KB whose content never arrived.
    expect(container.textContent).toContain("vm-memory");
    expect(container.textContent).toContain("house-style");
    // …and the confinement the run actually ran under.
    expect(container.textContent).toContain("Edit, Write");
    expect(getByText("hide what this run was given").getAttribute("aria-expanded")).toBe("true");
  });

  it("hoists the disclosure above the provider lines of its own run", () => {
    const provider: StreamedLine = {
      display: { t: "10:00:01", ev: "init", tag: "system·init", text: "session x" },
      raw: "{}",
    };
    const { container } = renderConsole([provider, line]);
    const tags = [...container.querySelectorAll(".log-line .ltag")].map((n) => n.textContent);
    expect(tags[0]).toBe(RUN_INPUTS_TAG);
    expect(tags[1]).toBe("system·init");
  });

  it("keeps an opened disclosure with its own agent (CON-6)", () => {
    // Every thread's first line is `0:0`, so a disclosure keyed by the row
    // alone opened the same row of whichever agent the picker showed next.
    const op = mkRun({ id: "op", serverRunId: "run_op", state: "idle", lifecycle: "finished" });
    const spec = mkRun({ id: "spec", serverRunId: "run_spec", state: "idle", lifecycle: "finished" });
    const linesByThread = { op: [{ ...line, key: "0:0" }], spec: [{ ...line, key: "0:0" }] };
    const { getByText, queryByText, rerender } = render(
      <Logs runtime={[op, spec]} sel="op" onSel={() => {}} linesByThread={linesByThread} />,
    );
    fireEvent.click(getByText("show what this run was given"));
    expect(getByText("hide what this run was given")).toBeTruthy();
    rerender(<Logs runtime={[op, spec]} sel="spec" onSel={() => {}} linesByThread={linesByThread} />);
    // CANARY: key the open set by `kind|row key` alone and this row opens.
    expect(queryByText("hide what this run was given")).toBeNull();
    expect(getByText("show what this run was given")).toBeTruthy();
    // The operator's row is still open when the reader comes back to it.
    rerender(<Logs runtime={[op, spec]} sel="op" onSel={() => {}} linesByThread={linesByThread} />);
    expect(getByText("hide what this run was given")).toBeTruthy();
  });

  it("yields to the raw toggle like every other line", () => {
    // The `{ } raw` contract is "the stored envelope, verbatim" — a viberr line
    // does not get to keep its friendly rendering there.
    const { getByText, queryByText, container } = renderConsole([line]);
    fireEvent.click(getByText("{ } raw"));
    expect(container.textContent).toContain(rawEnvelope);
    expect(queryByText("show what this run was given")).toBeNull();
  });
});

/**
 * Ruling 130(a): the Agent-logs footer selects its SENTENCE from the
 * classified failure for every run kind; the retry button stays gated on the
 * offer. Canary: restore the kind gate on the sentence (operator runs fall
 * back to "continuity error").
 */
describe("ruling 130(a): the classified footer", () => {
  it("an OPERATOR run tagged run·error·quota renders the classified footer, and no retry button", () => {
    const run = mkRun({ id: "operator", kind: "operator", state: "error", lifecycle: "error", failureKind: "quota", failedBackendUnavailable: true });
    const { getByText, queryByText } = render(
      <Logs runtime={[run]} sel="operator" onSel={() => {}} linesByThread={{ operator: [] }} />,
    );
    expect(getByText(/Claude refused this run: the account's usage window is spent/)).toBeTruthy();
    // The state pill follows the class too: no "continuity error" anywhere.
    expect(getByText("refused · quota")).toBeTruthy();
    expect(queryByText(/continuity error/)).toBeNull();
    expect(queryByText(/Retry on/)).toBeNull();
  });

  it("an auth refusal on a specialist names the provider's rejection", () => {
    const run = mkRun({ state: "error", lifecycle: "error", failureKind: "auth", failedBackendUnavailable: true });
    const { getByText } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(getByText(/Claude refused this run: the account was rejected by the provider/)).toBeTruthy();
  });

  it("a provider overload (Agent SDK 0.3.261 upgrade) names the provider's side and clears the account; the pill reads 'provider overloaded'", () => {
    // Canary: drop the `overloaded` arm and the footer falls to the
    // backend-unavailable sentence, which blames "quota, rate limit, or an
    // account that cannot run it" for the provider's own outage.
    const run = mkRun({ state: "error", lifecycle: "error", failureKind: "overloaded", failedBackendUnavailable: true });
    const { getByText, queryByText } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(
      getByText(/Claude could not serve this run: the provider was overloaded or failed on its side; nothing about the account is wrong, retry in a few minutes/),
    ).toBeTruthy();
    expect(getByText("provider overloaded")).toBeTruthy();
    expect(queryByText(/quota, rate limit/)).toBeNull();
    expect(queryByText(/continuity error/)).toBeNull();
  });

  it("U35-11: an overload whose origin is this deployment's own network path says 'could not be reached from this deployment'; the pill reads 'provider unreachable'", () => {
    // Canary: drop the `failureOrigin === "local"` branch and the footer
    // blames the provider for a TLS failure inside the container.
    const run = mkRun({ state: "error", lifecycle: "error", failureKind: "overloaded", failureOrigin: "local", failedBackendUnavailable: true });
    const { getByText, queryByText } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(
      getByText(/Claude could not be reached from this deployment: the connection failed before the provider answered; nothing about the account is wrong, check the network path and retry in a few minutes/),
    ).toBeTruthy();
    expect(getByText("provider unreachable")).toBeTruthy();
    expect(queryByText(/provider was overloaded/)).toBeNull();
  });
});

/**
 * Pass 35 U35-7: boot recovery finalizes an orphaned run as interrupted by a
 * RESTART; the panel used to read it as "continuity error" with the user
 * "restart". Canary: drop the `interruptedReason` arm from the footer and the
 * pill/footer assertions fail.
 */
describe("a run interrupted by a restart", () => {
  const restartedDev = (patch: Partial<RunView> = {}) =>
    mkRun({
      id: "primary",
      kind: "primary",
      who: { kind: "agent", backend: "claude", name: "dev", role: "Developer" },
      state: "idle",
      lifecycle: "interrupted",
      interruptedBy: null,
      interruptedReason: "restart",
      ...patch,
    });

  it("the pill and the footer name the restart and what recovery did for a task run", () => {
    const { container } = render(
      <Logs runtime={[restartedDev()]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(container.querySelector(".logs-bar .pill")!.textContent).toBe(
      "interrupted · by a restart",
    );
    /**
     * Ruling 338: this assertion REQUIRED the lie.
     *
     * Its fixture is a bare `lifecycle: "interrupted", interruptedReason:
     * "restart"` run — exactly the case where whether recovery re-invoked
     * anything is unknown to the panel — and it asserted the panel claim it
     * anyway. Recovery stamps that identical row state on a re-invoked orphan
     * and on one its crash-loop guard refused to re-invoke.
     *
     * Live: 6 of this board's 250 restart renderings are capped runs (SHOP-27,
     * SHOP-34 twice, SHOP-35, SHOP-36, SHOP-38), and on every one the task's own
     * timeline says the opposite one panel away — "Viberr did NOT re-invoke the
     * operator for it… Run the operator from this page when you are ready."
     *
     * CANARY: restore the old sentence in `runs-panels.tsx`.
     */
    expect(container.textContent).toContain(
      "interrupted by a restart; the task record says what recovery did",
    );
    expect(container.textContent).not.toContain("the operator was re-invoked");
    expect(container.textContent).not.toContain("continuity error");
  });

  it("a controller turn names its own recovery: the conversation carries a note", () => {
    const { container } = render(
      <Logs
        runtime={[restartedDev({ kind: "controller", who: { kind: "agent", name: "Controller" } })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{ primary: [] }}
      />,
    );
    expect(container.textContent).toContain(
      "interrupted by a restart; the conversation carries a note",
    );
    expect(container.textContent).not.toContain("the operator was re-invoked");
  });
});

/**
 * Ruling 350 (pass 38, F38-4): the Agent-logs footer says what the run row
 * says, whatever the run's kind. Lens-2 of the pass found the pill and the
 * footer reading one RunView through different gates.
 */
describe("ruling 350: the footer follows the classified failure for every run kind", () => {
  it("an operator drive refused for `unavailable` names the class, not a continuity error", () => {
    // Live: one operator drive on this instance carried `run·unavailable`, and
    // the footer beneath its "backend unavailable" pill read "stream ended on
    // a continuity error; see the blocked packet". CANARY: gate the class on
    // `kind === "primary" || "reviewer"` again.
    const run = mkRun({
      id: "op", kind: "operator", role: "Operator",
      who: { kind: "agent", backend: "claude", name: "Operator", role: "Operator" },
      state: "error", lifecycle: "error", failedBackendUnavailable: true, failureKind: "unavailable",
    });
    const { container } = render(
      <Logs runtime={[run]} sel="op" onSel={() => {}} linesByThread={{ op: [] }} />,
    );
    expect(container.textContent).toContain("could not run this");
    expect(container.textContent).not.toContain("continuity error");
    // …and no retry is advertised for a drive that has no other backend.
    expect(container.textContent).not.toContain("Retry on");
  });

  it("a run the spending cap cut off says so under the pill that says so", () => {
    // CANARY: drop the `max_budget` arm.
    const run = mkRun({ state: "error", lifecycle: "error", failureKind: "max_budget" });
    const { container } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(container.querySelector(".logs-bar .pill")!.textContent).toBe("cut off · spending cap");
    expect(container.textContent).toContain("cut off by the instance's spending cap");
    expect(container.textContent).not.toContain("continuity error");
  });

  it("a run stopped before a session existed is not called resumable", () => {
    // CANARY: read `interruptedBy` alone.
    const run = mkRun({
      state: "idle", lifecycle: "interrupted", sid: null,
      interruptedBy: { userId: "u_1", label: "Arda Kaya" },
    });
    const { container } = render(
      <Logs runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(container.textContent).toContain("before a session existed, so there is no thread to resume");
    expect(container.textContent).not.toContain("resumable");
  });

  it("a controller turn's unclassified error is sent to its error line, not to a packet it cannot have", () => {
    // CANARY: keep one unclassified sentence for every kind.
    const run = mkRun({
      id: "controller", kind: "controller", role: "Controller",
      who: { kind: "agent", backend: "claude", name: "Controller", role: "Controller" },
      state: "error", lifecycle: "error",
    });
    const { container } = render(
      <Logs runtime={[run]} sel="controller" onSel={() => {}} linesByThread={{ controller: [] }} />,
    );
    expect(container.textContent).toContain("the error line above carries what the provider said");
    expect(container.textContent).not.toContain("blocked packet");
  });
});

/**
 * Ruling 366(e): while the call is open the count runs on from the
 * heartbeat's own instant, one second at a time, and the next heartbeat
 * resyncs it. Canary: count from the render instead of `progress.at` and the
 * first reading below is 30, not 40.
 */
describe("the wait row's live count (ruling 366(e))", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs on from the provider's figure at the heartbeat's instant, and ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T10:05:00.000Z"));
    const beat: StreamedLine = {
      display: {
        t: "10:04:50", ev: "meta", tag: "tool_progress", name: "Bash",
        text: "Bash still running · 30s",
        progress: { call: "toolu_9", elapsed: 30, heartbeat: true, at: "2026-09-20T10:04:50.000Z" },
      },
      raw: '{"type":"tool_progress"}',
    };
    const { container } = render(
      <Logs runtime={[mkRun({ lineCount: 1 })]} sel="primary" onSel={() => {}} linesByThread={{ primary: [beat] }} />,
    );
    // The mount effect supplies the clock: 30 s reported + 10 s since the heartbeat.
    await act(async () => {});
    const count = container.querySelector(".log-line.wait .lw-clock")!;
    expect(count.getAttribute("data-elapsed")).toBe("40");
    // The clock in the tooltip is the viewer's, so only its shape is pinned.
    expect(count.getAttribute("title")).toMatch(
      /^Counting on from the runtime's last heartbeat: 30s at \d{2}:\d{2}:\d{2}\. A heartbeat lands about every 30 s and resets the count\.$/,
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(count.getAttribute("data-elapsed")).toBe("42");
  });

  it("links a tool row to what its summary cut, by name, inside the detail's own flow (366(d))", () => {
    const prompt = "p".repeat(200);
    const { container, getByText } = render(
      <Logs
        runtime={[mkRun({ state: "idle", lifecycle: "finished", lineCount: 3 })]}
        sel="primary"
        onSel={() => {}}
        linesByThread={{
          primary: [
            {
              display: { t: "10:00:01", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test", input: { command: "npm test", description: "Run the suite", timeout: 60000 } },
              raw: '{"type":"assistant","n":1}',
            },
            {
              display: {
                t: "10:00:02", ev: "tool", tag: "tool_use", name: "mcp__viberr__run_agent",
                text: `profileId: developer · prompt: ${prompt.slice(0, 159)}…`,
                input: { profileId: "developer", prompt },
              },
              raw: '{"type":"assistant","n":2}',
            },
            {
              display: { t: "10:00:03", ev: "tool", tag: "tool_use", name: "mcp__viberr__read_default_branch_file", text: "a/b.ts", input: { path: "a/b.ts" } },
              raw: '{"type":"assistant","n":3}',
            },
          ],
        }}
      />,
    );
    // Bash: the description sits beside the command as a comment, and its
    // timeout earns no link. The single-string call shows its whole argument.
    // Only the clipped prompt gets a link — named for what it hides, inside
    // the detail text rather than beside the chip.
    const bash = container.querySelectorAll(".log-line.tool")[0]!;
    expect(bash.querySelector(".lc-detail")!.textContent).toBe("npm test # Run the suite");
    const buttons = [...container.querySelectorAll("button.log-more")];
    expect(buttons.map((b) => b.textContent)).toEqual(["+ full prompt"]);
    expect(buttons[0]!.closest(".lc-detail")).not.toBeNull();
    expect(container.textContent).not.toContain(prompt);
    fireEvent.click(getByText("+ full prompt"));
    const rows = [...container.querySelectorAll(".log-line.tstep")].map((r) => [r.querySelector(".ltag")!.textContent, r.querySelector(".lx")!.textContent]);
    expect(rows).toEqual([["prompt", prompt]]);
    fireEvent.click(getByText("{ } raw"));
    expect(container.querySelector("button.log-more")).toBeNull();
    expect(container.textContent).not.toContain("# Run the suite");
  });
});

/**
 * Ruling 369: the console's facts row carries the run's cache record on
 * `data-` attributes (the DOM reads without the words), and the strip's Tokens
 * cell says on hover what the cache wrote and read.
 */
describe("the console's prompt-cache facts (ruling 369)", () => {
  const facts = (run: RunView) => {
    const { container, unmount } = render(
      <Logs runtime={[run]} sel={run.id} onSel={() => {}} linesByThread={{}} />,
    );
    const row = container.querySelector<HTMLElement>(".run-facts")!;
    const read = (attr: string) => row.querySelector<HTMLElement>(`[${attr}]`)?.getAttribute(attr) ?? null;
    const out = {
      start: read("data-start"),
      firstWrite: read("data-first-write"),
      firstRead: read("data-first-read"),
      miss: read("data-miss"),
      ttl: read("data-ttl"),
      write: read("data-write"),
      read: read("data-read"),
      peak: read("data-peak"),
      last: read("data-last"),
      compactions: read("data-compactions"),
      text: row.textContent,
    };
    unmount();
    return out;
  };

  it("a cold first call with a miss reason, the TTL, the totals, the peak and the compactions", () => {
    const out = facts(
      mkRun({
        cache: {
          writeTokens: 120_800,
          readTokens: 6_100_000,
          firstCall: { promptTokens: 298_000, write: 297_600, read: 14_900, warm: false, missReason: "messages_changed" },
          ttlBucket: "1h",
          peakPromptTokens: 344_000,
          lastPromptTokens: 12_000,
          compactions: 1,
        },
      }),
    );
    expect(out).toMatchObject({
      start: "cold",
      firstWrite: "297600",
      firstRead: "14900",
      miss: "messages_changed",
      ttl: "1h",
      write: "120800",
      read: "6100000",
      peak: "344000",
      last: "12000",
      compactions: "1",
    });
    expect(out.text).toContain("cold start · wrote 298k");
    expect(out.text).toContain("miss: messages changed");
    expect(out.text).toContain("cache 1h");
    expect(out.text).toContain("peak prompt 344k");
    expect(out.text).toContain("1 compaction");
  });

  it("a warm first call reads its figure; a run with no first call says so instead of zeros", () => {
    const warm = facts(
      mkRun({
        cache: { ...NO_RUN_CACHE, writeTokens: 4_200, readTokens: 47_900, firstCall: { promptTokens: 52_102, write: 4_200, read: 47_900, warm: true, missReason: null } },
      }),
    );
    expect(warm.start).toBe("warm");
    expect(warm.text).toContain("warm start · read 47.9k");
    expect(warm.miss).toBeNull();
    expect(warm.ttl).toBeNull();
    const none = facts(mkRun({ cache: NO_RUN_CACHE }));
    expect(none.start).toBe("none");
    expect(none.text).toContain("no first call yet");
    expect(none.write).toBeNull();
    expect(none.peak).toBeNull();
    expect(none.compactions).toBe("0");
  });

  it("the strip's Tokens cell carries the cache writes and reads on hover, beside the estimate sentence", () => {
    const title = (run: RunView) => {
      const { container, unmount } = render(
        <LiveRunPanel runtime={[run]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />,
      );
      const cell = [...container.querySelectorAll(".run-cell")].find((c) => c.querySelector(".lbl")?.textContent === "Tokens")!;
      const out = cell.querySelector<HTMLElement>(".val")!.getAttribute("title");
      unmount();
      return out;
    };
    const cache = { ...NO_RUN_CACHE, writeTokens: 4_200, readTokens: 47_900 };
    expect(title(mkRun({ tokens: 52_000, tokensEstimated: false, cache }))).toBe("Prompt cache: wrote 4.2k · read 47.9k");
    expect(title(mkRun({ tokens: 52_000, tokensEstimated: true, cache }))).toBe(
      "Estimated from the streamed text. The provider's own total replaces it when one lands; a run that was stopped never gets one\nPrompt cache: wrote 4.2k · read 47.9k",
    );
    // Nothing reported: nothing claimed (the existing test pins the null).
    expect(title(mkRun({ tokens: 1500, tokensEstimated: false, cache: NO_RUN_CACHE }))).toBeNull();
  });
});

/**
 * Ruling 451 (motion from transitions.dev, owner 2026-09-23). The live strip's
 * status line arrives as a new line when its words change, the Turns figure
 * rolls with its neighbours, and a copy control trades its glyph in place.
 */
describe("ruling 451: the live strip's motion", () => {
  const panel = (run: RunView) => (
    <LiveRunPanel runtime={[run]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />
  );

  it("(a) a new phase or step is a new line; the same one is the same node", () => {
    // CANARY: drop the `key` on `.ph` / `.step` and React patches the text in
    // place, so the node survives the change and `swap-in` never replays.
    const { container, rerender } = render(panel(mkRun({})));
    const step = container.querySelector(".run-phase .step")!;
    const phase = container.querySelector(".run-phase .ph")!;
    // A re-render with the same words (a new row object, as every refresh
    // brings) keeps both nodes.
    rerender(panel(mkRun({})));
    expect(container.querySelector(".run-phase .step")).toBe(step);
    expect(container.querySelector(".run-phase .ph")).toBe(phase);
    rerender(panel(mkRun({ step: "Read · app/app.css" })));
    expect(container.querySelector(".run-phase .step")).not.toBe(step);
    expect(container.querySelector(".run-phase .step")!.textContent).toBe("Read · app/app.css");
    expect(container.querySelector(".run-phase .ph")).toBe(phase);
    rerender(panel(mkRun({ step: "Read · app/app.css", phase: "Preparing workspace" })));
    expect(container.querySelector(".run-phase .ph")).not.toBe(phase);
  });

  it("(e) Turns rolls like Elapsed and Tokens, and carries its figure on data-turns", () => {
    // CANARY: render `{run.turns}` bare again and there is no .lw-clock here.
    const { container } = render(panel(mkRun({ turns: 7 })));
    const cell = [...container.querySelectorAll(".run-cell")].find(
      (c) => c.querySelector(".lbl")?.textContent === "Turns",
    )!;
    expect(cell.querySelector(".lw-clock")?.getAttribute("data-turns")).toBe("7");
  });
});

describe("ruling 451(c): copy controls trade their glyph in place", () => {
  it("the session id's copy button keeps both marks and flips data-copied", async () => {
    // CANARY: render `<Icon name={copied ? "check" : "copy"} />` again and the
    // button holds one glyph, swapped in a single frame.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container, getByRole } = render(
      <Logs runtime={[mkRun({})]} sel="primary" onSel={() => {}} linesByThread={{}} />,
    );
    const button = getByRole("button", { name: "Copy full session id" });
    const glyph = button.querySelector(".copy-glyph")!;
    expect(glyph.querySelectorAll(".ico")).toHaveLength(2);
    expect(glyph.hasAttribute("data-copied")).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith("51d8f0e2-3a7b");
    expect(container.querySelector(".copy-glyph")!.getAttribute("data-copied")).toBe("true");
    // The same element carries the change: nothing remounted.
    expect(container.querySelector(".copy-glyph")).toBe(glyph);
  });
});

/**
 * Ruling 459 (amending 451(a)): the status line on screen when the strip opens
 * is not news, so it stands still; only a line that replaces it carries
 * `data-fresh`, the mark the sheet's `swap-in` reads. A latch, so a line that
 * repeats the first words later (Working, Compacting context, Working) still
 * rises.
 */
describe("ruling 459: the live strip's first line stands still", () => {
  const panel = (run: RunView) => (
    <LiveRunPanel runtime={[run]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting={false} />
  );
  const fresh = (container: HTMLElement, part: "ph" | "step") =>
    container.querySelector(`.run-phase .${part}`)?.getAttribute("data-fresh") ?? null;

  it("paints the phase and step it opens on without the mark", () => {
    // CANARY: set `data-fresh` unconditionally and the step on screen when a
    // task opens mid-run rises as if it had just changed.
    const { container } = render(panel(mkRun({})));
    expect(fresh(container, "ph")).toBeNull();
    expect(fresh(container, "step")).toBeNull();
  });

  it("marks each line that replaces the first, and keeps marking after a return to the first words", () => {
    // CANARY: compare with the first words instead of latching
    // (`return line !== first` with no setFirst) and the return below stands still.
    const { container, rerender } = render(panel(mkRun({})));
    rerender(panel(mkRun({ step: "Read · app/app.css" })));
    expect(fresh(container, "step")).toBe("true");
    // The phase did not change: its node still stands, unmarked.
    expect(fresh(container, "ph")).toBeNull();
    rerender(panel(mkRun({ step: "Bash · npm test" })));
    expect(container.querySelector(".run-phase .step")!.textContent).toBe("Bash · npm test");
    expect(fresh(container, "step")).toBe("true");
    rerender(panel(mkRun({ phase: "Compacting context" })));
    expect(fresh(container, "ph")).toBe("true");
  });

  it("a step that appears where there was none is news", () => {
    const { container, rerender } = render(panel(mkRun({ step: null })));
    expect(container.querySelector(".run-phase .step")).toBeNull();
    rerender(panel(mkRun({ step: "Bash · npm test" })));
    expect(fresh(container, "step")).toBe("true");
  });
});

/**
 * Ruling 457: the console reads a live store (`createLiveRunLogStore`, the one
 * `useRunLogStream` holds) rather than lines handed down by the page.
 */
describe("the console on a live store (ruling 457)", () => {
  const text = (seq: number): LogLine => ({ t: "10:00:00", ev: "text", tag: "assistant", text: `line ${seq}` });
  const running = () =>
    mkRun({
      lines: [0, 1, 2].map(text),
      raw: [],
      lineKeys: ["0:0", "0:1", "0:2"],
      lineCount: 3,
      logWindow: { totalLines: 3, hasMore: false, runIds: ["run_1"], oldest: null, headSeq: 2 },
    });
  const tail = (seq: number) => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        runId: "run_1",
        state: "running",
        lines: [{ seq, display: text(seq) }],
        headSeq: seq,
        oldestSeq: seq,
        hasMore: true,
      },
    }),
  });
  async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  /** A `/resources/run-log` answer, as much of a `Response` as the store reads. */
  interface RunLogAnswer {
    ok: boolean;
    status: number;
    json: () => Promise<{ data: object }>;
  }
  afterEach(() => vi.unstubAllGlobals());

  it("appends a line without touching the rows already drawn, and counts it", async () => {
    const run = running();
    const store = createLiveRunLogStore({ kind: "task", projectSlug: "p", taskKey: "K-1" }, [run]);
    const { container } = render(<AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} store={store} />);
    const first = container.querySelector(".console > .log-line")!;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tail(3)));
    await act(async () => {
      store.onFrame("run_1", 3);
      await flush();
    });
    // CANARY: key the rows by index and prepend-free appends still pass, but
    // the load-older test below does not.
    expect(container.querySelector(".console > .log-line")).toBe(first);
    expect(container.textContent).toContain("line 3");
    // The page loaded 3 lines; the tail's fourth is counted without a reload.
    expect(footerCount(container)).toBe("4");
  });

  it("follows the tail to its newest line, and leaves a reader who scrolled up where they are", async () => {
    const run = running();
    const store = createLiveRunLogStore({ kind: "task", projectSlug: "p", taskKey: "K-1" }, [run]);
    const { container } = render(<AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} store={store} />);
    const box = container.querySelector<HTMLElement>(".console")!;
    let height = 1000;
    Object.defineProperty(box, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(box, "clientHeight", { get: () => 320, configurable: true });
    const fetchMock = vi.fn().mockResolvedValueOnce(tail(3)).mockResolvedValueOnce(tail(4));
    vi.stubGlobal("fetch", fetchMock);
    height = 1021;
    await act(async () => {
      store.onFrame("run_1", 3);
      await flush();
    });
    expect(box.scrollTop).toBe(1021);

    // The reader scrolls up: `follow` turns off and the next line leaves them.
    box.scrollTop = 200;
    fireEvent.scroll(box);
    height = 1042;
    await act(async () => {
      store.onFrame("run_1", 4);
      await flush();
    });
    expect(container.textContent).toContain("line 4");
    expect(box.scrollTop).toBe(200);
  });

  /**
   * CON-4: the console's rows skip layout until they are near the view
   * (`content-visibility: auto`, ruling 457 CSS-6), so a row the follow jump
   * brings into view counts at its 21px placeholder when `scrollHeight` is read
   * and reaches its real height in a later frame. Nothing re-pinned, so the
   * newest line sat below the fold with `follow` still on; and the scroll
   * event the browser then sent, with the view short of the end, turned
   * `follow` off. jsdom lays nothing out, so the geometry is stubbed: a
   * scroller that clamps like a browser's, a height that grows after the jump,
   * and frames the test runs one at a time.
   */
  it("re-pins to the real bottom as rows grow after the jump, and the growth never turns follow off (CON-4)", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(nextFrame, cb);
      return nextFrame++;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const runFrame = () => {
      const due = [...frames.values()];
      frames.clear();
      for (const cb of due) cb(0);
    };

    const run = running();
    const store = createLiveRunLogStore({ kind: "task", projectSlug: "p", taskKey: "K-1" }, [run]);
    const { container, getByRole } = render(
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} store={store} />,
    );
    const box = container.querySelector<HTMLElement>(".console")!;
    let height = 1000;
    let top = 0;
    Object.defineProperty(box, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(box, "clientHeight", { get: () => 320, configurable: true });
    Object.defineProperty(box, "scrollTop", {
      get: () => top,
      set: (v: number) => (top = Math.max(0, Math.min(v, height - 320))),
      configurable: true,
    });
    const following = () => getByRole("button", { name: "follow" }).getAttribute("aria-pressed");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tail(3)));
    height = 1021; // the new row, at its placeholder height
    await act(async () => {
      store.onFrame("run_1", 3);
      await flush();
    });
    expect(top).toBe(701);

    // The first frame still reads the placeholder; the rows laid out at the
    // end of it are 200px taller than their estimates.
    act(runFrame);
    height = 1221;
    act(runFrame);
    // CANARY: drop the re-pin and the view stays at 701, 200px short.
    expect(top).toBe(901);

    // More rows came near the view before the browser sent the scroll event
    // for that pin: it arrives 79px short of the end.
    height = 1300;
    fireEvent.scroll(box);
    // CANARY: derive follow from the distance alone and this reads "false".
    expect(following()).toBe("true");
    act(runFrame);
    expect(top).toBe(980);
    act(runFrame);
    // Settled: the height stopped moving, so the pinning stopped with it.
    height = 1400;
    act(runFrame);
    expect(top).toBe(980);

    // A reader who scrolls up still stops following.
    top = 500;
    fireEvent.scroll(box);
    expect(following()).toBe("false");
  });

  it("keeps every drawn row's node when older lines are loaded above it", async () => {
    const run = mkRun({
      lines: [3, 4].map(text),
      raw: [],
      lineKeys: ["0:3", "0:4"],
      lineCount: 5,
      logWindow: { totalLines: 5, hasMore: true, runIds: ["run_1"], oldest: { runId: "run_1", seq: 3 }, headSeq: 4 },
    });
    const store = createLiveRunLogStore({ kind: "task", projectSlug: "p", taskKey: "K-1" }, [run]);
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} store={store} />,
    );
    const rows = () => [...container.querySelectorAll(".console > .log-line")].filter((el) => /line \d/.test(el.textContent ?? ""));
    const before = rows();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { runId: "run_1", lines: [0, 1, 2].map((seq) => ({ seq, display: text(seq) })), oldestSeq: 0, hasMore: false },
        }),
      }),
    );
    await act(async () => {
      fireEvent.click(getByText("load older lines"));
      await flush();
    });
    const after = rows();
    expect(after.map((el) => el.querySelector(".lx")!.textContent)).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4"]);
    // LIVE-4: rows keyed by run and seq; index keys rewrote every row.
    expect(after.slice(3)).toEqual(before);
  });

  it("fills a thread the page did not carry with one request, saying so meanwhile", async () => {
    const run = mkRun({
      lines: [],
      raw: [],
      lineCount: 2,
      logWindow: { totalLines: 2, hasMore: false, runIds: ["run_1"], oldest: null, headSeq: 1, loaded: false },
    });
    const store = createLiveRunLogStore({ kind: "task", projectSlug: "p", taskKey: "K-1" }, [run]);
    let answer: (value: RunLogAnswer) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} store={store} />);
    expect(container.textContent).toContain("loading this console…");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/resources/run-log?runId=run_1&window=1");
    await act(async () => {
      answer({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            runId: "run_1",
            threadId: "primary",
            lines: [text(0), text(1)],
            lineKeys: ["0:0", "0:1"],
            logWindow: { totalLines: 2, hasMore: false, runIds: ["run_1"], oldest: null, headSeq: 1 },
            facts: { phase: null, step: null, turns: 0, tokens: 0, tokensEstimated: false, cache: NO_RUN_CACHE },
          },
        }),
      });
      await flush();
    });
    expect(container.textContent).not.toContain("loading this console…");
    expect(container.textContent).toContain("line 1");
  });

  it("the raw view prints each stored envelope, loaded when it opens", async () => {
    const run = running();
    const store = createLiveRunLogStore({ kind: "task", projectSlug: "p", taskKey: "K-1" }, [run]);
    let answer: (value: RunLogAnswer) => void = () => {};
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise((resolve) => (answer = resolve))));
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} store={store} />,
    );
    await act(async () => {
      fireEvent.click(getByText("{ } raw"));
      await flush();
    });
    // While the envelopes are on their way the row says so, not the display text.
    expect(container.querySelector(".console > .log-line .lx")!.textContent).toBe("loading the stored envelope…");
    await act(async () => {
      answer({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            runId: "run_1",
            lines: [0, 1, 2].map((seq) => ({ seq, display: text(seq), raw: `{"seq":${seq}}` })),
            oldestSeq: 0,
            hasMore: false,
          },
        }),
      });
      await flush();
    });
    expect(container.querySelector(".console > .log-line .lx")!.textContent).toBe('{"seq":0}');
  });

  it("UI-03: says the live tail is down while the tab's stream reconnects", () => {
    // The tab's one stream is the layout's (`useLiveUpdates`, ruling 457); its
    // failure is what the console reads. It used to watch its own.
    class FailingEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      static last: FailingEventSource | null = null;
      readyState = 1;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      url: string;
      constructor(url: string) {
        this.url = url;
        FailingEventSource.last = this;
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", FailingEventSource);
    const store = staticRunLogStore({ linesByThread: { primary: [] } });
    function Layout() {
      useLiveUpdates(["project:p"]);
      return <AgentLogsPanel runtime={[mkRun({})]} sel="primary" onSel={() => {}} store={store} />;
    }
    const Stub = createRoutesStub([{ path: "/", Component: Layout }]);
    const { container } = render(<Stub initialEntries={["/"]} />);
    const foot = () => container.querySelector(".logs-foot")!.textContent;
    expect(foot()).toContain("streaming");
    act(() => {
      FailingEventSource.last!.readyState = FailingEventSource.CLOSED;
      FailingEventSource.last!.onerror?.();
    });
    // CANARY: drop `liveDown` from the console's `stopped`.
    expect(foot()).toContain("Live tail disconnected");
  });
});

/**
 * Ruling 459: a wait row's orb and clock share one cell and trade in place
 * as the wait ends. React swapped the 20px canvas for the 14px clock in one
 * frame, so the tool chip beside it jumped 6px left.
 */
describe("ruling 459: the wait row's orb trades for the clock in place", () => {
  const beat = (n: number, elapsed: number): StreamedLine => ({
    display: {
      t: `10:0${n}:00`, ev: "meta", tag: "tool_progress", name: "Bash",
      text: `Bash still running · ${elapsed}s`,
      progress: { call: "toolu_1", elapsed, heartbeat: true, at: null },
    },
    raw: `{"type":"tool_progress","elapsed_time_seconds":${elapsed}}`,
  });
  const call: StreamedLine = {
    display: { t: "10:00:00", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test" },
    raw: '{"type":"assistant"}',
  };
  const done: StreamedLine = {
    display: { t: "10:03:00", ev: "out", tag: "tool_result", text: "ok" },
    raw: '{"type":"user"}',
  };
  const panel = (lines: StreamedLine[]) => (
    <Logs runtime={[mkRun({ lineCount: lines.length })]} sel="primary" onSel={() => {}} linesByThread={{ primary: lines }} />
  );

  it("keeps the orb it watched live, marked ended, so the sheet fades it out as the clock comes in", () => {
    // CANARY: render `{live ? <ConsoleOrb … /> : <Icon name="clock" />}`
    // again and the orb is gone the moment the wait ends.
    const { container, rerender } = render(panel([call, beat(1, 30), beat(2, 60)]));
    const cell = container.querySelector(".log-line.wait .lw-glyph")!;
    expect(cell.getAttribute("aria-hidden")).toBe("true");
    expect(cell.getAttribute("data-live")).toBe("true");
    const orb = cell.querySelector(":scope > .log-orb")!;
    const clock = cell.querySelector(":scope > svg.ico")!;
    expect(orb).not.toBeNull();
    expect(orb.getAttribute("data-orb")).toBe("wave");
    expect(clock).not.toBeNull();

    rerender(panel([call, beat(1, 30), beat(2, 60), done]));
    // The same cell and the same two glyphs; only the mark moved.
    expect(container.querySelector(".log-line.wait .lw-glyph")).toBe(cell);
    expect(cell.hasAttribute("data-live")).toBe(false);
    expect(cell.querySelector(":scope > .log-orb")).toBe(orb);
    expect(cell.querySelector(":scope > svg.ico")).toBe(clock);
  });

  it("a row first drawn ended mounts no orb at all", () => {
    const { container } = render(panel([call, beat(1, 30), beat(2, 60), done]));
    const cell = container.querySelector(".log-line.wait .lw-glyph")!;
    expect(cell.hasAttribute("data-live")).toBe(false);
    expect(cell.querySelector(".log-orb")).toBeNull();
    expect(cell.querySelectorAll(":scope > svg.ico")).toHaveLength(1);
  });
});

/**
 * Ruling 368: a run request shows itself on the button that started it. The
 * task page's run fetcher carries interrupts, retries and merges alike, so
 * Interrupt and Retry used to go `disabled` for ANY of them with their resting
 * glyph and label: the one that was pressed painted the .45 refused step and
 * said nothing. The page now names the run (or agent) in flight; that button
 * carries `aria-busy`, the loader spinning and the work's own name. Ruling
 * 459: the loader trades in for the resting glyph in its GlyphSwap cell, where
 * it is always drawn, so "shown" is the cell's `data-copied`.
 * Canary: drop `aria-busy` from Interrupt in `runs-panels.tsx`.
 */
describe("ruling 368: run requests in flight", () => {
  it("Interrupt reads Interrupting… for the run being stopped", () => {
    const { getByText } = render(
      <LiveRunPanel
        runtime={[mkRun({})]}
        onViewLogs={() => {}}
        onInterrupt={() => {}}
        canInterrupt
        interrupting
        interruptingRunId="run_1"
      />,
    );
    const b = getByText("Interrupting…").closest("button")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.disabled).toBe(true);
    expect(b.querySelector(".copy-glyph[data-copied] > svg.ico.spin:last-child")).not.toBeNull();
  });

  it("another request in flight leaves Interrupt waiting, claiming nothing", () => {
    const { getByText } = render(
      <LiveRunPanel
        runtime={[mkRun({})]}
        onViewLogs={() => {}}
        onInterrupt={() => {}}
        canInterrupt
        interrupting
        interruptingRunId={null}
      />,
    );
    const b = getByText("Interrupt").closest("button")!;
    expect(b.disabled).toBe(true);
    expect(b.hasAttribute("aria-busy")).toBe(false);
    expect(b.querySelector(".copy-glyph")!.hasAttribute("data-copied")).toBe(false);
  });

  it("Retry reads Retrying on Codex… when the shown agent's retry is in flight", () => {
    const failed = mkRun({
      state: "error",
      lifecycle: "error",
      failureKind: "quota",
      failedBackendUnavailable: true,
      altBackend: "codex",
    });
    const props = {
      runtime: [failed],
      sel: "primary",
      onSel: () => {},
      onRetryBackend: () => {},
      retryBackends: ["claude", "codex"] as const,
      linesByThread: { primary: [] },
      retrying: true,
    };
    const { getByText, rerender } = render(<Logs {...props} retryingProfileId="developer" />);
    const b = getByText("Retrying on Codex…").closest("button")!;
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.querySelector(".copy-glyph[data-copied] > svg.ico.spin:last-child")).not.toBeNull();

    // Another agent's retry (or any other run request): this one only waits.
    rerender(<Logs {...props} retryingProfileId="reviewer" />);
    const waiting = getByText("Retry on Codex").closest("button")!;
    expect(waiting.disabled).toBe(true);
    expect(waiting.hasAttribute("aria-busy")).toBe(false);
    expect(waiting.querySelector(".copy-glyph")!.hasAttribute("data-copied")).toBe(false);
  });
});

/**
 * Ruling 499: the console draws what an agent did the way agent tools draw
 * it. An edit is its diff (the owner, 2026-09-26, of the `+ old_string,
 * new_string` link: "this diff looks dated"), a to-do list is its steps, a
 * thought still running shimmers "Thinking", and `{ } raw` still shows every
 * stored envelope and none of it.
 */
describe("ruling 499: the console draws an agent's edits, to-dos and thinking", () => {
  const W = "/data/projects/akinozer-com/tasks/WEB-3/workspace/website/";
  const line = (display: LogLine, n: number): StreamedLine => ({
    display,
    raw: `{"n":${n}}`,
    key: `0:${n}`,
  });
  const panel = (lines: StreamedLine[], run: Partial<RunView> = { state: "idle", lifecycle: "finished" }) => (
    <Logs
      runtime={[mkRun({ lineCount: lines.length, ...run })]}
      sel="primary"
      onSel={() => {}}
      linesByThread={{ primary: lines }}
    />
  );
  const edit = line(
    {
      t: "10:00:01", ev: "tool", tag: "tool_use", name: "Edit", text: W + "docs/deploy-runbook.md",
      input: {
        file_path: W + "docs/deploy-runbook.md",
        old_string: "## Step 1\n5. Non-production branch builds: on",
        new_string: "## Step 1\n5. Non-production branch builds: off\nIts writes are unmeasured.",
      },
    },
    1,
  );

  it("draws an Edit as its diff: the file repo-relative, +N −M, the changed words marked, no link", () => {
    // CANARY: drop `diff?.drawn` from hiddenArguments and the row offers
    // `+ old_string, new_string` again beside the diff that shows them.
    const { container, queryByText } = render(panel([edit]));
    const row = container.querySelector(".log-line.tool")!;
    const path = row.querySelector(".lc-path")!;
    expect(path.textContent).toBe("docs/deploy-runbook.md");
    expect(path.getAttribute("title")).toBe(W + "docs/deploy-runbook.md");
    expect(path.querySelector(".lc-base")!.textContent).toBe("deploy-runbook.md");
    expect(row.querySelector(".lc-stat")!.textContent).toBe("+2 added, −1 removed");
    expect(queryByText(/old_string/)).toBeNull();
    const rows = [...row.querySelectorAll(".log-diff .ld-row")];
    expect(rows.map((r) => [r.getAttribute("data-kind"), r.querySelector(".ld-code")!.textContent])).toEqual([
      ["ctx", "## Step 1"],
      ["del", "removed: 5. Non-production branch builds: on"],
      ["add", "added: 5. Non-production branch builds: off"],
      ["add", "added: Its writes are unmeasured."],
    ]);
    // The +/− is a glyph as well as a tint, hidden from assistive tech, which
    // reads the words instead.
    expect(rows[1]!.querySelector(".ld-mark")!.getAttribute("aria-hidden")).toBe("true");
    expect(rows[1]!.querySelector(".ld-mark")!.textContent).toBe("−");
    expect([...row.querySelectorAll("mark.ld-w")].map((m) => m.textContent)).toEqual(["on", "off"]);
  });

  it("shows a long diff's first rows, then the rest on the row's own disclosure", () => {
    const content = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n");
    const write = line(
      { t: "10:00:02", ev: "tool", tag: "tool_use", name: "Write", text: W + "docs/new.md", input: { file_path: W + "docs/new.md", content } },
      2,
    );
    const { container, getByRole } = render(panel([write]));
    // A Write numbers its lines and claims no +/−.
    expect(container.querySelector(".lc-stat")!.textContent).toBe("15 lines");
    expect(container.querySelectorAll(".ld-row")).toHaveLength(10);
    expect(container.querySelector(".ld-num")!.textContent).toBe("1");
    const more = getByRole("button", { name: "Show 5 more lines" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(container.querySelectorAll(".ld-row")).toHaveLength(15);
    expect(getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens an unchanged run in place", () => {
    const old = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const next = [...old];
    next[0] = "changed";
    const long = line(
      { t: "10:00:03", ev: "tool", tag: "tool_use", name: "Edit", text: "/tmp/a.ts", input: { file_path: "/tmp/a.ts", old_string: old.join("\n"), new_string: next.join("\n") } },
      3,
    );
    const { container, getByRole } = render(panel([long]));
    expect(container.querySelectorAll(".ld-row")).toHaveLength(5);
    fireEvent.click(getByRole("button", { name: "8 unchanged lines" }));
    expect(container.querySelectorAll(".ld-row")).toHaveLength(13);
    expect(container.querySelector(".ld-fold")).toBeNull();
  });

  it("prints a Read's file repo-relative too, but never rewrites a path inside a command", () => {
    const { container } = render(
      panel([
        line({ t: "10:00:04", ev: "tool", tag: "tool_use", name: "Read", text: W + "docs/x.md", input: { file_path: W + "docs/x.md" } }, 4),
        line({ t: "10:00:05", ev: "tool", tag: "tool_use", name: "Bash", text: "cat " + W + "docs/x.md", input: { command: "cat " + W + "docs/x.md" } }, 5),
      ]),
    );
    const details = [...container.querySelectorAll(".lc-detail")].map((d) => d.textContent);
    expect(details).toEqual(["docs/x.md", "cat " + W + "docs/x.md"]);
  });

  const todos = (n: number, current: number): StreamedLine =>
    line(
      {
        t: `10:00:1${n}`, ev: "tool", tag: "tool_use", name: "TodoWrite", text: "todos: [3 items]",
        input: {
          todos: ["Read the runbook", "Correct the steps", "Run the link check"].map((content, i) => ({
            content,
            status: i < current ? "completed" : i === current ? "in_progress" : "pending",
            activeForm: content,
          })),
        },
      },
      10 + n,
    );

  it("draws TodoWrite as the agent's to-do list, and folds it from its header", () => {
    const { container, getByRole, queryByText } = render(panel([todos(0, 1)]));
    const card = container.querySelector(".log-todo")!;
    const head = getByRole("button", { name: /To-dos/ });
    expect(head.textContent).toBe("To-dos1/3 done");
    expect([...card.querySelectorAll(".td-item")].map((i) => [i.getAttribute("data-status"), i.textContent])).toEqual([
      ["completed", "done: Read the runbook"],
      ["in_progress", "in progress: Correct the steps"],
      ["pending", "to do: Run the link check"],
    ]);
    // The list IS the row; the arguments line and its link are not printed.
    expect(queryByText(/todos: \[/)).toBeNull();
    expect(queryByText(/\+ todos/)).toBeNull();
    // A finished run's list holds still.
    expect(card.querySelector("[data-live]")).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector(".td-list")).toBeNull();
  });

  it("shimmers the step under way only on the list a running agent wrote last", () => {
    // CANARY: pass `live` to every to-do row and the stale list shimmers too.
    const { container } = render(panel([todos(0, 0), todos(1, 1)], { state: "running", lifecycle: "running" }));
    const cards = [...container.querySelectorAll(".log-todo")];
    expect(cards[0]!.querySelector("[data-live]")).toBeNull();
    const live = cards[1]!.querySelector(".td-item[data-live]")!;
    expect(live.textContent).toBe("in progress: Correct the steps");
    expect(live.querySelector(".td-text")!.getAttribute("data-text")).toBe("Correct the steps");
  });

  it("draws a Codex plan as the same list, with no empty row above it", () => {
    const codex = line(
      { t: "10:00:20", ev: "meta", tag: "todo_list", text: "1 of 2 to-dos done", todos: [{ text: "Plan", status: "completed" }, { text: "Build", status: "pending" }] },
      20,
    );
    const { container } = render(panel([codex]));
    const row = container.querySelector(".log-line.meta")!;
    expect(row.querySelector(".lx")!.textContent).toBe("To-dos1/2 donedone: Planto do: Build");
  });

  it("shimmers \"Thinking\" on the last thought of a running agent, and reads \"Thought for\" once anything follows", () => {
    const think = (n: number, text: string): StreamedLine =>
      line({ t: `10:00:3${n}`, ev: "think", tag: "reasoning", text }, 30 + n);
    const live = render(panel([think(0, "weighing"), think(4, "picking")], { state: "running", lifecycle: "running" }));
    const button = live.getByRole("button", { name: "Thinking · 2 steps" });
    expect(button.querySelector(".log-shimmer")!.getAttribute("data-text")).toBe("Thinking");
    live.unmount();
    const done = render(
      panel([think(0, "weighing"), think(4, "picking"), edit], { state: "running", lifecycle: "running" }),
    );
    expect(done.getByRole("button", { name: "Thought for 4s · 2 steps" }).querySelector(".log-shimmer")).toBeNull();
  });

  it("keeps `{ } raw` authoritative: every stored envelope, no diff, no list", () => {
    const { container, getByText } = render(panel([edit, todos(0, 1)]));
    fireEvent.click(getByText("{ } raw"));
    expect(container.querySelector(".log-diff")).toBeNull();
    expect(container.querySelector(".log-todo")).toBeNull();
    expect(container.textContent).toContain('{"n":1}');
    expect(container.textContent).toContain('{"n":10}');
  });
});
