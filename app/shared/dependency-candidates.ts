/**
 * Ruling 548: what the Details panel's Blocked by picker offers, and the
 * writer's refusals of a `blockedBy` entry (ruling 131) in the one wording
 * both use: `validateDependencyRefs` and `setTaskDependencies` throw these
 * sentences, and the picker says them on the row before Save, so the words a
 * person meets there are the words Save would answer with (ruling 186's rule).
 *
 * Its own module rather than `dependencies.ts`: the picker is a chunk of its
 * own, and that module's hold sentences would follow it into a chunk the task
 * page loads (ruling 457).
 */

/** Why the writer would refuse a task as a NEW entry, in the order it checks. */
export type DependencyCandidateBar = "archived" | "cycle" | "done";

/** One task the picker offers. */
export interface DependencyCandidate {
  key: string;
  title: string;
  /** Its stage's display name. */
  stage: string;
  /** Why the writer would refuse it as a new entry; null when it would not. */
  bar: DependencyCandidateBar | null;
  /** For a `cycle`: the cycle as the stored lists run, from the task that is
   *  choosing, through this one, back to it. */
  chain?: string[];
}

export function archivedEntryRefusal(key: string): string {
  return `${key} is archived; a task cannot wait on abandoned work.`;
}

export function cycleEntryRefusal(key: string, chain: readonly string[]): string {
  return `Waiting on ${key} would close a cycle: ${chain.join(" waits on ")}.`;
}

export function doneEntriesRefusal(keys: readonly string[]): string {
  const one = keys.length === 1;
  return (
    `${keys.join(", ")} ${one ? "is" : "are"} already done, so waiting on ${one ? "it" : "them"} ` +
    `holds nothing. Leave ${one ? "it" : "them"} off the list.`
  );
}

/** The writer's refusal of a barred candidate. */
export function candidateRefusal(candidate: DependencyCandidate): string {
  if (candidate.bar === "archived") return archivedEntryRefusal(candidate.key);
  if (candidate.bar === "cycle") return cycleEntryRefusal(candidate.key, candidate.chain ?? []);
  return doneEntriesRefusal([candidate.key]);
}
