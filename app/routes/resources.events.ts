import type { Route } from "./+types/resources.events";
import { authenticate } from "~/server/auth/require-user.server";
import {
  connectSseClient,
  parseSseScope,
  type SseScope,
} from "~/server/events/sse-broker.server";

/**
 * GET /resources/events — the SSE stream (Phase 6).
 *
 * Query params (repeatable): scope=project:<slug> | task:<slug>/<key> |
 * projects | user
 *   - project/task scopes: projection change events for that surface;
 *   - projects: every project/task-routed event, any project (Home);
 *   - user: this session user's targeted events (notification.created/read)
 *     plus broadcasts (projection.rebuilt).
 * Reconnect position: `Last-Event-ID` header (native EventSource retry) or
 * `?lastEventId=` (our client wrapper recreates the EventSource, which
 * never re-sends the header) — the param wins.
 *
 * Auth: session cookie, same as every loader — but an unauthenticated
 * EventSource can't render a login page, so this returns plain 401 JSON
 * instead of requireUser's redirect (the client backs off and retries;
 * after a re-login the next retry succeeds).
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
      { error: { code: "unauthorized", message: "Sign in to subscribe." } },
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
            code: "validation",
            message: `Invalid scope "${raw}" — expected project:<slug>, task:<slug>/<key>, projects or user.`,
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
          code: "validation",
          message: "At least one scope query param is required.",
        },
      },
      { status: 400 },
    );
  }

  const lastRaw =
    url.searchParams.get("lastEventId") ?? request.headers.get("last-event-id");
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
        scopes,
        lastEventId,
        write,
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
