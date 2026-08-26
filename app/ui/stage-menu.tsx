import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
 * stacking. Closes on outside-click, Escape, or scroll/resize.
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
}: {
  stages: StageOption[];
  currentStageId: string;
  onSelect: (stageId: string) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
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
    setPos({ top: r.bottom + 6, left: clampedLeft, width });
  };

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
  // selectable stage), so Arrow/Home/End navigation has an anchor.
  useEffect(() => {
    if (!open || !pos) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button.sm-item:not([disabled])",
    );
    first?.focus();
  }, [open, pos]);

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

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`stage-menu-btn panel${open ? " open" : ""}`}
        onClick={toggle}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change stage (currently ${current?.name ?? "unknown"})`}
        title="Change stage"
      >
        <span key={currentStageId} className={`sm-current${changed ? " changed" : ""}`}>
          <span className="col-stage-dot" style={{ background: current?.color }} />
          <span className="sm-name">{current?.name ?? "−"}</span>
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
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              minWidth: pos.width,
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
                    style={{ background: s.color }}
                  />
                  <span className="sm-item-name">{s.name}</span>
                  {isCurrent && <Icon name="check" className="sm-check" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
