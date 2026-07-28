import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { insertUser } from "~/server/auth/user-store.server";
import {
  ambiguousMentionNote,
  fanOutMentions,
  notifyMentionedUsers,
  resolveMentionTargets,
} from "./mention-notify.server";
import type { ActorRender } from "~/shared/mapping/actor.server";

/**
 * NEW-4: the shared @mention → `mention`-notification fan-out. Every comment
 * writer (human appendComment AND the agent/operator writers) funnels through
 * this helper, so the matching rules asserted here are THE routing contract.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const OPERATOR_FROM: ActorRender = { kind: "agent", name: "Operator" };

function notificationRows(store: TestStore) {
  return store.db
    .prepare(`SELECT user_id, kind, text, actor_json FROM notifications ORDER BY user_id`)
    .all() as { user_id: string; kind: string; text: string; actor_json: string | null }[];
}

describe("notifyMentionedUsers", () => {
  it("matches by first name and email local-part, case-insensitively, with the agent as `from`", () => {
    const store = setupTestStore(ctx);
    const selinLocal = store.users.selin.email.split("@")[0]!; // e.g. selin7
    const matched = notifyMentionedUsers(store.db, {
      text: `@ARDA the review is clean; @${selinLocal} please take acceptance.`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(new Set(matched)).toEqual(
      new Set([store.users.arda.id, store.users.selin.id]),
    );
    const rows = notificationRows(store);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe("mention");
      expect(JSON.parse(row.actor_json!)).toEqual(OPERATOR_FROM);
    }
  });

  it("a multi-word display-name mention (@Arda Test) matches via its first token", () => {
    const store = setupTestStore(ctx);
    const matched = notifyMentionedUsers(store.db, {
      text: `@${store.users.arda.name} the file listing landed — over to you.`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(matched).toEqual([store.users.arda.id]);
  });

  it("reserved agent handles never notify a person; no handles → no rows", () => {
    const store = setupTestStore(ctx);
    expect(
      notifyMentionedUsers(store.db, {
        text: "@operator @agent @claude @codex all reserved",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([]);
    expect(
      notifyMentionedUsers(store.db, {
        text: "no mentions here at all",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([]);
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("never notifies the excluded author, and skips disabled users", () => {
    const store = setupTestStore(ctx);
    store.db
      .prepare(`UPDATE users SET disabled = 1 WHERE id = ?`)
      .run(store.users.selin.id);
    const matched = notifyMentionedUsers(store.db, {
      text: "@arda @selin ping",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
      excludeUserId: store.users.arda.id,
    });
    expect(matched).toEqual([]);
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("clips a long agent report in the notification text (the timeline keeps the rest)", () => {
    const store = setupTestStore(ctx);
    const report = `@arda done. ${"evidence ".repeat(80)}`;
    notifyMentionedUsers(store.db, {
      text: report,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    const [row] = notificationRows(store);
    expect(row!.text.length).toBeLessThan(300);
    expect(row!.text).toContain("mentioned you");
    expect(row!.text).toContain("…");
  });
});

/**
 * B-FD2: a mention addresses ONE person. On a team with two Ardas the flat
 * first-name OR notified both, and neither could tell who was meant.
 */
describe("mention disambiguation (B-FD2)", () => {
  /** A second Arda: same first name, distinct local-part and full name. */
  function addSecondArda(store: TestStore) {
    return insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
  }

  it("an ambiguous FIRST-NAME mention notifies nobody and is reported back", () => {
    const store = setupTestStore(ctx);
    addSecondArda(store);
    const result = fanOutMentions(store.db, {
      text: "@arda can you take acceptance?",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(result.mentioned).toEqual([]);
    expect(result.ambiguous).toEqual(["arda"]);
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("the full display name and its dashed form each route to exactly one Arda", () => {
    const store = setupTestStore(ctx);
    const second = addSecondArda(store);
    expect(
      notifyMentionedUsers(store.db, {
        text: `@${store.users.arda.name} please look`,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([store.users.arda.id]);
    expect(
      notifyMentionedUsers(store.db, {
        text: "@arda-yilmaz please look",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([second.id]);
  });

  it("an exact email local-part outranks another user's first name", () => {
    const store = setupTestStore(ctx);
    // A user whose local-part IS someone else's first name: the handle belongs
    // to its owner, not to the person who happens to be called that.
    const impostor = insertUser(store.db, {
      id: "u_localpart_owner",
      email: "murat@viberr.test",
      name: "Deniz Kara",
      role: "member",
    });
    const matched = notifyMentionedUsers(store.db, {
      text: "@murat over to you",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(matched).toEqual([impostor.id]);
  });

  it("one person tagged twice in a comment gets ONE notification", () => {
    const store = setupTestStore(ctx);
    const local = store.users.selin.email.split("@")[0]!;
    const matched = notifyMentionedUsers(store.db, {
      text: `@${local} and @${store.users.selin.name} — same person, one ping.`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(matched).toEqual([store.users.selin.id]);
    expect(notificationRows(store)).toHaveLength(1);
  });

  it("ambiguity is judged before the author exclusion", () => {
    const store = setupTestStore(ctx);
    addSecondArda(store);
    // One Arda writing "@arda" must NOT be silently redirected to the other.
    const result = fanOutMentions(store.db, {
      text: "@arda take it from here",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
      excludeUserId: store.users.arda.id,
    });
    expect(result.mentioned).toEqual([]);
    expect(result.ambiguous).toEqual(["arda"]);
  });

  it("resolveMentionTargets is pure and keeps users-table order", () => {
    const users = [
      { id: "u1", email: "arda.kaya@x.test", name: "Arda Kaya" },
      { id: "u2", email: "selin@x.test", name: "Selin Ay" },
      { id: "u3", email: "arda.yilmaz@x.test", name: "Arda Yilmaz" },
    ];
    expect(resolveMentionTargets(users, "@selin @arda-kaya ship it")).toEqual({
      userIds: ["u1", "u2"],
      ambiguous: [],
    });
    expect(resolveMentionTargets(users, "@arda ship it")).toEqual({
      userIds: [],
      ambiguous: ["arda"],
    });
  });

  it("the non-delivery note names the handle and both unambiguous forms", () => {
    expect(ambiguousMentionNote([])).toBe("");
    const note = ambiguousMentionNote(["arda"]);
    expect(note).toContain("@arda");
    expect(note).toContain("nobody was notified");
    expect(note).toContain("email handle");
  });
});
