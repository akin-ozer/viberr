/**
 * Ruling 127: whose accounts a run on THIS task would bill, and the one
 * sentence a control renders when the answer is "nobody's".
 *
 * Every agent run on a task bills its OWNER's connected backends, so the
 * question the task page used to ask ("is this backend configured on the
 * instance?") no longer has an answer: two tasks side by side in one project
 * can differ because their owners differ. The loader therefore ships the
 * owner's health instead of a deployment boolean, and every disabled run
 * control on the page renders the refusal that names the person, not a
 * credential nobody can set any more.
 *
 * The sentences here are the UI voice of `principalRefusalMessage`
 * (`app/server/runtimes/run-principal.server.ts`), which is what the refused
 * run's `run·unavailable` line and the blocked packet say. They are shorter
 * (a control is not a run log) and they drop its "No agent process was
 * started" clause, because nothing has been started here yet — but they must
 * never tell a DIFFERENT story, so the wording tracks that builder.
 *
 * This module carries no JSX and imports nothing, so the execution profile,
 * the agent selector and the mention menu can all read it without the import
 * cycle a shared helper inside `execution-profile.tsx` would create.
 */

/** The two real agent backends, as the client side names them. */
export type ViewBackend = "claude" | "codex";

/** Per-backend health of the task owner's account, as the loader ships it
 *  (`app/routes/project.task.tsx`). `detail` is the store's own actionable
 *  sentence, written in the SECOND person for the person it is about, so it is
 *  only ever rendered to the owner themselves. */
export interface PrincipalBackendView {
  available: boolean;
  detail: string | null;
}

/**
 * The task's run principal: the owner whose accounts its agent runs bill.
 *
 * `null` means there is nobody to bill — the task has no owner, or its seat
 * points at an account that is disabled or gone. That is a DIFFERENT refusal
 * from "the owner has not connected this backend" (no backend switch fixes it,
 * and the remedy is a human taking the task), which is why the two are not
 * collapsed into a pair of booleans.
 */
export interface TaskRunPrincipalView {
  ownerUserId: string;
  ownerName: string;
  claude: PrincipalBackendView;
  codex: PrincipalBackendView;
}

/** The task page's copy of `BACKEND_LABEL` (shared/text/backend-label.ts),
 *  which the execution profile reads through `backendLabelOf`: ruling 457
 *  keeps the shared one's chunk off the task page (why: that file). */
const BACKEND_LABEL = {
  claude: "Claude",
  codex: "Codex",
} satisfies Record<ViewBackend, string>;

/** Ruling 92: the label is "Claude", never "Claude Code". */
export function backendLabelOf(backend: ViewBackend): string {
  return BACKEND_LABEL[backend];
}

/**
 * Why a run on this backend would refuse right now, or `null` when it would
 * start. `viewerId` decides the voice: the owner reading their own task gets
 * the store's second-person sentence (the one that also names a wiped runtime
 * volume); anyone else gets the third-person sentence that names the owner and
 * what THEY have to do, because "connect it on your Profile" is false advice
 * for a teammate.
 */
export function backendRunRefusal(
  principal: TaskRunPrincipalView | null,
  backend: ViewBackend,
  viewerId: string,
): string | null {
  const label = BACKEND_LABEL[backend];
  if (!principal) {
    return (
      "Own this task to run agents. Agent runs use the task owner's accounts, " +
      "and this task has none."
    );
  }
  const health = principal[backend];
  if (health.available) return null;
  if (principal.ownerUserId === viewerId) {
    // The store's own sentence already says what to do and, on a wiped runtime
    // volume, that the sign-in file is what went missing. Restating it here
    // would give the same person two versions of one fact.
    return (
      (health.detail ??
        `${label} isn't connected. Connect it on your Profile → Agent accounts.`) +
      " Runs on this task use your own account."
    );
  }
  return (
    `${label} isn't connected for ${principal.ownerName}, the task owner. ` +
    `Runs on this task use the owner's account: they can connect ${label} ` +
    "on Profile → Agent accounts."
  );
}

/** The compact mark for a list row, where a full sentence does not fit (the
 *  agent selector's row marks, the mention menu's sub-line). Same two states as
 *  the sentence above, so a row and the control under it cannot disagree. */
export function backendRunMark(
  principal: TaskRunPrincipalView | null,
  backend: ViewBackend,
): string | null {
  if (!principal) return "no task owner";
  if (principal[backend].available) return null;
  return `${BACKEND_LABEL[backend]} not connected for ${principal.ownerName}`;
}
