import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  getProjectGithubContext,
  type GithubContextOptions,
} from "./github-context.server";
import { githubFailureMessage } from "./github-client.server";

/**
 * Ruling 266 (pass 37, F37-96): the controller can read what a pull request
 * CHANGED, not just which files it touched.
 *
 * Asked to say whether three open PRs should merge, the controller had
 * `get_task`'s `pr.paths.changed` (a filename list), the commit subjects, and
 * `changed: {files: 4, add: 1528, del: 67}`. Nothing in either of its servers
 * returned a diff, a hunk, or a file at a revision, and it said so: "my
 * judgement on PR #32 rests on a four-line filename list and a reviewer verdict
 * that had not arrived. I can commission a review; I cannot check one." A
 * +1528/-67 rewrite of a process supervisor is a lot of surface for a
 * false-green to hide in, and the person asking got an answer that admitted it
 * could not be checked.
 *
 * Deliberately NARROW (owner's call, 2026-09-15). Specialists hold
 * `read-github-api`, a GET-only passthrough scoped to their task's repo
 * (`agent-github-read.server.ts`), and mounting that on the controller would
 * have been fewer lines. The controller runs with an END USER's permissions
 * across every project they can see, so it gets one named question — "what did
 * this pull request change" — with no caller-supplied path to scope, instead of
 * an API surface to reason about. Read-only, one endpoint, patches only.
 */

/** GitHub caps `pulls/{n}/files` at 3000 files and 100 per page. Past this a
 *  diff is not something a person reads in a conversation anyway, and the
 *  reply says it was cut rather than implying the PR ends here. */
const MAX_PAGES = 6;
const PER_PAGE = 100;

/**
 * Total patch bytes one reply may carry, measured AS THE REPLY CARRIES THEM.
 *
 * Ruling 268 (pass 37, F37-98): the first version of this counted raw patch
 * characters against 120 KB, and the reply is JSON — every newline in a diff
 * becomes `\n` and every quote `\"`, so a hunk roughly doubles on the way out.
 * The controller called this on PR #32 (4 files) and the protection never
 * engaged: `patchesWithheldForSize` stayed false, `patchOmitted` stayed null,
 * and the 83,196-byte reply tripped the Agent SDK's own offload instead — which
 * wrote the result to a file under the run's home and told the model to read it
 * in chunks. The controller has no filesystem tool. So a guard calibrated to
 * the wrong quantity handed a path that could not be opened, carrying
 * instructions addressed to an agent it is not.
 *
 * Two corrections. The budget is spent in ENCODED characters
 * (`JSON.stringify(patch).length`), which is the quantity that actually reaches
 * the ceiling. And the default is set well UNDER the measured trip point —
 * 83,196 bytes offloaded on 2026-09-15 — rather than above it, because the
 * caller cannot recover from the other side's truncation and can always ask for
 * another page.
 */
const MAX_PATCH_BYTES = 40_000;

const prFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  /** Absent on a binary file, and on a file GitHub judged too large to diff. */
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});

const prFilesSchema = z.array(prFileSchema);

export interface PrDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** The unified-diff hunks, or null when GitHub returned none (binary, or a
   *  file too large for it to diff) — distinguished from an EMPTY patch by
   *  `patchOmitted`. */
  patch: string | null;
  /** Why `patch` is null, when it is: the caller asked for a files-only
   *  listing, GitHub sent no diff at all (binary, or too large for it), or this
   *  reply's byte budget ran out before this file. A reader must never mistake
   *  any of the three for "this file changed nothing", and the three call for
   *  different next moves. */
  patchOmitted: "not-requested" | "none-from-github" | "budget" | null;
  renamedFrom?: string;
}

export type PrDiffResult =
  | {
      ok: true;
      number: number;
      repo: string;
      files: PrDiffFile[];
      /** True when GitHub has MORE changed files than this reply listed (the
       *  page cap was reached). Never a silent truncation: a caller reading a
       *  600-file PR has to know the list ends early. */
      moreFiles: boolean;
      /** True when at least one patch was withheld for the byte budget. */
      truncated: boolean;
    }
  | { ok: false; reason: string };

/**
 * Every changed file of one pull request, with its hunks.
 *
 * `path` narrows to a single file (exact match on the new path, or the old one
 * for a rename), which is how a diff too big for one reply is read.
 */
export async function readPullRequestDiff(
  db: DatabaseSync,
  projectSlug: string,
  prNumber: number,
  opts: GithubContextOptions & {
    path?: string;
    maxPatchBytes?: number;
    /** Ruling 268: list the changed files WITHOUT their hunks. A caller that
     *  wants one file's diff needs the file list first, and asking for every
     *  patch to obtain it is the call most likely to be too big — the loop the
     *  controller hit. This makes the first call always safe. */
    patches?: boolean;
  } = {},
): Promise<PrDiffResult> {
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    return { ok: false, reason: "a pull request number is a positive integer" };
  }
  const ctx = getProjectGithubContext(db, projectSlug, opts);
  if (ctx.status === "no_repo_configured") {
    return { ok: false, reason: "no repository is configured for this project" };
  }
  if (ctx.status === "no_pat_configured") {
    return {
      ok: false,
      reason: "no GitHub credential is configured for this project",
    };
  }

  const wanted = opts.path?.trim() ?? "";
  const budget = Math.max(opts.maxPatchBytes ?? MAX_PATCH_BYTES, 1_000);
  const files: PrDiffFile[] = [];
  let spent = 0;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await ctx.client.request(
      "GET",
      `/repos/${ctx.repo}/pulls/${prNumber}/files`,
      prFilesSchema,
      { searchParams: { per_page: PER_PAGE, page } },
    );
    if (!response.ok) return { ok: false, reason: githubFailureMessage(response) };
    const batch = response.data;
    for (const f of batch) {
      if (wanted && f.filename !== wanted && f.previous_filename !== wanted) {
        continue;
      }
      const row: PrDiffFile = {
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: null,
        patchOmitted: null,
      };
      if (f.previous_filename) row.renamedFrom = f.previous_filename;
      const encoded = f.patch === undefined ? 0 : JSON.stringify(f.patch).length;
      if (opts.patches === false) {
        // Files-only: not a truncation, so `truncated` stays false — the caller
        // asked for exactly this and nothing was cut from under it.
        row.patchOmitted = "not-requested";
      } else if (f.patch === undefined) {
        // A binary file, or one GitHub declined to diff. The counts above are
        // still real, so the row stays and says why there are no hunks.
        row.patchOmitted = "none-from-github";
      } else if (spent + encoded > budget) {
        // The file is still LISTED with its counts — dropping the row would
        // read as a PR that does not touch it.
        row.patchOmitted = "budget";
        truncated = true;
      } else {
        row.patch = f.patch;
        spent += encoded;
      }
      files.push(row);
    }
    if (batch.length < PER_PAGE) {
      return {
        ok: true,
        number: prNumber,
        repo: ctx.repo,
        files,
        moreFiles: false,
        truncated,
      };
    }
  }
  // Every page was full through the cap, so GitHub has at least one more.
  return {
    ok: true,
    number: prNumber,
    repo: ctx.repo,
    files,
    moreFiles: true,
    truncated,
  };
}
