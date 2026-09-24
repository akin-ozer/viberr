import { describe, expect, it } from "vitest";
import {
  collapseTelemetry,
  isTelemetryLine,
  telemetryLabel,
} from "./log-noise";
import type { LogLine } from "./runtime-types";

/**
 * P14-WL-02 — live, one task's console was dozens of `system·thinking_tokens`
 * rows and raw `rate_limit_event` JSON blobs interleaved with the two tool
 * calls a human opened it to read.
 */

function line(patch: Partial<LogLine>) {
  const display: LogLine = {
    t: "09:41:02",
    ev: "text",
    tag: "assistant",
    text: "hi",
    ...patch,
  };
  return { display, raw: '{"type":"assistant"}' };
}

describe("isTelemetryLine", () => {
  it("names the vendors' per-turn accounting envelopes", () => {
    expect(
      isTelemetryLine({ t: "", ev: "meta", tag: "system·thinking_tokens", text: "thinking_tokens" }),
    ).toBe(true);
    expect(
      isTelemetryLine({ t: "", ev: "meta", tag: "rate_limit_event", text: '{"rate_limits":{}}' }),
    ).toBe(true);
  });

  it("leaves meta lines that DO report something alone", () => {
    // An API retry and a compaction boundary are events a reader needs.
    expect(
      isTelemetryLine({ t: "", ev: "meta", tag: "system·api_retry", text: "429" }),
    ).toBe(false);
    expect(
      isTelemetryLine({ t: "", ev: "meta", tag: "turn.started", text: "turn started" }),
    ).toBe(false);
    // Same tag on a non-meta line is not telemetry either.
    expect(
      isTelemetryLine({ t: "", ev: "text", tag: "rate_limit_event", text: "x" }),
    ).toBe(false);
  });
});

describe("collapseTelemetry", () => {
  const rows = [
    line({}),
    line({ ev: "meta", tag: "system·thinking_tokens", text: "thinking_tokens" }),
    line({ ev: "meta", tag: "system·thinking_tokens", text: "thinking_tokens" }),
    line({ ev: "meta", tag: "rate_limit_event", text: '{"rate_limits":{"primary":{}}}' }),
    line({ ev: "tool", tag: "tool_use", text: "npm test", name: "Bash" }),
  ];

  it("folds a consecutive telemetry run into ONE entry that says how many", () => {
    const out = collapseTelemetry(rows, false);
    expect(out.map((e) => e.kind)).toEqual(["line", "telemetry", "line"]);
    const folded = out[1]!;
    if (folded.kind !== "telemetry") throw new Error("expected the folded entry");
    expect(folded.count).toBe(3);
    expect(folded.tags).toEqual(["system·thinking_tokens", "rate_limit_event"]);
    expect(telemetryLabel(folded)).toContain("3 telemetry events");
    expect(telemetryLabel(folded)).toContain("“{ } raw” shows them");
  });

  it("a lone telemetry row's label agrees with its count of one", () => {
    const [folded] = collapseTelemetry(
      [line({ ev: "meta", tag: "rate_limit_event", text: "{}" })],
      false,
    );
    if (folded?.kind !== "telemetry") throw new Error("expected the folded entry");
    expect(telemetryLabel(folded)).toContain("1 telemetry event ");
    expect(telemetryLabel(folded)).toMatch(/“\{ \} raw” shows it$/);
  });

  it("separate runs fold separately — nothing is reordered", () => {
    const out = collapseTelemetry(
      [
        line({ ev: "meta", tag: "rate_limit_event", text: "{}" }),
        line({}),
        line({ ev: "meta", tag: "rate_limit_event", text: "{}" }),
      ],
      false,
    );
    expect(out.map((e) => e.kind)).toEqual(["telemetry", "line", "telemetry"]);
  });

  it("raw mode is a pass-through — the raw toggle shows the stored stream", () => {
    const out = collapseTelemetry(rows, true);
    expect(out).toHaveLength(rows.length);
    expect(out.every((e) => e.kind === "line")).toBe(true);
  });
});
