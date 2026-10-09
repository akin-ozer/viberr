import type { DatabaseSync } from "node:sqlite";
import { encodeControllerInstrument } from "~/shared/mapping/actor.server";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import {
  assertProjectAction,
  isOrgAdmin,
  type AuthorityActor,
} from "~/server/auth/project-authority.server";
import { AppError } from "~/server/errors/app-error.server";
import { logger } from "~/server/logging/logger.server";
import { textResult } from "~/server/runtimes/strict-tool.server";
import { toError } from "~/shared/errors";

/**
 * The refusal machinery every controller-side MCP shares (ruling 269).
 *
 * The controller mounts two in-process servers — `viberr_controller` (the
 * governed CRUD toolkit, ruling 247) and `viberr_ops` (read-only diagnostics) —
 * and they must refuse in ONE voice: `[denied] <the guard's own sentence>` for
 * an authority refusal, a uniform not-visible sentence for a read the asker may
 * not have, `[error]` for anything unexpected. Two copies of that voice would
 * drift on the first reworded sentence, so it lives here and both build from it.
 *
 * AUTHORITY is resolved LIVE, per call, against the ASKING USER: no controller
 * server holds authority of its own.
 */

/** The asking person — the only authority any controller tool runs under. */
export interface ControllerToolUser {
  id: string;
  email: string;
  name: string;
}

/** The single result shape every controller tool answers in (`textResult`'s,
 *  the shape every Viberr tool shares). A type alias, not an interface: the
 *  SDK's tool-result parameter carries an index signature, and only an alias
 *  picks up the implicit one that makes it assignable. */
export type ControllerToolText = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
};

/**
 * Ruling 260: the most text one controller tool reply carries, in characters.
 *
 * The Claude CLI checks an MCP result in two steps (read from the bundle of
 * its 2.1.284): a text result whose length is at most four times half its
 * token limit, 50,000 characters at the default 25,000 tokens, passes as it
 * is; only a longer one is counted in tokens, and over the limit the model is
 * handed a path to a file with advice to grep it, tools the controller is
 * denied. Live on the AWS calculator board `get_project` came to 93,696
 * characters, and on all three turns that called it the controller was told
 * to read a file it could not open. So the cap sits on the first step, where
 * no reply is refused however many tokens its characters make: a list of ids
 * and timestamps runs near two characters to a token, and a cap reckoned from
 * the token limit would let that reply through to be refused.
 */
const CONTROLLER_REPLY_MAX_CHARS = 50_000;

/** How far back from the cut, in characters, a line break is worth stepping to. */
const LINE_BREAK_REACH = 4_000;

/**
 * Ruling 260: a reply a turn can carry. One within {@link CONTROLLER_REPLY_MAX_CHARS}
 * is returned as it is. A longer one is cut at the last line break that fits
 * (or, when none is near, where the room ends), and its first line says so,
 * with the sizes, before anything else is read: a head the model can use and
 * a plain account of what is missing, where the CLI would have returned
 * neither. Each tool still bounds its own reply (a page, a limit, an
 * excerpt); this is what stands behind the one that did not.
 */
function carriedReply(text: string): string {
  if (text.length <= CONTROLLER_REPLY_MAX_CHARS) return text;
  const size = (n: number) => n.toLocaleString("en-US");
  const note = (kept: number) =>
    `[cut] This reply is ${size(text.length)} characters and a turn carries ${size(CONTROLLER_REPLY_MAX_CHARS)}: ` +
    `what follows is its first ${size(kept)}, and the rest is not here. ` +
    "Ask for less (one item, a limit, a later page) rather than taking this as the whole of it.\n";
  // Room for the note at its longest, and never between the two halves of a
  // character that takes two code units.
  let room = CONTROLLER_REPLY_MAX_CHARS - note(text.length).length;
  const last = text.charCodeAt(room - 1);
  if (last >= 0xd800 && last <= 0xdbff) room -= 1;
  const head = text.slice(0, room);
  // Back to a line break when one is near, so whole lines are kept. A reply
  // that is mostly one line (a document inside a JSON string) is cut where it
  // stands: stepping back to its last break would keep its first few lines.
  const lineEnd = head.lastIndexOf("\n");
  const kept = lineEnd > head.length - LINE_BREAK_REACH ? head.slice(0, lineEnd) : head;
  return note(kept.length) + kept;
}

/** Uniform not-visible copy: a missing project and a forbidden one read
 *  identically, so a probe cannot learn that a project exists (R15-4). */
export function notVisible(slug: string): string {
  return `[denied] No project "${slug}" is visible to you.`;
}

/** Thrown wherever a read must answer a uniform not-visible sentence instead of
 *  the guard's own copy; `run` relays the message verbatim. */
export class NotVisibleError extends Error {}

export interface ControllerToolGuards {
  /** The authority + audit actor every call runs under: the human's id (guards
   *  bind to it) with the instrument disclosed in the label. */
  actor: AuthorityActor & AuditActor;
  /** LIVE org role — never snapshotted at conversation start. */
  orgAdmin: () => boolean;
  /** Org-scope gate: refuses with an audited denial row (P13-D-8 parity —
   *  project denials are audited; instance denials must not read cleaner). */
  requireOrgAdmin: (what: string) => void;
  /** Membership gate for project READS: missing and forbidden both throw the
   *  same not-visible shape. Org admins pass via the audited override. */
  requireVisible: (slug: string, what: string) => void;
  /** Wrap a handler: AppError → [denied]/[error] text the model relays. A
   *  handler answers in text, or (ruling 117) in text and a picture. */
  run: (
    fn: () => Promise<string | ControllerToolText> | string | ControllerToolText,
  ) => () => Promise<ControllerToolText>;
  /** The same wrapper for handlers that take validated args. */
  runWith: <A>(
    fn: (args: A) => Promise<string | ControllerToolText> | string | ControllerToolText,
  ) => (args: A) => Promise<ControllerToolText>;
  /** Machine-readable answers, formatted for a model to read back. */
  json: <T>(value: T) => string;
}

/** Build the shared guards for one controller turn, bound to the asking user. */
export function controllerToolGuards(
  db: DatabaseSync,
  user: ControllerToolUser,
  dataRoot?: string,
): ControllerToolGuards {
  const actor = { userId: user.id, label: encodeControllerInstrument(user.email) };

  const orgAdmin = () => isOrgAdmin(db, user.id);

  function requireOrgAdmin(what: string): void {
    if (orgAdmin()) return;
    recordAudit(db, {
      action: "controller.authority.denied",
      actor,
      details: { scope: "instance", what },
    });
    throw AppError.forbidden(
      `Only org admins can ${what}. Your org role is member.`,
    );
  }

  function requireVisible(slug: string, what: string): void {
    try {
      assertProjectAction(db, "any-member", slug, actor, what, {
        dataRoot,
        allowArchived: true,
      });
    } catch {
      throw new NotVisibleError(notVisible(slug));
    }
  }

  function run(fn: () => Promise<string | ControllerToolText> | string | ControllerToolText) {
    return async (): Promise<ControllerToolText> => {
      try {
        const answer = await fn();
        // Ruling 260: no reply leaves here longer than a turn carries.
        if (answer instanceof Object) {
          return {
            content: answer.content.map((part) =>
              part.type === "text" ? { type: "text" as const, text: carriedReply(part.text) } : part,
            ),
          };
        }
        return textResult(carriedReply(answer));
      } catch (error) {
        if (error instanceof AppError) {
          const denied = error.status === 403 || error.status === 401;
          return textResult(
            `[${denied ? "denied" : "error"}] ${error.userMessage}`,
          );
        }
        if (error instanceof NotVisibleError) {
          return textResult(error.message);
        }
        logger.error("controller tool failed", {
          err: toError(error),
        });
        return textResult(
          "[error] That action failed unexpectedly. The details are in the server log; nothing was partially hidden from the audit trail.",
        );
      }
    };
  }

  function runWith<A>(fn: (args: A) => Promise<string | ControllerToolText> | string | ControllerToolText) {
    return async (args: A) => {
      const wrapped = run(() => fn(args));
      return wrapped();
    };
  }

  return {
    actor,
    orgAdmin,
    requireOrgAdmin,
    requireVisible,
    run,
    runWith,
    json: (value) => JSON.stringify(value, null, 1),
  };
}
