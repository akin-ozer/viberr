import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";
import type { loader as taskLoader, action as taskAction } from "~/routes/project.task";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";

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
/** The seeded humans every request in this file is issued as. */
let ids: SeedUserIds;

type LoaderData = Awaited<ReturnType<typeof taskLoader>>;
type ActionData = Awaited<ReturnType<typeof taskAction>>;

/**
 * The action's refusal envelope. Every guard in routes/project.task raises an
 * AppError that the action's single catch hands to `appErrorResponse`, i.e.
 * `data({ ok: false, error }, { status })` — so on this arm `init` always
 * exists and carries a numeric status, where react-router types `data()`'s
 * `init` as `ResponseInit | null` for the general case.
 */
interface ActionRefusal {
  data: { ok: false; error: string };
  init: { status: number };
}

/**
 * What `.catch((e) => e)` yields for a refusal the route THROWS rather than
 * returns — R15-4's unknown-slug 404 Response. Both fields stay optional
 * because a catch binding is only ever "whatever was thrown".
 */
interface ThrownRefusal {
  init?: { status: number };
  data?: unknown;
}

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
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
  // Ruling 127: an agent run bills the TASK OWNER's own accounts, so a
  // dispatch (and the operator drive a packet resolution re-queues) only
  // reaches an adapter when that person has the backend connected. These five
  // are the demo humans this file acts as; connecting both backends for each
  // is the ordinary state of a team using the product, and it keeps the
  // dispatch tests below about dispatch rather than about connection.
  const { connectFakeBackends } = await import(
    "../../../test-support/backend-credentials"
  );
  for (const userId of Object.values(ids)) {
    await connectFakeBackends(app.db, userId);
  }
});
afterAll(() => app.cleanup());

async function runLoader(
  key: string,
  userId: string,
  search = "",
): Promise<LoaderData> {
  const { loader } = await import("~/routes/project.task");
  const { cookie } = await app.cookieFor(userId);
  // SAFETY: the loader destructures `request` and `params` and nothing else;
  // React Router's generated `LoaderArgs` additionally carries the framework's
  // `context` provider, which no path under test reads. `as never` supplies the
  // two fields it does read without standing a router up around them.
  return await loader({
    request: app.request(`/projects/viberr-core/tasks/${key}${search}`, { cookie }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never);
}

async function postIntent(
  key: string,
  userId: string,
  fields: Record<string, string>,
): Promise<ActionData | ActionRefusal> {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  // SAFETY: as in runLoader — the action reads `request` and `params` only, so
  // `as never` stands in for the generated `ActionArgs` context provider.
  return await action({
    request: app.request(`/projects/viberr-core/tasks/${key}`, {
      method: "POST",
      cookie,
      body: new URLSearchParams({ _csrf: csrf, ...fields }),
    }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never);
}

/**
 * F39-6 (pass 39): the one intent that arrives as MULTIPART. A person attaching
 * a file is the writer the attachments directory never had — viberr's own
 * controller planned around it and the only route was the data volume.
 */
async function postFile(
  key: string,
  userId: string,
  name: string,
  body: string,
): Promise<ActionData | ActionRefusal> {
  const { action } = await import("~/routes/project.task");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const form = new FormData();
  form.set("_csrf", csrf);
  form.set("intent", "attach-file");
  form.set("file", new File([body], name));
  // SAFETY: as in postIntent — the action reads `request` and `params` only.
  return await action({
    request: app.request(`/projects/viberr-core/tasks/${key}`, {
      method: "POST",
      cookie,
      body: form,
    }),
    params: { slug: "viberr-core", key },
    context: {},
  } as never);
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
      { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
      { label: "integration/pr_sync_test", result: "11 passed", status: "pass" },
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

/* ---------------------------------------------- ruling 127 run principal */

/**
 * Ruling 127 — the loader ships WHOSE accounts this task's agent runs would
 * bill, not whether the deployment holds a credential.
 *
 * The old `backendAvailable` pair answered one question for every task in the
 * instance. A run bills the task OWNER, so two tasks on one board can differ,
 * and a disabled Run has to name the person who can fix it. These pin the
 * shape (`runPrincipal`), the three states it distinguishes (owner with the
 * backend connected, owner without, no owner at all) and the hard rule that
 * nothing about the credential itself reaches the browser.
 */
describe("loader — runPrincipal (ruling 127)", () => {
  it("names the OWNER and answers per backend from THEIR accounts", async () => {
    // VIB-142 is seeded owned by Arda, and the file's beforeAll connected both
    // backends for every demo human.
    const data = await runLoader("VIB-142", ids.selin);
    expect(data.runPrincipal).toEqual({
      ownerUserId: ids.arda,
      ownerName: "Arda Kaya",
      claude: { available: true, detail: null },
      codex: { available: true, detail: null },
    });
    // The answer is about the OWNER, not the viewer: Selin asked, and what
    // came back is Arda's.
    expect(data.runPrincipal?.ownerUserId).not.toBe(ids.selin);
  });

  it("an UNOWNED task ships null: there is nobody to bill", async () => {
    // VIB-148 is seeded with no owner (the ownership describe below is what
    // changes that, which is why this reads it first).
    const data = await runLoader("VIB-148", ids.arda);
    expect(data.runPrincipal).toBeNull();
  });

  it("reports the owner's DISCONNECTED backend with the store's own remedy, naming no environment variable", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    await disconnectFakeBackend(app.db, ids.arda, "codex");
    try {
      const data = await runLoader("VIB-142", ids.arda);
      expect(data.runPrincipal?.codex.available).toBe(false);
      expect(data.runPrincipal?.codex.detail).toContain(
        "Connect it on your Profile",
      );
      // The other backend is a separate account and a separate answer.
      expect(data.runPrincipal?.claude).toEqual({
        available: true,
        detail: null,
      });
      // Ruling 127 deleted the deployment credentials: no surface may send a
      // person hunting for one.
      const wire = JSON.stringify(data.runPrincipal);
      for (const dead of [
        "ANTHROPIC_API_KEY",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "OPENAI_API_KEY",
        "this instance",
      ]) {
        expect(wire).not.toContain(dead);
      }
    } finally {
      await connectFakeBackend(app.db, ids.arda, "codex");
    }
  });

  it("carries no secret, no sealed box and no filesystem path", async () => {
    const { fakeBackendSecret } = await import(
      "../../../test-support/backend-credentials"
    );
    const data = await runLoader("VIB-142", ids.arda);
    const wire = JSON.stringify(data);
    expect(wire).not.toContain(fakeBackendSecret("claude"));
    expect(wire).not.toContain(fakeBackendSecret("codex"));
    expect(wire).not.toContain("secret_box");
    expect(wire).not.toContain("secretSuffix");
    // The loader ships a verdict and a sentence, nothing that locates the
    // credential on disk.
    expect(JSON.stringify(data.runPrincipal)).not.toContain(app.dataRoot);
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
          await interruptRun(
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

  it("@operator on a task WITH a specialist triggers the agent + names it in the toast", async () => {
    // SAFETY: arda is a project admin, so the comment runs to completion and the
    // action returns its `comment` arm — the only success arm that carries
    // `toAgent`/`agent`/`triggered` next to the toast.
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

  it("@codex also routes + triggers; plain member mentions do not", async () => {
    // SAFETY: the same `comment` arm — an @mention that resolves to a deployed
    // specialist reports through `toAgent`/`triggered`.
    const codex = (await postIntent("VIB-153", ids.arda, {
      intent: "comment", text: "@codex check the linter",
    })) as { toAgent: boolean; triggered: string | null };
    expect(codex.toAgent).toBe(true);
    expect(codex.triggered).toBeTruthy();
    await stopTaskRuns("VIB-153", ids.arda);

    // SAFETY: still the `comment` arm; a plain member mention is the not-routed
    // branch of that same return, so the fields are unchanged.
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
    // SAFETY: deniz is not a member, so `requireVisibleProject` throws the
    // unknown-slug 404 OUTSIDE the action's try — the catch above receives what
    // was thrown, never a returned envelope.
    const thrown = (await postIntent("VIB-153", ids.deniz, {
      intent: "comment", text: "Following from the platform side.",
    }).catch((e) => e)) as ThrownRefusal;
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
      // SAFETY: as an org admin deniz clears the D2 override, so the comment lands
      // on the action's `comment` success arm.
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
    // SAFETY: a whitespace-only comment fails validation inside the try, and the
    // action's single catch answers every AppError through `appErrorResponse`.
    const result = (await postIntent("VIB-153", ids.arda, {
      intent: "comment", text: "   ",
    })) as ActionRefusal;
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

  /**
   * Ruling 315. The note is the one field on this card that holds a person's
   * own words, and the ROUTE cut it to 2,000 characters with `.slice(0, 2000)`
   * before the request reached the server — no `maxLength` on the box, no
   * counter, no marker on the record, no error, and nothing anywhere holding
   * the tail.
   *
   * Live on SHOP-76 a 4,454-character decision was stored at exactly 2,000,
   * ending mid-word, and a rework round ran on the operator's reconstruction of
   * the deleted sentence. Ruling 292 permits a cut on a VERDICT because "the
   * full text is never lost — the agent's own report is on the same timeline,
   * untruncated"; a typed note has no second copy.
   *
   * This test lives at the ROUTE because that is where the slice was. A test
   * that called `resolvePacket` directly passed with the slice restored — the
   * first version of this test did exactly that, and its canary came out green.
   */
  it("ruling 315: the route records a long note WHOLE", async () => {
    const long = `HEAD ${"x".repeat(2600)} TAIL`;
    expect(long.length).toBeGreaterThan(2000);
    // Option 1 is `request_edit` — it resolves and records the decision. Option
    // 0 would merge a pull request, which is not what this test is about.
    // SAFETY: `postIntent` returns the action's union; the success arm of
    // `resolve-packet` is an object with no `error` key, and this asserts the
    // narrower read of it rather than the refusal arm.
    const posted = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet",
      option: "1",
      note: long,
    })) as { ok?: boolean; error?: string };
    expect(posted.error).toBeUndefined();
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const parsed = readTaskFile({
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
      dataRoot: app.dataRoot,
    })!.parsed;
    const recorded = parsed.timeline.map((e) => e.text).join("\n");
    // CANARY: restore `.slice(0, 2000)` in the route and TAIL disappears while
    // HEAD stays — silently, which is the whole defect.
    expect(recorded).toContain("HEAD");
    expect(recorded).toContain("TAIL");
  });

  it("ruling 315: a note past the shared cap is refused, and the packet stays open", async () => {
    const { PACKET_NOTE_MAX } = await import("~/schemas/task-file.schema");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const read = () =>
      readTaskFile({
        projectSlug: "viberr-core",
        taskKey: "VIB-142",
        dataRoot: app.dataRoot,
      })!.parsed;
    const before = read().timeline.length;
    // SAFETY: an over-long note raises `AppError.validation`, which the
    // action's single catch turns into `data({ ok: false, error }, { status })`
    // — the `ActionRefusal` arm this file documents above.
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet",
      option: "1",
      note: "y".repeat(PACKET_NOTE_MAX + 1),
    })) as ActionRefusal;
    // Refusing and then writing half of it would be the same defect wearing a
    // message, so the packet must still be open and the timeline unmoved.
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toMatch(/too long/);
    // It says the number AND what they wrote, so the person can tell how much
    // to cut rather than guessing at a limit they were never shown.
    expect(result.data.error).toContain("4,000");
    expect(result.data.error).toContain("Nothing was recorded");
    expect(read().packet).not.toBeNull();
    expect(read().timeline.length).toBe(before);
  });

  it("ruling 138: the resolve response prefers the option's goalDraft, and a reload rebuilds the SAME draft from the decided packet", async () => {
    // Canary: compose title + detail inline again in the route (drop
    // `goalDraftForOption`) — the response stops matching the option's draft.
    // Canary 2: drop the `decided` stamp in resolvePacket — the reload path
    // has nothing to rebuild from.
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    const { goalDraftForOption } = await import("~/shared/packet-goal-draft");
    const draft = "Deliver a CSV export of the board.\n\nAcceptance: the export downloads every visible column.";
    await updateTaskFile(
      { projectSlug: "viberr-core", taskKey: "VIB-142", dataRoot: app.dataRoot },
      (parsed) => {
        parsed.packet = {
          id: "pkt_scope",
          type: "input",
          kind: "Decision required",
          from: "operator",
          title: "Scope needed",
          body: "",
          observations: [],
          options: [
            { kind: "edit_goal", t: "Ship the CSV export", d: "Add the export button.", rec: true, goalDraft: draft },
            { kind: "hold_runtime_debug", t: "Hold", d: "", rec: false },
          ],
        };
      },
    );
    // SAFETY: arda holds `resolve-packet` and may edit the goal, so the
    // confirmed edit_goal option answers with the resolve arm's own shape.
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "0",
    })) as { ok: true; kind: string; goalDraft?: string };
    expect(result.kind).toBe("edit_goal");
    expect(result.goalDraft).toBe(draft);

    // After a reload the loader carries the decided packet…
    const after = await runLoader("VIB-142", ids.arda);
    const decidedPacket = after.task.packet;
    expect(decidedPacket?.awaiting).toBe("goal_edit");
    expect(decidedPacket?.decided).toMatchObject({ optionIndex: 0, byUserId: ids.arda });
    expect(after.task.displayReadiness).toBe("goal_edit_pending");
    // …and the reload path rebuilds the same draft through the ONE composition.
    const chosen = decidedPacket?.options[decidedPacket.decided?.optionIndex ?? -1];
    expect(chosen ? goalDraftForOption(chosen) : null).toBe(result.goalDraft);
  });

  it("rejects a non-owner contributor accepting a completion packet (R6-2)", async () => {
    // Accepting a completion is admin|maintainer OR the task's owner (R6-2).
    // selin is a contributor and NOT VIB-142's owner, so the accept path denies.
    // SAFETY: that denial leaves the action through its `appErrorResponse` catch.
    const result = (await postIntent("VIB-142", ids.selin, {
      intent: "resolve-packet", option: "0",
    })) as ActionRefusal;
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("accept completion into Done");
  });

  it("rejects non-members entirely (R15-4: as an unknown slug, not a 403)", async () => {
    // SAFETY: as in the non-member comment above — the visibility refusal is
    // thrown ahead of the action body.
    const thrown = (await postIntent("VIB-142", ids.deniz, {
      intent: "resolve-packet", option: "1",
    }).catch((e) => e)) as ThrownRefusal;
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
    // SAFETY: arda holds `resolve-packet`, so the confirmed option returns the
    // resolve arm: `kind`, its toast, and the optional navigation target.
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "2",
    })) as { ok: true; kind: string; toast: string; navigateTo?: string };
    expect(result.kind).toBe("block_on_policy");
    // Ruling 130(c) (pass 34): the toast states the EFFECT and restates no
    // claim. Canary: restore the old "Policy / credential updated" literal.
    expect(result.toast).toBe("Unblocked · the operator re-runs to re-check");
    expect(result.navigateTo).toBeUndefined();

    const after = await runLoader("VIB-142", ids.arda);
    expect(after.task.readiness).toBe("ready");
    expect(after.task.waiting).toBe("agent");
    expect(after.task.packet).toBeNull(); // resolved, not held
    // The re-queue may post its own events, so find the decision by type.
    const decision = after.task.timeline.find((e) => e.type === "transition");
    expect(decision).toBeDefined();
    // The record restates the seeded option's own words (ruling 130(c)).
    expect(decision!.text).toContain("**Decision:** Block on policy.");
    expect(decision!.text).not.toContain("policy / credential updated");
    expect(decision!.text).toContain("unblocked");
  });

  it("ruling 131 set-task-dependencies: sets the wait, clears it as a release, refuses a bad reference by name", async () => {
    // Canary: drop the intent's `case` (every shape answers the unknown-intent
    // refusal), or route it through `setTaskMetadata`.
    // SAFETY: arda holds `edit-task-meta`, so a valid list returns the intent's
    // ok arm with its toast.
    const set = (await postIntent("VIB-153", ids.arda, {
      intent: "set-task-dependencies", blockedBy: "VIB-142, VIB-142\n",
    })) as { ok: true; toast: string };
    expect(set.toast).toBe("Waits on VIB-142");
    const held = await runLoader("VIB-153", ids.arda);
    expect(held.task.blockedBy.map((e) => e.ref)).toEqual(["VIB-142"]);
    expect(held.task.readiness).toBe("blocked");

    // SAFETY: the validator refuses inside the try; the action answers through
    // `appErrorResponse`.
    const bad = (await postIntent("VIB-153", ids.arda, {
      intent: "set-task-dependencies", blockedBy: "VIB-153",
    })) as ActionRefusal;
    expect(bad.init.status).toBe(400);
    expect(bad.data.error).toContain("VIB-153: a task cannot wait on itself");

    // SAFETY: same arm as above; an empty list is valid and clears.
    const cleared = (await postIntent("VIB-153", ids.arda, {
      intent: "set-task-dependencies", blockedBy: "",
    })) as { ok: true; toast: string };
    expect(cleared.toast).toBe("No longer waits on other work");
    const released = await runLoader("VIB-153", ids.arda);
    expect(released.task.blockedBy).toEqual([]);
    expect(released.task.timeline.some((e) => e.type === "note" && /Dependencies released/.test(e.title ?? ""))).toBe(true);
  });

  it("ruling 501 set-task-metadata: an edit writes only the axis its form carries", async () => {
    // Canary: read an absent field as empty again (the old full replace), and
    // the priority edit below clears VIB-142's labels and due date.
    const before = await runLoader("VIB-142", ids.arda);
    expect(before.task.labels.length).toBeGreaterThan(0);
    expect(before.task.dueDate).not.toBeNull();
    // SAFETY: arda holds `edit-task-meta`, so each post returns the intent's
    // ok arm with its toast.
    const priority = (await postIntent("VIB-142", ids.arda, {
      intent: "set-task-metadata", priority: "high",
    })) as { ok: true; toast: string };
    expect(priority.toast).toBe("Priority updated");
    const raised = await runLoader("VIB-142", ids.arda);
    expect(raised.task.priority).toBe("high");
    expect(raised.task.labels).toEqual(before.task.labels);
    expect(raised.task.dueDate).toBe(before.task.dueDate);
    // A present empty field still clears its own axis, and only that one.
    // SAFETY: the same ok arm.
    const undated = (await postIntent("VIB-142", ids.arda, {
      intent: "set-task-metadata", dueDate: "",
    })) as { ok: true; toast: string };
    expect(undated.toast).toBe("Due date updated");
    const cleared = await runLoader("VIB-142", ids.arda);
    expect(cleared.task.dueDate).toBeNull();
    expect(cleared.task.priority).toBe("high");
    expect(cleared.task.labels).toEqual(before.task.labels);
    // Put VIB-142 back as the fixture seeded it.
    await postIntent("VIB-142", ids.arda, {
      intent: "set-task-metadata", priority: before.task.priority, dueDate: before.task.dueDate ?? "",
    });
    const restored = await runLoader("VIB-142", ids.arda);
    expect(restored.task.priority).toBe(before.task.priority);
    expect(restored.task.dueDate).toBe(before.task.dueDate);
  });

  it("request_edit: clears the packet, flips waiting to agent, writes option.ev", async () => {
    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "working" }],
      keepRunning: true,
    });
    // SAFETY: the same resolve arm as the block_on_policy case above.
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
    // SAFETY: the first resolve succeeds, so this is the resolve arm; only
    // `kind` is read, to pin which option ran.
    const first = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "1",
    })) as { ok: true; kind: string };
    expect(first.kind).toBe("request_edit");

    // SAFETY: the packet is already cleared, so resolvePacket raises the conflict
    // and the action answers through `appErrorResponse`.
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet", option: "1",
    })) as ActionRefusal;
    expect(result.init.status).toBe(409);
    expect(result.data.error).toBe("This packet was already resolved.");
  });

  it("hold_runtime_debug on VIB-160 (R20-1): stays blocked but RESOLVES the packet", async () => {
    // SAFETY: murat holds `resolve-packet` on VIB-160, so this is the resolve arm
    // again — a hold still resolves the packet.
    const result = (await postIntent("VIB-160", ids.murat, {
      intent: "resolve-packet", option: "2",
    })) as { ok: true; kind: string; toast: string };
    expect(result.kind).toBe("hold_runtime_debug");
    expect(result.toast).toBe(
      "Held for runtime debug · the session is recorded per audit policy",
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
    // SAFETY: `count(*) AS c` with no GROUP BY is an aggregate, so sqlite always
    // answers with exactly one row holding that one integer.
    const opRuns = () =>
      (
        app.db
          .prepare(
            `SELECT count(*) AS c FROM agent_runs WHERE kind = 'operator' AND task_key = 'VIB-148'`,
          )
          .get() as { c: number }
      ).c;
    const before = opRuns();

    // SAFETY: arda may own tasks, so `owner-take` returns the ownership arm.
    const result = (await postIntent("VIB-148", ids.arda, {
      intent: "owner-take",
    })) as { ok: true; toast: string };
    expect(result.toast).toBe("You own VIB-148 · review & acceptance");

    const after = await runLoader("VIB-148", ids.arda);
    expect(after.task.owner).toMatchObject({ kind: "human", name: "Arda Kaya" });
    // The assign event sits at the top of the timeline…
    expect(after.task.timeline[0]!.type).toBe("assign");
    expect(after.task.timeline[0]!.text).toBe(
      "Took task ownership. The owner is the human reviewer and acceptance authority for this task.",
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
    // SAFETY: releasing one's own seat is permitted, so this is the ownership arm
    // — `forced` exists only there, to separate a self-release from an admin one.
    const result = (await postIntent("VIB-148", ids.arda, {
      intent: "owner-release",
    })) as { ok: true; forced: boolean; toast: string };
    expect(result.forced).toBe(false);
    expect(result.toast).toBe("Ownership released on VIB-148");

    const after = await runLoader("VIB-148", ids.arda);
    expect(after.task.owner).toBeNull();
    expect(after.task.timeline[0]!.text).toBe(
      "Released task ownership. Review & acceptance stall until another member takes the seat.",
    );
    // Re-taking is a clean ownership mutation: just the assign event on top,
    // no operator scheduling reaction to re-fire (F19).
    // SAFETY: selin is a contributor, which `own-task` admits, so the re-take
    // lands on the ownership arm.
    const again = (await postIntent("VIB-148", ids.selin, {
      intent: "owner-take",
    })) as { ok: true };
    expect(again.ok).toBe(true);
    const after2 = await runLoader("VIB-148", ids.selin);
    expect(after2.task.timeline[0]).toMatchObject({ type: "assign" });
    expect(after2.task.timeline[0]!.text).toBe(
      "Took task ownership. The owner is the human reviewer and acceptance authority for this task.",
    );
  });

  it("non-owner non-admin cannot hand off or release someone else's seat", async () => {
    // VIB-151 is owned by Selin; Murat is a maintainer (not owner, not admin).
    // SAFETY: the hand-off guard therefore denies through `appErrorResponse`.
    const handoff = (await postIntent("VIB-151", ids.murat, {
      intent: "owner-assign", userId: ids.elif,
    })) as ActionRefusal;
    expect(handoff.init.status).toBe(403);
    expect(handoff.data.error).toContain("Only the current owner or a project admin");

    // SAFETY: `release-any-ownership` is admin-only, so selin releasing another
    // member's seat is denied the same way.
    const release = (await postIntent("VIB-160", ids.selin, {
      intent: "owner-release",
    })) as ActionRefusal;
    expect(release.init.status).toBe(403);
    // Canonical guard (release-any-ownership = admin only): the message names the
    // actor's role rather than a hard-coded "admins" string.
    expect(release.data.error).toContain("cannot release another member's ownership");
  });

  it("hand-off by admin + admin release with the forced copy + audit trail", async () => {
    // SAFETY: arda is a project admin, so the hand-off returns the ownership arm.
    const handoff = (await postIntent("VIB-151", ids.arda, {
      intent: "owner-assign", userId: ids.murat,
    })) as { ok: true; toast: string };
    expect(handoff.toast).toBe("Ownership handed to Murat");
    let after = await runLoader("VIB-151", ids.arda);
    expect(after.task.owner).toMatchObject({ name: "Murat Yıldız" });
    expect(after.task.timeline[0]!.text).toBe(
      "Handed task ownership to **Murat Yıldız**. They hold review & acceptance for this task now.",
    );

    // SAFETY: the admin release returns the ownership arm too, with `forced` set.
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
      "Released **Murat Yıldız** from task ownership (admin). The seat is open to any contributor or above.",
    );

    // Admin release promise: recorded in the audit trail (spec §4.5).
    // SAFETY: `COUNT(*) AS n` is an aggregate with no GROUP BY — exactly one row,
    // holding exactly the one integer the SELECT names.
    const audit = app.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_events
         WHERE action = 'task.ownership.admin_released' AND subject_id = 'VIB-151'`,
      )
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it("non-members are denied ownership; hand-off to a non-member is denied", async () => {
    // R15-4: a non-member never gets past the route's visibility gate, so the
    // refusal is the unknown-slug 404 rather than the mutation's own 403.
    // SAFETY: that gate runs outside the action's try, so the 404 arrives here
    // as a throw rather than a returned envelope.
    const take = (await postIntent("VIB-148", ids.deniz, {
      intent: "owner-take",
    }).catch((e) => e)) as ThrownRefusal;
    expect(take?.init?.status).toBe(404);
    expect(String(take?.data)).toBe("No project at projects/viberr-core.");

    // Murat takes the seat over from Selin first: only the current owner or a
    // project admin may hand it off, so the refusal below is the target's.
    expect(
      await postIntent("VIB-148", ids.murat, { intent: "owner-take" }),
    ).toMatchObject({ ok: true });
    // SAFETY: a hand-off target must be a project member and deniz is not, so the
    // mutation's own guard denies through `appErrorResponse`.
    const toGuest = (await postIntent("VIB-148", ids.murat, {
      intent: "owner-assign", userId: ids.deniz,
    })) as ActionRefusal;
    expect(toGuest.init.status).toBe(403);
    expect(toGuest.data.error).toContain("only be handed to a project member");
  });
});

/* ---------------------------------------------------- stage transitions */

describe("transition action (manual stage move — admin|maintainer)", () => {
  it("moving to Done routes through acceptance: a contributor is rejected", async () => {
    // A manual move INTO the final stage IS accepting completion — the RBAC
    // message reflects the acceptance authority, still admin|maintainer.
    // SAFETY: selin does not hold it, so the guard denies through
    // `appErrorResponse`.
    const result = (await postIntent("VIB-145", ids.selin, {
      intent: "transition", to: "done",
    })) as ActionRefusal;
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("accept completion into Done");
  });

  it("a non-final manual move is admin|maintainer only: a contributor is rejected", async () => {
    // SAFETY: non-final manual moves are admin|maintainer, so the contributor is
    // denied the same way.
    const result = (await postIntent("VIB-145", ids.selin, {
      intent: "transition", to: "triage",
    })) as ActionRefusal;
    expect(result.init.status).toBe(403);
    expect(result.data.error).toContain("change the task stage");
  });

  it("ruling 381: that same backward move with no reason is refused, after the authority gate", async () => {
    // Runs BEFORE the move below, which lands VIB-145 on triage for good.
    // SAFETY: the route answers its refusal envelope, not the transition arm.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "transition", to: "triage",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("needs a reason");
  });

  it("an admin can move across a non-boundary edge (manual override), with a toast", async () => {
    // triage is not a declared boundary FROM VIB-145's stage — allowed only
    // because the dropdown move is `manual`. (The transition comment it writes
    // is covered by task-governance.server.test.ts against an isolated store.)
    // SAFETY: arda is a project admin, so the move returns the transition arm —
    // the only success arm carrying `stage`.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "transition", to: "triage", reason: "scope was never agreed",
    })) as { ok: true; intent: string; stage: string; toast: string };
    expect(result.ok).toBe(true);
    expect(result.stage).toBe("triage");
    expect(result.toast).toContain("Moved VIB-145 to Triage");
  });

  it("rejects a move to a stage that isn't in the project", async () => {
    // SAFETY: "nope" is not one of the project's stages, so validation rejects it
    // inside the try and the catch answers through `appErrorResponse`.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "transition", to: "nope",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
  });
});

/* ---------------------------------------------- agent dispatch (run-agent) */

describe("loader — ruling 550: a task delivered as files", () => {
  it("hands the accept confirm the delivery's time, and nothing for a task with a commit revision", async () => {
    // CANARY: drop `filesDeliveredAt` from the loader and the confirm promises
    // a GitHub re-check that would close a delivered result "with no changes".
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    const ref = { projectSlug: "viberr-core", taskKey: "VIB-166", dataRoot: app.dataRoot };
    const before: Pick<TaskFrontmatter, "workRevision" | "deliveredAt"> = { workRevision: null, deliveredAt: null };
    await updateTaskFile(ref, (parsed) => {
      before.workRevision = parsed.frontmatter.workRevision;
      before.deliveredAt = parsed.frontmatter.deliveredAt ?? null;
      parsed.frontmatter.workRevision = null;
      parsed.frontmatter.deliveredAt = "2026-09-28T08:44:13.751Z";
    });
    try {
      expect((await runLoader("VIB-166", ids.arda)).filesDeliveredAt).toBe("2026-09-28T08:44:13.751Z");
    } finally {
      await updateTaskFile(ref, (parsed) => {
        parsed.frontmatter.workRevision = before.workRevision;
        parsed.frontmatter.deliveredAt = before.deliveredAt ?? null;
      });
    }
    expect((await runLoader("VIB-166", ids.arda)).filesDeliveredAt).toBeUndefined();
  });
});

describe("loader — deployed specialists", () => {
  it("exposes the project's deployed specialists (developer) + the live-run profile set", async () => {
    const result = await runLoader("VIB-166", ids.arda);
    const ids2 = result.deployedSpecialists.map((s) => s.id);
    // The seed deploys operator + developer/reviewer; the
    // operator must NOT appear (specialists only).
    expect(ids2).toContain("developer");
    expect(ids2).not.toContain("operator");
    const dev = result.deployedSpecialists.find((s) => s.id === "developer")!;
    expect(dev).toMatchObject({ role: "Implementation" });
    expect(dev.backend === "codex" || dev.backend === "claude").toBe(true);
    // Dynamic-dispatch rework: ONE per-profile live-run set replaced the
    // deliveringActive/activeReviewerIds split — no live run on VIB-166 yet.
    expect(result.liveAgentRuns).toEqual([]);
  });
});

describe("run-agent intent — the one manual dispatch (auto-engage)", () => {
  it("dispatching the developer AUTO-ENGAGES it as the deliverer and starts the run (streaming toast)", async () => {
    // Ruling 127: VIB-166 is seeded UNOWNED, and an unowned task cannot run
    // agents at all — there is no account to bill, so the dispatch would be
    // refused before any adapter. Arda takes the seat first, which is exactly
    // what the refusal tells a human to do ("Own the task (Assign me)").
    await postIntent("VIB-166", ids.arda, { intent: "owner-take" });
    // VIB-166 is a triage task with NO engagements. The Developer's eligible
    // stages are ready/impl (F1 still holds inside the auto-engage), so move it
    // to Ready first — dispatching a developer at Triage is correctly rejected.
    await postIntent("VIB-166", ids.arda, { intent: "transition", to: "ready" });
    // Moving VIB-166 into the auto "ready" stage auto-invokes the operator,
    // which may have already started a primary run — F7-OP1 single-flight then
    // (correctly) refuses a second concurrent delivering run. Clear any
    // in-flight primary first so this verifies the human dispatch on a task
    // with no active run.
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
    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "working" }],
      keepRunning: true,
    }, "codex");
    // SAFETY: arda is a project admin, the profile is deployed and the stage is
    // eligible, so `run-agent` returns its success arm.
    const result = (await postIntent("VIB-166", ids.arda, {
      intent: "run-agent", profileId: "developer",
    })) as { ok: true; toast: string };
    expect(result.ok).toBe(true);
    // The verbatim toast contract: backend + display name + streaming pointer.
    expect(result.toast).toBe(
      "Codex run started for Developer · streaming to agent logs",
    );

    const after = await runLoader("VIB-166", ids.arda);
    // Auto-engage: no deliverer stood + the profile holds repo-write, so the
    // dispatch engaged it as the DELIVERING agent ("Engage it first" is gone).
    expect(after.task.specialist).toMatchObject({
      profileId: "developer",
      role: "Implementation",
    });
    // …recorded with the same agent event an explicit engage always wrote. The
    // operator auto-invoke above may post its own events, so locate it by
    // type + copy rather than assuming position.
    const deployed = after.task.timeline.find(
      (e) => e.type === "agent" && e.text.includes("Deployed **Developer**"),
    );
    expect(deployed, "the auto-engage must be recorded as an agent event").toBeDefined();
    // A primary run now exists, and the loader's live-run set names its profile.
    const primary = after.runtime.find((r) => r.kind === "primary");
    expect(primary).toBeDefined();
    expect(after.liveAgentRuns.map((r) => r.profileId)).toContain("developer");

    // Stop the run's realistic-cadence timer so it does not outlive the suite
    // and write to the DB after afterAll() closes it (the sink guards this,
    // but interrupting keeps the run registry + logs clean).
    const { interruptRun } = await import("~/server/runtimes/run-service.server");
    await interruptRun(
      app.db,
      { projectSlug: "viberr-core", taskKey: "VIB-166", runId: primary!.serverRunId },
      { userId: ids.arda, label: "arda@viberr.dev" },
    );
  });

  it("ruling 152(c) (pass 35, G35-4): a dispatch into a backend the instance knows is out of quota is HELD: the toast names the hold, no run starts, the hand-off comment stays on the record unanswered (ruling 375), and the retry is on the schedule", async () => {
    // Canary: remove the `isDispatchHeld` catch in the run-agent arm and the
    // route answers the 409 as an error instead of the hold toast.
    const { recordBackendQuotaExhaustion, clearBackendQuotaExhaustion } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    recordBackendQuotaExhaustion(app.db, "codex", {
      credentialUserId: ids.arda,
      credentialLabel: "Arda",
      resetsAt,
      resetsAtPrecision: "clock",
      providerText: "try again at 6:18 PM",
      runId: "run_refused",
      observedAt: new Date().toISOString(),
    });
    try {
      const before = await runLoader("VIB-166", ids.arda);
      const runsBefore = before.runtime.length;
      // SAFETY: the developer is engaged on VIB-166 and no run is live, so the
      // only thing between the dispatch and a run is the hold.
      const result = (await postIntent("VIB-166", ids.arda, {
        intent: "run-agent", profileId: "developer", prompt: "Pick up the lint debt",
      })) as { ok: true; toast: string };
      expect(result.ok).toBe(true);
      expect(result.toast).toMatch(/^Held: Codex is out of quota until .* UTC; Developer's run is scheduled for then\.$/);

      const after = await runLoader("VIB-166", ids.arda);
      expect(after.runtime.length).toBe(runsBefore);
      expect(after.liveAgentRuns).toEqual([]);
      const held = after.task.timeline.find((e) => e.title === "Dispatch held");
      expect(held?.text).toContain("**Held:** Codex is out of quota until");
      expect(held?.text).toContain("Developer's run starts when the window reopens");
      // Ruling 375: the prompt is recorded BEFORE the start (so a run's own
      // directive is never redelivered), which on a hold leaves the person's
      // words on the record with the hold note beside them and no reply.
      const handOff = after.task.timeline.find(
        (e) => e.type === "comment" && e.text === "@Developer Pick up the lint debt",
      );
      expect(handOff?.toAgent, "the hand-off comment is on the record").toBe(true);
      const schedule = after.schedules.find((x) => x.status === "pending" && x.action === "run-agent");
      expect(schedule).toMatchObject({ profileId: "developer", prompt: "Pick up the lint debt" });
    } finally {
      clearBackendQuotaExhaustion(app.db, "codex");
    }
  });

  it("a contributor is denied run-agent (admin|maintainer only)", async () => {
    // SAFETY: dispatching agents is admin|maintainer, so selin's attempt is
    // denied through `appErrorResponse`.
    const result = (await postIntent("VIB-166", ids.selin, {
      intent: "run-agent", profileId: "developer",
    })) as ActionRefusal;
    expect(result.init.status).toBe(403);
  });

  it("rejects a dispatch to a stage outside the profile's eligibility (F1)", async () => {
    // VIB-168 is at Triage; the Developer profile is scoped to ready/impl. The
    // auto-engage runs the same stage guard the explicit engage did.
    // SAFETY: the F1 eligibility check rejects inside the try, and the catch
    // answers through `appErrorResponse`.
    const result = (await postIntent("VIB-168", ids.arda, {
      intent: "run-agent", profileId: "developer",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("not eligible");
  });

  it("an UNDEPLOYED profile id is refused with the deploy-first pointer", async () => {
    // The old "not engaged — engage it first" refusal no longer exists; the
    // only identity gate left is deployment.
    // SAFETY: no deployment carries that id, so the dispatch rejects inside the
    // try.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "run-agent", profileId: "does-not-exist",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toBe(
      '"does-not-exist" is not deployed on this project. Deploy it on the Agents page first.',
    );
  });

  it("run-agent without a profileId is refused: pick an agent", async () => {
    // SAFETY: the route validates the field before any dispatch, and the catch
    // answers through `appErrorResponse`.
    const result = (await postIntent("VIB-168", ids.arda, {
      intent: "run-agent",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toBe("Pick an agent to run.");
  });

  it("hunt 2026-08-29: schedule-action clamps its inputs — a crafted delayMinutes is a 400, never a Date RangeError 500", async () => {
    // 1e15 minutes overflowed Date into `Invalid time value` (an unhandled
    // RangeError, a 500); the prompt had no cap while the sibling run-agent
    // arm enforces 4000. Same bounds, honest refusals.
    // SAFETY: both refusals throw AppError.validation in the route before any
    // schedule write, answered through `appErrorResponse`.
    const overflow = (await postIntent("VIB-168", ids.arda, {
      intent: "schedule-action", delayMinutes: "1e15", prompt: "x",
    })) as ActionRefusal;
    expect(overflow.init.status).toBe(400);
    expect(overflow.data.error).toBe("Schedule between 1 minute and 28 days out.");

    // SAFETY: same refusal arm as above — the clamp throws before any write.
    const nonsense = (await postIntent("VIB-168", ids.arda, {
      intent: "schedule-action", delayMinutes: "abc", prompt: "x",
    })) as ActionRefusal;
    expect(nonsense.init.status).toBe(400);

    // SAFETY: same refusal arm — the prompt clamp throws before any write.
    const oversize = (await postIntent("VIB-168", ids.arda, {
      intent: "schedule-action", delayMinutes: "60", prompt: "y".repeat(4001),
    })) as ActionRefusal;
    expect(oversize.init.status).toBe(400);
    expect(oversize.data.error).toBe("Keep the run prompt under 4000 characters.");
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
    // The POST carries the echo the dialog would send for VIB-166 as the page
    // shows it, so it clears ruling 88's disclosure check (a bare POST is
    // refused there first) and meets the boundary itself.
    const { acceptanceDisclosureFields } = await import(
      "~/shared/acceptance-disclosure"
    );
    const shown = await runLoader("VIB-166", ids.arda);
    // SAFETY: VIB-166 is not at the review boundary, so acceptance is refused
    // inside the try instead of granted.
    const result = (await postIntent("VIB-166", ids.arda, {
      intent: "accept-completion",
      ...acceptanceDisclosureFields({
        pr: shown.task.pr?.state ?? "none",
        revision: shown.workRevisionSha ?? "none",
        verdict: shown.task.validation,
      }),
    })) as ActionRefusal;
    expect(result.init.status).toBe(409);
    expect(result.data.error).toContain(
      "A completion can only be accepted from the boundary the workflow puts before Done.",
    );
    // …the same sentence the page already shows beside the missing control.
    expect(result.data.error).toBe(shown.acceptance.blockedReason);
  });
});

describe("task archive (R14-3)", () => {
  it("a contributor cannot archive", async () => {
    // SAFETY: archiving is admin|maintainer, so the contributor is denied through
    // `appErrorResponse`.
    const result = (await postIntent("VIB-153", ids.selin, {
      intent: "archive-task",
    })) as ActionRefusal;
    expect(result.init.status).toBe(403);
  });

  it("a maintainer archives and restores; the loader reports the disposition", async () => {
    // SAFETY: murat is a maintainer, so the archive returns its success arm.
    const archived = (await postIntent("VIB-153", ids.murat, {
      intent: "archive-task",
    })) as { ok: true; toast: string };
    expect(archived.ok).toBe(true);
    expect(archived.toast).toContain("archived");
    const after = await runLoader("VIB-153", ids.murat);
    expect(after.archived).toBe(true);
    // An archived task is out of the flow — acceptance is refused with a reason.
    expect(after.acceptance.canAccept).toBe(false);

    // SAFETY: the same maintainer restoring what he just archived — the restore
    // success arm.
    const restored = (await postIntent("VIB-153", ids.murat, {
      intent: "restore-task",
    })) as { ok: true; toast: string };
    expect(restored.ok).toBe(true);
    expect(restored.toast).toContain("restored");
    expect((await runLoader("VIB-153", ids.murat)).archived).toBe(false);
  });
});

/* --------------------------------------------------- F20-11 read-marking */

describe("F20-11: task-view read-marking fires only on a genuine navigation", () => {
  /** Run the loader against an arbitrary wire URL (here the `.data` address a
   *  revalidation uses) so we can prove it marks nothing seen. The clean
   *  document load that DOES mark is R19-15's, in project.task.server.test.ts. */
  async function runLoaderAt(
    key: string,
    userId: string,
    url: string,
    headers?: Record<string, string>,
  ) {
    const { loader } = await import("~/routes/project.task");
    const { cookie } = await app.cookieFor(userId);
    // SAFETY: as in runLoader — this loader reads `request` and `params` only, so
    // `as never` stands in for the generated args' context provider.
    return loader({
      request: app.request(url, { cookie, headers }),
      params: { slug: "viberr-core", key },
      context: {},
    } as never);
  }

  // SAFETY: the statement selects the single `read_at` column, so a hit is a
  // one-property row and a miss is undefined, which the `?.` below handles.
  const readAt = (id: string) =>
    (
      app.db
        .prepare(`SELECT read_at FROM notifications WHERE id = ?`)
        .get(id) as { read_at: string | null } | undefined
    )?.read_at ?? null;

  it("a `.data` revalidation does NOT mark the viewer's rows seen (the parked-tab eat)", async () => {
    const { createNotification } = await import(
      "~/server/projections/notifications.server"
    );
    createNotification(app.db, {
      id: "f2011_data",
      userId: ids.arda,
      kind: "packet",
      ptype: "blocked",
      text: "Blocked — decision needed",
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    // The SSE-driven revalidation shape: the single-fetch `.data` wire address.
    await runLoaderAt(
      "VIB-142",
      ids.arda,
      "/projects/viberr-core/tasks/VIB-142.data?_routes=routes/project.task",
      { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
    );
    expect(readAt("f2011_data")).toBeNull();
  });
});

/**
 * F21-2 / ruling 88 — the acceptance disclosure at the HTTP door.
 *
 * The pass-21 finding: the R15-1 ceremony was client architecture only, so a
 * POST that never opened `AcceptConfirm` accepted the completion and merged its
 * PR with no disclosure at all. These two requests are that POST — the exact
 * shape a stale tab, a replayed form or a console `fetch` sends — and the route
 * refuses them before any gate, merge or audit row runs.
 *
 * The ordinary (non-terminal) `transition` above is the counterweight: it still
 * carries no acknowledgment and still succeeds, because only a move that IS an
 * acceptance is held to the ceremony.
 */
describe("acceptance disclosure (ruling 88) — the HTTP door", () => {
  it("refuses an accept-completion POST that carries no acknowledgment", async () => {
    // SAFETY: arda holds acceptance authority, so the refusal that answers is
    // the disclosure — not RBAC, which is checked first and passes.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "accept-completion",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("accept from the dialog");
  });

  it("refuses a force-accept POST that carries no acknowledgment", async () => {
    // SAFETY: the disclosure guard raises an AppError, so the action answers on
    // its refusal arm — `appErrorResponse`'s `{ ok: false, error }` + status.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "force-accept",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("accept from the dialog");
  });

  it("refuses a stage move INTO the terminal stage that carries no acknowledgment", async () => {
    // F19-37: the Current-state menu's last stage is the sixth acceptance
    // writer — the same door, and the same demand.
    // SAFETY: as above — a refused intent always answers on the refusal arm.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "transition",
      to: "done",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("accept from the dialog");
  });
});

/**
 * The INDIRECT acceptance doors at the same HTTP boundary: applying an operator
 * recommendation that reaches acceptance, and resolving a packet's
 * `accept_completion` option. Both render the same ceremony (`AcceptConfirm`,
 * modes `apply-recommendation` and `packet`) and both used to accept — and
 * merge — on a POST that carried nothing back from it. Their server-side pins
 * (the recommendation id, the packet identity) say WHICH decision is being
 * settled, never what the human was shown merging.
 *
 * The ordinary intents are the counterweight: an apply that is not an
 * acceptance, and a non-accepting packet option, still POST bare and still
 * succeed — proved at the server level in `task-actions.server.test.ts`.
 */
describe("acceptance disclosure (ruling 88) — the indirect HTTP doors", () => {
  // The packet cases below consume VIB-142's open packet, and the earlier
  // describes in this file resolve it too. Re-seed so each case starts from the
  // seeded (open-packet) state rather than from whatever ran before it.
  beforeEach(async () => {
    const { runDemoSeed } = await import("../../../test-support/demo-seed");
    await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  });

  /** Put an `accept_completion` card on VIB-145 — the operator's own "accept
   *  completion → Done" recommendation, which is what the Apply button applies. */
  async function seedAcceptRecommendation(): Promise<void> {
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    await updateTaskFile(
      { projectSlug: "viberr-core", taskKey: "VIB-145", dataRoot: app.dataRoot },
      (parsed) => {
        parsed.frontmatter.recommendations = [
          {
            id: "rec-accept-145",
            kind: "accept_completion",
            toStageId: "done",
            label: "Accept completion — move VIB-145 to Done",
            detail: "",
          },
        ];
      },
    );
  }

  it("refuses an apply-recommendation POST that reaches acceptance with no acknowledgment", async () => {
    // F19-3, live-proven: one Apply click merged an unreviewed head into main.
    await seedAcceptRecommendation();
    // SAFETY: arda holds acceptance authority, so the refusal that answers is
    // the disclosure guard's AppError — the action's `appErrorResponse` arm,
    // `{ ok: false, error }` plus a status — not RBAC and not the success shape.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "apply-recommendation",
      recId: "rec-accept-145",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("accept from the dialog");
  });

  it("refuses an apply-recommendation POST whose acknowledgment no longer matches", async () => {
    // The card sat on screen while the task moved (R17-1 drift): the echo names
    // a revision the task no longer carries, so the acceptance is refused rather
    // than merged against a screen that stopped being true.
    await seedAcceptRecommendation();
    // SAFETY: as above — a stale echo is refused, so the action answers on its
    // refusal arm.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "apply-recommendation",
      recId: "rec-accept-145",
      ackPr: "review",
      ackRevision: "9".repeat(40),
      ackVerdict: "healthy",
    })) as ActionRefusal;
    expect(result.init.status).toBe(409);
    expect(result.data.error).toContain("changed after the accept dialog");
  });

  it("refuses a resolve-packet POST on the accept_completion option with no acknowledgment", async () => {
    // F19-7: VIB-142's packet option 0 IS the acceptance — "Confirm decision"
    // runs the real merge.
    // SAFETY: arda holds acceptance authority on VIB-142, so the resolution
    // reaches the disclosure guard and is refused there — the action's refusal
    // arm, never the resolve success shape.
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet",
      option: "0",
    })) as ActionRefusal;
    expect(result.init.status).toBe(400);
    expect(result.data.error).toContain("accept from the dialog");
    // Refused before anything was decided — the packet is still open.
    const detail = await runLoader("VIB-142", ids.arda);
    expect(detail.task.packet).not.toBeNull();
  });

  it("refuses a resolve-packet POST whose acknowledgment no longer matches", async () => {
    // SAFETY: as above — a refused resolution always answers on the refusal arm.
    const result = (await postIntent("VIB-142", ids.arda, {
      intent: "resolve-packet",
      option: "0",
      ackPr: "review",
      ackRevision: "9".repeat(40),
      ackVerdict: "healthy",
    })) as ActionRefusal;
    expect(result.init.status).toBe(409);
    expect(result.data.error).toContain("changed after the accept dialog");
  });
});

/**
 * F21-6 (route half, carried through the rework) — "reviewer" is a claim about
 * AUTHORITY. Acceptance waits for a REVIEWER's approval; it never waits on a
 * supporting agent. The engage toast that used to make this claim is gone with
 * the assign-reviewer intent; what remains is the auto-engage's own timeline
 * event, which still follows the verdict grant, not the control the human used.
 * `release-agent` (remove-reviewer's successor) is pinned here too.
 *
 * Last in this file on purpose: the supporting arm edits the project's deployed
 * grants, which nothing after it should inherit.
 */
describe("run-agent auto-engage — reviewer vs supporting agent, and release-agent", () => {
  /**
   * Ruling 127 + ruling 263: both tasks below ship OWNERLESS in the seed, and a
   * run bills the owner's accounts — so the dispatch was refused for a missing
   * principal and, until ruling 263, still toasted "Claude run started for
   * Reviewer · streaming to agent logs". Owning the task is what a person has
   * already done before they run an agent on it; these tests are about the
   * engagement's posture, not about ownership.
   */
  async function ownFor(key: string): Promise<void> {
    const { setOwner } = await import("~/server/tasks/task-actions.server");
    await setOwner(
      app.db,
      { projectSlug: "viberr-core", taskKey: key, targetUserId: ids.arda },
      { userId: ids.arda, label: "test" },
      { dataRoot: app.dataRoot },
    );
  }

  /** Interrupt every live run the dispatch under test started. */
  async function stopRuns(key: string) {
    const { listRunsForTaskRows } = await import(
      "~/server/runtimes/run-store.server"
    );
    const { interruptRun } = await import("~/server/runtimes/run-service.server");
    for (const run of listRunsForTaskRows(app.db, "viberr-core", key)) {
      if (run.state === "running" || run.state === "queued") {
        try {
          await interruptRun(
            app.db,
            { projectSlug: "viberr-core", taskKey: key, runId: run.id },
            { userId: ids.arda, label: "test" },
          );
        } catch {
          // ignore
        }
      }
    }
  }

  it("engages a verdict-capable profile 'as a reviewer' on its way into the run", async () => {
    // The seeded Reviewer profile holds "Report a validation verdict" directly,
    // and VIB-153 already has a deliverer — so the dispatch engages it as a
    // supporting engagement whose verdict gates acceptance.
    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "reviewing" }],
      keepRunning: true,
    }, "claude");
    await ownFor("VIB-153");
    // SAFETY: VIB-153 sits at Implementation (the Reviewer's eligible stages are
    // impl/review) and arda is a project admin, so this returns the success arm.
    const result = (await postIntent("VIB-153", ids.arda, {
      intent: "run-agent", profileId: "reviewer",
    })) as { ok: true; toast: string };
    expect(result.toast).toBe(
      "Claude run started for Reviewer · streaming to agent logs",
    );
    await stopRuns("VIB-153");
    const after = await runLoader("VIB-153", ids.arda);
    // The engagement landed in the supporting roster, not the deliverer seat…
    expect(after.task.specialist?.profileId).not.toBe("reviewer");
    expect(after.task.reviewers.map((r) => r.profileId)).toContain("reviewer");
    // …and the event makes the authority claim the grant supports.
    const engaged = after.task.timeline.find(
      (e) => e.type === "agent" && e.text.includes("Engaged **Reviewer**"),
    );
    expect(engaged?.text).toContain("as a reviewer.");
  });

  it("engages 'as a supporting agent' when the verdict grant is off; release-agent lets it go", async () => {
    // Same profile, same dispatch, one grant different — the copy follows the
    // authority, not the control the human used.
    // Canary: restore an unconditional `as a reviewer.` in assignReviewer's
    // event and the first timeline assertion below fails.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { writeProject } = await import("../../../test-support/test-store");
    const { rebuildAll } = await import("~/server/projections/rebuilder.server");
    const project = readProjectFile({ projectSlug: "viberr-core", dataRoot: app.dataRoot })!;
    writeProject(
      app.dataRoot,
      {
        ...project.parsed.frontmatter,
        agents: project.parsed.frontmatter.agents.map((agent) =>
          agent.profileId === "reviewer"
            ? {
                ...agent,
                capabilities: agent.capabilities.map((grant) =>
                  grant.capabilityId === "report-validation-verdict"
                    ? { ...grant, mode: "human" as const }
                    : grant,
                ),
              }
            : agent,
        ),
      },
      project.parsed.description,
    );
    rebuildAll(app.db, { dataRoot: app.dataRoot, force: true });

    queueFakeRun({
      lines: [{ t: "", ev: "text", tag: "assistant", text: "supporting" }],
      keepRunning: true,
    }, "claude");
    await ownFor("VIB-145");
    // SAFETY: VIB-145 sits at Review (also an eligible Reviewer stage) with no
    // engagement for this profile, so the dispatch returns the success arm.
    const result = (await postIntent("VIB-145", ids.arda, {
      intent: "run-agent", profileId: "reviewer",
    })) as { ok: true; toast: string };
    expect(result.toast).toBe(
      "Claude run started for Reviewer · streaming to agent logs",
    );
    await stopRuns("VIB-145");
    const after = await runLoader("VIB-145", ids.arda);
    const engaged = after.task.timeline.find(
      (e) => e.type === "agent" && e.text.includes("Engaged **Reviewer**"),
    );
    expect(engaged?.text).toContain("as a supporting agent.");

    // release-agent (remove-reviewer's successor): lets the supporting
    // engagement go, and says so honestly on the repeat.
    // SAFETY: the engagement exists, so the first release returns the success
    // arm; the second finds nothing engaged and reports that on the same arm.
    const released = (await postIntent("VIB-145", ids.arda, {
      intent: "release-agent", profileId: "reviewer",
    })) as { ok: true; toast: string };
    expect(released.toast).toBe("Agent released");
    // SAFETY: same success arm as above — the action returns {ok, toast} for
    // both the released and the already-released case; only the copy differs.
    const again = (await postIntent("VIB-145", ids.arda, {
      intent: "release-agent", profileId: "reviewer",
    })) as { ok: true; toast: string };
    expect(again.toast).toBe("That agent wasn't engaged");
    const cleared = await runLoader("VIB-145", ids.arda);
    expect(cleared.task.reviewers.map((r) => r.profileId)).not.toContain("reviewer");
  });
});

/**
 * Ruling 320 — a field the loader computes for the page has to reach the page.
 *
 * `queuedQuestions` was read from the task file by this loader, returned by it,
 * accepted by `TaskDetailPage` and rendered by `TaskDetailsPanel` — and the
 * route never passed it. Both ends default to `[]`, so nothing failed, nothing
 * logged, and the row ruling 241 built ("Viberr puts Arda's question to
 * @reviewer when the wait clears") simply never appeared on any task. The
 * promise stayed in the timeline note; the surface that was supposed to carry
 * it standing was dead from the day it shipped.
 *
 * A default value is what makes this class of break silent, so the test is
 * aimed exactly there: every loader field whose name `TaskDetailPage` declares
 * as a prop must be passed in the route's own JSX. It reads source text rather
 * than rendering, because the defect is not in any render — it is in the join,
 * and a render test with the prop supplied by hand proves the opposite of what
 * is needed.
 *
 * A loader field that is deliberately not a page prop (`timelineTotal`) is out
 * of scope by construction: the rule is about props that EXIST and go unfed.
 */
describe("ruling 320 — the loader-to-page wire", () => {
  it("passes every loader field the page declares as a prop", async () => {
    const { readFileSync } = await import("node:fs");
    const routeSrc = readFileSync("app/routes/project.task.tsx", "utf8");
    const pageSrc = readFileSync(
      "app/features/task-detail/task-detail-page.tsx",
      "utf8",
    );

    // The loader's REAL keys, from a real request — not a re-parse of the
    // return statement, which is the sort of second description this codebase
    // keeps finding drifted.
    const loaderKeys = Object.keys(await runLoader("VIB-142", ids.arda));
    expect(loaderKeys.length).toBeGreaterThan(20);

    // The page's declared props: the `}: {` … `}) {` block of its signature.
    const propsBlock = pageSrc.slice(
      pageSrc.indexOf("}: {"),
      pageSrc.indexOf("\n}) {"),
    );
    const props = new Set(
      [...propsBlock.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!),
    );
    expect(props.size).toBeGreaterThan(20);

    // The route's own `<TaskDetailPage … />`.
    const jsxAt = routeSrc.indexOf("<TaskDetailPage");
    const jsx = routeSrc.slice(jsxAt, routeSrc.indexOf("/>", jsxAt));
    expect(jsxAt).toBeGreaterThan(-1);

    const unfed = loaderKeys.filter(
      (key) => props.has(key) && !jsx.includes(`loaderData.${key}`),
    );
    expect(
      unfed,
      `the loader computes these and the page declares them, but the route never hands them over: ${unfed.join(", ")}`,
    ).toEqual([]);
  });
});

describe("attach-file (F39-6) — the human writer, end to end through the route", () => {
  const attachmentsOf = async (key: string) => {
    const { listTaskAttachments } = await import(
      "~/server/files/task-attachments.server"
    );
    return listTaskAttachments("viberr-core", key, app.dataRoot).map((a) => a.name);
  };

  it("a CONTRIBUTOR attaches a file: it lands, the timeline says so, the audit names them", async () => {
    const result = await postFile(
      "VIB-141",
      ids.selin,
      "ax-upstream-manifests.yaml",
      "apiVersion: ax.io/v1alpha1\nkind: Task\n",
    );
    expect(result).toMatchObject({ ok: true, intent: "attach-file" });
    // SAFETY: the assertion above proved this is the `attach-file` success arm,
    // which is the only member of the action's union carrying `toast` for this
    // intent.
    const ok = result as Extract<ActionData, { intent: "attach-file" }>;
    expect(ok.toast).toContain("ax-upstream-manifests.yaml");
    // The toast says what the file is FOR, because that is the reason to attach
    // one at all.
    expect(ok.toast).toContain("can read it");
    expect(await attachmentsOf("VIB-141")).toContain("ax-upstream-manifests.yaml");

    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const top = readTaskFile({
      projectSlug: "viberr-core",
      taskKey: "VIB-141",
      dataRoot: app.dataRoot,
    })!.parsed.timeline[0]!;
    expect(top.title).toBe("Attachment added");
    expect(top.text).toContain("ax-upstream-manifests.yaml");
    expect(top.actor.kind).toBe("human");

    const { listAuditEvents } = await import("../../../test-support/audit-log");
    expect(
      listAuditEvents(app.db).some(
        (e) =>
          e.action === "task.attachment.added" &&
          e.taskKey === "VIB-141" &&
          e.actorUserId === ids.selin,
      ),
    ).toBe(true);
  });

  it("refuses a NON-MEMBER, and refuses a type the serving route would not render", async () => {
    // R15-4: a non-member is stopped by the route's visibility gate, before the
    // intent switch, with the unknown-slug 404; the grant check inside
    // attachTaskFile is the VIEWER case below.
    await expect(
      postFile("VIB-141", ids.deniz, "sneaky.txt", "x"),
    ).rejects.toMatchObject({
      init: { status: 404 },
      data: "No project at projects/viberr-core.",
    });
    expect(await attachmentsOf("VIB-141")).not.toContain("sneaky.txt");

    // SAFETY: a name the store would hide throws AppError, which the route
    // renders through `appErrorResponse` — the refusal arm. (Ruling 566: any
    // kind is stored; the name and the size are what an upload is refused by.)
    const badName = (await postFile(
      "VIB-141",
      ids.selin,
      ".hidden.txt",
      "x",
    )) as ActionRefusal;
    expect(badName.data.ok).toBe(false);
    expect(badName.data.error).toContain("cannot start with a dot");
    expect(await attachmentsOf("VIB-141")).not.toContain(".hidden.txt");
  });

  it("refuses a VIEWER at attachTaskFile's own attach-file grant, and stores nothing", async () => {
    // A viewer is a member, so the visibility gate lets the request through and
    // the refusal is the writer's own: `attach-file` is contributor and up.
    // CANARY: drop `requireAction(… "attach-file" …)` in attachTaskFile and the
    // viewer's file lands.
    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { reprojectProject } = await import(
      "~/server/projections/rebuilder.server"
    );
    /** Deniz on viberr-core as a viewer, or off it again: in the file the
     *  writer's guard reads and in the projection the visibility gate reads. */
    const seatDeniz = async (role: "viewer" | null) => {
      await updateProjectFile(
        { projectSlug: "viberr-core", dataRoot: app.dataRoot },
        (parsed) => {
          parsed.frontmatter.members = parsed.frontmatter.members.filter(
            (m) => m.userId !== ids.deniz,
          );
          if (role) parsed.frontmatter.members.push({ userId: ids.deniz, role });
        },
      );
      reprojectProject(app.db, { dataRoot: app.dataRoot }, "viberr-core");
    };
    await seatDeniz("viewer");
    try {
      // SAFETY: the grant refusal is an AppError raised inside the action's
      // try, answered on the refusal arm through `appErrorResponse`.
      const refused = (await postFile(
        "VIB-141",
        ids.deniz,
        "viewer-notes.txt",
        "x",
      )) as ActionRefusal;
      expect(refused.init.status).toBe(403);
      expect(refused.data.error).toBe(
        "Your project role (viewer) cannot attach a file to a task.",
      );
      expect(await attachmentsOf("VIB-141")).not.toContain("viewer-notes.txt");
    } finally {
      await seatDeniz(null);
    }
  });

  /**
   * Ruling 388 binds a review to WHEN a deliverer saved its files, not to
   * their bytes, so a person's upload over one of them would leave an
   * approval standing on content no reviewer read.
   */
  it("never overwrites a file an agent run saved, and still lets a person replace their own", async () => {
    const { updateTaskFile, readTaskFile } = await import("~/server/files/task-writer.server");
    const { writeTaskAttachment } = await import("~/server/files/task-attachments.server");
    const ref = { projectSlug: "viberr-core", taskKey: "VIB-141", dataRoot: app.dataRoot };
    writeTaskAttachment("viberr-core", "VIB-141", "report.md", new TextEncoder().encode("the agent's report"), app.dataRoot);
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "comment",
        actor: { kind: "agent", backend: "codex", profileId: "dev", roleHint: "Developer" },
        title: null,
        text: "Report attached.",
        toAgent: false,
        evidence: null,
        attachments: ["report.md"],
      });
    });

    // SAFETY: a refused write throws AppError, rendered by the refusal arm.
    const refused = (await postFile("VIB-141", ids.selin, "report.md", "mine")) as ActionRefusal;
    // CANARY: pass no refusal to the writer and the agent's report is replaced.
    expect(refused.data.ok).toBe(false);
    expect(refused.data.error).toContain("an agent run saved");
    const { readTaskAttachment } = await import("~/server/files/task-attachments.server");
    expect(JSON.stringify(readTaskAttachment("viberr-core", "VIB-141", "report.md", app.dataRoot))).toContain(
      "the agent's report",
    );
    expect(readTaskFile(ref)!.parsed.timeline[0]!.title).not.toBe("Attachment added");

    await postFile("VIB-141", ids.selin, "notes.md", "first");
    const again = await postFile("VIB-141", ids.selin, "notes.md", "second");
    expect(again).toMatchObject({ ok: true, intent: "attach-file" });
    // SAFETY: the assertion above proved the success arm.
    expect((again as Extract<ActionData, { intent: "attach-file" }>).toast).toContain("(replaced)");
  });

  it("refuses an oversized body before reading it", async () => {
    const { action } = await import("~/routes/project.task");
    const { cookie } = await app.cookieFor(ids.selin);
    let read = false;
    // A zero high-water mark: `pull` runs only when something reads the body.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    // SAFETY: as in postIntent, the action reads `request` and `params` only.
    const result = (await action({
      request: app.request("/projects/viberr-core/tasks/VIB-141", {
        method: "POST",
        cookie,
        headers: { "content-length": String(40 * 1024 * 1024) },
        body,
        duplex: "half",
      } as RequestInit),
      params: { slug: "viberr-core", key: "VIB-141" },
      context: {},
    } as never)) as ActionRefusal;
    // CANARY: drop the content-length check and the whole form is parsed
    // (the stream is read) before any size refusal.
    expect(result.init?.status).toBe(413);
    expect(result.data.error).toContain("up to 10 MB");
    expect(read).toBe(false);
  });

  it("refuses an empty submit by name", async () => {
    const { action } = await import("~/routes/project.task");
    const { cookie, sessionId } = await app.cookieFor(ids.selin);
    const csrf = await app.csrfFor(sessionId);
    const form = new FormData();
    form.set("_csrf", csrf);
    form.set("intent", "attach-file");
    // SAFETY: as in postIntent, the action reads `request` and `params` only;
    // and a submit with no file part takes the intent's own 400 arm.
    const result = (await action({
      request: app.request("/projects/viberr-core/tasks/VIB-141", {
        method: "POST",
        cookie,
        body: form,
      }),
      params: { slug: "viberr-core", key: "VIB-141" },
      context: {},
    } as never)) as ActionRefusal;
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toContain("Choose a file");
  });
});

/**
 * Ruling 482: "Run gates" on the PR card. The intent reaches the gate request
 * at the manual delivery's tier; on a project that declares no gates it says
 * so rather than claiming a run.
 */
describe("run-gates (ruling 482)", () => {
  it("refuses a contributor, and answers a maintainer honestly when nothing is owed", async () => {
    // CANARY: drop the `run-gates` case and both answers are the unknown
    // intent's 400.
    // SAFETY: a refused intent always answers on the refusal arm.
    const denied = (await postIntent("VIB-141", ids.selin, { intent: "run-gates" })) as ActionRefusal;
    expect(denied.init.status).toBe(403);
    // SAFETY: as above — `not_owed` is the intent's own 409 refusal arm.
    const none = (await postIntent("VIB-141", ids.murat, { intent: "run-gates" })) as ActionRefusal;
    expect(none.init.status).toBe(409);
    expect(none.data.error).toBe("The project declares no gates.");
  });
});
