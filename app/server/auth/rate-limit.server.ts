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

/**
 * Hard cap on tracked keys, held by EVICTION.
 *
 * The login path is unauthenticated and every distinct `email|ip` mints a
 * bucket, so the map is attacker-sized. A scan cannot hold the cap on its own:
 * a bucket is prunable only once it has fully refilled, so under sustained
 * traffic nothing is ever eligible and the map grows without bound.
 */
export const MAX_TRACKED_KEYS = 10_000;

/**
 * A prune is O(size). Once the map sits at the cap the pruning branch is on the
 * path of EVERY new key, so an unthrottled scan turns the login throttle into
 * the quadratic amplifier it exists to prevent.
 */
const PRUNE_MIN_INTERVAL_MS = 1_000;

export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private lastPrunedAt = Number.NEGATIVE_INFINITY;

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
      this.makeRoom(now);
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

  /**
   * Holds the map under {@link MAX_TRACKED_KEYS} before a new key is inserted.
   *
   * Map iteration is insertion order, so the front is the oldest key: dropping
   * it forgives at most one throttled caller, and flushing a SPECIFIC key costs
   * an attacker MAX_TRACKED_KEYS fresh attempts that this same limiter meters.
   * That is a far better failure than a map an unauthenticated caller grows
   * without bound.
   */
  private makeRoom(now: number): void {
    if (this.buckets.size < MAX_TRACKED_KEYS) return;
    if (now - this.lastPrunedAt >= PRUNE_MIN_INTERVAL_MS) {
      this.lastPrunedAt = now;
      this.prune();
    }
    while (this.buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
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

/**
 * PAT-validation policy (P13-D-33): 10 per user per 5 minutes.
 * `architecture.md` asks for targeted limits on "PAT validation" and there were
 * none. Saving or replacing a connection token makes the app call GitHub with a
 * token the CALLER supplied — an authenticated org admin could otherwise use
 * the connection form as an unmetered GitHub-probe proxy, and even honest
 * retries burn the org's rate-limit budget. Keyed on the user id (always known
 * here, unlike the login path's ip), so one admin's retries never block
 * another's.
 */
export const PAT_VALIDATION_RATE_LIMIT = {
  capacity: 10,
  refillIntervalMs: 5 * 60 * 1000,
} as const;

const LIMITER_KEY = Symbol.for("viberr.loginRateLimiter");
const SOCIAL_LIMITER_KEY = Symbol.for("viberr.socialStartRateLimiter");
const PAT_LIMITER_KEY = Symbol.for("viberr.patValidationRateLimiter");

function cachedLimiter(
  key: symbol,
  options: TokenBucketOptions,
): TokenBucketLimiter {
  // SAFETY: `globalThis` carries no index signature, so the symbol slots have
  // to be named to be read at all. The `Symbol.for("viberr.*RateLimiter")` keys
  // are written nowhere but the assignment below, which only ever stores a
  // TokenBucketLimiter — a slot therefore holds one of ours or nothing.
  const cache = globalThis as Record<symbol, TokenBucketLimiter | undefined>;
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

/** Process-wide PAT-validation limiter (P13-D-33). Key: the actor's user id. */
export function getPatValidationRateLimiter(): TokenBucketLimiter {
  return cachedLimiter(PAT_LIMITER_KEY, PAT_VALIDATION_RATE_LIMIT);
}

/** How many trusted reverse proxies sit in front of the app, from
 *  `VIBERR_TRUST_PROXY` (default 0 = trust none). See `clientIpOf`. Read from
 *  raw env so a test can flip it per case; a non-positive/garbage value is 0. */
function trustedProxyHops(): number {
  const raw = process.env.VIBERR_TRUST_PROXY;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Best-effort client ip for the `email|ip` login bucket key.
 *
 * `X-Forwarded-For` is CLIENT-SETTABLE: every proxy APPENDS the ip it observed,
 * so the LEFTMOST value is whatever the original caller chose to send. Trusting
 * it (the old behavior) let a brute-forcer rotate the ip half of the bucket key
 * on every attempt and defeat the per-email throttle outright — and in the
 * shipped proxy-less deployment the header is 100% attacker input, so there is
 * no safe leftmost value to read at all.
 *
 * So the header is honored ONLY when the operator declares how many trusted
 * proxies sit in front (`VIBERR_TRUST_PROXY=N`), and the ip is read as the Nth
 * hop FROM THE RIGHT — the address the outermost trusted proxy actually saw,
 * past any spoofed prefix the client prepended. Trust none (the default) or a
 * chain shorter than N (misconfig / stripped) → "local", so every attempt for
 * an email shares one bucket and the throttle holds. Safe because the key also
 * carries the email.
 */
export function clientIpOf(headers?: Headers | null): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    const chain = headers
      ?.get("X-Forwarded-For")
      ?.split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (chain && chain.length >= hops) {
      const ip = chain[chain.length - hops];
      if (ip) return ip;
    }
  }
  return "local";
}
