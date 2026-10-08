import { reconfigureProject } from "./projected-store";
import type { TestStore } from "./test-store";

/**
 * Deploy ONLY the operator on `store`'s project, with a direct
 * `deliver-review-pr` grant, repo `akin-ozer/viberr` and the given autonomy on
 * its definition, then re-project. The delivery tests' operator (R18-2's
 * full-autonomy re-queue, F19-1's supervised next step). Through
 * `projected-store.ts` it loads `test-store.ts` first, as its adopters do.
 */
export function deployDeliveryOperator(
  store: TestStore,
  autonomy: "full" | "supervised",
): void {
  reconfigureProject(store, {
    repo: "akin-ozer/viberr",
    agents: [
      {
        profileId: "operator",
        capabilities: [{ capabilityId: "deliver-review-pr", mode: "direct" }],
        extras: [],
        definition: {
          kind: "operator",
          name: "Operator",
          backends: ["claude"],
          model: "sonnet",
          autonomy,
        },
      },
    ],
  });
}
