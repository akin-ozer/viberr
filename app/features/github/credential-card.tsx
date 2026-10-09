import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  ProjectCredentialHealth,
  ScopeChip,
} from "~/server/secrets/pat-store.server";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";

/**
 * THE credential card (github-view spec §7.12: one component, used by the
 * GitHub view (`github-view.tsx`) and by the project settings page's
 * Repository panel (`RepoCredentialSlot`, `settings-page.tsx`), so the two
 * can't drift). Markup is the mock's `.cred-card` verbatim; the two differ
 * only in what they hand it: the footer actions (Re-check scopes on both,
 * plus "Fix in Settings" on the GitHub view), the manage row, and, from the
 * GitHub view alone, the connection probe's token health (`connectionAuth`).
 *
 * States:
 * - source "pat" → cred-top + scope chips + warn/ok footer (chips render the
 *   server verdicts directly — the mock's `s.ok || scopeGranted` hack is
 *   deleted per spec §7.2).
 * - source "none" → the settings-spec §7.11 degraded mode: a "connect
 *   credential" affordance instead of scope chips (reuses cred-warn). A project
 *   with a credentialPolicy but no bound PAT also lands here — a policy is not
 *   a credential (honest empty slate), so no fabricated card is shown.
 */

export type CredentialCardData = Pick<
  ProjectCredentialHealth,
  "configured" | "source" | "label" | "masked" | "scopes" | "advisories"
>;

export function CredentialCard({
  credential,
  onOpenTask,
  warnActions,
  manageActions,
  connectionAuth,
}: {
  credential: CredentialCardData;
  /** Opens the flagged task (the cred-warn `.keybtn`). */
  onOpenTask: (taskKey: string) => void;
  /** Right-aligned footer action slot (Fix in Settings / Re-check scopes).
   * The green footer carries it only while an advisory is open. */
  warnActions?: ReactNode;
  /** Always-visible manage row (attach / re-attach / remove the credential). */
  manageActions?: ReactNode;
  /** Live token auth health from the connection probe. When the token is
   * revoked/expired, the "all scopes granted" affirmation is suppressed — the
   * scopes a dead token was granted are moot, and showing both was
   * contradictory ("token revoked" pill next to "all scopes granted"). */
  connectionAuth?: "ok" | "revoked" | "expired";
}) {
  if (credential.source === "none") {
    return (
      <div className="cred-card">
        <div className="cred-top">
          <Icon name="lock" />
          <span className="cred-name">No credential configured</span>
        </div>
        <div className="cred-warn">
          <Icon name="alert" />
          <span>
            No GitHub PAT is connected to this project. Branch and PR sync
            stays offline until one is added.
          </span>
          {warnActions}
        </div>
        {manageActions}
      </div>
    );
  }

  const { missing, proven, unproven, unverified } = readScopes(
    credential.scopes,
  );
  return (
    <div className="cred-card">
      <div className="cred-top">
        <Icon name="lock" />
        <span className="cred-name">{credential.label}</span>
        <span className="mono push faint">
          {credential.masked}
        </span>
      </div>
      <div className="scope-chips">
        {proven.map((s: ScopeChip) => (
          <span className={"scope-chip" + (s.ok ? "" : " miss")} key={s.id}>
            <Icon name={s.ok ? "check" : "alert"} />
            {s.id}
          </span>
        ))}
        {!unverified && unproven.length > 0 && (
          <span className="sub self-center">
            {unproven.map((s) => s.id).join(", ")} unproven (verified on
            first use)
          </span>
        )}
      </div>
      {/* Ruling 221(a): advisories are facts about what this token cannot do,
          never a missing chip and never a validation failure. */}
      {credential.advisories.map((a) => (
        <div className="sub" key={a.id} data-advisory={a.id}>
          <Icon name="flag" />
          {a.text}
        </div>
      ))}
      <CredentialFooter
        connectionAuth={connectionAuth}
        missing={missing}
        unverified={unverified}
        unproven={unproven}
        advised={credential.advisories.length > 0}
        onOpenTask={onOpenTask}
        warnActions={warnActions}
      />
      {manageActions}
    </div>
  );
}

/** What a PAT card's scope chips prove (ruling 13(b), the split of
 *  `CredentialCard`): the first refused scope, the chips that are evidence,
 *  the ones that are not, and whether nothing at all is proven. */
function readScopes(scopes: ScopeChip[]) {
  const missing = scopes.find((s) => !s.ok);
  // Owner ruling 2026-07-25: a chip is a PROVEN verdict — a scope header, a
  // live probe (writes via the empty-payload dry-run), or an open violation.
  // Ruling 220: a repository-scoped chip's probe is this project's repository's
  // proof, a write Viberr made there included.
  // `assumed`/`unchecked` entries are not evidence, so they render as the
  // honest "unproven" line instead of a pseudo-check next to real ones.
  const proven = scopes.filter(
    (s: ScopeChip) => s.source !== "assumed" && s.source !== "unchecked",
  );
  const unproven = scopes.filter(
    (s: ScopeChip) => s.source === "assumed" || s.source === "unchecked",
  );
  // F15-01: NOTHING has been proven — a freshly-attached PAT nobody validated
  // (every chip "unchecked"), or a fine-grained token validated without repo
  // context (every chip "assumed"). The `assumed` shape dodged the old
  // all-"unchecked" test and fell straight through to the green footer, so a
  // card with zero evidence affirmed "Every provable scope verified". Zero
  // proven scopes is the unverified state, whatever the excuse.
  const unverified = proven.length === 0;
  return { missing, proven, unproven, unverified };
}

/**
 * A PAT card's footer (ruling 13(b), the split of `CredentialCard`): the one
 * warning that outranks the others (a dead token, then a refused scope, then
 * no proof at all), or the all-clear. Hook-free, in the slot the card's
 * ternary held.
 */
function CredentialFooter({
  connectionAuth,
  missing,
  unverified,
  unproven,
  advised,
  onOpenTask,
  warnActions,
}: {
  connectionAuth?: "ok" | "revoked" | "expired";
  missing: ScopeChip | undefined;
  unverified: boolean;
  unproven: ScopeChip[];
  /** The card carries at least one advisory. */
  advised: boolean;
  onOpenTask: (taskKey: string) => void;
  warnActions?: ReactNode;
}) {
  if (connectionAuth === "revoked" || connectionAuth === "expired") {
    return (
      <div className="cred-warn">
        <Icon name="alert" />
        <span>
          Token {connectionAuth}. Re-authenticate this connection to
          resume branch and PR sync. Its granted scopes don't apply while
          the token is invalid.
        </span>
        {warnActions}
      </div>
    );
  }
  if (missing) {
    return (
      <div className="cred-warn">
        <Icon name="alert" />
        <span>
          Missing <code className="mono">{missing.id}</code>. PR status
          can't auto-sync after merge.
          {missing.flaggedTaskKey ? " Flagged on" : ""}
        </span>
        {missing.flaggedTaskKey && (
          <button
            type="button"
            className="keybtn"
            onClick={() => onOpenTask(missing.flaggedTaskKey!)}
          >
            {missing.flaggedTaskKey}
          </button>
        )}
        {warnActions}
      </div>
    );
  }
  if (unverified) {
    return (
      <div className="cred-warn">
        <Icon name="alert" />
        <span>
          Credential attached. Scopes not yet verified against GitHub
          {unproven.length > 0
            ? ` (${unproven.map((s) => s.id).join(", ")})`
            : ""}
          . Use Re-check scopes to verify them.
        </span>
        {warnActions}
      </div>
    );
  }
  return (
    <div className="cred-ok">
      <Icon name="check" />
      <span>
        {unproven.length > 0
          ? "Every provable scope verified. Secrets stay isolated from task records and timelines."
          : "All required scopes proven. Secrets stay isolated from task records and timelines."}
      </span>
      {/* An advisory's scope (`workflow`, `checks:read`) is never required,
          so a card whose only problem is an advisory lands here. Its copy
          and the delivery remedies send the person to Re-check, and the
          pre-push refusal reads the cached header scopes: without the slot
          here, granting the scope on GitHub changed nothing short of
          rotating the credential. */}
      {advised && warnActions}
    </div>
  );
}

/** The remove confirm, on the shared `ConfirmDialog` (ruling 297). */
function RemoveCredentialDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      screenLabel="Credential removal dialog"
      title="Remove this credential?"
      body={
        <>
          Branch and PR sync go offline until a credential is attached again.
          Nothing already pushed to GitHub is affected, and the token itself stays
          in Instance settings.
        </>
      }
      confirmLabel="Remove credential"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/**
 * The attach / re-attach / remove manage row shared by the GitHub view and
 * project Settings (finding #13). `configured` (a real PAT is bound) shows
 * Re-attach + Remove; otherwise a single Attach. admin|maintainer only — the
 * parent renders it only for them. Remove goes through a confirm.
 *
 * Ruling 222 (F40-45): the configured button said "Rotate credential" and
 * rotated nothing. It binds the connection that matches the repository's owner
 * (or the default) again and re-checks it, so on a one-connection instance the
 * token that runs afterwards is byte for byte the one before, and someone
 * reacting to a leaked token was told it was rotated. It is named for what it
 * does, and the row says where a token IS replaced: a link to the bound
 * connection's Update token for an instance admin, a sentence for everyone
 * else (Instance settings is admin-only).
 */
export function CredentialManageActions({
  configured,
  inFlight,
  onSet,
  onClear,
  replaceHref = null,
}: {
  configured: boolean;
  /** Ruling 286: the intent the credential fetcher is carrying
   *  (`inFlightIntent`), null while it is idle. The button that started it
   *  shows the work; the other one only waits at the disabled step. */
  inFlight: string | null;
  /** Attach (unconfigured) or re-attach (configured) → set-credential. */
  onSet: () => void;
  /** Remove → clear-credential (after the confirm). */
  onClear: () => void;
  /** The bound connection's Update token (`replaceTokenHref`) when the reader
   *  is an instance admin; null (the default) otherwise. */
  replaceHref?: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const busy = inFlight !== null;
  const setting = inFlight === "set-credential";
  const clearing = inFlight === "clear-credential";
  return (
    <>
    <div className="cred-manage">
      <button
        type="button"
        className="btn ghost sm"
        onClick={onSet}
        disabled={busy}
        aria-busy={setting || undefined}
        title={
          configured
            ? "Bind the connection for this repository's owner (or the default) again and re-check it. It does not replace a token"
            : "Bind the GitHub connection for this repository's owner to this project"
        }
      >
        {/* Ruling 284 over ruling 286: the lock trades for the refresh mark
            once a credential is bound, and that resting cell trades for the
            spinning loader while this button's own request is in flight. */}
        <GlyphSwap rest="lock" alt="refresh" on={configured} busy={setting} />
        {configured
          ? setting
            ? "Re-attaching…"
            : "Re-attach connection"
          : setting
            ? "Attaching…"
            : "Attach credential"}
      </button>
      {configured && replaceHref && (
        <Link className="btn ghost sm" to={replaceHref}>
          <Icon name="sliders" />
          Replace token
        </Link>
      )}
      {configured && (
        <button
          type="button"
          // Ruling 278: unbinding the credential is destructive, and the
          // dialog it opens already commits in red.
          className="btn ghost sm danger"
          onClick={() => setConfirming(true)}
          disabled={busy}
          aria-busy={clearing || undefined}
          title="Unbind the credential from this project"
        >
          <GlyphSwap rest="x" alt="loader" on={clearing} spinAlt />
          {clearing ? "Removing…" : "Remove credential"}
        </button>
      )}
      {confirming && (
        <RemoveCredentialDialog
          onCancel={() => setConfirming(false)}
          onConfirm={onClear}
        />
      )}
    </div>
    {configured && !replaceHref && (
      <div className="sub" data-replace-token-note>
        Re-attaching never replaces a token. An instance admin replaces it in
        Instance settings, under GitHub connections.
      </div>
    )}
    </>
  );
}
