import { revalidateWhen } from "~/features/live-updates/revalidation-policy";
import { useRef } from "react";
import { pageTitle } from "~/shared/page-title";
import {
  data,
  useFetcher,
  useLocation,
  useNavigate,
  useRouteLoaderData,
} from "react-router";
import { z } from "zod";
import type { Route } from "./+types/profile";
import type { loader as rootLoader } from "../root";
import { requireAuth, requireUser } from "~/server/auth/require-user.server";
import { csrfError } from "~/features/shell/csrf-result.server";
import { getDb } from "~/server/db/sqlite.server";
import { AppError, isAppError } from "~/server/errors/app-error.server";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { getProfileView } from "~/features/profile/profile-query.server";
import {
  cancelBackendSignIn,
  changeOwnPassword,
  connectBackendKey,
  disconnectAgentAccount,
  disconnectGithubIdentity,
  renameAgentAccount,

  setNotifRoutingPref,
  setTimelineDefaultPref,
  startBackendSignIn,
  submitBackendSignInCode,
  switchAgentAccount,
  updateProfileIdentity,
} from "~/features/profile/profile-actions.server";
import {
  ProfilePage,
  type ProfileActionData,
} from "~/features/profile/profile-page";
import { applyThemePreference } from "~/features/shell/theme-preference";
import { AGENT_ACCOUNTS_ANCHOR } from "~/shared/page-anchors";
import { useCsrfToken } from "~/ui/csrf-input";
import { PageOverlay } from "~/ui/page-overlay";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { revealTarget, scrollingBox, useHashTarget } from "~/ui/use-hash-target";

/**
 * /profile — URL-addressable PageOverlay route (phase-4 shell decision,
 * kept). Phase 9C fills it with the full profile.jsx surface: identity,
 * notification routing, MOUNTED Appearance panel (ruling 13), read-only
 * RBAC access view, GitHub identity, self-serve password change.
 *
 * Theme still goes through the existing /prefs/theme action (cookie +
 * users.theme); tlDefault/notifs live in user_prefs via this route's
 * action (ruling 148(c): there is no motion preference any more).
 */

export function meta() {
  return [{ title: pageTitle("Profile & preferences") }];
}

/** Overlay routes are opened from the shell with the path to return to in
 *  history state (top-bell, user-menu). Browser history state survives reloads
 *  and back/forward and is not the app's to trust, so it is parsed here rather
 *  than asserted. */
const overlayReturnState = z
  .object({ returnTo: z.string().optional().catch(undefined) })
  .catch({});

/**
 * Ruling 127 form fields. Decoded, never coerced: `backend` names a directory
 * segment and a spawn target, and `method` / `kind` decide which vendor flow
 * runs, so a value outside the vocabulary must be a refusal with a sentence,
 * not a silent default.
 */
const backendField = z.enum(["claude", "codex"]);
const loginMethodField = z.enum(["claudeai", "console", "device"]);
const pasteKindField = z.enum(["api_key", "access_token"]);
/** Ruling 507: an account id, shaped the way `newId("ubc")` mints them. The
 *  store only ever looks one up together with the session's own user. */
const accountField = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** The optional `account` of a sign-in: absent or empty means a new account. */
function optionalAccount(value: FormDataEntryValue | null): string | undefined {
  if (value === null || value === "") return undefined;
  return decodeOr(accountField.safeParse(value), "Unknown account.");
}

/** The one sentence every unknown backend/method/kind value gets. */
function decodeOr<T>(parsed: z.ZodSafeParseResult<T>, message: string): T {
  if (!parsed.success) throw AppError.validation(message);
  return parsed.data;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const profile = getProfileView(db, user.id);
  if (!profile) throw data("Account not found.", { status: 404 });
  return { profile };
}

export async function action({ request }: Route.ActionArgs) {
  const ctx = await requireAuth(request);
  const db = getDb();
  const formData = await request.formData();
  // UI-32: `assertCsrf` used to throw here, OUTSIDE the try below — a thrown
  // Response renders the nearest boundary, so an expired token replaced the
  // profile overlay (and everything else) with root's 403 page instead of the
  // `{ok:false,error}` toast this action's own catch produces for every other
  // failure.
  const csrfFailure = await csrfError(request, ctx.sessionId, formData);
  if (csrfFailure) return csrfFailure;
  const intent = String(formData.get("intent") ?? "");
  const actor = { userId: ctx.user.id, label: ctx.user.email };

  try {
    switch (intent) {
      case "identity": {
        const { toast } = updateProfileIdentity(db, actor, {
          name: String(formData.get("name") ?? ""),
          title: String(formData.get("title") ?? ""),
        });
        return { ok: true as const, intent, toast };
      }
      case "set-notif": {
        setNotifRoutingPref(
          db,
          ctx.user.id,
          String(formData.get("category") ?? ""),
          formData.get("on") === "1",
        );
        return { ok: true as const, intent };
      }
      case "set-tl-default": {
        setTimelineDefaultPref(
          db,
          ctx.user.id,
          String(formData.get("tlDefault") ?? ""),
        );
        return { ok: true as const, intent };
      }
      case "change-password": {
        const { toast } = await changeOwnPassword(
          db,
          { ...actor, sessionId: ctx.sessionId },
          {
            current: String(formData.get("current") ?? ""),
            next: String(formData.get("next") ?? ""),
            confirm: String(formData.get("confirm") ?? ""),
          },
        );
        return { ok: true as const, intent, toast };
      }
      case "github-disconnect": {
        const { toast } = disconnectGithubIdentity(db, actor);
        return { ok: true as const, intent, toast };
      }
      // Ruling 127: the Agent-accounts intents. None of them toasts a success
      // here except the ones that ARE complete when they return; a sign-in is
      // only connected once the vendor's own binary says so, which the panel
      // learns from /resources/backend-login. Ruling 507 added switching and
      // naming accounts, and made a disconnect name the account it removes.
      case "backend-login-start": {
        startBackendSignIn(
          db,
          actor,
          decodeOr(
            backendField.safeParse(formData.get("backend")),
            "Unknown agent backend.",
          ),
          decodeOr(
            loginMethodField.safeParse(formData.get("method")),
            "Unknown sign-in method.",
          ),
          optionalAccount(formData.get("account")),
        );
        return { ok: true as const, intent };
      }
      case "backend-account-switch": {
        const { toast } = switchAgentAccount(
          db,
          actor,
          decodeOr(accountField.safeParse(formData.get("account")), "Unknown account."),
        );
        return { ok: true as const, intent, toast };
      }
      case "backend-account-rename": {
        const { toast } = renameAgentAccount(
          db,
          actor,
          decodeOr(accountField.safeParse(formData.get("account")), "Unknown account."),
          String(formData.get("name") ?? ""),
        );
        return { ok: true as const, intent, toast };
      }
      case "backend-login-code": {
        submitBackendSignInCode(
          db,
          actor,
          decodeOr(
            backendField.safeParse(formData.get("backend")),
            "Unknown agent backend.",
          ),
          String(formData.get("code") ?? ""),
        );
        return { ok: true as const, intent };
      }
      case "backend-login-cancel": {
        const { toast } = cancelBackendSignIn(
          db,
          actor,
          decodeOr(
            backendField.safeParse(formData.get("backend")),
            "Unknown agent backend.",
          ),
        );
        return { ok: true as const, intent, toast };
      }
      case "backend-set-key": {
        const { toast } = await connectBackendKey(
          db,
          actor,
          decodeOr(
            backendField.safeParse(formData.get("backend")),
            "Unknown agent backend.",
          ),
          decodeOr(
            pasteKindField.safeParse(formData.get("kind")),
            "Unknown credential kind.",
          ),
          String(formData.get("secret") ?? ""),
        );
        return { ok: true as const, intent, toast };
      }
      case "backend-disconnect": {
        const { toast } = await disconnectAgentAccount(
          db,
          actor,
          decodeOr(accountField.safeParse(formData.get("account")), "Unknown account."),
        );
        return { ok: true as const, intent, toast };
      }
      default:
        return data(
          { ok: false as const, intent, error: "Unknown action." },
          { status: 400 },
        );
    }
  } catch (error) {
    // Map ALL AppErrors to the fetcher's `{ ok:false }` shape (WI-13/WI-14):
    // an infrastructure-kind AppError otherwise crashed the overlay's error
    // boundary instead of surfacing inline like every sibling route.
    if (isAppError(error)) {
      return data(
        { ok: false as const, intent, error: error.userMessage },
        { status: error.status },
      );
    }
    throw error;
  }
}

export default function Profile({ loaderData }: Route.ComponentProps) {
  const { profile } = loaderData;
  const rootData = useRouteLoaderData<typeof rootLoader>("root");
  const theme = rootData?.theme ?? "system";
  const navigate = useNavigate();
  const location = useLocation();
  const csrf = useCsrfToken();
  const push = useToast();
  // Ruling 532: Home's setup checklist opens `#agent-accounts`. Here, above
  // the overlay, the reveal runs after the overlay's own effect has opened
  // its dialog (effects run child first), so the panel it scrolls to and
  // focuses is on screen.
  const accountsTargeted =
    useHashTarget(isAgentAccountsAnchor, true, revealUnderHead) !== null;
  const themeFetcher = useFetcher<{ ok: boolean; error?: string }>();
  // The segment the page is on: the choice a save is carrying, else `theme`,
  // which the root loader confirms only once that save revalidates it (the
  // account menu's item reads its theme the same way, `user-menu-panel.tsx`).
  const inFlight = themeFetcher.formData?.get("theme");
  const current: ThemePreference =
    inFlight === "light" || inFlight === "dark" || inFlight === "system" ? inFlight : theme;

  const identityFetcher = useFetcher<ProfileActionData>();
  const prefsFetcher = useFetcher<ProfileActionData>();
  // UI-56: Appearance gets its own fetcher. Sharing `prefsFetcher` meant a
  // notification flip immediately followed by an appearance flip never delivered the
  // `set-notif` result, stranding that panel's rollback snapshot so a LATER
  // failure rolled back to stale state.
  const appearanceFetcher = useFetcher<ProfileActionData>();
  const passwordFetcher = useFetcher<ProfileActionData>();
  const githubFetcher = useFetcher<ProfileActionData>();
  // Ruling 127: the Agent-accounts panel's own action fetcher. Its POLLING is a
  // separate per-card fetcher inside the panel (`/resources/backend-login`) —
  // a `fetcher.load` on this one would overwrite the intent RESULT the toast
  // and the inline error settle on.
  const backendsFetcher = useFetcher<ProfileActionData>();

  const close = () => {
    const { returnTo } = overlayReturnState.parse(location.state);
    navigate(returnTo ?? "/");
  };

  const submitWith =
    (fetcher: typeof identityFetcher) => (fields: Record<string, string>) => {
      const fd = new FormData();
      fd.set("_csrf", csrf);
      for (const [key, value] of Object.entries(fields)) fd.set(key, value);
      fetcher.submit(fd, { method: "post", action: "/profile" });
    };

  // UI-31: the theme toast fired at SUBMIT time and no handler read the result,
  // so a rejected POST (expired session / stale CSRF) left the page claiming the
  // theme was saved while the next revalidation reverted it. Settle on the
  // result and roll the applied preference back on failure.
  const themePending = useRef<{ toast: string; rollback: ThemePreference } | null>(
    null,
  );
  useFetcherResult(themeFetcher, (result) => {
    const p = themePending.current;
    themePending.current = null;
    if (!p) return;
    if (result.ok) {
      push(p.toast);
    } else {
      applyThemePreference(p.rollback);
      push(result.error ?? "Theme not saved. Reload and try again", "error");
    }
  });

  const onTheme = (next: ThemePreference, label: string) => {
    // RU-1: re-selecting the active theme is a no-op — don't re-submit or toast.
    // Active is the one on screen: while Dark is saving over a confirmed
    // Light, pressing Light is a change back, not a repeat.
    if (next === current) return;
    themePending.current = {
      toast: "Theme · " + label + (next === "system" ? " (follows your OS)" : ""),
      rollback: theme,
    };
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    themeFetcher.submit(fd, { method: "post", action: "/prefs/theme" });
  };

  return (
    <PageOverlay label="Profile & preferences" onClose={close}>
      <ProfilePage
        key={profile.user.id}
        data={profile}
        theme={current}
        onTheme={onTheme}
        fetchers={{
          identity: identityFetcher,
          prefs: prefsFetcher,
          appearance: appearanceFetcher,
          password: passwordFetcher,
          github: githubFetcher,
          backends: backendsFetcher,
        }}
        submitWith={submitWith}
        accountsTargeted={accountsTargeted}
      />
    </PageOverlay>
  );
}

function isAgentAccountsAnchor(id: string): boolean {
  return id === AGENT_ACCOUNTS_ANCHOR;
}

/** Ruling 532: the overlay pins its head over the top of what it scrolls
 *  (`.page-overlay .board-head`), so the panel comes to rest below it, where
 *  its title shows, instead of under it. */
function revealUnderHead(id: string): HTMLElement | null {
  const target = document.getElementById(id);
  if (!target) return null;
  revealTarget(target);
  const head = target.closest("dialog")?.querySelector(".board-head");
  const box = scrollingBox(target);
  if (head && box) box.scrollTop -= head.getBoundingClientRect().height;
  return target;
}

/** Ruling 457: when this loader re-runs (`revalidation-policy.ts`). */
export const shouldRevalidate = revalidateWhen("routes/profile");
