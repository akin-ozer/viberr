import { writeProject, type TestStore } from "./test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";

/**
 * Deploy ONLY the operator on `store`'s project, with a direct
 * `deliver-review-pr` grant, repo `akin-ozer/viberr` and the given autonomy on
 * its definition, then re-project. The delivery tests' operator (R18-2's
 * full-autonomy re-queue, F19-1's supervised next step). It loads
 * `test-store.ts` first, in the order its adopters import the three.
 */
export function deployDeliveryOperator(
  store: TestStore,
  autonomy: "full" | "supervised",
): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
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
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}
