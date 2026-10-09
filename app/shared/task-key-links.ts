/**
 * U39-29: a task key as a board spells it in prose: the project's key (a
 * capital letter, then capitals or digits), a dash, and the task's number.
 * Shared by the server, which resolves the keys a transcript names, and the
 * renderer, which links the ones it was given; so the two can never disagree
 * about what counts as a key. Lower-case branch names (`ax-29`) never match.
 */
export const TASK_KEY_IN_TEXT_RE = /\b[A-Z][A-Z0-9]{0,9}-\d{1,6}\b/g;

/** The knowledge-base ids a Controller page links to their entries: ruling
 *  267's proposals (`kp-`, `kb-proposals.server.ts`) and ruling 210's
 *  corrections (`kc-`, `kb-corrections.server.ts`), each ten hex characters. A
 *  page that shows them maps the ones it holds in the same {@link TaskLinks}. */
export const PROPOSAL_ID_IN_TEXT_RE = /\bk[pc]-[0-9a-f]{10}\b/g;

/** U39-29: the tasks a text names that its reader can open, by key: the path
 *  each one opens at. Built by the page's loader; read by the renderer. A page
 *  showing knowledge-base proposals adds each id's in-page anchor. */
export interface TaskLinks {
  readonly [key: string]: string;
}
