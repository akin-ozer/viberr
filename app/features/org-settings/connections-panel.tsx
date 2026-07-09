import { useState } from "react";
import type { ConnectionRecord } from "~/server/org/connections.server";
import { slugify } from "~/shared/ids/slugify";
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

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

const SCOPES = ["repo", "workflow", "pull_request:write"] as const;

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
            onChange={(e) => {
              setOwner(e.target.value);
              setErr(null);
            }}
            onKeyDown={enter}
            autoFocus={!initial}
          />
        </div>
      </div>
      <div className="field">
        <label className="flabel" htmlFor="cn-token">
          Personal access token<span className="req">*</span>{" "}
          <span className="fhint">stored encrypted · never displayed</span>
        </label>
        <input
          id="cn-token"
          type="text"
          className="mono"
          value={token}
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
        <span className="scope-chips" style={{ marginTop: 0 }}>
          {SCOPES.map((s) => (
            <span className="scope-chip" key={s}>
              {s}
            </span>
          ))}
        </span>
        <div className="def-note">
          <Icon name="shield" />
          <span>
            Verified when you apply. If any scope is missing the token is refused
            and nothing is saved.
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
      push("Set another connection as default first");
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
          <strong>
            {connections.length} connection{connections.length === 1 ? "" : "s"}.
          </strong>{" "}
          Every project picks one at creation — it sets the repository root. Each
          authenticates with a <strong>PAT</strong>, validated against the minimum
          scopes before anything is saved.
        </span>
      </div>
      <div className="conn-list">
        {connections.map((c) => {
          const expiry = formatExpiry(c.expiresAt);
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
                  {SCOPES.map((s) => (
                    <span className="scope-chip" key={s}>
                      {verified && <Icon name="check" />}
                      {s}
                    </span>
                  ))}
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
          <div className="empty">No connections yet — add one to create projects.</div>
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
