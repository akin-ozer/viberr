import type { MessageFile } from "~/server/controller/controller-conversations.server";
import { PICTURE_RE } from "~/ui/picked-files";
import { Icon } from "~/ui/icon";
import { prettySize } from "~/shared/text/byte-size";

/** Ruling 565: where a file sent in a conversation is served. */
export function messageFileHref(file: Pick<MessageFile, "id">): string {
  return `/resources/controller-file/${encodeURIComponent(file.id)}`;
}

/**
 * Ruling 565: the files a person sent with a message, under its words, on the
 * page and in the dock. A picture shows as itself; any other file as the
 * composer tray's chip (name and size), so what was sent looks like what was
 * attached. Each opens the file in a new tab from the conversation's own
 * serving route.
 */
export function MessageFiles({ files }: { files: readonly MessageFile[] }) {
  return (
    <ul className="ctl-files" aria-label={files.length === 1 ? "1 file sent" : `${files.length} files sent`}>
      {files.map((file) => (
        <li key={file.id}>
          {PICTURE_RE.test(file.name) ? (
            <a
              className="ctl-file-pic"
              href={messageFileHref(file)}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${file.name} (${prettySize(file.bytes)})`}
            >
              <img src={messageFileHref(file)} alt="" loading="lazy" />
            </a>
          ) : (
            <a className="att-chip ctl-file" href={messageFileHref(file)} target="_blank" rel="noreferrer">
              <span className="att-chip-media" aria-hidden="true">
                <Icon name="file" />
              </span>
              <span className="attach-name" title={file.name}>
                {file.name}
              </span>
              <span className="attach-size">{prettySize(file.bytes)}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
