/**
 * Pure resolution of a finished board drag into the governed reorder action —
 * or null when nothing should be submitted. Framework-free so the no-op and
 * stale-state rules are unit-testable without a drag library.
 *
 * The server stays authoritative: this never reorders board state, it only
 * names the requested destination (`beforeKey` null = end of column).
 */

export interface BoardDropState {
  /** The card in flight. */
  dragKey: string;
  /** Stage the drag started from. */
  fromStage: string;
  /** Column under the pointer / keyboard target at drop (null = no target). */
  overStage: string | null;
  /** Requested slot: land immediately before this card (null = column end). */
  beforeKey: string | null;
  /** VISIBLE ordered keys per stage at drop time (current, not drag-start). */
  columns: { stageId: string; keys: string[] }[];
}

export function resolveBoardDrop(
  state: BoardDropState,
): { to: string; beforeKey: string | null } | null {
  const { dragKey, fromStage, overStage } = state;
  if (!overStage) return null;
  const column = state.columns.find((c) => c.stageId === overStage);
  if (!column) return null;

  // A slot that no longer exists in the target column (the board can change
  // under a drag via SSE revalidation) degrades to "end of column" rather
  // than submitting a reference the server can't place.
  let beforeKey = state.beforeKey;
  if (beforeKey !== null && beforeKey !== dragKey && !column.keys.includes(beforeKey)) {
    beforeKey = null;
  }

  if (overStage === fromStage) {
    const di = column.keys.indexOf(dragKey);
    const afterDragged = di >= 0 ? (column.keys[di + 1] ?? null) : null;
    // Dropped exactly where it already sits: before itself, before the card
    // that already follows it, or at the end while already last.
    if (beforeKey === dragKey || beforeKey === afterDragged) return null;
  } else if (beforeKey === dragKey) {
    // A cross-stage slot cannot reference the card itself.
    beforeKey = null;
  }

  return { to: overStage, beforeKey };
}
