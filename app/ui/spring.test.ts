import { describe, expect, it } from "vitest";
import { createVelocityTracker, springAt, springFrames, springProgress, type Spring } from "./spring";

const CRITICAL: Spring = { dampingRatio: 1, response: 0.3 };
const BOUNCY: Spring = { dampingRatio: 0.6, response: 0.3 };

describe("springAt", () => {
  it("starts where it is told and comes to rest on the target", () => {
    expect(springAt(CRITICAL, -300, 0, 0)).toBe(-300);
    expect(Math.abs(springAt(CRITICAL, -300, 0, 1))).toBeLessThan(0.05);
    expect(Math.abs(springAt(BOUNCY, -300, 0, 1))).toBeLessThan(0.5);
  });

  it("a critically damped spring released at rest never passes its target", () => {
    for (let t = 0; t <= 1; t += 1 / 120) {
      expect(springAt(CRITICAL, -300, 0, t)).toBeLessThanOrEqual(0);
    }
  });

  it("an underdamped one does (the damping ratio is the overshoot control)", () => {
    let most = -Infinity;
    for (let t = 0; t <= 1; t += 1 / 120) most = Math.max(most, springAt(BOUNCY, -300, 0, t));
    expect(most).toBeGreaterThan(1);
  });

  it("leaves at the velocity it is handed", () => {
    const h = 1e-5;
    const v = (springAt(CRITICAL, -300, 900, h) - springAt(CRITICAL, -300, 900, 0)) / h;
    expect(v).toBeCloseTo(900, 0);
  });

  it("a lower response gets there sooner", () => {
    const at = (response: number) => Math.abs(springAt({ dampingRatio: 1, response }, -300, 0, 0.15));
    expect(at(0.2)).toBeLessThan(at(0.4));
  });
});

describe("springFrames", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 240, y: -80 };

  it("runs at 60 frames a second from the start to exactly the target", () => {
    const { frames, duration } = springFrames(CRITICAL, from, to);
    expect(frames[0]).toEqual(from);
    expect(frames[frames.length - 1]).toEqual(to);
    expect(duration).toBeCloseTo(((frames.length - 1) * 1000) / 60, 6);
    // The 0.3 s response settles in well under the one-second cap.
    expect(duration).toBeGreaterThan(250);
    expect(duration).toBeLessThan(600);
  });

  it("starts at rest when released at rest — no lurch on the first frame", () => {
    const { frames } = springFrames(CRITICAL, from, to);
    const first = Math.hypot(frames[1]!.x - frames[0]!.x, frames[1]!.y - frames[0]!.y);
    const second = Math.hypot(frames[2]!.x - frames[1]!.x, frames[2]!.y - frames[1]!.y);
    expect(first).toBeLessThan(second);
  });

  it("carries a throw's velocity through the release", () => {
    const thrown = springFrames(CRITICAL, from, to, { x: 1800, y: -600 });
    const still = springFrames(CRITICAL, from, to);
    const extra = thrown.frames[1]!.x - still.frames[1]!.x;
    // 1800 px/s over the first 1/60 s is 30 px on top of the spring's own
    // pull, less what its damping brakes.
    expect(extra).toBeGreaterThan(20);
    expect(extra).toBeLessThan(30);
  });

  it("moves each axis on its own spring: a sideways throw curves nothing it should not", () => {
    // A vertical flick on a horizontal move bends the path up and back...
    const { frames } = springFrames(CRITICAL, { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: -900 });
    expect(Math.min(...frames.map((f) => f.y))).toBeLessThan(-5);
    // ...and the horizontal leg is the at-rest one, untouched by it.
    const still = springFrames(CRITICAL, { x: 0, y: 0 }, { x: 200, y: 0 });
    expect(frames.slice(0, 6).map((f) => f.x)).toEqual(still.frames.slice(0, 6).map((f) => f.x));
  });

  it("stops at the one-second cap and still lands on the target", () => {
    const { frames, duration } = springFrames({ dampingRatio: 0.05, response: 0.3 }, from, to);
    expect(duration).toBe(1000);
    expect(frames[frames.length - 1]).toEqual(to);
  });
});

describe("springProgress", () => {
  it("rises from 0 to exactly 1 over the frames it is asked for", () => {
    const p = springProgress(CRITICAL, 20);
    expect(p).toHaveLength(20);
    expect(p[0]).toBe(0);
    expect(p[19]).toBe(1);
    for (let i = 1; i < p.length; i++) expect(p[i]!).toBeGreaterThanOrEqual(p[i - 1]!);
  });
});

describe("createVelocityTracker", () => {
  it("reads the pointer's speed over its last few samples", () => {
    const tracker = createVelocityTracker();
    for (let i = 0; i <= 6; i++) tracker.push(i * 10, i * -5, i * 16);
    const v = tracker.velocity(96);
    expect(v.x).toBeCloseTo(625, 0);
    expect(v.y).toBeCloseTo(-312.5, 0);
  });

  it("forgets samples older than its window", () => {
    const tracker = createVelocityTracker();
    tracker.push(0, 0, 0); // a fast start long before the release...
    tracker.push(500, 0, 10);
    for (let t = 200; t <= 300; t += 20) tracker.push(500 + (t - 200), 0, t);
    // ...counts for nothing: the last 100 ms moved at 1 px/ms.
    expect(tracker.velocity(300).x).toBeCloseTo(1000, 0);
  });

  it("is at rest when the pointer paused before letting go", () => {
    const tracker = createVelocityTracker();
    for (let i = 0; i <= 6; i++) tracker.push(i * 10, 0, i * 16);
    expect(tracker.velocity(96 + 80)).toEqual({ x: 0, y: 0 });
  });

  it("is at rest with fewer than two samples, and after a reset", () => {
    const tracker = createVelocityTracker();
    expect(tracker.velocity(0)).toEqual({ x: 0, y: 0 });
    tracker.push(0, 0, 0);
    expect(tracker.velocity(0)).toEqual({ x: 0, y: 0 });
    tracker.push(50, 0, 16);
    tracker.reset();
    expect(tracker.velocity(16)).toEqual({ x: 0, y: 0 });
  });

  it("measures nothing, rather than dividing by zero, when the samples share one tick", () => {
    // CANARY: drop the `last.t <= first.t` guard — 0/0 is NaN, and the
    // board's drop flight then asked WAAPI for `NaNpx` keyframes.
    const tracker = createVelocityTracker();
    tracker.push(0, 100, 5);
    tracker.push(0, 100, 5);
    tracker.push(0, 140, 5);
    expect(tracker.velocity(5)).toEqual({ x: 0, y: 0 });
  });

  it("clamps a coalesced-event spike", () => {
    const tracker = createVelocityTracker();
    tracker.push(0, 0, 0);
    tracker.push(900, 0, 1);
    expect(tracker.velocity(1).x).toBe(8000);
  });
});
