// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStableRows, useStableValue } from "./use-stable-rows";

/**
 * Ruling 11: structural sharing must never hand a page stale data. A row is
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

/** `useStableRows` across one revalidation: `prev` committed, then `decoded` arrives. */
function afterRevalidation(prev: Row[], decoded: Row[]): Row[] {
  const view = renderHook(({ rows }) => useStableRows(rows, keyOf), {
    initialProps: { rows: prev },
  });
  view.rerender({ rows: decoded });
  return view.result.current;
}

describe("useStableRows (ruling 11)", () => {
  it("keeps every object, and the array, when a fresh decode changed nothing", () => {
    const prev = [row("A"), row("B"), row("C")];
    expect(afterRevalidation(prev, structuredClone(prev))).toBe(prev);
  });

  it("replaces only the row whose content changed, however deep", () => {
    const prev = [row("A"), row("B"), row("C")];
    const decoded = structuredClone(prev);
    decoded[1]!.pr!.state = "merged";
    const next = afterRevalidation(prev, decoded);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toBe(decoded[1]);
    expect(next[1]!.pr!.state).toBe("merged");
    expect(next[2]).toBe(prev[2]);
  });

  it("matches rows by key, so a reorder keeps every object in its new place", () => {
    const prev = [row("A"), row("B"), row("C")];
    const next = afterRevalidation(prev, structuredClone([prev[2]!, prev[0]!, prev[1]!]));
    expect(next).not.toBe(prev);
    expect(next.map((r) => r.key)).toEqual(["C", "A", "B"]);
    expect(next[0]).toBe(prev[2]);
    expect(next[1]).toBe(prev[0]);
    expect(next[2]).toBe(prev[1]);
  });

  it("takes an added row as it came and drops a removed one", () => {
    const prev = [row("A"), row("B")];
    const decoded = structuredClone([prev[0]!, row("D")]);
    const next = afterRevalidation(prev, decoded);
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toBe(decoded[1]);
    expect(afterRevalidation(prev, [structuredClone(prev[0]!)])).toEqual([prev[0]]);
  });

  it("treats a field that appears or disappears as a change", () => {
    const prev = [row("A")];
    expect(afterRevalidation(prev, [row("A", { note: "new" })])[0]).not.toBe(prev[0]);
    const withNote = [row("A", { note: "x" })];
    expect(afterRevalidation(withNote, [row("A")])[0]).not.toBe(withNote[0]);
    expect(afterRevalidation(prev, [row("A", { labels: ["api", "ui"] })])[0]).not.toBe(prev[0]);
    expect(afterRevalidation(prev, [row("A", { pr: null })])[0]).not.toBe(prev[0]);
  });
});

/** A field that may be present-but-undefined or absent. */
interface Sparse {
  a?: undefined;
}

/** `useStableValue` across one revalidation: `first` committed, then `next` arrives. */
function held<T>(first: T, next: T): T {
  const view = renderHook(({ value }) => useStableValue(value), {
    initialProps: { value: first },
  });
  view.rerender({ value: next });
  return view.result.current;
}

describe("useStableValue compares loader data by content (ruling 11)", () => {
  it("holds an equal value, however deep, and takes any difference", () => {
    const first = { a: [1, { b: "x" }], c: null };
    expect(held(first, { a: [1, { b: "x" }], c: null })).toBe(first);
    const deeper = { a: [1, { b: "y" }] };
    expect(held({ a: [1, { b: "x" }] }, deeper)).toBe(deeper);
    const longer = { a: [1, 2, 3] };
    expect(held({ a: [1, 2] }, longer)).toBe(longer);
    const fewer: Sparse = {};
    expect(held<Sparse>({ a: undefined }, fewer)).toBe(fewer);
    expect(held<Row["labels"] | Row["pr"]>([], null)).toBeNull();
  });
});

interface Directory {
  agents: { handle: string }[];
  users: string[];
}

describe("useStableValue (ruling 11)", () => {
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
