import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientIpOf,
  MAX_TRACKED_KEYS,
  TokenBucketLimiter,
} from "./rate-limit.server";

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

  /**
   * The login path is unauthenticated, so an attacker varying the `email` half
   * of the key mints a bucket per attempt. A prune frees only FULLY REFILLED
   * buckets, so under sustained traffic nothing is ever eligible: the cap held
   * nothing, and every later insert paid a full O(n) scan — the throttle
   * becoming the amplifier.
   */
  it("bounds the tracked-key map and does not rescan on every new key", () => {
    const now = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillIntervalMs: 60_000,
      now: () => now,
    });
    const prune = vi.spyOn(limiter, "prune");

    // The clock never advances, so no bucket ever refills and none is prunable.
    for (let i = 0; i < MAX_TRACKED_KEYS + 50; i += 1) {
      limiter.tryConsume(`k${i}`);
    }

    // The oldest key was evicted, so it is forgiven rather than tracked
    // forever: a fresh bucket answers true where a retained (spent) one
    // answered false. (Every bucket here is equally spent, so the least
    // -throttled eviction degenerates to the first-inserted one.)
    expect(limiter.tryConsume("k0")).toBe(true);
    // And the O(n) scan is time-limited, not once per insert.
    expect(prune.mock.calls.length).toBeLessThanOrEqual(1);
  });

  /**
   * bug-sweep #2: eviction must target the LEAST-throttled bucket, never the
   * oldest-inserted. Otherwise an attacker who has driven a victim's `email|ip`
   * bucket to its lockout can flood the map with rotating fresh keys to evict
   * that specific throttled bucket, and the next victim attempt mints a fresh
   * full one — converting the 10-per-15-min lockout into unbounded guessing.
   */
  it("a flood of fresh keys cannot evict a specific throttled bucket to reset it", () => {
    const now = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 10,
      refillIntervalMs: 15 * 60 * 1000,
      now: () => now,
    });
    // Drive the victim to its lockout: 10 pass, the 11th is blocked.
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.tryConsume("victim|ip")).toBe(true);
    }
    expect(limiter.tryConsume("victim|ip")).toBe(false);

    // Flood past the cap with rotating fresh keys — each a nearly-full bucket,
    // so the LEAST-throttled eviction target is always one of THESE, not the
    // victim's spent bucket (the clock is frozen, so nothing refills).
    for (let i = 0; i < MAX_TRACKED_KEYS + 5; i += 1) {
      limiter.tryConsume(`flood-${i}|ip`);
    }

    // The victim's throttled bucket survived: the lockout is NOT reset.
    expect(limiter.tryConsume("victim|ip")).toBe(false);
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
