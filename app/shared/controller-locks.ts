/**
 * Ruling 270 — the controller's configuration sections are LOCKED by default,
 * org admins included: which skills, knowledge bases and org MCP servers it
 * loads, and its instructions, are a DEPLOYMENT decision, unlocked per section
 * by an environment variable at deploy time. `true` = locked. Model and effort
 * are deliberately not sections: picking the model tier is day-to-day admin
 * work, while rewriting what the controller IS operates above the org.
 *
 * P07-G (pass 32): the vocabulary — section names, unlock variables, the
 * unlock value — lives HERE, imported by the server (which enforces and words
 * the refusal) and by the settings panel (which words the lock note), so the
 * two can never call one thing two names. It used to be hand-copied into the
 * panel with a drift test standing between the copies.
 */
export interface ControllerSectionLocks {
  skills: boolean;
  kb: boolean;
  mcps: boolean;
  instructions: boolean;
}

export type ControllerSection = keyof ControllerSectionLocks;

/** The unlock variable per section — named in refusals and in the settings
 *  panel, so the operator is told exactly what to set. */
export const CONTROLLER_UNLOCK_ENV = {
  skills: "VIBERR_UNLOCK_CONTROLLER_SKILLS",
  kb: "VIBERR_UNLOCK_CONTROLLER_KB",
  mcps: "VIBERR_UNLOCK_CONTROLLER_MCPS",
  instructions: "VIBERR_UNLOCK_CONTROLLER_INSTRUCTIONS",
} as const satisfies Record<ControllerSection, string>;

/** Human names for the sections, shared by the refusal sentence and the
 *  settings panel's lock note. */
export const CONTROLLER_SECTION_LABEL = {
  skills: "skill grants",
  kb: "knowledge base grants",
  mcps: "MCP server grants",
  instructions: "instructions",
} as const satisfies Record<ControllerSection, string>;

/** The unlock value for a section, read like a switch: `enabled` unlocks it,
 *  and every other value — `disabled`, unset, or a typo — keeps it locked, so
 *  an unexpected value fails safe (closed) rather than opening the section. */
export const CONTROLLER_UNLOCK_VALUE = "enabled";
