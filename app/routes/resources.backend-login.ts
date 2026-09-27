import { z } from "zod";
import type { Route } from "./+types/resources.backend-login";
import { authenticate } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  userBackendHealth,
  type CredentialKind,
  type LoginMethod,
} from "~/server/runtimes/backend-credentials.server";
import {
  getBackendLogin,
  type LoginSessionView,
} from "~/server/runtimes/backend-login.server";

/**
 * GET /resources/backend-login?backend=claude|codex — the CALLER's own hosted
 * sign-in session, plus their current backend health (ruling 127).
 *
 * Profile → Agent accounts polls this every 2 s while a sign-in is running: the
 * vendor's process is driven server-side, so the browser has no other way to
 * learn that Anthropic printed a URL, that OpenAI printed a device code, or
 * that the flow finished. The poll stops when the session reaches a terminal
 * state; health rides along so the card can report the connection the moment
 * the vendor's own binary confirmed it, without waiting for the loader round
 * trip that follows.
 *
 * It is keyed by `user.id` from the session and takes no user parameter, so it
 * can only ever answer for the person asking: a live sign-in belongs to one
 * person, and one person's device code must never be readable by another.
 *
 * The payload carries NO secret. A `login` session holds only what the vendor
 * displayed to the person (a URL, a one-time code) plus one already-redacted
 * error sentence, and the health half ships the last four characters of a
 * pasted key, never the key.
 *
 * Success is route-shaped data, the way a loader answers its own fetcher; a
 * refusal uses the conventions' JSON error shape `{ error: { code, message } }`
 * with a code from the catalog, like every sibling `resources.*` route.
 */

const backendParam = z.enum(["claude", "codex"]);

/** The health fields the card renders. `verification` and the internal ids stay
 *  server-side: the card needs to know whether the backend works, how it was
 *  connected and what to say when it does not. */
export interface BackendHealthView {
  available: boolean;
  kind: CredentialKind | null;
  method: LoginMethod | null;
  detail: string | null;
  secretSuffix: string | null;
  verifiedAt: string | null;
  connectedAt: string | null;
}

export interface BackendLoginPollData {
  login: LoginSessionView | null;
  health: BackendHealthView;
}

/** A refusal, in the conventions' JSON error shape: a 400 for an unknown
 *  backend, a 401 for a caller who is not signed in. It carries no sign-in
 *  and no health. */
export interface BackendLoginRefusal {
  error: { code: string; message: string };
  login?: undefined;
  health?: undefined;
}

/** Everything the poll can hand the Profile card. */
export type BackendLoginPollAnswer = BackendLoginPollData | BackendLoginRefusal;

export async function loader({ request }: Route.LoaderArgs) {
  // Ruling 457 (test audit L14-29): a 401, never `requireUser`'s login
  // redirect, which named THIS route as the returnTo. The card polls it
  // through a fetcher, and a fetcher follows a redirect as a navigation: a
  // stale tab went to /login and, once signed in, to a page of raw JSON. The
  // card keeps what its page drew, and the page's next real navigation asks
  // for the sign-in.
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    return Response.json(
      {
        error: {
          code: ERROR_CODES.UNAUTHORIZED,
          message: "Sign in to see your agent accounts.",
        },
      } satisfies BackendLoginRefusal,
      { status: 401 },
    );
  }
  const { user } = ctx;
  const backend = backendParam.safeParse(
    new URL(request.url).searchParams.get("backend"),
  );
  if (!backend.success) {
    // The conventions' JSON error shape, the same one `/resources/run-log` and
    // `/resources/events` answer with: a caller that switches on
    // `error.code` must be able to tell a bad `backend` from anything else.
    return Response.json(
      {
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: "Unknown backend.",
        },
      } satisfies BackendLoginRefusal,
      { status: 400 },
    );
  }
  const db = getDb();
  const health = userBackendHealth(db, user.id, backend.data);
  const body: BackendLoginPollData = {
    login: getBackendLogin(user.id, backend.data),
    health: {
      available: health.available,
      kind: health.kind,
      method: health.method,
      detail: health.detail,
      secretSuffix: health.secretSuffix,
      verifiedAt: health.verifiedAt,
      connectedAt: health.connectedAt,
    },
  };
  return Response.json(body);
}
