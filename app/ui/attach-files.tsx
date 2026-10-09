import { memo, useEffect, useRef, useState, type DragEvent } from "react";
import { ATTACHMENT_BATCH_MAX } from "~/shared/attachment-kinds";
import { IMAGE_RE } from "./picked-files";
import { prettySize } from "~/shared/text/byte-size";
import { Icon } from "./icon";

/**
 * Ruling 319: the files a person hands over with a message, picked, dropped or
 * pasted, before the message is sent: the tray, the paperclip and the drop,
 * for the controller page and dock and a task's comments.
 *
 * The anatomy follows ReUI's composer tray with removable attachments
 * (`c-attachment-2`), shadcn's `Attachment` and ReUI's `use-file-upload` hook,
 * read as design references and never installed (ruling 14): a paperclip
 * that opens the picker, a tray of chips over the text (a picture's own
 * thumbnail or the file glyph, the name, the size, a remove button), a drop on
 * the composer's frame, and a pasted screenshot.
 *
 * The picker offers any kind of file (ruling 76); the rules for what a
 * composer keeps, sizes and counts, are `picked-files.ts`.
 */

/** What a drop target spreads on its element. */
export interface FileDropProps {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

/** A drop target's state and the handlers it spreads. */
export interface FileDrop {
  dropping: boolean;
  dropProps: FileDropProps;
}

/**
 * Ruling 319: a composer's frame takes the files dropped on it. `dropping` is
 * true while files are held over the frame, for its highlight; a drag of text
 * or of anything but files is left to the page.
 */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false): FileDrop {
  const [dropping, setDropping] = useState(false);
  const carriesFiles = (event: DragEvent<HTMLElement>) => !disabled && event.dataTransfer.types.includes("Files");
  return {
    dropping,
    dropProps: {
      onDragEnter: (event) => {
        if (carriesFiles(event)) setDropping(true);
      },
      onDragOver: (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event) => {
        // Leaving for one of the frame's own children is still over it.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDropping(false);
      },
      onDrop: (event) => {
        setDropping(false);
        if (!carriesFiles(event) || event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        onFiles(Array.from(event.dataTransfer.files));
      },
    },
  };
}

/**
 * The paperclip that opens the file picker. A button beside a hidden input,
 * not a label around it, so the press is the button's own (ruling 283, F31)
 * and the keyboard meets one control. Memoised with the tray (ruling 11): a
 * composer re-renders on every revalidation of its page, and these draw
 * nothing new until the person picks.
 */
export const AttachButton = /* @__PURE__ */ memo(function AttachButton({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="icon-btn att-add"
        aria-label="Attach files"
        title="Attach files, or drop them here, or paste a screenshot"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Icon name="clip" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const picked = Array.from(event.currentTarget.files ?? []);
          // Let the same file be picked again after it was removed.
          event.currentTarget.value = "";
          if (picked.length > 0) onFiles(picked);
        }}
      />
    </>
  );
});

/** A picture's thumbnail, made from the file and let go when the chip goes. */
function useObjectUrl(file: File, wanted: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted) return;
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file, wanted]);
  return url;
}

function TrayChip({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled: boolean }) {
  const thumb = useObjectUrl(file, IMAGE_RE.test(file.name));
  return (
    <li className="att-chip">
      <span className="att-chip-media" aria-hidden="true">
        {thumb ? <img src={thumb} alt="" /> : <Icon name="file" />}
      </span>
      <span className="attach-name" title={file.name}>
        {file.name}
      </span>
      <span className="attach-size">{prettySize(file.size)}</span>
      <button
        type="button"
        className="att-chip-x"
        aria-label={`Remove ${file.name}`}
        disabled={disabled}
        onClick={onRemove}
      >
        <Icon name="x" />
      </button>
    </li>
  );
}

/**
 * The files waiting to go with the message, over its text, and the first
 * one refused. Renders nothing while there are neither.
 */
export const AttachTray = /* @__PURE__ */ memo(function AttachTray({
  files,
  problem,
  onRemove,
  disabled = false,
}: {
  files: readonly File[];
  problem: string | null;
  onRemove: (name: string) => void;
  disabled?: boolean;
}) {
  if (files.length === 0 && !problem) return null;
  return (
    <div className="att-tray">
      {files.length > 0 && (
        <ul className="att-chips" aria-label={`${files.length} of ${ATTACHMENT_BATCH_MAX} files attached`}>
          {files.map((file) => (
            <TrayChip key={file.name} file={file} disabled={disabled} onRemove={() => onRemove(file.name)} />
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
});
