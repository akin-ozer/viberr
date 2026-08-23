import { afterEach, describe, expect, it } from "vitest";
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
  const savedTrust = process.env.VIBERR_TRUST_PROXY;
  afterEach(() => {
    if (savedTrust === undefined) delete process.env.VIBERR_TRUST_PROXY;
    else process.env.VIBERR_TRUST_PROXY = savedTrust;
  });

  it("ignores X-Forwarded-For entirely when no proxy is trusted (the default)", () => {
    delete process.env.VIBERR_TRUST_PROXY;
    // The leftmost hop is client-settable — trusting it would let a brute-forcer
    // rotate the ip half of the bucket key, so with no trusted proxy the header
    // is not read at all and every request buckets under "local".
    expect(
      clientIpOf(new Headers({ "X-Forwarded-For": "203.0.113.9, 10.0.0.1" })),
    ).toBe("local");
    expect(clientIpOf(new Headers())).toBe("local");
    expect(clientIpOf(undefined)).toBe("local");
  });

  it("with one trusted proxy, reads the rightmost hop (past a spoofed prefix)", () => {
    process.env.VIBERR_TRUST_PROXY = "1";
    // One trusted proxy appends the ip IT saw as the last entry; a client that
    // prepends a spoofed hop cannot move it.
    expect(
      clientIpOf(new Headers({ "X-Forwarded-For": "203.0.113.9" })),
    ).toBe("203.0.113.9");
    expect(
      clientIpOf(new Headers({ "X-Forwarded-For": "1.2.3.4, 203.0.113.9" })),
    ).toBe("203.0.113.9");
    expect(clientIpOf(new Headers())).toBe("local");
  });

  it("with N trusted proxies, reads the Nth hop from the right", () => {
    process.env.VIBERR_TRUST_PROXY = "2";
    // Two trusted proxies → the real client ip is the 2nd from the right; the
    // spoofed leftmost is ignored.
    expect(
      clientIpOf(new Headers({ "X-Forwarded-For": "9.9.9.9, 203.0.113.9, 10.0.0.1" })),
    ).toBe("203.0.113.9");
    // A chain shorter than the declared hop count is a misconfig / stripped
    // header → "local" rather than a spoofable guess.
    expect(
      clientIpOf(new Headers({ "X-Forwarded-For": "203.0.113.9" })),
    ).toBe("local");
  });
});
