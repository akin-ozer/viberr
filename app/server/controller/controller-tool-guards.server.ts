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
 * The refusal machinery every controller-side MCP shares (ruling 107).
 *
 * The controller mounts two in-process servers — `viberr_controller` (the
 * governed CRUD toolkit, ruling 99) and `viberr_ops` (read-only diagnostics) —
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
   *  handler answers in text, or (ruling 533) in text and a picture. */
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
  const auditActor: AuditActor = actor;

  const orgAdmin = () => isOrgAdmin(db, user.id);

  function requireOrgAdmin(what: string): void {
    if (orgAdmin()) return;
    recordAudit(db, {
      action: "controller.authority.denied",
      actor: auditActor,
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
        return answer instanceof Object ? answer : textResult(answer);
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
