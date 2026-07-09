import { useEffect, useState } from "react";
import { Form, Link, useFetcher, useLocation, useNavigate } from "react-router";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Avatar, initialsOf } from "~/ui/avatar";
import { CsrfInput, useCsrfToken } from "~/ui/csrf-input";
import { applyThemePreference } from "./theme-preference";
import { Icon } from "~/ui/icon";
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

const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

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
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher();
  const csrf = useCsrfToken();
  const push = useToast();

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const person = { initials: initialsOf(user.name), tone: user.avatarTone };

  const cycleTheme = () => {
    const next = NEXT_THEME[theme] ?? "light";
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    fetcher.submit(fd, { method: "post", action: "/prefs/theme" });
    push(themeToast(next));
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
          <div className="user-menu from-top" role="menu">
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
              role="menuitem"
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
                role="menuitem"
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
              role="menuitem"
              onClick={cycleTheme}
            >
              <Icon name="sparkle" />
              Theme ·{" "}
              <span style={{ color: "var(--faint)" }}>{themeLabel(theme)}</span>
            </button>
            {user.role === "admin" && (
              <Link
                className="menu-item"
                role="menuitem"
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
              <button className="menu-item danger" role="menuitem" type="submit">
                <Icon name="ext" />
                Sign out
              </button>
            </Form>
          </div>
        </>
      )}
      <button
        type="button"
        className={"home-user" + (menu ? " open" : "")}
        onClick={() => setMenu((m) => !m)}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label="Account menu"
      >
        <Avatar person={person} lg />
      </button>
    </div>
  );
}
