import type { LoginState } from "~/server/runtimes/backend-login.server";
import type {
  LoginMethod,
  UserBackendHealth,
} from "~/server/runtimes/backend-credentials.server";
import { utcDayKey } from "~/shared/dates/format";
import { inFlightIntent } from "~/ui/in-flight";
import type { ProfileBackend, ProfileBackendAccount } from "./profile-query.server";

/**
 * What Profile → Agent accounts reads off its props and its fetcher before it
 * draws (ruling 13(b), the split of `agent-accounts-panel.tsx` along the task
 * page's recipe): the vendors' own words for their flows, a running sign-in's
 * status line, an account's kind, the usage pill, the badge, and which request
 * in flight is this card's. Pure functions of the loader data and the fetcher,
 * no React.
 */

/** How each vendor's own sign-in flow is named to the person starting it. */
export const SIGN_IN_LABEL = {
  claudeai: "Sign in with Claude",
  console: "Sign in with Console",
  device: "Sign in with ChatGPT",
} as const satisfies Record<LoginMethod, string>;

export const PASTE_LABEL = {
  api_key: "Use an API key",
  access_token: "Use a workspace access token",
} as const;

/** How a completed connection reads back. */
export const SIGN_IN_CONNECTED = {
  claudeai: "Connected via Claude sign-in (claude.ai)",
  console: "Connected via Console sign-in",
  device: "Connected via ChatGPT sign-in",
} as const satisfies Record<LoginMethod, string>;

/** The company whose page the person signs in on. The step titles name the
 *  company; the badge, the buttons and every sentence keep the ruling-298
 *  product names ("Claude", "Codex"). */
export const VENDOR = { claude: "Anthropic", codex: "OpenAI" } as const;

/** What the person is waiting for, in their words. The server's own states are
 *  machine vocabulary; a status line that said "awaiting-browser" would be a
 *  leak of the state machine, not a status. */
export function statusLine(state: LoginState, label: string): string {
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

/** The host of the vendor's link, shown beside the Open button so the person
 *  can see where a new tab is about to go. A line the vendor printed that
 *  `URL` cannot parse gets no host, not a crash. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Ruling 161: a reading's percentage, clamped.
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
export function usageText(usage: NonNullable<ProfileBackend["usage"]>): string {
  const window = (usage.rateLimitType || "window").replaceAll("_", " ");
  // Ruling 161(c): the window this figure was read in is over, so the figure
  // describes nothing current. It used to stay "92% of five hour" for hours.
  if (usage.windowReset) return `${window} window reset`;
  const pct = usagePct(usage.utilization);
  if (pct === null) return `${window} usage not reported`;
  return `${pct}% of ${window}`;
}

/** Warn only on the provider's OWN warning word or on overage. Viberr does not
 *  invent a threshold: a percentage it decided was alarming would be Viberr's
 *  opinion wearing the provider's authority. */
export function usagePillKind(usage: NonNullable<ProfileBackend["usage"]>): "neutral" | "risk" {
  // A warning from a window that has since reset warns about nothing.
  if (usage.windowReset) return "neutral";
  return usage.isUsingOverage || usage.status.includes("warning") ? "risk" : "neutral";
}

/**
 * Ruling 138: how an account was connected, as the line under its name says
 * it. The name itself says WHICH account (`backendAccountName`); this says what
 * kind, so a person holding a sign-in and a key can tell them apart at a glance.
 */
const ACCOUNT_KIND_WORD = {
  claudeai: "Claude sign-in (claude.ai)",
  console: "Console sign-in",
  device: "ChatGPT sign-in",
} as const satisfies Record<LoginMethod, string>;

export function accountKindWord(health: UserBackendHealth): string {
  if (health.kind === "login") {
    return health.method ? ACCOUNT_KIND_WORD[health.method] : "Sign-in";
  }
  return health.kind === "access_token" ? "Workspace access token" : "API key";
}

/** A timestamp the card can read, or null. One it cannot is omitted together
 *  with its " on " / "verified " lead-in, never rendered as the word "null";
 *  the date itself renders through the hydration-safe primitive: UTC day
 *  first, the viewer's calendar date after hydration (pass 34, C6). */
export function readableDate(iso: string | null): string | null {
  return iso && utcDayKey(iso) ? iso : null;
}

/** The badge says where this account STANDS, in the person's vocabulary. The
 *  stored `kind` (`api_key`, `access_token`) is our schema, not their word.
 *  An unconnected card says so in words: the "−" this slot used to show read
 *  as a collapse control that did nothing. A sign-in under way wins over
 *  "connected": it is what the card is showing, and it is what the person is
 *  waiting on. */
export function cardBadge(running: boolean, connected: boolean): string {
  return running ? "signing in" : connected ? "connected" : "not connected";
}

/** The account a running or failed sign-in is FOR, when it is one the person
 *  already has (signing an existing sign-in in again, ruling 138). */
export function loginAccount(
  login: NonNullable<ProfileBackend["login"]>,
  accounts: ProfileBackendAccount[],
): ProfileBackendAccount | null {
  return login.existingAccount
    ? (accounts.find((account) => account.id === login.accountId) ?? null)
    : null;
}

/** Ruling 286: the panel's one request, as ONE card reads it. */
export interface CardRequest {
  /** A request is in flight: both cards share the fetcher, so every control
   *  waits. */
  busy: boolean;
  /** The intent THIS card sent, while it is in flight. */
  inFlight: string | null;
  /** Ruling 138: and the account it names ("" for a sign-in that adds a new
   *  one), so only that row's button shows the work. */
  inFlightAccount: string | null;
  /** Whether the sign-in starting is `method`, into `account`. */
  starting: (method: LoginMethod, account: string) => boolean;
  /** Whether `intent` is in flight for `account`. */
  accountBusy: (intent: string, account: string) => boolean;
}

/**
 * Ruling 286: both cards share the fetcher, so the request is THIS card's only
 * when it names this backend; the button that sent it shows the work and every
 * other control (this card's and the other card's) only waits.
 */
export function cardRequest(
  fetcher: { state: "idle" | "loading" | "submitting"; formData?: FormData | undefined },
  backend: ProfileBackend["backend"],
): CardRequest {
  const busy = fetcher.state !== "idle";
  const sent = inFlightIntent(fetcher);
  const inFlight = sent !== null && fetcher.formData?.get("backend") === backend ? sent : null;
  const inFlightAccount = inFlight !== null ? String(fetcher.formData?.get("account") ?? "") : null;
  const startingMethod =
    inFlight === "backend-login-start" ? String(fetcher.formData?.get("method") ?? "") : null;
  return {
    busy,
    inFlight,
    inFlightAccount,
    starting: (method, account) => startingMethod === method && inFlightAccount === account,
    accountBusy: (intent, account) => inFlight === intent && inFlightAccount === account,
  };
}
