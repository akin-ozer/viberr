import { useState } from "react";
import { Form, Link, useFetcher, useLocation, useNavigate } from "react-router";
import { DropdownMenu } from "radix-ui";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Avatar } from "~/ui/avatar";
import { initialsOf } from "~/ui/initials";
import { CsrfInput, useCsrfToken } from "~/ui/csrf-input";
import { applyThemePreference } from "./theme-preference";
import { Icon } from "~/ui/icon";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useToast } from "~/ui/toast";

/**
 * Account menu (`user-menu`) — ONE implementation for the workspace topbar and
 * the Home header (the mock duplicates it). Real session identity, real logout
 * POST, theme cycling persisted to the user row + cookie via /prefs/theme.
 *
 * Deliberate mock behavior kept: the Theme item does NOT close the menu
 * (rapid cycling UX). Additions (sanctioned): Escape closes; admins get an
 * "Org settings" quick link to the instance admin surface.
 *
 * Ruling 166 (2026-09-08): this is a real ARIA menu again. UI-45 had DROPPED
 * `role="menu"`/`role="menuitem"` because they were declared with no arrow-key
 * handling — a contract that tells a screen-reader user to expect Up/Down
 * navigation that does not exist — and hand-rolling a full menu widget (roving
 * tabindex, typeahead, Home/End) for six links was not worth it. Radix ships
 * exactly that widget, unstyled, so the roles come back and this time they are
 * honoured: arrows, typeahead, Home/End, focus in on open and back to the
 * avatar on close, and outside-press dismissal.
 *
 * That also retires three hand-rolled pieces: the `menu-scrim` div (Radix
 * dismisses on outside press), the `useDismiss` subscription, and the
 * focus-in/focus-restore effect that existed because the panel used to be
 * rendered BEFORE its trigger. Placement is floating-ui's now — collision
 * aware, so the menu no longer runs off a narrow viewport — and `app.css`
 * keeps only the menu's appearance.
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
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher<{ ok: boolean; theme?: ThemePreference; error?: string }>();
  const csrf = useCsrfToken();
  const push = useToast();

  // Toast only once the server confirms the theme write — a failed POST
  // (expired session/CSRF) reports the failure, not a false success (P11-40).
  useFetcherResult(fetcher, (data) => {
    if (data.ok && data.theme) push(themeToast(data.theme));
    else if (!data.ok)
      push(data.error ?? "Theme change failed. Try again", "error");
  });

  const person = { initials: initialsOf(user.name), tone: user.avatarTone };

  const cycleTheme = () => {
    const next = NEXT_THEME[theme] ?? "light";
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    fetcher.submit(fd, { method: "post", action: "/prefs/theme" });
    // Toast fires on the server result (effect above), not on submit.
  };

  const triggerProps = { className: "home-user" + (menu ? " open" : "") };
  const contentProps = { className: "user-menu" };

  return (
    <div className="home-user-wrap">
      <DropdownMenu.Root
        open={menu}
        onOpenChange={setMenu}
        // Not modal: this is a six-item account menu in the page header, not a
        // task that owns the screen. `modal` would mark the rest of the page
        // aria-hidden and lock scrolling for it, which is heavier than the
        // interaction deserves — and heavier than the scrim it replaces was.
        modal={false}
      >
        <DropdownMenu.Trigger asChild>
          <button type="button" {...triggerProps} aria-label="Account menu">
            <Avatar person={person} size="lg" />
          </button>
        </DropdownMenu.Trigger>
        {/* No Portal on purpose. Radix positions the popper `fixed`, so no
            ancestor can clip it, and staying in the tree keeps the menu inside
            the component's own DOM — which is what the shell tests query and
            what keeps `.home-user-wrap` meaningful. */}
        <DropdownMenu.Content
          {...contentProps}
          side="bottom"
          align="end"
          // `.55rem` — the gap the stylesheet used to express as
          // `top: calc(100% + .55rem)`.
          sideOffset={9}
          // No aria-label here: Radix points the menu's `aria-labelledby` at
          // the trigger, so the panel is named by the control that opened it —
          // one source for the name instead of two that can drift.
        >
          <DropdownMenu.Label className="user-menu-head">
            <Avatar person={person} size="lg" />
            <span>
              <div className="who">{user.name}</div>
              <div className="role">{user.email}</div>
            </span>
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className="menu-item"
            onSelect={() =>
              navigate("/profile", {
                state: { returnTo: location.pathname + location.search },
              })
            }
          >
            <Icon name="user" />
            Profile &amp; preferences
          </DropdownMenu.Item>
          {showSwitchProject && (
            <DropdownMenu.Item asChild>
              <Link className="menu-item" to="/">
                <Icon name="board" />
                Switch project
              </Link>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            className="menu-item"
            // The one item that does not close the menu: theme is cycled in
            // place (light → dark → system), so closing after every press would
            // make three presses into three round trips through the trigger.
            onSelect={(e) => {
              e.preventDefault();
              cycleTheme();
            }}
          >
            <Icon name="sparkle" />
            Switch theme ·{" "}
            <span className="faint">{themeLabel(theme)}</span>
          </DropdownMenu.Item>
          {user.role === "admin" && (
            <DropdownMenu.Item asChild>
              <Link className="menu-item" to="/org/settings">
                <Icon name="sliders" />
                {/* D2 (pass 23): the destination's own H1 and every other
                    direction call it "Instance settings"; the only nav entry to
                    it said "Org settings", so users relaying an error hunted for
                    a name the menu doesn't show. One name. */}
                Instance settings
              </Link>
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator className="menu-sep" />
          <Form method="post" action="/logout">
            <CsrfInput />
            <DropdownMenu.Item
              asChild
              // Closing unmounts the form mid-submit. Let the POST and its
              // redirect take the page instead; nothing is left to return to.
              onSelect={(e) => e.preventDefault()}
            >
              <button className="menu-item danger" type="submit">
                <Icon name="ext" />
                Sign out
              </button>
            </DropdownMenu.Item>
          </Form>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
}
