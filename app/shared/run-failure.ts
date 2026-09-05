/**
 * The vocabulary of a FAILED run, shared by the server (both runtime adapters,
 * the run sink, the packet builders) and the client (the console's `LogLine`
 * and the Agent-logs footer). Client-safe: no server imports.
 *
 * Pass 34 (ruling 130(a)): the classified failure used to live only in the
 * `·<kind>` suffix of an adapter's `err` tag, and every reader that wanted
 * more than the kind (the reset instant, the API status) ran its own regex
 * over the raw stream and disagreed with the last one. The adapter now
 * attaches a typed {@link RunFailureFacts} record to the terminal line, and
 * every reader consumes THAT.
 */

/** Classified failure classes for an errored run (F8 + R7-2 fail-fast). */
export type RunFailureKind =
  | "quota"
  | "auth"
  | "unavailable"
  /** The PROVIDER could not serve the run: overloaded (HTTP 529, the API's
   *  `overloaded` error) or failing on its own side (5xx, `server_error`).
   *  Neither the account nor the task is at fault, so it is neither `quota`
   *  (whose remedy is the account's window or a different account) nor
   *  `unavailable` (no credential principal to spawn with): the honest remedy
   *  is a retry, on the same backend once the provider recovers or on the
   *  other one now. The Claude Agent SDK ≥ 0.3.223 ends a run it gave up on
   *  after repeated 529s with `api_error_status: 529`, so this class is read
   *  from that fact first and from prose ("overloaded", "503") second. */
  | "overloaded"
  | "max_turns"
  /** The stream produced nothing for the whole idle window — the run was HUNG,
   *  not failed by the task. Both adapters emit it (P13-RT-11). */
  | "idle_timeout"
  /** P13-D-2 (FR22 / NFR17): the provider session this run tried to resume no
   *  longer exists — Claude Code's ~30-day transcript retention, or a wiped
   *  `$CODEX_HOME/sessions`. Its own class because it is neither a credential
   *  problem nor a task failure: the honest recovery is a fresh run
   *  re-anchored on task.md, which `resumeRun` performs automatically when its
   *  pre-flight probe catches it. This class is what survives when the SDK
   *  reports the vanished session first. */
  | "session_missing"
  | "unknown";

/** The classes an adapter can tag on its own `err` line (`error·quota`), and
 *  the single list the tag is matched against. */
export const TAGGED_FAILURE_KINDS = [
  "quota",
  "auth",
  "unavailable",
  "overloaded",
  "max_turns",
  "idle_timeout",
  "session_missing",
  "unknown",
] as const satisfies readonly RunFailureKind[];

/**
 * The machine facts an adapter learned about a failure, attached to the
 * terminal `err` line beside its `run·error·<kind>` tag (ruling 130(a)).
 *
 * `resetsAt` / `window` are carried ONLY for a rate-limit reading whose
 * `status` was `rejected` (`windowRejected: true`): a transient 429 that the
 * SDK retried through, or an `allowed` reading that merely reported
 * utilization, names no window and no instant — otherwise the quota store
 * would record an exhaustion the provider never declared.
 */
export interface RunFailureFacts {
  kind: RunFailureKind;
  /** ISO instant the spent window reopens; null unless `windowRejected`. */
  resetsAt: string | null;
  /** The window that was spent (`five_hour`, `seven_day`, …); null unless
   *  `windowRejected`. */
  window: string | null;
  /** A `rate_limit_event` with `status: "rejected"` preceded the failure. */
  windowRejected: boolean;
  /** The assistant envelope's `error` code (`oauth_org_not_allowed`,
   *  `authentication_failed`, `rate_limit`, `billing_error`, …), when the SDK
   *  sent one. */
  apiError: string | null;
  /** The result envelope's `api_error_status` (403, 429, …). */
  apiErrorStatus: number | null;
  /** The result envelope's `terminal_reason` (`api_error`, …). */
  terminalReason: string | null;
}

/** Every fact unknown — what a thrown stream error with no envelope evidence
 *  yields, so the prose classifier still has a record to fill `kind` into. */
export function emptyRunFailureFacts(kind: RunFailureKind): RunFailureFacts {
  return {
    kind,
    resetsAt: null,
    window: null,
    windowRejected: false,
    apiError: null,
    apiErrorStatus: null,
    terminalReason: null,
  };
}
