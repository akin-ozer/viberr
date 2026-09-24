import type { PerfBudgetTable } from "../perf-verdict";

/** The `revalidation.perf.test.tsx` fixture. */
const TAB =
  "jsdom: test-support/revalidation-harness.tsx (React Router with single fetch's revalidation choice, the real broker in-process, root > routes/project > board | task, every loader counting a fresh object), streams connected and the first load settled";

/** Ruling 454 ratchet ceilings: loaders re-run per navigation, action and live event. */
export const REVALIDATION_BUDGETS: PerfBudgetTable = {
  // BOARD-1 / RF-3: 15 (root, layout and board on every keystroke); no loader
  // reads the filter, and each declares the search params it does read.
  "revalidation:board.loader-runs-per-5-keystrokes": {
    ceiling: 0,
    unit: "count",
    journey: "board-live",
    fixture: `${TAB}; the board, five keystrokes into its filter (replace navigations of ?q=)`,
  },
  // RF-5 / CS-2: 6 (root, layout and task after the action, and again 300 ms
  // later for the task.updated the action itself published); now layout and
  // task once: root reads neither, and the echo arrived before the action's
  // own revalidation was sent.
  "revalidation:task.loader-runs-per-own-comment": {
    ceiling: 2,
    unit: "count",
    journey: "compose-send",
    fixture: `${TAB}; the task page, one comment whose action publishes task.updated before it answers; loader runs after the click and 1 s`,
  },
  // RF-5 / BOARD-7: 6; now layout and board once.
  "revalidation:board.loader-runs-per-own-drop": {
    ceiling: 2,
    unit: "count",
    journey: "board-live",
    fixture: `${TAB}; the board, one drop whose action publishes task.updated before it answers; loader runs after the drop and 1 s`,
  },
  // RF-5: 6 (a badge change re-ran the whole task page twice); now the layout,
  // which draws the bell's counts, once.
  "revalidation:task.loader-runs-per-bell-mark-read": {
    ceiling: 1,
    unit: "count",
    journey: "compose-send",
    fixture: `${TAB}; the task page, the bell's /notifications/read whose action publishes notification.read; loader runs after it and 1 s`,
  },
  // RF-1: 6 (the navigation re-ran root, layout and task, then the re-scoped
  // stream's reconnect pulled all three again); now the task, once: the
  // layout's slug did not change, and the reopen replays instead of pulling.
  "revalidation:task-open.loader-runs": {
    ceiling: 1,
    unit: "count",
    journey: "task-open",
    fixture: `${TAB}; board -> task navigation, the re-scoped stream connected, 1 s`,
  },
  // RF-4 / LIVE-8: 3 (root, layout and task); now the task: the shell draws
  // no run state.
  "revalidation:task.loader-runs-per-own-run-state": {
    ceiling: 1,
    unit: "count",
    journey: "live-run",
    fixture: `${TAB}; the task page, one run.state-changed of that task, 1 s`,
  },
  // RF-4: 3; now the task, which renders instance facts another task's run
  // can change (model availability, the owner's backend health).
  "revalidation:task.loader-runs-per-other-run-state": {
    ceiling: 1,
    unit: "count",
    journey: "live-run",
    fixture: `${TAB}; the task page, one run.state-changed of another task in the project, 1 s`,
  },
  // RF-7: 10 (root's theme and csrf re-ran on every live event).
  "revalidation:root.loader-runs-per-10-live-events": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture: `${TAB}; the task page, ten task.updated of another task a second apart; root loader runs`,
  },
  // RF-6: 9 (the F22 net re-ran root, layout and task every 20 s); 6 once
  // root sat a `revalidate()` out; it arms only while the stream is down.
  "revalidation:task.loader-runs-per-60s-healthy-stream": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture: `${TAB}; the task page showing an active run (the F22 safety net armed), 60 s with no event`,
  },
  // RF-1 / ruling 301: 3 (a returning tab pulled every loader whether or not
  // anything happened while it was away); the broker replays what it missed.
  "revalidation:task.loader-runs-per-quiet-return": {
    ceiling: 0,
    unit: "count",
    journey: "live-run",
    fixture: `${TAB}; the task page hidden then shown again with nothing published meanwhile, the new stream connected, 1 s`,
  },
};
