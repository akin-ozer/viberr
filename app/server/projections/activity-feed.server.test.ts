import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  openScopeViolation,
  resolveScopeViolation,
} from "./policy-violations.server";
import { rebuildAll } from "./rebuilder.server";
import {
  countAuditLog,
  listActivityStream,
  listAuditLog,
} from "./activity-feed.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function seedStream(store: ReturnType<typeof setupTestStore>) {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-201", { stage: "review" }),
    timeline: [
      {
        occurredAt: "2026-07-02T09:41:00.000Z",
        type: "completion",
        actor: { kind: "agent", backend: "codex", profileId: "developer", roleHint: "Developer" },
        title: "Completion report",
        text: "Implemented `attach` flow.",
        toAgent: false,
        evidence: null,
      },
      {
        occurredAt: "2026-07-02T09:38:00.000Z",
        type: "policy",
        actor: { kind: "system", systemId: "policy-engine" },
        title: null,
        text: "**Policy violation:** PAT missing scope.",
        toAgent: false,
        evidence: null,
      },
    ],
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-202", { stage: "impl" }),
    timeline: [
      {
        occurredAt: "2026-07-02T10:12:00.000Z",
        type: "comment",
        actor: { kind: "human", userId: store.users.arda.id, nameHint: null },
        title: null,
        text: "@operator please continue.",
        toAgent: true,
        evidence: null,
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

describe("listActivityStream", () => {
  it("flattens every task's events, occurred_at DESC, with title folded", () => {
    const store = setupTestStore(ctx);
    seedStream(store);

    const rows = listActivityStream(store.db, store.slug);
    expect(rows.map((r) => r.taskKey)).toEqual([
      "VIB-202",
      "VIB-201",
      "VIB-201",
    ]);
    // Title folded into text as a leading bold sentence (mock norm()).
    expect(rows[1]!.text).toBe(
      "**Completion report.** Implemented `attach` flow.",
    );
    // Untitled events keep their text verbatim.
    expect(rows[2]!.text).toBe("**Policy violation:** PAT missing scope.");
    // Actor render snapshots survive with kind for the filter.
    expect(rows[0]!.actor?.kind).toBe("human");
    expect(rows[1]!.actor?.kind).toBe("agent");
    expect(rows[2]!.actor?.kind).toBe("system");
  });

  it("respects the limit option", () => {
    const store = setupTestStore(ctx);
    seedStream(store);
    expect(listActivityStream(store.db, store.slug, { limit: 2 })).toHaveLength(
      2,
    );
  });

  it("is empty for a project with no events", () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(listActivityStream(store.db, store.slug)).toEqual([]);
  });

  it("user rename shows immediately — human actors resolve at read time (E1)", () => {
    const store = setupTestStore(ctx);
    seedStream(store);

    // Rename arda AFTER projection: the baked actor_json still carries the
    // old name (content-hash short-circuit means no reprojection happens).
    store.db
      .prepare(`UPDATE users SET name = ? WHERE id = ?`)
      .run("Arda Yıldız", store.users.arda.id);

    const rows = listActivityStream(store.db, store.slug);
    const human = rows.find((r) => r.actor?.kind === "human")!;
    expect(human.actor).toMatchObject({
      kind: "human",
      name: "Arda Yıldız",
      initials: "AY",
    });

    // Deleted user → the baked snapshot survives as fallback.
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(store.users.arda.id);
    const after = listActivityStream(store.db, store.slug);
    const orphan = after.find((r) => r.actor?.kind === "human")!;
    expect(orphan.actor).toMatchObject({ kind: "human", name: "Arda Test" });
  });
});

describe("listAuditLog", () => {
  it("renders scope violations with their own open/resolved state (ruling 5)", () => {
    const store = setupTestStore(ctx);
    // The mock VIB-142 violation used to be migration-seeded; the squashed
    // baseline is schema-only, so open one explicitly to render it.
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail:
        "Project credential is missing `pull_request:write` — flagged by the policy engine on VIB-142.",
    });
    const seeded = listAuditLog(store.db, store.slug).find(
      (e) => e.kind === "violation",
    )!;
    expect(seeded.status).toBe("open");
    expect(seeded.taskKey).toBe("VIB-142");
    expect(seeded.text).toBe(
      "Project credential is missing `pull_request:write` — flagged by the policy engine on",
    );

    const { violation } = openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-201",
      scope: "workflow",
    });
    resolveScopeViolation(store.db, violation.id);
    const entries = listAuditLog(store.db, store.slug);
    const resolved = entries.find((e) => e.id === violation.id)!;
    expect(resolved.kind).toBe("violation");
    expect(resolved.status).toBe("resolved");
  });

  it("maps whitelisted audit actions to display kinds and readable text", () => {
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    recordAudit(store.db, {
      action: "project.policy.boundary_changed",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { from: "impl", to: "review", boundary: "auto" },
    });
    recordAudit(store.db, {
      action: "project.member.role_changed",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { from: "contributor", to: "viewer", targetUserId: store.users.selin.id },
    });
    recordAudit(store.db, {
      action: "github.pr.merge_refused",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      taskKey: "VIB-201",
      details: { scope: "pull_request:write" },
    });
    recordAudit(store.db, {
      action: "task.ownership.admin_released",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      taskKey: "VIB-202",
    });
    // NOT whitelisted → never in this panel (auth noise, comments, …).
    recordAudit(store.db, {
      action: "task.comment",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      taskKey: "VIB-202",
    });
    recordAudit(store.db, {
      action: "auth.login.success",
      actor: { userId: arda.id, label: arda.email },
    });

    const entries = listAuditLog(store.db, store.slug);
    const byKind = (k: string) => entries.filter((e) => e.kind === k);

    const change = byKind("change");
    expect(change.map((e) => e.text)).toEqual(
      expect.arrayContaining([
        `${arda.name} set **impl → review** to auto-advance.`,
        `${arda.name} set ${store.users.selin.name} to **viewer**.`,
      ]),
    );

    const blocked = byKind("blockedact");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.text).toBe(
      "Blocked: review PR merge refused — the project credential is missing `pull_request:write` — on",
    );
    expect(blocked[0]!.taskKey).toBe("VIB-201");

    const audit = byKind("audit");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.text).toBe(
      `${arda.name} released the task owner — recorded per audit policy on`,
    );

    expect(entries.some((e) => e.text.includes("task comment"))).toBe(false);
  });

  // F20-27 / F20-13: the stage add/remove renderer names the stage (the name was
  // recorded and ignored), and a removal that retightened a surviving hop
  // discloses the composite boundary change the toast alone hid.
  it("names the stage on add/remove and discloses a re-tightened boundary", () => {
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    // CONTRACT with C-PROJECT-SETTINGS (the writer): added/removed record
    // `details: { id, name }`; a removal that tightens a hop also records
    // `tightened: { from, to, boundary }` as display NAMES.
    recordAudit(store.db, {
      action: "project.stage.added",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { id: "hold", name: "Hold" },
    });
    recordAudit(store.db, {
      action: "project.stage.removed",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { id: "hold", name: "Hold" },
    });
    recordAudit(store.db, {
      action: "project.stage.removed",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: {
        id: "parked",
        name: "Parked",
        tightened: { from: "Ready", to: "In Progress", boundary: "human" },
      },
    });

    const texts = listAuditLog(store.db, store.slug).map((e) => e.text);
    expect(texts).toContain(`${arda.name} added workflow stage **Hold**.`);
    expect(texts).toContain(`${arda.name} removed workflow stage **Hold**.`);
    expect(texts).toContain(
      `${arda.name} removed workflow stage **Parked** — **Ready → In Progress** is now human only.`,
    );
    // A removal whose details drop the name still renders (older rows / no name).
    recordAudit(store.db, {
      action: "project.stage.removed",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: {},
    });
    expect(
      listAuditLog(store.db, store.slug).map((e) => e.text),
    ).toContain(`${arda.name} removed a workflow stage.`);
  });

  it("sorts merged violations + audit rows newest-first and caps at limit", () => {
    const store = setupTestStore(ctx);
    recordAudit(store.db, {
      action: "project.settings.updated",
      actor: { userId: store.users.arda.id, label: store.users.arda.email },
      projectSlug: store.slug,
      details: { fields: ["name"] },
    });
    const entries = listAuditLog(store.db, store.slug);
    const times = entries.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    expect(listAuditLog(store.db, store.slug, { limit: 1 })).toHaveLength(1);
  });

  // P13-D-7: both rows were RECORDED and surfaced nowhere — the whitelist that
  // drives this panel (and its count) omitted them, so reconstructing "who
  // bypassed the required reviewer" needed raw SQLite.
  it("surfaces the two governance overrides (P13-D-7) with readable text", () => {
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    recordAudit(store.db, {
      action: "task.acceptance.forced",
      actor: { userId: arda.id, label: arda.email },
      subjectKind: "task",
      subjectId: "VIB-201",
      projectSlug: store.slug,
      taskKey: "VIB-201",
      // The REAL shape `forceAcceptCompletion` stores: the full refusal
      // sentence the human was shown, remediation clause and all — not a short
      // gate name. The old fixture used a hand-written phrase that read fine
      // after "bypassing" and so hid the live nonsense this test now pins.
      details: {
        bypassed:
          "VIB-201's delivered revision has no approving verdict yet — run a review for a verdict, or an admin can force-accept.",
      },
    });
    recordAudit(store.db, {
      action: "project.org_admin.override",
      actor: { userId: arda.id, label: arda.email },
      subjectKind: "project",
      subjectId: store.slug,
      projectSlug: store.slug,
      details: {
        action: "edit-policy",
        what: "change the policy",
        projectSlug: store.slug,
        memberRole: null,
      },
    });

    const entries = listAuditLog(store.db, store.slug);
    const forced = entries.find((e) => e.taskKey === "VIB-201")!;
    expect(forced.kind).toBe("audit");
    expect(forced.text).toBe(
      `${arda.name} force-accepted the completion, overriding the acceptance gate (VIB-201's delivered revision has no approving verdict yet) — on`,
    );
    // The remediation half is advice about a decision already made — it must not
    // survive into the record of the override.
    expect(forced.text).not.toContain("an admin can force-accept");
    const override = entries.find((e) => e.text.includes("org-admin override"))!;
    expect(override.kind).toBe("audit");
    expect(override.text).toBe(
      `${arda.name} used the org-admin override to change the policy (project role: not a member).`,
    );
    // The count that drives "show older" must agree with the list.
    expect(countAuditLog(store.db, store.slug)).toBe(entries.length);
  });

  // P13-D-8: NFR10's fourth category. A recorded denial that never reaches the
  // panel is the same invisibility D-7 fixes, so assert both ends.
  it("surfaces a denied authority attempt as a blocked action (P13-D-8)", () => {
    const store = setupTestStore(ctx);
    const elif = store.users.elif;
    recordAudit(store.db, {
      action: "project.authority.denied",
      actor: { userId: elif.id, label: elif.email },
      subjectKind: "project",
      subjectId: store.slug,
      projectSlug: store.slug,
      details: {
        action: "edit-policy",
        what: "change the policy",
        projectSlug: store.slug,
        memberRole: "viewer",
      },
    });

    const entry = listAuditLog(store.db, store.slug)[0]!;
    expect(entry.kind).toBe("blockedact");
    expect(entry.text).toBe(
      `Blocked: ${elif.name} tried to change the policy — their project role (viewer) is not permitted.`,
    );
    expect(countAuditLog(store.db, store.slug)).toBe(1);
  });
});
