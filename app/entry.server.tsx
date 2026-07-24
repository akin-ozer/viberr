import { PassThrough, Readable } from "node:stream";

import type {
  EntryContext,
  HandleErrorFunction,
  RouterContextProvider,
} from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";

import { bootServer } from "./server/boot.server";
import { logger } from "./server/logging/logger.server";

// One-time startup: validate env (fail fast) + open db and run migrations.
await bootServer();

export const streamTimeout = 5_000;

/**
 * Server error sink (F12-02). Without a `handleError`, React Router's default
 * logs EVERY handler error — including routine 404s — so each `/favicon.ico`
 * hit (browsers auto-request it; we ship `favicon.svg`, linked in root.tsx)
 * and every crawler probe of a stray path spams the log with a full
 * "No route matches URL …" entry. Swallow aborted requests (client navigated
 * away / stream timed out) and route-not-found 404s as routine; log everything
 * else through the app logger like the streaming-render path does.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) && error.status === 404) return;
  logger.error("request handler error", {
    err: error instanceof Error ? error : new Error(String(error)),
  });
};

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const readyOption: keyof RenderToPipeableStreamOptions =
      routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          const stream = Readable.toWeb(
            body,
          ) as unknown as ReadableStream<Uint8Array>;

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            logger.error("streaming render error", {
              err: error instanceof Error ? error : new Error(String(error)),
            });
          }
        },
      },
    );
  });
}
