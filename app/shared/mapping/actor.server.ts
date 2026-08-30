import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef } from "~/schemas/task-file.schema";
import {
  agentBackendName,
  agentRoleDisplay,
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
 *
 * READ-TIME REFRESH (E1): the baked snapshot goes stale on user rename —
 * the content-hash short-circuit means historical events never re-project.
 * Read paths therefore overlay the CURRENT users-table name/initials/tone
 * via `createActorRenderOverlay`; the snapshot remains the fallback for
 * deleted users (their events keep the last-known identity).
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
  // Ruling 99: the instance controller — same backend-less shape as the
  // operator (it is machinery, not a deployed profile).
  | { kind: "agent"; name: "Controller" }
  | { kind: "system"; name: string };

/** The human variant, named so it can be built in steps (the `guest` marker is
 *  set only for a non-member — see `createActorResolver`). */
type HumanActorRender = Extract<ActorRender, { kind: "human" }>;

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

/**
 * Read-time identity refresh for STORED ActorRender snapshots (E1): human
 * actors are re-resolved against the current users table so a rename
 * reflects everywhere immediately — no reprojection required. A missing
 * user row (deleted account) keeps the baked snapshot; non-human actors
 * pass through untouched. Cached per instance — create one per request/query
 * and map many rows through it.
 */
export function createActorRenderOverlay(
  db: DatabaseSync,
): (actor: ActorRender) => ActorRender {
  const stmt = db.prepare(`SELECT id, name, avatar_tone FROM users WHERE id = ?`);
  const cache = new Map<string, UserDisplayRow | null>();

  return (actor: ActorRender): ActorRender => {
    if (actor.kind !== "human") return actor;
    let row = cache.get(actor.userId);
    if (row === undefined) {
      // SAFETY: UserDisplayRow names exactly the three columns the statement
      // above selects — `users.id`/`name` are NOT NULL and `avatar_tone` is the
      // nullable one, per 0001_baseline. An id with no account yields no row.
      row = (stmt.get(actor.userId) as UserDisplayRow | undefined) ?? null;
      cache.set(actor.userId, row);
    }
    if (!row) return actor; // deleted user → baked snapshot survives
    return {
      ...actor,
      name: row.name,
      initials: initialsOfName(row.name),
      tone: row.avatar_tone ?? actor.tone,
    };
  };
}

/** Cached per-call-site lookup helper for resolving many refs at once.
 *
 * `agentNames` (profile id → display name, from run rows — see
 * `agentNamesByProfile`) makes an agent actor render under the agent's OWN name
 * (e.g. "Reviewer"), not its runtime/backend label ("Claude"). Without it,
 * agents fall back to the backend label — historical behaviour, kept so a
 * caller with no project context never crashes. */
export function createActorResolver(
  db: DatabaseSync,
  options: { projectMemberIds?: Set<string>; agentNames?: Map<string, string> } = {},
): (ref: FileActorRef) => ActorRender {
  const stmt = db.prepare(`SELECT id, name, avatar_tone FROM users WHERE id = ?`);
  const cache = new Map<string, UserDisplayRow | null>();

  return (ref: FileActorRef): ActorRender => {
    switch (ref.kind) {
      case "operator":
        return { kind: "agent", name: "Operator" };
      case "controller":
        return { kind: "agent", name: "Controller" };
      case "agent":
        return {
          kind: "agent",
          backend: ref.backend,
          // The agent's own name is the identity; the backend is the runtime,
          // not who acted. Fall back to the backend label only when the name is
          // unknown (nameless seed/legacy run, or no project context).
          name: options.agentNames?.get(ref.profileId) ?? agentBackendName(ref.backend),
          role: agentRoleDisplay(ref),
        };
      case "system":
        return { kind: "system", name: systemIdToName(ref.systemId) };
      // Tolerantly-kept unrecognized author (D7) — render as a system chip so
      // the event stays visible instead of vanishing.
      case "unknown":
        return { kind: "system", name: "Unknown actor" };
      case "human": {
        let row = cache.get(ref.userId);
        if (row === undefined) {
          // SAFETY: same statement, same three-column correspondence as
          // `createActorRenderOverlay` above.
          row = (stmt.get(ref.userId) as UserDisplayRow | undefined) ?? null;
          cache.set(ref.userId, row);
        }
        const name = row?.name ?? ref.nameHint ?? ref.userId;
        const guest =
          options.projectMemberIds !== undefined &&
          !options.projectMemberIds.has(ref.userId);
        const render: HumanActorRender = {
          kind: "human",
          userId: ref.userId,
          name,
          initials: initialsOfName(name),
          tone: row?.avatar_tone ?? "",
        };
        // `guest` is a marker: the key is ABSENT for a member, never `false`.
        if (guest) render.guest = true;
        return render;
      }
    }
  };
}
