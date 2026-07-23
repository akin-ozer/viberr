/**
 * In-memory token-bucket rate limiter. Per-process only (single-node app,
 * per architecture) — a restart resets buckets, which is acceptable for
 * login throttling.
 *
 * Login policy: 10 attempts per email+ip per 15 minutes (continuous refill).
 * The key always carries the email, so one account's failures can never deny
 * sign-in to another account — the reason this lives here instead of relying
 * on Better Auth's IP-keyed limiter (see lib/auth.server.ts).
 *
 * Social-start policy: 30 per provider+ip per minute. `/sign-in/social` has no
 * identity to key on — it only mints a provider redirect URL, before anyone has
 * authenticated — so this bucket is unavoidably shared org-wide on a
 * proxy-less deployment (clientIpOf → "local"). It is therefore sized to clear
 * realistic concurrent human use by a wide margin and only bound automation;
 * it exists to DISPLACE Better Auth's 3-per-10s default on the same path,
 * which is tight enough that a handful of simultaneous clicks locks social
 * sign-in out for the whole org.
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

/** See the social-start policy note at the top of this module. */
export const SOCIAL_START_RATE_LIMIT = {
  capacity: 30,
  refillIntervalMs: 60 * 1000,
} as const;

const LIMITER_KEY = Symbol.for("viberr.loginRateLimiter");
const SOCIAL_LIMITER_KEY = Symbol.for("viberr.socialStartRateLimiter");

function cachedLimiter(
  key: symbol,
  options: TokenBucketOptions,
): TokenBucketLimiter {
  const cache = globalThis as unknown as Record<
    symbol,
    TokenBucketLimiter | undefined
  >;
  let limiter = cache[key];
  if (!limiter) {
    limiter = new TokenBucketLimiter(options);
    cache[key] = limiter;
  }
  return limiter;
}

/** Process-wide login limiter (survives HMR). */
export function getLoginRateLimiter(): TokenBucketLimiter {
  return cachedLimiter(LIMITER_KEY, LOGIN_RATE_LIMIT);
}

/** Process-wide `/sign-in/social` start limiter (survives HMR). */
export function getSocialStartRateLimiter(): TokenBucketLimiter {
  return cachedLimiter(SOCIAL_LIMITER_KEY, SOCIAL_START_RATE_LIMIT);
}

/**
 * Best-effort client ip (X-Forwarded-For when behind a proxy). Falls back to
 * "local" — the shipped deployment serves react-router-serve directly with no
 * proxy, so there is no header to read and every request buckets under the
 * same ip. That is safe here only because the bucket key also carries the
 * email.
 */
export function clientIpOf(headers?: Headers | null): string {
  const forwarded = headers?.get("X-Forwarded-For");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "local";
}
