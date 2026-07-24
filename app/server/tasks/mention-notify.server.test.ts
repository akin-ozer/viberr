import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { notifyMentionedUsers } from "./mention-notify.server";
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
