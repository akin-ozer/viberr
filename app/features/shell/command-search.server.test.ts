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
