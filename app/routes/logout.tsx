import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { assertCsrf } from "~/server/auth/csrf.server";
import { authenticate } from "~/server/auth/require-user.server";
import { clearSessionCookieHeader } from "~/server/auth/session-cookie.server";
import { destroySessionByToken } from "~/server/auth/session.server";
import { getDb } from "~/server/db/sqlite.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";

/** POST /logout — destroys the session row + cookie. GET redirects home. */

export async function action({ request }: Route.ActionArgs) {
  const db = getDb();
  const auth = authenticate(request);
  if (!auth) throw redirect("/login");
  await assertCsrf(request, auth.sessionId);

  destroySessionByToken(db, auth.sessionToken);
  recordAudit(db, {
    action: "auth.logout",
    actor: { userId: auth.user.id, label: auth.user.email },
    subjectKind: "user",
    subjectId: auth.user.id,
  });
  throw redirect("/login", {
    headers: { "Set-Cookie": clearSessionCookieHeader() },
  });
}

export function loader(_: Route.LoaderArgs) {
  throw redirect("/");
}
