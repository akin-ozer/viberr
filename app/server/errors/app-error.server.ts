import { ERROR_CODES, type ErrorCode } from "./error-codes";

export interface AppErrorOptions {
  code: ErrorCode;
  /** HTTP status this error maps to. Default 500. */
  status?: number;
  /** Internal message for logs. Never shown to users. */
  message?: string;
  /** Safe, human-readable message that MAY be shown to users. */
  userMessage?: string;
  /** Structured, secret-free context (ids, field names — never values of secrets). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

const DEFAULT_USER_MESSAGE = "Something went wrong on our side.";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly userMessage: string;
  readonly details?: Record<string, unknown>;

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
    details?: Record<string, unknown>,
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
    details?: Record<string, unknown>,
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

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
