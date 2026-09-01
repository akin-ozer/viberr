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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
