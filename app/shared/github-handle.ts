/**
 * The one home of GitHub-handle normalization (ruling 29). Shared because the
 * field lives on both sides: the GitHub OAuth provisioning reads the provider's
 * `login` through it, the org admin's Edit-user save reads a typed value
 * through it, and the client field validates what it will send with the same
 * rule. A handle is compared case-insensitively everywhere
 * (`resolveGithubHandle` lowers the column), so it is stored lowered too.
 */

/** `"@OctoCat "` -> `"octocat"`; blank, whitespace-only or a lone `@` -> null. */
export function normalizeHandle(handle: string | null | undefined): string | null {
  return handle?.trim().replace(/^@/, "").toLowerCase() || null;
}

/**
 * GitHub's own username rule: 1 to 39 alphanumerics or hyphens, never a
 * leading or trailing hyphen, never two in a row. Applied to an already
 * normalized handle.
 */
export function isValidGithubHandle(handle: string): boolean {
  return /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(handle);
}
