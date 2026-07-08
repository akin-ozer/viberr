import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icon";

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
  variant = "panel",
  align = "right",
}: {
  stages: StageOption[];
  currentStageId: string;
  onSelect: (stageId: string) => void;
  busy?: boolean;
  /** panel = full trigger (dot + name + caret); card = compact (dot + caret). */
  variant?: "panel" | "card";
  /** Which trigger edge the popover aligns to. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = stages.find((s) => s.id === currentStageId);

  // Pop the trigger when the stage actually CHANGES (not on first mount), so a
  // move made from this menu animates in place. Board cards remount into the new
  // column instead, so this is a no-op there (the card handles its own motion).
  const prevStage = useRef(currentStageId);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (prevStage.current === currentStageId) return;
    prevStage.current = currentStageId;
    setChanged(true);
    const t = setTimeout(() => setChanged(false), 450);
    return () => clearTimeout(t);
  }, [currentStageId]);

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(r.width, 190);
    const left = align === "right" ? r.right - width : r.left;
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

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onReflow = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    // capture:true so a scroll inside the column (not just window) closes it.
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open]);

  const pick = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    if (id !== currentStageId) onSelect(id);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`stage-menu-btn ${variant}${open ? " open" : ""}`}
        onClick={toggle}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change stage (currently ${current?.name ?? "unknown"})`}
        title="Change stage"
      >
        <span className={`sm-current${changed ? " changed" : ""}`}>
          <span className="col-stage-dot" style={{ background: current?.color }} />
          {variant === "panel" && (
            <span className="sm-name">{current?.name ?? "—"}</span>
          )}
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
