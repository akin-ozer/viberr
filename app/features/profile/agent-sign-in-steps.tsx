import { useEffect, useRef, useState, type RefObject } from "react";
import { CopyGlyph } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { useRefusalShake, type RefusalShake } from "~/ui/use-refusal-shake";
import type { LoginState } from "~/server/runtimes/backend-login.server";
import { hostOf, statusLine, VENDOR } from "./agent-accounts-derive";
import type { ProfileBackend } from "./profile-query.server";

/**
 * Profile → Agent accounts: a running sign-in (ruling 689(e), the split of
 * `agent-accounts-panel.tsx` along the task page's recipe). `SignInSteps`
 * keeps every hook it always owned; its two steps and its footer are
 * hook-free pieces it hands what they show.
 */

type StepState = "pending" | "current" | "done";

/** WHICH button just copied (ruling 294). */
type Copied = "link" | "code" | null;

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
export function SignInSteps({
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
  const [code, setCode] = useState("");
  const [refused, setRefused] = useState(0);
  // Ruling 451(g): the box shakes once per refusal, not on each mount.
  const refusalShake = useRefusalShake(refused);
  // Ruling 294: WHICH button just copied, not merely that one did. Step 1 now
  // has a copy-link button and step 2 (on codex) still has the copy-code one,
  // inside the same component — one boolean made both read "Copied" at once,
  // and the later reset would have blanked the other's confirmation early.
  const [copied, setCopied] = useState<Copied>(null);
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
        <OpenLinkStep
          backend={backend}
          state={openStep}
          url={login.url}
          copied={copied}
          onCopy={copyValue}
        />
        <li className="signin-step" data-state={codeStep}>
          <StepMark n={2} state={codeStep} />
          {codeStep === "done" ? <span className="vh">done: </span> : null}
          {backend === "codex" ? (
            <CopyCodeBody userCode={login.userCode} copied={copied} onCopy={copyValue} />
          ) : (
            <PasteCodeBody
              codeId={codeId}
              code={code}
              onCode={setCode}
              needsCode={login.needsCode}
              busy={busy}
              inFlight={inFlight}
              invalid={codeInvalid}
              refused={refused}
              refusalShake={refusalShake}
              field={codeField}
              onSubmit={submitCode}
            />
          )}
        </li>
      </ol>
      <SignInFoot
        backend={backend}
        label={label}
        state={login.state}
        busy={busy}
        inFlight={inFlight}
        submit={submit}
      />
    </div>
  );
}

/** Step 1: the vendor's page, opened here or copied to wherever the person
 *  holds the vendor session. */
function OpenLinkStep({
  backend,
  state,
  url,
  copied,
  onCopy,
}: {
  backend: "claude" | "codex";
  state: StepState;
  url: string | null;
  copied: Copied;
  onCopy: (what: "link" | "code", value: string) => Promise<void>;
}) {
  const host = url ? hostOf(url) : null;
  return (
    <li className="signin-step" data-state={state}>
      <StepMark n={1} state={state} />
      {state === "done" ? <span className="vh">done: </span> : null}
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
                  redirect. Same fixture as the code button in step 2, which
                  is the point: one gesture on this card, learned once.
                  The label deliberately does NOT embed the URL — a screen
                  reader reading those 300 characters is exactly what
                  `hostOf` exists to prevent. */}
              <button
                type="button"
                className="btn ghost sm"
                aria-label={`Copy the ${VENDOR[backend]} sign-in link`}
                onClick={() => void onCopy("link", url)}
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
  );
}

/** Step 2 on Codex: the one-time code OpenAI's page asks for, copyable. */
function CopyCodeBody({
  userCode,
  copied,
  onCopy,
}: {
  userCode: string | null;
  copied: Copied;
  onCopy: (what: "link" | "code", value: string) => Promise<void>;
}) {
  return (
    <div className="signin-body">
      <div className="signin-title">Enter this code on that page</div>
      <div className="signin-act">
        {userCode ? (
          <>
            <span className="signin-code">{userCode}</span>
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Copy the sign-in code ${userCode}`}
              onClick={() => void onCopy("code", userCode)}
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
  );
}

/** Step 2 on Claude: the field for the code Anthropic's page shows. */
function PasteCodeBody({
  codeId,
  code,
  onCode,
  needsCode,
  busy,
  inFlight,
  invalid,
  refused,
  refusalShake,
  field,
  onSubmit,
}: {
  codeId: string;
  code: string;
  onCode: (code: string) => void;
  needsCode: boolean;
  busy: boolean;
  inFlight: string | null;
  invalid: boolean;
  refused: number;
  refusalShake: RefusalShake;
  field: RefObject<HTMLInputElement | null>;
  onSubmit: () => void;
}) {
  const errId = `${codeId}-err`;
  return (
    <div className="signin-body field">
      <label className="signin-title" htmlFor={codeId}>
        Paste the code Anthropic shows you
      </label>
      <div className="signin-act">
        <input
          ref={field}
          id={codeId}
          type="text"
          className="mono"
          value={code}
          disabled={!needsCode}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errId : undefined}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          onChange={(e) => onCode(e.target.value)}
        />
        <button
          type="button"
          className="btn sm"
          disabled={!needsCode || busy}
          aria-busy={inFlight === "backend-login-code" || undefined}
          onClick={onSubmit}
        >
          {inFlight === "backend-login-code" && <Icon name="loader" className="spin" />}
          {inFlight === "backend-login-code" ? "Submitting…" : "Submit code"}
        </button>
      </div>
      {invalid ? (
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
  );
}

/** The sign-in's one polite live region, beside its Cancel. */
function SignInFoot({
  backend,
  label,
  state,
  busy,
  inFlight,
  submit,
}: {
  backend: "claude" | "codex";
  label: string;
  state: LoginState;
  busy: boolean;
  inFlight: string | null;
  submit: (fields: Record<string, string>) => void;
}) {
  return (
    <div className="signin-foot">
      <p className="signin-status" role="status" aria-live="polite">
        <span className="live-dot" aria-hidden="true" />
        {statusLine(state, label)}
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
  );
}
