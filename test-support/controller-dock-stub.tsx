import { render } from "@testing-library/react";
import { createRoutesStub, Link, Outlet, useRevalidator } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ControllerDock } from "~/features/controller/controller-dock";
import type { ControllerDockView } from "~/features/controller/controller-dock-query.server";
import type { WaitingActionResult } from "~/features/controller/waiting-actions";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";
import { dockResourceShouldRevalidate } from "~/features/controller/controller-dock-context";
import * as dockStatusRoute from "~/routes/resources.controller-unseen";
import * as dockRoute from "~/routes/resources.controller";
import type { LiveTurnView, UnseenReplyView } from "~/routes/resources.controller-unseen";
import { clientActionOver, clientLoaderOver, unreachable } from "./client-data";

/**
 * Ruling 256: the controller dock under a routed stub shaped like the app —
 * root (which mounts the dock), the workspace layout, a board, a task and the
 * project controller page, and the dock's two resource routes. Shared by the
 * dock's behaviour tests and its ruling-11 perf test, so both drive the same
 * routes and count the same requests.
 *
 * The resource routes run as framework mode runs a fetcher's request, through
 * the real modules' `clientLoader` and `clientAction` (`client-data.ts`); the
 * stub stands in for the server.
 *
 * Each page offers the two moves a person makes under the dock: links to the
 * other page (a client navigation) and a button that revalidates (what the
 * page's own live stream does on an event). The task page also links to the
 * project's full controller page, which the dock stays off, and that page
 * links back. `live` mounts the `user` stream a real board holds
 * (`routes/project`), for tests that emit SSE events through a stubbed
 * `EventSource`.
 */

const USER_SCOPES = [sseScopes.user()];

export interface DockStubOptions {
  path: string;
  view: (request: Request) => ControllerDockView;
  /** O39-d: the viewer's unseen replies (none by default). */
  unseen?: () => UnseenReplyView[];
  /** Ruling 11: the viewer's turns working right now (none by default). */
  working?: () => LiveTurnView[];
  action?: (
    form: FormData,
  ) => { ok: true; conversationId: string } | { ok: false; error: string } | WaitingActionResult;
  /** Ruling 11: asked on every request the dock makes; false while the
   *  server can't be reached (a restart, a dead network), when the request
   *  gets no answer. Reachable when absent. */
  reachable?: () => boolean;
  /** The pages hold the `user` stream, as the workspace layout does. */
  live?: boolean;
  /** Mount under `<StrictMode>`, as `entry.client.tsx` does (the dev server
   *  double-runs mount effects there; production does not). */
  strict?: boolean;
}

export interface DockStubCounters {
  /** Every load of the dock's view (`/resources/controller`), in order. */
  loads: URL[];
  /** Every load of the unseen-reply list (`/resources/controller-unseen`). */
  unseenLoads: URL[];
  /** Every send the server took (`POST /resources/controller`). */
  sends: FormData[];
  /** Every run of a PAGE loader (root, the layout, the board, the task). */
  pageLoads: string[];
}

function Revalidate() {
  const revalidator = useRevalidator();
  return (
    <button type="button" onClick={() => void revalidator.revalidate()}>
      revalidate page
    </button>
  );
}

function LiveStream() {
  useLiveUpdates(USER_SCOPES);
  return null;
}

export function mountDock(opts: DockStubOptions) {
  const counters: DockStubCounters = { loads: [], unseenLoads: [], sends: [], pageLoads: [] };
  const page = (id: string) => () => {
    counters.pageLoads.push(id);
    return null;
  };
  const reachable = opts.reachable ?? (() => true);
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => {
        counters.pageLoads.push("root");
        return { csrf: "tok", theme: "system" };
      },
      Component: () => (
        <ToastProvider>
          <Outlet />
          <ControllerDock />
        </ToastProvider>
      ),
      children: [
        {
          id: "routes/project",
          path: "projects/:slug",
          loader: page("routes/project"),
          Component: () => (
            <>
              {opts.live && <LiveStream />}
              <Outlet />
              <Revalidate />
            </>
          ),
          children: [
            {
              id: "routes/project.board",
              path: "board",
              loader: page("routes/project.board"),
              Component: () => (
                <>
                  <div>board page</div>
                  <Link to="/projects/viberr/tasks/VIB-1">open VIB-1</Link>
                </>
              ),
            },
            {
              id: "routes/project.task",
              path: "tasks/:key",
              loader: page("routes/project.task"),
              Component: () => (
                <>
                  <div>task page</div>
                  <Link to="/projects/viberr/board">back to the board</Link>
                  <Link to="/projects/viberr/controller">open the controller page</Link>
                </>
              ),
            },
            {
              id: "routes/project.controller",
              path: "controller",
              Component: () => (
                <>
                  <div>controller page</div>
                  <Link to="/projects/viberr/tasks/VIB-1">back to VIB-1</Link>
                </>
              ),
            },
          ],
        },
        {
          id: "routes/resources.controller-unseen",
          path: "resources/controller-unseen",
          // The real routes' own answer, so a page revalidation here reloads
          // what it reloads in the app.
          shouldRevalidate: dockResourceShouldRevalidate,
          loader: clientLoaderOver(dockStatusRoute, ({ request }) => {
            counters.unseenLoads.push(new URL(request.url));
            if (!reachable()) unreachable();
            return {
              unseen: opts.unseen ? opts.unseen() : [],
              working: opts.working ? opts.working() : [],
            };
          }),
        },
        {
          id: "routes/resources.controller",
          path: "resources/controller",
          shouldRevalidate: dockResourceShouldRevalidate,
          loader: clientLoaderOver(dockRoute, ({ request }) => {
            counters.loads.push(new URL(request.url));
            if (!reachable()) unreachable();
            return { view: opts.view(request) };
          }),
          action: clientActionOver(dockRoute, async ({ request }) => {
            if (!reachable()) unreachable();
            const form = await request.formData();
            counters.sends.push(form);
            return opts.action ? opts.action(form) : { ok: true as const, conversationId: "cnv_new" };
          }),
        },
      ],
    },
  ]);
  const utils = render(<Stub initialEntries={[opts.path]} />, { reactStrictMode: opts.strict });
  return { ...utils, ...counters };
}
