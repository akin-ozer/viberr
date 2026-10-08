import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { utcDayKey } from "~/shared/dates/format";
import { Icon } from "~/ui/icon";
import { LocalCalendarDate } from "~/ui/local-time";
import { useDismiss } from "~/ui/use-dismiss";
import { scrollingBox } from "~/ui/use-hash-target";
import { accountKindWord } from "./agent-accounts-derive";
import type { ProfileBackendAccount } from "./profile-query.server";

/**
 * Profile → Agent accounts: the account picker (ruling 696(e), the split of
 * `agent-accounts-panel.tsx` along the task page's recipe), moved whole with
 * the hooks it always owned.
 */

/** The menu's room: from the trigger, from the edge of the box that clips it,
 *  and the least height a capped menu keeps (its head, two accounts and the
 *  actions under the rule). */
const MENU_GAP = 4;
const MENU_EDGE = 8;
const MENU_MIN = 220;

interface MenuPlace {
  side: "top" | "bottom";
  maxHeight?: number;
}

/**
 * Ruling 616: which of a backend's accounts the person's runs use, as a select
 * (owner, 2026-10-01: "make this part shadcn like selection from the dropdown
 * between accounts of saved accounts to use a selected one in every
 * provider"). It replaces ruling 507's list of the other accounts, each with
 * its own Use this account.
 *
 * The trigger names the account in use. The menu lists every account the
 * person keeps on the backend, up to the store's ceiling, with the one in use
 * checked; choosing another is ruling 507's switch: one write, no sign-in, and
 * the next run bills it. An account whose sign-in file this server no longer
 * holds is listed but cannot be chosen, because the store refuses that switch,
 * and its line says why. Under a rule the menu carries what else starts here:
 * adding an account, and managing the others (a name, a sign-in, a disconnect)
 * without first making one of them the account in use. A switch made only to
 * disconnect an account would bill any run that started in between.
 *
 * The behaviour is this repo's menu contract (StageMenu, the run picker), not
 * Radix's: the Radix menu is about 32 KB gzip (ruling 457, `user-menu.tsx`)
 * for what a few handlers do here. A real button with `aria-haspopup="menu"`,
 * `menuitemradio` rows, focus on the checked row when it opens, ↑/↓ wrapping,
 * Home/End, Escape and Tab back to the trigger, and a press outside closes it.
 * The menu renders inside the card, not under `<body>`: Profile is a modal
 * `<dialog>`, and everything outside one is inert. It hangs from the trigger
 * at its width and opens upward when the overlay's scrolling body has no room
 * for it below, capping its height when neither side has: StageMenu's layo-8
 * placement, measured against the box that clips the menu.
 */
export function AccountPicker({
  label,
  accounts,
  active,
  maxAccounts,
  busy,
  switchingTo,
  triggerRef,
  onSwitch,
  onAdd,
  onManage,
}: {
  label: string;
  accounts: ProfileBackendAccount[];
  active: ProfileBackendAccount;
  maxAccounts: number;
  /** An account request is in flight: both cards share the fetcher. */
  busy: boolean;
  /** Ruling 368: the account THIS card's switch names, while it is in flight. */
  switchingTo: string | null;
  /** Where the card returns focus when what the menu opened is closed. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onSwitch: (accountId: string) => void;
  onAdd: () => void;
  /** Null while the person keeps no other account here. */
  onManage: (() => void) | null;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  // Null until the placement effect has measured the open menu.
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef(false);
  const close = (refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) triggerRef.current?.focus();
  };
  // The trigger is inside the wrapper, so pressing it toggles rather than
  // dismissing and reopening; Escape is consumed, so the Profile dialog
  // around the card does not close with the menu.
  const wrapRef = useDismiss<HTMLDivElement>(open, () => close(false));
  const atLimit = accounts.length >= maxAccounts;
  const switching = accounts.find((account) => account.id === switchingTo) ?? null;
  const rows = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? [],
    );

  // Before paint: below when it fits there, else above when it fits there,
  // else the roomier side with the height capped to it. The box is the
  // nearest scroller (Profile's overlay body), clipped to the viewport, less
  // the head the overlay pins over its top, read as ruling 532's
  // `revealUnderHead` reads it: a menu opened upward under that head covered
  // the page's title.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!open || place || !menu || !trigger) return;
    const at = trigger.getBoundingClientRect();
    const box = scrollingBox(trigger)?.getBoundingClientRect();
    const head = trigger.closest("dialog")?.querySelector(".board-head")?.getBoundingClientRect();
    const top = Math.max(box?.top ?? 0, head?.bottom ?? 0, 0) + MENU_EDGE;
    const bottom = Math.min(box?.bottom ?? window.innerHeight, window.innerHeight) - MENU_EDGE;
    const height = menu.offsetHeight;
    const below = bottom - at.bottom - MENU_GAP;
    const above = at.top - MENU_GAP - top;
    if (height <= below) setPlace({ side: "bottom" });
    else if (height <= above) setPlace({ side: "top" });
    else if (above > below) setPlace({ side: "top", maxHeight: Math.max(MENU_MIN, above) });
    else setPlace({ side: "bottom", maxHeight: Math.max(MENU_MIN, below) });
  }, [open, place, triggerRef]);

  // Once placed, the checked row takes the focus, so the arrows start from
  // the account in use, as a select does.
  useEffect(() => {
    if (!open || !place || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const all = rows();
    (all.find((row) => row.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
  }, [open, place]);

  const openMenu = () => {
    if (busy || switching) return;
    focusOnOpen.current = true;
    setOpen(true);
  };

  const choose = (account: ProfileBackendAccount) => {
    // The store refuses a switch to an account without its sign-in file; the
    // row says so and the menu stays open.
    if (!account.active && !account.health.available) return;
    close(true);
    if (!account.active && !busy) onSwitch(account.id);
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = rows();
    const at = all.findIndex((row) => row === document.activeElement);
    const step = (delta: 1 | -1) => {
      const next = at < 0 ? (delta > 0 ? 0 : all.length - 1) : (at + delta + all.length) % all.length;
      all[next]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        step(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        break;
      case "Home":
        event.preventDefault();
        all[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        all[all.length - 1]?.focus();
        break;
      // A menu is not walked with Tab: it closes, and the focus is back on
      // the trigger for the next Tab to leave from.
      case "Escape":
      case "Tab":
        event.preventDefault();
        close(true);
        break;
    }
  };

  return (
    <div className="acct-pick" ref={wrapRef}>
      <span className="flabel" id={`${ids}-label`}>
        Runs use
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="acct-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${ids}-menu` : undefined}
        // "Runs use work@example.com, Claude sign-in": the label and the
        // value, as the trigger shows them (WCAG 2.5.3).
        aria-labelledby={`${ids}-label ${ids}-value`}
        // Ruling 368: the switch in flight shows on its trigger; any other
        // request leaves the trigger waiting. Not `disabled`: a disabled
        // button drops the focus the menu has just handed back to it.
        aria-busy={switching ? true : undefined}
        aria-disabled={busy && !switching ? true : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) openMenu();
          else (rows().find((row) => row.getAttribute("aria-checked") === "true") ?? rows()[0])?.focus();
        }}
      >
        {/* The spaces between the spans are the accessible names': a flex
            box draws none of them, and without them a name ran on into the
            line under it ("work@example.comClaude sign-in"). */}
        <span className="acct-txt" id={`${ids}-value`}>
          <span className="acct-nm" title={active.name}>
            {active.name}
          </span>{" "}
          <span className="acct-sub">
            {switching ? `Switching to ${switching.name}…` : accountKindWord(active.health)}
          </span>
        </span>
        {switching ? <Icon name="loader" className="spin" /> : <Icon name="chevron" className="caret" />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={`${ids}-menu`}
          className="rsel-menu acct-menu"
          role="menu"
          aria-labelledby={`${ids}-head`}
          data-side={place?.side ?? "bottom"}
          style={place?.maxHeight ? { maxHeight: place.maxHeight } : undefined}
          onKeyDown={onMenuKeyDown}
        >
          <div className="acct-menu-head" id={`${ids}-head`}>
            <span className="flabel">{label} accounts</span>{" "}
            <span className="fine">
              {accounts.length} of {maxAccounts}
            </span>
          </div>
          {/* Only the accounts scroll: ten of them outgrow the menu, and the
              head and the actions under the rule stay where they are. */}
          <div className="acct-menu-list">
            {accounts.map((account) => {
              const on =
                account.health.connectedAt && utcDayKey(account.health.connectedAt)
                  ? account.health.connectedAt
                  : null;
              const unusable = !account.active && !account.health.available;
              return (
                <button
                  key={account.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={account.active}
                  aria-disabled={unusable || undefined}
                  tabIndex={-1}
                  className="rsel-item"
                  onClick={() => choose(account)}
                >
                  <span className="acct-txt">
                    <span className="acct-nm" title={account.name}>
                      {account.name}
                    </span>{" "}
                    <span className="acct-sub">
                      {accountKindWord(account.health)}
                      {account.active ? (
                        " · in use"
                      ) : on ? (
                        <>
                          {" "}· connected <LocalCalendarDate iso={on} />
                        </>
                      ) : null}
                      {account.health.available ? "" : " · sign-in file missing"}
                    </span>
                  </span>
                  {account.active ? <Icon name="check" className="acct-check" /> : null}
                </button>
              );
            })}
          </div>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            aria-disabled={atLimit || undefined}
            tabIndex={-1}
            className="menu-item"
            onClick={() => {
              if (atLimit) return;
              close(false);
              onAdd();
            }}
          >
            <Icon name="plus" />
            <span className="acct-txt">
              <span>Add another {label} account</span>{" "}
              {atLimit ? (
                <span className="acct-sub">
                  {maxAccounts} is the most one person can keep; disconnect one to add another.
                </span>
              ) : null}
            </span>
          </button>
          {onManage ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
                close(false);
                onManage();
              }}
            >
              <Icon name="sliders" />
              Manage other accounts
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
