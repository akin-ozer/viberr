import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { getAuth } from "~/lib/auth.server";
import { assertCsrf } from "~/server/auth/csrf.server";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";

/** POST /logout — revokes the better-auth session + clears its cookie. */

export async function action({ request }: Route.ActionArgs) {
  const db = getDb();
  const auth = await authenticate(request);
  if (!auth) throw redirect("/login");
  await assertCsrf(request, auth.sessionId);

  recordAudit(db, {
    action: "auth.logout",
    actor: { userId: auth.user.id, label: auth.user.email },
    subjectKind: "user",
    subjectId: auth.user.id,
  });

  // Revoke the better-auth session and clear its cookie.
  const res = await getAuth().api.signOut({
    headers: request.headers,
    asResponse: true,
  });
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }
  throw redirect("/login", { headers });
}

export function loader(_args: Route.LoaderArgs) {
  throw redirect("/");
}
