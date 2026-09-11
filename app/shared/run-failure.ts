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
  /** Ruling 175: the run reached the instance's spending cap (Org settings →
   *  Max spend per Claude run) and the SDK ended it with
   *  `error_max_budget_usd`. Cut off, like `max_turns`, not failed by the task:
   *  the remedy is to continue it or raise the cap. Claude only; Codex has no
   *  budget option. */
  | "max_budget"
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
  "max_budget",
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
  /**
   * U35-11 (pass 35): WHERE an `overloaded` failure happened. `"provider"`
   * means the provider answered with its own failure (a 529, a 5xx, its
   * `overloaded` / `server_error` banner). `"local"` means the request never
   * got an answer: the connection failed inside Viberr's own environment
   * (a TLS verification error, DNS, a refused or reset socket, a proxy) and
   * the CLI reported it under the same `server_error` banner. Live, nine runs
   * that died on `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` were narrated as
   * "the provider failed on its own side" while the container's own fetch was
   * the thing failing. The retry advice is the same either way; the
   * attribution is not. Null for every other kind (nothing to attribute).
   */
  origin: "provider" | "local" | null;
  /** Ruling 175: for a `max_budget` cut-off, the cap the run carried (USD).
   *  Absent on every other kind, and on lines written before the ruling. */
  spendCapUsd?: number;
  /** Ruling 175: for a `max_budget` cut-off, what the run had spent when the
   *  SDK stopped it (USD, the result's cost). Absent otherwise. */
  spentUsd?: number;
}

/**
 * U35-11: the signatures of a connection that failed BEFORE the provider
 * answered, in Viberr's own environment. Both adapters read these off the
 * raw failure text; a run the provider answered with an HTTP status (5xx) is
 * never local, whatever its prose says. Client-safe (a regex), shared so the
 * two classifiers cannot drift.
 */
export const LOCAL_NETWORK_FAILURE_RE =
  /unable to connect|could not connect|connection (?:refused|reset|closed|timed out|error)|econnrefused|econnreset|enotfound|eai_again|etimedout|ehostunreach|enetunreach|epipe|certificate|self.signed|\btls\b|\bssl\b|handshake|fetch failed|network error|socket hang up|getaddrinfo|dns/i;

/** The machine code such a failure carries, when it names one
 *  (`UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`, `ECONNRESET`, `ERR_TLS_...`),
 *  for the sentence a human reads. Null when the text names none. */
export function localNetworkFailureCode(text: string): string | null {
  const match =
    /\b(UNKNOWN_[A-Z_]+|[A-Z_]*CERT(?:IFICATE)?[A-Z_]*|SELF_SIGNED[A-Z_]*|DEPTH_ZERO[A-Z_]*|UNABLE_TO_[A-Z_]+|ERR_TLS[A-Z_]*|ERR_SSL[A-Z_]*|E(?:CONN(?:REFUSED|RESET|ABORTED)|NOTFOUND|AI_AGAIN|TIMEDOUT|PIPE|HOSTUNREACH|NETUNREACH))\b/.exec(
      text,
    );
  return match ? match[1]! : null;
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
    origin: null,
  };
}

/**
 * Ruling 175: a dollar amount as a run's lines, packets and notes print it.
 * Cents from a dollar up; below a dollar up to four decimals, so a spend just
 * past a small cap does not print as equal to it ("reached its $0.01 cap after
 * spending $0.0106", not "…after spending $0.01"). Never fewer than two.
 */
export function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4).replace(/0{1,2}$/, "")}`;
}
