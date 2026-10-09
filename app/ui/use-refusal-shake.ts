import { useState, type AnimationEvent } from "react";

/** The latest refusal a control has answered: its refusal counter, or a token
 *  that changes with each refusal. `0` and `null` mean none yet. */
export type RefusalMark = number | string | null;

export interface RefusalShake {
  /** Whether the box on screen answers a refusal whose shake has not played. */
  shake: boolean;
  /** Put on the shaking box: records the shake as played once it has run. */
  onAnimationEnd: (event: AnimationEvent<HTMLElement>) => void;
}

/**
 * Ruling 284: a refusal box shakes once for each refusal (`.refused`), not
 * once for each time it mounts.
 *
 * A refusal box is keyed on its refusal, so a second refused click mounts a
 * new box and shakes it again. But most boxes also unmount while the field is
 * valid and mount again when it turns invalid, still keyed on the SAME
 * refusal. Typing "abc" and then a backspace after a refused "ab" did that, and
 * so did a refresh that brought a standing note back. A shake tied to the
 * mount played on those keystrokes and refreshes as if the person had clicked.
 * So the hook remembers the refusal whose shake has played, and the box
 * carries `.refused` only while the refusal it shows is newer. It records the
 * shake at `animationend`: dropping the class any sooner would cut the shake
 * short. A counter that resets to none starts over, so the next first refusal
 * shakes even though its number repeats.
 */
export function useRefusalShake(refusal: RefusalMark): RefusalShake {
  const [played, setPlayed] = useState<RefusalMark>(null);
  if (!refusal && played !== null) setPlayed(null);
  return {
    shake: Boolean(refusal) && refusal !== played,
    onAnimationEnd: (event) => {
      // Only the box's own shake: a descendant's animation bubbles here too.
      if (event.target === event.currentTarget) setPlayed(refusal);
    },
  };
}
