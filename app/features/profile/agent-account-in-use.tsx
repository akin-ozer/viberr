import { ConfirmDialog } from "~/ui/confirm-dialog";
import { Icon } from "~/ui/icon";
import { LocalCalendarDate, LocalDayDotTime } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { utcDayKey } from "~/shared/dates/format";
import { AccountPicker } from "./agent-account-picker";
import {
  accountKindWord,
  readableDate,
  SIGN_IN_CONNECTED,
  usagePillKind,
  usageText,
  VENDOR,
} from "./agent-accounts-derive";
import {
  AccountRename,
  ConnectWays,
  ManageButtons,
  SignInButtons,
  type CardControls,
} from "./agent-accounts-regions";
import type {
  ProfileBackend,
  ProfileBackendAccount,
  ProfileBackendRefusal,
} from "./profile-query.server";

/**
 * An agent account card with an account in use (ruling 695(e), the split of
 * `agent-accounts-panel.tsx` along the task page's recipe): the picker, that
 * account's health, usage and last refusal, its controls, and what the
 * picker's menu opens. Hook-free: the card owns the state and the picker owns
 * its own, so the picker's ids are what they were.
 */
export function AccountInUse({
  data,
  active,
  others,
  card,
}: {
  data: ProfileBackend;
  active: ProfileBackendAccount;
  others: ProfileBackendAccount[];
  card: CardControls;
}) {
  const { health, accounts, limits, usage } = data;
  // Ruling 130(d) (pass 34, F34-1): the last refusal Viberr OBSERVED on this
  // person's own account. The card used to say "connected · verified" while
  // every run on the account was refused with a 403.
  const lastRefusal = data.lastRefusal;
  const { backend, label, request } = card;
  return (
    <>
      {/* Ruling 616: which account runs bill is the picker's to say and
          to change; the line under it is that account's health. */}
      <AccountPicker
        label={label}
        accounts={accounts}
        active={active}
        maxAccounts={limits.maxAccounts}
        busy={request.busy}
        switchingTo={request.inFlight === "backend-account-switch" ? request.inFlightAccount : null}
        triggerRef={card.picker}
        onSwitch={(account) => card.submit({ intent: "backend-account-switch", backend, account })}
        onAdd={() => card.openSection("adding")}
        onManage={others.length > 0 ? () => card.openSection("managing") : null}
      />
      <AccountHealth health={health} />
      <AccountPills health={health} lastRefusal={lastRefusal} usage={usage} />
      {usage ? <UsageNote usage={usage} label={label} backend={backend} /> : null}
      {/* Design pass 2026-09-08: a forty-word sentence is prose, not a
          datum — as a `.kv-row` value it sat right-aligned across the
          card's width with no measure. It is the sheet's note idiom now
          (icon, sentence, 70ch), with the label folded in as its lead. */}
      {lastRefusal ? <RefusalNote refusal={lastRefusal} label={label} /> : null}
      <div className="cred-manage">
        {/* The health detail for a vanished credential file ends "Sign in
            again on your Profile → Agent accounts", which is THIS card: so
            the card has to carry the sign-in it names, or the only way out
            of a wiped runtime volume would be to guess that Disconnect
            comes first. Ruling 507: into THIS account's own home, when it
            is a sign-in; a pasted key never goes missing. */}
        {!health.available && health.kind === "login" && (
          <SignInButtons account={active.id} lead={false} card={card} />
        )}
        <ManageButtons account={active} card={card} />
      </div>
      <AccountRename account={active} card={card} />

      {/* Ruling 616: the person's other accounts on this backend, opened
          from the picker's menu, which is also where switching to one
          lives. Each is renamed, signed in again or disconnected where it
          stands: making one the account in use only to disconnect it
          would bill any run that started in between. */}
      {card.managing && others.length > 0 ? <OtherAccounts others={others} card={card} /> : null}

      {/* Ruling 616: opened from the picker's menu, which says when the
          ceiling leaves no room for another. */}
      {card.adding ? <AddAccount kept={accounts.length} card={card} /> : null}
      {card.confirmDisconnect && (
        <DisconnectConfirm
          account={card.confirmDisconnect}
          kept={accounts.length}
          active={active}
          others={others}
          card={card}
        />
      )}
    </>
  );
}

/** The account in use: how it was connected and when, and why it is not
 *  available when it is not. */
function AccountHealth({ health }: { health: ProfileBackend["health"] }) {
  const connectedOn = readableDate(health.connectedAt);
  return (
    <div className={health.available ? "cred-ok" : "cred-warn"}>
      <Icon name={health.available ? "check" : "alert"} />
      <span>
        {health.kind === "login" && health.method
          ? SIGN_IN_CONNECTED[health.method]
          : health.kind === "access_token"
            ? "Connected via workspace access token"
            : `Connected via API key · ending in ${health.secretSuffix ?? ""}`}
        {connectedOn ? <> on <LocalCalendarDate iso={connectedOn} /></> : ""}.
        {health.available ? "" : ` ${health.detail ?? ""}`}
      </span>
    </div>
  );
}

/** The account in use as pills: verified or not, the last refusal, and the
 *  usage reading. */
function AccountPills({
  health,
  lastRefusal,
  usage,
}: {
  health: ProfileBackend["health"];
  lastRefusal: ProfileBackendRefusal | null;
  usage: ProfileBackend["usage"];
}) {
  const verifiedOn = readableDate(health.verifiedAt);
  return (
    <div className="scope-chips">
      {health.available ? (
        verifiedOn ? (
          <Pill kind="ready" sm>
            verified <LocalCalendarDate iso={verifiedOn} />
          </Pill>
        ) : (
          <Pill kind="neutral" sm>
            unverified
          </Pill>
        )
      ) : (
        <Pill kind="risk" sm>
          sign-in file missing
        </Pill>
      )}
      {lastRefusal?.kind === "credential" ? (
        <Pill kind="risk" sm>
          refused by the provider · <LocalDayDotTime iso={lastRefusal.observedAt} />
        </Pill>
      ) : lastRefusal?.kind === "quota" ? (
        <Pill kind="neutral" sm>
          usage window spent
          {lastRefusal.resetsAt ? (
            <>
              {" "}· reopens <RefusalReset refusal={lastRefusal} />
            </>
          ) : null}
        </Pill>
      ) : null}
      {/* Ruling 294: the reading this person's own runs reported. Ruling
          146(a) already said readings "are already rendered per person on
          Insights ... and on Profile, which is where a fact about
          somebody's account belongs" — Profile never rendered one, so
          this closes a drift rather than opening a disclosure. Scoped to
          the viewer in `ownReading`, which matters more here than on
          Insights: that page is org-admin gated, and this card is the
          first non-admin surface to carry a utilization figure at all. */}
      {usage ? (
        <Pill kind={usagePillKind(usage)} sm>
          {usageText(usage)}
        </Pill>
      ) : null}
    </div>
  );
}

/**
 * Pass 34 review: a reset the provider gave in WORDS is a UTC calendar day, not
 * a minute. Rendering it as a local time claimed precision the record never
 * had (and could name the wrong day); `exact` and `clock` are real instants and
 * keep their hour, viewer-local after hydration.
 */
function RefusalReset({ refusal }: { refusal: ProfileBackendRefusal }) {
  if (!refusal.resetsAt) return null;
  return refusal.resetsAtPrecision === "exact" || refusal.resetsAtPrecision === "clock" ? (
    <LocalDayDotTime iso={refusal.resetsAt} />
  ) : (
    <>{utcDayKey(refusal.resetsAt)} (UTC)</>
  );
}

/** Ruling 294: the usage reading's note, what it is and how old. */
function UsageNote({
  usage,
  label,
  backend,
}: {
  usage: NonNullable<ProfileBackend["usage"]>;
  label: string;
  backend: ProfileBackend["backend"];
}) {
  return (
    <div className="pol-note after" data-usage={usage.rateLimitType || "window"}>
      <Icon name="clock" />
      <span>
        <strong>Usage</strong>
        {" · "}
        Observed <LocalDayDotTime iso={usage.observedAt} />, from the last{" "}
        {label} run billed to this account. Viberr cannot ask{" "}
        {VENDOR[backend]} how much of a window is left, so this is the
        last figure a run reported and not a live reading: it moves when
        a run reports another.
        {usage.resetsAt && usage.windowReset ? (
          // Ruling 481(d) (F40-50): past tense once the reset has
          // passed. "The window resets 03:30" at 09:00 claimed a
          // closed window was about to reopen.
          <>
            {" "}That window reset <LocalDayDotTime iso={usage.resetsAt} />, and
            no {label} run has reported a reading since.
          </>
        ) : usage.resetsAt ? (
          <>
            {" "}The window resets <LocalDayDotTime iso={usage.resetsAt} />.
          </>
        ) : null}
        {usage.isUsingOverage && !usage.windowReset
          ? " This account is running on overage."
          : ""}
      </span>
    </div>
  );
}

/** Ruling 130(d): the last refusal Viberr observed on the account in use. */
function RefusalNote({ refusal, label }: { refusal: ProfileBackendRefusal; label: string }) {
  return (
    <div className="pol-note after last" data-refusal={refusal.kind}>
      <Icon name="alert" />
      <span>
        <strong>
          {refusal.kind === "credential" ? "Last refusal" : "Usage window"}
        </strong>
        {" · "}
        {refusal.kind === "credential" ? (
          <>
            Refused by the provider on{" "}
            <LocalDayDotTime iso={refusal.observedAt} />:{" "}
            {refusal.providerText} This is the last refusal Viberr
            observed on this account; any completed {label} run retires
            it, as does switching to or connecting a different {label}{" "}
            account here, so its absence is not proof the account works.
          </>
        ) : (
          <>
            Spent as of <LocalDayDotTime iso={refusal.observedAt} />
            {refusal.resetsAt ? (
              <>
                ; reopens <LocalDayDotTime iso={refusal.resetsAt} />
              </>
            ) : null}
            . Any completed {label} run retires this notice, as does
            switching to or connecting a different {label} account here;
            until then, runs billed to this account are refused.
          </>
        )}
      </span>
    </div>
  );
}

/** Ruling 616: the other accounts' management, each where it stands. */
function OtherAccounts({ others, card }: { others: ProfileBackendAccount[]; card: CardControls }) {
  const { backend } = card;
  return (
    <div
      className="acct-list"
      role="group"
      aria-labelledby={`agentacc-${backend}-others`}
      tabIndex={-1}
      ref={card.managingBox}
    >
      <div className="acct-list-head">
        <h3 className="flabel" id={`agentacc-${backend}-others`}>
          Other {card.label} accounts
        </h3>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            card.setManaging(false);
            card.setRenaming(null);
            card.picker.current?.focus();
          }}
        >
          Done
        </button>
      </div>
      <div className="conn-list">
        {others.map((account) => {
          const on = readableDate(account.health.connectedAt);
          return (
            <div className="conn-row" key={account.id} data-account={account.id}>
              {/* Ruling 515: the name and its facts, then the buttons
                  under them, as the account in use reads above. The
                  name keeps one line; the title holds all of it when
                  a narrow row ends it in an ellipsis. */}
              <div className="conn-main">
                <b title={account.name}>{account.name}</b>
                <span className="sub">
                  {accountKindWord(account.health)}
                  {on ? (
                    <>
                      {" "}· connected <LocalCalendarDate iso={on} />
                    </>
                  ) : null}
                  {account.health.available ? "" : " · sign-in file missing"}
                </span>
              </div>
              <div className="cred-manage">
                {!account.health.available && account.health.kind === "login" ? (
                  <SignInButtons account={account.id} lead={false} card={card} />
                ) : null}
                <ManageButtons account={account} card={card} />
              </div>
              <AccountRename account={account} card={card} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Ruling 616: another account, through the same sign-in and paste methods;
 *  `kept` is how many the person has now. */
function AddAccount({ kept, card }: { kept: number; card: CardControls }) {
  const { backend } = card;
  return (
    <div
      className="acct-list"
      role="group"
      aria-labelledby={`agentacc-${backend}-adding`}
      tabIndex={-1}
      ref={card.addingBox}
    >
      <h3 className="flabel" id={`agentacc-${backend}-adding`}>
        Add another {card.label} account
      </h3>
      <p className="fine">
        It becomes the account your runs use; the{" "}
        {kept === 1 ? "one" : "ones"} you have stay connected, and
        switching back needs no sign-in.
      </p>
      <ConnectWays card={card} />
      <div className="cred-manage">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            card.setAdding(false);
            card.setPaste(null);
            card.picker.current?.focus();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Ruling 481(b): what a Disconnect asks first, and who runs bill after it. */
function DisconnectConfirm({
  account,
  kept,
  active,
  others,
  card,
}: {
  account: ProfileBackendAccount;
  kept: number;
  active: ProfileBackendAccount;
  others: ProfileBackendAccount[];
  card: CardControls;
}) {
  const { label } = card;
  return (
    <ConfirmDialog
      screenLabel="Disconnect agent account dialog"
      title={kept > 1 ? `Disconnect ${account.name}?` : `Disconnect ${label}?`}
      body={
        <>
          Viberr signs this server out of{" "}
          {kept > 1 ? <>this {label} account</> : <>your {label} account</>} and
          deletes the stored credential.{" "}
          {!account.active ? (
            <>Your runs keep using {active.name}.</>
          ) : others.length > 0 ? (
            <>
              Your runs switch to {others[0]!.name}, the {label} account you used
              before it.
            </>
          ) : (
            <>
              Tasks you own and your controller conversations can&apos;t start a{" "}
              {label} run until you connect again.
            </>
          )}
        </>
      }
      confirmLabel={kept > 1 ? `Disconnect ${account.name}` : `Disconnect ${label}`}
      busy={card.request.busy}
      onCancel={() => card.setConfirmDisconnect(null)}
      onConfirm={() => {
        // Close any paste form the card was showing before this
        // connection existed, so disconnecting does not re-reveal a
        // half-typed key field.
        card.setPaste(null);
        card.setRenaming(null);
        card.submit({ intent: "backend-disconnect", backend: card.backend, account: account.id });
      }}
    />
  );
}
