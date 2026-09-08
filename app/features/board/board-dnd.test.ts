import { describe, expect, it } from "vitest";
import { laneAt, resolveBoardDrop, slotInLane, type BoardDropState, type LaneBlock } from "./board-dnd";

const COLUMNS = [
  { stageId: "todo", keys: ["A", "B"] },
  { stageId: "doing", keys: ["C", "D"] },
  { stageId: "done", keys: [] },
];

function drop(patch: Partial<BoardDropState>): ReturnType<typeof resolveBoardDrop> {
  return resolveBoardDrop({
    dragKey: "A",
    fromStage: "todo",
    overStage: "todo",
    beforeKey: null,
    columns: COLUMNS,
    ...patch,
  });
}

describe("resolveBoardDrop", () => {
  it("same-stage reorder before another card submits that slot", () => {
    expect(drop({ dragKey: "B", beforeKey: "A" })).toEqual({
      to: "todo",
      beforeKey: "A",
    });
  });

  it("same-stage move to end submits with a null slot", () => {
    expect(drop({ dragKey: "A", beforeKey: null })).toEqual({
      to: "todo",
      beforeKey: null,
    });
  });

  it("dropping before itself is a no-op", () => {
    expect(drop({ beforeKey: "A" })).toBeNull();
  });

  it("dropping before the card that already follows it is a no-op", () => {
    expect(drop({ beforeKey: "B" })).toBeNull();
  });

  it("dropping at the end while already last is a no-op", () => {
    expect(drop({ dragKey: "B", beforeKey: null })).toBeNull();
  });

  it("cross-stage move before a card submits that slot", () => {
    expect(drop({ overStage: "doing", beforeKey: "D" })).toEqual({
      to: "doing",
      beforeKey: "D",
    });
  });

  it("cross-stage move to the column end submits a null slot", () => {
    expect(drop({ overStage: "doing", beforeKey: null })).toEqual({
      to: "doing",
      beforeKey: null,
    });
  });

  it("an empty column is a valid target", () => {
    expect(drop({ overStage: "done" })).toEqual({ to: "done", beforeKey: null });
  });

  it("no target means no submit", () => {
    expect(drop({ overStage: null })).toBeNull();
  });

  it("an unknown stage means no submit", () => {
    expect(drop({ overStage: "ghost" })).toBeNull();
  });

  it("a slot that left the target column degrades to the column end", () => {
    // SSE revalidation can move cards mid-drag; a vanished beforeKey must not
    // reach the server.
    expect(drop({ overStage: "doing", beforeKey: "Z" })).toEqual({
      to: "doing",
      beforeKey: null,
    });
  });

  it("a stale same-stage slot degrades and still no-ops when that lands in place", () => {
    // A (first card) dropped at a vanished slot in its own column → end; that
    // is a real move for A (it is not last), so it submits.
    expect(drop({ beforeKey: "Z" })).toEqual({ to: "todo", beforeKey: null });
    // B (last card) dropped at a vanished slot in its own column → end → no-op.
    expect(drop({ dragKey: "B", beforeKey: "Z" })).toBeNull();
  });

  it("a cross-stage slot referencing the dragged card itself degrades to the end", () => {
    expect(drop({ overStage: "doing", beforeKey: "A" })).toEqual({
      to: "doing",
      beforeKey: null,
    });
  });
});

describe("laneAt", () => {
  const LANES = [
    { stageId: "todo", left: 0, right: 200, top: 100, bottom: 900 },
    { stageId: "doing", left: 216, right: 416, top: 100, bottom: 900 },
  ];
  it("names the lane under the pointer", () => {
    expect(laneAt(LANES, 50, 400)).toBe("todo");
    expect(laneAt(LANES, 300, 400)).toBe("doing");
  });
  it("in the gutter, picks the nearer lane", () => {
    expect(laneAt(LANES, 205, 400)).toBe("todo");
    expect(laneAt(LANES, 212, 400)).toBe("doing");
  });
  it("just outside the outer lanes still counts, further out does not", () => {
    expect(laneAt(LANES, -20, 400)).toBe("todo");
    expect(laneAt(LANES, -30, 400)).toBeNull();
    expect(laneAt(LANES, 300, 920)).toBe("doing");
    expect(laneAt(LANES, 300, 930)).toBeNull();
    expect(laneAt(LANES, 300, 80)).toBe("doing");
  });
  it("no lanes, no target", () => {
    expect(laneAt([], 50, 400)).toBeNull();
  });
});

describe("slotInLane", () => {
  const GAP = 12;
  type Card = { key: string; height: number };
  /** Lay the lane out top to bottom with the drop preview (`previewBefore`:
   *  undefined = no preview, null = at the end) inserted the way `Column` does. */
  function layout(
    cards: Card[],
    preview: { height: number; before: string | null } | undefined,
    top = 100,
  ): LaneBlock[] {
    const blocks: LaneBlock[] = [];
    let y = top;
    const push = (key: string | null, height: number) => {
      blocks.push({ key, top: y, bottom: y + height });
      y += height + GAP;
    };
    for (const c of cards) {
      if (preview && preview.before === c.key) push(null, preview.height);
      push(c.key, c.height);
    }
    if (preview && preview.before === null) push(null, preview.height);
    return blocks;
  }
  const CARDS: Card[] = [
    { key: "A", height: 196 },
    { key: "B", height: 290 },
    { key: "C", height: 148 },
    { key: "D", height: 219 },
  ];

  it("a card's top half asks for the slot before it, its bottom half for the slot after", () => {
    const lane = layout(CARDS, undefined);
    expect(slotInLane(lane, 100 + 10)).toBe("A");
    expect(slotInLane(lane, 100 + 97)).toBe("A");
    expect(slotInLane(lane, 100 + 99)).toBe("B");
    expect(slotInLane(lane, 100 + 195)).toBe("B");
  });
  it("the gap between two cards and the padding above the first belong to the card below", () => {
    const lane = layout(CARDS, undefined);
    expect(slotInLane(lane, 100 + 196 + 5)).toBe("B");
    expect(slotInLane(lane, 80)).toBe("A");
  });
  it("below the last card is the end; an empty lane is the end", () => {
    const lane = layout(CARDS, undefined);
    expect(slotInLane(lane, lane[lane.length - 1].bottom + 30)).toBeNull();
    expect(slotInLane([], 400)).toBeNull();
  });
  it("over the preview, the slot is the one the preview stands in", () => {
    const above = layout(CARDS, { height: 196, before: "B" });
    const preview = above.find((b) => b.key === null)!;
    expect(slotInLane(above, preview.top + 5)).toBe("B");
    expect(slotInLane(above, preview.bottom - 5)).toBe("B");
    const atEnd = layout(CARDS, { height: 196, before: null });
    const tail = atEnd[atEnd.length - 1];
    expect(tail.key).toBeNull();
    expect(slotInLane(atEnd, tail.top + 50)).toBeNull();
  });
  it("the dragged card's own hole is a card: its halves name no-op slots", () => {
    // B is in flight; its hole stands where B was, keyed B (`resolveBoardDrop`
    // turns "before B" and "before C" into no submit).
    const lane = layout(CARDS, undefined);
    const hole = lane.find((b) => b.key === "B")!;
    expect(slotInLane(lane, hole.top + 10)).toBe("B");
    expect(slotInLane(lane, hole.bottom - 10)).toBe("C");
  });

  it("every answer is a fixed point of the layout it causes (no oscillation), for any pointer, preview and grab", () => {
    // The loop the owner saw: slot → preview drawn → cards move → new slot →
    // preview redrawn → … A rule is stable iff re-reading the lane it just
    // produced asks for the same slot, for every pointer position, every
    // starting preview position and every preview height.
    const previewHeights = [60, 148, 196, 290, 420];
    const startingSlots: (string | null | undefined)[] = [undefined, ...CARDS.map((c) => c.key), null];
    let checked = 0;
    for (const height of previewHeights) {
      for (const start of startingSlots) {
        const before = layout(CARDS, start === undefined ? undefined : { height, before: start });
        const bottom = before[before.length - 1].bottom + 60;
        for (let y = 60; y <= bottom; y += 1) {
          const slot = slotInLane(before, y);
          const after = layout(CARDS, { height, before: slot });
          expect(slotInLane(after, y), `height ${height}, start ${String(start)}, y ${y}`).toBe(slot);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("a slow sweep down the lane only ever moves the slot down, and back up only up", () => {
    const order = (slot: string | null) => (slot === null ? CARDS.length : CARDS.findIndex((c) => c.key === slot));
    for (const height of [148, 196, 290]) {
      let slot: string | null | undefined;
      let last = -1;
      const bottom = layout(CARDS, undefined)[CARDS.length - 1].bottom + 40;
      for (let y = 80; y <= bottom; y += 2) {
        const lane = layout(CARDS, slot === undefined ? undefined : { height, before: slot });
        slot = slotInLane(lane, y);
        expect(order(slot), `down: height ${height}, y ${y}`).toBeGreaterThanOrEqual(last);
        last = order(slot);
      }
      last = CARDS.length + 1;
      for (let y = bottom; y >= 80; y -= 2) {
        const lane = layout(CARDS, { height, before: slot ?? null });
        slot = slotInLane(lane, y);
        expect(order(slot), `up: height ${height}, y ${y}`).toBeLessThanOrEqual(last);
        last = order(slot);
      }
    }
  });
});
