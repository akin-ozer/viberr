import { useState } from "react";
import type { AuthProviderView } from "~/server/org/org-view.server";
import { oauthCallbackUrl } from "~/shared/auth/auth-paths";
import { LocalCalendarDate } from "~/ui/local-time";
import { CopyGlyph } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { inFlightIntent } from "~/ui/in-flight";
import { Pill } from "~/ui/pill";
import { useCopied } from "~/ui/use-copied";
import { ConfirmDelete } from "./confirm-delete";
import { MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";
import { useOrgAction } from "./use-org-action";

/**
 * Sign-in & SSO tab (R19-16).
 *
 * The Allow-access modal offered "GitHub · off" / "Google · off" with a tooltip
 * saying the deployment had not configured them — true, and a dead end: the
 * only cure was an env var an admin could not set from the app. This tab is
 * that cure. Paste the client id + secret, PROVE them against the provider,
 * switch the method on; the running auth handler picks the change up on the
 * next request (`oauthConfigFingerprint`), so there is no restart.
 *
 * Three honesty rules the markup keeps:
 *  - the callback URL is SHOWN, because a provider app that does not carry it
 *    fails at real sign-in no matter how good the credentials are;
 *  - a passing test says exactly WHAT was proved (the credential pair) and what
 *    was not (the callback registration) — a green tick that implied "sign-in
 *    works" would be the same over-promise the acceptance surfaces exist to
 *    avoid;
 *  - a card configured HERE says so even when the deployment env also carries a
 *    pair, because the app row is what the running app obeys.
 */

const PROVIDER_META = {
  github: {
    label: "GitHub",
    icon: "github" as const,
    where: "Settings → Developer settings → OAuth Apps",
    idHint: "Client ID (starts Iv1. or Ov23…)",
  },
  google: {
    label: "Google",
    icon: "user" as const,
    where: "Google Cloud console → APIs & Services → Credentials",
    idHint: "Client ID (ends .apps.googleusercontent.com)",
  },
};

function ProviderModal({
  provider,
  existing,
  onClose,
}: {
  provider: "github" | "google";
  existing: AuthProviderView;
  onClose: () => void;
}) {
  const meta = PROVIDER_META[provider];
  const [clientId, setClientId] = useState(existing.clientId ?? "");
  const [secret, setSecret] = useState("");
  // Ruling 287: a save plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);
  const { action, err, setErr } = useModalAction(() => setDone(true));
  // On a NEW provider both values are required; on an existing one the secret
  // may be left blank to keep the stored value (it can never be read back).
  const canSave =
    clientId.trim().length > 0 &&
    (existing.configuredInApp || secret.trim().length > 0);

  const apply = () => {
    if (!canSave) return;
    setErr(null);
    action.submit({
      intent: "oauth-save",
      provider,
      clientId: clientId.trim(),
      clientSecret: secret.trim(),
    });
  };

  return (
    <MiniModal
      icon={<Icon name={meta.icon} />}
      title={`${meta.label} sign-in`}
      busy={action.busy}
      done={done}
      sub={`Create an OAuth app under ${meta.where}, then paste its credentials`}
      onClose={onClose}
      canSave={canSave}
      saveLabel={action.busy ? "Saving…" : "Save credentials"}
      footHint="saving never switches sign-in on. Test the pair first"
      onSave={apply}
    >
      <div className="field">
        <label className="flabel" htmlFor="sso-id">
          {meta.idHint}
          <span className="req">*</span>
        </label>
        <input
          id="sso-id"
          type="text"
          className="mono"
          value={clientId}
          placeholder={
            provider === "github" ? "Iv1.0123456789abcdef" : "…apps.googleusercontent.com"
          }
          onChange={(e) => {
            setClientId(e.target.value);
            setErr(null);
          }}
          autoFocus
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="sso-secret">
          Client secret
          {existing.configuredInApp ? "" : <span className="req">*</span>}{" "}
          <span className="fhint">stored encrypted · never displayed</span>
        </label>
        {/* Same rule as the PAT field: a secret is `type="password"` and opts
            out of the autofill/spellcheck stores that scrape text inputs. */}
        <input
          id="sso-secret"
          type="password"
          className="mono"
          value={secret}
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          placeholder={
            existing.configuredInApp ? "leave blank to keep the stored secret" : "paste the secret"
          }
          onChange={(e) => {
            setSecret(e.target.value);
            setErr(null);
          }}
        />
        {existing.configuredInApp && (
          <div className="fhint">
            Changing either value clears the last test result and switches the
            method off until it passes again.
          </div>
        )}
      </div>
      {err && (
        <div className="form-err">
          <Icon name="alert" />
          <span>{err}</span>
        </div>
      )}
    </MiniModal>
  );
}

function CallbackUrl({ url }: { url: string }) {
  const [copied, setCopied] = useCopied(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard denied (permissions, insecure origin) — the URL is on screen
      // and selectable, which is the fallback that always works.
    }
  };
  return (
    // Ruling 280: the label is prose; only the URL is code.
    <span className="sub">
      Callback URL: <code className="mono">{url}</code>{" "}
      <button
        type="button"
        className="btn ghost sm"
        onClick={copy}
        aria-label={"Copy the callback URL " + url}
      >
        <CopyGlyph copied={copied} />
        {copied ? <span className="copy-done">Copied</span> : "Copy"}
      </button>
    </span>
  );
}

export function SsoPanel({
  providers,
  callbackOrigin,
}: {
  providers: AuthProviderView[];
  callbackOrigin: string;
}) {
  const [modal, setModal] = useState<AuthProviderView | null>(null);
  const [confirm, setConfirm] = useState<AuthProviderView | null>(null);
  const action = useOrgAction();
  // Ruling 286: the row and the button whose request is in flight. The rest
  // of the row's controls only wait.
  const inFlight = inFlightIntent(action.fetcher);
  const inFlightProvider = action.fetcher.formData?.get("provider") ?? null;

  const activeCount = providers.filter((p) => p.active).length;

  return (
    <section className="panel" data-screen-label="Settings · Sign-in & SSO">
      <div className="panel-head">
        <Icon name="shield" />
        <h2>Sign-in &amp; SSO</h2>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span>
          <strong>
            {activeCount === 0
              ? "No single sign-on: local accounts only."
              : activeCount === 1
                ? "1 single sign-on method is live."
                : "2 single sign-on methods are live."}
          </strong>{" "}
          Configure a provider here and it applies immediately, no redeploy.
          Credentials set here override the ones a deployment passes in its
          environment. Who may actually sign in is still the whitelist under{" "}
          <strong>Users &amp; access</strong>.
        </span>
      </div>
      <div className="conn-list">
        {providers.map((p) => {
          const meta = PROVIDER_META[p.provider];
          const callback = oauthCallbackUrl(callbackOrigin, p.provider);
          const proved = p.verifiedAt !== null;
          const testing = inFlight === "oauth-test" && inFlightProvider === p.provider;
          const toggling = inFlight === "oauth-toggle" && inFlightProvider === p.provider;
          return (
            <div className="conn-row" key={p.provider}>
              <span className="conn-ico">
                <Icon name={meta.icon} />
              </span>
              <span className="conn-main">
                <b>{meta.label}</b>
                <span className="sub">
                  {p.source === "app"
                    ? p.clientId
                      ? `Client ID ${p.clientId}`
                      : "Configured here"
                    : p.source === "env"
                      ? "From this deployment's environment. Set credentials here to take it over"
                      : "Not configured"}
                  {proved && (
                    <>
                      {" · proved "}
                      {/* First paint is the UTC day; the viewer's calendar
                          date lands after hydration (pass 34, C6). */}
                      <LocalCalendarDate iso={p.verifiedAt} fallback="recently" />
                    </>
                  )}
                </span>
                <CallbackUrl url={callback} />
                {/* The limit of the proof, stated where the verdict is read. */}
                {proved && p.verifiedDetail && (
                  <span className="sub">
                    {p.verifiedDetail} The callback URL above still has to be
                    registered on the provider. That is only exercised by a real
                    sign-in.
                  </span>
                )}
                {p.disabledInApp && p.envAvailable && (
                  <span className="sub">
                    Switched off here, which overrides the credentials in this
                    deployment&apos;s environment.
                  </span>
                )}
              </span>
              {p.active ? (
                <Pill kind="ready" sm quiet>
                  live
                </Pill>
              ) : (
                // Interface review 2026-09-24 (colo-13): off is a valid setup
                // (local accounts only), a settled fact that goes quiet like a
                // disabled user. `not tested` below keeps the amber demand.
                <Pill kind="neutral" sm quiet>
                  off
                </Pill>
              )}
              {p.configuredInApp && !proved && (
                <Pill kind="input" sm>
                  not tested
                </Pill>
              )}
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setModal(p)}
              >
                {p.configuredInApp ? "Update credentials" : "Set up"}
              </button>
              {p.configuredInApp && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={action.busy}
                  aria-busy={testing || undefined}
                  onClick={() =>
                    action.submit({ intent: "oauth-test", provider: p.provider })
                  }
                >
                  {testing && <Icon name="loader" className="spin" />}
                  {testing ? "Testing…" : "Test"}
                </button>
              )}
              {p.configuredInApp && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={action.busy || (!proved && !p.active)}
                  aria-busy={toggling || undefined}
                  title={
                    !proved && !p.active
                      ? "Test the credentials first: a sign-in method is only offered once the provider has accepted it"
                      : undefined
                  }
                  onClick={() =>
                    action.submit({
                      intent: "oauth-toggle",
                      provider: p.provider,
                      enabled: p.active ? "0" : "1",
                    })
                  }
                >
                  {toggling && <Icon name="loader" className="spin" />}
                  {p.active
                    ? toggling
                      ? "Turning off…"
                      : "Turn off"
                    : toggling
                      ? "Turning on…"
                      : "Turn on"}
                </button>
              )}
              {p.configuredInApp && (
                <button
                  type="button"
                  className="stg-x"
                  aria-label={"Remove the " + meta.label + " configuration"}
                  onClick={() => setConfirm(p)}
                >
                  <Icon name="x" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {modal && (
        <ProviderModal
          provider={modal.provider}
          existing={modal}
          onClose={() => setModal(null)}
        />
      )}
      {confirm && (
        <ConfirmDelete
          what={`the ${PROVIDER_META[confirm.provider].label} configuration`}
          confirmLabel="Remove configuration"
          detail={
            confirm.envAvailable
              ? `${PROVIDER_META[confirm.provider].label} sign-in falls back to the credentials in this deployment's environment.`
              : `${PROVIDER_META[confirm.provider].label} sign-in stops being offered. People who signed in this way keep their accounts but will need another method.`
          }
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            action.submit({
              intent: "oauth-remove",
              provider: confirm.provider,
            });
          }}
        />
      )}
    </section>
  );
}
