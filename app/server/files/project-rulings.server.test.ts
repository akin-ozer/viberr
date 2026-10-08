import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeProject, type TestStore } from "../../../test-support/test-store";
import { deployDeliveryOperator } from "../../../test-support/delivery-operator";
import { readProjectFile } from "~/server/files/project-writer.server";
import { projectRulingsKb, withProjectRulings } from "./project-rulings.server";

/**
 * Ruling 239 (pass 37): the project's rulings knowledge base reaches every run
 * the project makes, whether or not any profile grants it.
 *
 * The unit under test is deliberately tiny, because the interesting property is
 * not what it computes but WHERE it is called — three runtimes, one of which
 * (the controller) only when a project is in scope. The operator's and the
 * controller's call sites are pinned at the bottom by what they return; the
 * specialist's two (a fresh run and a resumed @mention) by the index the run
 * is handed, in `specialist-run.server.test.ts` (ruling 422) and
 * `agent-reply.server.test.ts` (ruling 239). A helper with no production
 * caller is the state this pass found that ruling's own helper in.
 */
let ctx: TestDbContext;
let store: TestStore;

function setRulings(dir: string | null): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, { ...file.parsed.frontmatter, rulingsKb: dir });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});
afterEach(() => ctx.cleanup());

describe("projectRulingsKb", () => {
  it("is null when the project names none, and trims what it names", () => {
    expect(projectRulingsKb(store.slug, { dataRoot: store.dataRoot })).toBeNull();
    setRulings("  team-rulings  ");
    expect(projectRulingsKb(store.slug, { dataRoot: store.dataRoot })).toBe("team-rulings");
    // A whitespace-only value is a value nobody meant: it would resolve to a
    // store path of nothing and inject an empty knowledge base into every run.
    setRulings("   ");
    expect(projectRulingsKb(store.slug, { dataRoot: store.dataRoot })).toBeNull();
  });

  it("is null for a project that does not exist, rather than throwing into a run", () => {
    // Every caller is on the hot path of starting a run. A missing project is
    // already refused upstream with a real message; this must not turn into a
    // second, worse error from the KB reader.
    expect(projectRulingsKb("no-such-project", { dataRoot: store.dataRoot })).toBeNull();
  });
});

describe("withProjectRulings", () => {
  it("appends the rulings KB, never displacing the profile's own grants", () => {
    setRulings("team-rulings");
    // CANARY: prepend instead of append. `readKbIndexes` emits the indexes in
    // this order, and ruling 239 reads a profile's own grants first and the
    // project's rulings last.
    expect(withProjectRulings(["mine", "inherited"], store.slug, { dataRoot: store.dataRoot })).toEqual([
      "mine",
      "inherited",
      "team-rulings",
    ]);
  });

  it("charges it once when a profile also grants it explicitly", () => {
    // The expected shape once an existing KB is promoted into this role, which
    // is what the owner asked to be possible. CANARY: drop the `includes` test
    // and the KB is injected twice against one budget.
    setRulings("team-rulings");
    expect(withProjectRulings(["team-rulings"], store.slug, { dataRoot: store.dataRoot })).toEqual([
      "team-rulings",
    ]);
  });

  it("changes nothing for a project that names none", () => {
    expect(withProjectRulings(["mine"], store.slug, { dataRoot: store.dataRoot })).toEqual(["mine"]);
    expect(withProjectRulings([], store.slug, { dataRoot: store.dataRoot })).toEqual([]);
  });
});

describe("the runtimes that build a run's knowledge call it", () => {
  it.each([
    { operator: "a deployed", deployed: true, deploy: () => deployDeliveryOperator(store, "supervised") },
    // No operator deployed: `runOperator` still runs one (the Run operator
    // control, a schedule, boot recovery, the controller), with no grants.
    { operator: "an undeployed", deployed: false, deploy: () => {} },
  ])("$operator operator reads it through its resolved authority", async ({ deployed, deploy }) => {
    // So every consumer of `authority.kb` gets it, not just the prompt builder.
    deploy();
    setRulings("team-rulings");
    const { resolveOperatorAuthority } = await import("~/server/tasks/operator-authority.server");
    const authority = resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug);
    expect(authority.deployed).toBe(deployed);
    // CANARY: build either branch's `kb` without `withProjectRulings` (the
    // deployed `view.resources.kb`, the undeployed `[]`) and that operator's
    // list loses the project's rulings; leave its `rulingsKb` null and its
    // index no longer says they bind (ruling 286).
    expect(authority.kb).toContain("team-rulings");
    expect(authority.rulingsKb).toBe("team-rulings");
  });

  it("the controller reads it when scoped to the project, and NOT when instance-scoped", async () => {
    const { saveKnowledgeBase } = await import("~/server/org/resources.server");
    const saved = await saveKnowledgeBase(
      store.db,
      { name: "Team rulings", refresh: "on change" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    const { writeFileSync } = await import("node:fs");
    const { kbDirPath } = await import("~/server/files/file-store-root.server");
    const marker = "LOCKFILE IS DERIVED, NOT SEPARATELY OWNED";
    // Ruling 283: the prompt carries the INDEX — the doc's name and its
    // headings — so the marker has to live where an index can carry it.
    writeFileSync(`${kbDirPath(saved.kb.dir, store.dataRoot)}/rulings.md`, `# ${marker}\n\nbody\n`);
    setRulings(saved.kb.dir);

    const { buildControllerSystemPrompt } = await import(
      "~/server/controller/controller-run.server"
    );
    const { resolveControllerConfig } = await import(
      "~/server/controller/controller-profile.server"
    );
    const { createConversation } = await import(
      "~/server/controller/controller-conversations.server"
    );
    const user = { ...store.users.arda, orgRole: "admin" as const };
    // Built in statements, not a conditional spread: an ABSENT `projectSlug`
    // is the instance-scoped conversation, which is the case under test.
    const newConversation = (projectSlug: string | null) => {
      const base = { userId: user.id, userLabel: user.email };
      return projectSlug
        ? createConversation(store.db, { ...base, projectSlug })
        : createConversation(store.db, base);
    };
    const promptFor = (projectSlug: string | null) =>
      buildControllerSystemPrompt({
        conversation: newConversation(projectSlug),
        user,
        config: resolveControllerConfig(store.dataRoot),
        mountedMcps: [],
        unresolvedMcps: [],
        toolkit: [],
        deniedTools: [],
        dataRoot: store.dataRoot,
      }).prompt;

    // CANARY: replace the `input.conversation.projectSlug` condition with
    // `false` and the scoped prompt loses the rulings text.
    expect(promptFor(store.slug)).toContain(marker);
    // An instance-scoped conversation belongs to no project and must not
    // inherit one project's rules. CANARY: drop the condition entirely and
    // this one gains them.
    expect(promptFor(null)).not.toContain(marker);
  });
});
