import { useRef, useState } from "react";
import { MAX_LABEL_LENGTH, MAX_TASK_LABELS } from "~/schemas/task-file.schema";
import { Icon } from "./icon";
import { useDismiss } from "./use-dismiss";

/**
 * A GitHub-style label combobox. Type a label and commit it with Enter or comma
 * (or on blur); each label is a removable chip (its own named Remove button);
 * Backspace on an empty field removes the last chip. As you type, a popover
 * offers the labels ALREADY used elsewhere in the project (passed in
 * `suggestions`) filtered to what matches, plus a "Create <label>" row for a
 * brand-new one — arrow to a row and Enter/click to take it, or just keep typing
 * and Enter to commit the typed text. Labels are trimmed, whitespace-collapsed,
 * de-duplicated case-insensitively, and capped to match the server's
 * `normalizeTaskLabels` (so the UI never builds a set the server would silently
 * trim). A polite live region announces adds/removes/rejections.
 *
 * The suggestion popover renders IN FLOW (not a portaled floating layer) for the
 * same reason the date-picker's calendar does: this input is used inside the
 * New-task `<dialog>`, which is transform-centered with `overflow: hidden`, so a
 * `position: fixed` popover mis-anchors and an absolute one is clipped. An
 * in-flow block lives in the scrollable modal body and is never clipped, and
 * behaves identically in the (non-dialog) Details panel.
 */
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

  // Options offered right now: existing project labels not already picked and
  // matching the buffer, then (if the typed text is a genuinely new label) a
  // "Create" row. Nothing is offered once the set is full — there is no room.
  const query = normalize(buffer);
  const room = value.length < max;
  const matches = room
    ? suggestions.filter(
        (s) => !has(s) && (query === "" || s.toLowerCase().includes(query.toLowerCase())),
      )
    : [];
  const canCreate =
    room &&
    query !== "" &&
    !has(query) &&
    !suggestions.some((s) => s.toLowerCase() === query.toLowerCase());
  const options: { value: string; create: boolean }[] = [
    ...matches.map((s) => ({ value: s, create: false })),
    ...(canCreate ? [{ value: query, create: true }] : []),
  ];
  const showPopover = open && options.length > 0;
  // `active` can dangle when options shrink under it; treat out-of-range as none.
  const activeOpt = active >= 0 && active < options.length ? active : -1;

  /** Fold one or more raw strings into the label set in a SINGLE onChange — so a
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

  const removeAt = (index: number) => {
    const removed = value[index];
    onChange(value.filter((_, i) => i !== index));
    setStatus(`Removed label ${removed}, ${value.length - 1} of ${max}`);
    inputRef.current?.focus();
  };

  /** Take an option (a suggestion or the Create row): add it, clear the buffer,
   *  and keep the field open + focused so more can be added in a flow. */
  const takeOption = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    addLabels([opt.value]);
    setBuffer("");
    setActive(-1);
    inputRef.current?.focus();
  };

  const commitBuffer = () => {
    addLabels([buffer]);
    setBuffer("");
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Comma is handled in onChange (the char lands in the value); the rest is
    // navigation + commit for the combobox.
    if (e.key === "ArrowDown" && options.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === "ArrowUp" && options.length > 0) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showPopover && activeOpt >= 0) takeOption(activeOpt);
      else commitBuffer();
    } else if (e.key === "Escape" && showPopover) {
      // Consume Escape ONLY to close the popover; a closed popover lets Escape
      // bubble so the enclosing dialog can cancel on it.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Backspace" && buffer === "" && value.length > 0) {
      e.preventDefault();
      removeAt(value.length - 1);
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

  const listId = "label-suggest-list";
  const optionId = (i: number) => `label-opt-${i}`;

  return (
    <div className="label-combo" ref={wrapRef}>
      <div className="label-input" onMouseDown={(e) => {
        // Clicking the chrome (not a chip button) focuses the field without
        // stealing focus away from an already-focused input mid-selection.
        if (e.target === e.currentTarget) inputRef.current?.focus();
      }}>
        {value.map((label, i) => (
          <span key={label} className="label-token">
            {label}
            <button
              type="button"
              className="label-token-x"
              aria-label={`Remove label ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                removeAt(i);
              }}
            >
              <Icon name="x" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className="label-input-field"
          role="combobox"
          aria-expanded={showPopover}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOpt >= 0 ? optionId(activeOpt) : undefined}
          value={buffer}
          onChange={onChangeText}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            commitBuffer();
            setOpen(false);
          }}
          placeholder={value.length === 0 ? "Add a label" : ""}
          aria-label="Add a label"
        />
      </div>
      {showPopover && (
        <ul className="label-suggest" id={listId} role="listbox">
          {options.map((opt, i) => (
            <li
              key={(opt.create ? "new:" : "sug:") + opt.value}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeOpt}
              className={"label-opt" + (opt.create ? " create" : "")}
              data-active={i === activeOpt}
              // mousedown, not click: fire before the input's blur so focus is
              // never lost (preventDefault keeps it), and the popover stays put.
              onMouseDown={(e) => {
                e.preventDefault();
                takeOption(i);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {opt.create ? (
                <>
                  <Icon name="plus" />
                  <span className="label-opt-name">{opt.value}</span>
                  <span className="label-opt-hint">create</span>
                </>
              ) : (
                <span className="label-opt-name">{opt.value}</span>
              )}
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
