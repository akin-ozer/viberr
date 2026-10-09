import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { useNavigate, type FetcherWithComponents } from "react-router";
import { Avatar } from "~/ui/avatar";
import { initialsOf } from "~/ui/initials";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { TglP } from "~/ui/toggle";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useToast } from "~/ui/toast";
import { LocalCalendarDate } from "~/ui/local-time";
import { MIN_PASSWORD_LENGTH } from "~/shared/auth/password-policy";
import { RBAC_ROWS } from "~/features/policy/policy-data";
import type { ProjectRole } from "~/shared/rbac";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { PROFILE_NTF, type NotifPrefs } from "./notification-prefs";
import {
  desktopAlertState,
  disableDesktopAlerts,
  enableDesktopAlerts,
  type DesktopAlertState,
} from "~/features/notifications/desktop-alerts";
import { MiniModal } from "~/features/org-settings/mini-modal";
import { AgentAccountsPanel } from "./agent-accounts-panel";
import { GithubOAuthIdentity } from "./profile-github";
import type { ProfileBackend } from "./profile-query.server";

/**
 * Profile and preferences overlay, including appearance and a self-serve
 * password change for accounts with a local password (ruling 323: a row
 * on the Profile card whose button opens a modal; phase-2 machinery,
 * login-flow copy).
 *
 * Identity is the session user widened by the loader (ruling 26(a) — id is
 * authoritative, names render-only). "Your access" reads the shared
 * RBAC_ROWS table (contracts §3.2, imported from features/policy — never
 * restated) indexed by the REAL membership role. GitHub connection state
 * is derived from users.idp (ruling 30); Connect starts the real OAuth
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
  memberships: { slug: string; name: string; role: ProjectRole }[];
  accessRole: ProjectRole | null;
  /** F18-3: whether GitHub OAuth is configured on this deployment. */
  githubConfigured: boolean;
  /** Ruling 137: the viewer's own Claude and Codex accounts. Type-only import
   *  of the loader's shape, so the panel and the query cannot drift apart. */
  backends: ProfileBackend[];
  prefs: {
    notifs: NotifPrefs;
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
  useFetcherResult(fetcher, (data) => {
    if (data.ok && data.toast) push(data.toast);
  });
}

function actionError(fetcher: ProfileFetcher): string | null {
  if (fetcher.state === "idle" && fetcher.data && !fetcher.data.ok) {
    return fetcher.data.error ?? "Something went wrong.";
  }
  return null;
}

// ------------------------------------------------------------ Identity

/**
 * UI-33: the ONLY save path for the identity fields is `onBlur` (Enter just
 * blurs). `useDialog`'s cancel handler closes and unmounts the overlay on
 * Escape while focus is still in the input, and React does not fire `onBlur` on
 * unmount — so "type a new display name, press Escape, reopen" silently
 * restored the old name. The keydown listener runs BEFORE the dialog's `cancel`
 * default action, so committing here lands the edit.
 */
const identityKeyDown =
  (commit: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    else if (e.key === "Escape") commit();
  };

function ProfileIdentity({
  data,
  fetcher,
  submit,
  passwordRow,
}: {
  data: ProfileData;
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
  /** Ruling 323: the "Password · Change password" row, when the account
   *  has a local password. Rendered under the sign-in facts it belongs to. */
  passwordRow?: ReactNode;
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
          size="xl"
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
                onKeyDown={identityKeyDown(commit)}
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
                onKeyDown={identityKeyDown(commit)}
              />
            </div>
          </div>
          {error && (
            <div className="login-err" role="alert">
              <Icon name="alert" />
              {error}
            </div>
          )}
        </div>
      </div>
      <div className="kv spaced">
        {memberships.length ? (
          memberships.map((m, i) => (
            <div className="kv-row membership" key={m.slug}>
              <span className="k">{i === 0 ? "Member of" : ""}</span>
              <span className="v">
                {m.name}
                {/* Quiet: the role describes; the panel-head pill on Your
                    access keeps its fill because it is that panel's subject. */}
                <Pill kind="info" sm quiet>
                  {m.role}
                </Pill>
              </span>
            </div>
          ))
        ) : (
          <div className="kv-row">
            <span className="k">Member of</span>
            {/* UXA-10: a bare em dash for the same fact the Your-access panel
                further down states in words ("No project membership yet."). An
                em dash reads as "unknown", not "none" — say the same thing the
                same way on the same page. */}
            <span className="v plain">No projects yet</span>
          </div>
        )}
        {/* Design pass 2026-09-08: the email was a disabled form control under
            the two editable fields — a control nobody can operate. It is a
            fact, beside the sign-in fact it belongs with. */}
        <div className="kv-row">
          <span className="k">Email</span>
          {/* Ruling 280: an address and a sign-in method are not code: the
              body face, at the value's regular weight. */}
          <span className="v light">{user.email}</span>
        </div>
        <div className="kv-row">
          <span className="k">Signs in via</span>
          <span className="v light">
            <Icon name={user.idp === "github" ? "github" : "lock"} />
            {signsInVia}
          </span>
        </div>
        <div className="kv-row">
          <span className="k">Joined</span>
          {/* UXA-10: `formatDayBucket` is the TIMELINE form — it yields
              "Today"/"Yesterday" for a new account and a year-less "Mar 30"
              forever after, so an account opened last year read as though it
              were opened this one. A join date is a calendar fact — rendered
              through the hydration-safe primitive: UTC day first, the viewer's
              calendar date after hydration (pass 34, C6). */}
          <span className="v">
            <LocalCalendarDate iso={user.createdAt} />
          </span>
        </div>
        {passwordRow}
      </div>
      <div className="pol-note after last">
        <Icon name="lock" />
        <span>
          An org admin can change your email in Instance settings → Users &amp;
          access.
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------- Notification routing

function ProfileNotifications({
  notifs,
  fetcher,
  submit,
}: {
  notifs: NotifPrefs;
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const push = useToast();
  const [ntf, setNtf] = useState(notifs);

  // Toast only once the server confirms the routing change — a failed POST
  // (expired session/CSRF) must not report a false success (P11-40). The
  // message is client-computed, so it's stashed on submit alongside the
  // pre-flip state and settled on the matching `set-notif` result (the prefs
  // fetcher is shared with Appearance, hence the intent guard). On failure the
  // optimistic flip is ROLLED BACK — silence would leave a toggle that looks
  // changed but didn't stick.
  const pending = useRef<{ toast: string; rollback: NotifPrefs } | null>(null);
  useFetcherResult(fetcher, (data) => {
    if (data.intent !== "set-notif") return;
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    if (data.ok) {
      push(p.toast);
    } else {
      setNtf(p.rollback);
      push(data.error ?? "Saving notification routing failed. Change not applied", "error");
    }
  });

  const flip = (row: (typeof PROFILE_NTF)[number]) => {
    const on = !ntf[row.id].app;
    pending.current = {
      toast: row.n + " notifications " + (on ? "on" : "off"),
      rollback: ntf,
    };
    setNtf({ ...ntf, [row.id]: { ...ntf[row.id], app: on } });
    submit({ intent: "set-notif", category: row.id, on: on ? "1" : "0" });
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
        <DesktopNotificationsRow />
      </div>
    </div>
  );
}

/** Why the switch cannot turn on here, in the person's words. */
function desktopRefusal(state: DesktopAlertState | null): string | null {
  if (state === "blocked") {
    return "Notifications are blocked for Viberr in this browser's site settings. Allow them there, then switch this on.";
  }
  if (state === "unsupported") {
    return "This browser can't show notifications from Viberr at this address. They need a desktop browser and an HTTPS or localhost address.";
  }
  return null;
}

/**
 * Ruling 74 (F40-51): the opt-in for desktop notifications, per browser
 * (`desktop-alerts.ts` says why). The browser's permission is requested here
 * and nowhere else, and only when the person switches it on. Its state is
 * the browser's, so it renders off until hydration reads it, and it is read
 * again whenever the page regains focus (a person who allowed Viberr in site
 * settings comes back to a switch that knows).
 */
function DesktopNotificationsRow() {
  const push = useToast();
  const [state, setState] = useState<DesktopAlertState | null>(null);
  const asking = useRef(false);
  useEffect(() => {
    const sync = () => setState(desktopAlertState());
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  const flip = () => {
    if (state === null || asking.current) return;
    if (state === "on") {
      disableDesktopAlerts();
      setState("off");
      push("Desktop notifications off");
      return;
    }
    asking.current = true;
    void enableDesktopAlerts().then((next) => {
      asking.current = false;
      setState(next);
      if (next === "on") {
        push("Desktop notifications on");
        return;
      }
      push(
        desktopRefusal(next) ??
          "Desktop notifications stay off: the browser was not allowed to show them.",
        "error",
      );
    });
  };

  const refusal = desktopRefusal(state);
  return (
    <div className="pref-row">
      <span className="pref-main">
        <div className="pn">Desktop notifications</div>
        <div className="pd">
          In this browser: a system notification when a decision, an agent
          question or an approval waits on you and no Viberr tab is in front
          of you. Clicking it opens the task. Every open tab&apos;s title also
          counts them.
        </div>
        {refusal ? <div className="pd">{refusal}</div> : null}
      </span>
      <span className="ntf-cols">
        <span className="ntf-cell">
          <TglP on={state === "on"} onChange={flip} label="Desktop notifications" />
        </span>
      </span>
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
  tlDefault,
  fetcher,
  submit,
}: {
  theme: ThemePreference;
  onTheme: (value: ThemePreference, label: string) => void;
  tlDefault: "all" | "typed" | "comment";
  /** UI-56: Appearance's OWN fetcher. It used to share the notification-routing
   *  fetcher, so a notif flip immediately followed by an appearance flip stranded the
   *  notif panel's pending rollback snapshot forever. */
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const push = useToast();
  const [tl, setTl] = useState(tlDefault);

  // UI-31: settle on the RESULT with rollback, exactly as ProfileNotifications
  // does. The control used to set local state, submit, and toast success
  // immediately — and the shared result handler early-returned unless the intent
  // was `set-notif`, so a `set-tl-default` failure was consumed by NOBODY: no
  // error and no rollback of the control.
  // Ruling 323: the "Reduce motion" toggle that sat here is gone; the OS
  // `prefers-reduced-motion` setting is the one reduced-motion signal.
  const pending = useRef<{
    toast: string;
    rollback: () => void;
  } | null>(null);
  useFetcherResult(fetcher, (data) => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    if (data.ok) {
      push(p.toast);
    } else {
      p.rollback();
      push(data.error ?? "That preference could not be saved. Change not applied", "error");
    }
  });

  const pickTl = (v: "all" | "typed" | "comment", l: string) => {
    // RU-1: re-picking the active default is a no-op — don't re-submit or toast.
    if (v === tl) return;
    const previous = tl;
    setTl(v);
    pending.current = {
      toast: "Timeline opens on “" + l + "”",
      rollback: () => setTl(previous),
    };
    submit({ intent: "set-tl-default", tlDefault: v });
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
            {/* UI-31 family: "Applies on this device" was FALSE — /prefs/theme
                writes `users.theme` and sign-in re-syncs the cookie, so the
                choice follows the account to every browser. */}
            <div className="pd">
              Light and dark both hold the WCAG AA baseline. Saved to your
              account. It follows you to every browser you sign in from.
            </div>
          </span>
          <span className="mini-seg" role="group" aria-label="Theme">
            {THEMES.map(([v, l]) => (
              <button
                type="button"
                key={v}
                className={theme === v ? "on" : ""}
                aria-pressed={theme === v}
                onClick={() => onTheme(v, l)}
              >
                {l}
              </button>
            ))}
          </span>
        </div>
        <div className="pref-row">
          <span className="pref-main">
            <div className="pn">Timeline opens showing</div>
            <div className="pd">
              Default filter when you open a task. Typed important events are
              kept either way.
            </div>
          </span>
          <span className="mini-seg" role="group" aria-label="Timeline opens showing">
            {TLS.map(([v, l]) => (
              <button
                type="button"
                key={v}
                className={tl === v ? "on" : ""}
                aria-pressed={tl === v}
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
  role: ProjectRole | null;
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
        // `grants` (design pass 2026-09-08): twenty permission rows, each ruled
        // off and each ending in a filled tile at the far right of a ~400px
        // gap, took half this overlay for a reference list read once — and for
        // an admin every row says yes, so twenty identical fills carried no
        // information at all. The modifier ungroups it by SPACE instead of
        // rules, strips the tile to a bare glyph, and puts the marker first so
        // there is one left-aligned column the eye can run down. The point is
        // not the ledger: it is that Agent accounts, the panel that decides
        // whether this person's agents can run, now reaches the first screen.
        <div className="kv grants">
          {RBAC_ROWS.map((r) => (
            <div className="kv-row" key={r.action}>
              <span className="k strong">
                {r.action}
                {/* Ruling 26(b): see policy-page — the grant name is short on
                    purpose and two of them gate more than they say. */}
                {r.covers ? <span className="act-covers">{r.covers}</span> : null}
              </span>
              {/* Ruling 291: the fact in words. The check is aria-hidden, so a
                  glyph-only pair left the whole list silent to a reader, and a
                  lone "−" in a value slot reads as a collapse control (the same
                  swap the GitHub card below already made). */}
              {r.grant[role] ? (
                <span className="rbac-yes">
                  <Icon name="check" />
                  <span className="vh">yes</span>
                </span>
              ) : (
                <span className="rbac-no">no</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        // D8: absent → why it matters → next action (P16), not a bare label.
        <div className="empty">
          No project membership yet. A project role, assigned by an admin, is
          what unlocks that project&rsquo;s board, tasks and the actions listed
          above. Ask an admin to add you to a project.
        </div>
      )}
      <div className="pol-note after last">
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

/** better-auth's social sign-in reply: the provider URL to hand the browser.
 *  A reply without a usable one is a failure the caller's catch reports, so a
 *  malformed body must not read as a destination (same schema the login screen
 *  parses this endpoint with). */
const socialSignIn = z
  .object({ url: z.string().min(1).optional().catch(undefined) })
  .catch({});

/** The "GitHub account" fact: the handle and whether it signs in here or an
 *  org admin linked it (ruling 29). */
function githubAccountLine(user: ProfileData["user"]): string {
  if (user.githubConnected) {
    return user.githubHandle ? `@${user.githubHandle} · GitHub sign-in` : "linked · GitHub sign-in";
  }
  return user.githubHandle ? `@${user.githubHandle} · linked by an org admin` : "not connected";
}

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
  // F18-3: on a deployment with no GitHub OAuth, a Connect can only fail — so an
  // UNconfigured + UNconnected card reads as a quiet fact, not warn chips + a
  // doomed button. A CONNECTED card always keeps its full state (rare, but real
  // if OAuth was configured, used, then removed). Mirrors R17-4.
  const showConnectAffordance = gh || data.githubConfigured;
  useServerToast(fetcher);
  const error = actionError(fetcher);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectErr, setConnectErr] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  // The confirm asks about the connection on screen, so it goes when that
  // connection does. A confirmed Disconnect closes it itself (ruling 287); a
  // connection that goes away otherwise (disconnected in another tab while
  // "Disconnect GitHub?" is open here) takes the dialog off with the connected
  // box but not this state, and the next load that finds GitHub connected
  // again would open the dialog with nobody asking. Adjusted during render,
  // React's pattern for state a prop invalidates, not in an effect.
  if (confirmDisconnect && !gh) setConfirmDisconnect(false);

  // Start better-auth's GitHub OAuth link and follow the returned provider URL
  // — the same flow the login screen uses. (The old `/auth/github` href had no
  // route and 404'd; pass-4 MU-1.)
  const startConnect = () => {
    if (connectBusy) return;
    setConnectErr(null);
    setConnectBusy(true);
    void (async () => {
      try {
        const res = await fetch("/api/auth/sign-in/social", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "github", callbackURL: "/profile" }),
        });
        // fetch() resolves on 4xx/5xx, so an error payload would otherwise be
        // read as a successful connect response.
        if (!res.ok) throw new Error("connect request failed");
        const body = socialSignIn.parse(await res.json());
        if (body.url) {
          window.location.href = body.url;
          return;
        }
        throw new Error("no redirect url");
      } catch {
        setConnectBusy(false);
        setConnectErr(
          "GitHub sign-in couldn't start. It may not be configured on this deployment. Ask an admin, or use your workspace identity.",
        );
      }
    })();
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="github" />
        <h2>GitHub identity</h2>
      </div>
      <div className="kv">
        <div className="kv-row">
          <span className="k">Workspace identity</span>
          <span className="v light">{user.email}</span>
        </div>
        <div className="kv-row">
          <span className="k">GitHub account</span>
          <span className="v light">{githubAccountLine(user)}</span>
        </div>
      </div>
      {!showConnectAffordance ? (
        // Unconfigured + unconnected: a quiet, honest one-liner — no warn chips,
        // no Connect that could only produce "GitHub sign-in couldn't start".
        // Ruling 29: with an admin-linked handle the line says what that
        // link does; the person cannot change it here (the verdict path
        // counts approvals by it), so there is no field.
        <div className="pol-note">
          <Icon name={user.githubHandle ? "github" : "lock"} />
          <span>
            {user.githubHandle
              ? "An org admin linked your GitHub handle, so your approvals on review pull requests count as the review verdict."
              : "GitHub sign-in isn't configured on this deployment, so there's no personal GitHub identity to connect. Your actions record under your workspace identity above."}
          </span>
        </div>
      ) : (
        <div className="cred-card">
          <GithubOAuthIdentity
            connected={gh}
            handle={user.githubHandle}
            email={user.email}
            busy={fetcher.state !== "idle"}
            confirming={confirmDisconnect}
            onConfirming={setConfirmDisconnect}
            onDisconnect={() => submit({ intent: "github-disconnect" })}
            connectBusy={connectBusy}
            onConnect={startConnect}
          />
        </div>
      )}
      {(error || connectErr) && (
        <div className="login-err spaced" role="alert">
          <Icon name="alert" />
          {error ?? connectErr}
        </div>
      )}
      <div className="pol-note after last">
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
          )}
          . Secrets never appear in task records.
        </span>
      </div>
    </div>
  );
}

// -------------------------------------------------------- Change password

type PwField = "current" | "next" | "confirm";

/**
 * Ruling 323: the password change is a row on the Profile card whose
 * button opens a modal, not a three-field form served inline on the page.
 * The modal is the org-settings `MiniModal`, which carries the ruling 288
 * contract (the primary stays enabled; an incomplete submit is refused with
 * the hint re-inserted as an alert and the first empty field focused). The two
 * checks the server would also make, length and match, are refused here with
 * the offending field marked and focused, and a server refusal (a wrong
 * current password) lands in the same alert slot.
 */
function ChangePasswordModal({
  fetcher,
  submit,
  done,
  onClose,
}: {
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
  /** The change landed: the modal plays its exit (ruling 287). */
  done: boolean;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  /** The field a refused submit named; null on a pristine form. */
  const [flagged, setFlagged] = useState<PwField | null>(null);
  const [clientErr, setClientErr] = useState<string | null>(null);
  const refs = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  const busy = fetcher.state !== "idle";
  const err = clientErr ?? actionError(fetcher);
  const canSave = current !== "" && next !== "" && confirm !== "";

  const refuse = (field: PwField, message: string) => {
    setFlagged(field);
    setClientErr(message);
    refs[field].current?.focus();
  };
  const save = () => {
    if (next.length < MIN_PASSWORD_LENGTH) {
      refuse("next", `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      refuse("confirm", "Passwords don't match.");
      return;
    }
    setFlagged(null);
    setClientErr(null);
    submit({ intent: "change-password", current, next, confirm });
  };
  const edit = (field: PwField, set: (v: string) => void) => (value: string) => {
    set(value);
    setClientErr(null);
    setFlagged((f) => (f === field ? null : f));
  };
  const mark = (field: PwField) => ({
    "aria-invalid": flagged === field || undefined,
    "aria-describedby": flagged === field && err ? "profile-pw-err" : undefined,
  });

  return (
    <MiniModal
      icon={<Icon name="lock" />}
      title="Change password"
      sub="Keeps you signed in here; every other session is signed out"
      onClose={onClose}
      canSave={canSave}
      busy={busy}
      done={done}
      saveLabel="Change password"
      unmetHint="Fill in all three fields to continue."
      focusUnmet={() => {
        const first: PwField =
          current === "" ? "current" : next === "" ? "next" : "confirm";
        setFlagged(first);
        refs[first].current?.focus();
      }}
      onSave={save}
      screen="Change password dialog"
    >
      <div className="field">
        <label className="flabel" htmlFor="profile-pw-current">
          Current password
        </label>
        <input
          ref={refs.current}
          id="profile-pw-current"
          type="password"
          autoComplete="current-password"
          value={current}
          data-autofocus
          onChange={(e) => edit("current", setCurrent)(e.target.value)}
          {...mark("current")}
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label className="flabel" htmlFor="profile-pw-next">
            New password{" "}
            <span className="fhint">at least {MIN_PASSWORD_LENGTH} characters</span>
          </label>
          <input
            ref={refs.next}
            id="profile-pw-next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => edit("next", setNext)(e.target.value)}
            {...mark("next")}
          />
        </div>
        <div className="field">
          <label className="flabel" htmlFor="profile-pw-confirm">
            Confirm new password
          </label>
          <input
            ref={refs.confirm}
            id="profile-pw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => edit("confirm", setConfirm)(e.target.value)}
            {...mark("confirm")}
          />
        </div>
      </div>
      {err && (
        <div id="profile-pw-err" className="login-err" role="alert">
          <Icon name="alert" />
          {err}
        </div>
      )}
    </MiniModal>
  );
}

/** The "Password" row on the Profile card and the modal its button opens. */
function ProfilePassword({
  fetcher,
  submit,
}: {
  fetcher: ProfileFetcher;
  submit: (fields: Record<string, string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  useServerToast(fetcher);

  // Close on the server's success result: the toast says what happened, and a
  // modal that stayed open over "Password changed" would read as unfinished.
  // Ruling 287: through the modal's exit (`done`), then onClose unmounts it.
  useFetcherResult(fetcher, (data) => {
    if (data.ok) setDone(true);
  });

  return (
    <>
      <div className="kv-row">
        <span className="k">Password</span>
        <span className="v">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              // A change that landed after a Cancel must not close the next
              // opening at once.
              setDone(false);
              setOpen(true);
            }}
          >
            <Icon name="lock" />
            Change password
          </button>
        </span>
      </div>
      {open && (
        <ChangePasswordModal
          fetcher={fetcher}
          submit={submit}
          done={done}
          onClose={() => {
            setOpen(false);
            setDone(false);
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ root

export function ProfilePage({
  data,
  theme,
  onTheme,
  fetchers,
  submitWith,
  accountsTargeted = false,
}: {
  data: ProfileData;
  theme: ThemePreference;
  onTheme: (value: ThemePreference, label: string) => void;
  fetchers: {
    identity: ProfileFetcher;
    prefs: ProfileFetcher;
    /** UI-56: separate from `prefs` — one fetcher per panel. */
    appearance: ProfileFetcher;
    password: ProfileFetcher;
    github: ProfileFetcher;
    /** Ruling 137: the Agent-accounts intents. */
    backends: ProfileFetcher;
  };
  submitWith: (
    fetcher: ProfileFetcher,
  ) => (fields: Record<string, string>) => void;
  /** Ruling 322: the URL names the Agent accounts panel (`#agent-accounts`). */
  accountsTargeted?: boolean;
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
            Personal to your account. Project policy and roles stay in Policy
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
              passwordRow={
                data.user.hasPassword ? (
                  <ProfilePassword
                    fetcher={fetchers.password}
                    submit={submitWith(fetchers.password)}
                  />
                ) : null
              }
            />
            <ProfileNotifications
              notifs={data.prefs.notifs}
              fetcher={fetchers.prefs}
              submit={submitWith(fetchers.prefs)}
            />
            <ProfileAppearance
              theme={theme}
              onTheme={onTheme}
              tlDefault={data.prefs.tlDefault}
              fetcher={fetchers.appearance}
              submit={submitWith(fetchers.appearance)}
            />
          </div>
          <div className="profile-col">
            <ProfileAccess
              role={data.accessRole}
              onNav={onNav}
              hasMembership={first !== null}
            />
            {/* Ruling 137: above GitHub identity. This is the panel that
                decides whether this person's agents can run at all, so it
                outranks the attribution card below it. */}
            <AgentAccountsPanel
              backends={data.backends}
              fetcher={fetchers.backends}
              submit={submitWith(fetchers.backends)}
              targeted={accountsTargeted}
            />
            <ProfileGithub
              data={data}
              onNav={onNav}
              hasMembership={first !== null}
              fetcher={fetchers.github}
              submit={submitWith(fetchers.github)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
