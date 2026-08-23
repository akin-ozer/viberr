import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, fromISODate } from "./calendar";
import { Icon } from "./icon";
import { useDismiss } from "./use-dismiss";

/**
 * A calendar date-picker: a trigger button showing the selected date (or a
 * placeholder) that opens a portaled calendar popover; picking a day sets the
 * value and closes. Emits/accepts a plain `YYYY-MM-DD` string (or null). The
 * popover mirrors StageMenu — `useDismiss` for outside-press/Escape/reflow, a
 * fixed-position portal measured from the trigger rect.
 */

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** `YYYY-MM-DD` → "Aug 30, 2026" in a fixed (locale-independent) vocabulary. */
function displayDate(iso: string): string {
  const d = fromISODate(iso);
  if (!d) return iso;
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function DatePicker({
  value,
  onChange,
  id,
  placeholder = "Pick a date",
}: {
  /** `YYYY-MM-DD` or null. */
  value: string | null;
  onChange: (iso: string | null) => void;
  id?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useDismiss<HTMLDivElement>(open, () => setOpen(false), {
    onReflow: true,
    also: [btnRef],
  });

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 268);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    // Open downward by default; flip above the trigger when the calendar (a
    // fixed ~300px block) would spill past the viewport bottom and there is room
    // above (the Due-date field sits mid-modal).
    const estHeight = 300;
    const below = r.bottom + 6;
    const flipUp = below + estHeight > window.innerHeight - 8 && r.top - estHeight > 8;
    const top = flipUp ? r.top - 6 - estHeight : below;
    setPos({ top, left, width });
  };
  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!open) place();
    setOpen((o) => !o);
  };
  const select = (iso: string) => {
    onChange(iso);
    setOpen(false);
    btnRef.current?.focus();
  };

  // When the trigger sits inside a top-layer <dialog> (the New-task modal uses
  // showModal()), a popover portaled to document.body renders BEHIND the
  // dialog's top layer. Portal into the dialog instead so it shares that layer;
  // position:fixed keeps it viewport-anchored (never clipped by the dialog's
  // own overflow). Falls back to document.body outside a dialog (the Details
  // panel). Computed while `open` (the trigger is mounted, so `closest` works).
  const portalTarget = btnRef.current?.closest("dialog") ?? document.body;

  return (
    <div className="datepick">
      <button
        type="button"
        ref={btnRef}
        id={id}
        className={"datepick-trigger" + (value ? "" : " dp-empty")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon name="clock" />
        <span className="datepick-value">{value ? displayDate(value) : placeholder}</span>
      </button>
      {value && (
        <button
          type="button"
          className="datepick-clear"
          aria-label="Clear date"
          onClick={() => onChange(null)}
        >
          <Icon name="x" />
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="datepick-pop"
            style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
            // The popover's own presses must not bubble to a card/row behind it.
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                btnRef.current?.focus();
              }
            }}
          >
            <Calendar selected={value} onSelect={select} />
          </div>,
          portalTarget,
        )}
    </div>
  );
}
