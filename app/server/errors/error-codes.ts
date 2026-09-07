/**
 * Stable machine-readable error codes. These are part of the app's contract
 * (JSON error bodies, audit records, tests) — never rename existing values,
 * only add new ones.
 */
export const ERROR_CODES = {
  INTERNAL: "internal_error",
  NOT_FOUND: "not_found",
  VALIDATION_FAILED: "validation_failed",
  FORBIDDEN: "forbidden",
  CONFLICT: "conflict",
  DB_MIGRATION_FAILED: "db_migration_failed",
  SECRET_BOX_INVALID: "secret_box_invalid",
  /** A canonical store file parsed only with fallback defaults (hardStop) —
   *  writing to it would replace the human's content. */
  FILE_NOT_TRUSTED: "file_not_trusted",
  /** Ruling 88 (F21-2): an acceptance arrived with NO disclosure acknowledgment
   *  — the caller never confirmed what merges, so it is refused. */
  ACCEPT_DISCLOSURE_MISSING: "accept_disclosure_missing",
  /** Ruling 88 (F21-2): the acknowledgment describes a task state that is no
   *  longer live — the ceremony has to be re-opened against what is true now. */
  ACCEPT_DISCLOSURE_STALE: "accept_disclosure_stale",
  /** V11-4 (pass 32): the SSE subscribe route answers an unauthenticated
   *  caller with this — it used to emit a literal outside this catalog. */
  UNAUTHORIZED: "unauthorized",
  /** Ruling 127: the run's credential principal has no usable account for the
   *  requested backend, so no agent process is started. Distinct from a plain
   *  CONFLICT because the remedy is always "connect the backend", never
   *  "retry" — the run service turns it into the honest `run·unavailable`
   *  error run rather than a thrown 409 at a route. */
  RUN_UNAVAILABLE: "run_unavailable",
  /** G35-4 / ruling 152(c) (pass 35): the dispatch was HELD because the
   *  instance already knows the backend is out of quota for the account the
   *  run would bill. Not a failure and not a decision: the retry is already
   *  on the task's schedule, the timeline says so, and the thrower's
   *  `details` carry the backend, the reopen instant and the schedule id. */
  DISPATCH_HELD: "dispatch_held",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
