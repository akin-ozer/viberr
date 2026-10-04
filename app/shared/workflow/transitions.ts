import type {
  Boundary,
  StageDef,
  WorkflowBoundary,
} from "~/schemas/project-file.schema";

/**
 * Transition-chain maintenance for a project's workflow graph.
 *
 * P13-D-1 (owner ruling 2026-07-25): FR6 promises admins can define stages,
 * allowed transitions and approval boundaries. Stages shipped
 * (add/rename/remove/reorder) and boundaries shipped (`setTransitionBoundary`
 * flips an existing rule), but `frontmatter.workflow` had NO create path — the
 * only writer that ever grew it was project creation. An admin who added a 6th
 * stage got a board column no governed flow could reach: `transitionStage`
 * refused it except as a manual admin/maintainer move and the operator's
 * `nextStages` (built purely from `workflow`) was empty for it. The ruling is to
 * auto-wire the chain on stage add/remove rather than build a transitions
 * editor, so these helpers are the single place that knows the shape.
 *
 * The model they maintain: **`workflow` is a chain that follows `stages` order**
 * — one rule per consecutive pair. Every stage then has an in-edge (except the
 * entry stage) and an out-edge (except the terminal stage), so the terminal
 * stage stays reachable and no column is stranded. `addStage` splices, and
 * `removeStage` re-joins, against that model; `reorderStages` re-aligns it
 * (without it, a reorder would leave the chain describing the OLD column order
 * and the next splice — which looks up the rule between the new stage's
 * positional neighbours — would find nothing and strand the column again).
 *
 * Two facts are recomputed rather than carried, because both are already
 * enforced server-side (policy-actions.server.ts) and a carried copy can only
 * drift into a lie:
 *   - a rule the chain AUTHORS into the terminal stage is `human` — V1's
 *     human-acceptance invariant, which no preset may grant away;
 *   - `locked` marks exactly the human-into-terminal rules. A lock left on a
 *     rule that no longer ends at the terminal stage would disable a control the
 *     server is perfectly willing to change; a missing lock would offer one it
 *     always refuses.
 */

const STRICTNESS = {
  auto: 0,
  approval: 1,
  human: 2,
} satisfies Record<Boundary, number>;

/**
 * Display copy for an auto-wired rule. Deliberately names no stage — stages are
 * renamed freely (`renameStage` keeps ids), and copy that embedded a name would
 * go stale the moment it did.
 */
export function defaultTransitionBy(boundary: Boundary): string {
  switch (boundary) {
    case "auto":
      return "Operator, within policy; no human decision required";
    case "approval":
      return "Operator transition request, approved by a human";
    case "human":
      return "Human decision";
  }
}

function terminalIdOf(stages: readonly Pick<StageDef, "id">[]): string | null {
  return stages[stages.length - 1]?.id ?? null;
}

/** Re-derive `locked` from the one invariant it stands for. */
function withLock(
  rule: WorkflowBoundary,
  terminalId: string | null,
): WorkflowBoundary {
  const locked = rule.to === terminalId && rule.boundary === "human";
  return rule.locked === locked ? rule : { ...rule, locked };
}

/**
 * Author a new rule. A rule into the terminal stage is forced `human`: V1's
 * acceptance invariant is not something a stage edit may loosen (the server
 * refuses to set anything else there anyway — `setTransitionBoundary`).
 */
function createdRule(
  from: string,
  to: string,
  boundary: Boundary,
  terminalId: string | null,
  by?: string,
): WorkflowBoundary {
  const resolved: Boundary = to === terminalId ? "human" : boundary;
  return {
    from,
    to,
    boundary: resolved,
    by: by ?? defaultTransitionBy(resolved),
    locked: resolved === "human" && to === terminalId,
  };
}

/**
 * Splice a just-inserted stage into the chain.
 *
 * `stages` must ALREADY contain `stageId` at its final position. Inserting at
 * position *i* replaces the `prev → next` rule with `prev → new` and
 * `new → next`; both inherit the boundary of the edge they replace, so adding a
 * column never loosens the gate that used to guard that hop. The outgoing half
 * also keeps the replaced rule's `by` copy — it still ends at the same stage, so
 * it is the same decision entered from a different column — while the incoming
 * half is a genuinely new decision point and gets generated copy.
 *
 * Inserting at either end wires the single adjacent edge, inheriting the
 * boundary that guarded entry into that neighbour (falling back to `approval`,
 * the conservative middle, when there is nothing to inherit).
 */
export function spliceStageIntoChain(
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly WorkflowBoundary[],
  stageId: string,
): WorkflowBoundary[] {
  const terminalId = terminalIdOf(stages);
  const relocked = workflow.map((w) => withLock(w, terminalId));
  const idx = stages.findIndex((s) => s.id === stageId);
  if (idx === -1) return relocked;

  const prev = idx > 0 ? stages[idx - 1]!.id : null;
  const next = idx < stages.length - 1 ? stages[idx + 1]!.id : null;
  // Nothing to wire to (the new stage is the whole board).
  if (prev === null && next === null) return relocked;

  // Head insert: the new stage becomes the entry point.
  if (prev === null) {
    const inherited = relocked.find((w) => w.to === next)?.boundary ?? "approval";
    return [createdRule(stageId, next!, inherited, terminalId), ...relocked];
  }
  // Tail insert: the new stage becomes terminal (the old terminal's in-edge was
  // already unlocked by `withLock` above, since it no longer ends the board).
  if (next === null) {
    const inherited =
      relocked.find((w) => w.from === prev)?.boundary ?? "approval";
    return [...relocked, createdRule(prev, stageId, inherited, terminalId)];
  }

  const at = relocked.findIndex((w) => w.from === prev && w.to === next);
  const replaced = at === -1 ? null : relocked[at]!;
  // No prev→next rule to replace means the chain was already broken here. Wire
  // the new stage in regardless — an unreachable column is the bug this exists
  // to prevent — inheriting whatever guards entry into `next`.
  const boundary: Boundary =
    replaced?.boundary ??
    relocked.find((w) => w.to === next)?.boundary ??
    "approval";
  const incoming = createdRule(prev, stageId, boundary, terminalId);
  const outgoing = createdRule(stageId, next, boundary, terminalId, replaced?.by);
  if (at === -1) return [...relocked, incoming, outgoing];
  return [
    ...relocked.slice(0, at),
    incoming,
    outgoing,
    ...relocked.slice(at + 1),
  ];
}

/**
 * Re-join a removed stage's neighbours.
 *
 * `stages` must still contain `stageId` (call this BEFORE filtering it out).
 * Every rule touching the stage is dropped — nothing may point at a stage that
 * no longer exists — and `prev → next` takes their place, carrying the
 * **stricter** of the two boundaries it replaces.
 *
 * Why stricter and not, say, the in-edge's: removing a stage removes a
 * governance checkpoint. If `impl → sign-off` needed human approval and
 * `sign-off → review` was auto, collapsing the pair to an `auto` hop would
 * delete the approval gate as a side effect of a column edit, which no admin
 * asked for and no audit row would explain. Taking the stricter keeps the
 * checkpoint; an admin who wants it looser flips it in Policy, deliberately and
 * audited. `by` follows whichever edge's boundary won (a tie goes to the
 * out-edge — the merged rule still ends where that one ended).
 */
export function rejoinChainAroundStage(
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly WorkflowBoundary[],
  stageId: string,
): WorkflowBoundary[] {
  const remaining = stages.filter((s) => s.id !== stageId);
  const terminalId = terminalIdOf(remaining);
  const idx = stages.findIndex((s) => s.id === stageId);
  if (idx === -1) return workflow.map((w) => withLock(w, terminalId));

  const prev = idx > 0 ? stages[idx - 1]!.id : null;
  const next = idx < stages.length - 1 ? stages[idx + 1]!.id : null;
  const touches = (w: WorkflowBoundary) => w.from === stageId || w.to === stageId;
  const inEdge = workflow.find((w) => w.to === stageId && w.from === prev);
  const outEdge = workflow.find((w) => w.from === stageId && w.to === next);
  const alreadyJoined = workflow.some(
    (w) => !touches(w) && w.from === prev && w.to === next,
  );

  let merged: WorkflowBoundary | null = null;
  if (prev !== null && next !== null && !alreadyJoined && (inEdge || outEdge)) {
    const winner =
      inEdge && outEdge
        ? STRICTNESS[inEdge.boundary] > STRICTNESS[outEdge.boundary]
          ? inEdge
          : outEdge
        : (inEdge ?? outEdge)!;
    merged = createdRule(prev, next, winner.boundary, terminalId, winner.by);
  }

  const out: WorkflowBoundary[] = [];
  for (const rule of workflow) {
    if (touches(rule)) {
      // The merged rule takes the position of the first rule it replaces, so
      // the Policy list keeps reading in chain order.
      if (merged) {
        out.push(merged);
        merged = null;
      }
      continue;
    }
    out.push(withLock(rule, terminalId));
  }
  if (merged) out.push(merged);
  return out;
}

/**
 * Re-align the chain to a new stage order (`reorderStages`).
 *
 * One rule per consecutive pair. A pair that already has a rule keeps it
 * verbatim; a pair that does not inherits the boundary and copy of the rule that
 * used to guard **entry into the target stage**, wherever it came from. That is
 * the non-loosening reading of a reorder: nothing was deleted, so every stage
 * keeps its own gate, and moving a column cannot hand an `auto` hop to a stage
 * that was human-gated a moment ago.
 *
 * Rules that are not consecutive pairs of the new order are dropped. In-product
 * they cannot exist (the chain is the only shape these helpers author); a
 * hand-edited skip edge is removed rather than kept, which narrows the graph
 * instead of widening it.
 */
export function realignChainToStages(
  stages: readonly Pick<StageDef, "id">[],
  workflow: readonly WorkflowBoundary[],
): WorkflowBoundary[] {
  if (stages.length < 2) return [];
  const terminalId = terminalIdOf(stages);
  const guardingEntry = new Map<string, WorkflowBoundary>();
  for (const rule of workflow) {
    if (!guardingEntry.has(rule.to)) guardingEntry.set(rule.to, rule);
  }

  const chain: WorkflowBoundary[] = [];
  for (let i = 1; i < stages.length; i += 1) {
    const from = stages[i - 1]!.id;
    const to = stages[i]!.id;
    const existing = workflow.find((w) => w.from === from && w.to === to);
    if (existing) {
      chain.push(withLock(existing, terminalId));
      continue;
    }
    const inherited = guardingEntry.get(to);
    chain.push(createdRule(from, to, inherited?.boundary ?? "approval", terminalId, inherited?.by));
  }
  return chain;
}

/** The walk's result: the stage ids governance can actually reach in order,
 *  and the ones no rule reaches. */
export interface StageFlow {
  chain: string[];
  offChain: string[];
}

/**
 * The governed path through the board, walked from the entry stage along real
 * `workflow` rules — what Policy's flow map draws (P13-D-1). Drawing an arrow
 * between every consecutive stage *position* is what let the map depict a path
 * governance did not have; anything the rules do not reach comes back in
 * `offChain` so the panel can say so out loud.
 */
export function stageFlowPath(
  stages: readonly Pick<StageDef, "id">[],
  // Structural (not `WorkflowBoundary`) so the Policy page can pass its
  // `TransitionView` read model straight through — the walk needs endpoints
  // only, and the two shapes agree on those.
  workflow: readonly { from: string; to: string }[],
): StageFlow {
  const known = new Set(stages.map((s) => s.id));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = stages[0]?.id ?? null;
  while (cur !== null && known.has(cur) && !seen.has(cur)) {
    chain.push(cur);
    seen.add(cur);
    cur =
      workflow.find(
        (w) => w.from === cur && known.has(w.to) && !seen.has(w.to),
      )?.to ?? null;
  }
  return {
    chain,
    offChain: stages.filter((s) => !seen.has(s.id)).map((s) => s.id),
  };
}
