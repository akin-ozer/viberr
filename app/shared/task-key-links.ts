/**
 * U39-29: a task key as a board spells it in prose: the project's key (a
 * capital letter, then capitals or digits), a dash, and the task's number.
 * Shared by the server, which resolves the keys a transcript names, and the
 * renderer, which links the ones it was given; so the two can never disagree
 * about what counts as a key. Lower-case branch names (`ax-29`) never match.
 */
export const TASK_KEY_IN_TEXT_RE = /\b[A-Z][A-Z0-9]{0,9}-\d{1,6}\b/g;

/** U39-29: the tasks a text names that its reader can open, by key: the path
 *  each one opens at. Built by the page's loader; read by the renderer. */
export interface TaskLinks {
  readonly [key: string]: string;
}
