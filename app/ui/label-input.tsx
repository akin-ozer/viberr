import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { MAX_TASK_LABELS } from "~/schemas/task-file.schema";
import { Icon } from "./icon";
import {
  foldLabels,
  hasLabel,
  labelRows,
  normalizeLabel,
  type LabelRow,
} from "./label-input-derive";
import { useDismiss } from "./use-dismiss";

/**
 * A GitHub-style label multi-select. The field shows the chosen labels as chips
 * and, while focused, opens a checkbox list: the CHOSEN labels are pinned to the
 * top (checked — uncheck to remove), the project's other labels follow
 * (unchecked — check to add), filtered by what you type, and a "Create <label>"
 * row appears for a brand-new one. The list stays open across toggles so several
 * labels can be picked in a row. Type + Enter (or comma / blur) also commits a
 * new label directly; Backspace on the empty field removes the last chip.
 *
 * Labels are trimmed, whitespace-collapsed, de-duplicated case-insensitively,
 * and capped to match the server's `normalizeTaskLabels`, so the UI never builds
 * a set the server would silently trim. A polite live region announces changes.
 *
 * The list renders IN FLOW (not a portaled floating layer) for the same reason
 * the date-picker's calendar does: this input is used inside the New-task
 * `<dialog>`, which is transform-centered with `overflow: hidden`, so a
 * `position: fixed` popover mis-anchors and an absolute one is clipped. An
 * in-flow block lives in the scrollable modal body and is never clipped, and
 * behaves identically in the (non-dialog) Details panel.
 */

/** What ends a press (ruling 561): its click, which goes to where the press
 *  began and ended before any listener runs, so letting go there moves nothing
 *  it lands on; or the drop of a drag it started, which sends no click. */
const PRESS_ENDS = ["click", "dragend"] as const;

const LIST_ID = "label-select-list";
const rowId = (i: number) => `label-row-${i}`;

export function LabelInput({
  value,
  onChange,
  suggestions = [],
}: {
  value: string[];
  onChange: (labels: string[]) => void;
  /** Labels already used in this project, offered as autocomplete. */
  suggestions?: readonly string[];
}) {
  const [buffer, setBuffer] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const wrapRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));

  const query = normalizeLabel(buffer);
  const room = value.length < MAX_TASK_LABELS;
  // Interface review 2026-09-24 (writ-8): at the cap the refusal was a
  // screen-reader-only status and the typed label was cleared anyway, so a
  // sighted person saw it vanish as if saved. The same sentence is now shown
  // under the field before anything is refused, and a refused label stays in
  // the field.
  const capNote = `A task can have at most ${MAX_TASK_LABELS} labels. Remove one to add another.`;
  const capNoteId = useId();
  const rows = labelRows(value, suggestions, query, room);
  const showList = open && rows.length > 0;
  // `active` can dangle when rows shrink under it; treat out-of-range as none.
  const activeRow = active >= 0 && active < rows.length ? active : -1;

  // Scroll the list into view when it opens. This field is used inside the
  // New-task <dialog>, whose body scrolls under a pinned footer; without this,
  // a list opened near the bottom renders below the fold and behind the footer,
  // where its lower rows are unclickable. (Same reason the date-picker does it;
  // optional-chained so jsdom's missing `scrollIntoView` is a no-op.)
  useEffect(() => {
    if (showList) listRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [showList]);

  // Ruling 561: listening only while the list is shown or a label is half
  // typed: nothing else here moves.
  usePressHold(wrapRef, showList || query !== "");

  const announce = (next: string[], verb: "Added" | "Removed", label: string) => {
    setStatus(`${verb} label ${label}, ${next.length} of ${MAX_TASK_LABELS}`);
  };

  /** False only when the cap refused the label — the caller then keeps the
   *  typed text. A duplicate is already there as a chip, so it clears. */
  const addLabel = (raw: string): boolean => {
    const label = normalizeLabel(raw);
    if (!label) return true;
    if (hasLabel(value, label)) {
      setStatus("That label is already added");
      return true;
    }
    if (value.length >= MAX_TASK_LABELS) {
      setStatus(capNote);
      return false;
    }
    const next = [...value, label];
    onChange(next);
    announce(next, "Added", label);
    return true;
  };

  /** Fold one or more raw strings into the set in a SINGLE onChange — so a
   *  multi-item paste/comma-list doesn't stale-closure-overwrite itself.
   *  Returns the raw strings the cap refused, for the caller to keep. */
  const addLabels = (raws: readonly string[]): string[] => {
    const { next, added, dup, refused } = foldLabels(value, raws);
    if (added > 0) {
      onChange(next);
      // Inline plural, not `countLabel`: ruling 457 (shared/text/plural.ts).
      setStatus(`Added ${added} label${added > 1 ? "s" : ""}, ${next.length} of ${MAX_TASK_LABELS}`);
    } else if (refused.length > 0) {
      setStatus(capNote);
    } else if (dup) {
      setStatus("That label is already added");
    }
    return refused;
  };

  /** Enter / blur: commit the typed text. Whatever the cap refuses stays in the
   *  field — and text the comma path put back there is still comma-separated,
   *  so it splits the same way rather than landing as one "a, b" label. */
  const commitTyped = () => {
    if (buffer.includes(",")) setBuffer(addLabels(buffer.split(",")).join(","));
    else if (addLabel(query)) setBuffer("");
  };

  const removeLabel = (label: string) => {
    const next = value.filter((l) => l !== label);
    onChange(next);
    announce(next, "Removed", label);
  };

  /** A checkbox row was toggled (click or Enter): flip its membership and keep
   *  the list open + focused so several labels can be picked in one flow. */
  const toggleRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "selected") {
      removeLabel(row.value);
    } else {
      addLabel(row.value);
      setBuffer(""); // reset the filter so the fresh selection is easy to see
      setActive(-1);
    }
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && rows.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % rows.length);
    } else if (e.key === "ArrowUp" && rows.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a <= 0 ? rows.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showList && activeRow >= 0) toggleRow(activeRow);
      else if (query !== "") {
        commitTyped();
        setActive(-1);
      }
    } else if (e.key === "Escape" && showList) {
      // Consume Escape ONLY to close the list; a closed list lets Escape bubble
      // so the enclosing dialog can cancel on it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Backspace" && buffer === "" && value.length > 0) {
      e.preventDefault();
      removeLabel(value[value.length - 1]);
    }
  };

  const onChangeText = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.currentTarget.value;
    setOpen(true);
    setActive(-1);
    // A typed/pasted comma commits everything before the last comma at once.
    if (v.includes(",")) {
      const parts = v.split(",");
      const tail = parts.pop() ?? "";
      setBuffer([...addLabels(parts), tail].join(","));
    } else {
      setBuffer(v);
    }
  };

  return (
    <div className="label-combo" ref={wrapRef}>
      <div
        className="label-input"
        onMouseDown={(e) => {
          // Clicking the chrome (a chip or the gap) focuses the field and opens
          // the list, without stealing focus mid-interaction from the input.
          if (e.target !== inputRef.current) {
            e.preventDefault();
            inputRef.current?.focus();
            setOpen(true);
          }
        }}
      >
        {value.map((label) => (
          <span key={label} className="label-token">
            {label}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="label-input-field"
          role="combobox"
          aria-expanded={showList}
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeRow >= 0 ? rowId(activeRow) : undefined}
          value={buffer}
          onChange={onChangeText}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={(e) => {
            // Close only when focus actually leaves the combo for another
            // element. A press on a (non-focusable) list row blurs the input
            // with a null relatedTarget — that is a pick, not a leave, so the
            // list stays open and the multi-select flow continues. A real
            // outside press is caught by useDismiss instead. This is
            // deterministic (no dependence on mousedown/mouseup/blur ordering).
            const next = e.relatedTarget;
            if (next instanceof Node && !wrapRef.current?.contains(next)) {
              // Commit a half-typed label so it is not lost; one the cap
              // refuses stays in the field.
              if (query !== "") commitTyped();
              setOpen(false);
            }
          }}
          placeholder={value.length === 0 ? "Add a label" : ""}
          aria-label="Add a label"
          aria-describedby={room ? undefined : capNoteId}
        />
      </div>
      {!room && (
        <p className="fine" id={capNoteId}>
          {capNote}
        </p>
      )}
      {showList && (
        <LabelOptions
          rows={rows}
          activeRow={activeRow}
          listRef={listRef}
          onToggle={toggleRow}
          onHover={setActive}
        />
      )}
      <span className="vh" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}

/**
 * Ruling 561: a press that takes the focus out of the field lands on what it
 * pressed. The press folds the list (useDismiss, the blur) and commits a
 * half-typed label as it begins, and with the list went its height: the
 * Details editor's Save rose 128 px between the press and the release, so
 * the release landed on no button and the browser sent no click. While a
 * press outside is under way the combo keeps the height it had, and lets
 * go at the press's click. `shifts`: the list is shown or a label is half
 * typed. (Ruling 700(e), the split of `LabelInput`: its effect, unchanged,
 * called where it always ran.)
 */
function usePressHold(wrapRef: RefObject<HTMLDivElement | null>, shifts: boolean) {
  useEffect(() => {
    const combo = wrapRef.current;
    if (!shifts || !combo) return;
    const onPress = (event: MouseEvent) => {
      const target = event.target;
      // The inline height is the hold: one press at a time.
      if (event.button !== 0 || combo.style.height || !(target instanceof Element)) return;
      // A select opens its menu on the press itself, and the menu takes the
      // release: held, the combo would let go under an open menu, or never.
      if (combo.contains(target) || target.closest("select")) return;
      combo.style.height = `${combo.getBoundingClientRect().height}px`;
      const end = () => {
        for (const type of PRESS_ENDS) window.removeEventListener(type, end, true);
        combo.style.height = "";
      };
      for (const type of PRESS_ENDS) window.addEventListener(type, end, true);
    };
    // Capture on the window, so the height is taken before anything this
    // press sets off.
    window.addEventListener("mousedown", onPress, true);
    return () => window.removeEventListener("mousedown", onPress, true);
  }, [shifts, wrapRef]);
}

/** The open checkbox list (ruling 700(e), the split of `LabelInput`:
 *  hook-free, in the slot its `showList &&` held). */
function LabelOptions({
  rows,
  activeRow,
  listRef,
  onToggle,
  onHover,
}: {
  rows: LabelRow[];
  activeRow: number;
  listRef: RefObject<HTMLUListElement | null>;
  onToggle: (index: number) => void;
  onHover: (index: number) => void;
}) {
  return (
    <ul
      ref={listRef}
      className="label-select"
      id={LIST_ID}
      role="listbox"
      aria-multiselectable="true"
    >
      {rows.map((row, i) => (
        <li
          // Key by value (stable across a suggest<->selected transition) so a
          // toggled row is REORDERED, not unmounted — otherwise React detaches
          // it mid-click and the outside-press guard (which then sees a
          // detached target) would wrongly close the list.
          key={row.value}
          id={rowId(i)}
          role="option"
          aria-selected={row.kind === "selected"}
          className={"label-opt" + (row.kind === "create" ? " create" : "")}
          data-active={i === activeRow}
          // mousedown, not click: fire before the input's blur so focus is
          // never lost (preventDefault keeps it) and the list stays open.
          // stopPropagation so the press never reaches useDismiss's
          // document-level listener — adding a label re-renders the list, and
          // a detached target there reads as "outside" and dismisses.
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle(i);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {row.kind === "create" ? (
            <span className="lc-plus">
              <Icon name="plus" />
            </span>
          ) : (
            <span className="lc-check" data-checked={row.kind === "selected"}>
              <Icon name="check" />
            </span>
          )}
          <span className="label-opt-name">{row.value}</span>
          {row.kind === "create" && <span className="label-opt-hint">create</span>}
        </li>
      ))}
    </ul>
  );
}
