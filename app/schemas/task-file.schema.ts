import { z } from "zod";
import {
  diagError,
  diagInfo,
  diagWarning,
  type FileDiagnostic,
} from "./file-diagnostics";

/**
 * Zod schemas + tolerant parser for the `task.md` frontmatter and packet
 * (canonical file format documented in docs/architecture/file-formats.md).
 *
 * Tolerance contract (CONVENTIONS "Behavior rules"):
 * - unknown frontmatter fields are PRESERVED (returned separately, re-written
 *   verbatim by the serializer);
 * - missing/invalid fields produce structured FileDiagnostics + a safe
 *   fallback — the parser never throws and never drops the task.
 *
 * Readiness values are the canonical 4-value enum ONLY (orchestrator
 * ruling 1). "accepted" is a derived display state, never stored here.
 */

// ---------------------------------------------------------------- enums

export const READINESS_VALUES = [
  "ready",
  "input_required",
  "inconsistency_risk_detected",
  "blocked",
] as const;
export type Readiness = (typeof READINESS_VALUES)[number];

export const WAITING_VALUES = ["human", "agent", "none"] as const;
export type Waiting = (typeof WAITING_VALUES)[number];

export const VALIDATION_VALUES = ["healthy", "changed", "failing", "none"] as const;
export type Validation = (typeof VALIDATION_VALUES)[number];

/** The 9 timeline event types (cross-cutting contracts §1.3). Parsers keep
 * unknown strings as-is (renderer falls back to comment meta). */
export const TIMELINE_EVENT_TYPES = [
  "comment",
  "completion",
  "github",
  "policy",
  "quality",
  "transition",
  "blocked",
  "agent",
  "assign",
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

/** Stable packet-option kinds (orchestrator ruling 7). Dispatch on these,
 * never on English titles. */
export const PACKET_OPTION_KINDS = [
  "accept_completion",
  "request_edit",
  "block_on_policy",
  "hold_runtime_debug",
  "redirect",
  "custom",
] as const;
export type PacketOptionKind = (typeof PACKET_OPTION_KINDS)[number];

// ------------------------------------------------------------ sub-shapes

/** Agent reference (specialist/reviewers): profile id is the join key
 * (ruling: never join by role string). backend+role are display data. */
export const agentRefSchema = z
  .object({
    profileId: z.string().min(1),
    backend: z.enum(["codex", "claude"]),
    role: z.string().min(1),
  })
  .loose();
export type AgentRef = z.infer<typeof agentRefSchema>;

/** Operator assignment — stage id captured when the operator attached
 * (ruling 16: store the stage id; UI renders "stage <1-based index>"). */
export const operatorRefSchema = z
  .object({ assignedAtStageId: z.string().min(1) })
  .loose();
export type OperatorRef = z.infer<typeof operatorRefSchema>;

/** Operator recommendation kinds — a supervised operator RECOMMENDS an action
 * (rather than performing it); the task UI renders each as a one-click card a
 * human accepts (applies) or dismisses. Distinct from packets (single decision):
 * a task can carry several pending recommendations at once. */
export const RECOMMENDATION_KINDS = [
  "assign_specialist",
  "assign_reviewer",
  "transition",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export const recommendationSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(RECOMMENDATION_KINDS),
    /** assign_specialist / assign_reviewer — the deployed specialist to engage. */
    profileId: z.string().optional(),
    /** transition — the target stage id. */
    toStageId: z.string().optional(),
    /** Button label, e.g. "Assign Dev as primary specialist". */
    label: z.string().min(1),
    /** The operator's reasoning for the recommendation (rendered under it). */
    detail: z.string().default(""),
  })
  .loose();
export type Recommendation = z.infer<typeof recommendationSchema>;

export const prRefSchema = z
  .object({
    number: z.number().int().min(1),
    /** "review" | "merged" today; Phase 7 adds real GitHub states. */
    state: z.string().min(1),
    title: z.string(),
  })
  .loose();
export type PrRef = z.infer<typeof prRefSchema>;

/** GitHub projection cache mirrored into the file by the (future) Phase-7
 * reconciler — commits + change stats. Not human-edited truth. */
export const githubCacheSchema = z
  .object({
    commits: z
      .array(z.object({ sha: z.string(), msg: z.string() }).loose())
      .default([]),
    changed: z
      .object({
        files: z.number().int(),
        add: z.number().int(),
        del: z.number().int(),
      })
      .loose()
      .nullable()
      .default(null),
  })
  .loose();
export type GithubCache = z.infer<typeof githubCacheSchema>;

export const packetObservationSchema = z
  .object({
    k: z.string(),
    v: z.string(),
    code: z.boolean().default(false),
  })
  .loose();
export type PacketObservation = z.infer<typeof packetObservationSchema>;

export const packetOptionSchema = z
  .object({
    kind: z.enum(PACKET_OPTION_KINDS),
    t: z.string().min(1),
    d: z.string().default(""),
    rec: z.boolean().default(false),
    accept: z.boolean().optional(),
    /** Pre-authored timeline text written when this option is chosen. */
    ev: z.string().optional(),
  })
  .loose();
export type PacketOption = z.infer<typeof packetOptionSchema>;

export const taskPacketSchema = z
  .object({
    type: z.enum(["input", "blocked"]),
    /** Pill label, e.g. "Completion report" | "Blocked decision". */
    kind: z.string().min(1),
    /** Actor ref string — "operator" in every observed packet. */
    from: z.string().default("operator"),
    title: z.string().min(1),
    body: z.string().default(""),
    observations: z.array(packetObservationSchema).default([]),
    options: z.array(packetOptionSchema).default([]),
  })
  .loose();
export type TaskPacket = z.infer<typeof taskPacketSchema>;

// -------------------------------------------------------- frontmatter

/** Strict target shape — what a fully valid task.md frontmatter parses to. */
export const taskFrontmatterSchema = z.object({
  key: z.string().regex(/^[A-Za-z]+-\d+$/),
  title: z.string().min(1),
  stage: z.string().min(1),
  readiness: z.enum(READINESS_VALUES),
  waiting: z.enum(WAITING_VALUES),
  ownerUserId: z.string().nullable(),
  specialist: agentRefSchema.nullable(),
  reviewers: z.array(agentRefSchema),
  operator: operatorRefSchema.nullable(),
  /** Pending operator recommendations rendered as one-click action cards. */
  recommendations: z.array(recommendationSchema),
  urgent: z.boolean(),
  validation: z.enum(VALIDATION_VALUES),
  branch: z.string().nullable(),
  /** Task-level repo override; null → project default repo. */
  repo: z.string().nullable(),
  pr: prRefSchema.nullable(),
  github: githubCacheSchema.nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type TaskFrontmatter = z.infer<typeof taskFrontmatterSchema>;

export const TASK_FRONTMATTER_KEYS: readonly (keyof TaskFrontmatter)[] = [
  "key",
  "title",
  "stage",
  "readiness",
  "waiting",
  "ownerUserId",
  "specialist",
  "reviewers",
  "operator",
  "recommendations",
  "urgent",
  "validation",
  "branch",
  "repo",
  "pr",
  "github",
  "createdAt",
  "updatedAt",
];

export interface TolerantTaskFrontmatterResult {
  frontmatter: TaskFrontmatter;
  /** Unknown fields, preserved verbatim for round-trip writes. */
  unknown: Record<string, unknown>;
  diagnostics: FileDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runs `schema` over `value`; on failure records a diagnostic and returns
 * `fallback`. Absent (undefined) values only diagnose when `required`. */
function tolerant<T>(
  diagnostics: FileDiagnostic[],
  path: string,
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
  options: { required?: boolean; severity?: "info" | "warning" } = {},
): T {
  if (value === undefined) {
    if (options.required) {
      const make = options.severity === "info" ? diagInfo : diagWarning;
      diagnostics.push(
        make(
          "frontmatter.missing_field",
          `Frontmatter field \`${path}\` is missing — using ${JSON.stringify(fallback)}.`,
          path,
        ),
      );
    }
    return fallback;
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const make = options.severity === "info" ? diagInfo : diagWarning;
  diagnostics.push(
    make(
      "frontmatter.invalid_field",
      `Frontmatter field \`${path}\` is invalid (${result.error.issues[0]?.message ?? "unparseable"}) — using ${JSON.stringify(fallback)}.`,
      path,
    ),
  );
  return fallback;
}

/**
 * Tolerant frontmatter parse. `fallbackKey` (the task directory name) rescues
 * files whose `key` field is missing/invalid.
 */
export function parseTaskFrontmatter(
  raw: unknown,
  context: { fallbackKey?: string } = {},
): TolerantTaskFrontmatterResult {
  const diagnostics: FileDiagnostic[] = [];
  const data: Record<string, unknown> = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    diagnostics.push(
      diagError(
        "frontmatter.not_a_map",
        "Frontmatter is not a YAML mapping — all fields fall back to defaults.",
        undefined,
        true,
      ),
    );
  }

  // key — identity; unidentifiable without a directory-name fallback.
  let key: string;
  const keyResult = taskFrontmatterSchema.shape.key.safeParse(data.key);
  if (keyResult.success) {
    key = keyResult.data;
    if (context.fallbackKey && key !== context.fallbackKey) {
      diagnostics.push(
        diagError(
          "frontmatter.key_mismatch",
          `Frontmatter key \`${key}\` does not match the task directory \`${context.fallbackKey}\` — the directory name wins.`,
          "key",
        ),
      );
      key = context.fallbackKey;
    }
  } else if (context.fallbackKey) {
    key = context.fallbackKey;
    diagnostics.push(
      diagWarning(
        "frontmatter.missing_key",
        `Frontmatter has no valid \`key\` — inferred \`${key}\` from the task directory.`,
        "key",
      ),
    );
  } else {
    key = "UNKNOWN-0";
    diagnostics.push(
      diagError(
        "frontmatter.missing_key",
        "Frontmatter has no valid `key` and no directory fallback — the task cannot be identified.",
        "key",
        true,
      ),
    );
  }

  const frontmatter: TaskFrontmatter = {
    key,
    title: tolerant(
      diagnostics,
      "title",
      data.title,
      taskFrontmatterSchema.shape.title,
      key,
      { required: true },
    ),
    stage: tolerant(
      diagnostics,
      "stage",
      data.stage,
      taskFrontmatterSchema.shape.stage,
      "triage",
      { required: true },
    ),
    readiness: tolerant(
      diagnostics,
      "readiness",
      data.readiness,
      z.enum(READINESS_VALUES),
      "ready",
      { required: true },
    ),
    waiting: tolerant(
      diagnostics,
      "waiting",
      data.waiting,
      z.enum(WAITING_VALUES),
      "none",
      { required: true },
    ),
    ownerUserId: tolerant(
      diagnostics,
      "ownerUserId",
      data.ownerUserId,
      taskFrontmatterSchema.shape.ownerUserId,
      null,
    ),
    specialist: tolerant(
      diagnostics,
      "specialist",
      data.specialist,
      taskFrontmatterSchema.shape.specialist,
      null,
    ),
    // `reviewers` was formerly `consultants`; read the old key when a
    // pre-rename task.md hasn't been rewritten yet (back-compat migration).
    reviewers: tolerant(
      diagnostics,
      "reviewers",
      data.reviewers ?? data.consultants,
      taskFrontmatterSchema.shape.reviewers,
      [],
    ),
    operator: tolerant(
      diagnostics,
      "operator",
      data.operator,
      taskFrontmatterSchema.shape.operator,
      null,
    ),
    recommendations: tolerant(
      diagnostics,
      "recommendations",
      data.recommendations,
      taskFrontmatterSchema.shape.recommendations,
      [],
    ),
    // urgent is an optional boolean by contract — absent means false, silently.
    urgent: tolerant(
      diagnostics,
      "urgent",
      data.urgent,
      taskFrontmatterSchema.shape.urgent,
      false,
    ),
    validation: tolerant(
      diagnostics,
      "validation",
      data.validation,
      z.enum(VALIDATION_VALUES),
      "none",
      { required: true, severity: "info" },
    ),
    branch: tolerant(
      diagnostics,
      "branch",
      data.branch,
      taskFrontmatterSchema.shape.branch,
      null,
    ),
    repo: tolerant(
      diagnostics,
      "repo",
      data.repo,
      taskFrontmatterSchema.shape.repo,
      null,
    ),
    pr: tolerant(diagnostics, "pr", data.pr, taskFrontmatterSchema.shape.pr, null),
    github: tolerant(
      diagnostics,
      "github",
      data.github,
      taskFrontmatterSchema.shape.github,
      null,
    ),
    createdAt: tolerant(
      diagnostics,
      "createdAt",
      data.createdAt,
      taskFrontmatterSchema.shape.createdAt,
      null,
    ),
    updatedAt: tolerant(
      diagnostics,
      "updatedAt",
      data.updatedAt,
      taskFrontmatterSchema.shape.updatedAt,
      null,
    ),
  };

  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    // `consultants` is the pre-rename alias of `reviewers` — already absorbed
    // above; don't preserve it as "unknown" or a rewrite would emit both keys.
    if (k === "consultants") continue;
    if (!(TASK_FRONTMATTER_KEYS as readonly string[]).includes(k)) {
      unknown[k] = v;
    }
  }

  return { frontmatter, unknown, diagnostics };
}

/** Tolerant packet parse (the fenced yaml block under `## Packet`). Returns
 * null + diagnostics when the block cannot be salvaged. */
export function parseTaskPacket(raw: unknown): {
  packet: TaskPacket | null;
  diagnostics: FileDiagnostic[];
} {
  if (raw === undefined || raw === null) return { packet: null, diagnostics: [] };
  const result = taskPacketSchema.safeParse(raw);
  if (result.success) {
    const diagnostics: FileDiagnostic[] = [];
    const recCount = result.data.options.filter((o) => o.rec).length;
    if (result.data.options.length > 0 && recCount !== 1) {
      diagnostics.push(
        diagInfo(
          "packet.rec_count",
          `Packet has ${recCount} recommended options (expected exactly 1).`,
          "packet.options",
        ),
      );
    }
    return { packet: result.data, diagnostics };
  }
  const issue = result.error.issues[0];
  return {
    packet: null,
    diagnostics: [
      diagError(
        "packet.invalid",
        `Packet block is invalid at \`${issue?.path.join(".") || "packet"}\` (${issue?.message ?? "unparseable"}) — packet ignored.`,
        "packet",
      ),
    ],
  };
}

// ------------------------------------------------------- actor refs

/**
 * Actor reference variants as encoded in files (contracts §3.1):
 *   humans   →  user:<userId> (Optional Display Name)
 *   agents   →  agent:<backend>/<role-slug>
 *   operator →  operator
 *   system   →  system:<id>            (only "system:policy-engine" observed)
 */
export type FileActorRef =
  | { kind: "human"; userId: string; nameHint: string | null }
  | { kind: "agent"; backend: "codex" | "claude"; role: string }
  | { kind: "operator" }
  | { kind: "system"; systemId: string };

// -------------------------------------------------- timeline events

/** One parsed `###` timeline entry. Newest-first in the file and here. */
export interface TaskFileEvent {
  /** UTC ISO 8601. */
  occurredAt: string;
  /** One of TIMELINE_EVENT_TYPES, or an unknown string kept tolerantly. */
  type: string;
  actor: FileActorRef;
  /** Completion events only ("Completion report" | "Completion accepted"). */
  title: string | null;
  /** RichText micro-format: **bold**, `code`, @mention. */
  text: string;
  /** Comments only — routed to the operator/agent (toagent card tint). */
  toAgent: boolean;
  /** Completion events only. add/del are signed display strings ("+14"). */
  evidence: { label: string; add: string; del: string }[] | null;
}

/** Full parsed task file (see app/server/files/task-file.server.ts). */
export interface ParsedTaskFile {
  frontmatter: TaskFrontmatter;
  unknownFrontmatter: Record<string, unknown>;
  goal: string;
  packet: TaskPacket | null;
  /** Newest first. */
  timeline: TaskFileEvent[];
  /** Unrecognized `## Section` blocks, preserved verbatim in order. */
  extraSections: { title: string; raw: string }[];
}
