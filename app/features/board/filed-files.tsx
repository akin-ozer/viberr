import { prettySize } from "~/shared/text/byte-size";
import { FILING_BATCH } from "~/shared/attachment-kinds";
import { ATTACH_ACCEPT, addPickedFiles, type PickedFiles } from "~/ui/picked-files";
import { Icon } from "~/ui/icon";

/**
 * Ruling 533: a task is filed WITH its input. On a board that delivers
 * results, the thing a person hands over (an inventory, a spreadsheet, a
 * screenshot of a portal) is the task, and it used to reach the task only
 * after the operator had already triaged a goal that could not show it.
 *
 * The picker offers exactly what the server stores, and the rules that keep or
 * refuse a pick are the composers' own (`~/ui/attach-files`, ruling 565); a
 * filing only words its limits for the dialog.
 */

/** The filing's picks, kept or refused by the upload's own rules. */
export function addFiledFiles(current: readonly File[], incoming: readonly File[]): PickedFiles {
  return addPickedFiles(current, incoming, FILING_BATCH);
}

export function FiledFiles({
  files,
  problem,
  onAdd,
  onRemove,
}: {
  files: readonly File[];
  problem: string | null;
  onAdd: (files: File[]) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <div
      className="field"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        onAdd(Array.from(e.dataTransfer.files));
      }}
    >
      <span className="flabel">
        Files
        <span className="fhint">optional · the input the agents work from</span>
      </span>
      <div className="attach-add">
        <label className="btn ghost sm">
          <Icon name="file" />
          Attach files
          <input
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            onChange={(e) => {
              const picked = Array.from(e.currentTarget.files ?? []);
              // Let the same file be picked again after it was removed.
              e.currentTarget.value = "";
              if (picked.length > 0) onAdd(picked);
            }}
          />
        </label>
        <span className="fine sm">or drop them here, or paste a screenshot</span>
      </div>
      {files.length > 0 && (
        <ul className="attach-list" aria-label="Files the task is filed with">
          {files.map((file) => (
            <li key={file.name} className="filed-file">
              <Icon name="file" />
              <span className="attach-name">{file.name}</span>
              <span className="attach-size">{prettySize(file.size)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemove(file.name)}
              >
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="form-err" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
