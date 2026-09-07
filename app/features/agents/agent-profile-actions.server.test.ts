import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { saveGlobalAgentProfile } from "~/server/org/gagents.server";
import { deployAgentProfileFromLibrary } from "./agent-profile-actions.server";

/**
 * Ruling 153 (pass 35, G35-2): a template carries a default `effort`, and a
 * library deploy takes it when no override is given (an override still wins;
 * a tier the backend does not offer falls back to the backend default).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("deployAgentProfileFromLibrary takes the template's effort (ruling 153)", () => {
  it("writes the template's effort to project.md when no override is given", async () => {
    const store = setupTestStore(ctx);
    seedDefaultAgentAssets(store.dataRoot);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const arda = { userId: store.users.arda.id, label: store.users.arda.email };
    await saveGlobalAgentProfile(
      store.db,
      {
        id: "developer",
        name: "Developer",
        backend: "claude",
        summary: "Implements the change.",
        persona: "",
        stages: ["ready", "impl"],
        effort: "max",
      },
      arda,
      { dataRoot: store.dataRoot },
    );
    // Canary: restore `effort: effortOverride || defaultEffortFor(backend)`
    // and this reads the Claude default ("high").
    const deployed = await deployAgentProfileFromLibrary(
      store.db,
      { projectSlug: store.slug, profileId: "developer" },
      arda,
      { dataRoot: store.dataRoot },
    );
    expect(deployed.applied?.effort).toBe("max");
    const copy = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.agents.find((a) => a.profileId === "developer")!;
    expect(copy.definition?.effort).toBe("max");

    // An explicit override still wins.
    const overridden = await deployAgentProfileFromLibrary(
      store.db,
      { projectSlug: store.slug, profileId: "reviewer", effort: "low" },
      arda,
      { dataRoot: store.dataRoot },
    );
    expect(overridden.applied?.effort).toBe("low");
  });
});
