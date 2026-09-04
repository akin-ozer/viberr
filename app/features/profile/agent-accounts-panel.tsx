import { useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import type { FetcherWithComponents } from "react-router";
import { Icon } from "~/ui/icon";
import { LocalCalendarDate } from "~/ui/local-time";
import { Pill } from "~/ui/pill";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useToast } from "~/ui/toast";
import { utcDayKey } from "~/shared/dates/format";
import type { BackendLoginPollData } from "~/routes/resources.backend-login";
import type { ProfileBackend } from "./profile-query.server";
import type { ProfileActionData } from "./profile-page";
import type { LoginState } from "~/server/runtimes/backend-login.server";
import type { LoginMethod } from "~/server/runtimes/backend-credentials.server";

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
 */

/** Ruling 92: the backends are called "Claude" and "Codex". */
const BACKEND_LABEL = { claude: "Claude", codex: "Codex" } as const;

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
    case "awaiting-code":
      return "Waiting for the code Anthropic showed you";
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
  const noun = kind === "access_token" ? "workspace access token" : "API key";
  const fieldId = `agentacc-${backend}-${kind}`;
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
        id={fieldId}
        type="password"
        className="mono"
        value={secret}
        autoComplete="new-password"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        placeholder={backend === "claude" ? "sk-ant-…" : "sk-…"}
        onChange={(e) => setSecret(e.target.value)}
      />
      <div className="cred-manage">
        <button
          type="button"
          className="btn sm"
          disabled={busy || secret.trim() === ""}
          aria-busy={busy}
          onClick={() =>
            submit({ intent: "backend-set-key", backend, kind, secret })
          }
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

// -------------------------------------------------------------- one backend

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
  const push = useToast();
  const revalidator = useRevalidator();
  const [paste, setPaste] = useState<"api_key" | "access_token" | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  // The poll fetcher is the card's OWN: `/resources/backend-login` answers for
  // the signed-in caller only, and loading it on the panel's action fetcher
  // would overwrite the intent result the toast settles on.
  const poll = useFetcher<BackendLoginPollData>();
  // The LOADER decides which session exists; the poll only supplies a fresher
  // state OF THAT SESSION. Matching on the id is what keeps a stale answer from
  // an earlier sign-in (a fetcher keeps its last data indefinitely) from
  // rendering a brand-new attempt as already finished.
  const polled =
    poll.data && data.login && poll.data.login?.id === data.login.id
      ? poll.data
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

  // The step list REPLACES the button the person just pressed, so without this
  // their focus falls back to the document body and a screen reader is told
  // nothing at all. Focus moves once per session id (the poll re-renders this
  // card every 2 s, and stealing focus back on each tick would trap them).
  const steps = useRef<HTMLDivElement | null>(null);
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!running || !login) return;
    if (focusedFor.current === login.id) return;
    focusedFor.current = login.id;
    steps.current?.focus();
  }, [running, login]);

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
    // The card's connected state, the health pill and every other surface that
    // reads this person's backends come from the loader, not from the poll.
    void revalidator.revalidate();
  });

  const busy = fetcher.state !== "idle";
  /** The badge says where this account STANDS, in the person's vocabulary. The
   *  stored `kind` (`api_key`, `access_token`) is our schema, not their word,
   *  and an unconnected card gets the sibling GitHub card's minus rather than a
   *  third copy of the sentence the card itself already states. A sign-in under
   *  way wins over "connected": it is what the card is showing, and it is what
   *  the person is waiting on. */
  const badge = running ? "signing in" : connected ? "connected" : "−";
  // A timestamp the card cannot read is omitted together with its " on " /
  // "verified " lead-in, never rendered as the word "null". The date itself
  // renders through the hydration-safe primitive: UTC day first, the viewer's
  // calendar date after hydration (pass 34, C6).
  const connectedOn =
    health.connectedAt && utcDayKey(health.connectedAt) ? health.connectedAt : null;
  const verifiedOn =
    health.verifiedAt && utcDayKey(health.verifiedAt) ? health.verifiedAt : null;
  const copyCode = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard denied (permissions, insecure origin). The code is on screen
      // and selectable, which is the fallback that always works.
    }
  };

  return (
    <div className="cred-card">
      <div className="cred-top">
        <Icon name="cpu" />
        <span className="cred-name">{label}</span>
        <span className="mono push faint">{badge}</span>
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
              onClick={() =>
                submit({
                  intent: "backend-login-start",
                  backend,
                  method: login.method,
                })
              }
            >
              Start again
            </button>
          </div>
        </>
      )}

      {running && login ? (
        <>
          {/* Everything in here is filled in ASYNCHRONOUSLY by the 2 s poll:
              the vendor's URL, the one-time code and the status line all
              appear seconds after the card does. A polite live region is what
              announces them; `tabIndex` makes the region the focus target the
              effect above moves to. */}
          <div
            className="kv spaced"
            role="status"
            aria-live="polite"
            aria-label={`${label} sign-in`}
            tabIndex={-1}
            ref={steps}
          >
            <div className="kv-row">
              <span className="k">1. Open this link and sign in</span>
              <span className="v">
                {login.url ? (
                  <a
                    className="mono"
                    href={login.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {login.url}
                  </a>
                ) : (
                  <span className="mono">waiting for the link</span>
                )}
              </span>
            </div>
            {backend === "codex" ? (
              <div className="kv-row">
                <span className="k">2. Enter this code</span>
                <span className="v">
                  <span className="scope-chip">
                    {login.userCode ?? "waiting for the code"}
                  </span>
                  {login.userCode && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      aria-label={`Copy the sign-in code ${login.userCode}`}
                      onClick={() => void copyCode(login.userCode ?? "")}
                    >
                      <Icon name={copied ? "check" : "copy"} />
                      {copied ? "Copied" : "Copy"}
                    </button>
                  )}
                </span>
              </div>
            ) : (
              <div className="kv-row">
                <span className="k">2. Paste the code Anthropic shows you</span>
                <span className="v">
                  <input
                    className="mono"
                    type="text"
                    value={code}
                    disabled={!login.needsCode}
                    aria-label="Code from Anthropic"
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    onChange={(e) => setCode(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!login.needsCode || busy || code.trim() === ""}
                    onClick={() =>
                      submit({ intent: "backend-login-code", backend, code })
                    }
                  >
                    Submit
                  </button>
                </span>
              </div>
            )}
            <div className="kv-row">
              <span className="k">Status</span>
              <span className="v plain">{statusLine(login.state, label)}</span>
            </div>
          </div>
          <div className="cred-manage">
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => submit({ intent: "backend-login-cancel", backend })}
            >
              Cancel
            </button>
          </div>
        </>
      ) : health.kind !== null ? (
        <>
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
          </div>
          <div className="cred-manage">
            {/* The health detail for a vanished credential file ends "Sign in
                again on your Profile → Agent accounts", which is THIS card: so
                the card has to carry the sign-in it names, or the only way out
                of a wiped runtime volume would be to guess that Disconnect
                comes first. */}
            {!health.available &&
              methods.signIn.map((method) => (
                <button
                  key={method}
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() =>
                    submit({ intent: "backend-login-start", backend, method })
                  }
                >
                  {SIGN_IN_LABEL[method]}
                </button>
              ))}
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => {
                // Close any paste form the card was showing before this
                // connection existed, so disconnecting does not re-reveal a
                // half-typed key field.
                setPaste(null);
                submit({ intent: "backend-disconnect", backend });
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="cred-warn">
            <Icon name="alert" />
            <span>
              Not connected. Runs on tasks you own, and your controller
              conversations, use your own {label} account.
            </span>
          </div>
          <div className="cred-manage">
            {methods.signIn.map((method) => (
              <button
                key={method}
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() =>
                  submit({ intent: "backend-login-start", backend, method })
                }
              >
                {SIGN_IN_LABEL[method]}
              </button>
            ))}
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
      )}
    </div>
  );
}

// ------------------------------------------------------------------- panel

export function AgentAccountsPanel({
  backends,
  fetcher,
  submit,
}: {
  backends: ProfileBackend[];
  fetcher: AccountsFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  useAccountsToast(fetcher);
  const error = accountsError(fetcher);
  return (
    <div className="panel">
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
