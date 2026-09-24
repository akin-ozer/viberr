import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { stageLabel } from "~/shared/workflow/stage-roles";
import { Icon } from "./icon";
import { useDismiss } from "./use-dismiss";

/**
 * StageMenu — a stage-change dropdown shared by the board card and the
 * task-detail "Current state" panel. Presentational: the trigger shows the
 * current stage (color dot + optional name + caret) and opens a popover of all
 * stages; picking a DIFFERENT stage calls `onSelect(stageId)`. The caller owns
 * the mutation (a route-action fetcher), so this stays route-agnostic.
 *
 * The popover is portaled to <body> and fixed-positioned from the trigger's
 * rect, so it never clips inside a scrolling column and ignores ancestor
 * stacking. The viewport still clips it, so it opens upward when there is no
 * room below (see the placement effect). Closes on outside-click, Escape, or
 * scroll/resize.
 *
 * `onReorder` adds "Move up" / "Move down" after the stages: the board card's
 * keyboard and single-pointer path to a slot within its lane, which the drag
 * alone offered. Task detail passes nothing.
 */

export interface StageOption {
  id: string;
  name: string;
  color: string;
}

export function StageMenu({
  stages,
  currentStageId,
  onSelect,
  busy = false,
  onReorder,
  canMoveUp = false,
  canMoveDown = false,
}: {
  stages: StageOption[];
  currentStageId: string;
  onSelect: (stageId: string) => void;
  busy?: boolean;
  /** Interface review 2026-09-24 (acce-17): -1 moves the task one slot up its
   *  lane, 1 one slot down. */
  onReorder?: (dir: -1 | 1) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // `side` is null until the placement effect has measured the open menu.
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    side: "top" | "bottom" | null;
    maxHeight?: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = stages.find((s) => s.id === currentStageId);

  // P16-UI-12: outside-press / Escape / reflow close, from the one shared hook
  // (`app/ui/use-dismiss.ts`) instead of a sixth hand-rolled copy of it.
  // `onReflow` because this popover is fixed-positioned from the trigger's rect
  // and a scroll inside the board column makes that rect a lie; `also: [btnRef]`
  // because the popover is portaled to <body>, so the trigger is NOT inside the
  // returned ref and a press on it would otherwise dismiss-then-reopen.
  // Escape-with-focus-return stays the caller's job — `onMenuKeyDown` below
  // owns it, because only the caller knows where focus should land.
  const menuRef = useDismiss<HTMLDivElement>(open, () => setOpen(false), {
    onReflow: true,
    also: [btnRef],
  });

  // Pop the trigger when the stage actually CHANGES (not on first mount), so a
  // move made from this menu animates in place. Board cards remount into the new
  // column instead, so this is a no-op there (the card handles its own motion).
  // `changed` derives from which stage the animation last settled on, so it
  // flips true in the same render as the stage change (no flag-resetting effect).
  // The .sm-current span is keyed on the stage id (below) so a second change
  // landing inside the 450ms window remounts it and the keyframe replays; a CSS
  // animation on an unchanged class-list is otherwise swallowed (same
  // key-remount trick the notification bell badge uses for the same pulse).
  const [settledStageId, setSettledStageId] = useState(currentStageId);
  const changed = settledStageId !== currentStageId;
  useEffect(() => {
    if (settledStageId === currentStageId) return;
    const t = setTimeout(() => setSettledStageId(currentStageId), 450);
    return () => clearTimeout(t);
  }, [settledStageId, currentStageId]);

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 190);
    const left = r.right - width;
    // Clamp into the viewport with an 8px gutter.
    const clampedLeft = Math.min(
      Math.max(8, left),
      window.innerWidth - width - 8,
    );
    setPos({ top: r.bottom + 6, left: clampedLeft, width, side: null });
  };

  // Interface review 2026-09-24 (layo-8): the menu always opened downward, so a
  // trigger near the viewport's bottom (the last list row on a 1440x900
  // desktop, every board card at 200% zoom) put stages off-screen, and the
  // scroll that would bring them back closes the menu. place() runs before the
  // portal mounts, so the height is read here, before paint: open upward when
  // the menu fits there and not below; when it fits on neither side, take the
  // roomier one, clamped into the viewport, and cap the height so the list
  // scrolls inside the menu instead.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const el = btnRef.current;
    if (!open || !pos || pos.side !== null || !menu || !el) return;
    const r = el.getBoundingClientRect();
    const h = menu.offsetHeight;
    const vh = window.innerHeight;
    const below = vh - 8 - (r.bottom + 6);
    const above = r.top - 6 - 8;
    if (h <= below) {
      setPos({ ...pos, side: "bottom" });
    } else if (h <= above) {
      setPos({ ...pos, top: r.top - 6 - h, side: "top" });
    } else if (above > below) {
      setPos({ ...pos, top: 8, side: "top", maxHeight: Math.min(r.top - 6, vh - 8) - 8 });
    } else {
      const top = Math.max(8, r.bottom + 6);
      setPos({ ...pos, top, side: "bottom", maxHeight: vh - 8 - top });
    }
  }, [open, pos, menuRef]);

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    if (!open) place();
    setOpen((o) => !o);
  };

  // F10-25: close the menu AND return focus to the trigger (keyboard users must
  // not be dumped at the top of the document after Escape / selection).
  const closeAndReturnFocus = () => {
    setOpen(false);
    btnRef.current?.focus();
  };

  // F10-25: move keyboard focus into the menu when it opens (the first
  // selectable stage), so Arrow/Home/End navigation has an anchor. Once the
  // placement effect has settled the side, so focus never lands on an item
  // still standing off-screen. The stages render before the Reorder group, so
  // this is a stage whenever one is selectable.
  useEffect(() => {
    if (!open || !pos?.side) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button.sm-item:not([disabled])",
    );
    first?.focus();
  }, [open, pos, menuRef]);

  // F10-25: the ARIA menu keyboard contract — roving focus with Arrow Up/Down
  // (wrapping), Home/End, and Escape. Enter/Space activate natively (real
  // <button>s). Operates on the enabled items only (the current stage is
  // disabled and skipped).
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button.sm-item:not([disabled])",
      ) ?? [],
    );
    if (items.length === 0) return;
    const idx = items.findIndex((el) => el === document.activeElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        items[(idx + 1 + items.length) % items.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "Escape":
        e.preventDefault();
        closeAndReturnFocus();
        break;
    }
  };

  const pick = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    closeAndReturnFocus();
    if (id !== currentStageId) onSelect(id);
  };

  const nudge = (e: React.MouseEvent, dir: -1 | 1) => {
    e.preventDefault();
    e.stopPropagation();
    closeAndReturnFocus();
    onReorder?.(dir);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        // `panel` used to ride along here, a leftover of a removed variant: the
        // generic `.panel` surface rule is later in the sheet at equal
        // specificity, so it overrode this trigger's own padding, radius and
        // shadow on every board card, list row and task page.
        className={`stage-menu-btn${open ? " open" : ""}`}
        onClick={toggle}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        // Ruling 148: a stage id the project no longer lists is stated in
        // words, the same words everywhere. The visible label was a "−" that
        // read as a cleared control while this name said "unknown", so the
        // accessible name did not even contain the visible one.
        aria-label={`Change stage (currently ${stageLabel(current)})`}
        title="Change stage"
      >
        <span key={currentStageId} className={`sm-current${changed ? " changed" : ""}`}>
          <span className="col-stage-dot" data-stage-color={current?.color} />
          <span className="sm-name">{stageLabel(current)}</span>
        </span>
        <Icon name="chevron" className="sm-caret" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="stage-menu-pop"
            role="menu"
            aria-label="Move to stage"
            data-side={pos.side ?? "bottom"}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              minWidth: pos.width,
              maxHeight: pos.maxHeight,
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onMenuKeyDown}
          >
            <div className="sm-head">Move to stage</div>
            {stages.map((s) => {
              const isCurrent = s.id === currentStageId;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  className={`sm-item${isCurrent ? " current" : ""}`}
                  onClick={(e) => pick(e, s.id)}
                  disabled={isCurrent}
                >
                  <span
                    className="col-stage-dot"
                    data-stage-color={s.color}
                  />
                  <span className="sm-item-name">{s.name}</span>
                  {isCurrent && <Icon name="check" className="sm-check" />}
                </button>
              );
            })}
            {/* Real `.sm-item` buttons, so the roving keys above walk them too.
                An edge the task cannot move past is disabled the way the
                current stage is. */}
            {onReorder && (
              <>
                <div className="sm-head">Reorder</div>
                <button
                  type="button"
                  role="menuitem"
                  className={`sm-item${canMoveUp ? "" : " current"}`}
                  onClick={(e) => nudge(e, -1)}
                  disabled={!canMoveUp}
                >
                  <span className="sm-item-name">Move up</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`sm-item${canMoveDown ? "" : " current"}`}
                  onClick={(e) => nudge(e, 1)}
                  disabled={!canMoveDown}
                >
                  <span className="sm-item-name">Move down</span>
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
