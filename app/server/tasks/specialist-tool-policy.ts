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
 * mappable capabilities are enforced at the tool layer (branch, local commit,
 * merge PR). Push and PR creation are always withheld from the model because
 * Viberr finalizes them with its project-bound credential. Finer-grained delivery capabilities remain advisory in the run
 * persona. Codex runs use their own sandbox config and ignore this list.
 *
 * Polarity (safe-by-default): omitted, `human`, and `off` capabilities are
 * withheld. Only an explicit `direct` or `recommend` grant leaves a mapped
 * local action available; remote delivery always stays server-owned.
 */

const ALWAYS_HUMAN = new Set<string>(ALWAYS_HUMAN_CAPABILITY_IDS);
const SERVER_OWNED_DELIVERY_DENIES = [
  "Bash(git push:*)",
  "Bash(gh pr create:*)",
] as const;

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
  { capabilityId: "commit-push-branch", deny: ["Bash(git commit:*)"] },
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
    ALWAYS_HUMAN.has(capabilityId) ||
    mode === undefined ||
    mode === "human" ||
    mode === "off"
  );
}

const CODEX_ADVISORY_ONLY_CAPABILITIES = [
  "create-task-branch",
  "commit-push-branch",
  "execute-code-or-write-repo",
] as const;

export interface SpecialistBackendCapabilitySupport {
  supported: boolean;
  advisoryOnlyWithheld: string[];
}

/** Codex has no tool denylist equivalent for local branch/commit/write work. */
export function specialistBackendCapabilitySupport(
  grants: readonly CapabilityGrant[],
  backend: "claude" | "codex",
): SpecialistBackendCapabilitySupport {
  if (backend === "claude") {
    return { supported: true, advisoryOnlyWithheld: [] };
  }
  const modeById = new Map(grants.map((grant) => [grant.capabilityId, grant.mode]));
  const advisoryOnlyWithheld = CODEX_ADVISORY_ONLY_CAPABILITIES.filter((id) =>
    isWithheld(modeById, id),
  );
  return {
    supported: advisoryOnlyWithheld.length === 0,
    advisoryOnlyWithheld,
  };
}

/**
 * The `disallowedTools` a specialist run is confined to, given its stored
 * capability grants. Empty when nothing is withheld.
 */
export function resolveSpecialistDisallowedTools(
  grants: readonly CapabilityGrant[],
): string[] {
  const modeById = new Map(grants.map((g) => [g.capabilityId, g.mode]));
  // Remote authentication and PR creation are server-owned even when the
  // profile is allowed to deliver. The agent may create/commit locally; it
  // never receives a project token and is never asked to push or run gh.
  const denied = new Set<string>(SERVER_OWNED_DELIVERY_DENIES);
  for (const rule of CAP_DENY_RULES) {
    if (isWithheld(modeById, rule.capabilityId)) {
      for (const t of rule.deny) denied.add(t);
    }
  }
  return [...denied];
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
 */
export function resolveDeliveryPermissions(
  grants: readonly CapabilityGrant[],
): DeliveryPermissions {
  const modeById = new Map(grants.map((g) => [g.capabilityId, g.mode]));
  return {
    canBranch: !isWithheld(modeById, "create-task-branch"),
    canCommitPush: !isWithheld(modeById, "commit-push-branch"),
    canOpenPr: !isWithheld(modeById, "open-review-pr"),
  };
}
