import { describe, expect, it } from "vitest";
import {
  clampTimelineLimit,
  timelineSlice,
  timelineWindowSize,
} from "./timeline-slice";

describe("clampTimelineLimit", () => {
  it("falls back to the initial slice for junk", () => {
    for (const raw of [null, undefined, "", "abc", "-3", "0", "1.5", "NaN"]) {
      expect(clampTimelineLimit(raw)).toBe(30);
    }
  });
  it("accepts positive integers and caps hostile values", () => {
    expect(clampTimelineLimit("2")).toBe(2);
    expect(clampTimelineLimit("60")).toBe(60);
    expect(clampTimelineLimit("999999999")).toBe(10_000);
  });
});

describe("timelineSlice over the whole history", () => {
  const events = Array.from({ length: 75 }, (_, i) => ({ id: i }));

  it("serves a bounded newest-first slice with remainder accounting", () => {
    const slice = timelineSlice(events, events.length, 30);
    expect(slice.events).toHaveLength(30);
    expect(slice.events[0]).toEqual({ id: 0 }); // newest-first order kept
    expect(slice.hasMore).toBe(true);
    expect(slice.remaining).toBe(45);
    expect(slice.nextLimit).toBe(60);
  });

  it("caps nextLimit at the total on the last step", () => {
    const slice = timelineSlice(events, events.length, 60);
    expect(slice.events).toHaveLength(60);
    expect(slice.remaining).toBe(15);
    expect(slice.nextLimit).toBe(75);
    const last = timelineSlice(events, events.length, 75);
    expect(last.hasMore).toBe(false);
    expect(last.remaining).toBe(0);
    expect(last.events).toHaveLength(75);
  });

  it("short histories fit in the first payload", () => {
    const nine = events.slice(0, 9);
    const slice = timelineSlice(nine, nine.length, 30);
    expect(slice.events).toHaveLength(9);
    expect(slice.hasMore).toBe(false);
    expect(slice.remaining).toBe(0);
    expect(slice.nextLimit).toBe(9);
  });

  it("never slices below one event", () => {
    const slice = timelineSlice(events, events.length, 0);
    expect(slice.events).toHaveLength(1);
  });
});

describe("timelineSlice over a fetched window (ruling 11)", () => {
  it("equals slicing the whole history, for every limit and length", () => {
    const history = Array.from({ length: 75 }, (_, i) => `e${i}`);
    for (const total of [0, 1, 9, 30, 31, 75]) {
      const all = history.slice(0, total);
      for (const limit of [0, 1, 29, 30, 31, 60, 75, 10_000]) {
        const window = all.slice(0, timelineWindowSize(limit));
        expect(timelineSlice(window, total, limit)).toEqual(
          timelineSlice(all, all.length, limit),
        );
      }
    }
  });
});
