import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { capabilityById } from "~/shared/capabilities";

/**
 * Ruling 564: a run that posts files keeps its file tools, and they write only
 * where its posting goes.
 *
 * Ruling 109 gives every run whose profile holds `attach-evidence-references`
 * the task's attachments folder, and ruling 535 lets an agent that makes a
 * result deliver it there without a repo-write grant. The write posture never
 * met either: a withheld `execute-code-or-write-repo` removes Edit, MultiEdit
 * and Write outright (the parity ruling of 2026-08-31), so on Claude the agent
 * a results board exists for could post files and had no tool to write one.
 * Live on AWSC-4..7 (2026-09-28) every Claude run of the AWS calculator board
 * called Write first, read "No such tool available: Write", and wrote its
 * deliverable through a shell heredoc instead: the Cloud Solutions Architect's
 * `mapping.md`, the Calculator Builder's estimate files. The architect wrote
 * every amount as "USD", because an unquoted heredoc expands a `$` away
 * (`$766.63` reads `66.63`).
 *
 * Such a run keeps the three tools, and a PreToolUse hook refuses a call whose
 * target is outside the attachments folder and the temp directory, with a
 * sentence naming both. The checkout stays out of their reach, which is what
 * the withheld grant is about, and NotebookEdit stays denied. Coverage, not
 * containment, like the Bash hook beside it (ruling 101(e)): the run keeps
 * Bash, which writes anywhere its user can. Codex is unchanged: since ruling
 * 185 its write posture is advisory, and its patch tool already writes the
 * drop.
 */

/** The file tools a run with an attachments folder keeps, confined. */
export const DROP_FILE_TOOLS = ["Edit", "MultiEdit", "Write"] as const;

/**
 * Where a Claude run's Edit, MultiEdit and Write may write, or null when
 * nothing changes: the grants leave the tools alone, or the run has no
 * attachments folder. The one derivation the adapter's hook and the run's
 * disclosure share.
 */
export function fileWriteRoots(
  denied: readonly string[] | undefined,
  attachmentsDir: string | null | undefined,
  tempDir: string = tmpdir(),
): string[] | null {
  if (!attachmentsDir || !denied) return null;
  if (!DROP_FILE_TOOLS.every((tool) => denied.includes(tool))) return null;
  return [attachmentsDir, tempDir];
}

/** The denylist the SDK is handed once the file tools are confined instead. */
export function withoutConfinedFileTools(denied: readonly string[]): string[] {
  const confined = new Set<string>(DROP_FILE_TOOLS);
  return denied.filter((tool) => !confined.has(tool));
}

/** The path with its existing part resolved through symlinks, so a root and a
 *  target spelled through different links (`/tmp` and `/private/tmp`) compare. */
function canonical(target: string): string {
  const missing: string[] = [];
  let head = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...missing);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(target);
      missing.unshift(path.basename(head));
      head = parent;
    }
  }
}

/** Whether `filePath` names a file inside one of the roots (never a root itself). */
export function insideFileWriteRoots(filePath: string, roots: readonly string[]): boolean {
  if (!path.isAbsolute(filePath)) return false;
  const target = canonical(filePath);
  return roots.some((root) => {
    const rel = path.relative(canonical(root), target);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  });
}

/** The sentence the hook hands the model when it refuses a file tool. */
export function fileWriteDenyReason(
  tool: string,
  filePath: string,
  roots: readonly string[],
): string {
  const id = "execute-code-or-write-repo";
  const label = capabilityById(id)?.label ?? id;
  const [attachments, ...scratch] = roots;
  // Ruling 692(d): the last sentence. The grant's label opens with "Execute
  // code", and live a writer that read this refusal stopped running commands
  // for the rest of its run ("after that I only counted words and checked
  // links"), though the grant never took its shell away.
  return (
    `Withheld by capability policy: "${label}" (${id}) is not granted on this run, so ${tool} ` +
    `writes only into the task's attachments folder \`${attachments}\`, where the files you ` +
    `post on the task go, and ${scratch.map((dir) => `\`${dir}\``).join(", ")} for scratch. ` +
    `\`${filePath}\` is outside both: write the file there by its absolute path, and leave ` +
    "everything else as it is. This confines Edit, MultiEdit and Write and nothing else: your " +
    "shell still runs commands."
  );
}
