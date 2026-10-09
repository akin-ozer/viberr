import { useLayoutEffect, useMemo, useRef } from "react";

/**
 * Ruling 11: structural sharing for rows that arrive from a loader.
 *
 * Every revalidation decodes a brand-new object for every row (single-fetch has
 * no memory of the last answer), so a list of memoised rows re-rendered every
 * row on every live update even when one row, or none, had changed. These keep
 * the object the page already holds for every row whose content is unchanged,
 * matched by the row's key, and the array itself when no row changed at all.
 * A memoised row then re-renders only when its own data did.
 */

/** Loader data: the shapes single-fetch hands a page. */
type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Json[]
  | { readonly [field: string]: Json };

function isRecord(value: Json): value is { readonly [field: string]: Json } {
  if (value === null || value === undefined || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function equalJson(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => equalJson(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const fields = Object.keys(a);
  if (fields.length !== Object.keys(b).length) return false;
  return fields.every((f) => Object.hasOwn(b, f) && equalJson(a[f], b[f]));
}

/** Deep equality over loader data (plain objects, arrays and primitives). */
function sameRow<T>(a: T, b: T): boolean {
  // SAFETY: rows are loader data, which single-fetch decodes into plain
  // objects, arrays and primitives only; any other object compares by identity.
  return equalJson(a as Json, b as Json);
}

/**
 * `next`, with each row replaced by the row of `prev` that has the same key and
 * the same content; `prev` itself when every row was kept in the same order.
 */
function shareRows<T>(
  prev: T[],
  next: T[],
  keyOf: (row: T) => string,
): T[] {
  if (prev === next) return prev;
  const byKey = new Map(prev.map((row) => [keyOf(row), row]));
  let unchanged = prev.length === next.length;
  const out = next.map((row, i) => {
    const old = byKey.get(keyOf(row));
    const kept = old !== undefined && sameRow(old, row) ? old : row;
    if (kept !== prev[i]) unchanged = false;
    return kept;
  });
  return unchanged ? prev : out;
}

/**
 * One loader value (a directory, a lookup map, a list with no row keys),
 * kept as the object this component last committed while its content is the
 * same, so the memos and memoised children that depend on it hold still
 * across a revalidation.
 */
export function useStableValue<T>(value: T): T {
  const committed = useRef(value);
  const stable = useMemo(
    () => (sameRow(committed.current, value) ? committed.current : value),
    [value],
  );
  useLayoutEffect(() => {
    committed.current = stable;
  }, [stable]);
  return stable;
}

/**
 * The hook form: `rows`, shared against what this component last committed.
 * `keyOf` must be stable (a module-level function).
 */
export function useStableRows<T>(
  rows: T[],
  keyOf: (row: T) => string,
): T[] {
  const committed = useRef(rows);
  const stable = useMemo(
    () => shareRows(committed.current, rows, keyOf),
    [rows, keyOf],
  );
  useLayoutEffect(() => {
    committed.current = stable;
  }, [stable]);
  return stable;
}
