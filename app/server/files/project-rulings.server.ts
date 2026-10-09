/**
 * Ruling 208(a) (pass 37): the project's RULINGS knowledge base.
 *
 * A knowledge base is granted per profile (`agents[].resources.kb`), which
 * makes it a thing a controller can attach to eight profiles and forget on the
 * ninth — and the ninth is always the one that needed it. Live on this pass the
 * conventions KB carried a section headed "For reviewers" stating in as many
 * words that a missing lockfile importer "is a KNOWN systemic condition on this
 * repository with a stated rule above — not a novel defect to be re-derived
 * from first principles on each task", and noting that four reviewers had each
 * re-derived it for four rework rounds. SHOP-24's Code Reviewer then blocked on
 * exactly that rule twice more, which raised ruling 94's packet and cost a
 * human a goal amendment.
 *
 * (That reviewer HAD the KB — checked, twice, because the obvious hypothesis
 * was that it did not. The grants were right. What was missing is a channel
 * that cannot be got wrong and that the whole project shares.)
 *
 * So a project names ONE knowledge base as its rulings, and Viberr injects it
 * into every run the project makes: each specialist, the operator, and the
 * controller while it is working on that project. Nobody grants it and nobody
 * can forget it. A project that names none behaves exactly as before.
 *
 * The owner's framing, which this implements: "per project kb with rulings …
 * this kb must be used by every agent in the project, when the controller
 * session also using a project it should read the project kb as well. If we
 * already have a kb for this we can transform it to this."
 */
import { readProjectFile } from "~/server/files/project-writer.server";

/** The store directory of a project's rulings KB, or null when it names none. */
export function projectRulingsKb(
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): string | null {
  // The optional-key convention: an ABSENT `dataRoot` means "use the default",
  // which is not the same as passing `undefined` through a typed field.
  const dir = readProjectFile(
    ctx.dataRoot ? { projectSlug, dataRoot: ctx.dataRoot } : { projectSlug },
  )?.parsed.frontmatter.rulingsKb;
  return dir?.trim() ? dir.trim() : null;
}

/**
 * A run's KB list with the project's rulings KB guaranteed present.
 *
 * Appended, not prepended: ruling 208(a) puts a profile's own grants first and the
 * project's rulings last, and `readKbIndexes` emits the indexes in that order.
 * It is a reading order now; until ruling 205 it was a shared character budget
 * spent in order, and a rulings KB in front would have silently taken context
 * from the thing the profile was deployed to do. Deduped, because a profile
 * that ALSO grants it explicitly must not have it indexed twice — which is the
 * likely shape when an existing KB is promoted into this role, as the owner
 * asked to be possible.
 */
export function withProjectRulings(
  kb: readonly string[],
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): string[] {
  const rulings = projectRulingsKb(projectSlug, ctx);
  if (!rulings) return [...kb];
  return kb.includes(rulings) ? [...kb] : [...kb, rulings];
}
