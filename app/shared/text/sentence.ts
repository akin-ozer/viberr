/**
 * A sentence that ends exactly once: text already ending in `.`, `!`, `?` or
 * `…` comes back as is; anything else gains a period.
 *
 * For a clause the product did not write, embedded in a longer message: a
 * provider sentence, whatever the adapter wrote, or a refusal reason. A refusal
 * sentence that already carried its period used to be followed by another
 * (`..`, F34-12).
 *
 * Pure, client-safe, no imports.
 */
export function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}
