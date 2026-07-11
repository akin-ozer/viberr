import type { Guardrail, StageDef, WorkflowBoundary } from "~/schemas/project-file.schema";

/**
 * Instance-default workflow templates (orchestrator ruling 15).
 *
 * Stages are per-project (stored in project.md); these templates feed org
 * surfaces (Phase 9 AgentModal instance stage list) and the Phase-4
 * create-project action. Colors accept both hex and var(--*) strings.
 *
 * The "Lightweight · 3 stages" template's stage set is undefined in the
 * mock — defined here as todo / doing / done with the review→done boundary
 * collapsed onto doing→done (still human-locked).
 */

export interface WorkflowTemplate {
  id: string;
  /** Display label, e.g. "Governed · 5 stages". */
  label: string;
  stages: StageDef[];
  workflow: WorkflowBoundary[];
}

export const GOVERNED_TEMPLATE: WorkflowTemplate = {
  id: "governed-5",
  label: "Governed · 5 stages",
  stages: [
    { id: "triage", name: "Triage", color: "#a5a8b5" },
    { id: "ready", name: "Ready", color: "#187574" },
    { id: "impl", name: "In Progress", color: "#7b61ff" },
    { id: "review", name: "Review", color: "#5b76fe" },
    { id: "done", name: "Done", color: "#00b473" },
  ],
  workflow: [
    {
      from: "triage",
      to: "ready",
      boundary: "auto",
      by: "Operator, once the goal is scoped — flags underspecified tasks instead",
      locked: false,
    },
    {
      from: "ready",
      to: "impl",
      boundary: "auto",
      by: "Operator, when a primary specialist is assigned",
      locked: false,
    },
    {
      from: "impl",
      to: "review",
      boundary: "approval",
      by: "Operator transition request, with evidence attached",
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

export const LIGHTWEIGHT_TEMPLATE: WorkflowTemplate = {
  id: "lightweight-3",
  label: "Lightweight · 3 stages",
  stages: [
    { id: "todo", name: "To do", color: "#a5a8b5" },
    { id: "doing", name: "In progress", color: "#7b61ff" },
    { id: "done", name: "Done", color: "#00b473" },
  ],
  workflow: [
    {
      from: "todo",
      to: "doing",
      boundary: "auto",
      by: "Operator, when a primary specialist is assigned",
      locked: false,
    },
    {
      from: "doing",
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
 * that silently disables timeline compaction and operator brevity enforcement.
 */
export const DEFAULT_GUARDRAILS: Guardrail[] = [
  { id: "meaningful-comment", desc: "Agent comments must add information — status chatter is rejected before it reaches the timeline.", on: true },
  { id: "operator-brevity", desc: "Operator packets keep to observed → changed → recommended → decision required.", on: true },
  { id: "no-duplicate-summary", desc: "A summary that restates an earlier one is dropped instead of appended.", on: true },
  { id: "compression-threshold", desc: "Long timelines compress once routine events pass the threshold; typed events are always kept.", on: true, value: 40, unit: "events" },
  { id: "evidence-separation", desc: "Raw validation output stays in evidence references — never inline in the task record.", on: true },
];
