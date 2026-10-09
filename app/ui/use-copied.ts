import { useEffect, useState } from "react";

/** How long a copy control's confirmation stands before its resting word returns. */
const COPIED_MS = 1400;

/**
 * A copy control's confirmation (ruling 284): state that starts at `rest`
 * and, once set to anything else, returns to `rest` 1.4 s later. `rest` is
 * compared by identity, so it is a primitive (`false`, `null`).
 *
 * The lapse belongs to the value on screen, not to the click that set it. Each
 * control used to arm a bare `setTimeout` per click and never clear it: a
 * control gone inside the window (the run's console closed) was still set
 * 1.4 s later, after a test run's jsdom too, and a re-copy's leftover timer
 * ended the NEXT confirmation early. Here the timer is cleared when the value
 * changes or the control unmounts. Setting the value already shown changes
 * nothing, so a re-copy inside the window does not restart it (as before);
 * another value (the sign-in code after its link) stands its own full 1.4 s.
 */
export function useCopied<T>(rest: T): [T, (value: T) => void] {
  const [value, setValue] = useState(rest);
  useEffect(() => {
    if (Object.is(value, rest)) return;
    const timer = setTimeout(() => setValue(rest), COPIED_MS);
    return () => clearTimeout(timer);
  }, [value, rest]);
  return [value, setValue];
}
