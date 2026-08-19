import { useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/login";
import { assertCsrf, assertTrustedOrigin } from "~/server/auth/csrf.server";
import {
  completeForcedPasswordReset,
  loginWithCredentials,
} from "~/server/auth/login.server";
import {
  authenticate,
  requireAuth,
  safeReturnTo,
} from "~/server/auth/require-user.server";
import { getAuth } from "~/lib/auth.server";
import { getDb } from "~/server/db/sqlite.server";
import { resolveOAuthProvider } from "~/server/auth/oauth-providers.server";
import { serializeThemePreference } from "~/server/theme/theme-cookie.server";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";
import { CsrfInput } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";

/**
 * Login and required-password-reset surface.
 * Two server-driven modes:
 *   "login" — providers + local credentials form
 *   "reset" — the forced set-new-password step (pwreset_required gate)
 */

export function meta() {
  return [{ title: "Viberr — Sign in" }];
}

/** A form field that must be text: `FormData.get` also yields a `File` for a
 *  file input, and a filename is not a redirect target. Anything but a string
 *  reads as absent, which `safeReturnTo` then treats as "no destination". */
const returnToField = z.string().nullable().catch(null);

/** better-auth's social sign-in reply: the provider URL to hand the browser.
 *  A reply without a usable one is a failure, handled by the caller's catch —
 *  so a malformed body must not read as a destination. */
const socialSignIn = z
  .object({ url: z.string().min(1).optional().catch(undefined) })
  .catch({});

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const auth = await authenticate(request);

  // Signed in and no reset pending → nothing to do here.
  if (auth && !auth.pwresetRequired) throw redirect(returnTo ?? "/");

  return {
    mode: auth ? ("reset" as const) : ("login" as const),
    returnTo,
    // R19-16: the SAME resolution better-auth runs on (app configuration
    // overriding the deployment env), so the login page never offers a button
    // the handler would refuse — nor hides one an admin just switched on.
    providers: {
      github: resolveOAuthProvider(getDb(), "github").credentials !== null,
      google: resolveOAuthProvider(getDb(), "google").credentials !== null,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  assertTrustedOrigin(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent");
  const returnTo = safeReturnTo(returnToField.parse(formData.get("returnTo")));

  if (intent === "login") {
    // Already signed in (e.g. double submit / second tab)? Never create a
    // second session — just go where they were headed.
    const existing = await authenticate(request);
    if (existing && !existing.pwresetRequired) {
      return redirect(returnTo ?? "/");
    }

    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    if (!email) return data({ error: "Enter your email." }, { status: 400 });

    const result = await loginWithCredentials(
      db,
      getAuth(),
      {
        email,
        password,
      },
      { requestHeaders: request.headers, requestUrl: request.url },
    );

    if (!result.ok) {
      const error =
        result.reason === "wrong_password"
          ? "Wrong password. Ask an admin to reset it if you're locked out."
          : result.reason === "rate_limited"
            ? "Too many sign-in attempts. Wait a few minutes and try again."
            : result.reason === "disabled"
              ? "This account is disabled — ask an admin to re-enable it."
              : // unknown_email + no_password share the mock's copy: don't
                // reveal whether an (OAuth-only) account exists.
                "No local account for that email — ask an admin to create one, or sign in with GitHub / Google if you're whitelisted.";
      return data({ error }, { status: 400 });
    }

    const headers = new Headers();
    // Forward better-auth's session Set-Cookie(s).
    for (const cookie of result.setCookies) {
      headers.append("Set-Cookie", cookie);
    }
    // Sync the user's stored theme preference to the viberr_theme cookie.
    headers.append("Set-Cookie", serializeThemePreference(result.user.theme));
    if (result.mustResetPassword) {
      // Forced-reset gate: land on the set-new-password step.
      const target = returnTo
        ? `/login?returnTo=${encodeURIComponent(returnTo)}`
        : "/login";
      return redirect(target, { headers });
    }
    return redirect(returnTo ?? "/", { headers });
  }

  if (intent === "set-password") {
    const auth = await requireAuth(request, {
      allowPendingPasswordReset: true,
    });
    await assertCsrf(request, auth.sessionId, formData);
    if (!auth.pwresetRequired) return redirect(returnTo ?? "/");

    const npw = String(formData.get("npw") ?? "");
    const npw2 = String(formData.get("npw2") ?? "");
    if (npw.length < MIN_PASSWORD_LENGTH) {
      return data(
        {
          error: `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
        },
        { status: 400 },
      );
    }
    if (npw !== npw2) {
      return data({ error: "Passwords don't match." }, { status: 400 });
    }

    await completeForcedPasswordReset(db, {
      user: { id: auth.user.id, email: auth.user.email },
      newPassword: npw,
    });
    // The existing better-auth session stays valid; just clear the gate.
    return redirect(returnTo ?? "/");
  }

  return data({ error: "Unknown action." }, { status: 400 });
}

/** The forced set-new-password step (mock's `reset` screen). */
function SetNewPassword({
  returnTo,
  actionError,
}: {
  returnTo: string | null;
  actionError: string | null;
}) {
  const [npw, setNpw] = useState("");
  const [npw2, setNpw2] = useState("");
  const [clientErr, setClientErr] = useState<string | null>(null);
  // Store which server error the user dismissed (by typing); a new
  // actionError no longer matches, so it un-hides itself — no effect needed.
  const [dismissedServerErr, setDismissedServerErr] = useState<
    string | null | undefined
  >(undefined);
  const serverErrHidden =
    dismissedServerErr !== undefined && dismissedServerErr === actionError;
  const err = clientErr ?? (serverErrHidden ? null : actionError);

  return (
    <div className="login-wrap" data-screen-label="Login — set new password">
      <div className="login-card">
        <div className="login-brand">
          <span className="mark">V</span>
          <div>
            <h1>Set a new password</h1>
            <div className="sub">
              {/* F17-L11: this screen shows for BOTH a freshly whitelisted
                  account (temp password, never had one) and an admin reset of an
                  existing one — the old copy asserted "an admin reset your
                  password", false for a brand-new account. Both share one truth:
                  a temporary password was issued and must be replaced. */}
              You signed in with a temporary password — choose your own to
              continue.
            </div>
          </div>
        </div>
        <Form
          method="post"
          className="login-form"
          onSubmit={(e) => {
            if (npw.length < MIN_PASSWORD_LENGTH) {
              e.preventDefault();
              setClientErr(
                `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
              );
              return;
            }
            if (npw !== npw2) {
              e.preventDefault();
              setClientErr("Passwords don't match.");
            }
          }}
        >
          <input type="hidden" name="intent" value="set-password" />
          {returnTo ? (
            <input type="hidden" name="returnTo" value={returnTo} />
          ) : null}
          <CsrfInput />
          <div className="field">
            <label className="flabel" htmlFor="npw">
              New password
            </label>
            <input
              id="npw"
              name="npw"
              type="password"
              autoComplete="new-password"
              value={npw}
              onChange={(e) => {
                setNpw(e.target.value);
                setClientErr(null);
                setDismissedServerErr(actionError);
              }}
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="npw2">
              Confirm password
            </label>
            <input
              id="npw2"
              name="npw2"
              type="password"
              autoComplete="new-password"
              value={npw2}
              onChange={(e) => {
                setNpw2(e.target.value);
                setClientErr(null);
                setDismissedServerErr(actionError);
              }}
            />
          </div>
          {err && (
            <div className="login-err" role="alert">
              <Icon name="alert" />
              {err}
            </div>
          )}
          <button className="btn primary provider" type="submit">
            Save &amp; continue
          </button>
        </Form>
      </div>
    </div>
  );
}

/** The two OAuth buttons (rendered only when ≥1 provider is configured —
 *  R17-4). D12: an unconfigured provider renders disabled with an explicit
 *  label rather than looking clickable. */
function ProviderButtons({
  providers,
  busy,
  onProvider,
}: {
  providers: { github: boolean; google: boolean };
  busy: "github" | "google" | "local" | null;
  onProvider: (which: "github" | "google") => void;
}) {
  return (
    <div className="login-providers">
      <button
        type="button"
        className="btn provider github"
        onClick={() => onProvider("github")}
        disabled={!providers.github}
        aria-busy={busy === "github" || undefined}
        title={
          providers.github
            ? undefined
            : "GitHub OAuth isn't configured on this deployment"
        }
        style={
          !providers.github
            ? { opacity: 0.55, cursor: "not-allowed" }
            : busy === "github"
              ? { opacity: 0.7, pointerEvents: "none" }
              : undefined
        }
      >
        <Icon
          name={busy === "github" ? "refresh" : "github"}
          className={busy === "github" ? "spin" : ""}
        />
        {busy === "github"
          ? "Checking whitelist…"
          : providers.github
            ? "Continue with GitHub"
            : "GitHub — not configured"}
      </button>
      <button
        type="button"
        className="btn provider"
        onClick={() => onProvider("google")}
        disabled={!providers.google}
        aria-busy={busy === "google" || undefined}
        title={
          providers.google
            ? undefined
            : "Google OAuth isn't configured on this deployment"
        }
        style={
          !providers.google
            ? { opacity: 0.55, cursor: "not-allowed" }
            : busy === "google"
              ? { opacity: 0.7, pointerEvents: "none" }
              : undefined
        }
      >
        {busy === "google" ? (
          <Icon name="refresh" className="spin" />
        ) : (
          <span className="gmark lg">G</span>
        )}
        {busy === "google"
          ? "Checking whitelist…"
          : providers.google
            ? "Continue with Google"
            : "Google — not configured"}
      </button>
    </div>
  );
}

export default function Login({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { mode, returnTo, providers } = loaderData;
  const navigation = useNavigation();
  const actionError = actionData?.error ?? null;

  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [clientErr, setClientErr] = useState<string | null>(null);
  // Store which server error the user dismissed (by typing); a new
  // actionError no longer matches, so it un-hides itself — no effect needed.
  const [dismissedServerErr, setDismissedServerErr] = useState<
    string | null | undefined
  >(undefined);
  const serverErrHidden =
    dismissedServerErr !== undefined && dismissedServerErr === actionError;
  const [info, setInfo] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState<"github" | "google" | null>(
    null,
  );

  if (mode === "reset") {
    return <SetNewPassword returnTo={returnTo} actionError={actionError} />;
  }

  const submitting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "login";
  const busy = providerBusy ?? (submitting ? "local" : null);
  const err = clientErr ?? (serverErrHidden ? null : actionError);

  const provider = (which: "github" | "google") => {
    if (busy) return;
    setClientErr(null);
    setDismissedServerErr(actionError);
    if (!providers[which]) {
      setInfo(
        (which === "github" ? "GitHub" : "Google") +
          " OAuth isn't configured on this deployment — use a local account, or ask an admin to set it up.",
      );
      return;
    }
    setInfo(null);
    setProviderBusy(which);
    // Kick off better-auth's social sign-in and follow the provider URL.
    void (async () => {
      try {
        const res = await fetch("/api/auth/sign-in/social", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: which,
            callbackURL: returnTo ?? "/",
          }),
        });
        // fetch() resolves on 4xx/5xx, so an error payload would otherwise be
        // read as a successful sign-in response.
        if (!res.ok) throw new Error("sign-in request failed");
        const body = socialSignIn.parse(await res.json());
        if (body.url) {
          window.location.href = body.url;
          return;
        }
        throw new Error("no redirect url");
      } catch {
        setProviderBusy(null);
        setInfo(
          (which === "github" ? "GitHub" : "Google") +
            " sign-in couldn't start — please try again.",
        );
      }
    })();
  };

  // R17-4 (UX-1): on a local-only deployment (neither OAuth provider
  // configured) the card used to lead with two DISABLED provider buttons — its
  // most prominent elements were things that cannot work. When SSO is entirely
  // off, the local form leads and SSO shrinks to a one-line note; with at
  // least one provider configured, the SSO-first ordering stands.
  const ssoConfigured = providers.github || providers.google;

  return (
    <div className="login-wrap login-wrap-2col" data-screen-label="Login">
      {/* F10-27: a desktop-only brand/value panel beside the card so the wide
          viewport reads as an intentional composition rather than a lone card
          in empty space. Hidden below the two-column breakpoint. */}
      {/* UXA-12: this panel used to be `aria-hidden="true"`. Its decorative
          MARK is decorative; its heading and three product claims are not, and
          they appear nowhere else — so an assistive-tech user got a bare
          sign-in form where a sighted user got the product's whole value
          statement. Hide the glyph, expose the prose. */}
      <aside className="login-aside">
        <span className="login-aside-mark" aria-hidden="true">
          V
        </span>
        <h2>Managed AI delivery for small teams</h2>
        <p>
          Humans set the policy and stay accountable. Claude and Codex agents do
          first-class work on real repository branches — inspectable,
          recoverable, and reviewed before anything ships.
        </p>
        <ul className="login-aside-points">
          <li>Task-centered board with a managed operator</li>
          <li>Every agent run is real, attributed, and auditable</li>
          <li>Server-owned delivery: branches, pull requests, merges</li>
        </ul>
      </aside>
      <div className="login-card">
        <div className="login-brand">
          <span className="mark">V</span>
          <div>
            <h1>Sign in to Viberr</h1>
            <div className="sub">
              Self-hosted · collaborative agentic AI delivery
            </div>
          </div>
        </div>

        {ssoConfigured && (
          <>
            <ProviderButtons
              providers={providers}
              busy={busy}
              onProvider={provider}
            />
            {(!providers.github || !providers.google) && (
              <div className="login-tag providers">
                {/* Inside the ssoConfigured branch exactly one provider can be
                missing — the both-missing deployment renders the local-first
                layout below instead. */}
                {!providers.github
                  ? "GitHub sign-in isn't configured on this deployment — use a local account below."
                  : "Google sign-in isn't configured on this deployment — use a local account below."}
              </div>
            )}
            {info && (
              <div className="cred-warn" role="status">
                <Icon name="alert" />
                {info}
              </div>
            )}

            <div className="login-div">or a local account</div>
          </>
        )}

        <Form
          method="post"
          className="login-form"
          onSubmit={(e) => {
            if (busy) {
              e.preventDefault();
              return;
            }
            setInfo(null);
            if (!email.trim()) {
              e.preventDefault();
              setClientErr("Enter your email.");
            }
          }}
        >
          <input type="hidden" name="intent" value="login" />
          {returnTo ? (
            <input type="hidden" name="returnTo" value={returnTo} />
          ) : null}
          <div className="field">
            <label className="flabel" htmlFor="lg-email">
              Email
            </label>
            <input
              id="lg-email"
              name="email"
              type="email"
              className="mono"
              autoComplete="username"
              value={email}
              placeholder="you@company.dev"
              onChange={(e) => {
                setEmail(e.target.value);
                setClientErr(null);
                setDismissedServerErr(actionError);
              }}
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="lg-pw">
              Password
            </label>
            <input
              id="lg-pw"
              name="password"
              type="password"
              autoComplete="current-password"
              value={pw}
              placeholder="••••"
              onChange={(e) => {
                setPw(e.target.value);
                setClientErr(null);
                setDismissedServerErr(actionError);
              }}
            />
          </div>
          {err && (
            <div className="login-err" role="alert">
              <Icon name="alert" />
              {err}
            </div>
          )}
          <button
            className="btn primary provider"
            type="submit"
            aria-busy={busy === "local" || undefined}
            style={
              busy === "local"
                ? { opacity: 0.7, pointerEvents: "none" }
                : undefined
            }
          >
            {busy === "local" ? "Signing in…" : "Sign in"}
          </button>
          <div className="login-foot">
            <button
              type="button"
              className="linkish fine sm"
              onClick={() => {
                setClientErr(null);
                setDismissedServerErr(actionError);
                setInfo(
                  "Ask an admin to reset your password — you'll be prompted to set a new one at your next sign-in.",
                );
              }}
            >
              Forgot password?
            </button>
          </div>
        </Form>

        {/* The info box ("forgot password?" guidance) renders after the form
            in the local-first layout so clicking the link doesn't shove the
            form — and the button under the cursor — down the card. */}
        {!ssoConfigured && info && (
          <div className="cred-warn" role="status">
            <Icon name="alert" />
            {info}
          </div>
        )}

        {ssoConfigured ? (
          <div className="login-tag">
            whitelist-based access — GitHub &amp; Google accounts sign in
            directly once whitelisted
          </div>
        ) : (
          <div className="login-tag providers">
            GitHub &amp; Google SSO isn't configured on this deployment — sign
            in with a local account. An admin can enable OAuth to let
            whitelisted accounts sign in directly.
          </div>
        )}
      </div>
    </div>
  );
}
