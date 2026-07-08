import { useEffect, useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { assertCsrf, assertTrustedOrigin } from "~/server/auth/csrf.server";
import {
  clearLoginFlash,
  readLoginFlash,
} from "~/server/auth/login-flash.server";
import {
  completeForcedPasswordReset,
  loginWithCredentials,
} from "~/server/auth/login.server";
import { clientIpOf } from "~/server/auth/rate-limit.server";
import {
  authenticate,
  requireAuth,
  safeReturnTo,
} from "~/server/auth/require-user.server";
import { getAuth } from "~/lib/auth.server";
import { getEnv } from "~/server/config/env.server";
import { getDb } from "~/server/db/sqlite.server";
import { serializeThemePreference } from "~/server/theme/theme-cookie.server";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";
import { CsrfInput } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";

/**
 * /login — ported 1:1 from design/html-app/app/login.jsx.
 * Two server-driven modes:
 *   "login" — providers + local credentials form
 *   "reset" — the forced set-new-password step (pwreset_required gate)
 */

export function meta(_: Route.MetaArgs) {
  return [{ title: "Viberr — Sign in" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const env = getEnv();
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const auth = await authenticate(request);

  // Signed in and no reset pending → nothing to do here.
  if (auth && !auth.pwresetRequired) throw redirect(returnTo ?? "/");

  const flash = readLoginFlash(request);
  const payload = {
    mode: auth ? ("reset" as const) : ("login" as const),
    returnTo,
    flash,
    providers: {
      github: Boolean(
        env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET,
      ),
      google: Boolean(
        env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET,
      ),
    },
  };
  return flash
    ? data(payload, { headers: { "Set-Cookie": clearLoginFlash() } })
    : data(payload);
}

export async function action({ request }: Route.ActionArgs) {
  assertTrustedOrigin(request);
  const db = getDb();
  const formData = await request.formData();
  const intent = formData.get("intent");
  const returnTo = safeReturnTo(
    typeof formData.get("returnTo") === "string"
      ? (formData.get("returnTo") as string)
      : null,
  );

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
        ip: clientIpOf(request),
        userAgent: request.headers.get("User-Agent"),
      },
      { requestHeaders: request.headers },
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
    const auth = await requireAuth(request, { allowPendingPasswordReset: true });
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

    completeForcedPasswordReset(db, {
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
  const [serverErrHidden, setServerErrHidden] = useState(false);
  useEffect(() => setServerErrHidden(false), [actionError]);
  const err = clientErr ?? (serverErrHidden ? null : actionError);

  return (
    <div className="login-wrap" data-screen-label="Login — set new password">
      <div className="login-card">
        <div className="login-brand">
          <span className="mark">V</span>
          <div>
            <h1>Set a new password</h1>
            <div className="sub">
              An admin reset your password — choose a new one to continue.
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
              autoFocus
              onChange={(e) => {
                setNpw(e.target.value);
                setClientErr(null);
                setServerErrHidden(true);
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
                setServerErrHidden(true);
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

export default function Login({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { mode, returnTo, flash, providers } = loaderData;
  const navigation = useNavigation();
  const actionError = actionData?.error ?? null;

  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [clientErr, setClientErr] = useState<string | null>(null);
  const [serverErrHidden, setServerErrHidden] = useState(false);
  const [info, setInfo] = useState<string | null>(
    flash?.kind === "info" ? flash.message : null,
  );
  const [providerBusy, setProviderBusy] = useState<
    "github" | "google" | null
  >(null);

  useEffect(() => setServerErrHidden(false), [actionError]);

  if (mode === "reset") {
    return <SetNewPassword returnTo={returnTo} actionError={actionError} />;
  }

  const submitting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "login";
  const busy = providerBusy ?? (submitting ? "local" : null);
  const err =
    clientErr ??
    (serverErrHidden ? null : actionError) ??
    (flash?.kind === "error" && !serverErrHidden ? flash.message : null);

  const provider = (which: "github" | "google") => {
    if (busy) return;
    setClientErr(null);
    setServerErrHidden(true);
    setInfo(null);
    setProviderBusy(which);
    if (!providers[which]) {
      setTimeout(() => {
        setProviderBusy(null);
        setInfo(
          (which === "github" ? "GitHub" : "Google") +
            " OAuth isn't configured on this deployment — use a local account, or ask an admin to set it up.",
        );
      }, 900);
      return;
    }
    // Kick off better-auth's social sign-in and follow the provider URL.
    void (async () => {
      try {
        const res = await fetch("/api/auth/sign-in/social", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: which, callbackURL: returnTo ?? "/" }),
        });
        const body = (await res.json()) as { url?: string };
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

  return (
    <div className="login-wrap" data-screen-label="Login">
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

        <div className="login-providers">
          <button
            type="button"
            className="btn provider github"
            onClick={() => provider("github")}
            aria-busy={busy === "github" || undefined}
            style={
              busy === "github"
                ? { opacity: 0.7, pointerEvents: "none" }
                : undefined
            }
          >
            <Icon
              name={busy === "github" ? "refresh" : "github"}
              className={busy === "github" ? "spin" : ""}
            />
            {busy === "github" ? "Checking whitelist…" : "Continue with GitHub"}
          </button>
          <button
            type="button"
            className="btn provider"
            onClick={() => provider("google")}
            aria-busy={busy === "google" || undefined}
            style={
              busy === "google"
                ? { opacity: 0.7, pointerEvents: "none" }
                : undefined
            }
          >
            {busy === "google" ? (
              <Icon name="refresh" className="spin" />
            ) : (
              <span className="gmark lg">G</span>
            )}
            {busy === "google" ? "Checking whitelist…" : "Continue with Google"}
          </button>
        </div>
        {info && (
          <div className="cred-warn" role="status">
            <Icon name="alert" />
            {info}
          </div>
        )}

        <div className="login-div">or a local account</div>

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
              type="text"
              className="mono"
              autoComplete="username"
              value={email}
              placeholder="arda@viberr.dev"
              onChange={(e) => {
                setEmail(e.target.value);
                setClientErr(null);
                setServerErrHidden(true);
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
                setServerErrHidden(true);
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
              className="linkish"
              style={{ fontSize: ".78rem", color: "var(--faint)" }}
              onClick={() => {
                setClientErr(null);
                setServerErrHidden(true);
                setInfo(
                  "Ask an admin to reset your password — you'll be prompted to set a new one at your next sign-in.",
                );
              }}
            >
              Forgot password?
            </button>
          </div>
        </Form>

        <div className="login-tag">
          whitelist-based access — GitHub &amp; Google accounts sign in
          directly once whitelisted
        </div>
      </div>
    </div>
  );
}
