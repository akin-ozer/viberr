import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
import type { OperatorAuthority } from "~/server/tasks/operator-actions.server";
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
      return { ok: true, stdout: BASE_SHA, stderr: "" };
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
const act = (
  exec: ReturnType<typeof fakeGit>["exec"],
  auth: OperatorAuthority = authority(),
  fetchImpl: typeof fetch = fakeGithubFetch({}).fetchImpl,
) =>
  operatorUpdateBranchFromBase(
    store.db,
    { dataRoot: store.dataRoot, fetchImpl },
    { projectSlug: store.slug, taskKey: "VIB-1", exec },
    auth,
  );

describe("operatorUpdateBranchFromBase — the decision half (N19-9)", () => {
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

  it("a CONFLICT opens a BLOCKING decision packet naming the files — and never retries", async () => {
    // Ruling 133(b): the redirect is recommended because the task HAS a
    // deployed, repo-write deliverer. Canary: pass `{kind: "none"}`
    // unconditionally into `conflictOptions`.
    deployDeliverer(true);
    const git = fakeGit({ conflict: true });
    const res = await act(git.exec);
    // Not `denied`: nothing about the policy refused this (the LV-03 misblame
    // split) — the branch's state ruled it out.
    expect(res.outcome).toBe("noop");
    expect(res.message).toContain("CONFLICTS");
    expect(res.message).toContain("decision packet");
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
    expect(listAuditEvents(store.db).find((e) => e.action === "github.branch_update.operator")?.details).toMatchObject({ status: "conflict", resolver: "deliverer" });
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
  // The live store is gitignored data, not source — it exists on a developer's
  // machine and not in a fresh clone, so this half is a guarded drift check.
  const livePath = path.join(
    REPO_ROOT,
    "docker-data/agents/definitions/operator.md",
  );
  const live = existsSync(livePath) ? readFileSync(livePath, "utf8") : null;

  it("names the tool and when to use it", () => {
    expect(seed).toContain("`update_branch_from_base`");
    expect(seed).toMatch(/before you deliver/i);
    expect(seed).toMatch(/never ask an agent to rebase, merge, or force-push/i);
  });

  it("ruling 134(c): says the tool reports origin's copy and that the push is `deliver_for_review`'s job", () => {
    // Canary: revert the seed sentence.
    expect(seed).toMatch(/It also reports whether origin carries the workspace head/);
    expect(seed).toMatch(/When it says the remote copy is behind, call `deliver_for_review` to push it; do not ask a person to push\./);
  });

  it("makes a conflict a human decision the operator does not retry", () => {
    expect(seed).toMatch(/A CONFLICT is not yours to settle/i);
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

  it("keeps the live store's copy in step when one is present (both copies or neither)", () => {
    if (live === null) return;
    expect(live).toBe(seed);
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
    const lines = file.parsed.timeline.filter((e) => e.type === "github" && e.text === first.message);
    expect(lines).toHaveLength(1);
    expect(file.parsed.packet).toBeNull();
    const audit = listAuditEvents(store.db, { action: "github.branch_update.operator" });
    expect(audit).toHaveLength(2);
    expect(audit[0]!.details).toMatchObject({ status: "already_current", remote: "behind", remoteHeadSha: REMOTE_SHA });
  });

  it("a current origin stays a quiet no-op; diverged and absent say who acts", async () => {
    const current = await act(fakeGit({ behind: 0 }).exec);
    expect(current.message).toContain("Origin carries the workspace head");
    expect(readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline).toHaveLength(0);
    const diverged = await act(fakeGit({ behind: 0, remote: "diverged" }).exec);
    expect(diverged.message).toContain("holds commits this workspace does not");
    expect(diverged.message).toContain("A person resolves the branch history");
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
    expect(fm.frontmatter.baseRefreshes).toEqual([
      { mergeSha: MERGE_SHA, baseSha: BASE_SHA, base: "main", commits: 2, at: expect.any(String) },
    ]);
    expect(fm.frontmatter.pr?.revisionDrift).toBeTruthy();
    const sentence = describeRevisionDrift(fm.frontmatter.pr?.revisionDrift).sentence;
    expect(sentence).not.toBe("");
    expect(res.message).toContain(`Drift re-measured: ${sentence}.`);
    expect(res.message).toContain("merge commit `merge00`");
    const event = fm.timeline.find((e) => e.type === "github" && e.text.includes("Brought `vib-1` up to date"))!;
    expect(event.text).toBe(res.message);
    expect(listAuditEvents(store.db, { action: "github.branch_update.operator" })[0]!.details).toMatchObject({ mergeSha: MERGE_SHA, remote: "current" });
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
        { id: "triage", name: "Triage", color: "#a5a8b5" },
        { id: "impl", name: "In Progress", color: "#7b61ff" },
        { id: "review", name: "Review", color: "#5b76fe" },
        { id: "merge", name: "Merge", color: "#187574" },
        { id: "done", name: "Done", color: "#00b473" },
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
    expect(res.outcome).toBe("denied");
    expect(res.message).toBe(
      "VIB-1 is at Review, the acceptance boundary: the branch is brought up to date once, at acceptance time, and merged in the same ceremony. Do not refresh it here; recommend or accept the completion instead.",
    );
    expect(git.calls).toHaveLength(0);
    expect(listAuditEvents(store.db).find((e) => e.action === "github.branch_update.operator")).toBeUndefined();
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
