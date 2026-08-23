import type { TaskPriority } from "~/schemas/task-file.schema";
import { Icon } from "./icon";
import { useHydrated } from "./local-time";
import { Pill, type PillKind } from "./pill";

/**
 * Shared renderers for the lightweight task metadata (priority, labels, due
 * date). The board card and the task hero both draw these, so the vocabulary
 * lives in ONE place — a `high` task looks the same on the board and on its own
 * page, the rule the readiness/validation pills already follow.
 *
 * Only NON-DEFAULT metadata renders: `priority: "normal"`, an empty label set,
 * and a null due date each draw nothing, so the common task keeps its density
 * and the flags mean something when they DO appear.
 */

const PRIORITY_DISPLAY = {
  low: { kind: "neutral", label: "low" },
  high: { kind: "info", label: "high" },
  urgent: { kind: "risk", label: "urgent" },
} satisfies Record<Exclude<TaskPriority, "normal">, { kind: PillKind; label: string }>;

/** A priority flag pill. `normal` renders nothing (it is the default). */
export function PriorityFlag({
  priority,
  sm,
}: {
  priority: TaskPriority;
  sm?: boolean;
}) {
  if (priority === "normal") return null;
  const d = PRIORITY_DISPLAY[priority];
  return (
    <Pill kind={d.kind} sm={sm}>
      <Icon name="flag" />
      {d.label}
    </Pill>
  );
}

/** Freeform label chips. Caps the visible set and folds the rest into a `+N`
 *  chip so a heavily-tagged card never blows out the column width. */
export function LabelChips({
  labels,
  max = 3,
}: {
  labels: readonly string[];
  max?: number;
}) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const extra = labels.length - shown.length;
  return (
    <>
      {shown.map((l) => (
        <span key={l} className="label-chip">
          {l}
        </span>
      ))}
      {extra > 0 && (
        <span className="label-chip more" title={labels.slice(max).join(", ")}>
          +{extra}
        </span>
      )}
    </>
  );
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `YYYY-MM-DD` → "Mon D" in a fixed, locale-independent vocabulary (the app
 *  never leaves English copy, and a locale-formatted date would drift between
 *  server render and client hydration). Falls back to the raw string. */
export function formatDueDate(due: string): string {
  const [y, m, d] = due.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return due;
  return `${MONTHS[m - 1]} ${d}`;
}

/** Today as a plain `YYYY-MM-DD` calendar date (local wall clock). */
export function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** A due date is overdue when it is strictly before today. Plain `YYYY-MM-DD`
 *  strings sort lexically the same as chronologically, so a string compare is
 *  the whole test. */
export function isOverdue(dueDate: string | null, today: string): boolean {
  return dueDate != null && dueDate < today;
}

/** A due-date pill. Overdue → `blocked` (red) with the word "overdue" so the
 *  state does not rely on colour alone; otherwise a neutral "due Mon D".
 *
 *  "Overdue" depends on the VIEWER's local today, which the server does not
 *  know — rendering it during SSR would hydrate to different text across a
 *  timezone/midnight boundary (the recoverable React #418 `LocalDayDotTime`
 *  guards against). So unless an explicit `today` is passed (tests, or a caller
 *  that already has a deterministic date), the overdue branch is withheld until
 *  after hydration: first paint is the neutral "due Mon D" on both sides, and an
 *  effect swaps in the red "overdue" once the client's date is known. */
export function DueDatePill({
  dueDate,
  today,
  sm,
}: {
  dueDate: string | null;
  today?: string;
  sm?: boolean;
}) {
  const hydrated = useHydrated();
  if (!dueDate) return null;
  const effectiveToday = today ?? (hydrated ? todayISO() : null);
  const overdue = effectiveToday != null && isOverdue(dueDate, effectiveToday);
  return (
    <Pill kind={overdue ? "blocked" : "neutral"} sm={sm}>
      <Icon name="clock" />
      {overdue ? `overdue · ${formatDueDate(dueDate)}` : `due ${formatDueDate(dueDate)}`}
    </Pill>
  );
}

/** True when a task carries any non-default metadata worth a dedicated row. */
export function hasVisibleMeta(task: {
  priority: TaskPriority;
  labels: readonly string[];
  dueDate: string | null;
}): boolean {
  return (
    task.priority !== "normal" || task.labels.length > 0 || task.dueDate != null
  );
}
