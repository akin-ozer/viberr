import type { PacketOptionKind } from "~/schemas/task-file.schema";

/**
 * Ruling 672: the operator's one question about a board with no repository.
 *
 * A board can start without a repository. When a task on it needs one (its
 * goal changes a codebase, or it has to ship as a pull request), the operator
 * asks a person once, on a decision packet with these two options. Connecting
 * one attaches it through the Change door (ruling 669) and starts the
 * controller on the board. Keeping none is written into the project's rulings
 * knowledge base, and while that ruling stands the question is not asked
 * again.
 *
 * Client-safe: no server import.
 */
export const REPOSITORY_OPTION_KINDS: readonly PacketOptionKind[] = [
  "connect_repository",
  "keep_without_repository",
];

/** Whether an option is one of the two the repository question offers. */
export function isRepositoryOptionKind(kind: PacketOptionKind): boolean {
  return REPOSITORY_OPTION_KINDS.includes(kind);
}

const CAUSE_PREFIX = "repository:";

/**
 * The cause every repository question on one board carries (ruling 315's
 * field). The question is about the board, so answering it on one task
 * answers it on each task that asked.
 */
export function repositoryAskCause(projectSlug: string): string {
  return `${CAUSE_PREFIX}${projectSlug}`;
}

export function isRepositoryAskCause(cause: string | null | undefined): boolean {
  return (cause ?? "").startsWith(CAUSE_PREFIX);
}

/** The document, in the project's rulings knowledge base, that holds a
 *  person's decision to keep the board without a repository. */
export const NO_REPOSITORY_RULING_DOC = "no-repository.md";
