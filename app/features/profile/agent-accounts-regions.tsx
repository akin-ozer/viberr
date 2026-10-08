import type { Dispatch, RefObject, SetStateAction } from "react";
import type { LoginMethod } from "~/server/runtimes/backend-credentials.server";
import { Icon } from "~/ui/icon";
import { PasteForm, RenameForm } from "./agent-account-forms";
import {
  loginAccount,
  PASTE_LABEL,
  SIGN_IN_LABEL,
  type CardRequest,
} from "./agent-accounts-derive";
import { SignInSteps } from "./agent-sign-in-steps";
import type { ProfileBackend, ProfileBackendAccount } from "./profile-query.server";

/**
 * An agent account card's regions (ruling 696(e), the split of
 * `agent-accounts-panel.tsx` along the task page's recipe): the failed and the
 * running sign-in, the card with no account yet, and the controls every
 * account carries. Each takes the slot its markup held in the card and calls
 * no hook, so the card's markup, and every id React derives from its place in
 * the tree, are what they were.
 */

/**
 * What a card's regions act through (ruling 696(e)). The card owns every
 * piece of state here (ruling 507: the account a Disconnect is asking about,
 * the account whose name is being edited, whether "Add another account" is
 * open; ruling 616: and whether the other accounts' management is) and hands
 * it down with its posts and the request in flight.
 */
export interface CardControls {
  backend: ProfileBackend["backend"];
  label: string;
  methods: ProfileBackend["methods"];
  limits: ProfileBackend["limits"];
  request: CardRequest;
  submit: (fields: Record<string, string>) => void;
  /** Start a sign-in: into a new account, or (`account`) into that existing
   *  sign-in again (ruling 507). */
  startSignIn: (method: LoginMethod, account: string) => void;
  paste: "api_key" | "access_token" | null;
  setPaste: Dispatch<SetStateAction<"api_key" | "access_token" | null>>;
  renaming: string | null;
  setRenaming: Dispatch<SetStateAction<string | null>>;
  /** The id of the account a Disconnect is asking about. */
  confirmDisconnect: string | null;
  setConfirmDisconnect: Dispatch<SetStateAction<string | null>>;
  adding: boolean;
  setAdding: Dispatch<SetStateAction<boolean>>;
  managing: boolean;
  setManaging: Dispatch<SetStateAction<boolean>>;
  /** Ruling 616: where closing what the picker's menu opened hands the focus. */
  picker: RefObject<HTMLButtonElement | null>;
  addingBox: RefObject<HTMLDivElement | null>;
  managingBox: RefObject<HTMLDivElement | null>;
  /** Opens "Add another account" or the others' management, and focuses it. */
  openSection: (box: "adding" | "managing") => void;
}

/** A failed sign-in: the vendor's sentence and a Start again for that flow. */
export function FailedSignIn({
  login,
  card,
}: {
  login: NonNullable<ProfileBackend["login"]>;
  card: CardControls;
}) {
  // Ruling 507: again into the same account the failed flow was for; a new
  // account's attempt starts a new one.
  const account = login.existingAccount ? login.accountId : "";
  const starting = card.request.starting(login.method, account);
  return (
    <>
      <div className="login-err spaced" role="alert">
        <Icon name="alert" />
        {login.error ?? `${card.label} sign-in did not finish.`}
      </div>
      <div className="cred-manage">
        <button
          type="button"
          className="btn sm"
          disabled={card.request.busy}
          aria-busy={starting || undefined}
          onClick={() => card.startSignIn(login.method, account)}
        >
          {starting && <Icon name="loader" className="spin" />}
          {starting ? "Starting sign-in…" : "Start again"}
        </button>
      </div>
    </>
  );
}

/** A sign-in under way, and which account it is for when the card already
 *  has one. */
export function SignInUnderWay({
  login,
  accounts,
  card,
}: {
  login: NonNullable<ProfileBackend["login"]>;
  accounts: ProfileBackendAccount[];
  card: CardControls;
}) {
  const { label } = card;
  const forAccount = loginAccount(login, accounts);
  return (
    <>
      {/* Ruling 507: which account the sign-in is for, when the card
          already has one — the steps below look the same either way. */}
      {accounts.length > 0 ? (
        <p className="fine spaced">
          {forAccount
            ? `Signing in to ${forAccount.name} again.`
            : `Adding another ${label} account. The ${accounts.length === 1 ? "one" : "ones"} you have stay${accounts.length === 1 ? "s" : ""} connected.`}
        </p>
      ) : null}
      <SignInSteps
        key={login.id}
        backend={card.backend}
        label={label}
        login={login}
        busy={card.request.busy}
        inFlight={card.request.inFlight}
        submit={card.submit}
      />
    </>
  );
}

/** A card with no account yet: what it is for, and the ways to connect one. */
export function NoAccountYet({ card }: { card: CardControls }) {
  return (
    <>
      {/* Design pass 2026-09-08: not connected is the RESTING state of a
          fresh account, not an alarm. The badge above already says it, so
          the sentence is the sheet's quiet note rather than an amber box
          inside a card inside a panel; a failed sign-in still reports in
          `.cred-warn` above. */}
      <div className="pol-note after last">
        <Icon name="user" />
        <span>
          Tasks you own and your controller conversations run on your
          own {card.label} account.
        </span>
      </div>
      <ConnectWays card={card} />
    </>
  );
}

/** The ways to connect an account: every sign-in the vendor offers, then the
 *  paste methods, and the paste form when one is open. The whole of a fresh
 *  card, and what "Add another account" opens on a connected one. */
export function ConnectWays({ card }: { card: CardControls }) {
  const { paste, setPaste } = card;
  return (
    <>
      <div className="cred-manage">
        <SignInButtons account="" lead card={card} />
        {card.methods.paste.map((kind) => (
          <button
            key={kind}
            type="button"
            className="btn ghost sm"
            onClick={() => setPaste(paste === kind ? null : kind)}
          >
            {PASTE_LABEL[kind]}
          </button>
        ))}
      </div>
      {paste && (
        <PasteForm
          backend={card.backend}
          kind={paste}
          busy={card.request.busy}
          onCancel={() => setPaste(null)}
          submit={card.submit}
        />
      )}
    </>
  );
}

/** A "Sign in with …" button for each vendor flow: into a new account, or
 *  (`account`) into that existing sign-in again. The vendor's own sign-in
 *  leads when `lead` is set; the other flows stay neutral. */
export function SignInButtons({
  account,
  lead,
  card,
}: {
  account: string;
  lead: boolean;
  card: CardControls;
}) {
  const { request } = card;
  return (
    <>
      {card.methods.signIn.map((method, i) => (
        <button
          key={method}
          type="button"
          className={"btn sm" + (lead && i === 0 ? " primary" : "")}
          disabled={request.busy}
          aria-busy={request.starting(method, account) || undefined}
          onClick={() => card.startSignIn(method, account)}
        >
          {request.starting(method, account) && <Icon name="loader" className="spin" />}
          {request.starting(method, account) ? "Starting sign-in…" : SIGN_IN_LABEL[method]}
        </button>
      ))}
    </>
  );
}

/** The two manage buttons every account carries, the active one included. */
export function ManageButtons({
  account,
  card,
}: {
  account: ProfileBackendAccount;
  card: CardControls;
}) {
  const { request } = card;
  return (
    <>
      <button
        type="button"
        className="btn ghost sm"
        disabled={request.busy}
        onClick={() => card.setRenaming(card.renaming === account.id ? null : account.id)}
      >
        Rename
      </button>
      <button
        type="button"
        // Ruling 149: dropping the stored credential is destructive.
        className="btn ghost sm danger"
        disabled={request.busy}
        aria-busy={request.accountBusy("backend-disconnect", account.id) || undefined}
        // Ruling 481(b) (F40-49): it asks first, like every other one-way
        // control (ruling 458(f)). One tap used to sign the vendor session
        // out, with no undo short of a fresh sign-in.
        onClick={() => card.setConfirmDisconnect(account.id)}
      >
        {request.accountBusy("backend-disconnect", account.id) && <Icon name="loader" className="spin" />}
        {request.accountBusy("backend-disconnect", account.id) ? "Disconnecting…" : "Disconnect"}
      </button>
    </>
  );
}

/** The rename form, under the account whose name is being edited. */
export function AccountRename({
  account,
  card,
}: {
  account: ProfileBackendAccount;
  card: CardControls;
}) {
  return card.renaming === account.id ? (
    <RenameForm
      backend={card.backend}
      account={account}
      maxLength={card.limits.maxLabelLength}
      busy={card.request.busy}
      inFlight={card.request.accountBusy("backend-account-rename", account.id)}
      onCancel={() => card.setRenaming(null)}
      submit={card.submit}
    />
  ) : null;
}
