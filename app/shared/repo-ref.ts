/**
 * A repository as a person types or pastes it: `owner/name`, or its GitHub
 * URL (with or without the scheme, `www.` or a trailing `.git`). Null for
 * anything that is not one. One reading for the settings door that changes a
 * project's repository and for the operator's repository question (ruling
 * 672), so the same text is a repository to both.
 *
 * Client-safe: no server import.
 */
export function normalizeRepoInput(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  s = s.replace(/^github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(s)
    ? s
    : null;
}
