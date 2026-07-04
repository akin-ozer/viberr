import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { loader as taskLoader, action as taskAction } from "~/routes/project.task";

/**
 * Route-level tests for the phase-5 task workspace: real Requests against
 * routes/project.task — loader fidelity for the seeded VIB-142 (packet +
 * 9-event timeline + truth strip), timeline slicing, comment routing
 * detection, resolvePacket dispatch incl. the human-only rejection, and the
 * ownership action matrix (take / hand-off / release / admin-release /
 * RBAC-denied) with the VIB-148 operator-scheduling reaction.
 *
 * ORDER MATTERS inside this file: read-only assertions run before the
 * mutating ones (one seed per file).
 */

let app: AppTestContext;
let ids: { arda: string; elif: string; murat: string; selin: string; deniz: string };

type LoaderData = Awaited<ReturnType<typeof taskLoader>>;
type ActionData = Awaited<ReturnType<typeof taskAction>>;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  const byEmail = (email: string) => findUserByEmail(app.db, email)!.id;
  ids = {
    arda: byEmail("arda@viberr.dev"),
    elif: byEmail("elif@viberr.dev"),
    murat: byEmail("murat@viberr.dev"),
    selin: byEmail("selin@viberr.dev"),
    deniz: byEmail("deniz@viberr.dev"),
  };
});
afterAll(() => app.cleanup());

async function runLoader(key: string, userId: string, search = "") {
  const { loader } = await import("~/routes/project.task");
  const { cookie } = await app.cookieFor(userId);
  return (await loader({
    request: app.request(`/projects/viberr-core/tasks/${key}${search}`, { cookie }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never)) as LoaderData;
}

async function postIntent(
  key: string,
  userId: string,
  fields: Record<string, string>,
) {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  return (await action({
    request: app.request(`/projects/viberr-core/tasks/${key}`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never)) as
    | ActionData
    | { data: { ok: false; error: string }; init: { status: number } };
}

/* --------------------------------------------------- loader (read-only) */

describe("loader — VIB-142 fidelity", () => {
  it("returns the full detail: packet, 9-event timeline, truth strip, store path", async () => {
    const result = await runLoader("VIB-142", ids.arda);
    const t = result.task;

    // Hero + current state.
    expect(t.key).toBe("VIB-142");
    expect(t.title).toBe("Attach execution workspace to task runtime");
    expect(t.stage).toBe("review");
    expect(t.displayReadiness).toBe("input_required");
    expect(t.waiting).toBe("human");
    expect(t.validation).toBe("changed");
    expect(t.urgent).toBe(true);
    expect(t.filePath).toBe("projects/viberr-core/tasks/VIB-142/task.md");
    expect(t.stages.map((s) => s.id)).toEqual([
      "triage", "ready", "impl", "review", "done",
    ]);

    // Execution profile: operator since stage 1, codex specialist, consultant.
    expect(t.operator?.sinceLabel).toBe("stage 1");
    expect(t.specialist?.backend).toBe("codex");
    expect(t.specialist?.role).toBe("Developer");
    expect(t.consultants.map((c) => c.role)).toEqual(["Reviewer"]);
    expect(t.owner?.kind).toBe("human");

    // Decision packet: stable option kinds (ruling 7), observations, rec.
    expect(t.packet).not.toBeNull();
    expect(t.packet!.type).toBe("input");
    expect(t.packet!.kind).toBe("Completion report");
    expect(t.packet!.from).toBe("Operator");
    expect(t.packet!.options.map((o) => o.kind)).toEqual([
      "accept_completion", "request_edit", "block_on_policy",
    ]);
    expect(t.packet!.options.filter((o) => o.rec)).toHaveLength(1);
    expect(t.packet!.observations).toHaveLength(4);
    expect(t.packet!.observations[0]).toEqual({
      k: "Changed", v: "9 files · +412 / −87", code: true,
    });

    // Execution truth strip: branch / commits / diff / PR from real seed.
    expect(t.branch).toBe("vib-142-attach-workspace");
    expect(t.repo).toBe("akin-ozer/viberr"); // project default resolved
    expect(t.pr).toMatchObject({ number: 318, state: "review" });
    expect(t.commits).toHaveLength(3);
    expect(t.commits[0]!.sha).toBe("a91f7c2");
    expect(t.changed).toEqual({ files: 9, add: 412, del: 87 });

    // Timeline: all 9 seeded events, newest first, typed fidelity.
    expect(result.timelineTotal).toBe(9);
    expect(result.timelineHasMore).toBe(false);
    expect(t.timeline).toHaveLength(9);
    expect(t.timeline.map((e) => e.type)).toEqual([
      "comment", "completion", "github", "policy", "quality",
      "transition", "agent", "comment", "assign",
    ]);
    const [newest, completion] = t.timeline;
    expect(newest!.toAgent).toBe(true); // @operator-routed comment
    expect(newest!.actor).toMatchObject({ kind: "human", name: "Arda Kaya" });
    expect(completion!.title).toBe("Completion report");
    expect(completion!.evidence).toEqual([
      { label: "unit/policy_gate_test", add: "+14", del: "0" },
      { label: "integration/pr_sync_test", add: "+38", del: "−4" },
    ]);
    const policy = t.timeline.find((e) => e.type === "policy")!;
    expect(policy.actor).toMatchObject({ kind: "system", name: "Policy engine" });
    const operatorEv = t.timeline.find((e) => e.type === "agent")!;
    expect(operatorEv.actor).toMatchObject({ kind: "agent", name: "Operator" });

    expect(result.tlDefault).toBe("all");
  });

  it("slices the timeline via ?events= (progressive disclosure)", async () => {
    const result = await runLoader("VIB-142", ids.arda, "?events=2");
    expect(result.task.timeline).toHaveLength(2);
    expect(result.timelineTotal).toBe(9);
    expect(result.timelineHasMore).toBe(true);
    expect(result.timelineRemaining).toBe(7);
    expect(result.timelineNextLimit).toBe(9); // capped at the total
  });

  it("VIB-153 carries Deniz's guest comment (app user · not in project)", async () => {
    const result = await runLoader("VIB-153", ids.arda);
    const deniz = result.task.timeline[0]!;
    expect(deniz.type).toBe("comment");
    expect(deniz.actor).toMatchObject({
      kind: "human",
      name: "Deniz Şahin",
      guest: true,
    });
  });

  it("honors the per-user tlDefault preference", async () => {
    const { setPref } = await import("~/server/prefs/user-prefs.server");
    setPref(app.db, ids.selin, "tlDefault", "typed");
    const result = await runLoader("VIB-142", ids.selin);
    expect(result.tlDefault).toBe("typed");
  });

  it("404s unknown keys into the in-shell boundary", async () => {
    const thrown = await runLoader("VIB-999", ids.arda).catch((e) => e);
    expect(thrown?.init?.status ?? thrown?.status).toBe(404);
  });
});

/* ------------------------------------------------------ comment routing */

describe("comment action — @agent routing detection", () => {
  it("@operator routes to the agent side (toagent tint + routed toast)", async () => {
    const result = (await postIntent("VIB-153", ids.arda, {
      intent: "comment",
      text: "@operator please tighten the packet budget",
    })) as { ok: true; toAgent: boolean; toast: string };
    expect(result.ok).toBe(true);
    expect(result.toAgent).toBe(true);
    expect(result.toast).toBe("Comment posted · routed to mentioned agent");

    const after = await runLoader("VIB-153", ids.arda);
    expect(after.task.timeline[0]).toMatchObject({
      type: "comment",
      toAgent: true,
    });
  });

  it("@codex and @claude also route; plain member mentions do not", async () => {
    const codex = (await postIntent("VIB-153", ids.arda, {
      intent: "comment", text: "@codex check the linter",
    })) as { toAgent: boolean };
    expect(codex.toAgent).toBe(true);

    const plain = (await postIntent("VIB-153", ids.arda, {
      intent: "comment", text: "cc @murat for a second look",
    })) as { ok: true; toAgent: boolean; toast: string };
    expect(plain.toAgent).toBe(false);
    expect(plain.toast).toBe("Comment posted");
  });

  it("non-members may comment app-wide and project as guests", async () => {
    const result = (await postIntent("VIB-153", ids.deniz, {
      intent: "comment", text: "Following from the platform side.",
    })) as { ok: true };
    expect(result.ok).toBe(true);
    const after = await runLoader("VIB-153", ids.deniz);
    expect(after.task.timeline[0]!.actor).toMatchObject({
      kind: "human",
      name: "Deniz Şahin",
      guest: true,
    });
  });

  it("rejects empty comments", async () => {
    const result = (await postIntent("VIB-153", ids.arda, {
      intent: "comment", text: "   ",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(400);
  });
});

/* ------------------------------------------------------- resolvePacket */

describe("resolve-packet action — kind dispatch + RBAC", () => {
  it("rejects non-privileged members on accept_completion (human-only boundary)", async () => {
    const result = (await postIntent("VIB-142", ids.selin, {
      intent: "resolve-packet", option: "0",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("cannot accept completion");
  });

  it("rejects non-members entirely", async () => {
    const result = (await postIntent("VIB-142", ids.deniz, {
      intent: "resolve-packet", option: "1",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("Only project members");
  });

  it("block_on_policy: blocks + KEEPS the packet + navigates to settings", async () => {
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "2",
    })) as { ok: true; kind: string; toast: string; navigateTo?: string };
    expect(result.kind).toBe("block_on_policy");
    expect(result.toast).toBe("Task held on policy · opening repository settings");
    expect(result.navigateTo).toBe("/projects/viberr-core/settings");

    const after = await runLoader("VIB-142", ids.arda);
    expect(after.task.readiness).toBe("blocked");
    expect(after.task.waiting).toBe("human");
    expect(after.task.packet).not.toBeNull(); // held, not cleared
    expect(after.task.timeline[0]).toMatchObject({ type: "blocked" });
    expect(after.task.timeline[0]!.text).toBe(
      "**Decision:** hold on policy. VIB-142 stays blocked until the project credential policy is updated.",
    );
  });

  it("request_edit: clears the packet, flips waiting to agent, writes option.ev", async () => {
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "1",
    })) as { ok: true; kind: string; toast: string; navigateTo?: string };
    expect(result.kind).toBe("request_edit");
    expect(result.toast).toBe("Decision recorded: Request one edit");
    expect(result.navigateTo).toBeUndefined();

    const after = await runLoader("VIB-142", ids.arda);
    expect(after.task.packet).toBeNull();
    expect(after.task.waiting).toBe("agent");
    expect(after.task.readiness).toBe("ready");
    expect(after.task.timeline[0]).toMatchObject({ type: "transition" });
    expect(after.task.timeline[0]!.text).toBe(
      "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance.",
    );
  });

  it("second resolve conflicts (409) instead of crashing", async () => {
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "1",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(409);
    expect(result.data.error).toBe("This packet was already resolved.");
  });

  it("hold_runtime_debug on VIB-160 keeps the packet with blocked readiness", async () => {
    const result = (await postIntent("VIB-160", ids.murat, {
      intent: "resolve-packet", option: "2",
    })) as { ok: true; kind: string; toast: string };
    expect(result.kind).toBe("hold_runtime_debug");
    expect(result.toast).toBe(
      "Held for runtime debug — the session is recorded per audit policy",
    );
    const after = await runLoader("VIB-160", ids.murat);
    expect(after.task.readiness).toBe("blocked");
    expect(after.task.packet).not.toBeNull();
    expect(after.task.timeline[0]!.text).toContain(
      "**Decision:** hold for runtime debug. VIB-160 stays blocked",
    );
  });
});

/* ---------------------------------------------------- ownership matrix */

describe("ownership actions", () => {
  it("take on VIB-148 fires the operator-scheduling reaction (ruling §3.3)", async () => {
    const result = (await postIntent("VIB-148", ids.arda, {
      intent: "owner-take",
    })) as { ok: true; toast: string };
    expect(result.toast).toBe("You own VIB-148 · review & acceptance");

    const after = await runLoader("VIB-148", ids.arda);
    expect(after.task.owner).toMatchObject({ kind: "human", name: "Arda Kaya" });
    // Operator reaction: waiting flips to agent, readiness to ready…
    expect(after.task.waiting).toBe("agent");
    expect(after.task.readiness).toBe("ready");
    // …and the operator wrote its own `agent` event ABOVE the assign event.
    expect(after.task.timeline[0]).toMatchObject({ type: "agent" });
    expect(after.task.timeline[0]!.actor).toMatchObject({
      kind: "agent",
      name: "Operator",
    });
    expect(after.task.timeline[0]!.text).toBe(
      "Acceptance boundary now owned by **Arda Kaya** — scheduling execution against the quality-gated scope.",
    );
    expect(after.task.timeline[1]).toMatchObject({ type: "assign" });
    expect(after.task.timeline[1]!.text).toBe(
      "Took task ownership — owner is the human reviewer and acceptance authority for this task.",
    );
  });

  it("self release writes the exact assign copy (no re-scheduling on re-take)", async () => {
    const result = (await postIntent("VIB-148", ids.arda, {
      intent: "owner-release",
    })) as { ok: true; forced: boolean; toast: string };
    expect(result.forced).toBe(false);
    expect(result.toast).toBe("Ownership released on VIB-148");

    const after = await runLoader("VIB-148", ids.arda);
    expect(after.task.owner).toBeNull();
    expect(after.task.timeline[0]!.text).toBe(
      "Released task ownership — review & acceptance stall until another member takes the seat.",
    );
    // waiting is now "agent" → the quality-gate reaction must not re-fire.
    const again = (await postIntent("VIB-148", ids.selin, {
      intent: "owner-take",
    })) as { ok: true };
    expect(again.ok).toBe(true);
    const after2 = await runLoader("VIB-148", ids.selin);
    expect(after2.task.timeline[0]).toMatchObject({ type: "assign" });
    expect(after2.task.timeline[0]!.text).toBe(
      "Took task ownership — owner is the human reviewer and acceptance authority for this task.",
    );
  });

  it("non-owner non-admin cannot hand off or release someone else's seat", async () => {
    // VIB-151 is owned by Selin; Murat is a maintainer (not owner, not admin).
    const handoff = (await postIntent("VIB-151", ids.murat, {
      intent: "owner-assign", userId: ids.elif,
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(handoff.init.status).toBe(403);
    expect(handoff.data.error).toContain("Only the current owner or a project admin");

    const release = (await postIntent("VIB-160", ids.selin, {
      intent: "owner-release",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(release.init.status).toBe(403);
    expect(release.data.error).toContain("Only project admins");
  });

  it("hand-off by admin + admin release with the forced copy + audit trail", async () => {
    const handoff = (await postIntent("VIB-151", ids.arda, {
      intent: "owner-assign", userId: ids.murat,
    })) as { ok: true; toast: string };
    expect(handoff.toast).toBe("Ownership handed to Murat");
    let after = await runLoader("VIB-151", ids.arda);
    expect(after.task.owner).toMatchObject({ name: "Murat Yıldız" });
    expect(after.task.timeline[0]!.text).toBe(
      "Handed task ownership to **Murat Yıldız** — they hold review & acceptance for this task now.",
    );

    const release = (await postIntent("VIB-151", ids.arda, {
      intent: "owner-release",
    })) as { ok: true; forced: boolean; toast: string };
    expect(release.forced).toBe(true);
    expect(release.toast).toBe("Murat released from VIB-151 · admin action");
    after = await runLoader("VIB-151", ids.arda);
    expect(after.task.owner).toBeNull();
    expect(after.task.timeline[0]!.text).toBe(
      "Released **Murat Yıldız** from task ownership (admin) — the seat is open to any project member.",
    );

    // Admin release promise: recorded in the audit trail (spec §4.5).
    const audit = app.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_events
         WHERE action = 'task.ownership.admin_released' AND subject_id = 'VIB-151'`,
      )
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it("take-over writes the take-over copy", async () => {
    // Selin owns VIB-148 (from the earlier test); Murat takes over.
    const result = (await postIntent("VIB-148", ids.murat, {
      intent: "owner-take",
    })) as { ok: true };
    expect(result.ok).toBe(true);
    const after = await runLoader("VIB-148", ids.murat);
    expect(after.task.timeline[0]!.text).toBe(
      "Took over task ownership from **Selin Aksoy** — owner is the human reviewer and acceptance authority.",
    );
  });

  it("non-members are denied ownership; hand-off to a non-member is denied", async () => {
    const take = (await postIntent("VIB-148", ids.deniz, {
      intent: "owner-take",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(take.init.status).toBe(403);
    expect(take.data.error).toContain("Only project members");

    const toGuest = (await postIntent("VIB-148", ids.murat, {
      intent: "owner-assign", userId: ids.deniz,
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(toGuest.init.status).toBe(403);
    expect(toGuest.data.error).toContain("only be handed to a project member");
  });
});

/* ---------------------------------------------------- stage transitions */

describe("transition action (server-enforced boundaries)", () => {
  it("review → done is human-only: reviewers are rejected", async () => {
    const result = (await postIntent("VIB-145", ids.selin, {
      intent: "transition", to: "done",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("accept completion into Done");
  });

  it("undeclared boundaries are rejected as validation errors", async () => {
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "transition", to: "triage",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("No governed boundary");
  });
});
