/**
 * The vocabulary of a FAILED run, shared by the server (both runtime adapters,
 * the run sink, the packet builders) and the client (the console's `LogLine`
 * and the Agent-logs footer). Client-safe: no server imports.
 *
 * Pass 34 (ruling 155(a)): the classified failure used to live only in the
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
  /** Ruling 159: the run reached the instance's spending cap (Instance settings →
   *  Max spend per Claude run) and the SDK ended it with
   *  `error_max_budget_usd`. Cut off, like `max_turns`, not failed by the task:
   *  the remedy is to continue it or raise the cap. Claude only; Codex has no
   *  budget option. */
  | "max_budget"
  /** The stream produced nothing for the whole idle window — the run was HUNG,
   *  not failed by the task. Both adapters emit it (P13-RT-11). */
  | "idle_timeout"
  /** Ruling 158(b): the gateway stopped the run because it kept sending one tool
   *  call with the same arguments and getting the same answer, a script or
   *  loop that never read the answer. Not the account's fault and not a hang:
   *  the remedy is guidance, so the run's own sentence names the tool and
   *  what it answered. */
  | "tool_loop"
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
  "tool_loop",
  "session_missing",
  "unknown",
] as const satisfies readonly RunFailureKind[];

/**
 * The machine facts an adapter learned about a failure, attached to the
 * terminal `err` line beside its `run·error·<kind>` tag (ruling 155(a)).
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
  /** Ruling 159: for a `max_budget` cut-off, the cap the run carried (USD).
   *  Absent on every other kind, and on lines written before the ruling. */
  spendCapUsd?: number;
  /** Ruling 159: for a `max_budget` cut-off, what the run had spent when the
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
/**
 * Ruling 155: the patterns here are what decides whether a failed run is
 * reported as "this deployment could not reach the provider" or as "review its
 * authentication and runtime configuration" — and the second sentence sends a
 * person to re-issue a credential that was never at fault.
 *
 * The list was written against Node's error codes and Node's prose. The Codex
 * CLI is Rust and says it differently, so a name-resolution failure matched
 * nothing: live on SHOP-10, `failed to lookup address information: Name does
 * not resolve` was classified `unknown` and the packet told the owner to check
 * authentication. Its TLS sibling matched only by accident, through `\btls\b`
 * inside a `close_notify` message.
 */
/**
 * Ruling 155(c) (F39-16): the additions at the end are Codex's own transport
 * vocabulary, which this list did not speak.
 *
 * Live on ax-clone AX-11 the provider said, verbatim, "Reconnecting... waiting
 * for network (Connection failed: error sending request)" — reqwest's standard
 * transport failure, which the Rust CLI surfaces unchanged. The list had
 * "connection error" but not "connection failed", and nothing for "error
 * sending request". So the classifier fell through to `unknown`, and a network
 * blip cost twice: the packet told the owner to "Review its authentication and
 * runtime configuration" one line above the provider's own words saying the
 * network dropped, and it came out as a generic stalled-work packet
 * recommending "Redirect with sharper guidance" instead of the backend-failure
 * packet that offers waiting and retrying.
 */
export const LOCAL_NETWORK_FAILURE_RE =
  /unable to connect|could not connect|connection (?:refused|reset|closed|timed out|error|failed)|econnrefused|econnreset|enotfound|eai_again|etimedout|ehostunreach|enetunreach|epipe|certificate|self.signed|\btls\b|\bssl\b|handshake|fetch failed|network error|socket hang up|getaddrinfo|dns|failed to lookup address information|name does not resolve|nodename nor servname|temporary failure in name resolution|peer closed connection|close_notify|error sending request|waiting for network|request timed out|\breconnecting\b|stream (?:closed|ended) unexpectedly/i;

/**
 * Ruling 155 (F39-24): the lead of the sentence a failed run writes onto the
 * task timeline, and the matcher that finds it again.
 *
 * They live together so they cannot drift. The operator has to be able to spot
 * this event among the several kinds of `blocked` event a task carries, because
 * it is the one that may be standing directly on top of a finished report: the
 * reply is written first and the failure a few milliseconds later, and the
 * failure's own words ("Nothing was delivered to a pull request") are about the
 * PR while a reader takes them to be about the work.
 */
export function runDidNotCompleteLead(role: string, roleLabel: string): string {
  return `The ${role} ${roleLabel} run did not complete`;
}

/** Matches what {@link runDidNotCompleteLead} writes, for any role. */
export const RUN_DID_NOT_COMPLETE_RE = /^The \S[^\n]{0,80}? run did not complete[.:]/;

/**
 * Ruling 155(d) (F39-21): the tag on the line a run carries when its transport
 * died AFTER the agent's turn had already completed.
 *
 * Live on the ax-clone board, twice inside ten minutes, a Codex run emitted a
 * complete outcome envelope, the provider emitted `turn.completed`, and THEN
 * the connection dropped while Viberr ran its own end-of-run compaction. Both
 * adapters gated success on "a completed turn and no fatal error" as a flat
 * conjunction over the whole stream, with no regard for ORDER, so a drop during
 * teardown reclassified a finished run as a failed one. AX-2 lost 1,531 lines
 * of committed Go across seven files and AX-3 lost two commits; each task was
 * parked `waiting: human` under a packet whose RECOMMENDED option was to re-run
 * the agent whose work was already in the tree.
 *
 * A completed turn with nothing in flight behind it is a completed turn. What
 * happens to the socket afterwards is a fact about the socket, and this line is
 * where it is recorded.
 */
export const POST_TURN_TRANSPORT_TAG = "run·transport·after-turn";

/**
 * The line a human reads when {@link POST_TURN_TRANSPORT_TAG} is written: the
 * run's own result stands, and the drop is named rather than hidden.
 */
export function postTurnTransportText(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  const clipped = flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
  return (
    "the connection dropped after the agent's turn had completed, so the run's " +
    "own result stands and this is recorded as transport only" +
    (clipped ? ` · ${clipped}` : "")
  );
}

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
 * Ruling 159: a dollar amount as a run's lines, packets and notes print it.
 * Cents from a dollar up; below a dollar up to four decimals, so a spend just
 * past a small cap does not print as equal to it ("reached its $0.01 cap after
 * spending $0.0106", not "…after spending $0.01"). Never fewer than two.
 */
export function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(4).replace(/0{1,2}$/, "")}`;
}

/**
 * Ruling 116: the lead sentence of the note Viberr writes when an operator plan
 * step did not run, and the matcher that finds it again.
 *
 * Paired here for the same reason {@link RUN_DID_NOT_COMPLETE_RE} is: the
 * writer is in `operator-codex-plan.server.ts` and the reader is in
 * `operator-snapshot.server.ts`, and a silent drift between them turns the
 * carry back into the "read them on the timeline" instruction ruling 121
 * retired.
 */
export const PLAN_NOT_CARRIED_OUT_LEAD = "**The operator's plan was not carried out in full.**";
export const PLAN_NOT_CARRIED_OUT_RE = /^\*\*The operator's plan was not carried out in full\.\*\*/;
