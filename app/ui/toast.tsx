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

export function useToasts(): {
  toasts: Toast[];
  push: (text: string, kind?: ToastKind) => void;
} {
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
    setToasts((t) => [...t, { id, text, kind }]);
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

function ToastHost({ toasts }: { toasts: Toast[] }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof el.showPopover !== "function") return;
    try {
      if (toasts.length > 0) el.showPopover();
      else el.hidePopover();
    } catch {
      // Already open/closed, or popover unsupported — the element still renders
      // in the normal layer, which is the pre-fix behaviour.
    }
  }, [toasts.length]);

  return (
    <div
      ref={hostRef}
      popover="manual"
      className="toast-wrap"
      style={TOAST_HOST_STYLE}
      role="status"
      aria-live="polite"
    >
      {/* P13-D-10: `data-kind` makes the success/failure distinction assertable
          (and stylable) — the icon is the only other carrier, and an inline
          <svg> is not something a test can name. */}
      {toasts.map((t) => (
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
