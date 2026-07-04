import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  createSession,
  destroySessionByToken,
  destroySessionsForUser,
  getSessionByToken,
  hashSessionToken,
  rotateSession,
  SESSION_RENEW_INTERVAL_MS,
  SESSION_TTL_MS,
  sweepExpiredSessions,
} from "./session.server";
import { insertUser } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function makeDbWithUser() {
  const db = ctx.makeDb();
  const user = insertUser(db, {
    id: "u_test",
    email: "t@viberr.test",
    name: "Test",
    role: "member",
  });
  return { db, user };
}

describe("sessions", () => {
  it("creates a session storing only the sha256 hash of the token", () => {
    const { db, user } = makeDbWithUser();
    const created = createSession(db, user.id, { ip: "1.2.3.4", userAgent: "vitest" });

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    const row = db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(hashSessionToken(created.token)) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.id).not.toBe(created.token); // raw token never stored
    expect(row.ip).toBe("1.2.3.4");
    // No column contains the raw token.
    expect(Object.values(row)).not.toContain(created.token);
  });

  it("reads a valid session back", () => {
    const { db, user } = makeDbWithUser();
    const created = createSession(db, user.id);
    const found = getSessionByToken(db, created.token);
    expect(found?.session.userId).toBe(user.id);
    expect(found?.renewed).toBe(false); // fresh session — no renewal yet
  });

  it("returns null for unknown tokens", () => {
    const { db } = makeDbWithUser();
    expect(getSessionByToken(db, "no-such-token")).toBeNull();
  });

  it("deletes and rejects expired sessions", () => {
    const { db, user } = makeDbWithUser();
    const created = createSession(db, user.id);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      created.id,
    );
    expect(getSessionByToken(db, created.token)).toBeNull();
    const count = db.prepare(`SELECT count(*) AS c FROM sessions`).get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });

  it("slides the rolling expiry once past the renewal interval", () => {
    const { db, user } = makeDbWithUser();
    const created = createSession(db, user.id);
    // Simulate a session that was last renewed > 1 day ago.
    const staleExpiry = new Date(
      Date.now() + SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS - 60_000,
    ).toISOString();
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(
      staleExpiry,
      created.id,
    );
    const found = getSessionByToken(db, created.token);
    expect(found?.renewed).toBe(true);
    expect(Date.parse(found!.session.expiresAt)).toBeGreaterThan(
      Date.parse(staleExpiry),
    );
  });

  it("rotates: fresh token + id, old token dead, meta carried over", () => {
    const { db, user } = makeDbWithUser();
    const first = createSession(db, user.id, { ip: "9.9.9.9", userAgent: "ua" });
    const rotated = rotateSession(db, first.token);
    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(first.token);
    expect(rotated!.id).not.toBe(first.id);
    expect(getSessionByToken(db, first.token)).toBeNull();
    const found = getSessionByToken(db, rotated!.token);
    expect(found?.session.ip).toBe("9.9.9.9");
    expect(found?.session.userId).toBe(user.id);
  });

  it("destroys by token and by user", () => {
    const { db, user } = makeDbWithUser();
    const a = createSession(db, user.id);
    const b = createSession(db, user.id);
    destroySessionByToken(db, a.token);
    expect(getSessionByToken(db, a.token)).toBeNull();
    expect(getSessionByToken(db, b.token)).not.toBeNull();
    expect(destroySessionsForUser(db, user.id)).toBe(1);
    expect(getSessionByToken(db, b.token)).toBeNull();
  });

  it("sweeps only expired sessions", () => {
    const { db, user } = makeDbWithUser();
    const live = createSession(db, user.id);
    const dead = createSession(db, user.id);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 1000).toISOString(),
      dead.id,
    );
    expect(sweepExpiredSessions(db)).toBe(1);
    expect(getSessionByToken(db, live.token)).not.toBeNull();
  });
});
