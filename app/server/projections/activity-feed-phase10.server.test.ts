import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  countActivityStream,
  countAuditLog,
  listAuditLog,
} from "./activity-feed.server";
import {
  openScopeViolation,
  resolveScopeViolation,
} from "./policy-violations.server";

/**
 * Phase 10 — audit panel deepening: readable templates for the new action
 * kinds (grant-scope attempts, runtime session opens), per-violation
 * resolve context, and the count queries behind "Show older". No entry may
 * ever surface raw JSON — asserted across every rendered row.
 */

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-7", { stage: "impl" }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
});

afterEach(() => ctx.cleanup());

const arda = () => ({
  userId: store.users.arda.id,
  label: store.users.arda.email,
});

describe("audit panel — Phase 10 action kinds render readably", () => {
  it("github.credential.revalidated renders per outcome, never raw JSON", () => {
    recordAudit(store.db, {
      action: "github.credential.revalidated",
      actor: arda(),
      subjectKind: "github_credential",
      subjectId: store.slug,
      projectSlug: store.slug,
      details: { outcome: "no_pat_configured" },
    });
    recordAudit(store.db, {
      action: "github.credential.revalidated",
      actor: arda(),
      subjectKind: "github_credential",
      subjectId: store.slug,
      projectSlug: store.slug,
      details: { outcome: "revalidated", resolvedViolations: 1 },
    });
    // NOTE: migration 0005 data-seeds one open viberr-core violation — the
    // panel legitimately shows it; scope the assertions to the new rows.
    const entries = listAuditLog(store.db, store.slug).filter(
      (e) => e.kind !== "violation",
    );
    const texts = entries.map((e) => e.text);
    expect(texts).toContain(
      "Arda Test requested a scope grant, but no GitHub credential is configured.",
    );
    expect(texts).toContain(
      "Arda Test re-validated the project credential and resolved 1 policy flag.",
    );
    for (const e of entries) {
      expect(e.kind).toBe("change");
      expect(e.text).not.toMatch(/[{}"]:/);
    }
  });

  it("runtime.run.started renders as an audit-kind session-open row", () => {
    recordAudit(store.db, {
      action: "runtime.run.started",
      actor: { userId: null, label: "operator" },
      subjectKind: "run",
      subjectId: "run_x",
      projectSlug: store.slug,
      taskKey: "VIB-7",
      details: { role: "Developer", backend: "codex", kind: "primary" },
    });
    const entry = listAuditLog(store.db, store.slug)[0]!;
    expect(entry.kind).toBe("audit");
    // E32-8 (pass 32): the actor reads as its display name ("Operator", not
    // the stored `operator` token); the fixed words after it are the fold key
    // the Activity page matches on (activity-page.tsx), unchanged.
    expect(entry.text).toBe(
      "Operator opened the Developer runtime session. Recorded per audit policy on",
    );
    expect(entry.taskKey).toBe("VIB-7");
  });

  it("ruling 462: a repository created with the project reads as a sentence naming it", () => {
    // CANARY: drop the action from AUDIT_ACTION_KINDS and the row never
    // reaches the panel.
    recordAudit(store.db, {
      action: "project.repository.created",
      actor: arda(),
      subjectKind: "project",
      subjectId: store.slug,
      projectSlug: store.slug,
      details: { repo: "akin-ozer/website", private: true },
    });
    const entry = listAuditLog(store.db, store.slug)[0]!;
    expect(entry.kind).toBe("change");
    expect(entry.text).toBe(
      "Arda Test created the private GitHub repository **akin-ozer/website**.",
    );
  });

  it("messy details never leak — templates render sentences, not JSON", () => {
    recordAudit(store.db, {
      action: "project.settings.updated",
      actor: arda(),
      projectSlug: store.slug,
      details: { fields: ["name"], weirdNested: { a: 1, b: [2, 3] } },
    });
    const entry = listAuditLog(store.db, store.slug)[0]!;
    expect(entry.text).toBe("Arda Test updated project settings.");
    expect(entry.text).not.toContain("{");
  });
});

describe("violation resolve context (Phase 10)", () => {
  it("resolved violations carry resolver name + timestamp", () => {
    const { violation } = openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-7",
      scope: "pull_request:write",
      actor: arda(),
    });
    resolveScopeViolation(store.db, violation.id, arda());

    const entry = listAuditLog(store.db, store.slug).find(
      (e) => e.id === violation.id,
    )!;
    expect(entry.status).toBe("resolved");
    expect(entry.resolvedAt).toBeTruthy();
    // resolved_by stored the user id → resolved to the display name.
    expect(entry.resolvedBy).toBe("Arda Test");
  });

  it("open violations have no resolve context", () => {
    const { violation } = openScopeViolation(store.db, {
      projectSlug: store.slug,
      scope: "repo",
      actor: arda(),
    });
    const entry = listAuditLog(store.db, store.slug).find(
      (e) => e.id === violation.id,
    )!;
    expect(entry.status).toBe("open");
    expect(entry.resolvedAt).toBeNull();
    expect(entry.resolvedBy).toBeNull();
  });
});

describe("pagination counts (Phase 10)", () => {
  it("countAuditLog = violations + whitelisted audit rows; limit slices", () => {
    const baseline = countAuditLog(store.db, store.slug); // 0005 seed row
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      scope: "workflow",
      actor: arda(),
    });
    for (let i = 0; i < 5; i++) {
      recordAudit(store.db, {
        action: "project.stage.renamed",
        actor: arda(),
        projectSlug: store.slug,
        details: { name: `Stage ${i}` },
      });
    }
    // Unlisted actions must NOT count (comments live in the stream)...
    recordAudit(store.db, {
      action: "task.comment",
      actor: arda(),
      projectSlug: store.slug,
      taskKey: "VIB-7",
    });

    // ...but the violation-open audit row (whitelisted? no — the violation
    // itself is the panel row) and the 5 changes do:
    expect(countAuditLog(store.db, store.slug)).toBe(baseline + 6);
    expect(listAuditLog(store.db, store.slug, { limit: 3 })).toHaveLength(3);
    expect(listAuditLog(store.db, store.slug)).toHaveLength(baseline + 6);
  });

  it("countActivityStream counts the project's task_events", () => {
    expect(countActivityStream(store.db, store.slug)).toBe(0);
  });
});
