import type { CapabilityGrant } from "~/schemas/project-file.schema";
import { ALWAYS_HUMAN_CAPABILITY_IDS } from "~/shared/capabilities";

/**
 * Specialist capability → runtime tool confinement.
 *
 * A specialist run is a real coding agent (Claude Code / Codex). Its capability
 * grants used to be decorative — stored + rendered as a policy matrix but never
 * consulted at run time. This maps the repo-MUTATING capabilities to concrete
 * Bash tool specifiers and turns them into a `disallowedTools` list for the run.
 *
 * Claude Agent SDK deny rules bind even under `permissionMode: bypassPermissions`
 * (deny always wins), so a server-spawned specialist genuinely cannot invoke a
 * withheld command — this is real enforcement, not guidance.
 *
 * Scope (deliberate + honest): only the high-consequence, cleanly command-
 * mappable capabilities are enforced at the tool layer (branch, push, open PR,
 * merge PR). Finer-grained delivery capabilities remain advisory in the run
 * persona. Codex runs use their own sandbox config and ignore this list.
 *
 * Polarity (safe-by-default): a capability is enforced (its commands denied)
 * only when an admin has EXPLICITLY withheld it — mode `human` (reserved for a
 * person) or `off` (withheld) — or when it is an always-human capability.
 * `direct` / `recommend` / unspecified capabilities keep the agent's default
 * tool access, so an ordinary developer run is never crippled.
 */

const ALWAYS_HUMAN = new Set<string>(ALWAYS_HUMAN_CAPABILITY_IDS);

const CAP_DENY_RULES: readonly {
  capabilityId: string;
  deny: readonly string[];
}[] = [
  {
    capabilityId: "create-task-branch",
    deny: ["Bash(git checkout -b:*)", "Bash(git switch -c:*)"],
  },
  { capabilityId: "commit-push-branch", deny: ["Bash(git push:*)", "Bash(git commit:*)"] },
  { capabilityId: "open-review-pr", deny: ["Bash(gh pr create:*)"] },
  { capabilityId: "merge-pull-request", deny: ["Bash(gh pr merge:*)"] },
  // The headline "write to the repo" capability now has REAL teeth (D1/Q4): a
  // specialist whose `execute-code-or-write-repo` is withheld cannot edit files
  // or commit — Edit/Write/NotebookEdit are removed and git commit is denied.
  {
    capabilityId: "execute-code-or-write-repo",
    deny: ["Edit", "Write", "NotebookEdit", "Bash(git commit:*)"],
  },
  // NOTE (F11, 2026-07-12): the former `edit-other-task-branch` rule denied the
  // broad `Bash(git checkout:*)` / `Bash(git switch:*)`. Because deny wins under
  // bypassPermissions, that ALSO blocked a specialist's own `git checkout -B
  // <task-branch>`, defeating the granted `create-task-branch` and making Claude
  // delivery impossible in the default (edit-other-task-branch: human) config.
  // Under per-task workspace isolation (Q7) each run gets a fresh single-task
  // clone — there is no other task branch to protect — so the capability was moot
  // as well as harmful. It (and the dead `open-or-merge-pr` rule) were removed
  // from the catalog rather than narrowed.
];

/**
 * The `disallowedTools` a specialist run is confined to, given its stored
 * capability grants. Empty when nothing is withheld.
 */
export function resolveSpecialistDisallowedTools(
  grants: readonly CapabilityGrant[],
): string[] {
  const modeById = new Map(grants.map((g) => [g.capabilityId, g.mode]));
  const denied = new Set<string>();
  for (const rule of CAP_DENY_RULES) {
    const mode = modeById.get(rule.capabilityId);
    const withheld =
      ALWAYS_HUMAN.has(rule.capabilityId) || mode === "human" || mode === "off";
    if (withheld) {
      for (const t of rule.deny) denied.add(t);
    }
  }
  return [...denied];
}
