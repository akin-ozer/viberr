import type { PerfBudgetTable } from "../perf-verdict";

/** Ruling 11 ratchet ceilings: controller dock and page. */
export const CONTROLLER_BUDGETS: PerfBudgetTable = {
  // FL-1 / CTL-1: root mounts the dock on every page, and the dock imported the
  // controller page (runs panels, run console, NumberFlow, thinking-orbs) and
  // the markdown pipeline for a panel that starts closed (48). The note moved
  // to not-connected.tsx and the open panel's body loads on demand.
  // Raised 18 -> 19 by ruling 11 (RF-1/RF-5): the dock's live hook records
  // into the tab's revalidation ledger (`live-updates/revalidation-policy.ts`),
  // a module root imports itself, so no byte is added to the first download.
  // Raised 19 -> 22 on merging main: ruling 285's pull-to-dismiss sheet
  // lives in the dock's frame, which root ships, and brings
  // ui/use-sheet-drag.ts, ui/spring.ts and ui/live-pose.ts with it. The
  // panel's body, the markdown and the console stay lazy.
  // Lowered 22 -> 21 by ruling 285's deferred dock half (2026-09-24): the
  // dock's entrance is a transition a close retargets, so it no longer pins
  // its live pose and ui/live-pose.ts left its closure (dialogs keep it).
  // Held at 21 through ruling 272 (2026-09-26): the task schema is in this
  // closure (sse-event.schema takes its READINESS_VALUES), so whatever it
  // imports is too. The epic id it validates brought the epic file schema and
  // the stage presets (23); it now takes that and the `blockedBy` spelling
  // from shared/task-refs.ts, a leaf that also took shared/dependencies.ts's
  // place.
  "controller:closed-dock.static-modules": {
    ceiling: 21,
    unit: "count",
    journey: "fresh-load",
    fixture:
      "app/features/controller/controller-dock.tsx: client modules plus npm packages reached through static imports (`import type` statements, import() and server modules excluded), walked from source by test-support/static-imports.ts",
  },
  // RF-8: the root-owned unseen fetcher reloaded on every pathname change (1).
  // Navigation changes nothing it shows; the dock reloads it on its own moments.
  "controller:closed-dock.requests-per-navigation": {
    ceiling: 0,
    unit: "count",
    journey: "controller",
    fixture:
      "test-support/controller-dock-stub.tsx on /projects/viberr/board, dock never opened: dock requests (view + unseen) per client navigation, board -> task -> board",
  },
  // RF-8 + CTL-3: every revalidation re-ran the unseen fetcher and, once the
  // dock had been opened, the view fetcher with its last `seen=1` URL (2).
  // Both resource routes now answer shouldRevalidate false.
  "controller:closed-dock.requests-per-revalidation": {
    ceiling: 0,
    unit: "count",
    journey: "controller",
    fixture:
      "controller-dock-stub on the board, a 30-message board thread; open, close, then 3 page revalidations: dock requests per revalidation",
  },
  // CTL-4 (a): the post-action revalidation, the selection effect and an
  // explicit load each loaded the same thread (3); now the one load.
  "controller:dock-send.view-loads": {
    ceiling: 1,
    unit: "count",
    journey: "compose-send",
    fixture:
      "controller-dock-stub on the board, open on a 30-message thread, one Send that lands in the same thread: dock view loads after the click",
  },
  // CTL-4 (a): the send revalidated the page under the dock (3);
  // defaultShouldRevalidate false.
  "controller:dock-send.page-loader-runs": {
    ceiling: 0,
    unit: "count",
    journey: "compose-send",
    fixture:
      "same send: page loader runs (root, routes/project, routes/project.board) after the click",
  },
  // CTL-4 (b): every controller.updated revalidated every page the asker had
  // open (3); off the controller pages it now goes to the dock alone.
  "controller:controller-event.page-loader-runs": {
    ceiling: 0,
    unit: "count",
    journey: "controller",
    fixture:
      "controller-dock-stub on the board holding the user stream (stubbed EventSource), dock closed: page loader runs after one controller.updated and the 300 ms debounce",
  },
  // CTL-2: the working poll re-fetched the whole transcript every 5 s to move
  // one step line and keep the button's dot honest (1); it now reads the
  // dock's small status and reloads the view only when the turn flips.
  "controller:working-poll.view-loads-per-tick": {
    ceiling: 0,
    unit: "count",
    journey: "controller",
    fixture:
      "controller-dock-stub on the board, a 30-message thread whose turn is working; open, close, then 3 x 5 s on a fake clock: dock view loads per tick",
  },
  // CTL-2: what the dock's 5 s working poll fetches. On this fixture the view
  // it used to reload was 35,821 bytes; the status is the unseen list and the
  // live turns.
  "controller:working-poll.bytes-per-tick": {
    ceiling: 1092,
    unit: "bytes",
    journey: "controller",
    fixture:
      "setupAppTest + demo seed, arda on viberr-core: a 30-message board thread (15 x 400-char asks, 15 x 1,495-char replies) with a turn kept running, plus 5 board threads with an unseen reply: JSON bytes of GET DOCK_STATUS_URL",
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
