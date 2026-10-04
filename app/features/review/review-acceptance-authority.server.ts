import { gate, resolveOperatorAuthority } from "~/server/tasks/operator-authority.server";

/**
 * P13-D-9 (MOCK-3): does THIS project's deployed operator hold the one
 * deliberate exception to the human-only Done boundary?
 *
 * Owner ruling Q1 (2026-07-11): an operator may close a task itself only when
 * it runs at FULL autonomy *and* holds an explicit
 * `completion-for-acceptance: direct` grant — `gate()` refuses to promote
 * `recommend → direct` for that one capability precisely so a silent agent
 * close cannot fall out of an autonomy setting alone (`gate` in
 * operator-authority.server.ts, enforced in `operatorAcceptCompletion` in
 * operator-moves.server.ts).
 *
 * The create modal (`home-page.tsx`) and the Policy note (`policy-page.tsx`,
 * commit 127721d) already disclose this; the Review queue — the screen where a
 * maintainer forms the acceptance belief — shipped the absolute claim
 * unconditionally. This is the read model that lets it qualify.
 */
export interface AcceptanceAuthority {
  /** The operator can move tasks into the terminal stage without a human. */
  operatorCanAccept: boolean;
  /** The operator's display name, for the disclosure copy. */
  operatorName: string;
}

export function resolveAcceptanceAuthority(
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): AcceptanceAuthority {
  try {
    const authority = resolveOperatorAuthority(ctx, projectSlug);
    return {
      operatorCanAccept:
        authority.deployed &&
        authority.autonomy === "full" &&
        gate(authority, "completion-for-acceptance") === "direct",
      operatorName: authority.name || "the operator",
    };
  } catch {
    // An unreadable/absent project file must never make the queue claim an
    // exception that is not configured — fall back to the strict boundary.
    return { operatorCanAccept: false, operatorName: "the operator" };
  }
}
