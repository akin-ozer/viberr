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
  // Phase 7 — secrets + GitHub integration.
  SECRET_BOX_INVALID: "secret_box_invalid",
  GITHUB_AUTH_FAILED: "github_auth_failed",
  GITHUB_FORBIDDEN: "github_forbidden",
  GITHUB_NOT_FOUND: "github_not_found",
  GITHUB_UNAVAILABLE: "github_unavailable",
  GITHUB_API_ERROR: "github_api_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
