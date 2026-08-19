import { useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useLocation, useNavigate } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Avatar } from "~/ui/avatar";
import { initialsOf } from "~/ui/initials";
import { CsrfInput, useCsrfToken } from "~/ui/csrf-input";
import { applyThemePreference } from "./theme-preference";
import { Icon } from "~/ui/icon";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useDismiss } from "~/ui/use-dismiss";
import { useToast } from "~/ui/toast";

/**
 * Account menu (`user-menu from-top`) — ONE implementation for the
 * workspace topbar and the Home header (the mock duplicates it). Real
 * session identity, real logout POST, theme cycling persisted to the user
 * row + cookie via /prefs/theme.
 *
 * Deliberate mock behavior kept: the Theme item does NOT close the menu
 * (rapid cycling UX). Additions (sanctioned): Escape closes; admins get an
 * "Org settings" quick link to the instance admin surface.
 */

export interface MenuUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarTone: string;
}

const NEXT_THEME = {
  light: "dark",
  dark: "system",
  system: "light",
} satisfies Record<ThemePreference, ThemePreference>;

function themeLabel(theme: ThemePreference): string {
  return theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light";
}

function themeToast(theme: ThemePreference): string {
  return (
    "Theme · " +
    (theme === "system"
      ? "System (follows your OS)"
      : theme === "dark"
        ? "Dark"
        : "Light")
  );
}

export function UserMenu({
  user,
  theme,
  showSwitchProject,
}: {
  user: MenuUser;
  theme: ThemePreference;
  showSwitchProject?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher<{ ok: boolean; theme?: ThemePreference; error?: string }>();
  const csrf = useCsrfToken();
  const push = useToast();

  // P16-UI-12: one shared dismiss hook (`app/ui/use-dismiss.ts`) instead of a
  // hand-rolled listener. `outside: false` preserves the deliberate behaviour
  // here — this menu stays open until Escape or an explicit action, because the
  // Theme item is meant to be cycled in place.
  useDismiss(menu, () => setMenu(false), { outside: false });

  // Toast only once the server confirms the theme write — a failed POST
  // (expired session/CSRF) reports the failure, not a false success (P11-40).
  useFetcherResult(fetcher, (data) => {
    if (data.ok && data.theme) push(themeToast(data.theme));
    else if (!data.ok)
      push(data.error ?? "Theme change failed — try again", "error");
  });

  // UI-45: the panel is rendered BEFORE its trigger, so without this a keyboard
  // user who opened the menu and pressed Tab left it entirely. Focus in on open,
  // restore to the avatar on close.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (menu) menuRef.current?.focus();
    else if (wasOpen.current) buttonRef.current?.focus();
    wasOpen.current = menu;
  }, [menu]);

  const person = { initials: initialsOf(user.name), tone: user.avatarTone };

  const cycleTheme = () => {
    const next = NEXT_THEME[theme] ?? "light";
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    fetcher.submit(fd, { method: "post", action: "/prefs/theme" });
    // Toast fires on the server result (effect above), not on submit.
    // Menu intentionally stays open (mock behavior — rapid cycling).
  };

  return (
    <div className="home-user-wrap">
      {menu && (
        <>
          {/* Mouse-only dismiss affordance; keyboard users close via the
              window-level Escape handler above, so hide from the a11y tree. */}
          <div
            className="menu-scrim"
            aria-hidden="true"
            onClick={() => setMenu(false)}
          />
          {/*
            UI-45: this declared `role="menu"` / `role="menuitem"` with NO
            arrow-key handling — a broken ARIA menu contract, which tells a
            screen-reader user to expect Up/Down navigation that does not exist.
            Rather than hand-roll a full menu widget (roving tabindex, typeahead,
            Home/End) for six links, the roles are DROPPED: this is a small group
            of buttons and links, and plain Tab order is a contract the code
            actually honours. Focus moves into the panel on open and returns to
            the avatar on close (the popover is rendered before its trigger).
          */}
          <div
            className="user-menu from-top"
            ref={menuRef}
            tabIndex={-1}
            aria-label="Account menu"
          >
            <div className="user-menu-head">
              <Avatar person={person} lg />
              <span>
                <div className="who">{user.name}</div>
                <div className="role">{user.email}</div>
              </span>
            </div>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setMenu(false);
                navigate("/profile", {
                  state: { returnTo: location.pathname + location.search },
                });
              }}
            >
              <Icon name="user" />
              Profile &amp; preferences
            </button>
            {showSwitchProject && (
              <Link
                className="menu-item"
                to="/"
                onClick={() => setMenu(false)}
              >
                <Icon name="board" />
                Switch project
              </Link>
            )}
            <button
              type="button"
              className="menu-item"
              onClick={cycleTheme}
            >
              <Icon name="sparkle" />
              Theme ·{" "}
              <span className="faint">{themeLabel(theme)}</span>
            </button>
            {user.role === "admin" && (
              <Link
                className="menu-item"
                to="/org/settings"
                onClick={() => setMenu(false)}
              >
                <Icon name="sliders" />
                Org settings
              </Link>
            )}
            <div className="menu-sep" />
            <Form method="post" action="/logout">
              <CsrfInput />
              <button className="menu-item danger" type="submit">
                <Icon name="ext" />
                Sign out
              </button>
            </Form>
          </div>
        </>
      )}
      <button
        type="button"
        ref={buttonRef}
        className={"home-user" + (menu ? " open" : "")}
        onClick={() => setMenu((m) => !m)}
        aria-haspopup="dialog"
        aria-expanded={menu}
        aria-label="Account menu"
      >
        <Avatar person={person} lg />
      </button>
    </div>
  );
}
