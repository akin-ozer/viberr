import type { DatabaseSync } from "node:sqlite";
import { isOrgAdmin } from "~/server/auth/project-authority.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { ProjectCredentialHealth } from "~/server/secrets/pat-store.server";
import { roleCan, type ProjectRole } from "~/shared/rbac";

/**
 * R19-11 (owner ruling, Q-V1 PAT half) — who may receive the project
 * credential's identity and health, and what the payload looks like for
 * everyone else.
 *
 * F21-5: this used to live inside `routes/project.github.tsx`, and the /settings
 * route — which renders the SAME `CredentialCard` from the same
 * `getProjectCredentialHealth` fact — never got it. A project Viewer's Settings
 * HTML carried `github_pat_••••42af`, its label and its per-scope verdicts,
 * exactly the leak the ruling closed one page over. Two routes, one rule: the
 * decision lives here so a third surface reaching for credential health has to
 * pass through it (rulings 12/14 — never fork a mapping per surface).
 */

/**
 * Does this reader hold the credential grant on this project?
 *
 * The role derivation is `routes/project.tsx`'s, verbatim: the live membership
 * role from project.md, or project-admin authority for an ORG admin who is not
 * a member (D2). That is deliberate — the layout's `myRole` is what the page
 * gates the card on, so deriving it any other way here would let the payload and
 * the render disagree (a redacted card rendered as if it held a credential, or
 * the reverse).
 *
 * The ACTION is read from `ACTION_ROLES` through `roleCan`, never a role
 * literal, so this can never drift from the `grant-github-scope` guard both
 * routes' actions enforce on the same three credential mutations.
 *
 * `resolveProjectAuthority` is deliberately NOT used: it audits, and a page READ
 * by a role that simply has no reason to see a token is not an unauthorized
 * attempt (P13-D-8's `silentDeny` category). Membership itself was already
 * resolved — and audited — by `requireProjectMember` in the loader.
 */
export function credentialGrantHolder(
  db: DatabaseSync,
  projectSlug: string,
  userId: string,
): boolean {
  const file = readProjectFile({ projectSlug });
  if (!file) return false;
  const memberRole: ProjectRole | null =
    file.parsed.frontmatter.members.find((m) => m.userId === userId)?.role ??
    null;
  const myRole = memberRole ?? (isOrgAdmin(db, userId) ? "admin" : null);
  return roleCan(myRole, "grant-github-scope");
}

/**
 * The credential facts a reader without the grant never receives.
 *
 * A render-only gate would not close this ruling: single-fetch serializes the
 * loader payload into the document, so `github_pat_••••42af` stayed in a
 * viewer's HTML however the card was hidden — which is exactly how the pass-18
 * live session found it ("a viewer's Settings HTML still carries the GitHub
 * connection tail"). Withhold it from the payload and the DOM together.
 *
 * `configured` / `source` / `requiredScopes` stay: none of them is credential
 * DETAIL. The first two say only what the Connection pill already says out loud
 * ("no credential"), and required scopes are project policy — the same list the
 * Policy surface publishes to every member. What goes is the token's identity
 * and health: the masked tail, its label and id, when it was last validated, the
 * validator result, the per-scope verdicts and the open violations.
 */
export function withoutCredentialDetail(
  credential: ProjectCredentialHealth,
): ProjectCredentialHealth {
  return {
    ...credential,
    patId: null,
    label: null,
    masked: null,
    lastValidatedAt: null,
    validation: null,
    scopes: [],
    openViolations: [],
  };
}
