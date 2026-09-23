import type { PerfBudgetTable } from "../perf-verdict";

/** Ruling 454 ratchet ceilings: controller dock and page. */
export const CONTROLLER_BUDGETS: PerfBudgetTable = {
  // FL-1 / CTL-1: root mounts the dock on every page, and the dock imported the
  // controller page (runs panels, run console, NumberFlow, thinking-orbs) and
  // the markdown pipeline for a panel that starts closed (48). The note moved
  // to not-connected.tsx and the open panel's body loads on demand.
  "controller:closed-dock.static-modules": {
    ceiling: 18,
    unit: "count",
    journey: "fresh-load",
    fixture:
      "app/features/controller/controller-dock.tsx: app modules plus npm packages reached through static, value-carrying imports (type-only imports and import() excluded), walked from source",
  },
  // CTL-7: one conversation-wide taskLinks map; a new key re-parsed every
  // message (31). The memo now compares only the keys a text names.
  "controller:markdown.reparses-per-new-key": {
    ceiling: 1,
    unit: "count",
    journey: "controller",
    fixture:
      "30-message transcript (15 x 400-char asks, 15 x 1,500-char replies) naming six keys, then a reply naming a new key VIB-7: Markdown elements whose memo comparator lets them re-render, plus the reply",
  },
};
