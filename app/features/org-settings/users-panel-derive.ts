import type { OrgUserView } from "~/server/org/org-users.server";
import { isValidGithubHandle, normalizeHandle } from "~/shared/github-handle";

/**
 * What the Users & access modals read off their fields (ruling 689(e), the
 * split of `users-panel.tsx`): the sign-in method Allow access opens on,
 * whether its entry is a whole Google domain, whether it is complete, and
 * what its Save and foot say; and whether Edit user's fields can be saved.
 * Pure functions of the props and the typed values, no React; each modal
 * calls each at most once per render.
 */

export type InviteIdp = "github" | "google" | "local";

/** F18-3: default to a method this deployment can actually grant. A
 *  whitelisted GitHub/Google account can NEVER sign in if that OAuth provider
 *  is unset, so defaulting the modal to GitHub (and promising "allowed the
 *  moment they sign in with GitHub") on a local-only deployment sets a trap.
 *  Lead with the first configured OAuth provider, else Local — mirroring
 *  R17-4's login-page rule. */
export function defaultInviteIdp(providers: { github: boolean; google: boolean }): InviteIdp {
  if (providers.github) return "github";
  return providers.google ? "google" : "local";
}

/** A Google entry that names a whole domain (`@company.dev`) rather than one
 *  account. `account` is the trimmed entry. */
export function isDomainInvite(idp: InviteIdp, account: string): boolean {
  return idp === "google" && (account.startsWith("@") || (account.includes("@") && !account.split("@")[0]));
}

/** Allow access holds what its method needs: a handle of 2+ characters, a
 *  Google address or domain with a dot after the `@`, or a local account's
 *  name and email. `account` is the trimmed email entry. */
export function inviteComplete(
  idp: InviteIdp,
  fields: { handle: string; account: string; name: string; email: string },
): boolean {
  if (idp === "github") return fields.handle.trim().replace(/^@/, "").length > 1;
  if (idp === "google") {
    return fields.account.includes("@") && (fields.account.split("@")[1] || "").includes(".");
  }
  return fields.name.trim().length > 1 && fields.email.includes("@");
}

/** Allow access's primary, named for what it creates. */
export function inviteSaveLabel(idp: InviteIdp, isDomain: boolean): string {
  if (idp === "local") return "Create account";
  if (isDomain) return "Whitelist domain";
  return "Whitelist " + (idp === "github" ? "user" : "account");
}

/** Allow access's foot: when the person gets in. */
export function inviteFootHint(idp: InviteIdp, isDomain: boolean, account: string): string {
  if (idp === "github") return "allowed the moment they sign in with GitHub";
  if (idp === "google") {
    return isDomain
      ? "everyone " + account + " can sign in with Google"
      : "allowed the moment they sign in with Google";
  }
  return "they sign in with the generated temp password, then set their own";
}

/** The OAuth provider an account signs in with, by name. */
export function idpName(idp: OrgUserView["idp"]): string {
  return idp === "github" ? "GitHub" : "Google";
}

/** Where Edit user's fields stand. */
export interface EditUserCheck {
  /** The handle as it would be linked; null when blank (which unlinks). */
  handleInput: string | null;
  /** Blank, or a handle GitHub could issue. */
  handleOk: boolean;
  /** A valid or blank handle, and for a local account a name and an email. */
  canSave: boolean;
}

/** Edit user's handle, normalized, whether it is one GitHub could issue, and
 *  whether the form can be saved. */
export function editUserCheck(fields: {
  isLocal: boolean;
  name: string;
  email: string;
  githubHandle: string;
}): EditUserCheck {
  const handleInput = normalizeHandle(fields.githubHandle);
  const handleOk = handleInput === null || isValidGithubHandle(handleInput);
  const canSave =
    handleOk && (!fields.isLocal || (fields.name.trim().length > 1 && fields.email.includes("@")));
  return { handleInput, handleOk, canSave };
}
