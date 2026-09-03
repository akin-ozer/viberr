import { useCallback, useMemo, useRef, useState } from "react";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TaskRunPrincipalView } from "./run-principal-view";
import {
  detectMentionToken,
  filterMentions,
  flattenMentionables,
  insertMention,
  type InsertResult,
  type MentionSuggestion,
  type MentionToken,
} from "./mention-autocomplete";

/**
 * Composer @-mention autocomplete controller. Owns the active-token state,
 * the filtered suggestion list, and the active-row index. The editing surface
 * feeds it snapshots (`refreshFrom(text, caret)`) and receives insertions
 * through `applyInsert` — the controller never touches the DOM, so the same
 * model drives any editor (it grew up on a textarea, it now drives Lexical).
 *
 * Keyboard is owned by the composer (Lexical key commands): ArrowUp/Down →
 * `moveActive`, Enter/Tab → `pickActive`, Escape → `close`. ⌘/Ctrl+Enter is
 * always the composer's send, never the menu's.
 */

const MAX_SUGGESTIONS = 8;

export interface MentionAutocomplete {
  /** True when the dropdown should render. */
  open: boolean;
  /** The capped, filtered suggestions for the current token. */
  items: MentionSuggestion[];
  /** Index of the highlighted row. */
  active: number;
  /** The current token query (for highlighting). */
  query: string;
  /** Stable listbox id (aria-controls). */
  listId: string;
  /** aria-activedescendant for the input, or undefined when closed. */
  activeId: string | undefined;
  /** Recompute the token from the surface's current text + caret
   *  (`caret: null` = no collapsed caret → close). */
  refreshFrom: (text: string, caret: number | null) => void;
  /** Point the active row at `index` (hover). */
  setActive: (index: number) => void;
  /** Move the active row by `delta`, wrapping. */
  moveActive: (delta: number) => void;
  /** Insert a specific suggestion (click / programmatic). */
  pick: (s: MentionSuggestion) => void;
  /** Insert the active suggestion; false when there is none. */
  pickActive: () => boolean;
  /** Close without inserting (blur / Escape / outside). */
  close: () => void;
}

export function useMentionAutocomplete(
  mentionables: Mentionables,
  applyInsert: (result: InsertResult) => void,
  /** Ruling 127: the task's run principal, so the `@claude` / `@codex` rows can
   *  say whose account they would bill and whether it can pay. */
  runPrincipal?: TaskRunPrincipalView | null,
): MentionAutocomplete {
  const all = useMemo(
    () => flattenMentionables(mentionables, runPrincipal),
    [mentionables, runPrincipal],
  );
  const [token, setToken] = useState<MentionToken | null>(null);
  const [active, setActiveIndex] = useState(0);
  /** The surface text the current token was detected in — what `pick` edits. */
  const lastText = useRef("");
  // Identity of the token the active row currently points into: the highlight
  // must NOT reset while the token is unchanged (caret-only refreshes), only
  // when a new @-token appears or its query changes.
  const tokenKeyRef = useRef<string | null>(null);
  const listId = useRef(
    "mention-list-" + Math.random().toString(36).slice(2, 8),
  ).current;

  const items = useMemo(
    () => (token ? filterMentions(all, token.query, MAX_SUGGESTIONS) : []),
    [all, token],
  );
  const open = token !== null && items.length > 0;

  const refreshFrom = useCallback((text: string, caret: number | null) => {
    lastText.current = text;
    const next = caret === null ? null : detectMentionToken(text, caret);
    const key = next ? `${next.start}:${next.query}` : null;
    if (key !== tokenKeyRef.current) {
      tokenKeyRef.current = key;
      setActiveIndex(0);
    }
    setToken(next);
  }, []);

  const close = useCallback(() => {
    tokenKeyRef.current = null;
    setToken(null);
    setActiveIndex(0);
  }, []);

  const pick = useCallback(
    (s: MentionSuggestion) => {
      if (!token) return;
      // Insert the display NAME (not the lowercased handle) so the mention
      // reads with the real name and highlights as one chip.
      applyInsert(insertMention(lastText.current, token, s.name));
      close();
    },
    [token, applyInsert, close],
  );

  const moveActive = useCallback(
    (delta: number) => {
      setActiveIndex((i) =>
        items.length === 0 ? 0 : (i + delta + items.length) % items.length,
      );
    },
    [items.length],
  );

  const pickActive = useCallback((): boolean => {
    const s = items[active];
    if (!s) return false;
    pick(s);
    return true;
  }, [items, active, pick]);

  return {
    open,
    items,
    active,
    query: token?.query ?? "",
    listId,
    activeId: open ? `${listId}-opt-${active}` : undefined,
    refreshFrom,
    setActive: setActiveIndex,
    moveActive,
    pick,
    pickActive,
    close,
  };
}
