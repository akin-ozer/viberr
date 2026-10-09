import type {
  ActionFunction,
  ActionFunctionArgs,
  LoaderFunction,
  LoaderFunctionArgs,
} from "react-router";

/**
 * Ruling 11: a resource route's `clientLoader` and `clientAction` under
 * `createRoutesStub`. A stub route whose loader or action comes from here runs
 * a fetcher's request the way framework mode runs it (react-router
 * `lib/dom/ssr/routes.js`, `createClientRoutes`): through the route module's
 * `clientLoader` or `clientAction`, with the server's answer handed to it as
 * `serverLoader` or `serverAction`, or the server's answer alone when the
 * module has none.
 *
 * `server` stands in for the route's server handler. It returns what single
 * fetch decodes from the route's answer (a returned 4xx is data, and its status
 * reaches no client handler), or it throws what the request rejects with:
 * {@link unreachable} for a server that a restart or a dead network leaves
 * with no answer at all.
 */

interface ClientDataModule {
  clientLoader?(
    args: LoaderFunctionArgs & { serverLoader: () => ReturnType<LoaderFunction> },
  ): ReturnType<LoaderFunction>;
  clientAction?(
    args: ActionFunctionArgs & { serverAction: () => ReturnType<ActionFunction> },
  ): ReturnType<ActionFunction>;
}

/** A stub route's loader: `module`'s `clientLoader` over `server`. Not
 *  `clientLoader?.() ?? server()`: a `clientLoader` may answer null, and that
 *  is its answer. */
export function clientLoaderOver(module: ClientDataModule, server: LoaderFunction): LoaderFunction {
  return (args) => {
    const serverLoader = async () => server(args);
    return module.clientLoader ? module.clientLoader({ ...args, serverLoader }) : serverLoader();
  };
}

/** A stub route's action: `module`'s `clientAction` over `server`. */
export function clientActionOver(module: ClientDataModule, server: ActionFunction): ActionFunction {
  return (args) => {
    const serverAction = async () => server(args);
    return module.clientAction ? module.clientAction({ ...args, serverAction }) : serverAction();
  };
}

/** A request that got no answer: the browser's `fetch` rejects with a
 *  `TypeError` when the server is restarting or the network is gone. */
export function unreachable(): never {
  throw new TypeError("Failed to fetch");
}
