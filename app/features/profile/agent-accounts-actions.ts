import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import type {
  BackendLoginPollAnswer,
  BackendLoginPollData,
} from "~/routes/resources.backend-login";
import type { LoginState } from "~/server/runtimes/backend-login.server";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import type { ProfileBackend } from "./profile-query.server";

/**
 * An agent account card's poll of its running sign-in (ruling 689(e), the
 * split of `agent-accounts-panel.tsx` along the task page's recipe). The card
 * calls it where its poll fetcher always registered, so the fetcher keeps its
 * key. No component lives here, so the module is not a Fast Refresh boundary.
 */

const POLL_INTERVAL_MS = 2_000;

const TERMINAL_STATES: ReadonlySet<LoginState> = new Set<LoginState>([
  "succeeded",
  "failed",
  "cancelled",
]);

/** The sign-in the card shows and what it adds to the loader's word. */
export interface SignInPoll {
  /** The loader's sign-in, at the poll's fresher state of that session. */
  login: ProfileBackend["login"];
  /** The loader's "connected", or the poll's once the vendor confirmed. */
  connected: boolean;
  /** A sign-in is under way (not succeeded, failed or cancelled). */
  running: boolean;
}

/**
 * The poll fetcher is the card's OWN: `/resources/backend-login` answers for
 * the signed-in caller only, and loading it on the panel's action fetcher
 * would overwrite the intent result the toast settles on. Once this tab is
 * signed out it answers a refusal (a 401, ruling 457), and a poll that fails
 * answers null (the route's `clientLoader`); neither names a session, so
 * neither matches the loader's below. `onConnected` runs once per session the
 * vendor confirms.
 */
export function useSignInPoll(data: ProfileBackend, onConnected: () => void): SignInPoll {
  const { backend, health } = data;
  const poll = useFetcher<BackendLoginPollAnswer | null>();
  // The LOADER decides which session exists; the poll only supplies a fresher
  // state OF THAT SESSION. Matching on the id is what keeps a stale answer from
  // an earlier sign-in (a fetcher keeps its last data indefinitely) from
  // rendering a brand-new attempt as already finished.
  // SAFETY: a refusal carries no `login` (`BackendLoginRefusal`), so an answer
  // naming the loader's session is always the poll's own data.
  const polled =
    poll.data && data.login && poll.data.login?.id === data.login.id
      ? (poll.data as BackendLoginPollData)
      : null;
  const login = polled?.login ?? data.login;
  // A poll may only ADD "connected", never take it away: the loader is the
  // authority on a stored credential, and this covers the moment between the
  // vendor confirming a sign-in and the revalidation landing.
  const connected = health.available || (polled?.health.available ?? false);
  // Being connected does NOT hide a sign-in that is under way. A person whose
  // key already works may start a hosted sign-in (or restart one after a
  // failure), and suppressing this card would run the vendor's process
  // invisibly: no URL to open, no code, no Cancel, until it timed out.
  const running = login !== null && !TERMINAL_STATES.has(login.state);

  // `fetcher.load` is not a stable identity across renders, so the interval
  // reads the current one through a ref instead of resubscribing every render
  // (the pattern `useFetcherResult` uses for its handler).
  const load = useRef(poll.load);
  useEffect(() => {
    load.current = poll.load;
  });
  useEffect(() => {
    if (!running) return;
    const url = `/resources/backend-login?backend=${backend}`;
    const timer = setInterval(() => load.current(url), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, backend]);

  // The success toast settles on the POLL RESULT, which is the first moment the
  // vendor's own binary has confirmed the sign-in. Toasting at submit time
  // would claim a connection while the browser step had not even started.
  // Keyed by SESSION id, not a boolean: a person who disconnects and signs in
  // again in the same page session must be told about the second connection too.
  const announced = useRef<string | null>(null);
  useFetcherResult(poll, (payload) => {
    const done = payload.login;
    if (!done || done.state !== "succeeded" || announced.current === done.id) {
      return;
    }
    announced.current = done.id;
    onConnected();
  });

  return { login, connected, running };
}
