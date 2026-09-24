// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sameRow, shareRows, useStableValue } from "./use-stable-rows";

/**
 * Ruling 454: structural sharing must never hand a page stale data. A row is
 * kept only when its content is equal in full, at any depth; anything else is
 * the new row, and the array is kept only when every row was.
 */

interface Row {
  key: string;
  title: string;
  labels: string[];
  pr: { number: number; state: string } | null;
  note?: string;
}

const keyOf = (r: Row) => r.key;

function row(key: string, patch: Partial<Row> = {}): Row {
  return { key, title: `Task ${key}`, labels: ["api"], pr: { number: 1, state: "open" }, ...patch };
}

describe("shareRows (ruling 454)", () => {
  it("keeps every object, and the array, when a fresh decode changed nothing", () => {
    const prev = [row("A"), row("B"), row("C")];
    const next = shareRows(prev, structuredClone(prev), keyOf);
    expect(next).toBe(prev);
  });

  it("replaces only the row whose content changed, however deep", () => {
    const prev = [row("A"), row("B"), row("C")];
    const decoded = structuredClone(prev);
    decoded[1]!.pr!.state = "merged";
    const next = shareRows(prev, decoded, keyOf);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toBe(decoded[1]);
    expect(next[1]!.pr!.state).toBe("merged");
    expect(next[2]).toBe(prev[2]);
  });

  it("matches rows by key, so a reorder keeps every object in its new place", () => {
    const prev = [row("A"), row("B"), row("C")];
    const decoded = structuredClone([prev[2]!, prev[0]!, prev[1]!]);
    const next = shareRows(prev, decoded, keyOf);
    expect(next).not.toBe(prev);
    expect(next.map((r) => r.key)).toEqual(["C", "A", "B"]);
    expect(next[0]).toBe(prev[2]);
    expect(next[1]).toBe(prev[0]);
    expect(next[2]).toBe(prev[1]);
  });

  it("takes an added row as it came and drops a removed one", () => {
    const prev = [row("A"), row("B")];
    const decoded = structuredClone([prev[0]!, row("D")]);
    const next = shareRows(prev, decoded, keyOf);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toBe(decoded[1]);
    expect(shareRows(prev, [structuredClone(prev[0]!)], keyOf)).toEqual([prev[0]]);
  });

  it("treats a field that appears or disappears as a change", () => {
    const prev = [row("A")];
    expect(shareRows(prev, [row("A", { note: "new" })], keyOf)[0]).not.toBe(prev[0]);
    const withNote = [row("A", { note: "x" })];
    expect(shareRows(withNote, [row("A")], keyOf)[0]).not.toBe(withNote[0]);
    expect(shareRows(prev, [row("A", { labels: ["api", "ui"] })], keyOf)[0]).not.toBe(prev[0]);
    expect(shareRows(prev, [row("A", { pr: null })], keyOf)[0]).not.toBe(prev[0]);
  });
});

describe("sameRow (ruling 454)", () => {
  it("compares loader data by content", () => {
    expect(sameRow({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null })).toBe(true);
    expect(sameRow({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
    expect(sameRow({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(sameRow({ a: undefined }, {})).toBe(false);
    expect(sameRow<Row["labels"] | Row["pr"]>([], null)).toBe(false);
  });
});

interface Directory {
  agents: { handle: string }[];
  users: string[];
}

describe("useStableValue (ruling 454)", () => {
  it("keeps the object it holds while the content is the same, takes a changed one", () => {
    const first: Directory = { agents: [{ handle: "dev" }], users: [] };
    const view = renderHook(({ value }) => useStableValue(value), {
      initialProps: { value: first },
    });
    expect(view.result.current).toBe(first);
    view.rerender({ value: structuredClone(first) });
    expect(view.result.current).toBe(first);
    const changed: Directory = { agents: [{ handle: "dev" }, { handle: "qa" }], users: [] };
    view.rerender({ value: changed });
    expect(view.result.current).toBe(changed);
    // ...and a copy of the changed one is held from then on.
    view.rerender({ value: structuredClone(changed) });
    expect(view.result.current).toBe(changed);
  });
});
