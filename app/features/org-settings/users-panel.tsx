import { useState } from "react";
import { useSearchParams } from "react-router";
import type { DomainRecord, OrgUserView } from "~/server/org/org-users.server";
import { countLabel } from "~/shared/text/plural";
import { Avatar } from "~/ui/avatar";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { GlyphSwap } from "~/ui/copy-glyph";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { ConfirmDelete } from "./confirm-delete";
import { MiniModal } from "./mini-modal";
import { useModalAction } from "./resource-helpers";
import { useOrgAction } from "./use-org-action";
import {
  defaultInviteIdp,
  editUserCheck,
  idpName,
  inviteComplete,
  inviteFootHint,
  inviteSaveLabel,
  isDomainInvite,
  type InviteIdp,
} from "./users-panel-derive";

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
        <Icon name="google" />
        Google
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

/** Allow access's sign-in method picker (ruling 13(b), split out of
 *  `InviteModal`, which keeps the state): a method this deployment has not
 *  configured is drawn, disabled and marked off (F18-3). */
function InviteMethodPicker({
  idp,
  providers,
  onPick,
}: {
  idp: InviteIdp;
  providers: { github: boolean; google: boolean };
  onPick: (idp: InviteIdp) => void;
}) {
  return (
    <div className="field">
      <span className="flabel">Sign-in method</span>
      <div className="be-pick three">
        <button
          type="button"
          className={"be-opt" + (idp === "github" ? " on" : "")}
          onClick={() => onPick("github")}
          aria-pressed={idp === "github"}
          disabled={!providers.github}
          title={
            providers.github
              ? undefined
              : "GitHub sign-in isn't configured on this deployment"
          }
        >
          <span className="be-ic">
            <Icon name="github" />
          </span>
          <span className="bnm">
            GitHub{providers.github ? "" : " · off"}
          </span>
          <span className="bcheck">
            <Icon name="check" />
          </span>
        </button>
        <button
          type="button"
          className={"be-opt" + (idp === "google" ? " on" : "")}
          onClick={() => onPick("google")}
          aria-pressed={idp === "google"}
          disabled={!providers.google}
          title={
            providers.google
              ? undefined
              : "Google sign-in isn't configured on this deployment"
          }
        >
          <span className="be-ic">
            <Icon name="google" />
          </span>
          <span className="bnm">
            Google{providers.google ? "" : " · off"}
          </span>
          <span className="bcheck">
            <Icon name="check" />
          </span>
        </button>
        <button
          type="button"
          className={"be-opt" + (idp === "local" ? " on" : "")}
          onClick={() => onPick("local")}
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
  );
}

/** The instance-role toggle both user modals end on (ruling 13(b), split out
 *  of `InviteModal` and `EditUserModal`, which keep the role's state). */
function InstanceRoleField({
  label,
  role,
  onRole,
}: {
  label: string;
  role: "admin" | "member";
  onRole: (role: "admin" | "member") => void;
}) {
  return (
    <div className="field">
      <span className="flabel">{label}</span>
      <span className="mini-seg self-start" role="group" aria-label="Instance role">
        <button type="button" className={role === "admin" ? "on" : ""} aria-pressed={role === "admin"} onClick={() => onRole("admin")}>
          Admin
        </button>
        <button type="button" className={role === "member" ? "on" : ""} aria-pressed={role === "member"} onClick={() => onRole("member")}>
          Member
        </button>
      </span>
    </div>
  );
}

function InviteModal({
  onClose,
  onSetupNotice,
  providers,
  initialRole,
}: {
  onClose: () => void;
  onSetupNotice: (notice: SetupNotice) => void;
  providers: { github: boolean; google: boolean };
  initialRole: "admin" | "member";
}) {
  // F18-3: default to a method this deployment can actually grant
  // (`defaultInviteIdp`).
  const [idp, setIdp] = useState<InviteIdp>(() => defaultInviteIdp(providers));
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"admin" | "member">(initialRole);
  // Ruling 287: a save plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);
  const { action, err, setErr } = useModalAction((d) => {
    if (d.tempPassword !== undefined) {
      onSetupNotice({
        email: d.email ?? "",
        tempPassword: d.tempPassword,
      });
    }
    setDone(true);
  });

  const g = email.trim();
  const isDomain = isDomainInvite(idp, g);
  const canSave = inviteComplete(idp, { handle, account: g, name, email });

  const submit = () => {
    // Enter in a field reaches this directly, so the busy guard lives here
    // too, and so does the one for a save that landed and is leaving.
    if (!canSave || action.busy || done) return;
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
      busy={action.busy}
      done={done}
      sub="Whitelist who can sign in: no invite emails, access on first login"
      onClose={onClose}
      canSave={canSave}
      saveLabel={inviteSaveLabel(idp, isDomain)}
      footHint={inviteFootHint(idp, isDomain, g)}
      onSave={submit}
    >
      <InviteMethodPicker idp={idp} providers={providers} onPick={setIdp} />
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
            value={email}
            placeholder="name@company.dev · or · @company.dev"
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={enter}
            autoFocus
          />
        </div>
      )}
      {idp === "local" && (
        <div className="key-row even">
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
              value={email}
              placeholder="name@company.dev"
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={enter}
            />
          </div>
        </div>
      )}
      <InstanceRoleField
        label={isDomain ? "Role for everyone joining via this domain" : "Instance role"}
        role={role}
        onRole={setRole}
      />
      {/* Pass-19 UX coherence audit, finding #20 — see the note on the Edit
          modal's slot below: this is the invite half of the same asymmetry
          ("A user with email … already exists.", an invalid handle, an
          already-whitelisted account). */}
      {err && (
        <div className="form-err" role="alert">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

/** A local account's Password field in Edit user (ruling 13(b), split out of
 *  `EditUserModal`, which keeps the reset's fetcher and the one-time temp
 *  password it returned). */
function PasswordResetField({
  user,
  tempPassword,
  busy,
  onReset,
}: {
  user: OrgUserView;
  tempPassword: string | null;
  busy: boolean;
  onReset: () => void;
}) {
  return (
    <div className="field">
      <span className="flabel">Password</span>
      {/* LV-F1: the pending state is CONTEXT, never a replacement for the
          action. This branch used to render the "Reset pending" banner
          INSTEAD of the button whenever `pwreset`/`invited` was set — which
          is true for EVERY freshly created account. So an admin who missed
          or reloaded past the one-time temp password had no way to issue a
          new one: the account was permanently un-signin-able and the only
          escape was Remove + recreate (live-reproduced by the owner). The
          button now always renders for a local account; the banner sits
          above it and carries the freshly generated password when there is
          one. */}
      {(user.pwreset || user.status === "invited" || tempPassword) && (
        <div className="cred-ok">
          <Icon name="check" />
          <span>
            Reset pending: {user.name} will be prompted to set a new password at
            next sign-in.
            {tempPassword && (
              <>
                {" "}
                Temp sign-in password:{" "}
                <code className="mono">{tempPassword}</code> (shown once, hand it
                over out-of-band).
              </>
            )}
          </span>
        </div>
      )}
      <div>
        <button
          type="button"
          className="btn ghost sm"
          onClick={onReset}
          disabled={busy}
          // Ruling 286: the reset in flight shows itself here.
          aria-busy={busy || undefined}
        >
          <GlyphSwap rest="lock" alt="loader" on={busy} spinAlt />
          {user.pwreset || user.status === "invited"
            ? busy
              ? "Generating…"
              : "Generate a new temp password"
            : busy
              ? "Resetting…"
              : "Reset password"}
        </button>
        <div className="def-note after">
          <Icon name="lock" />
          <span>
            No email is sent. A temp password is generated for you to hand over;
            they're prompted to set a new password at their next sign-in.
            {(user.pwreset || user.status === "invited") &&
              " Generating again replaces any temp password you handed over earlier."}
          </span>
        </div>
      </div>
    </div>
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
  // Ruling 29: an org admin links the GitHub handle of a local or Google
  // account here; a GitHub account's handle syncs from the provider instead.
  const linksHandle = user.idp !== "github";
  const [githubHandle, setGithubHandle] = useState(user.githubHandle ?? "");
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  // Ruling 287: a save plays the modal's exit, then onClose unmounts it.
  const [done, setDone] = useState(false);
  const push = useToast();

  const { action: saveAction, err, setErr } = useModalAction(() => setDone(true));
  const resetAction = useOrgAction({
    onResult: (d) => {
      if (!d.ok) {
        setErr(d.error);
        return;
      }
      if (d.toast) push(d.toast);
      // Modal stays open — the live user record re-renders the pending
      // state and the temp password shows ONCE (spec §7.7 + honesty).
      if (d.tempPassword !== undefined) setTempPassword(d.tempPassword);
    },
  });

  const { handleInput, handleOk, canSave } = editUserCheck({ isLocal, name, email, githubHandle });
  const save = () => {
    if (!canSave) return;
    if (isYou && role !== "admin") {
      // P13-D-10: every client-side refusal in this panel ("can't demote /
      // disable / remove yourself") is a FAILURE toast — they all rendered the
      // success tick because `push` defaults to "success".
      push("You can't demote yourself", "error");
      return;
    }
    setErr(null);
    const fields = {
      intent: "user-edit",
      userId: user.id,
      name: name.trim(),
      email: email.trim(),
      role,
    };
    // A blank handle clears the link; a GitHub account sends none at all.
    saveAction.submit(
      linksHandle ? { ...fields, githubHandle: handleInput ?? "" } : fields,
    );
  };

  return (
    <MiniModal
      icon={<Icon name="user" />}
      title={"Edit " + user.name}
      busy={saveAction.busy}
      done={done}
      sub={isLocal ? "Local account" : "Signs in with " + idpName(user.idp)}
      onClose={onClose}
      canSave={canSave}
      saveLabel="Save changes"
      footHint={isYou ? "this is your own account" : undefined}
      unmetHint={
        handleOk
          ? undefined
          : "Enter a GitHub username: letters, digits and hyphens only."
      }
      focusUnmet={
        handleOk ? undefined : () => document.getElementById("eu-github")?.focus()
      }
      onSave={save}
    >
      <div className="key-row even">
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
            value={email}
            disabled={!isLocal}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      {!isLocal && (
        <div className="def-note pulled">
          <Icon name="lock" />
          <span>
            Name &amp; email sync from {idpName(user.idp)} at
            each sign-in and can't be edited here.
          </span>
        </div>
      )}
      {linksHandle && (
        <div className="field">
          <label className="flabel" htmlFor="eu-github">
            GitHub handle
          </label>
          <input
            id="eu-github"
            type="text"
            className="mono"
            placeholder="octocat"
            value={githubHandle}
            aria-invalid={!handleOk}
            aria-describedby="eu-github-hint"
            onChange={(e) => setGithubHandle(e.target.value)}
          />
          <span id="eu-github-hint" className="fhint flush">
            Counts this person's GitHub approval of a review pull request as
            the review verdict.
          </span>
        </div>
      )}
      <InstanceRoleField label="Instance role" role={role} onRole={setRole} />
      {isLocal && (
        <PasswordResetField
          user={user}
          tempPassword={tempPassword}
          busy={resetAction.busy}
          onReset={() =>
            resetAction.submit({ intent: "user-reset-password", userId: user.id })
          }
        />
      )}
      {/* Pass-19 UX coherence audit, finding #20: this panel gave one server
          guard two different feedback semantics. The member row's role toggle
          routes its refusal through `useOrgAction`'s default handler and toasts
          it (ui/toast.tsx — role="status", "the app's ONE announcer"), and the
          client-side refusal on THIS button ("You can't demote yourself") also
          toasts; only the server's "no" — the duplicate-email guard and the
          last-admin guard in org-users.server.ts — landed in a roleless div, so
          a screen-reader user pressed Save changes and heard nothing at all.
          Rendering a refusal in place is right; it just has to ALSO be
          announced. `role="alert"` is what login.tsx and profile-page.tsx
          already use for exactly this. */}
      {err && (
        <div className="form-err" role="alert">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

/** Disable confirm — killing sessions + blocking sign-in is disruptive, so a
 * confirm gate mirrors the remove flow (the shared `ConfirmDialog`, a native
 * <dialog>, ruling 287). */
function DisableUserDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      screenLabel="Disable user dialog"
      icon="hand"
      title={`Disable ${name}?`}
      body={
        <>
          They're signed out immediately and can't sign in until re-enabled. Their
          comments, decisions, and task assignments stay untouched.
        </>
      }
      confirmLabel="Disable"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function UsersPanel({
  users,
  domains,
  meId,
  providers = { github: false, google: false },
}: {
  users: OrgUserView[];
  domains: DomainRecord[];
  meId: string;
  /** F18-3: which OAuth providers this deployment has configured. */
  providers?: { github: boolean; google: boolean };
}) {
  const [confirm, setConfirm] = useState<
    | { kind: "user"; item: OrgUserView }
    | { kind: "domain"; item: DomainRecord }
    | null
  >(null);
  const [disabling, setDisabling] = useState<OrgUserView | null>(null);
  // Ruling 322: Home's setup checklist lands here with `?add=admin`, the
  // person making an account of their own: the dialog opens with Admin chosen.
  const [searchParams] = useSearchParams();
  const [inviting, setInviting] = useState<"admin" | "member" | null>(
    searchParams.get("add") === "admin" ? "admin" : null,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [setupNotice, setSetupNotice] = useState<SetupNotice | null>(null);
  const push = useToast();
  const rowAction = useOrgAction();

  const setRole = (u: OrgUserView, role: "admin" | "member") => {
    if (u.id === meId && role !== "admin") {
      push("You can't demote yourself", "error");
      return;
    }
    if (u.role === role) return;
    rowAction.submit({ intent: "user-role", userId: u.id, role });
  };

  const editing = editingId ? (users.find((x) => x.id === editingId) ?? null) : null;

  return (
    <section className="panel" data-screen-label="Settings · Users & access">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Users &amp; access</h2>
        <span className="right">
          <button type="button" className="btn sm" onClick={() => setInviting("member")}>
            <Icon name="plus" />
            Allow access
          </button>
        </span>
      </div>
      <div className="pol-note">
        <Icon name="shield" />
        <span>
          <strong>{countLabel(users.length, "instance account")}</strong>. GitHub &amp;
          Google access
          is whitelist-based: allowed people simply sign in, no invite emails. Board
          permissions are granted per project.
        </span>
      </div>
      {setupNotice && (
        <div className="cred-ok">
          <Icon name="check" />
          <span>
            Account created for {setupNotice.email}. Temp
            sign-in password: <code className="mono">{setupNotice.tempPassword}</code>{" "}
            (shown once, hand it over out-of-band).
          </span>
          <button
            type="button"
            className="icon-btn modal-close"
            aria-label="Dismiss"
            onClick={() => setSetupNotice(null)}
          >
            <Icon name="x" />
          </button>
        </div>
      )}
      {domains.length > 0 && (
        <div className="member-list last">
          {domains.map((d) => (
            <div className="member-row" key={d.id}>
              <span className="dom-ic">
                <Icon name="google" />
              </span>
              <span className="member-main">
                <div className="nm">{d.domain}</div>
                <div className="em">
                  any Google account with this domain · joins as {d.role}
                </div>
              </span>
              <Pill kind="ready" sm quiet>
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
                <Pill kind="neutral" sm quiet>
                  setup pending
                </Pill>
              )}
              {u.status === "whitelisted" && (
                <Pill kind="neutral" sm quiet>
                  whitelisted
                </Pill>
              )}
              {u.pwreset && (
                <Pill kind="input" sm>
                  password reset pending
                </Pill>
              )}
              {u.disabled && (
                <Pill kind="neutral" sm quiet>
                  disabled
                </Pill>
              )}
              <span className="mini-seg" role="group" aria-label={`Role for ${u.name}`}>
                <button
                  type="button"
                  className={u.role === "admin" ? "on" : ""}
                  aria-pressed={u.role === "admin"}
                  onClick={() => setRole(u, "admin")}
                >
                  Admin
                </button>
                <button
                  type="button"
                  className={u.role === "member" ? "on" : ""}
                  aria-pressed={u.role === "member"}
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
                <Icon name="edit" />
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
                  // Ruling 278: disabling signs the person out at once and
                  // locks them out until someone re-enables them, and the
                  // confirm it opens commits on a `btn danger`. The row's ✕
                  // takes the destructive hover by position (`:last-child`);
                  // this control sits before it, so it opts in by name
                  // (ruling 278).
                  className={"stg-x destructive" + (you ? " off" : "")}
                  title="Disable user"
                  aria-label={"Disable " + u.name}
                  onClick={() => {
                    if (you) {
                      push("You can't disable your own account", "error");
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
                    push("You can't remove your own account", "error");
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
          onClose={() => setInviting(null)}
          onSetupNotice={setSetupNotice}
          providers={providers}
          initialRole={inviting}
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
          }}
        />
      )}
      {confirm && confirm.kind === "user" && (
        <ConfirmDelete
          what={confirm.item.name}
          confirmLabel="Remove member"
          detail="Their comments and decisions stay in the audit history. Any task they own is released in every project: each ownership seat reopens for another contributor to take."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            rowAction.submit({ intent: "user-remove", userId: confirm.item.id });
          }}
        />
      )}
      {confirm && confirm.kind === "domain" && (
        <ConfirmDelete
          what={confirm.item.domain}
          confirmLabel="Remove domain"
          detail="New Google sign-ins from this domain are refused. Accounts that already signed in keep their access."
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            rowAction.submit({ intent: "domain-remove", domainId: confirm.item.id });
          }}
        />
      )}
    </section>
  );
}
