import { createContext, useContext, type ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

/**
 * A hook under test runs under a REAL data router, so `useRevalidator` is React
 * Router's own and a revalidation is observable the way the product sees one:
 * the route loader runs again. `hydrationData` starts the router initialized,
 * so the tree paints synchronously and the initial load is not counted. The
 * subject renders through a context slot rather than as the route's own
 * element, so `rerender` with new props still reaches it.
 */
const SubjectContext = createContext<ReactNode>(null);

function Subject() {
  return <>{useContext(SubjectContext)}</>;
}

let loaderRuns = 0;
let router = makeRouter();

function makeRouter() {
  loaderRuns = 0;
  return createMemoryRouter(
    [
      {
        path: "*",
        Component: Subject,
        loader: () => {
          loaderRuns += 1;
          return null;
        },
      },
    ],
    { hydrationData: { loaderData: { "0": null } } },
  );
}

/** A fresh router whose loader has not run (before each test). */
export function resetDataRouter(): void {
  router = makeRouter();
}

/** How many times the route loader ran: one per revalidation. */
export function loaderRunCount(): number {
  return loaderRuns;
}

/** The render `wrapper` that mounts its children inside the router. */
export function DataRouter({ children }: { children: ReactNode }) {
  return (
    <SubjectContext.Provider value={children}>
      <RouterProvider router={router} />
    </SubjectContext.Provider>
  );
}
