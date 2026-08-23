import { useRef, useState } from "react";
import { MAX_LABEL_LENGTH, MAX_TASK_LABELS } from "~/schemas/task-file.schema";
import { Icon } from "./icon";

/**
 * A GitHub-style freeform token/chip input for task labels. Type a label and
 * commit it with Enter or comma (or on blur); each label is a removable chip
 * (its own named Remove button); Backspace on an empty field removes the last
 * chip. Labels are trimmed, whitespace-collapsed, de-duplicated
 * case-insensitively, and capped to match the server's `normalizeTaskLabels`
 * (so the UI never builds a set the server would silently trim). A polite
 * live region announces adds/removes/rejections.
 */
export function LabelInput({
  value,
  onChange,
  max = MAX_TASK_LABELS,
  maxLen = MAX_LABEL_LENGTH,
}: {
  value: string[];
  onChange: (labels: string[]) => void;
  max?: number;
  maxLen?: number;
}) {
  const [buffer, setBuffer] = useState("");
  const [status, setStatus] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const normalize = (raw: string) => raw.trim().replace(/\s+/g, " ").slice(0, maxLen);

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Comma is handled in onChange (the char lands in the value); Enter commits
    // the buffer, which the value never carries.
    if (e.key === "Enter") {
      e.preventDefault();
      addLabels([buffer]);
      setBuffer("");
    } else if (e.key === "Backspace" && buffer === "" && value.length > 0) {
      e.preventDefault();
      removeAt(value.length - 1);
    }
  };

  const onChangeText = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.currentTarget.value;
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

  return (
    <div className="label-input" onClick={() => inputRef.current?.focus()}>
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
        value={buffer}
        onChange={onChangeText}
        onKeyDown={onKeyDown}
        onBlur={() => {
          addLabels([buffer]);
          setBuffer("");
        }}
        placeholder={value.length === 0 ? "Add a label" : ""}
        aria-label="Add a label"
      />
      <span className="vh" role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
