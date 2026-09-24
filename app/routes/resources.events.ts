import type { Route } from "./+types/resources.events";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { authenticate } from "~/server/auth/require-user.server";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  connectSseClient,
  parseSseScope,
  type SseScope,
} from "~/server/events/sse-broker.server";

/** Project slugs the user is a member of (for scoping the `projects` firehose). */
function memberProjectSlugs(userId: string): string[] {
  // SAFETY: the SELECT names exactly one column, `project_members.project_slug`,
  // which is NOT NULL TEXT (0001_baseline.sql).
  const rows = getDb()
    .prepare(`SELECT project_slug FROM project_members WHERE user_id = ?`)
    .all(userId) as { project_slug: string }[];
  return rows.map((r) => r.project_slug);
}

/**
 * GET /resources/events — the SSE stream (Phase 6).
 *
 * Query params (repeatable): scope=project:<slug> | task:<slug>/<key> |
 * projects | user
 *   - project/task scopes: projection change events for that surface;
 *   - projects: every project/task-routed event, any project (Home);
 *   - user: this session user's targeted events (notification.created/read)
 *     plus broadcasts (projection.rebuilt).
 * Reconnect position: the native EventSource `Last-Event-ID` header, or the
 * `lastEventId` query param a new EventSource carries (ruling 454).
 *
 * Auth: session cookie, same as every loader — but an unauthenticated
 * EventSource can't render a login page, so this returns plain 401 JSON
 * instead of requireUser's redirect.
 *
 * UI-03 correction: this comment used to claim "the client backs off and
 * retries; after a re-login the next retry succeeds". That is NOT what the
 * browser does. Per the HTML spec an EventSource that receives a non-200
 * response **fails the connection** and does not reconnect — so the 401 above
 * (and the 400/403 scope rejections below) permanently kill the stream. The
 * client therefore owns recovery: `useLiveUpdates` observes `onerror`, surfaces
 * a "live updates paused" state and re-opens a FRESH EventSource on a bounded
 * backoff (a new connection does succeed after a re-login).
 *
 * Streaming: the loader returns a `Response` wrapping a never-ending web
 * `ReadableStream` — the one shape that streams through BOTH the Vite dev
 * server and `react-router-serve` (its compression middleware skips
 * `text/event-stream` because the type is not compressible, so chunks pass
 * through unbuffered). `Cache-Control: no-store, no-transform` +
 * `X-Accel-Buffering: no` keep intermediaries from buffering.
 * Client disconnects surface as `request.signal` aborts (wired by the node
 * adapter in dev and prod) AND as `cancel()` on the stream — both close the
 * broker connection; enqueue on a torn stream throws, which the broker
 * treats as drop-and-close.
 *
 * Backpressure: the adapter stops pulling when the socket stalls, so
 * queued chunks accumulate and `desiredSize` goes negative. Past the limit
 * below the write throws and the broker drops the connection — a stalled
 * client can never grow the queue unboundedly.
 */

const MAX_QUEUED_CHUNKS = 1024;

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await authenticate(request);
  if (!ctx || ctx.pwresetRequired) {
    return Response.json(
      { error: { code: ERROR_CODES.UNAUTHORIZED, message: "Sign in to subscribe." } },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const rawScopes = url.searchParams.getAll("scope");
  const scopes: SseScope[] = [];
  for (const raw of rawScopes) {
    const scope = parseSseScope(raw);
    if (!scope) {
      return Response.json(
        {
          error: {
            code: ERROR_CODES.VALIDATION_FAILED,
            message: `Invalid scope "${raw}". Expected project:<slug>, task:<slug>/<key>, projects or user.`,
          },
        },
        { status: 400 },
      );
    }
    scopes.push(scope);
  }
  if (scopes.length === 0) {
    return Response.json(
      {
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: "At least one scope query param is required.",
        },
      },
      { status: 400 },
    );
  }

  // SSE subscription authorization (full D9). Org admins may subscribe to any
  // scope (they can already see every project — mirrors the Home filter). For a
  // NON-org-admin:
  //   - the `projects` firehose is EXPANDED to per-project scopes for only their
  //     member projects (it would otherwise leak every project's existence/state);
  //   - an EXPLICITLY-named `project:<slug>` / `task:<slug>/<key>` scope is kept
  //     only if they are a member of <slug> — otherwise dropped. Previously any
  //     authenticated user could name a foreign scope and stream its live events
  //     (R2: parseSseScope validated syntax, never membership).
  //   - `user` scope (their own targeted events) always passes.
  /**
   * The scopes this user is allowed RIGHT NOW.
   *
   * Re-resolved rather than captured: the org role and the membership set are
   * both read live, because this same function is handed to the broker as the
   * connection's `reauthorize` hook. An SSE stream stays open indefinitely, so
   * deciding this once at connect time meant a member removed from a project
   * (or an admin demoted) kept receiving that project's events for as long as
   * the tab lived.
   */
  const resolveScopes = (): SseScope[] => {
    if (isOrgAdmin(getDb(), ctx.user.id)) return scopes;
    const memberOf = new Set(memberProjectSlugs(ctx.user.id));
    return scopes.flatMap((s): SseScope[] => {
      if (s.kind === "projects") {
        return [...memberOf].map((slug) => ({ kind: "project", slug }));
      }
      if (s.kind === "project" || s.kind === "task") {
        return memberOf.has(s.slug) ? [s] : [];
      }
      return [s]; // user scope
    });
  };

  const effectiveScopes = resolveScopes();
  // A non-member who named ONLY foreign project/task scopes gets nothing to
  // subscribe to — deny explicitly rather than open an empty stream.
  if (effectiveScopes.length === 0) {
    return Response.json(
      {
        error: {
          code: "forbidden",
          message: "You are not a member of the requested project scope(s).",
        },
      },
      { status: 403 },
    );
  }

  // The browser's own retry of a source sends the header; a NEW EventSource
  // cannot, so the client names its position on the URL (ruling 454, RF-1: a
  // re-scope or a return from hidden replays what the tab missed instead of
  // reloading every loader). The header is the fresher of the two.
  const lastRaw = request.headers.get("last-event-id") ?? url.searchParams.get("lastEventId");
  const lastEventId =
    lastRaw !== null && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;

  const encoder = new TextEncoder();
  let handle: { close(): void } | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        const desired = controller.desiredSize;
        if (desired !== null && desired < 1 - MAX_QUEUED_CHUNKS) {
          throw new Error("sse backpressure limit exceeded");
        }
        controller.enqueue(encoder.encode(chunk));
      };
      handle = connectSseClient({
        userId: ctx.user.id,
        scopes: effectiveScopes,
        lastEventId,
        write,
        reauthorize: resolveScopes,
        onClose: () => {
          try {
            controller.close();
          } catch {
            // Already closed/errored by the adapter — nothing to do.
          }
        },
      });
      request.signal.addEventListener("abort", () => handle?.close(), {
        once: true,
      });
      if (request.signal.aborted) handle.close();
    },
    cancel() {
      handle?.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
