import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { readProjectFile, updateProjectFile } from "~/server/files/project-writer.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { noRepositoryRulingDoc } from "~/shared/repository-ask";
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
 * that removes it, is all it takes for the question to be askable again. It
 * is named for its project (`noRepositoryRulingDoc`), so a knowledge base two
 * projects share as their rulings holds each board's decision apart.
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
  return rulingIn(projectRulingsKb(projectSlug, ctx), projectSlug, ctx);
}

/** The project's ruling in the knowledge base it names as its rulings. */
function rulingIn(
  kb: string | null,
  projectSlug: string,
  ctx: RulingContext,
): NoRepositoryRuling | null {
  if (!kb) return null;
  const doc = noRepositoryRulingDoc(projectSlug);
  try {
    return existsSync(path.join(kbDirPath(kb, ctx.dataRoot), doc)) ? { kb, doc } : null;
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
  project: {
    slug: string;
    repo?: string | null | undefined;
    rulingsKb?: string | null | undefined;
  },
  ctx: RulingContext = {},
): RepositoryAskState | null {
  if (project.repo) return null;
  return rulingIn(project.rulingsKb?.trim() || null, project.slug, ctx) ? "declined" : "open";
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
 *  shows, so the heading alone says what was decided, and for which project. */
function rulingText(input: RecordNoRepositoryRulingInput, projectName: string): string {
  return (
    `# ${projectName} connects no repository\n\n` +
    `Decided by ${input.byName} on ${input.at.slice(0, 10)}, answering the operator's question on ${input.taskKey}.\n\n` +
    `- Every task on ${projectName}'s board is delivered as the files its delivering agent saves on the task. Nothing is committed and no pull request is opened.\n` +
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
  const doc = noRepositoryRulingDoc(input.projectSlug);
  // Ruling 681: the document is this board's own and is named after it, so
  // no other board given the knowledge base is shown the write.
  writeStoreDoc(db, target, [], doc, rulingText(input, project.parsed.frontmatter.name), actor, {
    overwrite: true,
    ofBoard: input.projectSlug,
  });
  publishResourceUpdated("kb", target.id);
  recordAudit(db, {
    action: "project.repo.ruling_recorded",
    actor,
    subjectKind: "project",
    subjectId: input.projectSlug,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kb, doc, createdKb },
  });
  return { kb, doc, createdKb };
}

/**
 * The project names another rulings knowledge base, or none: the decision is
 * the board's, not the knowledge base's, so it goes where the project's
 * rulings go. Named another, the document is written into the new one and
 * taken out of the old: a project that only changed where its rulings live
 * has not been asked again. Cleared, the project keeps no rulings, this one
 * included, and the document is removed. Either way the old knowledge base
 * keeps no copy: one left behind would come back as a binding ruling if the
 * project named that knowledge base again, on a board that may have a
 * repository by then.
 */
export function moveNoRepositoryRuling(
  db: DatabaseSync,
  input: { projectSlug: string; fromKb: string | null; toKb: string | null },
  actor: AuditActor,
  ctx: RulingContext = {},
): void {
  const standing = rulingIn(input.fromKb, input.projectSlug, ctx);
  if (!standing || input.toKb === input.fromKb) return;
  const from = kbStoreTargetForDir(db, standing.kb, ctx);
  if (!from) return;
  if (input.toKb !== null) {
    const to = kbStoreTargetForDir(db, input.toKb, ctx);
    if (!to) return;
    const text = readFileSync(path.join(from.rootAbs, standing.doc), "utf8");
    writeStoreDoc(db, to, [], standing.doc, text, actor, {
      overwrite: true,
      ofBoard: input.projectSlug,
    });
    publishResourceUpdated("kb", to.id);
  }
  deleteStoreNode(db, from, [standing.doc], actor, { ofBoard: input.projectSlug });
  publishResourceUpdated("kb", from.id);
  if (input.toKb === null) {
    recordAudit(db, {
      action: "project.repo.ruling_removed",
      actor,
      subjectKind: "project",
      subjectId: input.projectSlug,
      projectSlug: input.projectSlug,
      // No repository: the project stopped naming a rulings knowledge base.
      details: { kb: standing.kb, doc: standing.doc, repo: null },
    });
  }
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
  deleteStoreNode(db, target, [standing.doc], actor, { ofBoard: input.projectSlug });
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
