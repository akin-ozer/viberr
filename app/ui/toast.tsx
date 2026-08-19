import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icon";

/**
 * Bottom-center toast stack with 2600 ms auto-dismiss. Errors render
 * inline or at route level; the root mounts one
 * ToastProvider in root.tsx; features call useToast() instead of the
 * mock's prop-drilled `push`.
 */

export type ToastKind = "success" | "error";

export interface Toast {
  id: string;
  text: string;
  /** Inventory #33: a failure toast must not render a success tick. */
  kind: ToastKind;
  /** Exit phase: `.leaving` plays the 200 ms fade-down before unmount. */
  leaving?: boolean;
}

const TOAST_DISMISS_MS = 2600;
const TOAST_EXIT_MS = 200;
/**
 * P16-UI-13: the stack was unbounded. A burst of failures — an SSE reconnect
 * storm, a multi-row bulk action, a fetcher retry loop — grew it upward off the
 * top of the viewport, and the toasts that scrolled out of sight were the
 * OLDEST, i.e. the first error, i.e. the one that explains the rest.
 *
 * Every other list in the app is capped (BELL_LIST_CAP 100,
 * COMMAND_GROUP_LIMIT 6, the feed limits); this is the one that wasn't. Four is
 * the most that fit above the fold on the shortest supported viewport, and past
 * three or four simultaneous 2.6 s messages nobody is reading them anyway.
 *
 * Oldest drops. The two-phase exit is untouched: a toast that reaches its own
 * timer still plays `.leaving` for 200 ms. A toast pushed out by the cap is
 * removed immediately — it has already had its time on screen, and animating an
 * exit that is caused by an ARRIVAL would read as the new toast pushing the old
 * one, which is not what happened. Its pending timers stay armed and become
 * no-ops (both filter/map by id).
 */
const TOAST_STACK_CAP = 4;

/** What the provider wires together: the live stack and its one pusher. */
export interface ToastStack {
  toasts: Toast[];
  push: (text: string, kind?: ToastKind) => void;
}

export function useToasts(): ToastStack {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const push = useCallback((text: string, kind: ToastKind = "success") => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, text, kind }].slice(-TOAST_STACK_CAP));
    // Two-phase dismissal: mark `leaving` (CSS plays the exit transition,
    // mirroring the `rise` entrance path), then unmount after it settles.
    timers.current.push(
      setTimeout(() => {
        setToasts((t) =>
          t.map((x) => (x.id === id ? { ...x, leaving: true } : x)),
        );
      }, TOAST_DISMISS_MS),
    );
    timers.current.push(
      setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, TOAST_DISMISS_MS + TOAST_EXIT_MS),
    );
  }, []);

  return { toasts, push };
}

/**
 * UI-34: the toast host lives at the app root with `z-index: 100`, but
 * `PageOverlay` and every confirm dialog open with `showModal()`, which
 * promotes them to the browser's TOP LAYER — `dialog::backdrop` then paints
 * over every normal-layer element regardless of z-index. So every confirmation
 * inside `/profile` and `/notifications` (password changed, routing saved,
 * mark-all-read) appeared dimmed or clipped.
 *
 * Fix: put the host in the top layer too, via a manual popover. The inline
 * styles neutralise the UA `[popover]` rules (inset/margin/border/background)
 * that would otherwise fight `.toast-wrap`'s bottom-center placement — they are
 * inline rather than in app.css because they must beat the UA sheet.
 */
const TOAST_HOST_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: "auto",
  bottom: "1.4rem",
  left: "50%",
  transform: "translateX(-50%)",
  margin: 0,
  padding: 0,
  border: 0,
  background: "transparent",
  width: "auto",
  height: "auto",
  maxWidth: "min(92vw, 40rem)",
  overflow: "visible",
  color: "inherit",
};

/**
 * P16-UI-26: this host is the app's ONE announcer — `role="status"
 * aria-live="polite"` — and it was silent for every dialog-driven action.
 *
 * While a modal `<dialog>` is open everything outside it is inert, so the live
 * region is not in the accessibility tree at all. The old code then called
 * `showPopover()` in the same commit that inserted the toast: the region and
 * its content appeared together, which is the one case screen readers do NOT
 * announce (a live region only announces CHANGES to a region it was already
 * observing). Every AcceptConfirm / ArchiveConfirm / ReleaseConfirm,
 * DeleteProject, RepairRepo, org-settings MiniModal and store-browser action
 * therefore completed in silence.
 *
 * Two-step, on the 0 → n transition only:
 *   1. promote the still-EMPTY host to the top layer, which also un-inerts it,
 *   2. commit the toast children in a SECOND render (`regionReady`), so the
 *      region is observed before it changes.
 * `regionReady` is flipped from a passive effect, so React commits it after the
 * first paint in the browser and synchronously inside `act()` in tests — the
 * fake-timer specs keep asserting the DOM without awaiting anything.
 *
 * The re-arm matters as much as the promotion: the top layer is ordered by
 * INSERTION, so a dialog opened AFTER the host was promoted sits above it — the
 * exact UI-34 failure. So the host also re-inserts itself (hide → show) when
 * the set of open dialogs has changed since it was promoted.
 *
 * What it deliberately does NOT do is re-insert on every push. That would drop
 * the region out of the a11y tree and back mid-burst, costing the very
 * announcement it exists to make.
 */
function ToastHost({ toasts }: { toasts: Toast[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [regionReady, setRegionReady] = useState(false);
  /** Whether the host currently holds a place in the top layer. */
  const promoted = useRef(false);
  /** The dialogs that were open when it took that place. */
  const promotedOver = useRef<Element[]>([]);
  const empty = toasts.length === 0;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const supported = typeof el.showPopover === "function";
    const hide = () => {
      if (!supported) return;
      try {
        el.hidePopover();
      } catch {
        // Not open.
      }
    };
    const show = () => {
      if (!supported) return;
      try {
        el.showPopover();
      } catch {
        // Popover unsupported at runtime — the element still renders in the
        // normal layer, which is the pre-UI-34 behaviour.
      }
    };

    if (empty) {
      if (promoted.current) {
        hide();
        promoted.current = false;
        promotedOver.current = [];
      }
      setRegionReady(false);
      return;
    }

    const dialogs = [...document.querySelectorAll("dialog[open]")];
    if (!promoted.current) {
      // Step 1. `regionReady` is still false, so the host in the DOM right now
      // is EMPTY — this puts an empty live region into the a11y tree.
      show();
      promoted.current = true;
      promotedOver.current = dialogs;
      // Step 2, as a second commit.
      setRegionReady(true);
      return;
    }
    const reordered =
      dialogs.length !== promotedOver.current.length ||
      dialogs.some((d, i) => d !== promotedOver.current[i]);
    if (reordered) {
      hide();
      show();
      promotedOver.current = dialogs;
    }
  }, [empty, toasts.length]);

  return (
    <div
      ref={hostRef}
      popover="manual"
      className="toast-wrap"
      style={TOAST_HOST_STYLE}
      role="status"
      aria-live="polite"
      // `role="status"` implies `aria-atomic="true"`, which would re-read the
      // whole stack on every arrival — up to TOAST_STACK_CAP messages for one
      // event. Only the toast that just landed is news.
      aria-atomic="false"
    >
      {/* P13-D-10: `data-kind` makes the success/failure distinction assertable
          (and stylable) — the icon is the only other carrier, and an inline
          <svg> is not something a test can name. */}
      {(regionReady ? toasts : []).map((t) => (
        <div
          className={"toast" + (t.leaving ? " leaving" : "")}
          data-kind={t.kind}
          key={t.id}
        >
          {/* Inventory #33: error strings pushed by the bell / user menu /
              pref rollbacks used to render with a green success tick. */}
          <Icon name={t.kind === "error" ? "alert" : "check"} />
          {t.text}
        </div>
      ))}
    </div>
  );
}

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(
  () => {},
);

/** App-wide toast context: mounts the single ToastHost (root layout). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, push } = useToasts();
  return (
    <ToastContext.Provider value={push}>
      {children}
      <ToastHost toasts={toasts} />
    </ToastContext.Provider>
  );
}

/** `push(text, kind?)` — 2600 ms auto-dismissing toast (`"error"` for failures,
 *  which renders the alert icon instead of the success tick). */
export function useToast(): (text: string, kind?: ToastKind) => void {
  return useContext(ToastContext);
}
