/**
 * A fence the fenced content cannot close. A fixed five-backtick fence was
 * forgeable: the task-file writer escapes structural lines (`## `, `title:`, …)
 * but not a line of backticks, so a comment starting with five or more of them
 * closed the block early and anything after it read as the server's own words
 * (review finding 6). CommonMark closes on a run of the same length or longer,
 * so one more than the longest run inside can never be matched.
 *
 * It lives here because two callers need it: the controller's context read
 * fences what people and agents wrote, and a refused knowledge-base correction
 * (ruling 210) fences the document's own lines back to the agent that must
 * copy them exactly.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  return "`".repeat(Math.max(4, longest + 1));
}
