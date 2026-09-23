import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
} from "~/server/files/frontmatter.server";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  CONTROLLER_SECTION_LABEL,
  CONTROLLER_UNLOCK_ENV,
  CONTROLLER_UNLOCK_VALUE,
} from "~/shared/controller-locks";

/**
 * Ruling 390 (F39-17): the controller's standing ask for a resource it cannot
 * grant itself.
 *
 * Live in pass 39 the owner's instance-wide rule ("the controller runs opus at
 * high; every other agent runs luna at MAX") was broken on a new deployment,
 * because nothing on the instance held it. Told once, in a conversation that
 * had since ended, it reached the next turn through nothing at all.
 *
 * The controller worked the mechanism out correctly on its own: a skill is
 * injected verbatim every turn, a knowledge base is injected as an INDEX of
 * names and headings, and it may not edit its own profile, skill or handbook
 * (ruling 108 locks all three, org admins included). So it wrote the rule into
 * a NEW org knowledge base with the rule as the heading — and then could not
 * attach it to itself. Its own words: "I created the resource, I cannot grant
 * it to myself." The document sat in the store, unread, and the ask existed
 * only as prose in the conversation that would end and take it with it.
 *
 * Owner's call (2026-09-22): keep the controller out of its own resources, and
 * give the ask somewhere durable and human-visible to live instead. This is
 * that record.
 *
 * It resolves OUTSIDE the app, and says so. Ruling 108 makes controller grants
 * a deployment decision with no in-app override anywhere, so this surface never
 * offers a button that does not exist: it names the environment variable, the
 * value, and the restart, and then gets out of the way.
 */

/** Which kind of resource a request is for — the three ruling-108 sections. */
export const REQUESTABLE_KINDS = ["skills", "kb", "mcps"] as const;
export type RequestableKind = (typeof REQUESTABLE_KINDS)[number];

export const RESOURCE_REQUEST_STATUSES = [
  "open",
  "granted",
  "declined",
  "withdrawn",
] as const;
export type ResourceRequestStatus = (typeof RESOURCE_REQUEST_STATUSES)[number];

const resourceRequestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(REQUESTABLE_KINDS),
  /** The resource's store name, exactly as `list_knowledge_bases` prints it. */
  name: z.string().min(1),
  /** Why the controller wants it — the sentence an admin reads. */
  reason: z.string().default(""),
  askedAt: z.string().min(1),
  askedByUserId: z.string().min(1),
  askedByLabel: z.string().default(""),
  status: z.enum(RESOURCE_REQUEST_STATUSES).default("open"),
  closedAt: z.string().nullable().default(null),
  closedByLabel: z.string().nullable().default(null),
});
export type ResourceRequest = z.infer<typeof resourceRequestSchema>;

/**
 * Where the record lives: beside the controller's profile, never inside it.
 * The profile is what the controller is READ BY and ruling 108 locks it; this
 * file is a record ABOUT the controller, so writing it changes nothing about
 * how the controller is loaded.
 */
export function controllerRequestsFilePath(dataRoot?: string): string {
  return path.join(getDataRoot(dataRoot), "agents", "controller-requests.md");
}

const HEADER =
  "Resource grants the controller has asked for and cannot make itself " +
  "(ruling 390). Each one names the deployment change that answers it.";

/** Every request on file, newest first. Empty for a store that has none. */
export function readResourceRequests(dataRoot?: string): ResourceRequest[] {
  const file = controllerRequestsFilePath(dataRoot);
  if (!existsSync(file)) return [];
  const { data } = splitFrontmatter(readFileSync(file, "utf8"));
  const rows = z
    .object({ requests: z.array(z.unknown()).catch([]) })
    .catch({ requests: [] })
    .parse(data).requests;
  const parsed: ResourceRequest[] = [];
  // Per-ROW tolerance, like `verdicts` in a task file: one malformed entry
  // drops itself and never the rest, because a whole-file wipe would silently
  // discard asks a person has not answered yet.
  for (const row of rows) {
    const result = resourceRequestSchema.safeParse(row);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

/** The open ones, which are the only ones anybody has to act on. */
export function openResourceRequests(dataRoot?: string): ResourceRequest[] {
  return readResourceRequests(dataRoot).filter((r) => r.status === "open");
}

function writeAll(rows: ResourceRequest[], dataRoot?: string): void {
  const file = controllerRequestsFilePath(dataRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(
    file,
    serializeFrontmatterFile({ requests: rows }, {}, HEADER),
  );
}

export interface RaiseResourceRequestInput {
  kind: RequestableKind;
  name: string;
  reason: string;
  askedByUserId: string;
  askedByLabel: string;
  now?: string;
}

/** What {@link raiseResourceRequest} answers: the row that now carries the ask,
 *  and whether this call is what raised it. */
export interface RaiseResourceRequestOutcome {
  request: ResourceRequest;
  created: boolean;
}

/**
 * Raise one, or return the OPEN one that already covers it.
 *
 * Idempotent per (kind, name) while open: a controller that re-reads its own
 * context every turn must be able to call this without stacking duplicates on
 * an admin, and a second ask for the same thing is the same ask.
 */
export function raiseResourceRequest(
  input: RaiseResourceRequestInput,
  dataRoot?: string,
): RaiseResourceRequestOutcome {
  const rows = readResourceRequests(dataRoot);
  const existing = rows.find(
    (r) => r.status === "open" && r.kind === input.kind && r.name === input.name,
  );
  if (existing) return { request: existing, created: false };
  const request: ResourceRequest = {
    id: newId("rq"),
    kind: input.kind,
    name: input.name,
    reason: input.reason.trim(),
    askedAt: input.now ?? new Date().toISOString(),
    askedByUserId: input.askedByUserId,
    askedByLabel: input.askedByLabel,
    status: "open",
    closedAt: null,
    closedByLabel: null,
  };
  writeAll([request, ...rows], dataRoot);
  return { request, created: true };
}

/** Close one. Returns null when no OPEN request carries that id. */
export function closeResourceRequest(
  id: string,
  status: Exclude<ResourceRequestStatus, "open">,
  closedByLabel: string,
  dataRoot?: string,
  now?: string,
): ResourceRequest | null {
  const rows = readResourceRequests(dataRoot);
  const at = rows.findIndex((r) => r.id === id && r.status === "open");
  if (at === -1) return null;
  const closed: ResourceRequest = {
    ...rows[at]!,
    status,
    closedAt: now ?? new Date().toISOString(),
    closedByLabel,
  };
  const next = [...rows];
  next[at] = closed;
  writeAll(next, dataRoot);
  return closed;
}

/**
 * What answering this request actually takes — the whole point of the record.
 *
 * Ruling 108 put controller grants outside the app on purpose, so a surface
 * that rendered a Grant button would be promising something no code can do.
 * This sentence is what goes on the settings panel and into the controller's
 * own context instead.
 */
export function resourceRequestRemedy(kind: RequestableKind): string {
  return (
    `${CONTROLLER_SECTION_LABEL[kind]} are deployment-locked (ruling 108): set ` +
    `${CONTROLLER_UNLOCK_ENV[kind]}=${CONTROLLER_UNLOCK_VALUE} and restart, then add it ` +
    `on the Controller tab. There is no in-app grant while the section is locked.`
  );
}

/** One line per open request for the controller's own turn context, so it can
 *  see it has already asked rather than asking again or claiming it cannot. */
export function openRequestsContextLine(dataRoot?: string): string {
  const open = openResourceRequests(dataRoot);
  if (open.length === 0) return "";
  const rows = open
    .map(
      (r) =>
        `- ${CONTROLLER_SECTION_LABEL[r.kind]}: \`${r.name}\` (asked ${r.askedAt} by ${r.askedByLabel || "someone"}) — ${resourceRequestRemedy(r.kind)}`,
    )
    .join("\n");
  return (
    `\n## Resource grants you have asked for and do not have yet\n` +
    `You raised these; they are on the record and an admin has not answered them. ` +
    `Do not ask again, and do not describe the resource as if you can read it.\n${rows}\n`
  );
}
