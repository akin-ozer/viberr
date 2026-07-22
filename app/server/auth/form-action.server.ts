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

export function appErrorResponse(error: unknown) {
  if (!isAppError(error)) throw error;
  return data(
    { ok: false as const, error: error.userMessage },
    { status: error.status },
  );
}
