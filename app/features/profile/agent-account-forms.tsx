import { useEffect, useRef, useState } from "react";
import { Icon } from "~/ui/icon";
import { useRefusalShake } from "~/ui/use-refusal-shake";
import type { ProfileBackendAccount } from "./profile-query.server";

/**
 * Profile → Agent accounts: the two forms a card opens, the pasted key and an
 * account's name (ruling 700(e), the split of `agent-accounts-panel.tsx` along
 * the task page's recipe), moved whole with the hooks they always owned.
 */

/** A pasted API key or workspace access token, which IS ours to hold and is
 *  stored sealed. */
export function PasteForm({
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

/**
 * Ruling 507: give an account the person's own name, or clear it. The same
 * field idiom as the key paste form (a `.field` with its label and the card's
 * button row), prefilled with the name it has; an empty save clears the name
 * and the account is named by its vendor facts again. Ruling 147: Save is
 * enabled until the request starts, and an over-long name is refused here
 * with the store's own sentence.
 */
export function RenameForm({
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
