import { act } from "@testing-library/react";

/**
 * Ruling 11: counts which components rendered in each React commit, for the
 * render ratchets (`*.perf.test.tsx`). React's `<Profiler onRender>` says THAT
 * a subtree committed, not WHICH components inside it ran; this reads the
 * answer off the committed fiber tree the way React DevTools' profiler does:
 *
 *   - a fiber object that was already in the previous commit's tree was not
 *     touched at all (React reused the whole subtree without cloning it), so it
 *     did not render, whatever its stale flags say;
 *   - any other component fiber was cloned or created for this commit, and the
 *     clone starts with its flags cleared, so its `PerformedWork` bit (1) is set
 *     exactly when its function ran. A `memo` card whose props compared equal
 *     is cloned and bails out, so it does not count.
 *
 * Wire `onRender` into a `<Profiler>` at the root of the rendered tree, then
 * `attach` the testing-library container once the first render is in; each
 * later commit adds to `renders(name)` until `reset()`. Test support only: the
 * field names are React 19's fiber internals, read nowhere in the app.
 */

/** The fiber fields this reads. `type` is a component function or the object
 *  `forwardRef` returns for the component tags counted here; host fibers carry
 *  a tag name there, which is never read. */
interface Fiber {
  tag: number;
  flags: number;
  type: { name?: string; displayName?: string; render?: { name?: string } } | null;
  child: Fiber | null;
  sibling: Fiber | null;
}

interface HostRootFiber {
  stateNode: { current: Fiber };
}

const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const SIMPLE_MEMO_COMPONENT = 15;
const PERFORMED_WORK = 1;

function componentName(fiber: Fiber): string | null {
  switch (fiber.tag) {
    case FUNCTION_COMPONENT:
    case CLASS_COMPONENT:
    case SIMPLE_MEMO_COMPONENT:
      return fiber.type?.displayName ?? fiber.type?.name ?? "Anonymous";
    case FORWARD_REF:
      return fiber.type?.displayName ?? fiber.type?.render?.name ?? "Anonymous";
    default:
      // A `memo(fn, compare)` wrapper (tag 14) renders its inner function as a
      // child fiber, which is the one counted.
      return null;
  }
}

export interface RenderCounter {
  /** Pass to `<Profiler onRender>`: reads each commit's tree once attached. */
  onRender: () => void;
  /** Starts counting from the tree `container` holds now. */
  attach: (container: HTMLElement) => void;
  /** Renders of the component named `name` since `attach` or `reset`. */
  renders: (name: string) => number;
  /** Renders of every component since `attach` or `reset`. */
  total: () => number;
  /** Commits seen since `attach` or `reset`. */
  commits: () => number;
  reset: () => void;
}

export function createRenderCounter(): RenderCounter {
  let root: HostRootFiber | null = null;
  let previous = new Set<Fiber>();
  let counts = new Map<string, number>();
  let commits = 0;

  const walk = (visit: (fiber: Fiber) => void) => {
    if (!root) return;
    const stack: Fiber[] = [root.stateNode.current];
    while (stack.length > 0) {
      const fiber = stack.pop()!;
      visit(fiber);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  };

  return {
    onRender: () => {
      if (!root) return;
      commits++;
      const seen = new Set<Fiber>();
      walk((fiber) => {
        seen.add(fiber);
        if (previous.has(fiber) || (fiber.flags & PERFORMED_WORK) === 0) return;
        const name = componentName(fiber);
        if (name !== null) counts.set(name, (counts.get(name) ?? 0) + 1);
      });
      previous = seen;
    },
    attach: (container) => {
      const entry = Object.entries(container).find(([key]) =>
        key.startsWith("__reactContainer$"),
      );
      if (!entry) throw new Error("no React root is mounted on this container");
      root = entry[1];
      previous = new Set();
      walk((fiber) => previous.add(fiber));
      counts = new Map();
      commits = 0;
    },
    renders: (name) => counts.get(name) ?? 0,
    total: () => [...counts.values()].reduce((sum, n) => sum + n, 0),
    commits: () => commits,
    reset: () => {
      counts = new Map();
      commits = 0;
    },
  };
}

/**
 * Waits until the tree stops committing: a quiet window with no commit. Reset
 * a counter only after this, so the measured window holds the interaction and
 * not the tail of the step before it. Under a loaded suite that tail lands
 * late, and a ratchet must read the same figure however busy the machine is.
 */
export async function settle(counter: RenderCounter, quietMs = 25): Promise<void> {
  for (let round = 0; round < 40; round++) {
    const before = counter.commits();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, quietMs));
    });
    if (counter.commits() === before) return;
  }
  throw new Error("settle: the tree never stopped committing");
}

/**
 * Ruling 11: the DOM writes a change makes under `target`, as MutationObserver
 * records. The ones still queued are drained synchronously (`takeRecords`) so a
 * test reads them right after its `act`; the ones a microtask checkpoint
 * already delivered (an `async` act that awaits a fetch) are kept by the
 * callback, so they are counted too.
 */
export function observeMutations(target: Node) {
  const delivered: MutationRecord[] = [];
  const observer = new MutationObserver((records) => {
    delivered.push(...records);
  });
  observer.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    /** The records since the last call, and clears them. */
    take: (): MutationRecord[] => {
      const out = [...delivered.splice(0), ...observer.takeRecords()];
      return out;
    },
  };
}
