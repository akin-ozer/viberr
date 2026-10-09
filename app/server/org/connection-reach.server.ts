import { z } from "zod";
import {
  createGithubClient,
  githubFailureMessage,
  type GithubClientOptions,
} from "~/server/github/github-client.server";
import {
  repoPermissionsSchema,
  repoWritable,
} from "~/server/secrets/pat-validator.server";
import {
  REACH_CAP,
  type ConnectionReach,
  type ReachedRepo,
} from "~/shared/connection-reach";

/**
 * Ruling 222 (pass 40, F40-6): which repositories a connection's token
 * actually reaches.
 *
 * The connection card used to read "PAT ····k3ui · 3 public repos": the
 * ACCOUNT's `public_repos` from `GET /users/{owner}`, which says nothing about
 * the token. The fine-grained token behind it was granted a set of
 * repositories that included a PRIVATE one, and the controller, asked to build
 * a project on it, could not tell whether the token could reach it.
 *
 * `GET /user/repos` answers for the TOKEN: a fine-grained token lists exactly
 * the repositories it was granted, a classic one every repository its user can
 * see through the three affiliations. Each row carries `private` and the
 * `permissions` block GitHub computes for this token, read through
 * `repoWritable`, the one decoder of that block.
 *
 * The read is paged (100 a page) and stops after `REACH_PAGE_LIMIT` pages; a
 * full last page is recorded as `capped`, and every surface says "300+". A
 * failed read is stored as `unknown` with GitHub's reason, never as zero.
 */

const REACH_PAGE_SIZE = 100;
const REACH_PAGE_LIMIT = Math.ceil(REACH_CAP / REACH_PAGE_SIZE);

const REACH_AFFILIATION = "owner,collaborator,organization_member";

const reachedRepoSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  canPush: z.boolean().nullable(),
});

/** What `github_connections.reach_json` holds. */
const storedReachSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("read"),
    readAt: z.string(),
    repos: z.array(reachedRepoSchema),
    capped: z.boolean(),
  }),
  z.object({
    status: z.literal("unknown"),
    readAt: z.string(),
    reason: z.string(),
  }),
]);
export type StoredReach = z.infer<typeof storedReachSchema>;

/** The stored column as written, or null for NULL or a value this code did
 *  not write. */
export function parseStoredReach(raw: string | null): StoredReach | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = storedReachSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Ruling 222's dated note (pre-merge review R-seams-4): a repository Viberr
 * has just created through this token (ruling 225) is one the token reaches,
 * so a `read` reach gains it; `list_github_connections` says a repository
 * missing from a read reach is one the token cannot see. An `unknown` reach
 * stays unknown (one entry is not a count), and one already listing it
 * (compared without case, as GitHub names do) needs nothing: both answer null.
 */
export function withCreatedRepository(stored: StoredReach, repo: ReachedRepo): StoredReach | null {
  if (stored.status !== "read") return null;
  const name = repo.fullName.toLowerCase();
  if (stored.repos.some((r) => r.fullName.toLowerCase() === name)) return null;
  return { ...stored, repos: [...stored.repos, repo] };
}

/** The stored column, read tolerantly: NULL, or a value this code did not
 *  write, is "not read yet" (null), never an empty reach. */
export function parseConnectionReach(raw: string | null): ConnectionReach | null {
  const stored = parseStoredReach(raw);
  if (!stored) return null;
  if (stored.status === "unknown") return stored;
  return {
    ...stored,
    total: stored.repos.length,
    privateCount: stored.repos.filter((r) => r.private).length,
  };
}

/** A reach that was not read, with the reason. */
export function unknownReach(reason: string): StoredReach {
  return { status: "unknown", readAt: new Date().toISOString(), reason };
}

/** One page of `GET /user/repos`, narrowed to the three fields recorded. A row
 *  without a name or a privacy flag voids the page (the read is then stored as
 *  unknown): dropping it would record a count GitHub did not give. The
 *  permission block is decoded per row by `repoPermissionsSchema` when the
 *  read runs, not here: this module sits in an import cycle with the
 *  validator (through the store browser), so a module-level reference to its
 *  schema can be read before the validator has defined it. */
const repoPageSchema = z.array(
  z.object({
    full_name: z.string(),
    private: z.boolean(),
    permissions: z.unknown().optional(),
  }),
);

/**
 * Read which repositories `token` reaches. Never throws; a failure at any page
 * is an `unknown` reach naming GitHub's answer, because a partial list would
 * be a wrong count.
 */
export interface ReachReadOptions {
  /** Test seam; production reaches the real `fetch`. */
  fetchImpl?: typeof fetch;
}

export async function readTokenReach(
  token: string,
  options: ReachReadOptions = {},
): Promise<StoredReach> {
  const readAt = new Date().toISOString();
  const clientOptions: GithubClientOptions = { token };
  // Only a test hands one over; production must reach the real `fetch`.
  if (options.fetchImpl) clientOptions.fetchImpl = options.fetchImpl;
  const client = createGithubClient(clientOptions);
  const repos: ReachedRepo[] = [];
  for (let page = 1; page <= REACH_PAGE_LIMIT; page++) {
    const result = await client.request("GET", "/user/repos", repoPageSchema, {
      searchParams: { per_page: REACH_PAGE_SIZE, affiliation: REACH_AFFILIATION, page },
    });
    if (!result.ok) {
      const why =
        result.kind === "network"
          ? `GitHub was unreachable (${result.message})`
          : result.kind === "http"
            ? `GitHub answered ${result.status} on /user/repos (${result.message})`
            : githubFailureMessage(result);
      return { status: "unknown", readAt, reason: why };
    }
    const permissions = repoPermissionsSchema.optional().catch(undefined);
    for (const row of result.data) {
      repos.push({
        fullName: row.full_name,
        private: row.private,
        canPush: repoWritable(permissions.parse(row.permissions)),
      });
    }
    if (result.data.length < REACH_PAGE_SIZE) {
      return { status: "read", readAt, repos, capped: false };
    }
  }
  return { status: "read", readAt, repos, capped: true };
}
