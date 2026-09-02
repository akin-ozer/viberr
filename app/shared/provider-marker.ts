/**
 * The marker every run-failure writer appends the provider's OWN (redacted)
 * sentence behind, so a reader can split it back off and judge only that
 * sentence — `backend-quota.server` decides "quota exhausted" vs "transient
 * 429" on the provider's words, never on the adapter's role-neutral prose.
 *
 * P07-C (pass 32): this literal existed five times (an export in agent-reply,
 * a private copy in backend-quota, three inline template literals in the two
 * runtimes, and a different shape in the controller reply) with no drift pin.
 * A writer drifting by one character would have made the quota classifier
 * judge the WHOLE line — the V4 transient-429 defect, re-opened silently.
 * ONE module now; `provider-marker.test.ts` greps the tree for the literal.
 */
export const PROVIDER_TEXT_MARKER = "\n\nThe provider reported: ";

/** `message` + the provider's sentence behind the marker, or `message` alone
 *  when the adapter had nothing to add. */
export function withProviderText(message: string, providerText: string | null | undefined): string {
  return providerText ? `${message}${PROVIDER_TEXT_MARKER}${providerText}` : message;
}
