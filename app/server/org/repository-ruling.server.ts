import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { readProjectFile, updateProjectFile } from "~/server/files/project-writer.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { NO_REPOSITORY_RULING_DOC } from "~/shared/repository-ask";
import { publishResourceUpdated } from "./resource-events.server";
import { kbStoreTargetForDir, saveKnowledgeBase } from "./resources.server";
import { deleteStoreNode, writeStoreDoc } from "./store-files.server";

/**
 * Ruling 672: a person's decision that a board connects no repository.
 *
 * The owner, 2026-10-06: "If they refuse that's stored as a ruling on project
 * kb never asked again." So the decision is one document in the project's
 * rulings knowledge base (ruling 239), which Viberr puts in front of every run
 * the project makes: the operator reads it, and so does each agent it
 * dispatches. The document's presence is the whole fact. Nothing else stores
 * the decision, so a person who deletes it, or the connection of a repository
 * that removes it, is all it takes for the question to be askable again.
 */
export interface NoRepositoryRuling {
  /** The rulings knowledge base's store directory. */
  kb: string;
  /** The document's path inside it. */
  doc: string;
}

interface RulingContext {
  dataRoot?: string;
}

/** The ruling as it stands on the project, or null. */
export function noRepositoryRuling(
  projectSlug: string,
  ctx: RulingContext = {},
): NoRepositoryRuling | null {
  return rulingIn(projectRulingsKb(projectSlug, ctx), ctx);
}

/** The ruling in the knowledge base a project names as its rulings. */
function rulingIn(kb: string | null, ctx: RulingContext): NoRepositoryRuling | null {
  if (!kb) return null;
  try {
    return existsSync(path.join(kbDirPath(kb, ctx.dataRoot), NO_REPOSITORY_RULING_DOC))
      ? { kb, doc: NO_REPOSITORY_RULING_DOC }
      : null;
  } catch {
    // A `rulingsKb` that is not a name a store folder can have holds nothing.
    return null;
  }
}

/**
 * Whether the operator may ask a person to connect a repository: `open` on a
 * project with none and no ruling, `declined` once a person has decided the
 * board keeps none, and null for a project that has one (or cannot be read),
 * where there is nothing to ask.
 */
export type RepositoryAskState = "open" | "declined";

/**
 * Read off a project file the caller already holds: every operator run and
 * every task page resolves the operator's authority, and neither may pay a
 * second read of `project.md` for this.
 */
export function repositoryAskState(
  project: { repo?: string | null | undefined; rulingsKb?: string | null | undefined },
  ctx: RulingContext = {},
): RepositoryAskState | null {
  if (project.repo) return null;
  return rulingIn(project.rulingsKb?.trim() || null, ctx) ? "declined" : "open";
}

export interface RecordNoRepositoryRulingInput {
  projectSlug: string;
  /** The person who decided, as the ruling names them. */
  byName: string;
  /** The task whose question they answered. */
  taskKey: string;
  /** When, as an ISO instant. */
  at: string;
}

/** The ruling's text. Its heading is what a run's index of the knowledge base
 *  shows, so the heading alone says what was decided. */
function rulingText(input: RecordNoRepositoryRulingInput): string {
  return (
    "# This board connects no repository\n\n" +
    `Decided by ${input.byName} on ${input.at.slice(0, 10)}, answering the operator's question on ${input.taskKey}.\n\n` +
    "- Every task on this board is delivered as the files its delivering agent saves on the task. Nothing is committed and no pull request is opened.\n" +
    "- Do not ask a person to connect a repository. Where a task cannot be done without one, say what cannot be done and deliver the rest.\n" +
    "- This stands until a repository is connected to the project, which removes this document.\n"
  );
}

/**
 * The store directory of a new rulings knowledge base for a project that
 * names none: `<slug>-rulings`, or the first numbered one no folder holds.
 */
function freeRulingsDir(projectSlug: string, ctx: RulingContext): string {
  for (let n = 1; n <= 50; n += 1) {
    const dir = n === 1 ? `${projectSlug}-rulings` : `${projectSlug}-rulings-${n}`;
    if (!existsSync(kbDirPath(dir, ctx.dataRoot))) return dir;
  }
  throw AppError.conflict(
    `No free name was found for ${projectSlug}'s rulings knowledge base. Name one in the project's rulings setting and answer again.`,
  );
}

/**
 * Write the ruling. A project that names no rulings knowledge base gets one,
 * named as the project's: the decision has to reach every run, and that is the
 * one knowledge base every run reads. The caller has checked the person may
 * decide it (a project admin: it is the board's policy).
 */
export async function recordNoRepositoryRuling(
  db: DatabaseSync,
  input: RecordNoRepositoryRulingInput,
  actor: AuditActor,
  ctx: RulingContext = {},
): Promise<NoRepositoryRuling & { createdKb: boolean }> {
  const ref = { projectSlug: input.projectSlug, dataRoot: ctx.dataRoot };
  const project = readProjectFile(ref);
  if (!project) throw AppError.notFound(`Project not found: ${input.projectSlug}`);
  let kb = projectRulingsKb(input.projectSlug, ctx);
  const createdKb = kb === null;
  if (kb === null) {
    const dir = freeRulingsDir(input.projectSlug, ctx);
    // The name slugs to the directory: `saveKnowledgeBase` derives one from
    // the other, and a run knows a knowledge base by its directory.
    await saveKnowledgeBase(db, { name: dir, refresh: "on change" }, actor, ctx);
    await updateProjectFile(ref, (parsed) => {
      parsed.frontmatter.rulingsKb = dir;
    });
    reprojectProject(db, ctx, input.projectSlug);
    recordAudit(db, {
      action: "project.rulings_kb.updated",
      actor,
      subjectKind: "project",
      subjectId: input.projectSlug,
      projectSlug: input.projectSlug,
      details: { dir },
    });
    kb = dir;
  }
  const target = kbStoreTargetForDir(db, kb, ctx);
  if (!target) {
    throw AppError.conflict(
      `${input.projectSlug} names \`${kb}\` as its rulings knowledge base, and the store has no such folder, so the decision has nowhere to be written. Name a rulings knowledge base that exists and answer again.`,
    );
  }
  writeStoreDoc(db, target, [], NO_REPOSITORY_RULING_DOC, rulingText(input), actor, {
    overwrite: true,
  });
  publishResourceUpdated("kb", target.id);
  recordAudit(db, {
    action: "project.repo.ruling_recorded",
    actor,
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kb, doc: NO_REPOSITORY_RULING_DOC, createdKb },
  });
  return { kb, doc: NO_REPOSITORY_RULING_DOC, createdKb };
}

/**
 * Take the ruling back: a repository was connected, so it is no longer true.
 * Returns what was removed, or null when none stood. The knowledge base stays,
 * with whatever else it holds.
 */
export function removeNoRepositoryRuling(
  db: DatabaseSync,
  input: { projectSlug: string; repo: string },
  actor: AuditActor,
  ctx: RulingContext = {},
): NoRepositoryRuling | null {
  const standing = noRepositoryRuling(input.projectSlug, ctx);
  if (!standing) return null;
  const target = kbStoreTargetForDir(db, standing.kb, ctx);
  if (!target) return null;
  deleteStoreNode(db, target, [standing.doc], actor);
  publishResourceUpdated("kb", target.id);
  recordAudit(db, {
    action: "project.repo.ruling_removed",
    actor,
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    details: { kb: standing.kb, doc: standing.doc, repo: input.repo },
  });
  return standing;
}
