import type { DeliveryOutcome } from "~/server/tasks/task-actions.server";

/**
 * Ruling 134(a): every human door that performs a delivery says what moved
 * through ONE toast. The task page's Deliver / Push control and an applied
 * `delivery` recommendation both come through here, so a person is never told
 * "Delivered" for a push that moved nothing, and never left in the dark after
 * applying the operator's card.
 */
export function deliveryToast(outcome: DeliveryOutcome): string {
  if (outcome.status !== "delivered") {
    return `Delivery did not complete: ${outcome.message}`;
  }
  const sha = outcome.headSha ? ` \`${outcome.headSha.slice(0, 7)}\`` : "";
  if (outcome.created) return `Delivered · opened review PR #${outcome.prNumber}`;
  if (outcome.moved) return `Delivered · pushed${sha} to PR #${outcome.prNumber}`;
  return `PR #${outcome.prNumber} already carries${sha || " the delivered revision"} · nothing to push`;
}
