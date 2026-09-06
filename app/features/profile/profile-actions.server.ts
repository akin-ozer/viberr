import type { DatabaseSync } from "node:sqlite";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  credentialPasswordHash,
  setCredentialPassword,
} from "~/server/auth/identity.server";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from "~/server/auth/password.server";
import {
  findUserById,
  updateUserFields,
} from "~/server/auth/user-store.server";
import { getPref, setPref } from "~/server/prefs/user-prefs.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  disconnectBackend,
  setBackendApiKey,
  type LoginMethod,
} from "~/server/runtimes/backend-credentials.server";
import {
  backendBinaryIfPresent,
  cancelBackendLogin,
  startBackendLogin,
  submitBackendLoginCode,
  type LoginSessionView,
} from "~/server/runtimes/backend-login.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  isNotifPrefCategory,
  mergeNotifPrefs,
  type NotifPrefs,
} from "./notification-prefs";
import {

  listUserMemberships,

  NOTIFS_PREF_KEY,
  TL_DEFAULT_PREF_KEY,

  type TimelineDefault,
} from "./profile-query.server";

/**
 * Profile mutations (Phase 9C, profile.md §5). Route-level auth + CSRF
 * happen in routes/profile.tsx; these functions trust their caller and
 * take the acting user for audit (phase-2 pattern). All errors are typed
 * AppError (user-correctable) — the route maps them to inline copy.
 */

export interface ProfileActor {
  userId: string;
  label: string;
}

/** What a profile mutation hands the route: the one line it toasts. */
export interface ProfileToast {
  toast: string;
}

/** Name/Title blur-commit. Toast copy is the mock's, parameterized with
 * the first membership's project name (single-project mock literal). */
export function updateProfileIdentity(
  db: DatabaseSync,
  actor: ProfileActor,
  input: { name: string; title: string },
): ProfileToast {
  const name = input.name.trim();
  if (!name) {
    throw AppError.validation("Display name can't be empty.");
  }
  const title = input.title.trim();
  updateUserFields(db, actor.userId, { name, title: title || null });
  recordAudit(db, {
    action: "profile.updated",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: actor.userId,
    details: { fields: ["name", "title"] },
  });
  const first = listUserMemberships(db, actor.userId)[0];
  return {
    toast: first
      ? `Profile saved. Visible to ${first.name} members`
      : "Profile saved",
  };
}

/** Notification-routing toggle (app channel only — ruling 13). */
export function setNotifRoutingPref(
  db: DatabaseSync,
  userId: string,
  category: string,
  on: boolean,
): NotifPrefs {
  if (!isNotifPrefCategory(category)) {
    throw AppError.validation("Unknown notification category.");
  }
  const current = mergeNotifPrefs(getPref(db, userId, NOTIFS_PREF_KEY));
  const next: NotifPrefs = {
    ...current,
    [category]: { ...current[category], app: on },
  };
  setPref(db, userId, NOTIFS_PREF_KEY, next);
  return next;
}

export function setTimelineDefaultPref(
  db: DatabaseSync,
  userId: string,
  value: string,
): TimelineDefault {
  if (value !== "all" && value !== "typed" && value !== "comment") {
    throw AppError.validation("Invalid timeline default.");
  }
  setPref(db, userId, TL_DEFAULT_PREF_KEY, value);
  return value;
}

/**
 * Self-serve password change. Hash/verify go through the app's
 * `password.server` wrappers — i.e. better-auth's own crypto, the sole auth
 * system — plus the shared MIN_PASSWORD_LENGTH and the login flow's validation
 * copy. Keeps the current session, signs out every other one.
 */
export async function changeOwnPassword(
  db: DatabaseSync,
  actor: ProfileActor & { sessionId: string },
  input: { current: string; next: string; confirm: string },
): Promise<{ toast: string }> {
  const user = findUserById(db, actor.userId);
  if (!user) throw AppError.notFound("Account not found.");
  const currentHash = credentialPasswordHash(db, user.id);
  if (!currentHash) {
    throw AppError.validation(
      "This account has no local password. It signs in through an identity provider.",
    );
  }
  if (!(await verifyPassword(input.current, currentHash))) {
    throw AppError.validation("Current password is incorrect.");
  }
  if (input.next.length < MIN_PASSWORD_LENGTH) {
    throw AppError.validation(
      `New password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (input.next !== input.confirm) {
    throw AppError.validation("Passwords don't match.");
  }
  const hash = await hashPassword(input.next);
  // better-auth holds the credential that sign-in verifies.
  setCredentialPassword(db, actor.userId, hash);
  // Sign out every OTHER session; the one making this change survives.
  db.prepare(`DELETE FROM session WHERE userId = ? AND id != ?`).run(
    actor.userId,
    actor.sessionId,
  );
  recordAudit(db, {
    action: "auth.password.changed",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: actor.userId,
  });
  return { toast: "Password updated. Other sessions were signed out" };
}

/**
 * GitHub identity disconnect (attribution only). Connected state is
 * derived from users.idp (ruling 13); disconnecting flips sign-in back to
 * the local account — refused when no password exists (the account would
 * lock itself out). Audit-relevant per profile.md §5.
 */
export function disconnectGithubIdentity(
  db: DatabaseSync,
  actor: ProfileActor,
): ProfileToast {
  const user = findUserById(db, actor.userId);
  if (!user) throw AppError.notFound("Account not found.");
  if (user.idp !== "github") {
    throw AppError.validation("GitHub isn't connected on this account.");
  }
  if (!user.hasPassword) {
    throw AppError.validation(
      "Set a password first: this account signs in only through GitHub.",
    );
  }
  updateUserFields(db, actor.userId, { idp: "local" });
  recordAudit(db, {
    action: "identity.github.disconnected",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "user",
    subjectId: actor.userId,
  });
  return {
    toast: "GitHub disconnected. Audit falls back to your workspace identity",
  };
}

// ------------------------------------------------ agent accounts (ruling 127)

/**
 * Profile → Agent accounts. Every run this instance starts bills ONE person's
 * provider account, so connecting Claude and Codex is a personal action taken
 * here, not a deployment setting (ruling 127).
 *
 * These wrappers exist for one reason each function states: the store and the
 * sign-in driver both need the absolute path of the UNMODIFIED vendor binary,
 * and resolving it is `backend-login.server.ts`'s job. Routes stay thin, so the
 * route never reaches for a binary itself.
 */

/** Ruling 92: the backends are called "Claude" and "Codex" everywhere. */
const BACKEND_LABEL = { claude: "Claude", codex: "Codex" } as const;

/**
 * Start the vendor's own hosted sign-in for this person.
 *
 * No `binaries` override: the driver resolves the ONE binary this flow needs,
 * so a server that has Anthropic's optional package but not OpenAI's can still
 * sign Claude in, and a missing package is reported as the actionable sentence
 * naming the vendor the person pressed.
 */
export function startBackendSignIn(
  db: DatabaseSync,
  actor: ProfileActor,
  backend: RealBackend,
  method: LoginMethod,
): LoginSessionView {
  return startBackendLogin(db, actor, backend, method);
}

/** Hand Anthropic's one-time code to the waiting child (Claude only). The value
 *  passes straight through to the child's stdin: nothing here stores or logs
 *  it. */
export function submitBackendSignInCode(
  db: DatabaseSync,
  actor: ProfileActor,
  backend: RealBackend,
  code: string,
): LoginSessionView {
  return submitBackendLoginCode(db, actor, backend, code);
}

/** Cancel a running sign-in. A person who has nothing running is told so rather
 *  than being toasted a cancellation that never happened. */
export function cancelBackendSignIn(
  db: DatabaseSync,
  actor: ProfileActor,
  backend: RealBackend,
): ProfileToast {
  const cancelled = cancelBackendLogin(db, actor, backend);
  if (!cancelled) {
    throw AppError.validation(
      `No ${BACKEND_LABEL[backend]} sign-in is running.`,
    );
  }
  return { toast: `${BACKEND_LABEL[backend]} sign-in cancelled` };
}

/**
 * Store a pasted key or workspace access token, replacing whatever held the
 * slot. This backend's `binary` rides along because replacing a previous vendor
 * SIGN-IN runs that vendor's own logout first (spec §3.2 replace semantics);
 * without it the store would delete the local credential file and leave the
 * vendor-side session alive. `backendBinaryIfPresent` rather than a hard
 * resolve: a host missing the optional package must still let a person manage
 * their own account, and it never withholds the OTHER vendor's logout.
 */
export async function connectBackendKey(
  db: DatabaseSync,
  actor: ProfileActor,
  backend: RealBackend,
  kind: "api_key" | "access_token",
  secret: string,
): Promise<ProfileToast> {
  const row = await setBackendApiKey(db, actor, backend, kind, secret, {
    binary: backendBinaryIfPresent(backend),
  });
  const label = BACKEND_LABEL[backend];
  const suffix = row.secretSuffix ?? "";
  return {
    toast:
      kind === "access_token"
        ? `${label} connected · access token ending in ${suffix}, stored unverified`
        : `${label} connected · key ending in ${suffix}`,
  };
}

/** Disconnect this person's account for one backend. */
export async function disconnectBackendAccount(
  db: DatabaseSync,
  actor: ProfileActor,
  backend: RealBackend,
): Promise<ProfileToast> {
  await disconnectBackend(db, actor, backend, {
    binary: backendBinaryIfPresent(backend),
  });
  return { toast: `${BACKEND_LABEL[backend]} disconnected` };
}
