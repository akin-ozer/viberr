// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentLogsPanel, LiveRunPanel } from "./runs-panels";
import { runBoundaryLine, type RunView } from "./runtime-types";
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
    expect(getByText("No agent runs yet — runtime streams appear here once the operator engages a specialist.")).toBeTruthy();
  });

  it("running thread: streaming footer + cursor line + running pill", () => {
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[mkRun({})]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "init", tag: "system·init", text: "x" }, raw: "{}" }] }} />,
    );
    expect(getByText("streaming — raw output stays here as evidence, never in the task record")).toBeTruthy();
    expect(container.querySelector(".log-line.cursor")).not.toBeNull();
    expect(container.querySelector(".logs-bar .pill.agent")).not.toBeNull();
  });

  it("done thread: 'run finished at …' footer, no cursor", () => {
    const run = mkRun({ state: "done", lifecycle: "finished", finished: "9:41" });
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: run.lines.map((d, i) => ({ display: d, raw: run.raw[i]! })) }} />,
    );
    expect(getByText("run finished at 9:41 — thread can be re-engaged")).toBeTruthy();
    expect(container.querySelector(".log-line.cursor")).toBeNull();
  });

  it("error thread: continuity-error footer + blocked pill", () => {
    const run = mkRun({ state: "error", lifecycle: "error" });
    const { container, getByText } = render(
      <AgentLogsPanel runtime={[run]} sel="primary" onSel={() => {}} linesByThread={{ primary: [{ display: { t: "1", ev: "err", tag: "tool_result", text: "boom" }, raw: "{}" }] }} />,
    );
    expect(getByText("stream ended on a continuity error — see the blocked packet")).toBeTruthy();
    expect(container.querySelector(".logs-bar .pill.blocked")).not.toBeNull();
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
    expect(getByText("streaming — raw output stays here as evidence, never in the task record")).toBeTruthy();
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
  const older = (patch: Partial<OlderLogState> = {}): Record<string, OlderLogState> => ({
    primary: { hasMore: true, withheld: 528, loading: false, error: null, ...patch },
  });
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
    const box = container.querySelector(".console") as HTMLElement;
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
