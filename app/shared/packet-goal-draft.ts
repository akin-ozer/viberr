/**
 * The goal editor's prefill for a decided `edit_goal` option — the ONE
 * composition, shared by the confirm response (the same page session) and the
 * reload path that rebuilds it from the decided packet (ruling 138, pass 34
 * F34-13 / U34-10). Client-safe.
 *
 * An option may carry `goalDraft`, the proposed goal text itself, which both
 * operator backends are told to write AS a goal (deliverable plus acceptance
 * criteria) because it is what the editor opens with. Without one the prefill
 * is the option's title and detail verbatim (F17-L3) — which is why the
 * prompts say what becomes the draft, so an operator never phrases them as an
 * instruction to the human.
 */
export function goalDraftForOption(option: {
  t: string;
  d?: string | null;
  goalDraft?: string | null;
}): string {
  const draft = option.goalDraft?.trim();
  if (draft) return draft;
  const detail = option.d?.trim();
  return detail ? `${option.t}\n\n${detail}` : option.t;
}
