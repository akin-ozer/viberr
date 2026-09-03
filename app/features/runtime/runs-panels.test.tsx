// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentLogsPanel, LiveRunPanel } from "./runs-panels";
import {
  runBoundaryLine,
  RUN_INPUTS_TAG,
  type RunInputs,
  type RunView,
} from "./runtime-types";
import type { OlderLogState, StreamedLine } from "./use-run-log-stream";

afterEach(cleanup);

function mkRun(patch: Partial<RunView>): RunView {
  return {
    id: "primary", serverRunId: "run_1", role: "Primary specialist", kind: "primary",
    who: { kind: "agent", backend: "claude", name: "Claude Code", role: "Developer" },
    backend: "claude", sdk: "Claude Agent SDK", model: "claude-sonnet-4-5",
    exportable: false, sid: "51d8f0e2-3a7b", state: "running", lifecycle: "running", interruptedBy: null,
    phase: "Running validation sweep", step: "Bash · npm test", startedAt: new Date(Date.now() - 402_000).toISOString(),
    finished: null, turns: 0, tokens: 0,
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
    expect(getByText("06:42")).toBeTruthy();
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
    const { queryByText, rerender, getByText } = render(
      <LiveRunPanel runtime={[mkRun({})]} onViewLogs={() => {}} onInterrupt={onInterrupt} canInterrupt={false} interrupting={false} />,
    );
    expect(queryByText("Interrupt")).toBeNull();
    rerender(<LiveRunPanel runtime={[mkRun({})]} onViewLogs={() => {}} onInterrupt={onInterrupt} canInterrupt interrupting={false} />);
    fireEvent.click(getByText("Interrupt"));
    expect(onInterrupt).toHaveBeenCalledWith("primary");
  });
});

describe("AgentLogsPanel", () => {
  it("renders the exact empty state when the task has no runtime", () => {
    const { getByText } = render(<AgentLogsPanel runtime={[]} sel={null} onSel={() => {}} linesByThread={{}} />);
    expect(getByText("No agent runs yet. Runtime streams appear here once the operator engages a specialist.")).toBeTruthy();
  });

  it("running thread: streaming footer + cursor line + running pill", () => {
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[mkRun({})]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "init", tag: "system·init", text: "x" }, raw: "{}" }] }} />,
    );
    expect(getByText("streaming: raw output stays here as evidence, never in the task record")).toBeTruthy();
    expect(container.querySelector(".log-line.cursor")).not.toBeNull();
    expect(container.querySelector(".logs-bar .pill.agent")).not.toBeNull();
  });

  it("done thread: 'run finished at …' footer, no cursor", () => {
    const run = mkRun({ state: "done", lifecycle: "finished", finished: "9:41" });
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: run.lines.map((d, i) => ({ display: d, raw: run.raw[i]! })) }} />,
    );
    expect(getByText("run finished at 9:41; thread can be re-engaged")).toBeTruthy();
    expect(container.querySelector(".log-line.cursor")).toBeNull();
  });

  it("error thread: continuity-error footer + blocked pill", () => {
    const run = mkRun({ state: "error", lifecycle: "error" });
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "err", tag: "tool_result", text: "boom" }, raw: "{}" }] }} />,
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
      <AgentLogsPanel
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
      <AgentLogsPanel
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

    // Owner connects Codex: the same run now carries a real offer.
    rerender(
      <AgentLogsPanel
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
      <AgentLogsPanel
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
      <AgentLogsPanel
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
        <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "17:46:46", ev: "text", tag: "agent_message", text: "done" }, raw: "{}" }] }} />,
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
      <AgentLogsPanel runtime={[mkRun({ state: "idle", lifecycle: "finished" })]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "init", tag: "system·init", text: "friendly text" }, raw }] }} />,
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
    const { container, getByText, queryByText } = render(
      <AgentLogsPanel
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
    // behind it rather than gone.
    expect(getByText("Thought for 4s · 2 steps")).toBeTruthy();
    expect(queryByText("weighing the options")).toBeNull();
    fireEvent.click(getByText("Thought for 4s · 2 steps"));
    expect(getByText("weighing the options")).toBeTruthy();
    expect(getByText("picking the branch")).toBeTruthy();

    // …and `raw` is authoritative: no fold, both stored envelopes verbatim.
    fireEvent.click(getByText("{ } raw"));
    expect(container.textContent).toContain(rawA);
    expect(container.textContent).toContain(rawB);
    expect(queryByText(/Thought for/)).toBeNull();
  });

  it("renders a tool call as a chip and file changes as per-file chips", () => {
    const { container, getByText, queryByText } = render(
      <AgentLogsPanel
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
    expect(files.map((f) => f.textContent)).toEqual(["+app/a.ts", "−app/b.ts"]);
    // WCAG 1.4.1: the kind is a glyph as well as a colour class.
    expect(files[0]!.className).toContain("lf-add");
    expect(files[1]!.className).toContain("lf-delete");

    fireEvent.click(getByText("{ } raw"));
    expect(container.querySelector(".log-chip")).toBeNull();
    expect(container.querySelector(".log-file")).toBeNull();
    expect(queryByText("npm run build")).toBeNull();
  });

  it("lifts multi-line output into a bounded block, whole and copyable", () => {
    const out = ["> npm test", "", "34 passed", "done in 1.2s"].join("\n");
    const { container, getByText } = render(
      <AgentLogsPanel
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
    expect(getByText("4 lines")).toBeTruthy();
    // The text is not ALSO printed inline above the block.
    expect(container.querySelectorAll(".log-line.out .lx")[0]!.textContent).toBe(
      block.textContent,
    );
  });

  it("colours diff polarity on top of the glyph the stored line already carries", () => {
    const { container } = render(
      <AgentLogsPanel
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
      <AgentLogsPanel
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
    expect(getByText("4 events")).toBeTruthy();
  });

  it("codex meta line vs claude meta line", () => {
    const codex = mkRun({ backend: "codex", sid: "0199a2c4-7b31-7802", state: "idle", lifecycle: "finished" });
    const { getByText } = render(
      <AgentLogsPanel runtime={[codex]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
    );
    expect(getByText(/@openai\/codex-sdk · runStreamed\(\) · thread/)).toBeTruthy();
  });

  it("the picker labels each agent by its who.name (grouped, one per agent)", () => {
    // Two grouped entries: the operator + a "dev" specialist (BUG 2).
    const op = mkRun({ id: "op", op: true, who: { kind: "agent", name: "Operator" }, state: "idle", lifecycle: "finished" });
    const dev = mkRun({ id: "primary", who: { kind: "agent", backend: "claude", name: "dev", role: "developer" }, state: "idle", lifecycle: "finished" });
    const { container } = render(
      <AgentLogsPanel runtime={[op, dev]} sel="primary" onSel={() => {}} linesByThread={{ op: [], primary: [] }} />,
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
      <AgentLogsPanel
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
      <AgentLogsPanel
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
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
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

  it("P11-43: the Export link renders only when the run is exportable", () => {
    const notExportable = mkRun({
      backend: "claude",
      sid: "aaaa-1111",
      state: "idle",
      lifecycle: "finished",
      exportable: false,
    });
    const { queryByTitle, rerender } = render(
      <AgentLogsPanel runtime={[notExportable]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
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
      <AgentLogsPanel runtime={[exportable]} sel="primary" onSel={() => {}} linesByThread={{ primary: [] }} />,
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
      <AgentLogsPanel
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
      <AgentLogsPanel
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
      <AgentLogsPanel
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
      <AgentLogsPanel
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
      <AgentLogsPanel
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
    const { getByText, rerender } = render(
      <AgentLogsPanel
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
    expect(getByText("6 events")).toBeTruthy();

    // A live tail can run ahead of the loader's snapshot — the count follows
    // the lines that exist, so it never goes backwards.
    rerender(
      <AgentLogsPanel
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
    expect(getByText("8 events")).toBeTruthy();
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
      <AgentLogsPanel runtime={runs} sel="primary" onSel={() => {}} linesByThread={{ primary: [], c0: [] }} />,
    );
    const role = () => container.querySelector(".rsel-role")!.textContent!;
    expect(role()).toContain("delivering");
    // "primary" is the internal kind literal — a THIRD name for the agent the
    // Execution profile on this same page calls "Delivering agent".
    expect(role()).not.toContain("primary");
    rerender(
      <AgentLogsPanel runtime={runs} sel="c0" onSel={() => {}} linesByThread={{ primary: [], c0: [] }} />,
    );
    expect(role()).toContain("supporting");
  });

  it("UXV19-5: an option carries its run's LIFECYCLE, so the list, the pill and the footer agree", () => {
    // Canary: put `RUN_STATE[r.state].label` back in the option and the
    // interrupted/queued expectations below fail on "idle".
    const { container } = render(
      <AgentLogsPanel
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
      "interrupted by Arda; the thread stays resumable",
    );
  });
});

describe("AgentPicker dismissal (shared useDismiss)", () => {
  function openPicker() {
    const op = mkRun({ id: "op", op: true, who: { kind: "agent", name: "Operator" }, state: "idle", lifecycle: "finished" });
    const dev = mkRun({ id: "primary", who: { kind: "agent", backend: "claude", name: "dev", role: "developer" }, state: "idle", lifecycle: "finished" });
    const view = render(
      <AgentLogsPanel runtime={[op, dev]} sel="primary" onSel={() => {}} linesByThread={{ op: [], primary: [] }} />,
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
    sandbox: null,
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
      <AgentLogsPanel
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

  it("yields to the raw toggle like every other line", () => {
    // The `{ } raw` contract is "the stored envelope, verbatim" — a viberr line
    // does not get to keep its friendly rendering there.
    const { getByText, queryByText, container } = renderConsole([line]);
    fireEvent.click(getByText("{ } raw"));
    expect(container.textContent).toContain(rawEnvelope);
    expect(queryByText("show what this run was given")).toBeNull();
  });
});
