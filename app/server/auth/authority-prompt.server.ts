import {
  PROJECT_ROLES,
  RBAC_DEFINITIONS,
  ROLE_RANK,
  type ProjectRole,
} from "~/shared/rbac";

/**
 * Ruling 309: the authorization table, written out for a model that has to
 * decide what to OFFER a person before it calls anything.
 *
 * The controller is told "their live permissions are the ceiling for everything
 * you do here" and then handed their ORG role — which is not the role that
 * decides anything on a board. Live pass 37, asked what the person in front of
 * it could do on a task, it answered correctly and then said how: "your project
 * role was not in anything I had... I bridged that gap with a rule from my
 * playbook", and, on the tier-to-action map, "that is documentation, not the
 * server's live authorization table". Both halves were missing: the role (fixed
 * in the turn context, `controller-context.server.ts`) and the map, which
 * reached the model nowhere at all — not this prompt, not `whoami`, which
 * returns a tier NAME, and not `list_capabilities`, which is the agent
 * capability catalogue and a different axis entirely.
 *
 * So a round trip bought a word like "contributor" and the model still had to
 * supply the meaning from memory. The cost is not a wrong sentence; it is an
 * OFFER it cannot keep, and a fan-out — create, invite, deploy, set policy —
 * that stops at step four with a half-built board.
 *
 * GENERATED from `RBAC_DEFINITIONS`, for the reason `app/shared/rbac.ts` gives
 * for rendering the Policy page from the same object: display and enforcement
 * cannot drift when there is one source. A hand-written summary in a prompt is
 * the drift this avoids.
 */

/** One tier and every action whose floor it is. */
interface AuthorityTier {
  role: ProjectRole;
  /** Labels of the actions this role is the LOWEST role to hold. */
  gains: string[];
}

/** Weakest first. `PROJECT_ROLES` is declared strongest-first, for the member
 *  pickers that render it; a tier story reads the other way, and neither module
 *  should depend on the other's order. `ROLE_RANK` is the ordering itself. */
const ASCENDING: readonly ProjectRole[] = [...PROJECT_ROLES].sort(
  (a, b) => ROLE_RANK[a] - ROLE_RANK[b],
);

/**
 * Group the actions by the lowest role that holds them.
 *
 * `rbac.ts` states that every action is monotonic over the tier — if a role
 * holds it, every higher role does too — which is what makes a floor a complete
 * description. That is an invariant of the data, not of this function, so it is
 * checked here rather than assumed: an edit that breaks it would otherwise
 * generate a table that quietly under-reports someone's authority.
 */
export function authorityTiers(): AuthorityTier[] {
  return tiersFrom(RBAC_DEFINITIONS);
}

/** The grouping itself, over any table — so the monotonicity guard can be
 *  driven with a table that breaks it, which the real one never will. */
export function tiersFrom(
  definitions: readonly {
    id: string;
    label: string;
    covers?: string;
    roles: readonly ProjectRole[];
  }[],
): AuthorityTier[] {
  const gains = new Map<ProjectRole, string[]>(ASCENDING.map((role) => [role, []]));
  for (const { id, label, covers, roles } of definitions) {
    const floor = ASCENDING.find((role) => roles.includes(role));
    if (floor === undefined) throw new Error(`RBAC action "${id}" is held by no role`);
    const gap = ASCENDING.slice(ASCENDING.indexOf(floor)).find((r) => !roles.includes(r));
    if (gap) {
      throw new Error(
        `RBAC action "${id}" is not monotonic over the role tier: ` +
          `its floor is ${floor}, so ${gap} should hold it and does not. ` +
          `Grouping by floor cannot describe it; the prompt table would lie.`,
      );
    }
    // Ruling 309(a): two actions gate more than their grant name says, and the
    // model reads this list to decide what to offer. A name it can only take
    // literally would have it predicting that a contributor may retitle a
    // label and not that the same grant lets them release a held task.
    gains.get(floor)?.push(covers === undefined ? label : `${label} (${covers})`);
  }
  return ASCENDING.map((role): AuthorityTier => ({ role, gains: gains.get(role) ?? [] }));
}

function tierLine(tier: AuthorityTier): string {
  // Bound to the ROLE, not to the position in a list that drops empty tiers:
  // if viewer ever held nothing, position 0 would call contributor "every
  // member", and nothing else would notice.
  const who =
    tier.role === ASCENDING[0]
      ? `${tier.role}, and so every member:`
      : tier.role === ASCENDING[ASCENDING.length - 1]
        ? `${tier.role} alone, on top of all of that:`
        : `${tier.role} and up, on top of that:`;
  // The labels are the Policy page's own words, unaltered. Lower-casing them to
  // read as a list corrupted the two that carry proper nouns ("accept
  // completion → Done", "reconcile GitHub state") into things this product does
  // not call them.
  return `- ${who} ${tier.gains.join("; ")}`;
}

/**
 * The block for the controller's system prompt. Static: the same bytes for
 * every conversation, so the per-person facts stay where they belong (the
 * asking person's own role is a live read in the turn context).
 */
export function projectAuthorityPrompt(): string {
  const tiers = authorityTiers().filter((t) => t.gains.length > 0);
  return (
    "## What a project role may do\n\n" +
    "Project roles are a strict tier — " +
    ASCENDING.join(" ⊂ ") +
    " — and every action the server gates names the lowest role that holds " +
    "it, so a role holds everything at or below its own tier. This list is generated from the " +
    "server's authorization map, so it is what will actually be enforced on your " +
    "call, not a summary of it.\n\n" +
    tiers.map(tierLine).join("\n") +
    "\n\nThe tiers above are generated. What follows is NOT: it is maintained by " +
    "hand, because these live in code paths rather than in a table, and it is the " +
    "part most likely to be incomplete. Treat it as the best current account, not " +
    "as the whole of the decision.\n" +
    "- An ORG admin holds all of it on every project, as an audited override, " +
    "whatever their project role is and even with no membership at all.\n" +
    "- A DISABLED account holds none of it, at any tier, including org admin.\n" +
    "- A task's OWNER may accept their own task, and resolve its decision packets and " +
    "recommendations, at contributor or higher, though both gates are otherwise " +
    "maintainer and up.\n" +
    "- An ARCHIVED project refuses every action here to everyone, admins included, " +
    "before role is even considered. Reading still works, and so does restoring it.\n" +
    "- Membership is the outer gate for everyone EXCEPT an org admin, whose " +
    "override is checked first: to a non-member who is not an org admin the " +
    "project does not exist, and the refusal says so rather than naming a role.\n" +
    "- Role is one gate among several. A call can be refused for reasons this list " +
    "says nothing about: a name that is already taken, a task key that does not " +
    "exist, a stage that has no such transition.\n" +
    "- RUNNING AN AGENT has a second gate that is not about role at all. A task run " +
    "bills the TASK OWNER's accounts, never the asker's, so it is refused when the " +
    "task has no owner, or when the owner has not connected that backend or their " +
    "sign-in is unhealthy — however senior the person asking is. Expect this one: " +
    "the list says yes and the server says no, and the useful sentence names the " +
    "owner's account rather than anybody's role.\n" +
    "- THE INSTANCE is a separate question with a simpler answer: everything " +
    "outside a project — users, knowledge bases, skills, MCP connections, global " +
    "agent templates, the audit log, run analytics — is ORG ADMIN ONLY, reads " +
    "included. Open to any signed-in person: creating a project, `whoami`, " +
    "`list_capabilities`, and reading a document out of a knowledge base ALREADY " +
    "ATTACHED to this conversation (that attachment is the grant; reading any other " +
    "knowledge base in the store by id is not). Project role has no bearing on any " +
    "of it.\n" +
    "- This list is the PERSON's authority, not your toolkit. Some of what it grants " +
    "them you have no tool for and never will: accepting a completion, forcing past " +
    "the review gate, resolving a decision, merging. Reading that they hold it is " +
    "not you offering to do it — say they can, on the task page, themselves.\n\n" +
    "USE IT FOR PLANNING, SEQUENCING AND EXPLANATION. It is never grounds for " +
    "refusing something the person asked you to do. This list is static and the " +
    "role you were given is a read taken when the turn began; the server decides at " +
    "the instant of the write, it is the only authority, and its refusal is the " +
    "audited one. So if someone asks for something this list says their role does " +
    "not hold, say that it will probably be refused and why, then MAKE THE CALL " +
    "ANYWAY and let the answer be the answer. Never turn a person away on the " +
    "strength of a table in your own prompt.\n\n" +
    "What it is genuinely for: not offering what will be refused, ordering a " +
    "multi-step request so the step most likely to be refused goes first, and " +
    "explaining a denial well enough to act on — which tier is missing, and who " +
    "could do it instead.\n\n" +
    "One way this list can make you WORSE, so watch for it. It hands you tier " +
    "vocabulary, and most of the refusals above are not about tier: an archived " +
    "project, a disabled account, a non-member, a name already taken. If a " +
    "refusal's own words do not name a role, it was not a role that stopped it — " +
    "do not supply one from here. Report what the server said and name the gate " +
    "you could not identify. \"You need maintainer, ask an admin\" is not an " +
    "incomplete explanation of an archived-project refusal, it is a false one, and " +
    "it sends the person to fix the wrong thing."
  );
}

/**
 * The asking person's own authority over the bound project, for the turn
 * context. `role` is their membership role, or null when they reach the project
 * only through the org-admin override.
 *
 * It names the ROLE and stops. The obvious alternative — have the server
 * compute the held and not-held sets and hand over just those — was put to the
 * controller and it argued the alternative down, convincingly: "a held/not-held
 * set is the answer with the reasoning deleted. When it tells me I don't hold
 * set_file_leases, I cannot tell you why: whether it's maintainer or project
 * admin that's missing, whether promoting someone one tier fixes it or only
 * two." Every question about granting someone a role is a question about a tier
 * OTHER than the asker's, and a set describing only the asker cannot answer one.
 *
 * So the two factors stay separate and the model multiplies them: the tier list
 * is static and generated (`projectAuthorityPrompt`), this is live and personal,
 * and keeping them apart is what lets a refusal be explained instead of merely
 * reported.
 */
export function askerAuthorityLine(role: ProjectRole | null, orgAdmin: boolean): string {
  const here =
    role === null
      ? orgAdmin
        ? "not a member of this project, reaching it through the audited org-admin override, which holds every action on it"
        : "not a member of this project"
      : orgAdmin
        ? `project role ${role}, and org admin, which overrides it and holds every action here`
        : `project role ${role}`;
  // Ruling 309 (the controller's own amendment): tools default to the bound
  // project but take another, so a conversation anchored here can act there —
  // and this line says nothing about there. Naming the reader turns being blind
  // into knowing where to look, which is what ruling 297 settled for tools.
  return (
    `your authority: ${here} · your role on any OTHER project is not in this ` +
    `read — whoami has it, and the tier list in your instructions says what a role holds`
  );
}
