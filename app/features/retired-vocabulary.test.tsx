import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createTestDbContext } from "../../test-support/test-db";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { seedOrgResources } from "~/server/org/org-seed.server";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import {
  OperatorRecommendations,
  type RecommendationView,
} from "./task-detail/operator-recommendations";

/**
 * F19-12, the residuals.
 *
 * D9/Q17-5 retired "primary specialist": a task has ENGAGEMENTS, and the actor
 * that implements the stage work is the **delivering agent** — the name the UI
 * already ships in the execution profile's section header, the "Assign
 * delivering agent" menu, the GitHub panel's deliver button and the operator's
 * own recommendation text. F19-12 landed the four RENDERED sites and stopped
 * there, which left the term alive in the places nothing renders and nothing
 * scanned:
 *
 *  - the developer SKILL doc, mounted natively into every developer run — the
 *    substantive one, because it TEACHES the retired model to the agent that
 *    then speaks it back into the timeline;
 *  - the seeded "Task contract" KB doc, read by agents and by humans in the org
 *    resources panel;
 *  - the workflow template's `ready → impl` rationale, which is rendered on the
 *    Policy page AND persisted verbatim into every new `project.md`;
 *  - the operator-recommendation chip, sitting one row below the chip that
 *    already said "Delivering agent" for the same actor.
 *
 * Each case asserts the SHIPPED artifact — the seeded file on disk, the exported
 * constant, the rendered HTML — not the source line, so a fix that never reaches
 * a run, a store, or a screen cannot pass. Every case also pins the surrounding
 * copy, so "the sentence was deleted" and "the sentence was fixed" are not the
 * same green.
 *
 * `app/features/copy-ban.test.ts` is the sibling gate for the OTHER banned
 * vocabulary ("govern*"); this file is deliberately separate because the two
 * bans have different scopes — "govern*" is exempt in agent prompt text, and
 * "primary specialist" is at its WORST there.
 */

const RETIRED = /primary specialist/i;
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("F19-12 residuals: the retired 'primary specialist' vocabulary", () => {
  const ASSETS = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../server/seed/assets",
  );

  it("no seeded agent asset teaches the retired model", () => {
    const md = readdirSync(ASSETS)
      .filter((f) => f.endsWith(".md"))
      .sort();
    // Non-vacuity: the sweep must be looking at the real asset set, including
    // the file the finding was found in.
    expect(md).toContain("developer-expertise.skill.md");
    expect(md).toContain("reviewer-expertise.skill.md");
    expect(md.length).toBeGreaterThan(3);
    const offenders = md.filter((f) =>
      RETIRED.test(readFileSync(path.join(ASSETS, f), "utf8")),
    );
    expect(
      offenders,
      `seeded agent copy teaches the retired "primary specialist" model — these ` +
        `files are mounted into real runs, so the agent learns it and speaks it ` +
        `back into the timeline`,
    ).toEqual([]);
  });

  it("the developer skill MOUNTED into a run names the delivering agent", () => {
    // The asset sweep above proves the source is clean; this proves the copy
    // that actually reaches the run is the fixed one.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const skill = readFileSync(
      path.join(dataRoot, "skills", "developer-expertise", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain(
      "You are the **delivering agent** for the task while you hold it",
    );
    expect(skill).not.toMatch(RETIRED);
  });

  it("the seeded Task-contract KB doc names the delivering agent", () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    seedOrgResources(db, { dataRoot });
    const doc = readFileSync(
      path.join(kbDirPath("api-contracts", dataRoot), "schemas", "task-contract.md"),
      "utf8",
    );
    // Non-vacuity: the doc really is the task contract, and it really does
    // enumerate the task's actors — so "no match" means fixed, not missing.
    expect(doc).toContain("# Task contract");
    expect(doc).toContain("one human owner, one delivering agent, 0..n reviewers");
    expect(doc).not.toMatch(RETIRED);
  });

  it("the workflow template persisted into every new project.md names the delivering agent", () => {
    // `GOVERNED_TEMPLATE.workflow[].by` is BOTH rendered (the Policy page's
    // transition table) and written verbatim into `project.md` at create time,
    // so this string ships twice over.
    const by = GOVERNED_TEMPLATE.workflow.map((w) => w.by);
    expect(by.length, "the template must still declare its transitions").toBe(4);
    for (const b of by) expect(b.length).toBeGreaterThan(10);
    const readyToImpl = GOVERNED_TEMPLATE.workflow.find(
      (w) => w.from === "ready" && w.to === "impl",
    )!;
    expect(readyToImpl.by).toMatch(/delivering agent/);
    expect(
      by.filter((b) => RETIRED.test(b)),
      "a new project's stored workflow rationale must not ship retired vocabulary",
    ).toEqual([]);
    // Stage names and the preset label travel with it onto the same page.
    expect(GOVERNED_TEMPLATE.label).not.toMatch(RETIRED);
    for (const s of GOVERNED_TEMPLATE.stages) expect(s.name).not.toMatch(RETIRED);
  });

  it("no operator-recommendation chip renders 'specialist' at all", () => {
    // The chip labels are a Record keyed by recommendation kind, and the KINDS
    // are still `assign_specialist` / `run_specialist` — internal ids nobody
    // reads. Rendering EVERY kind is the completeness half: a new kind that
    // reintroduces the word fails here, and so does a revert of either row.
    const kinds: RecommendationView["kind"][] = [
      "assign_specialist",
      "assign_reviewer",
      "run_specialist",
      "run_reviewer",
      "transition",
      "accept_completion",
      "delivery",
    ];
    const recommendations: RecommendationView[] = kinds.map((kind, i) => ({
      id: `r${i}`,
      kind,
      // Deliberately neutral: a label containing "delivering agent" would make
      // the assertions below pass on the FIXTURE rather than on the chip.
      label: `VIB-${i}`,
      detail: "",
    }));
    const html = renderToString(
      <OperatorRecommendations
        recommendations={recommendations}
        canApply
        busy={false}
        onApply={() => {}}
        onDismiss={() => {}}
      />,
    );
    // Non-vacuity: every card rendered, and the chips are really in the output.
    for (const r of recommendations) expect(html).toContain(r.label);
    expect(html).toContain("Delivering agent"); // assign_specialist
    expect(html).toContain("Run delivering agent"); // run_specialist
    expect(html).toContain("Run reviewer");
    expect(
      /specialist/i.test(html),
      `an operator-recommendation chip still renders "specialist" — the panel ` +
        `calls this actor the delivering agent one row above`,
    ).toBe(false);
  });
});
