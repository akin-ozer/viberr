import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { saveGlobalAgentProfile } from "~/server/org/gagents.server";
import { deployAgentProfileFromLibrary } from "./agent-profile-actions.server";

/**
 * Ruling 261 (pass 35, G35-2): a template carries a default `effort`, and a
 * library deploy takes it when no override is given (an override still wins;
 * a tier the backend does not offer falls back to the backend default).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("deployAgentProfileFromLibrary takes the template's effort (ruling 261)", () => {
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

/**
 * Ruling 183 (pass 37, F37-94): a deploy reports the delivery posture it
 * actually stored.
 *
 * Ruling 177 made a library deploy COPY the template's grants, and the shipped
 * `developer` template carries `execute-code-or-write-repo: direct` — so on the
 * live instance a deploy of it produces a profile that can write the repo,
 * while `deploy_agent` answered "Delivery starts withheld; open it up with
 * update_agent_deployment when the profile should write the repo" every single
 * time. That sentence is read by the one person whose next decision (engage it
 * as the deliverer, or not) turns on the answer.
 */
describe("deployAgentProfileFromLibrary reports the delivery it stored (ruling 183)", () => {
  /** Write a global template file directly: `saveGlobalAgentProfile` has no
   *  capability field, and the grants are the whole point here. */
  function writeTemplate(dataRoot: string, id: string, repoWrite: boolean): void {
    const caps = repoWrite
      ? "capabilities:\n  - capabilityId: execute-code-or-write-repo\n    mode: direct\n"
      : "capabilities:\n  - capabilityId: report-validation-verdict\n    mode: direct\n";
    writeFileSync(
      path.join(dataRoot, "agents", "profiles", `${id}.md`),
      `---\nid: ${id}\nkind: specialist\nname: ${id}\nrole: Implementation\nbackends:\n  - claude\nmodel: sonnet\nstages:\n  - impl\nresources:\n  skills: []\n  mcps: []\n  kb: []\n${caps}---\n\nA probe.\n`,
      "utf8",
    );
  }

  it("says GRANTED for a template that carries repo write, and WITHHELD for one that does not", async () => {
    const store = setupTestStore(ctx);
    seedDefaultAgentAssets(store.dataRoot);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const arda = { userId: store.users.arda.id, label: store.users.arda.email };
    writeTemplate(store.dataRoot, "writer-probe", true);
    writeTemplate(store.dataRoot, "reader-probe", false);

    // CANARY: return a fixed "withheld" (or drop `result.delivery`) and the
    // deploy reply goes back to promising delivery is off on a profile that
    // can push to the repo the moment it is engaged.
    const writer = await deployAgentProfileFromLibrary(
      store.db,
      { projectSlug: store.slug, profileId: "writer-probe" },
      arda,
      { dataRoot: store.dataRoot },
    );
    expect(writer.delivery).toBe("granted");

    const reader = await deployAgentProfileFromLibrary(
      store.db,
      { projectSlug: store.slug, profileId: "reader-probe" },
      arda,
      { dataRoot: store.dataRoot },
    );
    expect(reader.delivery).toBe("withheld");

    // The answer is read through the predicate the RUN is gated on, so the two
    // cannot drift: the stored grants agree with the sentence.
    const { deliveryWithheld } = await import("~/server/tasks/specialist-tool-policy");
    const agents = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter.agents;
    const stored = (id: string) => agents.find((a) => a.profileId === id)!.capabilities;
    expect(deliveryWithheld(stored("writer-probe"))).toBe(false);
    expect(deliveryWithheld(stored("reader-probe"))).toBe(true);
  });
});
