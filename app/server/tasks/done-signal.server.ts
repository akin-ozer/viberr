/**
 * Ruling 492 (pass 40, F40-69): what a task's done signal can be.
 *
 * Acceptance merges the task's PR and moves it to Done in one write
 * (`acceptCompletion`, task-actions.server.ts), and the owner declined a
 * post-merge Verify stage (F40-64): a proof only the merged code can show goes
 * in a follow-up task. Nothing told a goal's author either fact, so goals kept
 * asking for such a proof, and each needed a person to rewrite the goal, or an
 * extra packet, before it could ever finish: the operator's `create_task`
 * option on WEB-16 ("Done when, after the merge and the Workers Builds deploy,
 * a read-only post-merge read … shows …"), WEB-13's goal, and the controller's
 * goal-1 links 9 and 11 (WEB-12, WEB-7).
 *
 * This is the rule's one home. Every door that writes a goal carries it in the
 * goal field's description: the controller's `create_task`, `update_task`,
 * `create_goal` (each link) and `update_goal` (`add_link`, `edit_link`), and
 * the operator's `set_goal`, `edit_goal` option (`goalDraft`) and `create_task`
 * option (`newTask.goal`), on the Claude toolkit and in the Codex plan schema.
 * The shipped controller guide and operator doctrine quote it word for word,
 * and `default-assets.server.test.ts` holds them to it. It is guidance, not a
 * gate: no door refuses a goal for the words of its done signal.
 */
export const DONE_SIGNAL_RULE =
  "Acceptance merges the task's PR and moves the task to Done in the same write, so a done signal is something the task can show BEFORE acceptance: its gates, its reviewers' verdicts, a measurement made on the branch or locally. " +
  "Anything only the merged or deployed code can show (a production deploy, a cron run on the merged code, a live page, a production log) is never this task's done signal: that proof goes in a follow-up read task that waits on this one (`blockedBy` this task's key), raised before or at this task's acceptance. " +
  "A goal link whose outcome needs such a proof is split in two: the delivery link, and a read link whose `blockedBy` names it.";
