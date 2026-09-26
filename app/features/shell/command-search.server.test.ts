import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { defaultEpicColor, type EpicStatus } from "~/schemas/epic-file.schema";
import { createEpicFile } from "~/server/files/epic-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { searchWorkspace } from "./command-search.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

/**
 * R15-5 — the ⌘K palette's query. The scoping assertions matter most: the
 * palette must never surface a task, branch or agent from a project the viewer
 * cannot open (R15-4 / WI-13).
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function seed(): TestStore {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-142", {
      title: "Attach a project credential",
      stage: "review",
      branch: "vib-142-attach-credential",
    }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-9", {
      title: "Rotate the PAT",
      branch: "vib-9-rotate-pat",
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

/** Deploys ONE specialist profile into the test project, so the palette has a
 *  real agent hit to resolve (setupTestStore ships `agents: []`). */
function deploySpecialist(store: TestStore, id: string, name: string): void {
  mkdirSync(path.join(store.dataRoot, "agents", "profiles"), {
    recursive: true,
  });
  writeFileSync(
    path.join(store.dataRoot, "agents", "profiles", `${id}.md`),
    [
      "---",
      `id: ${id}`,
      "kind: specialist",
      `name: ${name}`,
      "role: reviewer",
      'desc: "t"',
      "icon: cpu",
      "backends:",
      "  - claude",
      'model: ""',
      "scope: Global base",
      "stages:",
      "  - review",
      "spanAll: false",
      "capabilities: []",
      "extras: []",
      "resources:",
      "  skills: []",
      "  mcps: []",
      "  kb: []",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );
  writeProject(store.dataRoot, {
    name: "Viberr Core",
    slug: store.slug,
    repo: "akin-ozer/viberr",
    defaultBranch: "main",
    taskPrefix: "VIB",
    nextTaskNumber: 100,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members: Object.values(store.users)
      .filter((u) => u.projectRole !== null)
      .map((u) => ({ userId: u.id, role: u.projectRole! })),
    agents: [{ profileId: id, capabilities: [], extras: [] }],
    credentialPolicy: null,
    guardrails: [],
    requiredReviewers: [],
  fileLeases: [],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

const asMember = (store: TestStore) => ({
  id: store.users.selin.id,
  role: "member" as const,
});
const asNonMember = (store: TestStore) => ({
  id: store.users.deniz.id,
  role: "member" as const,
});

describe("searchWorkspace", () => {
  it("returns nothing for an empty query", () => {
    const store = seed();
    expect(
      searchWorkspace(store.db, asMember(store), "   ", {
        dataRoot: store.dataRoot,
      }),
    ).toEqual([]);
  });

  it("finds a task by key and by title, pointing at the task page", () => {
    const store = seed();
    const byKey = searchWorkspace(store.db, asMember(store), "VIB-142", {
      dataRoot: store.dataRoot,
    });
    expect(byKey.some((h) => h.href.endsWith("/tasks/VIB-142"))).toBe(true);
    const byTitle = searchWorkspace(store.db, asMember(store), "credential", {
      dataRoot: store.dataRoot,
    });
    expect(byTitle.find((h) => h.kind === "task")?.href).toContain("VIB-142");
  });

  // F20-28: a full task key the viewer typed must rank that exact task FIRST,
  // ahead of a newer row whose TITLE merely mentions the key. Before this the
  // single scan sorted by `updated_at DESC` only, so typing a key + Enter could
  // land on a different task.
  it("ranks an exact task-key match ahead of a title that only mentions it", () => {
    const store = setupTestStore(ctx);
    // VIB-1 IS the task. VIB-2's title mentions "VIB-1", and it is the more
    // recently updated row — so recency alone floated the wrong task to row 0.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Seed the marker",
        updatedAt: "2026-07-01T09:00:00.000Z",
      }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        title: "Browser-verify the merged VIB-1 marker",
        updatedAt: "2026-07-09T09:00:00.000Z",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const tasks = searchWorkspace(store.db, asMember(store), "VIB-1", {
      dataRoot: store.dataRoot,
    }).filter((h) => h.kind === "task");
    // Both match "VIB-1" (one by key, one by title); the exact-key hit is row 0
    // regardless of which row was touched last, and the fuzzy match still shows.
    expect(tasks.map((h) => h.id)).toEqual([
      "task:viberr-core/VIB-1",
      "task:viberr-core/VIB-2",
    ]);
  });

  // F20-29: an archived PROJECT hit is labelled like an archived task hit — the
  // flag lives on `HomeProjectCard` already; `projectHits` used to drop it, so
  // an archived project came back through the palette byte-identical to a live
  // one.
  it("marks an ARCHIVED project instead of passing it off as live", () => {
    const store = seed();
    // Re-file the project itself as archived (same members) — Home lifts it into
    // its own "Archived" section, but the palette row said nothing.
    writeProject(store.dataRoot, {
      name: "Viberr Core",
      slug: store.slug,
      repo: "akin-ozer/viberr",
      defaultBranch: "main",
      taskPrefix: "VIB",
      nextTaskNumber: 100,
      stages: GOVERNED_TEMPLATE.stages,
      workflow: GOVERNED_TEMPLATE.workflow,
      members: Object.values(store.users)
        .filter((u) => u.projectRole !== null)
        .map((u) => ({ userId: u.id, role: u.projectRole! })),
      agents: [],
      credentialPolicy: null,
      guardrails: [],
      requiredReviewers: [],
      fileLeases: [],
      archived: true,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const project = searchWorkspace(store.db, asMember(store), "viberr", {
      dataRoot: store.dataRoot,
    }).find((h) => h.kind === "project");
    expect(project?.sub).toBe("akin-ozer/viberr · archived");
  });

  it("files a branch-only match under branches, not tasks", () => {
    const store = seed();
    const hits = searchWorkspace(store.db, asMember(store), "rotate-pat", {
      dataRoot: store.dataRoot,
    });
    const hit = hits.find((h) => h.label === "vib-9-rotate-pat");
    expect(hit?.kind).toBe("branch");
    // A branch is still a jump to its task.
    expect(hit?.href).toContain("/tasks/VIB-9");
  });

  it("finds the project itself", () => {
    const store = seed();
    const hits = searchWorkspace(store.db, asMember(store), "viberr", {
      dataRoot: store.dataRoot,
    });
    expect(hits.some((h) => h.kind === "project")).toBe(true);
  });

  it("shows a NON-MEMBER nothing at all (R15-4 scoping)", () => {
    const store = seed();
    // deniz is a registered user with no membership anywhere. Before the
    // palette existed the topbar promised a global search; a global search that
    // ignored membership would leak task keys, titles and branch names.
    expect(
      searchWorkspace(store.db, asNonMember(store), "VIB-142", {
        dataRoot: store.dataRoot,
      }),
    ).toEqual([]);
    expect(
      searchWorkspace(store.db, asNonMember(store), "viberr", {
        dataRoot: store.dataRoot,
      }),
    ).toEqual([]);
  });

  it("an ORG ADMIN who is not a member still reaches every project", () => {
    const store = seed();
    const hits = searchWorkspace(
      store.db,
      { id: store.users.deniz.id, role: "admin" },
      "VIB-142",
      { dataRoot: store.dataRoot },
    );
    expect(hits.some((h) => h.href.endsWith("/tasks/VIB-142"))).toBe(true);
  });

  // F19-8 / R14-3: an archived task leaves every default view; the palette is
  // the deliberate way BACK to it, so it is labelled, not excluded — and with
  // the board's own word. Before this the hit was byte-identical to a live
  // task's, and ORDER BY updated_at DESC ranked a just-archived task first.
  it("marks an ARCHIVED task — and its branch — instead of passing it off as live", () => {
    const store = seed();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", {
        title: "Fix the flaky poll",
        branch: "vib-3-retry-loop",
        archived: true,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const task = searchWorkspace(store.db, asMember(store), "flaky", {
      dataRoot: store.dataRoot,
    }).find((h) => h.kind === "task");
    expect(task?.id).toBe("task:viberr-core/VIB-3");
    expect(task?.sub).toBe("Viberr Core · archived");

    // Same row, reached by its branch — the marker has to travel with it.
    const branch = searchWorkspace(store.db, asMember(store), "retry-loop", {
      dataRoot: store.dataRoot,
    }).find((h) => h.label === "vib-3-retry-loop");
    expect(branch?.kind).toBe("branch");
    expect(branch?.sub).toBe("VIB-3 · Viberr Core · archived");

    // A LIVE task is untouched — the marker names a state, it is not decoration.
    const live = searchWorkspace(store.db, asMember(store), "credential", {
      dataRoot: store.dataRoot,
    }).find((h) => h.kind === "task");
    expect(live?.sub).toBe("Viberr Core");
  });

  // F19-16: the agent hit was the only hit kind that discarded identity its
  // destination can consume — it linked to the bare roster, whose pane falls
  // back to the operator, so EVERY agent hit landed on the wrong agent.
  it("an agent hit deep-links to the agent that was picked, not the roster default", () => {
    const store = seed();
    deploySpecialist(store, "reviewer-bot", "Reviewer Bot");
    const hit = searchWorkspace(store.db, asMember(store), "reviewer bot", {
      dataRoot: store.dataRoot,
    }).find((h) => h.kind === "agent");
    expect(hit?.label).toBe("Reviewer Bot");
    expect(hit?.href).toBe("/projects/viberr-core/agents?profile=reviewer-bot");
  });

  it("treats % and _ as literals, not LIKE wildcards", () => {
    const store = seed();
    expect(
      searchWorkspace(store.db, asMember(store), "%", {
        dataRoot: store.dataRoot,
      }).filter((h) => h.kind === "task"),
    ).toEqual([]);
  });
});

/**
 * Ruling 503: the palette finds an epic by its name or its id, the way
 * Linear's finds a project, inside the same membership scope as every other
 * hit.
 */
describe("searchWorkspace: epics (ruling 503)", () => {
  async function writeEpic(store: TestStore, id: string, title: string, status: EpicStatus, updatedAt: string) {
    await createEpicFile(
      { projectSlug: store.slug, epicId: id, dataRoot: store.dataRoot },
      {
        frontmatter: {
          id,
          title,
          status,
          color: defaultEpicColor(id),
          leadUserId: null,
          startDate: null,
          targetDate: null,
          createdBy: store.users.arda.id,
          createdByLabel: store.users.arda.email,
          conversationId: null,
          convertedFrom: null,
          createdAt: updatedAt,
          updatedAt,
        },
        description: "",
      },
    );
  }

  async function seedEpics(): Promise<TestStore> {
    const store = seed();
    // The done one is the newest: recency alone would put it first.
    await writeEpic(store, "epic-1", "Checkout revamp", "done", "2026-09-25T10:00:00.000Z");
    await writeEpic(store, "epic-2", "Checkout analytics", "in_progress", "2026-09-20T10:00:00.000Z");
    await writeEpic(store, "epic-3", "Search", "planned", "2026-09-21T10:00:00.000Z");
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return store;
  }

  it("finds an epic by name, open ones first, a closed one saying so", async () => {
    // CANARY: drop the open-first CASE from the epic query's ORDER BY.
    const store = await seedEpics();
    const epics = searchWorkspace(store.db, asMember(store), "checkout", {
      dataRoot: store.dataRoot,
    }).filter((h) => h.kind === "epic");
    expect(epics).toEqual([
      {
        kind: "epic",
        id: "epic:viberr-core/epic-2",
        label: "Checkout analytics",
        sub: "epic-2 · Viberr Core",
        href: "/projects/viberr-core/epics/epic-2",
      },
      {
        kind: "epic",
        id: "epic:viberr-core/epic-1",
        label: "Checkout revamp",
        sub: "epic-1 · Viberr Core · done",
        href: "/projects/viberr-core/epics/epic-1",
      },
    ]);
  });

  it("finds an epic by its id, and lists epics after projects and before tasks", async () => {
    const store = await seedEpics();
    const byId = searchWorkspace(store.db, asMember(store), "EPIC-3", {
      dataRoot: store.dataRoot,
    });
    expect(byId.filter((h) => h.kind === "epic").map((h) => h.label)).toEqual(["Search"]);
    // "c" meets the project (Viberr Core), the epics and the tasks.
    const kinds = searchWorkspace(store.db, asMember(store), "c", {
      dataRoot: store.dataRoot,
    }).map((h) => h.kind);
    const firstTask = kinds.indexOf("task");
    expect(kinds.indexOf("project")).toBe(0);
    expect(kinds.lastIndexOf("epic")).toBeLessThan(firstTask);
    expect(kinds.includes("epic")).toBe(true);
  });

  it("shows a NON-MEMBER no epic (R15-4 scoping)", async () => {
    // CANARY: query `epic_projections` without the visible-project filter.
    const store = await seedEpics();
    expect(
      searchWorkspace(store.db, asNonMember(store), "checkout", {
        dataRoot: store.dataRoot,
      }),
    ).toEqual([]);
  });
});
