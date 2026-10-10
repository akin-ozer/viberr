/**
 * Ruling 88: the longest verdict justification stored on a task, and the
 * sentence that ships when it does not fit.
 *
 * 2,000 characters is a generous paragraph and a short essay, which is the
 * right size for the reason a reviewer gives beside its verdict. What was
 * wrong was the silence: a bare `.slice` meant a long justification was stored
 * ending mid-word and read, on the task page, as the whole of what the reviewer
 * said. The full text is never lost - the agent's own report is on the same
 * timeline, untruncated - so the marker's job is to send the reader there.
 */
export const VERDICT_REASON_MAX_CHARS = 2_000;

/** What a reason that did not fit ends with: that it was cut, how long the
 *  whole ran, and where the whole is. */
function cutSentence(length: number): string {
  return (
    `\n\n[cut here - the reviewer's justification ran to ` +
    `${length.toLocaleString("en-US")} characters and this is its first ` +
    `${VERDICT_REASON_MAX_CHARS.toLocaleString("en-US")}. Its full report is on this ` +
    `task's timeline, whole.]`
  );
}

export function clipVerdictReason(text: string): string {
  const reason = text.trim();
  if (reason.length <= VERDICT_REASON_MAX_CHARS) return reason;
  return `${reason.slice(0, VERDICT_REASON_MAX_CHARS)}${cutSentence(reason.length)}`;
}

/**
 * The most a stored reason runs to: its 2,000 characters and, when it was
 * cut, the sentence that says so, whatever length that sentence names. A
 * reader that hands a stored reason on whole leaves room for both (the
 * canonical anchor, ruling 201): one that stops at 2,000 cuts the sentence
 * away and shows a verdict that ends mid-finding as the whole of it.
 */
export const VERDICT_REASON_STORED_MAX_CHARS = VERDICT_REASON_MAX_CHARS + cutSentence(Number.MAX_SAFE_INTEGER).length;
