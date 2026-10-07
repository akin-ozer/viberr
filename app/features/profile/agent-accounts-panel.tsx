import { useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { FetcherWithComponents } from "react-router";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useToast } from "~/ui/toast";
import { AGENT_ACCOUNTS_ANCHOR } from "~/shared/page-anchors";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import type { ProfileBackend, ProfileBackendAccount } from "./profile-query.server";
import type { ProfileActionData } from "./profile-page";
import { AccountInUse } from "./agent-account-in-use";
import { useSignInPoll } from "./agent-accounts-actions";
import { cardBadge, cardRequest } from "./agent-accounts-derive";
import {
  FailedSignIn,
  NoAccountYet,
  SignInUnderWay,
  type CardControls,
} from "./agent-accounts-regions";

/**
 * Profile → Agent accounts (ruling 127).
 *
 * Every agent run bills ONE person's provider account: a run on a task belongs
 * to the task owner, a controller turn to the asker. So "is Claude configured"
 * is a question about a PERSON, answered here, and this panel is where a person
 * connects each backend.
 *
 * Two ways per backend, both the vendor's own:
 *
 *  - a hosted SIGN-IN driven through the unmodified vendor binary on this
 *    server. Viberr never implements the vendors' OAuth and never sees the
 *    resulting token: the vendor's client writes it into that person's runtime
 *    home. The card's job is to relay what the vendor printed (a URL, a device
 *    code, a prompt for the code Anthropic shows) and to say honestly where the
 *    flow has got to.
 *  - a pasted API key or ChatGPT workspace access token, which IS ours to hold
 *    and is stored sealed.
 *
 * The in-progress card POLLS `/resources/backend-login` because the vendor
 * process runs server-side: nothing else would ever tell the browser that the
 * URL appeared or that the sign-in finished. Every toast settles on a fetcher
 * RESULT, never at submit time.
 *
 * Ruling 507: a person may keep several accounts per backend. The card leads
 * with the one their runs use (its health, usage and refusals, which are about
 * that account). Ruling 616: that account is a select (`AccountPicker`), whose
 * menu lists every account kept here and switches to the one chosen — a
 * switch, not a sign-in: each account's sign-in stays in its own home on this
 * server. The same menu adds another account, which connects through the same
 * sign-in and paste methods and becomes the one in use, and opens the others'
 * management. Rename and Disconnect are per account; disconnecting the one in
 * use hands runs to the account used before it.
 *
 * Ruling 689(e): the card is composition. Its sign-in poll is a hook in
 * `agent-accounts-actions.ts`, what it reads off its props and the fetcher is
 * pure functions in `agent-accounts-derive.ts`, and its regions are hook-free
 * components in `agent-accounts-regions.tsx` and `agent-account-in-use.tsx`;
 * the picker (`agent-account-picker.tsx`), the paste and rename forms
 * (`agent-account-forms.tsx`) and the running sign-in
 * (`agent-sign-in-steps.tsx`) keep the hooks they always owned.
 */

/** The panel shares the profile route's one action shape; importing the type
 *  (erased at build) keeps it from being restated here. */
type AccountsFetcher = FetcherWithComponents<ProfileActionData>;

/** The panel's inline error: the intent fetcher's refusal, shown once settled.
 *  Guarded by intent so an unrelated profile action never lands here. */
function accountsError(fetcher: AccountsFetcher): string | null {
  if (fetcher.state !== "idle" || !fetcher.data || fetcher.data.ok) return null;
  if (!fetcher.data.intent?.startsWith("backend-")) return null;
  return fetcher.data.error ?? "Something went wrong.";
}

/**
 * The server-computed toast for a completed intent, pushed once per result.
 * Only the intents that ARE finished when the action returns carry one: a
 * disconnect, a saved key, a cancelled sign-in. Starting a sign-in returns no
 * toast on purpose, because at that moment nothing is connected yet.
 */
function useAccountsToast(fetcher: AccountsFetcher): void {
  const push = useToast();
  useFetcherResult(fetcher, (data) => {
    if (!data.intent?.startsWith("backend-")) return;
    if (data.ok && data.toast) push(data.toast);
  });
}

// -------------------------------------------------------------- one backend

function AgentAccountCard({
  data,
  fetcher,
  submit,
}: {
  data: ProfileBackend;
  fetcher: AccountsFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const { backend, methods, limits } = data;
  const label = BACKEND_LABEL[backend];
  // Ruling 507: every account the person holds here, the active one first.
  const accounts = data.accounts;
  const active = accounts.find((account) => account.active) ?? null;
  const others = accounts.filter((account) => !account.active);
  const push = useToast();
  const revalidator = useRevalidator();
  const [paste, setPaste] = useState<"api_key" | "access_token" | null>(null);
  // Ruling 507: the account a Disconnect is asking about, the account whose
  // name is being edited, and whether "Add another account" is open. Ruling
  // 616: and whether the other accounts' management is.
  const [confirmDisconnect, setConfirmDisconnect] = useState<ProfileBackendAccount | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  // Ruling 616: what the picker's menu opens takes the focus once it is on
  // screen (the menu row that opened it is gone by then), and closing it
  // hands the focus back to the picker. A fresh object per request, so a
  // section asked for again while it is already open is focused again.
  const picker = useRef<HTMLButtonElement | null>(null);
  const addingBox = useRef<HTMLDivElement | null>(null);
  const managingBox = useRef<HTMLDivElement | null>(null);
  const [focusAsked, setFocusAsked] = useState<{ box: "adding" | "managing" } | null>(null);
  useEffect(() => {
    if (focusAsked) (focusAsked.box === "adding" ? addingBox : managingBox).current?.focus();
  }, [focusAsked]);
  const openSection = (box: "adding" | "managing") => {
    if (box === "adding") setAdding(true);
    else setManaging(true);
    setFocusAsked({ box });
  };
  // The management closes with the last account it listed, so an account
  // added later does not open it again on its own.
  useEffect(() => {
    if (others.length === 0) setManaging(false);
  }, [others.length]);

  const { login, connected, running } = useSignInPoll(data, () => {
    push(`${label} connected`);
    setAdding(false);
    // The card's connected state, the health pill and every other surface that
    // reads this person's backends come from the loader, not from the poll.
    void revalidator.revalidate();
  });

  // The confirm asks about an account on screen, so it goes when that account
  // does, or when a sign-in under way takes the card's accounts off it. A
  // confirmed Disconnect closes it itself (ruling 459). An account
  // disconnected in another tab while its "Disconnect …?" was open here kept
  // the dialog open over an account that no longer existed while others
  // remained; with none left, or a sign-in from another tab in their place,
  // the dialog went with the accounts but this state stayed, and the next load
  // that showed an account opened it again with nobody asking. Matched by id,
  // since every load brings fresh objects. Adjusted during render, React's
  // pattern for state a prop invalidates, not in an effect.
  if (
    confirmDisconnect &&
    (running || !accounts.some((account) => account.id === confirmDisconnect.id))
  ) {
    setConfirmDisconnect(null);
  }

  // A completed rename or saved key closes what the person had open for it.
  // Settled on the RESULT, so a refusal leaves the field as it was. Not the
  // disconnect dialog: ConfirmDialog closes it once the Disconnect is
  // confirmed (ruling 459), whatever the answer; the account's own Disconnect
  // button carries the request, and the toast or the inline error says what
  // happened.
  useFetcherResult(fetcher, (result) => {
    if (!result.ok) return;
    if (result.intent === "backend-account-rename") setRenaming(null);
    if (result.intent === "backend-set-key") {
      setPaste(null);
      setAdding(false);
    }
  });

  const card: CardControls = {
    backend,
    label,
    methods,
    limits,
    request: cardRequest(fetcher, backend),
    submit,
    startSignIn: (method, account) => {
      if (account) submit({ intent: "backend-login-start", backend, method, account });
      else submit({ intent: "backend-login-start", backend, method });
    },
    paste,
    setPaste,
    renaming,
    setRenaming,
    confirmDisconnect,
    setConfirmDisconnect,
    adding,
    setAdding,
    managing,
    setManaging,
    picker,
    addingBox,
    managingBox,
    openSection,
  };

  return (
    <div className="cred-card">
      <div className="cred-top">
        {/* Ruling 625: the backend's own mark (Claude's sparkle, Codex's
            chip), as every other surface draws it; the name beside it is the
            text, so the tile is decorative. */}
        <AgentGlyph backend={backend} decorative />
        <span className="cred-name">{label}</span>
        <span className="fine push">{cardBadge(running, connected)}</span>
      </div>

      {/* A failed sign-in is reported ALONGSIDE whatever is connected, never
          instead of it: a person whose key still works must not be told they
          have nothing because one browser flow timed out. */}
      {!running && login?.state === "failed" && <FailedSignIn login={login} card={card} />}

      {running && login ? (
        <SignInUnderWay login={login} accounts={accounts} card={card} />
      ) : active ? (
        <AccountInUse data={data} active={active} others={others} card={card} />
      ) : (
        <NoAccountYet card={card} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- panel

export function AgentAccountsPanel({
  backends,
  fetcher,
  submit,
  targeted = false,
}: {
  backends: ProfileBackend[];
  fetcher: AccountsFetcher;
  submit: (fields: Record<string, string>) => void;
  /** Ruling 532: the URL names this panel, so it wears the landing ring. */
  targeted?: boolean;
}) {
  useAccountsToast(fetcher);
  const error = accountsError(fetcher);
  return (
    <div
      className="panel"
      id={AGENT_ACCOUNTS_ANCHOR}
      tabIndex={-1}
      data-targeted={targeted || undefined}
    >
      <div className="panel-head">
        <Icon name="cpu" />
        <h2>Agent accounts</h2>
      </div>
      {backends.map((data) => (
        <AgentAccountCard
          key={data.backend}
          data={data}
          fetcher={fetcher}
          submit={submit}
        />
      ))}
      {error && (
        <div className="login-err spaced" role="alert">
          <Icon name="alert" />
          {error}
        </div>
      )}
      <div className="pol-note after last">
        <Icon name="lock" />
        <span>
          Viberr never sees your sign-in tokens: the vendor&apos;s own client
          keeps them in your runtime home on this server. API keys are stored
          sealed. Nothing here is shared with other people.
        </span>
      </div>
    </div>
  );
}
