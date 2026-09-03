import type { DatabaseSync } from "node:sqlite";
import { findUserById } from "~/server/auth/user-store.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { taskRef } from "~/server/tasks/task-mutation.server";
import {
  userBackendHealth,
  type UserBackendHealth,
} from "./backend-credentials.server";
import type { RealBackend } from "./runtime-registry.server";

/**
 * Whose account a run bills (ruling 127).
 *
 * Every agent run has a credential PRINCIPAL, and there are exactly two rules:
 *
 *  - a TASK run — operator, specialist, resume, scheduled, boot recovery,
 *    retry — uses the **task owner's** accounts;
 *  - a CONTROLLER turn uses the **asker's** Claude account.
 *
 * A task with no owner therefore cannot run agents at all: there is nobody to
 * bill, and inventing one (the viewer, the dispatcher, an instance credential)
 * is precisely what ruling 127 forbids. That refusal is honest and cheap — it
 * happens before any clone, any reservation and any process — which is why
 * creation now seats the creator as owner.
 *
 * This module RESOLVES and REFUSES; it never starts anything. The one sentence
 * a human reads for a refusal is {@link principalRefusalMessage}, so the error
 * run line, the packet body and the disabled control in the UI cannot drift
 * apart. (The controller writes its own sentence — "your own Claude account" —
 * because "the task owner" is not who its refusal is about; see
 * `controller-run.server.ts`.)
 */

/** The person a run bills. `label` is the email (the audit label); `name` is
 *  the display name, which the refusal copy names alongside it. */
export interface RunPrincipal {
  userId: string;
  label: string;
  name: string;
}

export type RunPrincipalRefusal =
  /** The task has no owner — nobody to bill. Carries the key because the
   *  sentence names the task the human has to own. */
  | { kind: "unowned"; taskKey: string }
  /** The owner's user row is gone or disabled. */
  | { kind: "owner-missing"; ownerUserId: string }
  /** The owner exists but has not connected this backend (or their sign-in
   *  file is gone) — `health` carries the specific reason. */
  | {
      kind: "no-credential";
      owner: RunPrincipal;
      backend: RealBackend;
      health: UserBackendHealth;
    };

export type RunPrincipalResolution =
  | { ok: true; principal: RunPrincipal; health: UserBackendHealth }
  | { ok: false; refusal: RunPrincipalRefusal };

/** Ruling 92: the backends are called "Claude" and "Codex" everywhere. */
const BACKEND_LABEL = { claude: "Claude", codex: "Codex" } as const;

const NO_PROCESS = "No agent process was started.";

export interface RunPrincipalContext {
  /** Override the data root (tests). Defaults to env VIBERR_DATA_ROOT. */
  dataRoot?: string;
  /** Override the platform the login-file probe judges by (tests). */
  platform?: NodeJS.Platform;
}

/**
 * The principal for a run on a task: its owner, if the owner is a live user
 * with this backend connected.
 *
 * A task file that cannot be read is `unowned` — not an error. It is the same
 * fact from the run's point of view (there is no owner to bill), and it reaches
 * the human as an actionable sentence instead of a 500.
 */
export function resolveTaskRunPrincipal(
  db: DatabaseSync,
  ctx: RunPrincipalContext,
  projectSlug: string,
  taskKey: string,
  backend: RealBackend,
): RunPrincipalResolution {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const ownerUserId = file?.parsed.frontmatter.ownerUserId ?? null;
  if (!ownerUserId) {
    return { ok: false, refusal: { kind: "unowned", taskKey } };
  }
  return resolveForUser(db, ctx, ownerUserId, backend);
}

/** The principal for a controller turn: the asker themselves. */
export function resolveUserRunPrincipal(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  ctx: RunPrincipalContext = {},
): RunPrincipalResolution {
  return resolveForUser(db, ctx, userId, backend);
}

function resolveForUser(
  db: DatabaseSync,
  ctx: RunPrincipalContext,
  userId: string,
  backend: RealBackend,
): RunPrincipalResolution {
  const user = findUserById(db, userId);
  // A disabled account is as gone as a deleted one for billing purposes: the
  // person can no longer sign in, so nothing they own may keep spending on
  // their provider account.
  if (!user || user.disabled) {
    return { ok: false, refusal: { kind: "owner-missing", ownerUserId: userId } };
  }
  const principal: RunPrincipal = {
    userId: user.id,
    label: user.email,
    name: user.name,
  };
  const health = userBackendHealth(db, user.id, backend, {
    dataRoot: ctx.dataRoot,
    platform: ctx.platform,
  });
  if (!health.available) {
    return {
      ok: false,
      refusal: { kind: "no-credential", owner: principal, backend, health },
    };
  }
  return { ok: true, principal, health };
}

/**
 * The person a refusal still NAMES, when there is a live one.
 *
 * A run refused for a missing credential is still billed-to-nobody, but it
 * knows whose account it would have used — so `agent_runs.credential_user_id`
 * records it and the refusal is auditable rather than anonymous. The other two
 * refusals genuinely have no live person behind them (nobody owns the task; the
 * owner's account is gone or disabled), and the column stays NULL, which is
 * exactly what the DDL comment promises: null only on a run refused before any
 * credential was looked up.
 */
export function refusedPrincipalUserId(
  refusal: RunPrincipalRefusal,
): string | null {
  return refusal.kind === "no-credential" ? refusal.owner.userId : null;
}

/**
 * The single source of the human-facing refusal sentence — the error run's
 * `run·unavailable` line, the blocked packet's body and the disabled dispatch
 * control all render THIS, so a person cannot be told three different stories
 * about the same refusal.
 */
export function principalRefusalMessage(
  refusal: RunPrincipalRefusal,
  backend: RealBackend,
): string {
  const label = BACKEND_LABEL[backend];
  if (refusal.kind === "unowned") {
    return (
      `${label} runs on ${refusal.taskKey} need a task owner: agent runs use the owner's ` +
      `accounts and this task has none. Own the task (Assign me) and run the agent again. ` +
      NO_PROCESS
    );
  }
  if (refusal.kind === "owner-missing") {
    return (
      "This task's owner account is disabled or gone, so its agents have no account to run on. " +
      `Assign a new owner and run the agent again. ${NO_PROCESS}`
    );
  }
  // The health detail is the SPECIFIC half ("your sign-in file is missing…"),
  // and it is only worth appending when it says more than "not connected" — the
  // first sentence already said that.
  const specific =
    refusal.health.kind !== null && refusal.health.detail
      ? ` ${refusal.health.detail}`
      : "";
  return (
    `${label} isn't connected for ${refusal.owner.name} (${refusal.owner.label}), the task owner. ` +
    `Runs on this task use the owner's accounts; they can connect ${label} on ` +
    `Profile → Agent accounts.${specific} ${NO_PROCESS}`
  );
}
