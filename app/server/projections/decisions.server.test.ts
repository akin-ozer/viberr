import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { insertUser } from "~/server/auth/user-store.server";
import { rebuildAll } from "./rebuilder.server";
import { decisionsRequiring } from "./decisions.server";
import type { TaskPacket } from "~/schemas/task-file.schema";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const PACKET: TaskPacket = {
  type: "input",
  kind: "Decision required",
  from: "operator",
  title: "Pick one",
  body: "",
  observations: [],
  options: [{ kind: "request_edit", t: "Send back", d: "", rec: true }],
};

/** A task at a non-terminal stage carrying an open packet. */
function seedOpenDecision(
  store: ReturnType<typeof setupTestStore>,
  key: string,
  patch: Record<string, unknown> = {},
) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { stage: "review", ...patch }),
    packet: PACKET,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

describe("decisionsRequiring (R8-3 single member-scoped source)", () => {
  it("maintainer+ hold every open decision as `mine`; viewers hold none", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-201");

    // arda = admin, murat = maintainer → the decision is theirs.
    expect(decisionsRequiring(store.db, store.users.arda.id).mine).toHaveLength(1);
    expect(decisionsRequiring(store.db, store.users.murat.id).mine).toHaveLength(1);
    // selin = contributor (not the owner) + elif = viewer → nothing.
    expect(decisionsRequiring(store.db, store.users.selin.id).mine).toHaveLength(0);
    expect(decisionsRequiring(store.db, store.users.elif.id).mine).toHaveLength(0);
  });

  it("a contributor who OWNS the task holds its decision (owner allowance)", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-202", { ownerUserId: store.users.selin.id });
    // selin is a contributor AND the owner → mine.
    const selin = decisionsRequiring(store.db, store.users.selin.id);
    expect(selin.mine.map((d) => d.taskKey)).toEqual(["VIB-202"]);
    // deniz (non-member) owning nothing → nothing.
    expect(decisionsRequiring(store.db, store.users.deniz.id).mine).toHaveLength(0);
  });

  it("a contributor-owner does NOT hold a maintainer-only recommendation (transition/assign/run)", () => {
    const store = setupTestStore(ctx);
    // A recommendation-ONLY task (no packet) owned by a contributor. Applying a
    // `transition` needs approve-transition (maintainer+) and even DISMISSING any
    // recommendation needs resolve-packet (maintainer+) — neither has an owner
    // exception, so the owner can act on NEITHER: it must not count as `mine`.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-210", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.selin.id,
        recommendations: [
          { id: "r1", kind: "transition", toStageId: "done", label: "Accept", detail: "" },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // selin (contributor + owner) can neither apply nor dismiss it → not hers.
    expect(decisionsRequiring(store.db, store.users.selin.id).mine).toHaveLength(0);
    // A maintainer holds it (maintainer+ can act on any decision).
    expect(
      decisionsRequiring(store.db, store.users.murat.id).mine.map((d) => d.taskKey),
    ).toEqual(["VIB-210"]);
  });

  it("a contributor-owner DOES hold an accept_completion recommendation (owner exception)", () => {
    const store = setupTestStore(ctx);
    // accept_completion is the ONE recommendation kind an owner can act on — the
    // owner exception (R6-2) lets a contributor-owner accept their task's
    // completion, exactly like resolving a completion packet.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-211", {
        stage: "review",
        waiting: "human",
        ownerUserId: store.users.selin.id,
        recommendations: [
          {
            id: "r1",
            kind: "accept_completion",
            toStageId: "done",
            label: "Accept completion",
            detail: "",
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      decisionsRequiring(store.db, store.users.selin.id).mine.map((d) => d.taskKey),
    ).toEqual(["VIB-211"]);
    // A contributor who is NOT the owner still can't accept → not theirs.
    // (Reuse deniz — a non-member — for the clearly-nothing case.)
    expect(decisionsRequiring(store.db, store.users.deniz.id).mine).toHaveLength(0);
  });

  it("an org admin who is a below-tier project member gets overrideEligible (not dropped)", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-212");
    // An ORG admin who is ALSO a project VIEWER (below the maintainer+ tier).
    // resolveProjectAuthority would grant them the audited D2 override, so the
    // decision must surface as overrideEligible — NOT silently dropped.
    const admin = insertUser(store.db, {
      id: "u_orgadmin_viewer",
      email: "orgadmin-viewer@viberr.test",
      name: "Org Admin Viewer",
      role: "admin",
    });
    store.db
      .prepare(
        `INSERT INTO project_members (project_slug, user_id, role) VALUES (?, ?, 'viewer')`,
      )
      .run(store.slug, admin.id);
    const result = decisionsRequiring(store.db, admin.id);
    expect(result.mine).toHaveLength(0);
    expect(result.overrideEligible.map((d) => d.taskKey)).toEqual(["VIB-212"]);
  });

  it("a non-member ORG ADMIN gets `overrideEligible`, never `mine`", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-203");
    // An org admin who is NOT a project member.
    const rec = insertUser(store.db, {
      id: "u_orgadmin_dec",
      email: "orgadmin-dec@viberr.test",
      name: "Org Admin",
      role: "admin",
    });
    const result = decisionsRequiring(store.db, rec.id);
    expect(result.mine).toHaveLength(0);
    expect(result.overrideEligible.map((d) => d.taskKey)).toEqual(["VIB-203"]);
  });

  it("terminal-stage tasks are never counted, even with a leftover packet", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-204", { stage: "done", waiting: "none" }),
      packet: PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(decisionsRequiring(store.db, store.users.arda.id).mine).toHaveLength(0);
  });

  it("dedupes to one decision per task and honors projectSlug scoping", () => {
    const store = setupTestStore(ctx);
    seedOpenDecision(store, "VIB-205");
    seedOpenDecision(store, "VIB-206");
    const all = decisionsRequiring(store.db, store.users.murat.id);
    expect(all.mine.map((d) => d.taskKey).sort()).toEqual(["VIB-205", "VIB-206"]);
    const scoped = decisionsRequiring(store.db, store.users.murat.id, {
      projectSlug: "no-such-project",
    });
    expect(scoped.mine).toHaveLength(0);
  });
});
