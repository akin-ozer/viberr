import { logger } from "../logging/logger.server";
import { isAppError } from "./app-error.server";
import { ERROR_CODES } from "./error-codes";

/**
 * JSON error body shape (see CONVENTIONS.md):
 *   { error: { code, message, details? } }
 * `message` is always the safe userMessage — internal messages, stacks and
 * causes stay in the logs.
 */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Maps any thrown value to a Response for loaders/actions.
 * - AppError        → its status + { error: { code, message, details? } }
 * - Response        → passed through untouched (framework redirects etc.)
 * - anything else   → logged, opaque 500 internal_error
 */
export function toErrorResponse(error: unknown, requestId?: string): Response {
  if (error instanceof Response) return error;

  if (isAppError(error)) {
    if (error.kind === "infrastructure") {
      logger.error("request failed", { requestId, err: error, code: error.code });
    }
    const body: ErrorBody = {
      error: {
        code: error.code,
        message: error.userMessage,
        ...(error.details ? { details: error.details } : {}),
      },
    };
    return Response.json(body, { status: error.status });
  }

  logger.error("unhandled error in loader/action", {
    requestId,
    err: error instanceof Error ? error : new Error(String(error)),
  });
  const body: ErrorBody = {
    error: { code: ERROR_CODES.INTERNAL, message: "Unexpected server error." },
  };
  return Response.json(body, { status: 500 });
}
