import path from "node:path";
import type { Route } from "./+types/task-attachment";
import { requireProjectMember } from "~/server/auth/require-project.server";
import {
  attachmentContentType,
  attachmentDisposition,
  readAttachmentBytes,
  resolveTaskAttachment,
} from "~/server/files/task-attachments.server";

/**
 * GET /projects/:slug/tasks/:key/attachments/:file — one task attachment
 * (R19-19: files an agent's browser saved — screenshots, PDFs).
 *
 * Authorization is PROJECT MEMBERSHIP, the same bar as `/resources/run-log`:
 * a screenshot of the running app is run-artifact material (it can show
 * anything the agent saw), not the app-wide task summary. Org admins pass via
 * the audited D2 override inside the same guard.
 *
 * Serving is deliberately hostile to content smuggling:
 *  - the name resolves through the traversal-refusing store resolver; any
 *    violation is a plain 404 (no oracle distinguishing "bad name" from
 *    "no file");
 *  - `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`
 *    on every response, and only whitelisted types render inline — HTML/SVG
 *    saved by a browsing agent must never execute on this origin.
 */

/** Memory bound for the read-into-buffer serve; larger files are refused. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireProjectMember(request, params.slug, "view task attachments");

  let abs: string;
  try {
    abs = resolveTaskAttachment(params.slug, params.key, params.file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  // Ruling 552: never through a link. Agents can write this folder (ruling
  // 460), and a link planted in it served the file it pointed at, one only
  // the server may read, to anyone in the project.
  const read = readAttachmentBytes(abs, MAX_ATTACHMENT_BYTES);
  if (!read) return new Response("Not found", { status: 404 });
  if ("tooLarge" in read) {
    return new Response("Attachment too large to serve.", { status: 413 });
  }

  const { type, inline } = attachmentContentType(params.file);
  // Ruling 105: the in-app text viewer's Download button asks for the same
  // URL with `?download=1` — force the save dialog instead of inline render.
  const forceDownload =
    new URL(request.url).searchParams.get("download") === "1";
  return new Response(new Uint8Array(read.bytes), {
    headers: {
      "content-type": type,
      "content-length": String(read.bytes.length),
      // Ruling 675: a name outside Latin-1 cannot stand in a header as it is.
      "content-disposition": attachmentDisposition(path.basename(abs), inline && !forceDownload),
      "x-content-type-options": "nosniff",
      // Even the inline types render inert: no scripts, no plugins reaching
      // back into the origin. Browsers that refuse to show a sandboxed PDF
      // inline fall back to downloading it — acceptable.
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, max-age=300",
    },
  });
}
