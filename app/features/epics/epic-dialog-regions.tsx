import type { KeyboardEvent } from "react";
import { EPIC_COLORS, EPIC_STATUS_LABEL, EPIC_STATUS_VALUES } from "~/schemas/epic-file.schema";
import { DatePicker } from "~/ui/date-picker";
import { Icon } from "~/ui/icon";
import type { EpicDraft, SetEpicDraft } from "./epic-dialog-derive";
import type { EpicMemberView } from "./epics-query.server";

/**
 * The epic dialog's fields after its name, and its foot (ruling 696(e), the
 * large-component split of `EpicDialog` in `epic-parts.tsx`). Neither calls a
 * hook: the dialog holds the draft, the request and the close, and hands them
 * in, so the markup is what it was. The name stays in the dialog: it takes
 * the focus as the dialog opens and submits on Enter.
 */

/** The swatches are one radio group: the arrows move the pick, wrapping. */
function onSwatchKey(e: KeyboardEvent<HTMLDivElement>) {
  const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = all.findIndex((el) => el === document.activeElement);
  const step =
    e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (step === 0 || at < 0) return;
  e.preventDefault();
  const next = all[(at + step + all.length) % all.length];
  next?.focus();
  next?.click();
}

/** What the epic is, after its name: the description, the status and the
 *  lead, the two dates, the colour. */
export function EpicDialogFields({
  draft,
  set,
  members,
}: {
  draft: EpicDraft;
  set: SetEpicDraft;
  members: EpicMemberView[];
}) {
  return (
    <>
      <div className="field">
        <label className="flabel" htmlFor="epic-description">
          Description
          <span className="fhint">markdown, optional: the outcome the tasks add up to</span>
        </label>
        <textarea
          id="epic-description"
          rows={5}
          value={draft.description}
          onChange={(e) => set("description", e.target.value)}
          placeholder="What is done when this epic is done, and what is out of scope."
        />
      </div>
      <div className="field-row">
        <div className="field">
          <label className="flabel" htmlFor="epic-status">
            Status
          </label>
          <select
            id="epic-status"
            value={draft.status}
            onChange={(e) => {
              const next = EPIC_STATUS_VALUES.find((s) => s === e.target.value);
              if (next) set("status", next);
            }}
          >
            {EPIC_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {EPIC_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="flabel" htmlFor="epic-lead">
            Lead
          </label>
          <select id="epic-lead" value={draft.leadUserId} onChange={(e) => set("leadUserId", e.target.value)}>
            <option value="">Nobody</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <span className="flabel">Start date</span>
          <DatePicker
            label="Start date"
            placeholder="Not set"
            value={draft.startDate || null}
            onChange={(v) => set("startDate", v ?? "")}
          />
        </div>
        <div className="field">
          <span className="flabel">Target date</span>
          <DatePicker
            label="Target date"
            placeholder="Not set"
            value={draft.targetDate || null}
            onChange={(v) => set("targetDate", v ?? "")}
          />
        </div>
      </div>
      <div className="field">
        <span className="flabel" id="epic-color-label">
          Colour
          <span className="fhint">{draft.color ? draft.color : "the next in the sequence"}</span>
        </span>
        <div
          className="epic-swatches"
          role="radiogroup"
          aria-labelledby="epic-color-label"
          onKeyDown={onSwatchKey}
        >
          {EPIC_COLORS.map((color, i) => {
            const checked = draft.color === color;
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={checked}
                // One tab stop: the picked swatch, else the first.
                tabIndex={checked || (draft.color === "" && i === 0) ? 0 : -1}
                className="swatch"
                data-stage-color={color}
                aria-label={color}
                title={color}
                onClick={() => set("color", color)}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

/** The foot: its sentence (an alert while it names what is wrong), Cancel,
 *  and Save or Create epic. */
export function EpicDialogFoot({
  hint,
  alert,
  editing,
  busy,
  onCancel,
  onSubmit,
}: {
  hint: string;
  /** The sentence names a fault: the name, the dates or the server's refusal. */
  alert: boolean;
  editing: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="modal-foot">
      <span id="epic-dialog-hint" className={"foot-hint" + (alert ? " err" : "")} role={alert ? "alert" : undefined}>
        {hint}
      </span>
      <div className="foot-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={onSubmit} disabled={busy} aria-busy={busy}>
          <Icon name={editing ? "check" : "plus"} />
          {editing ? "Save" : "Create epic"}
        </button>
      </div>
    </div>
  );
}
