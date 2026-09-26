import { describe, expect, it } from "vitest";
import { isTelemetryLine, telemetryLabel } from "./log-noise";

/**
 * P14-WL-02 — live, one task's console was dozens of `system·thinking_tokens`
 * rows and raw `rate_limit_event` JSON blobs interleaved with the two tool
 * calls a human opened it to read.
 */

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

describe("telemetryLabel", () => {
  it("labels a folded run by its count, and says where the lines went", () => {
    const three = telemetryLabel({ count: 3, tags: ["system·thinking_tokens", "rate_limit_event"] });
    expect(three).toContain("3 telemetry events");
    expect(three).toContain("“{ } raw” shows them");
    // A lone row's label agrees with its count of one.
    const one = telemetryLabel({ count: 1, tags: ["rate_limit_event"] });
    expect(one).toContain("1 telemetry event ");
    expect(one).toMatch(/“\{ \} raw” shows it$/);
  });
});
