import { data } from "react-router";
import { assertCsrf } from "~/server/auth/csrf.server";

/**
 * UI-32: CSRF failure as a RESULT, not a thrown Response.
 *
 * `assertCsrf` throws a raw `Response` (csrf.server.ts). React Router renders
 * the nearest error boundary for a thrown response, so a stale/missing token in
 * a fetcher submission replaced the entire UI with root's "403 Forbidden"
 * document — losing whatever the user had open. Worse, that made the
 * `{ ok:false, error }` toast branches in `top-bell.tsx`, `notifications.tsx`,
 * `user-menu.tsx` and `profile-page.tsx` (all commented "reports the failure
 * instead of a false success") unreachable for the one failure they were
 * written for.
 *
 * Returns `null` when the token is valid, or the 403 result the client toast
 * handlers already know how to read.
 */
export async function csrfError(
  request: Request,
  sessionId: string,
  formData: FormData,
): Promise<ReturnType<typeof data<{ ok: false; error: string }>> | null> {
  try {
    await assertCsrf(request, sessionId, formData);
    return null;
  } catch (error) {
    if (error instanceof Response) {
      return data(
        {
          ok: false as const,
          error:
            "That request expired. Reload the page and try again (security token mismatch).",
        },
        { status: 403 },
      );
    }
    throw error;
  }
}
