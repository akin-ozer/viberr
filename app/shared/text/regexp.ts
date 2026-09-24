/**
 * `value` as a literal inside a RegExp: every metacharacter
 * (`. * + ? ^ $ { } ( ) | [ ] \`) backslash-escaped, nothing else touched.
 *
 * Not `RegExp.escape`: that one also escapes `/`, `-`, whitespace and a leading
 * letter or digit, so its bytes differ, and not every browser the client
 * supports ships it. `file-leases.ts` keeps its own escape on purpose: it
 * leaves `*` alone because it is translating a glob.
 *
 * Pure, client-safe, no imports.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
