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

/** One lane's live rectangle (viewport coordinates), for `laneAt`. */
export interface LaneRect {
  stageId: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The lane under the pointer — or, in the gutter between two, the nearer one
 * within `slack` px. Null when the pointer is off the lanes (no preview).
 *
 * The lane is read from the pointer, not from dnd-kit's collision target: that
 * target is whichever droppable the LIFTED CARD's rectangle happens to overlap
 * when the pointer itself is over nothing droppable, which near a lane edge is
 * a card in the neighbouring lane — and the preview would cross lanes with it.
 */
export function laneAt(
  lanes: readonly LaneRect[],
  x: number,
  y: number,
  slack = 24,
): string | null {
  let best: { stageId: string; distance: number } | null = null;
  for (const lane of lanes) {
    if (y < lane.top - slack || y > lane.bottom + slack) continue;
    const distance = x < lane.left ? lane.left - x : x > lane.right ? x - lane.right : 0;
    if (distance > slack) continue;
    if (!best || distance < best.distance) best = { stageId: lane.stageId, distance };
  }
  return best?.stageId ?? null;
}

/** One block in a lane's flow, top to bottom: a card (keyed — the dragged
 *  card's own hole included) or a keyless stand-in (the drop preview, the
 *  landing preview of a move in flight). */
export interface LaneBlock {
  key: string | null;
  top: number;
  bottom: number;
}

/**
 * The insertion slot a pointer at `y` asks for, read from the lane AS DRAWN —
 * preview included. Over a card, its top half means "before it" and its bottom
 * half "before the card after it"; anywhere else — the preview, a gap, the
 * padding — the slot is before the first card below the pointer, or the end
 * when there is none.
 *
 * Why the preview counts (owner, 2026-09-08: the preview "flickers between
 * upside and downside" of the card every 100 ms, upper half only): choosing
 * "before T" draws the preview above T and pushes T down from under the
 * pointer. A rule that knew only cards then asked dnd-kit what the pointer was
 * over, got the column, called that "end", moved the preview below T — and T
 * came back up under the pointer. Reading the preview as "the slot it stands
 * in" makes every answer a fixed point of its own layout: the layout it causes
 * asks for the same slot (see the property test). The bottom half never
 * looped because a preview below T moves nothing above it.
 */
export function slotInLane(blocks: readonly LaneBlock[], y: number): string | null {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (y >= block.bottom) continue;
    // Over a stand-in (or the gap above one): the first card below it.
    if (block.key === null) return nextCardKey(blocks, i + 1);
    // In the gap or padding above this card: before it.
    if (y < block.top) return block.key;
    return y < (block.top + block.bottom) / 2 ? block.key : nextCardKey(blocks, i + 1);
  }
  return null;
}

function nextCardKey(blocks: readonly LaneBlock[], from: number): string | null {
  for (let i = from; i < blocks.length; i++) {
    const key = blocks[i].key;
    if (key !== null) return key;
  }
  return null;
}
