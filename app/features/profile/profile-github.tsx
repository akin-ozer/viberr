import { ConfirmDialog } from "~/ui/confirm-dialog";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";

/**
 * Profile → GitHub identity's personal OAuth card (ruling 696(e), the split of
 * `profile-page.tsx` along the task page's recipe): the scopes, and either the
 * connection with its Disconnect or the Connect. Hook-free: `ProfileGithub`
 * owns the connect, the confirm and the fetcher, and hands each in.
 *
 * This is the card's CONTENTS. Its `.cred-card` box stays in `ProfileGithub`,
 * where the page chooses between it and the quiet note, so a revalidation that
 * flips that choice keeps the same `<div>` node, as it did before the split.
 */
export function GithubOAuthIdentity({
  connected,
  handle,
  email,
  busy,
  confirming,
  onConfirming,
  onDisconnect,
  connectBusy,
  onConnect,
}: {
  connected: boolean;
  handle: string | null;
  email: string;
  /** The disconnect is in flight. */
  busy: boolean;
  /** Ruling 481(b): the Disconnect is asking first. */
  confirming: boolean;
  onConfirming: (confirming: boolean) => void;
  onDisconnect: () => void;
  /** Ruling 368: the Connect is in flight, until the redirect. */
  connectBusy: boolean;
  onConnect: () => void;
}) {
  return (
    <>
      <div className="cred-top">
        <Icon name="github" />
        <span className="cred-name">Personal OAuth identity</span>
        {/* "not connected" in words: the "−" this slot used to show read as a
            collapse control that did nothing. */}
        <span className="fine push">{connected ? "oauth" : "not connected"}</span>
      </div>
      <div className="scope-chips">
        <span className={"scope-chip" + (connected ? "" : " miss")}>
          <Icon name={connected ? "check" : "alert"} />
          read:user
        </span>
        <span className={"scope-chip" + (connected ? "" : " miss")}>
          <Icon name={connected ? "check" : "alert"} />
          user:email
        </span>
      </div>
      <GithubStatus
        connected={connected}
        handle={handle}
        email={email}
        busy={busy}
        confirming={confirming}
        onConfirming={onConfirming}
        onDisconnect={onDisconnect}
        connectBusy={connectBusy}
        onConnect={onConnect}
      />
    </>
  );
}

/**
 * Connected: whom the audit records name, and the Disconnect behind its
 * confirm. Not connected: what that costs, and the Connect.
 *
 * One component with the choice at its root, never one per state: the two
 * boxes line up as glyph, sentence, button, so when a revalidation flips the
 * connection React keeps the box, the glyph, the sentence and the button and
 * the focused Disconnect simply becomes the Connect (and back). As two
 * components the button was replaced, and the confirm's focus return found its
 * opener gone and dropped a keyboard user on <body>.
 */
function GithubStatus({
  connected,
  handle,
  email,
  busy,
  confirming,
  onConfirming,
  onDisconnect,
  connectBusy,
  onConnect,
}: {
  connected: boolean;
  handle: string | null;
  email: string;
  busy: boolean;
  confirming: boolean;
  onConfirming: (confirming: boolean) => void;
  onDisconnect: () => void;
  connectBusy: boolean;
  onConnect: () => void;
}) {
  return connected ? (
    <div className="cred-ok">
      <Icon name="check" />
      <span>
        Connected. Your approvals, acceptances, and runtime-session
        opens are attributed to{" "}
        <strong>
          {handle ? `@${handle}` : email}
        </strong>{" "}
        in audit records.
      </span>
      <button
        type="button"
        // Ruling 149: disconnecting an identity is destructive.
        className="btn ghost sm push danger"
        // Ruling 481(b) (F40-49): asks first, like the agent account
        // Disconnect beside it.
        onClick={() => onConfirming(true)}
      >
        Disconnect
      </button>
      {confirming && (
        <ConfirmDialog
          screenLabel="Disconnect GitHub dialog"
          title="Disconnect GitHub?"
          body={
            <>
              Your approvals, acceptances, and runtime-session opens are
              attributed to your workspace identity instead of{" "}
              {handle ? `@${handle}` : "your GitHub account"}{" "}
              in audit records until you connect again.
            </>
          }
          confirmLabel="Disconnect GitHub"
          busy={busy}
          onCancel={() => onConfirming(false)}
          onConfirm={onDisconnect}
        />
      )}
    </div>
  ) : (
    <div className="cred-warn">
      <Icon name="alert" />
      {/* Ruling 154 (pass 35, G35-3): an org admin can link the handle
          on a deployment where GitHub sign-in IS configured too, so this
          card can no longer say the approvals go unmatched. The line
          above already reads "@handle · linked by an org admin". */}
      <span>
        {handle ? (
          <>
            Not connected. An org admin linked{" "}
            <strong>@{handle}</strong>, so your approvals on
            review pull requests already count as the review verdict.
            Connecting GitHub also records your own actions under that
            identity.
          </>
        ) : (
          <>
            Not connected. Actions record under your workspace identity
            only, and your GitHub review approvals can&apos;t be matched back
            to you.
          </>
        )}
      </span>
      <button
        type="button"
        className="btn sm push"
        disabled={connectBusy}
        aria-busy={connectBusy || undefined}
        onClick={onConnect}
      >
        <GlyphSwap rest="github" alt="loader" on={connectBusy} spinAlt />
        {connectBusy ? "Connecting…" : "Connect"}
      </button>
    </div>
  );
}
