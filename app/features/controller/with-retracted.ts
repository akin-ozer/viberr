// Lives apart from waiting-actions.tsx so that file exports only components
// (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/**
 * Ruling 251: the composer's box once a retracted message comes back. What
 * the person is typing stays where it is and the message goes under it, so
 * neither is lost (ruling 319's rule for the box).
 */
export function withRetracted(box: string, retracted: string): string {
  return box.trim() ? `${box.trimEnd()}\n\n${retracted}` : retracted;
}
