import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ThemePreference } from "~/server/theme/theme-cookie.server";
import { Avatar } from "~/ui/avatar";
import { initialsOf } from "~/ui/initials";
import { useDismiss } from "~/ui/use-dismiss";

/**
 * The account menu as pages ship it. Ruling 457: the menu itself
 * (`user-menu-panel.tsx`, a Radix DropdownMenu per ruling 166) and the Radix
 * primitives under it were about 32 KB gzip on every signed-in page, for a
 * menu that opens a few times a session. So pages render only its trigger,
 * the same button with the same classes, name and ARIA, and the menu module
 * is fetched on intent: the pointer over the trigger or focus on it. Once it
 * is there the real Radix trigger replaces this one (taking the focus if a
 * Tab had put it here), and every interaction after that is Radix's own.
 *
 * A press that beats the fetch is not lost: pointerdown (left button, no
 * Ctrl) or Enter / Space / ArrowDown, the keys Radix's trigger opens on,
 * opens the menu as soon as it arrives, and a keyboard open puts the focus
 * on the first item as Radix does for a keyboard open. Until then the press
 * can be taken back as an open menu can be closed: Escape, a second press
 * (pointerdown, Enter or Space toggle, as on Radix's trigger), or a press or
 * the focus anywhere outside the trigger.
 */

export interface MenuUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarTone: string;
}

/** The trigger's accessible name, shared by this trigger and the menu's. */
export const ACCOUNT_MENU_LABEL = "Account menu";

/** The trigger's classes, shared by this trigger and the menu's. */
export function accountTriggerClass(open: boolean): string {
  return "home-user" + (open ? " open" : "");
}

/** What this trigger hands the menu when the menu replaces it. */
export interface MenuHandOver {
  /** A Tab had put the focus on this trigger; the menu's trigger takes it. */
  focused: boolean;
  /** The first open came from the keyboard: the first item takes the focus. */
  keyboard: boolean;
}

let panelModule: Promise<typeof import("./user-menu-panel")> | null = null;
let panelLoaded = false;

/** Starts (once) fetching the menu's chunk; a failed fetch is forgotten so
 *  the next intent retries. */
function loadPanel(): Promise<typeof import("./user-menu-panel")> {
  if (!panelModule) {
    const pending = import("./user-menu-panel");
    panelModule = pending;
    pending.then(
      () => {
        panelLoaded = true;
      },
      () => {
        panelModule = null;
      },
    );
  }
  return panelModule;
}

const LazyUserMenuPanel = lazy(() =>
  loadPanel().then((module) => ({ default: module.UserMenuPanel })),
);

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
  // Every mount renders the plain trigger first: the server has no menu to
  // render, so hydration must see the plain trigger too.
  const [wanted, setWanted] = useState(false);
  const handOver = useRef<MenuHandOver>({ focused: false, keyboard: false });

  const want = useCallback(() => {
    loadPanel().then(
      // A transition keeps this trigger on screen until the menu can render
      // in its place in one commit.
      () => startTransition(() => setWanted(true)),
      // Offline or a stale deploy: nothing to open; the next intent retries.
      () => setMenu(false),
    );
  }, []);

  // A later page in the same session already has the chunk: swap at once.
  useEffect(() => {
    if (panelLoaded) want();
  }, [want]);

  const openFrom = (keyboard: boolean) => {
    handOver.current.keyboard = keyboard;
    setMenu(true);
    want();
  };
  const takeBack = () => {
    handOver.current.keyboard = false;
    setMenu(false);
  };

  // Review finding UM-PENDING-OPEN (ruling 457): a press that beat the fetch
  // opens the menu when it lands, and the menu then takes the focus. So the
  // pending press is dismissed the way Radix dismisses the open menu: Escape,
  // or a press or the focus outside the trigger. Otherwise the menu opened
  // late on its own, pulling the focus (and the keystrokes typed there) away
  // from wherever the person had gone. Once the menu is here, it is Radix's.
  const wrapRef = useDismiss<HTMLDivElement>(menu && !wanted, takeBack, { focus: true });

  // Runs when the menu replaces this trigger, in the same commit and before
  // the menu's layout effect reads it.
  const capture = useCallback((el: HTMLButtonElement | null) => {
    if (!el) return;
    return () => {
      handOver.current.focused = el.ownerDocument.activeElement === el;
    };
  }, []);

  const trigger = (
    <button
      ref={capture}
      type="button"
      className={accountTriggerClass(menu)}
      aria-label={ACCOUNT_MENU_LABEL}
      aria-haspopup="menu"
      aria-expanded={menu}
      onPointerEnter={want}
      onFocus={want}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.ctrlKey) return;
        // A second press takes the first back, as Radix's trigger toggles.
        if (menu) {
          takeBack();
          return;
        }
        // As Radix does: the menu, not the trigger, takes the focus.
        e.preventDefault();
        openFrom(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
        e.preventDefault();
        // Enter and Space toggle, ArrowDown only opens (Radix's trigger).
        if (menu && e.key !== "ArrowDown") takeBack();
        else openFrom(true);
      }}
    >
      <Avatar person={{ initials: initialsOf(user.name), tone: user.avatarTone }} size="lg" />
    </button>
  );

  return (
    <div className="home-user-wrap" ref={wrapRef}>
      {/* The boundary stays mounted and its child changes inside a
          transition, so React keeps this trigger instead of the fallback
          while the lazy module settles. The fallback is only a guard. */}
      <Suspense fallback={trigger}>
        {wanted ? (
          <LazyUserMenuPanel
            user={user}
            theme={theme}
            showSwitchProject={showSwitchProject}
            open={menu}
            onOpenChange={setMenu}
            handOver={handOver}
          />
        ) : (
          trigger
        )}
      </Suspense>
    </div>
  );
}
