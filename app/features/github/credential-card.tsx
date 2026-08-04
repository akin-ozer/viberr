import { useState, type ReactNode } from "react";
import type {
  ProjectCredentialHealth,
  ScopeChip,
} from "~/server/secrets/pat-store.server";
import { Icon } from "~/ui/icon";
import { useDialog } from "~/ui/use-dialog";

/**
 * THE credential card (github-view spec §7.12: one component, used by the
 * GitHub view now and Settings → RepoSettings in Phase 9, so the two can't
 * drift). Markup is the mock's `.cred-card` verbatim; the footer action
 * slot is the only variation point ("Fix in Settings" here, "Grant scope"
 * in Settings — this page currently renders both, see the phase report).
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
  "configured" | "source" | "label" | "masked" | "scopes"
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
  /** Right-aligned footer action slot (Fix in Settings / Grant scope). */
  warnActions?: ReactNode;
  /** Always-visible manage row (attach / rotate / remove the credential). */
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
            No GitHub PAT is connected to this project — branch and PR sync
            stays offline until one is added.
          </span>
          {warnActions}
        </div>
        {manageActions}
      </div>
    );
  }

  const missing = credential.scopes.find((s) => !s.ok);
  // Owner ruling 2026-07-25: a chip is a PROVEN verdict — a scope header, a
  // live probe (writes via the empty-payload dry-run), or an open violation.
  // `assumed`/`unchecked` entries are not evidence, so they render as the
  // honest "unproven" line instead of a pseudo-check next to real ones.
  const proven = credential.scopes.filter(
    (s: ScopeChip) => s.source !== "assumed" && s.source !== "unchecked",
  );
  const unproven = credential.scopes.filter(
    (s: ScopeChip) => s.source === "assumed" || s.source === "unchecked",
  );
  // F15-01: NOTHING has been proven — a freshly-attached PAT nobody validated
  // (every chip "unchecked"), or a fine-grained token validated without repo
  // context (every chip "assumed"). The `assumed` shape dodged the old
  // all-"unchecked" test and fell straight through to the green footer, so a
  // card with zero evidence affirmed "Every provable scope verified". Zero
  // proven scopes is the unverified state, whatever the excuse.
  const unverified = proven.length === 0;
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
            {unproven.map((s) => s.id).join(", ")} unproven — verified on
            first use
          </span>
        )}
      </div>
      {connectionAuth === "revoked" || connectionAuth === "expired" ? (
        <div className="cred-warn">
          <Icon name="alert" />
          <span>
            Token {connectionAuth} — re-authenticate this connection to
            resume branch and PR sync. Its granted scopes don't apply while
            the token is invalid.
          </span>
          {warnActions}
        </div>
      ) : missing ? (
        <div className="cred-warn">
          <Icon name="alert" />
          <span>
            Missing <code className="mono">{missing.id}</code> — PR status
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
      ) : unverified ? (
        <div className="cred-warn">
          <Icon name="alert" />
          <span>
            Credential attached — scopes not yet verified against GitHub
            {unproven.length > 0
              ? ` (${unproven.map((s) => s.id).join(", ")})`
              : ""}
            . Run Grant scope to validate.
          </span>
          {warnActions}
        </div>
      ) : (
        <div className="cred-ok">
          <Icon name="check" />
          {unproven.length > 0
            ? "Every provable scope verified. Secrets stay isolated from task records and timelines."
            : "All required scopes proven. Secrets stay isolated from task records and timelines."}
        </div>
      )}
      {manageActions}
    </div>
  );
}

function RemoveCredentialDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { ref, close } = useDialog(onCancel);
  return (
    <dialog
      ref={ref}
      className="confirm-card"
      role="alertdialog"
      aria-label="Remove credential?"
    >
      <div className="confirm-icon">
        <Icon name="alert" />
      </div>
      <h3>Remove this credential?</h3>
      <p>
        Branch and PR sync go offline until a credential is attached again.
        Nothing already pushed to GitHub is affected, and the token itself stays
        in org settings.
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          Remove credential
        </button>
      </div>
    </dialog>
  );
}

/**
 * The attach / rotate / remove manage row shared by the GitHub view and
 * project Settings (finding #13). `configured` (a real PAT is bound) shows
 * Rotate + Remove; otherwise a single Attach. admin|maintainer only — the
 * parent gates `canManage`. Remove goes through a confirm.
 */
export function CredentialManageActions({
  configured,
  canManage,
  busy,
  onSet,
  onClear,
}: {
  configured: boolean;
  canManage: boolean;
  busy: boolean;
  /** Attach (unconfigured) or rotate (configured) → set-credential. */
  onSet: () => void;
  /** Remove → clear-credential (after the confirm). */
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!canManage) return null;
  return (
    <div className="cred-manage">
      <button
        type="button"
        className="btn ghost sm"
        onClick={onSet}
        disabled={busy}
        title={
          configured
            ? "Re-bind to the default connection's PAT"
            : "Bind the default connection's PAT to this project"
        }
      >
        <Icon name={configured ? "refresh" : "lock"} />
        {configured ? "Rotate credential" : "Attach credential"}
      </button>
      {configured && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setConfirming(true)}
          disabled={busy}
          title="Unbind the credential from this project"
        >
          <Icon name="x" />
          Remove credential
        </button>
      )}
      {confirming && (
        <RemoveCredentialDialog
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onClear();
          }}
        />
      )}
    </div>
  );
}
