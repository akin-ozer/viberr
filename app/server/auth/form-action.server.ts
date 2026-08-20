import { data } from "react-router";
import { getDb } from "../db/sqlite.server";
import { isAppError } from "../errors/app-error.server";
import { assertCsrf } from "./csrf.server";
import { requireAuth } from "./require-user.server";

export async function requireFormAction(request: Request) {
  const auth = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  await assertCsrf(request, auth.sessionId, formData);
  return {
    auth,
    db,
    formData,
    actor: { userId: auth.user.id, label: auth.user.email },
    intent: String(formData.get("intent") ?? ""),
  };
}

/** Render a CAUGHT throwable as an action response — or re-throw it untouched
 *  when it is not one of ours, so a genuine defect still reaches the error
 *  boundary instead of being flattened into a 500-shaped payload. */
export function appErrorResponse(cause: unknown) {
  if (!isAppError(cause)) throw cause;
  return data(
    { ok: false as const, error: cause.userMessage },
    { status: cause.status },
  );
}
