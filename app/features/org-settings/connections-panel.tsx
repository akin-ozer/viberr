import { useState } from "react";
import type { ConnectionRecord } from "~/server/org/connections.server";
import { slugify } from "~/shared/ids/slugify";
import { formatCalendarDate } from "~/shared/dates/format";
import { countLabel } from "~/shared/text/plural";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { ConfirmDelete, MiniModal } from "./mini-modal";
import { useOrgAction, type OrgActionData } from "./use-org-action";

/**
 * GitHub connections tab (org-settings spec §4.1). Row markup is the
 * mock's `.conn-row`; the honest-state deltas from the prototype:
 * masked token in the sub line, scope-chip checks only after a PASSING
 * validation, and a "not validated" / "validation failed" pill for
 * placeholder or broken tokens (seed's akin-ozer connection ships
 * unvalidated on purpose). Add/replace run the REAL phase-7 validator —
 * failure copy renders in the modal's `.cred-warn` and nothing is saved.
 */

// Owner ruling 2026-07-25: the required set is what Viberr's own writes use —
// branch push + PR open/merge. The mock-era `workflow` (unprovable on
// fine-grained tokens, over-demanding on classic ones) is gone.
const SCOPES = ["repo", "pull_request:write"] as const;

function ConnectionModal({
  initial,
  existing,
  onClose,
}: {
  initial: ConnectionRecord | null;
  existing: ConnectionRecord[];
  onClose: () => void;
}) {
  const [owner, setOwner] = useState(initial ? initial.owner : "");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const push = useToast();
  const action = useOrgAction({
    onResult: (d: OrgActionData) => {
      if (d.ok) {
        // Toast lives in the root provider — safe to push, then unmount.
        if (d.toast) push(d.toast);
        onClose();
        return;
      }
      setErr(d.error);
    },
  });
  const checking = action.busy;
  const canSave =
    !checking &&
    (!!initial || owner.trim().length > 1) &&
    token.trim().length > 0;

  const apply = () => {
    if (!canSave) return;
    const o = owner.trim();
    if (!initial && existing.some((c) => c.id === slugify(o))) {
      setErr("That connection already exists.");
      return;
    }
    setErr(null);
    action.submit(
      initial
        ? { intent: "connection-replace", connectionId: initial.id, token: token.trim() }
        : { intent: "connection-add", owner: o, token: token.trim() },
    );
  };
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };

  return (
    <MiniModal
      icon={<Icon name="github" />}
      title={initial ? "Update token — " + initial.owner : "New GitHub connection"}
      sub={
        initial
          ? "The current token is never shown — paste a replacement"
          : "A PAT authenticates every repo action for this owner"
      }
      onClose={onClose}
      canSave={canSave}
      saveLabel={
        checking
          ? "Verifying scopes…"
          : initial
            ? "Validate & replace"
            : "Validate & connect"
      }
      footHint={
        initial
          ? "the old token stays active unless validation passes"
          : "nothing is saved unless validation passes"
      }
      onSave={apply}
    >
      <div className="field">
        <label className="flabel" htmlFor="cn-owner">
          Organization or user<span className="req">*</span>
        </label>
        <div className="repo-input">
          <span className="pre">github.com/</span>
          <input
            id="cn-owner"
            type="text"
            value={owner}
            disabled={!!initial}
            placeholder="owner"
            // Owner report 2026-08-20: a text input followed by a password input
            // reads as a LOGIN form, and browsers filled a saved email here.
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            onChange={(e) => {
              setOwner(e.target.value);
              setErr(null);
            }}
            onKeyDown={enter}
            autoFocus={!initial}
          />
        </div>
        {/* UXA-11: on the update path this field is `disabled` and nothing said
            why — the title says "Update token" and the sub says the token is
            never shown, but neither states that the OWNER is fixed. A disabled
            input cannot explain itself; say it where the reader is looking. */}
        {initial && (
          <div className="fhint">
            The owner can&apos;t be changed — add a separate connection for a
            different account or organisation.
          </div>
        )}
      </div>
      <div className="field">
        <label className="flabel" htmlFor="cn-token">
          Personal access token<span className="req">*</span>{" "}
          <span className="fhint">stored encrypted · never displayed</span>
        </label>
        {/* F11/UI-D: the label promises the token is never displayed while the
            field displayed it in clear text as you pasted it — over a shoulder,
            in a screen share, and to every password manager and spell-checker
            that scrapes text inputs. A secret field is `type="password"`; the
            autofill/spellcheck opt-outs keep the value out of the same stores.
            Nothing else changes: the value is still submitted verbatim, and the
            server still never sends one back. */}
        <input
          id="cn-token"
          type="password"
          className="mono"
          value={token}
          // `off` is ignored by browsers on login-shaped pairs (owner report
          // 2026-08-20: a saved password landed in this field) — `new-password`
          // is the value password managers actually honor for "never fill".
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          placeholder="ghp_…"
          onChange={(e) => {
            setToken(e.target.value);
            setErr(null);
          }}
          onKeyDown={enter}
          autoFocus={!!initial}
        />
      </div>
      <div className="field">
        <span className="flabel">Required scopes</span>
        <span className="scope-chips flush">
          {SCOPES.map((s) => (
            <span className="scope-chip" key={s}>
              {s}
            </span>
          ))}
        </span>
        <div className="def-note">
          <Icon name="shield" />
          <span>
            Verified when you apply: a classic PAT publishes its scopes, so a
            missing one refuses the token and nothing is saved. A{" "}
            <strong>fine-grained</strong> PAT publishes none — its permissions
            are proven by real probes (including write dry-runs) once the
            connection is attached to a project with a repository.
          </span>
        </div>
      </div>
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

export function ConnectionsPanel({
  connections,
}: {
  connections: ConnectionRecord[];
}) {
  const [modal, setModal] = useState<{ item: ConnectionRecord | null } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<ConnectionRecord | null>(null);
  const push = useToast();
  const rowAction = useOrgAction();

  const setDefault = (id: string) =>
    rowAction.submit({ intent: "connection-default", connectionId: id });
  const remove = (c: ConnectionRecord) => {
    if (c.def) {
      // D5: a refusal must not render the success tick.
      push("Set another connection as default first", "error");
      return;
    }
    setConfirm(c);
  };

  return (
    <section className="panel" data-screen-label="Settings — GitHub connections">
      <div className="panel-head">
        <Icon name="github" />
        <h2>GitHub connections</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={() => setModal({ item: null })}>
            <Icon name="plus" />
            Add connection
          </button>
        </span>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span>
          <strong>{countLabel(connections.length, "connection")}.</strong>{" "}
          Every project picks one at creation — it sets the repository root. Each
          authenticates with a <strong>PAT</strong>, validated against the minimum
          scopes before anything is saved.
        </span>
      </div>
      <div className="conn-list">
        {connections.map((c) => {
          const expiry = formatCalendarDate(c.expiresAt);
          const verified = c.validationState === "valid";
          return (
            <div className="conn-row" key={c.id}>
              <span className="conn-ico">
                <Icon name="github" />
              </span>
              <span className="conn-main">
                <b>
                  {c.owner}
                  <span className="mono pre">/</span>
                </b>
                <span className="sub mono">
                  PAT {c.masked}
                  {c.repos !== null ? ` · ${c.repos} repos` : ""} · expires{" "}
                  {expiry || "—"}
                </span>
                <span className="scope-chips">
                  {/* P13-UI-01 + owner ruling 2026-07-25: chips are PROVEN
                      verdicts only — a scope header (classic) or a real probe
                      (fine-grained; writes via the empty-payload dry-run). An
                      `assumed` entry is not evidence, so it renders no chip:
                      unproven scopes collapse into the single honest line
                      below instead of a pseudo-check next to real ones. */}
                  {(() => {
                    const evidence = verified ? (c.scopes ?? []) : [];
                    const proven = evidence.filter((s) => s.source !== "assumed");
                    const unproven = evidence.filter((s) => s.source === "assumed");
                    return (
                      <>
                        {proven.map((s) => (
                          <span
                            className={"scope-chip" + (s.ok ? "" : " miss")}
                            key={s.id}
                            title={
                              (s.source === "header"
                                ? "Confirmed against the token's published scopes."
                                : "Proven by a live probe against the repository.") +
                              (s.note ? ` (${s.note})` : "")
                            }
                          >
                            <Icon name={s.ok ? "check" : "alert"} />
                            {s.id}
                          </span>
                        ))}
                        {unproven.length > 0 && (
                          <span
                            className="sub"
                            title={unproven.map((s) => s.note ?? s.id).join(" · ")}
                          >
                            {proven.length > 0 ? " · " : ""}
                            {unproven.map((s) => s.id).join(", ")} unproven —
                            verified when attached to a project
                          </span>
                        )}
                      </>
                    );
                  })()}
                </span>
              </span>
              {c.validationState === "unvalidated" && (
                <Pill kind="input" sm>
                  not validated
                </Pill>
              )}
              {c.validationState === "failed" && (
                <Pill kind="risk" sm>
                  validation failed
                </Pill>
              )}
              {c.daysLeft !== null && c.daysLeft <= 30 && (
                <Pill kind="input" sm>
                  expires in {c.daysLeft} days
                </Pill>
              )}
              {c.def && (
                <Pill kind="info" sm>
                  default
                </Pill>
              )}
              <button type="button" className="btn ghost sm" onClick={() => setModal({ item: c })}>
                Update token
              </button>
              {!c.def && (
                <button type="button" className="btn ghost sm" onClick={() => setDefault(c.id)}>
                  Set default
                </button>
              )}
              <button
                type="button"
                className="stg-x"
                aria-label={"Remove " + c.owner}
                onClick={() => remove(c)}
              >
                <Icon name="x" />
              </button>
            </div>
          );
        })}
        {connections.length === 0 && (
          <div className="empty">No connections yet — add one first: every project binds to a GitHub repo through a connection.</div>
        )}
      </div>
      {modal && (
        <ConnectionModal
          key={modal.item ? modal.item.id : "new"}
          initial={modal.item}
          existing={connections}
          onClose={() => setModal(null)}
        />
      )}
      {confirm && (
        <ConfirmDelete
          what={confirm.owner}
          // C6: the outcome, not a bare "Remove".
          confirmLabel="Remove connection"
          detail={
            "Projects already created from " +
            confirm.owner +
            " keep their repos; new projects can no longer select it."
          }
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            rowAction.submit({
              intent: "connection-remove",
              connectionId: confirm.id,
            });
            setConfirm(null);
          }}
        />
      )}
    </section>
  );
}
