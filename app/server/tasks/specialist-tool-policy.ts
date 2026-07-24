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
    // Cover the force-create variants too (`-B`/`-C`) — the delivery-contract
    // prompt instructs `git checkout -B <branch>`, and `-b`/`-c`-only specifiers
    // let a withheld specialist branch anyway by following the prompt (XS-4).
    deny: [
      "Bash(git checkout -b:*)",
      "Bash(git checkout -B:*)",
      "Bash(git switch -c:*)",
      "Bash(git switch -C:*)",
    ],
  },
  { capabilityId: "commit-push-branch", deny: ["Bash(git push:*)", "Bash(git commit:*)"] },
  { capabilityId: "open-review-pr", deny: ["Bash(gh pr create:*)"] },
  { capabilityId: "merge-pull-request", deny: ["Bash(gh pr merge:*)"] },
  // The headline "write to the repo" capability has REAL teeth (D1/Q4): a
  // specialist whose `execute-code-or-write-repo` is withheld cannot edit files
  // or commit — the file-write tools are removed and git commit is denied.
  // MultiEdit is included to match the operator built-in denylist (XS-13);
  // shell-level writes (`sed -i`, redirection) remain reachable because the
  // specialist keeps Bash to run validation — an inherent tension we surface
  // honestly rather than deny all of Bash and break test runs.
  {
    capabilityId: "execute-code-or-write-repo",
    deny: ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash(git commit:*)"],
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

function isWithheld(
  modeById: Map<string, string>,
  capabilityId: string,
): boolean {
  const mode = modeById.get(capabilityId);
  return (
    ALWAYS_HUMAN.has(capabilityId) || mode === "human" || mode === "off"
  );
}

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
    if (isWithheld(modeById, rule.capabilityId)) {
      for (const t of rule.deny) denied.add(t);
    }
  }
  return [...denied];
}

/**
 * The disallowedTools for a run whose profile can NO LONGER be resolved to a
 * live deployment (undeployed/deleted between engage and resume). We can't
 * confirm any grant, and the safe-by-default polarity treats "unspecified" as
 * full access — which would leave a resumed run of a vanished profile nearly
 * unconfined (only `gh pr merge` denied). So treat EVERY delivery capability as
 * explicitly withheld: an undeployed run may read/validate but never deliver.
 */
export function resolveUndeployedDisallowedTools(): string[] {
  return resolveSpecialistDisallowedTools(
    CAP_DENY_RULES.map((r) => ({ capabilityId: r.capabilityId, mode: "off" })),
  );
}

export interface DeliveryPermissions {
  canBranch: boolean;
  canCommitPush: boolean;
  canOpenPr: boolean;
}

/**
 * Which delivery steps a specialist may perform, so the run PROMPT matches the
 * tool-layer enforcement (XS-4): instructing `git checkout -B` while denying it
 * is a contradiction that produces confused, failing runs. When a step is
 * withheld the prompt omits its instruction instead.
 */
export function resolveDeliveryPermissions(
  grants: readonly CapabilityGrant[],
): DeliveryPermissions {
  const modeById = new Map(grants.map((g) => [g.capabilityId, g.mode]));
  // The headline repo-write capability gates ALL delivery. The tool layer
  // already denies `git commit` when `execute-code-or-write-repo` is withheld
  // (CAP_DENY_RULES above) — but this prompt-side resolution used to consult
  // only the three fine-grained delivery capabilities, so the run prompt
  // still said "commit and push" while the permission layer denied it. The
  // agent then obeyed the prompt, failed three times, and reported a
  // "blocked commit" (observed live, VIB-1 2026-07-17). Prompt and
  // enforcement must tell the same story (XS-4).
  const repoWriteWithheld = isWithheld(modeById, "execute-code-or-write-repo");
  return {
    canBranch: !repoWriteWithheld && !isWithheld(modeById, "create-task-branch"),
    canCommitPush:
      !repoWriteWithheld && !isWithheld(modeById, "commit-push-branch"),
    canOpenPr: !repoWriteWithheld && !isWithheld(modeById, "open-review-pr"),
  };
}
