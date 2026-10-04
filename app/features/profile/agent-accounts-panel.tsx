import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useFetcher, useRevalidator } from "react-router";
import type { FetcherWithComponents } from "react-router";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { CopyGlyph } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { AgentGlyph } from "~/ui/identity";
import { LocalCalendarDate, LocalDayDotTime } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { inFlightIntent } from "~/ui/in-flight";
import { useDismiss } from "~/ui/use-dismiss";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { scrollingBox } from "~/ui/use-hash-target";
import { useToast } from "~/ui/toast";
import { utcDayKey } from "~/shared/dates/format";
import { AGENT_ACCOUNTS_ANCHOR } from "~/shared/page-anchors";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import type {
  BackendLoginPollAnswer,
  BackendLoginPollData,
} from "~/routes/resources.backend-login";
import type {
  ProfileBackend,
  ProfileBackendAccount,
  ProfileBackendRefusal,
} from "./profile-query.server";
import type { ProfileActionData } from "./profile-page";
import type { LoginState } from "~/server/runtimes/backend-login.server";
import type {
  LoginMethod,
  UserBackendHealth,
} from "~/server/runtimes/backend-credentials.server";
import { useRefusalShake } from "~/ui/use-refusal-shake";

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
 */

/** How each vendor's own sign-in flow is named to the person starting it. */
const SIGN_IN_LABEL = {
  claudeai: "Sign in with Claude",
  console: "Sign in with Console",
  device: "Sign in with ChatGPT",
} as const satisfies Record<LoginMethod, string>;

const PASTE_LABEL = {
  api_key: "Use an API key",
  access_token: "Use a workspace access token",
} as const;

/** How a completed connection reads back. */
const SIGN_IN_CONNECTED = {
  claudeai: "Connected via Claude sign-in (claude.ai)",
  console: "Connected via Console sign-in",
  device: "Connected via ChatGPT sign-in",
} as const satisfies Record<LoginMethod, string>;

const POLL_INTERVAL_MS = 2_000;

const TERMINAL_STATES: ReadonlySet<LoginState> = new Set<LoginState>([
  "succeeded",
  "failed",
  "cancelled",
]);

/** What the person is waiting for, in their words. The server's own states are
 *  machine vocabulary; a status line that said "awaiting-browser" would be a
 *  leak of the state machine, not a status. */
function statusLine(state: LoginState, label: string): string {
  switch (state) {
    case "starting":
      return `Starting the ${label} sign-in on this server`;
    case "awaiting-browser":
      return "Waiting for you to finish in the browser";
    // Anthropic's client prints its code prompt the instant the link exists,
    // so this state does NOT mean a code has been shown yet: the person may
    // still be on step 1. "Waiting for the code Anthropic showed you" claimed
    // a code that usually did not exist.
    case "awaiting-code":
      return "Waiting for you to sign in and paste the code";
    case "finishing":
      return `Confirming the sign-in with ${label}`;
    case "succeeded":
      return "Connected";
    case "cancelled":
      return "Sign-in cancelled";
    case "failed":
      return "Sign-in did not finish";
  }
}

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

// ------------------------------------------------------------- the paste form

function PasteForm({
  backend,
  kind,
  busy,
  onCancel,
  submit,
}: {
  backend: "claude" | "codex";
  kind: "api_key" | "access_token";
  busy: boolean;
  onCancel: () => void;
  submit: (fields: Record<string, string>) => void;
}) {
  const [secret, setSecret] = useState("");
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  const field = useRef<HTMLInputElement | null>(null);
  const noun = kind === "access_token" ? "workspace access token" : "API key";
  // The refusal says what `validatePastedSecret` says, and the server calls a
  // workspace access token an "access token", so the two agree word for word.
  const serverNoun = kind === "access_token" ? "access token" : "API key";
  const fieldId = `agentacc-${backend}-${kind}`;
  const errId = `${fieldId}-err`;
  const empty = secret.trim() === "";
  const invalid = refused > 0 && empty;

  // Ruling 147: Save stays enabled until the request starts; an empty field is
  // refused here, with the sentence the server would have thrown, and never
  // becomes a request. A pristine form is never marked.
  const save = () => {
    if (busy) return;
    if (empty) {
      setRefused((n) => n + 1);
      field.current?.focus();
      return;
    }
    submit({ intent: "backend-set-key", backend, kind, secret });
  };

  return (
    <div className="field spaced">
      <label className="flabel" htmlFor={fieldId}>
        {kind === "access_token" ? "Workspace access token" : "API key"}{" "}
        <span className="fhint">
          {kind === "access_token"
            ? "stored sealed, never shown again. There is no free way to check a workspace token, so it is saved unverified"
            : "stored sealed, never shown again. Checked against the provider before it is saved"}
        </span>
      </label>
      {/* The label promises the value is never displayed, so the field must not
          display it either: `type="password"` plus the autofill and
          spell-check opt-outs the GitHub PAT form settled on, which keep a
          pasted credential out of every password manager and dictionary. */}
      <input
        ref={field}
        id={fieldId}
        type="password"
        className="mono"
        value={secret}
        autoComplete="new-password"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errId : undefined}
        placeholder={backend === "claude" ? "sk-ant-…" : "sk-…"}
        onChange={(e) => setSecret(e.target.value)}
      />
      {invalid ? (
        <div
          key={`refused-${refused}`}
          id={errId}
          className={"login-err" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
          role="alert"
        >
          <Icon name="alert" />
          Paste the {serverNoun} first.
        </div>
      ) : null}
      <div className="cred-manage">
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          aria-busy={busy}
          onClick={save}
        >
          Save {noun}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ the sign-in

/** The company whose page the person signs in on. The step titles name the
 *  company; the badge, the buttons and every sentence keep the ruling-92
 *  product names ("Claude", "Codex"). */
const VENDOR = { claude: "Anthropic", codex: "OpenAI" } as const;

type StepState = "pending" | "current" | "done";

/** The host of the vendor's link, shown beside the Open button so the person
 *  can see where a new tab is about to go. A line the vendor printed that
 *  `URL` cannot parse gets no host, not a crash. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function StepMark({ n, state }: { n: number; state: StepState }) {
  return (
    <span className="signin-mark" aria-hidden="true">
      {state === "done" ? <Icon name="check" /> : n}
    </span>
  );
}

/**
 * A running sign-in as two numbered steps and a status line.
 *
 * Both vendors print their URL and, an instant later, what the person needs
 * next (Claude: the prompt for the code Anthropic will show; Codex: the
 * one-time code), so for most of the flow BOTH steps are actionable and both
 * markers read as current. A step is `pending` only until its own input has
 * arrived, and `done` once the code is on its way (`finishing`). Nothing here
 * can know whether the person has opened the link, so step 1 is never marked
 * done on its own.
 *
 * The URL is never printed. It is a few hundred characters of OAuth
 * parameters, and printed inline it crushed the step labels to one word per
 * line and ran off the card; the link is the Open button, and the host beside
 * it says where the tab goes.
 *
 * Accessibility: the status line is the ONE polite live region. The old card
 * made the whole step list `role="status"`, whose implicit `aria-atomic`
 * re-read every character of the URL on each poll that changed anything. The
 * list is a labelled group that takes focus once, when it replaces the button
 * the person pressed (the card mounts it per session id, so a restarted
 * sign-in moves focus again and the 2 s poll's re-renders never do).
 *
 * Ruling 147 for the code field: Submit stays enabled, an empty submit is
 * refused with the server's own sentence as a fresh alert, the field marked
 * and focused, and never becomes a request. The field itself is disabled only
 * while Anthropic has not asked for a code yet, which is availability, not
 * validation.
 */
function SignInSteps({
  backend,
  label,
  login,
  busy,
  inFlight,
  submit,
}: {
  backend: "claude" | "codex";
  label: string;
  login: NonNullable<ProfileBackend["login"]>;
  busy: boolean;
  /** Ruling 368: the intent THIS card sent, while it is in flight. */
  inFlight: string | null;
  submit: (fields: Record<string, string>) => void;
}) {
  const codeId = `agentacc-${backend}-code`;
  const errId = `${codeId}-err`;
  const [code, setCode] = useState("");
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  // Ruling 294: WHICH button just copied, not merely that one did. Step 1 now
  // has a copy-link button and step 2 (on codex) still has the copy-code one,
  // inside the same component — one boolean made both read "Copied" at once,
  // and the later reset would have blanked the other's confirmation early.
  const [copied, setCopied] = useState<"link" | "code" | null>(null);
  const group = useRef<HTMLDivElement | null>(null);
  const codeField = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    group.current?.focus();
  }, []);

  const past = login.state === "finishing";
  const openStep: StepState = past ? "done" : "current";
  const codeReady =
    backend === "codex" ? login.userCode !== null : login.needsCode;
  const codeStep: StepState = past ? "done" : codeReady ? "current" : "pending";
  // Hoisted so the copy closure narrows: TS drops property narrowing at a
  // function boundary, which is why the code button below reads
  // `login.userCode ?? ""` inside its own handler.
  const url = login.url;
  const host = url ? hostOf(url) : null;
  const codeEmpty = code.trim() === "";
  const codeInvalid = refused > 0 && codeEmpty;

  const submitCode = () => {
    if (codeEmpty) {
      setRefused((n) => n + 1);
      codeField.current?.focus();
      return;
    }
    submit({ intent: "backend-login-code", backend, code });
  };
  const copyValue = async (what: "link" | "code", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      // Clears only its OWN key: copying the code and then the link must not
      // cancel the link's confirmation when the code's timer comes due.
      window.setTimeout(() => {
        setCopied((cur) => (cur === what ? null : cur));
      }, 1400);
    } catch {
      // Clipboard denied (permissions, insecure origin). The link and the code
      // are both on screen and a click selects either, which is the fallback
      // that always works.
    }
  };

  return (
    <div
      className="signin"
      role="group"
      aria-label={`${label} sign-in`}
      tabIndex={-1}
      ref={group}
    >
      <ol className="signin-steps">
        <li className="signin-step" data-state={openStep}>
          <StepMark n={1} state={openStep} />
          {openStep === "done" ? <span className="vh">done: </span> : null}
          <div className="signin-body">
            <div className="signin-title">
              Sign in on {VENDOR[backend]}&apos;s page
            </div>
            <div className="signin-act">
              {url ? (
                <>
                  <a className="btn sm" href={url} target="_blank" rel="noreferrer">
                    Open sign-in page
                    <Icon name="ext" className="ico-end" />
                  </a>
                  {/* Ruling 294 (owner's ask): the LINK, copyable. Opening it
                      here only works when the browser reading this page is the
                      one holding the vendor session, and often it is not: the
                      instance runs on a server, a person is on a second
                      machine, or the sign-in has to finish in a different
                      profile. Until now the only way to move the URL was to
                      right-click an anchor whose href is a 300-character OAuth
                      redirect. Same fixture as the code button below, which is
                      the point: one gesture on this card, learned once.
                      The label deliberately does NOT embed the URL — a screen
                      reader reading those 300 characters is exactly what
                      `hostOf` exists to prevent. */}
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={`Copy the ${VENDOR[backend]} sign-in link`}
                    onClick={() => void copyValue("link", url)}
                  >
                    <CopyGlyph copied={copied === "link"} />
                    {copied === "link" ? <span className="copy-done">Copied</span> : "Copy link"}
                  </button>
                </>
              ) : (
                <button type="button" className="btn sm" disabled>
                  Open sign-in page
                  <Icon name="ext" className="ico-end" />
                </button>
              )}
              {host ? <span className="fine mono signin-host">{host}</span> : null}
            </div>
          </div>
        </li>
        <li className="signin-step" data-state={codeStep}>
          <StepMark n={2} state={codeStep} />
          {codeStep === "done" ? <span className="vh">done: </span> : null}
          {backend === "codex" ? (
            <div className="signin-body">
              <div className="signin-title">Enter this code on that page</div>
              <div className="signin-act">
                {login.userCode ? (
                  <>
                    <span className="signin-code">{login.userCode}</span>
                    <button
                      type="button"
                      className="btn ghost sm"
                      aria-label={`Copy the sign-in code ${login.userCode}`}
                      onClick={() => void copyValue("code", login.userCode ?? "")}
                    >
                      <CopyGlyph copied={copied === "code"} />
                      {copied === "code" ? <span className="copy-done">Copied</span> : "Copy"}
                    </button>
                  </>
                ) : (
                  <span className="fine">waiting for the code</span>
                )}
              </div>
            </div>
          ) : (
            <div className="signin-body field">
              <label className="signin-title" htmlFor={codeId}>
                Paste the code Anthropic shows you
              </label>
              <div className="signin-act">
                <input
                  ref={codeField}
                  id={codeId}
                  type="text"
                  className="mono"
                  value={code}
                  disabled={!login.needsCode}
                  aria-invalid={codeInvalid || undefined}
                  aria-describedby={codeInvalid ? errId : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  onChange={(e) => setCode(e.target.value)}
                />
                <button
                  type="button"
                  className="btn sm"
                  disabled={!login.needsCode || busy}
                  aria-busy={inFlight === "backend-login-code" || undefined}
                  onClick={submitCode}
                >
                  {inFlight === "backend-login-code" && <Icon name="loader" className="spin" />}
                  {inFlight === "backend-login-code" ? "Submitting…" : "Submit code"}
                </button>
              </div>
              {codeInvalid ? (
                <div
                  key={`refused-${refused}`}
                  id={errId}
                  className={"login-err" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
                  role="alert"
                >
                  <Icon name="alert" />
                  Paste the code Anthropic showed you.
                </div>
              ) : null}
            </div>
          )}
        </li>
      </ol>
      <div className="signin-foot">
        <p className="signin-status" role="status" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />
          {statusLine(login.state, label)}
        </p>
        <button
          type="button"
          className="btn ghost sm push"
          disabled={busy}
          aria-busy={inFlight === "backend-login-cancel" || undefined}
          onClick={() => submit({ intent: "backend-login-cancel", backend })}
        >
          {inFlight === "backend-login-cancel" && <Icon name="loader" className="spin" />}
          {inFlight === "backend-login-cancel" ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- one backend

/**
 * Ruling 294: a reading's percentage, clamped.
 *
 * The clamp is not defensive noise: a provider on OVERAGE reports a utilization
 * above 1, and rounding that unclamped renders "118% of seven day" on a card
 * whose whole job is to be a number a person trusts. /insights clamps for the
 * same reason (`pctOf`, insights-page.tsx); this is the same expression rather
 * than a second one that can drift from it.
 */
function usagePct(utilization: number | null): number | null {
  if (utilization == null) return null;
  return Math.max(0, Math.min(100, Math.round(utilization * 100)));
}

/**
 * The pill's text. Two absences are handled and neither is faked:
 *
 * A null `utilization` reads "not reported", never 0% — `wire-format.server`
 * states the rule for the same field ("a missing utilization must read as 'not
 * reported', never as a fabricated 0% that looks like a fresh quota"), and a
 * fabricated zero on this card would read as a completely fresh window.
 *
 * An EMPTY `rateLimitType` falls back to "window". The wire format turns a
 * missing provider string into `""` rather than null, so `${type}` composes to
 * "62% of " with a dangling preposition. `wire-format.server` already solved
 * this with `info.rateLimitType || "window"`; this is that fallback, not a new
 * one. (/insights composes the raw field and has the same latent defect; it is
 * not cloned here.)
 */
function usageText(usage: NonNullable<ProfileBackend["usage"]>): string {
  const window = (usage.rateLimitType || "window").replaceAll("_", " ");
  // Ruling 481(d): the window this figure was read in is over, so the figure
  // describes nothing current. It used to stay "92% of five hour" for hours.
  if (usage.windowReset) return `${window} window reset`;
  const pct = usagePct(usage.utilization);
  if (pct === null) return `${window} usage not reported`;
  return `${pct}% of ${window}`;
}

/** Warn only on the provider's OWN warning word or on overage. Viberr does not
 *  invent a threshold: a percentage it decided was alarming would be Viberr's
 *  opinion wearing the provider's authority. */
function usagePillKind(usage: NonNullable<ProfileBackend["usage"]>): "neutral" | "risk" {
  // A warning from a window that has since reset warns about nothing.
  if (usage.windowReset) return "neutral";
  return usage.isUsingOverage || usage.status.includes("warning") ? "risk" : "neutral";
}

/**
 * Ruling 507: how an account was connected, as the line under its name says
 * it. The name itself says WHICH account (`backendAccountName`); this says what
 * kind, so a person holding a sign-in and a key can tell them apart at a glance.
 */
const ACCOUNT_KIND_WORD = {
  claudeai: "Claude sign-in (claude.ai)",
  console: "Console sign-in",
  device: "ChatGPT sign-in",
} as const satisfies Record<LoginMethod, string>;

function accountKindWord(health: UserBackendHealth): string {
  if (health.kind === "login") {
    return health.method ? ACCOUNT_KIND_WORD[health.method] : "Sign-in";
  }
  return health.kind === "access_token" ? "Workspace access token" : "API key";
}


/**
 * Ruling 507: give an account the person's own name, or clear it. The same
 * field idiom as the key paste form (a `.field` with its label and the card's
 * button row), prefilled with the name it has; an empty save clears the name
 * and the account is named by its vendor facts again. Ruling 147: Save is
 * enabled until the request starts, and an over-long name is refused here
 * with the store's own sentence.
 */
function RenameForm({
  backend,
  account,
  maxLength,
  busy,
  inFlight,
  onCancel,
  submit,
}: {
  backend: "claude" | "codex";
  account: ProfileBackendAccount;
  maxLength: number;
  busy: boolean;
  inFlight: boolean;
  onCancel: () => void;
  submit: (fields: Record<string, string>) => void;
}) {
  const [name, setName] = useState(account.label ?? "");
  const [refused, setRefused] = useState(0);
  const refusalShake = useRefusalShake(refused);
  const field = useRef<HTMLInputElement | null>(null);
  const fieldId = `agentacc-${account.id}-name`;
  const errId = `${fieldId}-err`;
  const tooLong = name.trim().length > maxLength;
  const invalid = refused > 0 && tooLong;

  useEffect(() => {
    field.current?.focus();
  }, []);

  const save = () => {
    if (busy) return;
    if (tooLong) {
      setRefused((n) => n + 1);
      field.current?.focus();
      return;
    }
    submit({ intent: "backend-account-rename", backend, account: account.id, name });
  };

  return (
    <div className="field spaced">
      <label className="flabel" htmlFor={fieldId}>
        Account name{" "}
        <span className="fhint">shown only to you; leave it empty to go back to {account.name}</span>
      </label>
      <input
        ref={field}
        id={fieldId}
        type="text"
        value={name}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errId : undefined}
        placeholder="Work, Personal…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      />
      {invalid ? (
        <div
          key={`refused-${refused}`}
          id={errId}
          className={"login-err" + (refusalShake.shake ? " refused" : "")}
          onAnimationEnd={refusalShake.onAnimationEnd}
          role="alert"
        >
          <Icon name="alert" />
          An account name can be at most {maxLength} characters.
        </div>
      ) : null}
      <div className="cred-manage">
        <button type="button" className="btn sm" disabled={busy} aria-busy={inFlight || undefined} onClick={save}>
          {inFlight && <Icon name="loader" className="spin" />}
          {inFlight ? "Saving…" : "Save name"}
        </button>
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- the account picker

/** The menu's room: from the trigger, from the edge of the box that clips it,
 *  and the least height a capped menu keeps (its head, two accounts and the
 *  actions under the rule). */
const MENU_GAP = 4;
const MENU_EDGE = 8;
const MENU_MIN = 220;

interface MenuPlace {
  side: "top" | "bottom";
  maxHeight?: number;
}

/**
 * Ruling 616: which of a backend's accounts the person's runs use, as a select
 * (owner, 2026-10-01: "make this part shadcn like selection from the dropdown
 * between accounts of saved accounts to use a selected one in every
 * provider"). It replaces ruling 507's list of the other accounts, each with
 * its own Use this account.
 *
 * The trigger names the account in use. The menu lists every account the
 * person keeps on the backend, up to the store's ceiling, with the one in use
 * checked; choosing another is ruling 507's switch: one write, no sign-in, and
 * the next run bills it. An account whose sign-in file this server no longer
 * holds is listed but cannot be chosen, because the store refuses that switch,
 * and its line says why. Under a rule the menu carries what else starts here:
 * adding an account, and managing the others (a name, a sign-in, a disconnect)
 * without first making one of them the account in use. A switch made only to
 * disconnect an account would bill any run that started in between.
 *
 * The behaviour is this repo's menu contract (StageMenu, the run picker), not
 * Radix's: the Radix menu is about 32 KB gzip (ruling 457, `user-menu.tsx`)
 * for what a few handlers do here. A real button with `aria-haspopup="menu"`,
 * `menuitemradio` rows, focus on the checked row when it opens, ↑/↓ wrapping,
 * Home/End, Escape and Tab back to the trigger, and a press outside closes it.
 * The menu renders inside the card, not under `<body>`: Profile is a modal
 * `<dialog>`, and everything outside one is inert. It hangs from the trigger
 * at its width and opens upward when the overlay's scrolling body has no room
 * for it below, capping its height when neither side has: StageMenu's layo-8
 * placement, measured against the box that clips the menu.
 */
function AccountPicker({
  label,
  accounts,
  active,
  maxAccounts,
  busy,
  switchingTo,
  triggerRef,
  onSwitch,
  onAdd,
  onManage,
}: {
  label: string;
  accounts: ProfileBackendAccount[];
  active: ProfileBackendAccount;
  maxAccounts: number;
  /** An account request is in flight: both cards share the fetcher. */
  busy: boolean;
  /** Ruling 368: the account THIS card's switch names, while it is in flight. */
  switchingTo: string | null;
  /** Where the card returns focus when what the menu opened is closed. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSwitch: (accountId: string) => void;
  onAdd: () => void;
  /** Null while the person keeps no other account here. */
  onManage: (() => void) | null;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  // Null until the placement effect has measured the open menu.
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef(false);
  const close = (refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  };
  // The trigger is inside the wrapper, so pressing it toggles rather than
  // dismissing and reopening; Escape is consumed, so the Profile dialog
  // around the card does not close with the menu.
  const wrapRef = useDismiss<HTMLDivElement>(open, () => close(false));
  const atLimit = accounts.length >= maxAccounts;
  const switching = accounts.find((account) => account.id === switchingTo) ?? null;
  const rows = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? [],
    );

  // Before paint: below when it fits there, else above when it fits there,
  // else the roomier side with the height capped to it. The box is the
  // nearest scroller (Profile's overlay body), clipped to the viewport, less
  // the head the overlay pins over its top, read as ruling 532's
  // `revealUnderHead` reads it: a menu opened upward under that head covered
  // the page's title.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!open || place || !menu || !trigger) return;
    const at = trigger.getBoundingClientRect();
    const box = scrollingBox(trigger)?.getBoundingClientRect();
    const head = trigger.closest("dialog")?.querySelector(".board-head")?.getBoundingClientRect();
    const top = Math.max(box?.top ?? 0, head?.bottom ?? 0, 0) + MENU_EDGE;
    const bottom = Math.min(box?.bottom ?? window.innerHeight, window.innerHeight) - MENU_EDGE;
    const height = menu.offsetHeight;
    const below = bottom - at.bottom - MENU_GAP;
    const above = at.top - MENU_GAP - top;
    if (height <= below) setPlace({ side: "bottom" });
    else if (height <= above) setPlace({ side: "top" });
    else if (above > below) setPlace({ side: "top", maxHeight: Math.max(MENU_MIN, above) });
    else setPlace({ side: "bottom", maxHeight: Math.max(MENU_MIN, below) });
  }, [open, place, triggerRef]);

  // Once placed, the checked row takes the focus, so the arrows start from
  // the account in use, as a select does.
  useEffect(() => {
    if (!open || !place || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const all = rows();
    (all.find((row) => row.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
  }, [open, place]);

  const openMenu = () => {
    if (busy || switching) return;
    focusOnOpen.current = true;
    setOpen(true);
  };

  const choose = (account: ProfileBackendAccount) => {
    // The store refuses a switch to an account without its sign-in file; the
    // row says so and the menu stays open.
    if (!account.active && !account.health.available) return;
    close(true);
    if (!account.active && !busy) onSwitch(account.id);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    const at = all.findIndex((row) => row === document.activeElement);
    const step = (delta: 1 | -1) => {
      const next = at < 0 ? (delta > 0 ? 0 : all.length - 1) : (at + delta + all.length) % all.length;
      all[next]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "Home":
        event.preventDefault();
        all[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        all[all.length - 1]?.focus();
        break;
      // A menu is not walked with Tab: it closes, and the focus is back on
      // the trigger for the next Tab to leave from.
      case "Escape":
      case "Tab":
        event.preventDefault();
        close(true);
        break;
    }
  };

  return (
    <div className="acct-pick" ref={wrapRef}>
      <span className="flabel" id={`${ids}-label`}>
        Runs use
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="acct-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${ids}-menu` : undefined}
        // "Runs use work@example.com, Claude sign-in": the label and the
        // value, as the trigger shows them (WCAG 2.5.3).
        aria-labelledby={`${ids}-label ${ids}-value`}
        // Ruling 368: the switch in flight shows on its trigger; any other
        // request leaves the trigger waiting. Not `disabled`: a disabled
        // button drops the focus the menu has just handed back to it.
        aria-busy={switching ? true : undefined}
        aria-disabled={busy && !switching ? true : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) openMenu();
          else (rows().find((row) => row.getAttribute("aria-checked") === "true") ?? rows()[0])?.focus();
        }}
      >
        {/* The spaces between the spans are the accessible names': a flex
            box draws none of them, and without them a name ran on into the
            line under it ("work@example.comClaude sign-in"). */}
        <span className="acct-txt" id={`${ids}-value`}>
          <span className="acct-nm" title={active.name}>
            {active.name}
          </span>{" "}
          <span className="acct-sub">
            {switching ? `Switching to ${switching.name}…` : accountKindWord(active.health)}
          </span>
        </span>
        {switching ? <Icon name="loader" className="spin" /> : <Icon name="chevron" className="caret" />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={`${ids}-menu`}
          className="rsel-menu acct-menu"
          role="menu"
          aria-labelledby={`${ids}-head`}
          data-side={place?.side ?? "bottom"}
          style={place?.maxHeight ? { maxHeight: place.maxHeight } : undefined}
          onKeyDown={onMenuKeyDown}
        >
          <div className="acct-menu-head" id={`${ids}-head`}>
            <span className="flabel">{label} accounts</span>{" "}
            <span className="fine">
              {accounts.length} of {maxAccounts}
            </span>
          </div>
          {/* Only the accounts scroll: ten of them outgrow the menu, and the
              head and the actions under the rule stay where they are. */}
          <div className="acct-menu-list">
            {accounts.map((account) => {
              const on =
                account.health.connectedAt && utcDayKey(account.health.connectedAt)
                  ? account.health.connectedAt
                  : null;
              const unusable = !account.active && !account.health.available;
              return (
                <button
                  key={account.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={account.active}
                  aria-disabled={unusable || undefined}
                  tabIndex={-1}
                  className="rsel-item"
                  onClick={() => choose(account)}
                >
                  <span className="acct-txt">
                    <span className="acct-nm" title={account.name}>
                      {account.name}
                    </span>{" "}
                    <span className="acct-sub">
                      {accountKindWord(account.health)}
                      {account.active ? (
                        " · in use"
                      ) : on ? (
                        <>
                          {" "}· connected <LocalCalendarDate iso={on} />
                        </>
                      ) : null}
                      {account.health.available ? "" : " · sign-in file missing"}
                    </span>
                  </span>
                  {account.active ? <Icon name="check" className="acct-check" /> : null}
                </button>
              );
            })}
          </div>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            aria-disabled={atLimit || undefined}
            tabIndex={-1}
            className="menu-item"
            onClick={() => {
              if (atLimit) return;
              close(false);
              onAdd();
            }}
          >
            <Icon name="plus" />
            <span className="acct-txt">
              <span>Add another {label} account</span>{" "}
              {atLimit ? (
                <span className="acct-sub">
                  {maxAccounts} is the most one person can keep; disconnect one to add another.
                </span>
              ) : null}
            </span>
          </button>
          {onManage ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
                close(false);
                onManage();
              }}
            >
              <Icon name="sliders" />
              Manage other accounts
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AgentAccountCard({
  data,
  fetcher,
  submit,
}: {
  data: ProfileBackend;
  fetcher: AccountsFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const { backend, health, methods } = data;
  const label = BACKEND_LABEL[backend];
  // Ruling 507: every account the person holds here, the active one first.
  const accounts = data.accounts;
  const active = accounts.find((account) => account.active) ?? null;
  const others = accounts.filter((account) => !account.active);
  const limits = data.limits;
  // Ruling 130(d) (pass 34, F34-1): the last refusal Viberr OBSERVED on this
  // person's own account. The card used to say "connected · verified" while
  // every run on the account was refused with a 403.
  const lastRefusal = data.lastRefusal;
  const usage = data.usage;
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

  // The poll fetcher is the card's OWN: `/resources/backend-login` answers for
  // the signed-in caller only, and loading it on the panel's action fetcher
  // would overwrite the intent result the toast settles on. Once this tab is
  // signed out it answers a refusal (a 401, ruling 457), and a poll that fails
  // answers null (the route's `clientLoader`); neither names a session, so
  // neither matches the loader's below.
  const poll = useFetcher<BackendLoginPollAnswer | null>();
  // The LOADER decides which session exists; the poll only supplies a fresher
  // state OF THAT SESSION. Matching on the id is what keeps a stale answer from
  // an earlier sign-in (a fetcher keeps its last data indefinitely) from
  // rendering a brand-new attempt as already finished.
  // SAFETY: a refusal carries no `login` (`BackendLoginRefusal`), so an answer
  // naming the loader's session is always the poll's own data.
  const polled =
    poll.data && data.login && poll.data.login?.id === data.login.id
      ? (poll.data as BackendLoginPollData)
      : null;
  const login = polled?.login ?? data.login;
  // A poll may only ADD "connected", never take it away: the loader is the
  // authority on a stored credential, and this covers the moment between the
  // vendor confirming a sign-in and the revalidation landing.
  const connected = health.available || (polled?.health.available ?? false);
  // Being connected does NOT hide a sign-in that is under way. A person whose
  // key already works may start a hosted sign-in (or restart one after a
  // failure), and suppressing this card would run the vendor's process
  // invisibly: no URL to open, no code, no Cancel, until it timed out.
  const running = login !== null && !TERMINAL_STATES.has(login.state);

  // `fetcher.load` is not a stable identity across renders, so the interval
  // reads the current one through a ref instead of resubscribing every render
  // (the pattern `useFetcherResult` uses for its handler).
  const load = useRef(poll.load);
  useEffect(() => {
    load.current = poll.load;
  });
  useEffect(() => {
    if (!running) return;
    const url = `/resources/backend-login?backend=${backend}`;
    const timer = setInterval(() => load.current(url), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, backend]);

  // The success toast settles on the POLL RESULT, which is the first moment the
  // vendor's own binary has confirmed the sign-in. Toasting at submit time
  // would claim a connection while the browser step had not even started.
  // Keyed by SESSION id, not a boolean: a person who disconnects and signs in
  // again in the same page session must be told about the second connection too.
  const announced = useRef<string | null>(null);
  useFetcherResult(poll, (payload) => {
    const done = payload.login;
    if (!done || done.state !== "succeeded" || announced.current === done.id) {
      return;
    }
    announced.current = done.id;
    push(`${label} connected`);
    setAdding(false);
    // The card's connected state, the health pill and every other surface that
    // reads this person's backends come from the loader, not from the poll.
    void revalidator.revalidate();
  });

  // A completed rename or saved key closes what the person had open for it.
  // Settled on the RESULT, so a refusal leaves the field as it was. The
  // disconnect dialog closes on either outcome: it holds its busy state until
  // the answer lands, and then the toast or the inline error says what
  // happened (the card stays mounted now that other accounts may remain).
  useFetcherResult(fetcher, (result) => {
    if (result.intent === "backend-disconnect") setConfirmDisconnect(null);
    if (!result.ok) return;
    if (result.intent === "backend-account-rename") setRenaming(null);
    if (result.intent === "backend-set-key") {
      setPaste(null);
      setAdding(false);
    }
  });

  const busy = fetcher.state !== "idle";
  // Ruling 368: both cards share the fetcher, so the request is THIS card's
  // only when it names this backend; the button that sent it shows the work
  // and every other control (this card's and the other card's) only waits.
  const sent = inFlightIntent(fetcher);
  const inFlight = sent !== null && fetcher.formData?.get("backend") === backend ? sent : null;
  // Ruling 507: and within the card, the ACCOUNT it names ("" for a sign-in
  // that adds a new one), so only that row's button shows the work.
  const inFlightAccount = inFlight !== null ? String(fetcher.formData?.get("account") ?? "") : null;
  const startingMethod =
    inFlight === "backend-login-start" ? String(fetcher.formData?.get("method") ?? "") : null;
  const starting = (method: LoginMethod, account: string) =>
    startingMethod === method && inFlightAccount === account;
  const accountBusy = (intent: string, account: string) =>
    inFlight === intent && inFlightAccount === account;
  /** The badge says where this account STANDS, in the person's vocabulary. The
   *  stored `kind` (`api_key`, `access_token`) is our schema, not their word.
   *  An unconnected card says so in words: the "−" this slot used to show read
   *  as a collapse control that did nothing. A sign-in under way wins over
   *  "connected": it is what the card is showing, and it is what the person is
   *  waiting on. */
  const badge = running ? "signing in" : connected ? "connected" : "not connected";
  // A timestamp the card cannot read is omitted together with its " on " /
  // "verified " lead-in, never rendered as the word "null". The date itself
  // renders through the hydration-safe primitive: UTC day first, the viewer's
  // calendar date after hydration (pass 34, C6).
  const connectedOn =
    health.connectedAt && utcDayKey(health.connectedAt) ? health.connectedAt : null;
  const verifiedOn =
    health.verifiedAt && utcDayKey(health.verifiedAt) ? health.verifiedAt : null;

  /** Start a sign-in: into a new account, or (`account`) into that existing
   *  sign-in again (ruling 507). */
  const startSignIn = (method: LoginMethod, account: string) => {
    if (account) submit({ intent: "backend-login-start", backend, method, account });
    else submit({ intent: "backend-login-start", backend, method });
  };

  /** A "Sign in with …" button for each vendor flow: into a new account, or
   *  (`account`) into that existing sign-in again. The vendor's own sign-in
   *  leads when `lead` is set; the other flows stay neutral. */
  const signInButtons = (account: string, lead: boolean) =>
    methods.signIn.map((method, i) => (
      <button
        key={method}
        type="button"
        className={"btn sm" + (lead && i === 0 ? " primary" : "")}
        disabled={busy}
        aria-busy={starting(method, account) || undefined}
        onClick={() => startSignIn(method, account)}
      >
        {starting(method, account) && <Icon name="loader" className="spin" />}
        {starting(method, account) ? "Starting sign-in…" : SIGN_IN_LABEL[method]}
      </button>
    ));

  /** The ways to connect an account: every sign-in the vendor offers, then the
   *  paste methods, and the paste form when one is open. The whole of a fresh
   *  card, and what "Add another account" opens on a connected one. */
  const connectWays = (
    <>
      <div className="cred-manage">
        {signInButtons("", true)}
        {methods.paste.map((kind) => (
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
          backend={backend}
          kind={paste}
          busy={busy}
          onCancel={() => setPaste(null)}
          submit={submit}
        />
      )}
    </>
  );

  /** The two manage buttons every account carries, the active one included. */
  const manageButtons = (account: ProfileBackendAccount) => (
    <>
      <button
        type="button"
        className="btn ghost sm"
        disabled={busy}
        onClick={() => setRenaming(renaming === account.id ? null : account.id)}
      >
        Rename
      </button>
      <button
        type="button"
        // Ruling 149: dropping the stored credential is destructive.
        className="btn ghost sm danger"
        disabled={busy}
        aria-busy={accountBusy("backend-disconnect", account.id) || undefined}
        // Ruling 481(b) (F40-49): it asks first, like every other one-way
        // control (ruling 458(f)). One tap used to sign the vendor session
        // out, with no undo short of a fresh sign-in.
        onClick={() => setConfirmDisconnect(account)}
      >
        {accountBusy("backend-disconnect", account.id) && <Icon name="loader" className="spin" />}
        {accountBusy("backend-disconnect", account.id) ? "Disconnecting…" : "Disconnect"}
      </button>
    </>
  );

  const renameFor = (account: ProfileBackendAccount) =>
    renaming === account.id ? (
      <RenameForm
        backend={backend}
        account={account}
        maxLength={limits.maxLabelLength}
        busy={busy}
        inFlight={accountBusy("backend-account-rename", account.id)}
        onCancel={() => setRenaming(null)}
        submit={submit}
      />
    ) : null;

  // The account a running or failed sign-in is FOR, when it is one the person
  // already has (signing an existing sign-in in again, ruling 507).
  const loginAccount =
    login?.existingAccount ? accounts.find((account) => account.id === login.accountId) ?? null : null;

  return (
    <div className="cred-card">
      <div className="cred-top">
        {/* Ruling 625: the backend's own mark (Claude's sparkle, Codex's
            chip), as every other surface draws it; the name beside it is the
            text, so the tile is decorative. */}
        <AgentGlyph backend={backend} decorative />
        <span className="cred-name">{label}</span>
        <span className="fine push">{badge}</span>
      </div>

      {/* A failed sign-in is reported ALONGSIDE whatever is connected, never
          instead of it: a person whose key still works must not be told they
          have nothing because one browser flow timed out. */}
      {!running && login?.state === "failed" && (
        <>
          <div className="login-err spaced" role="alert">
            <Icon name="alert" />
            {login.error ?? `${label} sign-in did not finish.`}
          </div>
          <div className="cred-manage">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              aria-busy={starting(login.method, login.existingAccount ? login.accountId : "") || undefined}
              onClick={() =>
                // Ruling 507: again into the same account the failed flow was
                // for; a new account's attempt starts a new one.
                startSignIn(login.method, login.existingAccount ? login.accountId : "")
              }
            >
              {starting(login.method, login.existingAccount ? login.accountId : "") && (
                <Icon name="loader" className="spin" />
              )}
              {starting(login.method, login.existingAccount ? login.accountId : "")
                ? "Starting sign-in…"
                : "Start again"}
            </button>
          </div>
        </>
      )}

      {running && login ? (
        <>
          {/* Ruling 507: which account the sign-in is for, when the card
              already has one — the steps below look the same either way. */}
          {accounts.length > 0 ? (
            <p className="fine spaced">
              {loginAccount
                ? `Signing in to ${loginAccount.name} again.`
                : `Adding another ${label} account. The ${accounts.length === 1 ? "one" : "ones"} you have stay${accounts.length === 1 ? "s" : ""} connected.`}
            </p>
          ) : null}
          <SignInSteps
            key={login.id}
            backend={backend}
            label={label}
            login={login}
            busy={busy}
            inFlight={inFlight}
            submit={submit}
          />
        </>
      ) : active ? (
        <>
          {/* Ruling 616: which account runs bill is the picker's to say and
              to change; the line under it is that account's health. */}
          <AccountPicker
            label={label}
            accounts={accounts}
            active={active}
            maxAccounts={limits.maxAccounts}
            busy={busy}
            switchingTo={inFlight === "backend-account-switch" ? inFlightAccount : null}
            triggerRef={picker}
            onSwitch={(account) => submit({ intent: "backend-account-switch", backend, account })}
            onAdd={() => openSection("adding")}
            onManage={others.length > 0 ? () => openSection("managing") : null}
          />
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
          {usage ? (
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
          ) : null}
          {/* Design pass 2026-09-08: a forty-word sentence is prose, not a
              datum — as a `.kv-row` value it sat right-aligned across the
              card's width with no measure. It is the sheet's note idiom now
              (icon, sentence, 70ch), with the label folded in as its lead. */}
          {lastRefusal ? (
            <div className="pol-note after last" data-refusal={lastRefusal.kind}>
              <Icon name="alert" />
              <span>
                <strong>
                  {lastRefusal.kind === "credential" ? "Last refusal" : "Usage window"}
                </strong>
                {" · "}
                {lastRefusal.kind === "credential" ? (
                  <>
                    Refused by the provider on{" "}
                    <LocalDayDotTime iso={lastRefusal.observedAt} />:{" "}
                    {lastRefusal.providerText} This is the last refusal Viberr
                    observed on this account; any completed {label} run retires
                    it, as does switching to or connecting a different {label}{" "}
                    account here, so its absence is not proof the account works.
                  </>
                ) : (
                  <>
                    Spent as of <LocalDayDotTime iso={lastRefusal.observedAt} />
                    {lastRefusal.resetsAt ? (
                      <>
                        ; reopens <LocalDayDotTime iso={lastRefusal.resetsAt} />
                      </>
                    ) : null}
                    . Any completed {label} run retires this notice, as does
                    switching to or connecting a different {label} account here;
                    until then, runs billed to this account are refused.
                  </>
                )}
              </span>
            </div>
          ) : null}
          <div className="cred-manage">
            {/* The health detail for a vanished credential file ends "Sign in
                again on your Profile → Agent accounts", which is THIS card: so
                the card has to carry the sign-in it names, or the only way out
                of a wiped runtime volume would be to guess that Disconnect
                comes first. Ruling 507: into THIS account's own home, when it
                is a sign-in; a pasted key never goes missing. */}
            {!health.available && health.kind === "login" && signInButtons(active.id, false)}
            {manageButtons(active)}
          </div>
          {renameFor(active)}

          {/* Ruling 616: the person's other accounts on this backend, opened
              from the picker's menu, which is also where switching to one
              lives. Each is renamed, signed in again or disconnected where it
              stands: making one the account in use only to disconnect it
              would bill any run that started in between. */}
          {managing && others.length > 0 ? (
            <div
              className="acct-list"
              role="group"
              aria-labelledby={`agentacc-${backend}-others`}
              tabIndex={-1}
              ref={managingBox}
            >
              <div className="acct-list-head">
                <h3 className="flabel" id={`agentacc-${backend}-others`}>
                  Other {label} accounts
                </h3>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setManaging(false);
                    setRenaming(null);
                    picker.current?.focus();
                  }}
                >
                  Done
                </button>
              </div>
              <div className="conn-list">
                {others.map((account) => {
                  const on =
                    account.health.connectedAt && utcDayKey(account.health.connectedAt)
                      ? account.health.connectedAt
                      : null;
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
                        {!account.health.available && account.health.kind === "login"
                          ? signInButtons(account.id, false)
                          : null}
                        {manageButtons(account)}
                      </div>
                      {renameFor(account)}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Ruling 616: opened from the picker's menu, which says when the
              ceiling leaves no room for another. */}
          {adding ? (
            <div
              className="acct-list"
              role="group"
              aria-labelledby={`agentacc-${backend}-adding`}
              tabIndex={-1}
              ref={addingBox}
            >
              <h3 className="flabel" id={`agentacc-${backend}-adding`}>
                Add another {label} account
              </h3>
              <p className="fine">
                It becomes the account your runs use; the{" "}
                {accounts.length === 1 ? "one" : "ones"} you have stay connected, and
                switching back needs no sign-in.
              </p>
              {connectWays}
              <div className="cred-manage">
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => {
                    setAdding(false);
                    setPaste(null);
                    picker.current?.focus();
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {confirmDisconnect && (
            <ConfirmDialog
              screenLabel="Disconnect agent account dialog"
              title={
                accounts.length > 1 ? `Disconnect ${confirmDisconnect.name}?` : `Disconnect ${label}?`
              }
              body={
                <>
                  Viberr signs this server out of{" "}
                  {accounts.length > 1 ? <>this {label} account</> : <>your {label} account</>} and
                  deletes the stored credential.{" "}
                  {!confirmDisconnect.active ? (
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
              confirmLabel={
                accounts.length > 1 ? `Disconnect ${confirmDisconnect.name}` : `Disconnect ${label}`
              }
              busy={busy}
              onCancel={() => setConfirmDisconnect(null)}
              onConfirm={() => {
                // Close any paste form the card was showing before this
                // connection existed, so disconnecting does not re-reveal a
                // half-typed key field.
                setPaste(null);
                setRenaming(null);
                submit({ intent: "backend-disconnect", backend, account: confirmDisconnect.id });
              }}
            />
          )}
        </>
      ) : (
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
              own {label} account.
            </span>
          </div>
          {connectWays}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- panel

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
