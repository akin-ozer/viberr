import type { Route } from "./+types/resources.controller-file";
import { requireUser } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import {
  canAccessConversation,
  getConversation,
  getMessageFile,
} from "~/server/controller/controller-conversations.server";
import { servedFileResponse } from "~/server/files/task-attachments.server";

/**
 * GET /resources/controller-file/:id — one file a person sent with a controller
 * message (ruling 573), for the transcript's thumbnails and links.
 *
 * Authorization is the conversation's: its owner and a live org admin, the two
 * who may read the transcript (`canAccessConversation`). Anyone else, and a
 * file that does not exist, gets the same 404, as a conversation does.
 *
 * Served the way a task attachment is (`servedFileResponse`): `nosniff`, a
 * sandbox CSP, only the whitelisted kinds inline, and `?download=1` for the
 * save dialog. The name rides the header twice: an ASCII fallback, and the
 * whole name in RFC 5987's `filename*`, since a header refuses characters past
 * Latin-1 and a person's file can be named in any script.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const db = getDb();
  const file = getMessageFile(db, params.id);
  const conversation = file ? getConversation(db, file.conversationId) : null;
  if (!file || !conversation || !canAccessConversation(db, conversation, { userId: user.id, orgRole: user.role })) {
    return new Response("Not found", { status: 404 });
  }
  return servedFileResponse(request, file.name, file.data);
}
