import type { GagentView } from "~/server/org/gagents.server";
import type { ProjectCustomStages } from "~/server/org/org-view.server";
import type { StageDef } from "~/schemas/project-file.schema";

/**
 * What the global agent-template editor reads off its props (ruling 13(b), the
 * split of `agent-template-modal.tsx`): a grant list matched against the org's
 * resources, the stage a new profile starts on, the stored stages no board
 * offers, the Custom stages list's order and the page of it on screen. Pure
 * functions, no React; the chip helpers take the setter they call.
 */

export const match = (list: string[], names: string[]) => {
  const set = new Set(names);
  return list.filter((x) => set.has(x));
};
export const unmatched = (list: string[], names: string[]) => {
  const set = new Set(names);
  return list.filter((x) => !set.has(x));
};

export const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
  set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export const drop = (list: string[], set: (v: string[]) => void, id: string) =>
  set(list.filter((x) => x !== id));

/** Ruling 326: the Custom stages list pages through projects this many at a
 *  time. */
export const PROJECTS_PER_PAGE = 3;

/**
 * P11-47: default a new profile's eligible stages to a real work stage that
 * exists, not a hardcoded "impl" that silently references nothing if the org
 * stage template renames/removes it. Prefer a stage literally named "impl",
 * else the middle non-terminal stage, else the first.
 */
export function defaultStageOf(workStages: StageDef[]): string | undefined {
  return (
    workStages.find((s) => s.id === "impl")?.id ??
    workStages[Math.floor(workStages.length / 2)]?.id ??
    workStages[0]?.id
  );
}

/**
 * Ruling 326: a stored stage the chips do not offer (a project's own
 * `build`, carried into the template) had no chip, so it could be neither
 * seen nor removed and every save kept it. Ruling 326: a stage a live
 * project's board has is offered in that project's row, so this is only what
 * no board has any more (a project archived, a stage renamed).
 */
export function storedOnlyStagesOf(
  initial: GagentView | null,
  workStages: StageDef[],
  projectStages: ProjectCustomStages[],
): string[] {
  return initial
    ? initial.stages.filter(
        (id) =>
          !workStages.some((s) => s.id === id) &&
          !projectStages.some((p) => p.stages.some((s) => s.id === id)),
      )
    : [];
}

/** Ruling 326: the projects whose stages the profile already names lead, so
 *  what it stores is on the first page. */
export function projectsNamedFirst(
  initial: GagentView | null,
  projectStages: ProjectCustomStages[],
): ProjectCustomStages[] {
  const named = new Set(initial ? initial.stages : []);
  const namesOne = (p: ProjectCustomStages) => p.stages.some((s) => named.has(s.id));
  return [...projectStages.filter(namesOne), ...projectStages.filter((p) => !namesOne(p))];
}

/** Ruling 326: the page of the Custom stages list on screen. */
export function stagePage(projects: ProjectCustomStages[], page: number) {
  const pages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const pageStart = (page - 1) * PROJECTS_PER_PAGE;
  const pageProjects = projects.slice(pageStart, pageStart + PROJECTS_PER_PAGE);
  const pageEnd = pageStart + pageProjects.length;
  return { pages, pageStart, pageProjects, pageEnd };
}
