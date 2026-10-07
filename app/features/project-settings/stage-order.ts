// Lives apart from settings-page.tsx so that file exports only components
// (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/**
 * Resolve a finished stage drag — or a Move-menu pick — into the ordered id
 * list the `reorder-stages` action takes, or null when nothing should be
 * submitted. Pure, so the pinning and no-op rules are unit-testable without a
 * drag library; the direct counterpart of `board-dnd.ts:resolveBoardDrop`.
 *
 * `beforeId` names the stage the moved one should land immediately BEFORE
 * (null = the end of the list), exactly like the board's `beforeKey`.
 */
export function resolveStageOrder(
  stages: readonly { id: string }[],
  moveId: string,
  beforeId: string | null,
): string[] | null {
  const ids = stages.map((s) => s.id);
  if (!ids.includes(moveId)) return null;
  if (beforeId === moveId) return null;
  const rest = ids.filter((id) => id !== moveId);
  // A target that vanished under the drag (the list can change via SSE
  // revalidation) degrades to the end rather than submitting a reference the
  // server cannot place.
  const found = beforeId === null ? -1 : rest.indexOf(beforeId);
  const insertAt = beforeId === null || found < 0 ? rest.length : found;
  const next = [...rest.slice(0, insertAt), moveId, ...rest.slice(insertAt)];
  // Entry stays first, terminal stays last — pinned by CURRENT identity, not by
  // literal id, mirroring what the server re-applies on top of whatever we send.
  const entryId = ids[0];
  const terminalId = ids.length > 1 ? ids[ids.length - 1] : undefined;
  const pinned = [
    ...(entryId === undefined ? [] : [entryId]),
    ...next.filter((id) => id !== entryId && id !== terminalId),
    ...(terminalId === undefined ? [] : [terminalId]),
  ];
  if (pinned.every((id, i) => id === ids[i])) return null;
  return pinned;
}

/** The stages a member may actually reorder: everything between the pinned
 *  entry and terminal stages. */
function movableStages<T extends { id: string }>(stages: readonly T[]): T[] {
  return stages.length > 2 ? stages.slice(1, -1) : [];
}

/**
 * Every reorder this row can perform, as `{label, beforeId}` pairs. Empty when
 * the row cannot move, which is what hides the Move control.
 */
export function stageMoveOptions(
  stages: readonly { id: string; name: string }[],
  stageId: string,
): { label: string; beforeId: string | null }[] {
  const movable = movableStages(stages);
  const i = movable.findIndex((s) => s.id === stageId);
  if (i < 0 || movable.length < 2) return [];
  const out: { label: string; beforeId: string | null }[] = [];
  if (i > 0) {
    out.push({ label: "Move earlier", beforeId: movable[i - 1]!.id });
    if (i > 1) out.push({ label: "Move to first", beforeId: movable[0]!.id });
  }
  if (i < movable.length - 1) {
    // Land after my current neighbour: before whatever follows it.
    out.push({ label: "Move later", beforeId: movable[i + 2]?.id ?? null });
    if (i < movable.length - 2) out.push({ label: "Move to last", beforeId: null });
  }
  return out;
}
