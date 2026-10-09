import type { Route } from "./+types/task-source";
import { requireProjectMember } from "~/server/auth/require-project.server";
import { readAttachmentBytes, servedFileResponse } from "~/server/files/task-attachments.server";
import { resolveTaskSource } from "~/server/files/task-sources.server";

/**
 * GET /projects/:slug/tasks/:key/sources/:id: one kept source of a task
 * (ruling 317), by its id (`S7`), for the Sources panel and the result card.
 *
 * Authorization is PROJECT MEMBERSHIP, the bar a task's attachments have
 * (`task-attachment.ts`): a kept source is what an agent read, a page or a
 * command's output, and it is shown to nobody a screenshot would not be.
 *
 * A source is a page as an agent fetched it, so it is served the way a file
 * an agent saved is (`servedFileResponse`, ruling 317): under the name the
 * agent gave it, with `nosniff` and a sandbox, and inline only when its kind
 * is whitelisted. A kept `.html` page is therefore a download of a generic
 * type and never renders on the app's origin; the reader card shows its
 * source text. An id the task does not keep, a key that is not one task's
 * folder and a bytes file that has left the store all answer the same 404.
 */

/** Memory bound for the read-into-buffer serve; larger files are refused. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireProjectMember(request, params.slug, "view task sources");

  const resolved = resolveTaskSource(params.slug, params.key, params.id);
  if (!resolved) return new Response("Not found", { status: 404 });
  // Never through a link, as every stored file is read (ruling 19).
  const read = readAttachmentBytes(resolved.abs, MAX_SOURCE_BYTES);
  if (!read) return new Response("Not found", { status: 404 });
  if ("tooLarge" in read) {
    return new Response("Source too large to serve.", { status: 413 });
  }
  return servedFileResponse(request, resolved.source.name, read.bytes);
}
