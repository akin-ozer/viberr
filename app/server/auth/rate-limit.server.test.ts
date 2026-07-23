import { describe, expect, it } from "vitest";
import { clientIpOf, TokenBucketLimiter } from "./rate-limit.server";

describe("TokenBucketLimiter", () => {
  it("allows exactly `capacity` immediate attempts, then blocks", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 10,
      refillIntervalMs: 15 * 60 * 1000,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume("k")).toBe(true);
    }
    expect(limiter.tryConsume("k")).toBe(false);
    expect(limiter.tryConsume("k")).toBe(false);
  });

  it("keys are independent", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillIntervalMs: 1000,
      now: () => now,
    });
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("b")).toBe(true);
  });

  it("refills continuously over the window", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 10,
      refillIntervalMs: 15 * 60 * 1000,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) limiter.tryConsume("k");
    expect(limiter.tryConsume("k")).toBe(false);
    // 1/10th of the window refills one token.
    now += (15 * 60 * 1000) / 10;
    expect(limiter.tryConsume("k")).toBe(true);
    expect(limiter.tryConsume("k")).toBe(false);
    // A full window fully refills (capped at capacity).
    now += 16 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      expect(limiter.tryConsume("k")).toBe(true);
    }
    expect(limiter.tryConsume("k")).toBe(false);
  });

  it("reset() forgives a key", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillIntervalMs: 60_000,
      now: () => now,
    });
    limiter.tryConsume("k");
    expect(limiter.tryConsume("k")).toBe(false);
    limiter.reset("k");
    expect(limiter.tryConsume("k")).toBe(true);
  });
});

describe("clientIpOf", () => {
  it("uses the first X-Forwarded-For hop, else 'local'", () => {
    expect(
      clientIpOf(new Headers({ "X-Forwarded-For": "203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9");
    expect(clientIpOf(new Headers())).toBe("local");
    expect(clientIpOf(undefined)).toBe("local");
  });
});
