import { data } from "react-router";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "../db/sqlite.server";
import { isAppError } from "../errors/app-error.server";
import { requireAuth } from "./require-user.server";

/**
 * The preamble of a route action: auth → db → formData → CSRF. A signed-out
 * post is THROWN (the /login redirect); a failed CSRF check is ANSWERED: the
 * caller returns `refused`, the 403 `{ ok: false, error }` result, before it
 * touches anything else:
 *
 *   const { refused, db, formData, actor, intent } = await requireFormAction(request);
 *   if (refused) return refused;
 *
 * Ruling 454 (RV-1): the refusal used to be a thrown 403. React Router sends a
 * thrown fetcher error to the route's error boundary without revalidating, so
 * a tab whose session changed in another tab (a sign-in again gives it a new
 * id, and root's csrf token is the old one's) lost the page, and with it the
 * comment typed into the composer; and root, which no longer re-runs on a
 * navigation or a live event, never read the new token. Answered, the page
 * stays up with an inline error, and the 403 re-runs root
 * (`revalidation-policy.ts`), so the next try carries a good token.
 */
export async function requireFormAction(request: Request) {
  const auth = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  const refused = await csrfError(request, auth.sessionId, formData);
  if (refused) return { refused };
  return {
    refused: null,
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
