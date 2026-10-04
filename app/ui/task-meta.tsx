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

/** A priority flag pill, small. `normal` renders nothing (it is the default). */
export function PriorityFlag({ priority }: { priority: TaskPriority }) {
  if (priority === "normal") return null;
  const d = PRIORITY_DISPLAY[priority];
  return (
    // `low` is a description of the task; `high` and `urgent` are a claim on the
    // reader's attention. Only the latter two earn a fill (design pass
    // 2026-09-08) — a low-priority card used to shout as loudly as an urgent one.
    <Pill kind={d.kind} sm quiet={priority === "low"}>
      <Icon name="flag" />
      {d.label}
    </Pill>
  );
}

/** Freeform label chips. Caps the visible set and folds the rest into a `+N`
 *  chip so a heavily-tagged card never blows out the column width.
 *
 *  The folded labels are named twice, because the two audiences need different
 *  things and `title` only serves one of them: `title` is the sighted pointer
 *  user's hover, and a `.vh` span is what actually reaches the accessibility
 *  tree. `title` on a role-less `<span>` is not a reliable accessible name —
 *  it is skipped outright by several screen readers and is unreachable by
 *  touch and by keyboard, so on its own it left "+2" announced as "+2" with the
 *  labels it stands for available to nobody. */
export function LabelChips({
  labels,
  max = 3,
}: {
  labels: readonly string[];
  max?: number;
}) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const hidden = labels.slice(max);
  return (
    <>
      {shown.map((l) => (
        <span key={l} className="label-chip">
          {l}
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="label-chip more" title={hidden.join(", ")}>
          +{hidden.length}
          <span className="vh">{hidden.join(", ")}</span>
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
function formatDueDate(due: string): string {
  const [y, m, d] = due.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return due;
  return `${MONTHS[m - 1]} ${d}`;
}

/** Today as a plain `YYYY-MM-DD` calendar date (local wall clock). */
function todayISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** A due date is overdue when it is strictly before today. Plain `YYYY-MM-DD`
 *  strings sort lexically the same as chronologically, so a string compare is
 *  the whole test. */
function isOverdue(dueDate: string | null, today: string): boolean {
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
}: {
  dueDate: string | null;
  today?: string;
}) {
  const hydrated = useHydrated();
  if (!dueDate) return null;
  const effectiveToday = today ?? (hydrated ? todayISO() : null);
  const overdue = effectiveToday != null && isOverdue(dueDate, effectiveToday);
  return (
    // A date that has not passed is a fact about the task; an overdue one is a
    // problem. Only the problem gets a fill (design pass 2026-09-08).
    <Pill kind={overdue ? "blocked" : "neutral"} sm quiet={!overdue}>
      <Icon name="clock" />
      {overdue ? `overdue · ${formatDueDate(dueDate)}` : `due ${formatDueDate(dueDate)}`}
    </Pill>
  );
}
