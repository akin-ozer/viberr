import type { Guardrail, StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";

/**
 * The instance-default workflow template (ruling 47).
 *
 * Stages are per-project (stored in project.md); this template feeds org
 * surfaces (the AgentModal instance stage list) and the create-project action.
 *
 * `workflow` is a CHAIN over `stages`: one rule per consecutive pair, so every
 * stage has an in-edge (bar the entry) and an out-edge (bar the terminal) and
 * Done is always reachable. The stage editor maintains that shape as stages are
 * added, removed and reordered — app/shared/workflow/transitions.ts (P13-D-1).
 *
 * P13-AP-04 / P13 owner decision 2 (2026-07-24): the "Lightweight · 3 stages" preset
 * was DELETED. It shipped the built-in Developer/Reviewer, whose eligible
 * stages are the governed ids (`ready`/`impl`/`review`), onto a `todo`/`doing`/
 * `done` board — so no specialist was ever stage-eligible and the operator
 * could not hand work off (LV-01, live-proven: every lightweight project was
 * dead on arrival for agent work). The Standard 5-stage template is now the
 * only preset. Custom boards remain fully supported through project settings —
 * they are just no longer created with a roster that cannot work them.
 */

export interface WorkflowTemplate {
  id: string;
  /** Display label, e.g. "Standard · 5 stages". F18-14: NOT the banned word
   *  "Governed" — matches the New Project modal's rendered "Standard · 5 stages". */
  label: string;
  stages: StageDef[];
  workflow: WorkflowBoundary[];
}

/** The Standard template's words for its In Progress → Review edge (ruling
 *  91), shared with the boot conversion that writes them onto older boards. */
export const TEMPLATE_REVIEW_ENTRY_BY = "Operator, when the work is ready for review";

export const GOVERNED_TEMPLATE: WorkflowTemplate = {
  id: "governed-5",
  label: "Standard · 5 stages",
  stages: [
    { id: "triage", name: "Triage", color: "slate" },
    { id: "ready", name: "Ready", color: "teal" },
    { id: "impl", name: "In Progress", color: "violet" },
    { id: "review", name: "Review", color: "blue" },
    { id: "done", name: "Done", color: "green" },
  ],
  workflow: [
    {
      from: "triage",
      to: "ready",
      boundary: "auto",
      by: "Operator, once the goal is scoped. Flags underspecified tasks instead.",
      locked: false,
    },
    {
      from: "ready",
      to: "impl",
      boundary: "auto",
      // F19-12 residual: "primary specialist" is retired vocabulary (D9/Q17-5)
      // — the UI calls this actor the delivering agent. This string ships twice:
      // rendered on the Policy page AND persisted verbatim into every NEW
      // project's project.md. Existing projects keep whatever `by` text they
      // were created with — that is their data, not this template, and this
      // pass forbids migrations.
      by: "Operator, when a delivering agent is assigned",
      locked: false,
    },
    {
      from: "impl",
      to: "review",
      // Ruling 91 (owner, 2026-09-27): Review is a state the task reaches on
      // its own, not one a person confirms. The operator moves the task there
      // when the work is ready and says why on the move; the one person's gate
      // on this board is acceptance, the edge below. It was `approval`, and the
      // boards created while it was are converted once at boot
      // (`convertTemplateReviewEntry`).
      boundary: "auto",
      by: TEMPLATE_REVIEW_ENTRY_BY,
      locked: false,
    },
    {
      from: "review",
      to: "done",
      boundary: "human",
      by: "Human acceptance of the completion report",
      locked: true,
    },
  ],
};

/**
 * The PRD's anti-noise guardrails, ON by default for EVERY project — the seed
 * demo AND app-created projects. Timeline noise is the product's #1 named risk,
 * so a fresh board must ship with these enabled, not with an empty guardrail set
 * that silently disables timeline compaction and chatter rejection.
 *
 * There is deliberately no operator-brevity row (owner ruling 2026-08-31): the
 * old hard cap truncated operator narration in the canonical record; brevity is
 * now a style instruction on the operator's post_comment tool, and the timeline
 * collapses long comments view-side behind a Show more toggle.
 */
export const DEFAULT_GUARDRAILS: Guardrail[] = [
  { id: "meaningful-comment", desc: "Agent comments must add information. Status chatter is rejected before it reaches the timeline.", on: true },
  { id: "no-duplicate-summary", desc: "A summary that restates an earlier one is dropped instead of appended.", on: true },
  { id: "compression-threshold", desc: "Long timelines compress once routine events pass the threshold; typed events are always kept.", on: true, value: 40, unit: "events" },
  { id: "evidence-separation", desc: "Raw validation output stays in evidence references, never inline in the task record.", on: true },
];
