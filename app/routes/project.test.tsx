// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PROJECT_ROLES, roleCan } from "~/shared/rbac";
import { ArchivedBanner } from "./project";

/**
 * Pass-19 UX coherence audit, finding #15 (navigation & wayfinding).
 *
 * The workspace's archived banner is the one place the product tells a reader
 * how to un-archive a project. It named an exact destination — "Settings →
 * Danger zone" — to EVERYONE, but the Q-V1 owner ruling (pass 18) renders that
 * panel only for a reader holding `edit-policy`. A maintainer, contributor or
 * viewer therefore walked a named path to a panel that is not on their Settings
 * page, and no surface anywhere named who could restore it: the Danger zone's
 * own "ask a project admin" note sits INSIDE the panel the same grant hides, so
 * it can never render.
 *
 * The banner is now bound to that same grant — the route is named only to the
 * reader who has it, and everyone else is told the authority instead.
 */

afterEach(cleanup);

describe("the archived banner speaks to the reader's authority", () => {
  it("names Settings → Danger zone only to a reader who can actually see it", () => {
    for (const role of PROJECT_ROLES) {
      const canRestore = roleCan(role, "edit-policy");
      const { container } = render(<ArchivedBanner canRestore={canRestore} />);
      const text = container.textContent ?? "";
      // Every reader still learns the state itself.
      expect(text).toContain("archived");
      if (canRestore) {
        expect(text).toContain("Settings → Danger zone");
      } else {
        // The defect: a route the Q-V1 gate keeps off this reader's page.
        expect(text).not.toContain("Danger zone");
        // …replaced by the thing they can act on — who to ask.
        expect(text).toContain("project admin");
      }
      cleanup();
    }
  });

  it("keeps the banner a live-region status for both readers", () => {
    for (const canRestore of [true, false]) {
      const { container } = render(<ArchivedBanner canRestore={canRestore} />);
      expect(
        container.querySelector(".archived-banner")?.getAttribute("role"),
      ).toBe("status");
      cleanup();
    }
  });
});
