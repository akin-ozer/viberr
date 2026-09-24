import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
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
import {
  ACCOUNT_MENU_LABEL,
  accountTriggerClass,
  type MenuHandOver,
  type MenuUser,
} from "./user-menu";

/**
 * Account menu (`user-menu`) — ONE implementation for the workspace topbar and
 * the Home header (the mock duplicates it). Real session identity, real logout
 * POST, theme cycling persisted to the user row + cookie via /prefs/theme.
 *
 * Ruling 457: this module is the menu itself and is loaded lazily. Pages ship
 * `user-menu.tsx`, a trigger that looks the same and fetches this module on
 * intent (pointer over it, focus) or on the first press; see there.
 *
 * Deliberate mock behavior kept: the Theme item does NOT close the menu
 * (rapid cycling UX). Additions (sanctioned): Escape closes; admins get an
 * "Instance settings" quick link to the instance admin surface.
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

export function UserMenuPanel({
  user,
  theme,
  showSwitchProject,
  open: menu,
  onOpenChange: setMenu,
  handOver,
}: {
  user: MenuUser;
  theme: ThemePreference;
  showSwitchProject?: boolean;
  /** Owned by `UserMenu`, so a press that beat the fetch opens it on arrival. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handOver: RefObject<MenuHandOver>;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const fetcher = useFetcher<{ ok: boolean; theme?: ThemePreference; error?: string }>();
  const csrf = useCsrfToken();
  const push = useToast();

  // The theme on screen: the one the save is carrying, else `theme`. The page
  // flips at the press, but `theme` (the root loader's) catches up only when
  // the save revalidates it. Read alone, it left the label a step behind the
  // page, and a second quick press cycled from the stale value (light, press,
  // press landed on Dark, not System). A refused save clears the form data,
  // so this falls back to `theme`, where the rollback below puts the page.
  // Inline, not a shared helper: a module shared with /profile becomes a chunk
  // of its own, and every page preloads it with this menu (ruling 457).
  const inFlight = fetcher.formData?.get("theme");
  const current: ThemePreference =
    inFlight === "light" || inFlight === "dark" || inFlight === "system" ? inFlight : theme;

  // Toast only once the server confirms the theme write — a failed POST
  // (expired session/CSRF) reports the failure, not a false success (P11-40),
  // and puts the page back on the confirmed theme the label has returned to.
  useFetcherResult(fetcher, (data) => {
    if (data.ok && data.theme) push(themeToast(data.theme));
    else if (!data.ok) {
      applyThemePreference(theme);
      push(data.error ?? "Theme change failed. Try again", "error");
    }
  });

  const person = { initials: initialsOf(user.name), tone: user.avatarTone };

  const cycleTheme = () => {
    const next = NEXT_THEME[current] ?? "light";
    applyThemePreference(next);
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("theme", next);
    fetcher.submit(fd, { method: "post", action: "/prefs/theme" });
    // Toast fires on the server result (effect above), not on submit.
  };

  // Ruling 457: this trigger replaced the plain one in `UserMenu`. If a Tab
  // had put the focus there, it moves here; an open menu takes it instead.
  useLayoutEffect(() => {
    const hadFocus = handOver.current.focused;
    handOver.current.focused = false;
    if (hadFocus && !menu) triggerRef.current?.focus();
  }, [handOver, menu]);

  // Radix puts the focus on the first item when a key opened the menu. It
  // cannot know that of the first open, whose key reached the plain trigger
  // before this module had even loaded, so that one is done here. A passive
  // effect, like Radix's own focus-on-open, which then finds the focus
  // already inside and leaves it there.
  useEffect(() => {
    if (!menu || !handOver.current.keyboard) return;
    handOver.current.keyboard = false;
    contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [handOver, menu]);

  const triggerProps = { className: accountTriggerClass(menu) };
  const contentProps = { className: "user-menu" };

  // `UserMenu` renders the `.home-user-wrap` around this.
  return (
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
        <button
          ref={triggerRef}
          type="button"
          {...triggerProps}
          aria-label={ACCOUNT_MENU_LABEL}
        >
          <Avatar person={person} size="lg" />
        </button>
      </DropdownMenu.Trigger>
      {/* No Portal on purpose. Radix positions the popper `fixed`, so no
          ancestor can clip it, and staying in the tree keeps the menu inside
          the component's own DOM — which is what the shell tests query and
          what keeps `.home-user-wrap` meaningful. */}
      <DropdownMenu.Content
        ref={contentRef}
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
          <span className="faint">{themeLabel(current)}</span>
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
  );
}
