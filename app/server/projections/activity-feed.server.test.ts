import { afterEach, describe, expect, it } from "vitest";
import { encodeControllerInstrument } from "~/shared/mapping/actor.server";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { recordAudit, SYSTEM_ACTOR, type AuditEventInput } from "~/server/audit/audit-recorder.server";
import {
  openScopeViolation,
  resolveScopeViolation,
} from "./policy-violations.server";
import { rebuildAll } from "./rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { writeBoardHolding } from "../../../test-support/resource-boards";
import { deployAgentProfileFromLibrary } from "~/features/agents/agent-profile-actions.server";
import { setProjectRulingsKb } from "~/features/project-settings/settings-actions.server";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { saveGlobalAgentProfile } from "~/server/org/gagents.server";
import {
  editKbPassage,
  mergeKbCorrection,
  undoKbCorrection,
} from "~/server/org/kb-corrections.server";
import {
  recordNoRepositoryRuling,
  removeNoRepositoryRuling,
} from "~/server/org/repository-ruling.server";
import {
  deleteKnowledgeBase,
  deleteMcpServer,
  deleteSkill,
  resolveStoreTarget,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
  setKnowledgeBasePrivacy,
} from "~/server/org/resources.server";
import {
  deleteStoreNode,
  importGithubSnapshot,
  writeStoreDoc,
  writeStoreFiles,
} from "~/server/org/store-files.server";
import { propagateTemplateResources } from "~/server/org/template-propagation.server";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import {
  countActivityStream,
  countAuditLog,
  listActivityStream,
  listAuditLog,
  streamFilterOptions,
  auditFilterActors,
  displayAuditActorLabel,
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

  it("F28-D1: same-occurred_at events agree with the task page's file order", () => {
    const store = setupTestStore(ctx);
    const at = "2026-08-26T12:00:00.000Z";
    // Two events at the IDENTICAL timestamp — plausible when one reconcile pass
    // stamps several `new Date().toISOString()` events in a single tick. File
    // order is newest-first, so the "newer" event is listed first (position 0).
    const ev = (text: string) => ({
      occurredAt: at,
      type: "policy" as const,
      actor: { kind: "system" as const, systemId: "policy-engine" },
      title: null,
      text,
      toAgent: false,
      evidence: null,
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "review" }),
      timeline: [ev("newer"), ev("older")],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // The task page reads task_events `position ASC` → [newer, older].
    // SAFETY: the SELECT names exactly `text`, which 0001_baseline declares
    // NOT NULL on task_events, so every row is `{ text: string }`.
    const rows = store.db
      .prepare(
        `SELECT text FROM task_events WHERE project_slug = ? AND task_key = ? ORDER BY position ASC`,
      )
      .all(store.slug, "VIB-9") as { text: string }[];
    const taskPage = rows.map((r) => r.text);
    expect(taskPage).toEqual(["newer", "older"]);

    // The activity stream must AGREE on the tie. Before F28-D1 its `id DESC`
    // tie-break reversed these two relative to the task page.
    const stream = listActivityStream(store.db, store.slug)
      .filter((r) => r.taskKey === "VIB-9")
      .map((r) => r.text);
    expect(stream).toEqual(["newer", "older"]);
  });

  it("F28-D1 + ruling 457: a newer event appended later still wins the tie", () => {
    // Ruling 457 keeps the ids of rows that did not change, so the event
    // appended SECOND carries the larger id — the old `id ASC` tie-break would
    // have listed it after the older one. The task page orders by position.
    const store = setupTestStore(ctx);
    const at = "2026-08-26T12:00:00.000Z";
    const ev = (text: string) => ({
      occurredAt: at,
      type: "policy" as const,
      actor: { kind: "system" as const, systemId: "policy-engine" },
      title: null,
      text,
      toAgent: false,
      evidence: null,
    });
    const frontmatter = baseTaskFrontmatter("VIB-9", { stage: "review" });
    writeTask(store.dataRoot, store.slug, { frontmatter, timeline: [ev("older")] });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    writeTask(store.dataRoot, store.slug, {
      frontmatter,
      timeline: [ev("newer"), ev("older")],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const stream = listActivityStream(store.db, store.slug)
      .filter((r) => r.taskKey === "VIB-9")
      .map((r) => r.text);
    expect(stream).toEqual(["newer", "older"]);
  });

  it("is empty for a project with no events", () => {
    const store = setupProjectedStore(ctx);
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
        "Project credential is missing `pull_request:write`. Flagged by the policy engine on VIB-142.",
    });
    const seeded = listAuditLog(store.db, store.slug).find(
      (e) => e.kind === "violation",
    )!;
    expect(seeded.status).toBe("open");
    expect(seeded.taskKey).toBe("VIB-142");
    expect(seeded.text).toBe(
      "Project credential is missing `pull_request:write`. Flagged by the policy engine on",
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
    // E32-6: the three guardrail-change shapes the Policy card writes.
    for (const details of [
      { id: "meaningful-comment", label: "Meaningful comments", op: "off" },
      { id: "compression-threshold", label: "Compression threshold", op: "value", value: 60 },
      { id: "old-rule", label: "old-rule", op: "remove" },
    ]) {
      recordAudit(store.db, {
        action: "project.policy.guardrail_changed",
        actor: { userId: arda.id, label: arda.email },
        projectSlug: store.slug,
        details,
      });
    }
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
        `${arda.name} turned **Meaningful comments** off.`,
        `${arda.name} set **Compression threshold** to 60.`,
        `${arda.name} removed the **old-rule** guardrail.`,
      ]),
    );

    const blocked = byKind("blockedact");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.text).toBe(
      "Blocked: review PR merge refused (the project credential is missing `pull_request:write`) on",
    );
    expect(blocked[0]!.taskKey).toBe("VIB-201");

    const audit = byKind("audit");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.text).toBe(
      `${arda.name} released the task owner. Recorded per audit policy on`,
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
      `${arda.name} removed workflow stage **Parked**. **Ready → In Progress** is now human only.`,
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

    // The de-dashed shape `acceptanceRefusalReason` stores today: reason and
    // remediation split by a sentence boundary rather than an em dash. The
    // reader must extract the same reason half from both generations of rows.
    recordAudit(store.db, {
      action: "task.acceptance.forced",
      actor: { userId: arda.id, label: arda.email },
      subjectKind: "task",
      subjectId: "VIB-202",
      projectSlug: store.slug,
      taskKey: "VIB-202",
      details: {
        bypassed:
          "VIB-202's delivered revision has no approving verdict yet. Run a review for a verdict, approve the pull request on GitHub, or an admin can force-accept.",
      },
    });

    const entries = listAuditLog(store.db, store.slug);
    const forced = entries.find((e) => e.taskKey === "VIB-201")!;
    expect(forced.kind).toBe("audit");
    expect(forced.text).toBe(
      `${arda.name} force-accepted the completion, overriding the acceptance gate (VIB-201's delivered revision has no approving verdict yet) on`,
    );
    // The remediation half is advice about a decision already made — it must not
    // survive into the record of the override.
    expect(forced.text).not.toContain("an admin can force-accept");
    const forcedNew = entries.find((e) => e.taskKey === "VIB-202")!;
    expect(forcedNew.text).toBe(
      `${arda.name} force-accepted the completion, overriding the acceptance gate (VIB-202's delivered revision has no approving verdict yet) on`,
    );
    expect(forcedNew.text).not.toContain("an admin can force-accept");
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
      `Blocked: ${elif.name} tried to change the policy, but their project role (viewer) is not permitted.`,
    );
    expect(countAuditLog(store.db, store.slug)).toBe(1);
  });
});

describe("feed filters (P21 — owner request: search + filters per panel)", () => {
  it("stream filters compile to SQL and the count agrees with the list", () => {
    const store = setupTestStore(ctx);
    seedStream(store);

    const all = listActivityStream(store.db, store.slug);
    expect(all).toHaveLength(3);

    // q — case-insensitive substring over text/title/task key.
    const q = { q: "ATTACH" };
    expect(listActivityStream(store.db, store.slug, { filters: q })).toHaveLength(1);
    expect(countActivityStream(store.db, store.slug, q)).toBe(1);

    // type — exact.
    const type = { type: "comment" };
    const comments = listActivityStream(store.db, store.slug, { filters: type });
    expect(comments).toHaveLength(1);
    expect(comments[0]?.taskKey).toBe("VIB-202");
    expect(countActivityStream(store.db, store.slug, type)).toBe(1);

    // actorRef — the stable ref behind the display name (`agent/<profileId>`;
    // D32-14: the backend is NOT part of the key, so one profile's Codex and
    // Claude legs are one actor).
    const actor = { actorRef: "agent/developer" };
    expect(listActivityStream(store.db, store.slug, { filters: actor })).toHaveLength(1);

    // task — case-insensitive exact key.
    const task = { task: "vib-201" };
    expect(countActivityStream(store.db, store.slug, task)).toBe(2);

    // date range — inclusive ISO days; everything seeded lands on 2026-07-02.
    expect(countActivityStream(store.db, store.slug, { from: "2026-07-03" })).toBe(0);
    expect(countActivityStream(store.db, store.slug, { to: "2026-07-01" })).toBe(0);
    expect(
      countActivityStream(store.db, store.slug, {
        from: "2026-07-02",
        to: "2026-07-02",
      }),
    ).toBe(3);

    // A LIKE metacharacter is searched literally, never as a wildcard.
    expect(countActivityStream(store.db, store.slug, { q: "%" })).toBe(0);
  });

  it("streamFilterOptions lists the actors by stable ref and the type vocabulary", () => {
    const store = setupTestStore(ctx);
    seedStream(store);
    const options = streamFilterOptions(store.db, store.slug);
    expect(options.types.sort()).toEqual(["comment", "completion", "policy"]);
    const refs = options.actors.map((a) => a.ref);
    expect(refs).toContain("agent/developer");
    expect(refs).toContain("policy-engine");
    expect(refs).toContain(store.users.arda.id);
    // The human's label is the CURRENT users-table name, not the baked ref.
    const arda = options.actors.find((a) => a.ref === store.users.arda.id);
    expect(arda?.label).toBe("Arda Test");
  });

  it("audit filters: kind narrows to its action family, q matches the RENDERED sentence", () => {
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    recordAudit(store.db, {
      action: "project.member.invited",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { email: "new@viberr.test", role: "contributor" },
    });
    recordAudit(store.db, {
      action: "task.acceptance.forced",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      taskKey: "VIB-201",
      details: { bypassed: "no gate" },
    });
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-202",
      scope: "workflow",
    });

    // kind — "change" keeps the invite, drops the override and the violation.
    const changes = listAuditLog(store.db, store.slug, {
      filters: { kind: "change" },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.text).toContain("invited");
    expect(countAuditLog(store.db, store.slug, { kind: "change" })).toBe(1);

    // kind — "violation" keeps only the policy engine's rows.
    expect(countAuditLog(store.db, store.slug, { kind: "violation" })).toBe(1);

    // q — matches the sentence the reader sees ("force-accepted" appears in
    // the rendered template, not in any stored column verbatim).
    const forced = listAuditLog(store.db, store.slug, {
      filters: { q: "force-accepted" },
    });
    expect(forced).toHaveLength(1);
    expect(forced[0]?.taskKey).toBe("VIB-201");
    expect(countAuditLog(store.db, store.slug, { q: "force-accepted" })).toBe(1);

    // actor — violations carry no human actor, so an actor filter drops them.
    const byArda = listAuditLog(store.db, store.slug, {
      filters: { actor: "Arda Test" },
    });
    expect(byArda).toHaveLength(2);
    expect(byArda.every((e) => e.kind !== "violation")).toBe(true);

    // task — case-insensitive exact key across both legs.
    expect(countAuditLog(store.db, store.slug, { task: "vib-202" })).toBe(1);

    // The unfiltered count keeps its cheap aggregate path.
    expect(countAuditLog(store.db, store.slug)).toBe(3);
  });
});

describe("audit-panel actor names (E32-8, pass 32)", () => {
  it("decodes agent and system labels to the Stream's display names, humans by users-table name", () => {
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    // A whitelisted action an AGENT writes (the session-open row).
    recordAudit(store.db, {
      action: "runtime.run.started",
      actor: { userId: null, label: "agent:claude/developer (Implementation)" },
      projectSlug: store.slug,
      taskKey: "VIB-201",
      details: { role: "Reviewer", backend: "claude", kind: "reviewer" },
    });
    recordAudit(store.db, {
      action: "github.reconcile",
      actor: { userId: null, label: "system:workspace-reconcile" },
      projectSlug: store.slug,
    });
    recordAudit(store.db, {
      action: "project.policy.boundary_changed",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { from: "impl", to: "review", boundary: "auto" },
    });
    const options = auditFilterActors(store.db, store.slug);
    // The VALUE stays the stored label (what the filter matches on); the LABEL
    // is what a reader sees.
    expect(options).toEqual(
      expect.arrayContaining([
        { value: "agent:claude/developer (Implementation)", label: "Developer (Implementation) · Claude" },
        { value: "system:workspace-reconcile", label: "Workspace reconcile" },
        { value: arda.name, label: arda.name },
      ]),
    );
    // One option per PERSON: a second row recorded under the user's name (not
    // the email) must not add a second "Arda".
    recordAudit(store.db, {
      action: "project.member.role_changed",
      actor: { userId: arda.id, label: arda.name },
      projectSlug: store.slug,
      details: { from: "contributor", to: "viewer", targetUserId: store.users.selin.id },
    });
    expect(
      auditFilterActors(store.db, store.slug).filter((o) => o.label === arda.name),
    ).toHaveLength(1);
    // The value is what the panel's filter matches on (COALESCE(name, label)).
    expect(
      listAuditLog(store.db, store.slug, { filters: { actor: arda.name } }).length,
    ).toBeGreaterThan(0);
    expect(displayAuditActorLabel("delivery")).toBe("Delivery");
    expect(displayAuditActorLabel("operator")).toBe("Operator");
    // The rendered sentence uses the same name for a human (the users-table
    // row wins either way — the NON-human sentence path is the one that
    // exercises displayAuditActorLabel, locked below and in
    // activity-feed-phase10.server.test.ts "Operator opened …").
    const entries = listAuditLog(store.db, store.slug);
    const change = entries.find((e) => e.text.includes("impl → review"))!;
    expect(change.text.startsWith(`${arda.name} set`)).toBe(true);
    // Review F9b: an agent-authored row renders its decoded name (canary: put
    // `row.actor_label` back at the `actor` derivation in auditText).
    const agentRow = entries.find((e) => e.text.startsWith("Developer (Implementation) · Claude opened the Reviewer runtime session"));
    expect(agentRow, "agent audit rows must render the decoded actor name").toBeTruthy();
  });
});

/**
 * C5 (pass 34, U34-4): the Activity audit column keeps the controller
 * instrument. The joined user name used to win outright, so a row written as
 * `<email> · via controller` (ruling 99(b)) read exactly like one the same
 * person wrote by hand — this is the ONE column that dropped the disclosure.
 */
describe("the audit column discloses the controller instrument (C5)", () => {
  it("an instrumented row and a hand-written row read differently, and the filter still lists one option", () => {
    // Canary: restore `row.actor_name ?? displayAuditActorLabel(...)`.
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    recordAudit(store.db, {
      action: "project.policy.boundary_changed",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { from: "impl", to: "review", boundary: "auto" },
    });
    recordAudit(store.db, {
      action: "project.policy.boundary_changed",
      actor: { userId: arda.id, label: encodeControllerInstrument(arda.email) },
      projectSlug: store.slug,
      details: { from: "review", to: "done", boundary: "approval" },
    });
    const rows = listAuditLog(store.db, store.slug, { limit: 10 });
    const viaController = rows.filter((r) => r.text.includes("(via the controller)"));
    const byHand = rows.filter((r) => !r.text.includes("(via the controller)"));
    expect(viaController).toHaveLength(1);
    expect(byHand.length).toBeGreaterThan(0);
    expect(viaController[0]!.text).toContain(`${arda.name} (via the controller)`);
    expect(byHand[0]!.text).toContain(arda.name);
    // One option per person: the filter compiles on COALESCE(u.name, label).
    const options = auditFilterActors(store.db, store.slug);
    expect(options.filter((o) => o.label.includes(arda.name))).toHaveLength(1);
  });

  it("a row whose user no longer resolves still reads as that person via the controller", () => {
    // Canary: decode the instrument on the joined-name leg only — the userless
    // row then renders a third way (the capitalised raw label).
    const store = setupTestStore(ctx);
    recordAudit(store.db, {
      action: "project.policy.boundary_changed",
      actor: { userId: null, label: encodeControllerInstrument("gone@viberr.dev") },
      projectSlug: store.slug,
      details: { from: "impl", to: "review", boundary: "auto" },
    });
    const row = listAuditLog(store.db, store.slug, { limit: 5 })[0]!;
    expect(row.text).toContain("gone@viberr.dev (via the controller)");
  });

  it("ruling 178: a required-reviewer change reads as a policy change naming each rule, and a clear says so", () => {
    // Canary: leave `project.required_reviewers.updated` out of AUDIT_ACTION_KINDS.
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    recordAudit(store.db, {
      action: "project.required_reviewers.updated",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: {
        count: 2,
        rules: [
          { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Code Reviewer" },
          { stageId: "qa", stageName: "QA", profileId: "qa-bot", agentName: "QA Bot" },
        ],
      },
    });
    recordAudit(store.db, {
      action: "project.required_reviewers.updated",
      actor: { userId: arda.id, label: arda.email },
      projectSlug: store.slug,
      details: { count: 0, rules: [] },
    });
    const rows = listAuditLog(store.db, store.slug, { limit: 5 });
    expect(rows.map((r) => r.kind)).toEqual(["change", "change"]);
    expect(rows[0]!.text).toBe(`${arda.name} cleared the required reviewers.`);
    expect(rows[1]!.text).toBe(
      `${arda.name} set the required reviewers to **Code Reviewer at Review**, **QA Bot at QA**.`,
    );
  });

  it("two audit rows written in the SAME millisecond keep their insertion order", () => {
    // Live (2026-09-12, twice in a full suite run): the ruling-178 test above
    // flipped its two rows. `ORDER BY occurred_at DESC, id DESC` tie-breaks on
    // a RANDOM id (`newId` is 72 random bits), so two events stamped in one
    // millisecond render in either order — the feed says the wrong thing
    // happened last. The tie-break is `rowid DESC` (insertion order), the
    // shape `operator-snapshot` and `controller-conversations` already use.
    //
    // Canary: put `a.id DESC` back and this fails EVERY time (not 50% of the
    // time): the two ids below sort against their insertion order on purpose.
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    const at = "2026-09-12T10:00:00.000Z";
    const insert = (id: string, action: string, details: string) =>
      store.db
        .prepare(
          `INSERT INTO audit_events
             (id, occurred_at, actor_user_id, actor_label, action, project_slug, details_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, at, arda.id, arda.email, action, store.slug, details);
    insert("evt_zzzzzzzzzzzz", "project.required_reviewers.updated", '{"count":0,"rules":[]}');
    insert(
      "evt_aaaaaaaaaaaa",
      "project.policy.boundary_changed",
      '{"from":"review","to":"done","boundary":"approval"}',
    );
    const rows = listAuditLog(store.db, store.slug, { limit: 2 });
    expect(rows.map((r) => r.id)).toEqual(["evt_aaaaaaaaaaaa", "evt_zzzzzzzzzzzz"]);
  });
});

/**
 * Ruling 235 — the refused-acceptance row reads as a sentence, not a humanised
 * action id.
 *
 * Registering the action on the feed put it on screen; without a `auditText`
 * case it rendered "System: task acceptance head unpushed." while every row
 * around it said things like "Sam Okafor tried to force-accept past the review
 * gate, but their project role (viewer) is not permitted." The panel exists to
 * be read, and a reader needs WHICH revision was reviewed against WHICH head.
 */
describe("ruling 235: the refused-acceptance audit row", () => {
  it("names both shas and the pull request", () => {
    const store = setupTestStore(ctx);
    recordAudit(store.db, {
      action: "task.acceptance.head_unpushed",
      actor: SYSTEM_ACTOR,
      subjectKind: "task",
      subjectId: "VIB-301",
      projectSlug: store.slug,
      taskKey: "VIB-301",
      details: {
        prNumber: 13,
        revisionHeadSha: "ea5f2ffd7493a0b5e338e16636bf1339e48d64ba",
        liveHeadSha: "913ce9d70967b7eca7d580631b1fd2ca2f179fcc",
      },
    });
    const audit = listAuditLog(store.db, store.slug, { limit: 50 });
    const row = audit.find((e) => e.text.includes("Acceptance refused"));
    expect(row).toBeTruthy();
    expect(row!.text).toContain("`ea5f2ff`");
    expect(row!.text).toContain("**PR #13**");
    expect(row!.text).toContain("`913ce9d`");
    // It is a blocked ACT, beside the RBAC refusals, not a neutral audit note.
    expect(row!.kind).toBe("blockedact");
    // And it must not degrade to the humanised action id.
    expect(row!.text).not.toContain("head unpushed");
  });
});

/**
 * Ruling 477(b) (F40-28): the goal-chain rows. The org audit store held
 * `goal.created` and `goal.updated` for goal-1 on akinozer.com while the
 * project's audit column ("58 of 58 entries") showed neither: the whitelist
 * had no `goal.*` action. Every op a redirect can run has its own sentence,
 * and a row written before the writer recorded a title or a link still reads.
 */
describe("ruling 477(b): goal-chain rows on the audit column", () => {
  it("names every redirect op, the controller instrument, and the runner's completion", () => {
    // CANARY: leave `goal.updated` out of AUDIT_ACTION_KINDS and every row but
    // the creation and the completion vanishes.
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    const goalRow = (action: string, details: Record<string, string | number | boolean>, label = arda.email) =>
      recordAudit(store.db, {
        action,
        actor: action === "goal.completed" ? { userId: null, label: "goal-runner" } : { userId: arda.id, label },
        subjectKind: "goal",
        subjectId: "goal-4",
        projectSlug: store.slug,
        details,
      });
    goalRow("goal.created", { title: "Launch", links: 1, firstTask: "VIB-9" });
    goalRow("goal.created", {});
    goalRow("goal.updated", { op: "cancel", title: "Launch", reason: "Superseded by goal-5." });
    goalRow("goal.updated", { op: "add_link", title: "Launch", index: 4 });
    goalRow("goal.updated", { op: "remove_pending_link", title: "Launch", index: 2 });
    goalRow("goal.updated", { op: "retry_link", title: "Launch", index: 3 });
    goalRow("goal.updated", { op: "edit_link", title: "Launch", index: 1 }, encodeControllerInstrument(arda.email));
    goalRow("goal.updated", { op: "rename", title: "Launch" });
    goalRow("goal.updated", { op: "resume", title: "Launch", unchanged: true });
    goalRow("goal.completed", {});
    const rows = listAuditLog(store.db, store.slug, { limit: 20 }).reverse();
    expect(rows.map((r) => r.text)).toEqual([
      `${arda.name} created goal **goal-4** (Launch) with 1 link.`,
      `${arda.name} created goal **goal-4**.`,
      `${arda.name} cancelled goal **goal-4** (Launch): Superseded by goal-5.`,
      `${arda.name} added link 4 to goal **goal-4** (Launch).`,
      `${arda.name} removed pending link 2 from goal **goal-4** (Launch).`,
      `${arda.name} retried link 3 of goal **goal-4** (Launch).`,
      `${arda.name} (via the controller) edited link 1 of goal **goal-4** (Launch).`,
      `${arda.name} rewrote the description of goal **goal-4** (Launch).`,
      `${arda.name} changed nothing on goal **goal-4** (Launch).`,
      "Goal **goal-4** completed: every link is settled.",
    ]);
    // The kind filter finds them: a person's chain decisions are changes, the
    // runner's completion an audit note.
    expect(countAuditLog(store.db, store.slug, { kind: "change" })).toBe(9);
    expect(listAuditLog(store.db, store.slug, { filters: { kind: "audit" } }).map((r) => r.text)).toEqual([
      "Goal **goal-4** completed: every link is settled.",
    ]);
  });
});

/**
 * Ruling 503: the epic rows. Creating an epic, changing it and putting a task
 * in one or taking it out are a person's plan; the one-time conversion of a
 * goal chain is Viberr's own record. A task's move reads on its task chip,
 * and a row written without one still ends in a full stop.
 */
describe("ruling 503: epic rows on the audit column", () => {
  it("names the epic, what changed, where a task moved, and the conversion", () => {
    // CANARY: leave `task.epic.changed` out of AUDIT_ACTION_KINDS and the
    // three membership rows vanish from the column.
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    const epicRow = (action: string, details: Record<string, string | number | boolean>) =>
      recordAudit(store.db, {
        action,
        actor: action === "epic.converted" ? { userId: null, label: "epic-conversion" } : { userId: arda.id, label: arda.email },
        subjectKind: "epic",
        subjectId: "epic-4",
        projectSlug: store.slug,
        details,
      });
    const moveRow = (details: Record<string, string>, onTask = true) => {
      const event: AuditEventInput = {
        action: "task.epic.changed",
        actor: { userId: arda.id, label: encodeControllerInstrument(arda.email) },
        subjectKind: "task",
        subjectId: "VIB-9",
        projectSlug: store.slug,
        details,
      };
      if (onTask) event.taskKey = "VIB-9";
      recordAudit(store.db, event);
    };
    epicRow("epic.created", { title: "Launch", status: "planned", total: 2 });
    epicRow("epic.created", { title: "Launch", status: "planned", total: 0 });
    epicRow("epic.updated", { title: "Launch", summary: "set the status to In progress and cleared the lead" });
    epicRow("epic.updated", { title: "Launch" });
    moveRow({ to: "epic-4", title: "Launch" });
    moveRow({ from: "epic-4", to: "epic-5", title: "Beta" });
    moveRow({ from: "epic-5", title: "Beta" }, false);
    epicRow("epic.converted", { title: "Launch", from: "goal-4", total: 3 });
    const rows = listAuditLog(store.db, store.slug, { limit: 20 }).reverse();
    expect(rows.map((r) => r.text)).toEqual([
      `${arda.name} created epic **epic-4** (Launch) with 2 tasks.`,
      `${arda.name} created epic **epic-4** (Launch).`,
      `${arda.name} changed epic **epic-4** (Launch): set the status to In progress and cleared the lead.`,
      `${arda.name} changed epic **epic-4** (Launch).`,
      `${arda.name} (via the controller) set the epic to **epic-4** (Launch) on`,
      `${arda.name} (via the controller) moved the epic from **epic-4** to **epic-5** (Beta) on`,
      // No task on the row: no chip, so no dangling "on".
      `${arda.name} (via the controller) cleared the epic **epic-5** (Beta).`,
      "Goal **goal-4** became epic **epic-4** (Launch) with 3 tasks.",
    ]);
    expect(rows.slice(4, 6).map((r) => r.taskKey)).toEqual(["VIB-9", "VIB-9"]);
    // A person's plan is a change; the conversion is an audit note.
    expect(countAuditLog(store.db, store.slug, { kind: "change" })).toBe(7);
    expect(listAuditLog(store.db, store.slug, { filters: { kind: "audit" } }).map((r) => r.text)).toEqual([
      "Goal **goal-4** became epic **epic-4** (Launch) with 3 tasks.",
    ]);
  });
});

/**
 * Ruling 681: a write to a knowledge base, a skill or an MCP server is audited
 * for the instance, with no project. The boards whose runs are given the
 * resource see it on their audit panel, as a sentence that names the document
 * and quotes none of it. Every row here is written by the writer that writes
 * it in the app, so a writer and this panel cannot come to disagree about a
 * detail's name.
 */
describe("ruling 681: the instance writes to what a board's runs are given", () => {
  type Store = ReturnType<typeof setupTestStore>;
  const personOf = (store: Store) => ({
    userId: store.users.arda.id,
    label: store.users.arda.email,
  });

  /** A knowledge base in the store's own root, and the target writes go through. */
  async function kbNamed(store: Store, name: string) {
    const where = { dataRoot: store.dataRoot };
    const { kb } = await saveKnowledgeBase(store.db, { name, refresh: "manual" }, personOf(store), where);
    return { id: kb.id, target: resolveStoreTarget(store.db, "kb", kb.id, where)! };
  }

  /** A board's panel as its sentences, newest first. */
  const sentences = (store: Store, slug: string = store.slug) =>
    listAuditLog(store.db, slug).map((e) => e.text);

  // CANARY: put `edited.text` (or `.replaced`) into the edit's sentence and the
  // passage of a document reaches every member of the board; drop the board
  // from `resourceRowsWhere` and the other board reads all five rows.
  it("a board's panel shows a write to its rulings and to what its agents hold, quoting nothing, and no other board's", async () => {
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    const actor = { userId: arda.id, label: encodeControllerInstrument(arda.email) };
    const where = { dataRoot: store.dataRoot };
    const rules = await kbNamed(store, "House rules");
    const golden = await kbNamed(store, "Golden set");
    const elsewhere = await kbNamed(store, "Elsewhere");
    const { skill } = await saveSkill(
      store.db,
      { name: "estimating", summary: "How to estimate.", body: "# v1" },
      actor,
      where,
    );
    writeBoardHolding(
      store.dataRoot,
      store.slug,
      { kb: ["golden-set"], skills: ["estimating"] },
      { rulingsKb: "house-rules" },
    );
    writeBoardHolding(store.dataRoot, "other-board", { skills: ["something-else"] });

    writeStoreDoc(store.db, rules.target, [], "proposal.md", "one\nSECRET-LINE\nthree\n", actor);
    const edit = await editKbPassage(
      store.db,
      { kb: "house-rules", doc: "proposal.md", was: "SECRET-LINE", now: "REPLACED-LINE", actor },
      where,
    );
    expect(edit.ok).toBe(true);
    writeStoreDoc(store.db, golden.target, [], "key.md", "SECRET-KEY\n", actor);
    setKnowledgeBasePrivacy(store.db, { id: golden.id, private: true }, actor, where);
    await saveSkill(
      store.db,
      { id: skill.id, name: "estimating", summary: "How to estimate.", body: "# v2 SECRET-SKILL" },
      actor,
      where,
    );
    // Nobody on either board is given this one.
    writeStoreDoc(store.db, elsewhere.target, [], "notes.md", "n\n", actor);

    const who = `${arda.name} (via the controller)`;
    const panel = listAuditLog(store.db, store.slug);
    expect(panel.map((e) => e.text)).toEqual([
      `${who} rewrote the skill **estimating**, which Scout uses.`,
      `${who} made the knowledge base **golden-set**, which Scout reads, private.`,
      `${who} added the document **key.md** to the knowledge base **golden-set**, which Scout reads.`,
      `${who} edited a passage of **proposal.md** in the project's rulings **house-rules**.`,
      `${who} added the document **proposal.md** to the project's rulings **house-rules**.`,
    ]);
    expect(panel.every((e) => e.kind === "change" && e.taskKey === null)).toBe(true);
    expect(JSON.stringify(panel)).not.toMatch(/SECRET|REPLACED/);
    // The document a row wrote, for the route to link for who may open it.
    expect(panel.map((e) => e.doc)).toEqual([
      undefined,
      undefined,
      { kb: "golden-set", doc: "key.md" },
      { kb: "house-rules", doc: "proposal.md" },
      { kb: "house-rules", doc: "proposal.md" },
    ]);
    expect(countAuditLog(store.db, store.slug)).toBe(5);
    // One option per person, whichever instrument wrote the row.
    expect(auditFilterActors(store.db, store.slug).map((o) => o.label)).toEqual([arda.name]);

    // They are changes, by a person, on no task.
    const filtered = (filters: Parameters<typeof listAuditLog>[2] & object) =>
      listAuditLog(store.db, store.slug, filters).length;
    expect(filtered({ filters: { kind: "audit" } })).toBe(0);
    expect(filtered({ filters: { task: "VIB-1" } })).toBe(0);
    expect(filtered({ filters: { actor: arda.name } })).toBe(5);
    expect(filtered({ filters: { q: "golden-set" } })).toBe(2);

    expect(listAuditLog(store.db, "other-board")).toEqual([]);
    expect(countAuditLog(store.db, "other-board")).toBe(0);
    expect(auditFilterActors(store.db, "other-board")).toEqual([]);
  });

  // CANARY: drop `onTask` from the correction's store write, or from its
  // undo's, or the `task.project` term from `resourceRowsWhere`, and the board
  // whose task already says so on the Stream shows the write again here.
  it("an agent's correction and its undo are not repeated on the board whose task records them, and are shown on another board given the knowledge base", async () => {
    const store = setupTestStore(ctx);
    const where = { dataRoot: store.dataRoot };
    const facts = await kbNamed(store, "Shared facts");
    writeStoreDoc(store.db, facts.target, [], "facts.md", "The limit is 10.\n", personOf(store));
    writeBoardHolding(store.dataRoot, store.slug, { kb: ["shared-facts"] });
    writeBoardHolding(store.dataRoot, "second-board", { kb: ["shared-facts"] });
    const scout = encodeActorRef({
      kind: "agent",
      backend: "claude",
      profileId: "scout",
      roleHint: "Research",
    });

    const merged = await mergeKbCorrection(
      store.db,
      {
        kb: "shared-facts",
        doc: "facts.md",
        replaces: "The limit is 10.",
        text: "The limit is 25.",
        evidence: "Measured it.",
        projectSlug: store.slug,
        taskKey: "VIB-7",
        filedBy: "Scout",
        actorRef: scout,
        rulings: false,
        actor: { userId: null, label: scout },
      },
      where,
    );
    if (!merged.ok) throw new Error(merged.message);
    const undone = await undoKbCorrection(
      store.db,
      { id: merged.correction.id, projectSlug: store.slug, reason: null, byName: "Arda" },
      personOf(store),
      where,
    );
    expect(undone.outcome).toBe("done");

    expect(sentences(store)).toEqual([]);
    const seen = listAuditLog(store.db, "second-board");
    const wrote = "replaced **facts.md** in the knowledge base **shared-facts**, which Scout reads.";
    expect(seen.map((e) => e.text.slice(-wrote.length))).toEqual([wrote, wrote]);
    expect(seen[0]!.text).toBe(`${store.users.arda.name} ${wrote}`);
    // The other board is told what changed, not on whose task.
    expect(JSON.stringify(seen)).not.toMatch(/VIB-7|viberr-core|limit/);
  });

  // CANARY: read a detail under another name than its writer gives it (an
  // import's `fileCount`, a rename's `renamedFrom`, a skill's `rewritten`) and
  // its sentence loses the fact; print an import's `source` and a repository's
  // name reaches the board; name every holder instead of the first and a count;
  // say "read" of a skill, or "uses" of one that is gone.
  it("each kind of write reads as what its writer did, to what, and who on the board is given it", async () => {
    const store = setupTestStore(ctx);
    const arda = store.users.arda;
    const actor = personOf(store);
    const where = { dataRoot: store.dataRoot };
    const probe = { fetchImpl: unreachableFetch() };
    const facts = await kbNamed(store, "Facts");
    const { skill } = await saveSkill(
      store.db,
      { name: "estimating", summary: "How to estimate.", body: "# v1" },
      actor,
      where,
    );
    const server = { transport: "HTTP", cred: "" };
    const { mcp } = await saveMcpServer(
      store.db,
      { ...server, name: "aws-pricing", target: "https://x.test/mcp" },
      actor,
      probe,
      where,
    );
    const holding = (name: string, resources: { skills?: string[]; kb?: string[]; mcps?: string[] }) => ({
      profileId: name.toLowerCase(),
      capabilities: [],
      extras: [],
      definition: { name, resources: { skills: ["estimating"], ...resources } },
    });
    writeBoardHolding(store.dataRoot, store.slug, {}, {
      agents: [
        holding("Operator", {}),
        holding("Judge", { kb: ["facts"], mcps: ["aws-pricing"] }),
        holding("Scout", { kb: ["facts"] }),
        holding("Builder", {}),
        holding("Analyst", {}),
      ],
    });

    writeStoreDoc(store.db, facts.target, [], "log.md", "a\n", actor);
    writeStoreDoc(store.db, facts.target, [], "log.md", "b\n", actor, { append: true });
    writeStoreDoc(store.db, facts.target, [], "log.md", "c\n", actor, { overwrite: true });
    writeStoreFiles(
      store.db,
      facts.target,
      ["drafts"],
      [
        { relPath: "a.md", data: Buffer.from("a") },
        { relPath: "b.md", data: Buffer.from("b") },
      ],
      actor,
    );
    deleteStoreNode(store.db, facts.target, ["log.md"], actor);
    deleteStoreNode(store.db, facts.target, ["drafts"], actor);
    const github = fakeGithubFetch({
      "GET /repos/acme/private-notes/git/trees/main": {
        body: { truncated: false, tree: [{ path: "README.md", type: "blob", sha: "s1", size: 4 }] },
      },
      "GET /repos/acme/private-notes/git/blobs/s1": {
        body: { content: Buffer.from("read").toString("base64"), encoding: "base64" },
      },
    });
    const imported = await importGithubSnapshot(
      store.db,
      facts.target,
      "https://github.com/acme/private-notes/blob/main/README.md",
      actor,
      { fetchImpl: github.fetchImpl },
    );
    expect(imported.status).toBe("imported");
    setKnowledgeBasePrivacy(store.db, { id: facts.id, private: true }, actor, where);
    setKnowledgeBasePrivacy(store.db, { id: facts.id, private: false }, actor, where);
    await saveKnowledgeBase(store.db, { id: facts.id, name: "True facts", refresh: "manual" }, actor, where);
    await saveSkill(
      store.db,
      { id: skill.id, name: "pricing", summary: "How to price.", body: "# v2" },
      actor,
      where,
    );
    const saved = { ...server, id: mcp.id, name: "aws-pricing", target: "https://y.test/mcp" };
    await saveMcpServer(store.db, saved, actor, probe, where);
    // Its marks change and nothing a run reaches does: one row, for the marks.
    await saveMcpServer(store.db, { ...saved, writeTools: ["create_estimate"] }, actor, probe, where);
    await saveMcpServer(store.db, { ...saved, name: "pricing-api" }, actor, probe, where);
    await deleteKnowledgeBase(store.db, facts.id, actor, where);
    await deleteSkill(store.db, skill.id, actor, where);
    await deleteMcpServer(store.db, mcp.id, actor, where);

    const facts2 = "the knowledge base **facts**, which Judge and Scout read";
    expect(sentences(store).map((text) => text.slice(arda.name.length + 1))).toEqual([
      "removed the MCP server **pricing-api**, which Judge used.",
      "deleted the skill **pricing**, which Operator and 4 others used.",
      "deleted the knowledge base **true-facts**, which Judge and Scout read.",
      "renamed the MCP server **aws-pricing**, which Judge uses, to **pricing-api**.",
      "changed which tools of the MCP server **aws-pricing**, which Judge uses, are marked as writes.",
      "changed the MCP server **aws-pricing**, which Judge uses.",
      "renamed the skill **estimating**, which Operator and 4 others use, to **pricing** and rewrote it.",
      `renamed ${facts2}, to **true-facts**.`,
      `made ${facts2}, open again.`,
      `made ${facts2}, private.`,
      `imported 1 file from GitHub into ${facts2}.`,
      `deleted the folder **drafts** from ${facts2}.`,
      `deleted **log.md** from ${facts2}.`,
      `added 2 files to ${facts2}.`,
      `replaced **log.md** in ${facts2}.`,
      `added to **log.md** in ${facts2}.`,
      `added the document **log.md** to ${facts2}.`,
    ]);
  });

  // CANARY: drop `ofBoard` from the ruling's write or its removal and the
  // second board, given the same rulings, reads the first board's slug in a
  // document's name.
  it("a board's own ruling document, named after it, is on that board's panel alone", async () => {
    const store = setupTestStore(ctx);
    const actor = personOf(store);
    const where = { dataRoot: store.dataRoot };
    await kbNamed(store, "Shared rules");
    writeBoardHolding(store.dataRoot, store.slug, {}, { rulingsKb: "shared-rules" });
    writeBoardHolding(store.dataRoot, "second-board", {}, { rulingsKb: "shared-rules" });

    await recordNoRepositoryRuling(
      store.db,
      { projectSlug: store.slug, byName: "Arda", taskKey: "VIB-7", at: "2026-10-07T10:00:00.000Z" },
      actor,
      where,
    );
    removeNoRepositoryRuling(store.db, { projectSlug: store.slug, repo: "acme/app" }, actor, where);

    const who = store.users.arda.name;
    expect(sentences(store)).toEqual([
      `${who} deleted **no-repository-viberr-core.md** from the project's rulings **shared-rules**.`,
      `${who} added the document **no-repository-viberr-core.md** to the project's rulings **shared-rules**.`,
    ]);
    expect(listAuditLog(store.db, "second-board")).toEqual([]);
    expect(countAuditLog(store.db, "second-board")).toBe(0);
  });

  // CANARY: leave either action out of AUDIT_ACTION_KINDS and the board never
  // says which knowledge base its rulings became, or that an agent's grants
  // were replaced by its template's.
  it("names the knowledge base a board took as its rulings, its clearing, and a sync of an agent's grants", async () => {
    const store = setupProjectedStore(ctx);
    const arda = store.users.arda;
    const actor = { userId: arda.id, label: arda.email };
    const where = { dataRoot: store.dataRoot };
    await saveKnowledgeBase(store.db, { name: "House rules", refresh: "manual" }, actor, where);
    await setProjectRulingsKb(store.db, { projectSlug: store.slug, dir: "house-rules" }, actor, where);
    await setProjectRulingsKb(store.db, { projectSlug: store.slug, dir: null }, actor, where);
    seedDefaultAgentAssets(store.dataRoot);
    rebuildAll(store.db, where);
    await deployAgentProfileFromLibrary(
      store.db,
      { projectSlug: store.slug, profileId: "developer" },
      actor,
      where,
    );
    await saveGlobalAgentProfile(
      store.db,
      {
        id: "developer",
        name: "Developer",
        backend: "claude",
        summary: "Implements the change.",
        persona: "",
        stages: ["ready", "impl"],
        mcps: ["github"],
      },
      actor,
      where,
    );
    await propagateTemplateResources(
      store.db,
      { profileId: "developer", projectSlugs: [store.slug] },
      actor,
      where,
    );

    const panel = listAuditLog(store.db, store.slug).map((e) => e.text);
    expect(panel).toContain(
      `${arda.name} set **Developer**'s skills, knowledge bases and MCP servers to its template's.`,
    );
    expect(panel.slice(-2)).toEqual([
      `${arda.name} cleared the project's rulings.`,
      `${arda.name} named **house-rules** the project's rulings.`,
    ]);
  });

  // CANARY: sort the two legs by `occurred_at` alone and the board's own row,
  // written first, is listed as the newer of the two.
  it("orders an instance row and a board's own row of one millisecond as they were written", async () => {
    const store = setupProjectedStore(ctx);
    // A board that names no rulings gets a knowledge base for them: the
    // board's own row first, then the document's.
    await recordNoRepositoryRuling(
      store.db,
      { projectSlug: store.slug, byName: "Arda", taskKey: "VIB-7", at: "2026-10-07T10:00:00.000Z" },
      personOf(store),
      { dataRoot: store.dataRoot },
    );
    store.db.prepare(`UPDATE audit_events SET occurred_at = '2026-10-07T10:00:00.000Z'`).run();
    const who = store.users.arda.name;
    expect(sentences(store)).toEqual([
      `${who} added the document **no-repository-viberr-core.md** to the project's rulings **viberr-core-rulings**.`,
      `${who} named **viberr-core-rulings** the project's rulings.`,
    ]);
  });

  // CANARY: ask every member of `boards` for its project, object or not, and
  // one such row raises "malformed JSON" on every board's panel.
  it("a row whose `resource` is not what a writer writes names no board, and breaks no board's panel", () => {
    const store = setupTestStore(ctx);
    const odd = (details: AuditEventInput["details"]) =>
      recordAudit(store.db, { action: "org.store.doc_written", actor: SYSTEM_ACTOR, details });
    odd({ path: "a.md", resource: { kind: "kb", key: "k", boards: [store.slug] } });
    odd({ path: "b.md", resource: { kind: "kb", key: "k", boards: store.slug } });
    odd({ path: "c.md", resource: { kind: "kb", key: "k", boards: { project: store.slug } } });
    odd({ path: "d.md", resource: store.slug });
    odd({ path: "e.md" });
    recordAudit(store.db, { action: "org.store.doc_written", actor: SYSTEM_ACTOR });
    store.db
      .prepare(`UPDATE audit_events SET details_json = 'not json' WHERE details_json IS NULL`)
      .run();

    expect(listAuditLog(store.db, store.slug)).toEqual([]);
    expect(countAuditLog(store.db, store.slug)).toBe(0);
    expect(auditFilterActors(store.db, store.slug)).toEqual([]);
  });
});
