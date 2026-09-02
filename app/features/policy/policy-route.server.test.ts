import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import type {
  loader as policyLoader,
  action as policyAction,
} from "~/routes/project.policy";
import { RBAC_ROWS, ROLE_IDS } from "./policy-data";

/**
 * Route-level tests for /projects/:slug/policy: loader read model from the
 * seeded store, the 9-row RBAC grant table (contracts §3.2 verbatim), role
 * change round trip (project.md + project_members + audit), the last-admin
 * guard, boundary changes with the review→done human lock, and RBAC
 * denials for non-admins.
 */

let app: AppTestContext;
let ids: SeededUserIds;

/** The seeded humans every request in this file is issued as. */
interface SeededUserIds {
  arda: string;
  elif: string;
  murat: string;
  selin: string;
}

type PolicyLoaderData = Awaited<ReturnType<typeof policyLoader>>;
type PolicyActionData = Awaited<ReturnType<typeof policyAction>>;

/**
 * The accept arm: both intents answer a permitted change with this object
 * directly, no `data()` envelope around it.
 */
interface PolicyAccepted {
  ok: true;
  toast: string;
}

/**
 * The refusal arm. Every guard in routes/project.policy raises an AppError that
 * the action's single catch hands to `appErrorResponse`, i.e.
 * `data({ ok: false, error }, { status })` — so on this arm `init` always exists
 * and carries a numeric status, where react-router types `data()`'s `init` as
 * the general `ResponseInit | null`.
 */
interface PolicyRefusal {
  data: { ok: false; error: string };
  init: { status: number };
}

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // project admin
    elif: findUserByEmail(app.db, "elif@viberr.dev")!.id, // project admin
    murat: findUserByEmail(app.db, "murat@viberr.dev")!.id, // maintainer
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // contributor
  };
});
afterAll(() => app.cleanup());

async function runLoader(userId: string): Promise<PolicyLoaderData> {
  const { loader } = await import("~/routes/project.policy");
  const { cookie } = await app.cookieFor(userId);
  // SAFETY: the loader destructures `request` and `params` and nothing else;
  // React Router's generated `LoaderArgs` additionally carries the framework's
  // `context` provider, which cannot be built outside a real router and which
  // no path under test reads.
  return loader({
    request: app.request("/projects/viberr-core/policy", { cookie }),
    params: { slug: "viberr-core" },
    context: {},
  } as never);
}

async function postAction(
  userId: string,
  fields: Record<string, string>,
): Promise<PolicyActionData> {
  const { action } = await import("~/routes/project.policy");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ ...fields, _csrf: csrf });
  const request = app.request("/projects/viberr-core/policy", {
    method: "POST",
    cookie,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  // SAFETY: as in runLoader — the action reads `request` and `params` only, so
  // this stub carries everything the call executes.
  return action({ request, params: { slug: "viberr-core" }, context: {} } as never);
}

describe("RBAC grant table (derived from PROJECT_CAP_MATRIX)", () => {
  it("carries the canonical rows in broadest→narrowest order", () => {
    expect(RBAC_ROWS.map((r) => r.action)).toEqual([
      "View board, tasks & timelines",
      "Comment on tasks",
      "Create tasks",
      "Take / release own task ownership",
      "Edit task priority, labels & due date",
      "Approve stage transitions",
      "Resolve decision packets",
      "Accept completion → Done",
      "Edit the task goal",
      "Run agents",
      "Reorder the board",
      "Reconcile GitHub state",
      "Grant GitHub scope",
      "Re-scan project files & projections",
      "Release any task owner",
      "Manage members & roles",
      "Manage agent profiles",
      "Edit workflow & policy",
      "Force-accept past the review gate",
    ]);
    expect(ROLE_IDS).toEqual(["admin", "maintainer", "contributor", "viewer"]);
    // Admin holds everything. Q5 clean tiering: a viewer is strictly read +
    // comment; the contributor tier adds "Create tasks" AND task ownership.
    // R8-4: reconcile-github is now maintainer+ (was contributor+).
    expect(RBAC_ROWS.every((r) => r.grant.admin === 1)).toBe(true);
    // E1: view/comment are held by every ROLE and by no non-member — there is no
    // "app-wide" row shape any more, so every row carries four role grants and
    // nothing in this table can render as membership-free.
    expect(RBAC_ROWS.every((r) => Object.keys(r.grant).length === 4)).toBe(true);
    expect(
      RBAC_ROWS.filter((r) => ROLE_IDS.every((role) => r.grant[role] === 1)).map(
        (r) => r.action,
      ),
    ).toEqual(["View board, tasks & timelines", "Comment on tasks"]);
    expect(RBAC_ROWS.map((r) => r.grant.viewer)).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    // edit-task-meta is the 5th row (index 4) and contributor+ holds it.
    expect(RBAC_ROWS.map((r) => r.grant.contributor)).toEqual([
      1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(RBAC_ROWS.map((r) => r.grant.maintainer)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
    ]);
  });
});

describe("loader", () => {
  it("returns members, transitions, stages and the shared roster", async () => {
    const { view } = await runLoader(ids.arda);
    expect(view.projectName).toBe("Viberr Core");
    expect(view.members.map((m) => [m.userId, m.role])).toEqual([
      [ids.elif, "admin"],
      [ids.arda, "admin"],
      [ids.murat, "maintainer"],
      [ids.selin, "contributor"],
    ]);
    expect(view.transitions.map((t) => [t.from, t.to, t.boundary, t.locked])).toEqual([
      ["triage", "ready", "auto", false],
      ["ready", "impl", "auto", false],
      ["impl", "review", "approval", false],
      ["review", "done", "human", true],
    ]);
    // Profile roster is the SAME assembly the Agents surface renders.
    expect(view.profiles.map((p) => p.id)).toEqual([
      "operator",
      "developer",
      "reviewer",
    ]);
    // Fresh seed: no policy-change audit yet → the chip hides.
    expect(view.edited).toBeNull();
    // E32-6: the four enforced guardrails, in shipped order, present and on.
    expect(view.guardrails.filter((g) => g.kind === "default").map((g) => [g.id, g.on, g.present])).toEqual([
      ["meaningful-comment", true, true],
      ["no-duplicate-summary", true, true],
      ["compression-threshold", true, true],
      ["evidence-separation", true, true],
    ]);
    expect(view.guardrails.find((g) => g.id === "compression-threshold")).toMatchObject({
      value: 40,
      unit: "events",
      label: "Compression threshold",
    });
  });
});

describe("set-guardrail (E32-6, pass 32)", () => {
  it("rejects a contributor (Edit workflow & policy is admin-only)", async () => {
    // SAFETY: selin is a contributor; the admin-only capability check raises
    // an AppError the action answers through `appErrorResponse`.
    // SAFETY: this call is refused (a capability or validation AppError the
    // action answers through `appErrorResponse`), so the data is the refusal shape.
    const result = (await postAction(ids.selin, {
      intent: "set-guardrail",
      id: "meaningful-comment",
      op: "off",
    })) as PolicyRefusal;
    expect(result.init?.status).toBe(403);
  });

  it("toggles an enforced guardrail: project.md → projection → audit → toast", async () => {
    // SAFETY: an admin toggling a known row, so `setGuardrail` runs to its
    // accept arm.
    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const off = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "meaningful-comment",
      op: "off",
    })) as PolicyAccepted;
    expect(off).toEqual({
      ok: true,
      toast: "Meaningful comments: off · applies from the next agent comment",
    });
    const { view } = await runLoader(ids.arda);
    expect(view.guardrails.find((g) => g.id === "meaningful-comment")?.on).toBe(false);
    // The file is the truth the runtime reads (comment-guardrails.server.ts).
    const raw = readFileSync(
      path.join(app.dataRoot, "projects", "viberr-core", "project.md"),
      "utf8",
    );
    expect(raw).toMatch(/id: meaningful-comment[\s\S]*?on: false/);
    const audit = listAuditEvents(app.db, { action: "project.policy.guardrail_changed" });
    expect(audit[0]).toMatchObject({
      subjectId: "meaningful-comment",
      details: { id: "meaningful-comment", label: "Meaningful comments", op: "off", beforeOn: true },
    });
    // Idempotent: the same state again changes nothing and says so.
    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const again = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "meaningful-comment",
      op: "off",
    })) as PolicyAccepted;
    expect(again.toast).toBe("Meaningful comments is already off · nothing changed");
    expect(listAuditEvents(app.db, { action: "project.policy.guardrail_changed" })).toHaveLength(1);

    // Restore.
    await postAction(ids.arda, { intent: "set-guardrail", id: "meaningful-comment", op: "on" });
    expect((await runLoader(ids.arda)).view.guardrails.find((g) => g.id === "meaningful-comment")?.on).toBe(true);
  });

  it("sets the compression threshold; refuses a non-number and a unitless row", async () => {
    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const set = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "compression-threshold",
      op: "value",
      value: "60",
    })) as PolicyAccepted;
    expect(set.toast).toBe("Compression threshold: 60 events · applies to the next compaction pass");
    expect((await runLoader(ids.arda)).view.guardrails.find((g) => g.id === "compression-threshold")?.value).toBe(60);

    // SAFETY: this call is refused (a capability or validation AppError the
    // action answers through `appErrorResponse`), so the data is the refusal shape.
    const junk = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "compression-threshold",
      op: "value",
      value: "lots",
    })) as PolicyRefusal;
    expect(junk.init?.status).toBe(400);

    // SAFETY: this call is refused (a capability or validation AppError the
    // action answers through `appErrorResponse`), so the data is the refusal shape.
    const unitless = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "evidence-separation",
      op: "value",
      value: "5",
    })) as PolicyRefusal;
    expect(unitless.init?.status).toBe(400);

    // Restore.
    await postAction(ids.arda, { intent: "set-guardrail", id: "compression-threshold", op: "value", value: "40" });
  });

  it("review F1: a value written onto an ABSENT row keeps it off and says so", async () => {
    // A project whose file lacks the row: the card shows it OFF ("not in
    // project.md") with the shipped number prefilled. Typing a number must
    // save the number without switching compaction on behind the reader's back.
    const { updateProjectFile } = await import("~/server/files/project-writer.server");
    await updateProjectFile({ projectSlug: "viberr-core", dataRoot: app.dataRoot }, (parsed) => {
      parsed.frontmatter.guardrails = parsed.frontmatter.guardrails.filter(
        (g) => g.id !== "compression-threshold",
      );
    });
    const { rebuildPath } = await import("~/server/projections/rebuilder.server");
    const { projectFilePath } = await import("~/server/files/file-store-root.server");
    rebuildPath(app.db, projectFilePath("viberr-core", app.dataRoot), { dataRoot: app.dataRoot });
    expect(
      (await runLoader(ids.arda)).view.guardrails.find((g) => g.id === "compression-threshold"),
    ).toMatchObject({ present: false, on: false, value: 40 });

    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const set = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "compression-threshold",
      op: "value",
      value: "50",
    })) as PolicyAccepted;
    expect(set.toast).toBe(
      "Compression threshold: 50 events · saved; the guardrail is off, so it applies once you turn it on",
    );
    // Canary: push `{ ...shipped, value }` without `on: false` and this reads on:true.
    expect(
      (await runLoader(ids.arda)).view.guardrails.find((g) => g.id === "compression-threshold"),
    ).toMatchObject({ present: true, on: false, value: 50 });

    // Restore: on, at the shipped value.
    await postAction(ids.arda, { intent: "set-guardrail", id: "compression-threshold", op: "on" });
    await postAction(ids.arda, { intent: "set-guardrail", id: "compression-threshold", op: "value", value: "40" });
    expect(
      (await runLoader(ids.arda)).view.guardrails.find((g) => g.id === "compression-threshold"),
    ).toMatchObject({ present: true, on: true, value: 40 });
  });

  it("review F8: removing an id that is not there says so and records nothing", async () => {
    const before = listAuditEvents(app.db, { action: "project.policy.guardrail_changed" }).length;
    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const gone = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "never-existed",
      op: "remove",
    })) as PolicyAccepted;
    // Canary: rebuild the no-op copy by splitting the success toast and this
    // claims "removed … · already so".
    expect(gone.toast).toBe("never-existed is not on this project's guardrails · nothing changed");
    expect(listAuditEvents(app.db, { action: "project.policy.guardrail_changed" })).toHaveLength(before);
  });

  it("never removes an enforced row, never touches the GitHub-owned row, removes an unknown one", async () => {
    // SAFETY: this call is refused (a capability or validation AppError the
    // action answers through `appErrorResponse`), so the data is the refusal shape.
    const keep = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "evidence-separation",
      op: "remove",
    })) as PolicyRefusal;
    expect(keep.init?.status).toBe(400);

    // SAFETY: this call is refused (a capability or validation AppError the
    // action answers through `appErrorResponse`), so the data is the refusal shape.
    const github = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "delete-branch-after-merge",
      op: "off",
    })) as PolicyRefusal;
    expect(github.init?.status).toBe(400);

    // A retired id a hand edit left behind: listed inert, removable here.
    const { updateProjectFile } = await import("~/server/files/project-writer.server");
    await updateProjectFile({ projectSlug: "viberr-core", dataRoot: app.dataRoot }, (parsed) => {
      parsed.frontmatter.guardrails.push({ id: "operator-brevity", desc: "retired", on: true });
    });
    const { rebuildPath } = await import("~/server/projections/rebuilder.server");
    const { projectFilePath } = await import("~/server/files/file-store-root.server");
    rebuildPath(app.db, projectFilePath("viberr-core", app.dataRoot), { dataRoot: app.dataRoot });
    expect((await runLoader(ids.arda)).view.guardrails.find((g) => g.id === "operator-brevity")).toMatchObject({
      kind: "unknown",
      present: true,
      label: "operator-brevity",
    });
    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const removed = (await postAction(ids.arda, {
      intent: "set-guardrail",
      id: "operator-brevity",
      op: "remove",
    })) as PolicyAccepted;
    expect(removed.toast).toBe("operator-brevity removed from this project's guardrails");
    expect((await runLoader(ids.arda)).view.guardrails.some((g) => g.id === "operator-brevity")).toBe(false);
  });
});

describe("set-role", () => {
  it("rejects a maintainer (Manage members & roles is admin-only)", async () => {
    // SAFETY: a maintainer fails the admin-only capability check, which raises
    // an AppError the action answers through `appErrorResponse`.
    // SAFETY: this call is refused (a capability or validation AppError the
    // action answers through `appErrorResponse`), so the data is the refusal shape.
    const result = (await postAction(ids.murat, {
      intent: "set-role",
      userId: ids.selin,
      role: "viewer",
    })) as PolicyRefusal;
    expect(result.init?.status).toBe(403);
  });

  it("round trip: project.md → projection → audit → toast, chip appears", async () => {
    // SAFETY: arda is a project admin demoting someone else, so `setMemberRole`
    // runs to completion and the action returns its accept arm.
    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const result = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.selin,
      role: "viewer",
    })) as PolicyAccepted;
    // D2 (pass 31): the FULL display name — a first name alone is ambiguous
    // among members who share one, and the toast is the only confirmation of
    // WHOSE role just moved.
    expect(result).toEqual({
      ok: true,
      toast: "Selin Aksoy is now Viewer · enforced on the next action",
    });

    // Canonical file updated…
    const file = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    expect(file).toMatch(new RegExp(`userId: ${ids.selin}\\s*\\n\\s*role: viewer`));
    // …projection follows…
    // SAFETY: the SELECT list is the single column `role`, which
    // `project_members` declares TEXT NOT NULL in 0001_baseline, and the row
    // exists because the round trip above just wrote it.
    const row = app.db
      .prepare(
        `SELECT role FROM project_members WHERE project_slug = 'viberr-core' AND user_id = ?`,
      )
      .get(ids.selin) as { role: string };
    expect(row.role).toBe("viewer");
    // …audit row written…
    const audit = listAuditEvents(app.db, {
      action: "project.member.role_changed",
    });
    expect(audit[0]).toMatchObject({
      actorUserId: ids.arda,
      subjectId: ids.selin,
      projectSlug: "viberr-core",
      details: { from: "contributor", to: "viewer" },
    });
    // …and the last-change chip now derives from it.
    const { view } = await runLoader(ids.arda);
    // UXA-16: the loader ships the RAW timestamp; the display form is the
    // client's job. It used to pre-format with `formatDayBucket` on the server,
    // so a UTC container showed the SERVER's calendar day (and no year) while
    // every other timestamp in the app is viewer-local.
    expect(view.edited!.by).toBe("Arda Kaya");
    expect(view.edited!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Restore.
    await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.selin,
      role: "contributor",
    });
  });

  it("last-admin guard: demoting the only admin is blocked server-side", async () => {
    // Two seeded admins — demote elif first (allowed, arda remains).
    // SAFETY: a second admin remains, so the last-admin guard passes and the
    // action returns its accept arm.
    // SAFETY: an admin on a valid input, so `setGuardrail` reaches its accept arm
    // and the action returns the accepted shape.
    const demoteElif = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.elif,
      role: "maintainer",
    })) as PolicyAccepted;
    expect(demoteElif.ok).toBe(true);

    // Now arda is the only admin — self-demotion must be refused.
    // SAFETY: the last-admin guard raises an AppError here, which the action
    // answers through `appErrorResponse`.
    // SAFETY: this call is refused (a capability or validation AppError the
    // action answers through `appErrorResponse`), so the data is the refusal shape.
    const demoteArda = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.arda,
      role: "viewer",
    })) as PolicyRefusal;
    expect(demoteArda.init?.status).toBe(409);
    expect(demoteArda.data?.error).toBe(
      "Viberr Core needs at least one admin. Promote someone else first",
    );

    // Restore elif.
    // SAFETY: a promotion by an admin, so the action returns its accept arm.
    const restore = (await postAction(ids.arda, {
      intent: "set-role",
      userId: ids.elif,
      role: "admin",
    })) as PolicyAccepted;
    expect(restore.ok).toBe(true);
  });
});

describe("set-boundary", () => {
  it("rejects a reviewer (Edit workflow & policy is admin-only)", async () => {
    // SAFETY: a contributor fails the admin-only capability check, which raises
    // an AppError the action answers through `appErrorResponse`.
    const result = (await postAction(ids.selin, {
      intent: "set-boundary",
      from: "impl",
      to: "review",
      boundary: "auto",
    })) as PolicyRefusal;
    expect(result.init?.status).toBe(403);
  });

  it("persists a boundary change with the verbatim toast + audit", async () => {
    // SAFETY: an admin editing an unlocked boundary, so `setTransitionBoundary`
    // runs to completion and the action returns its accept arm.
    const result = (await postAction(ids.arda, {
      intent: "set-boundary",
      from: "impl",
      to: "review",
      boundary: "auto",
    })) as PolicyAccepted;
    expect(result).toEqual({
      ok: true,
      toast: "In Progress → Review: auto-advance · applies to future transitions",
    });
    const { view } = await runLoader(ids.arda);
    const changed = view.transitions.find(
      (t) => t.from === "impl" && t.to === "review",
    )!;
    expect(changed.boundary).toBe("auto");
    // F20-26: the `by` prose is recomputed from the new boundary, so the row no
    // longer contradicts itself (it used to keep the seed's `approval` copy
    // beside an Auto-advance selection). Reverting the `rule.by = …` recompute
    // in setTransitionBoundary makes this go red.
    expect(changed.by).toBe(
      "Operator, within policy; no human decision required",
    );
    const audit = listAuditEvents(app.db, {
      action: "project.policy.boundary_changed",
    });
    // N20-9: the human-readable detail carries stage NAMES, not raw ids, so the
    // rendered audit row matches the toast and the rest of the app.
    expect(audit[0]).toMatchObject({
      details: { from: "In Progress", to: "Review", boundary: "auto" },
    });

    // Restore.
    await postAction(ids.arda, {
      intent: "set-boundary",
      from: "impl",
      to: "review",
      boundary: "approval",
    });
  });

  it("review→done stays LOCKED human — server hard-reject", async () => {
    // SAFETY: the locked-boundary guard raises an AppError even for an admin,
    // which the action answers through `appErrorResponse`.
    const result = (await postAction(ids.arda, {
      intent: "set-boundary",
      from: "review",
      to: "done",
      boundary: "auto",
    })) as PolicyRefusal;
    expect(result.init?.status).toBe(403);
    expect(result.data?.error).toBe(
      "Completion is human-authorized in V1, so this boundary can't be delegated",
    );
    const { view } = await runLoader(ids.arda);
    expect(
      view.transitions.find((t) => t.from === "review" && t.to === "done")!
        .boundary,
    ).toBe("human");
  });
});
