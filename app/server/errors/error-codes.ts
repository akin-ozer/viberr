/**
 * Stable machine-readable error codes. These are part of the app's contract
 * (JSON error bodies, audit records, tests) — never rename existing values,
 * only add new ones.
 */
export const ERROR_CODES = {
  INTERNAL: "internal_error",
  NOT_FOUND: "not_found",
  VALIDATION_FAILED: "validation_failed",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  CONFLICT: "conflict",
  CONFIG_INVALID: "config_invalid",
  DB_MIGRATION_FAILED: "db_migration_failed",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
