import { parseDependencyRef, type DependencyRender } from "./dependencies";

/**
 * Ruling 476(b) (F40-22): where one goal link lives on the project controller
 * page. Each link row on the Goals rail carries this id, so the task page's
 * chain chip ("goal-1 · link 3") and a wait entry that names a goal link land
 * on the link itself rather than on its chain's head, which is where
 * `#goal-1` used to send a person to count rows.
 */
export function goalLinkAnchor(goalId: string, linkIndex: number): string {
  return `${goalId}-link-${linkIndex}`;
}

/** The anchor a wait entry opens on the controller page: its link's row when
 *  it names a goal link, else its chain, else nothing. */
export function dependencyAnchor(entry: Pick<DependencyRender, "ref" | "goalId">): string | null {
  const ref = parseDependencyRef(entry.ref);
  if (ref?.kind === "goal") return goalLinkAnchor(ref.goal, ref.link);
  return entry.goalId;
}
