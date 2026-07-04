import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { logger } from "../logging/logger.server";

/**
 * Server-side sessions in the `sessions` table.
 *
 * - The opaque token (256 random bits, base64url) only ever lives in the
 *   signed viberr_session cookie.
 * - The DB `sessions.id` is sha256(token) hex — a leaked DB never yields
 *   usable session tokens.
 * - 30-day rolling expiry: reads renew expires_at (at most once per
 *   SESSION_RENEW_INTERVAL_MS) so active users never get logged out.
 * - Expired rows are deleted on read, on boot, and by a daily sweeper.
 */

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Renew at most once a day to avoid a DB write per request. */
export const SESSION_RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SessionRecord {
  /** sha256(token) hex — the DB primary key, safe to log. */
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface CreatedSession {
  /** Raw opaque token — goes into the cookie, never into the DB or logs. */
  token: string;
  id: string;
  expiresAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
}

function mapSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export function createSession(
  db: Database.Database,
  userId: string,
  meta: SessionMeta = {},
): CreatedSession {
  const token = randomBytes(32).toString("base64url"); // 256-bit opaque token
  const id = hashSessionToken(token);
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    new Date(now).toISOString(),
    expiresAt,
    meta.ip ?? null,
    meta.userAgent ?? null,
  );
  return { token, id, expiresAt };
}

export interface GetSessionResult {
  session: SessionRecord;
  /** True when the rolling expiry was extended (re-issue the cookie). */
  renewed: boolean;
}

/**
 * Looks up a session by its raw token. Expired sessions are deleted and
 * treated as absent. Valid sessions get their rolling expiry extended at
 * most once per SESSION_RENEW_INTERVAL_MS.
 */
export function getSessionByToken(
  db: Database.Database,
  token: string,
): GetSessionResult | null {
  const id = hashSessionToken(token);
  const row = db
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
  if (!row) return null;

  const now = Date.now();
  const expiresAtMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
    return null;
  }

  let renewed = false;
  if (expiresAtMs - now <= SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS) {
    row.expires_at = new Date(now + SESSION_TTL_MS).toISOString();
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(
      row.expires_at,
      id,
    );
    renewed = true;
  }
  return { session: mapSessionRow(row), renewed };
}

export function destroySessionByToken(
  db: Database.Database,
  token: string,
): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(hashSessionToken(token));
}

/** Destroys every session of a user (disable, password reset). */
export function destroySessionsForUser(
  db: Database.Database,
  userId: string,
): number {
  return db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId)
    .changes;
}

/**
 * Session-fixation protection: issues a fresh token/id for the same user
 * (carrying over ip/user-agent) and deletes the old row. Used after
 * privilege-relevant changes (forced password reset completion).
 * Login itself always creates a brand-new session, which is the primary
 * fixation defense.
 */
export function rotateSession(
  db: Database.Database,
  token: string,
): CreatedSession | null {
  const current = getSessionByToken(db, token);
  if (!current) return null;
  const fresh = createSession(db, current.session.userId, {
    ip: current.session.ip,
    userAgent: current.session.userAgent,
  });
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(current.session.id);
  return fresh;
}

/** Deletes all expired sessions; returns how many were removed. */
export function sweepExpiredSessions(db: Database.Database): number {
  return db
    .prepare(`DELETE FROM sessions WHERE expires_at <= ?`)
    .run(new Date().toISOString()).changes;
}

const SWEEPER_KEY = Symbol.for("viberr.sessionSweeper");

/** Starts the daily expired-session sweep (idempotent, survives HMR). */
export function startSessionSweeper(db: Database.Database): void {
  const cache = globalThis as unknown as Record<
    symbol,
    ReturnType<typeof setInterval> | undefined
  >;
  if (cache[SWEEPER_KEY]) return;
  const interval = setInterval(
    () => {
      try {
        const swept = sweepExpiredSessions(db);
        if (swept > 0) logger.info("expired sessions swept", { swept });
      } catch (error) {
        logger.error("session sweep failed", {
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    24 * 60 * 60 * 1000,
  );
  interval.unref?.();
  cache[SWEEPER_KEY] = interval;
}
