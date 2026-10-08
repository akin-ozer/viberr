import path from "node:path";
import type { Route } from "./+types/task-attachment";
import { requireProjectMember } from "~/server/auth/require-project.server";
import {
  readAttachmentBytes,
  resolveTaskAttachment,
  servedFileResponse,
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
 *    saved by a browsing agent must never execute on this origin. Ruling 690:
 *    `servedFileResponse` writes those headers, for this route, the
 *    controller's files and a task's kept sources alike.
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

  // The stored name: a typed name finds the file in either Unicode form
  // (ruling 675), and the header carries the one the folder holds.
  return servedFileResponse(request, path.basename(abs), read.bytes);
}
