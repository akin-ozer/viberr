/**
 * Ruling 531: how the operator scopes and delivers a task whose deliverable is
 * a result rather than a change to the repository, the task a board that
 * delivers results is made of (ruling 530).
 *
 * Nothing told the operator about such a task. Its triage gate asks for "what
 * changes, and where" and reads the repository first, and its delivery rule
 * delivers whatever the deliverer committed. Live on aws-cost-calculator, the
 * CALC-4 pilot estimate was committed under `estimates/CALC-4/` and delivered
 * as PR #4 (its goal, written before ruling 530, said "on the task branch"),
 * so accepting the estimate would have merged it into the repository.
 *
 * This is the rules' one home. The operator's turn prompt carries both
 * (`triageQualityGate` and `stageRule` in operator-run.server.ts), the shipped
 * operator doctrine quotes them word for word, and
 * `default-assets.server.test.ts` holds the doctrine to them.
 */

/** When a results task's goal is concrete: the triage quality gate's clause. */
export const RESULT_GOAL_RULE =
  "A task whose deliverable is a result rather than a change to the repository (an estimate, a report, a dataset made from what a person gave; its goal and the project's rulings say which) is concrete when it names the result, the files it comes back in on this task, and the reviewer whose approval proves it. " +
  "Scope such a task from its goal, the rulings and the files attached to it, not from the repository.";

/** How a results task is delivered: the delivery rule's exception. */
export const RESULT_DELIVERY_RULE =
  "A task whose deliverable is a result is delivered on the task, never in a pull request: the files its delivering agent saves there ARE the delivery, what its reviewers judge and what the person accepts. " +
  "Hand delivery to the agent that makes the result (`run_agent` with `delivers: true`), direct it to post the result on the task and commit nothing, and never call `deliver_for_review` for it, even when it committed something: " +
  "a pull request would put the person's result into the repository, and accepting the task would merge it.";
