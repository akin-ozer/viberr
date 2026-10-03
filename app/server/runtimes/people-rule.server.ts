/**
 * Ruling 649: the one line every writer Viberr prompts reads about the people
 * it writes about: the operator's turn, a specialist's run on either backend,
 * and the controller.
 *
 * Pass 37 (F37-56) put a sentence into the operator's definition ("Refer to a
 * person as 'they' unless they have told you otherwise") and into a specialist
 * prompt only when a person asked the run directly. Neither held. Live on the
 * AWS estimates board 18 entries called the board's owner "he" or "she": the
 * operator wrote "his words" on AWSC-43 and "Her words" on AWSC-80, agents
 * dispatched by the operator (whose prompt carried no such sentence) wrote "His
 * existing answers", and the controller wrote "her comment" into AWSC-98's
 * goal. The record invented a fact about a real person two incompatible ways.
 * A rule buried in one paragraph of a 22 KB definition, or absent, is not one a
 * model keeps, so each writer now reads it in a line of its own, with the words
 * it must not use spelled out.
 */
export const PEOPLE_RULE =
  'Name a person, or call them "they": never "he", "she", "him", "her", "his" or "hers". ' +
  "You are given names, not pronouns, and what you write stays on a record the people it names read.";
