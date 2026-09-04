import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "~/shared/mapping/notification.server";
import {
  DEFAULT_NOTIF_PREFS,
  NOTIF_PREF_CATEGORIES,
  PROFILE_NTF,
  mergeNotifPrefs,
  notifCategoryForKind,
} from "./notification-prefs";

/**
 * Rulings 131 and 140 (pass 34): the two new notification kinds route through
 * their own categories, with their own toggles, defaulting ON like every other.
 *
 * Canary: map `dependency` to `controller` (or `ownership` to `packets`) in
 * `KIND_TO_CATEGORY` and the routing case fails.
 */
describe("notification routing — the pass-34 kinds", () => {
  it("routes dependency → dependencies and ownership → ownership", () => {
    expect(notifCategoryForKind("dependency")).toBe("dependencies");
    expect(notifCategoryForKind("ownership")).toBe("ownership");
  });

  it("every kind routes to a category that has a profile row and a default", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const category = notifCategoryForKind(kind);
      expect(NOTIF_PREF_CATEGORIES).toContain(category);
      expect(PROFILE_NTF.map((row) => row.id)).toContain(category);
      expect(DEFAULT_NOTIF_PREFS[category]).toEqual({ app: true });
    }
  });

  it("a stored pref written before the categories existed reads them as ON", () => {
    const merged = mergeNotifPrefs({
      packets: { app: false },
      approvals: { app: true },
      mentions: { app: true },
      policy: { app: true },
      quality: { app: true },
      controller: { app: true },
    });
    expect(merged.packets).toEqual({ app: false });
    expect(merged.dependencies).toEqual({ app: true });
    expect(merged.ownership).toEqual({ app: true });
    // …and a silenced new category is honoured once stored.
    expect(mergeNotifPrefs({ ...merged, ownership: { app: false } }).ownership).toEqual({
      app: false,
    });
  });
});
