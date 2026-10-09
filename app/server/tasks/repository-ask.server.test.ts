import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAuditEvents } from "../../../test-support/audit-log";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { settle } from "../../../test-support/polling";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
  type TestStoreUser,
} from "../../../test-support/test-store";
import { changeProjectRepo } from "~/features/project-settings/settings-actions.server";
import type { PacketOptionKind } from "~/schemas/task-file.schema";
import { listConversations } from "~/server/controller/controller-conversations.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { noRepositoryRuling } from "~/server/org/repository-ruling.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat } from "~/server/secrets/pat-store.server";
import { resolveOperatorAuthority } from "./operator-authority.server";
import { operatorAskForRepository, operatorOpenPacket } from "./operator-packets.server";
import { causeFanOutDisclosure, siblingPacketsSharingCause } from "./packet-fanout.server";
import { resolvePacket } from "./packet-resolution.server";
import {
  connectRepositoryFromPacket,
  keepWithoutRepositoryFromPacket,
} from "./repository-ask.server";
import { buildOperatorToolkit } from "./operator-toolkit.server";
import { buildControllerToolkit } from "~/server/controller/controller-toolkit.server";
import { requestPacketMaintainerDecision } from "./packet-resolution.server";
import type { TaskActionDeps } from "./task-action-core.server";
import { decisionsRequiring } from "~/server/projections/decisions.server";
import { callToolText, publishedSchemas } from "../../../test-support/mcp-tool-meta";
import { z } from "zod";

/**
 * Ruling 224 (owner, 2026-10-06): "operator creates a packet to remind to
 * user to connect a repo. If they refuse that's stored as a ruling on project
 * kb never asked again. If they decide to connect a repo, controller spawns on
 * board level and reverts the ruling on kb."
 *
 * The two runs a decision starts are the only things stubbed, through the
 * resolution's own seam (`TaskActionDeps`): a real controller turn or operator
 * run starts a model. Everything else is the real door: the packet writer,
 * `resolvePacket`, the settings change it attaches through, the
 * knowledge-base store.
 */
const runControllerTurn = vi.fn<NonNullable<TaskActionDeps["runControllerTurn"]>>();

const ctx = createTestDbContext();
afterEach(ctx.cleanup);
beforeEach(() => {
  runControllerTurn.mockReset();
  runControllerTurn.mockResolvedValue({ state: "started", runId: "run_ctl", messageId: "msg_1" });
});

const REPO = "acme/site";
const REASON = "VIB-1 changes the checkout page, whose code this board has no repository for.";

/**
 * A board with no repository: an operator, one specialist whose repo-write is
 * `writer`, and two tasks. A board made to deliver results is `off`; one made
 * for software and not connected yet is `direct`.
 */
function board(writer: "direct" | "off"): TestStore {
  const store = setupTestStore(ctx);
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "operator",
        capabilities: [{ capabilityId: "generate-packets", mode: "direct" }],
        extras: [],
        definition: { kind: "operator", name: "Operator", backends: ["claude"], model: "sonnet", autonomy: "supervised" },
      },
      {
        profileId: "builder",
        capabilities: [{ capabilityId: "execute-code-or-write-repo", mode: writer }],
        extras: [],
        definition: { kind: "specialist", name: "Builder", role: "Build", backends: ["claude"], model: "sonnet" },
      },
    ],
  });
  for (const key of ["VIB-1", "VIB-2"]) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, { stage: "impl", readiness: "ready", ownerUserId: store.users.arda.id }),
      goal: "Change the checkout page.",
    });
  }
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  return store;
}

/** A GitHub connection for `acme`, the instance default. */
function connect(store: TestStore): void {
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "connection · acme", token: "github_pat_acme0001" },
    actorOf(store.users.arda),
  );
  const now = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
       VALUES ('acme', 'acme', ?, 1, ?, ?)`,
    )
    .run(pat.id, now, now);
}

/** GitHub answering for the repository, with a token that can push or only read. */
const github = (push = true) =>
  fakeGithubFetch({
    [`GET /repos/${REPO}`]: { body: { full_name: REPO, default_branch: "trunk", private: true, permissions: { push } } },
  }).fetchImpl;

const at = (store: TestStore) => ({ dataRoot: store.dataRoot });
const authority = (store: TestStore) => resolveOperatorAuthority(at(store), store.slug);
const ask = (store: TestStore, taskKey = "VIB-1", repository?: string) =>
  operatorAskForRepository(
    store.db,
    at(store),
    repository ? { projectSlug: store.slug, taskKey, reason: REASON, repository } : { projectSlug: store.slug, taskKey, reason: REASON },
    authority(store),
  );
const taskOf = (store: TestStore, key = "VIB-1") =>
  readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed;
const timeline = (store: TestStore, key = "VIB-1") =>
  taskOf(store, key)
    .timeline.map((e) => e.text ?? "")
    .join("\n");
const projectOf = (store: TestStore) =>
  readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter;

/** The operator-run seam `autoInvokeOperator` starts, so a hand-back is seen. */
function operatorRuns() {
  return vi.fn<NonNullable<TaskActionDeps["runOperator"]>>(async () => ({
    runId: "run_op",
    queued: false,
    backend: "claude",
    autonomy: "supervised",
  }));
}

/** Answer the open question on `key` with the option of `kind`. */
function answer(
  store: TestStore,
  kind: PacketOptionKind,
  options: {
    key?: string;
    note?: string;
    by?: TestStoreUser;
    fetchImpl?: typeof fetch;
    runOperator?: ReturnType<typeof operatorRuns>;
  } = {},
) {
  const key = options.key ?? "VIB-1";
  const optionIndex = taskOf(store, key).packet!.options.findIndex((o) => o.kind === kind);
  const input: Parameters<typeof resolvePacket>[1] = { projectSlug: store.slug, taskKey: key, optionIndex };
  if (options.note !== undefined) input.note = options.note;
  const actionCtx: Parameters<typeof resolvePacket>[3] = { dataRoot: store.dataRoot };
  if (options.fetchImpl) actionCtx.fetchImpl = options.fetchImpl;
  actionCtx.deps = options.runOperator
    ? { runControllerTurn, runOperator: options.runOperator }
    : { runControllerTurn };
  return resolvePacket(store.db, input, actorOf(options.by ?? store.users.arda), actionCtx);
}

/** The tasks an operator run was started on, in order. */
const startedOn = (runOperator: ReturnType<typeof operatorRuns>) =>
  runOperator.mock.calls.map((call) => call[1].taskKey);

describe("the operator asks for a repository (ruling 224)", () => {
  it("opens one packet with both answers: connecting is recommended and needs the repository typed, opened with the one the task named", async () => {
    // CANARY: drop `keep_without_repository` and a person cannot refuse, so
    // nothing ever stops the question; drop `reply` and an empty Confirm
    // attaches nothing; drop the cause and a second task's question is not
    // answered with the first.
    const store = board("off");
    const result = await ask(store, "VIB-1", "https://github.com/acme/site.git");
    expect(result.outcome).toBe("done");
    const packet = taskOf(store).packet!;
    expect(packet).toMatchObject({
      type: "input",
      title: "Connect a repository to Viberr Core?",
      body: REASON,
      cause: `repository:${store.slug}`,
      observations: [{ k: "Repository named", v: REPO, code: true }],
    });
    expect(packet.options.map((o) => [o.kind, o.rec, o.reply ?? false, o.repo ?? null])).toEqual([
      ["connect_repository", true, true, REPO],
      ["keep_without_repository", false, false, null],
    ]);
    expect(taskOf(store).frontmatter.waiting).toBe("human");
  });

  it("is refused on a board that has a repository, with no reason given, and through the general packet tool", async () => {
    // CANARY: let the general tool write these kinds and an operator composes
    // a "connect" with no way to refuse it; ask on a board with a repository
    // and a person is asked to connect what is there.
    const store = board("off");
    expect((await operatorAskForRepository(store.db, at(store), { projectSlug: store.slug, taskKey: "VIB-1", reason: "  " }, authority(store))).message).toContain(
      "Say why this task needs a repository",
    );
    const stray = await operatorOpenPacket(
      store.db,
      at(store),
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        packetType: "input",
        title: "Repository?",
        options: [{ kind: "connect_repository", title: "Connect akin-ozer/site" }],
      },
      authority(store),
    );
    expect(stray).toMatchObject({ outcome: "noop" });
    expect(stray.message).toContain("Only ask_for_repository writes it");
    expect(taskOf(store).packet).toBeNull();

    writeProject(store.dataRoot, { ...projectOf(store), repo: REPO });
    const withRepo = await ask(store);
    expect(withRepo).toMatchObject({ outcome: "noop" });
    expect(withRepo.message).toContain(`This board already has a repository (${REPO})`);
    expect(taskOf(store).packet).toBeNull();
  });
});

describe("a person keeps the board without a repository (ruling 224)", () => {
  it("writes the decision into the project's rulings, answers every task that asked, and the question is never asked again", async () => {
    // CANARY: clear the packet without writing the ruling and the next task
    // asks again; leave the second task's packet open and the person is asked
    // twice; let `ask_for_repository` through with the ruling standing and
    // "never asked again" is a sentence, not a refusal.
    const store = board("off");
    await ask(store, "VIB-1");
    await ask(store, "VIB-2");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runOperator = operatorRuns();

    await answer(store, "keep_without_repository", { runOperator });

    const ruling = noRepositoryRuling(store.slug, at(store));
    expect(ruling).toEqual({ kb: `${store.slug}-rulings`, doc: `no-repository-${store.slug}.md` });
    expect(projectOf(store).rulingsKb).toBe(`${store.slug}-rulings`);
    expect(projectOf(store).repo).toBeNull();
    for (const key of ["VIB-1", "VIB-2"]) {
      expect(taskOf(store, key).packet, key).toBeNull();
      expect(timeline(store, key), key).toContain(
        `**Decision:** Keep this board without one. It is in the project's rulings (\`${store.slug}-rulings/no-repository-${store.slug}.md\`)`,
      );
    }
    expect(timeline(store, "VIB-2")).toContain('chose "Keep this board without one" there for the board');
    expect(timeline(store, "VIB-1")).toContain("The same answer was applied to VIB-2, where the same question was open.");
    // A board decision is not this task's contract: the goal is as it was.
    expect(taskOf(store).goal).toBe("Change the checkout page.");
    // Both operators carry on at once: nothing is being switched.
    await vi.waitFor(() => expect(startedOn(runOperator).toSorted()).toEqual(["VIB-1", "VIB-2"]));
    expect(runControllerTurn).not.toHaveBeenCalled();
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_recorded" })).toHaveLength(1);

    const again = await ask(store, "VIB-2");
    expect(again).toMatchObject({ outcome: "noop" });
    expect(again.message).toContain("A person already decided this board connects no repository");
    expect(again.message).toContain(`${store.slug}-rulings/no-repository-${store.slug}.md`);
    expect(taskOf(store, "VIB-2").packet).toBeNull();
    expect(authority(store).repositoryAsk).toBe("declined");
  });

  it("is a project admin's to decide: a maintainer is refused and nothing is written", async () => {
    // CANARY: check only `resolve-packet` and a maintainer writes a standing
    // ruling for the whole board.
    const store = board("off");
    await ask(store);
    await expect(answer(store, "keep_without_repository", { by: store.users.murat })).rejects.toMatchObject({ status: 403 });
    expect(noRepositoryRuling(store.slug, at(store))).toBeNull();
    expect(taskOf(store).packet).not.toBeNull();
  });
});

describe("a person connects a repository from the packet (ruling 224)", () => {
  it("attaches what they typed through the settings door, with GitHub's default branch and the connection bound", async () => {
    // CANARY: clear the packet without the attach and the board has no
    // repository under a record that says it does; attach without the probe
    // and `defaultBranch` is a guess (rulings 226, 225).
    const store = board("direct");
    connect(store);
    await ask(store);
    const runOperator = operatorRuns();
    await answer(store, "connect_repository", { note: REPO, fetchImpl: github(), runOperator });

    expect(projectOf(store)).toMatchObject({ repo: REPO, defaultBranch: "trunk" });
    expect(
      store.db.prepare(`SELECT COUNT(*) AS n FROM project_github_credentials WHERE project_slug = ?`).get(store.slug),
    ).toEqual({ n: 1 });
    expect(taskOf(store).packet).toBeNull();
    expect(timeline(store)).toContain(
      "**Decision:** Connect a repository. Repository attached: acme/site (default branch trunk), checked and bound with acme's connection.",
    );
    expect(taskOf(store).goal).toBe("Change the checkout page.");
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })[0]?.details).toMatchObject({ from: null, to: REPO });
    expect(authority(store).repositoryAsk).toBeNull();
  });

  it("refuses what GitHub does not confirm, a token that cannot push, and an empty answer, each leaving the question open", async () => {
    // CANARY: accept a read-only token because no agent writes yet and the
    // board is switched to pull requests it cannot push; clear the packet on
    // a refusal and the person has no question left to answer.
    const store = board("off");
    connect(store);
    await ask(store);
    const refusals: [string, typeof fetch, string][] = [
      ["", github(), "needs your answer"],
      ["acme/ghost", github(), "acme/ghost"],
      [REPO, github(false), "cannot push"],
      ["not a repository", github(), "Enter the repository as owner/name"],
    ];
    for (const [note, fetchImpl, sentence] of refusals) {
      await expect(answer(store, "connect_repository", { note, fetchImpl }), note).rejects.toThrow(sentence);
      expect(projectOf(store).repo, note).toBeNull();
      expect(taskOf(store).packet, note).not.toBeNull();
    }
    expect(runControllerTurn).not.toHaveBeenCalled();
  });

  it("is a project admin's: a maintainer is refused before GitHub is asked anything", async () => {
    // CANARY: let the packet's own tier attach a repository and a maintainer
    // changes the board's policy from a task page.
    const store = board("off");
    connect(store);
    await ask(store);
    const gh = fakeGithubFetch({});
    await expect(
      answer(store, "connect_repository", { note: REPO, by: store.users.murat, fetchImpl: gh.fetchImpl }),
    ).rejects.toMatchObject({ status: 403 });
    expect(gh.calls).toHaveLength(0);
    expect(projectOf(store).repo).toBeNull();
    // The settings door guards the attach; the answer's own check is what
    // guards a question left open on a board that has a repository since.
    writeProject(store.dataRoot, { ...projectOf(store), repo: REPO });
    await expect(answer(store, "connect_repository", { note: REPO, by: store.users.murat })).rejects.toMatchObject({
      status: 403,
    });
    expect(taskOf(store).packet).not.toBeNull();
    // A project admin closes it, and attaches nothing: it is connected.
    await answer(store, "connect_repository", { note: "acme/other" });
    expect(taskOf(store).packet).toBeNull();
    expect(projectOf(store).repo).toBe(REPO);
    expect(timeline(store)).toContain(
      "**Decision:** Connect a repository. `acme/site` is connected to this board. It was connected before this answer, so `acme/other` was not: changing a project's repository is done in its settings.",
    );
    expect(runControllerTurn).not.toHaveBeenCalled();
  });
});

describe("the controller is started on the board, and the operators carry on when the board can deliver (ruling 259)", () => {
  it("on a board no agent may write yet: the controller starts as the person who connected it, is told which operators wait, and they are not started", async () => {
    // CANARY: start the operators with the answer and each finds a
    // repository nobody may write, and opens a packet about it the moment a
    // person answered one; start no controller and the board is never switched.
    const store = board("off");
    connect(store);
    await connectFakeBackend(store.db, store.users.arda.id, "claude");
    await ask(store, "VIB-1");
    await ask(store, "VIB-2");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const runOperator = operatorRuns();

    await answer(store, "connect_repository", { note: REPO, fetchImpl: github(), runOperator });

    expect(runControllerTurn).toHaveBeenCalledTimes(1);
    const turn = runControllerTurn.mock.calls[0]![1];
    const conversations = listConversations(store.db, { userId: store.users.arda.id, projectSlug: store.slug });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ projectSlug: store.slug, taskKey: null });
    expect(turn).toMatchObject({
      conversationId: conversations[0]!.id,
      user: { id: store.users.arda.id, email: store.users.arda.email, orgRole: "admin" },
      surface: `/projects/${store.slug}/tasks/VIB-1`,
    });
    expect(turn.text).toBe(
      "I connected `acme/site` to this board from VIB-1's decision packet, so its tasks should ship as pull requests from here on. " +
        "Switch the board to pull requests: give the agent that delivers its work repo-write back, correct any ruling that still says tasks here are delivered as files (or name the passages, if editing the knowledge base is not mine to ask for), and tell me what you changed and what is left for me to decide. " +
        "When the board is switched, start the operator again on VIB-1, VIB-2 with `run_agent_on_task`: they wait for that.",
    );
    // The second task took the answer and attached nothing of its own.
    expect(taskOf(store, "VIB-2").packet).toBeNull();
    expect(timeline(store, "VIB-2")).toContain("**Decision:** Connect a repository. `acme/site` is connected to this board.");
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })).toHaveLength(1);
    expect(timeline(store, "VIB-1")).toContain(
      "The controller was started on this board to switch it to pull requests. Its answer is in the board's Controller conversation. No agent here may write the repository yet, so the operator starts again when the controller has switched the board.",
    );
    // The other task waits too, and says why: it shows "waiting on agent".
    expect(timeline(store, "VIB-2")).toContain(
      "No agent on this board may write the repository yet, so the operator here starts again when the controller has switched the board to pull requests.",
    );
    // A hand-back is fire-and-forget, so give one the time it would take.
    await settle();
    expect(runOperator).not.toHaveBeenCalled();
  });

  it("on a board whose agent already writes: the controller starts, nobody waits for it, and the operators start at once", async () => {
    // CANARY: hold the operators whenever a controller starts and a software
    // board connected late sits idle for a switch it does not need.
    const store = board("direct");
    connect(store);
    await connectFakeBackend(store.db, store.users.arda.id, "claude");
    await ask(store);
    const runOperator = operatorRuns();
    await answer(store, "connect_repository", { note: REPO, fetchImpl: github(), runOperator });

    expect(runControllerTurn).toHaveBeenCalledTimes(1);
    expect(runControllerTurn.mock.calls[0]![1].text).not.toContain("run_agent_on_task");
    await vi.waitFor(() => expect(startedOn(runOperator)).toEqual(["VIB-1"]));
    expect(runOperator.mock.calls[0]![1]).toMatchObject({
      trigger: "packet-resolved",
      resolvedOption: { kind: "connect_repository", title: "Connect a repository", note: REPO },
    });
  });

  it("with no Claude account connected: no controller turn, the task says why and what is left, and the operators start", async () => {
    // CANARY: hold the operators for a controller that never started and the
    // task waits on nobody; say nothing and the board looks switched.
    const store = board("off");
    connect(store);
    await ask(store);
    const runOperator = operatorRuns();
    await answer(store, "connect_repository", { note: REPO, fetchImpl: github(), runOperator });

    expect(runControllerTurn).not.toHaveBeenCalled();
    expect(listConversations(store.db, { userId: store.users.arda.id, projectSlug: store.slug })).toHaveLength(0);
    expect(timeline(store)).toContain(
      "The controller was not started on this board: Claude is not connected on Arda Test's account, and the controller runs on the account of the person who asks it. No agent here may write the repository yet: ask the controller to switch the board to pull requests, or grant repo-write on the Agents page.",
    );
    await vi.waitFor(() => expect(startedOn(runOperator)).toEqual(["VIB-1"]));
  });
});

describe("what the review of ruling 224 found (each a refusal or a record that was missing)", () => {
  it("states the records an earlier repository left beside the answers, and Connect goes through on that", async () => {
    // CANARY: drop `confirmFootprint` from the answer and a board that once
    // had a repository (the AWS board) can never connect one from the card:
    // the settings door refuses with "Confirm the change to proceed", and the
    // card has no such control.
    const store = board("direct");
    connect(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "done",
        ownerUserId: store.users.arda.id,
        pr: { number: 4, state: "merged", title: "Old work" },
      }),
      goal: "Finished against the repository this project had.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await ask(store);
    expect(taskOf(store).packet!.observations).toEqual([
      {
        k: "Earlier records",
        v: "1 task here carries branch or pull request records from a repository this project had before. They keep their history, and sync runs against the one you connect.",
        code: false,
      },
    ]);
    await answer(store, "connect_repository", { note: REPO, fetchImpl: github() });
    expect(projectOf(store).repo).toBe(REPO);
    expect(listAuditEvents(store.db, { action: "project.repo.updated" })[0]?.details).toMatchObject({ footprintTasks: 1 });
  });

  it("says the repository is connected when the decision's own write is refused, and settles the board all the same", async () => {
    // CANARY: let the refusal out as it is and a person reads "already
    // resolved" for an attach that happened, with the other task still asking.
    const store = board("direct");
    connect(store);
    await ask(store, "VIB-1");
    await ask(store, "VIB-2");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // The operator withdraws VIB-1's packet while GitHub is being asked.
    const racing = fakeGithubFetch({
      [`GET /repos/${REPO}`]: () => {
        writeTask(store.dataRoot, store.slug, {
          frontmatter: taskOf(store).frontmatter,
          goal: taskOf(store).goal,
        });
        return { body: { full_name: REPO, default_branch: "trunk", private: true, permissions: { push: true } } };
      },
    }).fetchImpl;
    await expect(answer(store, "connect_repository", { note: REPO, fetchImpl: racing })).rejects.toMatchObject({
      status: 409,
      userMessage:
        "acme/site was connected to this board, but the decision could not be recorded on VIB-1: This packet was already resolved. " +
        "The repository stays connected, and every task still asking was answered. If no agent here may write it yet, ask the controller to switch the board to pull requests.",
    });
    expect(projectOf(store).repo).toBe(REPO);
    expect(taskOf(store, "VIB-2").packet).toBeNull();
    expect(timeline(store, "VIB-2")).toContain("connected `acme/site` to the board, so the question here is settled.");
  });

  it("refuses the second of two answers that attach at once, writing nothing over the first", async () => {
    // CANARY: write without re-reading under the project's lock and the
    // second person's repository silently replaces the first's.
    const store = board("direct");
    connect(store);
    await ask(store);
    const racing = fakeGithubFetch({
      [`GET /repos/${REPO}`]: () => {
        writeProject(store.dataRoot, { ...projectOf(store), repo: "acme/first", defaultBranch: "main" });
        return { body: { full_name: REPO, default_branch: "trunk", private: true, permissions: { push: true } } };
      },
    }).fetchImpl;
    await expect(answer(store, "connect_repository", { note: REPO, fetchImpl: racing })).rejects.toMatchObject({
      status: 409,
      userMessage: "The project's repository became acme/first while acme/site was being checked. Nothing was changed.",
    });
    expect(projectOf(store)).toMatchObject({ repo: "acme/first", defaultBranch: "main" });
    expect(taskOf(store).packet).not.toBeNull();
    expect(runControllerTurn).not.toHaveBeenCalled();
  });

  it("refuses to keep a board without a repository once it has one, and each answer that only reached a task checks what it claims", async () => {
    // CANARY: record the ruling on a board that has a repository and every
    // run there reads, as binding, that it has none.
    const store = board("off");
    await ask(store);
    writeProject(store.dataRoot, { ...projectOf(store), repo: REPO });
    await expect(answer(store, "keep_without_repository")).rejects.toMatchObject({
      status: 409,
      userMessage:
        "This board has acme/site now, so there is nothing to keep it without. Remove it in the project's settings if the board should have none.",
    });
    expect(noRepositoryRuling(store.slug, at(store))).toBeNull();
    expect(taskOf(store).packet).not.toBeNull();

    // An answer that reached a task from elsewhere carries nothing out, so it
    // refuses when what it would record is not so.
    writeProject(store.dataRoot, { ...projectOf(store), repo: null });
    const reached = { projectSlug: store.slug, answeredElsewhere: true };
    await expect(
      connectRepositoryFromPacket(store.db, at(store), { ...reached, typed: REPO }, actorOf(store.users.arda)),
    ).rejects.toThrow("No repository is connected to this board, so the question here still stands.");
    await expect(
      keepWithoutRepositoryFromPacket(
        store.db,
        at(store),
        { ...reached, taskKey: "VIB-1", byName: "Arda Test", at: "2026-10-06T18:00:00.000Z" },
        actorOf(store.users.arda),
      ),
    ).rejects.toThrow("The project's rulings hold no decision about a repository, so the question here still stands.");
    expect(noRepositoryRuling(store.slug, at(store))).toBeNull();
  });

  it("is waiting on a project admin and nobody else, and anyone who cannot answer sends it to one", async () => {
    // CANARY: count it for whoever resolves packets, or for the task's owner,
    // and an inbox holds a decision its person cannot make; route it to "a
    // maintainer" and the people told cannot answer it either; leave it out
    // of what the controller lists and a maintainer who asks what is waiting
    // is told "nothing" about a packet on their own board.
    const store = board("off");
    // The task's owner is a contributor: the owner exception is not a way in.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", readiness: "ready", ownerUserId: store.users.selin.id }),
      goal: "Change the checkout page.",
    });
    await ask(store);
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const waiting = (user: TestStoreUser) => {
      const found = decisionsRequiring(store.db, user.id, { projectSlug: store.slug });
      return { mine: found.mine.map((d) => d.taskKey), needsProjectAdmin: found.needsProjectAdmin.map((d) => d.taskKey) };
    };
    expect(waiting(store.users.arda)).toEqual({ mine: ["VIB-1"], needsProjectAdmin: [] });
    expect(waiting(store.users.murat)).toEqual({ mine: [], needsProjectAdmin: ["VIB-1"] });
    expect(waiting(store.users.selin)).toEqual({ mine: [], needsProjectAdmin: ["VIB-1"] });

    // What the controller tells a maintainer who asks what is waiting.
    const listed = z
      .object({
        forYou: z.array(z.object({ task: z.string() })),
        waitingOnAProjectAdmin: z.array(z.object({ task: z.string(), packet: z.object({ title: z.string() }) })),
        howToAnswer: z.string(),
      })
      .parse(
        JSON.parse(
          await callToolText(
            buildControllerToolkit({
              db: store.db,
              ctx: at(store),
              user: { id: store.users.murat.id, email: store.users.murat.email, name: store.users.murat.name },
              projectSlug: store.slug,
            }).tools,
            "list_decisions",
            {},
          ),
        ),
      );
    expect(listed.forYou).toEqual([]);
    expect(listed.waitingOnAProjectAdmin).toEqual([
      { task: "VIB-1", packet: { title: "Connect a repository to Viberr Core?" } },
    ]);
    expect(listed.howToAnswer).toBe(
      "Nothing here is this person's to answer. Each decision under `waitingOnAProjectAdmin` asks whether the board connects a repository. " +
        "Both answers decide the board, so a project admin gives one: this person opens the task page at `answerAt` and sends it to one.",
    );

    await expect(
      requestPacketMaintainerDecision(store.db, { projectSlug: store.slug, taskKey: "VIB-1" }, actorOf(store.users.arda), at(store)),
    ).rejects.toThrow("You can answer this decision yourself; there is no need to send it to a project admin.");
    const sent = await requestPacketMaintainerDecision(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.murat),
      at(store),
    );
    expect(sent.to).toBe("admin");
    expect(timeline(store)).toContain(
      `cannot answer "Connect a repository to Viberr Core?" on VIB-1: both answers decide the board, which is a project admin's, so they asked a project admin to make the call.`,
    );
    expect(
      store.db
        .prepare(`SELECT title FROM notifications WHERE user_id = ? ORDER BY rowid DESC LIMIT 1`)
        .get(store.users.arda.id),
    ).toEqual({ title: "Decision needs a project admin: Connect a repository to Viberr Core?" });
  });

  it("the operator's own tool opens the question, and its packet options cannot spell either answer", async () => {
    // CANARY: drop the handler's `repository` and the card opens empty; put
    // the two kinds back in the option enum and every operator's schema
    // offers answers only this tool may write.
    const store = board("off");
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: at(store),
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority(store),
      orgMcpServers: {},
    });
    expect(
      await callToolText(toolkit.tools, "ask_for_repository", { reason: REASON, repository: "github.com/acme/site" }),
    ).toBe("[done] Opened a decision packet with 2 option(s).");
    expect(taskOf(store).packet).toMatchObject({ body: REASON, cause: `repository:${store.slug}` });
    expect(taskOf(store).packet!.options[0]).toMatchObject({ kind: "connect_repository", repo: REPO });
    // What the model is shown of `open_decision_packet`: the kinds it may write.
    const published = z
      .object({
        properties: z.object({
          options: z.object({ items: z.object({ properties: z.object({ kind: z.object({ enum: z.array(z.string()) }) }) }) }),
        }),
      })
      .parse((await publishedSchemas(toolkit.mcpServers.viberr)).get("open_decision_packet"));
    const kinds = published.properties.options.items.properties.kind.enum;
    expect(kinds).toContain("redirect");
    expect(kinds).not.toContain("connect_repository");
    expect(kinds).not.toContain("keep_without_repository");
  });
});

describe("a repository connected in the project's settings (ruling 224)", () => {
  const attach = (store: TestStore) =>
    changeProjectRepo(store.db, { projectSlug: store.slug, repo: REPO }, actorOf(store.users.arda), at(store), {
      fetchImpl: github(),
    });

  it("answers every task still asking, and says so in its own toast and on each task", async () => {
    // CANARY: attach without settling and a board with a repository still
    // shows a packet asking whether to connect one.
    const store = board("direct");
    connect(store);
    await ask(store, "VIB-1");
    await ask(store, "VIB-2");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const result = await attach(store);
    expect(result.toast).toBe(
      "Repository attached: acme/site (default branch trunk), checked and bound with acme's connection. The operator's question on VIB-1, VIB-2 was answered",
    );
    expect(result.settled).toMatchObject({ rulingRemoved: null, answered: ["VIB-1", "VIB-2"], missed: [], operatorsStarted: true });
    for (const key of ["VIB-1", "VIB-2"]) {
      expect(taskOf(store, key).packet, key).toBeNull();
      expect(timeline(store, key), key).toContain("connected `acme/site` to the board, so the question here is settled.");
    }
    // The settings door starts no controller: nobody answered a packet.
    expect(runControllerTurn).not.toHaveBeenCalled();
  });

  it("removes the ruling that the board connects none", async () => {
    // CANARY: keep the document and every run on a board with a repository
    // reads, as binding, that it has none.
    const store = board("off");
    connect(store);
    await ask(store);
    await answer(store, "keep_without_repository");
    expect(noRepositoryRuling(store.slug, at(store))).not.toBeNull();

    const result = await attach(store);
    // The settings door starts no controller, so on a board nobody may write
    // it says what is left. CANARY: drop the sentence and the board looks
    // switched while its tasks still come back as files.
    expect(result.toast).toBe(
      "Repository attached: acme/site (default branch trunk), checked and bound with acme's connection. " +
        `The ruling that this board connects no repository was removed from ${store.slug}-rulings. ` +
        "No agent on this board may write it yet: ask the controller to switch the board to pull requests",
    );
    expect(noRepositoryRuling(store.slug, at(store))).toBeNull();
    expect(listAuditEvents(store.db, { action: "project.repo.ruling_removed" })).toHaveLength(1);
    expect(runControllerTurn).not.toHaveBeenCalled();
  });
});

describe("the controller connects a repository (ruling 224)", () => {
  /** The controller's toolkit as the store's project admin, on the board. */
  const controller = (store: TestStore, fetchImpl: typeof fetch = github()) =>
    buildControllerToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot, fetchImpl },
      user: { id: store.users.arda.id, email: store.users.arda.email, name: store.users.arda.name },
      projectSlug: store.slug,
    }).tools;
  const CONNECT = { owner: "acme", repoName: "site" };

  it("to deliver through, on a board nobody may write: the question is answered, the operators wait, and the reply says whom to start", async () => {
    // CANARY: start the operators with the connection and each meets a
    // repository nobody may write while the controller is still switching
    // the board; leave the tasks out of the reply and nothing starts them
    // but the fifteen-minute sweep.
    const store = board("off");
    connect(store);
    await ask(store, "VIB-1");
    await ask(store, "VIB-2");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const reply = await callToolText(controller(store), "connect_project_repository", { ...CONNECT, delivers: true });
    expect(reply).toBe(
      "[done] Repository attached: acme/site (default branch trunk), checked and bound with acme's connection. " +
        "The operator's question on VIB-1, VIB-2 was answered. " +
        "No deployed agent may write it: tasks still come back as files until one is granted repo-write with update_agent_deployment. " +
        "Once one may, start the operator again on VIB-1, VIB-2 with run_agent_on_task: they wait for that.",
    );
    for (const key of ["VIB-1", "VIB-2"]) {
      expect(taskOf(store, key).packet, key).toBeNull();
      expect(timeline(store, key), key).toContain(
        "the operator here starts again when the controller has switched the board to pull requests.",
      );
    }
    // The controller made the connection in its own turn: no second one.
    expect(runControllerTurn).not.toHaveBeenCalled();
  });

  it("for the agents to read: the question is answered, nobody waits for a switch that is not coming, and a standing ruling goes", async () => {
    // CANARY: hold the operators whenever the controller connects and a
    // repository attached only to be read leaves its tasks waiting for a
    // switch nobody is making.
    const READ = { ...CONNECT, delivers: false };
    const asking = board("off");
    connect(asking);
    await ask(asking);
    rebuildAll(asking.db, { dataRoot: asking.dataRoot, force: true });
    const reply = await callToolText(controller(asking, github(false)), "connect_project_repository", READ);
    expect(reply).toContain("The operator's question on VIB-1 was answered");
    expect(reply).not.toContain("start the operator again");
    expect(taskOf(asking).packet).toBeNull();
    expect(timeline(asking)).not.toContain("starts again when the controller has switched the board");
    expect(projectOf(asking).repo).toBe(REPO);

    // On a board whose admin had decided to keep none, the decision goes.
    const declined = board("off");
    connect(declined);
    await ask(declined);
    await answer(declined, "keep_without_repository");
    const second = await callToolText(controller(declined, github(false)), "connect_project_repository", READ);
    expect(second).toContain(
      `The ruling that this board connects no repository was removed from ${declined.slug}-rulings`,
    );
    expect(noRepositoryRuling(declined.slug, at(declined))).toBeNull();
  });

  it("relays the earlier repository's records before it connects over them, and says a board with no connection can still start", async () => {
    // CANARY: drop `confirmFootprint` from the tool and a project that once
    // had a repository can never be connected by the controller.
    const store = board("direct");
    expect(await callToolText(controller(store), "list_github_connections", {})).toContain(
      "Any board can start without one (ruling 224): create it with no `owner` or `repoName`",
    );
    connect(store);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "done",
        ownerUserId: store.users.arda.id,
        pr: { number: 4, state: "merged", title: "Old work" },
      }),
      goal: "Finished against the repository this project had.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const refused = await callToolText(controller(store), "connect_project_repository", { ...CONNECT, delivers: true });
    expect(refused).toContain("Confirm the change to proceed");
    expect(projectOf(store).repo).toBeNull();
    const confirmed = await callToolText(controller(store), "connect_project_repository", {
      ...CONNECT,
      delivers: true,
      confirmFootprint: true,
    });
    expect(confirmed).toContain("[done] Repository attached: acme/site");
  });
});

describe("the card says the answer reaches the other tasks (ruling 65)", () => {
  it("names them as the same question, not as a failure", async () => {
    // CANARY: reuse the account-failure sentence and a person reads that a
    // failure stopped tasks nothing stopped.
    const store = board("off");
    await ask(store, "VIB-1");
    await ask(store, "VIB-2");
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const cause = `repository:${store.slug}`;
    const others = siblingPacketsSharingCause(store.db, cause, { projectSlug: store.slug, taskKey: "VIB-1" });
    expect(causeFanOutDisclosure(others, cause)).toBe(
      "The same question is open on one other task: VIB-2. Answering here answers each of them the same way: " +
        "you are deciding about the board, not about this task alone. A directive you write yourself applies only here.",
    );
  });
});
