/**
 * D32-3 (pass 32): ONE grammar for document titles — "<Page> · <project> ·
 * Viberr" — so a tab, a bookmark and a screen reader name every surface the
 * same way. Before: six workspace views inherited the bare project title,
 * `/org/settings` dropped the product name, the task page dropped it too, and
 * the sign-in page had the order reversed (three grammars across eleven
 * titled routes). Falsy parts (a loader that has not run) are skipped.
 */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  return [...parts.filter((p): p is string => !!p && p.trim().length > 0), "Viberr"].join(" · ");
}
