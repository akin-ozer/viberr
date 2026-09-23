import type { DatabaseSync } from "node:sqlite";
import { TAGGED_FAILURE_KINDS, type RunFailureKind } from "~/shared/run-failure";
import type { LogLine, RunState } from "~/features/runtime/runtime-types";
import { listRunLinesTail, profileRunsSince } from "./run-store.server";

/**
 * How a run ENDED, as far as the question "was it the run's own work that
 * failed, or did the provider never serve it?" goes.
 *
 * Extracted from the run projection (ruling 416) so the review-round counter
 * reads the SAME classification the run card prints, rather than a second
 * reading of the same lines that could drift from it.
 */

/**
 * Signatures that mean "the BACKEND wasn't available" (quota, rate limit,
 * overload, auth/credit) rather than "the task genuinely failed". Matched
 * case-insensitively against an errored run's raw log tail so the UI can offer
 * a retry on the other backend (D4) instead of surfacing a dead end.
 */
const BACKEND_UNAVAILABLE_SIGNATURES = [
  "usage limit",
  "rate limit",
  "quota",
  "insufficient_quota",
  "overloaded",
  "capacity",
  "temporarily unavailable",
  "service unavailable",
  "credit balance",
  "billing",
  "429",
];

function isBackendUnavailableError(raw: readonly string[]): boolean {
  // Only scan the tail — the failure is at the end of the stream.
  const tail = raw.slice(-12).join("\n").toLowerCase();
  return BACKEND_UNAVAILABLE_SIGNATURES.some((s) => tail.includes(s));
}

export interface RunEnd {
  /** The classified failure, for an errored run that carries one. */
  failureKind: RunFailureKind | undefined;
  /** U35-11: where an overload came from, when the adapter said. */
  failureOrigin: "provider" | "local" | undefined;
  /** The provider could not or would not serve the run: quota, auth, no
   *  credential, or its own overload. The task's work is not what failed. */
  failedBackendUnavailable: boolean;
}

/**
 * Classify a run's end from its console lines and raw envelopes.
 *
 * A run can end in `error` because its BACKEND was unavailable / quota-limited
 * rather than because the task genuinely failed. The R7-2 fail-fast path emits
 * a STRUCTURED `run·unavailable` err tag (its prose does not match the
 * quota/rate-limit signatures), so the tag is trusted directly, and the prose
 * scan is the fallback for real backend errors that carry no tag.
 *
 * Ruling 130(a): the CLASSIFIED terminal line is consulted first, for every run
 * kind; the raw scan stays as the fallback for lines written before the class
 * existed. And it is a real FALLBACK: as an `||` arm the prose scan also fired
 * for runs that WERE classified, as something else, so a hung or turn-capped
 * run whose log tail merely mentioned "rate limit", "429" or "quota" was
 * reported as a backend-availability failure. When the run carries a
 * classification, that classification decides.
 */
export function classifyRunEnd(
  state: RunState,
  lines: readonly LogLine[],
  raw: readonly string[],
): RunEnd {
  const terminal = [...lines]
    .reverse()
    .find((l) => l.ev === "err" && (l.failure || (l.tag ?? "").startsWith("run·")));
  const failureKind: RunFailureKind | undefined =
    state !== "error"
      ? undefined
      : (terminal?.failure?.kind ??
        TAGGED_FAILURE_KINDS.find((k) => (terminal?.tag ?? "").endsWith(`·${k}`)));
  const failureOrigin: "provider" | "local" | undefined =
    failureKind === "overloaded" && terminal?.failure?.origin
      ? terminal.failure.origin
      : undefined;
  const classifiedUnavailable =
    failureKind === "quota" ||
    failureKind === "auth" ||
    failureKind === "unavailable" ||
    // The provider's own overload/5xx: the backend was not available for this
    // run, so the retry-on-the-other-backend offer applies exactly as the raw
    // "overloaded" signature below has always made it.
    failureKind === "overloaded";
  const taggedUnavailable = lines.some((l) => l.ev === "err" && l.tag === "run·unavailable");
  const classified = failureKind !== undefined || taggedUnavailable;
  const failedBackendUnavailable =
    state === "error" &&
    (classified ? classifiedUnavailable || taggedUnavailable : isBackendUnavailableError(raw));
  return { failureKind, failureOrigin, failedBackendUnavailable };
}

/** How many of a run's newest lines settle how it ended. The terminal err line
 *  is last, and the prose fallback reads only the last twelve envelopes. */
const RUN_END_TAIL = 40;

/**
 * Ruling 416 (F39-42): did the task's deliverer fight a ROUND of rework since
 * `since`?
 *
 * Ruling 242 (owner) counts a round by the deliverer having RUN since the
 * reviewer's previous verdict, whatever the run's state, "because a rework
 * dispatched that crashed is still a round fought". A run the PROVIDER refused
 * fought nothing. Live on ax-clone AX-19 the rework was refused for quota three
 * minutes in, with no commit and no report; that refusal counted, so the
 * reviewer's next verdict on the same untouched code read "6 times running"
 * and raised a packet that told a person to ask the reviewer a question it had
 * just answered. The owner's call (2026-09-23): a provider refusal does not
 * count; a crash mid-work still does.
 */
export function deliveredRoundSince(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  profileId: string,
  since: string,
): boolean {
  for (const run of profileRunsSince(db, projectSlug, taskKey, profileId, since)) {
    if (run.state !== "error") return true;
    const tail = listRunLinesTail(db, run.id, RUN_END_TAIL);
    const end = classifyRunEnd(
      run.state,
      tail.map((l) => l.display),
      tail.map((l) => l.raw),
    );
    if (!end.failedBackendUnavailable) return true;
  }
  return false;
}
