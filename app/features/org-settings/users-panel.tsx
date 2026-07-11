import { useState } from "react";
import type { DomainRecord, OrgUserView } from "~/server/org/org-users.server";
import { Avatar } from "~/ui/avatar";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useDialog } from "~/ui/use-dialog";
import { ConfirmDelete, EditIco, MiniModal } from "./mini-modal";
import { useOrgAction, type OrgActionData } from "./use-org-action";

/**
 * Users & access tab (org-settings spec §4.2) — the REAL org-user surface
 * over the phase-2 user-admin API (whitelist = account existence). Honest
 * deltas from the mock (documented in the phase report):
 *
 * - local create / password reset surface the generated TEMP password once
 *   (no mailer, no magic "setup link" — spec open question §8.8 resolved
 *   as an inline cred-ok notice);
 * - a github-handle row is an UNCLAIMED identity until that user first signs
 *   in with GitHub: the OAuth-callback claim IS built + wired (applyOAuthUser /
 *   isOAuthWhitelisted in oauth-provision.server, hooked into better-auth in
 *   auth.server) and unit-tested. It stays unclaimed only when no GitHub OAuth
 *   provider is configured for the instance (GITHUB_OAUTH_CLIENT_ID unset).
 *
 * Self-demote/self-remove guards are client toasts (mock parity) AND
 * server-enforced; the last-admin guard is server-side (phase-2).
 */

function IdpChip({ idp }: { idp: string }) {
  if (idp === "github") {
    return (
      <span className="idp-chip">
        <Icon name="github" />
        GitHub
      </span>
    );
  }
  if (idp === "google") {
    return (
      <span className="idp-chip">
        <span className="gmark">G</span>Google
      </span>
    );
  }
  return (
    <span className="idp-chip">
      <Icon name="lock" />
      Local
    </span>
  );
}

export interface SetupNotice {
  email: string;
  tempPassword: string;
}

function InviteModal({
  onClose,
  onSetupNotice,
}: {
  onClose: () => void;
  onSetupNotice: (notice: SetupNotice) => void;
}) {
  const [idp, setIdp] = useState<"github" | "google" | "local">("github");
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [err, setErr] = useState<string | null>(null);
  const push = useToast();
  const action = useOrgAction({
    onResult: (d: OrgActionData) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.toast) push(d.toast);
      if (typeof d.tempPassword === "string") {
        onSetupNotice({
          email: typeof d.email === "string" ? d.email : "",
          tempPassword: d.tempPassword,
        });
      }
      onClose();
    },
  });

  const g = email.trim();
  const isDomain =
    idp === "google" && (g.startsWith("@") || (g.includes("@") && !g.split("@")[0]));
  const canSave =
    !action.busy &&
    (idp === "github"
      ? handle.trim().replace(/^@/, "").length > 1
      : idp === "google"
        ? g.includes("@") && (g.split("@")[1] || "").includes(".")
        : name.trim().length > 1 && email.includes("@"));

  const submit = () => {
    if (!canSave) return;
    setErr(null);
    if (idp === "github") {
      action.submit({
        intent: "invite-github",
        handle: handle.trim().replace(/^@/, ""),
        role,
      });
    } else if (idp === "google") {
      action.submit({
        intent: isDomain ? "invite-domain" : "invite-google",
        email: g,
        role,
      });
    } else {
      action.submit({
        intent: "invite-local",
        name: name.trim(),
        email: email.trim(),
        role,
      });
    }
  };
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <MiniModal
      icon={<Icon name="user" />}
      title="Allow access"
      sub="Whitelist who can sign in — no invite emails, access on first login"
      onClose={onClose}
      canSave={canSave}
      saveLabel={
        idp === "local"
          ? "Create account"
          : isDomain
            ? "Whitelist domain"
            : "Whitelist " + (idp === "github" ? "user" : "account")
      }
      footHint={
        idp === "github"
          ? "allowed the moment they sign in with GitHub"
          : idp === "google"
            ? isDomain
              ? "everyone " + g + " can sign in with Google"
              : "allowed the moment they sign in with Google"
            : "they sign in with the generated temp password, then set their own"
      }
      onSave={submit}
    >
      <div className="field">
        <span className="flabel">Sign-in method</span>
        <div className="be-pick three">
          <button
            type="button"
            className={"be-opt" + (idp === "github" ? " on" : "")}
            onClick={() => setIdp("github")}
            aria-pressed={idp === "github"}
          >
            <span className="be-ic">
              <Icon name="github" />
            </span>
            <span className="bnm">GitHub</span>
            <span className="bcheck">
              <Icon name="check" />
            </span>
          </button>
          <button
            type="button"
            className={"be-opt" + (idp === "google" ? " on" : "")}
            onClick={() => setIdp("google")}
            aria-pressed={idp === "google"}
          >
            <span className="be-ic">
              <span className="gmark lg">G</span>
            </span>
            <span className="bnm">Google</span>
            <span className="bcheck">
              <Icon name="check" />
            </span>
          </button>
          <button
            type="button"
            className={"be-opt" + (idp === "local" ? " on" : "")}
            onClick={() => setIdp("local")}
            aria-pressed={idp === "local"}
          >
            <span className="be-ic">
              <Icon name="lock" />
            </span>
            <span className="bnm">Local</span>
            <span className="bcheck">
              <Icon name="check" />
            </span>
          </button>
        </div>
      </div>
      {idp === "github" && (
        <div className="field">
          <label className="flabel" htmlFor="inv-gh">
            GitHub username<span className="req">*</span>{" "}
            <span className="fhint">name &amp; avatar come from GitHub when they sign in</span>
          </label>
          <div className="repo-input">
            <span className="pre">github.com/</span>
            <input
              id="inv-gh"
              type="text"
              value={handle}
              placeholder="username"
              onChange={(e) => setHandle(e.target.value)}
              onKeyDown={enter}
              autoFocus
            />
          </div>
        </div>
      )}
      {idp === "google" && (
        <div className="field">
          <label className="flabel" htmlFor="inv-mail">
            Google account or domain<span className="req">*</span>{" "}
            <span className="fhint">@company.dev whitelists the whole org</span>
          </label>
          <input
            id="inv-mail"
            type="text"
            className="mono"
            value={email}
            placeholder="name@company.dev · or · @company.dev"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={enter}
            autoFocus
          />
        </div>
      )}
      {idp === "local" && (
        <div className="key-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="field">
            <label className="flabel" htmlFor="inv-name">
              Full name<span className="req">*</span>
            </label>
            <input
              id="inv-name"
              type="text"
              value={name}
              placeholder="Full name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={enter}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="inv-email">
              Email<span className="req">*</span>
            </label>
            <input
              id="inv-email"
              type="text"
              className="mono"
              value={email}
              placeholder="name@company.dev"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={enter}
            />
          </div>
        </div>
      )}
      <div className="field">
        <span className="flabel">
          {isDomain ? "Role for everyone joining via this domain" : "Instance role"}
        </span>
        <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
          <button type="button" className={role === "admin" ? "on" : ""} onClick={() => setRole("admin")}>
            Admin
          </button>
          <button type="button" className={role === "member" ? "on" : ""} onClick={() => setRole("member")}>
            Member
          </button>
        </span>
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

function EditUserModal({
  user,
  isYou,
  onClose,
}: {
  user: OrgUserView;
  isYou: boolean;
  onClose: () => void;
}) {
  const isLocal = user.idp === "local";
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<"admin" | "member">(
    user.role === "admin" ? "admin" : "member",
  );
  const [err, setErr] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const push = useToast();

  const saveAction = useOrgAction({
    onResult: (d) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.toast) push(d.toast);
      onClose();
    },
  });
  const resetAction = useOrgAction({
    onResult: (d) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.toast) push(d.toast);
      // Modal stays open — the live user record re-renders the pending
      // state and the temp password shows ONCE (spec §7.7 + honesty).
      if (typeof d.tempPassword === "string") setTempPassword(d.tempPassword);
    },
  });

  const canSave =
    !saveAction.busy && (!isLocal || (name.trim().length > 1 && email.includes("@")));
  const save = () => {
    if (!canSave) return;
    if (isYou && role !== "admin") {
      push("You can't demote yourself");
      return;
    }
    setErr(null);
    saveAction.submit({
      intent: "user-edit",
      userId: user.id,
      name: name.trim(),
      email: email.trim(),
      role,
    });
  };

  return (
    <MiniModal
      icon={<Icon name="user" />}
      title={"Edit " + user.name}
      sub={
        isLocal
          ? "Local account"
          : "Signs in with " + (user.idp === "github" ? "GitHub" : "Google")
      }
      onClose={onClose}
      canSave={canSave}
      saveLabel="Save changes"
      footHint={isYou ? "this is your own account" : undefined}
      onSave={save}
    >
      <div className="key-row" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="field">
          <label className="flabel" htmlFor="eu-name">
            Full name{isLocal && <span className="req">*</span>}
          </label>
          <input
            id="eu-name"
            type="text"
            value={name}
            disabled={!isLocal}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="flabel" htmlFor="eu-email">
            Email{isLocal && <span className="req">*</span>}
          </label>
          <input
            id="eu-email"
            type="text"
            className="mono"
            value={email}
            disabled={!isLocal}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      {!isLocal && (
        <div className="def-note" style={{ marginTop: "-.6rem" }}>
          <Icon name="lock" />
          <span>
            Name &amp; email sync from {user.idp === "github" ? "GitHub" : "Google"} at
            each sign-in and can't be edited here.
          </span>
        </div>
      )}
      <div className="field">
        <span className="flabel">Instance role</span>
        <span className="mini-seg" style={{ alignSelf: "flex-start" }}>
          <button type="button" className={role === "admin" ? "on" : ""} onClick={() => setRole("admin")}>
            Admin
          </button>
          <button type="button" className={role === "member" ? "on" : ""} onClick={() => setRole("member")}>
            Member
          </button>
        </span>
      </div>
      {isLocal && (
        <div className="field">
          <span className="flabel">Password</span>
          {user.pwreset || user.status === "invited" || tempPassword ? (
            <div className="cred-ok">
              <Icon name="check" />
              <span>
                Reset pending — {user.name} will be prompted to set a new password at
                next sign-in.
                {tempPassword && (
                  <>
                    {" "}
                    Temp sign-in password:{" "}
                    <code className="mono">{tempPassword}</code> — shown once, hand it
                    over out-of-band.
                  </>
                )}
              </span>
            </div>
          ) : (
            <div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() =>
                  resetAction.submit({ intent: "user-reset-password", userId: user.id })
                }
                disabled={resetAction.busy}
              >
                <Icon name="lock" />
                Reset password
              </button>
              <div className="def-note" style={{ marginTop: ".55rem" }}>
                <Icon name="lock" />
                <span>
                  No email is sent — a temp password is generated for you to hand over;
                  they're prompted to set a new password at their next sign-in.
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {err && (
        <div className="cred-warn">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

/** Disable confirm — killing sessions + blocking sign-in is disruptive, so a
 * confirm gate mirrors the remove flow (native <dialog>, ruling 16). */
function DisableUserDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useDialog(onCancel);
  return (
    <dialog
      ref={ref}
      className="confirm-card"
      role="alertdialog"
      aria-label={`Disable ${name}?`}
    >
      <div className="confirm-icon">
        <Icon name="hand" />
      </div>
      <h3>Disable {name}?</h3>
      <p>
        They're signed out immediately and can't sign in until re-enabled. Their
        comments, decisions, and task assignments stay untouched.
      </p>
      <div className="confirm-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          Disable
        </button>
      </div>
    </dialog>
  );
}

export function UsersPanel({
  users,
  domains,
  meId,
}: {
  users: OrgUserView[];
  domains: DomainRecord[];
  meId: string;
}) {
  const [confirm, setConfirm] = useState<
    | { kind: "user"; item: OrgUserView }
    | { kind: "domain"; item: DomainRecord }
    | null
  >(null);
  const [disabling, setDisabling] = useState<OrgUserView | null>(null);
  const [inviting, setInviting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [setupNotice, setSetupNotice] = useState<SetupNotice | null>(null);
  const push = useToast();
  const rowAction = useOrgAction();

  const setRole = (u: OrgUserView, role: "admin" | "member") => {
    if (u.id === meId && role !== "admin") {
      push("You can't demote yourself");
      return;
    }
    if (u.role === role) return;
    rowAction.submit({ intent: "user-role", userId: u.id, role });
  };

  const editing = editingId ? (users.find((x) => x.id === editingId) ?? null) : null;

  return (
    <section className="panel" data-screen-label="Settings — Users & access">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Users &amp; access</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={() => setInviting(true)}>
            <Icon name="plus" />
            Allow access
          </button>
        </span>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span>
          <strong>{users.length} instance accounts</strong> — GitHub &amp; Google access
          is whitelist-based: allowed people simply sign in, no invite emails. Board
          permissions are granted per project.
        </span>
      </div>
      {setupNotice && (
        <div className="cred-ok">
          <Icon name="check" />
          <span>
            Account created for <span className="mono">{setupNotice.email}</span> — temp
            sign-in password: <code className="mono">{setupNotice.tempPassword}</code>{" "}
            (shown once, hand it over out-of-band).
          </span>
          <button
            type="button"
            className="stg-x"
            aria-label="Dismiss"
            style={{ marginLeft: "auto" }}
            onClick={() => setSetupNotice(null)}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      {domains.length > 0 && (
        <div className="member-list" style={{ marginBottom: 0 }}>
          {domains.map((d) => (
            <div className="member-row" key={d.id}>
              <span className="dom-ic">
                <span className="gmark">G</span>
              </span>
              <span className="member-main">
                <div className="nm">{d.domain}</div>
                <div className="em">
                  any Google account with this domain · joins as {d.role}
                </div>
              </span>
              <Pill kind="ready" sm>
                domain allowlist
              </Pill>
              <button
                type="button"
                className="stg-x"
                aria-label={"Remove " + d.domain}
                onClick={() => setConfirm({ kind: "domain", item: d })}
              >
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="member-list">
        {users.map((u) => {
          const you = u.id === meId;
          return (
            <div className="member-row" key={u.id}>
              <Avatar person={{ initials: u.initials, tone: u.tone }} />
              <span className="member-main">
                <div className="nm">
                  {u.name}
                  {you && <span className="you-tag">you</span>}
                </div>
                <div className="em">{u.email}</div>
              </span>
              <IdpChip idp={u.idp} />
              {u.status === "invited" && (
                <Pill kind="neutral" sm>
                  setup pending
                </Pill>
              )}
              {u.status === "whitelisted" && (
                <Pill kind="neutral" sm>
                  whitelisted
                </Pill>
              )}
              {u.pwreset && (
                <Pill kind="input" sm>
                  password reset pending
                </Pill>
              )}
              {u.disabled && (
                <Pill kind="neutral" sm>
                  disabled
                </Pill>
              )}
              <span className="mini-seg">
                <button
                  type="button"
                  className={u.role === "admin" ? "on" : ""}
                  onClick={() => setRole(u, "admin")}
                >
                  Admin
                </button>
                <button
                  type="button"
                  className={u.role === "member" ? "on" : ""}
                  onClick={() => setRole(u, "member")}
                >
                  Member
                </button>
              </span>
              <button
                type="button"
                className="stg-x"
                title="Edit user"
                aria-label={"Edit " + u.name}
                onClick={() => setEditingId(u.id)}
              >
                <EditIco />
              </button>
              {u.disabled ? (
                <button
                  type="button"
                  className="stg-x"
                  title="Re-enable user"
                  aria-label={"Enable " + u.name}
                  onClick={() =>
                    rowAction.submit({ intent: "user-enable", userId: u.id })
                  }
                >
                  <Icon name="check" />
                </button>
              ) : (
                <button
                  type="button"
                  className={"stg-x" + (you ? " off" : "")}
                  title="Disable user"
                  aria-label={"Disable " + u.name}
                  onClick={() => {
                    if (you) {
                      push("You can't disable your own account");
                      return;
                    }
                    setDisabling(u);
                  }}
                >
                  <Icon name="hand" />
                </button>
              )}
              <button
                type="button"
                className={"stg-x" + (you ? " off" : "")}
                aria-label={"Remove " + u.name}
                onClick={() => {
                  if (you) {
                    push("You can't remove your own account");
                    return;
                  }
                  setConfirm({ kind: "user", item: u });
                }}
              >
                <Icon name="x" />
              </button>
            </div>
          );
        })}
      </div>
      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onSetupNotice={setSetupNotice}
        />
      )}
      {editing && (
        <EditUserModal
          key={editing.id}
          user={editing}
          isYou={editing.id === meId}
          onClose={() => setEditingId(null)}
        />
      )}
      {disabling && (
        <DisableUserDialog
          name={disabling.name}
          onCancel={() => setDisabling(null)}
          onConfirm={() => {
            rowAction.submit({ intent: "user-disable", userId: disabling.id });
            setDisabling(null);
          }}
        />
      )}
      {confirm && confirm.kind === "user" && (
        <ConfirmDelete
          what={confirm.item.name}
          detail="Their comments and decisions stay in the audit history. Task assignments return to the operator for reassignment."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            rowAction.submit({ intent: "user-remove", userId: confirm.item.id });
            setConfirm(null);
          }}
        />
      )}
      {confirm && confirm.kind === "domain" && (
        <ConfirmDelete
          what={confirm.item.domain}
          detail="New Google sign-ins from this domain are refused. Accounts that already signed in keep their access."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            rowAction.submit({ intent: "domain-remove", domainId: confirm.item.id });
            setConfirm(null);
          }}
        />
      )}
    </section>
  );
}
