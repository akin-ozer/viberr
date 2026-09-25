import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import { cardStatus } from "~/features/board/card-status";

/**
 * Ruling 476(g) and (h) through the project Controller page's own loader
 * (pass 40, F40-56 and F40-61): a started chain link says what the board's
 * card for its task says, and a chain names the conversation that planned it
 * to a viewer who may open that conversation.
 */

let app: AppTestContext;
let arda: string; // org admin + project admin on viberr-core
let murat: string; // maintainer on viberr-core
let selin: string; // contributor on viberr-core
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  arda = userIds.arda;
  murat = userIds.murat;
  selin = userIds.selin;
});
afterAll(() => app.cleanup());

function loaderArgs(path: string, cookie: string, pattern: string) {
  const request = app.request(path, { cookie });
  return { request, url: new URL(request.url), params: { slug: SLUG }, pattern, context: new RouterContextProvider() };
}

async function controllerPage(userId: string) {
  const { loader } = await import("~/routes/project.controller");
  const { cookie } = await app.cookieFor(userId);
  return (await loader(loaderArgs(`/projects/${SLUG}/controller`, cookie, "/projects/:slug/controller"))).view;
}

async function boardCards(userId: string) {
  const { loader } = await import("~/routes/project.board");
  const { cookie } = await app.cookieFor(userId);
  const board = await loader(loaderArgs(`/projects/${SLUG}/board`, cookie, "/projects/:slug/board"));
  return [...board.columns.flatMap((c) => c.tasks), ...board.orphanTasks];
}

async function chain(userId: string, label: string, title: string, conversationId: string | null = null) {
  const { createGoal } = await import("~/server/tasks/goal-actions.server");
  return createGoal(
    app.db,
    {
      projectSlug: SLUG,
      title,
      links: [{ title: "Only link", goal: "Do the one thing. Done when it exists." }],
      conversationId,
    },
    { userId, label },
    { dataRoot: app.dataRoot },
  );
}

describe("ruling 476: the Goals rail reads the board and the planning conversation", () => {
  it("(g) a started link carries the board card's status word for its task", async () => {
    const made = await chain(arda, "arda@viberr.dev", "Rail says what the board says");
    const view = await controllerPage(arda);
    const link = view.goals?.find((g) => g.id === made.goalId)?.links[0];
    expect(link?.status).toBe("active");
    expect(link?.taskKey).toBeTruthy();
    const card = (await boardCards(arda)).find((t) => t.key === link!.taskKey);
    const expected = cardStatus(card!);
    expect(expected).not.toBeNull();
    // CANARY: drop `taskStatuses` from the project Controller loader and the
    // link says the chain's "active" in the agent colour whatever its card says.
    expect(link?.taskStatus).toEqual({
      kind: expected!.kind,
      label: expected!.label,
      resumesAt: expected!.resumesAt ?? null,
    });
  });

  it("(h) a chain names the conversation that planned it, to its owner and an org admin only", async () => {
    const { createConversation } = await import("~/server/controller/controller-conversations.server");
    const planning = createConversation(app.db, { userId: murat, userLabel: "murat@viberr.dev", projectSlug: null });
    const made = await chain(murat, "murat@viberr.dev", "Planned at instance scope", planning.id);
    const expected = {
      id: planning.id,
      title: "New conversation",
      href: `/controller?c=${planning.id}`,
      scopeLabel: "Instance",
    };
    // CANARY: drop `plannedIn` from `projectGoals` and neither of these holds.
    const mine = await controllerPage(murat);
    expect(mine.goals?.find((g) => g.id === made.goalId)?.plannedIn).toEqual(expected);
    expect(mine.plannedElsewhere).toEqual([{ ...expected, goalIds: [made.goalId] }]);
    // An org admin may open anyone's conversation (ruling 100).
    const admin = await controllerPage(arda);
    expect(admin.goals?.find((g) => g.id === made.goalId)?.plannedIn).toEqual(expected);
    // A member who did not have the conversation is shown no link and no title.
    const other = await controllerPage(selin);
    expect(other.goals?.find((g) => g.id === made.goalId)?.plannedIn).toBeUndefined();
    expect(other.plannedElsewhere).toEqual([]);
  });
});
