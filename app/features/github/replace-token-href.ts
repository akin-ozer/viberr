// Lives apart from credential-card.tsx so that file exports only components
// (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/**
 * Ruling 480 (F40-45): where an instance admin replaces the token a project's
 * credential is bound to: its connection's Update token in Instance settings.
 * Null when no connection holds the token.
 */
export function replaceTokenHref(connectionId: string | undefined): string | null {
  return connectionId
    ? `/org/settings?tab=connections&update=${encodeURIComponent(connectionId)}`
    : null;
}
