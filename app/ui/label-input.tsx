import { useRef, useState } from "react";
import { MAX_LABEL_LENGTH, MAX_TASK_LABELS } from "~/schemas/task-file.schema";
import { Icon } from "./icon";
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

type Row =
  | { kind: "selected"; value: string }
  | { kind: "suggest"; value: string }
  | { kind: "create"; value: string };

export function LabelInput({
  value,
  onChange,
  suggestions = [],
  max = MAX_TASK_LABELS,
  maxLen = MAX_LABEL_LENGTH,
}: {
  value: string[];
  onChange: (labels: string[]) => void;
  /** Labels already used in this project, offered as autocomplete. */
  suggestions?: readonly string[];
  max?: number;
  maxLen?: number;
}) {
  const [buffer, setBuffer] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));

  const normalize = (raw: string) => raw.trim().replace(/\s+/g, " ").slice(0, maxLen);
  const has = (label: string) =>
    value.some((l) => l.toLowerCase() === label.toLowerCase());

  // Rows offered right now: the chosen labels pinned to the top (always shown, so
  // any of them can be unchecked), then the project's other labels filtered by
  // the query, then a "Create" row for genuinely-new typed text. Nothing can be
  // ADDED once the set is full, but the chosen rows stay so labels can be removed.
  const query = normalize(buffer);
  const q = query.toLowerCase();
  const room = value.length < max;
  const suggestRows: Row[] = room
    ? suggestions
        .filter((s) => !has(s) && (q === "" || s.toLowerCase().includes(q)))
        .map((s): Row => ({ kind: "suggest", value: s }))
    : [];
  const canCreate =
    room &&
    query !== "" &&
    !has(query) &&
    !suggestions.some((s) => s.toLowerCase() === q);
  const rows: Row[] = value.map((v): Row => ({ kind: "selected", value: v }));
  rows.push(...suggestRows);
  if (canCreate) rows.push({ kind: "create", value: query });
  const showList = open && rows.length > 0;
  // `active` can dangle when rows shrink under it; treat out-of-range as none.
  const activeRow = active >= 0 && active < rows.length ? active : -1;

  const announce = (next: string[], verb: "Added" | "Removed", label: string) => {
    setStatus(`${verb} label ${label}, ${next.length} of ${max}`);
  };

  const addLabel = (raw: string) => {
    const label = normalize(raw);
    if (!label) return;
    if (has(label)) {
      setStatus("That label is already added");
      return;
    }
    if (value.length >= max) {
      setStatus(`Maximum ${max} labels reached`);
      return;
    }
    const next = [...value, label];
    onChange(next);
    announce(next, "Added", label);
  };

  /** Fold one or more raw strings into the set in a SINGLE onChange — so a
   *  multi-item paste/comma-list doesn't stale-closure-overwrite itself. */
  const addLabels = (raws: readonly string[]) => {
    let next = value;
    let added = 0;
    let dup = false;
    let capped = false;
    for (const raw of raws) {
      const label = normalize(raw);
      if (!label) continue;
      if (next.length >= max) {
        capped = true;
        break;
      }
      if (next.some((l) => l.toLowerCase() === label.toLowerCase())) {
        dup = true;
        continue;
      }
      next = [...next, label];
      added += 1;
    }
    if (added > 0) {
      onChange(next);
      setStatus(`Added ${added} label${added > 1 ? "s" : ""}, ${next.length} of ${max}`);
    } else if (capped) {
      setStatus(`Maximum ${max} labels reached`);
    } else if (dup) {
      setStatus("That label is already added");
    }
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
        addLabel(query);
        setBuffer("");
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
      addLabels(parts);
      setBuffer(tail);
    } else {
      setBuffer(v);
    }
  };

  const listId = "label-select-list";
  const rowId = (i: number) => `label-row-${i}`;

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
          aria-controls={listId}
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
              if (query !== "") {
                addLabel(query); // commit a half-typed label so it is not lost
                setBuffer("");
              }
              setOpen(false);
            }
          }}
          placeholder={value.length === 0 ? "Add a label" : ""}
          aria-label="Add a label"
        />
      </div>
      {showList && (
        <ul className="label-select" id={listId} role="listbox" aria-multiselectable="true">
          {rows.map((row, i) => (
            <li
              key={row.kind + ":" + row.value}
              id={rowId(i)}
              role="option"
              aria-selected={row.kind === "selected"}
              className={"label-opt" + (row.kind === "create" ? " create" : "")}
              data-active={i === activeRow}
              // mousedown, not click: fire before the input's blur so focus is
              // never lost (preventDefault keeps it) and the list stays open.
              onMouseDown={(e) => {
                e.preventDefault();
                toggleRow(i);
              }}
              onMouseEnter={() => setActive(i)}
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
      )}
      <span className="vh" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
