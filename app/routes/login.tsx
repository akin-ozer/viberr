import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import {
  useEffect,
  useRef,
  useState,
  type FormEventHandler,
  type RefObject,
} from "react";
import { pageTitle } from "~/shared/page-title";
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
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";

/**
 * Login and required-password-reset surface.
 * Two server-driven modes:
 *   "login" — providers + local credentials form
 *   "reset" — the forced set-new-password step (pwreset_required gate)
 */

export function meta() {
  return [{ title: pageTitle("Sign in") }];
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

/** Which input a refusal belongs to, so the page can mark it invalid,
 *  describe it with the error box and hand it focus. `null` is the whole
 *  form (rate limit, disabled account, unknown intent). */
type ErrorField = "email" | "password" | "npw" | "npw2" | null;
/** Every refusal carries a field, so `actionData.field` is one type rather
 *  than a union only some branches satisfy. */
const refuse = (error: string, field: ErrorField) =>
  data({ error, field }, { status: 400 });

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
    if (!email) return refuse("Enter your email.", "email");

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
              ? "This account is disabled. Ask an admin to re-enable it."
              : // unknown_email + no_password share the mock's copy: don't
                // reveal whether an (OAuth-only) account exists.
                "No local account for that email. Ask an admin to create one, or sign in with GitHub / Google if you're whitelisted.";
      const field: ErrorField =
        result.reason === "wrong_password"
          ? "password"
          : result.reason === "rate_limited" || result.reason === "disabled"
            ? null
            : // unknown_email + no_password: the email is what they got wrong.
              "email";
      return refuse(error, field);
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
      return refuse(
        `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
        "npw",
      );
    }
    if (npw !== npw2) return refuse("Passwords don't match.", "npw2");

    await completeForcedPasswordReset(db, {
      user: { id: auth.user.id, email: auth.user.email },
      newPassword: npw,
    });
    // The existing better-auth session stays valid; just clear the gate.
    return redirect(returnTo ?? "/");
  }

  return refuse("Unknown action.", null);
}

/** The error the card shows, with the input it belongs to. */
type ShownError = { text: string; field: ErrorField };

/** What refused a submission on this page: the client's own check, or the
 *  action's answer. Each refusal is a new object; a re-render keeps the same one. */
type Refusal = ShownError | NonNullable<Route.ComponentProps["actionData"]>;

const refusalKeys = new WeakMap<Refusal, string>();
let refusalsSeen = 0;

/**
 * Ruling 451(g): a React key that is new for every NEW refusal. The error box
 * stays mounted across a second refused submission, so without a new key the
 * same sentence stood in place: nothing moved, and a `role="alert"` whose text
 * did not change is not announced again. Keyed on the refusal's identity, the
 * box remounts, which replays its shake and re-announces it, while a mere
 * re-render of the same refusal keeps its key.
 */
function refusalKey(refusal: Refusal | null | undefined): string | undefined {
  if (!refusal) return undefined;
  let key = refusalKeys.get(refusal);
  if (key === undefined) {
    refusalsSeen += 1;
    key = `refusal-${refusalsSeen}`;
    refusalKeys.set(refusal, key);
  }
  return key;
}

/**
 * The error the card shows (ruling 700(e), read once per render by `Login`):
 * the client's own refusal, else the action's unless the person dismissed
 * it. A dismissal stores WHICH result was dismissed (see SetNewPassword), so
 * a second refusal un-hides itself.
 */
function shownError(
  clientErr: ShownError | null,
  actionData: Route.ComponentProps["actionData"],
  dismissed: Route.ComponentProps["actionData"],
): ShownError | null {
  const serverErrHidden = actionData !== undefined && dismissed === actionData;
  return (
    clientErr ??
    (actionData && !serverErrHidden
      ? { text: actionData.error, field: actionData.field }
      : null)
  );
}

/** Which of the card's posts is in flight (ruling 700(e), read once per render
 *  by `Login`): a provider's sign-in, the local form's submission, or none. */
function signInBusy(
  providerBusy: "github" | "google" | null,
  navigation: ReturnType<typeof useNavigation>,
): "github" | "google" | "local" | null {
  const submitting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "login";
  return providerBusy ?? (submitting ? "local" : null);
}

/** The forced set-new-password step (mock's `reset` screen). */
function SetNewPassword({
  returnTo,
  actionData,
}: {
  returnTo: string | null;
  actionData: Route.ComponentProps["actionData"];
}) {
  const [npw, setNpw] = useState("");
  const [npw2, setNpw2] = useState("");
  const npwRef = useRef<HTMLInputElement>(null);
  const npw2Ref = useRef<HTMLInputElement>(null);
  const [clientErr, setClientErr] = useState<ShownError | null>(null);
  // Store WHICH result the user dismissed (by typing): the actionData object,
  // not its text. A second submit that fails the same way is a new object, so
  // it un-hides itself — comparing the text kept a repeated refusal hidden.
  // No effect needed for the hiding.
  const [dismissed, setDismissed] =
    useState<Route.ComponentProps["actionData"]>(undefined);
  const serverErrHidden = actionData !== undefined && dismissed === actionData;
  const err: ShownError | null =
    clientErr ??
    (actionData && !serverErrHidden
      ? { text: actionData.error, field: actionData.field }
      : null);
  // A server refusal names its field; put the person on it once it arrives.
  useEffect(() => {
    if (actionData?.field === "npw") npwRef.current?.focus();
    else if (actionData?.field === "npw2") npw2Ref.current?.focus();
  }, [actionData]);

  return (
    <div className="login-wrap" data-screen-label="Login · set new password">
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
              You signed in with a temporary password. Choose your own to
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
              setClientErr({
                text: `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
                field: "npw",
              });
              npwRef.current?.focus();
              return;
            }
            if (npw !== npw2) {
              e.preventDefault();
              setClientErr({ text: "Passwords don't match.", field: "npw2" });
              npw2Ref.current?.focus();
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
              ref={npwRef}
              name="npw"
              type="password"
              autoComplete="new-password"
              value={npw}
              aria-invalid={err?.field === "npw" || undefined}
              aria-describedby={err?.field === "npw" ? "npw-err" : undefined}
              onChange={(e) => {
                setNpw(e.target.value);
                setClientErr(null);
                setDismissed(actionData);
              }}
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="npw2">
              Confirm password
            </label>
            <input
              id="npw2"
              ref={npw2Ref}
              name="npw2"
              type="password"
              autoComplete="new-password"
              value={npw2}
              aria-invalid={err?.field === "npw2" || undefined}
              aria-describedby={err?.field === "npw2" ? "npw-err" : undefined}
              onChange={(e) => {
                setNpw2(e.target.value);
                setClientErr(null);
                setDismissed(actionData);
              }}
            />
          </div>
          {err && (
            <div
              key={refusalKey(clientErr ?? actionData)}
              className="login-err refused"
              role="alert"
              id="npw-err"
            >
              <Icon name="alert" />
              {err.text}
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
      >
        <GlyphSwap rest="github" alt="loader" on={busy === "github"} spinAlt />
        {busy === "github"
          ? "Checking whitelist…"
          : providers.github
            ? "Continue with GitHub"
            : "GitHub (not configured)"}
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
      >
        <GlyphSwap rest="google" alt="loader" on={busy === "google"} spinAlt />
        {busy === "google"
          ? "Checking whitelist…"
          : providers.google
            ? "Continue with Google"
            : "Google (not configured)"}
      </button>
    </div>
  );
}

/** The SSO-first head of the sign-in card (ruling 700(e), the split of
 *  `Login`: hook-free, in the slot its `ssoConfigured &&` held): the provider
 *  buttons, the note for the one that is missing, the info box and the
 *  divider above the local form. `Login` renders it only while at least one
 *  provider is configured. */
function SsoProviders({
  providers,
  busy,
  onProvider,
  info,
}: {
  providers: { github: boolean; google: boolean };
  busy: "github" | "google" | "local" | null;
  onProvider: (which: "github" | "google") => void;
  info: string | null;
}) {
  return (
    <>
      <ProviderButtons
        providers={providers}
        busy={busy}
        onProvider={onProvider}
      />
      {(!providers.github || !providers.google) && (
        <div className="login-tag providers">
          {/* Inside the ssoConfigured branch exactly one provider can be
          missing — the both-missing deployment renders the local-first
          layout below instead. */}
          {!providers.github
            ? "GitHub sign-in isn't configured on this deployment. Use a local account below."
            : "Google sign-in isn't configured on this deployment. Use a local account below."}
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
  );
}

/** The local credentials form (ruling 700(e), the split of `Login`:
 *  hook-free; `Login` keeps the fields' state, refs and handlers). */
function LocalSignInForm({
  returnTo,
  email,
  pw,
  emailRef,
  pwRef,
  err,
  refusal,
  busy,
  onSubmit,
  onEmail,
  onPassword,
  onForgot,
}: {
  returnTo: string | null;
  email: string;
  pw: string;
  emailRef: RefObject<HTMLInputElement | null>;
  pwRef: RefObject<HTMLInputElement | null>;
  err: ShownError | null;
  /** What the error box is keyed on (ruling 451(g)). */
  refusal: Refusal | null | undefined;
  busy: "github" | "google" | "local" | null;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onForgot: () => void;
}) {
  return (
    <Form method="post" className="login-form" onSubmit={onSubmit}>
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
          ref={emailRef}
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          placeholder="you@company.dev"
          aria-invalid={err?.field === "email" || undefined}
          aria-describedby={err?.field === "email" ? "lg-err" : undefined}
          onChange={(e) => onEmail(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="flabel" htmlFor="lg-pw">
          Password
        </label>
        <input
          id="lg-pw"
          ref={pwRef}
          name="password"
          type="password"
          autoComplete="current-password"
          value={pw}
          aria-invalid={err?.field === "password" || undefined}
          aria-describedby={err?.field === "password" ? "lg-err" : undefined}
          onChange={(e) => onPassword(e.target.value)}
        />
      </div>
      {err && (
        // Ruling 451(g): keyed on the refusal itself, so a second refused
        // sign-in remounts the box (shake, re-announce) instead of leaving
        // the same sentence standing as if the click had been ignored.
        <div
          key={refusalKey(refusal)}
          className="login-err refused"
          role="alert"
          id="lg-err"
        >
          <Icon name="alert" />
          {err.text}
        </div>
      )}
      <button
        className="btn primary provider"
        type="submit"
        aria-busy={busy === "local" || undefined}
      >
        {busy === "local" ? "Signing in…" : "Sign in"}
      </button>
      <div className="login-foot">
        <button
          type="button"
          className="linkish fine sm"
          onClick={onForgot}
        >
          Forgot password?
        </button>
      </div>
    </Form>
  );
}

export default function Login({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { mode, returnTo, providers } = loaderData;
  const navigation = useNavigation();

  const emailRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [clientErr, setClientErr] = useState<ShownError | null>(null);
  // Same identity-keyed dismissal as SetNewPassword (see the comment there).
  const [dismissed, setDismissed] =
    useState<Route.ComponentProps["actionData"]>(undefined);
  const [info, setInfo] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState<"github" | "google" | null>(
    null,
  );
  // A server refusal names its field; put the person on it once it arrives.
  // (Hooks stay above the mode fork below.)
  useEffect(() => {
    if (actionData?.field === "email") emailRef.current?.focus();
    else if (actionData?.field === "password") pwRef.current?.focus();
  }, [actionData]);

  if (mode === "reset") {
    return <SetNewPassword returnTo={returnTo} actionData={actionData} />;
  }

  const busy = signInBusy(providerBusy, navigation);
  const err = shownError(clientErr, actionData, dismissed);

  const provider = (which: "github" | "google") => {
    if (busy) return;
    setClientErr(null);
    setDismissed(actionData);
    if (!providers[which]) {
      setInfo(
        (which === "github" ? "GitHub" : "Google") +
          " OAuth isn't configured on this deployment. Use a local account, or ask an admin to set it up.",
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
            " sign-in couldn't start. Please try again.",
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
      {/* F10-27: a brand/value panel beside the card so the wide viewport
          reads as an intentional composition rather than a lone card in empty
          space. Below the two-column breakpoint it stacks under the card
          instead of hiding (app.css, interface review 2026-09-24 acce-27). */}
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
          first-class work on real repository branches: inspectable,
          recoverable, and reviewed before anything ships.
        </p>
        <ul className="login-aside-points">
          <li>
            <Icon name="arrow" />
            Task-centered board with a managed operator
          </li>
          <li>
            <Icon name="arrow" />
            Every agent run is real, attributed, and auditable
          </li>
          <li>
            <Icon name="arrow" />
            Server-owned delivery: branches, pull requests, merges
          </li>
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
          <SsoProviders
            providers={providers}
            busy={busy}
            onProvider={provider}
            info={info}
          />
        )}

        <LocalSignInForm
          returnTo={returnTo}
          email={email}
          pw={pw}
          emailRef={emailRef}
          pwRef={pwRef}
          err={err}
          refusal={clientErr ?? actionData}
          busy={busy}
          onSubmit={(e) => {
            if (busy) {
              e.preventDefault();
              return;
            }
            setInfo(null);
            if (!email.trim()) {
              e.preventDefault();
              setClientErr({ text: "Enter your email.", field: "email" });
              emailRef.current?.focus();
            }
          }}
          onEmail={(value) => {
            setEmail(value);
            setClientErr(null);
            setDismissed(actionData);
          }}
          onPassword={(value) => {
            setPw(value);
            setClientErr(null);
            setDismissed(actionData);
          }}
          onForgot={() => {
            setClientErr(null);
            setDismissed(actionData);
            setInfo(
              "Ask an admin to reset your password. You'll be prompted to set a new one at your next sign-in.",
            );
          }}
        />

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
            whitelist-based access: GitHub &amp; Google accounts sign in
            directly once whitelisted
          </div>
        ) : (
          <div className="login-tag providers">
            GitHub &amp; Google SSO isn't configured on this deployment. Sign
            in with a local account. An admin can enable OAuth to let
            whitelisted accounts sign in directly.
          </div>
        )}
      </div>
    </div>
  );
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/login");
