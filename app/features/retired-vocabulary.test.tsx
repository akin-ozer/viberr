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
import { AgentStats, LiveRoster, ProfileDetail } from "./agents/agents-page";
import { CapabilityMatrixModal } from "./agents/capability-matrix-modal";
import type { AgentProfileView, MatrixProfile } from "./agents/agent-types";
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
    // The chip labels are a Record keyed by recommendation kind. The dynamic-
    // dispatch rework (2026-08-29) collapsed the four slot-shaped kinds
    // (`assign_specialist` and friends) into one `run_agent`, so the retired
    // noun lost the internal ids it used to ride in on — but rendering EVERY
    // kind stays the completeness half: a new kind that reintroduces the word
    // fails here, and so does a revert of any label row.
    const kinds: RecommendationView["kind"][] = [
      "run_agent",
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
    expect(html).toContain("Run agent"); // run_agent
    expect(html).toContain("Delivery"); // delivery
    expect(
      /specialist/i.test(html),
      `an operator-recommendation chip still renders "specialist" — the panel ` +
        `calls this actor an agent everywhere else`,
    ).toBe(false);
  });
});

/**
 * U12 — the same class one page over.
 *
 * Pass 20's C11 fix landed the group label and the create button on the Agents
 * page, and the page's own comment declares *"The old 'specialist' vocabulary is
 * dropped below so one object stops carrying three names one click apart."* Two
 * RENDERED strings on that page were missed: the live-roster empty state ("When
 * an operator or specialist is running on a task…") and the stat label
 * ("specialists in a working state"). The gate above could not catch them — its
 * regex is `/primary specialist/i`, so the bare noun walked through — which is
 * exactly rulings 54/57: a claim that lives in a comment is a claim nobody
 * re-derives.
 *
 * These render the two components and read the HTML, for the same reason every
 * case above asserts a shipped artifact: a fix that never reaches a screen is
 * not a fix. `BARE` is the noun in isolation — internal ids (`assign_specialist`,
 * `SPECIALIST_CAP_MODES`) are not rendered copy and are none of this gate's
 * business.
 */
const BARE_SPECIALIST = /\bspecialists?\b/i;

describe("U12: the Agents page's rendered 'specialist' nouns", () => {
  it("the live-roster empty state names agent profiles, not specialists", () => {
    const html = renderToString(<LiveRoster deployments={[]} onOpen={() => {}} />);
    // Non-vacuity: this really is the empty state, and it still orients (D8).
    expect(html).toContain("No agents are currently engaged");
    expect(html).toContain("Open a task and run the operator to engage one");
    expect(
      BARE_SPECIALIST.test(html),
      `the live-roster empty state still renders "specialist" — the page it ` +
        `sits on calls these agent profiles`,
    ).toBe(false);
  });

  it("the run-in-flight stat counts agent threads, not specialists", () => {
    const html = renderToString(
      <AgentStats profiles={3} operators={1} running={2} waiting={1} />,
    );
    // Non-vacuity: all four counters rendered, so a missing label would fail
    // rather than pass by absence. The third and fourth labels are F34-5's:
    // the count is runs in flight (not "a working state" read off the task's
    // waiting flag) and the waiting is the task's.
    expect(html).toContain("profiles approved · incl. operator");
    expect(html).toContain("tasks with a live operator");
    expect(html).toContain("agent threads with a run in flight");
    expect(html).toContain("agent threads on tasks waiting on a human · this project");
    expect(
      BARE_SPECIALIST.test(html),
      `the Agents stat row still renders "specialist" — the objects it counts ` +
        `are agent profiles, engaged per task as delivering or supporting`,
    ).toBe(false);
  });

  /**
   * U12 residual — the two places the noun outlived the page's own sweep.
   *
   * 1. The CAPABILITY MATRIX modal. It is opened from both the Agents page and
   *    the Policy page, and its runtime-differences notes are the longest piece
   *    of prose in the product ("A Claude specialist runs with Claude Code's
   *    coding harness…", "Specialist processes share the host…"). Nothing had
   *    ever rendered this modal's copy in a test, which is precisely how it
   *    survived: the fix above landed on the two components a gate could reach.
   *
   * 2. The role-less profile CARD. `profileRoleLabel` falls back to "what the
   *    profile IS on this board" whenever the stored role is empty or merely
   *    repeats the name (P14-WL-05) — and that fallback literal was
   *    "Specialist", so the retired noun was the hero pill, the roster row and
   *    the glyph tooltip of every profile deployed from a template with no
   *    `role` in its frontmatter. The roster's own `role` default carried the
   *    same literal (`effectiveProfileView`), so a card could not repair it.
   */
  const matrixProfiles: MatrixProfile[] = [
    {
      id: "operator",
      kind: "operator",
      name: "Operator",
      icon: "shield",
      backends: ["claude"],
      capabilities: [],
      actions: {
        // The seeded operator's post-rework grant wording (dispatch-agents).
        direct: ["Select & run agents"],
        recommend: ["Stage transitions"],
        forbidden: ["Transition a task to Done"],
      },
    },
    {
      id: "developer",
      kind: "specialist",
      name: "Developer",
      icon: "branch",
      backends: ["claude"],
      capabilities: [],
      actions: {
        direct: ["Commit & push to the branch"],
        recommend: [],
        forbidden: ["Merge a pull request"],
      },
    },
  ];

  it("the capability matrix modal explains the backends without the retired noun", () => {
    const html = renderToString(
      <CapabilityMatrixModal
        profiles={matrixProfiles}
        projectName="Viberr Core"
        onClose={() => {}}
      />,
    );
    // Non-vacuity: the modal really rendered, the runtime-differences notes are
    // really in it, and the sentence that carried the noun still SAYS the thing
    // it was there to say (a deleted sentence is not a fixed one).
    expect(html).toContain("Capability matrix");
    expect(html).toContain("What differs between the two runtimes");
    expect(html).toContain("An agent profile running on");
    expect(html).toContain("gets the persona alone");
    // V11-1 (pass 32): the intro states ruling 101 — the write family binds on
    // both backends (Codex via the read-only sandbox) with the one disclosed
    // carve-out; "not process-sandboxed" was pre-parity copy.
    expect(html).toContain("Codex runs a read-only sandbox");
    expect(html).toContain("advisory on Codex");
    expect(html).not.toContain("not process-sandboxed");
    expect(
      BARE_SPECIALIST.test(html),
      `the capability matrix still renders "specialist" — its own rows are the ` +
        `agent profiles the Agents page names, engaged per task as delivering ` +
        `or supporting`,
    ).toBe(false);
  });

  const roleless = (patch: Partial<AgentProfileView>): AgentProfileView => ({
    fingerprint: "fp-fixture",
    templateDrift: null,
    id: "docs-writer",
    kind: "specialist",
    name: "Org Docs Writer",
    // The case P14-WL-05 describes: the library deploy writes
    // `role: fm.role || fm.name`, so a template with no frontmatter `role`
    // lands here with an empty one (or with its own name echoed back).
    role: "",
    icon: "file",
    backends: ["claude"],
    model: "sonnet",
    modelLabel: "Claude Sonnet",
    modelKnown: true,
    effort: "",
    scope: "Global base",
    customized: false,
    desc: "Writes and maintains the docs that ship with a change.",
    definition: "",
    stages: ["impl"],
    spanAll: false,
    actions: { direct: [], recommend: [], forbidden: [] },
    capabilities: [],
    extras: [],
    resources: { skills: [], mcps: [], kb: [] },
    source: "template",
    ...patch,
  });

  it("a profile card with no usable role names an agent profile, not a specialist", () => {
    const card = (patch: Partial<AgentProfileView>) =>
      renderToString(
        <ProfileDetail
          a={roleless(patch)}
          stages={[{ id: "impl", name: "In Progress", color: "#7b61ff" }]}
          workflow={[{ from: "impl", to: "review" }]}
          insts={[]}
          projectName="Viberr Core"
          canManage
          onOpen={() => {}}
          onDelete={() => {}}
          onEdit={() => {}}
        />,
      );

    for (const [why, patch] of [
      ["an empty stored role", {}],
      // A role that only repeats the name carries no information either, and
      // takes the same fallback.
      ["a role echoing the name", { role: "Org Docs Writer" }],
    ] as const) {
      const html = card(patch);
      // Non-vacuity: the card rendered, and the fallback label really is what
      // filled the role pill (so this is the fallback path, not an absent one).
      expect(html, why).toContain("Org Docs Writer");
      expect(html, why).toContain("Agent profile");
      expect(
        BARE_SPECIALIST.test(html),
        `a profile card with ${why} still renders "specialist" — the sidebar ` +
          `it sits beside groups these under "Agent profiles"`,
      ).toBe(false);
    }
  });
});
