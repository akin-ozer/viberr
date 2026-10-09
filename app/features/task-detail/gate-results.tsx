import type { GateNoteRow } from "~/shared/project-gates";
import { Icon } from "~/ui/icon";
import type { useAttachmentLightbox } from "./attachment-lightbox";

/**
 * Ruling 313: the project's gates as one table wherever they are shown, on
 * the note a run writes to the timeline, on the PR card and in the accept
 * dialog. A row is the gate's pass or fail mark, its name (a failure adds its
 * outcome in words), its time and its log, which opens in the in-app reader
 * like any attached text file.
 */
export function GateResults({
  rows,
  attachmentsBase,
  openLog,
  compact = false,
}: {
  rows: readonly GateNoteRow[];
  /** The attachment route base; without it no row links its log. */
  attachmentsBase?: string | null;
  /** The caller's `useAttachmentLightbox()`. Passed in, never imported, so
   *  a surface that links no log (the accept dialog, on the board too) does
   *  not load the reader (ruling 11). */
  openLog?: ReturnType<typeof useAttachmentLightbox>;
  /** The side panel and the dialog set the table at their smaller size. */
  compact?: boolean;
}) {
  return (
    <table className={compact ? "gate-table compact" : "gate-table"} aria-label="Gate results">
      <tbody>
        {rows.map((row) => {
          const url =
            row.log && attachmentsBase ? `${attachmentsBase}/${encodeURIComponent(row.log)}` : null;
          return (
            <tr key={row.name} className={row.ok ? "ok" : "bad"}>
              <td className="gate-mark">
                <Icon name={row.ok ? "checkcircle" : "xcircle"} />
                <span className="vh">{row.ok ? "passed" : "failed"}</span>
              </td>
              <th scope="row" className="gate-name">
                <span className="gate-name-in">
                  {row.name}
                  {!row.ok && <span className="gate-why">{row.outcome}</span>}
                </span>
              </th>
              <td className="gate-wall">{row.wall}</td>
              {attachmentsBase && (
                <td className="gate-log-cell">
                  {url && row.log && (
                    <a
                      className="gate-log"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${row.name} log`}
                      onClick={openLog?.({ name: row.log, url })}
                    >
                      <Icon name="page" />
                      <span className="gate-log-word">Log</span>
                    </a>
                  )}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
