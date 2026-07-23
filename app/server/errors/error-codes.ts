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
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
