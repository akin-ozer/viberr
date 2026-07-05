import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import {
  detectMentionToken,
  filterMentions,
  flattenMentionables,
  insertMention,
  type MentionSuggestion,
  type MentionToken,
} from "./mention-autocomplete";

/**
 * Composer @-mention autocomplete controller. Owns the active-token state,
 * the filtered suggestion list, the active-row index, and the keyboard model;
 * the composer stays the single source of truth for the draft text via
 * `value` / `setValue`.
 *
 * Keyboard (only while the menu is open):
 *   ArrowDown/ArrowUp move the active row (wrapping), Enter or Tab insert the
 *   active suggestion, Escape closes without inserting. ⌘/Ctrl+Enter is left
 *   for the composer (send) even while open. When the menu is closed the
 *   handler is a no-op so plain Enter/⌘↵ behave exactly as before.
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
  /** aria-activedescendant for the textarea, or undefined when closed. */
  activeId: string | undefined;
  /** Recompute the token from the textarea's current value + caret. */
  refresh: () => void;
  /** Point the active row at `index` (hover). */
  setActive: (index: number) => void;
  /** Insert a specific suggestion (click / programmatic). */
  pick: (s: MentionSuggestion) => void;
  /** Keydown handler for the textarea; returns true when it consumed the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Close without inserting (blur / outside). */
  close: () => void;
}

export function useMentionAutocomplete(
  mentionables: Mentionables,
  taRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  setValue: (next: string) => void,
): MentionAutocomplete {
  const all = useMemo(() => flattenMentionables(mentionables), [mentionables]);
  const [token, setToken] = useState<MentionToken | null>(null);
  const [active, setActiveIndex] = useState(0);
  const listId = useRef(
    "mention-list-" + Math.random().toString(36).slice(2, 8),
  ).current;

  const items = useMemo(
    () => (token ? filterMentions(all, token.query, MAX_SUGGESTIONS) : []),
    [all, token],
  );
  const open = token !== null && items.length > 0;

  const refresh = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const next = detectMentionToken(ta.value, ta.selectionStart ?? 0);
    setToken(next);
    setActiveIndex(0);
  }, [taRef]);

  const close = useCallback(() => {
    setToken(null);
    setActiveIndex(0);
  }, []);

  const pick = useCallback(
    (s: MentionSuggestion) => {
      if (!token) return;
      const { text, caret } = insertMention(value, token, s.handle);
      setValue(text);
      close();
      // Restore focus + caret after the controlled re-render.
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    },
    [token, value, setValue, close, taRef],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      // ⌘/Ctrl+Enter always belongs to the composer (send) — never intercept.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return false;
      if (!open) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % items.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        case "Enter":
        case "Tab": {
          e.preventDefault();
          const s = items[active];
          if (s) pick(s);
          return true;
        }
        case "Escape":
          e.preventDefault();
          close();
          return true;
        default:
          return false;
      }
    },
    [open, items, active, pick, close],
  );

  return {
    open,
    items,
    active,
    query: token?.query ?? "",
    listId,
    activeId: open ? `${listId}-opt-${active}` : undefined,
    refresh,
    setActive: setActiveIndex,
    pick,
    onKeyDown,
    close,
  };
}
