import type { DatabaseSync } from "node:sqlite";
import {
  RUN_INPUTS_TAG,
  type LogLine,
  type RunInputs,
  type RunKind,
} from "~/features/runtime/runtime-types";
import { logger } from "~/server/logging/logger.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { publishRunLogAppended } from "~/server/runtimes/run-events.server";
import { createLineRedactor } from "~/server/runtimes/run-sink.server";
import {
  appendRawLine,
  insertRunLine,
  nextSeq,
} from "~/server/runtimes/run-store.server";
import type { McpToolDenial } from "~/shared/mcp-tools";
import { countLabel } from "~/shared/text/plural";
import { toError } from "~/shared/errors";
import { withoutConfinedFileTools } from "~/server/runtimes/file-tool-policy.server";

/**
 * Ruling 167 — what a run was GIVEN, recorded on the run. One home, because
 * every runtime that starts a run owes the same disclosure.
 *
 * This lived in `specialist-run.server.ts`, which is why for the whole of pass
 * 37 only specialist runs had it: the operator and the controller would have
 * had to import the specialist runtime to disclose anything, and that direction
 * is one the codebase has already refused once (`KB_PRECEDENCE_NOTE` was moved
 * out of here for exactly that reason). The record is a property of a RUN, not
 * of one kind of agent, so it lives beside the run store.
 *
 * P19-G8/G11 is the original rationale and it never mentioned specialists: the
 * Agent-logs console was output-only by construction, so nobody could check the
 * claims the product makes about a run — which knowledge bases it carried,
 * which granted skills actually mounted, which grants resolved to nothing, what
 * canonical state a re-anchored turn was handed.
 */

/**
 * The half of `RunInputs` that describes RESOLVED RESOURCES — everything a run
 * start can know without seeing the turn's own prompt. The remaining three
 * fields belong to the caller that composes the prompt.
 */
export type ResolvedResourceInputs = Omit<
  RunInputs,
  "anchor" | "promptChars" | "directive"
>;

/**
 * ONE builder for the resource half, shared by the fresh-run and resume paths.
 *
 * Not a convenience: `resolveResumeConfinement` exists precisely because resume
 * kept silently dropping half of a run's policy (the XS-1 class), and a
 * disclosure that describes the fresh run accurately and the resumed run
 * approximately would re-create that bug in the surface built to detect it.
 */
export function resolvedResourceInputs(input: {
  cwd: string | null;
  repo: string | null;
  cloned: boolean;
  /** Ruling 195: what the pre-run refresh did to a reused checkout; undefined
   *  on a fresh clone and on a run with no working tree. */
  workspaceRefresh: string | undefined;
  delivers: boolean;
  personaChars: number;
  skills: string[];
  nativeSkills: readonly string[];
  kb: string[];
  mountedMcps: string[];
  unresolvedMcps: string[];
  unhealthyMcps: string[];
  /** Ruling 188: the org servers' marked write tools this run withholds. */
  mcpWriteToolsDenied: McpToolDenial[];
  unresolvedResources: { name: string; reason: string }[];
  deniedTools: string[];
  /**
   * Ruling 167: the names the toolkit reports it mounted (null → no toolkit at
   * all). Handed straight through, because this field is the answer to "what
   * did this run actually get" and a second derivation of the gates is how it
   * came to be wrong.
   */
  toolkit: readonly string[] | null;
  /** Ruling 217(d): `fileWriteRoots` for this run, the derivation its adapter's
   *  hook reads. Set, the file tools leave the denied list for this one. */
  fileWriteRoots?: string[] | null;
}): ResolvedResourceInputs {
  const resolved: ResolvedResourceInputs = {
    cwd: input.cwd,
    repo: input.repo,
    cloned: input.cloned,
    delivers: input.delivers,
    personaChars: input.personaChars,
    skills: {
      granted: input.skills,
      native: [...input.nativeSkills],
      injected: input.skills.filter((s) => !input.nativeSkills.includes(s)),
    },
    knowledge: input.kb,
    mcp: {
      mounted: input.mountedMcps,
      unresolved: input.unresolvedMcps,
      unhealthy: input.unhealthyMcps,
      writeToolsDenied: input.mcpWriteToolsDenied,
    },
    unresolvedResources: input.unresolvedResources,
    tools: {
      denied: input.fileWriteRoots
        ? withoutConfinedFileTools(input.deniedTools)
        : input.deniedTools,
      toolkit: input.toolkit ? [...input.toolkit] : [],
    },
  };
  if (input.fileWriteRoots) resolved.tools.fileWriteRoots = [...input.fileWriteRoots];
  if (input.workspaceRefresh) resolved.workspaceRefresh = input.workspaceRefresh;
  return resolved;
}

/**
 * One-line console summary of `RunInputs` (the expandable detail is the rest).
 *
 * U39-25: `kind` does for the headline what ruling 167 did for the detail
 * rows. Every controller turn opened "supporting engagement · NO canonical
 * anchor": a controller turn is not an engagement, and it is never handed a
 * canonical block, so the capitals flagged the design as a fault on the one
 * line everyone reads. Absent keeps the specialist wording, as it does there.
 */
function runInputsSummary(inputs: RunInputs, kind?: RunKind): string {
  const coordinates = kind === "operator" || kind === "controller";
  const bits: string[] = [
    kind === "controller"
      ? "controller turn"
      : kind === "operator"
        ? "operator drive"
        : inputs.delivers
          ? "delivering engagement"
          : "supporting engagement",
  ];
  if (!coordinates) {
    bits.push(
      inputs.anchor ? `canonical anchor ${inputs.anchor.length} chars` : "NO canonical anchor",
    );
  }
  bits.push(
    `persona ${inputs.personaChars} chars`,
    `prompt ${inputs.promptChars} chars`,
    countLabel(inputs.skills.granted.length, "skill"),
    countLabel(inputs.knowledge.length, "knowledge base"),
    countLabel(inputs.mcp.mounted.length, "MCP server"),
  );
  if (inputs.workspaceRefresh) bits.push(`workspace ${inputs.workspaceRefresh}`);
  const missing =
    inputs.unresolvedResources.length +
    inputs.mcp.unresolved.length +
    inputs.mcp.unhealthy.length;
  if (missing > 0) bits.push(`${countLabel(missing, "grant")} did NOT reach this run`);
  return `Run inputs: ${bits.join(" · ")}`;
}

/**
 * P19-G8/G11 — record what this run was GIVEN, as a console line on the run.
 *
 * The Agent-logs console was output-only by construction: the `LogLine` union
 * has no prompt kind, `agent_runs` has no column for the resolved resource set,
 * and the persona/anchor were built, sent and dropped. So nobody could check the
 * claims the product makes about a run: which knowledge bases it carried, which
 * granted skills actually mounted (natively on Claude, as prompt text on Codex
 * — an asymmetry the product promises to disclose, not hide), which MCP grants
 * resolved to nothing, or which canonical task state a re-anchored turn was
 * handed. The only way to see any of it was to export the session and resume it
 * on your own machine, which FR23 frames as a debug escape hatch, not the
 * record.
 *
 * A LINE, not a column: the same durable, migration-free mechanism the
 * `run·session_missing` and `run·line_lost` markers already use — raw envelope
 * in the canonical `.jsonl`, projection row in `run_log_lines`, and the same
 * `{ } raw` toggle prints it verbatim. It is written at run start, so it sits at
 * the head of the run's block, and it fills the Codex half of the disclosure
 * asymmetry too: Codex's `thread.started` projects an id and nothing else,
 * where Claude's `system·init` at least names its MCP servers.
 *
 * Secrets: the payload is names, counts and canonical task text — never a
 * server CONFIG (which is where a token would live) and never an env value. It
 * is additionally passed through the run sink's own redactor, so a credential
 * pasted into a task goal is scrubbed from the anchor exactly as it would be
 * from a provider line.
 *
 * Best-effort: a run must never fail because its disclosure could not be
 * written.
 */
export function recordRunInputs(
  db: DatabaseSync,
  input: {
    runId: string;
    projectSlug: string;
    taskKey: string;
    threadId: string;
    backend: RealBackend;
    inputs: RunInputs;
    /** U39-25: which kind of run, for the headline; absent reads as a
     *  specialist's, the only kind that once recorded this. */
    kind?: RunKind;
    dataRoot?: string;
  },
): void {
  const now = new Date().toISOString();
  const redact = createLineRedactor();
  const display: LogLine = {
    t: now.slice(11, 19),
    ev: "meta",
    tag: RUN_INPUTS_TAG,
    text: runInputsSummary(input.inputs, input.kind),
    inputs: input.inputs,
  };
  const displayJson = redact(JSON.stringify(display));
  // SAFETY: `displayJson` is `JSON.stringify(display)` with credential VALUES
  // swapped for the redaction marker, which carries no quote or backslash — the
  // substitution rewrites string contents only, never the JSON structure — so
  // the reparse yields the same LogLine with redacted text (same rule as
  // run-sink.server's `redactDisplay`).
  const safe = JSON.parse(displayJson) as LogLine;
  const raw = redact(
    JSON.stringify({
      type: "run_inputs",
      source: "viberr",
      run_id: input.runId,
      backend: input.backend,
      inputs: input.inputs,
    }),
  );
  try {
    appendRawLine(input.backend, input.runId, raw, input.dataRoot);
  } catch {
    // The raw file is best-effort; the DB projection below is the surface the
    // console actually reads.
  }
  try {
    const seq = nextSeq(db, input.runId);
    insertRunLine(db, {
      runId: input.runId,
      seq,
      occurredAt: now,
      raw,
      display: safe,
    });
    publishRunLogAppended({
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: input.runId,
      threadId: input.threadId,
      seq,
    });
  } catch (error) {
    logger.error("run-inputs disclosure could not be persisted", {
      runId: input.runId,
      err: toError(error),
    });
  }
}
