import type { DatabaseSync } from "node:sqlite";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  resolveTaskFilePath,
  type TaskFileRef,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import type { FileActorRef, PrState } from "~/schemas/task-file.schema";

/**
 * Pass 34 (F34-9): a PR ADOPTION is recorded, on the timeline and in the
 * audit log, by every door that performs one.
 *
 * Live (JC-4): the reconciler adopted a human-opened PR #6 (same head as the
 * delivered revision) after the task's own PR #5 was closed; `task.md`'s `pr:`
 * switched from #5 to #6 with NO timeline event and NO audit row, so the
 * record could not explain how the task came to reference a PR it never
 * opened. Two doors adopt: the reconciler (`reconcileTaskUnlocked`) and the
 * delivery's `prAlreadyOnHead` (`pr-open.server.ts`, whose "Opened PR" event
 * and `github.pr.opened` row are gated on `created`). The third door
 * (`workspace-delivery`) already records.
 */
export interface PrAdoptionRecordInput {
  repo: string;
  branch: string | null;
  prNumber: number;
  /** The PR the task referenced before, when it referenced one. */
  previousPrNumber: number | null;
  previousState: PrState | null;
  /** The adopted PR's head, when GitHub reported it. */
  headSha: string | null;
  source: "reconciler" | "delivery";
}

const SOURCE_ACTOR = {
  reconciler: { kind: "system", systemId: "policy-engine" },
  delivery: { kind: "system", systemId: "delivery" },
} as const satisfies Record<PrAdoptionRecordInput["source"], FileActorRef>;

export function prAdoptionText(taskKey: string, input: PrAdoptionRecordInput): string {
  const head = input.headSha ? ` (head \`${input.headSha.slice(0, 7)}\`, the delivered revision)` : "";
  const replaces =
    input.previousPrNumber !== null && input.previousPrNumber !== input.prNumber
      ? `, replacing PR #${input.previousPrNumber}${input.previousState ? ` (${input.previousState})` : ""}`
      : "";
  return `Adopted **PR #${input.prNumber}**${head} as ${taskKey}'s review PR${replaces}. Viberr did not open it; it was found on branch \`${input.branch ?? "?"}\` with this task's delivered head.`;
}

export async function recordPrAdoption(
  db: DatabaseSync,
  ref: TaskFileRef,
  input: PrAdoptionRecordInput,
  actor: AuditActor,
): Promise<void> {
  await appendTimelineEvent(ref, {
    occurredAt: new Date().toISOString(),
    type: "github",
    actor: SOURCE_ACTOR[input.source],
    title: null,
    text: prAdoptionText(ref.taskKey, input),
    toAgent: false,
    evidence: null,
  });
  rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ref.dataRoot });
  recordAudit(db, {
    action: "github.pr.adopted",
    actor,
    subjectKind: "pull_request",
    subjectId: `${input.repo}#${input.prNumber}`,
    projectSlug: ref.projectSlug,
    taskKey: ref.taskKey,
    details: {
      repo: input.repo,
      branch: input.branch,
      prNumber: input.prNumber,
      previousPrNumber: input.previousPrNumber,
      previousState: input.previousState,
      headSha: input.headSha,
      source: input.source,
    },
  });
}
