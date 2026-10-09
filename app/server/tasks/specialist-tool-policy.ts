import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  capabilityById,
  coerceSpecialistCapabilityMode,
  GRANT_REQUIRED_CAPABILITY_IDS,
  SCOPED_DELIVERY_CAPABILITY_IDS,
} from "~/shared/capabilities";

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
 * persona. Codex has no denylist channel of its own, and no OS sandbox
 * (ruling 144): one derived flag still binds there,
 * `webSearchWithheldFromDenylist` → `webSearchMode: "disabled"` (P14-RT-06).
 * The write family and the scoped commands are advisory on Codex, where the
 * server-owned delivery gate plus credential-less agents are the boundary —
 * see CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS and `codexRepoWriteAdvisory`.
 *
 * Polarity (P14-LV-01, safe-by-default and now actually safe): a delivery or
 * verdict capability is granted ONLY when a grant says so. Withheld means mode
 * `human` / `off`, an always-human capability, **or no grant at all**.
 *
 * It used to mean the opposite — an unlisted capability kept default tool
 * access — and that inversion was load-bearing in the wrong direction. Live
 * proof: deploying the org template `org-docs-writer` (whose file carries
 * `capabilities: []`, and whose own description is "never touches app code")
 * produced a project agent holding repo-write, branch, push, open-PR and both
 * verdict capabilities. Pass 13 patched two creation paths to persist explicit
 * grants and left the interpretation alone, so every profile authored before
 * that — or on disk, or through any path that forgets — stayed fully powered.
 *
 * Non-delivery capabilities (comment, ask-human, evidence, validation…) keep the
 * permissive default: withholding them is a policy nicety, and denying them by
 * omission would cripple ordinary runs for no safety gain.
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
  // P13-LV-18: network egress is a capability now. Withholding it removes the
  // built-in web tools AND the MCP resource-fetch helpers that reach the same
  // network surface. (`curl`/`wget` through Bash stay reachable for the same
  // reason shell writes do — the specialist needs Bash to run validation; that
  // tension is documented rather than papered over.)
  {
    capabilityId: "use-web-search-fetch",
    deny: ["WebFetch", "WebSearch"],
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

// GRANT_REQUIRED_CAPABILITY_IDS moved to ~/shared/capabilities (single source of
// truth) so the profile editor seeds its toggles from the same set the runtime
// withholds by — an absent grant renders exactly as the runtime treats it.

/**
 * Grants → mode lookup, repairing ONE thing: a headline
 * `execute-code-or-write-repo` that is **absent** on a profile whose scoped
 * delivery grants are actionable. Under the P14-LV-01 polarity a bare lookup
 * reads that absence as withheld and strips Edit/Write from a working deliverer,
 * so the absence is resolved the way the write paths resolve it.
 *
 * It deliberately does NOT reuse `normalizeDeliveryGrants` wholesale. That
 * helper also rewrites an EXPLICIT `off` headline to `direct` — defensible at
 * save time, where it repairs an editor artifact an admin can see and re-edit,
 * but wrong here: at the enforcement layer it would let a scoped grant silently
 * overturn an admin's explicit "Write to the repository: Off", handing
 * back Edit/Write/`git commit`. That is the P14-LV-01 polarity bug in mirror
 * image — permission appearing from something other than a grant — so the one
 * mode this layer never reinterprets is an explicit withholding.
 */
export function specialistGrantModes(
  grants: readonly CapabilityGrant[],
): Map<string, string> {
  const modes = new Map<string, string>(
    grants.map((g) => [g.capabilityId, g.mode]),
  );
  if (modes.has("execute-code-or-write-repo")) return modes;
  const actionable = (m: string | undefined) => m === "direct" || m === "recommend";
  if (SCOPED_DELIVERY_CAPABILITY_IDS.some((id) => actionable(modes.get(id)))) {
    modes.set("execute-code-or-write-repo", "direct");
  }
  return modes;
}

/**
 * Whether these grants let an agent deliver by writing the repository: the
 * headline `execute-code-or-write-repo` is not withheld, as the runtime itself
 * resolves it ({@link specialistGrantModes}), and the headline or a scoped
 * branch or commit grant is direct. One reading for whoever picks an agent
 * (the roster's `capabilities.delivery`), for an imported board, and for the
 * door that removes a project's repository (ruling 226).
 *
 * Re-deriving it as "any scoped delivery grant is direct" was the mistake XS-4
 * fixed on the prompt side: the headline gates ALL delivery, so a profile with
 * the headline off and `commit-push-branch` on read as delivery-capable to
 * whoever picks the agent, while the tool layer denied every write it would
 * need. `repairDeliveryGrants` deliberately preserves that combination
 * (B-AG1), so it is a state a human can really save.
 */
export function grantsWriteRepository(grants: readonly CapabilityGrant[]): boolean {
  const headline = specialistGrantModes(grants).get("execute-code-or-write-repo");
  if (headline === undefined || headline === "off" || headline === "human") return false;
  const direct = (id: string) =>
    grants.some((g) => g.capabilityId === id && coerceSpecialistCapabilityMode(g.mode) === "direct");
  return (
    direct("execute-code-or-write-repo") || direct("commit-push-branch") || direct("create-task-branch")
  );
}

function isWithheld(
  modeById: Map<string, string>,
  capabilityId: string,
): boolean {
  if (ALWAYS_HUMAN.has(capabilityId)) return true;
  const mode = modeById.get(capabilityId);
  if (mode === undefined) return GRANT_REQUIRED_CAPABILITY_IDS.has(capabilityId);
  return mode === "human" || mode === "off";
}

/**
 * The `disallowedTools` a specialist run is confined to, given its stored
 * capability grants. Empty when nothing is withheld.
 */
export function resolveSpecialistDisallowedTools(
  grants: readonly CapabilityGrant[],
): string[] {
  const modeById = specialistGrantModes(grants);
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
 * live deployment (undeployed/deleted between engage and resume). Nothing can be
 * confirmed about its grants, so every rule-bearing capability is withheld: such
 * a run may read and validate, never deliver.
 *
 * Since P14-LV-01 an empty grant list already denies the delivery set, so this
 * mainly adds the non-delivery rules (web egress) — but it stays explicit rather
 * than relying on the default, because "we know nothing about this profile" and
 * "this profile was authored with no delivery grants" are different facts and
 * only one of them should also lose web access.
 */
export function resolveUndeployedDisallowedTools(): string[] {
  return resolveSpecialistDisallowedTools(
    CAP_DENY_RULES.map((r) => ({ capabilityId: r.capabilityId, mode: "off" })),
  );
}

/**
 * Ruling 219(a), amended (Option D PR 5): the sentence the Claude PreToolUse
 * hook hands the model when a Bash command reaches a denied prefix.
 *
 * Named from the run's final denylist alone, the way
 * `repoWriteWithheldFromDenylist` derives the write posture: a capability is
 * withheld on this run when EVERY rule it contributes is in the list (the
 * resolver adds a withheld capability's whole set). `git commit` belongs to
 * two capabilities, so the sentence names whichever this run withholds. A
 * prefix no capability explains on a supporting run is the kind-based
 * delivery deny (VIB-30): supporting engagements never deliver.
 */
export function bashDenyReason(
  prefix: string,
  denied: readonly string[],
  supporting: boolean,
): string {
  const rule = `Bash(${prefix}:*)`;
  const deniedSet = new Set(denied);
  const withheld = CAP_DENY_RULES.filter(
    (r) => r.deny.includes(rule) && r.deny.every((d) => deniedSet.has(d)),
  );
  if (withheld.length) {
    const names = withheld.map(
      (r) => `"${capabilityById(r.capabilityId)?.label ?? r.capabilityId}" (${r.capabilityId})`,
    );
    return (
      `Withheld by capability policy: ${names.join(" and ")} ` +
      `${withheld.length === 1 ? "is" : "are"} not granted on this run, so \`${prefix}\` is ` +
      "refused however it is wrapped. Say what you needed in your report instead."
    );
  }
  if (supporting) {
    return (
      `A supporting engagement never delivers: \`${prefix}\` belongs to the delivering ` +
      "agent and Viberr's server. Say what should be delivered in your report instead."
    );
  }
  return (
    `\`${prefix}\` is denied on this run by its capability policy, however it is wrapped. ` +
    "Say what you needed in your report instead."
  );
}

/**
 * Ruling 191: the sentence Viberr's MCP gateway answers a call to a withheld
 * write tool with (ruling 188). The same shape as {@link bashDenyReason}: the
 * capability by label and id, the thing refused, what to do instead. On a
 * direct mount the CLI never lists such a tool at all; through the gateway it
 * is filtered from `tools/list` too, so this is what a run reads only if it
 * calls the name anyway.
 */
export function mcpWriteToolDenyReason(server: string, tool: string): string {
  const id = "execute-code-or-write-repo";
  const label = capabilityById(id)?.label ?? id;
  return (
    `Withheld by capability policy: "${label}" (${id}) is not granted on this run, so ` +
    `\`${tool}\` on ${server}, which an administrator marked as a write tool, is refused. ` +
    "Say what you needed in your report instead."
  );
}

/**
 * Ruling 183 (owner, 2026-09-12, pass 36): Viberr no longer confines a Codex
 * run with the CLI's OS sandbox, so on Codex a withheld repo-write family has
 * no OS channel to bind it. It is ADVISORY there: the prompt omits every
 * delivery step (`resolveDeliveryPermissions`), the run's own contract
 * forbids them, and the server-owned delivery gate — the only thing that
 * pushes a branch or opens a PR — refuses them whatever the agent does. On
 * Claude the tool denylist still binds it outright.
 *
 * This predicate is what every surface that RENDERS the repo-write
 * enforcement asks, so a Codex row is never drawn as a hard block it is not.
 * True for any Codex profile whose headline write family is withheld. (Before
 * ruling 183 it was true only for the narrower E32-3 carve-out — write
 * withheld AND evidence granted — because the sandbox bound the rest.)
 */
export function codexRepoWriteAdvisory(
  grants: readonly CapabilityGrant[],
): boolean {
  // P13-AP-06 parity: a deployment with NO grants runs FULLY withheld
  // (`deploymentGrants` → `withheldAgentGrants()`), which is still withheld —
  // and still advisory on Codex, for the same reason.
  return deliveryWithheld(grants);
}

/**
 * Ruling 183 (pass 37, F37-94): can this set of grants write the repo at all?
 *
 * The one derivation, so a SENTENCE about a deployment cannot drift from the
 * gate the run is held to. `deploy_agent` promised "Delivery starts withheld"
 * on every deploy, which is false because a library deploy COPIES the
 * template's grants (ruling 177) — so a repo-write template deployed with
 * repo write and the reply said the opposite.
 */
export function deliveryWithheld(grants: readonly CapabilityGrant[]): boolean {
  return isWithheld(specialistGrantModes(grants), "execute-code-or-write-repo");
}

/** The one sentence every surface uses for the Codex posture (see
 *  {@link codexRepoWriteAdvisory}). */
export const CODEX_REPO_WRITE_ADVISORY_NOTE =
  "repo-write is withheld, and Viberr does not OS-confine a Codex run, so on Codex the withholding is advisory (ruling 183): the prompt omits every delivery step and the server-owned delivery gate is the real boundary. Run the profile on Claude to have the tool layer refuse them outright";

export interface DeliveryPermissions {
  canBranch: boolean;
  canCommitPush: boolean;
  canOpenPr: boolean;
  /** The headline repo-write grant is not withheld. Without it a deliverer's
   *  delivery can only be the files it saves on the task (ruling 128); with it
   *  and commit withheld, its workspace changes are published by a person. */
  repoWrite: boolean;
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
  const modeById = specialistGrantModes(grants);
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
    repoWrite: !repoWriteWithheld,
    canBranch: !repoWriteWithheld && !isWithheld(modeById, "create-task-branch"),
    canCommitPush:
      !repoWriteWithheld && !isWithheld(modeById, "commit-push-branch"),
    canOpenPr: !repoWriteWithheld && !isWithheld(modeById, "open-review-pr"),
  };
}
