/**
 * The one normalization of a caught value. `catch` and a promise rejection hand
 * over `unknown` — usually an Error, but a thrown string or object is legal —
 * and a log record, a timeline note or a refusal needs an Error or its message.
 * Client-safe and import-free, so any module can take it.
 */

/** The value itself when it is an Error, else an Error whose message is
 *  `String(cause)`. The stack starts at the caller, as an inline `new Error`
 *  there would (the optional call keeps engines without the V8 API working). */
export function toError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const error = new Error(String(cause));
  Error.captureStackTrace?.(error, toError);
  return error;
}

/** An Error's `message`, else `String(cause)`. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
