import { describe, expect, it } from "vitest";
import {
  clampTimelineLimit,
  sliceTimeline,
  TIMELINE_INITIAL_SLICE,
  TIMELINE_SLICE_STEP,
} from "./timeline-slice";

describe("clampTimelineLimit", () => {
  it("falls back to the initial slice for junk", () => {
    for (const raw of [null, undefined, "", "abc", "-3", "0", "1.5", "NaN"]) {
      expect(clampTimelineLimit(raw)).toBe(TIMELINE_INITIAL_SLICE);
    }
  });
  it("accepts positive integers and caps hostile values", () => {
    expect(clampTimelineLimit("2")).toBe(2);
    expect(clampTimelineLimit("60")).toBe(60);
    expect(clampTimelineLimit("999999999")).toBe(10_000);
  });
});

describe("sliceTimeline", () => {
  const events = Array.from({ length: 75 }, (_, i) => ({ id: i }));

  it("serves a bounded newest-first slice with remainder accounting", () => {
    const slice = sliceTimeline(events, TIMELINE_INITIAL_SLICE);
    expect(slice.events).toHaveLength(30);
    expect(slice.events[0]).toEqual({ id: 0 }); // newest-first order kept
    expect(slice.total).toBe(75);
    expect(slice.hasMore).toBe(true);
    expect(slice.remaining).toBe(45);
    expect(slice.nextLimit).toBe(30 + TIMELINE_SLICE_STEP);
  });

  it("caps nextLimit at the total on the last step", () => {
    const slice = sliceTimeline(events, 60);
    expect(slice.events).toHaveLength(60);
    expect(slice.remaining).toBe(15);
    expect(slice.nextLimit).toBe(75);
    const last = sliceTimeline(events, 75);
    expect(last.hasMore).toBe(false);
    expect(last.remaining).toBe(0);
    expect(last.events).toHaveLength(75);
  });

  it("short histories fit in the first payload", () => {
    const nine = events.slice(0, 9);
    const slice = sliceTimeline(nine, TIMELINE_INITIAL_SLICE);
    expect(slice.events).toHaveLength(9);
    expect(slice.hasMore).toBe(false);
    expect(slice.remaining).toBe(0);
    expect(slice.nextLimit).toBe(9);
  });

  it("never slices below one event", () => {
    const slice = sliceTimeline(events, 0);
    expect(slice.events).toHaveLength(1);
  });
});
