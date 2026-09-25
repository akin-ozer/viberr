import { mkdirSync, readFileSync } from "node:fs";
import { DIVERGED_BRANCH_REMEDY } from "~/schemas/task-file.schema";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
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
import { listAuditEvents } from "../../../test-support/audit-log";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { describeRevisionDrift } from "~/shared/revision-drift";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { writeProject } from "../../../test-support/test-store";
import { operatorSnapshot, type OperatorAuthority } from "~/server/tasks/operator-actions.server";
import type { TaskActionDeps } from "~/server/tasks/task-actions.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import {
  operatorUpdateBranchFromBase,
  updateBranchGate,
} from "./update-branch-operator.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

/**
 * N19-9, decision half. The owner ruled this operator-decided: the operator
 * updates the branch when it judges it needed, and a CONFLICT opens a decision
 * packet (R18-4's shape — a human gate, never a force).
 */

let ctx: TestDbContext;
let store: TestStore;

const SYS = { userId: null, label: "test" };

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  // Ruling 162 (pass 35): the tool refuses at the acceptance boundary (Review
  // on this board), so the ordinary fixtures stand at the work stage.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", branch: "vib-1" }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  mkdirSync(
    path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "viberr", ".git"),
    { recursive: true },
  );
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "t", token: "ghp_faketoken1234567890" },
    SYS,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, SYS);
});

afterEach(() => ctx.cleanup());

function authority(patch: Partial<OperatorAuthority> = {}): OperatorAuthority {
  return {
    policy: new Map([
      ["generate-packets", "direct"],
      ["append-typed-events", "direct"],
    ]),
    autonomy: "supervised",
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps: [],
    persona: null,
    deployed: true,
    humanGatedBeforeWork: false,
    ...patch,
  };
}

/** A fake git whose merge either succeeds or conflicts. */
const PRE_SHA = "abc1234";
const MERGE_SHA = "merge00000000000000000000000000000000000";
const BASE_SHA = "base000000000000000000000000000000000000";
const REMOTE_SHA = "remote0000000000000000000000000000000000";

function fakeGit(
  opts: {
    conflict?: boolean;
    behind?: number;
    /** Ruling 134(c): origin's copy of the branch (default current). */
    remote?: "current" | "behind" | "diverged" | "absent";
    ahead?: number;
    /** Ruling 133(b): the push is refused non-fast-forward (a `push_conflict`). */
    pushRefused?: boolean;
    /** Ruling 159(b): the store-layout paths HEAD's tree carries. */
    storeLayoutFiles?: string[];
    /** Ruling 428: the files the branch changes since it forked. */
    branchFiles?: string[];
    /** Ruling 475: the base tip `origin/<base>` resolves to. */
    baseSha?: string;
  } = {},
) {
  const calls: string[][] = [];
  const remote = opts.remote ?? "current";
  let merged = false;
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) return { ok: true, stdout: "vib-1", stderr: "" };
    if (args.includes("--is-shallow-repository")) return { ok: true, stdout: "false", stderr: "" };
    if (args.includes("ls-tree")) {
      return {
        ok: true,
        stdout: (opts.storeLayoutFiles ?? []).map((f) => `${f}\0`).join(""),
        stderr: "",
      };
    }
    if (args.includes("--porcelain")) return { ok: true, stdout: "", stderr: "" };
    if (args.includes("fetch") && args.some((a) => a.includes("refs/heads/vib-1:"))) {
      return remote === "absent"
        ? { ok: false, stdout: "", stderr: "fatal: couldn't find remote ref vib-1" }
        : { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("--verify")) {
      return { ok: true, stdout: remote === "current" ? PRE_SHA : REMOTE_SHA, stderr: "" };
    }
    if (opts.branchFiles && args.includes("merge-base") && !args.includes("--is-ancestor")) {
      return { ok: true, stdout: "f".repeat(40), stderr: "" };
    }
    if (opts.branchFiles && args.includes("--name-only") && args.includes("--no-merges")) {
      return { ok: true, stdout: `${opts.branchFiles.join("\n")}\n`, stderr: "" };
    }
    if (args.includes("merge-base")) {
      return remote === "behind"
        ? { ok: true, stdout: "", stderr: "" }
        : { ok: false, stdout: "", stderr: "", code: 1 };
    }
    if (args.includes("--count")) {
      const range = args[args.length - 1] ?? "";
      if (range.endsWith("..HEAD")) return { ok: true, stdout: String(opts.ahead ?? 2), stderr: "" };
      return { ok: true, stdout: String(opts.behind ?? 2), stderr: "" };
    }
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      return { ok: true, stdout: merged ? MERGE_SHA : PRE_SHA, stderr: "" };
    }
    if (args.includes("rev-parse") && args.some((a) => a.startsWith("refs/remotes/origin/"))) {
      return { ok: true, stdout: opts.baseSha ?? BASE_SHA, stderr: "" };
    }
    if (args.includes("--diff-filter=U")) {
      return { ok: true, stdout: "app/main.ts\n", stderr: "" };
    }
    if (args.includes("merge") && args.includes("--abort")) {
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args.includes("merge") && opts.conflict) {
      return {
        ok: false,
        stdout: "CONFLICT (content): Merge conflict in app/main.ts",
        stderr: "",
      };
    }
    if (args.includes("merge")) merged = true;
    if (args.includes("push") && opts.pushRefused) {
      return {
        ok: false,
        stdout: "",
        stderr: " ! [rejected]        HEAD -> vib-1 (non-fast-forward)\nerror: failed to push some refs to 'origin'",
      };
    }
    return { ok: true, stdout: "", stderr: "" };
  });
  return { exec, calls };
}

/** Ruling 133(b): deploy `dev` (with or without repo-write) and engage it as
 *  VIB-1's deliverer, so the conflict packet has a resolver to consider. */
function deployDeliverer(repoWrite: boolean, engaged = true): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    agents: [
      {
        profileId: "dev",
        capabilities: repoWrite ? [{ capabilityId: "execute-code-or-write-repo", mode: "direct" }] : [],
        extras: [],
        definition: { kind: "specialist", name: "Dev", role: "developer", backends: ["claude"], model: "sonnet" },
      },
    ],
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      branch: "vib-1",
      engagements: engaged
        ? [{ profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false }]
        : [],
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** Every call carries a canned transport: the post-update reconcile (ruling
 *  132) must never reach GitHub from a test. Unrouted answers 404, which the
 *  reconcile degrades from honestly. */
type DispatchAgent = NonNullable<TaskActionDeps["dispatchAgent"]>;

/**
 * Ruling 475: the handoff's dispatch. A real one prepares the agent's
 * workspace from GitHub (the branch ensure, the mirror refresh), which no test
 * may reach, so every call carries a stub. The default refuses the way a task
 * with no owner to bill is refused, so a test that is not about the handoff
 * meets the fallback packet it always met.
 */
const refusedDispatch: DispatchAgent = async () => ({
  outcome: "noop",
  message: "No run started for Dev (the delivering agent): this task has no owner to bill its runs.",
});

/** A dispatch that starts the run, recording what it was handed. */
function startingDispatch() {
  const calls: Parameters<DispatchAgent>[2][] = [];
  const dispatch: DispatchAgent = async (_db, _ctx, input) => {
    calls.push(input);
    return { outcome: "done", message: "Prompted @Dev (the delivering agent) and started its run." };
  };
  return { dispatch, calls };
}

const act = (
  exec: ReturnType<typeof fakeGit>["exec"],
  auth: OperatorAuthority = authority(),
  fetchImpl: typeof fetch = fakeGithubFetch({}).fetchImpl,
  dispatchAgent: DispatchAgent = refusedDispatch,
) =>
  operatorUpdateBranchFromBase(
    store.db,
    { dataRoot: store.dataRoot, fetchImpl, deps: { dispatchAgent } },
    { projectSlug: store.slug, taskKey: "VIB-1", exec },
    auth,
  );

describe("operatorUpdateBranchFromBase — the decision half (N19-9)", () => {
  it("F39-69: a carried-out refresh is recorded on the drive, a conflict is not", async () => {
    const drive = () => ({ backend: "codex" as const, autonomy: "supervised" as const, reactDepth: 0 });
    const run = async (git: ReturnType<typeof fakeGit>) => {
      const operatorRun: ReturnType<typeof drive> & { refreshed?: boolean } = drive();
      await operatorUpdateBranchFromBase(
        store.db,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl, operatorRun },
        { projectSlug: store.slug, taskKey: "VIB-1", exec: git.exec },
        authority(),
      );
      return operatorRun.refreshed;
    };
    // CANARY: drop `stampRefreshed` from either `done` arm and its case reads
    // undefined, so the settle cannot tell a drive that stopped halfway.
    expect(await run(fakeGit({ behind: 2 }))).toBe(true);
    expect(await run(fakeGit({ behind: 0 }))).toBe(true);
    // Ruling 134(c)'s arm: the workspace is current and origin lags it.
    expect(await run(fakeGit({ behind: 0, remote: "behind" }))).toBe(true);
    expect(await run(fakeGit({ conflict: true }))).toBeUndefined();
  });

  it("updates the branch and puts it on the TIMELINE, not just in the tool result", async () => {
    const git = fakeGit({ behind: 2 });
    const res = await act(git.exec);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain("up to date with `main`");
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const event = file.parsed.timeline[0]!;
    expect(event.type).toBe("github");
    expect(event.text).toContain("`vib-1`");
    expect(event.text).toContain("2 commits merged in");
    expect(
      listAuditEvents(store.db, { action: "github.branch_update.operator" }),
    ).toHaveLength(1);
  });

  it("a CONFLICT whose deliverer cannot be started opens a BLOCKING decision packet naming the files, and never retries", async () => {
    // Ruling 133(b): the redirect is recommended because the task HAS a
    // deployed, repo-write deliverer. Canary: pass `{kind: "none"}`
    // unconditionally into `conflictOptions`. Ruling 475: the operator handed
    // the conflict to Dev first; this fixture's task has no owner to bill, so
    // no run could start and the packet is the fallback, saying so.
    deployDeliverer(true);
    const git = fakeGit({ conflict: true });
    const res = await act(git.exec);
    // Not `denied`: nothing about the policy refused this (the LV-03 misblame
    // split) — the branch's state ruled it out.
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain("CONFLICTS");
    expect(res.message).toContain("decision packet");
    // Ruling 443: the packet is the step's outcome. CANARY: drop the mark and
    // a Codex plan narrates this step as one that "did not apply".
    expect(res.openedPacket).toBe(true);
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const packet = file.parsed.packet!;
    expect(packet.type).toBe("blocked");
    expect(packet.title).toContain("`vib-1` conflicts with `main`");
    expect(
      packet.observations.find((o) => o.k === "Conflicting files")?.v,
    ).toBe("app/main.ts");
    // The in-product resolution is the RECOMMENDED one: the delivering agent
    // owns the branch, and its workspace now has the base fetched.
    const recommended = packet.options.find((o) => o.rec)!;
    expect(recommended.kind).toBe("redirect");
    expect(recommended.t).toBe("Have Dev resolve the conflict");
    expect(packet.observations.find((o) => o.k === "Delivering agent")?.v).toBe("Dev");
    expect(listAuditEvents(store.db).find((e) => e.action === "github.branch_update.operator")?.details).toMatchObject({ status: "conflict", resolver: "deliverer", route: "packet", handoffRefused: expect.any(String) });
    expect(packet.body).toContain("The operator sent it to Dev, but no run started:");
    expect(packet.body).toContain("A person decides how it is resolved.");
    // Every option is a human decision — none of them force the branch.
    expect(packet.options.map((o) => o.kind).sort()).toEqual([
      "archive_task",
      "custom",
      "redirect",
    ]);
    // Each option writes its OWN decision line: the shared default for these
    // kinds is "Operator re-engages the specialist with a summon note", which
    // would file "I'll resolve the branch myself" under a summon.
    for (const option of packet.options) {
      expect(option.ev, option.t).toBeTruthy();
      expect(option.ev).not.toMatch(/summon note/);
    }
    expect(file.parsed.frontmatter.readiness).toBe("blocked");
    expect(file.parsed.frontmatter.waiting).toBe("human");
    // The branch itself was left alone.
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("ruling 443: a conflict whose packet could not open carries no packet mark", async () => {
    // An operator that may not open packets: the conflict has no decision to
    // point at, so it stays a state refusal the plan narrates.
    const noPackets = authority({
      policy: new Map([
        ["generate-packets", "off"],
        ["append-typed-events", "direct"],
      ]),
    });
    const res = await act(fakeGit({ conflict: true }).exec, noPackets);
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain("could NOT be opened");
    expect(res.openedPacket).toBeUndefined();
  });

  it("ruling 133(b): with NO delivering agent the packet offers only what can execute and says why", async () => {
    // Canary: always build the three options.
    const git = fakeGit({ conflict: true });
    await act(git.exec);
    const packet = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.packet!;
    expect(packet.options.map((o) => [o.kind, o.rec])).toEqual([
      ["custom", true],
      ["archive_task", false],
    ]);
    expect(packet.options[0]!.t).toBe("Resolve `vib-1` yourself");
    expect(packet.body).toContain("No delivering agent can resolve it in product: this task has no delivering agent. Resolving by hand is the recommended option.");
    expect(packet.observations.find((o) => o.k === "Delivering agent")?.v).toBe("none");
    expect(listAuditEvents(store.db).find((e) => e.action === "github.branch_update.operator")?.details).toMatchObject({ status: "conflict", resolver: "none" });
  });

  it("ruling 133(b): a deliverer whose repo-write grant was withdrawn is not offered as the resolver", async () => {
    // Canary: treat any deployed deliverer as a resolver.
    deployDeliverer(false);
    const git = fakeGit({ conflict: true });
    await act(git.exec);
    const packet = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.packet!;
    expect(packet.options.find((o) => o.rec)!.kind).toBe("custom");
    expect(packet.options.some((o) => o.kind === "redirect")).toBe(false);
    expect(packet.body).toContain("its delivering agent (Dev) holds no repo-write grant any more");
  });

  it("ruling 133(b): a PUSH conflict takes the same rule, with its own wording", async () => {
    // Canary: route push_conflict through the merge wording (the deliverer
    // case's option detail speaks of merging the base).
    deployDeliverer(true);
    const withDev = fakeGit({ pushRefused: true });
    const res = await act(withDev.exec);
    expect(res.outcome).toBe("noop");
    const packet = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.packet!;
    expect(packet.title).toBe("`vib-1` diverged from its remote");
    const rec = packet.options.find((o) => o.rec)!;
    expect(rec.kind).toBe("redirect");
    expect(rec.t).toBe("Have Dev reconcile the branch with origin");
    expect(rec.d).not.toContain("merges and resolves the conflicting files");
    expect(rec.d).toContain("nothing is forced");
    expect(listAuditEvents(store.db).find((e) => e.action === "github.branch_update.operator")?.details).toMatchObject({ status: "push_conflict", resolver: "deliverer" });
  });

  it("ruling 133(b): a PUSH conflict with no delivering agent recommends resolving by hand, with the push wording", async () => {
    const noDev = fakeGit({ pushRefused: true });
    await act(noDev.exec);
    const packet = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.packet!;
    expect(packet.title).toBe("`vib-1` diverged from its remote");
    expect(packet.options.map((o) => [o.kind, o.rec])).toEqual([["custom", true], ["archive_task", false]]);
    expect(packet.options[0]!.d).toContain("Reconcile the branch with origin's copy by hand");
    expect(packet.body).toContain("this task has no delivering agent");
  });

  it("ruling 159(b): refuses a branch carrying the store layout, names the paths and pushes nothing", async () => {
    const stray = `projects/${store.slug}/tasks/VIB-1/attachments/knc-9.txt`;
    const git = fakeGit({ behind: 2, storeLayoutFiles: [stray] });
    const res = await act(git.exec);
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain(stray);
    expect(res.message).toContain("store layout");
    expect(res.message).toContain("Remove those paths");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
    expect(git.calls.some((c) => c.includes("merge") && !c.includes("merge-base"))).toBe(false);
  });

  it("ruling 428: a branch that changes a leased path is not refreshed, and the operator is told to wait for the holder", async () => {
    // CANARY: drop the `lease_held` arm from `outcomeSentence` and the message
    // falls to the generic "The branch was not updated" with no next step.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "review", branch: "vib-2" }),
    });
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      fileLeases: [{ paths: ["internal/controller/task.go"], taskKey: "VIB-2", reason: "lands first" }],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const git = fakeGit({ behind: 2, branchFiles: ["internal/controller/task.go"] });
    const res = await act(git.exec);
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain("was NOT updated, and nothing was merged or pushed");
    expect(res.message).toContain("which VIB-2 holds (lands first)");
    expect(res.message).toContain("Do not retry the refresh until VIB-2 has merged.");
    expect(git.calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("ruling 229: an already-current branch is never narrated as a refused plan step", async () => {
    // The end-to-end consequence, pinned where it is decidable: the plan
    // executor files a step under "refused" purely on `outcome`, and
    // `narrateRefusedActions` headlines any refused step "The operator's plan
    // was not carried out in full." The sentence is ALSO already on the
    // timeline as the `github` event ruling 134(c) writes — and 134(c) goes to
    // the trouble of suppressing that event when it would duplicate, which the
    // refusal narration then undid with no suppression and a worse headline.
    //
    // Canary: return `noop` from either already-current arm.
    const git = fakeGit({ behind: 0 });
    const res = await act(git.exec);
    expect(["denied", "noop"]).not.toContain(res.outcome);
  });

  it("says so honestly when the branch is already current — and calls it DONE", async () => {
    // Ruling 229 (F37-49): `done`, not `noop`. This is the tool's success
    // condition, and its own description tells the operator to call it
    // speculatively for exactly this reason ("idempotent and cheap… call it
    // when you are unsure rather than guessing"). Returned as `noop` it landed
    // in the plan executor's `refused` list, and the timeline then carried
    // "The operator's plan was not carried out in full" over a call the
    // product had asked for — 51 of 57 such notes on the pass-37 board.
    const git = fakeGit({ behind: 0 });
    const res = await act(git.exec);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain("already up to date");
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    // A no-op writes no timeline noise and opens no packet.
    expect(file.parsed.packet).toBeNull();
  });
});

describe("updateBranchGate — the capability", () => {
  it("an EXPLICIT `off` refuses, and no git runs", async () => {
    const auth = authority();
    auth.policy.set("update-task-branch", "off");
    expect(updateBranchGate(auth)).toBe("deny");
    const git = fakeGit();
    const res = await act(git.exec, auth);
    expect(res.outcome).toBe("denied");
    expect(git.exec).not.toHaveBeenCalled();
  });

  it("an ABSENT grant follows the DELIVERY gate — a project trusted to push is trusted to keep the branch current", async () => {
    const auth = authority();
    expect(auth.policy.has("update-task-branch")).toBe(false);
    expect(updateBranchGate(auth)).toBe("direct");
    // …and withholding DELIVERY withholds this too: it is the smaller act on
    // the same branch, never a way around a withheld delivery grant.
    auth.policy.set("deliver-review-pr", "off");
    expect(updateBranchGate(auth)).toBe("deny");
  });

  it("`recommend` refuses to perform and points at the packet surface (no silent promotion)", async () => {
    const auth = authority();
    auth.policy.set("update-task-branch", "recommend");
    const git = fakeGit();
    const res = await act(git.exec, auth);
    expect(res.outcome).toBe("denied");
    expect(res.message).toContain("open a decision packet");
    expect(git.exec).not.toHaveBeenCalled();
  });

  it("denies when no operator is deployed at all (A4)", () => {
    expect(
      updateBranchGate(authority({ deployed: false, policy: new Map() })),
    ).toBe("deny");
  });
});

/**
 * The persona is read on every operator turn; a tool the model is never told
 * about is a capability that exists only in the code. Both shipped copies must
 * carry it — the seed asset the app ships, and the live store definition.
 */
describe("the operator persona teaches the branch update", () => {
  const REPO_ROOT = path.join(import.meta.dirname, "../../..");
  const seed = readFileSync(
    path.join(REPO_ROOT, "app/server/seed/assets/operator.definition.md"),
    "utf8",
  );
  // Ruling 460 moved the live store into the named volume `viberr-data`; the
  // host's `./docker-data` is at most the pre-move fallback copy, so it is no
  // longer compared here. The store copy is upgraded at boot from this asset
  // by its shipped hash (`PRIOR_SHIPPED_HASHES`, default-assets.server.ts).

  it("names the tool and when to use it", () => {
    expect(seed).toContain("`update_branch_from_base`");
    expect(seed).toMatch(/before you deliver/i);
    expect(seed).toMatch(/never ask an agent to rebase or force-push, never ask it to bring the branch up to date/i);
  });

  it("ruling 438: names the one merge an agent makes, the conflict a person routed to it", () => {
    /**
     * Live on AX-28 at 02:45: I answered the branch-conflict packet by sending
     * the conflict to the Developer, which is what the packet's own recommended
     * redirect does ("it merges and resolves the conflicting files"). The
     * operator refused, "the operator rules prohibit agent-side merges", and
     * opened "AX-28 base conflict has no supported resolution path". The
     * doctrine forbade every agent merge; on AX-21 at 01:40 the same answer
     * had been relayed.
     *
     * CANARY: restore "never ask an agent to rebase, merge, or force-push".
     */
    expect(seed).not.toMatch(/never ask an agent to rebase, merge/i);
    expect(seed).toMatch(/that is the one merge an agent makes \(ruling 438\)/);
    expect(seed).toMatch(/direct it to merge `origin\/<base>` into the task branch in its own workspace/);
  });

  it("ruling 134(c): says the tool reports origin's copy and that the push is `deliver_for_review`'s job", () => {
    // Canary: revert the seed sentence.
    expect(seed).toMatch(/It also reports whether origin carries the workspace head/);
    expect(seed).toMatch(/When it says the remote copy is behind, call `deliver_for_review` to push it; do not ask a person to push\./);
  });

  it("ruling 475: a conflict goes to the delivering agent, a person only when no agent can take it, and nothing is retried or forced", () => {
    // CANARY: restore "A CONFLICT is not yours to settle ... a blocking packet
    // goes to a human" and the handoff sentences are gone.
    expect(seed).not.toMatch(/A CONFLICT is not yours to settle/i);
    expect(seed).toMatch(/A CONFLICT is the delivering agent's to resolve, never yours to force \(ruling 475\)/);
    expect(seed).toMatch(/the tool hands the conflict to it itself/);
    expect(seed).toMatch(/Only when no agent can take it \(no deliverer, no repo-write grant, or the deliverer already failed this same conflict once\) does a blocking packet go to a human/);
    expect(seed).toMatch(/Never open a packet of your own for a conflict/);
    expect(seed).toMatch(/never propose forcing the branch/i);
  });

  /**
   * Ruling 232: the persona used to close with "The mention is what notifies
   * them" and no qualification, which the ruling made FALSE for the one comment
   * the operator writes most — the directive it hands a specialist. An operator
   * that believes a tag in a directive reaches a person will keep putting
   * questions there, and they will now reach nobody. The owner's own words for
   * this decision were that the operator "already has a separate human-directed
   * comment path and should use it"; this is the sentence that tells it so.
   *
   * Canary: delete the directive sentence from the seed asset.
   */
  it("ruling 232: says a directive reaches only the specialist, so a person named in one is not notified", () => {
    expect(seed).toMatch(/A directive you hand a specialist reaches only that specialist/);
    expect(seed).toMatch(/naming a person inside one notifies nobody/);
    // The instruction that remains true is still there, now scoped to a comment.
    expect(seed).toMatch(/tag them by name with an @mention \(e\.g\. "@Arda"\) in a comment/);
  });

  /**
   * F37-56: agents were given the human's NAME and told to answer them, and
   * never told what to call them - so they guessed, and the record disagreed
   * with itself. Counted across this pass's project: 7 "him", 5 "he", 2 "his"
   * and 1 "her", all the same owner. `task.md` is what viberr calls truth, it
   * is permanent, and the person it describes reads it.
   *
   * Canary: delete the pronoun sentence from the seed asset.
   */
  it("F37-56: tells the operator to say 'they' rather than guess a pronoun", () => {
    expect(seed).toMatch(/Refer to a person as "they" unless they have told you otherwise/);
    expect(seed).toMatch(/you are given names, not pronouns/);
  });
});

/**
 * Ruling 134(c): `update_branch_from_base` reports origin's copy of the task
 * branch and points at `deliver_for_review` when origin lags; the record is as
 * idempotent as the tool (one timeline line across two identical calls, an
 * audit row per call). Canary: revert the `already_current` arm (no remote
 * sentence); append the line unconditionally.
 */
describe("ruling 134(c): the remote report", () => {
  const REPO_PATH = "/repos/akin-ozer/viberr";
  it("names a lagging origin, points at deliver_for_review, and writes ONE timeline line across two calls", async () => {
    const first = await act(fakeGit({ behind: 0, remote: "behind", ahead: 2 }).exec);
    // Ruling 229: `done` — see the already-current test above.
    expect(first.outcome).toBe("done");
    expect(first.message).toContain("already up to date with `main`");
    expect(first.message).toContain("Origin's copy of `vib-1` (`remote0`) is 2 commits behind the workspace head");
    expect(first.message).toContain("call `deliver_for_review` to push it");
    expect(first.message).not.toMatch(/nothing to do/i);
    const second = await act(fakeGit({ behind: 0, remote: "behind", ahead: 2 }).exec);
    expect(second.message).toBe(first.message);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    // Ruling 475 (F40-60): the timeline carries the PERSON's sentence, once.
    const lines = file.parsed.timeline.filter((e) => e.type === "github");
    expect(lines).toHaveLength(1);
    expect(file.parsed.packet).toBeNull();
    const audit = listAuditEvents(store.db, { action: "github.branch_update.operator" });
    expect(audit).toHaveLength(2);
    expect(audit[0]!.details).toMatchObject({ status: "already_current", remote: "behind", remoteHeadSha: REMOTE_SHA });
  });

  /**
   * Ruling 475 (F40-60): live on WEB-1, WEB-2 and WEB-4 every delivery was
   * preceded on the owner's timeline by "call `deliver_for_review` to push it.
   * Do not ask a person to push." (an instruction to the operator), and the
   * diverged variant told the person who has to act "That is a person's act,
   * not yours". The tool result keeps the model's sentence; the timeline gets
   * one written for a person.
   *
   * CANARY: append `outcomeSentence(result)` to the timeline again.
   */
  it("ruling 475 (F40-60): the timeline line is written for a person, and the tool result stays the operator's", async () => {
    const line = () =>
      readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
        .parsed.timeline.find((e) => e.type === "github")!;
    const behind = await act(fakeGit({ behind: 0, remote: "behind", ahead: 7 }).exec);
    expect(behind.message).toContain("call `deliver_for_review` to push it. Do not ask a person to push.");
    expect(line().text).toBe(
      "`vib-1` is level with `main`. GitHub's copy of the branch (`remote0`) is 7 commits behind the workspace; the operator's next delivery pushes them.",
    );
    expect(line().text).not.toMatch(/deliver_for_review|Do not ask a person/);
    await act(fakeGit({ behind: 0, remote: "diverged" }).exec);
    expect(line().text).toBe(
      `\`vib-1\` is level with \`main\`. GitHub's copy of the branch (\`remote0\`) holds commits the workspace does not, so the branch cannot be pushed as it stands. ${DIVERGED_BRANCH_REMEDY}`,
    );
    expect(line().text).not.toMatch(/not yours|person's act/);
    await act(fakeGit({ behind: 0, remote: "absent" }).exec);
    expect(line().text).toBe(
      "`vib-1` is level with `main`. The branch is not on GitHub yet; the operator's next delivery pushes it.",
    );
  });

  it("a current origin stays a quiet no-op; diverged and absent say who acts", async () => {
    const current = await act(fakeGit({ behind: 0 }).exec);
    expect(current.message).toContain("Origin carries the workspace head");
    expect(readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline).toHaveLength(0);
    const diverged = await act(fakeGit({ behind: 0, remote: "diverged" }).exec);
    expect(diverged.message).toContain("holds commits this workspace does not");
    // Ruling 321: one sentence for a diverged branch, wherever it is said.
    expect(diverged.message).toContain(DIVERGED_BRANCH_REMEDY);
    expect(diverged.message).toContain("never a force-push");
    expect(diverged.message).not.toContain("deliver_for_review");
    const absent = await act(fakeGit({ behind: 0, remote: "absent" }).exec);
    expect(absent.message).toContain("does not exist on origin yet: call `deliver_for_review`");
  });

  /**
   * Ruling 132: a successful update records the refresh row, reconciles so
   * drift is re-measured NOW, and says so from the re-read. Canaries: remove
   * the `reconcileTask` call (no drift is measured); remove the `baseRefreshes`
   * push (the row is missing).
   */
  it("ruling 132: a successful update records the row, re-measures drift and says so", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        branch: "vib-1",
        workRevision: { id: "rev_1", headSha: PRE_SHA, treeSha: null, branch: "vib-1", createdAt: "2026-09-04T00:00:00.000Z", sourceProfileId: "developer" },
        pr: { number: 5, state: "review", title: "[VIB-1] t" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/compare/main...vib-1`]: { body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] } },
      [`GET ${REPO_PATH}/pulls`]: { body: [{ number: 5, title: "[VIB-1] t", state: "open", draft: false, merged_at: null, head: { sha: MERGE_SHA } }] },
      [`GET ${REPO_PATH}/pulls/5`]: { body: { number: 5, title: "[VIB-1] t", state: "open", merged: false, merged_at: null, head: { sha: MERGE_SHA }, additions: 1, deletions: 0, changed_files: 1 } },
      [`GET ${REPO_PATH}/commits/${MERGE_SHA}/check-runs`]: { body: { total_count: 0, check_runs: [] } },
      [`GET ${REPO_PATH}/compare/${PRE_SHA}...${MERGE_SHA}`]: { body: { ahead_by: 3, behind_by: 0, status: "ahead", commits: [] } },
    });
    const res = await act(fakeGit({ behind: 2 }).exec, authority(), gh.fetchImpl);
    expect(res.outcome).toBe("done");
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
    // Ruling 439: and the head it merged onto, which is what lets the reviewed
    // revision be followed through the refresh. Canary: drop `onto` from the
    // push in recordBranchRefresh.
    expect(fm.frontmatter.baseRefreshes).toEqual([
      { mergeSha: MERGE_SHA, baseSha: BASE_SHA, base: "main", commits: 2, at: expect.any(String), onto: PRE_SHA },
    ]);
    // The push published the revision the merge was made onto. Canary: drop
    // the stamp in recordBranchRefresh.
    expect(fm.frontmatter.workRevision?.pushedAt).toEqual(expect.any(String));
    expect(fm.frontmatter.pr?.revisionDrift).toBeTruthy();
    const sentence = describeRevisionDrift(fm.frontmatter.pr?.revisionDrift).sentence;
    expect(sentence).not.toBe("");
    expect(res.message).toContain(`Drift re-measured: ${sentence}.`);
    expect(res.message).toContain("merge commit `merge00`");
    const event = fm.timeline.find((e) => e.type === "github" && e.text.includes("Brought `vib-1` up to date"))!;
    expect(event.text).toBe(res.message);
    expect(listAuditEvents(store.db, { action: "github.branch_update.operator" })[0]!.details).toMatchObject({ mergeSha: MERGE_SHA, remote: "current" });
  });

  /**
   * F39-64: GitHub shows a pushed head on the PR some seconds after the push.
   * Live on ax-clone AX-29 the acceptance ceremony's reconcile read the PR at
   * the reviewed head, measured no drift, and the timeline said "The review
   * PR's head now equals the reviewed revision" one line after the merge commit
   * it had pushed; the completion record then left the refresh out.
   */
  describe("F39-64: the reconcile reads the PR before GitHub shows the pushed head", () => {
    function lagging(reviewedHead: string) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          branch: "vib-1",
          workRevision: { id: "rev_1", headSha: reviewedHead, treeSha: null, branch: "vib-1", createdAt: "2026-09-04T00:00:00.000Z", sourceProfileId: "developer" },
          pr: { number: 5, state: "review", title: "[VIB-1] t", headSha: PRE_SHA },
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      // GitHub still answers the pre-push head.
      return fakeGithubFetch({
        [`GET ${REPO_PATH}/compare/main...vib-1`]: { body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] } },
        [`GET ${REPO_PATH}/pulls`]: { body: [{ number: 5, title: "[VIB-1] t", state: "open", draft: false, merged_at: null, head: { sha: PRE_SHA } }] },
        [`GET ${REPO_PATH}/pulls/5`]: { body: { number: 5, title: "[VIB-1] t", state: "open", merged: false, merged_at: null, head: { sha: PRE_SHA }, additions: 1, deletions: 0, changed_files: 1 } },
        [`GET ${REPO_PATH}/commits/${PRE_SHA}/check-runs`]: { body: { total_count: 0, check_runs: [] } },
      });
    }

    it("reads the drift from the refresh record, never claims the heads are equal", async () => {
      // CANARY: drop the `lagging` arm and the sentence is the AX-29 one.
      const gh = lagging(PRE_SHA);
      const res = await act(fakeGit({ behind: 2 }).exec, authority(), gh.fetchImpl);
      expect(res.outcome).toBe("done");
      expect(res.message).not.toContain("now equals the reviewed revision");
      expect(res.message).toContain(
        "Drift, from Viberr's own refresh record (GitHub had not shown the new head on the pull request): base refreshed · 1 merge commit · 2 base commits · 0 authored commits since review.",
      );
      const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
      // What the completion record and the accept dialog read.
      expect(fm.pr?.revisionDrift).toEqual({ headSha: MERGE_SHA, authored: 0, baseRefresh: { merges: 1, commits: 2 } });
    });

    it("says it did not re-measure when the record cannot reach the pushed head", async () => {
      // The refresh was made onto a head that is not the reviewed revision's.
      const gh = lagging("f".repeat(40));
      const res = await act(fakeGit({ behind: 2 }).exec, authority(), gh.fetchImpl);
      expect(res.message).not.toContain("now equals the reviewed revision");
      expect(res.message).toContain(
        "GitHub has not shown the new head on the pull request yet, so the drift was not re-measured; the next GitHub pass will.",
      );
    });
  });

  it("ruling 132: when the reconcile cannot run, the row still lands and the message says the drift was not re-measured", async () => {
    // Canary: swallow the reconcile result silently (no "could not be re-measured").
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/compare/main...vib-1`]: { status: 500, body: { message: "boom" } },
    });
    const res = await act(fakeGit({ behind: 1 }).exec, authority(), gh.fetchImpl);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain("could not be re-measured now");
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.baseRefreshes).toHaveLength(1);
    expect(fm.baseRefreshes[0]).toMatchObject({ mergeSha: MERGE_SHA, baseSha: BASE_SHA, commits: 1 });
  });
});

/**
 * Pass 35 S15: ruling 162 / G35-5 (d) (the operator stops refreshing at the
 * acceptance boundary) and ruling 163 (the conflict packet's redirect returns
 * a task past the review stage to it).
 */
describe("pass 35 S15: the acceptance-boundary refusal and the redirect's rework marker", () => {
  function seedAt(stage: string, patch: Partial<Parameters<typeof baseTaskFrontmatter>[1]> = {}): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage, branch: "vib-1", ...patch }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  function withMergeBoard(): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      stages: [
        { id: "triage", name: "Triage", color: "slate" },
        { id: "impl", name: "In Progress", color: "violet" },
        { id: "review", name: "Review", color: "blue" },
        { id: "merge", name: "Merge", color: "teal" },
        { id: "done", name: "Done", color: "green" },
      ],
      workflow: [
        { from: "triage", to: "impl", boundary: "auto", by: "Operator", locked: false },
        { from: "impl", to: "review", boundary: "approval", by: "Operator", locked: false },
        { from: "review", to: "merge", boundary: "approval", by: "Operator", locked: false },
        { from: "merge", to: "done", boundary: "human", by: "Human", locked: true },
      ],
      agents: [
        ...file.parsed.frontmatter.agents,
        {
          profileId: "reviewer",
          capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
          extras: [],
          definition: { kind: "specialist", name: "Rev", role: "Code review", backends: ["claude"], model: "sonnet", stages: ["review"] },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("G35-5 (d): at the acceptance boundary the tool refuses with the sentence naming acceptance-time refresh, and runs no git", async () => {
    // Canary: drop the `acceptanceBoundaryRefusal` read.
    seedAt("review", { pr: { number: 7, state: "review", title: "[VIB-1] t", mergeable: "clean" } });
    const git = fakeGit({ behind: 2 });
    const res = await act(git.exec);
    // F39-10: `noop`, not `denied`. What rules the step out is the task's
    // STAGE; the operator's `update-task-branch` grant is untouched, and
    // `narrateRefusedActions` files a `denied` under "refused by its capability
    // policy" as a `policy` event — blaming a grant that is not the cause.
    expect(res.outcome).toBe("noop");
    expect(res.message).toBe(
      "VIB-1 is at Review, the acceptance boundary: the branch is brought up to date once, at acceptance time, and merged in the same ceremony. Do not refresh it here; recommend or accept the completion instead.",
    );
    expect(git.calls).toHaveLength(0);
    expect(listAuditEvents(store.db).find((e) => e.action === "github.branch_update.operator")).toBeUndefined();
    // Ruling 424: the operator reads this refusal before it plans. The snapshot
    // and the tool share one function, so they say the same thing.
    const snap = operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority());
    expect(snap.notRefreshableReason).toBe(res.message);
  });

  it("ruling 429: while the work is still in its review loop the refresh runs at the acceptance stage", async () => {
    // Live on AX-20: validation `changed` at Review, and the deliverer needed
    // AX-19's merged work to build its integration test. CANARY: drop the
    // `failing`/`changed` arm from `acceptanceBoundaryRefusal`.
    seedAt("review", {
      validation: "failing",
      pr: { number: 7, state: "review", title: "[VIB-1] t", mergeable: "clean" },
    });
    const git = fakeGit({ behind: 2 });
    const res = await act(git.exec);
    expect(res.message).not.toContain("the acceptance boundary");
    expect(git.calls.some((c) => c.includes("merge") && !c.includes("merge-base"))).toBe(true);
  });

  it("G35-5 (d): a PR GitHub already reports conflicting is the exception: the tool records the conflict and opens the packet", async () => {
    deployDeliverer(true);
    seedAt("review", {
      engagements: [{ profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false }],
      pr: { number: 7, state: "review", title: "[VIB-1] t", mergeable: "conflicting" },
    });
    const git = fakeGit({ conflict: true });
    const res = await act(git.exec);
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain("CONFLICTS");
    const packet = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.packet!;
    expect(packet.title).toContain("conflicts with");
  });

  it("ruling 163 (b): past the review stage the redirect option carries the rework marker and says the task returns to Review", async () => {
    // Canary: pass `null` for `returnsToReview` unconditionally.
    deployDeliverer(true);
    withMergeBoard();
    seedAt("merge", {
      engagements: [
        { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
        { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
      ],
      pr: { number: 7, state: "review", title: "[VIB-1] t", mergeable: "conflicting" },
    });
    const res = await act(fakeGit({ conflict: true }).exec);
    expect(res.outcome).toBe("noop");
    const packet = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.packet!;
    const redirect = packet.options.find((o) => o.kind === "redirect")!;
    expect(redirect.rework).toBe(true);
    expect(redirect.d).toContain("The task returns to Review for the re-verdict.");
  });

  it("ruling 163 (b): at the work stage there is nothing to return to: no marker, no sentence", async () => {
    // A separate store: the write cache (write-cache.server) keeps the packet
    // write above ahead of a raw fixture rewrite of the same path.
    deployDeliverer(true);
    withMergeBoard();
    seedAt("impl", {
      engagements: [{ profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false }],
    });
    await act(fakeGit({ conflict: true }).exec);
    const atWork = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.packet!;
    const workRedirect = atWork.options.find((o) => o.kind === "redirect")!;
    expect(workRedirect.rework).toBeUndefined();
    expect(workRedirect.d).not.toContain("returns to Review");
  });
});

/**
 * Ruling 475 (F40-20, owner decision 2026-09-25): live on akinozer-com WEB-2's
 * accept was refused over a `package.json` conflict with WEB-4's merge; the
 * operator ran this door, wrote the exact fix in a comment, and then opened
 * "A person decides how this is resolved." The owner's whole part was to
 * confirm the packet's own recommendation, "Have Platform Engineer resolve the
 * conflict". The operator now routes it: the deployed, repo-write deliverer
 * gets it, and the packet is the fallback when no agent can.
 */
describe("ruling 475 (F40-20): the operator hands a conflict to the delivering agent", () => {
  const DEV_DELIVERS = {
    profileId: "dev",
    backend: "claude" as const,
    role: "developer",
    delivers: true,
    verdictCapable: false,
  };
  const file = () =>
    readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed;
  const lastUpdateAudit = () =>
    listAuditEvents(store.db, { action: "github.branch_update.operator" })[0]!.details;

  /** Dev as the deployed, repo-write deliverer of VIB-1, at `stage`. */
  function seedDeliverer(
    stage = "impl",
    patch: Partial<Parameters<typeof baseTaskFrontmatter>[1]> = {},
  ): void {
    deployDeliverer(true);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage,
        branch: "vib-1",
        engagements: [DEV_DELIVERS],
        ...patch,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  /** Dev's run on VIB-1, in `state`. */
  function devRun(state: "running" | "interrupted"): void {
    upsertRun(store.db, {
      id: "run_dev_resolving",
      taskKey: "VIB-1",
      projectSlug: store.slug,
      threadId: "t-dev",
      role: "developer",
      kind: "primary",
      backend: "claude",
      agentProfileId: "dev",
      model: "sonnet",
      sdk: "Claude Agent SDK",
      state,
    });
  }

  it("sends the conflict to the deliverer with ruling 438's directive, writes a person-facing line, and opens no packet", async () => {
    // CANARY: send every conflict to the packet (skip the handoff arm in
    // `routeConflict`) and this reads a packet and no dispatch.
    seedDeliverer();
    const started = startingDispatch();
    const res = await act(fakeGit({ conflict: true }).exec, authority(), undefined, started.dispatch);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain("`vib-1` CONFLICTS with `main` in app/main.ts.");
    expect(res.message).toContain("Ruling 475: handed it to Dev, the delivering agent. Prompted @Dev (the delivering agent) and started its run.");
    expect(res.message).toContain("When it reports the merge committed, deliver the result with `deliver_for_review`");
    expect(res.openedPacket).toBeUndefined();
    expect(started.calls).toHaveLength(1);
    expect(started.calls[0]).toMatchObject({ projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" });
    expect(started.calls[0]!.prompt).toBe(
      "`vib-1` conflicts with `main` in `app/main.ts`. Viberr's merge was aborted, so the branch is exactly as you left it. " +
        "`origin/main` is already fetched into your workspace: merge it into `vib-1` (a merge, never a rebase), resolve " +
        "`app/main.ts` keeping the intent of both sides, run the project's gates, and commit the merge. Do not push, and " +
        "do not open or touch a pull request: the operator delivers the result, and the reviewers judge the resolved " +
        "branch before anyone accepts it.",
    );
    const parsed = file();
    expect(parsed.packet).toBeNull();
    const line = parsed.timeline[0]!;
    expect(line.actor.kind).toBe("operator");
    expect(line.type).toBe("github");
    expect(line.toAgent).toBe(false);
    expect(line.text).toBe(
      "The operator sent the `app/main.ts` conflict between `vib-1` and `main` to Dev, which merges `main` into " +
        "the branch in its own workspace and resolves it. The reviewers judge the resolved branch before anyone accepts it.",
    );
    expect(lastUpdateAudit()).toMatchObject({
      status: "conflict",
      resolver: "deliverer",
      route: "deliverer",
      handedTo: "dev",
      baseSha: BASE_SHA,
      files: ["app/main.ts"],
    });
  });

  it("a task past review returns to the review stage in the handoff's own write, and the acceptance card it no longer earns is withdrawn", async () => {
    // CANARY: pass `returnsToReview: null` into `recordHandoff` and the task
    // stays at Merge, still offering the acceptance.
    seedDeliverer("review", {
      recommendations: [
        { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-1 to Done", detail: "" },
      ],
    });
    // A Merge stage between Review and Done, with a Review-scoped reviewer, so
    // the verdict stage is Review.
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      stages: [
        { id: "triage", name: "Triage", color: "slate" },
        { id: "impl", name: "In Progress", color: "violet" },
        { id: "review", name: "Review", color: "blue" },
        { id: "merge", name: "Merge", color: "teal" },
        { id: "done", name: "Done", color: "green" },
      ],
      workflow: [
        { from: "triage", to: "impl", boundary: "auto", by: "Operator", locked: false },
        { from: "impl", to: "review", boundary: "approval", by: "Operator", locked: false },
        { from: "review", to: "merge", boundary: "approval", by: "Operator", locked: false },
        { from: "merge", to: "done", boundary: "human", by: "Human", locked: true },
      ],
      agents: [
        ...project.parsed.frontmatter.agents,
        {
          profileId: "reviewer",
          capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
          extras: [],
          definition: { kind: "specialist", name: "Rev", role: "Code review", backends: ["claude"], model: "sonnet", stages: ["review"] },
        },
      ],
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "merge",
        branch: "vib-1",
        engagements: [
          DEV_DELIVERS,
          { profileId: "reviewer", backend: "claude", role: "Code review", delivers: false, verdictCapable: true },
        ],
        pr: { number: 7, state: "review", title: "[VIB-1] t", mergeable: "conflicting" },
        recommendations: [
          { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-1 to Done", detail: "" },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const started = startingDispatch();
    const res = await act(fakeGit({ conflict: true }).exec, authority(), undefined, started.dispatch);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain("VIB-1 returned from Merge to Review for the re-verdict.");
    const parsed = file();
    expect(parsed.frontmatter.stage).toBe("review");
    expect(parsed.frontmatter.previousStageId).toBe("merge");
    expect(parsed.frontmatter.recommendations).toEqual([]);
    const line = parsed.timeline.find((e) => e.text.startsWith("The operator sent"))!;
    expect(line.type).toBe("transition");
    expect(line.text).toContain("VIB-1 returns from Merge to Review, so the reviewers judge the resolved branch before anyone accepts it.");
    expect(listAuditEvents(store.db, { action: "task.transition" })[0]!.details).toMatchObject({
      from: "merge",
      to: "review",
      boundary: "rework",
      via: "conflict_handoff",
    });
  });

  it("the same conflict is never sent twice: nothing new while Dev's run is live, and after it a person decides", async () => {
    // CANARY: drop the `earlierHandoff` read and the second call dispatches
    // again, and so does the third.
    seedDeliverer();
    const started = startingDispatch();
    await act(fakeGit({ conflict: true }).exec, authority(), undefined, started.dispatch);
    devRun("running");
    const second = await act(fakeGit({ conflict: true }).exec, authority(), undefined, started.dispatch);
    expect(second.outcome).toBe("noop");
    expect(second.message).toContain("Dev was sent this same conflict at");
    expect(second.message).toContain("its run is still going");
    expect(started.calls).toHaveLength(1);
    expect(file().packet).toBeNull();
    expect(lastUpdateAudit()).toMatchObject({ route: "in_progress", handedTo: "dev" });

    // Dev's run ended without resolving it: the branch conflicts the same way.
    devRun("interrupted");
    const third = await act(fakeGit({ conflict: true }).exec, authority(), undefined, started.dispatch);
    expect(third.openedPacket).toBe(true);
    expect(started.calls).toHaveLength(1);
    const packet = file().packet!;
    expect(packet.body).toContain("Dev was already sent this same conflict (");
    expect(packet.body).toContain(
      "the branch still conflicts, so a person decides how it is resolved. Resolving by hand is the recommended option.",
    );
    expect(packet.options.map((o) => [o.kind, o.t, o.rec])).toEqual([
      ["custom", "Resolve `vib-1` yourself", true],
      ["redirect", "Have Dev try the conflict again", false],
      ["archive_task", "Archive the task: the work is superseded", false],
    ]);
    expect(lastUpdateAudit()).toMatchObject({ route: "packet", repeat: true });
  });

  it("a conflict against a NEW base commit is a new conflict, and goes to the deliverer again", async () => {
    // CANARY: compare the files alone in `sameConflict` and this reads as the
    // conflict Dev already failed.
    seedDeliverer();
    const started = startingDispatch();
    await act(fakeGit({ conflict: true, baseSha: "1".repeat(40) }).exec, authority(), undefined, started.dispatch);
    devRun("interrupted");
    const next = await act(fakeGit({ conflict: true, baseSha: "2".repeat(40) }).exec, authority(), undefined, started.dispatch);
    expect(next.outcome).toBe("done");
    expect(started.calls).toHaveLength(2);
    expect(file().packet).toBeNull();
  });

  it("a PUSH conflict is handed over the same way, with origin's copy to merge", async () => {
    seedDeliverer();
    const started = startingDispatch();
    const res = await act(fakeGit({ pushRefused: true, remote: "diverged" }).exec, authority(), undefined, started.dispatch);
    expect(res.outcome).toBe("done");
    expect(started.calls[0]!.prompt).toContain("merge it into `vib-1` (a merge, never a rebase and never a force-push)");
    expect(file().timeline[0]!.text).toBe(
      "The operator sent `vib-1` to Dev: GitHub's copy of the branch holds commits the workspace does not, and Dev " +
        "merges them in its own workspace. Nothing is forced. The reviewers judge the resolved branch before anyone accepts it.",
    );
    expect(lastUpdateAudit()).toMatchObject({ status: "push_conflict", route: "deliverer", remoteHeadSha: REMOTE_SHA });
  });

  it("a dispatch that throws is a run that could not start: the packet opens and quotes it", async () => {
    // CANARY: drop the `.catch` on the dispatch and the tool throws, leaving
    // the conflict with neither an agent nor a packet.
    seedDeliverer();
    const throwing: DispatchAgent = async () => {
      throw new Error("the adapter is not configured");
    };
    const res = await act(fakeGit({ conflict: true }).exec, authority(), undefined, throwing);
    expect(res.openedPacket).toBe(true);
    expect(file().packet!.body).toContain("The operator sent it to Dev, but no run started: the adapter is not configured.");
    expect(lastUpdateAudit()).toMatchObject({ route: "packet", handoffRefused: "the adapter is not configured" });
  });

  it("an operator whose policy asks a person before it starts an agent opens the packet, and says why", async () => {
    // CANARY: skip the `dispatchGate` check and the handoff files a run_agent
    // card behind a conflict nobody was told about.
    seedDeliverer();
    const started = startingDispatch();
    const recommendDispatch = authority({
      policy: new Map([
        ["generate-packets", "direct"],
        ["append-typed-events", "direct"],
        ["dispatch-agents", "recommend"],
      ]),
    });
    const res = await act(fakeGit({ conflict: true }).exec, recommendDispatch, undefined, started.dispatch);
    expect(res.openedPacket).toBe(true);
    expect(started.calls).toHaveLength(0);
    const packet = file().packet!;
    expect(packet.body).toContain("The operator's policy asks a person before it starts an agent, so it could not send the conflict to Dev itself.");
    // Dev has not tried: its redirect is still the recommended option.
    expect(packet.options.find((o) => o.rec)).toMatchObject({ kind: "redirect", t: "Have Dev resolve the conflict" });
  });

  it("F40-55 (b): an open packet offering acceptance is withdrawn first, so the conflict never waits behind it", async () => {
    // CANARY: drop `withdrawMootAcceptancePacket` and the fallback packet is
    // refused ("one packet stands at a time") while "Accept" still offers a
    // click the gate refuses.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", branch: "vib-1" }),
      packet: {
        id: "pkt_accept",
        type: "input",
        kind: "Completion report",
        from: "operator",
        title: "Accept VIB-1",
        body: "The PR is mergeable.",
        observations: [],
        options: [{ kind: "accept_completion", t: "Accept and merge", d: "", rec: true }],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const res = await act(fakeGit({ conflict: true }).exec);
    expect(res.openedPacket).toBe(true);
    const parsed = file();
    expect(parsed.packet!.title).toBe("`vib-1` conflicts with `main`");
    const note = parsed.timeline.find((e) => e.text.startsWith("**Packet withdrawn:**"))!;
    expect(note.text).toBe(
      '**Packet withdrawn:** "Accept VIB-1" no longer holds: `vib-1` conflicts with `main`, so the acceptance it offers would be refused.',
    );
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn_superseded" })[0]!.details).toMatchObject({
      reason: "pr_conflicting",
      title: "Accept VIB-1",
    });
  });
});
