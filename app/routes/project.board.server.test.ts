import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";
import type { SeedUserIds } from "../../test-support/demo-data";

/**
 * Route-level guard tests for /projects/:slug/board's action.
 *
 * E2 (found live): a signed-in NON-member POSTing `intent=create-task` here got
 * **403** — "Only project members can create tasks" — while the same user got a
 * 404 from every other project route and every other intent. That single outlier
 * confirmed the project exists, which is exactly what R15-4 (members-only
 * projects, WI-13 secrecy) refuses to do. The board action now runs
 * `requireVisibleProject` first, like the task and policy actions do, so the
 * refusal is the byte-identical unknown-slug 404 for all three intents.
 *
 * A member below the required tier still gets the honest 403 — the project is
 * not a secret from its own members.
 */

let app: AppTestContext;
/**
 * The seeded people these cases POST as: arda is project admin, selin a
 * contributor, deniz a non-member.
 */
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
});
afterAll(() => app.cleanup());

/**
 * A guard refuses by THROWING React Router's `data(message, { status })`, so
 * the rejection reaches the test untyped and is parsed where it lands.
 */
const thrownRefusalSchema = z.object({
  data: z.unknown(),
  init: z.object({ status: z.number() }).nullish(),
});

/** Un-interpolated match pattern, the way React Router reports it. */
const BOARD_PATTERN = "/projects/:slug/board";

type BoardActionResult = Awaited<
  ReturnType<typeof import("~/routes/project.board").action>
>;

async function post(
  slug: string,
  userId: string,
  fields: Record<string, string>,
): Promise<BoardActionResult> {
  const { action } = await import("~/routes/project.board");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const request = app.request(`/projects/${slug}/board`, {
    method: "POST",
    cookie,
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  });
  return action(routeArgs(request, { slug }, BOARD_PATTERN));
}

/**
 * The action answers on one of two envelopes: a bare success object, or
 * `data(payload, init)`. A case that reads a single member reads it through
 * this projection — a member the actual branch does not carry comes back
 * `undefined` and fails its assertion, rather than being asserted into
 * existence.
 */
function reply(result: BoardActionResult) {
  return {
    status: "init" in result ? result.init?.status : undefined,
    error: "data" in result ? result.data.error : undefined,
  };
}

const INTENTS: Record<string, string>[] = [
  { intent: "create-task", title: "Probe", goal: "a goal long enough to pass" },
  { intent: "reorder", taskKey: "VIB-142", to: "impl", beforeKey: "" },
  { intent: "rescan" },
  { intent: "no-such-intent" },
];

describe("board action — a non-member never learns the project exists (E2)", () => {
  for (const fields of INTENTS) {
    it(`${fields.intent}: refused as an unknown slug, not forbidden`, async () => {
      const thrown: unknown = await post("viberr-core", ids.deniz, fields).catch(
        (e) => e,
      );
      const refusal = thrownRefusalSchema.parse(thrown);
      expect(refusal.init?.status).toBe(404);
      expect(String(refusal.data)).toBe("No project at projects/viberr-core.");
    });
  }

  it("a MEMBER below the required tier still gets the honest 403", async () => {
    // The secrecy rule is about non-members. Selin is a contributor here, so she
    // may open the board and must be told plainly why she cannot reorder it —
    // turning THAT into a 404 would be a different lie.
    const result = reply(
      await post("viberr-core", ids.selin, {
        intent: "reorder",
        taskKey: "VIB-142",
        to: "impl",
        beforeKey: "",
      }),
    );
    expect(result.status).toBe(403);
    expect(result.error).toMatch(
      /role \(contributor\) cannot reorder the board/i,
    );
  });
});

/**
 * F21-2 / ruling 97 — the board's drop on the FINAL column is an acceptance.
 *
 * `reorderTask` routes a move into the terminal stage through the full
 * acceptance contract (→ `transitionStage` → `acceptCompletion` — the real,
 * irreversible merge), and the board fronts it with the shared
 * `AcceptConfirm` ceremony (ruling 97, R18-7). The POST behind that
 * ceremony carried nothing back from it: a drag whose confirmation was never
 * rendered — a stale tab, a replayed form, a script — merged to the default
 * branch on an unadorned request. The ordinary column move above (`to: "impl"`,
 * which the 403 case exercises) is the counterweight: only a move that IS an
 * acceptance is held to the ceremony.
 */
describe("board reorder — the acceptance disclosure (ruling 97)", () => {
  it("refuses a drop on the terminal column that carries no acknowledgment", async () => {
    // SAFETY: arda is the project admin, so `reorder-board` and the acceptance
    // authority both pass — the refusal that answers is the disclosure.
    const result = reply(
      await post("viberr-core", ids.arda, {
        intent: "reorder",
        taskKey: "VIB-142",
        to: "done",
        beforeKey: "",
      }),
    );
    expect(result.status).toBe(400);
    expect(result.error).toContain("accept from the dialog");
  });

  it("refuses a drop whose acknowledgment no longer matches the task", async () => {
    // The card was dragged from a board rendered against an earlier state
    // (R17-1 drift): the echo names a delivered revision the task does not
    // carry, so nothing is accepted and nothing is merged.
    const result = reply(
      await post("viberr-core", ids.arda, {
        intent: "reorder",
        taskKey: "VIB-142",
        to: "done",
        beforeKey: "",
        ackPr: "review",
        ackRevision: "9".repeat(40),
        ackVerdict: "healthy",
      })
    );
    expect(result.status).toBe(409);
    expect(result.error).toContain("changed after the accept dialog");
  });

  it("ruling 47: a backward drop with no reason is refused by the route", async () => {
    // Runs BEFORE the move below, which lands VIB-142 on impl for good.
    const result = reply(
      await post("viberr-core", ids.arda, {
        intent: "reorder",
        taskKey: "VIB-142",
        to: "impl",
        beforeKey: "",
      }),
    );
    expect(result.status).toBe(400);
    expect(result.error).toContain("needs a reason");
  });

  it("an ordinary column move needs no acceptance echo", async () => {
    // Same intent, a non-terminal target: no acceptance, no ceremony, no echo.
    // It carries a ruling 47 reason because the drop is backward, which is a
    // different rule with a different shape (a sentence, not three fields).
    const result = await post("viberr-core", ids.arda, {
      intent: "reorder",
      taskKey: "VIB-142",
      to: "impl",
      beforeKey: "",
      reason: "the retry path is still unhandled",
    });
    expect(reply(result).status).toBeUndefined();
    expect("stage" in result ? result.stage : null).toBe("impl");
  });
});

describe("create-task carries the metadata fields from the form", () => {
  it("persists priority, labels (trimmed + deduped) and due date", async () => {
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const result = await post("viberr-core", ids.arda, {
      intent: "create-task",
      title: "Metadata probe",
      goal: "a goal long enough to pass the floor",
      priority: "high",
      labels: "runtime, github, runtime",
      dueDate: "2026-09-15",
    });
    const key = z.object({ key: z.string() }).parse(result).key;
    const fm = readTaskFile({
      projectSlug: "viberr-core",
      taskKey: key,
      dataRoot: app.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.priority).toBe("high");
    expect(fm.labels).toEqual(["runtime", "github"]);
    expect(fm.dueDate).toBe("2026-09-15");
    // urgent stays derived from priority (high is not the urgent rung).
    expect(fm.urgent).toBe(false);
  });

  it("a blank labels/due form still creates a clean task", async () => {
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const result = await post("viberr-core", ids.arda, {
      intent: "create-task",
      title: "Bare probe",
      goal: "a goal long enough to pass the floor",
    });
    // The create toast names the column the task landed in (board-page.tsx).
    expect("stageName" in result ? result.stageName : null).toBe("Triage");
    const key = z.object({ key: z.string() }).parse(result).key;
    const fm = readTaskFile({
      projectSlug: "viberr-core",
      taskKey: key,
      dataRoot: app.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.priority).toBe("normal");
    expect(fm.labels).toEqual([]);
    expect(fm.dueDate).toBeNull();
  });
});

/**
 * Ruling 76: the New task form posts its files as multipart, and the route
 * hands every one of them to `createTask`, which saves them before triage.
 */
describe("create-task carries the files the task is filed with", () => {
  it("saves each posted file on the new task", async () => {
    // CANARY: stop reading `files` in the create-task arm and the task is
    // created with no attachments.
    const { action } = await import("~/routes/project.board");
    const { listTaskAttachments } = await import("~/server/files/task-attachments.server");
    const { cookie, sessionId } = await app.cookieFor(ids.arda);
    const form = new FormData();
    form.set("_csrf", await app.csrfFor(sessionId));
    form.set("intent", "create-task");
    form.set("title", "Estimate the Contoso estate");
    form.set("goal", "Price the attached inventory.");
    form.append("files", new File(["vm,cpu\nweb01,4\n"], "inventory.csv"));
    form.append("files", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "portal.png"));
    const request = app.request("/projects/viberr-core/board", { method: "POST", cookie, body: form });
    const result = await action(routeArgs(request, { slug: "viberr-core" }, BOARD_PATTERN));
    const key = z.object({ key: z.string() }).parse(result).key;
    expect(listTaskAttachments("viberr-core", key, app.dataRoot).map((a) => a.name).sort()).toEqual([
      "inventory.csv",
      "portal.png",
    ]);
  });
});
