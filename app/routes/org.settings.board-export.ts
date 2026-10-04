import { requireRole } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { AppError } from "~/server/errors/app-error.server";
import { exportBoard } from "~/server/org/board-export.server";

/**
 * GET /org/settings/board-export?project=<slug>
 *
 * Ruling 653: one board as a board file (`<slug>.viberr-board.zip`). Org-admin
 * gated, like the Instance settings tab its Export buttons sit on: the file
 * carries the knowledge bases and agent personas of the board, whichever
 * project it is. It changes nothing, so it records nothing, as the audit
 * log's own download does. A refusal (no such project, a project file the
 * store cannot read, a board too large to import back) answers JSON
 * `{ error }` with its status, which the tab shows as a toast.
 */
export async function loader({ request }: { request: Request }) {
  await requireRole(request, "admin");
  const slug = new URL(request.url).searchParams.get("project") ?? "";
  try {
    const file = exportBoard(getDb(), slug);
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(file.bytes.length),
        // The slug is `[a-z0-9-]` by the project schema, so the name needs no
        // escaping.
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.userMessage }, { status: error.status });
    }
    throw error;
  }
}
