/**
 * In-memory token-bucket rate limiter. Per-process only (single-node app,
 * per architecture) — a restart resets buckets, which is acceptable for
 * login throttling.
 *
 * Login policy: 10 attempts per email+ip per 15 minutes (continuous refill).
 */

export interface TokenBucketOptions {
  /** Bucket capacity = burst size (e.g. 10 attempts). */
  capacity: number;
  /** Time for a full refill of `capacity` tokens (e.g. 15 minutes). */
  refillIntervalMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const MAX_TRACKED_KEYS = 10_000;

export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity;
    this.refillIntervalMs = options.refillIntervalMs;
    this.now = options.now ?? Date.now;
  }

  /** Consumes one token; false = rate limited. */
  tryConsume(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_TRACKED_KEYS) this.prune();
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + (elapsed * this.capacity) / this.refillIntervalMs,
      );
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Clears a key (e.g. after a successful login). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drops buckets that have fully refilled (no memory of past failures). */
  prune(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      const tokens =
        bucket.tokens + (elapsed * this.capacity) / this.refillIntervalMs;
      if (tokens >= this.capacity) this.buckets.delete(key);
    }
  }
}

export const LOGIN_RATE_LIMIT = {
  capacity: 10,
  refillIntervalMs: 15 * 60 * 1000,
} as const;

const LIMITER_KEY = Symbol.for("viberr.loginRateLimiter");

/** Process-wide login limiter (survives HMR). */
export function getLoginRateLimiter(): TokenBucketLimiter {
  const cache = globalThis as unknown as Record<
    symbol,
    TokenBucketLimiter | undefined
  >;
  let limiter = cache[LIMITER_KEY];
  if (!limiter) {
    limiter = new TokenBucketLimiter(LOGIN_RATE_LIMIT);
    cache[LIMITER_KEY] = limiter;
  }
  return limiter;
}

/** Best-effort client ip (X-Forwarded-For when behind a proxy). */
export function clientIpOf(request: Request): string {
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "local";
}
