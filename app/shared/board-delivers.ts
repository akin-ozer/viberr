/**
 * Ruling 667: what a board delivers, settled when the project is created.
 *
 * A `software` board changes its repository and ships pull requests, so it
 * needs one. A `results` board is the no-code kind (ruling 530): a person
 * files a task with an input, the agents work on it, and the result comes back
 * as the files they save on the task. Its repository is optional, and none of
 * its agents is deployed able to write one.
 *
 * Nothing stores the choice. After creation the project's own facts say which
 * it is: whether it has a repository, and which of its agents may write it.
 *
 * Client-safe: no server import.
 */
export const BOARD_DELIVERS = ["software", "results"] as const;
export type BoardDelivers = (typeof BOARD_DELIVERS)[number];

/** A form's `delivers` field as a choice; anything else is `software`, the
 *  kind every project was before the choice existed. */
export function asBoardDelivers(raw: FormDataEntryValue | null): BoardDelivers {
  return raw === "results" ? "results" : "software";
}
