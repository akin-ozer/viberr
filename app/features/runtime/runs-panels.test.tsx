// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentLogsPanel, LiveRunPanel } from "./runs-panels";
import type { RunView } from "./runtime-types";
import type { StreamedLine } from "./use-run-log-stream";

afterEach(cleanup);

function mkRun(patch: Partial<RunView>): RunView {
  return {
    id: "primary", serverRunId: "run_1", role: "Primary specialist", kind: "primary",
    who: { kind: "agent", backend: "claude", name: "Claude Code", role: "Developer" },
    backend: "claude", simulated: true, sdk: "Claude Agent SDK", model: "claude-sonnet-4-5",
    sid: "51d8f0e2-3a7b", state: "running", lifecycle: "running", interruptedBy: null,
    phase: "Running validation sweep", step: "Bash · npm test", startedAt: new Date(Date.now() - 402_000).toISOString(),
    finished: null, turns: 0, tokens: 0,
    lines: [{ t: "1", ev: "init", tag: "system·init", text: "session x" }],
    raw: ['{"type":"system","subtype":"init","session_id":"51d8f0e2"}'], lineCount: 1,
    ...patch,
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

  it("shows an interrupting acknowledgement while the action is pending", () => {
    const { getByText, getByRole } = render(
      <LiveRunPanel runtime={[mkRun({})]} onViewLogs={() => {}} onInterrupt={() => {}} canInterrupt interrupting />,
    );
    expect(getByText("Interrupting…")).toBeTruthy();
    expect(
      getByRole("button", { name: "Interrupting…" }).getAttribute("aria-busy"),
    ).toBe("true");
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
    const { getByRole, getByText } = render(
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
});
