import type { DatabaseSync } from "node:sqlite";
import { listUsers } from "~/server/auth/user-store.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { listDeployedSpecialists } from "./specialist-run.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

/**
 * Mentionable directory for the task-comment composer's @-autocomplete.
 *
 * The composer suggests three groups, mirroring exactly how the server
 * resolves an @mention when a comment is posted (see task-actions.server.ts
 * `MENTION_RE`/`RESERVED_HANDLES` + agent-reply.server.ts
 * `resolveMentionedAgent`):
 *
 *   - agents   : the task/project's deployed specialists. The composer's
 *                handle is the specialist's `id` (space-free and stable); the
 *                resolver matches on name or id, and multi-word names resolve
 *                whole (P13-LV-11). A BACKEND handle is not an agent name: it
 *                resolves only while exactly one specialist runs on that
 *                backend (B-AG2), which is why the reserved group below is
 *                derived from the deployment rather than fixed.
 *   - users    : project members + every registered app user, keyed by the
 *                handle the fan-out resolves on: the email local-part (before
 *                `@`) OR the first name, both lowercased. We surface the email
 *                local-part as the canonical handle (stable, unambiguous) and
 *                keep name for the row label + Avatar initials.
 *   - reserved : the generic role/backend handles the routing regex honours —
 *                `operator`, `agent`, and the backend handles that still name
 *                ONE agent here — with a short label.
 *
 * This is READ-ONLY loader data: it never mutates the store. It is a NEW file
 * so the sibling *.server.ts mutation modules stay untouched.
 */

export interface MentionableAgent {
  handle: string;
  name: string;
  role: string;
  backend: RealBackend;
}

export interface MentionableUser {
  handle: string;
  name: string;
  email: string;
}

export interface MentionableReserved {
  handle: string;
  label: string;
}

export interface Mentionables {
  agents: MentionableAgent[];
  users: MentionableUser[];
  reserved: MentionableReserved[];
}

/** The role handles that route regardless of what is deployed. Mirrors
 *  task-actions.server.ts `RESERVED_HANDLES`; the backend handles are appended
 *  per project by `backendHandles` below. */
const RESERVED_ROLES: MentionableReserved[] = [
  { handle: "operator", label: "Operator" },
  // F19-12: the picker subline is rendered copy, so it uses the SHIPPED
  // vocabulary — "delivering agent" (execution-profile.tsx's "Assign delivering
  // agent" / "Delivering agent" header). "Primary specialist" is retired
  // vocabulary (D9/Q17-5, INTENT §6.5): the model is `engagements[]` with one
  // `delivers: true`, and `@agent` resolves to exactly that engagement.
  { handle: "agent", label: "Delivering agent" },
];

const BACKEND_LABEL = {
  claude: "Claude",
  codex: "Codex",
} satisfies Record<RealBackend, string>;

/**
 * The backend handles this project can still be tagged by, with the profile
 * each one reaches.
 *
 * B-AG2: `@claude` names a RUNTIME, not an agent, so it engages nobody once two
 * claude profiles are deployed. The composer used to offer it unconditionally,
 * so on exactly that project every suggested `@claude` produced a comment that
 * routed nowhere — the suggestion promised a target the resolver refuses. An
 * ambiguous backend is therefore not offered at all (its profiles are listed
 * individually in the agents group, which is what the human must tag); an
 * unambiguous one names the specialist it reaches so the promise is checkable.
 */
function backendHandles(
  specialists: readonly { name: string; backend: RealBackend }[],
): MentionableReserved[] {
  const out: MentionableReserved[] = [];
  for (const backend of ["claude", "codex"] as const) {
    const covered = specialists.filter((sp) => sp.backend === backend);
    if (covered.length > 1) continue;
    out.push({
      handle: backend,
      label: covered[0]
        ? `${BACKEND_LABEL[backend]} specialist — ${covered[0].name}`
        : `${BACKEND_LABEL[backend]} specialist`,
    });
  }
  return out;
}

/** Email local-part (before the first `@`), lowercased — the handle the
 *  server's mention fan-out resolves users on. */
function emailLocalPart(email: string): string {
  return (email.split("@")[0] ?? "").toLowerCase();
}

/**
 * Build the mentionable directory for a task's composer.
 *
 * `taskKey` is accepted for parity with the other task-scoped queries and to
 * leave room for per-task narrowing later; today the mentionable agents/users
 * are project-scoped (a comment can @mention any deployed specialist and any
 * registered user, matching the server-side resolver's scope).
 */
export function getMentionables(
  db: DatabaseSync,
  projectSlug: string,
  _taskKey: string,
  opts: { dataRoot?: string } = {},
): Mentionables {
  const ctx = { dataRoot: opts.dataRoot };

  // Agents: the project's deployed specialists. The handle is the PROFILE ID —
  // a stable, space-free token that the resolver has always matched. The
  // composer inserts the display NAME (which now also resolves, P13-LV-11), and
  // the menu shows the id so a human can type it directly.
  const agentSeen = new Set<string>();
  const agents: MentionableAgent[] = [];
  for (const sp of listDeployedSpecialists(projectSlug, ctx)) {
    const handle = sp.id.toLowerCase();
    if (agentSeen.has(handle)) continue;
    agentSeen.add(handle);
    agents.push({
      handle,
      name: sp.name,
      role: sp.role,
      backend: sp.backend,
    });
  }

  // Users: project members first (in membership order), then any remaining
  // registered, non-disabled app users. Keyed by email local-part; skipped
  // when a member id has no matching user row or the handle collides.
  const memberOrder = new Map<string, number>();
  const file = readProjectFile({ projectSlug, ...ctx });
  if (file) {
    file.parsed.frontmatter.members.forEach((m, i) => {
      memberOrder.set(m.userId, i);
    });
  }

  const userSeen = new Set<string>();
  const users: MentionableUser[] = [];
  const rows = listUsers(db)
    .filter((u) => !u.disabled)
    .sort((a, b) => {
      const am = memberOrder.has(a.id);
      const bm = memberOrder.has(b.id);
      if (am && bm) return memberOrder.get(a.id)! - memberOrder.get(b.id)!;
      if (am) return -1;
      if (bm) return 1;
      return 0; // listUsers is already created_at ASC for the non-member tail
    });
  for (const u of rows) {
    const handle = emailLocalPart(u.email);
    if (!handle || userSeen.has(handle)) continue;
    userSeen.add(handle);
    users.push({ handle, name: u.name, email: u.email });
  }

  return {
    agents,
    users,
    reserved: [...RESERVED_ROLES, ...backendHandles(agents)],
  };
}
