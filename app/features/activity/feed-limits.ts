/**
 * Activity feed pagination bounds (Phase 10): both panels serve a bounded
 * newest-first slice; "Show older" raises the `?stream=` / `?audit=` URL
 * params by one step (the task-detail `?events=` pattern). Hard ceilings
 * keep a hostile param from dumping the whole table.
 */

export const STREAM_STEP = 200;
export const AUDIT_STEP = 60;
export const STREAM_MAX = STREAM_STEP * 10;
export const AUDIT_MAX = AUDIT_STEP * 10;

/** Sanitizes a limit param: step-aligned, bounded, tolerant of junk. */
export function clampFeedLimit(
  raw: string | null,
  step: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return step;
  return Math.min(Math.max(step, Math.ceil(parsed / step) * step), max);
}
