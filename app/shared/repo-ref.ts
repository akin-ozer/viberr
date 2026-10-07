/**
 * Ruling 695(a): the one shape a project's repository takes, `owner/name` as
 * GitHub allows it. The owner is letters, digits and single hyphens, neither
 * first nor last, up to 39 characters; the name is letters, digits, `.`, `_`
 * and `-`, up to 100, and never `.` or `..`. Every checkout path is
 * `<taskDir>/workspace/<name>` and the mirror is `<owner>__<name>.git`, so a
 * value outside it (a hand-edited `owner/..` would make the checkout the task
 * directory itself) is never a repository: `project.md` reads it as none, and
 * `normalizeRepoInput` below refuses it.
 */
export const REPO_SLUG_RE =
  /^(?=[A-Za-z0-9-]{1,39}\/)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

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
  return REPO_SLUG_RE.test(s) ? s : null;
}
