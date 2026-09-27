import { Icon, type IconName } from "~/ui/icon";

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
 *
 * Ruling 516: each carries the app's own glyph for what it is about (the
 * board's "waiting on you" hand and blocked mark, the Insights pulse, the
 * pencil of a draft), and the list is drawn here, once, for both composers.
 */
export type ControllerExampleScope =
  | { kind: "task"; taskKey: string }
  | { kind: "board" }
  | { kind: "instance" };

export interface ControllerExample {
  /** The sentence a click sends, and the button's whole name. */
  text: string;
  icon: IconName;
}

export function controllerExamples(scope: ControllerExampleScope): ControllerExample[] {
  if (scope.kind === "task") {
    return [
      { text: `What's blocking ${scope.taskKey}?`, icon: "ban" },
      { text: "Where does this task stand, and who is waiting on whom?", icon: "review" },
      { text: "Draft a directive for this task's agent, but don't send it.", icon: "edit" },
    ];
  }
  if (scope.kind === "board") {
    return [
      { text: "What's waiting on me, and what's waiting on an agent?", icon: "hand" },
      { text: "Which tasks have been open longest, and why?", icon: "clock" },
      { text: "Draft a task this board is missing, but don't create it.", icon: "edit" },
    ];
  }
  return [
    { text: "What's blocked across every project I can see?", icon: "ban" },
    { text: "What did agent runs cost this week, by project?", icon: "activity" },
    { text: "Show me the agent profiles on this instance and what each can do.", icon: "agents" },
  ];
}

/**
 * Ruling 314: clicking one SENDS it. An example that only filled the box would
 * teach the same lesson and then ask the person to find the button, which is
 * the thing they were already unsure about.
 *
 * Ruling 516: a row, not a box — the glyph of what it is about, the sentence,
 * and an arrow that says the click goes somewhere. The glyph and the arrow are
 * drawn, never read: the button's name is the sentence it sends.
 */
export function ControllerExampleList({
  examples,
  disabled,
  onSend,
}: {
  examples: readonly ControllerExample[];
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  return (
    <ul className="ctl-examples">
      {examples.map((example) => (
        <li key={example.text}>
          <button
            type="button"
            className="ctl-example"
            onClick={() => onSend(example.text)}
            disabled={disabled}
          >
            <span className="ctl-example-ico">
              <Icon name={example.icon} />
            </span>
            <span className="ctl-example-text">{example.text}</span>
            <span className="ctl-example-go">
              <Icon name="arrow" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
