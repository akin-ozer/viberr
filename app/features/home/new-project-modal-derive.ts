import type { BoardDelivers } from "~/shared/board-delivers";
import { slugify } from "~/shared/ids/slugify";
import type { BlockedField } from "./project-fields";
import { keyFromName } from "./project-name";

/**
 * What the New project dialog's fields resolve to (ruling 696(e), the
 * large-component split of `NewProjectModal` in `new-project-modal.tsx`): the
 * task key, repository and owner a create posts, whether the board takes a
 * repository, whether the key is another project's, and the first requirement
 * still unmet with the sentence that names it. A pure function of what the
 * person entered, no React; the dialog calls it once per render.
 */

/** What the person typed and picked, as the dialog holds it. */
export interface NewProjectEntries {
  name: string;
  key: string;
  keyTouched: boolean;
  repo: string;
  connOwner: string;
  delivers: BoardDelivers;
  repoLater: boolean;
  attachRepo: boolean;
}

export function resolveNewProject(entries: NewProjectEntries, keyPool: string[]) {
  const { name, key, keyTouched, repo, connOwner, delivers, repoLater, attachRepo } = entries;
  const effKey = keyTouched ? key : keyFromName(name);
  // Q26-3: does the resolved key already belong to another project? (Only once
  // it is a valid 2+-letter key; case-insensitive, since keys are upper-cased.)
  const keyInUse =
    effKey.length >= 2 &&
    keyPool.some((k) => k.toUpperCase() === effKey.toUpperCase());
  const effRepo = repo || slugify(name);
  const slug = slugify(name);
  // The effective repo owner: a picked connection. A board that delivers
  // software delivers through GitHub, so it takes a repository, and with it a
  // PAT connection, unless the person connects it later (ruling 672: the
  // operator asks for one when a task needs it, so a board without is no dead
  // end). Ruling 667: a board that delivers results needs none, and takes one
  // only when the person attaches it.
  const effOwner = connOwner;
  const needsRepo = delivers === "software" ? !repoLater : attachRepo;
  const ok =
    name.trim().length > 1 &&
    effKey.length >= 2 &&
    (!needsRepo || (effOwner.length > 0 && effRepo.length > 0));
  // LV-07: name the FIRST unmet requirement so a refused Create is never
  // unexplained (the previous modal offered no message anywhere). The field
  // is derived once and the copy from it, so the flagged input and the
  // visible reason can never disagree.
  const blocked: BlockedField | null =
    name.trim().length <= 1
      ? "name"
      : effKey.length < 2
        ? "key"
        : !needsRepo
          ? null
          : effOwner.length === 0
            ? "conn"
            : effRepo.length === 0
              ? "repo"
              : null;
  const blockedReason =
    blocked === "name"
      ? "Enter a project name (2+ characters)."
      : blocked === "key"
        ? "Task key needs at least 2 letters."
        : blocked === "conn"
          ? "Pick a GitHub connection."
          : blocked === "repo"
            ? "Enter a repository name."
            : null;
  return { effKey, keyInUse, effRepo, slug, effOwner, needsRepo, ok, blocked, blockedReason };
}
