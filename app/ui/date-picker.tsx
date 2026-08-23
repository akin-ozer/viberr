import { useEffect, useRef, useState } from "react";
import { Calendar, fromISODate } from "./calendar";
import { Icon } from "./icon";
import { useDismiss } from "./use-dismiss";

/**
 * A calendar date-picker: a trigger button showing the selected date (or a
 * placeholder) that reveals an in-flow calendar; picking a day sets the value
 * and closes. Emits/accepts a plain `YYYY-MM-DD` string (or null).
 *
 * The calendar is rendered IN FLOW (not a portaled floating popover) on purpose:
 * this component is used inside the New-task `<dialog>`, which is transform-
 * centered with `overflow: hidden` — a `position: fixed` popover anchors to the
 * transformed card (wrong coords) and an absolute one is clipped. An in-flow
 * block lives in the scrollable modal body, so it is never clipped or
 * mis-anchored, and works identically in the (non-dialog) Details panel.
 * `useDismiss` still closes it on an outside press or Escape.
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
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const wrapRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));

  // Scroll the calendar into view when it opens inside a scrollable modal body.
  // Optional-chained call: jsdom has no `scrollIntoView`, so it no-ops in tests.
  useEffect(() => {
    if (open) popRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  const close = () => {
    setOpen(false);
    btnRef.current?.focus();
  };
  const select = (iso: string) => {
    onChange(iso);
    close();
  };

  return (
    <div
      className="datepick"
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) close();
      }}
    >
      <div className="datepick-control">
        <button
          type="button"
          ref={btnRef}
          id={id}
          className={"datepick-trigger" + (value ? "" : " dp-empty")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="clock" />
          <span className="datepick-value">
            {value ? displayDate(value) : placeholder}
          </span>
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
      </div>
      {open && (
        <div className="datepick-pop" ref={popRef}>
          <Calendar selected={value} onSelect={select} />
        </div>
      )}
    </div>
  );
}
