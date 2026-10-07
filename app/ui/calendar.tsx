import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";
import { fromISODate, toISODate } from "./iso-date";

/**
 * A dependency-free month calendar (the shadcn/react-day-picker model, rebuilt
 * in the app's own CSS). Works entirely in LOCAL-MIDNIGHT dates and plain
 * `YYYY-MM-DD` strings — it never touches time-of-day, never calls
 * `toISOString()`, and never does `new Date("YYYY-MM-DD")` (that parses as UTC
 * and rolls the day backward west of UTC). That invariant is what keeps a
 * calendar date timezone-safe.
 *
 * Fixed 6×7 grid so the popover never resizes month to month; roving-tabindex
 * keyboard nav; `role="grid"` with full per-day aria-labels.
 */

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Full accessible label for a day button, e.g. "Sunday, August 23, 2026". */
function dayLabel(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS_LONG[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function Calendar({
  selected,
  onSelect,
  today,
}: {
  /** `YYYY-MM-DD` or null. */
  selected: string | null;
  onSelect: (iso: string) => void;
  /** `YYYY-MM-DD` override for "today" (tests/determinism). Defaults to now. */
  today?: string;
}) {
  const todayDate = fromISODate(today ?? null) ?? new Date();
  const selectedDate = fromISODate(selected);
  const [month, setMonth] = useState<Date>(() =>
    startOfMonth(selectedDate ?? todayDate),
  );
  const [focused, setFocused] = useState<Date>(() => selectedDate ?? todayDate);
  const gridRef = useRef<HTMLTableElement>(null);

  // Move DOM focus to the roving day whenever it changes — this is both the
  // "focus into the grid on open" move and the arrow-key follow.
  useEffect(() => {
    const el = gridRef.current?.querySelector<HTMLButtonElement>(
      `button[data-iso="${toISODate(focused)}"]`,
    );
    el?.focus();
  }, [focused, month]);

  /** Move the roving focus by N days, pulling the visible month along. */
  const moveFocus = (deltaDays: number) => {
    const next = new Date(
      focused.getFullYear(),
      focused.getMonth(),
      focused.getDate() + deltaDays,
    );
    setFocused(next);
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) {
      setMonth(startOfMonth(next));
    }
  };

  /** Jump the visible month by N, keeping the focused day-of-month (clamped). */
  const gotoMonth = (deltaMonths: number) => {
    const first = new Date(month.getFullYear(), month.getMonth() + deltaMonths, 1);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    setMonth(first);
    setFocused(
      new Date(first.getFullYear(), first.getMonth(), Math.min(focused.getDate(), lastDay)),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowRight": e.preventDefault(); moveFocus(1); break;
      case "ArrowLeft": e.preventDefault(); moveFocus(-1); break;
      case "ArrowDown": e.preventDefault(); moveFocus(7); break;
      case "ArrowUp": e.preventDefault(); moveFocus(-7); break;
      case "Home": e.preventDefault(); moveFocus(-focused.getDay()); break;
      case "End": e.preventDefault(); moveFocus(6 - focused.getDay()); break;
      case "PageUp": e.preventDefault(); gotoMonth(-1); break;
      case "PageDown": e.preventDefault(); gotoMonth(1); break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(toISODate(focused));
        break;
      default:
        break;
    }
  };

  // Build the fixed 6×7 grid. `new Date(y, m, d)` normalizes overflow, so day
  // arithmetic rolls months/years safely (DST- and length-safe).
  const startOffset = startOfMonth(month).getDay(); // week starts Sunday
  const gridStart = new Date(month.getFullYear(), month.getMonth(), 1 - startOffset);
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(
        new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + w * 7 + d),
      );
    }
    weeks.push(row);
  }

  const caption = `${MONTHS_LONG[month.getMonth()]} ${month.getFullYear()}`;

  return (
    <div className="cal">
      <div className="cal-head">
        <button
          type="button"
          className="cal-nav"
          aria-label="Go to previous month"
          onClick={() => gotoMonth(-1)}
        >
          <Icon name="chevron" className="cal-prev" />
        </button>
        <div className="cal-caption" aria-live="polite">
          {caption}
        </div>
        <button
          type="button"
          className="cal-nav"
          aria-label="Go to next month"
          onClick={() => gotoMonth(1)}
        >
          <Icon name="chevron" />
        </button>
      </div>
      <table
        className="cal-grid"
        role="grid"
        aria-label={caption}
        ref={gridRef}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {WEEKDAY_ABBR.map((abbr, i) => (
              <th key={abbr} scope="col" aria-label={WEEKDAYS[i]}>
                {abbr}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((row) => (
            <tr key={toISODate(row[0]!)}>
              {row.map((day) => {
                const iso = toISODate(day);
                const outside = day.getMonth() !== month.getMonth();
                const isToday = isSameDay(day, todayDate);
                const isSelected = selectedDate != null && isSameDay(day, selectedDate);
                const isFocused = isSameDay(day, focused);
                const cls = ["cal-day"];
                if (outside) cls.push("out");
                if (isToday) cls.push("today");
                if (isSelected) cls.push("sel");
                return (
                  // The selected state belongs to the cell: `gridcell` supports
                  // `aria-selected`, a `button` ignores it.
                  <td key={iso} role="gridcell" aria-selected={isSelected || undefined}>
                    <button
                      type="button"
                      className={cls.join(" ")}
                      data-iso={iso}
                      tabIndex={isFocused ? 0 : -1}
                      aria-label={dayLabel(day)}
                      onClick={() => onSelect(iso)}
                      onFocus={() => {
                        if (!isSameDay(day, focused)) setFocused(day);
                      }}
                    >
                      {day.getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
