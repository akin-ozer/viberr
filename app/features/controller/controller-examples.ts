/**
 * Ruling 314: three things to ask, scoped to where the person is standing.
 *
 * The empty dock said what the controller KNOWS ("the controller already has
 * its task file") and nothing about what it can DO, so a person who had never
 * used it was looking at a text box and a claim. The owner's call was examples
 * over a capability list: a list tells, and goes stale as the toolkit changes,
 * while an example teaches the surface by being clicked.
 *
 * Each one is a real sentence the controller can act on at that scope, and the
 * third is deliberately a DO rather than an ask — the dock's own composer says
 * "or tell it what to do here", and nothing demonstrated that half.
 *
 * Ruling 419(g): one module for both composers. The dock offered these and the
 * full controller page, the surface a person opens on purpose to start
 * something, offered a paragraph and an empty box.
 */
export type ControllerExampleScope =
  | { kind: "task"; taskKey: string }
  | { kind: "board" }
  | { kind: "instance" };

export function controllerExamples(scope: ControllerExampleScope): string[] {
  if (scope.kind === "task") {
    return [
      `What is blocking ${scope.taskKey}?`,
      "Summarise where this task stands and who is waiting on whom.",
      "Draft a directive for the agent on this task, but do not send it.",
    ];
  }
  if (scope.kind === "board") {
    return [
      "What is waiting on me right now, and what is waiting on an agent?",
      "Which tasks have been open longest, and why?",
      "Draft a task for work this board is missing, but do not create it.",
    ];
  }
  return [
    "What is blocked across every project I can see?",
    "What did agent runs cost this week, by project?",
    "Show me the agent profiles on this instance and what each one can do.",
  ];
}
