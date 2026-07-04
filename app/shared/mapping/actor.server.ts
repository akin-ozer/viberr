import type Database from "better-sqlite3";
import type { FileActorRef } from "~/schemas/task-file.schema";
import {
  agentBackendName,
  systemIdToName,
} from "~/server/files/actor-ref.server";

/**
 * Actor render shapes — exactly the mock's polymorphic `who`/`actor`/`from`
 * variants (contracts §3.1), resolved from file actor refs.
 *
 * Humans resolve by user id against the users table (identity = id,
 * ruling 6); the resolved name/initials/tone are a denormalized snapshot
 * stored on projected events so they survive member removal. `guest: true`
 * marks a registered user who is NOT a member of the surrounding project.
 * Operator renders as `{ kind: "agent", name: "Operator" }` — NO backend,
 * NO role (AgentGlyph branches on that).
 */

export type ActorRender =
  | {
      kind: "human";
      userId: string;
      name: string;
      initials: string;
      tone: string;
      guest?: true;
    }
  | { kind: "agent"; backend: "codex" | "claude"; name: string; role: string }
  | { kind: "agent"; name: "Operator" }
  | { kind: "system"; name: string };

/** First letters of the first two words, uppercased ("Deniz Şahin" → "DŞ"). */
export function initialsOfName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

interface UserDisplayRow {
  id: string;
  name: string;
  avatar_tone: string | null;
}

/** Cached per-call-site lookup helper for resolving many refs at once. */
export function createActorResolver(
  db: Database.Database,
  options: { projectMemberIds?: Set<string> } = {},
): (ref: FileActorRef) => ActorRender {
  const stmt = db.prepare(`SELECT id, name, avatar_tone FROM users WHERE id = ?`);
  const cache = new Map<string, UserDisplayRow | null>();

  return (ref: FileActorRef): ActorRender => {
    switch (ref.kind) {
      case "operator":
        return { kind: "agent", name: "Operator" };
      case "agent":
        return {
          kind: "agent",
          backend: ref.backend,
          name: agentBackendName(ref.backend),
          role: ref.role,
        };
      case "system":
        return { kind: "system", name: systemIdToName(ref.systemId) };
      case "human": {
        let row = cache.get(ref.userId);
        if (row === undefined) {
          row = (stmt.get(ref.userId) as UserDisplayRow | undefined) ?? null;
          cache.set(ref.userId, row);
        }
        const name = row?.name ?? ref.nameHint ?? ref.userId;
        const guest =
          options.projectMemberIds !== undefined &&
          !options.projectMemberIds.has(ref.userId);
        return {
          kind: "human",
          userId: ref.userId,
          name,
          initials: initialsOfName(name),
          tone: row?.avatar_tone ?? "",
          ...(guest ? { guest: true as const } : {}),
        };
      }
    }
  };
}
