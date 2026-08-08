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
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
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
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", branch: "vib-1" }),
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
function fakeGit(opts: { conflict?: boolean; behind?: number } = {}) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--abbrev-ref")) return { ok: true, stdout: "vib-1", stderr: "" };
    if (args.includes("--is-shallow-repository")) return { ok: true, stdout: "false", stderr: "" };
    if (args.includes("--porcelain")) return { ok: true, stdout: "", stderr: "" };
    if (args.includes("--count")) return { ok: true, stdout: String(opts.behind ?? 2), stderr: "" };
    if (args.includes("rev-parse") && args.includes("HEAD")) {
      return { ok: true, stdout: "abc1234", stderr: "" };
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
    return { ok: true, stdout: "", stderr: "" };
  });
  return { exec, calls };
}

const act = (
  exec: ReturnType<typeof fakeGit>["exec"],
  auth: OperatorAuthority = authority(),
) =>
  operatorUpdateBranchFromBase(
    store.db,
    { dataRoot: store.dataRoot },
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

  it("says so honestly when the branch is already current", async () => {
    const git = fakeGit({ behind: 0 });
    const res = await act(git.exec);
    expect(res.outcome).toBe("noop");
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

  it("makes a conflict a human decision the operator does not retry", () => {
    expect(seed).toMatch(/A CONFLICT is not yours to settle/i);
    expect(seed).toMatch(/never propose forcing the branch/i);
  });

  it("keeps the live store's copy in step when one is present (both copies or neither)", () => {
    if (live === null) return;
    expect(live).toBe(seed);
  });
});
