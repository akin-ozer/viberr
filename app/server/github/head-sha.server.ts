const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Canonical full Git object identity used by delivery, review and merge.
 * Abbreviated SHAs are deliberately rejected: they are display values, not
 * immutable governance evidence.
 */
export function normalizeFullGitSha(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return FULL_GIT_SHA.test(normalized) ? normalized : null;
}
