import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import type { loader as taskLoader, action as taskAction } from "~/routes/project.task";

/**
 * Route-level tests for the phase-5 task workspace: real Requests against
 * routes/project.task — loader fidelity for the seeded VIB-142 (packet +
 * 9-event timeline + truth strip), timeline slicing, comment routing
 * detection, resolvePacket dispatch incl. the human-only rejection, and the
 * ownership action matrix (take / hand-off / release / admin-release /
 * RBAC-denied) — VIB-148 proves ownership is a clean mutation with no operator
 * side effects (F19).
 *
 * ORDER MATTERS inside this file: read-only assertions run before the
 * mutating ones (one seed per file).
 */

let app: AppTestContext;
let ids: { arda: string; elif: string; murat: string; selin: string; deniz: string };

type LoaderData = Awaited<ReturnType<typeof taskLoader>>;
type ActionData = Awaited<ReturnType<typeof taskAction>>;

beforeAll(async () => {
  // File-wide, BEFORE the first test. This used to live in the comment-routing
  // describe's own `beforeAll`, which was too late: earlier describes in this
  // file (packet resolution, ownership) can also start agent runs, and those
  // ran against the REAL adapters — hanging forever while holding the operator
  // lease. The next `@operator` comment then waited on that lease and died on
  // the 5s timeout, intermittently, depending on what ran before it.
  installFakeRuntime();
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
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

    // Execution profile: operator since Triage (stage NAME, F7-UI2), codex
    // specialist, reviewer.
    expect(t.operator?.sinceLabel).toBe("since Triage");
    expect(t.specialist?.backend).toBe("codex");
    // Role snapshots come from the LIVE seeded profiles (generic-agents seed
    // hygiene - hand-written snapshots shielded the VIB-12 codec bug).
    expect(t.specialist?.role).toBe("Implementation");
    expect(t.reviewers.map((c) => c.role)).toEqual(["Review & validation"]);
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
  // VIB-153 carries a Codex specialist, so @operator/@codex starts or resumes
  // runtime work. Inject a fake adapter and stop any run left open by a test.
  // Do NOT re-install the fake runtime here — the file-level beforeAll already
  // did, and re-installing clears its queued runs. Just drop any operator lease
  // an earlier describe left held, so an `@operator` comment is never waiting
  // on a run that belongs to a finished test.
  beforeAll(async () => {
    const { resetOperatorLeasesForTests } = await import(
      "~/server/runtimes/operator-run.server"
    );
    resetOperatorLeasesForTests();
  });

  async function stopTaskRuns(key: string, userId: string) {
    const { listRunsForTaskRows } = await import(
      "~/server/runtimes/run-store.server"
    );
    const { interruptRun } = await import(
      "~/server/runtimes/run-service.server"
    );
    for (const run of listRunsForTaskRows(app.db, "viberr-core", key)) {
      if (run.state === "running" || run.state === "queued") {
        try {
          interruptRun(
            app.db,
            { projectSlug: "viberr-core", taskKey: key, runId: run.id },
            { userId, label: "test" },
          );
        } catch {
          // ignore
        }
      }
    }
  }

  // 20s, not the 5s default: this test drives the FULL orchestration path
  // (comment → mention resolution → operator lease → run start → interrupt),
  // and under the parallel full-suite load it exceeded 5s often enough to go
  // red about one run in three while passing 3/3 in isolation. A timeout that
  // measures machine load rather than behavior is a false signal — the
  // assertions below are unchanged.
  it("@operator on a task WITH a specialist triggers the agent + names it in the toast", { timeout: 20_000 }, async () => {
    const result = (await postIntent("VIB-153", ids.arda, {
      intent: "comment",
      text: "@operator please tighten the packet budget",
    })) as { ok: true; toAgent: boolean; agent: string | null; triggered: string | null; toast: string };
    expect(result.ok).toBe(true);
    expect(result.toAgent).toBe(true);
    // Resolves to VIB-153's codex specialist and engages it.
    expect(result.agent).toBeTruthy();
    expect(result.triggered).toBeTruthy();
    expect(result.toast).toContain("is picking it up");
    await stopTaskRuns("VIB-153", ids.arda);

    const after = await runLoader("VIB-153", ids.arda);
    // The human comment is recorded with the routed tint.
    const humanComment = after.task.timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "human",
    )!;
    expect(humanComment).toMatchObject({ type: "comment", toAgent: true });
  });

  it("@codex also routes + triggers; plain member mentions do not", { timeout: 20_000 }, async () => {
    const codex = (await postIntent("VIB-153", ids.arda, {
      intent: "comment", text: "@codex check the linter",
    })) as { toAgent: boolean; triggered: string | null };
    expect(codex.toAgent).toBe(true);
    expect(codex.triggered).toBeTruthy();
    await stopTaskRuns("VIB-153", ids.arda);

    const plain = (await postIntent("VIB-153", ids.arda, {
      intent: "comment", text: "cc @murat for a second look",
    })) as { ok: true; toAgent: boolean; triggered: string | null; toast: string };
    expect(plain.toAgent).toBe(false);
    expect(plain.triggered).toBeNull();
    expect(plain.toast).toBe("Comment posted");
  });

  it("R15-4: a NON-MEMBER's comment is refused with the unknown-slug 404", async () => {
    // The layout loader refuses the read, but React Router runs a child ACTION
    // without its parent's loader — so this POST used to land a comment (and
    // could @mention an agent) inside a project the actor must not know exists.
    const before = (await runLoader("VIB-153", ids.arda)).task.timeline.length;
    const thrown = (await postIntent("VIB-153", ids.deniz, {
      intent: "comment", text: "Following from the platform side.",
    }).catch((e) => e)) as { init?: { status: number }; data?: unknown };
    expect(thrown?.init?.status).toBe(404);
    // Byte-identical to the unknown-slug refusal — no existence confirmation.
    expect(String(thrown?.data)).toBe("No project at projects/viberr-core.");
    // …and nothing was written.
    expect((await runLoader("VIB-153", ids.arda)).task.timeline).toHaveLength(
      before,
    );
  });

  it("R15-4: an ORG ADMIN who is not a member still acts (audited D2 override)", async () => {
    const { updateUserFields } = await import("~/server/auth/user-store.server");
    updateUserFields(app.db, ids.deniz, { role: "admin" });
    try {
      const result = (await postIntent("VIB-153", ids.deniz, {
        intent: "comment", text: "Checking in from the org-admin override.",
      })) as { ok: true };
      expect(result.ok).toBe(true);
      const after = await runLoader("VIB-153", ids.deniz);
      expect(after.task.timeline[0]!.actor).toMatchObject({
        kind: "human",
        name: "Deniz Şahin",
        guest: true,
      });
    } finally {
      updateUserFields(app.db, ids.deniz, { role: "member" });
    }
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
  // R20-1 (F20-5): a confirmed recovery option now RESOLVES (clears) the packet,
  // so each packet resolves at most once. Re-seed before every test in this
  // block (runDemoSeed is idempotent — it overwrites the task files, resetting
  // VIB-142/VIB-160's packets to open) so the tests no longer daisy-chain off
  // one shared packet that the first successful resolve would clear.
  beforeEach(async () => {
    // R20-1 (F20-5): block_on_policy/request_edit now RESOLVE the packet and
    // fire-and-forget a `packet-resolved` operator re-invoke (`void
    // autoInvokeOperator`). Let any such re-invoke from the PRIOR test fully
    // start (consume its queued `keepRunning` fake run, take the lease, then sit
    // inert) BEFORE re-seeding, so it can't asynchronously clobber the fresh
    // packet mid-test. Two macrotask hops drain the microtask + timer queues.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const { runDemoSeed } = await import("../../../test-support/demo-seed");
    await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  });

  it("rejects a non-owner contributor accepting a completion packet (R6-2)", async () => {
    // Accepting a completion is admin|maintainer OR the task's owner (R6-2).
    // selin is a contributor and NOT VIB-142's owner, so the accept path denies.
    const result = (await postIntent("VIB-142", ids.selin, {
      intent: "resolve-packet", option: "0",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("accept completion into Done");
  });

  it("rejects non-members entirely (R15-4: as an unknown slug, not a 403)", async () => {
    const thrown = (await postIntent("VIB-142", ids.deniz, {
      intent: "resolve-packet", option: "1",
    }).catch((e) => e)) as { init?: { status: number }; data?: unknown };
    expect(thrown?.init?.status).toBe(404);
    expect(String(thrown?.data)).toBe("No project at projects/viberr-core.");
  });

  it("block_on_policy (R20-1): UNBLOCKS, clears the packet, re-queues the operator, no settings nav", async () => {
    // R20-1 (F20-5): the option's label promises an unblock, so it now records
    // one — readiness→ready, waiting→agent, the packet clears, and the operator
    // re-runs to re-check. It used to hold the task blocked, keep the packet
    // open (re-accepting the same confirm forever), and deep-nav to settings.
    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "re-checking" }],
      keepRunning: true,
    });
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "2",
    })) as { ok: true; kind: string; toast: string; navigateTo?: string };
    expect(result.kind).toBe("block_on_policy");
    expect(result.toast).toBe(
      "Policy / credential updated · the operator re-runs to re-check",
    );
    expect(result.navigateTo).toBeUndefined();

    const after = await runLoader("VIB-142", ids.arda);
    expect(after.task.readiness).toBe("ready");
    expect(after.task.waiting).toBe("agent");
    expect(after.task.packet).toBeNull(); // resolved, not held
    // The re-queue may post its own events, so find the decision by type.
    const decision = after.task.timeline.find((e) => e.type === "transition");
    expect(decision).toBeDefined();
    expect(decision!.text).toContain("policy / credential updated");
    expect(decision!.text).toContain("unblocked");
  });

  it("request_edit: clears the packet, flips waiting to agent, writes option.ev", async () => {
    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "working" }],
      keepRunning: true,
    });
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
    // Sending work back re-invokes the operator (which may post its own events),
    // so locate the decision transition by type rather than assuming position.
    const decision = after.task.timeline.find((e) => e.type === "transition");
    expect(decision).toBeDefined();
    expect(decision!.text).toBe(
      "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance.",
    );
  });

  it("second resolve conflicts (409) instead of crashing", async () => {
    // Self-contained now that each test starts from a fresh packet (beforeEach):
    // resolve once (request_edit clears it + re-queues), then a second resolve
    // of the now-cleared packet must 409, not crash.
    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "working" }],
      keepRunning: true,
    });
    const first = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "1",
    })) as { ok: true; kind: string };
    expect(first.kind).toBe("request_edit");

    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "1",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(409);
    expect(result.data.error).toBe("This packet was already resolved.");
  });

  it("hold_runtime_debug on VIB-160 (R20-1): stays blocked but RESOLVES the packet", async () => {
    const result = (await postIntent("VIB-160", ids.murat, {
      intent: "resolve-packet", option: "2",
    })) as { ok: true; kind: string; toast: string };
    expect(result.kind).toBe("hold_runtime_debug");
    expect(result.toast).toBe(
      "Held for runtime debug — the session is recorded per audit policy",
    );
    const after = await runLoader("VIB-160", ids.murat);
    // R20-1 (F20-5): still a hold (readiness stays blocked, no run starts), but
    // the packet now CLEARS — it used to stay open and re-accept the same confirm.
    expect(after.task.readiness).toBe("blocked");
    expect(after.task.packet).toBeNull();
    expect(after.task.timeline[0]!.text).toContain(
      "**Decision:** hold for runtime debug. VIB-160 stays blocked",
    );
  });
});

/* ---------------------------------------------------- ownership matrix */

describe("ownership actions", () => {
  it("take on VIB-148 records ownership only — no operator scheduling side effects (F19)", async () => {
    const opRuns = () =>
      (
        app.db
          .prepare(
            `SELECT count(*) AS c FROM agent_runs WHERE kind = 'operator' AND task_key = 'VIB-148'`,
          )
          .get() as { c: number }
      ).c;
    const before = opRuns();

    const result = (await postIntent("VIB-148", ids.arda, {
      intent: "owner-take",
    })) as { ok: true; toast: string };
    expect(result.toast).toBe("You own VIB-148 · review & acceptance");

    const after = await runLoader("VIB-148", ids.arda);
    expect(after.task.owner).toMatchObject({ kind: "human", name: "Arda Kaya" });
    // The assign event sits at the top of the timeline…
    expect(after.task.timeline[0]!.type).toBe("assign");
    expect(after.task.timeline[0]!.text).toBe(
      "Took task ownership — owner is the human reviewer and acceptance authority for this task.",
    );
    // …board state is untouched: no fabricated ready/agent flip (VIB-148 stays
    // input_required + waiting on a human — ownership is orthogonal to
    // scheduling)…
    expect(after.task.waiting).toBe("human");
    expect(after.task.readiness).toBe("input_required");
    // …no synthesized "scheduling execution against the quality-gated scope"
    // narration (the removed mock stand-in)…
    expect(
      after.task.timeline.some((e) => e.text.includes("scheduling execution")),
    ).toBe(false);
    // …and NO operator run is fired on ownership: the operator is driven by its
    // real lifecycle triggers, not by claiming the acceptance seat.
    expect(opRuns()).toBe(before);
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
    // Re-taking is a clean ownership mutation: just the assign event on top,
    // no operator scheduling reaction to re-fire (F19).
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
    // Canonical guard (release-any-ownership = admin only): the message names the
    // actor's role rather than a hard-coded "admins" string.
    expect(release.data.error).toContain("cannot release another member's ownership");
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
    // F19-11: "any project member" was the wrong RBAC sentence (a viewer is a
    // member and cannot own) — the copy and this pin are corrected together.
    expect(after.task.timeline[0]!.text).toBe(
      "Released **Murat Yıldız** from task ownership (admin) — the seat is open to any contributor or above.",
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
    // R15-4: a non-member never gets past the route's visibility gate, so the
    // refusal is the unknown-slug 404 rather than the mutation's own 403.
    const take = (await postIntent("VIB-148", ids.deniz, {
      intent: "owner-take",
    }).catch((e) => e)) as { init?: { status: number }; data?: unknown };
    expect(take?.init?.status).toBe(404);
    expect(String(take?.data)).toBe("No project at projects/viberr-core.");

    const toGuest = (await postIntent("VIB-148", ids.murat, {
      intent: "owner-assign", userId: ids.deniz,
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(toGuest.init.status).toBe(403);
    expect(toGuest.data.error).toContain("only be handed to a project member");
  });
});

/* ---------------------------------------------------- stage transitions */

describe("transition action (manual stage move — admin|maintainer)", () => {
  it("moving to Done routes through acceptance: a contributor is rejected", async () => {
    // A manual move INTO the final stage IS accepting completion — the RBAC
    // message reflects the acceptance authority, still admin|maintainer.
    const result = (await postIntent("VIB-145", ids.selin, {
      intent: "transition", to: "done",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("accept completion into Done");
  });

  it("a non-final manual move is admin|maintainer only: a contributor is rejected", async () => {
    const result = (await postIntent("VIB-145", ids.selin, {
      intent: "transition", to: "triage",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("change the task stage");
  });

  it("an admin can move across a non-boundary edge (manual override), with a toast", async () => {
    // triage is not a declared boundary FROM VIB-145's stage — allowed only
    // because the dropdown move is `manual`. (The transition comment it writes
    // is covered by task-governance.server.test.ts against an isolated store.)
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "transition", to: "triage",
    })) as { ok: true; intent: string; stage: string; toast: string };
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("triage");
    expect(result.toast).toContain("Moved VIB-145 to Triage");
  });

  it("rejects a move to a stage that isn't in the project", async () => {
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "transition", to: "nope",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(400);
  });
});

/* ------------------------------------------ specialist assign + run intents */

describe("loader — deployed specialists", () => {
  it("exposes the project's deployed specialists (developer) + runActive flag", async () => {
    const result = await runLoader("VIB-166", ids.arda);
    const ids2 = result.deployedSpecialists.map((s) => s.id);
    // The seed deploys operator + developer/reviewer; the
    // operator must NOT appear (specialists only).
    expect(ids2).toContain("developer");
    expect(ids2).not.toContain("operator");
    const dev = result.deployedSpecialists.find((s) => s.id === "developer")!;
    expect(dev).toMatchObject({ role: "Implementation" });
    expect(dev.backend === "codex" || dev.backend === "claude").toBe(true);
    // F10-04: per-engagement run gating replaced the single `runActive` boolean.
    expect(result.deliveringActive).toBe(false); // no delivering run on VIB-166
    expect(result.activeReviewerIds).toEqual([]); // no reviewer run either
  });
});

describe("assign-specialist + run-specialist intents", () => {
  it("assigns the developer specialist (admin) → frontmatter + agent event + toast", async () => {
    // VIB-166 is a triage task with no specialist. The Developer's eligible
    // stages are ready/impl (F1 now enforces this), so move it to Ready first —
    // assigning a developer at Triage is correctly rejected.
    await postIntent("VIB-166", ids.arda, { intent: "transition", to: "ready" });
    const result = (await postIntent("VIB-166", ids.arda, {
      intent: "assign-specialist", profileId: "developer",
    })) as { ok: true; toast: string };
    expect(result.ok).toBe(true);
    expect(result.toast).toBe("Deployed Developer as specialist");

    const after = await runLoader("VIB-166", ids.arda);
    expect(after.task.specialist).toMatchObject({
      profileId: "developer",
      role: "Implementation",
    });
    // Moving VIB-166 into the auto "ready" stage above auto-invokes the
    // operator; with no workspace to advance (the read-only checkout fails
    // fast under GIT_ALLOW_PROTOCOL=file) its stranded-resume chain hits the
    // transition-chain cap and leaves a system stall note. That async note can
    // sit ABOVE the assign event, so locate the deployment by type + copy
    // rather than assuming it is the newest entry — the same reason the
    // request_edit case finds its transition by type instead of position.
    const deployed = after.task.timeline.find(
      (e) => e.type === "agent" && e.text.includes("Deployed **Developer**"),
    );
    expect(deployed, "the assign event must be recorded as an agent event").toBeDefined();
  });

  it("reviewer + viewer are denied assign (admin|maintainer only)", async () => {
    const reviewer = (await postIntent("VIB-145", ids.selin, {
      intent: "assign-specialist", profileId: "developer",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(reviewer.init.status).toBe(403);
  });

  it("rejects assigning a specialist to a stage outside its eligibility (F1)", async () => {
    // VIB-168 is at Triage; the Developer profile is scoped to ready/impl.
    const result = (await postIntent("VIB-168", ids.arda, {
      intent: "assign-specialist", profileId: "developer",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("not eligible");
  });

  it("assigning an unknown profile id is a validation error", async () => {
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "assign-specialist", profileId: "does-not-exist",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(400);
  });

  it("run-specialist requires an assigned specialist", async () => {
    // VIB-168 has no specialist assigned (VIB-148 gains one when the ownership
    // test's real operator reaction assigns the Developer).
    const result = (await postIntent("VIB-168", ids.arda, {
      intent: "run-specialist",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("Engage a delivering agent");
  });

  it("run-specialist starts a run for the assigned specialist (streaming toast)", async () => {
    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "working" }],
      keepRunning: true,
    }, "codex");
    // VIB-166 now has the developer specialist assigned (from the earlier test).
    // The earlier assign/transition auto-invoked the operator, which may have
    // already started a primary run — F7-OP1 single-flight then (correctly)
    // refuses a second concurrent run. Clear any in-flight primary first so this
    // test verifies the human "Run" action on a task with no active run.
    const before = await runLoader("VIB-166", ids.arda);
    const { interruptRun: stopExisting } = await import(
      "~/server/runtimes/run-service.server"
    );
    for (const r of before.runtime.filter(
      (r) => r.kind === "primary" && (r.state === "running" || r.state === "idle"),
    )) {
      stopExisting(
        app.db,
        { projectSlug: "viberr-core", taskKey: "VIB-166", runId: r.serverRunId },
        { userId: ids.arda, label: "arda@viberr.dev" },
      );
    }
    const result = (await postIntent("VIB-166", ids.arda, {
      intent: "run-specialist",
    })) as { ok: true; toast: string };
    expect(result.ok).toBe(true);
    expect(result.toast).toContain("run started · streaming to agent logs");

    const after = await runLoader("VIB-166", ids.arda);
    // A primary run now exists on the task.
    const primary = after.runtime.find((r) => r.kind === "primary");
    expect(primary).toBeDefined();
    expect(after.task.timeline[0]!.text).toContain("run for the Implementation agent");

    // Stop the run's realistic-cadence timer so it does not outlive the suite
    // and write to the DB after afterAll() closes it (the sink guards this,
    // but interrupting keeps the run registry + logs clean).
    const { interruptRun } = await import("~/server/runtimes/run-service.server");
    interruptRun(
      app.db,
      { projectSlug: "viberr-core", taskKey: "VIB-166", runId: primary!.serverRunId },
      { userId: ids.arda, label: "arda@viberr.dev" },
    );
  });

  it("reviewer is denied run-specialist (admin|maintainer only)", async () => {
    const result = (await postIntent("VIB-166", ids.selin, {
      intent: "run-specialist",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
  });
});

/* ------------------------------------ acceptance affordance + task archive */

/**
 * P14-LV-06 — the review queue counted a viewer under "Waiting on your
 * acceptance" while the task page rendered acceptance only as an operator
 * recommendation, so a withdrawn recommendation left the promised decision with
 * no control. The loader now ships the same predicate the queue counts with.
 *
 * R14-3 — the task archive the closed-PR guidance had been naming for a pass.
 */
describe("acceptance affordance (P14-LV-06)", () => {
  it("ships the viewer's authority, the boundary and the refusal", async () => {
    const atTriage = await runLoader("VIB-166", ids.arda);
    expect(atTriage.acceptance.hasAuthority).toBe(true);
    // Not at the review boundary → no acceptance control is rendered at all.
    expect(atTriage.acceptance.atBoundary).toBe(false);
    expect(atTriage.acceptance.canAccept).toBe(false);
    expect(atTriage.acceptance.blockedReason).toBeTruthy();
  });

  it("a non-member never gets as far as an acceptance affordance (R15-4)", async () => {
    // Before R15-4 a non-member loaded the page and saw `hasAuthority: false`.
    // Members-only projects refuse the read outright, so the affordance is not
    // "denied" — it is unreachable.
    await expect(runLoader("VIB-142", ids.deniz)).rejects.toMatchObject({
      init: { status: 404 },
      data: "No project at projects/viberr-core.",
    });
  });

  it("accept-completion refuses when the task is not at the boundary", async () => {
    const result = (await postIntent("VIB-166", ids.arda, {
      intent: "accept-completion",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBeGreaterThanOrEqual(400);
  });
});

describe("task archive (R14-3)", () => {
  it("a contributor cannot archive", async () => {
    const result = (await postIntent("VIB-153", ids.selin, {
      intent: "archive-task",
    })) as { data: { ok: false; error: string }; init: { status: number } };
    expect(result.init.status).toBe(403);
  });

  it("a maintainer archives and restores; the loader reports the disposition", async () => {
    const archived = (await postIntent("VIB-153", ids.murat, {
      intent: "archive-task",
    })) as { ok: true; toast: string };
    expect(archived.ok).toBe(true);
    expect(archived.toast).toContain("archived");
    const after = await runLoader("VIB-153", ids.murat);
    expect(after.archived).toBe(true);
    // An archived task is out of the flow — acceptance is refused with a reason.
    expect(after.acceptance.canAccept).toBe(false);

    const restored = (await postIntent("VIB-153", ids.murat, {
      intent: "restore-task",
    })) as { ok: true; toast: string };
    expect(restored.ok).toBe(true);
    expect(restored.toast).toContain("restored");
    expect((await runLoader("VIB-153", ids.murat)).archived).toBe(false);
  });
});
