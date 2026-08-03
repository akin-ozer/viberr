import { describe, expect, it } from "vitest";
import { resolveBoardDrop, type BoardDropState } from "./board-dnd";

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
