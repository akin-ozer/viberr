import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { runDemoSeed } from "~/server/seed/demo-seed.server";
import { onProjectionEvent } from "~/server/events/projection-events.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  countOpenPolicyViolations,
  findOpenScopeViolation,
  getScopeViolation,
  listScopeViolations,
  openScopeViolation,
  resolveScopeViolation,
} from "./policy-violations.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("scope violations (phase 7 — table-backed, ruling 5)", () => {
  it("a fresh (empty) database carries NO scope violations (schema is seed-free)", () => {
    // The mock VIB-142 violation moved out of the schema into the demo seed when
    // migrations were squashed — a fresh DB (production/empty dev) starts clean.
    const db = ctx.makeDb();
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(0);
    expect(listScopeViolations(db, "viberr-core", { status: "open" })).toHaveLength(0);
  });

  it("the demo seed re-adds the mock VIB-142 violation (rail badge = 1)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(1);
    expect(countOpenPolicyViolations(db, "deploy-pipeline")).toBe(0);
    const open = listScopeViolations(db, "viberr-core", { status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      scope: "pull_request:write",
      status: "open",
    });
  });

  it("rail-badge signature compatibility: demo seed keeps the count at exactly 1", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });
    // Same call the /projects/:slug shell loader makes (routes/project.tsx).
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(1);
    expect(countOpenPolicyViolations(db, "billing-service")).toBe(0);
  });

  it("openScopeViolation is idempotent per (project, scope, task)", () => {
    // A fresh (empty) DB carries no scope violations — the mock seed moved out of
    // the schema when migrations were squashed. The FIRST open creates the row.
    const db = ctx.makeDb();
    const first = openScopeViolation(db, {
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail: "first attempt",
    });
    expect(first.created).toBe(true);
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(1);

    // A second open for the SAME (project, task, scope) reuses that row.
    const dup = openScopeViolation(db, {
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail: "dup attempt",
    });
    expect(dup.created).toBe(false);
    expect(dup.violation.id).toBe(first.violation.id);
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(1);

    // A different task or scope IS a new violation.
    const otherTask = openScopeViolation(db, {
      projectSlug: "viberr-core",
      taskKey: "VIB-151",
      scope: "pull_request:write",
      detail: "second task",
    });
    const otherScope = openScopeViolation(db, {
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      scope: "repo",
      detail: "different scope",
    });
    expect(otherTask.created).toBe(true);
    expect(otherScope.created).toBe(true);
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(3);
  });

  it("resolve closes exactly one row, is idempotent, and reopening works after", () => {
    const db = ctx.makeDb();
    // Open the violation to resolve (a fresh DB is seed-free after the squash).
    openScopeViolation(db, {
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail: "flagged",
    });
    const seeded = findOpenScopeViolation(
      db,
      "viberr-core",
      "pull_request:write",
      "VIB-142",
    );
    expect(seeded).not.toBeNull();

    const resolved = resolveScopeViolation(db, seeded!.id, {
      userId: "u_test",
      label: "arda@viberr.dev",
    });
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.violation.status).toBe("resolved");
    expect(resolved?.violation.resolvedBy).toBe("u_test");
    expect(resolved?.violation.resolvedAt).toBeTruthy();
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(0);

    // Idempotent second resolve.
    const again = resolveScopeViolation(db, seeded!.id);
    expect(again?.resolved).toBe(false);
    // Unknown id → null.
    expect(resolveScopeViolation(db, "sv_nope")).toBeNull();

    // The violation can reopen later (new row — history preserved).
    const reopened = openScopeViolation(db, {
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail: "flagged again",
    });
    expect(reopened.created).toBe(true);
    expect(reopened.violation.id).not.toBe(seeded!.id);
    expect(listScopeViolations(db, "viberr-core")).toHaveLength(2);
    expect(getScopeViolation(db, seeded!.id)?.status).toBe("resolved");
  });

  it("open/resolve write audit events and emit violation.updated", () => {
    const db = ctx.makeDb();
    const events: string[] = [];
    const unsubscribe = onProjectionEvent((e) => {
      if (e.type === "violation.updated") {
        events.push(`${e.projectSlug}:${e.taskKey}`);
      }
    });
    try {
      const { violation } = openScopeViolation(db, {
        projectSlug: "viberr-core",
        taskKey: "VIB-153",
        scope: "workflow",
        actor: { userId: null, label: "policy-engine" },
      });
      resolveScopeViolation(db, violation.id);
      expect(events).toEqual(["viberr-core:VIB-153", "viberr-core:VIB-153"]);
      expect(
        listAuditEvents(db, { action: "github.scope_violation.opened" }),
      ).toHaveLength(1);
      expect(
        listAuditEvents(db, { action: "github.scope_violation.resolved" }),
      ).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("listScopeViolations filters by status, newest first", () => {
    const db = ctx.makeDb();
    openScopeViolation(db, {
      projectSlug: "proj-x",
      taskKey: "X-1",
      scope: "repo",
    });
    const second = openScopeViolation(db, {
      projectSlug: "proj-x",
      taskKey: "X-2",
      scope: "repo",
    });
    resolveScopeViolation(db, second.violation.id);
    expect(listScopeViolations(db, "proj-x")).toHaveLength(2);
    expect(
      listScopeViolations(db, "proj-x", { status: "open" }).map((v) => v.taskKey),
    ).toEqual(["X-1"]);
    expect(
      listScopeViolations(db, "proj-x", { status: "resolved" }).map(
        (v) => v.taskKey,
      ),
    ).toEqual(["X-2"]);
  });
});
