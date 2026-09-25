/**
 * Ruling 492 (pass 40, F40-69): what a task's done signal can be.
 *
 * Acceptance moves the task to Done and no stage sits after it, and the owner
 * declined a post-merge Verify stage (F40-64): a proof only the merged code
 * can show goes in a follow-up task. Nothing told a goal's author either fact,
 * so goals kept asking for such a proof, and each needed a person to rewrite
 * the goal, or an extra packet, before it could ever finish: the operator's
 * `create_task` option on WEB-16 ("Done when, after the merge and the Workers
 * Builds deploy, a read-only post-merge read … shows …"), WEB-13's goal, and
 * the controller's goal-1 links 9 and 11 (WEB-12, WEB-7).
 *
 * The rule says what is true on every acceptance path (review, 2026-09-26).
 * A person's acceptance merges the PR when GitHub can merge it
 * (`acceptCompletion`), but a full-autonomy operator's never merges and
 * leaves it "accepted, merge pending" (`operatorAcceptCompletion`), and a
 * `blockedBy` wait is done when its task reaches Done, merged or not
 * (`projections/dependencies.server.ts`). So the read is created before the
 * acceptance and confirms the merge and the deploy itself. The first wording
 * said every acceptance merges in the same write, and that the read could be
 * raised "at" the acceptance, which withdraws an open decision unanswered; the
 * operator's own acceptance now waits for the answer to the read's
 * `create_task` option (`followUpOptionRefusal`, operator-actions.server.ts).
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
  "Acceptance moves the task to Done, and nothing after that happens inside the task. A person's acceptance also merges the task's PR when GitHub can merge it; a full-autonomy operator's acceptance never merges and leaves the merge to a person. " +
  "So a done signal is something the task can show BEFORE acceptance: its gates, its reviewers' verdicts, a measurement made on the branch or locally. " +
  "Anything only the merged or deployed code can show (a production deploy, a cron run on the merged code, a live page, a production log) is never this task's done signal: that proof goes in a follow-up read task that waits on this one (`blockedBy` this task's key), created before this task is accepted. " +
  "Viberr releases the read when this task reaches Done, which can be before the merge and before the deploy, so the read's goal has it confirm this task's change is merged and deployed before it reads. " +
  "A goal link whose outcome needs such a proof is split in two: the delivery link, and a read link whose `blockedBy` names it.";
