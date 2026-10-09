/**
 * Which GitHub scopes a refusal is a VIOLATION of, and which are advisory
 * (F39-5, ruling 221(b)). Client-safe and dependency-free on purpose: both the
 * timeline writer (`server/github/scope-flag.server.ts`) and the credential
 * card's advisories (`server/secrets/pat-store.server.ts`) read it, and those
 * two import each other's neighbours — a shared constant in either of them is
 * a cycle, which is how `CONNECTION_REQUIRED_SCOPES` briefly became
 * `undefined` at module init while this list lived in one of them.
 *
 * The distinction is not cosmetic. Live in pass 39, one minute apart, viberr
 * told its owner both of these about one fact: the task record said
 * "**Policy violation:** active PAT is missing `checks:read`" under the coral
 * shield, and the credential card said "All required scopes proven". Ruling 237
 * had already settled it — merging never needed `checks:read` — but only the
 * card had learned.
 */

/** Scopes whose absence is worth reporting and is NOT a policy violation. */
const ADVISORY_SCOPES: ReadonlySet<string> = new Set(["checks:read"]);

/** Is a refusal on `scope` an advisory rather than a violation? */
export function scopeIsAdvisory(scope: string): boolean {
  return ADVISORY_SCOPES.has(scope);
}
