import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { unpushedRevisionOf } from "~/schemas/task-file.schema";
import { reconcileWorkspaceDelivery } from "~/server/github/workspace-delivery.server";
import { rebuildAll } from "./rebuilder.server";
import { getTaskDetail } from "./task-query.server";

/**
 * Ruling 229 / 243 (pass 34, F34-11): the task page's push control renders
 * from `unpushedRevisionOf(task.pr, task.workRevisionSha)` on the REAL detail
 * projection. This drives the record end to end (task file → workspace
 * reconcile → rebuild → detail projection → the panel's own expression), so
 * the button cannot pass on a hand-built fixture while the projection carries
 * nothing. Canary: stop writing `unpushedRevision` in the workspace reconcile.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("the unpushed-revision record reaches the task detail projection", () => {
  it("carries the record from the workspace reconcile to the detail the page renders from", async () => {
    const store = setupTestStore(ctx);
    const HEAD = "9".repeat(40);
    const PR_HEAD = "1".repeat(40);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        branch: "vib-1",
        pr: { number: 9, state: "review", title: "x" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const workdir = ctx.makeTempDir();
    mkdirSync(path.join(workdir, ".git"), { recursive: true });
    await reconcileWorkspaceDelivery({
      db: store.db,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      profileId: "developer",
      workdir,
      dataRoot: store.dataRoot,
      exec: async (file, args) => {
        if (file === "git" && args.includes("--is-shallow-repository")) return { ok: true, stdout: "false\n" };
        if (file === "git" && args.includes("HEAD^{tree}")) return { ok: true, stdout: `${"7".repeat(40)}\n` };
        if (file === "git" && args.includes("rev-parse") && args.includes("HEAD") && !args.includes("--abbrev-ref")) {
          return { ok: true, stdout: `${HEAD}\n` };
        }
        if (file === "git" && args.includes("rev-parse")) return { ok: true, stdout: "vib-1\n" };
        if (file === "git" && args.includes("log")) return { ok: true, stdout: "abc1234 [VIB-1] work\n" };
        if (file === "git" && args.includes("merge-base")) {
          return args[args.indexOf("--is-ancestor") + 1] === PR_HEAD
            ? { ok: true, stdout: "" }
            : { ok: false, stdout: "", stderr: "", code: 1 };
        }
        if (file === "gh") {
          return { ok: true, stdout: JSON.stringify({ number: 9, state: "OPEN", title: "x", headRefOid: PR_HEAD }) };
        }
        return { ok: false, stdout: "", stderr: "unexpected", code: 1 };
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const detail = getTaskDetail(store.db, store.slug, "VIB-1")!;
    expect(detail.workRevisionSha).toBe(HEAD);
    expect(detail.pr).toMatchObject({ number: 9, headSha: PR_HEAD });
    expect(detail.pr?.unpushedRevision).toEqual({ revisionSha: HEAD, prHeadSha: PR_HEAD, relation: "behind" });
    // The panel's own expression, on the projection it renders from.
    expect(unpushedRevisionOf(detail.pr, detail.workRevisionSha ?? null)).toEqual({
      revisionSha: HEAD,
      prHeadSha: PR_HEAD,
      relation: "behind",
    });
  });
});
