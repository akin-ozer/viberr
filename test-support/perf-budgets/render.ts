import type { PerfBudgetTable } from "../perf-verdict";

/** Ruling 454 ratchet ceilings: client render work and CSS (board cards, icons, hydration). */
export const RENDER_BUDGETS: PerfBudgetTable = {
  // TASK-8 / LIVE-6 / BOARD-4 / CTL-5: 12 before the per-glyph {__html} cache
  // (every re-render re-parsed every icon's SVG markup).
  "render:icon.dom-writes-per-rerender": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture:
      "jsdom: twelve <Icon>s under a parent that re-renders with nothing changed; MutationObserver records on the <svg>s",
  },
};
