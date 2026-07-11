import { useEffect, useReducer, useRef, useState } from "react";
import { useNavigate, type FetcherWithComponents } from "react-router";
import { Avatar, initialsOf } from "~/ui/avatar";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { TglP } from "~/ui/toggle";
import { useToast } from "~/ui/toast";
import { formatDayBucket } from "~/shared/dates/format";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";
import { RBAC_ROWS, type RoleId } from "~/features/policy/policy-data";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { PROFILE_NTF, type NotifPrefs } from "./notification-prefs";

/**
 * Profile & preferences overlay surface (Phase 9C, profile.md — ported
 * from design/html-app/app/profile.jsx). Four mock panels PLUS the
 * ruling-13 additions: ProfileAppearance is MOUNTED (the mock built it but
 * never rendered it) and a self-serve Change-password panel exists for
 * accounts with a local password (phase-2 machinery, login-flow copy).
 *
 * Identity is the session user widened by the loader (ruling 6 — id is
 * authoritative, names render-only). "Your access" reads the shared
 * RBAC_ROWS table (contracts §3.2, imported from features/policy — never
 * restated) indexed by the REAL membership role. GitHub connection state
 * is derived from users.idp (ruling 13); Connect starts the real OAuth
 * flow, Disconnect is a governed action with a lockout guard.
 */

export interface ProfileData {
  user: {
    id: string;
    name: string;
    title: string | null;
    email: string;
    idp: string;
    createdAt: string;
    avatarTone: string;
    hasPassword: boolean;
    githubConnected: boolean;
    githubHandle: string | null;
  };
  memberships: { slug: string; name: string; role: RoleId }[];
  accessRole: RoleId | null;
  prefs: {
    notifs: NotifPrefs;
    motion: "full" | "reduce";
    tlDefault: "all" | "typed" | "comment";
  };
}

export interface ProfileActionData {
  ok: boolean;
  intent?: string;
  toast?: string;
  error?: string;
}

type ProfileFetcher = FetcherWithComponents<ProfileActionData>;

/** Pushes server-computed toasts exactly once per completed submission. */
function useServerToast(fetcher: ProfileFetcher) {
  const push = useToast();
  const seen = useRef<ProfileActionData | null>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (seen.current === fetcher.data) return;
    seen.current = fetcher.data;
    if (fetcher.data.ok && fetcher.data.toast) push(fetcher.data.toast);
  }, [fetcher.state, fetcher.data, push]);
}

function actionError(fetcher: ProfileFetcher): string | null {
  if (fetcher.state === "idle" && fetcher.data && !fetcher.data.ok) {
    return fetcher.data.error ?? "Something went wrong.";
  }
  return null;
}

// ------------------------------------------------------------ Identity

const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Enter") e.currentTarget.blur();
};

function ProfileIdentity({
  data,
  fetcher,
  submit,
}: {
  data: ProfileData;
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const { user, memberships } = data;
  const [name, setName] = useState(user.name);
  const [title, setTitle] = useState(user.title ?? "");
  useServerToast(fetcher);
  const error = actionError(fetcher);

  const dirty = name !== user.name || title !== (user.title ?? "");
  const commit = () => {
    if (dirty) submit({ intent: "identity", name, title });
  };

  const signsInVia =
    user.idp === "local" ? "local account" : `${user.idp} oauth`;

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="user" />
        <h2>Profile</h2>
      </div>
      <div className="profile-id">
        <Avatar
          person={{ initials: initialsOf(name), tone: user.avatarTone }}
          xl
        />
        <div className="profile-fields">
          <div className="field-row">
            <div className="field">
              <label className="flabel" htmlFor="profile-name">
                Display name
              </label>
              <input
                id="profile-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commit}
                onKeyDown={blurOnEnter}
              />
            </div>
            <div className="field">
              <label className="flabel" htmlFor="profile-title">
                Title
              </label>
              <input
                id="profile-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commit}
                onKeyDown={blurOnEnter}
              />
            </div>
          </div>
          <div className="field">
            <label className="flabel" htmlFor="profile-email">
              Email{" "}
              <span className="fhint">{signsInVia} · admins can edit</span>
            </label>
            <input id="profile-email" type="text" value={user.email} disabled />
          </div>
          {error && (
            <div className="login-err" role="alert">
              <Icon name="alert" />
              {error}
            </div>
          )}
        </div>
      </div>
      <div className="kv" style={{ marginTop: ".9rem" }}>
        {memberships.length ? (
          memberships.map((m, i) => (
            <div className="kv-row" key={m.slug}>
              <span className="k">{i === 0 ? "Member of" : ""}</span>
              <span className="v">
                {m.name}
                <Pill kind="info" sm>
                  {m.role}
                </Pill>
              </span>
            </div>
          ))
        ) : (
          <div className="kv-row">
            <span className="k">Member of</span>
            <span className="v">—</span>
          </div>
        )}
        <div className="kv-row">
          <span className="k">Signs in via</span>
          <span className="v">
            <Icon name={user.idp === "github" ? "github" : "lock"} />
            <span className="mono">{signsInVia}</span>
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Joined</span>
          <span className="v">{formatDayBucket(user.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------- Notification routing

function ProfileNotifications({
  notifs,
  submit,
}: {
  notifs: NotifPrefs;
  submit: (fields: Record<string, string>) => void;
}) {
  const push = useToast();
  const [ntf, setNtf] = useState(notifs);

  const flip = (row: (typeof PROFILE_NTF)[number]) => {
    const on = !ntf[row.id].app;
    setNtf({ ...ntf, [row.id]: { ...ntf[row.id], app: on } });
    submit({ intent: "set-notif", category: row.id, on: on ? "1" : "0" });
    push(row.n + " notifications " + (on ? "on" : "off"));
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="bell" />
        <h2>Notification routing</h2>
      </div>
      <div>
        {PROFILE_NTF.map((row) => (
          <div className="pref-row" key={row.id}>
            <span className="pref-main">
              <div className="pn">{row.n}</div>
              <div className="pd">{row.d}</div>
            </span>
            <span className="ntf-cols">
              <span className="ntf-cell">
                <TglP
                  on={!!ntf[row.id].app}
                  onChange={() => flip(row)}
                  label={row.n}
                />
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------ Appearance & workspace

const THEMES: [ThemePreference, string][] = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["system", "System"],
];
const TLS: ["all" | "typed" | "comment", string][] = [
  ["all", "All"],
  ["typed", "Important"],
  ["comment", "Comments"],
];

function ProfileAppearance({
  theme,
  onTheme,
  motion,
  tlDefault,
  submit,
}: {
  theme: ThemePreference;
  onTheme: (value: ThemePreference, label: string) => void;
  motion: "full" | "reduce";
  tlDefault: "all" | "typed" | "comment";
  submit: (fields: Record<string, string>) => void;
}) {
  const push = useToast();
  const [mo, setMo] = useState(motion);
  const [tl, setTl] = useState(tlDefault);

  const flipMotion = () => {
    const next = mo === "reduce" ? "full" : "reduce";
    setMo(next);
    document.documentElement.dataset.motion = next;
    submit({ intent: "set-motion", motion: next });
    push(
      next === "reduce"
        ? "Motion reduced — pulses and animation paused"
        : "Motion restored",
    );
  };

  const pickTl = (v: "all" | "typed" | "comment", l: string) => {
    setTl(v);
    submit({ intent: "set-tl-default", tlDefault: v });
    push("Timeline opens on “" + l + "”");
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="sparkle" />
        <h2>Appearance &amp; workspace</h2>
      </div>
      <div>
        <div className="pref-row">
          <span className="pref-main">
            <div className="pn">Theme</div>
            <div className="pd">
              Light and dark both hold the WCAG AA baseline. Applies on this
              device.
            </div>
          </span>
          <span className="mini-seg">
            {THEMES.map(([v, l]) => (
              <button
                type="button"
                key={v}
                className={theme === v ? "on" : ""}
                onClick={() => onTheme(v, l)}
              >
                {l}
              </button>
            ))}
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-main">
            <div className="pn">Reduce motion</div>
            <div className="pd">Pauses live pulses and interface animation.</div>
          </span>
          <TglP on={mo === "reduce"} onChange={flipMotion} label="Reduce motion" />
        </div>
        <div className="pref-row">
          <span className="pref-main">
            <div className="pn">Timeline opens showing</div>
            <div className="pd">
              Default filter when you open a task — typed important events are
              kept either way.
            </div>
          </span>
          <span className="mini-seg">
            {TLS.map(([v, l]) => (
              <button
                type="button"
                key={v}
                className={tl === v ? "on" : ""}
                onClick={() => pickTl(v, l)}
              >
                {l}
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Your access

function ProfileAccess({
  role,
  onNav,
  hasMembership,
}: {
  role: RoleId | null;
  onNav: (view: "policy" | "settings") => void;
  hasMembership: boolean;
}) {
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="shield" />
        <h2>Your access</h2>
        {role && (
          <span className="right">
            <Pill kind="info" sm>
              {role}
            </Pill>
          </span>
        )}
      </div>
      {role ? (
        <div className="kv">
          {RBAC_ROWS.map((r) => (
            <div className="kv-row" key={r.action}>
              <span className="k" style={{ color: "var(--fg)" }}>
                {r.action}
              </span>
              {r.grant[role] ? (
                <span className="rbac-yes">
                  <Icon name="check" />
                </span>
              ) : (
                <span className="rbac-no">—</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty">No project membership yet.</div>
      )}
      <div className="pol-note" style={{ margin: ".9rem 0 0" }}>
        <Icon name="lock" />
        <span>
          Your role is assigned by an admin and enforced on every action.
          Changes go through{" "}
          {hasMembership ? (
            <button
              type="button"
              className="keybtn"
              onClick={() => onNav("policy")}
            >
              Policy → Human access
            </button>
          ) : (
            <strong>Policy → Human access</strong>
          )}
        </span>
      </div>
    </div>
  );
}

// -------------------------------------------------------- GitHub identity

function ProfileGithub({
  data,
  onNav,
  hasMembership,
  fetcher,
  submit,
}: {
  data: ProfileData;
  onNav: (view: "policy" | "settings") => void;
  hasMembership: boolean;
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const { user } = data;
  const gh = user.githubConnected;
  useServerToast(fetcher);
  const error = actionError(fetcher);

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="github" />
        <h2>GitHub identity</h2>
      </div>
      <div className="kv">
        <div className="kv-row">
          <span className="k">Workspace identity</span>
          <span className="v">
            <span className="mono">{user.email}</span>
          </span>
        </div>
        <div className="kv-row">
          <span className="k">GitHub account</span>
          <span className="v">
            <span className="mono">
              {gh
                ? user.githubHandle
                  ? `@${user.githubHandle} · GitHub sign-in`
                  : "linked · GitHub sign-in"
                : "not connected"}
            </span>
          </span>
        </div>
      </div>
      <div className="cred-card">
        <div className="cred-top">
          <Icon name="github" />
          <span className="cred-name">Personal OAuth identity</span>
          <span
            className="mono"
            style={{ marginLeft: "auto", color: "var(--faint)" }}
          >
            {gh ? "oauth" : "—"}
          </span>
        </div>
        <div className="scope-chips">
          <span className={"scope-chip" + (gh ? "" : " miss")}>
            <Icon name={gh ? "check" : "alert"} />
            read:user
          </span>
          <span className={"scope-chip" + (gh ? "" : " miss")}>
            <Icon name={gh ? "check" : "alert"} />
            user:email
          </span>
        </div>
        {gh ? (
          <div className="cred-ok">
            <Icon name="check" />
            <span>
              Connected — your approvals, acceptances, and runtime-session
              opens are attributed to{" "}
              <strong>
                {user.githubHandle ? `@${user.githubHandle}` : user.email}
              </strong>{" "}
              in audit records.
            </span>
            <button
              type="button"
              className="btn ghost sm"
              style={{ marginLeft: "auto" }}
              onClick={() => submit({ intent: "github-disconnect" })}
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="cred-warn">
            <Icon name="alert" />
            <span>
              Not connected — actions record under your workspace identity
              only, and your GitHub review approvals can't be matched back to
              you.
            </span>
            <a
              className="btn sm"
              style={{ marginLeft: "auto" }}
              href="/auth/github?returnTo=/profile"
            >
              <Icon name="github" />
              Connect
            </a>
          </div>
        )}
      </div>
      {error && (
        <div className="login-err" role="alert" style={{ marginTop: ".7rem" }}>
          <Icon name="alert" />
          {error}
        </div>
      )}
      <div className="pol-note" style={{ margin: ".9rem 0 0" }}>
        <Icon name="lock" />
        <span>
          This identity only attributes <strong>your</strong> actions. Agents
          execute with the project credential in{" "}
          {hasMembership ? (
            <button
              type="button"
              className="keybtn"
              onClick={() => onNav("settings")}
            >
              Settings → Repository &amp; credentials
            </button>
          ) : (
            <strong>Settings → Repository &amp; credentials</strong>
          )}{" "}
          — secrets never appear in task records.
        </span>
      </div>
    </div>
  );
}

// -------------------------------------------------------- Change password

type PwFormState = {
  current: string;
  next: string;
  confirm: string;
  clientErr: string | null;
};

const PW_FORM_INITIAL: PwFormState = {
  current: "",
  next: "",
  confirm: "",
  clientErr: null,
};

type PwFormAction =
  | { type: "edit"; field: "current" | "next" | "confirm"; value: string }
  | { type: "client-err"; error: string | null }
  | { type: "reset" };

function pwFormReducer(state: PwFormState, action: PwFormAction): PwFormState {
  switch (action.type) {
    case "edit":
      return { ...state, [action.field]: action.value, clientErr: null };
    case "client-err":
      return { ...state, clientErr: action.error };
    case "reset":
      return PW_FORM_INITIAL;
  }
}

function ProfilePassword({
  fetcher,
  submit,
}: {
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const [{ current, next, confirm, clientErr }, dispatch] = useReducer(
    pwFormReducer,
    PW_FORM_INITIAL,
  );
  useServerToast(fetcher);

  // Clear the fields after a successful change.
  const doneRef = useRef<ProfileActionData | null>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (doneRef.current === fetcher.data) return;
    doneRef.current = fetcher.data;
    if (fetcher.data.ok) {
      dispatch({ type: "reset" });
    }
  }, [fetcher.state, fetcher.data]);

  const err = clientErr ?? actionError(fetcher);
  const busy = fetcher.state !== "idle";

  const onSubmit = () => {
    if (next.length < MIN_PASSWORD_LENGTH) {
      dispatch({
        type: "client-err",
        error: `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }
    if (next !== confirm) {
      dispatch({ type: "client-err", error: "Passwords don't match." });
      return;
    }
    dispatch({ type: "client-err", error: null });
    submit({
      intent: "change-password",
      current,
      next,
      confirm,
    });
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="lock" />
        <h2>Change password</h2>
      </div>
      <div className="profile-fields">
        <div className="field">
          <label className="flabel" htmlFor="profile-pw-current">
            Current password
          </label>
          <input
            id="profile-pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) =>
              dispatch({ type: "edit", field: "current", value: e.target.value })
            }
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="flabel" htmlFor="profile-pw-next">
              New password{" "}
              <span className="fhint">
                at least {MIN_PASSWORD_LENGTH} characters
              </span>
            </label>
            <input
              id="profile-pw-next"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) =>
                dispatch({ type: "edit", field: "next", value: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label className="flabel" htmlFor="profile-pw-confirm">
              Confirm new password
            </label>
            <input
              id="profile-pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) =>
                dispatch({
                  type: "edit",
                  field: "confirm",
                  value: e.target.value,
                })
              }
            />
          </div>
        </div>
        {err && (
          <div className="login-err" role="alert">
            <Icon name="alert" />
            {err}
          </div>
        )}
        <div>
          <button
            className="btn sm"
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={onSubmit}
          >
            Change password
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ root

export function ProfilePage({
  data,
  theme,
  onTheme,
  fetchers,
  submitWith,
}: {
  data: ProfileData;
  theme: ThemePreference;
  onTheme: (value: ThemePreference, label: string) => void;
  fetchers: {
    identity: ProfileFetcher;
    prefs: ProfileFetcher;
    password: ProfileFetcher;
    github: ProfileFetcher;
  };
  submitWith: (
    fetcher: ProfileFetcher,
  ) => (fields: Record<string, string>) => void;
}) {
  const navigate = useNavigate();
  const first = data.memberships[0] ?? null;
  const onNav = (view: "policy" | "settings") => {
    if (first) navigate(`/projects/${first.slug}/${view}`);
  };

  return (
    <div className="board-wrap" data-screen-label="Profile & preferences">
      <div className="board-head">
        <div>
          <h1>Profile &amp; preferences</h1>
          <div className="sub">
            Personal to your account — project policy and roles stay in Policy
          </div>
        </div>
      </div>
      <div className="policy-wrap">
        <div className="profile-cols">
          <div className="profile-col">
            <ProfileIdentity
              data={data}
              fetcher={fetchers.identity}
              submit={submitWith(fetchers.identity)}
            />
            <ProfileNotifications
              notifs={data.prefs.notifs}
              submit={submitWith(fetchers.prefs)}
            />
            <ProfileAppearance
              theme={theme}
              onTheme={onTheme}
              motion={data.prefs.motion}
              tlDefault={data.prefs.tlDefault}
              submit={submitWith(fetchers.prefs)}
            />
          </div>
          <div className="profile-col">
            <ProfileAccess
              role={data.accessRole}
              onNav={onNav}
              hasMembership={first !== null}
            />
            <ProfileGithub
              data={data}
              onNav={onNav}
              hasMembership={first !== null}
              fetcher={fetchers.github}
              submit={submitWith(fetchers.github)}
            />
            {data.user.hasPassword && (
              <ProfilePassword
                fetcher={fetchers.password}
                submit={submitWith(fetchers.password)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
