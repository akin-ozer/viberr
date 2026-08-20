import { ERROR_CODES, type ErrorCode } from "./error-codes";

/**
 * Structured, secret-free error context: ids, field names, counts — the values
 * a log line or a test reads back. Scalars only, deliberately: `details` is
 * diagnostic context, never a payload, so nothing here can carry a nested blob
 * (or a secret's value) into a log.
 */
export type AppErrorDetails = Record<string, string | number | boolean | null>;

export interface AppErrorOptions {
  code: ErrorCode;
  /** HTTP status this error maps to. Default 500. */
  status?: number;
  /** Internal message for logs. Never shown to users. */
  message?: string;
  /** Safe, human-readable message that MAY be shown to users. */
  userMessage?: string;
  /** Structured, secret-free context (ids, field names — never values of secrets). */
  details?: AppErrorDetails;
  cause?: unknown;
}

const DEFAULT_USER_MESSAGE = "Something went wrong on our side.";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly details?: AppErrorDetails;

  constructor(options: AppErrorOptions) {
    super(options.message ?? options.userMessage ?? options.code, {
      cause: options.cause,
    });
    this.name = "AppError";
    this.code = options.code;
    this.status = options.status ?? 500;
    this.userMessage = options.userMessage ?? DEFAULT_USER_MESSAGE;
    this.details = options.details;
  }

  static notFound(
    userMessage = "Not found.",
    details?: AppErrorDetails,
  ): AppError {
    return new AppError({
      code: ERROR_CODES.NOT_FOUND,
      status: 404,
      userMessage,
      details,
    });
  }

  static validation(
    userMessage: string,
    details?: AppErrorDetails,
  ): AppError {
    return new AppError({
      code: ERROR_CODES.VALIDATION_FAILED,
      status: 400,
      userMessage,
      details,
    });
  }

  static forbidden(userMessage: string): AppError {
    return new AppError({
      code: ERROR_CODES.FORBIDDEN,
      status: 403,
      userMessage,
    });
  }

  static conflict(userMessage: string): AppError {
    return new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage,
    });
  }

  static internal(message: string, cause?: unknown): AppError {
    return new AppError({
      code: ERROR_CODES.INTERNAL,
      status: 500,
      message,
      cause,
    });
  }
}

/** Narrow a CAUGHT throwable — the only place `unknown` is the honest type for
 *  it, and the boundary every caller crosses before reading `.userMessage` /
 *  `.status` off one. */
export function isAppError(cause: unknown): cause is AppError {
  return cause instanceof AppError;
}
