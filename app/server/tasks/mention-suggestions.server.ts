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
 *                handle is the specialist's `name` lowercased — the same value
 *                `handleMatchesSpecialist` matches on (name / id / backend).
 *   - users    : project members + every registered app user, keyed by the
 *                handle the fan-out resolves on: the email local-part (before
 *                `@`) OR the first name, both lowercased. We surface the email
 *                local-part as the canonical handle (stable, unambiguous) and
 *                keep name for the row label + Avatar initials.
 *   - reserved : the generic backend/role handles the routing regex honours —
 *                `operator`, `agent`, `claude`, `codex` — with a short label.
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

/** The generic backend/role handles, in the order the composer lists them.
 *  Mirrors task-actions.server.ts `RESERVED_HANDLES`. */
const RESERVED: MentionableReserved[] = [
  { handle: "operator", label: "Operator" },
  { handle: "agent", label: "Primary specialist" },
  { handle: "claude", label: "Claude specialist" },
  { handle: "codex", label: "Codex specialist" },
];

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

  // Agents: the project's deployed specialists. Handle = name lowercased,
  // de-duped (two deployments could share a display name).
  const agentSeen = new Set<string>();
  const agents: MentionableAgent[] = [];
  for (const sp of listDeployedSpecialists(projectSlug, ctx)) {
    const handle = sp.name.toLowerCase();
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

  return { agents, users, reserved: RESERVED };
}
